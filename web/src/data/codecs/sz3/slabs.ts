export type SlabKind = "sz3" | "const" | "u8" | "f16";

export interface SlabIndex {
  kind: SlabKind;
  offset?: number;
  length?: number;
  value?: number | null;
  scale?: number;
  add?: number;
  nan?: { offset: number; length: number };
}

export interface SlabAssemblyIndex {
  name?: string;
  shape: number[];
  slab_shape: number[];
  transform?: "log10" | string | null;
  round?: boolean;
  slabs?: SlabIndex[];
  offsets?: number[];
  lengths?: number[];
}

export type DecodeSz3Slab = (bytes: Uint8Array) => Float32Array | Promise<Float32Array>;
export type Decompress = (bytes: Uint8Array) => Promise<Uint8Array>;

function slabCount(index: SlabAssemblyIndex): number {
  return index.shape.reduce((a, b) => a * b, 1) / index.slab_shape.reduce((a, b) => a * b, 1);
}

function bytesOf(pack: Uint8Array, offset: number | undefined, length: number | undefined, label: string): Uint8Array {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset! < 0 || length! < 0 || offset! + length! > pack.length)
    throw new Error(`SZ3 ${label} offset/length 无效`);
  return pack.subarray(offset!, offset! + length!);
}

function float16(value: number): number {
  const sign = (value & 0x8000) ? -1 : 1;
  const exponent = (value >> 10) & 0x1f;
  const fraction = value & 0x3ff;
  if (exponent === 0) return sign * (fraction ? fraction * 2 ** -24 : 0);
  if (exponent === 0x1f) return fraction ? Number.NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function applyNanMask(out: Float32Array, pack: Uint8Array, mask: { offset: number; length: number } | undefined): void {
  if (!mask) return;
  const bytes = bytesOf(pack, mask.offset, mask.length, "nan mask");
  if (bytes.length % 4 !== 0) throw new Error("SZ3 nan mask 长度不是 uint32 的整数倍");
  let cursor = 0;
  let missing = false;
  for (let i = 0; i < bytes.length; i += 4) {
    const count = new DataView(bytes.buffer, bytes.byteOffset + i, 4).getUint32(0, true);
    if (count > out.length - cursor) throw new Error("SZ3 nan mask 超出 slab");
    if (missing) out.fill(Number.NaN, cursor, cursor + count);
    cursor += count;
    missing = !missing;
  }
  if (cursor !== out.length) throw new Error("SZ3 nan mask 未覆盖完整 slab");
}

function transform(value: number, enabled: boolean): number {
  return enabled && Number.isFinite(value) ? 10 ** value : value;
}

/** Assemble one frame from v2 slabs, or the legacy all-SZ3 offset/length arrays. */
export async function assembleSlabs(
  pack: Uint8Array,
  index: SlabAssemblyIndex,
  decodeSz3: DecodeSz3Slab,
  decompress: Decompress = decompressDeflate,
): Promise<Float32Array> {
  const slab = index.slab_shape.reduce((a, b) => a * b, 1);
  const total = index.shape.reduce((a, b) => a * b, 1);
  const out = new Float32Array(total);
  const slabs: SlabIndex[] = index.slabs ?? (index.offsets ?? []).map((offset, i) => ({
    kind: "sz3",
    offset,
    length: index.lengths?.[i],
  }));
  if (slabs.length !== slabCount(index)) throw new Error(`SZ3 ${index.name ?? "var"}: slab 数量不匹配`);
  const log10 = index.transform === "log10";
  for (let s = 0; s < slabs.length; s += 1) {
    const spec = slabs[s]!;
    const values = new Float32Array(slab);
    if (spec.kind === "const") {
      values.fill(spec.value === null || spec.value === undefined ? Number.NaN : spec.value);
    } else if (spec.kind === "sz3") {
      const decoded = await decodeSz3(bytesOf(pack, spec.offset, spec.length, `slab ${s}`));
      if (decoded.length !== slab) throw new Error(`SZ3 decode ${index.name ?? "var"} slab ${s}: got ${decoded.length}`);
      values.set(decoded);
      if (log10) for (let i = 0; i < values.length; i += 1) values[i] = transform(values[i]!, true);
    } else if (spec.kind === "u8") {
      const decoded = await decompress(bytesOf(pack, spec.offset, spec.length, `slab ${s}`));
      if (decoded.length !== slab) throw new Error(`SZ3 u8 slab ${s}: got ${decoded.length}`);
      const scale = spec.scale ?? 1;
      const add = spec.add ?? 0;
      for (let i = 0; i < slab; i += 1) values[i] = transform(decoded[i]! * scale + add, log10);
    } else if (spec.kind === "f16") {
      const decoded = await decompress(bytesOf(pack, spec.offset, spec.length, `slab ${s}`));
      if (decoded.length !== slab * 2) throw new Error(`SZ3 f16 slab ${s}: got ${decoded.length / 2}`);
      for (let i = 0; i < slab; i += 1) values[i] = float16(decoded[i * 2]! | (decoded[i * 2 + 1]! << 8));
    } else {
      throw new Error(`SZ3 未知 slab kind: ${String((spec as { kind?: unknown }).kind)}`);
    }
    applyNanMask(values, pack, spec.nan);
    out.set(values, s * slab);
  }
  if (index.round) for (let i = 0; i < out.length; i += 1) if (Number.isFinite(out[i]!)) out[i] = Math.round(out[i]!);
  return out;
}

export async function decompressDeflate(bytes: Uint8Array): Promise<Uint8Array> {
  const input = bytes.slice().buffer as ArrayBuffer;
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
