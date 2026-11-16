/**
 * Measures, in the running page, how far the three.js placement (forward polynomial evaluated
 * in float32 like the shader, then the RTC-synced three camera) lands from Cesium's own exact
 * placement (Cartesian3.fromDegrees + SceneTransforms) for the test layer's edge points.
 */
import { Cartesian2, Matrix4, SceneTransforms, type Scene } from "cesium";
import { Vector3, type PerspectiveCamera } from "three";
import { polyForward, type GeoGrid, type GeoMap } from "../geo/mapping";
import { ellipsoidHeight, sampleGrid, type GridField } from "../geo/placement";
import { exactCartesian } from "./referenceOutline";
import type { RtcCameraSync } from "./rtcCamera";
import { edgeSegments } from "./testGeometry";

export interface AlignmentReport {
  points: number;
  onScreen: number;
  maxMm: number;
  meanMm: number;
  maxPx: number;
  meanPx: number;
}

export function measureAlignment(scene: Scene, camera: PerspectiveCamera, sync: RtcCameraSync, grid: GeoGrid, map: GeoMap, ground: GridField | null, k: number): AlignmentReport {
  const pts = edgeSegments(grid.top_m, 50, 10).flat();
  const canvas = scene.canvas;
  const v = new Vector3();
  const win = new Cartesian2();
  let maxMm = 0, sumMm = 0, maxPx = 0, sumPx = 0, onScreen = 0;
  for (const p of pts) {
    const exact = exactCartesian(grid, ground, k, p);
    const exactEnu = Matrix4.multiplyByPoint(sync.ecefToEnu, exact, exact.clone());
    const h = ellipsoidHeight(ground ? sampleGrid(ground, p[0], p[1]) : 0, k, p[2]);
    const poly = polyForward(map, p[0], p[1], h, Math.fround);
    const mm = Math.hypot(poly[0] - exactEnu.x, poly[1] - exactEnu.y, poly[2] - exactEnu.z) * 1000;
    maxMm = Math.max(maxMm, mm);
    sumMm += mm;
    const w = SceneTransforms.worldToWindowCoordinates(scene, exact, win);
    v.set(poly[0] / map.enu_unit_m, poly[1] / map.enu_unit_m, poly[2] / map.enu_unit_m).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix);
    if (!w || Math.abs(v.x) > 1 || Math.abs(v.y) > 1 || v.z > 1 || v.z < -1) continue;
    const px = Math.hypot(((v.x + 1) / 2) * canvas.clientWidth - w.x, ((1 - v.y) / 2) * canvas.clientHeight - w.y);
    onScreen++;
    maxPx = Math.max(maxPx, px);
    sumPx += px;
  }
  return { points: pts.length, onScreen, maxMm, meanMm: sumMm / pts.length, maxPx, meanPx: onScreen ? sumPx / onScreen : 0 };
}
