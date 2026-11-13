/** Three.js layer host sharing Cesium's canvas and WebGL context. */
import { Cartesian3, Matrix4, type Scene as CesiumScene } from "cesium";
import { Group, Mesh, PerspectiveCamera, Raycaster, Scene, Vector2, WebGLRenderer, type Material, type Object3D, type WebGLRenderTarget } from "three";
import type { GeoMap } from "../geo/mapping";
import { DepthProxy } from "./depthProxy";
import { RtcCameraSync, type EnuSphere } from "./rtcCamera";
import { applyLayerRendererConfig } from "../host/rendererConfig";
import type { FrameHooks, ViewHost } from "../host/types";

export class GlobeOverlay implements ViewHost {
  readonly renderer: WebGLRenderer;
  readonly camera = new PerspectiveCamera();
  readonly element: HTMLCanvasElement;
  readonly scene = new Scene();
  readonly layers = new Group();
  readonly sync: RtcCameraSync;
  readonly depthEncoding: "linear" | "log";
  sphere: EnuSphere = { center: [0, 0, 0], radius: 1.5 };
  private readonly ctx: CesiumContextInternals;
  private readonly proxyScene = new Scene();
  private readonly cesium: CesiumScene;
  private removePost: (() => void) | null = null;
  private removePre: (() => void) | null = null;
  private lost = false;
  private disposed = false;
  private hooks: FrameHooks | null = null;
  private layerScene: Scene | null = null;
  private last = performance.now();
  private view: { position: [number, number, number]; target: [number, number, number] } = { position: [0.6, 0.5, 1.2], target: [0, 0, 0] };
  drawCalls = 0;

  constructor(cesium: CesiumScene, map: GeoMap, readonly proxy: DepthProxy, private readonly onContextLost: () => void = () => {}) {
    this.cesium = cesium;
    this.ctx = (cesium as unknown as { context: CesiumContextInternals }).context;
    this.element = cesium.canvas;
    const mode = new URLSearchParams(location.search).get("globeDepth") === "log" ? "log" : "linear";
    this.depthEncoding = mode;
    const gl = this.ctx._gl;
    this.renderer = new WebGLRenderer({ canvas: cesium.canvas, context: gl, logarithmicDepthBuffer: mode === "log" });
    this.renderer.autoClear = false;
    this.renderer.setPixelRatio(1);
    applyLayerRendererConfig(this.renderer);
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;
    this.sync = new RtcCameraSync(map.lon0, map.lat0, map.enu_unit_m);
    this.proxyScene.add(proxy.mesh);
    this.scene.add(this.layers);
    cesium.canvas.addEventListener("webglcontextlost", this.handleLost);
  }

  private readonly handleLost = (event: Event): void => {
    event.preventDefault();
    this.lost = true;
    this.onContextLost();
  };

  size(): { width: number; height: number } { return { width: this.element.clientWidth, height: this.element.clientHeight }; }

  private resyncCesiumState(): void {
    const c = this.ctx;
    c._currentRenderState = c._defaultRenderState;
    c._currentPassState = c._defaultPassState;
    c._currentFramebuffer = undefined;
  }

  private syncCamera(): void {
    this.sync.sync(this.cesium.camera, this.camera, this.sphere);
    this.camera.matrix.decompose(this.camera.position, this.camera.quaternion, this.camera.scale);
    this.camera.updateMatrixWorld(false);
  }

  private renderLayers(): void {
    if (this.lost || this.disposed || !this.layerScene) return;
    const gl = this.renderer.getContext();
    this.renderer.resetState();
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.renderer.clearDepth();
    this.renderer.render(this.proxyScene, this.camera);
    this.renderer.render(this.layerScene, this.camera);
    this.drawCalls = this.renderer.info.render.calls;
    this.renderer.resetState();
    this.resyncCesiumState();
  }

