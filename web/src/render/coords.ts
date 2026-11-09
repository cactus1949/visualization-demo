import * as THREE from "three";
import type { GridMeta, Manifest } from "../data/manifest";

export interface WorldSize {
  x: number;
  y: number;
  z: number;
}

export function worldSize(manifest: Manifest, exaggeration = 5): WorldSize {
  const grid = manifest.grid;
  return {
    x: ((grid.nx - 1) * grid.dx_m) / 1000,
    y: exaggeration,
    z: ((grid.ny - 1) * grid.dy_m) / 1000,
  };
}

export function gridToWorld(
  manifest: Manifest,
  ix: number,
  iy: number,
  iz: number,
  exaggeration = 5,
): THREE.Vector3 {
  const size = worldSize(manifest, exaggeration);
  const { nx, ny, levels_m } = manifest.grid;
  return new THREE.Vector3(
    (ix / (nx - 1) - 0.5) * size.x,
    (levels_m[Math.max(0, Math.min(iz, levels_m.length - 1))] / 1000) * exaggeration,
    (0.5 - iy / (ny - 1)) * size.z,
  );
}

export function worldToGrid(
  manifest: Manifest,
  point: THREE.Vector3,
  exaggeration: number,
): { ix: number; iy: number; iz: number; lon: number; lat: number; height: number } {
  const grid = manifest.grid;
  const size = worldSize(manifest, exaggeration);
  const ix = THREE.MathUtils.clamp((point.x / size.x + 0.5) * (grid.nx - 1), 0, grid.nx - 1);
  const iy = THREE.MathUtils.clamp((0.5 - point.z / size.z) * (grid.ny - 1), 0, grid.ny - 1);
  const iz = THREE.MathUtils.clamp((point.y / size.y) * (grid.nz - 1), 0, grid.nz - 1);
  return {
    ix,
    iy,
    iz,
    lon: THREE.MathUtils.lerp(grid.lon_min, grid.lon_max, ix / (grid.nx - 1)),
    lat: THREE.MathUtils.lerp(grid.lat_min, grid.lat_max, iy / (grid.ny - 1)),
    height: (point.y / exaggeration) * 1000,
  };
}

export function flatIndex(grid: GridMeta, ix: number, iy: number, iz: number): number {
  return iz * grid.ny * grid.nx + iy * grid.nx + ix;
}
