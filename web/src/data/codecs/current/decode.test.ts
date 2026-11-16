import assert from "node:assert/strict";
import test from "node:test";
import type { VariableMeta } from "../../manifest";
import { decodeCurrent } from "./decode.ts";

// 2 levels x 2 x 3, u8 per_level with the top code (255) reserved for missing cells: valid codes are 0..254.
function meta(extra: Partial<VariableMeta> = {}): VariableMeta {
  return {
    shape: [2, 2, 3],
    dtype: "uint8",
    range_scope: "per_level",
    level_scale: [0.5, 0.1],
    level_offset: [1, -2],
    ...extra,
  } as unknown as VariableMeta;
}

function bytes(codes: number[]): ArrayBuffer {
  return new Uint8Array(codes).buffer;
}

test("u8 per_level with nan_code: reserved code decodes to NaN, top valid code to the level max", () => {
  const codes = [0, 254, 255, 10, 255, 254, /* level 1 */ 255, 0, 254, 100, 50, 255];
  const out = decodeCurrent(bytes(codes), meta({ nan_code: 255 }));
  const nanAt = codes.flatMap((c, i) => (c === 255 ? [i] : []));
  for (let i = 0; i < out.length; i += 1) assert.equal(Number.isNaN(out[i]), nanAt.includes(i), `cell ${i}`);
  assert.equal(out[0], 1); // level 0 min = offset
  assert.equal(out[1], 1 + 254 * 0.5); // level 0 max (code 254) = 128
  assert.equal(out[5], 128);
  assert.ok(Math.abs(out[7]! - -2) < 1e-6); // level 1 min
  assert.ok(Math.abs(out[8]! - (-2 + 254 * 0.1)) < 1e-5); // level 1 max = 23.4
});

test("without nan_code code 255 is an ordinary value", () => {
  const out = decodeCurrent(bytes([255, 0, 0, 0, 0, 0, 255, 0, 0, 0, 0, 0]), meta());
  assert.equal(out[0], 1 + 255 * 0.5);
  assert.ok(Math.abs(out[6]! - (-2 + 255 * 0.1)) < 1e-5);
  assert.ok(out.every((v) => Number.isFinite(v)));
});
