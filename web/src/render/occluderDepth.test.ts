import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { OccluderDepthCache } from "./occluderDepth.ts";

const view = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];
const projection = [1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, -1, -1, 0, 0, -0.2, 0];

describe("occluder depth cache", () => {
  it("reuses the depth image only while the camera, size and generation stay put", () => {
    const cache = new OccluderDepthCache();
    assert.equal(cache.matches(view, projection, 386, 191, "t"), false);
    cache.remember(view, projection, 386, 191, "t");
    assert.equal(cache.matches(view, projection, 386, 191, "t"), true);
    assert.equal(cache.matches(view, projection, 386, 191, "f"), false);
    const moved = [...view];
    moved[12] = 10.01;
    assert.equal(cache.matches(moved, projection, 386, 191, "t"), false);
    assert.equal(cache.matches(view, projection, 387, 191, "t"), false);
    cache.invalidate();
    assert.equal(cache.matches(view, projection, 386, 191, "t"), false);
  });

  it("treats sub-millimetre matrix noise as the same view", () => {
    const cache = new OccluderDepthCache();
    cache.remember(view, projection, 100, 50, "g");
    const jitter = [...view];
    jitter[12] = 10.0004;
    assert.equal(cache.matches(jitter, projection, 100, 50, "g"), true);
  });
});
