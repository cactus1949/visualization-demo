import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { colorRangeUniform, particleRanges } from "./particleRanges.ts";

const never = (): [number, number] => {
  throw new Error("fallback must not run when the manifest has a speed display_range");
};

describe("particleRanges", () => {
  it("uses the manifest display ranges (speed as is, w as the symmetric max)", () => {
    const r = particleRanges({
      speedDisplay: [0, 20],
      speedFallback: never,
      wDisplay: [-0.25, 0.3],
      wData: { data_min: -0.18, data_max: 0.21 },
    });
    assert.deepEqual(r, { speedRange: [0, 20], wRange: 0.3 });
  });

  it("falls back to the frame speed range and 0.6 × |w| data extent (at least 0.05)", () => {
    const r = particleRanges({
      speedDisplay: null,
      speedFallback: () => [1.5, 12],
      wDisplay: null,
      wData: { data_min: -0.5, data_max: 0.2 },
    });
    assert.deepEqual(r.speedRange, [1.5, 12]);
    assert.ok(Math.abs(r.wRange - 0.3) < 1e-12);
    const tiny = particleRanges({ speedDisplay: null, speedFallback: () => [0, 1], wDisplay: null, wData: { data_min: -0.01, data_max: 0.02 } });
    assert.equal(tiny.wRange, 0.05);
  });

  it("follows a manifest change: a second encoding's ranges replace the first's", () => {
    const a = particleRanges({ speedDisplay: [0, 20], speedFallback: never, wDisplay: [-0.25, 0.25], wData: { data_min: -1, data_max: 1 } });
    const b = particleRanges({ speedDisplay: [0, 18], speedFallback: never, wDisplay: [-0.4, 0.35], wData: { data_min: -1, data_max: 1 } });
    assert.notDeepEqual(a, b);
    assert.deepEqual(b, { speedRange: [0, 18], wRange: 0.4 });
  });

  it("does not alias the manifest array", () => {
    const disp: [number, number] = [0, 20];
    const r = particleRanges({ speedDisplay: disp, speedFallback: never, wDisplay: null, wData: { data_min: 0, data_max: 0 } });
    disp[1] = 99;
    assert.deepEqual(r.speedRange, [0, 20]);
  });
});

describe("colorRangeUniform (trail uColorRange)", () => {
  const binding = { maxSpeed: 25, speedRange: [0, 18] as [number, number], wRange: 0.4 };
  it("speed → (maxSpeed, lo, hi)", () => assert.deepEqual(colorRangeUniform("speed", binding), [25, 0, 18]));
  it("w → (wRange, 0, 0)", () => assert.deepEqual(colorRangeUniform("w", binding), [0.4, 0, 0]));
  it("height / single leave the uniform alone", () => {
    assert.equal(colorRangeUniform("height", binding), null);
    assert.equal(colorRangeUniform("single", binding), null);
  });
});
