import * as THREE from "three";
import type { Domain } from "./fields";

export interface CutState {
  x: [number, number];
  y: [number, number];
  z: [number, number];
  faces: boolean;
}

export const DEFAULT_CUTS: CutState = {
  x: [0, 1],
  y: [0, 1],
  z: [0, 1],
  faces: true,
};

export interface CutBounds {
  lo: THREE.Vector3;
  hi: THREE.Vector3;
}

export function cutBounds(domain: Domain, cuts: CutState): CutBounds {
  const x0 = Math.min(cuts.x[0], cuts.x[1]);
  const x1 = Math.max(cuts.x[0], cuts.x[1]);
  const y0 = Math.min(cuts.y[0], cuts.y[1]);
  const y1 = Math.max(cuts.y[0], cuts.y[1]);
  const z0 = Math.min(cuts.z[0], cuts.z[1]);
  const z1 = Math.max(cuts.z[0], cuts.z[1]);
  return {
    lo: new THREE.Vector3(-domain.sx / 2 + x0 * domain.sx, y0 * domain.top, -domain.sz / 2 + z0 * domain.sz),
    hi: new THREE.Vector3(-domain.sx / 2 + x1 * domain.sx, y1 * domain.top, -domain.sz / 2 + z1 * domain.sz),
  };
}

export function applyCutToMesh(mesh: THREE.Mesh, domain: Domain, cuts: CutState): CutBounds {
  const b = cutBounds(domain, cuts);
  const sx = Math.max(1e-4, (b.hi.x - b.lo.x) / domain.sx);
  const sy = Math.max(1e-4, (b.hi.y - b.lo.y) / domain.top);
  const sz = Math.max(1e-4, (b.hi.z - b.lo.z) / domain.sz);
  mesh.position.set((b.lo.x + b.hi.x) / 2, b.lo.y, (b.lo.z + b.hi.z) / 2);
  mesh.scale.set(sx, sy, sz);
  return b;
}

export function clampCuts(cuts: CutState): void {
  for (const axis of ["x", "y", "z"] as const) {
    cuts[axis][0] = THREE.MathUtils.clamp(cuts[axis][0], 0, 1);
    cuts[axis][1] = THREE.MathUtils.clamp(cuts[axis][1], 0, 1);
    if (cuts[axis][0] > cuts[axis][1]) [cuts[axis][0], cuts[axis][1]] = [cuts[axis][1], cuts[axis][0]];
  }
}
