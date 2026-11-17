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
/**
 * Climb when the steady p95 still meets the 30 fps target. 26 ms was stricter than the
 * target, so a device already holding ~30 fps never left the middle rung.
 * 34 ms still accepts a 30 Hz vsync (intervals sit on 33.3 ms) and rejects a 40 ms run.
 */
export const CLIMB_P95_MS = 34;
export const DROP_P95_MS = 36;
export const CLIMB_WINDOW_MS = 2000;
export const DROP_WINDOW_MS = 500;
export const CLIMB_LOCK_AFTER_DROP_MS = 5000;
export const DROP_LOCK_AFTER_CLIMB_MS = 1000;
export const TRANSITION_SUPPRESS_MS = 500;
/** After a step up fails, that channel is not probed again until this elapses. */
export const PROBE_RETRY_MS = 8000;
const SPIKE_FLOOR_MS = 80;
const HISTORY_MS = 4000;

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
  /** Volume-channel index after the change. Decorative channels are in `reason`. */
  level: number;
  reason: string;
}

export const BUDGET_CHANNELS = ["volume", "trail", "globe", "shadow", "pixel"] as const;
export type BudgetChannel = (typeof BUDGET_CHANNELS)[number];

/** Volume detail first. A globe or shadow stall must not be the reason the volume stays coarse. */
const CLIMB_ORDER: readonly BudgetChannel[] = ["volume", "trail", "globe", "shadow", "pixel"];
/** Shed the extra passes first when a higher rung misses the frame target. */
const DROP_ORDER: readonly BudgetChannel[] = ["pixel", "shadow", "globe", "trail", "volume"];

const TOP = BUDGET_LEVELS.length - 1;

export interface BudgetReport {
  /** Volume-channel index. This is the number the quality label's step count follows. */
  level: number;
  channels: Record<BudgetChannel, number>;
  /** Channel that may not rise again until `holdUntil`. */
  held: BudgetChannel | null;
  holdUntil: number;
  suppressKind: string;
  suppressRemainingMs: number;
  window: FrameWindowStats;
  /** Why the last evaluation did not raise quality, or the step it took. */
  reason: string;
  lastProbe: { at: number; channel: BudgetChannel; decision: "climb" | "drop" | "hold"; p95: number; reason: string } | null;
}

export class FrameBudget {
  lossCount = 0;
  restoreCount = 0;
  readonly levelHistory: LevelChange[] = [];
  private readonly channel: Record<BudgetChannel, number> = { volume: 0, trail: 0, globe: 0, shadow: 0, pixel: 0 };
  private readonly cap: Record<BudgetChannel, number> = { volume: TOP, trail: TOP, globe: TOP, shadow: TOP, pixel: TOP };
  private readonly capUntil: Record<BudgetChannel, number> = { volume: 0, trail: 0, globe: 0, shadow: 0, pixel: 0 };
  private steady: FrameSample[] = [];
  private spikes: FrameSpike[] = [];
  private suppressUntil = 0;
  private suppressKind = "startup";
  private lastDownAt = Number.NEGATIVE_INFINITY;
  private lastUpAt = Number.NEGATIVE_INFINITY;
  private dirty = true;
  private pending: BudgetChannel | null = null;
  private volumeWanted = true;
  private lastNow = 0;
  private holdText = "尚无采样";
  private lastProbe: BudgetReport["lastProbe"] = null;

  constructor(options: { now?: number; startupSuppressMs?: number } = {}) {
    const now = options.now ?? 0;
    const suppress = options.startupSuppressMs ?? TRANSITION_SUPPRESS_MS;
    this.suppressUntil = now + suppress;
    this.lastNow = now;
  }

  /** Volume rung. Screenshot hooks still read this as the quality step. */
  get level(): number {
    return this.channel.volume;
  }

  channels(): Record<BudgetChannel, number> {
    return { ...this.channel };
  }

  knobs(): BudgetKnobs {
    const volume = BUDGET_LEVELS[this.channel.volume]!;
    const trail = BUDGET_LEVELS[this.channel.trail]!;
    const globe = BUDGET_LEVELS[this.channel.globe]!;
    const shadow = BUDGET_LEVELS[this.channel.shadow]!;
    const pixel = BUDGET_LEVELS[this.channel.pixel]!;
    return {
      volumeScale: volume.volumeScale,
      volumeSteps: volume.volumeSteps,
      trailDivisor: trail.trailDivisor,
      shadowMapSize: shadow.shadowMapSize,
      cesiumMsaa: globe.cesiumMsaa,
      cesiumScreenSpaceError: globe.cesiumScreenSpaceError,
      cesiumResolutionScale: globe.cesiumResolutionScale,
      pixelRatioCap: pixel.pixelRatioCap,
    };
  }

