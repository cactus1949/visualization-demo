import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { northScreenDeg, scaledOffset, southOfTarget, zoomTravelM } from "./viewMotion.ts";

describe("view motion", () => {
  it("scaledOffset moves toward the target and clamps distance", () => {
    assert.deepEqual(scaledOffset([0, 3, 4], 0.5, 1, 100).map((v) => +v.toFixed(4)), [0, 1.5, 2]);
    const near = scaledOffset([0, 3, 4], 0.01, 2, 100);
    assert.ok(Math.abs(Math.hypot(...near) - 2) < 1e-9);
    const far = scaledOffset([0, 3, 4], 10, 1, 8);
    assert.ok(Math.abs(Math.hypot(...far) - 8) < 1e-9);
    assert.deepEqual(scaledOffset([0, 0, 0], 0.5, 1, 10), [0, 0, 0]);
  });

  it("zoomTravelM is positive when moving closer and respects the range clamp", () => {
    assert.equal(zoomTravelM(1000, 0.8, 80, 2.5e7), 200);
    assert.equal(zoomTravelM(1000, 1.25, 80, 2.5e7), -250);
    assert.equal(zoomTravelM(100, 0.1, 80, 2.5e7), 20);
    assert.equal(zoomTravelM(0, 0.8, 80, 2.5e7), 0);
  });

  it("southOfTarget parks the box camera due south at the same height and range", () => {
    const south = southOfTarget([-10, 5, -3], [0, 0, 0]);
    assert.ok(south);
    assert.ok(Math.abs(south[0]) < 1e-9);
    assert.equal(south[1], 5);
    assert.ok(Math.abs(south[2] - Math.hypot(10, 3)) < 1e-9);
    const stay = southOfTarget([0, 5, 10], [0, 0, 0]);
    assert.ok(stay && Math.abs(stay[2] - 10) < 1e-9);
    assert.equal(southOfTarget([0, 10, 0], [0, 0, 0]), null);
  });

  it("northScreenDeg points the needle at geographic north on both frames", () => {
    // box: looking north and down, north is screen-up
    assert.ok(Math.abs(northScreenDeg([1, 0, 0], [0, 0.894, -0.447], [0, 0, -1])) < 1);
    // box: looking east, north is screen-right
    assert.ok(Math.abs(northScreenDeg([0, 0, -1], [-0.447, 0.894, 0], [0, 0, -1]) - 90) < 1);
    // globe ENU: looking north and down
    assert.ok(Math.abs(northScreenDeg([1, 0, 0], [0, 0.447, 0.894], [0, 1, 0])) < 1);
    // nadir: north is along the view, no screen direction
    assert.equal(northScreenDeg([1, 0, 0], [0, 1, 0], [0, 0, -1]), 0);
  });
});
