<script setup lang="ts">
/**
 * Third tab "地球": Cesium globe (Tianditu imagery, optional self-built terrain) with the data layers
 * of AtmosViewer drawn by three.js in the same WebGL context through the Cesium ViewHost
 * (globe/overlay.ts). PR ③: the volume runs on the curved shell. PR ⑥: probe, height labels,
 * buildings, ground and legends are on this tab; sections (④) and particles (⑤) stay off.
 */
import { computed, onBeforeUnmount, onMounted, onUnmounted, reactive, ref, shallowRef, watch } from "vue";
import { Cartesian3, Color, Ellipsoid, HeadingPitchRange, Math as CMath, Matrix4, PolylineCollection, Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import AtmosViewer from "./AtmosViewer.vue";
import GlobeFormatSwitch from "./GlobeFormatSwitch.vue";
import type { FormatDef } from "../formats/types";
import type { CurvedVolumeOptions } from "../render/volume";
import { GeoDecodeError, geoBaseUrl, lastDecodeMs, lastDecodeWhere, loadGeoFoundation, type GeoFoundation } from "../geo/geoData";
import { applyBasemap } from "../globe/basemap";
import { pickBasemapSource, type BasemapStyle } from "../globe/basemapChoice";
import { terrainSwitch, type TerrainSwitch } from "../globe/terrain";
import { DepthProxy } from "../globe/depthProxy";
import { GlobeOverlay } from "../globe/overlay";
import { createGeoUniforms, type GeoUniforms } from "../globe/geoShader";
import { createTestLayer } from "../globe/testLayer";
import { buildReferenceOutline } from "../globe/referenceOutline";
import { measureAlignment } from "../globe/alignment";
import { measureInverseResidualGpu } from "../globe/inverseResidual";
import { shellBounds } from "../geo/mapping";
import { groundSampler } from "../geo/placement";
import { depthModeFromQuery, type GlobeDepthMode } from "../globe/depthMode";
import { VIEWS } from "../globe/viewPresets";
import { JulianDate } from "cesium";
import { SKY_KEYS, SkyDebugState, normalizeSkyValue, skyKey, type SkyKey, type SkyTarget, type SkyValue } from "../globe/skyDebug";

declare global {
  interface Window {
    __globeReady?: boolean;
    __globeApi?: GlobeApi;
  }
}

/** Debug-only (dev or ?globeDebug=1): window.__globeApi.sky, see globe/skyDebug.ts. */
interface SkyDebugApi {
  keys: readonly SkyKey[];
  set(key: string, value: unknown): unknown;
  clear(key: string): unknown;
  reset(): unknown;
  status(): unknown;
}
type GlobeApi = { [name: string]: ((...args: any[]) => unknown) | SkyDebugApi | undefined; sky?: SkyDebugApi };

const props = defineProps<{ format?: FormatDef }>();
const emit = defineEmits<{ "switch-format": [id: string] }>();

function onSwitchFormat(id: string): void {
  emit("switch-format", id);
}


const host = ref<HTMLDivElement | null>(null);
const atmos = ref<InstanceType<typeof AtmosViewer> | null>(null);
const status = ref("加载地理底座…");
const error = ref<string | null>(null);
const tileErrors = ref(0);
const tk = import.meta.env.VITE_TIANDITU_TK ?? "";
const query = new URLSearchParams(location.search);
const source = pickBasemapSource({ dev: import.meta.env.DEV, devFlag: import.meta.env.VITE_DEV_BASEMAP, query: query.get("devBasemap") });
const depthMode: GlobeDepthMode = depthModeFromQuery(location.search);
// measurement hooks only in dev or with ?globeDebug=1
const debug = import.meta.env.DEV || query.get("globeDebug") === "1";
const ui = reactive({ style: "img" as BasemapStyle, terrain: false, testLayer: false, proxy: true, k: 3 });
const themeClass = computed(() => atmos.value?.theme ?? "dark");
const LIGHT_SKY = Color.fromCssColorString("#dfe7ee");

function applySky(theme: string): void {
  if (!viewer) return;
  const light = theme === "light";
  viewer.scene.backgroundColor = light ? LIGHT_SKY : Color.BLACK;
  if (viewer.scene.skyBox) viewer.scene.skyBox.show = !light;
  if (viewer.scene.moon) viewer.scene.moon.show = !light;
  // Keep atmosphere lighting from following the sun / clock. Cesium's default
  // dynamicAtmosphereLighting is true; on a dark theme, a night-side sun can
  // paint the ground atmosphere (and the basemap under it) black. Light theme
  // already leaves atmosphere off, which is why Jayden's A/B looked fine there.
  viewer.scene.globe.dynamicAtmosphereLighting = false;
  viewer.scene.globe.dynamicAtmosphereLightingFromSun = false;
  applyNadirAtmosphere(theme);
}

/** True when the camera is looking down steeper than about 70° from the horizon. */
function isSteepLookDown(): boolean {
  if (!viewer) return false;
  if (viewer.camera.pitch < CMath.toRadians(-70)) return true;
  // Some backends report a milder pitch after lookAtTransform(IDENTITY) even
  // when the view is visually nadir; fall back to the world-space direction.
  const up = Ellipsoid.WGS84.geodeticSurfaceNormal(viewer.camera.positionWC);
  return Cartesian3.dot(viewer.camera.directionWC, up) < -Math.cos(CMath.toRadians(20));
}

/**
 * Dark theme turns on Cesium ground / sky atmosphere. Near nadir those shaders fill the view
 * and hide the basemap (reproduced under SwiftShader; light theme, which leaves atmosphere
 * off, shows the imagery at the same camera). Disable them when the view is steeper than -70°.
 * Applied in preRender so the flags are in effect for the frame that is about to draw.
 */
function applyNadirAtmosphere(theme?: string): void {
  if (!viewer) return;
  const light = (theme ?? themeClass.value) === "light";
  const steep = isSteepLookDown();
  const show = !light && !steep;
  if (viewer.scene.skyAtmosphere) viewer.scene.skyAtmosphere.show = show;
  viewer.scene.globe.showGroundAtmosphere = show;
}

watch(themeClass, (theme) => applySky(theme));


let viewer: Viewer | null = null;
let terrains: TerrainSwitch | null = null;
let removeAtmosphereTick: (() => void) | undefined;
let removeSkyDebug: (() => void) | undefined;
let outline: PolylineCollection | null = null;
let geoUniforms: GeoUniforms | null = null;
const overlay = shallowRef<GlobeOverlay | null>(null);
const geo = shallowRef<GeoFoundation | null>(null);
const volumeOptions = shallowRef<CurvedVolumeOptions | null>(null);

function setBasemap(style: BasemapStyle): void {
  ui.style = style;
  if (!viewer) return;
  applyBasemap(viewer.imageryLayers, source, style, tk);
  for (let i = 0; i < viewer.imageryLayers.length; i++) {
    viewer.imageryLayers.get(i).imageryProvider.errorEvent.addEventListener(() => tileErrors.value++);
  }
}

/** Bounding box and sphere (ENU units) of everything three draws: the shell box (plus the test curtain margin) and the depth proxy. */
function updateSphere(): void {
  if (!overlay.value || !geo.value) return;
  const { grid, map } = geo.value.meta;
  const b = shellBounds(grid, map, ui.terrain ? groundSampler(geo.value.ground) : null, ui.k, { samples: 11, marginM: 400 });
  // The depth proxy reaches 1500 m past the domain: without it in the box, a low camera just outside
  // the domain gets a near plane beyond the proxy ground in front of it, which then gets clipped.
  const proxyGeom = overlay.value.proxy.mesh.geometry;
  if (!proxyGeom.boundingBox) proxyGeom.computeBoundingBox();
  const pb = proxyGeom.boundingBox!;
  for (let c = 0; c < 3; c++) {
    b.lo[c] = Math.min(b.lo[c]!, pb.min.getComponent(c));
    b.hi[c] = Math.max(b.hi[c]!, pb.max.getComponent(c));
  }
  overlay.value.box = { min: b.lo, max: b.hi };
  const center = b.lo.map((x, i) => (x + b.hi[i]!) / 2) as [number, number, number];
  overlay.value.sphere = { center, radius: Math.hypot(...b.hi.map((x, i) => x - b.lo[i]!)) / 2 };
}

/** Terrain and k only touch uniforms, the proxy, Cesium's terrain provider and the volume's box: no data reload. */
function setTerrain(on: boolean): void {
  ui.terrain = on;
  if (!viewer || !terrains || !overlay.value || !geoUniforms) return;
  viewer.terrainProvider = terrains.provider(on);
  overlay.value.proxy.setTerrain(on);
  geoUniforms.uGeoTerrain.value = on ? 1 : 0;
  shapeChanged();
}

function clampK(k: number): number {
  const n = Number(k);
  if (!Number.isFinite(n)) return ui.k;
  return Math.min(10, Math.max(1, Math.round(n * 10) / 10));
}

/** Overlay uniforms and shell refresh immediately. Terrain provider is not rebuilt (k is not in the DEM). */
function setExaggeration(k: number): void {
  ui.k = clampK(k);
  if (geoUniforms) geoUniforms.uGeoK.value = ui.k;
  shapeChanged();
}

/** During a slider drag, hold particle place-replays; 100 ms after the last input, or on pointerup, run one. */
let exagPlaceTimer = 0;
function onExagInput(ev: Event): void {
  const v = Number((ev.target as HTMLInputElement).value);
  setExaggeration(v);
  atmos.value?.setParticlePlaceDeferred(true);
  window.clearTimeout(exagPlaceTimer);
  exagPlaceTimer = window.setTimeout(() => atmos.value?.setParticlePlaceDeferred(false), 100);
}
function onExagCommit(): void {
  window.clearTimeout(exagPlaceTimer);
  exagPlaceTimer = 0;
  atmos.value?.setParticlePlaceDeferred(false);
}

function shapeChanged(): void {
  updateSphere();
  atmos.value?.refreshShell();
  if (!outline || !geo.value) return;
  buildReferenceOutline(outline, geo.value.meta.grid, ui.terrain ? geo.value.ground : null, ui.k);
  outline.show = ui.testLayer;
}

function setTestLayer(on: boolean): void {
  ui.testLayer = on;
  if (overlay.value) overlay.value.layers.visible = on;
  if (outline) outline.show = on;
}

/** Debug: without the depth proxy (visible pass and volume occluder pass) to show what it hides. */
function setProxy(on: boolean): void {
  ui.proxy = on;
  if (overlay.value) overlay.value.proxy.mesh.visible = on;
}

function setView(name: string): void {
  if (!viewer || !geo.value) return;
  const g = geo.value.meta.grid;
  const [u, v, hd, pt, range] = VIEWS[name] ?? VIEWS.overview!;
  viewer.camera.lookAt(
    Cartesian3.fromDegrees(g.lon_min + u * (g.lon_max - g.lon_min), g.lat_min + v * (g.lat_max - g.lat_min), 0),
    new HeadingPitchRange(CMath.toRadians(hd), CMath.toRadians(pt), range),
  );
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
}

function setDepthView(range: number, pitch: number): void {
  if (!viewer || !geo.value) return;
  const g = geo.value.meta.grid;
  viewer.camera.lookAt(Cartesian3.fromDegrees((g.lon_min + g.lon_max) / 2, (g.lat_min + g.lat_max) / 2, 0), new HeadingPitchRange(0, CMath.toRadians(pitch), range));
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
}

/** ?depthFaceAgl= (debug only): a finite number of metres, otherwise the default 50 m face. */
function depthFaceAglParam(raw: string | null): number {
  const v = raw === null || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(v) ? v : 50;
}

let unmounted = false;

onMounted(async () => {
  window.__globeReady = false;
  try {
    const loaded = await loadGeoFoundation();
    // the tab may have been closed while the geo files were loading: don't build a Viewer on a detached node
    if (unmounted) return;
    geo.value = loaded;
  } catch (e) {
    if (unmounted) return;
    error.value =
      e instanceof GeoDecodeError
        ? `地理底座数据已下载，但解码失败（${geoBaseUrl()}）：${e.message}`
        : `没有地理底座数据（${geoBaseUrl()}geo.json）：先运行 python -m geopipe，见 pipeline/README.md。${String(e)}`;
    status.value = "加载失败";
    return;
  }
  try {
    start(geo.value);
  } catch (e) {
    const err = e as Error;
    error.value = `地球页初始化失败：${err.message}`;
    status.value = "初始化失败";
    console.error(err.message, err.stack);
  }
});

function start({ meta, dem, ground }: GeoFoundation): void {
  terrains = terrainSwitch(dem);
  viewer = new Viewer(host.value!, {
    baseLayer: false,
    baseLayerPicker: false,
    geocoder: false,
    timeline: false,
    animation: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    infoBox: false,
    selectionIndicator: false,
    fullscreenButton: false,
    terrainProvider: terrains.provider(false),
  });
  viewer.scene.verticalExaggeration = 1;
  setBasemap(ui.style);
  const proxy = new DepthProxy(meta.grid, meta.map, dem);
  overlay.value = new GlobeOverlay(viewer.scene, meta.map, proxy, {
    depthMode,
    onContextLost: () => {
      window.__globeReady = false;
      status.value = "WebGL 上下文丢失";
      error.value = "WebGL 上下文丢失（显卡重置或显存不足），请刷新页面。";
    },
  });
  geoUniforms = createGeoUniforms(meta.map, ground);
  overlay.value.layers.add(createTestLayer(meta.map, geoUniforms, meta.grid.top_m, debug ? depthFaceAglParam(query.get("depthFaceAgl")) : 50));
  overlay.value.layers.visible = ui.testLayer;
  outline = viewer.scene.primitives.add(new PolylineCollection());
  volumeOptions.value = { map: meta.map, grid: meta.grid, ground, geo: geoUniforms, dem };
  setExaggeration(ui.k);
  setTerrain(ui.terrain);
  setView("overview");
  applySky(themeClass.value);
  removeAtmosphereTick = viewer.scene.preRender.addEventListener(() => applyNadirAtmosphere());
  status.value = "就绪";
  exposeApi(meta, ground);
  window.__globeReady = true;
}

function exposeApi(meta: GeoFoundation["meta"], ground: GeoFoundation["ground"]): void {
  const o = overlay.value!;
  window.__globeApi = {
    setTerrain: (on: boolean) => setTerrain(on),
    setBasemap: (s: BasemapStyle) => setBasemap(s),
    setExaggeration: (k: number) => setExaggeration(k),
    setTestLayer: (on: boolean) => setTestLayer(on),
    setProxy: (on: boolean) => setProxy(on),
    setSlices: (on: boolean) => o.layers.traverse((x) => { if (x.name === "slice") x.visible = on; }),
    setView: (name: string) => setView(name),
    tilesLoaded: () => viewer!.scene.globe.tilesLoaded,
    measureAlignment: () => measureAlignment(viewer!.scene, o.camera, o.sync, meta.grid, meta.map, ui.terrain ? ground : null, ui.k),
    camera: () => ({ near: o.camera.near, far: o.camera.far, fov: o.camera.fov, aspect: o.camera.aspect, sphere: o.sphere, box: o.box, camEnu: o.sync.cameraEnu(viewer!.camera) }),
    status: () => ({ ...ui, source, depthMode, depthEncoding: o.depthEncoding, decodeMs: lastDecodeMs, decodeWhere: lastDecodeWhere, tileErrors: tileErrors.value, drawCalls: o.drawCalls, residualFromPipeline: meta.map.residual_m }),
  };
  if (!debug) return;
  Object.assign(window.__globeApi, {
    // on: only the 50 m (or ?depthFaceAgl=) AGL face is drawn so its pixels can be counted
    setDepthTestFace: (on: boolean) => {
      o.layers.traverse((x) => { if (x.parent?.name === "globe-test-layer") x.visible = x.name === "depth-test-face" ? on : !on; });
      if (outline) outline.show = !on && ui.testLayer;
    },
    setDepthView: (range: number, pitch: number) => setDepthView(range, pitch),
    nudgeCamera: (right: number, up: number) => { viewer!.camera.moveRight(right); viewer!.camera.moveUp(up); },
    measureInverseResidual: (opts: { samples?: number } = {}) => {
      let r: unknown = null;
      o.resyncAfter(() => { r = measureInverseResidualGpu(o.renderer, meta.grid, meta.map, geoUniforms!, opts.samples ?? 101); });
      return r;
    },
    benchFrames: (n = 30) => o.benchFrames(n),
    volumeInfo: () => ({ ...atmos.value?.globeVolumeInfo(), depthEncoding: o.depthEncoding, k: ui.k, terrain: ui.terrain, near: o.camera.near, far: o.camera.far }),
    sky: skyDebugApi(viewer!),
  });
}

/**
 * Sticky sky / atmosphere overrides for bisecting the dark top-view black basemap on a real GPU.
 * The app rewrites atmosphere each frame (postUpdate today, preRender in #24) and background /
 * skyBox / moon on theme change; these listeners are registered after the app's, on both
 * postUpdate and preRender, so the table is the last word right before Cesium draws.
 */
function skyDebugApi(v: Viewer): SkyDebugApi {
  const scene = v.scene;
  const colors = new Map<string, Color>();
  const cssColor = (css: string) => {
    let c = colors.get(css);
    if (!c) {
      c = Color.fromCssColorString(css);
      if (c) colors.set(css, c);
    }
    return c;
  };
  const target: SkyTarget = {
    read: (k) => {
      switch (k) {
        case "skyAtmosphere": return scene.skyAtmosphere?.show;
        case "groundAtmosphere": return scene.globe.showGroundAtmosphere;
        case "skyBox": return scene.skyBox?.show;
        case "moon": return scene.moon?.show;
        case "backgroundColor": return scene.backgroundColor.toCssHexString();
        case "dynamicAtmosphereLighting": return scene.globe.dynamicAtmosphereLighting;
        case "dynamicAtmosphereLightingFromSun": return scene.globe.dynamicAtmosphereLightingFromSun;
      }
    },
    write: (k, x: SkyValue) => {
      switch (k) {
        case "skyAtmosphere": if (scene.skyAtmosphere) scene.skyAtmosphere.show = x as boolean; break;
        case "groundAtmosphere": scene.globe.showGroundAtmosphere = x as boolean; break;
        case "skyBox": if (scene.skyBox) scene.skyBox.show = x as boolean; break;
        case "moon": if (scene.moon) scene.moon.show = x as boolean; break;
        case "backgroundColor": scene.backgroundColor = cssColor(x as string) ?? scene.backgroundColor; break;
        case "dynamicAtmosphereLighting": scene.globe.dynamicAtmosphereLighting = x as boolean; break;
        case "dynamicAtmosphereLightingFromSun": scene.globe.dynamicAtmosphereLightingFromSun = x as boolean; break;
      }
    },
  };
  const state = new SkyDebugState();
  let frame = 0;
  let lastFrame: { frame: number; pitchDeg: number } | null = null;
  let lastRendered: Record<SkyKey, SkyValue | null> | null = null;
  const apply = () => {
    if (Object.keys(state.overrides).length) state.apply(target);
  };
  const offPostUpdate = scene.postUpdate.addEventListener(apply);
  const offPreRender = scene.preRender.addEventListener(() => {
    frame++;
    lastFrame = { frame, pitchDeg: CMath.toDegrees(v.camera.pitch) };
    apply();
  });
  // what the frame that was just drawn actually used
  const offPostRender = scene.postRender.addEventListener(() => { lastRendered = state.read(target); });
  removeSkyDebug = () => { offPostUpdate(); offPreRender(); offPostRender(); };

  const status = () => {
    const cam = v.camera;
    return {
      ...state.read(target),
      pitchDeg: CMath.toDegrees(cam.pitch),
      headingDeg: CMath.toDegrees(cam.heading),
      heightM: cam.positionCartographic.height,
      lastFrame,
      lastRendered,
      enableLighting: scene.globe.enableLighting,
      clockUtc: JulianDate.toDate(v.clock.currentTime).toISOString(),
      globeShow: scene.globe.show,
      tilesLoaded: scene.globe.tilesLoaded,
      theme: themeClass.value,
      overrides: { ...state.overrides },
      saved: { ...state.saved },
      appliedFrames: state.applied,
    };
  };
  return {
    keys: SKY_KEYS,
    set: (key, value) => {
      const k = skyKey(key);
      state.set(k, normalizeSkyValue(k, value, (css) => cssColor(css) !== undefined), target);
      scene.requestRender();
      return status();
    },
    clear: (key) => {
      state.clear(skyKey(key), target);
      applySky(themeClass.value);
      state.apply(target); // the keys still overridden win over applySky
      scene.requestRender();
      return status();
    },
    reset: () => {
      state.reset(target);
      // let the app's own theme / nadir logic decide again
      applySky(themeClass.value);
      scene.requestRender();
      return status();
    },
    status,
  };
}

onBeforeUnmount(() => {
  unmounted = true;
  window.__globeReady = false;
  delete window.__globeApi;
});

/** AtmosViewer's own onBeforeUnmount runs after this component's; tear the globe down after the layers. */
function teardown(): void {
  window.clearTimeout(exagPlaceTimer);
  exagPlaceTimer = 0;
  const canvas = viewer?.scene?.canvas;
  const gl = canvas?.getContext("webgl2") ?? canvas?.getContext("webgl");
  removeAtmosphereTick?.();
  removeAtmosphereTick = undefined;
  removeSkyDebug?.();
  removeSkyDebug = undefined;
  overlay.value?.dispose();
  viewer?.destroy();
  const lose = gl?.getExtension("WEBGL_lose_context");
  if (lose && gl && !gl.isContextLost()) lose.loseContext();
  geoUniforms?.uGeoGround.value.dispose();
  overlay.value = null;
  viewer = null;
  outline = null;
  terrains = null;
  geoUniforms = null;
}
onUnmounted(teardown);
</script>

<template>
  <div class="globe" :class="themeClass">
    <div ref="host" class="globe-host" />
    <AtmosViewer
      v-if="overlay && volumeOptions"
      ref="atmos"
      :format="props.format"
      :globe-volume="volumeOptions"
      :create-host="() => overlay!"
    />
    <aside class="globe-panel">
      <GlobeFormatSwitch :model-value="props.format?.id ?? ''" @update:model-value="onSwitchFormat" />
      <div class="row">
        <span>底图</span>
        <button type="button" :class="{ on: ui.style === 'img' }" @click="setBasemap('img')">影像</button>
        <button type="button" :class="{ on: ui.style === 'vec' }" @click="setBasemap('vec')">矢量</button>
      </div>
      <label class="row"><input type="checkbox" :checked="ui.terrain" @change="setTerrain(($event.target as HTMLInputElement).checked)" /> 地形（自建 DEM）</label>
      <label class="exag">
        垂直夸张 {{ ui.k.toFixed(1) }}×
        <input
          type="range"
          min="1"
          max="10"
          step="0.1"
          :value="ui.k"
          @input="onExagInput"
          @pointerup="onExagCommit"
          @pointercancel="onExagCommit"
          @change="onExagCommit"
        />
      </label>
      <label class="row"><input type="checkbox" :checked="ui.testLayer" @change="setTestLayer(($event.target as HTMLInputElement).checked)" /> 对齐测试图层</label>
      <div class="row">
        <span>视角</span>
        <button type="button" @click="setView('overview')">总览</button>
        <button type="button" @click="setView('corner')">西南角</button>
        <button type="button" @click="setView('top')">俯视</button>
      </div>
      <p v-if="source === 'esri-dev'" class="warn">开发用 Esri 影像（仅 vite dev），正式版用天地图</p>
      <p v-else-if="!tk" class="warn">没有配置 VITE_TIANDITU_TK，天地图瓦片会加载失败</p>
      <p v-if="tileErrors > 0" class="warn">底图瓦片失败 {{ tileErrors }} 次</p>
      <p class="muted">{{ status }}</p>
    </aside>
    <p v-if="error" class="globe-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.globe {
  position: relative;
  width: 100%;
  height: 100%;
}
.globe-host {
  position: absolute;
  inset: 0;
}
.globe-host :deep(.cesium-credit-logoContainer) {
  display: none !important;
}
/* left of AtmosViewer's 300 px panel (right: 14px) */
.globe-panel {
  position: absolute;
  top: 14px;
  right: 328px;
  width: 210px;
  padding: 10px 12px;
  background: rgba(8, 16, 28, 0.88);
  border: 1px solid rgba(120, 170, 200, 0.22);
  border-radius: 6px;
  font-size: 13px;
  z-index: 10;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0;
}
.exag {
  display: block;
  margin: 6px 0;
}
.exag input {
  display: block;
  width: 100%;
  margin: 3px 0 0;
  accent-color: #5fd3e6;
}
.globe.light .exag input {
  accent-color: #0f8aa3;
}
.row button {
  background: transparent;
  border: 1px solid rgba(120, 170, 200, 0.3);
  color: #87a3b5;
  border-radius: 4px;
  padding: 1px 8px;
}
.row button.on {
  color: #e7f2f8;
  border-color: #5fd3e6;
}
.warn {
  color: #f5c46b;
  margin: 6px 0;
}
.muted {
  color: #87a3b5;
  margin: 6px 0 0;
}
.globe-error {
  position: absolute;
  left: 50%;
  top: 40%;
  transform: translateX(-50%);
  max-width: 560px;
  color: #f5c46b;
}

.globe.light .globe-panel {
  background: rgba(250, 252, 255, 0.93);
  border-color: rgba(60, 90, 110, 0.2);
  color: #1c2d3a;
}
.globe.light .row button {
  color: #5d7384;
  border-color: rgba(60, 90, 110, 0.3);
}
.globe.light .row button.on {
  color: #1c2d3a;
  border-color: #0f8aa3;
}
.globe.light .muted {
  color: #5d7384;
}
.globe.light .globe-panel select,
.globe.light .globe-panel input[type="checkbox"] {
  color: #1c2d3a;
  background: #f7fafc;
  accent-color: #0f8aa3;
  border: 1px solid rgba(60, 90, 110, 0.35);
}
.globe.light .globe-panel select {
  border-radius: 4px;
  padding: 1px 4px;
}
.globe.light .warn {
  color: #9a6b12;
}
</style>