  start(scene: Scene, hooks: FrameHooks): void {
    this.layerScene = scene;
    this.hooks = hooks;
    this.resizeAndNotify();
    this.last = performance.now();
    this.removePre = this.cesium.preRender.addEventListener(() => {
      // Data callbacks can upload textures outside postRender; restore Cesium's cache first.
      this.renderer.resetState();
      this.resyncCesiumState();
    });
    this.removePost = this.cesium.postRender.addEventListener(() => {
      if (this.lost || this.disposed || !this.hooks) return;
      const now = performance.now();
      const realDt = (now - this.last) / 1000;
      const dt = Math.min(0.1, realDt);
      this.last = now;
      this.hooks.beforeCamera(now, dt, realDt);
      this.syncCamera();
      this.hooks.afterCamera(now, dt, realDt);
      this.renderLayers();
      this.hooks.afterRender(now);
    });
  }

  private resizeAndNotify(): void {
    const { width, height } = this.size();
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.hooks?.resize(width, height);
  }

  captureOccluderDepth(target: WebGLRenderTarget, scene: Scene, hide: Object3D[]): void {
    if (this.lost) return;
    const volume = scene.getObjectByName("volume");
    const hidden: Array<[Object3D, boolean]> = [];
    if (volume) hidden.push([volume, volume.visible]), (volume.visible = false);
    for (const object of hide) hidden.push([object, object.visible]), (object.visible = false);
    const gl = this.renderer.getContext();
    this.renderer.resetState();
    this.renderer.setViewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, true, true);
    this.renderer.render(this.proxyScene, this.camera);
    this.renderer.render(scene, this.camera);
    this.renderer.setRenderTarget(null);
    for (const [object, visible] of hidden) object.visible = visible;
    this.renderer.resetState();
    this.resyncCesiumState();
  }

  raycaster(clientX: number, clientY: number): Raycaster {
    const rect = this.element.getBoundingClientRect();
    const ray = new Raycaster();
    ray.setFromCamera(new Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), this.camera);
    return ray;
  }

  setCameraControl(enabled: boolean): void { this.cesium.screenSpaceCameraController.enableInputs = enabled; }
  setDrawMode(_on: boolean): void {}
  capturePointer(id: number): void { this.element.setPointerCapture(id); }
  releasePointer(id: number): void { if (this.element.hasPointerCapture(id)) this.element.releasePointerCapture(id); }
  getView(): { position: [number, number, number]; target: [number, number, number] } { return this.view; }

  setView(position: [number, number, number], target: [number, number, number]): void {
    this.view = { position, target };
    const p = this.toEcef(position), t = this.toEcef(target);
    const direction = Cartesian3.normalize(Cartesian3.subtract(t, p, new Cartesian3()), new Cartesian3());
    const up = new Cartesian3(this.sync.enuToEcef[8], this.sync.enuToEcef[9], this.sync.enuToEcef[10]);
    this.cesium.camera.setView({ destination: p, orientation: { direction, up } });
  }

  private toEcef(p: [number, number, number]): Cartesian3 {
    return Matrix4.multiplyByPoint(this.sync.enuToEcef, new Cartesian3(p[0] * this.sync.unitM, p[1] * this.sync.unitM, p[2] * this.sync.unitM), new Cartesian3());
  }

  benchFrames(n: number): { mean: number; median: number } {
    const times: number[] = [];
    const gl = this.renderer.getContext();
    for (let i = 0; i < Math.max(0, Math.floor(n)); i++) {
      const t0 = performance.now();
      this.syncCamera();
      this.renderLayers();
      gl.finish();
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    return { mean: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0, median: times.length ? times[Math.floor(times.length / 2)]! : 0 };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.removePost?.();
    this.removePre?.();
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

export function createCesiumHost(cesium: CesiumScene, map: GeoMap, proxy: DepthProxy, onContextLost?: () => void): GlobeOverlay {
  return new GlobeOverlay(cesium, map, proxy, onContextLost);
}

interface CesiumContextInternals {
  _gl: WebGL2RenderingContext;
  _currentRenderState: unknown;
  _defaultRenderState: unknown;
  _currentPassState: unknown;
  _defaultPassState: unknown;
  _currentFramebuffer: unknown;
}
