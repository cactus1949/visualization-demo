/**
 * Colour-scale ends. `display` is the configured display_range (one scale for
 * every time step). `frame` is one frame's own min/max. Callers keep both and
 * pick with the panel / `?colorscale=`.
 */

export type ColorScaleMode = "display" | "frame";

/** `display` only when the value is exactly that; everything else is the per-frame scale. */
export function colorScaleModeOf(value: string | null | undefined): ColorScaleMode {
  return value === "display" ? "display" : "frame";
}

function finiteEnds(range: readonly [number, number] | null | undefined): [number, number] | null {
  if (!range) return null;
  const lo = range[0];
  const hi = range[1];
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null;
  return [lo, hi];
}

/**
 * Ends of the colour bar.
 * `display` uses the configured range, then `fallback`.
 * `frame` uses that frame's min/max, and the configured range until the frame
 * has a finite increasing span (all-zero frames, data not here yet).
 */
export function colorScaleEnds(
  mode: ColorScaleMode,
  display: readonly [number, number] | null | undefined,
  frame: { min: number; max: number } | null | undefined,
  fallback: readonly [number, number],
): [number, number] {
  const configured = finiteEnds(display) ?? finiteEnds(fallback);
  if (mode !== "frame") return configured ?? [0, 1];
  const one = frame ? finiteEnds([frame.min, frame.max]) : null;
  return one ?? configured ?? [0, 1];
}
