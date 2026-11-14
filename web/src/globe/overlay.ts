/**
 * Cesium ViewHost: three.js drawn into Cesium's own canvas and WebGL context, after Cesium's frame
 * (postRender). Each frame: hooks.beforeCamera → RTC camera sync (instead of controls.update) →
 * hooks.afterCamera (layers, occluder depth capture) → clear depth, depth-only terrain proxy,
 * own test objects, layer scene → hooks.afterRender → resetState + Cesium cache resync.
 *
 * Uses Cesium private fields (no public API exists): `context._gl`, and after three has reset GL
 * state, `_currentRenderState / _currentPassState / _currentFramebuffer` are put back to Cesium's
 * defaults so its state diffing re-applies everything. The same reset also runs on preRender, so GL
 * work layers do outside the frame (TimeFields uploads / blends from data callbacks) can't leave
 * Cesium with a stale cache. Recheck on Cesium upgrades (docs/globe-geo.md).
 */
import { Cartesian3, Matrix4, type Scene as CesiumScene } from "cesium";
import { Group, Mesh, PerspectiveCamera, Raycaster, Scene, Vector2, WebGLRenderer, type Material, type Object3D, type WebGLRenderTarget } from "three";
import type { GeoMap } from "../geo/mapping";
import { DepthProxy } from "./depthProxy";
import { RtcCameraSync, type EnuSphere } from "./rtcCamera";
import { DEFAULT_DEPTH_MODE, depthEncodingOf, depthModeFromQuery, type Box3Like, type GlobeDepthMode } from "./depthMode";
import { applyLayerRendererConfig, beginLayerFrame } from "../host/rendererConfig";
import { withHidden } from "../host/hidden";
import type { FrameHooks, ViewHost } from "../host/types";

export type DepthEncoding = ViewHost["depthEncoding"];

export interface CesiumHostOptions {
  /** "log" (default) or "linear" (NDC z). Prefer `depthMode` when legacy/near/log must be distinguished. */
  depthEncoding?: DepthEncoding;
  /** legacy | near | log; `?globeDepth=linear` is an alias of near. Overrides depthEncoding when set. */
  depthMode?: GlobeDepthMode;
  onContextLost?: () => void;
}

/** Default is log. `?globeDepth=linear` (or `near`) uses a linear buffer; `legacy` is the PR ① sphere frustum. */
export function depthEncodingFromUrl(search = location.search): DepthEncoding {
  return depthEncodingOf(depthModeFromQuery(search));
}

export class GlobeOverlay implements ViewHost {
  readonly renderer: WebGLRenderer;
  readonly camera = new PerspectiveCamera();
  readonly element: HTMLCanvasElement;
  readonly depthEncoding: DepthEncoding;
  readonly depthMode: GlobeDepthMode;
  /** host-owned extras drawn after the proxy (the alignment test layer lives in `layers`) */
  readonly scene = new Scene();
  readonly layers = new Group();
  readonly sync: RtcCameraSync;
  /** ENU bounding sphere of everything three draws; legacy near / far still use this */
  sphere: EnuSphere = { center: [0, 0, 0], radius: 1.5 };
  /** ENU axis-aligned box of the same content; log / near frustums use this */
  box: Box3Like = { min: [-1.5, -1.5, -1.5], max: [1.5, 1.5, 1.5] };
  drawCalls = 0;
  private readonly proxyScene = new Scene();
  private readonly ctx: CesiumContextInternals;
  private readonly onContextLost: () => void;
  private readonly ray = new Raycaster();
  private removePre: (() => void) | null = null;
  private removePost: (() => void) | null = null;
  private layerScene: Scene | null = null;
  private hooks: FrameHooks | null = null;
  private last = 0;
  private width = 0;
  private height = 0;
  private lost = false;
  private disposed = false;

