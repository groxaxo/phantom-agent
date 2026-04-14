export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function waitFor(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Gaussian-distributed random number (Box-Muller) */
export function gaussianRandom(mean: number, stdDev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stdDev;
}

/** Human-like delay with variance */
export function humanDelay(baseMs: number, variance = 0.3): Promise<void> {
  const actual = Math.max(10, gaussianRandom(baseMs, baseMs * variance));
  return new Promise((resolve) => setTimeout(resolve, actual));
}

/** Generate Bézier control points for natural mouse movement */
export function bezierPath(
  x0: number, y0: number,
  x1: number, y1: number,
  steps: number,
): Array<{ x: number; y: number }> {
  const cx1 = x0 + (x1 - x0) * (0.2 + Math.random() * 0.3);
  const cy1 = y0 + (y1 - y0) * (Math.random() * 0.6 - 0.3);
  const cx2 = x0 + (x1 - x0) * (0.5 + Math.random() * 0.3);
  const cy2 = y0 + (y1 - y0) * (0.7 + Math.random() * 0.6 - 0.3);

  const points: Array<{ x: number; y: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const x = u * u * u * x0 + 3 * u * u * t * cx1 + 3 * u * t * t * cx2 + t * t * t * x1;
    const y = u * u * u * y0 + 3 * u * u * t * cy1 + 3 * u * t * t * cy2 + t * t * t * y1;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}
