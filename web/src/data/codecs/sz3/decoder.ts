/** SZ3 3.4.0 WASM decoder (T1L packs). Only used by codecs/sz3.ts. */
export interface Sz3Index {
  name?: string;
  shape: number[];
  per_level?: boolean;
  slab_shape: number[];
  transform?: "log10" | string | null;
  /** categorical field stored with bound 0.49: round after decoding */
  round?: boolean;
  offsets: number[];
  lengths: number[];
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
  decodeVar(bytes: Uint8Array, idx: Sz3Index): Float32Array {
    const total = idx.shape.reduce((a, b) => a * b, 1);
    const slab = idx.slab_shape.reduce((a, b) => a * b, 1);
    this.ensure(bytes.length, slab);
    this.m.HEAPU8.set(bytes, this.inPtr);
    const out = new Float32Array(total);
    for (let s = 0; s < idx.offsets.length; s += 1) {
      const n = this.m._sz3_decompress_f32(this.inPtr + idx.offsets[s]!, idx.lengths[s]!, this.outPtr, slab);
      if (n !== slab) throw new Error(`SZ3 decode ${idx.name ?? "var"} slab ${s}: got ${n}`);
      out.set(this.m.HEAPF32.subarray(this.outPtr >> 2, (this.outPtr >> 2) + slab), s * slab);
    }
    if (idx.transform === "log10") {
      for (let i = 0; i < total; i += 1) out[i] = Math.pow(10, out[i]!);
    }
    if (idx.round) {
      for (let i = 0; i < total; i += 1) out[i] = Math.round(out[i]!);
    }
    return out;
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

export function decodeSz3(bytes: Uint8Array, idx: Sz3Index): Float32Array {
  if (!decoder) throw new Error("SZ3 WASM 尚未初始化");
  return decoder.decodeVar(bytes, idx);
}
