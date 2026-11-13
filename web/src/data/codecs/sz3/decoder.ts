/** SZ3 3.4.0 WASM decoder (T1L packs). Only used by codecs/sz3.ts. */
import { assembleSlabs, decompressDeflate, type SlabAssemblyIndex } from "./slabs";

export type { SlabIndex } from "./slabs";

export interface Sz3Index {
  name?: string;
  shape: number[];
  per_level?: boolean;
  slab_shape: number[];
  transform?: "log10" | string | null;
  /** categorical field stored with bound 0.49: round after decoding */
  round?: boolean;
  offsets?: number[];
  lengths?: number[];
  slabs?: SlabAssemblyIndex["slabs"];
}

type Sz3Module = {
  _sz3_decompress_f32: (inPtr: number, inLen: number, outPtr: number, outCap: number) => number;
  _sz3_malloc: (n: number) => number;
  _sz3_free: (p: number) => void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  wasmMemory?: { buffer: ArrayBuffer };
};

class Decoder {
  private inCap = 0;
  private inPtr = 0;
  private outCap = 0;
  private outPtr = 0;
  constructor(private readonly m: Sz3Module) {}
  private ensure(inBytes: number, outFloats: number): void {
    if (inBytes > this.inCap) {
      if (this.inPtr) this.m._sz3_free(this.inPtr);
      this.inPtr = this.m._sz3_malloc(inBytes);
      this.inCap = inBytes;
    }
    if (outFloats > this.outCap) {
      if (this.outPtr) this.m._sz3_free(this.outPtr);
      this.outPtr = this.m._sz3_malloc(outFloats * 4);
      this.outCap = outFloats;
    }
  }
  async decodeVar(bytes: Uint8Array, idx: Sz3Index): Promise<Float32Array> {
    const slab = idx.slab_shape.reduce((a, b) => a * b, 1);
    const total = idx.shape.reduce((a, b) => a * b, 1);
    this.ensure(bytes.length, slab);
    const decodeOne = (stream: Uint8Array): Float32Array => {
      this.m.HEAPU8.set(stream, this.inPtr);
      const n = this.m._sz3_decompress_f32(this.inPtr, stream.length, this.outPtr, slab);
      if (n !== slab) throw new Error(`SZ3 decode ${idx.name ?? "var"}: got ${n}`);
      return this.m.HEAPF32.subarray(this.outPtr >> 2, (this.outPtr >> 2) + slab).slice();
    };
    return assembleSlabs(bytes, idx, decodeOne, decompressDeflate);
  }
}

let ready: Promise<Decoder> | null = null;
let decoder: Decoder | null = null;

export function ensureSz3(): Promise<Decoder> {
  if (decoder) return Promise.resolve(decoder);
  if (!ready) {
    ready = (async () => {
      const factory = (await import("./sz3_O3.mjs")).default;
      const wasmUrl = new URL("./sz3_O3.wasm", import.meta.url).href;
      const mod = (await factory({ locateFile: (p: string) => (p.endsWith(".wasm") ? wasmUrl : p) })) as Sz3Module;
      decoder = new Decoder(mod);
      return decoder;
    })();
  }
  return ready;
}

export async function decodeSz3(bytes: Uint8Array, idx: Sz3Index): Promise<Float32Array> {
  const needsWasm = !idx.slabs || idx.slabs.some((slab) => slab?.kind === "sz3");
  if (!needsWasm) return assembleSlabs(bytes, idx, () => { throw new Error("unexpected SZ3 slab"); }, decompressDeflate);
  if (!decoder) await ensureSz3();
  return decoder!.decodeVar(bytes, idx);
}
