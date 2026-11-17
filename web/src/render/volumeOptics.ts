/**
 * CPU copy of the volume step transfer. The shader in volume.ts must stay in step
 * with these numbers: opacity slider, threshold, the 0.25 low-alpha ramp, the
 * (0.35 + 0.65 n) weight, and 6 / km. This is not a second colour scale.
 */

export const EXTINCTION_PER_KM = 6;
export const LOW_ALPHA_RAMP = 0.25;
/** The ray stops once accumulated alpha passes this, matching the shader. */
export const ALPHA_BREAK = 0.97;

export type OpticsMode = "beer" | "linear";

export interface OpticsParams {
  opacity: number;
  threshold: number;
  min: number;
  max: number;
  mode: OpticsMode;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Same ramp as GLSL lowAlphaFactor when the ramp is enabled (the volume always enables it). */
export function lowAlphaFactor(n: number, threshold: number): number {
  return smoothstep(threshold, Math.min(1, threshold + LOW_ALPHA_RAMP), n);
}

export function normalized(value: number, min: number, max: number): number {
  return Math.min(1, Math.max(0, (value - min) / Math.max(max - min, 1e-9)));
}

/** Extinction in 1/km at a normalized sample. Linear steps used to multiply this by the step. */
export function extinctionPerKm(n: number, opacity: number, threshold: number): number {
  return opacity * lowAlphaFactor(n, threshold) * (0.35 + 0.65 * n) * EXTINCTION_PER_KM;
}

/**
 * Alpha of one step. Beer-Lambert stays in (0, 1). The previous linear form
 * `sigma * stepKm` exceeds 1 when a coarse step is optically thick.
 */
export function stepAlpha(n: number, stepKm: number, params: OpticsParams): number | null {
  if (!(n >= params.threshold)) return null;
  const sigma = extinctionPerKm(n, params.opacity, params.threshold);
  if (params.mode === "linear") return sigma * stepKm;
  return 1 - Math.exp(-sigma * stepKm);
}

export interface Integral {
  alpha: number;
  /** Transmittance-weighted mean of normalized samples that contributed. */
  meanN: number;
  firstN: number | null;
  stepsApplied: number;
  /** Integrated sigma * step, including samples after the alpha cutoff would have stopped the shader. */
  tauToCutoff: number;
}

/** Front-to-back composite of already-normalized samples. Empty samples are omitted by the caller. */
export function integrateNormalized(samples: readonly number[], stepKm: number, params: OpticsParams, stop = ALPHA_BREAK): Integral {
  let alpha = 0;
  let weighted = 0;
  let firstN: number | null = null;
  let stepsApplied = 0;
  let tau = 0;
  for (const n of samples) {
    if (alpha > stop) break;
    const a = stepAlpha(n, stepKm, params);
    if (a === null || a <= 0) continue;
    const sigma = extinctionPerKm(n, params.opacity, params.threshold);
    tau += sigma * stepKm;
    if (firstN === null) firstN = n;
    const weight = (1 - alpha) * a;
    weighted += weight * n;
    alpha += weight;
    stepsApplied += 1;
  }
  return { alpha, meanN: alpha > 0 ? weighted / alpha : 0, firstN, stepsApplied, tauToCutoff: tau };
}
