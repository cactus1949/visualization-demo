import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { FrameHooks, ViewHost } from "./types";
import { applyLayerRendererConfig } from "./rendererConfig";
import { withHidden } from "./hidden";

export type ThreeHostOptions = {
  initialView?: { position: [number, number, number]; target: [number, number, number] } | null;
  initialNow?: number;
};

/** Creates the existing Three.js render host used by the atmosphere view. */
export function createThreeHost(
  canvas: HTMLCanvasElement,
  options: ThreeHostOptions = {},
): ViewHost {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: "high-performance",
  });
  applyLayerRendererConfig(renderer);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.2;
  controls.maxDistance = 60;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.screenSpacePanning = false;
  if (options.initialView) {
    camera.position.set(...options.initialView.position);
    controls.target.set(...options.initialView.target);
    controls.update();
  }

  const ray = new THREE.Raycaster();
  let hooks: FrameHooks | null = null;
  let scene: THREE.Scene | null = null;
  let raf = 0;
  let disposed = false;
  let last = options.initialNow ?? performance.now();
  let resizeObserver: ResizeObserver | null = null;

  function size(): { width: number; height: number } {
    return { width: canvas.clientWidth, height: canvas.clientHeight };
  }

  function resize(): void {
    const { width, height } = size();
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    hooks?.resize(width, height);
  }

  function frame(now: number): void {
    if (disposed || !hooks || !scene) return;
    raf = requestAnimationFrame(frame);
    const realDt = (now - last) / 1000;
    const dt = Math.min(0.1, realDt);
    last = now;
    hooks.beforeCamera(now, dt, realDt);
    controls.update();
    hooks.afterCamera(now, dt, realDt);
    renderer.render(scene, camera);
    hooks.afterRender(now);
  }

  const host: ViewHost = {
    renderer,
    camera,
    element: canvas,
    depthEncoding: "linear",
    size,
    start(nextScene, nextHooks) {
      scene = nextScene;
      hooks = nextHooks;
      resize();
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(canvas);
      raf = requestAnimationFrame(frame);
    },
    captureOccluderDepth(target, sceneToRender, hide) {
      // same calls as the pre-ViewHost VolumeLayer.captureDepth (first two tabs stay pixel-identical)
      withHidden(hide, () => {
        renderer.setRenderTarget(target);
        renderer.clear(true, true, true);
        renderer.render(sceneToRender, camera);
        renderer.setRenderTarget(null);
      });
    },
    raycaster(clientX, clientY) {
      const rect = canvas.getBoundingClientRect();
      ray.setFromCamera(
        new THREE.Vector2(
          ((clientX - rect.left) / rect.width) * 2 - 1,
          -((clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );
      return ray;
    },
    setCameraControl(enabled) {
      controls.enabled = enabled;
    },
    setDrawMode(on) {
      (controls.mouseButtons as any).LEFT = on ? -1 : THREE.MOUSE.ROTATE;
      (controls.mouseButtons as any).RIGHT = on ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    },
    capturePointer(id) {
      canvas.setPointerCapture(id);
    },
    releasePointer(id) {
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    },
    getView() {
      return {
        position: camera.position.toArray() as [number, number, number],
        target: controls.target.toArray() as [number, number, number],
      };
    },
    setView(position, target) {
      camera.position.set(...position);
      controls.target.set(...target);
      controls.update();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      controls.dispose();
      renderer.dispose();
    },
  };
  return host;
}
