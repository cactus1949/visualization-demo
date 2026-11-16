/**
 * Sliding window of frames the page may fetch, decode, and keep.
 * Shared by both export formats; only the caller decides which variables are open.
 */
/** Frames ahead of ⌊t⌋ kept as the buffer. +2 means the window is [⌊t⌋, ⌊t⌋+1, ⌊t⌋+2]. */
export const FETCH_WINDOW_AHEAD = 2;

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
