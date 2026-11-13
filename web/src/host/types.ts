import type * as THREE from "three";

/** Per-frame work supplied by the layer and panel owner. */
export type FrameHooks = {
  /** Runs before controls update. */
  beforeCamera(now: number, dt: number, realDt: number): void;
  /** Runs after controls and camera matrices update. */
  afterCamera(now: number, dt: number, realDt: number): void;
  /** Runs after the scene has rendered. */
  afterRender(now: number): void;
  /** Runs after the host has resized its renderer and camera. */
  resize(width: number, height: number): void;
};

/** Rendering and input services shared by a view implementation. */
export interface ViewHost {
  /** WebGL renderer used by layers and diagnostics. */
  readonly renderer: THREE.WebGLRenderer;
  /** Perspective camera used by the view. */
  readonly camera: THREE.PerspectiveCamera;
  /** Canvas receiving view input events. */
  readonly element: HTMLCanvasElement;
  /** How occluder depth is encoded: "linear" (NDC z) or "log" (three's logarithmicDepthBuffer). */
  readonly depthEncoding: "linear" | "log";
  /** Returns the canvas size in CSS pixels. */
  size(): { width: number; height: number };
  /** Starts the host loop for a scene and its layer hooks. */
  start(scene: THREE.Scene, hooks: FrameHooks): void;
  /** Renders occluder depth into `target` (scene minus `hide`; a Cesium host adds its terrain proxy). */
  captureOccluderDepth(target: THREE.WebGLRenderTarget, scene: THREE.Scene, hide: THREE.Object3D[]): void;
  /** Creates a ray through a client-space pointer location. */
  raycaster(clientX: number, clientY: number): THREE.Raycaster;
  /** Enables or disables orbit camera controls. */
  setCameraControl(enabled: boolean): void;
  /** Remaps orbit mouse buttons for drawing mode. */
  setDrawMode(on: boolean): void;
  /** Captures a pointer on the host element. */
  capturePointer(id: number): void;
  /** Releases a captured pointer when present. */
  releasePointer(id: number): void;
  /** Reads the current camera position and orbit target. */
  getView(): { position: [number, number, number]; target: [number, number, number] };
  /** Sets the camera position and orbit target, then updates controls. */
  setView(position: [number, number, number], target: [number, number, number]): void;
  /** Stops the loop and releases host resources. */
  dispose(): void;
  /**
   * Optional: run three.js GL work (render targets, full-screen passes) isolated from a host that
   * shares the WebGL context. The Cesium host resets GL state before and after and puts Cesium's
   * state cache back to its defaults. Hosts that own their context leave it out; callers then run
   * the work directly.
   */
  isolateGl?(work: () => void): void;
}
