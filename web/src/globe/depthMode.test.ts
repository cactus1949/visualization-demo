import test from "node:test";
import assert from "node:assert/strict";
import { boxDistances, depthModeFromQuery, depthResolution, frustumDistances, type Box3Like } from "./depthMode.ts";

const box: Box3Like = { min: [-1, -1, 0], max: [1, 1, 0.1] }; // ENU units of 10 km: 20 x 20 km, 1 km tall

test("depth mode query defaults to log and accepts legacy/near/log", () => {
  assert.equal(depthModeFromQuery(""), "log");
  assert.equal(depthModeFromQuery("?globeDepth=near"), "near");
  assert.equal(depthModeFromQuery("?globeDepth=legacy"), "legacy");
  assert.equal(depthModeFromQuery("?globeDepth=linear"), "near");
  assert.equal(depthModeFromQuery("?globeDepth=bogus"), "log");
});

test("box distances: outside, above and inside", () => {
  assert.deepEqual(boxDistances([0, 0, 0.5], box).nearest, 0.4);
  assert.ok(Math.abs(boxDistances([3, 0, 0.05], box).nearest - 2) < 1e-12);
  assert.equal(boxDistances([0, 0, 0.05], box).nearest, 0);
  assert.ok(Math.abs(boxDistances([0, 0, 0.5], box).farthest - Math.hypot(1, 1, 0.5)) < 1e-12);
});

test("near mode never clips the box and is much tighter than legacy from 10 km away", () => {
  const sphere = { center: [0, 0, 0.05] as [number, number, number], radius: Math.hypot(1, 1, 0.05) };
  const camera: [number, number, number] = [0, -1.3, 0.3]; // 3 km south of the box, 3 km up
  const near = frustumDistances({ mode: "near", camera, box, sphere, minNear: 1e-4 });
  const legacy = frustumDistances({ mode: "legacy", camera, box, sphere, minNear: 1e-4 });
  assert.ok(near.near <= boxDistances(camera, box).nearest);
  assert.ok(near.far >= boxDistances(camera, box).farthest);
  assert.equal(legacy.near, 1e-4);
  assert.ok(near.near > 0.3);
});

test("inside the box near falls back to the minimum", () => {
  const sphere = { center: [0, 0, 0] as [number, number, number], radius: 2 };
  assert.equal(frustumDistances({ mode: "log", camera: [0, 0, 0.05], box, sphere, minNear: 1e-4 }).near, 1e-4);
});

test("depth resolution: the PR ① case (1 m near, 30 km far, 10 km away) is about 6 m; log is millimetres", () => {
  // metres
  assert.ok(Math.abs(depthResolution("near", 10000, 1, 30000) - 5.96) < 0.05);
  // ENU units of 10 km, converted back to metres
  assert.ok(depthResolution("log", 1, 1e-4, 3) * 1e4 < 0.002);
});
