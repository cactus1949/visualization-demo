/** Pure geo-grid helpers shared by the decode worker, the page and the Node tests (no DOM, no imports). */
export interface QuantizedMeta {
  file: string;
  nx: number;
  ny: number;
  offset: number;
  scale: number;
}

export interface DecodeRequest {
  dem: ArrayBuffer;
  ground: ArrayBuffer;
  demMeta: QuantizedMeta;
  groundMeta: QuantizedMeta;
}

export interface DecodeReply {
  dem: Float32Array;
  ground: Float32Array;
  /** decode time inside the worker */
  ms: number;
}

export function dequantize(raw: ArrayBuffer, q: QuantizedMeta): Float32Array {
  const view = new DataView(raw);
  const n = q.nx * q.ny;
  if (raw.byteLength !== n * 2) throw new Error(`${q.file}: ${raw.byteLength} bytes, expected ${n * 2}`);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = q.offset + view.getUint16(i * 2, true) * q.scale;
  return out;
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
