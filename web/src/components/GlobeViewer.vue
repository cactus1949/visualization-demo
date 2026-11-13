<script setup lang="ts">
/**
 * Third tab "地球": Cesium globe (Tianditu imagery, optional self-built terrain) with a three.js
 * overlay in the same WebGL context. PR ① only has the geo foundation and an alignment test layer;
 * the data layers move here in later PRs.
 */
import { onBeforeUnmount, onMounted, reactive, ref, shallowRef } from "vue";
import { Cartesian3, HeadingPitchRange, Math as CMath, Matrix4, PolylineCollection, Viewer } from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import { geoBaseUrl, loadGeoFoundation, type GeoFoundation } from "../geo/geoData";
import { applyBasemap } from "../globe/basemap";
import { pickBasemapSource, type BasemapStyle } from "../globe/basemapChoice";
import { terrainSwitch, type TerrainSwitch } from "../globe/terrain";
import { DepthProxy } from "../globe/depthProxy";
import { GlobeOverlay } from "../globe/overlay";
import { createGeoUniforms, type GeoUniforms } from "../globe/geoShader";
import { createTestLayer } from "../globe/testLayer";
import { buildReferenceOutline } from "../globe/referenceOutline";
import { measureAlignment } from "../globe/alignment";
import { enuFrameAt, exactEnu } from "../geo/mapping";

declare global {
  interface Window {
    __globeReady?: boolean;
    __globeApi?: Record<string, (...args: any[]) => unknown>;
  }
}

const host = ref<HTMLDivElement | null>(null);
const status = ref("加载地理底座…");
const error = ref<string | null>(null);
const tileErrors = ref(0);
const tk = import.meta.env.VITE_TIANDITU_TK ?? "";
const source = pickBasemapSource({
  dev: import.meta.env.DEV,
  devFlag: import.meta.env.VITE_DEV_BASEMAP,
  query: new URLSearchParams(location.search).get("devBasemap"),
});
const ui = reactive({ style: "img" as BasemapStyle, terrain: false, testLayer: true, proxy: true, k: 1 });
const EXAGGERATIONS = [1, 3, 5, 10];

let viewer: Viewer | null = null;
let overlay: GlobeOverlay | null = null;
let terrains: TerrainSwitch | null = null;
let outline: PolylineCollection | null = null;
let geoUniforms: GeoUniforms | null = null;
const geo = shallowRef<GeoFoundation | null>(null);

function setBasemap(style: BasemapStyle): void {
  ui.style = style;
  if (!viewer) return;
  applyBasemap(viewer.imageryLayers, source, style, tk);
  for (let i = 0; i < viewer.imageryLayers.length; i++) {
    viewer.imageryLayers.get(i).imageryProvider.errorEvent.addEventListener(() => tileErrors.value++);
  }
}

/** Bounding sphere (ENU units) of everything three draws: domain from below the curtain to the exaggerated top, plus proxy margin. */
function updateSphere(): void {
  if (!overlay || !geo.value) return;
  const { grid, map } = geo.value.meta;
  const frame = enuFrameAt(map.lon0, map.lat0);
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const u of [-0.1, 0.5, 1.1]) for (const v of [-0.1, 0.5, 1.1]) for (const h of [-400, ui.k * grid.top_m + 50]) {
    const p = exactEnu(grid, frame, u, v, h);
    for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c]!, p[c]!); hi[c] = Math.max(hi[c]!, p[c]!); }
  }
  const s = map.enu_unit_m;
  const center: [number, number, number] = [(lo[0]! + hi[0]!) / 2 / s, (lo[1]! + hi[1]!) / 2 / s, (lo[2]! + hi[2]!) / 2 / s];
  overlay.sphere = { center, radius: Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) / 2 / s };
}

function setTerrain(on: boolean): void {
  ui.terrain = on;
  if (!viewer || !terrains || !overlay || !geoUniforms || !geo.value) return;
  viewer.terrainProvider = terrains.provider(on);
  overlay.proxy.setTerrain(on);
  geoUniforms.uGeoTerrain.value = on ? 1 : 0;
  refreshOutline();
}

