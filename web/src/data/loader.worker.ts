import type { Manifest } from "./manifest";

let manifest: Manifest;
let dataRoot = "";
const cache = new Set<string>();
const inflight = new Set<string>();

function halfToFloat(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const frac = h & 0x3ff;
  if (exp === 0) return sign * Math.pow(2, -14) * (frac / 1024);
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}

function decode(raw: ArrayBuffer, meta: any): Float32Array {
  const count = meta.shape.reduce((a: number, b: number) => a * b, 1);
  const out = new Float32Array(count);
  const bytes = new Uint8Array(raw);
  const view = new DataView(raw);
  const transformed = (v: number) => {
    if (meta.transform === "log10") return Math.pow(10, v);
    if (meta.transform === "log1p") return Math.expm1(v);
    if (meta.transform === "signed_sqrt") return Math.sign(v) * v * v;
    return v;
  };
  if (meta.dtype === "float16") {
    for (let i = 0; i < count; i += 1) out[i] = halfToFloat(view.getUint16(i * 2, true));
    return out;
  }
  const perLevel = meta.range_scope === "per_level" && meta.shape.length >= 3;
  const stride = perLevel ? meta.shape[1] * meta.shape[2] : count;
  for (let i = 0; i < count; i += 1) {
    const q = meta.dtype === "uint16" ? view.getUint16(i * 2, true) : bytes[i];
    const z = perLevel ? Math.floor(i / stride) : 0;
    const scale = perLevel ? meta.level_scale[z] : meta.scale;
    const offset = perLevel ? meta.level_offset[z] : meta.offset;
    out[i] = transformed(q * scale + offset);
  }
  return out;
}

async function loadVariable(name: string): Promise<void> {
  if (cache.has(name) || inflight.has(name)) return;
  inflight.add(name);
  try {
  const meta = manifest.variables[name];
  if (!meta) return;
  performance.mark(`atmos:fetch:${name}:start`);
  const tFetch = performance.now();
  const response = await fetch(dataRoot + meta.file);
  if (!response.ok) throw new Error(`无法加载 ${name}: ${response.status}`);
  const buffer = await response.arrayBuffer();
  performance.mark(`atmos:fetch:${name}:end`);
  const fetchMs = performance.now() - tFetch;
  cache.add(name);
  performance.mark(`atmos:decode:${name}:start`);
  const tDecode = performance.now();
  const decoded = decode(buffer, meta);
  performance.mark(`atmos:decode:${name}:end`);
  const decodeMs = performance.now() - tDecode;
  (self as any).postMessage(
    { type: "data", name, buffer: decoded.buffer, timing: { fetchMs, decodeMs, bytes: buffer.byteLength } },
    [decoded.buffer],
  );
  } finally {
    inflight.delete(name);
  }
}

self.onmessage = async (event: MessageEvent) => {
  try {
    if (event.data.type === "load") {
      dataRoot = event.data.url.replace(/manifest\.json$/, "");
      performance.mark("atmos:fetch:manifest:start");
      const tManifest = performance.now();
      const response = await fetch(event.data.url);
      if (!response.ok) throw new Error(`清单加载失败: ${response.status}`);
      manifest = (await response.json()) as Manifest;
      performance.mark("atmos:fetch:manifest:end");
      postMessage({ type: "manifest", manifest, timing: { fetchMs: performance.now() - tManifest } });
      for (const name of ["u", "v", "w"]) await loadVariable(name);
      for (const name of ["tke", "t2m"]) await loadVariable(name);
    } else if (event.data.type === "request") {
      await loadVariable(event.data.name);
    }
  } catch (error) {
    postMessage({ type: "error", message: String(error) });
  }
};
