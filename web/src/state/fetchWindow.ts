/**
 * Sliding window of frames the page may fetch, decode, and keep.
 * Shared by both export formats; only the caller decides which variables are open.
 */
/** Frames ahead of ⌊t⌋ kept as the buffer. +1 means the window is [⌊t⌋, ⌊t⌋+1]. */
export const FETCH_WINDOW_AHEAD = 1;

export function windowFrames(
  t: number,
  frameCount: number,
  opts: { ahead?: number; loop?: boolean } = {},
): number[] {
  const ahead = opts.ahead ?? FETCH_WINDOW_AHEAD;
  if (frameCount <= 0) return [];
  const last = frameCount - 1;
  const a = Math.min(Math.max(Math.floor(t + 1e-6), 0), last);
  const out: number[] = [];
  for (let k = 0; k <= ahead; k += 1) {
    let f = a + k;
    if (f > last) f = opts.loop && frameCount > 1 ? f % frameCount : last;
    if (!out.includes(f)) out.push(f);
  }
  return out;
}

export function payloadKey(name: string, frame: number): string {
  return `${name}@${frame}`;
}

export function frameOfKey(key: string): number {
  return Number(key.slice(key.lastIndexOf("@") + 1));
}

/** Encoded-byte keys (name@frame) that belong to a set of frames. */
export function keysOnFrames(keys: Iterable<string>, frames: Iterable<number>): string[] {
  const want = new Set(frames);
  return [...keys].filter((k) => want.has(frameOfKey(k)));
}

/** Cached or in-flight keys whose frame has left the window and must be released or cancelled. */
export function keysOutsideFrames(keys: Iterable<string>, frames: Iterable<number>): string[] {
  const want = new Set(frames);
  return [...keys].filter((k) => !want.has(frameOfKey(k)));
}
