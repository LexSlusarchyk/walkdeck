export type Phase =
  | "idle"
  | "countdown"
  | "running"
  | "paused"
  | "stopping"
  | "fault"
  | "safety";

export type RemoteSample = {
  phase?: Phase;
  countdown?: number;
  speedKmh?: number;
  incline?: number;
  elapsedSec?: number;
  distanceKm?: number;
  kcal?: number;
  steps?: number;
  heart?: number | null;
  minKmh?: number;
  maxKmh?: number;
};

const FIT_HEADER = 0x02;
const FIT_FOOTER = 0x03;

export function fitFrame(payload: number[]): Uint8Array {
  let fcs = 0;
  for (const b of payload) fcs ^= b;
  return Uint8Array.from([FIT_HEADER, ...payload, fcs & 0xff, FIT_FOOTER]);
}

export function consumeFitFrames(buffer: number[]): { frames: number[][]; rest: number[] } {
  const frames: number[][] = [];
  let i = 0;
  while (i < buffer.length) {
    if (buffer[i] !== FIT_HEADER) {
      i += 1;
      continue;
    }
    let end = i + 1;
    let matched = false;
    while (end < buffer.length) {
      if (buffer[end] === FIT_FOOTER) {
        const body = buffer.slice(i + 1, end);
        if (body.length >= 2) {
          let x = 0;
          for (let k = 0; k < body.length - 1; k += 1) x ^= body[k]!;
          if ((x & 0xff) === body[body.length - 1]) {
            frames.push(body.slice(0, -1));
            i = end + 1;
            matched = true;
            break;
          }
        }
      }
      end += 1;
    }
    if (!matched) {
      if (buffer.length - i > 48) {
        i += 1;
        continue;
      }
      break;
    }
  }
  return { frames, rest: buffer.slice(i) };
}

function mapFitPhase(status: number): Phase {
  switch (status) {
    case 0:
      return "idle";
    case 1:
      return "idle";
    case 2:
      return "countdown";
    case 3:
      return "running";
    case 4:
      return "stopping";
    case 5:
      return "fault";
    case 6:
      return "safety";
    case 10:
      return "paused";
    default:
      return "idle";
  }
}

/** Payload is the FitShow body without header, checksum, or footer. */
export function parseFitPayload(payload: number[]): RemoteSample | null {
  if (payload.length < 2) return null;
  const cmd = payload[0]!;
  const par = payload[1]!;
  if (cmd === 0x50 && par === 0x02 && payload.length >= 4) {
    const maxRaw = payload[2]!;
    const minRaw = payload[3]!;
    const tenths = maxRaw > 20;
    return {
      maxKmh: tenths ? maxRaw / 10 : maxRaw,
      minKmh: tenths ? minRaw / 10 : minRaw,
    };
  }
  if (cmd !== 0x51) return null;
  const phase = mapFitPhase(par);
  if (phase === "countdown") {
    return { phase, countdown: payload[2] ?? 3, speedKmh: 0 };
  }
  const withMetrics =
    payload.length >= 13 &&
    (par === 1 || par === 3 || par === 4 || par === 10);
  if (!withMetrics) {
    return { phase, speedKmh: phase === "running" ? undefined : 0 };
  }
  const speed = payload[2]! / 10;
  const inclineRaw = payload[3]!;
  const incline = inclineRaw > 127 ? inclineRaw - 256 : inclineRaw;
  const elapsed = payload[4]! | (payload[5]! << 8);
  // Distance is little-endian tenths of a kilometre (FitShow status layout).
  const distanceRaw = payload[6]! | (payload[7]! << 8);
  const kcal = payload[8]! | (payload[9]! << 8);
  const steps = payload[10]! | (payload[11]! << 8);
  const heart = payload[12]!;
  const distanceKm = distanceRaw / 10;
  return {
    phase,
    speedKmh: phase === "running" || phase === "stopping" ? speed : 0,
    incline,
    elapsedSec: elapsed > 0 && elapsed < 86_400 ? elapsed : undefined,
    distanceKm: distanceKm > 0.001 && distanceKm < 80 ? distanceKm : undefined,
    kcal: kcal > 0 ? kcal : undefined,
    steps: steps > 0 ? steps : undefined,
    heart: heart > 0 ? heart : null,
  };
}

