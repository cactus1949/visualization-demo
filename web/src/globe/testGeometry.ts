/**
 * Geometry of the alignment test layer, in grid coordinates (u, v, AGL metres). Shared by the
 * three.js test layer (placed by the GPU polynomial) and the Cesium reference outline (placed
 * exactly), so both draw the same chords between the same sample points.
 */
export type UvAgl = [number, number, number];

/** Domain edge: bottom ring, top ring and the four vertical corner edges, as line segments. */
export function edgeSegments(topM: number, perEdge = 100, perVertical = 20): UvAgl[][] {
  const ring = (agl: number): UvAgl[] => {
    const pts: UvAgl[] = [];
    for (let i = 0; i <= perEdge; i++) pts.push([i / perEdge, 0, agl]);
    for (let i = 1; i <= perEdge; i++) pts.push([1, i / perEdge, agl]);
    for (let i = perEdge - 1; i >= 0; i--) pts.push([i / perEdge, 1, agl]);
    for (let i = perEdge - 1; i >= 0; i--) pts.push([0, i / perEdge, agl]);
    return pts;
  };
  const verticals = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, v]) =>
    Array.from({ length: perVertical + 1 }, (_, i): UvAgl => [u!, v!, (topM * i) / perVertical]),
  );
  return [ring(0), ring(topM), ...verticals];
}

/** Grid of quads over (s, t) in [0,1]^2 mapped by `at`; returns flat positions and indices. */
export function gridSurface(cols: number, rows: number, at: (s: number, t: number) => UvAgl): { positions: Float32Array; indices: Uint32Array } {
  const positions = new Float32Array((cols + 1) * (rows + 1) * 3);
  let p = 0;
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) positions.set(at(i / cols, j / rows), (p++) * 3);
  const indices = new Uint32Array(cols * rows * 6);
  let q = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const a = j * (cols + 1) + i, b = a + 1, c = a + cols + 1, d = c + 1;
      indices.set([a, b, d, a, d, c], q);
      q += 6;
    }
  }
  return { positions, indices };
}

/** Horizontal test slices (AGL metres) and the vertical curtain that dips below ground. */
export const SLICE_AGL_M = [250, 500, 750];
export const CURTAIN = { v: 0.5, bottomM: -300, topM: 600 };
