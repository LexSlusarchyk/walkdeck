import {
  UUID,
  consumeFitFrames,
  fitFrame,
  parseFitPayload,
  parseHeartRate,
  parseMachineStatus,
  parseSpeedRange,
  parseTreadmillData,
  type Phase,
  type RemoteSample,
} from "@/lib/ble/codec";
import { hex } from "@/lib/format";
import {
  onNotify,
  permittedDevice,
  readText,
  shortUuid,
  writeChar,
  type BleChar,
  type BleDevice,
  type BleService,
} from "@/lib/ble/web-ble";

export type ProtocolPref = "auto" | "fitshow" | "ftms";
export type Picker = "filtered" | "all";
export type LinkState = "up" | "reconnecting";

export type LinkHandlers = {
  onSample: (sample: RemoteSample) => void;
  onLog: (line: string) => void;
  onIdentity: (info: {
    id: string;
    name: string;
    protocol: string;
    detail: string;
    services: string[];
  }) => void;
  onLimits: (limits: { min: number; max: number }) => void;
  onDisconnect: (message: string) => void;
  onLink: (state: LinkState) => void;
};

const OPTIONAL = [UUID.ftms, UUID.fit, UUID.info, UUID.hr];
const MODEL_MIN_TENTHS = 10;
const MODEL_MAX_TENTHS = 60;

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findService(services: BleService[], id: string) {
  return services.find((s) => s.uuid.toLowerCase() === id);
}

async function allChars(service: BleService): Promise<BleChar[]> {
  try {
    return await service.getCharacteristics();
  } catch {
    return [];
  }
}

async function findChar(service: BleService, id: string): Promise<BleChar | null> {
  try {
    return await service.getCharacteristic(id);
  } catch {
    const all = await allChars(service);
    return all.find((c) => c.uuid.toLowerCase() === id) ?? null;
  }
}

function isShort(uuid: string, short: string) {
  return shortUuid(uuid) === short || uuid.toLowerCase() === `0000${short}-0000-1000-8000-00805f9b34fb`;
}

export function explainBleError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotFoundError") {
    return "Chooser closed. If the pad was not listed, turn it on, quit Spax, and use Show every device.";
  }
  if (name === "NotAllowedError") {
    return "Bluetooth permission was blocked. In System Settings, Privacy & Security, Bluetooth, allow this browser. Do not pair the pad in the macOS device list.";
  }
  if (name === "SecurityError") {
    return "Bluetooth is blocked. In System Settings, Privacy & Security, Bluetooth, allow Chrome, then reload.";
  }
  if (name === "NotSupportedError") {
    return "This browser cannot open Bluetooth. Use Chrome, Edge, Brave, or Arc on your Mac.";
  }
  if (name === "NetworkError") {
    return "The pad refused the link. Quit Spax on your phone — it holds the only connection — and try again.";
  }
  if (err instanceof Error && err.message) return err.message;
  return "Couldn't connect to the pad.";
}

export class PadLink {
  private device: BleDevice | null = null;
  private protocol: "fitshow" | "ftms" | null = null;
  private fitWrite: BleChar | null = null;
  private ftmsControl: BleChar | null = null;
  private queue: number[][] = [];
  private pumping = false;
  private userClosed = false;
  private poll: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private rx: number[] = [];
  private controlReady = false;
  private retries = 0;
  private opening = false;
  private weightKg = 70;
  private fitUser = 0x51a2;
  private pref: ProtocolPref = "auto";
  private pendingKmh: number | null = null;
  private armedRun = false;
  private lastReportedKmh = 0;
  private lastSpeedCommandAt = 0;
  private minTenths = MODEL_MIN_TENTHS;
  private maxTenths = MODEL_MAX_TENTHS;
  private loggedIn = 0;
  private lastPhase: Phase | undefined;
  private live = false;
  private retryArmed = false;
  private readonly onGattDown = () => {
    this.handlers.onLog("Pad link dropped.");
    this.scheduleRetry();
  };

