/**
 * Particle colour scales. Pure helpers (no three.js) so the rules can be unit-tested and
 * recomputed when the open encoding changes in place (AtmosViewer reloadFormat).
 */

export type ParticleColorMode = "speed" | "w" | "height" | "single";

export interface ParticleRangeInputs {
  /** manifest derived.speed.display_range of the open encoding, if any */
  speedDisplay: [number, number] | null;
  /** fallback when the manifest has no speed display_range (current frame's CPU speed range) */
  speedFallback: () => [number, number];
  /** manifest variables.w.display_range, if any */
  wDisplay: [number, number] | null;
  /** manifest variables.w all-frame data_min / data_max */
  wData: { data_min: number; data_max: number };
  /**
   * One frame's range. When a component is finite and increasing it replaces
   * the display_range / all-frame scale for that component only. Omit to keep
   * the fixed scale.
   */
  frame?: {
    speed: [number, number] | null;
    /** max(|w_min|, |w_max|) of that frame; the w shader stays symmetric about 0 */
    wAbs: number | null;
  } | null;
}

export interface ParticleRanges {
  speedRange: [number, number];
  wRange: number;
}

function increasing(lo: number, hi: number): [number, number] | null {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return null;
  return [lo, hi];
}

/** Colour ranges for speed / w particle colouring, from the open encoding's manifest. */
export function particleRanges(inputs: ParticleRangeInputs): ParticleRanges {
  const frameSpeed = inputs.frame?.speed;
  const speedFromFrame = frameSpeed ? increasing(frameSpeed[0], frameSpeed[1]) : null;
  const speedRange: [number, number] = speedFromFrame
    ?? (inputs.speedDisplay
      ? [inputs.speedDisplay[0], inputs.speedDisplay[1]]
      : inputs.speedFallback());
  const wAbs = Math.max(Math.abs(inputs.wData.data_min), Math.abs(inputs.wData.data_max));
  const wFromDisplay = inputs.wDisplay
    ? Math.max(Math.abs(inputs.wDisplay[0]), Math.abs(inputs.wDisplay[1]))
    : Math.max(0.05, wAbs * 0.6);
  const wFrame = inputs.frame?.wAbs;
  const wRange = wFrame !== undefined && wFrame !== null && Number.isFinite(wFrame) && wFrame > 0
    ? wFrame
    : wFromDisplay;
  return { speedRange, wRange };
}

/**
 * Value of the trail shader's uColorRange for a colour mode: speed → (maxSpeed, lo, hi),
 * w → (wRange, 0, 0). null for modes that do not read it (the uniform is left as is).
 */
export function colorRangeUniform(
  mode: ParticleColorMode,
  binding: { maxSpeed: number; speedRange: [number, number]; wRange: number },
): [number, number, number] | null {
  if (mode === "speed") return [binding.maxSpeed, binding.speedRange[0], binding.speedRange[1]];
  if (mode === "w") return [binding.wRange, 0, 0];
  return null;
}
