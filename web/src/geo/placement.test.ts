import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ellipsoidHeight, sampleGrid } from "./placement.ts";

describe("globe vertical placement", () => {
  it("h = ground + k * AGL: exaggeration scales only the height above ground", () => {
    assert.equal(ellipsoidHeight(-7, 1, 100), 93);
    assert.equal(ellipsoidHeight(-7, 3, 100), 293);
    assert.equal(ellipsoidHeight(0, 10, 0), 0);
  });
  it("grid fields are row 0 = south, column 0 = west, sampled bilinearly", () => {
    // 3 x 2 grid: value = 10 * row + column
    const field = { nx: 3, ny: 2, values: new Float32Array([0, 1, 2, 10, 11, 12]) };
    assert.equal(sampleGrid(field, 0, 0), 0); // south-west
    assert.equal(sampleGrid(field, 1, 0), 2); // south-east
    assert.equal(sampleGrid(field, 0, 1), 10); // north-west
    assert.equal(sampleGrid(field, 1, 1), 12);
    assert.equal(sampleGrid(field, 0.25, 0.5), 5.5);
  });
});