function setExaggeration(k: number): void {
  ui.k = k;
  if (geoUniforms) geoUniforms.uGeoK.value = k;
  updateSphere();
  refreshOutline();
}

function refreshOutline(): void {
  if (!outline || !geo.value) return;
  buildReferenceOutline(outline, geo.value.meta.grid, ui.terrain ? geo.value.ground : null, ui.k);
  outline.show = ui.testLayer;
}

function setTestLayer(on: boolean): void {
  ui.testLayer = on;
  if (overlay) overlay.layers.visible = on;
  if (outline) outline.show = on;
}

/** Debug only: draw without the depth proxy to show what it hides. */
function setProxy(on: boolean): void {
  ui.proxy = on;
  if (overlay) overlay.proxy.mesh.visible = on;
}

const VIEWS: Record<string, [number, number, number, number, number]> = {
  // [u, v, heading°, pitch°, range m]
  overview: [0.5, 0.5, 20, -35, 32000],
  corner: [0, 0, 45, -12, 2500],
  top: [0.5, 0.5, 0, -89.9, 30000],
  curtain: [0.5, 0.5, 0, -12, 6000],
};

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

onMounted(async () => {
  window.__globeReady = false;
  try {
    geo.value = await loadGeoFoundation();
  } catch (e) {
    error.value = `没有地理底座数据（${geoBaseUrl()}geo.json）：先运行 python -m geopipe，见 pipeline/README.md。${String(e)}`;
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
  overlay = new GlobeOverlay(viewer.scene, meta.map, proxy);
  geoUniforms = createGeoUniforms(meta.map, ground);
  overlay.layers.add(createTestLayer(meta.map, geoUniforms, meta.grid.top_m));
  outline = viewer.scene.primitives.add(new PolylineCollection());
  setExaggeration(ui.k);
  setTerrain(ui.terrain);
  setView("overview");
  status.value = "就绪";

  window.__globeApi = {
    setTerrain: (on: boolean) => setTerrain(on),
    setBasemap: (s: BasemapStyle) => setBasemap(s),
    setExaggeration: (k: number) => setExaggeration(k),
    setTestLayer: (on: boolean) => setTestLayer(on),
    setProxy: (on: boolean) => setProxy(on),
    setSlices: (on: boolean) => overlay!.layers.traverse((o) => { if (o.name === "slice") o.visible = on; }),
    setView: (name: string) => setView(name),
    tilesLoaded: () => viewer!.scene.globe.tilesLoaded,
    measureAlignment: () =>
      measureAlignment(viewer!.scene, overlay!.camera, overlay!.sync, meta.grid, meta.map, ui.terrain ? ground : null, ui.k),
    camera: () => ({ near: overlay!.camera.near, far: overlay!.camera.far, fov: overlay!.camera.fov, aspect: overlay!.camera.aspect, sphere: overlay!.sphere, camEnu: overlay!.sync.cameraEnu(viewer!.camera) }),
    status: () => ({ ...ui, source, tileErrors: tileErrors.value, drawCalls: overlay?.drawCalls, residualFromPipeline: meta.map.residual_m }),
  };
  window.__globeReady = true;
}

onBeforeUnmount(() => {
  window.__globeReady = false;
  delete window.__globeApi;
  overlay?.dispose();
  viewer?.destroy();
  geoUniforms?.uGeoGround.value.dispose();
});
</script>

<template>
  <div class="globe">
    <div ref="host" class="globe-host" />
    <aside class="globe-panel">
      <div class="row">
        <span>底图</span>
        <button type="button" :class="{ on: ui.style === 'img' }" @click="setBasemap('img')">影像</button>
        <button type="button" :class="{ on: ui.style === 'vec' }" @click="setBasemap('vec')">矢量</button>
      </div>
      <label class="row"><input type="checkbox" :checked="ui.terrain" @change="setTerrain(($event.target as HTMLInputElement).checked)" /> 地形（自建 DEM）</label>
      <label class="row">
        垂直夸张
        <select :value="ui.k" @change="setExaggeration(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="k in EXAGGERATIONS" :key="k" :value="k">{{ k }}×</option>
        </select>
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
.globe-panel {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 230px;
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
</style>
