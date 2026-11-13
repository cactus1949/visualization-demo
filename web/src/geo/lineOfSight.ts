/**
 * Terrain line-of-sight for globe annotations (labels, probe, section readouts). Pure math.
 *
 * The straight centre-ENU segment camera -> anchor is clipped to the DEM domain (terrain outside
 * the DEM does not occlude, docs/globe-geo.md) and sampled by distance: step <= stepM, at most
 * maxSamples points (lines longer than stepM * maxSamples get a proportionally longer step).
 * Occluded when any sample is more than deepM under the ground, or two consecutive samples are
 * more than shallowM under it (the old rule, kept for shallow relief). The last endGuardM metres
 * before the anchor are not tested so a ground-level anchor does not hide itself.
 */
export type Vec3 = [number, number, number];

export interface SightOptions {
  stepM: number;
  maxSamples: number;
  deepM: number;
  shallowM: number;
  endGuardM: number;
}

export const SIGHT_DEFAULTS: SightOptions = { stepM: 60, maxSamples: 256, deepM: 3, shallowM: 1, endGuardM: 3 };

/** ENU metres -> grid (u, v) and ellipsoid h metres. */
export type ToGrid = (p: Vec3) => { u: number; v: number; h: number };
/** ground ellipsoid height (metres) at grid (u, v) */
export type GroundAt = (u: number, v: number) => number;

/**
 * Parameter range [t0, t1] of the segment inside the domain, using (u, v) of the end points.
 * Over one domain (~20 km) the ENU line is straight in (u, v) to well under a cell, and the range
 * is widened by one sample step on each side.
 */
function domainRange(a: { u: number; v: number }, b: { u: number; v: number }, pad: number): [number, number] {
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[a.u, b.u], [a.v, b.v]] as const) {
    const d = q - p;
    if (Math.abs(d) < 1e-15) {
      if (p < 0 || p > 1) return [1, 0];
      continue;
    }
    let lo = (0 - p) / d, hi = (1 - p) / d;
    if (lo > hi) [lo, hi] = [hi, lo];
    t0 = Math.max(t0, lo);
    t1 = Math.min(t1, hi);
  }
  return [Math.max(0, t0 - pad), Math.min(1, t1 + pad)];
}

export function terrainBlocksSight(
  cam: Vec3,
  anchor: Vec3,
  toGrid: ToGrid,
  groundAt: GroundAt,
  opts: SightOptions = SIGHT_DEFAULTS,
): boolean {
  const dx = anchor[0] - cam[0], dy = anchor[1] - cam[1], dz = anchor[2] - cam[2];
  const len = Math.hypot(dx, dy, dz);
  if (len <= opts.endGuardM) return false;
  const tGuard = 1 - opts.endGuardM / len;
  const pad = opts.stepM / len;
  let [t0, t1] = domainRange(toGrid(cam), toGrid(anchor), pad);
  t1 = Math.min(t1, tGuard);
  if (t1 <= t0) return false;
  const span = (t1 - t0) * len;
  const n = Math.min(opts.maxSamples, Math.max(2, Math.ceil(span / opts.stepM) + 1));
  let hits = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + ((t1 - t0) * i) / (n - 1);
    if (t <= 0) continue;
    const g = toGrid([cam[0] + dx * t, cam[1] + dy * t, cam[2] + dz * t]);
    if (g.u < 0 || g.u > 1 || g.v < 0 || g.v > 1) { hits = 0; continue; }
    const below = groundAt(g.u, g.v) - g.h;
    if (below > opts.deepM) return true;
    if (below > opts.shallowM) {
      if (++hits >= 2) return true;
    } else hits = 0;
  }
  return false;
}

/** Sample spacing actually used for a segment of `lengthM` inside the domain (for docs / tests). */
export function sightStepM(lengthM: number, opts: SightOptions = SIGHT_DEFAULTS): number {
  const n = Math.min(opts.maxSamples, Math.max(2, Math.ceil(lengthM / opts.stepM) + 1));
  return lengthM / (n - 1);
}
