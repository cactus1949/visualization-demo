/**
 * three.js drawn into Cesium's own canvas and WebGL context, after Cesium's frame (postRender).
 * Each frame: sync the RTC camera, clear depth, draw the depth proxy (no colour), then layers.
 */
import { type Scene as CesiumScene } from "cesium";
import { Group, PerspectiveCamera, Scene, WebGLRenderer } from "three";
import type { GeoMap } from "../geo/mapping";
import { DepthProxy } from "./depthProxy";
import { RtcCameraSync, type EnuSphere } from "./rtcCamera";

export class GlobeOverlay {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera();
  readonly layers = new Group();
  readonly sync: RtcCameraSync;
  sphere: EnuSphere = { center: [0, 0, 0], radius: 1.5 };
  private readonly remove: () => void;
  drawCalls = 0;

  constructor(private readonly cesium: CesiumScene, map: GeoMap, readonly proxy: DepthProxy) {
    // Cesium exposes no public getter for its WebGL context; sharing it is the documented-by-community way.
    const gl = (cesium as unknown as { context: { _gl: WebGL2RenderingContext } }).context._gl;
    this.renderer = new WebGLRenderer({ canvas: cesium.canvas, context: gl });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.sync = new RtcCameraSync(map.lon0, map.lat0, map.enu_unit_m);
    this.scene.add(proxy.mesh, this.layers);
    this.remove = cesium.postRender.addEventListener(() => this.draw());
  }

  private draw(): void {
    const gl = this.renderer.getContext();
    this.sync.sync(this.cesium.camera, this.camera, this.sphere);
    this.renderer.resetState();
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
    this.drawCalls = this.renderer.info.render.calls;
    this.renderer.resetState();
  }

  dispose(): void {
    this.remove();
    this.proxy.dispose();
    this.renderer.dispose();
  }
}
