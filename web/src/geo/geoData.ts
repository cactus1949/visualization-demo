/**
 * Loads the geo foundation written by `python -m geopipe` ($WEB_ROOT/geo/): geo.json plus the
 * smoothed ellipsoidal DEM and the per-column ground height on the nc grid (u16 + Brotli; the
 * server sends Content-Encoding: br so fetch already returns raw little-endian u16).
 */
import type { GeoGrid, GeoMap } from "./mapping";
import type { GridField } from "./placement";
import { dequantize, type DecodeReply, type DecodeRequest, type Dem, type QuantizedMeta } from "./geoGrid";

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
  const configured = import.meta.env.VITE_DATA_BASE;
  const base = configured ?? import.meta.env.BASE_URL;
  return `${base.replace(/\/$/, "")}/data/geo/`;
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
  const decoded = await decodeInWorker(demRaw, groundRaw, d, meta.ground);
  lastDecodeMs = decoded.ms;
  return {
    meta,
    dem: { nx: d.nx, ny: d.ny, west: d.west, east: d.east, south: d.south, north: d.north, values: decoded.dem },
    ground: { nx: meta.ground.nx, ny: meta.ground.ny, values: decoded.ground },
  };
}

/** u16 -> float32 for the DEM and ground grid off the main thread (module worker, buffers transferred). */
async function decodeInWorker(dem: ArrayBuffer, ground: ArrayBuffer, demMeta: QuantizedMeta, groundMeta: QuantizedMeta): Promise<DecodeReply> {
  if (typeof Worker === "undefined") return { dem: dequantize(dem, demMeta), ground: dequantize(ground, groundMeta), ms: 0 };
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
