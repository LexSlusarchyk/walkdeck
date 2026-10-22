import { create } from "zustand";
import type { Phase, RemoteSample } from "@/lib/ble/codec";
import { PadLink, explainBleError, type LinkState, type Picker, type ProtocolPref } from "@/lib/ble/link";
import { kcalPerSecond } from "@/lib/energy";
import { clamp, plausibleTotal, roundTenth } from "@/lib/format";
import { permittedDevice } from "@/lib/ble/web-ble";

export type WalkSource = "pad" | "demo" | "manual";

export type Session = {
  id: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  distanceKm: number;
  kcal: number;
  avgKmh: number;
  maxKmh: number;
  steps: number;
  source: WalkSource;
};

export type Settings = {
  weightKg: number;
  strideM: number;
  ceilingKmh: number;
  protocol: ProtocolPref;
  goalMin: number;
  lastDeviceId: string;
  lastDeviceName: string;
};

type Draft = {
  startedAt: number;
  maxKmh: number;
  source: WalkSource;
  deviceSteps: boolean;
  goaled: boolean;
};

type Persisted = { settings: Settings; sessions: Session[] };

const KEY = "walkdeck.v1";

const defaultSettings: Settings = {
  weightKg: 70,
  strideM: 0.72,
  ceilingKmh: 6,
  protocol: "auto",
  goalMin: 0,
  lastDeviceId: "",
  lastDeviceName: "",
};

function load(): Persisted {
  if (typeof localStorage === "undefined") return { settings: defaultSettings, sessions: [] };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { settings: defaultSettings, sessions: [] };
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      settings: { ...defaultSettings, ...parsed.settings },
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions.slice(0, 400) : [],
    };
  } catch {
    return { settings: defaultSettings, sessions: [] };
  }
}

function save(data: Persisted) {
  localStorage.setItem(KEY, JSON.stringify(data));
}

type Store = Persisted & {
  hydrated: boolean;
  mode: "off" | "demo" | "pad";
  phase: Phase;
  speed: number;
  target: number;
  elapsed: number;
  distanceKm: number;
  kcal: number;
  steps: number;
  stepsEstimated: boolean;
  heart: number | null;
  countdown: number | null;
  deviceName: string;
  protocolLabel: string;
  deviceDetail: string;
  services: string[];
  deviceMin: number;
  deviceMax: number;
  error: string;
  note: string;
  log: string[];
  busy: boolean;
  linkState: "down" | LinkState;
  hydrate: () => void;
  setSettings: (patch: Partial<Settings>) => void;
  setTarget: (kmh: number) => void;
  nudge: (delta: number) => void;
  connect: (opts?: { deviceId?: string; picker?: Picker }) => Promise<void>;
  disconnect: () => void;
  startDemo: () => void;
  begin: () => void;
  pause: () => void;
  stop: () => void;
  tick: () => void;
  addManual: (minutes: number, avgKmh: number) => void;
  removeSession: (id: string) => void;
  applyRemote: (sample: RemoteSample) => void;
};

let link: PadLink | null = null;
let draft: Draft | null = null;
let noteTimer = 0;
let speedTimer = 0;
let deviceElapsedAt = 0;
let deviceKcalAt = 0;
let distanceFreshUntil = 0;
let pauseSentAt = 0;
let remoteSpeed = 0;

function pushLog(line: string) {
  const prev = useWalk.getState().log;
  const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  useWalk.setState({ log: [`${stamp}  ${line}`, ...prev].slice(0, 40) });
}

function ceilingNow() {
  const { settings, deviceMax, mode } = useWalk.getState();
  const cap = Math.min(6, settings.ceilingKmh);
  if (mode === "pad" && deviceMax > 0) return Math.min(cap, deviceMax);
  return cap;
}

function floorNow() {
  const { deviceMin, mode } = useWalk.getState();
  if (mode === "pad" && deviceMin > 0) return Math.max(1, deviceMin);
  return 1;
}

