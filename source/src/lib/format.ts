export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

export function formatPace(kmh: number): string {
  if (kmh < 0.3) return "–";
  const min = 60 / kmh;
  const m = Math.floor(min);
  const s = Math.round((min - m) * 60);
  if (s === 60) return `${m + 1}:00`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatKm(km: number): string {
  return km.toFixed(2);
}

export function hex(data: Uint8Array | number[]): string {
  const arr = data instanceof Uint8Array ? data : data;
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function plausibleTotal(
  reported: number,
  expected: number,
  spread = 2.5,
  cap = 80,
): boolean {
  if (!Number.isFinite(reported) || reported <= 0 || reported > cap) return false;
  if (expected < 0.05) return reported < 1.5;
  const ratio = reported / expected;
  return ratio >= 1 / spread && ratio <= spread;
}

export function roundTenth(n: number): number {
  return Math.round(n * 10) / 10;
}

