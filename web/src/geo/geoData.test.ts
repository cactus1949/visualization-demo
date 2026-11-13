import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { demHeightAt, dequantize } from "./geoData.ts";

describe("geo foundation files", () => {
  it("u16 little-endian samples decode to offset + q * scale", () => {
    const raw = new Uint8Array([0, 0, 1, 0, 0xff, 0xff]).buffer;
    const v = dequantize(raw, { file: "x", nx: 3, ny: 1, offset: -20, scale: 0.01 });
    assert.deepEqual(Array.from(v, (x) => Math.round(x * 100) / 100), [-20, -19.99, 635.35]);
  });
  it("rejects a file whose size does not match the grid", () => {
    assert.throws(() => dequantize(new ArrayBuffer(4), { file: "dem", nx: 3, ny: 1, offset: 0, scale: 1 }), /dem/);
  });
  it("DEM rows run north to south and bounds are pixel centres; outside returns the fallback", () => {
    // 2 x 2: north row [1, 2], south row [3, 4]
    const dem = { nx: 2, ny: 2, west: 117, east: 118, south: 39, north: 40, values: new Float32Array([1, 2, 3, 4]) };
    assert.equal(demHeightAt(dem, 117, 40), 1);
    assert.equal(demHeightAt(dem, 118, 39), 4);
    assert.equal(demHeightAt(dem, 117.5, 39.5), 2.5);
    assert.equal(demHeightAt(dem, 116.9, 39.5, -99), -99);
  });
});
