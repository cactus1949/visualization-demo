declare const factory: (opts?: { locateFile?: (path: string, scriptDirectory?: string) => string }) => Promise<{
  _sz3_decompress_f32: (inPtr: number, inLen: number, outPtr: number, outCap: number) => number;
  _sz3_malloc: (n: number) => number;
  _sz3_free: (p: number) => void;
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  wasmMemory?: { buffer: ArrayBuffer };
}>;
export default factory;
