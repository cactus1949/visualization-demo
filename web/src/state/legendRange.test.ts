import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  blendRange,
  emptyHint,
  FrameRangeCache,
  formatLegendValue,
  isAllZero,
  markerFraction,
  rangeOfArray,
  thresholdHidesAll,
} from "./legendRange.ts";

describe("legend data ranges", () => {
  it("blends frame bounds and bounds a pointwise blend", () => {
    const a = { min: 0, max: 4 };
    const b = { min: 2, max: 6 };
    assert.deepEqual(blendRange(a, b, 0), a);
    assert.deepEqual(blendRange(a, b, 0.5), { min: 1, max: 5 });
    assert.deepEqual(blendRange(a, b, 1), b);
    const x = new Float32Array([0, 4]);
    const y = new Float32Array([6, 2]);
    const mixed = x.map((v, i) => v * 0.5 + y[i]! * 0.5);
    const bound = blendRange(rangeOfArray(x), rangeOfArray(y), 0.5);
    const actual = rangeOfArray(mixed);
    assert.ok(actual.min >= bound.min && actual.max <= bound.max);
    // the outer bound is never looser than min(s·rangeB, (1-s)·rangeA)
    const limit = Math.min(0.5 * (6 - 2), 0.5 * (4 - 0));
    assert.ok(bound.max - actual.max <= limit && actual.min - bound.min <= limit);
  });

  it("detects all-zero ranges and gives variable-specific hints", () => {
    const zero = { min: 0, max: 0 };
    assert.equal(isAllZero(zero), true);
    assert.equal(emptyHint("icing_index", zero), "本日无积冰");
    assert.equal(emptyHint("tke", zero), "当前无数据");
    assert.equal(emptyHint("tke", { min: 0, max: 1 }), null);
  });

  it("warns only when a known maximum is below the threshold", () => {
    assert.equal(thresholdHidesAll(2, { min: 0, max: 1.9 }), true);
    assert.equal(thresholdHidesAll(2, { min: 0, max: 2 }), false);
    assert.equal(thresholdHidesAll(2, null), false);
  });

  it("caches once per key and retains only current frames", () => {
    const cache = new FrameRangeCache();
    let calls = 0;
    assert.deepEqual(cache.get("tke@1", () => { calls += 1; return { min: 0, max: 1 }; }), { min: 0, max: 1 });
    cache.get("tke@1", () => { calls += 1; return { min: 2, max: 3 }; });
    cache.get("tke@2@k3", () => { calls += 1; return { min: 0, max: 1 }; });
    assert.equal(calls, 2);
    cache.retainFrames([2]);
    cache.get("tke@1", () => { calls += 1; return { min: 0, max: 1 }; });
    assert.equal(calls, 3);
  });

  it("clamps marker fractions and reports clipping", () => {
    assert.deepEqual(markerFraction(-1, 0, 10), { f: 0, clipped: "low" });
    assert.deepEqual(markerFraction(5, 0, 10), { f: 0.5, clipped: null });
    assert.deepEqual(markerFraction(11, 0, 10), { f: 1, clipped: "high" });
  });

  it("formats readouts with enough digits to compare against the threshold", () => {
    assert.equal(formatLegendValue(2.1866), "2.19");
    assert.equal(formatLegendValue(13), "13.0");
    assert.equal(formatLegendValue(0), "0");
    assert.equal(formatLegendValue(2.5e-5), "2.50e-5");
  });
});