  constructor(private readonly cesium: CesiumScene, map: GeoMap, readonly proxy: DepthProxy, opts: CesiumHostOptions = {}) {
    this.ctx = (cesium as unknown as { context: CesiumContextInternals }).context;
    this.element = cesium.canvas;
    this.depthMode = opts.depthMode ?? (opts.depthEncoding === "linear" ? "near" : opts.depthEncoding === "log" ? "log" : DEFAULT_DEPTH_MODE);
    this.depthEncoding = depthEncodingOf(this.depthMode);
    this.onContextLost = opts.onContextLost ?? (() => {});
    this.renderer = new WebGLRenderer({ canvas: cesium.canvas, context: this.ctx._gl, logarithmicDepthBuffer: this.depthEncoding === "log" });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);
    this.renderer.info.autoReset = false;
    applyLayerRendererConfig(this.renderer);
    // RTC sync writes the matrices; afterCamera's updateMatrixWorld() must not rebuild them from position
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.sync = new RtcCameraSync(map.lon0, map.lat0, map.enu_unit_m, 1, this.depthMode);
    this.proxyScene.add(proxy.mesh);
    this.scene.add(this.layers);
    cesium.canvas.addEventListener("webglcontextlost", this.handleLost);
    this.removePre = cesium.preRender.addEventListener(() => this.resyncAfter(() => {}));
    this.removePost = cesium.postRender.addEventListener(() => this.frame());
  }

  private readonly handleLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    this.onContextLost();
  };

  size(): { width: number; height: number } {
    return { width: this.element.clientWidth, height: this.element.clientHeight };
  }

  start(scene: Scene, hooks: FrameHooks): void {
    this.layerScene = scene;
    this.hooks = hooks;
    this.last = performance.now();
    this.width = this.height = 0;
  }

  private frame(): void {
    if (this.lost || this.disposed) return;
    const now = performance.now();
    const realDt = (now - this.last) / 1000;
    const dt = Math.min(0.1, realDt);
    this.last = now;
    this.trackSize();
    // beforeCamera reads last frame's draw calls for the HUD; count this frame from here
    beginLayerFrame(this.renderer);
    this.hooks?.beforeCamera(now, dt, realDt);
    this.renderer.info.reset();
    this.sync.sync(this.cesium.camera, this.camera, this.sphere, this.box);
    this.hooks?.afterCamera(now, dt, realDt);
    this.resyncAfter(() => {
      const gl = this.renderer.getContext();
      this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      this.renderer.clearDepth();
      this.renderer.render(this.proxyScene, this.camera);
      this.renderer.render(this.scene, this.camera);
      if (this.layerScene) this.renderer.render(this.layerScene, this.camera);
    });
    this.drawCalls = this.renderer.info.render.calls;
    this.hooks?.afterRender(now);
  }

  /** Cesium owns the canvas size (and its pixel ratio); only tell the layers when it changed. */
  private trackSize(): void {
    const { width, height } = this.size();
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.hooks?.resize(width, height);
  }

  /** Run three GL work, then put GL and Cesium's state cache back to defaults. */
  resyncAfter(work: () => void): void {
    if (this.lost || this.disposed) return;
    this.renderer.resetState();
    try {
      work();
    } finally {
      this.renderer.resetState();
      const c = this.ctx;
      c._currentRenderState = c._defaultRenderState;
      c._currentPassState = c._defaultPassState;
      c._currentFramebuffer = undefined;
    }
  }

  /**
   * ViewHost.isolateGl: layer GL work outside the draw pass (particle sim / place passes, debug
   * readbacks, disposal). Unlike resyncAfter the work always runs: callers put state changes and
   * disposal in here too. With a lost context there is no GL state to protect (GL calls are no-ops).
   */
  isolateGl(work: () => void): void {
    if (this.lost) {
      work();
      return;
    }
    this.renderer.resetState();
    try {
      work();
    } finally {
      this.renderer.resetState();
      const c = this.ctx;
      c._currentRenderState = c._defaultRenderState;
      c._currentPassState = c._defaultPassState;
      c._currentFramebuffer = undefined;
    }
  }

  captureOccluderDepth(target: WebGLRenderTarget, scene: Scene, hide: Object3D[]): void {
    this.resyncAfter(() => {
      this.renderer.setRenderTarget(target);
      this.renderer.clear(true, true, true);
      // the proxy stands in for Cesium's terrain / ellipsoid (Cesium's own depth is not usable here)
      this.renderer.render(this.proxyScene, this.camera);
      withHidden(hide, () => this.renderer.render(scene, this.camera));
      this.renderer.setRenderTarget(null);
    });
  }

  raycaster(clientX: number, clientY: number): Raycaster {
    const rect = this.element.getBoundingClientRect();
    this.ray.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    return this.ray;
  }

  setCameraControl(enabled: boolean): void {
    this.cesium.screenSpaceCameraController.enableInputs = enabled;
  }

  setDrawMode(_on: boolean): void {}

  capturePointer(id: number): void {
    this.element.setPointerCapture(id);
  }

  releasePointer(id: number): void {
    if (this.element.hasPointerCapture(id)) this.element.releasePointerCapture(id);
  }

  /** ENU units; the target is the point on the view ray at the camera's distance from the ENU origin. */
  getView(): { position: [number, number, number]; target: [number, number, number] } {
    const c = this.cesium.camera;
    const p = this.sync.cameraEnu(c);
    const d = Matrix4.multiplyByPointAsVector(this.sync.ecefToEnu, c.directionWC, new Cartesian3());
    const r = Math.hypot(...p);
    return { position: p, target: [p[0] + d.x * r, p[1] + d.y * r, p[2] + d.z * r] };
  }

  setView(position: [number, number, number], target: [number, number, number]): void {
    const p = this.toEcef(position), t = this.toEcef(target);
    const direction = Cartesian3.normalize(Cartesian3.subtract(t, p, new Cartesian3()), new Cartesian3());
    const m = this.sync.enuToEcef; // column 2 = local up at the ENU origin
    const up = new Cartesian3(m[8], m[9], m[10]);
    const right = Cartesian3.normalize(Cartesian3.cross(direction, up, new Cartesian3()), new Cartesian3());
    const trueUp = Cartesian3.cross(right, direction, new Cartesian3());
    this.cesium.camera.setView({ destination: p, orientation: { direction, up: trueUp } });
  }

  private toEcef(p: [number, number, number]): Cartesian3 {
    const s = this.sync.unitM;
    return Matrix4.multiplyByPoint(this.sync.enuToEcef, new Cartesian3(p[0] * s, p[1] * s, p[2] * s), new Cartesian3());
  }

  /** Debug: render n full Cesium frames (globe + this overlay) synchronously; a 1-pixel readPixels waits for the GPU. */
  benchFrames(n: number): { n: number; mean: number; median: number; p90: number } {
    const gl = this.renderer.getContext();
    const px = new Uint8Array(4);
    const times: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      this.cesium.requestRender();
      this.cesium.render();
      this.resyncAfter(() => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px));
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
    return { n, mean: times.reduce((a, b) => a + b, 0) / Math.max(1, n), median: at(0.5), p90: at(0.9) };
  }

  /** Releases the host's own objects (proxy, test layer) and the three renderer; the Viewer is owned by the caller. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removePre?.();
    this.removePost?.();
    this.element.removeEventListener("webglcontextlost", this.handleLost);
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
