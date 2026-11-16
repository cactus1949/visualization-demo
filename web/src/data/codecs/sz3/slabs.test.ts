import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { assembleSlabs, decompressDeflate } from "./slabs.ts";

function pack(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

function f16(...values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < values.length; i += 1) view.setUint16(i * 2, values[i]!, true);
  return out;
}

test("assembles const, u8 log10, f16 and nan mask slabs", async () => {
  const u8 = deflateSync(Buffer.from([0, 1]));
  const half = deflateSync(f16(0x3c00, 0xc000)); // 1, -2
  const mask = new Uint8Array(8);
  const maskView = new DataView(mask.buffer);
  maskView.setUint32(0, 1, true); // valid
  maskView.setUint32(4, 1, true); // missing
  const bytes = pack([u8, half, mask]);
  const u8Offset = 0;
  const f16Offset = u8.length;
  const nanOffset = f16Offset + half.length;
  const result = await assembleSlabs(
    bytes,
    {
      shape: [3, 2],
      slab_shape: [2],
      transform: "log10",
      slabs: [
        { kind: "const", value: null },
        { kind: "u8", offset: u8Offset, length: u8.length, scale: 1, add: 1 },
        { kind: "f16", offset: f16Offset, length: half.length, nan: { offset: nanOffset, length: mask.length } },
      ],
    },
    async (stream) => new Float32Array(stream),
    decompressDeflate,
  );
  assert.equal(result.length, 6);
  assert.ok(Number.isNaN(result[0]));
  assert.ok(Number.isNaN(result[1]));
  assert.equal(result[2], 10);
  assert.equal(result[3], 100);
  assert.equal(result[4], 1);
  assert.ok(Number.isNaN(result[5]));
});

test("legacy offsets decode all slabs through the SZ3 callback", async () => {
  const bytes = new Uint8Array([3, 4, 5, 6]);
  const result = await assembleSlabs(
    bytes,
    { shape: [2, 2], slab_shape: [2], offsets: [0, 2], lengths: [2, 2] },
    (stream) => new Float32Array([stream[0]!, stream[1]!]),
    async () => { throw new Error("legacy SZ3 must not use deflate"); },
  );
  assert.deepEqual([...result], [3, 4, 5, 6]);
});

test("round preserves NaN and rounds mixed slab values", async () => {
  const compressed = new Uint8Array([1, 2]);
  const result = await assembleSlabs(
    compressed,
    { shape: [2], slab_shape: [2], round: true, slabs: [{ kind: "sz3", offset: 0, length: compressed.length }] },
    async () => new Float32Array([1.4, Number.NaN]),
    async () => { throw new Error("round test must not use deflate"); },
  );
  assert.deepEqual([...result], [1, NaN]);
});
