/**
 * Data worker: fetches `<frame dir>/<name>.bin.br` (the browser undoes Brotli via
 * Content-Encoding), keeps the still-encoded bytes in an LRU cache and decodes on demand.
 *
 * Jobs (the main thread replaces the queue with its current wish list):
 *  - fetch  : only make sure the encoded bytes of name@frame are cached (background prefetch)
 *  - decode : Float32 physical values for CPU readers (+ half floats for a GPU slot if `half`)
 *  - wind   : RGBA half-float pack (u, v, w, 0) of one frame for the GPU wind slots
 *
 * Half-float work happens here, never on the main thread: f16 variables are already half
 * floats (copied as-is), others go through a table-based float→half conversion.
 */
import type { Manifest, VariableMeta } from "./manifest";
import { decodeSz3, ensureSz3, type Sz3Index } from "./sz3Decode";

type JobKind = "fetch" | "decode" | "wind";
interface Job {
  kind: JobKind;
  name: string;
  frame: number;
  half?: boolean;
}

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(message, transfer);
let manifest: Manifest;
let dataRoot = "";
let dirs: string[] = [""];
const RAW_BUDGET = 220 * 1024 * 1024;
const raw = new Map<string, ArrayBuffer>(); // insertion order = LRU order
let rawBytes = 0;
const fetching = new Map<string, Promise<ArrayBuffer>>();
const sz3Index = new Map<string, Sz3Index>();
const isSz3 = (meta: VariableMeta | undefined) => meta?.encoding === "sz3";
let queue: Job[] = [];
const running = new Set<string>();
const CONCURRENCY = 2;
let active = 0;

const key = (name: string, frame: number) => `${name}@${frame}`;
const jobKey = (j: Job) => `${j.kind}:${j.name}@${j.frame}${j.half ? "+h" : ""}`;

// ---------------------------------------------------------------- half-float tables
const HALF_TO_FLOAT = new Float32Array(65536);
for (let h = 0; h < 65536; h += 1) {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const frac = h & 0x3ff;
  HALF_TO_FLOAT[h] =
    exp === 0
      ? sign * Math.pow(2, -14) * (frac / 1024)
      : exp === 31
        ? frac
          ? NaN
          : sign * Infinity
        : sign * Math.pow(2, exp - 15) * (1 + frac / 1024);
}
// float -> half (round-to-nearest on the mantissa), tables as in three's DataUtils
const BASE = new Uint32Array(512);
const SHIFT = new Uint32Array(512);
for (let i = 0; i < 256; i += 1) {
  const e = i - 127;
  if (e < -27) {
    BASE[i] = 0x0000; BASE[i | 0x100] = 0x8000; SHIFT[i] = 24; SHIFT[i | 0x100] = 24;
  } else if (e < -14) {
    BASE[i] = 0x0400 >> (-e - 14); BASE[i | 0x100] = (0x0400 >> (-e - 14)) | 0x8000;
    SHIFT[i] = -e - 1; SHIFT[i | 0x100] = -e - 1;
  } else if (e <= 15) {
    BASE[i] = (e + 15) << 10; BASE[i | 0x100] = ((e + 15) << 10) | 0x8000;
    SHIFT[i] = 13; SHIFT[i | 0x100] = 13;
  } else if (e < 128) {
    BASE[i] = 0x7c00; BASE[i | 0x100] = 0xfc00; SHIFT[i] = 24; SHIFT[i | 0x100] = 24;
  } else {
    BASE[i] = 0x7c00; BASE[i | 0x100] = 0xfc00; SHIFT[i] = 13; SHIFT[i | 0x100] = 13;
  }
}
function toHalfArray(src: Float32Array, out: Uint16Array, stride = 1, channel = 0): void {
  const bits = new Uint32Array(src.buffer, src.byteOffset, src.length);
  for (let i = 0; i < src.length; i += 1) {
    const x = bits[i]!;
    const e = (x >>> 23) & 0x1ff;
    const s = SHIFT[e]!;
    let h = BASE[e]! + ((x & 0x007fffff) >>> s);
    // round half-up on the dropped bits (keeps 0.0039 m/s f16 accuracy for u, v)
    if (s < 24 && (x >>> (s - 1)) & 1 && (e & 0xff) !== 0xff) h += 1;
    out[i * stride + channel] = h;
  }
}

