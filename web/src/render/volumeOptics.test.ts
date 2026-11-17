import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extinctionPerKm,
  integrateNormalized,
  normalized,
  stepAlpha,
  type OpticsParams,
} from "./volumeOptics.ts";

/** 2026-11-11 SZ3 manifest: u_gust display_range and frame t000 min/max. */
const DISPLAY: [number, number] = [0, 25];
const FRAME0: [number, number] = [5.07303, 9.944845];

function params(mode: OpticsParams["mode"], opacity = 2): OpticsParams {
  return { opacity, threshold: 0, min: DISPLAY[0], max: DISPLAY[1], mode };
}

describe("volume step transfer", () => {
  it("matches Beer-Lambert through a uniform kilometre, and a coarse linear step exceeds 1", () => {
    const n = normalized(7, 0, 25);
    const sigma = extinctionPerKm(n, 2, 0);
    const pathKm = 1;
    const fine = integrateNormalized(Array.from({ length: 128 }, () => n), pathKm / 128, params("beer"), Infinity);
    const coarse = integrateNormalized(Array.from({ length: 2 }, () => n), pathKm / 2, params("beer"), Infinity);
    const expected = 1 - Math.exp(-sigma * pathKm);
    assert.ok(Math.abs(fine.alpha - expected) < 1e-3, `fine ${fine.alpha} vs ${expected}`);
    assert.ok(Math.abs(coarse.alpha - expected) < 0.02, `coarse ${coarse.alpha} vs ${expected}`);
    const linearStep = stepAlpha(n, pathKm / 2, params("linear"));
    assert.ok(linearStep !== null && linearStep > 1);
    assert.ok((stepAlpha(n, pathKm / 2, params("beer")) ?? 0) < 1);
  });

  it("frame-0 gust on the 0–25 scale is optically thick at opacity 2 over one vertical kilometre", () => {
    const lo = normalized(FRAME0[0], DISPLAY[0], DISPLAY[1]);
    const hi = normalized(FRAME0[1], DISPLAY[0], DISPLAY[1]);
    assert.ok(lo > 0.2 && hi < 0.4, `normalized band ${lo}..${hi}`);
    const vertical = integrateNormalized(Array.from({ length: 128 }, () => lo), 1 / 128, params("beer"));
    assert.ok(vertical.alpha > 0.97, `vertical alpha ${vertical.alpha}`);
    assert.ok(vertical.stepsApplied > 8, `a 1 km vertical ray still mixes steps, used ${vertical.stepsApplied}`);
    const across = integrateNormalized(Array.from({ length: 32 }, () => lo), 18 / 32, params("beer"));
    assert.ok(across.stepsApplied <= 2, `an 18 km ray at 32 steps should die at the entry, used ${across.stepsApplied}`);
    assert.ok((stepAlpha(lo, 18 / 32, params("beer")) ?? 0) > 0.9);
    const thin = integrateNormalized(Array.from({ length: 128 }, () => lo), 1 / 128, params("beer", 0.15));
    assert.ok(thin.alpha < 0.7, `low-opacity control should not be a wall, got ${thin.alpha}`);
  });

  it("32 and 128 Beer-Lambert steps agree, while the linear form saturates on the first coarse step", () => {
    const values = [5.1, 6.2, 7.4, 8.5, 9.2, 8.1, 7.0, 6.4];
    const samples = values.map((v) => normalized(v, 0, 25));
    const pathKm = 8;
    const beer32 = integrateNormalized(stretch(samples, 32), pathKm / 32, params("beer"));
    const beer128 = integrateNormalized(stretch(samples, 128), pathKm / 128, params("beer"));
    const linear32 = integrateNormalized(stretch(samples, 32), pathKm / 32, params("linear"));
    assert.ok(Math.abs(beer32.alpha - beer128.alpha) < 0.02);
    assert.equal(linear32.stepsApplied, 1);
    assert.ok(linear32.alpha > 1);
    assert.ok(beer32.stepsApplied > 1);
  });
});

function stretch(samples: readonly number[], count: number): number[] {
  return Array.from({ length: count }, (_, i) => samples[Math.min(samples.length - 1, Math.floor((i / count) * samples.length))]!);
}
