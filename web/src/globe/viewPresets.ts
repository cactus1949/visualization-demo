/**
 * Globe tab camera presets: Cesium lookAt(target, HeadingPitchRange). Pure data + geometry so the
 * presets can be checked in unit tests (GlobeViewer.vue only turns them into a Cesium lookAt).
 */

/** [u, v, heading°, pitch°, range m]; (u, v) is the lookAt target on the grid (0..1), at 0 m. */
export type ViewPreset = [number, number, number, number, number];

export const VIEWS: Record<string, ViewPreset> = {
  overview: [0.5, 0.5, 20, -35, 32000],
  // target inside the data (u = v = 0.3), seen from the south-west: the camera ends up above the
  // domain (u, v ≈ 0.14) at ~1.9 km, so the near field below the screen centre is inside the data.
  // Independent of k: at k = 1–3 the camera stays above every building (max 415 m × 3).
  corner: [0.3, 0.3, 45, -25, 4500],
  top: [0.5, 0.5, 0, -89.9, 30000],
  curtain: [0.5, 0.5, 0, -12, 6000],
  low: [0.5, 0.15, 0, -8, 9000],
  edge: [1, 0.5, 270, -4, 4000],
};

/**
 * Where lookAt puts the camera, flat-earth approximation in grid units: the camera sits `range`
 * from the target, behind the view direction (heading clockwise from north, pitch < 0 looks down).
 * `sizeM` = grid extent east / north in metres. Returns grid (u, v) and height in metres.
 */
export function presetCamera(p: ViewPreset, sizeM: [number, number]): { u: number; v: number; heightM: number } {
  const [u, v, hd, pt, range] = p;
  const h = (hd * Math.PI) / 180, t = (pt * Math.PI) / 180;
  const horizontal = range * Math.cos(t);
  return {
    u: u - (horizontal * Math.sin(h)) / sizeM[0],
    v: v - (horizontal * Math.cos(h)) / sizeM[1],
    heightM: -range * Math.sin(t),
  };
}
