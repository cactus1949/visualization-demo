/**
 * Codec plug-in interface for the data worker. Every `codecs/*.ts` file default-exports one
 * Codec and is picked up by `import.meta.glob` in loader.worker.ts, so deleting a codec file
 * (and its folder) removes it without editing the worker.
 */
import type { Manifest, VariableMeta } from "../manifest";

/** Encoded bytes of one variable at one frame, as kept in the worker's window cache. */
export interface Payload {
  bytes: ArrayBuffer;
  /** codec-specific sidecar (e.g. the SZ3 slab index) */
  extra?: unknown;
}

export interface CodecEnv {
  manifest: Manifest;
  /** physical values of another variable at the same frame (for derived fields) */
  values(name: string): Promise<Float32Array>;
}

export interface Codec {
  id: string;
  /** encodings this codec decodes (manifest `variables[name].encoding`) */
  encodings: string[];
  /** fetch the encoded payload; `base` is the frame directory URL */
  load(base: string, meta: VariableMeta, name: string, signal?: AbortSignal): Promise<Payload>;
  /** physical float32 values */
  decode(p: Payload, meta: VariableMeta, env: CodecEnv): Promise<Float32Array> | Float32Array;
  /** optional fast path: half floats straight from the payload (f16 data) */
  half?(p: Payload, meta: VariableMeta): Uint16Array | null;
}

export async function fetchBytes(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(url, signal ? { signal } : undefined);
  if (!response.ok) throw new Error(`无法加载 ${url}: ${response.status}`);
  return response.arrayBuffer();
}

export function count(meta: VariableMeta): number {
  return meta.shape.reduce((a, b) => a * b, 1);
}
