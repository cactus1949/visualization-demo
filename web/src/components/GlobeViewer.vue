<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import { Cartesian3, HeadingPitchRange, Math as CMath, Matrix4, PolylineCollection, Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import AtmosViewer, { type GlobeVolumeOptions } from "./AtmosViewer.vue";
import type { FormatDef } from "../formats/types";
import { geoBaseUrl, loadGeoFoundation, type GeoFoundation } from "../geo/geoData";
import { applyBasemap } from "../globe/basemap";
import { pickBasemapSource, type BasemapStyle } from "../globe/basemapChoice";
import { terrainSwitch, type TerrainSwitch } from "../globe/terrain";
import { DepthProxy } from "../globe/depthProxy";
import { createCesiumHost, type GlobeOverlay } from "../globe/overlay";
import { buildReferenceOutline } from "../globe/referenceOutline";
import { measureAlignment } from "../globe/alignment";
import { enuFrameAt, exactEnu, polyInverse, type GeoMap } from "../geo/mapping";

declare global {
  interface Window {
    __globeApi?: Record<string, (...args: any[]) => unknown>;
    __atmosApi?: Record<string, (...args: any[]) => unknown>;
  }
}

const props = defineProps<{ format: FormatDef }>();
const host = ref<HTMLDivElement | null>(null);
const status = ref("加载地理底座…");
const error = ref<string | null>(null);
const tileErrors = ref(0);
const ready = ref(false);
const source = pickBasemapSource({ dev: import.meta.env.DEV, devFlag: import.meta.env.VITE_DEV_BASEMAP, query: new URLSearchParams(location.search).get("devBasemap") });
const tk = import.meta.env.VITE_TIANDITU_TK ?? "";
const ui = reactive({ style: "img" as BasemapStyle, terrain: false, testLayer: false, proxy: true, k: 1 });
const EXAGGERATIONS = [1, 3, 5, 10];

let viewer: Viewer | null = null;
let overlay: GlobeOverlay | null = null;
let terrains: TerrainSwitch | null = null;
let outline: PolylineCollection | null = null;
const geo = shallowRef<GeoFoundation | null>(null);
const globeVolume = shallowRef<GlobeVolumeOptions | null>(null);
let unmounted = false;

function setBasemap(style: BasemapStyle): void {
  ui.style = style;
  if (!viewer) return;
  applyBasemap(viewer.imageryLayers, source, style, tk);
  for (let i = 0; i < viewer.imageryLayers.length; i++) viewer.imageryLayers.get(i).imageryProvider.errorEvent.addEventListener(() => tileErrors.value++);
}

function updateSphere(): void {
  if (!overlay || !geo.value) return;
  const { grid, map } = geo.value.meta;
  const frame = enuFrameAt(map.lon0, map.lat0);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const u of [0, 0.5, 1]) for (const v of [0, 0.5, 1]) for (const h of [0, ui.k * grid.top_m]) {
    const p = exactEnu(grid, frame, u, v, h);
    for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c]!, p[c]!); hi[c] = Math.max(hi[c]!, p[c]!); }
  }
  const s = map.enu_unit_m;
  overlay.sphere = { center: [(lo[0]! + hi[0]!) / 2 / s, (lo[1]! + hi[1]!) / 2 / s, (lo[2]! + hi[2]!) / 2 / s], radius: Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2 / s };
}

function setTerrain(on: boolean): void {
  ui.terrain = on;
  if (!viewer || !terrains || !overlay || !geo.value) return;
  viewer.terrainProvider = terrains.provider(on);
  overlay.proxy.setTerrain(on);
  if (globeVolume.value) globeVolume.value.terrain = on;
  updateSphere();
  refreshOutline();
}
function setExaggeration(k: number): void {
  ui.k = k;
  if (globeVolume.value) globeVolume.value.k = k;
  updateSphere();
  refreshOutline();
}
function refreshOutline(): void {
  if (!outline || !geo.value) return;
  buildReferenceOutline(outline, geo.value.meta.grid, ui.terrain ? geo.value.ground : null, ui.k);
  outline.show = ui.testLayer;
}
function setTestLayer(on: boolean): void { ui.testLayer = on; if (overlay) overlay.layers.visible = on; if (outline) outline.show = on; }
function setProxy(on: boolean): void { ui.proxy = on; if (overlay) overlay.proxy.mesh.visible = on; }

