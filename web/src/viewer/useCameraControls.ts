/**
 * 相机视角预设、初始视角复位、缩放、指北针与全屏切换。
 */
import { ref, type Ref } from "vue";
import type { ViewHost } from "../host/types";
import { clonePose, northScreenDeg, type CameraPose } from "../host/viewMotion";
import type { SectionKind } from "../render/sections/types";
import type { TimelineState } from "../state/timeline";

export interface ViewSnapshot {
  t: number;
  playing: boolean;
  rate: number;
  smooth: boolean;
  loop: boolean;
  camera: [number, number, number];
  target: [number, number, number];
  exaggeration: number;
}

// Camera presets look from the south-west so the prevailing SE wind runs across the screen.
export const BOX_VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { pos: [-14.5, 9, 13.5], target: [0.5, 0.3, -0.5] },
  slice: { pos: [-11.5, 10.5, 11.5], target: [0.5, 0.4, -0.5] },
  section: { pos: [-6, 4.8, 15], target: [0.5, 1.0, -0.5] },
  close: { pos: [-3.6, 1.5, 3.6], target: [0.3, 0.25, -0.3] },
  top: { pos: [0, 26, 0.01], target: [0, 0, 0] },
};

export const ZOOM_IN = 0.8;
export const ZOOM_OUT = 1.25;

export interface CameraControlsDeps {
  globeMode: boolean;
  viewerRoot: Ref<HTMLDivElement | null>;
  getHost: () => ViewHost | null;
  getHomeViewProp: () => CameraPose | null | undefined;
  tl: TimelineState;
  view: { exaggeration: number };
  section: { enabled: boolean; kind: SectionKind; drawMode: boolean };
  slice: { enabled: boolean };
  onCameraTransition: () => void;
  selectKind: (kind: SectionKind) => void;
  leaveKind: (kind: SectionKind) => void;
  updateSection: () => void;
}

export function useCameraControls(deps: CameraControlsDeps) {
  /** 打开这一屏时的相机。复位只恢复它，不动图层。 */
  let homePose: CameraPose | null = null;
  const compassDeg = ref(0);
  const compassRight: [number, number, number] = [1, 0, 0];
  const compassUp: [number, number, number] = [0, 1, 0];
  const fullscreen = ref(false);

  function snapshot(): ViewSnapshot {
    const current = deps.getHost()!.getView();
    return {
      t: deps.tl.t,
      playing: deps.tl.playing,
      rate: deps.tl.rate,
      smooth: deps.tl.smooth,
      loop: deps.tl.loop,
      camera: current.position,
      target: current.target,
      exaggeration: deps.view.exaggeration,
    };
  }

  function rememberHome(): void {
    const propHome = deps.getHomeViewProp();
    const host = deps.getHost();
    if (propHome) homePose = clonePose(propHome);
    else if (host) homePose = clonePose(host.getView());
  }

  function resetHomeView(): void {
    const host = deps.getHost();
    if (!host || !homePose) return;
    host.setView(homePose.position, homePose.target);
  }

  function zoomView(scale: number): void {
    deps.getHost()?.zoomBy(scale);
  }

  function faceNorth(): void {
    deps.getHost()?.faceNorth();
  }

  function updateCompass(): void {
    const cam = deps.getHost()?.camera;
    if (!cam) return;
    const e = cam.matrixWorld.elements;
    compassRight[0] = e[0]!;
    compassRight[1] = e[1]!;
    compassRight[2] = e[2]!;
    compassUp[0] = e[4]!;
    compassUp[1] = e[5]!;
    compassUp[2] = e[6]!;
    const north: [number, number, number] = deps.globeMode ? [0, 1, 0] : [0, 0, -1];
    const deg = Math.round(northScreenDeg(compassRight, compassUp, north));
    if (deg !== compassDeg.value) compassDeg.value = deg;
  }

  /**
   * 全屏目标必须包住真正的画布。地球页的 Cesium 画布是这个叠加层的兄弟节点，
   * 只全屏叠加层会得到一块黑屏，缩放和复位都画不回来。
   */
  function fullscreenRoot(): HTMLElement | null {
    const el = deps.viewerRoot.value;
    if (!el) return null;
    return (el.closest(".shell") as HTMLElement | null) ?? el;
  }

  function syncFullscreen(): void {
    fullscreen.value = document.fullscreenElement === fullscreenRoot();
  }

  function toggleFullscreen(): void {
    const el = fullscreenRoot();
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen();
  }

  function setView(name: string): void {
    deps.onCameraTransition();
    const preset = BOX_VIEWS[name] ?? BOX_VIEWS.overview;
    deps.getHost()!.setView(preset.pos, preset.target);
    if (name === "slice") {
      deps.selectKind("height");
    } else if (name === "section") {
      if (deps.section.kind === "height" || !deps.section.enabled) deps.selectKind("lon");
      else deps.selectKind(deps.section.kind === "box" || deps.section.kind === "polyline" ? "lon" : deps.section.kind);
    } else if (name === "overview") {
      if (deps.section.enabled) deps.leaveKind(deps.section.kind);
      deps.slice.enabled = false;
      deps.section.enabled = false;
      deps.section.drawMode = false;
      deps.updateSection();
    }
  }

  return {
    compassDeg,
    fullscreen,
    snapshot,
    rememberHome,
    resetHomeView,
    zoomView,
    faceNorth,
    updateCompass,
    syncFullscreen,
    toggleFullscreen,
    setView,
  };
}
