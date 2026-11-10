<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Manifest, VariableMeta } from "../data/manifest";
import { DataStore } from "../data/store";
import { AtmosScene, field2D, type Theme } from "../render/scene";
import { FieldTextures, floatRange, domainOf, textureUploadMs, type Domain } from "../render/fields";
import { HorizontalSlice, VerticalSection, type ScalarBinding } from "../render/slices";
import { VolumeLayer } from "../render/volume";
import { DEFAULT_CUTS, clampCuts, cutBounds, type CutState } from "../render/cuts";
import { PolylineSection } from "../render/sections/polyline";
import { AxisSection } from "../render/sections/planes";
import { BoxStack, type BoxStackParams } from "../render/sections/boxStack";
import type { SectionKind } from "../render/sections/types";
import { buildCompositeSurfaces, type CompositeSurface } from "../render/sections/composite";
import { sampleUnfolded, type UnfoldedGrid } from "../render/sections/unfolded";
import { Buildings } from "../render/buildings";
import { ProbeMarker } from "../render/probeMarker";
import { AnnotationLayer, HeightOccluder } from "../render/annotations";
import {
  DEFAULT_PARTICLES,
  WindParticles,
  type ColorMode,
  type ParticleParams,
} from "../render/particles";
import { COLORMAPS, COLORMAP_LABELS, DIVERGING } from "../render/colormaps";
import ColorLegend from "./ColorLegend.vue";
import ProfileChart from "./ProfileChart.vue";
import RangeSlider from "./RangeSlider.vue";
import UnfoldedPlot from "./UnfoldedPlot.vue";

const props = withDefaults(defineProps<{ manifestUrl?: string; showPanel?: boolean }>(), {
  manifestUrl: "/data/lowair_atmos/manifest.json",
  showPanel: true,
});
const emit = defineEmits<{
  ready: [{ backend: string }];
  probe: [Record<string, unknown>];
}>();

const query = new URLSearchParams(location.search);
const embed = query.has("embed") && query.get("embed") !== "0";
const MAX_SPEED = 25; // m/s, scale of the derived speed byte
const SPEED = "speed";

// ---------------------------------------------------------------- reactive UI state
const canvas = ref<HTMLCanvasElement>();
const manifest = shallowRef<Manifest>();
const panelOpen = ref(props.showPanel && !embed);
const status = ref("加载数据清单…");
const gpu = ref("");
const fps = ref(0);
const drawCalls = ref(0);
const loadMs = reactive<Record<string, number>>({});
const uploadMs: Record<string, number> = {};

function recordUpload(name: string, ms: number): void {
  if (uploadMs[name] !== undefined) return;
  uploadMs[name] = ms;
  publishTimings();
}

let firstFrameMsValue: number | undefined;
function publishTimings(extra: Record<string, unknown> = {}) {
  const started = (window as any).__atmosStart as number | undefined;
  const files = store?.fileTimings ? { ...store.fileTimings } : {};
  const fetchDone = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.fetchMs]));
  const decodeDone = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.decodeMs]));
  if (typeof extra.firstFrameMs === "number") firstFrameMsValue = extra.firstFrameMs;
  const payload = {
    start: started ?? 0,
    now: performance.now(),
    sinceStartMs: started !== undefined ? performance.now() - started : undefined,
    manifestMs: loadMs.manifest,
    manifestFetchMs: store?.manifestFetchMs ?? undefined,
    buildingsMs: loadMs.buildings,
    files,
    fetchMs: fetchDone,
    decodeMs: decodeDone,
    uploadMs: { ...textureUploadMs, ...uploadMs },
    loadMs: { ...loadMs },
    firstFrameMs: firstFrameMsValue,
    ...extra,
  };
  (window as any).__atmosTimings = payload;
  return payload;
}

const buildingsInfo = ref("加载中…");
const speedRange = ref<[number, number]>([0, 15]);

const view = reactive({ exaggeration: 3, theme: "dark" as Theme, shadows: true });
const layers = reactive({
  buildings: true,
  buildingOpacity: 1,
  ground: true,
  groundVar: "speed0",
  particles: true,
  volume: false,
  volumeVar: "tke",
  volumeOpacity: 0.6,
  volumeThreshold: 0.2,
  volumeFilterMin: 0,
  volumeFilterMax: 1,
  filterSlices: false,
  probe: false,
  probeFollowMouse: false,
});
const particleParams = reactive<ParticleParams>({ ...DEFAULT_PARTICLES });
const slice = reactive({
  enabled: false,
  variable: SPEED,
  heightM: 150,
  colormap: "viridis",
  autoRange: true,
  min: 0,
  max: 15,
  opacity: 0.85,
  contours: 12,
});
const section = reactive({
  enabled: false,
  kind: "lon" as SectionKind,
  drawMode: false,
  variable: SPEED,
  offsetKm: 0,
  azimuthDeg: 0,
  colormap: "viridis",
  autoRange: true,
  min: 0,
  max: 15,
  opacity: 0.85,
  contours: 12,
  points: [] as { x: number; z: number }[],
  box: {
    x0: 0, z0: 0, x1: 0, z1: 0,
    heightMinM: 0, heightMaxM: 1000, stepLevels: 1,
    defined: false,
  } as BoxStackParams,
});
const SECTION_KIND_LABELS: Record<SectionKind, string> = {
  height: "高度",
  lon: "经度",
  lat: "纬度",
  polyline: "折线",
  box: "框选",
};
const cuts = reactive<CutState>({ x: [...DEFAULT_CUTS.x], y: [...DEFAULT_CUTS.y], z: [...DEFAULT_CUTS.z], faces: DEFAULT_CUTS.faces });
const unfolded = ref<UnfoldedGrid | null>(null);
const unfoldedVisible = ref(true);
const probe = ref<{
  lon: number;
  lat: number;
  pinned: boolean;
  values: number[];
  speed: number[];
  direction: number[];
} | null>(null);

const COLOR_MODES: { value: ColorMode; label: string }[] = [
  { value: "speed", label: "按风速" },
  { value: "w", label: "按垂直速度 w" },
  { value: "height", label: "按高度" },
  { value: "single", label: "单色" },
];

const variables3D = computed(() => {
  const list: { name: string; label: string }[] = [{ name: SPEED, label: "水平风速 |V|" }];
  for (const [name, meta] of Object.entries(manifest.value?.variables ?? {})) {
    if (meta.dims.length === 3) list.push({ name, label: `${meta.label_zh} (${name})` });
  }
  return list;
});
const variables2D = computed(() => {
  const list: { name: string; label: string }[] = [
    { name: "none", label: "无（纯色底图）" },
    { name: "speed0", label: "近地面风速 (12.5 m)" },
  ];
  for (const [name, meta] of Object.entries(manifest.value?.variables ?? {})) {
    if (meta.dims.length === 2 && name !== "cloud_low" && name !== "p") {
      list.push({ name, label: `${meta.label_zh} (${name})` });
    }
  }
  return list;
});

function labelOf(name: string): string {
  if (name === SPEED) return "水平风速";
  return manifest.value?.variables[name]?.label_zh ?? name;
}
function unitsOf(name: string): string {
  if (name === SPEED) return "m/s";
  return manifest.value?.variables[name]?.units ?? "";
}
function defaultColormap(name: string): string {
  if (name === SPEED) return "viridis";
  const meta = manifest.value?.variables[name];
  if (!meta) return "viridis";
  if (meta.colormap === "rdbu" || (meta.data_min < 0 && meta.data_max > 0)) return "rdbu";
  return meta.colormap === "blues" ? "cividis" : meta.colormap;
}

function volumeFullRange(name: string): [number, number] {
  if (name === SPEED) return [...fields.speedRange] as [number, number];
  const meta = manifest.value?.variables[name];
  if (!meta) return [0, 1];
  return [meta.data_min, meta.data_max];
}

/** Fixed colour scale from the manifest; independent of the current time step. */
function displayRange(name: string): [number, number] | null {
  if (name === SPEED || name === "speed0") {
    const r = manifest.value?.derived?.speed?.display_range;
    return r ? [r[0], r[1]] : null;
  }
  const r = manifest.value?.variables[name]?.display_range;
  return r ? [r[0], r[1]] : null;
}

function resetVolumeFilter(name: string): void {
  const [lo, hi] = volumeFullRange(name);
  layers.volumeFilterMin = lo;
  layers.volumeFilterMax = hi;
  volumeFilterVariable.value = name;
  volumeFilterNeedsSpeedRange.value = name === SPEED && !fields.speedValues;
}

function updateSliceFilter(): void {
  const enabled = layers.filterSlices;
  hslice?.material.setFilter(layers.volumeFilterMin, layers.volumeFilterMax, enabled);
  vsection?.material.setFilter(layers.volumeFilterMin, layers.volumeFilterMax, enabled);
  polyline?.material.setFilter(layers.volumeFilterMin, layers.volumeFilterMax, enabled);
  boxStack?.material.setFilter(layers.volumeFilterMin, layers.volumeFilterMax, enabled);
}

function updateVolumeFilter(): void {
  if (layers.volumeFilterMin > layers.volumeFilterMax) {
    [layers.volumeFilterMin, layers.volumeFilterMax] = [
      layers.volumeFilterMax,
      layers.volumeFilterMin,
    ];
  }
  volume?.setFilter(layers.volumeFilterMin, layers.volumeFilterMax, layers.volume);
  updateSliceFilter();
}

const volumeBounds = computed<[number, number]>(() => {
  if (!manifest.value || !fields) return [0, 1];
  return volumeFullRange(layers.volumeVar);
});