const VIEWS: Record<string, [number, number, number, number, number]> = { overview: [0.5, 0.5, 20, -35, 32000], corner: [0, 0, 45, -12, 2500], top: [0.5, 0.5, 0, -89.9, 30000], curtain: [0.5, 0.5, 0, -12, 6000] };
function setView(name: string): void {
  if (!viewer || !geo.value) return;
  const g = geo.value.meta.grid;
  const [u, v, hd, pt, range] = VIEWS[name] ?? VIEWS.overview!;
  viewer.camera.lookAt(Cartesian3.fromDegrees(g.lon_min + u * (g.lon_max - g.lon_min), g.lat_min + v * (g.lat_max - g.lat_min), 0), new HeadingPitchRange(CMath.toRadians(hd), CMath.toRadians(pt), range));
  viewer.camera.lookAtTransform(Matrix4.IDENTITY);
}

function measureInverseResidual(meta: GeoFoundation["meta"], samples: number): Record<string, unknown> {
  const { grid, map } = meta;
  const frame = enuFrameAt(map.lon0, map.lat0);
  const errors: number[] = [];
  let worst = { u: 0, v: 0, h: 0 };
  let max = -1;
  for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++) for (const h of [-50, 0, 500, 1000, 3000, 5000, 10000]) {
    const u = i / Math.max(1, samples - 1), v = j / Math.max(1, samples - 1);
    const e = exactEnu(grid, frame, u, v, h);
    const inv = polyInverse(map, e);
    const back = exactEnu(grid, frame, inv.u, inv.v, inv.h);
    const err = Math.hypot(back[0] - e[0], back[1] - e[1], back[2] - e[2]);
    errors.push(err);
    if (err > max) { max = err; worst = { u, v, h }; }
  }
  errors.sort((a, b) => a - b);
  const percentile = (p: number) => errors[Math.min(errors.length - 1, Math.floor((errors.length - 1) * p))] ?? 0;
  return { count: errors.length, max_m: max, p50: percentile(0.5), p90: percentile(0.9), p99: percentile(0.99), mean: errors.reduce((a, b) => a + b, 0) / Math.max(1, errors.length), worst };
}

function start({ meta, dem, ground }: GeoFoundation): void {
  terrains = terrainSwitch(dem);
  viewer = new Viewer(host.value!, { baseLayer: false, baseLayerPicker: false, geocoder: false, timeline: false, animation: false, homeButton: false, sceneModePicker: false, navigationHelpButton: false, infoBox: false, selectionIndicator: false, fullscreenButton: false, terrainProvider: terrains.provider(false) });
  viewer.scene.verticalExaggeration = 1;
  setBasemap(ui.style);
  const proxy = new DepthProxy(meta.grid, meta.map, dem);
  overlay = createCesiumHost(viewer.scene, meta.map, proxy, () => { ready.value = false; status.value = "WebGL 上下文丢失"; error.value = "WebGL 上下文丢失（显卡重置或显存不足），请刷新页面。"; });
  globeVolume.value = reactive({ map: meta.map, grid: meta.grid, ground, terrain: ui.terrain, k: ui.k });
  outline = viewer.scene.primitives.add(new PolylineCollection());
  setExaggeration(ui.k); setTerrain(ui.terrain); setView("overview");
  ready.value = true; status.value = "就绪";
  window.__globeApi = {
    setTerrain, setBasemap, setExaggeration, setTestLayer, setProxy,
    setView, tilesLoaded: () => viewer!.scene.globe.tilesLoaded,
    measureAlignment: () => measureAlignment(viewer!.scene, overlay!.camera, overlay!.sync, meta.grid, meta.map, ui.terrain ? ground : null, ui.k),
    measureInverseResidual: (opts?: { samples?: number }) => measureInverseResidual(meta, opts?.samples ?? 101),
    benchFrames: (n: number) => overlay!.benchFrames(n),
    setVolumeSteps: (n: number) => window.__atmosApi?.setVolumeSteps?.(n),
    volumeInfo: () => ({ aabb: overlay!.sphere, steps: Number(new URLSearchParams(location.search).get("volSteps") ?? 128), depthMode: overlay!.depthEncoding, k: ui.k, terrain: ui.terrain }),
    camera: () => ({ near: overlay!.camera.near, far: overlay!.camera.far, fov: overlay!.camera.fov, aspect: overlay!.camera.aspect, sphere: overlay!.sphere, camEnu: overlay!.sync.cameraEnu(viewer!.camera) }),
    status: () => ({ ...ui, source, tileErrors: tileErrors.value, drawCalls: overlay?.drawCalls, residualFromPipeline: meta.map.residual_m }),
  };
}

