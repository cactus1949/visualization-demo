/**
 * Loads the geo foundation written by `python -m geopipe` ($WEB_ROOT/geo/): geo.json plus the
 * smoothed ellipsoidal DEM and the per-column ground height on the nc grid (u16 + Brotli; the
 * server sends Content-Encoding: br so fetch already returns raw little-endian u16).
 */
import type { GeoGrid, GeoMap } from "./mapping";
import type { GridField } from "./placement";
import { dequantize, type DecodeReply, type DecodeRequest, type Dem, type QuantizedMeta } from "./geoGrid";
import { dataBase } from "../data/dataBase";

export { dequantize, demHeightAt, type Dem, type QuantizedMeta } from "./geoGrid";

export interface GeoJson {
  version: number;
  grid: GeoGrid;
  map: GeoMap & { residual_m?: Record<string, number> };
  dem: QuantizedMeta & { west: number; east: number; south: number; north: number };
  ground: QuantizedMeta & { stats?: { min: number; max: number; mean: number } };
  source?: Record<string, unknown>;
}

export interface GeoFoundation {
  meta: GeoJson;
  dem: Dem;
  /** ground ellipsoid height per nc column (row 0 = south) */
  ground: GridField;
}

/** Worker-side decode time of the last load (ms), for the in-page check. */
export let lastDecodeMs = 0;

export function geoBaseUrl(): string {
  return `${dataBase()}/data/geo/`;
}

/** The geo files arrived but could not be decoded (worker and main-thread fallback both failed). */
export class GeoDecodeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GeoDecodeError";
  }
}

/** Where the last load decoded: "worker", or "main" after a worker failure / without Worker support. */
export let lastDecodeWhere: "worker" | "main" = "worker";

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
  const decoded = await decodeGeo(demRaw, groundRaw, d, meta.ground);
  lastDecodeMs = decoded.ms;
  return {
    meta,
    dem: { nx: d.nx, ny: d.ny, west: d.west, east: d.east, south: d.south, north: d.north, values: decoded.dem },
    ground: { nx: meta.ground.nx, ny: meta.ground.ny, values: decoded.ground },
  };
}

function decodeOnMain(dem: ArrayBuffer, ground: ArrayBuffer, demMeta: QuantizedMeta, groundMeta: QuantizedMeta): DecodeReply {
  const t0 = performance.now();
  try {
    return { dem: dequantize(dem, demMeta), ground: dequantize(ground, groundMeta), ms: performance.now() - t0 };
  } catch (e) {
    throw new GeoDecodeError(`DEM / 地面网格解码失败：${String(e)}`, { cause: e });
  }
}

/**
 * u16 -> float32 for the DEM and ground grid: module worker first (buffers transferred); if the worker
 * cannot start or fails, decode the same bytes on the main thread. The buffers are only transferred
 * after the worker is up, so a copy is kept for the fallback.
 */
async function decodeGeo(dem: ArrayBuffer, ground: ArrayBuffer, demMeta: QuantizedMeta, groundMeta: QuantizedMeta): Promise<DecodeReply> {
  if (typeof Worker === "undefined") {
    lastDecodeWhere = "main";
    return decodeOnMain(dem, ground, demMeta, groundMeta);
  }
  const demCopy = dem.slice(0);
  const groundCopy = ground.slice(0);
  try {
    const reply = await decodeInWorker(dem, ground, demMeta, groundMeta);
    lastDecodeWhere = "worker";
    return reply;
  } catch (e) {
    console.warn("[geo] worker decode failed, decoding on the main thread:", e);
    lastDecodeWhere = "main";
    return decodeOnMain(demCopy, groundCopy, demMeta, groundMeta);
  }
}

async function decodeInWorker(dem: ArrayBuffer, ground: ArrayBuffer, demMeta: QuantizedMeta, groundMeta: QuantizedMeta): Promise<DecodeReply> {
  const worker = new Worker(new URL("./geoDecode.worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<DecodeReply>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<DecodeReply | { error: string }>) =>
        "error" in event.data ? reject(new Error(event.data.error)) : resolve(event.data);
      worker.onerror = (event) => reject(event.error ?? new Error(`geo decode worker failed: ${event.message}`));
      const req: DecodeRequest = { dem, ground, demMeta, groundMeta };
      worker.postMessage(req, [dem, ground]);
    });
  } finally {
    worker.terminate();
  }
}
