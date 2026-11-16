import type { Domain } from "../fields";

export interface UnfoldedGrid { values: Float32Array; columns: number; rows: number; distanceKm: number; heightMaxM: number; }

export function sampleUnfolded(
  points: { x: number; z: number }[],
  levelsM: number[],
  domain: Domain,
  sample: (x: number, yKm: number, z: number) => number,
  columns = 96,
): UnfoldedGrid {
  let distance = 0;
  for (let i = 1; i < points.length; i += 1) distance += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
  const values = new Float32Array(columns * levelsM.length);
  for (let c = 0; c < columns; c += 1) {
    const d = distance * (columns === 1 ? 0 : c / (columns - 1));
    let left = 0, acc = 0;
    while (left < points.length - 2 && acc + Math.hypot(points[left + 1].x - points[left].x, points[left + 1].z - points[left].z) < d) {
      acc += Math.hypot(points[left + 1].x - points[left].x, points[left + 1].z - points[left].z); left += 1;
    }
    const seg = Math.max(1e-6, Math.hypot(points[left + 1].x - points[left].x, points[left + 1].z - points[left].z));
    const t = (d - acc) / seg;
    const x = points[left].x + (points[left + 1].x - points[left].x) * t;
    const z = points[left].z + (points[left + 1].z - points[left].z) * t;
    for (let r = 0; r < levelsM.length; r += 1) values[r * columns + c] = sample(x, levelsM[r] / 1000, z);
  }
  return { values, columns, rows: levelsM.length, distanceKm: distance, heightMaxM: Math.max(...levelsM, domain.top * 1000) };
}
