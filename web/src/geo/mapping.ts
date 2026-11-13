/**
 * Grid <-> geographic placement for the globe tab. Pure math, no three / Cesium imports.
 *
 * Grid coordinates: u = (lon - lon_min) / (lon_max - lon_min), v = (lat - lat_min) / (lat_max - lat_min),
 * h = WGS84 ellipsoid height in metres. Every layer uses h = g(lon, lat) + k * AGL (see placement.ts).
 * "ENU" is the east-north-up frame at the domain centre (lon0, lat0, h = 0), in metres.
 *
 * Two paths:
 * - exact: geodetic -> ECEF -> ENU in float64 (CPU placement, Cesium comparisons);
 * - polynomial: 16-term cubic fitted by the pipeline (geo.json `map`), cheap enough for shaders.
 *   Coefficients work in ENU / map.enu_unit_m and h / 1e4.
 */

export interface GeoGrid {
  lon_min: number;
  lon_max: number;
  lat_min: number;
  lat_max: number;
  nx: number;
  ny: number;
  nz: number;
  top_m: number;
}

export interface GeoMap {
  /** exponents (i, j, k) of u^i v^j w^k; same order as fwd/inv columns */
  terms: [number, number, number][];
  /** 3 rows (east, north, up) x terms: (u, v, h/1e4) -> ENU / enu_unit_m */
  fwd: number[][];
  /** 3 rows (u, v, h/1e4) x terms: ENU / enu_unit_m -> (u, v, h/1e4) */
  inv: number[][];
  lon0: number;
  lat0: number;
  h_valid_m: [number, number];
  enu_unit_m: number;
}

export type Vec3 = [number, number, number];

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;
/** the polynomial's height variable is h / H_UNIT */
export const H_UNIT = 1e4;

export function geodeticToEcef(lonDeg: number, latDeg: number, h: number): Vec3 {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - E2) + h) * sinLat];
}

export interface EnuFrame {
  origin: Vec3;
  /** rows: east, north, up unit vectors in ECEF */
  rows: [Vec3, Vec3, Vec3];
}

export function enuFrameAt(lonDeg: number, latDeg: number): EnuFrame {
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const sl = Math.sin(lon), cl = Math.cos(lon), sp = Math.sin(lat), cp = Math.cos(lat);
  return {
    origin: geodeticToEcef(lonDeg, latDeg, 0),
    rows: [
      [-sl, cl, 0],
      [-sp * cl, -sp * sl, cp],
      [cp * cl, cp * sl, sp],
    ],
  };
}

export function ecefToEnu(frame: EnuFrame, p: Vec3): Vec3 {
  const d: Vec3 = [p[0] - frame.origin[0], p[1] - frame.origin[1], p[2] - frame.origin[2]];
  return frame.rows.map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]) as Vec3;
}

export function gridToLonLat(grid: GeoGrid, u: number, v: number): [number, number] {
  return [grid.lon_min + u * (grid.lon_max - grid.lon_min), grid.lat_min + v * (grid.lat_max - grid.lat_min)];
}

/** Exact ENU (metres) of grid point (u, v) at ellipsoid height h. */
export function exactEnu(grid: GeoGrid, frame: EnuFrame, u: number, v: number, h: number): Vec3 {
  const [lon, lat] = gridToLonLat(grid, u, v);
  return ecefToEnu(frame, geodeticToEcef(lon, lat, h));
}

/** Pass Math.fround to emulate float32 shader arithmetic. */
type Round = (x: number) => number;
const exact: Round = (x) => x;

function evalPoly(terms: GeoMap["terms"], coef: number[][], a: number, b: number, c: number, r: Round): Vec3 {
  const pa = [1, r(a), r(r(a) * r(a)), 0];
  pa[3] = r(pa[2]! * pa[1]!);
  const pb = [1, r(b), r(r(b) * r(b)), 0];
  pb[3] = r(pb[2]! * pb[1]!);
  const pc = [1, r(c)];
  const out: Vec3 = [0, 0, 0];
  terms.forEach(([i, j, k], n) => {
    const f = r(r(pa[i]! * pb[j]!) * pc[k]!);
    for (let row = 0; row < 3; row++) out[row] = r(out[row] + r(r(coef[row]![n]!) * f));
  });
  return out;
}

/** Polynomial ENU (metres) of grid point (u, v) at ellipsoid height h. */
export function polyForward(map: GeoMap, u: number, v: number, h: number, round: Round = exact): Vec3 {
  const e = evalPoly(map.terms, map.fwd, u, v, h / H_UNIT, round);
  return [e[0] * map.enu_unit_m, e[1] * map.enu_unit_m, e[2] * map.enu_unit_m];
}

/** Polynomial inverse: ENU (metres) -> grid (u, v) and ellipsoid height h (metres). */
export function polyInverse(map: GeoMap, enu: Vec3, round: Round = exact): { u: number; v: number; h: number } {
  const s = map.enu_unit_m;
  const [u, v, w] = evalPoly(map.terms, map.inv, enu[0] / s, enu[1] / s, enu[2] / s, round);
  return { u, v, h: w * H_UNIT };
}

/** East / north extent of the domain in metres along its centre lines (for converting u/v errors to metres). */
export function domainSpanM(grid: GeoGrid, frame: EnuFrame): { east: number; north: number } {
  const w = exactEnu(grid, frame, 0, 0.5, 0), e = exactEnu(grid, frame, 1, 0.5, 0);
  const s = exactEnu(grid, frame, 0.5, 0, 0), n = exactEnu(grid, frame, 0.5, 1, 0);
  return { east: Math.hypot(e[0] - w[0], e[1] - w[1]), north: Math.hypot(n[0] - s[0], n[1] - s[1]) };
}
