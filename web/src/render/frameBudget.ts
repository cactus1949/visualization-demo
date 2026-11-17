/**
 * Automatic frame budget. Levels are a display ladder only: sliders, colour scales and layer
 * toggles stay under user control. Steady frame times move one level at a time with a lockout
 * so a strong GPU can climb back to the full product settings.
 *
 * Transition frames (startup, opening the volume, a camera jump, context restore) are kept out
 * of the percentile window. A long CPU interval is not treated as a GPU timeout.
 */

export interface BudgetKnobs {
  /** Fraction of the drawing buffer each axis. 1 renders the volume at full resolution. */
  volumeScale: number;
  volumeSteps: number;
  /** 1 draws the user's whole trail; 2 draws half the segments. Does not change the slider. */
  trailDivisor: number;
  shadowMapSize: number;
  cesiumMsaa: number;
  cesiumScreenSpaceError: number;
  /**
   * Cesium canvas scale (1 = CSS pixels). The box host ignores this.
   * The previous budget never changed it, so a moving globe stayed at full resolution.
   */
  cesiumResolutionScale: number;
  /** Box host uses min(devicePixelRatio, pixelRatioCap). 2 is the previous product cap. */
  pixelRatioCap: number;
}

/** Product defaults sit at the top. Index 0 is the conservative start. */
export const BUDGET_LEVELS: readonly BudgetKnobs[] = [
  // Floor: globe canvas itself shrinks, the shadow pass is not drawn, volume stays coarse.
  { volumeScale: 0.3, volumeSteps: 24, trailDivisor: 4, shadowMapSize: 0, cesiumMsaa: 1, cesiumScreenSpaceError: 8, cesiumResolutionScale: 0.67, pixelRatioCap: 1 },
  { volumeScale: 0.45, volumeSteps: 32, trailDivisor: 2, shadowMapSize: 1024, cesiumMsaa: 1, cesiumScreenSpaceError: 4, cesiumResolutionScale: 0.8, pixelRatioCap: 1 },
  { volumeScale: 0.7, volumeSteps: 48, trailDivisor: 2, shadowMapSize: 1024, cesiumMsaa: 1, cesiumScreenSpaceError: 2, cesiumResolutionScale: 1, pixelRatioCap: 1 },
  { volumeScale: 1, volumeSteps: 80, trailDivisor: 1, shadowMapSize: 2048, cesiumMsaa: 2, cesiumScreenSpaceError: 2, cesiumResolutionScale: 1, pixelRatioCap: 1 },
  { volumeScale: 1, volumeSteps: 128, trailDivisor: 1, shadowMapSize: 4096, cesiumMsaa: 4, cesiumScreenSpaceError: 2, cesiumResolutionScale: 1, pixelRatioCap: 2 },
];

export const FRAME_BUDGET_TARGET_MS = 1000 / 30;
export const CLIMB_P95_MS = 26;
export const DROP_P95_MS = 36;
export const CLIMB_WINDOW_MS = 3000;
export const DROP_WINDOW_MS = 500;
export const CLIMB_LOCK_AFTER_DROP_MS = 5000;
export const DROP_LOCK_AFTER_CLIMB_MS = 1000;
export const TRANSITION_SUPPRESS_MS = 500;

/** The volume image is redrawn from the current camera every frame. There is no stale-frame reuse. */
export const VOLUME_REDRAWS_EVERY_FRAME = true;

export interface FrameSample {
  ms: number;
  at: number;
}

export interface FrameSpike extends FrameSample {
  kind: string;
}

export interface FrameWindowStats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  /** Mean interval in the window, ms. */
  mean: number;
  /** Last sample time minus first, ms. */
  spanMs: number;
  /** Callbacks per second of this window. Not a displayed frame rate. */
  callbackHz: number;
  /** Counts of intervals in (0, 16.7], (16.7, 33.3], (33.3, 50], (50, ∞). */
  histogram: { le16: number; le33: number; le50: number; gt50: number };
  /** Fraction of samples strictly slower than 33.3 ms. */
  overTarget: number;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index]!;
}

export function windowStats(samples: readonly FrameSample[], targetMs = FRAME_BUDGET_TARGET_MS): FrameWindowStats {
  const values = samples.map((s) => s.ms);
  const over = values.filter((ms) => ms > targetMs).length;
  const mean = values.length === 0 ? 0 : values.reduce((sum, ms) => sum + ms, 0) / values.length;
  const spanMs = samples.length >= 2 ? samples[samples.length - 1]!.at - samples[0]!.at : 0;
  const histogram = { le16: 0, le33: 0, le50: 0, gt50: 0 };
  for (const ms of values) {
    if (ms <= 16.7) histogram.le16 += 1;
    else if (ms <= 33.3) histogram.le33 += 1;
    else if (ms <= 50) histogram.le50 += 1;
    else histogram.gt50 += 1;
  }
  return {
    n: values.length,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    mean,
    spanMs,
    callbackHz: spanMs > 0 ? ((values.length - 1) * 1000) / spanMs : 0,
    histogram,
    overTarget: values.length === 0 ? 0 : over / values.length,
  };
}

/** Trail segments actually drawn. Never exceeds the user's slider or the ring length. */
export function drawnTrailLength(userTrail: number, divisor: number, ringLayers: number): number {
  const requested = Math.max(2, Math.round(userTrail));
  const divided = Math.max(2, Math.floor(requested / Math.max(1, Math.round(divisor))));
  return Math.max(2, Math.min(requested, divided, Math.max(2, ringLayers)));
}

