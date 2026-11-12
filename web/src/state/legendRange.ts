export type DataRange = { min: number; max: number };

/**
 * For a pointwise linear blend (1-s)A+sB, the true min is at least the
 * blended min and the true max is at most the blended max. This is therefore
 * a conservative outer bound, exact at s=0 and s=1. The gap comes only from the
 * extremes sitting at different points; it is at most
 * min(s * (maxB - minB), (1 - s) * (maxA - minA)) on each side.
 */
export function blendRange(a: DataRange, b: DataRange | null, s: number): DataRange {
  if (!b || s === 0) return { min: a.min, max: a.max };
  if (s === 1) return { min: b.min, max: b.max };
  const t = Math.max(0, Math.min(1, s));
  return { min: a.min + (b.min - a.min) * t, max: a.max + (b.max - a.max) * t };
}

export function rangeOfArray(data: Float32Array, start = 0, end = data.length): DataRange {
  let min = Infinity;
  let max = -Infinity;
  const lo = Math.max(0, Math.floor(start));
  const hi = Math.min(data.length, Math.max(lo, Math.floor(end)));
  for (let i = lo; i < hi; i += 1) {
    const value = data[i]!;
    if (Number.isNaN(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min, max };
}

export class FrameRangeCache {
  private readonly ranges = new Map<string, DataRange>();

  get(key: string, compute: () => DataRange): DataRange {
    const cached = this.ranges.get(key);
    if (cached) return cached;
    const range = compute();
    this.ranges.set(key, range);
    return range;
  }

  retainFrames(frames: number[]): void {
    const keep = new Set(frames);
    for (const key of this.ranges.keys()) {
      const match = key.match(/@([0-9]+)(?:@|$)/);
      if (match && !keep.has(Number(match[1]))) this.ranges.delete(key);
    }
  }

  clear(): void {
    this.ranges.clear();
  }
}

export function isAllZero(r: DataRange, eps = 1e-9): boolean {
  return Number.isFinite(r.min) && Number.isFinite(r.max) && Math.abs(r.min) <= eps && Math.abs(r.max) <= eps;
}

export function emptyHint(name: string, r: DataRange | null): string | null {
  if (!r || !isAllZero(r)) return null;
  return name === "icing_index" || name === "icing_accum" ? "本日无积冰" : "当前无数据";
}

export function thresholdHidesAll(thresholdPhysical: number, r: DataRange | null): boolean {
  return !!r && Number.isFinite(r.max) && Number.isFinite(thresholdPhysical) && r.max < thresholdPhysical;
}

export function markerFraction(
  value: number,
  lo: number,
  hi: number,
): { f: number; clipped: "low" | "high" | null } {
  if (value < lo) return { f: 0, clipped: "low" };
  if (value > hi) return { f: 1, clipped: "high" };
  if (hi === lo) return { f: 0.5, clipped: null };
  return { f: Math.max(0, Math.min(1, (value - lo) / (hi - lo))), clipped: null };
}

export function formatLegendValue(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a < 0.01) return v.toPrecision(3).includes("e") ? v.toPrecision(3) : v.toExponential(2);
  if (a >= 100) return v.toFixed(0);
  // three significant digits so 2.19 does not read as 2.2 next to a 2.6 threshold
  return v.toFixed(a < 10 ? 2 : 1);
}
