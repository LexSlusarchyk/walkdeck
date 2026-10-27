import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Bluetooth, Download, Keyboard, Minus, Pause, Play, Plus, ShieldAlert, Square, Trash2 } from "lucide-react";
import { blocker, detectHost, macName, refineHost, type BleHost } from "@/lib/ble/host";
import { listPermitted } from "@/lib/ble/web-ble";
import { formatDuration, formatKm, formatPace, roundTenth } from "@/lib/format";
import { downloadStats, stopPadOnLeave, useWalk, type Session } from "@/lib/walk-store";

const PRESETS = [1, 2, 3, 4, 4.5, 5, 5.5, 6];
const GOALS = [0, 15, 30, 45, 60];

function lastDays(sessions: Session[], count: number) {
  const days = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  for (let i = count - 1; i >= 0; i -= 1) {
    const day = new Date(start);
    day.setDate(start.getDate() - i);
    const next = new Date(day);
    next.setDate(day.getDate() + 1);
    const km = sessions
      .filter((s) => s.startedAt >= day.getTime() && s.startedAt < next.getTime())
      .reduce((sum, s) => sum + s.distanceKm, 0);
    days.push({
      key: day.toISOString(),
      label: ["S", "M", "T", "W", "T", "F", "S"][day.getDay()]!,
      km,
    });
  }
  return days;
}

function emptyWeek() {
  return Array.from({ length: 7 }, (_, i) => ({ key: `d${i}`, label: "", km: 0 }));
}

function todayHours(sessions: Session[]) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const dayStart = start.getTime();
  const dayEnd = dayStart + 86_400_000;
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    km: 0,
    label: hour % 6 === 0 ? String(hour).padStart(2, "0") : "",
  }));
  for (const session of sessions) {
    const sessionEnd = session.startedAt + session.durationSec * 1000;
    const segStart = Math.max(session.startedAt, dayStart);
    const segEnd = Math.min(sessionEnd, dayEnd);
    if (segEnd <= segStart) continue;
    const span = Math.max(1, sessionEnd - session.startedAt);
    let cursor = segStart;
    while (cursor < segEnd) {
      const stamp = new Date(cursor);
      const hourEnd = new Date(stamp);
      hourEnd.setMinutes(0, 0, 0);
      hourEnd.setHours(stamp.getHours() + 1);
      const sliceEnd = Math.min(segEnd, hourEnd.getTime());
      hours[stamp.getHours()]!.km += session.distanceKm * ((sliceEnd - cursor) / span);
      cursor = sliceEnd;
    }
  }
  return hours;
}

function emptyDay() {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    km: 0,
    label: "",
  }));
}

function sourceLabel(source: Session["source"]) {
  if (source === "pad") return "Pad";
  if (source === "demo") return "Demo";
  return "Logged";
}

let audioCtx: AudioContext | null = null;

type BeforeInstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function armAudio() {
  const Ctx = window.AudioContext;
  if (!Ctx) return;
  audioCtx ??= new Ctx();
  void audioCtx.resume();
}

function chime() {
  if (!audioCtx) return;
  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, now);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.04, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(now);
  osc.stop(now + 0.4);
}