/** Low-resolution volume buffer. Never larger than the drawing buffer, never zero. */
export function volumeBufferSize(drawingWidth: number, drawingHeight: number, scale: number): { width: number; height: number } {
  const safeW = Math.max(1, Math.round(drawingWidth));
  const safeH = Math.max(1, Math.round(drawingHeight));
  const clamped = Math.min(1, Math.max(0.25, scale));
  return {
    width: Math.max(1, Math.min(safeW, Math.round(safeW * clamped))),
    height: Math.max(1, Math.min(safeH, Math.round(safeH * clamped))),
  };
}

export function budgetText(knobs: BudgetKnobs, userTrail: number): string {
  const drawn = drawnTrailLength(userTrail, knobs.trailDivisor, 64);
  const pct = Math.round(knobs.volumeScale * 100);
  const globe = Math.round(knobs.cesiumResolutionScale * 100);
  const shadow = knobs.shadowMapSize <= 0 ? "阴影关" : `阴影 ${knobs.shadowMapSize}`;
  return `体 ${pct}% · ${knobs.volumeSteps} 步 · 尾迹 ${drawn}/${Math.round(userTrail)} · ${shadow} · 地球 ${globe}%`;
}

export interface LevelChange {
  at: number;
  level: number;
  reason: string;
}

export class FrameBudget {
  level = 0;
  lossCount = 0;
  restoreCount = 0;
  readonly levelHistory: LevelChange[] = [];
  private steady: FrameSample[] = [];
  private spikes: FrameSpike[] = [];
  private suppressUntil = 0;
  private suppressKind = "startup";
  private lastDownAt = Number.NEGATIVE_INFINITY;
  private lastUpAt = Number.NEGATIVE_INFINITY;
  private dirty = true;

  constructor(options: { now?: number; startupSuppressMs?: number } = {}) {
    const now = options.now ?? 0;
    const suppress = options.startupSuppressMs ?? TRANSITION_SUPPRESS_MS;
    this.suppressUntil = now + suppress;
  }

  knobs(): BudgetKnobs {
    return BUDGET_LEVELS[this.level]!;
  }

  /** True once after the level changes, so callers can skip redundant GPU reallocations. */
  consumeChange(): boolean {
    const changed = this.dirty;
    this.dirty = false;
    return changed;
  }

  /**
   * Drop to the conservative level before a known-heavy frame (volume on, camera jump, restore).
   * The following half-second is recorded as spikes, not as the steady percentile.
   */
  forceConservative(now: number, kind: string): void {
    if (this.level !== 0) this.lastDownAt = now;
    this.level = 0;
    this.dirty = true;
    this.steady = [];
    this.suppressUntil = now + TRANSITION_SUPPRESS_MS;
    this.suppressKind = kind;
    this.remember(now, 0, kind);
  }

  /** Test and screenshot hook. Still suppresses the transition so one slow frame cannot undo it. */
  setLevel(level: number, now: number): void {
    const next = Math.max(0, Math.min(BUDGET_LEVELS.length - 1, Math.round(level)));
    if (next < this.level) this.lastDownAt = now;
    if (next > this.level) this.lastUpAt = now;
    this.level = next;
    this.dirty = true;
    this.steady = [];
    this.suppressUntil = now + TRANSITION_SUPPRESS_MS;
    this.suppressKind = "manual";
    this.remember(now, next, "manual");
  }

  noteLost(now: number): void {
    this.lossCount += 1;
    this.forceConservative(now, "context-lost");
  }

  noteRestored(now: number): void {
    this.restoreCount += 1;
    this.forceConservative(now, "context-restored");
  }

  /**
   * `frameMs` is the rAF interval that just ended. Returns whether the level changed.
   * Intervals during a transition are stored as spikes and do not move the level.
   */
  noteFrame(frameMs: number, now: number): boolean {
    const before = this.level;
    if (!(frameMs >= 0) || frameMs > 10_000) return false;
    if (now < this.suppressUntil) {
      this.spikes.push({ ms: frameMs, at: now, kind: this.suppressKind });
      if (this.spikes.length > 32) this.spikes.shift();
      return this.level !== before;
    }
    this.steady.push({ ms: frameMs, at: now });
    const cutoff = now - 4000;
    if (this.steady.length > 240 || this.steady[0]!.at < cutoff) {
      this.steady = this.steady.filter((sample) => sample.at >= cutoff);
    }
    this.evaluate(now);
    return this.level !== before;
  }

  stats(): FrameWindowStats {
    return windowStats(this.steady);
  }

  recentSpikes(): readonly FrameSpike[] {
    return this.spikes;
  }

  private evaluate(now: number): void {
    const dropSamples = this.steady.filter((sample) => sample.at >= now - DROP_WINDOW_MS);
    if (
      this.level > 0 &&
      dropSamples.length >= 4 &&
      now - this.lastUpAt >= DROP_LOCK_AFTER_CLIMB_MS &&
      windowStats(dropSamples).p95 > DROP_P95_MS
    ) {
      this.level -= 1;
      this.lastDownAt = now;
      this.dirty = true;
      this.steady = [];
      this.remember(now, this.level, "slow");
      return;
    }
    const climbSamples = this.steady.filter((sample) => sample.at >= now - CLIMB_WINDOW_MS);
    const oldest = climbSamples[0]?.at ?? now;
    if (
      this.level < BUDGET_LEVELS.length - 1 &&
      climbSamples.length >= 20 &&
      now - oldest >= CLIMB_WINDOW_MS &&
      now - this.lastDownAt >= CLIMB_LOCK_AFTER_DROP_MS &&
      windowStats(climbSamples).p95 < CLIMB_P95_MS
    ) {
      this.level += 1;
      this.lastUpAt = now;
      this.dirty = true;
      this.steady = [];
      this.remember(now, this.level, "fast");
    }
  }

  private remember(at: number, level: number, reason: string): void {
    this.levelHistory.push({ at, level, reason });
    if (this.levelHistory.length > 40) this.levelHistory.shift();
  }
}
