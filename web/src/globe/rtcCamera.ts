/**
 * Relative-to-centre camera sync. Cesium's view matrix is multiplied with the centre-ENU frame
 * in float64 (JS) before it reaches three, so GPU positions stay within a few ENU units instead
 * of ~6.4e6 m ECEF values. three gets its own near/far from the overlay's bounding sphere,
 * not Cesium's huge frustum.
 */
import { Cartesian3, Matrix4, PerspectiveFrustum, Transforms, type Camera as CesiumCamera } from "cesium";
import type { PerspectiveCamera } from "three";

export interface EnuSphere {
  /** centre in ENU units */
  center: [number, number, number];
  radius: number;
}

export class RtcCameraSync {
  readonly enuToEcef: Matrix4;
  readonly ecefToEnu: Matrix4;
  private readonly scaled: Matrix4;
  private readonly unscale: Matrix4;
  private readonly tmp = new Matrix4();
  private readonly camEnu = new Cartesian3();

  constructor(lon0: number, lat0: number, readonly unitM: number, private readonly minNearM = 1) {
    this.enuToEcef = Transforms.eastNorthUpToFixedFrame(Cartesian3.fromDegrees(lon0, lat0, 0));
    this.ecefToEnu = Matrix4.inverseTransformation(this.enuToEcef, new Matrix4());
    this.scaled = Matrix4.multiplyByUniformScale(this.enuToEcef, unitM, new Matrix4());
    this.unscale = Matrix4.fromUniformScale(1 / unitM);
  }

  /** Camera position in ENU units. */
  cameraEnu(camera: CesiumCamera): [number, number, number] {
    const p = Matrix4.multiplyByPoint(this.ecefToEnu, camera.positionWC, this.camEnu);
    return [p.x / this.unitM, p.y / this.unitM, p.z / this.unitM];
  }

  sync(camera: CesiumCamera, target: PerspectiveCamera, sphere: EnuSphere): void {
    // ENU units in, view space in ENU units out (so near/far below are in the same units)
    const view = Matrix4.multiply(this.unscale, Matrix4.multiply(camera.viewMatrix, this.scaled, this.tmp), this.tmp);
    target.matrixWorldInverse.fromArray(Matrix4.toArray(view));
    target.matrixWorld.copy(target.matrixWorldInverse).invert();
    target.matrix.copy(target.matrixWorld);
    target.matrix.decompose(target.position, target.quaternion, target.scale);
    const c = this.cameraEnu(camera);
    const d = Math.hypot(c[0] - sphere.center[0], c[1] - sphere.center[1], c[2] - sphere.center[2]);
    const frustum = camera.frustum as PerspectiveFrustum;
    target.fov = ((frustum.fovy ?? Math.PI / 3) * 180) / Math.PI;
    target.aspect = frustum.aspectRatio ?? 1;
    target.near = Math.max(d - sphere.radius, this.minNearM / this.unitM);
    target.far = d + sphere.radius;
    target.updateProjectionMatrix();
  }
}