export function Walkdeck() {
  const state = useWalk();
  const [host, setHost] = useState<BleHost | null>(null);
  const [known, setKnown] = useState<Array<{ id: string; name: string }>>([]);
  const [clock, setClock] = useState(false);
  const [minutes, setMinutes] = useState("30");
  const [manualSpeed, setManualSpeed] = useState("3.5");
  const [copied, setCopied] = useState(false);
  const [popNote, setPopNote] = useState("");
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPrompt | null>(null);

  useEffect(() => {
    useWalk.getState().hydrate();
    const detected = detectHost();
    setHost(detected);
    void refineHost(detected).then(setHost);
    setClock(true);
    void listPermitted().then(setKnown);
    const id = window.setInterval(() => useWalk.getState().tick(), 200);
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const walk = useWalk.getState();
      if (event.key === "ArrowUp" || event.key === "ArrowRight") {
        event.preventDefault();
        walk.nudge(0.1);
      } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
        event.preventDefault();
        walk.nudge(-0.1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        walk.stop();
      } else if (event.key === " " || event.key === "Spacebar") {
        event.preventDefault();
        if (walk.mode === "off") return;
        if (walk.phase === "running" || walk.phase === "countdown") walk.pause();
        else if (walk.phase !== "stopping") walk.begin();
      } else if (/^[1-6]$/.test(event.key)) {
        walk.setTarget(Number(event.key));
      }
    };
    const onGoal = () => chime();
    const onHide = (event: BeforeUnloadEvent) => {
      const phase = useWalk.getState().phase;
      if (phase === "running" || phase === "countdown" || phase === "paused") event.preventDefault();
    };
    const onInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPrompt);
    };
    window.addEventListener("beforeinstallprompt", onInstall);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pagehide", stopPadOnLeave);
    window.addEventListener("beforeunload", onHide);
    window.addEventListener("walkdeck-goal", onGoal);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("beforeinstallprompt", onInstall);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pagehide", stopPadOnLeave);
      window.removeEventListener("beforeunload", onHide);
      window.removeEventListener("walkdeck-goal", onGoal);
    };
  }, []);

  useEffect(() => {
    if (state.phase === "running") document.title = `${state.speed.toFixed(1)} km/h · Walkdeck`;
    else if (state.phase === "paused") document.title = "Paused · Walkdeck";
    else if (state.phase === "countdown") document.title = "Starting · Walkdeck";
    else document.title = "Walkdeck";
  }, [state.phase, state.speed]);

  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    const moving = state.phase === "running" || state.phase === "countdown";
    if (!moving || !("wakeLock" in navigator)) return;
    void navigator.wakeLock
      .request("screen")
      .then((sentinel) => {
        lock = sentinel;
      })
      .catch(() => undefined);
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      void navigator.wakeLock.request("screen").then((sentinel) => {
        lock = sentinel;
      }).catch(() => undefined);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      void lock?.release();
    };
  }, [state.phase]);

  const days = useMemo(
    () => (clock ? lastDays(state.sessions, 7) : emptyWeek()),
    [clock, state.sessions],
  );
  const hours = useMemo(
    () => (clock ? todayHours(state.sessions) : emptyDay()),
    [clock, state.sessions],
  );
  const weekKm = days.reduce((sum, day) => sum + day.km, 0);
  const todayKm = hours.reduce((sum, hour) => sum + hour.km, 0);
  const hourPeak = Math.max(0.05, ...hours.map((hour) => hour.km));
  const totalKm = state.sessions.reduce((sum, session) => sum + session.distanceKm, 0);
  const totalKcal = state.sessions.reduce((sum, session) => sum + session.kcal, 0);
  const peak = Math.max(1, ...days.map((day) => day.km));
  const linked = state.mode === "pad";
  const armed = state.mode !== "off";
  const blocked = host ? blocker(host) : null;
  const needsWindow = Boolean(host?.embedded && !blocked);
  const canConnectHere = Boolean(host && !blocked && !host.embedded);
  const remembered = known.find((device) => device.id === state.settings.lastDeviceId);
  const ceiling =
    linked && state.deviceMax > 0
      ? Math.min(6, state.settings.ceilingKmh, state.deviceMax)
      : Math.min(6, state.settings.ceilingKmh);
  const goalSec = state.settings.goalMin > 0 ? state.settings.goalMin * 60 : 0;

  const status = state.linkState === "reconnecting"
    ? "Reconnecting"
    : linked
      ? state.protocolLabel === "Unknown"
        ? "Heard the device, no control channel"
        : `Linked · ${state.protocolLabel || "pad"}`
      : state.mode === "demo"
        ? "Demo belt"
        : "Not linked";

  const desk = macName(host);
  const where = !host
    ? ""
    : blocked
      ? blocked
      : needsWindow
        ? `Bluetooth is blocked inside this chat pane. Open Walkdeck in its own window on ${desk}, then connect. This pane will not move the belt.`
        : !host.apple
          ? "The pad connects from Chrome on your MacBook Pro, not from this preview. Demo walks never start the real belt."
          : "Ready on your MacBook. Quit Spax on the phone first — the pad links to one device only. Do not pair it in the macOS Bluetooth menu. Closing the lid drops the radio; Walkdeck reconnects and will not restart the belt.";

  function onManual(event: FormEvent) {
    event.preventDefault();
    const mins = Number(minutes);
    const speed = Number(manualSpeed);
    if (!Number.isFinite(mins) || !Number.isFinite(speed) || mins <= 0 || speed <= 0) return;
    state.addManual(mins, speed);
  }

  function popOut() {
    const opened = window.open(window.location.href, "_blank");
    if (!opened) {
      setPopNote("The browser blocked the new window. Allow pop-ups for this site, then try again.");
    } else {
      setPopNote("Use the new window to connect. Leave the lid open while the belt is moving.");
    }
  }

  async function connect(opts: { deviceId?: string; picker?: "filtered" | "all" }) {
    await state.connect(opts);
    setKnown(await listPermitted());
  }

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(state.log.join("\n") || "No Bluetooth traffic yet.");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  const speedReadout =
    state.phase === "countdown"
      ? (state.countdown ?? 0) <= 0
        ? "…"
        : String(Math.max(1, Math.ceil(state.countdown ?? 3)))
      : state.speed.toFixed(1);

  return (
    <div className="min-h-dvh bg-bg text-fg">
      <header className="sticky top-0 z-10 border-b border-line bg-bg">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-medium tracking-widest text-muted">WALKDECK · MACBOOK</p>
            <h1 className="truncate text-xl font-semibold tracking-tight">EnergyFIT EF-X512NS</h1>
          </div>
          <button
            type="button"
            onClick={() => {
              if (linked) {
                state.disconnect();
                return;
              }
              if (needsWindow) {
                popOut();
                return;
              }
              void connect(remembered ? { deviceId: remembered.id } : { picker: "filtered" });
            }}
            disabled={state.busy || (linked ? false : !needsWindow && !canConnectHere)}
            className="inline-flex h-11 max-w-56 items-center gap-2 rounded-full bg-led px-4 text-sm font-semibold text-bg disabled:opacity-40"
          >
            <Bluetooth className="size-4 shrink-0" aria-hidden="true" />
            <span className="truncate">
              {state.busy
                ? "Looking…"
                : linked
                  ? "Disconnect"
                  : needsWindow
                    ? "Open Mac window"
                    : !canConnectHere
                      ? "Connect on your Mac"
                      : remembered
                        ? `Reconnect ${remembered.name}`
                        : "Connect pad"}
            </span>
          </button>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-5">
        <section className="lg:col-span-3">
          <div className="rounded-card border border-line bg-panel p-5 sm:p-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium tracking-widest text-muted">
                  {state.phase === "countdown" ? "STARTING" : "SPEED"}
                </p>
                <p className="font-mono text-6xl font-medium leading-none tracking-tight tabular-nums sm:text-8xl">
                  {speedReadout}
                </p>
                <p className="mt-2 text-sm text-muted">{state.phase === "countdown" ? "seconds" : "km/h"}</p>
              </div>
              <div className="text-right">
                <p className="text-xs font-medium tracking-widest text-muted">TARGET</p>
                <p className="font-mono text-3xl tabular-nums text-led">{state.target.toFixed(1)}</p>
                <p className="mt-1 text-sm text-muted">{formatPace(state.speed)} /km</p>
              </div>
            </div>

            <div
              className="belt mt-5"
              data-moving={state.speed > 0.15 ? "true" : "false"}
              style={{ ["--belt" as string]: `${Math.max(0.28, 1.3 - state.speed * 0.12)}s` }}
            >
              <span style={{ animationDuration: "var(--belt)" }} />
            </div>
            {goalSec > 0 ? (
              <div
                className="mt-3 h-1.5 overflow-hidden rounded-full bg-panel-2"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={goalSec}
                aria-valuenow={Math.min(goalSec, Math.floor(state.elapsed))}
                aria-label="Goal"
              >
                <div
                  className="h-full bg-led"
                  style={{ width: `${Math.min(100, (state.elapsed / goalSec) * 100)}%` }}
                />
              </div>
            ) : null}

            <dl className="mt-5 grid grid-cols-2 gap-4 border-t border-line pt-5 sm:grid-cols-4">
              <Metric label="Time" value={formatDuration(state.elapsed)} />
              <Metric label="Distance" value={formatKm(state.distanceKm)} unit="km" />
              <Metric label="Calories" value={String(Math.round(state.kcal))} unit="kcal" />
              <Metric label={state.stepsEstimated ? "Steps est." : "Steps"} value={state.steps.toLocaleString()} />
            </dl>
            {state.heart ? <p className="mt-3 text-sm text-muted">Heart rate {state.heart} bpm</p> : null}

            <div className="mt-6 flex items-center gap-3">
              <button
                type="button"
                aria-label="Slower"
                onClick={() => state.nudge(-0.1)}
                disabled={!armed}
                className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-panel-2 text-fg disabled:opacity-40"
              >
                <Minus className="size-4" aria-hidden="true" />
              </button>
              <input
                aria-label="Target speed"
                type="range"
                min={1}
                max={ceiling}
                step={0.1}
                value={Math.min(state.target, ceiling)}
                disabled={!armed}
                onChange={(event) => state.setTarget(Number(event.target.value))}
              />
              <button
                type="button"
                aria-label="Faster"
                onClick={() => state.nudge(0.1)}
                disabled={!armed}
                className="grid size-11 shrink-0 place-items-center rounded-full border border-line bg-panel-2 text-fg disabled:opacity-40"
              >
                <Plus className="size-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {PRESETS.filter((speed) => speed <= ceiling + 0.001).map((speed) => {
                const on = Math.abs(state.target - speed) < 0.05;
                return (
                  <button
                    key={speed}
                    type="button"
                    onClick={() => state.setTarget(speed)}
                    disabled={!armed}
                    className={
                      on
                        ? "h-11 rounded-full bg-led px-4 text-sm font-semibold text-bg"
                        : "h-11 rounded-full border border-line bg-panel-2 px-4 text-sm text-fg disabled:opacity-40"
                    }
                  >
                    {speed.toFixed(1)}
                  </button>
                );
              })}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {GOALS.map((minutes) => {
                const on = state.settings.goalMin === minutes;
                return (
                  <button
                    key={minutes}
                    type="button"
                    onClick={() => state.setSettings({ goalMin: minutes })}
                    className={
                      on
                        ? "h-11 rounded-full bg-led px-4 text-sm font-semibold text-bg"
                        : "h-11 rounded-full border border-line bg-panel-2 px-4 text-sm text-fg"
                    }
                  >
                    {minutes === 0 ? "No goal" : `${minutes} min`}
                  </button>
                );
              })}
            </div>

            <div className="mt-5 flex gap-3">
              {state.phase === "running" || state.phase === "countdown" ? (
                <button
                  type="button"
                  onClick={() => state.pause()}
                  className="inline-flex h-14 flex-1 items-center justify-center gap-2 rounded-2xl border border-line bg-panel-2 text-base font-semibold"
                >
                  <Pause className="size-5" aria-hidden="true" />
                  Pause
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    armAudio();
                    state.begin();
                  }}
                  disabled={!armed || state.phase === "stopping"}
                  className="inline-flex h-14 flex-1 items-center justify-center gap-2 rounded-2xl bg-led text-base font-semibold text-bg disabled:opacity-40"
                >
                  <Play className="size-5" aria-hidden="true" />
                  {state.phase === "paused" ? "Resume" : "Start belt"}
                </button>
              )}
              <button
                type="button"
                onClick={() => state.stop()}
                disabled={state.phase === "idle" || state.phase === "stopping"}
                className="inline-flex h-14 items-center justify-center gap-2 rounded-2xl bg-stop px-6 text-base font-semibold text-bg disabled:opacity-40"
              >
                <Square className="size-4 fill-current" aria-hidden="true" />
                {state.phase === "stopping" ? "Slowing" : "Stop"}
              </button>
            </div>

            {!armed ? (
              <button
                type="button"
                onClick={() => state.startDemo()}
                className={
                  canConnectHere
                    ? "mt-3 h-11 w-full rounded-2xl border border-line text-sm text-muted"
                    : "mt-3 h-11 w-full rounded-2xl bg-led text-sm font-semibold text-bg"
                }
              >
                Try the demo belt — the real pad stays still
              </button>
            ) : null}

            {state.mode === "demo" ? (
              <p className="mt-4 text-sm text-led">
                Demo belt. Nothing is sent to the treadmill.{" "}
                <button type="button" onClick={() => state.disconnect()} className="underline">
                  Leave demo
                </button>
              </p>
            ) : null}
            {state.note ? <p className="mt-3 text-sm text-led">{state.note}</p> : null}
            {state.error ? <p className="mt-3 text-sm text-stop">{state.error}</p> : null}
            <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
              <Keyboard className="size-3.5" aria-hidden="true" />
              <Key>1</Key>–<Key>6</Key> speed
              <Key>↑</Key>
              <Key>↓</Key> nudge
              <Key>space</Key> pause
              <Key>esc</Key> stop
            </p>
          </div>
        </section>

        <aside className="flex flex-col gap-4 lg:col-span-2">
          <div className="rounded-card border border-line bg-panel p-5">
            <div className="flex items-center gap-2">
              <span
                className={`size-2 rounded-full ${linked && state.linkState !== "reconnecting" ? "bg-led" : "bg-line"} ${state.linkState === "reconnecting" ? "link-wait bg-led" : ""}`}
              />
              <p className="text-xs font-medium tracking-widest text-muted">LINK</p>
            </div>
            <p className="mt-2 text-lg font-semibold">{status}</p>
            <p className="mt-1 truncate text-sm text-muted">{state.deviceName || "EnergyFIT walking pad"}</p>
            {state.deviceDetail ? <p className="mt-2 text-sm text-muted">{state.deviceDetail}</p> : null}
            {state.services.length > 0 ? (
              <p className="mt-3 font-mono text-xs text-muted">{state.services.join("  ")}</p>
            ) : null}
            {!linked ? (
              <ol className="mt-4 list-decimal space-y-2 pl-4 text-sm leading-relaxed text-muted">
                <li>On the MacBook Pro, use Chrome, Edge, Brave, or Arc. Safari cannot open Bluetooth.</li>
                <li>If you are inside chat, choose Open Mac window so the page is not embedded.</li>
                <li>System Settings, Privacy & Security, Bluetooth — allow that browser. Do not pair the pad in the macOS device list. Forget it there if you already did.</li>
                <li>Quit Spax on your phone. Power the pad, clip the safety key, then connect. The name usually starts with FS.</li>
              </ol>
            ) : (
              <p className="mt-4 text-sm leading-relaxed text-muted">
                Speed changes go out once the belt reports it is running. Stop is immediate. The handheld remote still works. Leave the lid open — sleep drops Bluetooth and does not restart the belt.
              </p>
            )}
            {where ? <p className="mt-3 text-sm leading-relaxed text-muted">{where}</p> : null}
            {popNote ? <p className="mt-3 text-sm text-led">{popNote}</p> : null}
            {!linked ? (
              <div className="mt-4 flex flex-col gap-2">
                {needsWindow ? (
                  <button
                    type="button"
                    onClick={popOut}
                    className="h-11 rounded-full bg-led text-sm font-semibold text-bg"
                  >
                    Open Mac window
                  </button>
                ) : null}
                {installPrompt ? (
                  <button
                    type="button"
                    onClick={() => {
                      void installPrompt.prompt().then(() => setInstallPrompt(null));
                    }}
                    className="h-11 rounded-full border border-line text-sm"
                  >
                    Add Walkdeck to the Dock
                  </button>
                ) : null}
                {remembered ? (
                  <button
                    type="button"
                    disabled={state.busy || !canConnectHere}
                    onClick={() => void connect({ picker: "filtered" })}
                    className="h-11 rounded-full border border-line text-sm disabled:opacity-40"
                  >
                    Choose a different pad
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={state.busy || !canConnectHere}
                  onClick={() => void connect({ picker: "all" })}
                  className="h-11 rounded-full border border-line text-sm disabled:opacity-40"
                >
                  Show every Bluetooth device
                </button>
              </div>
            ) : null}
          </div>

          <div className="rounded-card border border-line bg-panel p-5">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-medium tracking-widest text-muted">THIS WEEK</p>
              <p className="font-mono text-sm tabular-nums">{formatKm(weekKm)} km</p>
            </div>
            <div className="mt-4 flex h-28 items-end gap-2">
              {days.map((day) => (
                <div key={day.key} className="flex h-full flex-1 flex-col justify-end gap-2">
                  <div
                    className={day.km > 0 ? "rounded-t-md bg-led" : "rounded-t-md bg-line"}
                    style={{ height: `${Math.max(day.km > 0 ? 8 : 4, (day.km / peak) * 100)}%` }}
                  />
                  <span className="text-center text-xs text-muted">{day.label}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted">
              {formatKm(totalKm)} km saved · {state.sessions.length} walks · {Math.round(totalKcal).toLocaleString()} kcal
            </p>
          </div>

          <div className="rounded-card border border-line bg-panel p-5">
            <div className="flex items-baseline justify-between">
              <p className="text-xs font-medium tracking-widest text-muted">TODAY</p>
              <p className="font-mono text-sm tabular-nums">{formatKm(todayKm)} km</p>
            </div>
            <div className="mt-4 flex h-28 items-end gap-0.5">
              {hours.map((hour) => (
                <div key={hour.hour} className="flex h-full min-w-0 flex-1 flex-col justify-end gap-2">
                  <div
                    className={hour.km > 0 ? "rounded-t-sm bg-led" : "rounded-t-sm bg-line"}
                    style={{ height: `${Math.max(hour.km > 0 ? 8 : 3, (hour.km / hourPeak) * 100)}%` }}
                    title={hour.km > 0 ? `${hour.hour}:00 · ${formatKm(hour.km)} km` : `${hour.hour}:00`}
                  />
                  <span className="truncate text-center text-[10px] text-muted">{hour.label}</span>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm text-muted">Distance by hour, midnight to midnight.</p>
          </div>

          <div className="flex gap-2 rounded-card border border-line bg-panel px-4 py-3 text-sm text-muted">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-led" aria-hidden="true" />
            <p>Rated 1–6 km/h and 100 kg. Incline is the manual feet, about 0–3°, not a button. Stay on the belt. The safety key still cuts the motor.</p>
          </div>
        </aside>

        <section className="rounded-card border border-line bg-panel p-5 sm:p-6 lg:col-span-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Saved walks</h2>
            <button
              type="button"
              onClick={() => downloadStats(state.sessions)}
              disabled={state.sessions.length === 0}
              className="inline-flex h-11 items-center gap-2 rounded-full border border-line px-4 text-sm disabled:opacity-40"
            >
              <Download className="size-4" aria-hidden="true" />
              Download CSV
            </button>
          </div>
          <p className="mt-2 text-sm text-muted">
            Saved in this browser on your Mac. Nothing is uploaded. They do not sync with Spax. Download the CSV if you want a file in Downloads.
          </p>

          {state.sessions.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No walks yet. Connect the pad, try the demo, or log one below.</p>
          ) : (
            <ul className="mt-4 divide-y divide-line">
              {state.sessions.slice(0, 20).map((session) => (
                <li key={session.id} className="flex items-center gap-3 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">
                      {new Date(session.startedAt).toLocaleString(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </p>
                    <p className="text-sm text-muted">
                      {formatDuration(session.durationSec)} · {formatKm(session.distanceKm)} km · {Math.round(session.kcal)} kcal ·{" "}
                      {session.steps.toLocaleString()} steps · {sourceLabel(session.source)}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Delete walk"
                    onClick={() => state.removeSession(session.id)}
                    className="grid size-11 place-items-center rounded-full text-muted"
                  >
                    <Trash2 className="size-4" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form onSubmit={onManual} className="mt-6 grid gap-3 border-t border-line pt-5 sm:grid-cols-4">
            <label className="text-sm text-muted">
              Minutes
              <input
                value={minutes}
                onChange={(event) => setMinutes(event.target.value)}
                inputMode="decimal"
                className="mt-1 h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-fg"
              />
            </label>
            <label className="text-sm text-muted">
              Avg km/h
              <input
                value={manualSpeed}
                onChange={(event) => setManualSpeed(event.target.value)}
                inputMode="decimal"
                className="mt-1 h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-fg"
              />
            </label>
            <div className="flex items-end sm:col-span-2">
              <button type="submit" className="h-11 rounded-full border border-line px-5 text-sm font-medium">
                Log a walk you already did
              </button>
            </div>
          </form>

          <div className="mt-6 grid gap-3 border-t border-line pt-5 sm:grid-cols-4">
            <Field label="Weight kg" value={state.settings.weightKg} digits={0} onChange={(value) => state.setSettings({ weightKg: value })} />
            <Field label="Stride m" value={state.settings.strideM} digits={2} onChange={(value) => state.setSettings({ strideM: value })} />
            <Field
              label="Speed cap"
              value={state.settings.ceilingKmh}
              digits={1}
              onChange={(value) => state.setSettings({ ceilingKmh: roundTenth(value) })}
            />
            <label className="text-sm text-muted">
              Protocol
              <select
                value={state.settings.protocol}
                onChange={(event) =>
                  state.setSettings({ protocol: event.target.value as "auto" | "fitshow" | "ftms" })
                }
                className="mt-1 h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-fg"
              >
                <option value="auto">Auto — FitShow, then FTMS</option>
                <option value="fitshow">FitShow (Spax pads)</option>
                <option value="ftms">FTMS standard</option>
              </select>
            </label>
          </div>
          <p className="mt-3 text-xs text-muted">
            Spax on this model speaks FitShow. Leave protocol on Auto. Calories use your weight when the pad does not send its own. Reconnect after changing protocol.
          </p>

          <details className="mt-5">
            <summary className="cursor-pointer text-sm text-muted">Bluetooth log</summary>
            <div className="mt-3 flex justify-end">
              <button type="button" onClick={() => void copyLog()} className="text-sm text-led">
                {copied ? "Copied" : "Copy log"}
              </button>
            </div>
            <pre className="mt-2 max-h-48 overflow-auto font-mono text-xs leading-relaxed text-muted">
              {state.log.length ? state.log.join("\n") : "Traffic shows up here after you connect."}
            </pre>
          </details>
        </section>
      </main>
    </div>
  );
}

function Key({ children }: { children: string }) {
  return (
    <kbd className="rounded-md border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-xs text-fg">{children}</kbd>
  );
}

function Metric({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div>
      <dt className="text-xs font-medium tracking-widest text-muted">{label.toUpperCase()}</dt>
      <dd className="mt-1 font-mono text-2xl tabular-nums">
        {value}
        {unit ? <span className="ml-1 text-sm text-muted">{unit}</span> : null}
      </dd>
    </div>
  );
}

function Field({
  label,
  value,
  digits,
  onChange,
}: {
  label: string;
  value: number;
  digits: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(value.toFixed(digits));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value.toFixed(digits));
  }, [value, digits, focused]);
  return (
    <label className="text-sm text-muted">
      {label}
      <input
        inputMode="decimal"
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          const next = Number(text);
          if (Number.isFinite(next)) onChange(next);
          else setText(value.toFixed(digits));
        }}
        onChange={(event) => setText(event.target.value)}
        className="mt-1 h-11 w-full rounded-xl border border-line bg-panel-2 px-3 text-fg"
      />
    </label>
  );
}