export function parseTreadmillData(view: DataView): RemoteSample {
  const out: RemoteSample = {};
  if (view.byteLength < 2) return out;
  const flags = view.getUint16(0, true);
  let o = 2;
  const need = (n: number) => o + n <= view.byteLength;

  if ((flags & 0x0001) === 0) {
    if (!need(2)) return out;
    out.speedKmh = view.getUint16(o, true) / 100;
    o += 2;
  }
  if (flags & 0x0002) {
    if (!need(2)) return out;
    o += 2;
  }
  if (flags & 0x0004) {
    if (!need(3)) return out;
    const meters =
      view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16);
    out.distanceKm = meters / 1000;
    o += 3;
  }
  if (flags & 0x0008) {
    if (!need(4)) return out;
    out.incline = view.getInt16(o, true) / 10;
    o += 4;
  }
  if (flags & 0x0010) {
    if (!need(4)) return out;
    o += 4;
  }
  if (flags & 0x0020) {
    if (!need(1)) return out;
    o += 1;
  }
  if (flags & 0x0040) {
    if (!need(1)) return out;
    o += 1;
  }
  if (flags & 0x0080) {
    if (!need(5)) return out;
    out.kcal = view.getUint16(o, true);
    o += 5;
  }
  if (flags & 0x0100) {
    if (!need(1)) return out;
    out.heart = view.getUint8(o);
    o += 1;
  }
  if (flags & 0x0200) {
    if (!need(1)) return out;
    o += 1;
  }
  if (flags & 0x0400) {
    if (!need(2)) return out;
    out.elapsedSec = view.getUint16(o, true);
  }
  return out;
}

export function parseMachineStatus(view: DataView): RemoteSample {
  if (view.byteLength < 1) return {};
  const op = view.getUint8(0);
  if (op === 0x04) return { phase: "running" };
  if (op === 0x02) {
    const param = view.byteLength > 1 ? view.getUint8(1) : 1;
    return { phase: param === 2 ? "paused" : "idle", speedKmh: 0 };
  }
  if (op === 0x03) return { phase: "safety", speedKmh: 0 };
  if (op === 0x01) return { phase: "idle", speedKmh: 0 };
  return {};
}

export function parseSpeedRange(view: DataView): { min: number; max: number } | null {
  if (view.byteLength < 4) return null;
  const min = view.getUint16(0, true) / 100;
  const max = view.getUint16(2, true) / 100;
  if (max < min || max <= 0 || max > 40) return null;
  return { min, max };
}

export function parseHeartRate(view: DataView): number | null {
  if (view.byteLength < 2) return null;
  const flags = view.getUint8(0);
  const hr = flags & 0x01 ? view.getUint16(1, true) : view.getUint8(1);
  return hr > 0 ? hr : null;
}

export const UUID = {
  ftms: "00001826-0000-1000-8000-00805f9b34fb",
  fit: "0000fff0-0000-1000-8000-00805f9b34fb",
  info: "0000180a-0000-1000-8000-00805f9b34fb",
  hr: "0000180d-0000-1000-8000-00805f9b34fb",
  treadmillData: "00002acd-0000-1000-8000-00805f9b34fb",
  control: "00002ad9-0000-1000-8000-00805f9b34fb",
  machineStatus: "00002ada-0000-1000-8000-00805f9b34fb",
  speedRange: "00002ad4-0000-1000-8000-00805f9b34fb",
  fff1: "0000fff1-0000-1000-8000-00805f9b34fb",
  fff2: "0000fff2-0000-1000-8000-00805f9b34fb",
  hrMeas: "00002a37-0000-1000-8000-00805f9b34fb",
  model: "00002a24-0000-1000-8000-00805f9b34fb",
  manufacturer: "00002a29-0000-1000-8000-00805f9b34fb",
  firmware: "00002a26-0000-1000-8000-00805f9b34fb",
} as const;