  /** True once after a rung changes, so callers can skip redundant GPU reallocations. */
  consumeChange(): boolean {
    const changed = this.dirty;
    this.dirty = false;
    return changed;
  }

  /**
   * The volume rung is not raised while the layer is off (that used to bank a full-cost
   * volume and apply it the moment the checkbox came on). Turning it on caps a banked
   * rung at 1 and lets the probe climb again.
   */
  setVolumeWanted(on: boolean, now: number): void {
    if (on === this.volumeWanted) return;
    const becameOn = on && !this.volumeWanted;
    this.volumeWanted = on;
    if (!becameOn) return;
    this.noteTransition(now, "volume");
    if (this.channel.volume > 1) {
      this.channel.volume = 1;
      this.pending = null;
      this.dirty = true;
      this.steady = [];
      this.remember(now, "volume-on");
    }
  }

  /**
   * Context loss only. Camera moves and layer toggles must not wipe a recovered quality.
   * The following half-second is recorded as spikes, not as the steady percentile.
   */
  forceConservative(now: number, kind: string): void {
    const wasUp = BUDGET_CHANNELS.some((name) => this.channel[name] !== 0);
    for (const name of BUDGET_CHANNELS) {
      this.channel[name] = 0;
      this.cap[name] = TOP;
      this.capUntil[name] = 0;
    }
    this.pending = null;
    if (wasUp) this.lastDownAt = now;
    this.dirty = true;
    this.steady = [];
    this.suppressUntil = now + TRANSITION_SUPPRESS_MS;
    this.suppressKind = kind;
    this.remember(now, kind);
    this.noteProbe(now, "volume", "drop", 0, kind);
  }

  /** Keeps the current rungs. The next half-second does not enter the percentile. */
  noteTransition(now: number, kind: string): void {
    this.suppressUntil = Math.max(this.suppressUntil, now + TRANSITION_SUPPRESS_MS);
    this.suppressKind = kind;
  }