function finish(reason: string) {
  const state = useWalk.getState();
  if (!draft) {
    useWalk.setState({
      phase: "idle",
      speed: 0,
      countdown: null,
      elapsed: 0,
      distanceKm: 0,
      kcal: 0,
      steps: 0,
    });
    return;
  }
  const duration = state.elapsed;
  const keep = duration >= 20 || state.distanceKm >= 0.05;
  if (keep) {
    const session: Session = {
      id: `${draft.startedAt}-${Math.round(duration)}`,
      startedAt: draft.startedAt,
      endedAt: Date.now(),
      durationSec: Math.round(duration),
      distanceKm: state.distanceKm,
      kcal: state.kcal,
      avgKmh: duration > 0 ? state.distanceKm / (duration / 3600) : 0,
      maxKmh: draft.maxKmh,
      steps: state.steps,
      source: draft.source,
    };
    const sessions = [session, ...state.sessions].slice(0, 400);
    save({ settings: state.settings, sessions });
    useWalk.setState({ sessions, note: "Walk saved." });
  } else {
    useWalk.setState({ note: "Too short to save." });
  }
  draft = null;
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => useWalk.setState({ note: "" }), 4000);
  useWalk.setState({
    phase: "idle",
    speed: 0,
    countdown: null,
  });
  if (reason === "safety") {
    useWalk.setState({ error: "Safety key is out. Clip it back in, then start again." });
  }
  if (reason === "fault") {
    useWalk.setState({ error: "The pad reported a fault and stopped." });
  }
}

function ensureDraft(source: WalkSource) {
  if (draft) return;
  draft = { startedAt: Date.now(), maxKmh: 0, source, deviceSteps: false, goaled: false };
  deviceElapsedAt = 0;
  deviceKcalAt = 0;
  distanceFreshUntil = 0;
  useWalk.setState({
    elapsed: 0,
    distanceKm: 0,
    kcal: 0,
    steps: 0,
    stepsEstimated: true,
    heart: null,
  });
}

function markGoal(elapsed: number) {
  const goalMin = useWalk.getState().settings.goalMin;
  if (!draft || draft.goaled || goalMin <= 0 || elapsed < goalMin * 60) return;
  draft.goaled = true;
  useWalk.setState({ note: `${goalMin} min goal reached. The belt is still moving.` });
  window.clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => useWalk.setState({ note: "" }), 8000);
  window.dispatchEvent(new CustomEvent("walkdeck-goal"));
}

function sendSpeed(kmh: number) {
  if (useWalk.getState().mode !== "pad" || !link) return;
  const phase = useWalk.getState().phase;
  if (phase !== "running" && phase !== "countdown") return;
  window.clearTimeout(speedTimer);
  speedTimer = window.setTimeout(() => link?.setSpeed(kmh), 140);
}

