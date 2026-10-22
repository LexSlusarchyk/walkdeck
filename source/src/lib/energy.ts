/** ACSM walking equation, flat grade. Returns kcal per second. */
export function kcalPerSecond(kmh: number, weightKg: number): number {
  if (kmh <= 0 || weightKg <= 0) return 0;
  const mPerMin = kmh * (1000 / 60);
  const kcalPerMin = ((0.1 * mPerMin + 3.5) * weightKg) / 200;
  return kcalPerMin / 60;
}