// ---------------------------------------------------------------- three.js objects
let store: DataStore;
let renderer: THREE.WebGLRenderer;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let atmos: AtmosScene;
let domain: Domain;
let fields: FieldTextures;
let particles: WindParticles | null = null;
let hslice: HorizontalSlice | null = null;
let vsection: VerticalSection | null = null;
let volume: VolumeLayer | null = null;
let polyline: PolylineSection | null = null;
let boxStack: BoxStack | null = null;
let buildings: Buildings | null = null;
let probeMarker: ProbeMarker | null = null;
let annotations: AnnotationLayer | null = null;
let heightOccluder: HeightOccluder | null = null;
let resizeObserver: ResizeObserver | null = null;
let raf = 0;
let disposed = false;
const requestedAt: Record<string, number> = {};
const volumeColorRange = ref<[number, number]>([0, 1]);
const volumeFilterVariable = ref("");
const volumeFilterNeedsSpeedRange = ref(false);
const depthOccluders: THREE.Object3D[] = [];

const loaded = (name: string) => store?.loaded.get(name);

function request(name: string): void {
  if (!store || name === "none") return;
  const names = name === SPEED || name === "speed0" ? ["u", "v"] : [name];
  for (const n of names) {
    if (!loaded(n) && requestedAt[n] === undefined) requestedAt[n] = performance.now();
    store.request(n);
  }
}

/** Texture + dequantisation for a 3D variable, or null while it is still loading. */
function binding(name: string): ScalarBinding | null {
  if (name === SPEED) {
    const u = loaded("u");
    const v = loaded("v");
    if (!u || !v) return null;
    return {
      texture: fields.speed(u.data, v.data, MAX_SPEED),
      scale: 1,
      offset: 0,
      log10: false,
    };
  }
  const data = loaded(name);
  if (!data) return null;
  return {
    texture: fields.scalar(name, data.data),
    scale: 1,
    offset: 0,
    log10: false,
  };
}

/**
 * Colour range for a layer. "自动范围" uses the configured `display_range` so later
 * time steps share one scale. Manual min/max still override this. The 2–98%
 * percentile path is only a fallback for older manifests without display_range.
 */
function autoRange(name: string, colormap: string, heightM?: number): [number, number] {
  const configured = displayRange(name);
  if (configured) return configured;
  const g = manifest.value!.grid;
  const n = g.nx * g.ny;
  let start = 0;
  let end = n * g.nz;
  if (heightM !== undefined) {
    const dz = g.levels_m[1] - g.levels_m[0];
    const k = THREE.MathUtils.clamp(Math.round((heightM - g.levels_m[0]) / dz), 0, g.nz - 1);
    start = k * n;
    end = start + n;
  }
  let lo: number;
  let hi: number;
  if (name === SPEED) {
    if (!fields.speedValues) return [0, 15];
    [lo, hi] = floatRange(fields.speedValues, start, end);
  } else {
    const data = loaded(name);
    if (!data) return [0, 1];
    [lo, hi] = floatRange(data.data, start, end);
  }
  if (DIVERGING.has(colormap)) {
    const m = Math.max(Math.abs(lo), Math.abs(hi));
    return [-m, m];
  }
  return [lo, hi];
}

function isBoxMode(): boolean {
  return section.enabled && section.kind === "box";
}
function volumeWanted(): boolean {
  return layers.volume && !isBoxMode();
}
function syncStyleToSlice(): void {
  slice.variable = section.variable;
  slice.colormap = section.colormap;
  slice.autoRange = section.autoRange;
  slice.min = section.min;
  slice.max = section.max;
  slice.opacity = section.opacity;
  slice.contours = section.contours;
  slice.enabled = section.enabled && section.kind === "height";
}
function syncStyleToSection(): void {
  section.variable = slice.variable;
  section.colormap = slice.colormap;
  section.autoRange = slice.autoRange;
  section.min = slice.min;
  section.max = slice.max;
  section.opacity = slice.opacity;
  section.contours = slice.contours;
}
function levelsOf(): number[] {
  return manifest.value?.grid.levels_m ?? domain.levels;
}
function clearPolyline(): void {
  section.points = [];
  unfolded.value = null;
  unfoldedVisible.value = false;
  polyline?.setPoints([]);
  polyline?.clearHandles();
  annotations?.removePrefixed("polyline-v-");
}
function clearBox(): void {
  section.box.defined = false;
  section.box.x0 = 0;
  section.box.z0 = 0;
  section.box.x1 = 0;
  section.box.z1 = 0;
  boxStack?.clearAnnotations();
  boxStack?.update({ ...section.box, levels: levelsOf(), defined: false, drawing: false });
}
function leaveKind(prev: SectionKind | null | undefined): void {
  if (prev === "polyline") clearPolyline();
  if (prev === "box") clearBox();
  if (prev === "height") hslice?.setHandleVisible(false);
  if (prev === "lon" || prev === "lat") vsection?.setDragging(false);
  annotations?.removePrefixed("section-readout");
  annotations?.removePrefixed("height-readout");
}

// ---------------------------------------------------------------- layer updates
function updateSlice(): void {
  if (!hslice) return;
  const on = section.enabled && section.kind === "height";
  slice.enabled = on;
  hslice.group.visible = on;
  if (!on) {
    hslice.setHandleVisible(false);
    return;
  }
  const b = binding(section.variable);
  if (!b) {
    hslice.group.visible = false;
    hslice.setHandleVisible(false);
    request(section.variable);
    return;
  }
  if (section.autoRange)
    [section.min, section.max] = autoRange(section.variable, section.colormap, slice.heightM);
  syncStyleToSlice();
  hslice.material.bind(b);
  hslice.material.style(section);
  updateSliceFilter();
  hslice.setHeightKm(slice.heightM / 1000);
  syncVolumeSlices();
}

function syncSectionAnnotations(): void {
  hslice?.syncAnnotations();
  vsection?.syncAnnotations();
  if (section.enabled && section.kind === "polyline") polyline?.syncAnnotations();
  else {
    polyline?.clearHandles();
    annotations?.removePrefixed("polyline-v-");
  }
  if (section.enabled && section.kind === "box") boxStack?.syncAnnotations();
  else boxStack?.clearAnnotations();
}

function updateSection(): void {
  if (!vsection || !polyline || !boxStack) return;
  const on = section.enabled;
  const kind = section.kind;
  vsection.group.visible = on && (kind === "lon" || kind === "lat");
  if (kind === "lon") {
    section.azimuthDeg = 0;
    vsection.azimuthDeg = 0;
    vsection.setOffset(section.offsetKm);
  }
  if (kind === "lat") {
    section.azimuthDeg = 90;
    vsection.azimuthDeg = 90;
    vsection.setOffset(section.offsetKm);
  }
  if (on && kind === "polyline") {
    polyline.setPoints(section.points);
    updateUnfolded();
  } else {
    polyline.setPoints([]);
    polyline.group.visible = false;
    polyline.clearHandles();
    if (kind !== "polyline") {
      unfolded.value = null;
    }
  }
  if (on && kind === "box") {
    boxStack.update({
      ...section.box,
      levels: levelsOf(),
      defined: Boolean(section.box.defined),
      drawing: boxDrawing,
    });
  } else {
    boxStack.update({ ...section.box, levels: levelsOf(), defined: false, drawing: false });
    boxStack.clearAnnotations();
    boxStack.group.visible = false;
  }
  updateSlice();
  if (!on) {
    syncVolumeSlices();
    syncSectionAnnotations();
    return;
  }
  if (kind === "height") {
    syncVolumeSlices();
    syncSectionAnnotations();
    return;
  }
  const b = binding(section.variable);
  if (!b) {
    vsection.group.visible = false;
    polyline.group.visible = false;
    boxStack.group.visible = false;
    request(section.variable);
    syncSectionAnnotations();
    return;
  }
  if (section.autoRange) [section.min, section.max] = autoRange(section.variable, section.colormap);
  syncStyleToSlice();
  vsection.material.bind(b);
  vsection.material.style(section);
  polyline.material.bind(b); polyline.material.style(section);
  boxStack.material.bind(b);
  boxStack.material.setVolumeComposited(false);
  boxStack.material.style(section);
  boxStack.material.depthWrite = section.opacity >= 0.999;
  updateSliceFilter();
  updateComposite();
  syncSectionAnnotations();
}

function updateUnfolded(): void {
  if (!section.enabled || section.kind !== "polyline" || section.points.length < 2 || !manifest.value) { unfolded.value = null; return; }
  const data = section.variable === SPEED ? null : loaded(section.variable);
  const u = loaded("u"), v = loaded("v");
  if (section.variable === SPEED && (!u || !v)) return;
  if (section.variable !== SPEED && !data) return;
  const g = manifest.value.grid;
  unfolded.value = sampleUnfolded(section.points, g.levels_m, domain, (x, y, z) => {
    const ix = THREE.MathUtils.clamp(Math.round((x / domain.sx + .5) * (g.nx - 1)), 0, g.nx - 1);
    const iy = THREE.MathUtils.clamp(Math.round((.5 - z / domain.sz) * (g.ny - 1)), 0, g.ny - 1);
    const k = THREE.MathUtils.clamp(Math.round((y * 1000 - g.levels_m[0]) / (g.levels_m[1] - g.levels_m[0])), 0, g.nz - 1);
    const idx = k * g.nx * g.ny + iy * g.nx + ix;
    return section.variable === SPEED ? Math.hypot(u!.data[idx], v!.data[idx]) : data!.data[idx];
  });
}

function updateGround(): void {
  if (!atmos || !manifest.value) return;
  atmos.ground.visible = layers.ground;
  const name = layers.groundVar;
  if (name === "none") {
    atmos.setGroundField(null, [0, 1], "viridis", view.theme);
    return;
  }
  if (name === "speed0") {
    const u = loaded("u");
    const v = loaded("v");
    if (!u || !v) return request("speed0");
    const read = (i: number) =>
      Math.hypot(u.data[i], v.data[i]);
    const range = displayRange("speed0") ?? displayRange(SPEED) ?? [0, 20];
    atmos.setGroundField(read, range, "viridis", view.theme, 0.55);
    return;
  }
  const data = loaded(name);
  if (!data) return request(name);
  const meta = data.meta;
  const cmap = meta.colormap === "rdbu" ? "rdbu" : meta.colormap;
  const range: [number, number] = displayRange(name) ?? [meta.data_min, meta.data_max];
  atmos.setGroundField(field2D(meta, data.data), range, cmap, view.theme, 0.55);
}