export const useWalk = create<Store>((set, get) => ({
  settings: defaultSettings,
  sessions: [],
  hydrated: false,
  mode: "off",
  phase: "idle",
  speed: 0,
  target: 3,
  elapsed: 0,
  distanceKm: 0,
  kcal: 0,
  steps: 0,
  stepsEstimated: true,
  heart: null,
  countdown: null,
  deviceName: "",
  protocolLabel: "",
  deviceDetail: "",
  services: [],
  deviceMin: 1,
  deviceMax: 6,
  error: "",
  note: "",
  log: [],
  busy: false,
  linkState: "down",

  hydrate: () => {
    const data = load();
    set({ ...data, hydrated: true });
  },

  setSettings: (patch) => {
    const settings = { ...get().settings, ...patch };
    settings.weightKg = Math.round(clamp(settings.weightKg, 35, 200));
    settings.strideM = Math.round(clamp(settings.strideM, 0.4, 1.2) * 100) / 100;
    settings.ceilingKmh = clamp(roundTenth(settings.ceilingKmh), 1, 6);
    settings.goalMin = Math.round(clamp(settings.goalMin, 0, 180));
    const sessions = get().sessions;
    save({ settings, sessions });
    const target = clamp(get().target, 1, settings.ceilingKmh);
    set({ settings, target });
  },

  setTarget: (kmh) => {
    const target = clamp(roundTenth(kmh), floorNow(), ceilingNow());
    set({ target });
    sendSpeed(target);
  },

  nudge: (delta) => {
    get().setTarget(get().target + delta);
  },

  connect: async (opts) => {
    if (get().busy) return;
    set({ busy: true, error: "" });
    try {
      if (draft) finish("idle");
      if (get().mode === "demo") set({ mode: "off", phase: "idle", speed: 0, countdown: null });
      link?.close();
      link = new PadLink({
        onSample: (sample) => get().applyRemote(sample),
        onLog: pushLog,
        onLink: (linkState) =>
          set({
            linkState,
            note:
              linkState === "reconnecting"
                ? "Link dropped. Reconnecting… The handheld remote still stops the belt."
                : get().note,
          }),
        onIdentity: (info) => {
          const settings = {
            ...get().settings,
            lastDeviceId: info.id,
            lastDeviceName: info.name,
          };
          save({ settings, sessions: get().sessions });
          set({
            settings,
            deviceName: info.name,
            protocolLabel: info.protocol,
            deviceDetail: info.detail,
            services: info.services,
            mode: info.protocol === "Unknown" ? "off" : "pad",
            linkState: info.protocol === "Unknown" ? "down" : "up",
          });
        },
        onLimits: ({ min, max }) => set({ deviceMin: min, deviceMax: Math.min(6, max) }),
        onDisconnect: (message) => {
          if (get().phase === "running" || get().phase === "paused" || get().phase === "countdown") {
            finish("idle");
          }
          set({
            mode: "off",
            linkState: "down",
            error: `${message} If the belt is still moving, stop it with the handheld remote.`,
            phase: "idle",
            speed: 0,
          });
          link = null;
        },
      });
      const picker = opts?.picker ?? "filtered";
      if (opts?.deviceId && !permittedDevice(opts.deviceId)) {
        throw new Error("That pad is not permitted yet. Choose it from the Bluetooth list once.");
      }
      await link.connect({
        pref: get().settings.protocol,
        weightKg: get().settings.weightKg,
        fitUser: 0x51a2,
        picker,
        deviceId: opts?.deviceId,
      });
      if (get().protocolLabel === "Unknown") {
        set({
          error: "Connected, but this device didn't offer a known pad protocol. You can still log the walk by hand.",
        });
      }
    } catch (err) {
      link?.close();
      link = null;
      set({ error: explainBleError(err), mode: "off", linkState: "down" });
    } finally {
      set({ busy: false });
    }
  },

  disconnect: () => {
    if (get().mode === "pad") link?.stop();
    if (draft) finish("idle");
    link?.close();
    link = null;
    set({
      mode: "off",
      phase: "idle",
      speed: 0,
      protocolLabel: "",
      deviceName: "",
      deviceDetail: "",
      services: [],
      countdown: null,
      linkState: "down",
    });
  },

  startDemo: () => {
    if (get().mode === "pad") {
      link?.stop();
      link?.close();
      link = null;
    }
    if (draft) finish("idle");
    set({
      mode: "demo",
      error: "",
      phase: "idle",
      speed: 0,
      note: "",
      protocolLabel: "",
      deviceName: "",
      services: [],
      linkState: "down",
    });
  },

  begin: () => {
    const { mode, phase, target } = get();
    if (mode === "off") return;
    if (phase === "running" || phase === "countdown") return;
    set({ error: "" });
    if (phase === "paused") {
      set({ phase: "countdown", countdown: 3 });
      if (mode === "pad") link?.start(target);
      return;
    }
    ensureDraft(mode === "pad" ? "pad" : "demo");
    set({ phase: "countdown", countdown: 3, speed: 0 });
    if (mode === "pad") link?.start(target);
  },

  pause: () => {
    const { mode, phase } = get();
    if (phase !== "running" && phase !== "countdown") return;
    pauseSentAt = mode === "pad" ? Date.now() : 0;
    set({ phase: "paused", countdown: null, error: "" });
    if (mode === "pad") link?.pause();
  },

  stop: () => {
    const { mode, phase } = get();
    if (phase === "idle" && !draft) return;
    if (mode === "pad") link?.stop();
    if (mode === "demo" && get().speed > 0.2) {
      set({ phase: "stopping", countdown: null });
      return;
    }
    finish("idle");
    set({ phase: "idle", speed: 0, countdown: null });
  },

  tick: () => {
    const s = get();
    if (s.mode === "off") return;
    const dt = 0.2;
    if (s.mode === "demo") {
      if (s.phase === "countdown") {
        const countdown = (s.countdown ?? 3) - dt;
        if (countdown <= 0) set({ phase: "running", countdown: null, speed: 0 });
        else set({ countdown });
        return;
      }
      if (s.phase === "paused") {
        const speed = Math.max(0, s.speed - 0.25);
        set({ speed });
        return;
      }
      if (s.phase === "running" || s.phase === "stopping") {
        const goal = s.phase === "stopping" ? 0 : s.target;
        const step = 0.16;
        const speed = roundTenth(s.speed + clamp(goal - s.speed, -step, step));
        const moving = s.phase === "running" || speed > 0;
        const elapsed = s.elapsed + (moving ? dt : 0);
        const distanceKm = s.distanceKm + (speed / 3600) * dt;
        const kcal = s.kcal + kcalPerSecond(speed, s.settings.weightKg) * dt;
        const steps = Math.round((distanceKm * 1000) / s.settings.strideM);
        if (draft) draft.maxKmh = Math.max(draft.maxKmh, speed);
        if (s.phase === "stopping" && speed <= 0.05) {
          set({ speed: 0, elapsed, distanceKm, kcal, steps, stepsEstimated: true });
          finish("idle");
          return;
        }
        set({ speed: Math.max(0, speed), elapsed, distanceKm, kcal, steps, stepsEstimated: true });
        markGoal(elapsed);
      }
      return;
    }

    if (s.linkState === "reconnecting") return;

    if (
      s.phase === "paused" &&
      pauseSentAt > 0 &&
      Date.now() - pauseSentAt > 2200 &&
      remoteSpeed > 0.35
    ) {
      pauseSentAt = 0;
      set({
        phase: "running",
        error: "Pause did not take. The belt is still moving — press Stop.",
      });
    }

    if (s.phase === "countdown") {
      set({ countdown: Math.max(0, (s.countdown ?? 3) - dt) });
    }

    if (s.phase === "countdown" || s.phase === "running" || s.phase === "stopping" || s.phase === "paused") {
      const freshTime = Date.now() - deviceElapsedAt < 2500;
      const clocking = s.phase === "running" || s.phase === "stopping";
      const elapsed = freshTime ? s.elapsed : s.elapsed + (clocking ? dt : 0);
      const speed = s.phase === "paused" || s.phase === "countdown" ? 0 : s.speed;
      const distanceKm =
        Date.now() < distanceFreshUntil ? s.distanceKm : s.distanceKm + (speed / 3600) * dt;
      const kcal =
        Date.now() - deviceKcalAt < 2500 ? s.kcal : s.kcal + kcalPerSecond(speed, s.settings.weightKg) * dt;
      const steps = s.stepsEstimated ? Math.round((distanceKm * 1000) / s.settings.strideM) : s.steps;
      if (draft) draft.maxKmh = Math.max(draft.maxKmh, speed);
      set({ elapsed, distanceKm, kcal, steps, speed });
      markGoal(elapsed);
      if (s.phase === "stopping" && speed < 0.2) finish("idle");
    }
  },

  applyRemote: (sample) => {
    if (get().mode !== "pad") return;
    if (sample.phase === "safety") {
      finish("safety");
      return;
    }
    if (sample.phase === "fault") {
      finish("fault");
      return;
    }
    if (sample.phase === "idle") {
      const phase = get().phase;
      const slow = get().speed < 0.4 && remoteSpeed < 0.4;
      if ((phase === "running" || phase === "stopping") && slow) finish("idle");
      if (phase === "paused" && slow) finish("idle");
      return;
    }

    const patch: Partial<Store> = {};
    if (sample.phase) {
      ensureDraft("pad");
      patch.phase = sample.phase;
      if (sample.phase === "countdown") patch.countdown = sample.countdown ?? get().countdown ?? 3;
    }
    const nextPhase = sample.phase ?? get().phase;
    if (typeof sample.speedKmh === "number") remoteSpeed = sample.speedKmh;
    if (typeof sample.speedKmh === "number" && nextPhase !== "countdown" && nextPhase !== "paused") {
      patch.speed = sample.speedKmh;
    }
    if (nextPhase === "paused") patch.speed = 0;
    if (sample.elapsedSec != null) {
      patch.elapsed = sample.elapsedSec;
      deviceElapsedAt = Date.now();
    }
    if (sample.kcal != null && sample.kcal > 0 && sample.kcal < 5000) {
      const expected = kcalPerSecond(Math.max(get().speed, 0.8), get().settings.weightKg) * Math.max(get().elapsed, 1);
      if (plausibleTotal(sample.kcal, expected, 6, 5000)) {
        patch.kcal = sample.kcal;
        deviceKcalAt = Date.now();
      }
    }
    if (sample.steps != null && sample.steps > 0) {
      patch.steps = sample.steps;
      patch.stepsEstimated = false;
      if (draft) draft.deviceSteps = true;
    }
    if (sample.heart !== undefined) patch.heart = sample.heart;
    if (sample.distanceKm != null && sample.distanceKm > 0.001 && sample.distanceKm < 80) {
      const expected = (Math.max(get().speed, 0.8) * Math.max(get().elapsed, 1)) / 3600;
      if (plausibleTotal(sample.distanceKm, expected, 2.5, 40)) {
        patch.distanceKm = sample.distanceKm;
        distanceFreshUntil = Date.now() + 2500;
      }
    }
    if (sample.phase === "paused" || remoteSpeed < 0.3) {
      pauseSentAt = 0;
    }
    set(patch);
  },

  addManual: (minutes, avgKmh) => {
    const durationSec = Math.round(clamp(minutes, 1, 300) * 60);
    const speed = clamp(avgKmh, 0.5, get().settings.ceilingKmh);
    const distanceKm = speed * (durationSec / 3600);
    const kcal = kcalPerSecond(speed, get().settings.weightKg) * durationSec;
    const steps = Math.round((distanceKm * 1000) / get().settings.strideM);
    const startedAt = Date.now() - durationSec * 1000;
    const session: Session = {
      id: `manual-${startedAt}`,
      startedAt,
      endedAt: Date.now(),
      durationSec,
      distanceKm,
      kcal,
      avgKmh: speed,
      maxKmh: speed,
      steps,
      source: "manual",
    };
    const sessions = [session, ...get().sessions].slice(0, 400);
    save({ settings: get().settings, sessions });
    set({ sessions, note: "Walk saved." });
    window.clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => set({ note: "" }), 4000);
  },

  removeSession: (id) => {
    const sessions = get().sessions.filter((s) => s.id !== id);
    save({ settings: get().settings, sessions });
    set({ sessions });
  },
}));

export function downloadStats(sessions: Session[]) {
  const header = "started,minutes,distance_km,kcal,avg_kmh,max_kmh,steps,source\n";
  const rows = [...sessions]
    .reverse()
    .map((s) =>
      [
        new Date(s.startedAt).toISOString(),
        (s.durationSec / 60).toFixed(1),
        s.distanceKm.toFixed(3),
        Math.round(s.kcal),
        s.avgKmh.toFixed(2),
        s.maxKmh.toFixed(2),
        s.steps,
        s.source,
      ].join(","),
    )
    .join("\n");
  const blob = new Blob([header + rows], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "energyfit-walks.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function stopPadOnLeave() {
  link?.stop();
}
