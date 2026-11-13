/**
 * ⑤ globe particles: where a particle node sits on the curved shell (CPU reference of the GPU
 * place pass in render/particles.ts). Particle state is grid space: gx = u, gy = v (0..1, row 0 =
 * south like the nc), z = height above ground in km. On the box tabs the trail shader maps it to
 * root-local km as ((gx - 0.5) * sx, z, (0.5 - gy) * sz); on the globe it goes
 *   (u, v, AGL m) -> h = terrain * g(u, v) + k * AGL -> forward polynomial
 * which is the same placement as the volume, buildings and probe (docs/globe-geo.md).
 * No runtime imports, so node --test can load it directly.
 */
export type GridPos = readonly [gx: number, gy: number, zKm: number];

export function particleUvAgl(g: GridPos): { u: number; v: number; agl: number } {
  return { u: g[0], v: g[1], agl: g[2] * 1000 };
}

/** Root-local box km of a particle node, exactly as the box-tab trail shader's `toLocal`. */
export function particleBoxKm(sx: number, sz: number, g: GridPos): [number, number, number] {
  return [(g[0] - 0.5) * sx, g[2], (0.5 - g[1]) * sz];
}

/** Ellipsoid height of a particle node: ground (0 with terrain off) + k * AGL. k never scales the ground. */
export function particleEllipsoidHeight(groundM: number, terrainOn: boolean, k: number, zKm: number): number {
  return (terrainOn ? groundM : 0) + k * zKm * 1000;
}

/**
 * The placed trail history (ENU) depends on terrain on/off and k only; when this key changes every
 * history layer is placed again, so trails never mix two exaggerations.
 */
export function placementKey(k: number, terrain: number): string {
  return `${k}|${terrain > 0.5 ? 1 : 0}`;
}

/** Lowest height (km above ground) a live particle may have; mirrors the sim shader's 0.003 km floor. */
export const PARTICLE_MIN_AGL_KM = 0.003;