  constructor(private handlers: LinkHandlers) {}

  async connect(opts: {
    pref: ProtocolPref;
    weightKg: number;
    fitUser: number;
    picker: Picker;
    deviceId?: string;
  }) {
    this.pref = opts.pref;
    this.weightKg = opts.weightKg;
    this.fitUser = opts.fitUser;
    this.userClosed = false;
    this.retries = 0;
    const bluetooth = navigator.bluetooth;
    if (!bluetooth) {
      throw new Error("This browser can't talk to Bluetooth. On your MacBook, open Walkdeck in Chrome, Edge, Brave, or Arc.");
    }
    let device: BleDevice | null = null;
    if (opts.deviceId) {
      device = permittedDevice(opts.deviceId);
      if (!device) throw new Error("That pad is not permitted yet. Choose it from the Bluetooth list once.");
    } else {
      try {
        device =
          opts.picker === "all"
            ? await bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: OPTIONAL })
            : await bluetooth.requestDevice({
                filters: [
                  { namePrefix: "FS" },
                  { namePrefix: "Fs" },
                  { namePrefix: "EF" },
                  { namePrefix: "Ef" },
                  { namePrefix: "X512" },
                  { namePrefix: "SPAX" },
                  { namePrefix: "Spax" },
                  { namePrefix: "Fit" },
                  { namePrefix: "FIT" },
                  { namePrefix: "Walking" },
                  { namePrefix: "TM" },
                  { services: [UUID.fit] },
                  { services: [UUID.ftms] },
                ],
                optionalServices: OPTIONAL,
              });
      } catch (err) {
        throw new Error(explainBleError(err));
      }
    }
    this.device = device;
    device.addEventListener("gattserverdisconnected", this.onGattDown);
    await this.openGatt();
  }

  private async openGatt() {
    const device = this.device;
    if (!device || this.userClosed) return;
    this.opening = true;
    this.clearPoll();
    this.fitWrite = null;
    this.ftmsControl = null;
    this.queue = [];
    this.rx = [];
    try {
      const server = await device.gatt?.connect();
      if (!server) throw new Error("The pad didn't open a connection. Quit Spax on your phone and try again.");
      const services = await server.getPrimaryServices();
      const labels = services.map((s) => shortUuid(s.uuid));
      this.handlers.onLog(`Services: ${labels.join(", ") || "none"}`);
      const fit = findService(services, UUID.fit) ?? (await this.findFitService(services));
      const ftms = findService(services, UUID.ftms);
      const opened = await this.openProtocol(fit, ftms);
      if (!opened) {
        this.handlers.onIdentity({
          id: device.id,
          name: device.name || "Unknown device",
          protocol: "Unknown",
          detail: "No FitShow or FTMS channel. The service list below is the clue if Spax uses a private dialect.",
          services: labels,
        });
        this.opening = false;
        return;
      }
      const detail = await this.readInfo(findService(services, UUID.info));
      await this.openHeart(findService(services, UUID.hr));
      this.retries = 0;
      this.live = true;
      this.retryArmed = false;
      this.handlers.onLink("up");
      this.handlers.onIdentity({
        id: device.id,
        name: device.name || "Walking pad",
        protocol: this.protocol === "fitshow" ? "FitShow" : "FTMS",
        detail,
        services: labels,
      });
    } catch (err) {
      this.opening = false;
      throw new Error(explainBleError(err));
    }
    this.opening = false;
  }

  private async findFitService(services: BleService[]) {
    for (const service of services) {
      const chars = await allChars(service);
      const notify = chars.find((c) => isShort(c.uuid, "fff1"));
      const write = chars.find((c) => isShort(c.uuid, "fff2"));
      if (notify && write) return service;
    }
    return undefined;
  }

  private async openProtocol(fit: BleService | undefined, ftms: BleService | undefined) {
    const tryFit = Boolean(fit) && this.pref !== "ftms";
    const tryFtms = Boolean(ftms) && this.pref !== "fitshow";
    if (tryFit && fit) {
      try {
        await this.openFit(fit);
        this.protocol = "fitshow";
        return true;
      } catch (err) {
        this.handlers.onLog(`FitShow channel failed: ${err instanceof Error ? err.message : "unknown"}`);
        if (!tryFtms) throw err;
      }
    }
    if (tryFtms && ftms) {
      await this.openFtms(ftms);
      this.protocol = "ftms";
      return true;
    }
    if (fit && this.pref === "ftms") {
      await this.openFit(fit);
      this.protocol = "fitshow";
      return true;
    }
    if (ftms && this.pref === "fitshow") {
      await this.openFtms(ftms);
      this.protocol = "ftms";
      return true;
    }
    return false;
  }

  private async readInfo(service: BleService | undefined) {
    if (!service) return "";
    const bits: string[] = [];
    for (const [id, label] of [
      [UUID.manufacturer, ""],
      [UUID.model, ""],
      [UUID.firmware, "fw"],
    ] as const) {
      const ch = await findChar(service, id);
      if (!ch?.properties.read) continue;
      try {
        const text = await readText(ch);
        if (text) bits.push(label ? `${label} ${text}` : text);
      } catch {
        /* optional identity */
      }
    }
    return bits.join(" · ");
  }

  private async openHeart(service: BleService | undefined) {
    if (!service) return;
    const ch = await findChar(service, UUID.hrMeas);
    if (!ch?.properties.notify) return;
    await ch.startNotifications();
    onNotify(ch, (view) => {
      const heart = parseHeartRate(view);
      if (heart) this.handlers.onSample({ heart });
    });
  }

  private async openFit(service: BleService) {
    const chars = await allChars(service);
    const notify = chars.find((c) => isShort(c.uuid, "fff1")) ?? (await findChar(service, UUID.fff1));
    const write = chars.find((c) => isShort(c.uuid, "fff2")) ?? (await findChar(service, UUID.fff2));
    if (!notify || !write) throw new Error("FitShow service is missing its data channels.");
    this.fitWrite = write;
    await notify.startNotifications();
    onNotify(notify, (view) => this.onFitBytes(view));
    const now = new Date();
    const weight = Math.max(35, Math.min(200, Math.round(this.weightKg)));
    const uid = this.fitUser & 0xffff;
    this.enqueue([0x53, 0x00, uid & 0xff, (uid >> 8) & 0xff, 0x6e, 30, weight]);
    this.enqueue([
      0x50,
      0x00,
      now.getFullYear() - 2000,
      now.getMonth() + 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
    ]);
    for (const info of [0x02, 0x03, 0x04, 0x01]) this.enqueue([0x50, info]);
    this.poll = setInterval(() => {
      if (this.userClosed) return;
      this.retrySpeed();
      if (this.queue.length < 2) this.enqueue([0x51]);
    }, 500);
  }

  private onFitBytes(view: DataView) {
    const bytes = Array.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    this.rx.push(...bytes);
    const { frames, rest } = consumeFitFrames(this.rx);
    this.rx = rest.slice(-64);
    if (frames.length === 0 && this.loggedIn < 4) {
      this.loggedIn += 1;
      this.handlers.onLog(`← ${hex(bytes)}`);
    }
    for (const frame of frames) {
      const sample = parseFitPayload(frame);
      if (!sample) continue;
      if (sample.minKmh != null && sample.maxKmh != null) {
        this.minTenths = Math.max(MODEL_MIN_TENTHS, Math.round(sample.minKmh * 10));
        this.maxTenths = Math.min(MODEL_MAX_TENTHS, Math.max(this.minTenths, Math.round(sample.maxKmh * 10)));
        this.handlers.onLimits({
          min: this.minTenths / 10,
          max: this.maxTenths / 10,
        });
        this.handlers.onLog(`Speed range ${(this.minTenths / 10).toFixed(1)}–${(this.maxTenths / 10).toFixed(1)} km/h`);
      }
      if (sample.phase && (sample.phase !== this.lastPhase || this.loggedIn < 8)) {
        this.loggedIn += 1;
        this.handlers.onLog(`← ${hex(fitFrame(frame))} ${sample.phase}`);
      }
      if (sample.phase === "running" && !this.armedRun) {
        this.armedRun = true;
        if (this.pendingKmh != null) this.sendSpeedNow(this.pendingKmh);
      } else if (sample.phase && sample.phase !== "running" && sample.phase !== "countdown") {
        this.armedRun = false;
      }
      if (typeof sample.speedKmh === "number") this.lastReportedKmh = sample.speedKmh;
      this.lastPhase = sample.phase ?? this.lastPhase;
      if (sample.phase || sample.speedKmh != null || sample.heart != null || sample.distanceKm != null) {
        this.handlers.onSample(sample);
      }
    }
  }

  private async openFtms(service: BleService) {
    const data = await findChar(service, UUID.treadmillData);
    const control = await findChar(service, UUID.control);
    const status = await findChar(service, UUID.machineStatus);
    const range = await findChar(service, UUID.speedRange);
    if (!data) throw new Error("This FTMS pad doesn't publish treadmill data.");
    await data.startNotifications();
    onNotify(data, (view) => {
      const sample = parseTreadmillData(view);
      if (sample.speedKmh != null && sample.speedKmh > 0.2 && !sample.phase) sample.phase = "running";
      if (sample.phase === "running") this.armedRun = true;
      this.handlers.onSample(sample);
    });
    if (status?.properties.notify) {
      await status.startNotifications();
      onNotify(status, (view) => this.handlers.onSample(parseMachineStatus(view)));
    }
    if (control && (control.properties.indicate || control.properties.notify)) {
      await control.startNotifications();
      onNotify(control, (view) => {
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        this.handlers.onLog(`FTMS reply ${hex(bytes)}`);
        if (bytes[0] === 0x80 && bytes[1] === 0x00 && bytes[2] === 0x01) this.controlReady = true;
      });
    }
    this.ftmsControl = control;
    if (range?.properties.read) {
      try {
        const limits = parseSpeedRange(await range.readValue());
        if (limits) {
          this.minTenths = Math.max(MODEL_MIN_TENTHS, Math.round(limits.min * 10));
          this.maxTenths = Math.min(MODEL_MAX_TENTHS, Math.round(limits.max * 10));
          this.handlers.onLimits({ min: this.minTenths / 10, max: this.maxTenths / 10 });
        }
      } catch {
        /* optional */
      }
    }
    if (control) {
      await writeChar(control, Uint8Array.of(0x00), true);
      this.handlers.onLog("FTMS request control");
      await delay(200);
      this.controlReady = true;
    }
  }

  private speedCmd(kmh: number): number[] {
    let tenths = Math.round(kmh * 10);
    tenths = Math.min(this.maxTenths, Math.max(this.minTenths, tenths));
    return [0x53, 0x02, tenths & 0xff, 0x00];
  }

  private enqueue(payload: number[]) {
    this.queue.push(payload);
    void this.pump();
  }

  private async pump() {
    if (this.pumping || this.userClosed) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.fitWrite && !this.userClosed) {
        const payload = this.queue.shift()!;
        const frame = fitFrame(payload);
        this.handlers.onLog(`→ ${hex(frame)}`);
        await writeChar(this.fitWrite, frame, false);
        await delay(180);
      }
    } catch (err) {
      this.handlers.onLog(`Write failed: ${err instanceof Error ? err.message : "unknown"}`);
    } finally {
      this.pumping = false;
    }
  }

  start(kmh: number) {
    this.pendingKmh = kmh;
    this.armedRun = false;
    if (this.protocol === "fitshow") {
      // 0x01 starts older FitShow modules and arms newer ones. 0x09 is start/resume on the current Spax dialect.
      this.enqueue([0x53, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
      this.enqueue([0x53, 0x09]);
      return;
    }
    void this.ftmsStart(kmh);
  }

  private async ftmsStart(kmh: number) {
    const control = this.ftmsControl;
    if (!control) return;
    try {
      if (!this.controlReady) {
        await writeChar(control, Uint8Array.of(0x00), true);
        await delay(180);
        this.controlReady = true;
      }
      await writeChar(control, Uint8Array.of(0x07), true);
      await delay(180);
      this.armedRun = true;
      await this.ftmsSpeed(kmh);
    } catch (err) {
      this.handlers.onLog(`FTMS start failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  setSpeed(kmh: number) {
    this.pendingKmh = kmh;
    if (!this.armedRun) return;
    this.sendSpeedNow(kmh);
  }

  /** The pad ignores a speed write until it has been moving for a few seconds, so repeat it until the belt reports that speed. */
  private retrySpeed() {
    if (!this.armedRun || this.pendingKmh == null || this.userClosed) return;
    if (Math.abs(this.lastReportedKmh - this.pendingKmh) < 0.15) return;
    if (Date.now() - this.lastSpeedCommandAt < 1200) return;
    this.sendSpeedNow(this.pendingKmh);
  }

  private sendSpeedNow(kmh: number) {
    this.lastSpeedCommandAt = Date.now();
    if (this.protocol === "fitshow") {
      this.enqueue(this.speedCmd(kmh));
      return;
    }
    void this.ftmsSpeed(kmh);
  }

  private async ftmsSpeed(kmh: number) {
    const control = this.ftmsControl;
    if (!control) return;
    let tenths = Math.round(kmh * 10);
    tenths = Math.min(this.maxTenths, Math.max(this.minTenths, tenths));
    const hundredths = tenths * 10;
    try {
      await writeChar(control, Uint8Array.of(0x02, hundredths & 0xff, (hundredths >> 8) & 0xff), true);
    } catch (err) {
      this.handlers.onLog(`FTMS speed failed: ${err instanceof Error ? err.message : "unknown"}`);
    }
  }

  pause() {
    this.armedRun = false;
    if (this.protocol === "fitshow") {
      this.enqueue([0x53, 0x0a]);
      this.enqueue([0x53, 0x06]);
      return;
    }
    const control = this.ftmsControl;
    if (!control) return;
    void writeChar(control, Uint8Array.of(0x08, 0x02), true).catch(() => undefined);
  }

  stop() {
    this.pendingKmh = null;
    this.armedRun = false;
    if (this.protocol === "fitshow") {
      this.queue = [];
      this.enqueue([0x53, 0x03]);
      return;
    }
    const control = this.ftmsControl;
    if (!control) return;
    void writeChar(control, Uint8Array.of(0x08, 0x01), true).catch(() => undefined);
  }

  private clearPoll() {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
  }

  private scheduleRetry() {
    if (!this.live || this.userClosed || this.opening || this.retryArmed) return;
    if (this.retries >= 4) {
      this.clearPoll();
      this.live = false;
      this.handlers.onDisconnect("The pad stayed disconnected.");
      return;
    }
    this.clearPoll();
    this.fitWrite = null;
    const wait = 1000 * 2 ** this.retries;
    this.retries += 1;
    this.retryArmed = true;
    this.handlers.onLink("reconnecting");
    this.handlers.onLog(`Reconnecting in ${Math.round(wait / 1000)}s.`);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryArmed = false;
      void this.reopen();
    }, wait);
  }

  private async reopen() {
    if (this.userClosed) return;
    try {
      await this.openGatt();
      this.handlers.onLog("Link restored. The belt was not restarted.");
    } catch (err) {
      this.handlers.onLog(`Reconnect failed: ${err instanceof Error ? err.message : "unknown"}`);
      this.scheduleRetry();
    }
  }

  close() {
    this.userClosed = true;
    this.live = false;
    this.retryArmed = false;
    this.clearPoll();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    try {
      this.device?.removeEventListener("gattserverdisconnected", this.onGattDown);
      this.device?.gatt?.disconnect();
    } catch {
      /* already gone */
    }
  }
}
