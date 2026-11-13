/**
 * Loads the geo foundation written by `python -m geopipe` ($WEB_ROOT/geo/): geo.json plus the
 * smoothed ellipsoidal DEM and the per-column ground height on the nc grid (u16 + Brotli; the
 * server sends Content-Encoding: br so fetch already returns raw little-endian u16).
 */
import type { GeoGrid, GeoMap } from "./mapping";
import type { GridField } from "./placement";

interface QuantizedMeta {
  file: string;
  nx: number;
  ny: number;
  offset: number;
  scale: number;
}

export interface GeoJson {
  version: number;
  grid: GeoGrid;
  map: GeoMap & { residual_m?: Record<string, number> };
  dem: QuantizedMeta & { west: number; east: number; south: number; north: number };
  ground: QuantizedMeta & { stats?: { min: number; max: number; mean: number } };
  source?: Record<string, unknown>;
}

/** Ellipsoidal DEM, rows north -> south, columns west -> east, bounds are pixel centres. */
export interface Dem {
  nx: number;
  ny: number;
  west: number;
  east: number;
  south: number;
  north: number;
  values: Float32Array;
}

export interface GeoFoundation {
  meta: GeoJson;
  dem: Dem;
  /** ground ellipsoid height per nc column (row 0 = south) */
  ground: GridField;
}

export function geoBaseUrl(): string {
  return `${(import.meta.env.VITE_DATA_BASE ?? "").replace(/\/$/, "")}/data/geo/`;
}

export function dequantize(raw: ArrayBuffer, q: QuantizedMeta): Float32Array {
  const view = new DataView(raw);
  const n = q.nx * q.ny;
  if (raw.byteLength !== n * 2) throw new Error(`${q.file}: ${raw.byteLength} bytes, expected ${n * 2}`);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = q.offset + view.getUint16(i * 2, true) * q.scale;
  return out;
}

async function fetchOk(url: string): Promise<Response> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r;
}

export async function loadGeoFoundation(base = geoBaseUrl()): Promise<GeoFoundation> {
  const meta = (await (await fetchOk(`${base}geo.json`)).json()) as GeoJson;
  const [demRaw, groundRaw] = await Promise.all([
    fetchOk(base + meta.dem.file).then((r) => r.arrayBuffer()),
    fetchOk(base + meta.ground.file).then((r) => r.arrayBuffer()),
  ]);
  const d = meta.dem;
  return {
    meta,
    dem: { nx: d.nx, ny: d.ny, west: d.west, east: d.east, south: d.south, north: d.north, values: dequantize(demRaw, d) },
    ground: { nx: meta.ground.nx, ny: meta.ground.ny, values: dequantize(groundRaw, meta.ground) },
  };
}

/** Bilinear DEM height at (lon, lat); `outside` beyond the DEM extent. */
export function demHeightAt(dem: Dem, lon: number, lat: number, outside = 0): number {
  const fx = ((lon - dem.west) / (dem.east - dem.west)) * (dem.nx - 1);
  const fy = ((dem.north - lat) / (dem.north - dem.south)) * (dem.ny - 1);
  if (!(fx >= 0 && fy >= 0 && fx <= dem.nx - 1 && fy <= dem.ny - 1)) return outside;
  const x0 = Math.min(Math.floor(fx), dem.nx - 2), y0 = Math.min(Math.floor(fy), dem.ny - 2);
  const ax = fx - x0, ay = fy - y0;
  const at = (x: number, y: number) => dem.values[y * dem.nx + x]!;
  return (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
}
