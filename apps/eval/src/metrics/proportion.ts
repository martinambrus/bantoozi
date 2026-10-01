/**
 * A 95 % Wilson score interval for a proportion (spec 10 §4 "Policy": shares are reported with
 * their denominators and uncertainty). Null without a denominator.
 */
export function wilsonInterval(
  successes: number,
  n: number,
  z = 1.959963984540054,
): { lo: number; hi: number } | null {
  if (n <= 0) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
