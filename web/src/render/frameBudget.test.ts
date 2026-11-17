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
    assert.equal(stats.spanMs, 99);
    assert.ok(Math.abs(stats.mean - 50.5) < 1e-9);
    assert.deepEqual(stats.histogram, { le16: 16, le33: 17, le50: 17, gt50: 50 });
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

  it("starts conservative and raises volume to full before multisampling, then reaches the product ceiling", () => {
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
    let guard = 0;
    while (budget.knobs().volumeSteps < 128 && guard < 8) {
      drive(budget, cursor, CLIMB_WINDOW_MS, 16);
      cursor += 20_000;
      guard += 1;
    }
    assert.equal(budget.knobs().volumeSteps, 128);
    assert.equal(budget.knobs().cesiumMsaa, 1);
    guard = 0;
    while ((budget.knobs().cesiumMsaa < 4 || budget.knobs().pixelRatioCap < 2) && guard < 24) {
      drive(budget, cursor, CLIMB_WINDOW_MS, 16);
      cursor += 20_000;
      guard += 1;
    }
    assert.equal(budget.knobs().cesiumMsaa, 4);
    assert.equal(budget.knobs().pixelRatioCap, 2);
    assert.equal(budget.knobs().shadowMapSize, 4096);
    assert.equal(VOLUME_REDRAWS_EVERY_FRAME, true);
  });

  it("drops pixel ratio before volume steps, and the drop lock lasts five seconds", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    budget.setLevel(3, 0);
    const afterLock = DROP_LOCK_AFTER_CLIMB_MS + 50;
    drive(budget, afterLock, DROP_WINDOW_MS, 50);
    assert.equal(budget.level, 3);
    assert.equal(budget.channels().pixel, 2);
    drive(budget, afterLock + 1_000, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.level, 3);
    assert.equal(budget.channels().pixel, 2);
    const climbAt = afterLock + CLIMB_LOCK_AFTER_DROP_MS + 2_000;
    drive(budget, climbAt, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.knobs().volumeSteps, 128);
    assert.equal(budget.channels().pixel, 2);
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

  it("treats a steady 30 Hz cadence as fast enough to probe, and a sustained 50 ms cadence as not", () => {
    const refresh = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    drive(refresh, 0, CLIMB_WINDOW_MS, 1000 / 30);
    assert.equal(refresh.knobs().volumeSteps, 32);
    const slow = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    drive(slow, 0, CLIMB_WINDOW_MS, 50);
    assert.equal(slow.knobs().volumeSteps, 24);
    assert.equal(slow.report().reason.includes("30"), true);
  });

  it("recovers after the startup suppress once frames stay on the target", () => {
    const budget = new FrameBudget({ now: 0 });
    drive(budget, 0, 400, 16);
    assert.equal(budget.level, 0);
    assert.equal(budget.stats().n, 0);
    drive(budget, 500, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.knobs().volumeSteps, 32);
  });

  it("keeps a short hitch out of the window so it neither drops nor blocks the next climb", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    budget.setLevel(3, 0);
    drive(budget, DROP_LOCK_AFTER_CLIMB_MS + 100, 1_000, 16);
    const before = budget.channels();
    budget.noteFrame(400, DROP_LOCK_AFTER_CLIMB_MS + 2_000);
    assert.equal(budget.recentSpikes().at(-1)?.kind, "hitch");
    assert.equal(budget.stats().p95 <= 34, true);
    assert.deepEqual(budget.channels(), before);
    drive(budget, DROP_LOCK_AFTER_CLIMB_MS + 3_000, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.knobs().volumeSteps, 128);
  });

  it("a camera or layer transition does not throw away a recovered rung", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    budget.setLevel(3, 0);
    budget.noteTransition(2_000, "camera");
    budget.noteFrame(180, 2_100);
    assert.equal(budget.level, 3);
    assert.equal(budget.recentSpikes().at(-1)?.kind, "camera");
    assert.equal(budget.knobs().volumeSteps, 80);
  });

  it("a failed volume probe holds that rung, and a later fast window may still raise a cheaper channel", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    drive(budget, 0, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.knobs().volumeSteps, 32);
    const failedAt = CLIMB_WINDOW_MS + DROP_LOCK_AFTER_CLIMB_MS + 100;
    drive(budget, failedAt, DROP_WINDOW_MS, 50);
    assert.equal(budget.knobs().volumeSteps, 24);
    const report = budget.report(failedAt + DROP_WINDOW_MS);
    assert.equal(report.lastProbe?.decision, "drop");
    assert.equal(report.lastProbe?.channel, "volume");
    const duringHold = failedAt + CLIMB_LOCK_AFTER_DROP_MS + 500;
    drive(budget, duringHold, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.knobs().volumeSteps, 24);
    assert.equal(budget.knobs().trailDivisor, 2);
    assert.ok(budget.report().reason.length > 0);
  });

  it("does not bank volume steps while the layer is off, and caps them when it is turned back on", () => {
    const budget = new FrameBudget({ now: 0, startupSuppressMs: 0 });
    budget.setVolumeWanted(false, 0);
    drive(budget, 0, CLIMB_WINDOW_MS, 16);
    assert.equal(budget.knobs().volumeSteps, 24);
    assert.ok(budget.channels().trail > 0);
    budget.setLevel(4, 10_000);
    budget.setVolumeWanted(false, 11_000);
    budget.setVolumeWanted(true, 12_000);
    assert.equal(budget.knobs().volumeSteps, 32);
    assert.equal(budget.channels().globe, 4);
  });
});