function updateVolume(): void {
  if (!volume || !manifest.value) return;
  volume.mesh.visible = volumeWanted();
  if (!volumeWanted()) {
    syncVolumeSlices();
    if (window.__atmosStatus) window.__atmosStatus.volume = null;
    return;
  }
  const b = binding(layers.volumeVar);
  if (!b) {
    volume.mesh.visible = false;
    request(layers.volumeVar);
    syncVolumeSlices();
    return;
  }
  if (layers.volumeVar === SPEED && volumeFilterNeedsSpeedRange.value && fields.speedValues) {
    resetVolumeFilter(SPEED);
  } else if (volumeFilterVariable.value !== layers.volumeVar) {
    resetVolumeFilter(layers.volumeVar);
  }
  const cmap = defaultColormap(layers.volumeVar);
  const [lo, hi] = autoRange(layers.volumeVar, cmap);
  volumeColorRange.value = [lo, hi];
  volume.bind(b, cmap === "rdbu" ? "magma" : cmap, lo, hi);
  volume.material.uniforms.uOpacity.value = layers.volumeOpacity;
  volume.material.uniforms.uThreshold.value = layers.volumeThreshold;
  updateVolumeFilter();
  syncVolumeSlices();
  if (window.__atmosStatus) {
    window.__atmosStatus.volume = volume.mesh.visible ? layers.volumeVar : null;
  }
}

function syncVolumeSlices(): void {
  if (!volume) return;
  const compositing = Boolean(volumeWanted() && volume.mesh.visible);
  const filterMin = layers.volumeFilterMin;
  const filterMax = layers.volumeFilterMax;
  const heightOn = section.enabled && section.kind === "height";
  const vertOn = section.enabled && (section.kind === "lon" || section.kind === "lat");
  const polyOn = section.enabled && section.kind === "polyline";
  const hb = heightOn ? binding(section.variable) : null;
  const vb = (vertOn || polyOn) ? binding(section.variable) : null;
  const h: CompositeSurface = {
    kind: "horizontal", binding: "slice", field: hb,
    min: section.min, max: section.max, opacity: section.opacity, colormap: section.colormap,
    filterMin, filterMax, filterEnable: layers.filterSlices, contours: section.contours,
    height: slice.heightM / 1000,
  };
  const s: CompositeSurface | null = (vertOn || polyOn) ? {
    kind: "vertical", binding: "section", field: vb,
    min: section.min, max: section.max, opacity: section.opacity, colormap: section.colormap,
    filterMin, filterMax, filterEnable: layers.filterSlices, contours: section.contours,
    normalX: section.kind === "lat" ? 0 : 1, normalZ: section.kind === "lat" ? 1 : 0,
    offset: section.offsetKm,
  } : null;
  const surfaces = buildCompositeSurfaces({
    slice: heightOn && hb ? h : null,
    section: vertOn && vb ? s : null,
    domain,
    cutBounds: cutBounds(domain, cuts),
    cutFaces: cuts.faces && volumeWanted(),
    volumeField: volumeWanted() ? binding(layers.volumeVar) : null,
    volumeStyle: { min: volumeColorRange.value[0], max: volumeColorRange.value[1], opacity: 0.9, colormap: defaultColormap(layers.volumeVar) === "rdbu" ? "magma" : defaultColormap(layers.volumeVar), contours: 0, filterMin, filterMax, filterEnable: Boolean(volumeWanted()) },
  });
  if (polyOn && vb && s) {
    for (let i = 0; i < section.points.length - 1 && surfaces.length < 16; i += 1) {
      const a = section.points[i], b = section.points[i + 1]; const dx = b.x - a.x, dz = b.z - a.z; const len = Math.hypot(dx, dz) || 1;
      surfaces.push({ ...s, kind: "vertical", normalX: -dz / len, normalZ: dx / len, offset: (-dz / len) * a.x + (dx / len) * a.z, ax: a.x, az: a.z, bx: b.x, bz: b.z });
    }
  }
  volume.setSurfaces(surfaces);
  volume.setCuts(cuts);
  hslice?.material.setVolumeComposited(compositing && Boolean(hslice?.group.visible) && Boolean(hb));
  vsection?.material.setVolumeComposited(compositing && Boolean(vsection?.group.visible) && Boolean(vb));
  polyline?.material.setVolumeComposited(compositing && Boolean(polyline?.group.visible) && Boolean(vb));
  boxStack?.material.setVolumeComposited(false);
}

function updateComposite(): void { syncVolumeSlices(); }


function ensureParticles(): void {
  if (particles || !renderer || !manifest.value) return;
  const u = loaded("u");
  const v = loaded("v");
  const w = loaded("w");
  if (!u || !v || !w) return;
  const tUpload = performance.now();
  performance.mark("atmos:upload:wind:start");
  const texture = fields.windTexture(u.data, v.data, w.data, MAX_SPEED);
  fields.speed(u.data, v.data, MAX_SPEED);
  performance.mark("atmos:upload:wind:end");
  recordUpload("wind", performance.now() - tUpload);
  const wAbs = Math.max(Math.abs(w.meta.data_min), Math.abs(w.meta.data_max));
  const colourSpeed = displayRange(SPEED) ?? ([...fields.speedRange] as [number, number]);
  const wDisplay = displayRange("w");
  const wRange = wDisplay
    ? Math.max(Math.abs(wDisplay[0]), Math.abs(wDisplay[1]))
    : Math.max(0.05, wAbs * 0.6);
  particles = new WindParticles(
    renderer,
    domain,
    {
      texture,
      scale: new THREE.Vector3(1, 1, 1),
      offset: new THREE.Vector3(0, 0, 0),
      maxSpeed: MAX_SPEED,
      speedRange: colourSpeed,
      wRange,
    },
    { ...particleParams },
  );
  atmos.root.add(particles.object);
  speedRange.value = colourSpeed;
  status.value = "风场就绪";
}

/** Objects excluded from the volume depth pre-pass. Field meshes remain visible when opaque
 * enough to occlude the volume; particles and visual helpers must never write occluder depth. */
function updateDepthOccluders(): void {
  depthOccluders.length = 0;
  if (particles) depthOccluders.push(particles.object);
  if (hslice) {
    depthOccluders.push(hslice.mesh, hslice.outline);
  }
  if (vsection) {
    depthOccluders.push(vsection.outline);
    depthOccluders.push(vsection.mesh);
  }
  if (polyline) depthOccluders.push(polyline.group);
  if (boxStack) depthOccluders.push(boxStack.group);
}

function onData(name: string): void {
  if (name === "manifest") return;
  if (requestedAt[name] !== undefined)
    loadMs[name] = Math.round(performance.now() - requestedAt[name]);
  publishTimings();
  ensureParticles();
  updateSlice();
  updateSection();
  updateVolume();
  if (
    name === layers.groundVar ||
    ((name === "u" || name === "v") && layers.groundVar === "speed0")
  ) {
    updateGround();
  }
  if (layers.probe && probe.value) refreshProbe();
}

// ---------------------------------------------------------------- probe / profile
const previewCell = { ix: 0, iy: 0 };
let previewActive = false;
const fixedCell = ref<{ ix: number; iy: number } | null>(null);
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let pointerDirty = false;
let pointerEvent: PointerEvent | null = null;

function profileVariable(): string {
  return section.enabled ? section.variable : slice.enabled ? slice.variable : SPEED;
}

function refreshProbe(
  pinned = probe.value?.pinned ?? false,
  cell: { ix: number; iy: number } | null = fixedCell.value,
): void {
  if (!manifest.value) return;
  const u = loaded("u");
  const v = loaded("v");
  if (!u || !v) return;
  const source = cell ?? previewCell;
  const { ix, iy } = source;
  const g = manifest.value.grid;
  const name = profileVariable();
  const data = name === SPEED ? null : loaded(name);
  const speed: number[] = [];
  const direction: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < g.nz; k += 1) {
    const i = k * g.nx * g.ny + iy * g.nx + ix;
    const uu = u.data[i];
    const vv = v.data[i];
    speed.push(Math.hypot(uu, vv));
    // meteorological direction: where the wind comes from, clockwise from north
    direction.push((THREE.MathUtils.radToDeg(Math.atan2(-uu, -vv)) + 360) % 360);
    values.push(data ? data.data[i] : Math.hypot(uu, vv));
  }
  probe.value = {
    lon: THREE.MathUtils.lerp(g.lon_min, g.lon_max, ix / (g.nx - 1)),
    lat: THREE.MathUtils.lerp(g.lat_min, g.lat_max, iy / (g.ny - 1)),
    pinned,
    values,
    speed,
    direction,
  };
  const payload = {
    type: "atmos:probe",
    lon: probe.value.lon,
    lat: probe.value.lat,
    speed,
    direction,
  };
  emit("probe", payload);
  if (window.parent !== window) window.parent.postMessage(payload, "*");
}

function setPointer(event: PointerEvent): void {
  const rect = canvas.value!.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster.setFromCamera(pointer, camera);
}

function cellPosition(ix: number, iy: number): [number, number] {
  const g = manifest.value!.grid;
  return [
    (ix / (g.nx - 1) - 0.5) * domain.sx,
    (0.5 - iy / (g.ny - 1)) * domain.sz,
  ];
}

function updateMarker(): void {
  if (!probeMarker) return;
  if (!layers.probe) return probeMarker.setVisible(false, false);
  const fixed = fixedCell.value;
  const same = fixed !== null && previewCell.ix === fixed.ix && previewCell.iy === fixed.iy;
  if (previewActive && !same) {
    const [px, pz] = cellPosition(previewCell.ix, previewCell.iy);
    probeMarker.setPreview(px, pz, true);
  } else {
    probeMarker.setPreview(0, 0, false);
  }
  if (fixed) {
    const [fx, fz] = cellPosition(fixed.ix, fixed.iy);
    probeMarker.setFixed(fx, fz, true);
  } else {
    probeMarker.setFixed(0, 0, false);
  }
}