// ---------------------------------------------------------------- decode
function count(meta: VariableMeta): number {
  return meta.shape.reduce((a, b) => a * b, 1);
}

function decode(buffer: ArrayBuffer, meta: VariableMeta, frame = 0, name = ""): Float32Array {
  if (isSz3(meta)) {
    const idx = sz3Index.get(key(name, frame));
    if (!idx) throw new Error(`缺少 SZ3 索引 ${name}@${frame}`);
    return decodeSz3(new Uint8Array(buffer), idx);
  }
  const n = count(meta);
  const out = new Float32Array(n);
  if (meta.dtype === "float16") {
    const h = new Uint16Array(buffer, 0, n);
    for (let i = 0; i < n; i += 1) out[i] = HALF_TO_FLOAT[h[i]!]!;
    return out;
  }
  const q = meta.dtype === "uint16" ? new Uint16Array(buffer, 0, n) : new Uint8Array(buffer, 0, n);
  const perLevel = meta.range_scope === "per_level" && meta.shape.length >= 3;
  const levels = perLevel ? meta.shape[0]! : 1;
  const stride = perLevel ? n / levels : n;
  const tr = meta.transform;
  for (let z = 0; z < levels; z += 1) {
    const scale = perLevel ? meta.level_scale![z]! : meta.scale!;
    const offset = perLevel ? meta.level_offset![z]! : meta.offset!;
    const start = z * stride;
    const end = start + stride;
    if (!tr) for (let i = start; i < end; i += 1) out[i] = q[i]! * scale + offset;
    else
      for (let i = start; i < end; i += 1) {
        const v = q[i]! * scale + offset;
        out[i] =
          tr === "log10" ? Math.pow(10, v) : tr === "log1p" ? Math.expm1(v) : Math.sign(v) * v * v;
      }
  }
  return out;
}

function halfOf(buffer: ArrayBuffer, meta: VariableMeta, decoded: Float32Array): Uint16Array {
  const n = count(meta);
  if (meta.dtype === "float16") return new Uint16Array(buffer.slice(0, n * 2));
  const out = new Uint16Array(n);
  toHalfArray(decoded, out);
  return out;
}

// ---------------------------------------------------------------- raw cache
function touch(k: string, buf: ArrayBuffer): void {
  raw.delete(k);
  raw.set(k, buf);
}

function evict(): void {
  for (const [k, buf] of raw) {
    if (rawBytes <= RAW_BUDGET) break;
    raw.delete(k);
    rawBytes -= buf.byteLength;
    const [name, frame] = k.split("@");
    postMessage({ type: "evicted", name, frame: Number(frame) });
  }
}