  /** Test and screenshot hook. Sets every channel to the same rung. */
  setLevel(level: number, now: number): void {
    const next = Math.max(0, Math.min(TOP, Math.round(level)));
    if (next < this.channel.volume) this.lastDownAt = now;
    if (next > this.channel.volume) this.lastUpAt = now;
    for (const name of BUDGET_CHANNELS) {
      this.channel[name] = next;
      this.cap[name] = TOP;
      this.capUntil[name] = 0;
    }
    this.pending = null;
    this.dirty = true;
    this.steady = [];
    this.suppressUntil = now + TRANSITION_SUPPRESS_MS;
    this.suppressKind = "manual";
    this.remember(now, "manual");
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
   * `frameMs` is the callback interval that just ended, not a displayed frame rate.
   * Returns whether a rung changed. Transition frames and isolated hitches stay out of the window.
   */
  noteFrame(frameMs: number, now: number): boolean {
    const before = this.signature();
    this.lastNow = now;
    if (!(frameMs >= 0) || frameMs > 10_000) return false;
    if (now < this.suppressUntil) {
      this.pushSpike(frameMs, now, this.suppressKind);
      return false;
    }
    if (this.isolatedSpike(frameMs)) {
      this.pushSpike(frameMs, now, "hitch");
      return false;
    }
    this.steady.push({ ms: frameMs, at: now });
    const cutoff = now - HISTORY_MS;
    if (this.steady.length > 240 || this.steady[0]!.at < cutoff) {
      this.steady = this.steady.filter((sample) => sample.at >= cutoff);
    }
    this.evaluate(now);
    return this.signature() !== before;
  }

  stats(): FrameWindowStats {
    return windowStats(this.steady);
  }

  recentSpikes(): readonly FrameSpike[] {
    return this.spikes;
  }

  report(now = this.lastNow): BudgetReport {
    const held = this.heldChannel(now);
    return {
      level: this.channel.volume,
      channels: this.channels(),
      held,
      holdUntil: held ? this.capUntil[held] : 0,
      suppressKind: now < this.suppressUntil ? this.suppressKind : "",
      suppressRemainingMs: Math.max(0, this.suppressUntil - now),
      window: this.stats(),
      reason: this.holdText,
      lastProbe: this.lastProbe,
    };
  }

  private signature(): string {
    return BUDGET_CHANNELS.map((name) => this.channel[name]).join(",");
  }

  private heldChannel(now: number): BudgetChannel | null {
    for (const name of CLIMB_ORDER) {
      if (now < this.capUntil[name] && this.channel[name] >= this.cap[name] && this.channel[name] < TOP) return name;
    }
    return null;
  }

  private pushSpike(ms: number, now: number, kind: string): void {
    this.spikes.push({ ms, at: now, kind });
    if (this.spikes.length > 32) this.spikes.shift();
  }

  /** One long frame beside a steady median is a hitch, not a reason to drop or to refuse a climb. */
  private isolatedSpike(ms: number): boolean {
    if (this.steady.length < 8) return false;
    const recent = this.steady.slice(-12).map((sample) => sample.ms).sort((a, b) => a - b);
    const median = recent[recent.length >> 1]!;
    return ms > Math.max(SPIKE_FLOOR_MS, median * 3);
  }

  private evaluate(now: number): void {
    for (const name of BUDGET_CHANNELS) {
      if (now >= this.capUntil[name]) this.cap[name] = TOP;
    }
    const dropSamples = this.steady.filter((sample) => sample.at >= now - DROP_WINDOW_MS);
    const dropStats = windowStats(dropSamples);
    if (
      this.pending &&
      dropSamples.length >= 4 &&
      now - this.lastUpAt >= DROP_LOCK_AFTER_CLIMB_MS &&
      dropStats.p95 <= CLIMB_P95_MS
    ) {
      this.pending = null;
    }
    if (
      dropSamples.length >= 4 &&
      now - this.lastUpAt >= DROP_LOCK_AFTER_CLIMB_MS &&
      dropStats.p95 > DROP_P95_MS &&
      this.dropOne(now, dropStats.p95)
    ) {
      return;
    }
    const climbSamples = this.steady.filter((sample) => sample.at >= now - CLIMB_WINDOW_MS);
    const oldest = climbSamples[0]?.at ?? now;
    const climbStats = windowStats(climbSamples);
    const span = climbSamples.length >= 2 ? now - oldest : 0;
    if (
      climbSamples.length >= 12 &&
      span >= CLIMB_WINDOW_MS &&
      now - this.lastDownAt >= CLIMB_LOCK_AFTER_DROP_MS &&
      climbStats.p95 <= CLIMB_P95_MS
    ) {
      const name = this.nextClimb(now);
      if (!name) {
        this.noteProbe(now, "volume", "hold", climbStats.p95, "已在当前允许的最高质量");
        return;
      }
      this.channel[name] += 1;
      this.pending = name;
      this.lastUpAt = now;
      this.dirty = true;
      this.steady = [];
      this.remember(now, `fast:${name}`);
      this.noteProbe(now, name, "climb", climbStats.p95, `升 ${name}`);
      return;
    }
    this.holdText = this.holdReason(now, climbSamples.length, span, climbStats.p95);
  }

  private holdReason(now: number, n: number, span: number, p95: number): string {
    if (now < this.suppressUntil) return `抑制中（${this.suppressKind}）`;
    if (now - this.lastDownAt < CLIMB_LOCK_AFTER_DROP_MS) return "降档滞回";
    const held = this.heldChannel(now);
    if (held && this.nextClimb(now) === null) return `${held} 探测失败，暂不回升`;
    if (n < 12 || span < CLIMB_WINDOW_MS) return `采样窗口未满 ${Math.round(span)}/${CLIMB_WINDOW_MS} ms，n=${n}`;
    if (p95 > CLIMB_P95_MS) return `p95 ${p95.toFixed(1)} ms 高于 30 帧目标`;
    return "稳态";
  }

  private nextClimb(now: number): BudgetChannel | null {
    for (const name of CLIMB_ORDER) {
      if (name === "volume" && !this.volumeWanted) continue;
      if (this.channel[name] >= TOP) continue;
      if (now < this.capUntil[name] && this.channel[name] >= this.cap[name]) continue;
      return name;
    }
    return null;
  }

  /** @returns whether a channel actually moved. */
  private dropOne(now: number, p95: number): boolean {
    const name = (this.pending && this.channel[this.pending] > 0 ? this.pending : null) ?? DROP_ORDER.find((candidate) => this.channel[candidate] > 0);
    if (!name) return false;
    this.channel[name] -= 1;
    if (this.pending === name) {
      this.cap[name] = this.channel[name];
      this.capUntil[name] = now + PROBE_RETRY_MS;
    }
    this.pending = null;
    this.lastDownAt = now;
    this.dirty = true;
    this.steady = [];
    this.remember(now, `slow:${name}`);
    this.noteProbe(now, name, "drop", p95, `降 ${name}`);
    return true;
  }

  private remember(at: number, reason: string): void {
    this.levelHistory.push({ at, level: this.channel.volume, reason });
    if (this.levelHistory.length > 40) this.levelHistory.shift();
  }

  private noteProbe(at: number, channel: BudgetChannel, decision: "climb" | "drop" | "hold", p95: number, reason: string): void {
    this.holdText = reason;
    this.lastProbe = { at, channel, decision, p95, reason };
  }
}
