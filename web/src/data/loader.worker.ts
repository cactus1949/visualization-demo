/**
 * Data worker: fetches each variable's encoded file for a frame through its codec
 * (codecs/*.ts), keeps only the sliding-window payloads, and decodes on demand.
 *
 * Jobs (the main thread replaces the queue with its current wish list):
 *  - fetch  : only make sure the encoded bytes of name@frame are cached
 *  - decode : Float32 physical values for CPU readers (+ half floats for a GPU slot if `half`)
 *  - wind   : RGBA half-float pack (u, v, w, 0) of one frame for the GPU wind slots
 *
 * A `want` message also carries the frames in the current window. Encoded bytes
 * for frames that have left the window are released, and in-flight fetches for
 * those frames are aborted. Half-float work happens here, never on the main thread.
 */
import type { Manifest, VariableMeta } from "./manifest";
import type { Codec, CodecEnv, Payload } from "./codecs/types";
import { isAbortError, WindowByteCache } from "./windowCache";

// Codec plug-ins: every codecs/*.ts file (current.ts, sz3.ts, ...). Deleting one removes it.
const codecs: Codec[] = Object.values(
  import.meta.glob<{ default: Codec }>("./codecs/*.ts", { eager: true }),
)
  .map((m) => m.default)
  .filter((c): c is Codec => !!c && Array.isArray(c.encodings));
function codecOf(meta: VariableMeta): Codec {
  const c = codecs.find((x) => x.encodings.includes(meta.encoding));
  if (!c) throw new Error(`没有 ${meta.encoding} 编码的解码器（codecs/ 里缺对应文件）`);
  return c;
}

type JobKind = "fetch" | "decode" | "wind";
interface Job {
  kind: JobKind;
  name: string;
  frame: number;
  half?: boolean;
}

