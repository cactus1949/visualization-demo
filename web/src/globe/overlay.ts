/**
 * three.js drawn into Cesium's own canvas and WebGL context, after Cesium's frame (postRender).
 * Each frame: sync the RTC camera, clear depth, draw the depth proxy (no colour), then layers.
 *
 * Uses Cesium private fields (no public API exists): `context._gl`, and after three has reset GL
 * state, `_currentRenderState / _currentPassState / _currentFramebuffer` are put back to Cesium's
 * defaults so its state diffing re-applies everything. Recheck on Cesium upgrades (docs/globe-geo.md).
 */
import { type Scene as CesiumScene } from "cesium";
import { Group, Mesh, PerspectiveCamera, Scene, WebGLRenderer, type Material } from "three";
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
  private readonly ctx: CesiumContextInternals;
  private lost = false;
  drawCalls = 0;

  constructor(
    private readonly cesium: CesiumScene,
    map: GeoMap,
    readonly proxy: DepthProxy,
    private readonly onContextLost: () => void = () => {},
  ) {
    this.ctx = (cesium as unknown as { context: CesiumContextInternals }).context;
    const gl = this.ctx._gl;
    cesium.canvas.addEventListener("webglcontextlost", this.handleLost);
    this.renderer = new WebGLRenderer({ canvas: cesium.canvas, context: gl });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.sync = new RtcCameraSync(map.lon0, map.lat0, map.enu_unit_m);
    this.scene.add(proxy.mesh, this.layers);
    this.remove = cesium.postRender.addEventListener(() => this.draw());
  }

  private readonly handleLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    this.onContextLost();
  };

  private draw(): void {
    if (this.lost) return;
    const gl = this.renderer.getContext();
    this.sync.sync(this.cesium.camera, this.camera, this.sphere);
    this.renderer.resetState();
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
    this.drawCalls = this.renderer.info.render.calls;
    this.renderer.resetState();
    this.resyncCesiumState();
  }

  /** three's resetState() put GL back to defaults; make Cesium's cache agree so its next draw re-applies all state. */
  private resyncCesiumState(): void {
    const c = this.ctx;
    c._currentRenderState = c._defaultRenderState;
    c._currentPassState = c._defaultPassState;
    c._currentFramebuffer = undefined;
  }

  /** Release every geometry / material under `layers` (test layer included), the proxy and the renderer. */
  dispose(): void {
    this.remove();
    this.cesium.canvas.removeEventListener("webglcontextlost", this.handleLost);
    this.layers.traverse((o) => {
      if (!(o instanceof Mesh) && !("isLineSegments" in o)) return;
      const m = o as Mesh;
      m.geometry.dispose();
      for (const mat of ([] as Material[]).concat(m.material)) mat.dispose();
    });
    this.layers.clear();
    this.proxy.dispose();
    this.renderer.dispose();
  }
}

/** Private Cesium Context fields this overlay touches (no public API; recheck on upgrade). */
interface CesiumContextInternals {
  _gl: WebGL2RenderingContext;
  _currentRenderState: unknown;
  _defaultRenderState: unknown;
  _currentPassState: unknown;
  _defaultPassState: unknown;
  _currentFramebuffer: unknown;
}
