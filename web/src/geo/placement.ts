/**
 * Where a grid sample sits vertically on the globe. Shared by every globe layer (and the
 * Cesium reference outlines), so terrain on/off and vertical exaggeration agree everywhere:
 *
 *   ellipsoid height h = g(lon, lat) + k * AGL
 *
 * g is the ground ellipsoid height (0 with terrain off), AGL the nc height above ground, k the
 * vertical exaggeration. Terrain itself is never exaggerated (Cesium verticalExaggeration = 1).
 */
export function ellipsoidHeight(ground: number, k: number, agl: number): number {
  return ground + k * agl;
}

/** Row-major field on the nc grid (row 0 = south, column 0 = west), sampled bilinearly at (u, v) in [0, 1]. */
export interface GridField {
  nx: number;
  ny: number;
  values: Float32Array;
}

export function sampleGrid(field: GridField, u: number, v: number): number {
  const fx = Math.min(Math.max(u, 0), 1) * (field.nx - 1);
  const fy = Math.min(Math.max(v, 0), 1) * (field.ny - 1);
  const x0 = Math.min(Math.floor(fx), field.nx - 2), y0 = Math.min(Math.floor(fy), field.ny - 2);
  const ax = fx - x0, ay = fy - y0;
  const at = (x: number, y: number) => field.values[y * field.nx + x]!;
  return (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
}
