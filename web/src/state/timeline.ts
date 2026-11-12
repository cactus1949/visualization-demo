/**
 * Global time state (see docs/state-model.md「时间轴」). Orthogonal to the volume / section /
 * ground styles and to the draw/view interaction state: nothing here changes them, and
 * they never change the timeline.
 */
import { reactive } from "vue";
import type { TimeEntry } from "../data/manifest";

/** 1× = one hour of data in 4 s of screen time. */
export const SECONDS_PER_HOUR = 4;
export const RATES = [0.5, 1, 2, 4] as const;
/** pause on the last frame before looping, in hours of data (so 2 s at 1×) */
export const END_HOLD_H = 0.5;

export interface TimelineState {
  frames: number;
  /** continuous time index, 0 .. frames-1; integers are the original time steps */
  t: number;
  playing: boolean;
  rate: number;
  /** frame blending on; off = switch on the hour */
  smooth: boolean;
  loop: boolean;
  /** encoded bytes for this frame are in the worker cache (wind + layers in use) */
  ready: boolean[];
  /** playback is waiting at an integer for the next frame's GPU slots */
  buffering: boolean;
  /** user is dragging the progress bar */
  scrubbing: boolean;
  times: TimeEntry[];
}

export function createTimeline(): TimelineState {
  return reactive({
    frames: 1,
    t: 0,
    playing: false,
    rate: 1,
    smooth: true,
    loop: true,
    ready: [],
    buffering: false,
    scrubbing: false,
    times: [],
  }) as TimelineState;
}

/** Frames bracketing t and the blend weight actually used for display. */
export function bracket(tl: TimelineState): { a: number; b: number; s: number } {
  const last = Math.max(0, tl.frames - 1);
  const t = Math.min(Math.max(tl.t, 0), last);
  const a = Math.min(Math.floor(t + 1e-6), last);
  const b = Math.min(a + 1, last);
  const s = tl.smooth && b !== a ? Math.max(0, t - a) : 0;
  return { a, b, s: s < 1e-4 ? 0 : s > 1 - 1e-4 ? 1 : s };
}

/** Next frame the player will need after `b` (wraps when looping). */
export function prefetchFrame(tl: TimelineState, b: number): number {
  if (tl.frames <= 1) return 0;
  if (b + 1 < tl.frames) return b + 1;
  return tl.loop ? 0 : b;
}

let holdLeft = 0;

/**
 * Advance playback by `dt` seconds of screen time. `canShow(a, b)` says whether frames a and b
 * are resident on the GPU; if the next interval is not, playback waits on the hour (buffering).
 */
export function advance(tl: TimelineState, dt: number, canShow: (a: number, b: number) => boolean): void {
  if (!tl.playing || tl.scrubbing || tl.frames <= 1) {
    tl.buffering = false;
    return;
  }
  const last = tl.frames - 1;
  if (tl.t >= last - 1e-9) {
    if (!tl.loop) {
      tl.playing = false;
      return;
    }
    holdLeft -= (dt * tl.rate) / SECONDS_PER_HOUR;
    if (holdLeft > 0) return;
    if (!canShow(0, 0)) {
      tl.buffering = true;
      return;
    }
    tl.buffering = false;
    tl.t = 0;
    return;
  }
  let next = tl.t + (dt * tl.rate) / SECONDS_PER_HOUR;
  const a = Math.floor(tl.t + 1e-6);
  if (next >= a + 1) {
    // crossing the hour: land exactly on it once, so the original frame is shown
    next = Math.min(a + 1, last);
  }
  const na = Math.min(Math.floor(next + 1e-6), last);
  const nb = Math.min(na + 1, last);
  const needB = next - na > 1e-6;
  if (!canShow(na, needB ? nb : na)) {
    tl.buffering = true;
    tl.t = Math.min(tl.t, na);
    if (!canShow(na, na)) tl.t = Math.min(tl.t, a);
    return;
  }
  tl.buffering = false;
  tl.t = next;
  if (tl.t >= last - 1e-9) {
    tl.t = last;
    holdLeft = END_HOLD_H;
  }
}

/** Snap to the neighbouring integer and pause (prev / next buttons, ← / →). */
export function stepFrame(tl: TimelineState, dir: 1 | -1): void {
  tl.playing = false;
  const last = tl.frames - 1;
  const base = dir > 0 ? Math.floor(tl.t + 1e-6) + 1 : Math.ceil(tl.t - 1e-6) - 1;
  tl.t = tl.loop ? ((base % tl.frames) + tl.frames) % tl.frames : Math.min(Math.max(base, 0), last);
}

export function setTime(tl: TimelineState, t: number): void {
  const last = Math.max(0, tl.frames - 1);
  tl.t = Math.min(Math.max(Number(t) || 0, 0), last);
}

/** Literal clock of continuous t ("2026-11-11 02:30"); no time zone is added. */
export function clockOf(tl: TimelineState, t = tl.t): { date: string; time: string } {
  const times = tl.times;
  if (!times.length || !times[0]!.valid_time) return { date: "", time: "" };
  const a = Math.min(Math.floor(t + 1e-6), times.length - 1);
  const b = Math.min(a + 1, times.length - 1);
  const s = t - a;
  const pa = parseLiteral(times[a]!.valid_time);
  const pb = parseLiteral(times[b]!.valid_time);
  if (!pa) return { date: "", time: times[a]!.valid_time };
  const ms = pb ? pa + (pb - pa) * s : pa;
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
  };
}

/** Parse "YYYY-MM-DDTHH:MM:SS" as a literal clock (treated as UTC internally only to avoid DST shifts). */
function parseLiteral(text: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (!m) return null;
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
}
