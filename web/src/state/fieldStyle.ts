/**
 * Shared colour-mapping and range helpers.
 *
 * Volume, sections, cut faces and the ground each have their own consumer
 * state, but they all go through these functions so a range is always finite
 * and a default colormap / low-alpha policy is consistent.
 */
import type { Manifest, VariableMeta } from "../data/manifest";

export const LOW_ALPHA_RAMP = 0.25;

export const SPARSE_VARS = new Set([
  "icing_index",
  "icing_accum",
  "cloud",
  "cloud_low",
  "precip",
  "risk_level",
  "wind_shear",
]);

export type ColorMapping = {
  variable: string;
  colormap: string;
  min: number;
  max: number;
};

/** Return a finite increasing [min, max], falling back when either side is unusable. */
export function sanitizeRange(
  min: unknown,
  max: unknown,
  fallback: readonly [number, number],
): [number, number] {
  const fb0 = Number.isFinite(fallback[0]) ? fallback[0] : 0;
  const fb1 = Number.isFinite(fallback[1]) && fallback[1] !== fb0 ? fallback[1] : fb0 + 1;
  const a = typeof min === "number" ? min : Number(min);
  const b = typeof max === "number" ? max : Number(max);
  let lo = Number.isFinite(a) ? a : fb0;
  let hi = Number.isFinite(b) ? b : fb1;
  if (hi === lo) hi = lo + 1e-6;
  if (hi < lo) [lo, hi] = [hi, lo];
  return [lo, hi];
}

export function isFiniteRange(min: unknown, max: unknown): boolean {
  return Number.isFinite(Number(min)) && Number.isFinite(Number(max)) && Number(max) !== Number(min);
}

/** Physical value of a 0–1 threshold on a colour-mapping range. */
export function thresholdPhysical(min: number, max: number, t: number): number {
  const [lo, hi] = sanitizeRange(min, max, [0, 1]);
  return lo + Math.max(0, Math.min(1, t)) * (hi - lo);
}

export function prettyUnit(units: string): string {
  const map: Record<string, string> = {
    "m s-1": "m/s",
    "m2 s-2": "m²/s²",
    "s-1": "s⁻¹",
    "1/s": "s⁻¹",
    "deg/m": "°/m",
    "0-1": "",
    level: "",
  };
  return map[units] ?? units;
}

export function formatValue(v: number): string {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toPrecision(2);
}

/** GLSL-equivalent smoothstep, for CPU visibility checks. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const u = Math.max(0, Math.min(1, (x - e0) / Math.max(e1 - e0, 1e-9)));
  return u * u * (3 - 2 * u);
}

export function lowAlphaFactor(t: number, on: boolean, thr: number): number {
  if (!on) return 1;
  return smoothstep(thr, Math.min(1, thr + LOW_ALPHA_RAMP), t);
}

export function displayRangeOf(
  name: string,
  manifest: Manifest | null | undefined,
  speedRange?: [number, number] | null,
): [number, number] | null {
  if (name === "speed" || name === "speed0") {
    const r = manifest?.derived?.speed?.display_range;
    if (r) return [r[0], r[1]];
    if (speedRange) return [...speedRange];
    return [0, 15];
  }
  const r = manifest?.variables[name]?.display_range;
  return r ? [r[0], r[1]] : null;
}

export function fallbackRange(name: string, meta: VariableMeta | undefined): [number, number] {
  if (!meta) return name === "speed" || name === "speed0" ? [0, 15] : [0, 1];
  if (Number.isFinite(meta.display_range?.[0]) && Number.isFinite(meta.display_range?.[1])) {
    return [meta.display_range[0], meta.display_range[1]];
  }
  return [meta.data_min, meta.data_max === meta.data_min ? meta.data_min + 1 : meta.data_max];
}

/**
 * Sparse, non-negative fields default to a transparent low end. The heuristic
 * (cached) treats a field as sparse when at least half of a subsample sits in
 * the lowest 2% of the display range.
 */
export function isSparseVar(
  name: string,
  opts: {
    manifest?: Manifest | null;
    data?: Float32Array | null;
    cache?: Map<string, boolean>;
  } = {},
): boolean {
  if (name === "speed" || name === "speed0") return false;
  if (SPARSE_VARS.has(name)) return true;
  const meta = opts.manifest?.variables[name];
  if (!meta || meta.data_min < 0) return false;
  const cached = opts.cache?.get(name);
  if (cached !== undefined) return cached;
  const data = opts.data;
  if (!data) return false;
  const [lo, hi] = displayRangeOf(name, opts.manifest) ?? [meta.data_min, meta.data_max];
  const cut = lo + 0.02 * (hi - lo);
  const step = Math.max(1, Math.floor(data.length / 200_000));
  let low = 0;
  let total = 0;
  for (let i = 0; i < data.length; i += step) {
    total += 1;
    if (data[i]! <= cut) low += 1;
  }
  const sparse = total > 0 && low / total >= 0.5;
  opts.cache?.set(name, sparse);
  return sparse;
}

/** Fraction of samples that would be discarded by a hard value window and/or low-alpha. */
export function discardedFraction(
  data: Float32Array,
  opts: {
    min: number;
    max: number;
    filterMin?: number;
    filterMax?: number;
    filterEnable?: boolean;
    lowAlpha?: boolean;
    lowThreshold?: number;
  },
): number {
  if (!data.length) return 1;
  const span = Math.max(opts.max - opts.min, 1e-9);
  let dead = 0;
  const step = Math.max(1, Math.floor(data.length / 80_000));
  let total = 0;
  for (let i = 0; i < data.length; i += step) {
    total += 1;
    const v = data[i]!;
    if (
      opts.filterEnable &&
      (v < (opts.filterMin ?? -Infinity) - 1e-6 || v > (opts.filterMax ?? Infinity) + 1e-6)
    ) {
      dead += 1;
      continue;
    }
    const t = Math.max(0, Math.min(1, (v - opts.min) / span));
    if (lowAlphaFactor(t, Boolean(opts.lowAlpha), opts.lowThreshold ?? 0.15) < 0.004) dead += 1;
  }
  return total ? dead / total : 1;
}