function pickTargets(): THREE.Object3D[] {
  const list: THREE.Object3D[] = [];
  if (vsection?.group.visible) list.push(vsection.group);
  if (hslice?.group.visible) list.push(hslice.mesh);
  if (atmos.ground.visible) list.push(atmos.ground);
  return list;
}

function probeFromPointer(pin: boolean): boolean {
  const hit = raycaster.intersectObjects(pickTargets(), true)[0];
  if (!hit) return false;
  const local = atmos.root.worldToLocal(hit.point.clone());
  const g = manifest.value!.grid;
  previewCell.ix = Math.round(
    THREE.MathUtils.clamp((local.x / domain.sx + 0.5) * (g.nx - 1), 0, g.nx - 1),
  );
  previewCell.iy = Math.round(
    THREE.MathUtils.clamp((0.5 - local.z / domain.sz) * (g.ny - 1), 0, g.ny - 1),
  );
  previewActive = true;
  updateMarker();
  if (pin) {
    fixedCell.value = { ...previewCell };
    refreshProbe(true);
    updateMarker();
  } else if (layers.probeFollowMouse) {
    refreshProbe(false, previewCell);
  }
  return true;
}

// ---------------------------------------------------------------- section dragging
const drag = {
  active: false,
  kind: "" as "" | "lon" | "lat" | "height",
  plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  start: new THREE.Vector3(),
  startOffset: 0,
  startHeight: 0,
};
const pointerDown = { x: 0, y: 0, moved: false, active: false };
const tmp = new THREE.Vector3();
let drawStart: THREE.Vector3 | null = null;
let boxDrawing = false;
let vertexIndex = -1;
let boxCorner = -1;

function sectionHit(): THREE.Intersection | undefined {
  const targets: THREE.Object3D[] = [];
  if (vsection?.group.visible) targets.push(vsection.group);
  if (polyline?.group.visible) targets.push(polyline.mesh);
  if (boxStack?.group.visible) targets.push(boxStack.group);
  return raycaster.intersectObjects(targets, true)[0];
}

function groundPoint(): THREE.Vector3 | null {
  if (!atmos?.ground) return null;
  const hit = raycaster.intersectObject(atmos.ground, true)[0];
  if (!hit) return null;
  const p = atmos.root.worldToLocal(hit.point.clone());
  p.x = THREE.MathUtils.clamp(p.x, -domain.sx / 2, domain.sx / 2);
  p.z = THREE.MathUtils.clamp(p.z, -domain.sz / 2, domain.sz / 2);
  p.y = 0;
  return p;
}

