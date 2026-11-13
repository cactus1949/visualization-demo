/**
 * Globe tab probe picking on sections. The section meshes keep box-km geometry and are placed on
 * the curved shell in the vertex shader, so three's CPU raycast cannot hit them. Instead the pointer
 * ray (a straight line in ENU) is sampled, each sample is mapped back to box km, and every section's
 * box-space equation is checked for its first sign change; the crossing is refined by bisection.
 * Pure functions (no three.js) so the test can run under node.
 */

export type Vec3 = [number, number, number];

/** Section surfaces in box km (x east, y = AGL km, z south), same layout as the first two tabs. */
export type PickSurface =
  | { kind: "height"; y: number; hx: number; hz: number }
  | { kind: "wall"; ax: number; az: number; bx: number; bz: number; top: number };

export interface SectionPickHit {
  /** ray parameter of the hit */
  t: number;
  /** hit point in box km */
  box: Vec3;
  /** index into the surfaces array */
  index: number;
}

const EPS_KM = 1e-6;

function signed(s: PickSurface, p: Vec3): number {
  if (s.kind === "height") return p[1] - s.y;
  const ex = s.bx - s.ax, ez = s.bz - s.az;
  const len = Math.hypot(ex, ez) || 1;
  return (ex * (p[2] - s.az) - ez * (p[0] - s.ax)) / len;
}

function inside(s: PickSurface, p: Vec3): boolean {
  if (s.kind === "height") return Math.abs(p[0]) <= s.hx + EPS_KM && Math.abs(p[2]) <= s.hz + EPS_KM;
  const ex = s.bx - s.ax, ez = s.bz - s.az;
  const l2 = ex * ex + ez * ez;
  if (l2 < 1e-12) return false;
  const along = ((p[0] - s.ax) * ex + (p[2] - s.az) * ez) / l2;
  return along >= -EPS_KM && along <= 1 + EPS_KM && p[1] >= -EPS_KM && p[1] <= s.top + EPS_KM;
}

/**
 * First section crossing of the ray o + t·d for t in [t0, t1] (ENU units; t1 is usually the ground
 * hit, so sections behind terrain lose like on the first two tabs). `toBox` maps ENU -> box km.
 */
export function pickSections(
  o: Vec3,
  d: Vec3,
  t0: number,
  t1: number,
  toBox: (enu: Vec3) => Vec3,
  surfaces: PickSurface[],
  steps = 256,
  iterations = 40,
): SectionPickHit | null {
  if (!surfaces.length || !(t1 > t0)) return null;
  const at = (t: number): Vec3 => toBox([o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
  const ts: number[] = [];
  const ps: Vec3[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = t0 + ((t1 - t0) * i) / steps;
    ts.push(t);
    ps.push(at(t));
  }
  let best: SectionPickHit | null = null;
  surfaces.forEach((s, index) => {
    let fa = signed(s, ps[0]!);
    for (let i = 0; i < steps; i += 1) {
      if (best && ts[i]! >= best.t) return;
      const fb = signed(s, ps[i + 1]!);
      if (fa === 0 || fa * fb < 0) {
        let lo = ts[i]!, hi = fa === 0 ? ts[i]! : ts[i + 1]!, flo = fa;
        let p = fa === 0 ? ps[i]! : ps[i + 1]!;
        if (fa !== 0) {
          for (let k = 0; k < iterations; k += 1) {
            const mid = 0.5 * (lo + hi);
            const pm = at(mid);
            const fm = signed(s, pm);
            if (fm === 0) { lo = hi = mid; p = pm; break; }
            if (flo * fm < 0) hi = mid;
            else { lo = mid; flo = fm; }
            p = pm;
          }
        }
        const t = 0.5 * (lo + hi);
        if (inside(s, p) && (!best || t < best.t)) {
          best = { t, box: p, index };
          return;
        }
      }
      fa = fb;
    }
  });
  return best;
}

/** Polyline section walls (box km points, ground to `top`), one wall surface per segment. */
export function polylineWalls(points: { x: number; z: number }[], top: number): PickSurface[] {
  const out: PickSurface[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    const a = points[i]!, b = points[i + 1]!;
    if (Math.hypot(b.x - a.x, b.z - a.z) < 1e-9) continue;
    out.push({ kind: "wall", ax: a.x, az: a.z, bx: b.x, bz: b.z, top });
  }
  return out;
}
