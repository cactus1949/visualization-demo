import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BUDGET_LEVELS,
  CLIMB_LOCK_AFTER_DROP_MS,
  CLIMB_WINDOW_MS,
  DROP_LOCK_AFTER_CLIMB_MS,
  DROP_WINDOW_MS,
  FrameBudget,
  VOLUME_REDRAWS_EVERY_FRAME,
  budgetText,
  drawnTrailLength,
  percentile,
  volumeBufferSize,
  windowStats,
} from "./frameBudget.ts";

describe("percentile and window stats", () => {
  it("p95 is the high end of a 100-frame window, and >33.3 ms is the over-target fraction", () => {
    const samples = Array.from({ length: 100 }, (_, i) => ({ ms: i + 1, at: i }));
    assert.equal(percentile(samples.map((s) => s.ms), 0.5), 50);
    assert.equal(percentile(samples.map((s) => s.ms), 0.95), 95);
    assert.equal(percentile(samples.map((s) => s.ms), 0.99), 99);
    const stats = windowStats(samples);
    assert.equal(stats.n, 100);
    assert.equal(stats.overTarget, 0.67);
  });
});

describe("volume buffer and trail draw length", () => {
  it("scales the drawing buffer and never exceeds it", () => {
    assert.deepEqual(volumeBufferSize(1920, 1080, 0.4), { width: 768, height: 432 });
    assert.deepEqual(volumeBufferSize(1920, 1080, 1), { width: 1920, height: 1080 });
    assert.deepEqual(volumeBufferSize(1920, 1080, 4), { width: 1920, height: 1080 });
    assert.deepEqual(volumeBufferSize(3, 3, 0.25), { width: 1, height: 1 });
  });

  it("shortens the drawn trail without exceeding the slider or the ring", () => {
    assert.equal(drawnTrailLength(48, 1, 64), 48);
    assert.equal(drawnTrailLength(48, 2, 64), 24);
    assert.equal(drawnTrailLength(48, 4, 64), 12);
    assert.equal(drawnTrailLength(48, 4, 8), 8);
    assert.equal(drawnTrailLength(3, 4, 64), 2);
  });

  it("the label reports the effective draw, not a rewritten slider", () => {
    assert.equal(budgetText(BUDGET_LEVELS[0]!, 48), "体 30% · 24 步 · 尾迹 12/48 · 阴影关 · 地球 67%");
    assert.equal(budgetText(BUDGET_LEVELS[4]!, 48), "体 100% · 128 步 · 尾迹 48/48 · 阴影 4096 · 地球 100%");
  });
});

describe("frame budget hysteresis", () => {
  const drive = (budget: FrameBudget, start: number, span: number, frameMs: number, step = 100) => {
    for (let at = start; at <= start + span; at += step) budget.noteFrame(frameMs, at);
  };

  it("starts conservative and climbs to full detail when frames stay fast", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    assert.equal(budget.level, 0);
    assert.equal(budget.knobs().volumeSteps, 24);
    assert.equal(budget.knobs().cesiumResolutionScale, 0.67);
    assert.equal(budget.knobs().shadowMapSize, 0);
    drive(budget, 0, CLIMB_WINDOW_MS - 200, 16);
    assert.equal(budget.level, 0);
    drive(budget, CLIMB_WINDOW_MS, 0, 16);
    assert.equal(budget.level, 1);
    let cursor = 20_000;
    for (let level = 1; level < BUDGET_LEVELS.length - 1; level += 1) {
      drive(budget, cursor, CLIMB_WINDOW_MS, 16);
      assert.equal(budget.level, level + 1);
      cursor += 20_000;
    }
    assert.equal(budget.level, BUDGET_LEVELS.length - 1);
    assert.equal(budget.knobs().cesiumMsaa, 4);
    assert.equal(budget.knobs().pixelRatioCap, 2);
    assert.equal(VOLUME_REDRAWS_EVERY_FRAME, true);
  });

  it("drops one level after a slow half-second, then refuses to climb back for five seconds", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    budget.setLevel(3, 0);
    const afterLock = DROP_LOCK_AFTER_CLIMB_MS + 50;
    drive(budget, afterLock, DROP_WINDOW_MS, 50);
    assert.equal(budget.level, 2);
    drive(budget, afterLock + 1_000, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.level, 2);
    const climbAt = afterLock + CLIMB_LOCK_AFTER_DROP_MS + 2_000;
    drive(budget, climbAt, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.level, 3);
  });

  it("a forced volume-on drop records the transition as spikes, not as the steady p95", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    budget.setLevel(4, 0);
    budget.forceConservative(20_000, "volume");
    assert.equal(budget.level, 0);
    budget.noteFrame(800, 20_100);
    budget.noteFrame(400, 20_300);
    assert.equal(budget.stats().n, 0);
    assert.equal(budget.recentSpikes().length, 2);
    assert.equal(budget.recentSpikes()[0]!.kind, "volume");
    assert.equal(budget.level, 0);
  });

  it("does not treat one enormous interval as a reason to leave the top level by itself", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    budget.setLevel(4, 0);
    const t = DROP_LOCK_AFTER_CLIMB_MS + DROP_WINDOW_MS + 10;
    budget.noteFrame(5000, t);
    assert.equal(budget.level, 4);
    assert.equal(budget.stats().n, 1);
  });

  it("counts context loss and restore, and restore lands on the conservative level", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    budget.setLevel(4, 0);
    budget.noteLost(30_000);
    budget.noteRestored(30_100);
    assert.equal(budget.lossCount, 1);
    assert.equal(budget.restoreCount, 1);
    assert.equal(budget.level, 0);
    assert.equal(budget.knobs().shadowMapSize, 0);
    assert.equal(budget.levelHistory.at(-1)?.reason, "context-restored");
  });
});
