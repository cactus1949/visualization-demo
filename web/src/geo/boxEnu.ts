/**
 * Convert between the first two tabs' root-local box (km: x east, z south, y height)
 * and the globe's centre-ENU scene units. Placement uses the exact float64 path;
 * picking uses the inverse polynomial (docs/globe-geo.md).
 */
import { enuFrameAt, exactEnu, gridToLonLat, polyInverse, type EnuFrame, type GeoGrid, type GeoMap, type Vec3 } from "./mapping";
import { ellipsoidHeight, sampleGrid, type GridField } from "./placement";

export function boxToUv(sx: number, sz: number, x: number, z: number): { u: number; v: number } {
  return { u: x / sx + 0.5, v: 0.5 - z / sz };
}

export function uvToBox(sx: number, sz: number, u: number, v: number): { x: number; z: number } {
  return { x: (u - 0.5) * sx, z: (0.5 - v) * sz };
}

export function frameOf(map: GeoMap): EnuFrame {
  return enuFrameAt(map.lon0, map.lat0);
}

/** Centre-ENU in scene units (map.enu_unit_m) of grid (u, v) at AGL metres. Exact float64. */
export function placeEnuUnits(
  grid: GeoGrid,
  map: GeoMap,
  frame: EnuFrame,
  u: number,
  v: number,
  aglM: number,
  k: number,
  ground: GridField | null,
): Vec3 {
  const g = ground ? sampleGrid(ground, u, v) : 0;
  const e = exactEnu(grid, frame, u, v, ellipsoidHeight(g, k, aglM));
  const s = map.enu_unit_m;
  return [e[0] / s, e[1] / s, e[2] / s];
}

/** Inverse polynomial: scene ENU units → (u, v, ellipsoid h, AGL metres). */
export function enuUnitsToUvAgl(
  map: GeoMap,
  enu: Vec3,
  k: number,
  ground: GridField | null,
): { u: number; v: number; h: number; agl: number } {
  const s = map.enu_unit_m;
  const inv = polyInverse(map, [enu[0] * s, enu[1] * s, enu[2] * s]);
  const g = ground ? sampleGrid(ground, inv.u, inv.v) : 0;
  return { u: inv.u, v: inv.v, h: inv.h, agl: (inv.h - g) / Math.max(k, 1e-9) };
}

export function lonLatOf(grid: GeoGrid, u: number, v: number): { lon: number; lat: number } {
  const [lon, lat] = gridToLonLat(grid, u, v);
  return { lon, lat };
}

/** Snap a continuous (u, v) to the nearest nc node (same convention as the box probe). */
export function uvToCell(nx: number, ny: number, u: number, v: number): { ix: number; iy: number } {
  const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
  return {
    ix: Math.round(clamp(u * (nx - 1), 0, nx - 1)),
    iy: Math.round(clamp(v * (ny - 1), 0, ny - 1)),
  };
}

export function cellToUv(nx: number, ny: number, ix: number, iy: number): { u: number; v: number } {
  return { u: ix / Math.max(1, nx - 1), v: iy / Math.max(1, ny - 1) };
}