const post = (message: unknown, transfer: Transferable[] = []) =>
  (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(
    message,
    transfer,
  );
let manifest: Manifest;
let dataRoot = "";
let dirs: string[] = [""];
const cache = new WindowByteCache();
const running = new Set<string>();
const CONCURRENCY = 2;
let queue: Job[] = [];
let active = 0;
/** Frames the main thread currently wants kept in the encoded-byte cache. */
let keepFrames: number[] = [];

const key = (name: string, frame: number) => `${name}@${frame}`;
const jobKey = (j: Job) => `${j.kind}:${j.name}@${j.frame}${j.half ? "+h" : ""}`;

// ---------------------------------------------------------------- float -> half table
// float -> half (round-to-nearest on the mantissa), tables as in three's DataUtils
const BASE = new Uint32Array(512);
const SHIFT = new Uint32Array(512);
for (let i = 0; i < 256; i += 1) {
  const e = i - 127;
  if (e < -27) {
    BASE[i] = 0x0000;
    BASE[i | 0x100] = 0x8000;
    SHIFT[i] = 24;
    SHIFT[i | 0x100] = 24;
  } else if (e < -14) {
    BASE[i] = 0x0400 >> (-e - 14);
    BASE[i | 0x100] = (0x0400 >> (-e - 14)) | 0x8000;
    SHIFT[i] = -e - 1;
    SHIFT[i | 0x100] = -e - 1;
  } else if (e <= 15) {
    BASE[i] = (e + 15) << 10;
    BASE[i | 0x100] = ((e + 15) << 10) | 0x8000;
    SHIFT[i] = 13;
    SHIFT[i | 0x100] = 13;
  } else if (e < 128) {
    BASE[i] = 0x7c00;
    BASE[i | 0x100] = 0xfc00;
    SHIFT[i] = 24;
    SHIFT[i | 0x100] = 24;
  } else {
    BASE[i] = 0x7c00;
    BASE[i | 0x100] = 0xfc00;
    SHIFT[i] = 13;
    SHIFT[i | 0x100] = 13;
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

function envFor(frame: number): CodecEnv {
  return { manifest, values: (name: string) => valuesOf(name, frame) };
}

/** Physical values of name@frame (fetching the payload if needed). */
async function valuesOf(name: string, frame: number): Promise<Float32Array> {
  const meta = manifest.variables[name];
  if (!meta) throw new Error(`未知变量 ${name}`);
  const payload = await ensureRaw(name, frame);
  return codecOf(meta).decode(payload, meta, envFor(frame));
}

function halfOf(payload: Payload, meta: VariableMeta, decoded: Float32Array): Uint16Array {
  const fast = codecOf(meta).half?.(payload, meta);
  if (fast) return fast;
  const out = new Uint16Array(count(meta));
  toHalfArray(decoded, out);
  return out;
}

// ---------------------------------------------------------------- raw cache
async function ensureRaw(name: string, frame: number): Promise<Payload> {
  const k = key(name, frame);
  const meta = manifest.variables[name];
  if (!meta) throw new Error(`未知变量 ${name}`);
  return cache.load(k, async (signal) => {
    performance.mark(`atmos:fetch:${k}:start`);
    const t0 = performance.now();
    const payload = await codecOf(meta).load(dataRoot + (dirs[frame] ?? ""), meta, name, signal);
    performance.mark(`atmos:fetch:${k}:end`);
    postMessage({
      type: "cached",
      name,
      frame,
      timing: { fetchMs: performance.now() - t0, bytes: payload.bytes.byteLength },
    });
    return payload;
  });
}

function applyWindow(frames: number[]): void {
  keepFrames = [...frames];
  const { evicted, aborted } = cache.retainFrames(keepFrames);
  for (const k of evicted) {
    const at = k.lastIndexOf("@");
    postMessage({ type: "evicted", name: k.slice(0, at), frame: Number(k.slice(at + 1)) });
  }
  for (const k of aborted) {
    const at = k.lastIndexOf("@");
    postMessage({ type: "aborted", name: k.slice(0, at), frame: Number(k.slice(at + 1)) });
  }
}

// ---------------------------------------------------------------- jobs
async function run(job: Job): Promise<void> {
  if (job.kind === "fetch") {
    await ensureRaw(job.name, job.frame);
    return;
  }
  if (job.kind === "wind") {
    const names = ["u", "v", "w"] as const;
    const payloads = await Promise.all(names.map((n) => ensureRaw(n, job.frame)));
    const t0 = performance.now();
    const n = count(manifest.variables.u!);
    const packed = new Uint16Array(n * 4);
    for (let c = 0; c < 3; c += 1) {
      const meta = manifest.variables[names[c]]!;
      const fast = codecOf(meta).half?.(payloads[c]!, meta);
      if (fast) for (let i = 0; i < n; i += 1) packed[i * 4 + c] = fast[i]!;
      else
        toHalfArray(
          await codecOf(meta).decode(payloads[c]!, meta, envFor(job.frame)),
          packed,
          4,
          c,
        );
    }
    post({ type: "wind", frame: job.frame, half: packed.buffer, packMs: performance.now() - t0 }, [
      packed.buffer,
    ]);
    return;
  }
  const meta = manifest.variables[job.name];
  if (!meta) return;
  const tFetch = performance.now();
  const payload = await ensureRaw(job.name, job.frame);
  const fetchMs = performance.now() - tFetch;
  performance.mark(`atmos:decode:${job.name}@${job.frame}:start`);
  const t0 = performance.now();
  const decoded = await codecOf(meta).decode(payload, meta, envFor(job.frame));
  const half = job.half ? halfOf(payload, meta, decoded) : null;
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
      timing: { fetchMs, decodeMs: performance.now() - t0, bytes: payload.bytes.byteLength },
    },
    transfer,
  );
}

function pump(): void {
  while (active < CONCURRENCY && queue.length) {
    const job = queue.shift()!;
    const k = jobKey(job);
    if (running.has(k)) continue;
    if (keepFrames.length && !keepFrames.includes(job.frame)) continue;
    // A fetch-only job whose bytes are already here needs no slot.
    if (job.kind === "fetch" && cache.has(key(job.name, job.frame))) continue;
    running.add(k);
    active += 1;
    run(job)
      .catch((error) => {
        if (isAbortError(error)) return;
        postMessage({ type: "error", message: String(error), name: job.name, frame: job.frame });
      })
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
      postMessage({
        type: "manifest",
        manifest,
        timing: { fetchMs: performance.now() - tManifest },
      });
    } else if (event.data.type === "want") {
      const frames = Array.isArray(event.data.frames) ? (event.data.frames as number[]) : [];
      applyWindow(frames);
      // Highest priority first; jobs for frames no longer in the window are dropped.
      // In-flight fetches for those frames are aborted by applyWindow.
      queue = (event.data.jobs as Job[]).filter(
        (j) => !running.has(jobKey(j)) && frames.includes(j.frame),
      );
      pump();
    }
  } catch (error) {
    postMessage({ type: "error", message: String(error), fatal: true });
  }
};
