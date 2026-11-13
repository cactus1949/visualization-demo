import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SIGHT_DEFAULTS, sightStepM, terrainBlocksSight, type Vec3 } from "./lineOfSight.ts";

// flat-earth toy domain: 20 km x 20 km centred on the origin, u = x / 20000 + 0.5
const toGrid = (p: Vec3) => ({ u: p[0] / 20000 + 0.5, v: p[1] / 20000 + 0.5, h: p[2] });
/** a narrow ridge `height` m tall and `width` m wide across x = ridgeX */
const ridge = (ridgeX: number, height: number, width: number) => (u: number) =>
  Math.abs((u - 0.5) * 20000 - ridgeX) <= width / 2 ? height : 0;

describe("terrainBlocksSight (globe annotation line of sight)", () => {
  it("step <= 60 m, at most 256 samples", () => {
    assert.ok(sightStepM(1000) <= 60);
    assert.ok(sightStepM(15000) <= 60);
    assert.equal(Math.round(sightStepM(25500)), 100); // capped at 256 samples
    assert.equal(SIGHT_DEFAULTS.maxSamples, 256);
  });
  it("a 70 m wide, 6 m ridge on a 12 km grazing line is caught (old 64-sample rule stepped ~190 m)", () => {
    const g = ridge(1234, 6, 70);
    const occluded = terrainBlocksSight([-6000, 0, 2], [6000, 0, 2], toGrid, (u) => g(u));
    assert.equal(occluded, true);
  });
  it("one sample > 3 m under ground is enough; a single 2 m dip is not", () => {
    assert.equal(terrainBlocksSight([-3000, 0, 1], [3000, 0, 1], toGrid, (u) => ridge(17, 4.5, 40)(u)), true);
    assert.equal(terrainBlocksSight([-3000, 0, 1], [3000, 0, 1], toGrid, (u) => ridge(17, 3, 40)(u)), false);
  });
  it("terrain outside the domain does not occlude; the last 3 m before the anchor are not tested", () => {
    const outside = (u: number) => (u > 1 || u < 0 ? 100 : 0);
    assert.equal(terrainBlocksSight([-15000, 0, 5], [0, 0, 5], toGrid, outside), false);
    assert.equal(terrainBlocksSight([-500, 0, 10], [0, 0, 0], toGrid, (u) => ((u - 0.5) * 20000 > -2 ? 0.5 : 0)), false);
  });
  it("clear line stays visible", () => {
    assert.equal(terrainBlocksSight([-6000, 0, 50], [6000, 0, 20], toGrid, () => 0), false);
  });
});