async function ensureRaw(name: string, frame: number): Promise<ArrayBuffer> {
  const k = key(name, frame);
  const hit = raw.get(k);
  if (hit) {
    touch(k, hit);
    return hit;
  }
  const pending = fetching.get(k);
  if (pending) return pending;
  const meta = manifest.variables[name];
  if (!meta) throw new Error(`未知变量 ${name}`);
  const p = (async () => {
    performance.mark(`atmos:fetch:${k}:start`);
    const t0 = performance.now();
    const base = dataRoot + (dirs[frame] ?? "");
    const response = await fetch(base + meta.file);
    if (!response.ok) throw new Error(`无法加载 ${k}: ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (isSz3(meta)) {
      const indexName = meta.index_file || meta.file.replace(/\.sz3pack$/, ".json");
      const ir = await fetch(base + indexName);
      if (!ir.ok) throw new Error(`无法加载 ${k} 索引: ${ir.status}`);
      sz3Index.set(k, (await ir.json()) as Sz3Index);
    }
    performance.mark(`atmos:fetch:${k}:end`);
    raw.set(k, buffer);
    rawBytes += buffer.byteLength;
    postMessage({ type: "cached", name, frame, timing: { fetchMs: performance.now() - t0, bytes: buffer.byteLength } });
    evict();
    return buffer;
  })();
  fetching.set(k, p);
  try {
    return await p;
  } finally {
    fetching.delete(k);
  }
}

// ---------------------------------------------------------------- jobs
async function run(job: Job): Promise<void> {
  if (job.kind === "fetch") {
    await ensureRaw(job.name, job.frame);
    return;
  }
  if (job.kind === "wind") {
    if (isSz3(manifest.variables.u) || isSz3(manifest.variables.v) || isSz3(manifest.variables.w)) {
      await ensureSz3();
    }
    const [ub, vb, wb] = await Promise.all(["u", "v", "w"].map((n) => ensureRaw(n, job.frame)));
    const t0 = performance.now();
    const um = manifest.variables.u!, vm = manifest.variables.v!, wm = manifest.variables.w!;
    const n = count(um);
    const packed = new Uint16Array(n * 4);
    const put = (buf: ArrayBuffer, meta: VariableMeta, name: string, channel: number) => {
      if (meta.dtype === "float16") {
        const h = new Uint16Array(buf, 0, n);
        for (let i = 0; i < n; i += 1) packed[i * 4 + channel] = h[i]!;
      } else toHalfArray(decode(buf, meta, job.frame, name), packed, 4, channel);
    };
    put(ub!, um, "u", 0);
    put(vb!, vm, "v", 1);
    put(wb!, wm, "w", 2);
    post({ type: "wind", frame: job.frame, half: packed.buffer, packMs: performance.now() - t0 }, [packed.buffer]);
    return;
  }
  const meta = manifest.variables[job.name];
  if (!meta) return;
  if (isSz3(meta)) await ensureSz3();
  const tFetch = performance.now();
  const buffer = await ensureRaw(job.name, job.frame);
  const fetchMs = performance.now() - tFetch;
  performance.mark(`atmos:decode:${job.name}@${job.frame}:start`);
  const t0 = performance.now();
  const decoded = decode(buffer, meta, job.frame, job.name);
  const half = job.half ? halfOf(buffer, meta, decoded) : null;
  performance.mark(`atmos:decode:${job.name}@${job.frame}:end`);
  const transfer: ArrayBuffer[] = [decoded.buffer as ArrayBuffer];
  if (half) transfer.push(half.buffer as ArrayBuffer);
  post(
    {
      type: "data",
      name: job.name,
      frame: job.frame,
      buffer: decoded.buffer,
      half: half?.buffer ?? null,
      timing: { fetchMs, decodeMs: performance.now() - t0, bytes: buffer.byteLength },
    },
    transfer,
  );
}

function pump(): void {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    const k = jobKey(job);
    if (running.has(k)) continue;
    // A fetch-only job whose bytes are already here needs no slot.
    if (job.kind === "fetch" && raw.has(key(job.name, job.frame))) continue;
    running.add(k);
    active += 1;
    run(job)
      .catch((error) => postMessage({ type: "error", message: String(error), name: job.name, frame: job.frame }))
      .finally(() => {
        running.delete(k);
        active -= 1;
        postMessage({ type: "done", job });
        pump();
      });
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
      dirs = manifest.times?.length ? manifest.times.map((t) => t.dir) : [""];
      performance.mark("atmos:fetch:manifest:end");
      postMessage({ type: "manifest", manifest, timing: { fetchMs: performance.now() - tManifest } });
    } else if (event.data.type === "want") {
      // Highest priority first; anything not listed any more is dropped (in-flight jobs finish).
      queue = (event.data.jobs as Job[]).filter((j) => !running.has(jobKey(j)));
      pump();
    }
  } catch (error) {
    postMessage({ type: "error", message: String(error), fatal: true });
  }
};