function onPointerDown(event: PointerEvent): void {
  if (!manifest.value || event.button !== 0) return;
  setPointer(event);
  pointerDown.x = event.clientX;
  pointerDown.y = event.clientY;
  pointerDown.moved = false;
  pointerDown.active = true;
  const picked = annotations?.pick(event.clientX, event.clientY);
  const pickedKind = (picked?.userData as { pickable?: string; index?: number } | undefined)?.pickable;
  if (section.drawMode && section.kind === "polyline" && pickedKind === "polyline-vertex") {
    vertexIndex = (picked?.userData as { index?: number }).index ?? -1;
    if (picked) annotations?.setState(picked.id, "dragging");
    controls.enabled = false; canvas.value!.setPointerCapture(event.pointerId); event.preventDefault(); return;
  }
  if (section.kind === "box" && section.enabled && pickedKind === "box-corner") {
    boxCorner = (picked?.userData as { index?: number }).index ?? -1;
    if (picked) annotations?.setState(picked.id, "dragging");
    controls.enabled = false;
    canvas.value!.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  const sectionHandle = pickedKind === "section";
  const heightHandle = pickedKind === "height-handle";
  if (sectionHandle && vsection && section.enabled && (section.kind === "lon" || section.kind === "lat")) {
    drag.active = true;
    drag.kind = section.kind;
    tmp.set(vsection.center.x, domain.top, vsection.center.y);
    atmos.root.localToWorld(tmp);
    drag.plane.set(new THREE.Vector3(0, 1, 0), -tmp.y);
    if (!raycaster.ray.intersectPlane(drag.plane, drag.start)) drag.start.copy(tmp);
    drag.startOffset = vsection.offsetKm();
    vsection.setDragging(true, section.offsetKm);
    if (picked) annotations?.setState(picked.id, "dragging");
    controls.enabled = false;
    canvas.value!.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (heightHandle && hslice && section.enabled && section.kind === "height") {
    drag.active = true;
    drag.kind = "height";
    const anchor = new THREE.Vector3(domain.sx / 2, slice.heightM / 1000, 0);
    atmos.root.localToWorld(anchor);
    const normal = camera.position.clone().sub(anchor);
    normal.y = 0;
    if (normal.lengthSq() < 1e-8) camera.getWorldDirection(normal);
    else normal.normalize();
    drag.plane.setFromNormalAndCoplanarPoint(normal, anchor);
    drag.start.copy(anchor);
    drag.startHeight = slice.heightM;
    hslice.setDragging(true, slice.heightM);
    if (picked) annotations?.setState(picked.id, "dragging");
    controls.enabled = false;
    canvas.value!.setPointerCapture(event.pointerId);
    event.preventDefault();
    return;
  }
  if (section.drawMode) {
    const p = groundPoint();
    if (!p) return;
    if (section.kind === "polyline") {
      drawStart = p;
    } else if (section.kind === "box") {
      drawStart = p;
      boxDrawing = true;
      section.box.defined = false;
      controls.enabled = false;
      canvas.value!.setPointerCapture(event.pointerId);
      event.preventDefault();
    }
  }
}

function onPointerMove(event: PointerEvent): void {
  if (pointerDown.active && Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5)
    pointerDown.moved = true;
  pointerEvent = event;
  pointerDirty = true;
}

/** Pointer handling is batched to one raycast per animation frame. */
function processPointer(): void {
  if (!pointerDirty || !pointerEvent || !manifest.value) return;
  pointerDirty = false;
  setPointer(pointerEvent);
  if (drag.active && drag.kind === "height" && hslice) {
    if (!raycaster.ray.intersectPlane(drag.plane, tmp)) return;
    const local = atmos.root.worldToLocal(tmp.clone());
    slice.heightM = THREE.MathUtils.clamp(Math.round(local.y * 1000 * 10) / 10, 12.5, 987.5);
    hslice.setDragging(true, slice.heightM);
    return;
  }
  if (drag.active && vsection && (drag.kind === "lon" || drag.kind === "lat")) {
    if (!raycaster.ray.intersectPlane(drag.plane, tmp)) return;
    const local = atmos.root.worldToLocal(tmp.clone());
    const start = atmos.root.worldToLocal(drag.start.clone());
    const delta = drag.kind === "lon" ? local.x - start.x : local.z - start.z;
    section.offsetKm = Math.round((drag.startOffset + delta) * 1000) / 1000;
    vsection.setDragging(true, section.offsetKm);
    return;
  }
  if (vertexIndex >= 0 && polyline) {
    const p = groundPoint(); if (p && section.points[vertexIndex]) { section.points[vertexIndex] = { x: p.x, z: p.z }; updateSection(); }
    return;
  }
  if (boxCorner >= 0) {
    const p = groundPoint();
    if (p) {
      if (boxCorner === 0 || boxCorner === 3) section.box.x0 = p.x;
      if (boxCorner === 1 || boxCorner === 2) section.box.x1 = p.x;
      if (boxCorner === 0 || boxCorner === 1) section.box.z0 = p.z;
      if (boxCorner === 2 || boxCorner === 3) section.box.z1 = p.z;
      updateSection();
    }
    return;
  }
  if (boxDrawing && drawStart) {
    const p = groundPoint();
    if (p) {
      section.box.x0 = drawStart.x;
      section.box.z0 = drawStart.z;
      section.box.x1 = p.x;
      section.box.z1 = p.z;
      section.box.defined = false;
      updateSection();
    }
    return;
  }
  const picked = annotations?.pick(pointerEvent.clientX, pointerEvent.clientY);
  const handle = Boolean(picked?.draggable);
  const overSection = (picked?.userData as { pickable?: string } | undefined)?.pickable === "section";
  vsection?.setHighlight(overSection);
  if (drag.active || vertexIndex >= 0 || boxCorner >= 0 || boxDrawing) canvas.value!.style.cursor = "grabbing";
  else canvas.value!.style.cursor = handle ? "grab" : "";
  if (layers.probe && !section.drawMode) probeFromPointer(false);
}

function onPointerUp(event: PointerEvent): void {
  const wasClick = pointerDown.active && !pointerDown.moved && !drag.active && event.button === 0;
  if (drag.active) {
    drag.active = false;
    drag.kind = "";
    controls.enabled = true;
    vsection?.setDragging(false);
    hslice?.setDragging(false);
    vsection?.syncAnnotations();
    hslice?.syncAnnotations();
    canvas.value!.releasePointerCapture(event.pointerId);
  }
  if (boxDrawing) {
    const area = Math.abs(section.box.x1 - section.box.x0) * Math.abs(section.box.z1 - section.box.z0);
    section.box.defined = area > 0.01;
    if (!section.box.defined) clearBox();
    boxDrawing = false;
    drawStart = null;
    controls.enabled = true;
    canvas.value!.releasePointerCapture(event.pointerId);
    pointerDown.active = false;
    updateSection();
    return;
  }
  if (vertexIndex >= 0 || boxCorner >= 0) {
    polyline?.syncAnnotations();
    boxStack?.syncAnnotations();
    vertexIndex = -1;
    boxCorner = -1;
    drawStart = null;
    controls.enabled = true;
    canvas.value!.releasePointerCapture(event.pointerId);
    pointerDown.active = false;
    return;
  }
  if (section.drawMode && section.kind === "polyline" && wasClick && drawStart) {
    section.points = [...section.points, { x: drawStart.x, z: drawStart.z }].slice(-16);
    drawStart = null;
    unfoldedVisible.value = true;
    updateSection();
  }
  pointerDown.active = false;
  if (wasClick && layers.probe) {
    setPointer(event);
    probeFromPointer(true);
  }
}

function onContextMenu(event: MouseEvent): void {
  if (!section.drawMode) return;
  event.preventDefault();
  if (section.kind !== "polyline") return;
  setPointer(event as unknown as PointerEvent);
  const picked = annotations?.pick(event.clientX, event.clientY);
  const i = (picked?.userData as { pickable?: string; index?: number } | undefined)?.pickable === "polyline-vertex"
    ? (picked!.userData as { index: number }).index
    : -1;
  if (i >= 0 && section.points.length >= 1) { section.points.splice(i, 1); updateSection(); }
}

function setDrawOrbit(on: boolean): void {
  if (!controls) return;
  (controls.mouseButtons as any).LEFT = on ? -1 : THREE.MOUSE.ROTATE;
  (controls.mouseButtons as any).RIGHT = on ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
}

function selectKind(kind: SectionKind): void {
  if ((kind === "polyline" || kind === "box") && section.kind === kind && section.enabled && section.drawMode) {
    section.drawMode = false;
    return;
  }
  const prev = section.enabled ? section.kind : null;
  if (prev && prev !== kind) leaveKind(prev);
  section.kind = kind;
  section.enabled = true;
  section.drawMode = kind === "polyline" || kind === "box";
  if (kind === "lon") section.azimuthDeg = 0;
  if (kind === "lat") section.azimuthDeg = 90;
  if (kind === "polyline") unfoldedVisible.value = true;
  if (kind === "box" && prev !== "box") {
    section.box.defined = false;
    section.box.x0 = section.box.z0 = section.box.x1 = section.box.z1 = 0;
  }
  slice.enabled = kind === "height";
  updateSection();
}

// ---------------------------------------------------------------- camera presets
// Camera presets look from the south-west so the prevailing SE wind runs across the screen.
const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
  overview: { pos: [-14.5, 9, 13.5], target: [0.5, 0.3, -0.5] },
  slice: { pos: [-11.5, 10.5, 11.5], target: [0.5, 0.4, -0.5] },
  section: { pos: [-6, 4.8, 15], target: [0.5, 1.0, -0.5] },
  close: { pos: [-3.6, 1.5, 3.6], target: [0.3, 0.25, -0.3] },
  top: { pos: [0, 26, 0.01], target: [0, 0, 0] },
};

function setView(name: string): void {
  const preset = VIEWS[name] ?? VIEWS.overview;
  camera.position.set(...preset.pos);
  controls.target.set(...preset.target);
  controls.update();
  if (name === "slice") {
    selectKind("height");
  } else if (name === "section") {
    if (section.kind === "height" || !section.enabled) selectKind("lon");
    else selectKind(section.kind === "box" || section.kind === "polyline" ? "lon" : section.kind);
  } else if (name === "overview") {
    if (section.enabled) leaveKind(section.kind);
    slice.enabled = false;
    section.enabled = false;
    section.drawMode = false;
    updateSection();
  }
}

// ---------------------------------------------------------------- render loop
let last = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let ready = false;

function frame(now: number): void {
  if (disposed) return;
  raf = requestAnimationFrame(frame);
  const realDt = (now - last) / 1000;
  const dt = Math.min(0.1, realDt);
  last = now;
  fpsFrames += 1;
  fpsTime += realDt;
  if (fpsTime > 0.5) {
    fps.value = Math.round(fpsFrames / fpsTime);
    fpsFrames = 0;
    fpsTime = 0;
    drawCalls.value = renderer.info.render.calls;
    if (window.__atmosStatus) window.__atmosStatus.fps = fps.value;
  }
  processPointer();
  controls.update();
  atmos.root.scale.y = view.exaggeration;
  atmos.root.updateMatrixWorld();
  camera.updateMatrixWorld();
  if (boxStack?.group.visible) boxStack.sortSlabs(camera, atmos.root);
  annotations?.update(camera);
  hslice?.material.setRoot(atmos.root);
  vsection?.material.setRoot(atmos.root);
  polyline?.material.setRoot(atmos.root);
  boxStack?.material.setRoot(atmos.root);
  if (particles) {
    particles.object.visible = layers.particles;
    if (layers.particles) particles.step(dt);
  }
  if (volume?.mesh.visible) {
    updateDepthOccluders();
    volume.captureDepth(renderer, atmos.scene, camera, depthOccluders);
    volume.update(camera, atmos.root, renderer);
  }
  renderer.render(atmos.scene, camera);
  if (!ready && particles) {
    ready = true;
    performance.mark("atmos:first-frame");
    const started = (window as any).__atmosStart as number | undefined;
    const firstFrameMs = performance.now() - (started ?? 0);
    publishTimings({ firstFrameMs });
    window.__atmosStatus = {
      backend: "WebGL2",
      gpu: gpu.value,
      particlePath: particles.label,
      particleCount: particles.count,
      fps: fps.value,
      buildings: buildings?.meta?.count ?? 0,
    };
    window.__atmosReady = true;
    emit("ready", { backend: "WebGL2" });
    if (window.parent !== window) window.parent.postMessage({ type: "atmos:ready" }, "*");
  }
}

function resize(): void {
  if (!canvas.value || !renderer) return;
  const w = canvas.value.clientWidth;
  const h = canvas.value.clientHeight;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
  renderer.setSize(w, h, false);
  volume?.resize(renderer);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}

function exposeApi(): void {
  window.__atmosApi = {
    setView,
    setSection: (p: Partial<typeof section>) => {
      const prev = section.enabled ? section.kind : null;
      Object.assign(section, { enabled: true }, p);
      if (p.kind && p.kind !== prev) leaveKind(prev);
      if (p.azimuthDeg !== undefined && p.kind === undefined && (section.kind === "lon" || section.kind === "lat" || prev === null)) {
        const az = ((Number(p.azimuthDeg) % 180) + 180) % 180;
        if (section.kind !== "lon" && section.kind !== "lat") section.kind = Math.abs(az - 90) < 45 ? "lat" : "lon";
      }
      if (section.kind === "lon") section.azimuthDeg = 0;
      if (section.kind === "lat") section.azimuthDeg = 90;
      section.drawMode = section.kind === "polyline" || section.kind === "box";
      slice.enabled = section.kind === "height";
      updateSection();
    },
    setSectionMode: (kind: SectionKind) => { selectKind(kind); },
    setPolyline: (points: { x: number; z: number }[]) => {
      if (section.kind !== "polyline") {
        if (section.enabled) leaveKind(section.kind);
      }
      section.kind = "polyline";
      section.enabled = true;
      section.drawMode = true;
      section.points = points.slice(0, 16);
      unfoldedVisible.value = true;
      updateSection();
    },
    setBox: (p: Partial<BoxStackParams>) => {
      if (section.kind !== "box" && section.enabled) leaveKind(section.kind);
      section.kind = "box";
      section.enabled = true;
      section.drawMode = true;
      Object.assign(section.box, p);
      const hasArea = Math.abs((section.box.x1 ?? 0) - (section.box.x0 ?? 0)) * Math.abs((section.box.z1 ?? 0) - (section.box.z0 ?? 0)) > 1e-6;
      section.box.defined = p.defined !== undefined ? Boolean(p.defined) : hasArea;
      updateSection();
    },
    setCuts: (p: Partial<CutState>) => { if (p.x) cuts.x = [...p.x] as [number, number]; if (p.y) cuts.y = [...p.y] as [number, number]; if (p.z) cuts.z = [...p.z] as [number, number]; if (p.faces !== undefined) cuts.faces = p.faces; clampCuts(cuts); updateVolume(); },
    setSlice: (p: Partial<typeof slice>) => {
      Object.assign(slice, p);
      if (p.enabled === false) {
        if (section.kind === "height") {
          leaveKind("height");
          section.enabled = false;
        }
      } else {
        if (section.enabled && section.kind !== "height") leaveKind(section.kind);
        section.kind = "height";
        section.enabled = true;
        section.drawMode = false;
        if (p.variable !== undefined || p.colormap !== undefined || p.autoRange !== undefined || p.min !== undefined || p.max !== undefined || p.opacity !== undefined || p.contours !== undefined) {
          syncStyleToSection();
        }
      }
      updateSection();
    },
    setSliceEnabled: (on: boolean) => { if (on) selectKind("height"); else if (section.kind === "height") { section.enabled = false; leaveKind("height"); updateSection(); } },
    setParticles: (p: Partial<ParticleParams>) => Object.assign(particleParams, p),
    setLayer: (name: string, on: boolean) => {
      if (name in layers) (layers as Record<string, unknown>)[name] = on;
    },
    setVolume: (p: {
      enabled?: boolean;
      variable?: string;
      opacity?: number;
      threshold?: number;
      filterMin?: number;
      filterMax?: number;
      filterSlices?: boolean;
    }) => {
      if (p.variable !== undefined) {
        layers.volumeVar = p.variable;
        if (p.filterMin === undefined && p.filterMax === undefined) resetVolumeFilter(p.variable);
        else volumeFilterVariable.value = p.variable;
      }
      if (p.enabled !== undefined) layers.volume = p.enabled;
      if (p.opacity !== undefined) layers.volumeOpacity = p.opacity;
      if (p.threshold !== undefined) layers.volumeThreshold = p.threshold;
      if (p.filterMin !== undefined) layers.volumeFilterMin = p.filterMin;
      if (p.filterMax !== undefined) layers.volumeFilterMax = p.filterMax;
      if (p.filterSlices !== undefined) layers.filterSlices = p.filterSlices;
    },
    setCamera: (pos: [number, number, number], target: [number, number, number]) => {
      camera.position.set(...pos);
      controls.target.set(...target);
      controls.update();
    },
    setExaggeration: (n: number) => {
      view.exaggeration = THREE.MathUtils.clamp(Number(n) || 1, 1, 10);
      buildings?.setExaggeration(view.exaggeration);
    },
    selectPolylineVertex: (index: number) => {
      polyline?.setSelected(index);
    },
    probeAt: (ix: number, iy: number) => {
      layers.probe = true;
      previewCell.ix = THREE.MathUtils.clamp(Math.round(ix), 0, domain.nx - 1);
      previewCell.iy = THREE.MathUtils.clamp(Math.round(iy), 0, domain.ny - 1);
      fixedCell.value = { ...previewCell };
      updateMarker();
      refreshProbe(true);
    },
    setProbeEnabled: (on: boolean) => {
      layers.probe = on;
      if (on && fixedCell.value) {
        previewCell.ix = fixedCell.value.ix;
        previewCell.iy = fixedCell.value.iy;
        refreshProbe(true);
      }
      updateMarker();
    },
    setProbeFollowMouse: (on: boolean) => {
      layers.probeFollowMouse = on;
      if (on && layers.probe && probe.value) refreshProbe(false, previewCell);
    },
    probeHoverAt: (ix: number, iy: number) => {
      layers.probe = true;
      previewCell.ix = THREE.MathUtils.clamp(Math.round(ix), 0, domain.nx - 1);
      previewCell.iy = THREE.MathUtils.clamp(Math.round(iy), 0, domain.ny - 1);
      previewActive = true;
      updateMarker();
      if (layers.probeFollowMouse) refreshProbe(false, previewCell);
    },
    /** run n simulation steps without drawing the scene (screenshots on slow software GL) */
    advance: (steps: number, dt = 1 / 60) => {
      for (let i = 0; i < steps; i += 1) particles?.step(dt);
    },
    sampleParticle: () => particles?.sample() ?? [],
    sampleHistory: () => particles?.sampleHistory() ?? [],
    status: () => ({ ...window.__atmosStatus, fps: fps.value, drawCalls: drawCalls.value }),
    timings: () => window.__atmosTimings ?? publishTimings(),
  };
}

async function start(): Promise<void> {
  const t0 = performance.now();
  performance.mark("atmos:start");
  (window as any).__atmosStart = t0;
  store = new DataStore(props.manifestUrl);
  await new Promise<void>((resolve) => {
    const off = store.on((name) => {
      if (name === "manifest") {
        off();
        resolve();
      }
    });
  });
  if (disposed || !store.manifest) return;
  loadMs.manifest = Math.round(performance.now() - t0);
  manifest.value = store.manifest;
  domain = domainOf(store.manifest);
  fields = new FieldTextures(domain);
  resetVolumeFilter(layers.volumeVar);
  store.on(onData);
  // The worker already preloads u, v, w then tke, t2m; do not request them again
  // or a second fetch can start on a slow network before the first is cached.
  for (const n of ["u", "v", "w", "tke", "t2m"]) {
    if (requestedAt[n] === undefined) requestedAt[n] = performance.now();
  }

  renderer = new THREE.WebGLRenderer({
    canvas: canvas.value!,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const gl = renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  gpu.value = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "WebGL2";
  if (!renderer.extensions.has("EXT_color_buffer_float")) {
    status.value = "此 GPU 不支持浮点渲染目标（EXT_color_buffer_float），粒子不可用";
  }

  atmos = new AtmosScene(domain);
  annotations = new AnnotationLayer(canvas.value!.parentElement ?? canvas.value!, atmos.root);
  probeMarker = new ProbeMarker(annotations, domain.top);
  hslice = new HorizontalSlice(domain);
  vsection = new AxisSection(domain, "lon");
  polyline = new PolylineSection(domain);
  boxStack = new BoxStack(domain, manifest.value.grid.levels_m);
  volume = new VolumeLayer(domain);
  hslice.group.visible = false;
  vsection.group.visible = false;
  volume.mesh.visible = false;
  polyline.group.visible = false;
  boxStack.group.visible = false;
  hslice.setAnnotationLayer(annotations);
  vsection.setAnnotationLayer(annotations);
  polyline.setAnnotationLayer(annotations);
  boxStack.setAnnotationLayer(annotations);
  atmos.root.add(hslice.group, vsection.group, polyline.group, boxStack.group, volume.mesh);
  camera = new THREE.PerspectiveCamera(40, 1, 0.05, 200);
  controls = new OrbitControls(camera, canvas.value!);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 1.2;
  controls.maxDistance = 60;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.screenSpacePanning = false;
  setView("overview");
  resize();
  resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(canvas.value!);
  const el = canvas.value!;
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointermove", onPointerMove);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && section.drawMode) section.drawMode = false; });
  exposeApi();
  updateGround();
  raf = requestAnimationFrame(frame);

  const skipBuildings = new URLSearchParams(location.search).has("noBuildings");
  if (skipBuildings) {
    loadMs.buildings = 0;
    buildingsInfo.value = "已跳过";
    return;
  }
  buildings = new Buildings();
  atmos.root.add(buildings.group);
  const tb = performance.now();
  const ok = await buildings.load();
  loadMs.buildings = Math.round(performance.now() - tb);
  buildingsInfo.value = ok
    ? `${buildings.meta!.count.toLocaleString()} 栋 · 最高 ${buildings.meta!.max_height_m.toFixed(0)} m`
    : "无建筑数据";
  if (window.__atmosStatus) window.__atmosStatus.buildings = buildings.meta?.count ?? 0;
  if (ok && annotations) {
    heightOccluder = new HeightOccluder(domain.sx, domain.sz);
    heightOccluder.ingestObject(buildings.group, atmos.root);
    annotations.setOccluder(heightOccluder, layers.buildings);
  }
  applyBuildings();
}

function applyBuildings(): void {
  if (!buildings) return;
  buildings.group.visible = layers.buildings;
  buildings.setOpacity(layers.buildingOpacity);
  buildings.setExaggeration(view.exaggeration);
  buildings.setShadows(view.shadows);
}

// ---------------------------------------------------------------- watchers (all cheap)
watch(particleParams, () => particles?.setParams({ ...particleParams }), { deep: true });
watch(
  () => section.variable,
  (name) => {
    section.colormap = defaultColormap(name);
    section.autoRange = true;
  },
);
watch(() => slice.heightM, () => { if (section.kind === "height") updateSlice(); });
watch(
  () => [
    section.enabled,
    section.variable,
    section.colormap,
    section.autoRange,
    section.min,
    section.max,
    section.opacity,
    section.contours,
  ],
  updateSection,
);
watch(
  () => section.enabled,
  (on, was) => {
    if (!on && was) {
      leaveKind(section.kind);
      section.drawMode = false;
      updateSection();
    }
  },
);
watch(
  () => [section.offsetKm, section.azimuthDeg],
  () => {
    if (!vsection) return;
    if (section.kind === "lon") section.azimuthDeg = 0;
    if (section.kind === "lat") section.azimuthDeg = 90;
    if (section.kind === "lon" || section.kind === "lat") {
      vsection.azimuthDeg = section.azimuthDeg;
      vsection.setOffset(section.offsetKm);
    }
    syncVolumeSlices();
  },
);
watch(() => [section.kind, section.drawMode, section.points.length, section.box.x0, section.box.x1, section.box.z0, section.box.z1, section.box.heightMinM, section.box.heightMaxM, section.box.stepLevels, section.box.defined], updateSection);
watch(() => isBoxMode(), () => { updateVolume(); });
watch(() => [cuts.x[0], cuts.x[1], cuts.y[0], cuts.y[1], cuts.z[0], cuts.z[1], cuts.faces], () => { clampCuts(cuts); volume?.setCuts(cuts); syncVolumeSlices(); });
watch(() => [layers.ground, layers.groundVar], updateGround);
watch(
  () => [layers.volume, layers.volumeVar, layers.volumeOpacity, layers.volumeThreshold],
  updateVolume,
);
watch(
  () => layers.volumeVar,
  (name) => {
    if (name !== volumeFilterVariable.value) resetVolumeFilter(name);
  },
);
watch(
  () => [layers.volumeFilterMin, layers.volumeFilterMax, layers.filterSlices],
  updateVolumeFilter,
);
watch(
  () => layers.buildings,
  (on) => annotations?.setOcclusionEnabled(Boolean(on)),
);
watch(
  () => [layers.buildings, layers.buildingOpacity, view.exaggeration, view.shadows],
  applyBuildings,
);
watch(
  () => view.shadows,
  (on) => atmos?.setShadows(on),
);
watch(
  () => view.theme,
  (theme) => {
    atmos?.setTheme(theme);
    updateGround();
  },
);
watch(
  [() => section.enabled, () => slice.enabled, () => section.variable, () => slice.variable],
  () => {
    if (layers.probe && probe.value) refreshProbe();
  },
);
watch(() => section.drawMode, (on) => { setDrawOrbit(on); if (on) layers.probe = false; });
watch(
  () => [layers.probe, layers.probeFollowMouse],
  ([enabled, follow]) => {
    if (!enabled) {
      probeMarker?.setVisible(false, false);
      return;
    }
    if (fixedCell.value && !probe.value) refreshProbe(true);
    updateMarker();
    if (follow && probe.value) refreshProbe(false, previewCell);
  },
);

const legends = computed(() => {
  const out: {
    key: string;
    title: string;
    units: string;
    colormap: string;
    min: number;
    max: number;
    windowMin?: number;
    windowMax?: number;
  }[] = [];
  if (section.enabled)
    out.push({
      key: "section",
      title: section.kind === "height"
        ? `剖面 ${slice.heightM.toFixed(0)} m · ${labelOf(section.variable)}`
        : `剖面 · ${labelOf(section.variable)}`,
      units: unitsOf(section.variable),
      colormap: section.colormap,
      min: section.min,
      max: section.max,
    });
  if (layers.particles && particleParams.colorMode !== "single") {
    const name =
      particleParams.colorMode === "w"
        ? "w"
        : particleParams.colorMode === "height"
          ? "height"
          : SPEED;
    const range: [number, number] =
      name === SPEED
        ? (displayRange(SPEED) ?? speedRange.value)
        : name === "w"
          ? (displayRange("w") ?? [-0.2, 0.2])
          : [0, 1000];
    out.push({
      key: "particles",
      title: `粒子 · ${name === "height" ? "高度" : labelOf(name)}`,
      units: name === "height" ? "m" : "m/s",
      colormap: particleParams.colormap,
      min: range[0],
      max: range[1],
    });
  }
  if (volumeWanted()) {
    out.push({
      key: "volume",
      title: `体渲染 · ${labelOf(layers.volumeVar)}`,
      units: unitsOf(layers.volumeVar),
      colormap:
        defaultColormap(layers.volumeVar) === "rdbu" ? "magma" : defaultColormap(layers.volumeVar),
      min: volumeColorRange.value[0],
      max: volumeColorRange.value[1],
      windowMin: layers.volumeFilterMin,
      windowMax: layers.volumeFilterMax,
    });
  }
  return out;
});

onMounted(() => void start());
onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(raf);
  resizeObserver?.disconnect();
  store?.dispose();
  particles?.dispose();
  hslice?.dispose();
  vsection?.dispose();
  polyline?.dispose();
  boxStack?.dispose();
  volume?.dispose();
  buildings?.dispose();
  fields?.dispose();
  controls?.dispose();
  renderer?.dispose();
  probeMarker?.dispose();
  annotations?.dispose();
});
</script>

<template>
  <div class="viewer" :class="view.theme">
    <canvas ref="canvas" class="canvas" />

    <div class="hud">
      <b>天津低空三维风场</b>
      <span>WebGL2 · {{ gpu }}</span>
      <span
        >{{ fps || "—" }} FPS · {{ particles?.count?.toLocaleString() ?? "—" }} 粒子 ·
        {{ drawCalls }} draw</span
      >
      <span class="muted">{{ status }}</span>
    </div>

    <div class="legends">
      <ColorLegend
        v-for="l in legends"
        :key="l.key"
        :title="l.title"
        :units="l.units"
        :colormap="l.colormap"
        :min="l.min"
        :max="l.max"
        :window-min="l.windowMin"
        :window-max="l.windowMax"
      />
    </div>

    <ProfileChart
      v-if="layers.probe && probe"
      class="profile-box"
      :lon="probe.lon"
      :lat="probe.lat"
      :pinned="probe.pinned"
      :levels="manifest?.grid.levels_m ?? []"
      :values="probe.values"
      :speed="probe.speed"
      :direction="probe.direction"
      :label="labelOf(profileVariable())"
      :units="unitsOf(profileVariable())"
      :show-variable="profileVariable() !== 'speed'"
      @close="probe = null; fixedCell = null; updateMarker()"
    />
    <UnfoldedPlot v-if="unfoldedVisible" :grid="unfolded" :min="section.min" :max="section.max" :colormap="section.colormap" :units="unitsOf(section.variable)" @close="unfoldedVisible = false" />

    <div class="hint">
      拖动：旋转 · 右键：平移 · 滚轮：缩放 · 经度/纬度剖面可拖动平移 ·
      折线/框选绘制：左键放点或拖框，右键旋转，Esc 或再点同一模式退出 ·
      打开探针 → 悬停预览位置（不改读数）→ 单击（非拖动）固定并更新廓线；可选跟随鼠标
    </div>

    <aside v-if="panelOpen" class="panel">
      <div class="panel-head">
        <div>
          <div class="eyebrow">THREE.JS · WEBGL2 GPGPU</div>
          <h1>低空风场可视化</h1>
        </div>
        <button class="icon" title="收起" @click="panelOpen = false">×</button>
      </div>

      <details open>
        <summary>图层</summary>
        <label class="row"
          ><input v-model="layers.buildings" type="checkbox" />建筑白膜
          <small>{{ buildingsInfo }}</small></label
        >
        <label v-if="layers.buildings" class="slider"
          >建筑不透明度 {{ layers.buildingOpacity.toFixed(2) }}
          <input v-model.number="layers.buildingOpacity" type="range" min="0.2" max="1" step="0.05"
        /></label>
        <label class="row"
          ><input v-model="layers.ground" type="checkbox" />地面
          <select v-model="layers.groundVar">
            <option v-for="v in variables2D" :key="v.name" :value="v.name">{{ v.label }}</option>
          </select></label
        >
        <label class="row"
          ><input v-model="layers.particles" type="checkbox" />风粒子（GPGPU 流线）</label
        >
        <label class="row"><input v-model="layers.probe" type="checkbox" />探针</label>
        <label v-if="layers.probe" class="row"
          ><input v-model="layers.probeFollowMouse" type="checkbox" />跟随鼠标</label
        >
        <label class="row"
          ><input v-model="layers.volume" type="checkbox" />体渲染
          <select v-model="layers.volumeVar" :disabled="!layers.volume">
            <option v-for="v in variables3D" :key="v.name" :value="v.name">{{ v.label }}</option>
          </select></label
        >
        <template v-if="layers.volume">
          <label class="slider"
            >体渲染不透明度 {{ layers.volumeOpacity.toFixed(2)
            }}<input
              v-model.number="layers.volumeOpacity"
              type="range"
              min="0.05"
              max="2"
              step="0.05"
          /></label>
          <label class="slider"
            >阈值 {{ layers.volumeThreshold.toFixed(2)
            }}<input
              v-model.number="layers.volumeThreshold"
              type="range"
              min="0"
              max="0.95"
              step="0.01"
          /></label>
          <div class="slider range-label"><span>xcut</span><RangeSlider :min="0" :max="1" :min-value="cuts.x[0]" :max-value="cuts.x[1]" :step="0.01" @update:min-value="cuts.x[0] = $event" @update:max-value="cuts.x[1] = $event" /></div>
          <div class="slider range-label"><span>ycut</span><RangeSlider :min="0" :max="1" :min-value="cuts.y[0]" :max-value="cuts.y[1]" :step="0.01" @update:min-value="cuts.y[0] = $event" @update:max-value="cuts.y[1] = $event" /></div>
          <div class="slider range-label"><span>zcut</span><RangeSlider :min="0" :max="1" :min-value="cuts.z[0]" :max-value="cuts.z[1]" :step="0.01" @update:min-value="cuts.z[0] = $event" @update:max-value="cuts.z[1] = $event" /></div>
          <label class="row"><input v-model="cuts.faces" type="checkbox" />切面</label>
          <div class="slider range-label">
            <span>显示范围</span>
            <RangeSlider
              :min="volumeBounds[0]"
              :max="volumeBounds[1]"
              :min-value="layers.volumeFilterMin"
              :max-value="layers.volumeFilterMax"
              :unit="unitsOf(layers.volumeVar)"
              :step="Math.max((volumeBounds[1] - volumeBounds[0]) / 200, 1e-6)"
              @update:min-value="layers.volumeFilterMin = $event"
              @update:max-value="layers.volumeFilterMax = $event"
            />
          </div>
          <label class="row"
            ><input v-model="layers.filterSlices" type="checkbox" />截面同步过滤</label
          >
        </template>
      </details>

      <details open>
        <summary>
          粒子样式 <em>{{ particleParams.count.toLocaleString() }}</em>
        </summary>
        <label class="slider"
          >粒子数量 {{ particleParams.count.toLocaleString() }}
          <input
            v-model.number="particleParams.count"
            type="range"
            min="4000"
            max="262144"
            step="4000"
        /></label>
        <label class="slider"
          >尾迹长度 {{ particleParams.trailLength }} 步
          <input
            v-model.number="particleParams.trailLength"
            type="range"
            min="2"
            :max="particleParams.count > 70000 ? 32 : 64"
            step="1"
        /></label>
        <label class="slider"
          >速度倍率 {{ particleParams.speed.toFixed(2) }}×
          <input v-model.number="particleParams.speed" type="range" min="0.05" max="5" step="0.05"
        /></label>
        <label class="slider"
          >线宽 {{ particleParams.lineWidth.toFixed(1) }} px
          <input
            v-model.number="particleParams.lineWidth"
            type="range"
            min="0.5"
            max="8"
            step="0.1"
        /></label>
        <label class="slider"
          >生命周期 {{ particleParams.lifetime.toFixed(1) }} s
          <input v-model.number="particleParams.lifetime" type="range" min="1" max="30" step="0.5"
        /></label>
        <label class="slider"
          >不透明度 {{ particleParams.opacity.toFixed(2) }}
          <input
            v-model.number="particleParams.opacity"
            type="range"
            min="0.05"
            max="1"
            step="0.01"
        /></label>
        <label class="row"
          >着色
          <select v-model="particleParams.colorMode">
            <option v-for="m in COLOR_MODES" :key="m.value" :value="m.value">{{ m.label }}</option>
          </select></label
        >
        <label v-if="particleParams.colorMode !== 'single'" class="row"
          >色带
          <select v-model="particleParams.colormap">
            <option v-for="c in COLORMAPS" :key="c" :value="c">
              {{ COLORMAP_LABELS[c] ?? c }}
            </option>
          </select></label
        >
        <label v-else class="row">颜色 <input v-model="particleParams.color" type="color" /></label>
        <label class="slider"
          >高度下限 {{ particleParams.heightMin }} m
          <input
            v-model.number="particleParams.heightMin"
            type="range"
            min="10"
            max="950"
            step="10"
        /></label>
        <label class="slider"
          >高度上限 {{ particleParams.heightMax }} m
          <input
            v-model.number="particleParams.heightMax"
            type="range"
            min="40"
            max="1000"
            step="10"
        /></label>
        <label class="slider"
          >w 垂直放大 {{ particleParams.wExaggeration.toFixed(1) }}×
          <input
            v-model.number="particleParams.wExaggeration"
            type="range"
            min="0"
            max="20"
            step="0.5"
        /></label>
        <div class="row-wrap">
          <label class="row"
            ><input v-model="particleParams.taper" type="checkbox" />尾迹收细</label
          >
          <label class="row"
            ><input v-model="particleParams.additive" type="checkbox" />叠加发光</label
          >
          <label class="row"><input v-model="particleParams.paused" type="checkbox" />暂停</label>
        </div>
      </details>

      <details open>
        <summary>
          剖面 <em>{{ section.enabled ? SECTION_KIND_LABELS[section.kind] : "关" }}</em>
        </summary>
        <label class="row"
          ><input v-model="section.enabled" type="checkbox" />显示
        </label>
        <span class="mode-picks">
          <button type="button" :class="{ on: section.enabled && section.kind === 'height' }" @click="selectKind('height')">高度</button>
          <button type="button" :class="{ on: section.enabled && section.kind === 'lon' }" @click="selectKind('lon')">经度</button>
          <button type="button" :class="{ on: section.enabled && section.kind === 'lat' }" @click="selectKind('lat')">纬度</button>
          <button type="button" :class="{ on: section.enabled && section.kind === 'polyline' }" @click="selectKind('polyline')">折线</button>
          <button type="button" :class="{ on: section.enabled && section.kind === 'box' }" @click="selectKind('box')">框选</button>
        </span>
        <label class="row"
          >变量
          <select v-model="section.variable">
            <option v-for="v in variables3D" :key="v.name" :value="v.name">{{ v.label }}</option>
          </select></label
        >
        <label class="row"
          >色带
          <select v-model="section.colormap">
            <option v-for="c in COLORMAPS" :key="c" :value="c">
              {{ COLORMAP_LABELS[c] ?? c }}
            </option>
          </select></label
        >
        <label class="row"
          ><input v-model="section.autoRange" type="checkbox" />自动范围
          <input
            v-model.number="section.min"
            class="num"
            type="number"
            step="any"
            :disabled="section.autoRange" />–
          <input
            v-model.number="section.max"
            class="num"
            type="number"
            step="any"
            :disabled="section.autoRange"
        /></label>
        <label class="slider"
          >不透明度 {{ section.opacity.toFixed(2)
          }}<input v-model.number="section.opacity" type="range" min="0.1" max="1" step="0.01"
        /></label>
        <label class="slider"
          >等值线 {{ section.contours || "关"
          }}<input v-model.number="section.contours" type="range" min="0" max="30" step="1"
        /></label>
        <label v-if="section.kind === 'height'" class="slider"
          >高度 {{ slice.heightM.toFixed(1) }} m
          <input v-model.number="slice.heightM" type="range" min="12.5" max="987.5" step="0.5"
        /></label>
        <label v-if="section.kind === 'lon' || section.kind === 'lat'" class="slider"
          >位置偏移 {{ section.offsetKm.toFixed(2) }} km
          <input v-model.number="section.offsetKm" type="range" min="-12" max="12" step="0.01"
        /></label>
        <div v-if="section.kind === 'polyline'" class="section-tools">
          <div class="mode-picks">
            <button type="button" @click="clearPolyline()">清除折线</button>
            <button type="button" :class="{ on: unfoldedVisible }" @click="unfoldedVisible = !unfoldedVisible">{{ unfoldedVisible ? "隐藏展开图" : "显示展开图" }}</button>
          </div>
          <div class="hint-line">左键加点，右键删点，Esc 退出</div>
        </div>
        <template v-if="section.kind === 'box'">
          <div class="hint-line">拖拽地面框选范围 · 框选时暂停体渲染</div>
          <div class="slider range-label">
            <span>高度范围 {{ section.box.heightMinM.toFixed(0) }}–{{ section.box.heightMaxM.toFixed(0) }} m</span>
            <RangeSlider :min="0" :max="1000" :min-value="section.box.heightMinM" :max-value="section.box.heightMaxM" :step="12.5" @update:min-value="section.box.heightMinM = $event" @update:max-value="section.box.heightMaxM = $event" />
          </div>
          <label class="row">间隔
            <select v-model.number="section.box.stepLevels">
              <option :value="1">每 1 层</option>
              <option :value="2">每 2 层</option>
              <option :value="5">每 5 层</option>
            </select>
          </label>
        </template>
      </details>

      <details>
        <summary>视图</summary>
        <label class="slider"
          >垂直夸张 {{ view.exaggeration.toFixed(1) }}×
          <input v-model.number="view.exaggeration" type="range" min="1" max="10" step="0.1"
        /></label>
        <label class="row"><input v-model="view.shadows" type="checkbox" />建筑阴影</label>
        <label class="row"
          >主题
          <select v-model="view.theme">
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select></label
        >
        <div class="buttons">
          <button @click="setView('overview')">总览</button>
          <button @click="setView('close')">近景</button>
          <button @click="setView('top')">俯视</button>
        </div>
      </details>

      <details>
        <summary>状态</summary>
        <div class="stats">
          <div>渲染：WebGL2 · {{ gpu }}</div>
          <div>粒子路径：{{ particles?.label ?? "等待 u/v/w" }}</div>
          <div>
            加载耗时：<span v-for="(ms, k) in loadMs" :key="k">{{ k }} {{ ms }} ms · </span>
          </div>
          <div>建筑：{{ buildingsInfo }}（3D-GloBFP + OSM）</div>
        </div>
      </details>
    </aside>
    <button v-else class="open-panel" @click="panelOpen = true">控制面板</button>
  </div>
</template>

<style scoped>
.mode-picks { display: inline-flex; flex-wrap: wrap; gap: 4px; margin: 4px 0; }
.mode-picks button { background: rgba(20,40,55,.8); color: inherit; border: 1px solid var(--line); border-radius: 3px; padding: 1px 6px; cursor: pointer; font: inherit; }
.mode-picks button.on { border-color: var(--accent); color: var(--accent); }
.section-tools { display: flex; flex-direction: column; gap: 4px; margin: 6px 0; }
.hint-line { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin: 4px 0; }
.range-label span { display: block; margin-bottom: 4px; }
.viewer {
  --card: rgba(8, 17, 30, 0.78);
  --panel: rgba(8, 16, 28, 0.9);
  --line: rgba(120, 170, 200, 0.22);
  --text: #dce9f2;
  --muted: #87a3b5;
  --accent: #5fd3e6;
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  color: var(--text);
  font:
    12px/1.45 system-ui,
    -apple-system,
    "PingFang SC",
    "Microsoft YaHei",
    sans-serif;
}
.viewer.light {
  --card: rgba(250, 252, 255, 0.82);
  --panel: rgba(250, 252, 255, 0.93);
  --line: rgba(60, 90, 110, 0.2);
  --text: #1c2d3a;
  --muted: #5d7384;
  --accent: #0f8aa3;
}
.canvas {
  display: block;
  width: 100%;
  height: 100%;
  touch-action: none;
}
.hud {
  position: absolute;
  z-index: 5;
  left: 16px;
  top: 14px;
  display: flex;
  gap: 14px;
  align-items: baseline;
  padding: 8px 12px;
  border-radius: 10px;
  background: var(--card);
  border: 1px solid var(--line);
  backdrop-filter: blur(10px);
  font-variant-numeric: tabular-nums;
}
.hud b {
  font-size: 14px;
  white-space: nowrap;
}
.hud span {
  max-width: 420px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.muted {
  color: var(--muted);
}
.legends {
  position: absolute;
  z-index: 5;
  left: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.profile-box {
  position: absolute;
  z-index: 5;
  left: 16px;
  top: 60px;
}
.hint {
  position: absolute;
  z-index: 5;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 4px 10px;
  border-radius: 8px;
  background: var(--card);
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
}
.panel {
  position: absolute;
  z-index: 6;
  right: 14px;
  top: 14px;
  width: 300px;
  max-height: calc(100% - 28px);
  overflow-y: auto;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid var(--line);
  backdrop-filter: blur(14px);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}
.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
}
.eyebrow {
  font-size: 10px;
  letter-spacing: 0.14em;
  color: var(--muted);
}
.panel h1 {
  margin: 2px 0 6px;
  font-size: 17px;
  font-weight: 600;
}
.icon {
  border: 1px solid var(--line);
  background: transparent;
  color: var(--muted);
  border-radius: 7px;
  width: 26px;
  height: 26px;
  cursor: pointer;
}
details {
  border-top: 1px solid var(--line);
  padding: 8px 0 4px;
}
summary {
  cursor: pointer;
  font-weight: 600;
  font-size: 13px;
  list-style: none;
}
summary::-webkit-details-marker {
  display: none;
}
summary::before {
  content: "▸ ";
  color: var(--muted);
}
details[open] > summary::before {
  content: "▾ ";
}
summary em {
  float: right;
  font-style: normal;
  font-weight: 400;
  color: var(--accent);
  font-size: 11px;
}
.row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0;
}
.row small {
  margin-left: auto;
  color: var(--muted);
}
.row select {
  flex: 1;
  min-width: 0;
}
.row-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 0 12px;
}
.slider {
  display: block;
  margin: 6px 0;
  color: var(--text);
}
.slider input {
  display: block;
  width: 100%;
  margin: 3px 0 0;
  accent-color: var(--accent);
}
select,
.num {
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid var(--line);
  background: transparent;
  color: var(--text);
  font: inherit;
}
select option {
  color: #111;
}
.num {
  width: 64px;
}
input[type="checkbox"] {
  accent-color: var(--accent);
}
.buttons {
  display: flex;
  gap: 6px;
  margin: 6px 0;
}
.buttons button,
.open-panel {
  flex: 1;
  padding: 6px 8px;
  border-radius: 8px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text);
  cursor: pointer;
}
.open-panel {
  position: absolute;
  right: 14px;
  top: 14px;
  flex: none;
}
.stats {
  color: var(--muted);
  font-size: 11px;
  display: grid;
  gap: 4px;
  word-break: break-all;
}
</style>
