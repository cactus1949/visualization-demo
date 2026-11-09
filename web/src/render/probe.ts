import * as THREE from "three";
import type { Manifest, VariableMeta } from "../data/manifest";
import { flatIndex, worldToGrid } from "./coords";

export interface ProbeResult {
  lon: number;
  lat: number;
  height: number;
  volume?: number;
  windSpeed: number;
  windDirection: number;
  surface?: number;
}

function valueAt(
  manifest: Manifest,
  meta: VariableMeta | undefined,
  data: Uint8Array | undefined,
  ix: number,
  iy: number,
  iz: number,
): number | undefined {
  if (!meta || !data) return undefined;
  const index =
    meta.dims.length === 3 ? flatIndex(manifest.grid, ix, iy, iz) : iy * manifest.grid.nx + ix;
  const transformed = meta.offset + (data[index] / 255) * (meta.range[1] - meta.range[0]);
  return meta.transform === "log10" ? 10 ** transformed : transformed;
}

export function probeAt(
  manifest: Manifest,
  point: THREE.Vector3,
  exaggeration: number,
  volumeMeta: VariableMeta | undefined,
  volumeData: Uint8Array | undefined,
  surfaceMeta: VariableMeta | undefined,
  surfaceData: Uint8Array | undefined,
  uData: Uint8Array | undefined,
  vData: Uint8Array | undefined,
): ProbeResult {
  const grid = worldToGrid(manifest, point, exaggeration);
  const ix = Math.round(grid.ix);
  const iy = Math.round(grid.iy);
  const iz = Math.round(grid.iz);
  const u = valueAt(manifest, manifest.variables.u, uData, ix, iy, iz) ?? 0;
  const v = valueAt(manifest, manifest.variables.v, vData, ix, iy, iz) ?? 0;
  return {
    lon: grid.lon,
    lat: grid.lat,
    height: grid.height,
    volume: valueAt(manifest, volumeMeta, volumeData, ix, iy, iz),
    windSpeed: Math.hypot(u, v),
    windDirection: (Math.atan2(u, v) * 180) / Math.PI + 180,
    surface: valueAt(manifest, surfaceMeta, surfaceData, ix, iy, 0),
  };
}

export function pick(raycaster: THREE.Raycaster, objects: THREE.Object3D[]): THREE.Vector3 | null {
  return raycaster.intersectObjects(objects, true)[0]?.point ?? null;
}