onMounted(async () => {
  try {
    const loaded = await loadGeoFoundation();
    if (unmounted) return;
    geo.value = loaded;
    start(loaded);
  } catch (e) {
    if (unmounted) return;
    error.value = `地球页初始化失败：${String(e)}`;
    status.value = "加载失败";
  }
});
onBeforeUnmount(() => {
  unmounted = true; ready.value = false; delete window.__globeApi;
  overlay?.dispose(); viewer?.destroy(); overlay = null; viewer = null; outline = null; terrains = null; globeVolume.value = null;
});
</script>

<template>
  <div class="globe">
    <div ref="host" class="globe-host" />
    <AtmosViewer v-if="ready && overlay && globeVolume" class="globe-atmos" :format="props.format" :show-panel="true" :globe-mode="true" :globe-volume="globeVolume" :create-host="() => overlay!" />
    <aside class="globe-panel">
      <div class="row"><span>底图</span><button type="button" :class="{ on: ui.style === 'img' }" @click="setBasemap('img')">影像</button><button type="button" :class="{ on: ui.style === 'vec' }" @click="setBasemap('vec')">矢量</button></div>
      <label class="row"><input type="checkbox" :checked="ui.terrain" @change="setTerrain(($event.target as HTMLInputElement).checked)" /> 地形（自建 DEM）</label>
      <label class="row">垂直夸张<select :value="ui.k" @change="setExaggeration(Number(($event.target as HTMLSelectElement).value))"><option v-for="k in EXAGGERATIONS" :key="k" :value="k">{{ k }}×</option></select></label>
      <label class="row"><input type="checkbox" :checked="ui.testLayer" @change="setTestLayer(($event.target as HTMLInputElement).checked)" /> 对齐测试图层</label>
      <label class="row"><input type="checkbox" :checked="ui.proxy" @change="setProxy(($event.target as HTMLInputElement).checked)" /> 地形代理调试</label>
      <div class="row"><span>视角</span><button type="button" @click="setView('overview')">总览</button><button type="button" @click="setView('corner')">西南角</button><button type="button" @click="setView('top')">俯视</button></div>
      <p v-if="source === 'esri-dev'" class="warn">开发用 Esri 影像（仅 vite dev）</p><p v-else-if="!tk" class="warn">没有配置 VITE_TIANDITU_TK</p><p v-if="tileErrors > 0" class="warn">底图瓦片失败 {{ tileErrors }} 次</p><p class="muted">{{ status }}</p>
    </aside>
    <p v-if="error" class="globe-error">{{ error }}</p>
  </div>
</template>

<style scoped>
.globe { position: relative; width: 100%; height: 100%; }
.globe-host { position: absolute; inset: 0; }
.globe-host :deep(.cesium-credit-logoContainer) { display: none !important; }
.globe-atmos { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
.globe-atmos :deep(.canvas), .globe-atmos :deep(.hud), .globe-atmos :deep(.legends), .globe-atmos :deep(.panel), .globe-atmos :deep(.open-panel) { pointer-events: auto; }
.globe-panel { position: absolute; top: 10px; right: 10px; width: 230px; padding: 10px 12px; background: rgba(8,16,28,.88); border: 1px solid rgba(120,170,200,.22); border-radius: 6px; font-size: 13px; z-index: 10; }
.row { display: flex; align-items: center; gap: 6px; margin: 6px 0; }
.row button { background: transparent; border: 1px solid rgba(120,170,200,.3); color: #87a3b5; border-radius: 4px; padding: 1px 8px; }
.row button.on { color: #e7f2f8; border-color: #5fd3e6; }
.warn { color: #f5c46b; margin: 6px 0; }.muted { color: #87a3b5; margin: 6px 0 0; }.globe-error { position: absolute; left: 50%; top: 40%; transform: translateX(-50%); max-width: 560px; color: #f5c46b; }
</style>
