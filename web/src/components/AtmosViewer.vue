<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import * as THREE from "three";
import type { ViewHost } from "../host/types";
import { createThreeHost } from "../host/threeHost";
import type { Manifest, VariableMeta } from "../data/manifest";
import type { FormatDef } from "../formats/types";
import { DataStore } from "../data/store";
import { dataBase as resolvedDataBase } from "../data/dataBase";
import { AtmosScene, field2D, type Theme } from "../render/scene";
import { floatRange, domainOf, textureUploadMs, type Domain } from "../render/fields";
import { TimeFields, type TimeResource } from "../render/timeFields";
import { timesOf } from "../data/manifest";
import {
  advance as advanceTimeline,
  bracket,
  clockOf,
  createTimeline,
  setTime as setTimelineTime,
  stepFrame as stepTimelineFrame,
  RATES,
} from "../state/timeline";
import { FETCH_WINDOW_AHEAD, windowFrames } from "../state/fetchWindow";
import { canShowFrames, planOf, type LayerNeed } from "../state/openVariables";
import { HorizontalSlice, VerticalSection, type ScalarBinding } from "../render/slices";
import { VolumeLayer, type CurvedVolumeOptions } from "../render/volume";
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
import { ShellHeightLabels, shellLabelHeights } from "../render/annotations/shellLabels";
import { GlobeGround } from "../render/globeGround";
import { cellToUv, enuUnitsToUvAgl, frameOf, placeEnuUnits, uvToCell } from "../geo/boxEnu";
import { particlePlacementState } from "../geo/particlePlace";
import { exactInverse, polyInverse, type EnuFrame } from "../geo/mapping";
import type { SectionGlobe } from "../render/sections/globe";
import { readSectionSamples } from "../render/sections/globeDebug";
import { globePickSurfaces, pickSections } from "../render/sections/globePick";
import { sectionPickTargets } from "../render/sections/pickTargets";
import { terrainBlocksSight } from "../geo/lineOfSight";
import { sampleGrid, type GridField } from "../geo/placement";
import {
  DEFAULT_PARTICLES,
  WindParticles,
  type ColorMode,
  type ParticleParams,
} from "../render/particles";
import { COLORMAPS, COLORMAP_LABELS, DIVERGING, colormapRGB } from "../render/colormaps";
import { LOW_ALPHA_RAMP } from "../render/slices";
import {
  discardedFraction,
  fallbackRange,
  formatValue,
  isSparseVar as sparseOf,
  prettyUnit,
  sanitizeRange,
  thresholdPhysical,
} from "../state/fieldStyle";
import {
  blendRange,
  emptyHint,
  FrameRangeCache,
  formatLegendValue,
  rangeOfArray,
  thresholdHidesAll,
  type DataRange,
} from "../state/legendRange";
import ColorLegend from "./ColorLegend.vue";
import ProfileChart from "./ProfileChart.vue";
import RangeSlider from "./RangeSlider.vue";
import UnfoldedPlot from "./UnfoldedPlot.vue";
import TimelineBar from "./TimelineBar.vue";

export type ViewSnapshot = {
  t: number;
  playing: boolean;
  rate: number;
  smooth: boolean;
  loop: boolean;
  camera: [number, number, number];
  target: [number, number, number];
  exaggeration: number;
};

const props = withDefaults(defineProps<{
  manifestUrl?: string;
  showPanel?: boolean;
  /** export format = data directory under $WEB_ROOT (see formats/*.ts) */
  format?: FormatDef;
  initialView?: ViewSnapshot | null;
  /** Receives the viewer's container; the host picks or creates its own input / render element. */
  createHost?: (container: HTMLElement) => ViewHost;
  /** Globe tab: the volume runs in curved-shell mode; ④ sections stay off, ⑤ particles are placed on the shell. */
  globeVolume?: CurvedVolumeOptions | null;
}>(), {
  manifestUrl: "",
  showPanel: true,
  format: () => ({ id: "current", label: "当前编码", order: 0, fallbackCases: ["lowair_atmos_6h", "lowair_atmos"] }),
  initialView: null,
  createHost: undefined,
  globeVolume: null,
});
const globeMode = props.globeVolume != null;
const viewerRoot = ref<HTMLDivElement | null>(null);
const emit = defineEmits<{
  ready: [{ backend: string }];
  probe: [Record<string, unknown>];
}>();

const query = new URLSearchParams(location.search);
const embed = query.has("embed") && query.get("embed") !== "0";
/**
 * Which manifest to open (in this order):
 *  - `?data=<case>`  a repo case under data/web/ (e.g. lowair_atmos, the v6.10 single time)
 *  - `?date=YYYYMMDD` that day of this format: /data/<format>/yyyymm/yyyymmdd/manifest.json
 *  - otherwise the latest day of this format from /api/days, then the format's repo fallbacks
 */
const dataBase = resolvedDataBase();
const dateParam = (query.get("date") ?? "").replace(/-/g, "");
const dateOk = /^\d{8}$/.test(dateParam);
const caseParam = (query.get("data") ?? "").replace(/[^\w-]/g, "");
const dayUrl = (date: string) => `${dataBase}/data/${props.format.id}/${date.slice(0, 6)}/${date}/manifest.json`;
const caseUrl = (name: string) => `${dataBase}/data/${name}/manifest.json`;

async function latestDay(): Promise<string | null> {
  try {
    const r = await fetch(`${dataBase}/api/days?format=${encodeURIComponent(props.format.id)}`);
    if (!r.ok) return null;
    const body = (await r.json()) as { latest?: Record<string, string> };
    return body.latest?.[props.format.id] ?? null;
  } catch {
    return null;
  }
}

/** Candidate manifest URLs, best first. */
async function manifestCandidates(): Promise<string[]> {
  if (props.manifestUrl) return [props.manifestUrl];
  if (caseParam) return [caseUrl(caseParam)];
  if (dateOk) return [dayUrl(dateParam)];
  const latest = await latestDay();
  return [...(latest ? [dayUrl(latest)] : []), ...(props.format.fallbackCases ?? []).map(caseUrl)];
}
const timelineHidden = query.get("timeline") === "0";
/** Debug-only measurement hooks on __atmosApi (sampleCell, buildingBaseSamples). */
const debugApis = import.meta.env.DEV || query.get("globeDebug") === "1";
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
  buildingTintEnabled: false,
  buildingTintStrength: 0.6,
  ground: true,
  groundVar: "speed0",
  /** 地面值域过滤 (physical units); NaN = reset to the variable's full range. */
  groundFilterMin: Number.NaN,
  groundFilterMax: Number.NaN,
  particles: true,
  volume: false,
  volumeVar: "tke",
  volumeOpacity: 0.6,
  volumeThreshold: 0.2,
  volumeFilterMin: 0,
  volumeFilterMax: 1,
  /** When true, volume cut faces use the volume value window and transparent threshold. */
  filterSlices: true,
  /** Independent low-value alpha for volume cut faces (切面). */
  cutLowAlpha: false,
  cutLowThreshold: 0.15,
  probe: false,
  probeFollowMouse: false,
});
if (globeMode) {
  // ⑤ particles are bent onto the shell; ④ sections and ⑥ buildings, ground, probe start off like the box tabs
  layers.volume = true;
  view.exaggeration = 1;
}
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
  lowAlpha: false,
  lowThreshold: 0.15,
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
  /** 低值透明: value-based alpha ramp, default on for sparse non-negative fields. */
  lowAlpha: false,
  lowThreshold: 0.15,
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
const probeVariables = computed(() => {
  const list: { name: string; label: string }[] = [
    { name: SPEED, label: "水平风速 |V|" },
    { name: "direction", label: "风向" },
  ];
  for (const [name, meta] of Object.entries(manifest.value?.variables ?? {})) {
    if (meta.dims.length !== 3) continue;
    const destagger = meta.staggered_from ? "，已去交错" : "";
    list.push({ name, label: `${meta.label_zh} (${name}${destagger})` });
  }
  return list;
});
const probeVariable = ref(SPEED);
function probeSigned(name: string): boolean {
  if (name === SPEED || name === "direction") return false;
  const meta = manifest.value?.variables[name];
  return !!meta && meta.data_min < 0 && meta.data_max > 0;
}
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
  if (name === "direction") return "风向";
  return manifest.value?.variables[name]?.label_zh ?? name;
}
function unitsOf(name: string): string {
  if (name === SPEED) return "m/s";
  if (name === "direction") return "°";
  return manifest.value?.variables[name]?.units ?? "";
}
function defaultColormap(name: string): string {
  if (name === SPEED) return "viridis";
  const meta = manifest.value?.variables[name];
  if (!meta) return "viridis";
  if (meta.colormap === "rdbu" || (meta.data_min < 0 && meta.data_max > 0)) return "rdbu";
  return meta.colormap === "blues" ? "cividis" : meta.colormap;
}

const sparseCache = new Map<string, boolean>();
function isSparseVar(name: string): boolean {
  return sparseOf(name, { manifest: manifest.value, data: loaded(name)?.data, cache: sparseCache });
}

function sectionFallback(name: string): [number, number] {
  return displayRange(name) ?? fallbackRange(name, manifest.value?.variables[name]);
}

/** Keep section min/max finite and ordered; empty / NaN inputs fall back to display_range. */
function commitSectionRange(): void {
  const [lo, hi] = sanitizeRange(section.min, section.max, sectionFallback(section.variable));
  if (section.min !== lo) section.min = lo;
  if (section.max !== hi) section.max = hi;
}

/** Colour mapping the volume uses for `name`: follows the section style for the same variable. */
function volumeStyleFor(name: string): { colormap: string; min: number; max: number } {
  if (section.variable === name) {
    const [min, max] = sanitizeRange(section.min, section.max, sectionFallback(name));
    return { colormap: section.colormap, min, max };
  }
  const cmap = defaultColormap(name);
  const [lo, hi] = autoRange(name, cmap);
  const [min, max] = sanitizeRange(lo, hi, sectionFallback(name));
  return { colormap: cmap === "rdbu" ? "magma" : cmap, min, max };
}

function cutFaceStyle(): Omit<CompositeSurface, "kind" | "binding" | "field" | "height" | "normalX" | "normalZ" | "offset" | "clipX0" | "clipX1" | "clipZ0" | "clipZ1"> {
  const vs = volume?.bound ?? volumeStyleFor(layers.volumeVar);
  const [min, max] = sanitizeRange(vs.min, vs.max, sectionFallback(layers.volumeVar));
  const follow = Boolean(layers.filterSlices && volumeWanted());
  // Sparse defaults keep cut faces from turning into opaque dark walls even when
  // the volume threshold is 0; "follow" raises the cutoff to the volume threshold.
  const lowAlpha = layers.cutLowAlpha || (follow && layers.volumeThreshold > 0);
  const lowThreshold = follow ? Math.max(layers.cutLowThreshold, layers.volumeThreshold) : layers.cutLowThreshold;
  return {
    min, max, colormap: vs.colormap, opacity: 0.9, contours: 0,
    filterMin: layers.volumeFilterMin, filterMax: layers.volumeFilterMax,
    filterEnable: follow,
    lowAlpha, lowThreshold,
  };
}

/** Horizontal speed of the current frame (CPU, for stats / debug); cached per frame. */
const speedCache = { frame: -1, values: null as Float32Array | null, range: [0, 1] as [number, number] };
function speedValuesA(): Float32Array | null {
  const u = loaded("u");
  const v = loaded("v");
  if (!u || !v) return null;
  if (speedCache.frame === cur.a && speedCache.values) return speedCache.values;
  const values = new Float32Array(u.data.length);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < values.length; i += 1) {
    const s = Math.hypot(u.data[i]!, v.data[i]!);
    values[i] = s;
    if (Number.isFinite(s)) {
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
  }
  speedCache.frame = cur.a;
  speedCache.values = values;
  speedCache.range = [lo, hi];
  return values;
}
function speedRangeA(): [number, number] {
  speedValuesA();
  return Number.isFinite(speedCache.range[0]) ? [...speedCache.range] as [number, number] : [0, 1];
}

function volumeFullRange(name: string): [number, number] {
  // Fixed across time steps: the derived speed's display_range, otherwise the manifest's
  // all-frame data_min/max (schema 4) — the window slider never jumps while playing.
  if (name === SPEED) return displayRange(SPEED) ?? speedRangeA();
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
  volumeFilterNeedsSpeedRange.value = name === SPEED && !displayRange(SPEED) && !speedValuesA();
}

function updateSliceFilter(): void {
  // Never leak the volume value window onto sections. A leftover window from a
  // previous volume variable (e.g. icing 0–1) would discard a section of v.
  // Cut faces read the window through cutFaceStyle() when 切面跟随 is on.
  hslice?.material.setFilter(0, 1, false);
  vsection?.material.setFilter(0, 1, false);
  polyline?.material.setFilter(0, 1, false);
  boxStack?.material.setFilter(0, 1, false);
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
  if (!manifest.value || !domain) return [0, 1];
  return volumeFullRange(layers.volumeVar);
});

// ---------------------------------------------------------------- three.js objects
let store: DataStore;
let host: ViewHost | null = null;
let atmos: AtmosScene;
let domain: Domain;
let timeFields: TimeFields | null = null;
/** global timeline (state/timeline.ts); independent of every style / draw state */
const tl = createTimeline();
/** frames and weight currently displayed / requested: a = ⌊t⌋, b = a + 1, s = blend weight */
const cur = { a: 0, b: 0, s: 0 };
const showTimeline = computed(() => !timelineHidden && tl.frames > 1);
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
let globeGround: GlobeGround | null = null;
let shellLabels: ShellHeightLabels | null = null;
let globeFrame: EnuFrame | null = null;
const occCamBox = new THREE.Vector3();
const occAncBox = new THREE.Vector3();
let disposed = false;
const requestedAt: Record<string, number> = {};
const volumeColorRange = ref<[number, number]>([0, 1]);
const legendRanges = new FrameRangeCache();
/** Bumped when a CPU frame on screen arrives: the legend data ranges read non-reactive store data. */
const legendDataTick = ref(0);

/** Physical value of the volume transparent threshold on the colour-mapping range. */
const volumeThresholdPhysical = computed(() => {
  const [lo, hi] = volumeColorRange.value;
  return thresholdPhysical(lo, hi, layers.volumeThreshold);
});
const drawHint = computed(() => {
  if (section.kind === "polyline")
    return section.drawMode
      ? `左键加点（已 ${section.points.length} 点）· 双击/回车/右键/「完成」结束 · 右键顶点删点 · Esc 取消`
      : "查看模式：可拖动顶点 · 「编辑」继续加点 ·「重画」重新绘制";
  if (section.kind === "box")
    return section.drawMode
      ? "按住左键拖拽框选，松开即完成 · Esc 取消"
      : "查看模式：可拖动四角 ·「重画」重新框选 · 框选时暂停体渲染";
  return "";
});
const volumeThresholdHint = computed(() => {
  const unit = prettyUnit(unitsOf(layers.volumeVar));
  const phys = formatValue(volumeThresholdPhysical.value);
  return `${layers.volumeThreshold.toFixed(2)} → ${phys}${unit ? " " + unit : ""}`;
});

const volumeFilterVariable = ref("");
const volumeFilterNeedsSpeedRange = ref(false);
const depthOccluders: THREE.Object3D[] = [];

/** Physical values of `name` at the current frame ⌊t⌋ (CPU copy). */
const loaded = (name: string) => store?.get(name, cur.a);

/**
 * CPU values of `name` at the displayed instant: frame a, frame b and the blend weight.
 * Falls back to frame a alone until b has arrived.
 */
function cpuPair(name: string): { A: Float32Array; B: Float32Array | null; s: number } | null {
  const A = store?.get(name, cur.a)?.data;
  if (!A) return null;
  const B = cur.s > 0 ? (store.get(name, cur.b)?.data ?? null) : null;
  return { A, B, s: B ? cur.s : 0 };
}
const mixAt = (p: { A: Float32Array; B: Float32Array | null; s: number }, i: number) =>
  p.B
    ? (Number.isFinite(p.A[i]!) && Number.isFinite(p.B[i]!) ? p.A[i]! + (p.B[i]! - p.A[i]!) * p.s : Number.NaN)
    : p.A[i]!;

function manifestRangeAt(name: string, frame: number): DataRange | null {
  const meta = manifest.value?.variables[name];
  if (!meta) return null;
  const stats = meta.frames?.[frame] ?? meta;
  return Number.isFinite(stats.data_min) && Number.isFinite(stats.data_max)
    ? { min: stats.data_min, max: stats.data_max }
    : null;
}

function speedRangeAt(frame: number, level?: number): DataRange | null {
  const u = store?.get("u", frame)?.data;
  const v = store?.get("v", frame)?.data;
  if (!u || !v) return null;
  const n = domain.nx * domain.ny;
  const start = level === undefined ? 0 : Math.max(0, Math.min(domain.nz - 1, level)) * n;
  const end = level === undefined ? Math.min(u.length, v.length) : Math.min(start + n, u.length, v.length);
  const key = `speed@${frame}${level === undefined ? "" : `@k${level}`}`;
  return legendRanges.get(key, () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = start; i < end; i += 1) {
      const value = Math.hypot(u[i]!, v[i]!);
      if (!Number.isFinite(value)) continue;
      if (value < min) min = value;
      if (value > max) max = value;
    }
    return { min, max };
  });
}

function sectionLevel(): number | undefined {
  if (!manifest.value || section.kind !== "height") return undefined;
  const levels = manifest.value.grid.levels_m;
  const dz = levels[1] - levels[0];
  return THREE.MathUtils.clamp(Math.round((slice.heightM - levels[0]) / dz), 0, manifest.value.grid.nz - 1);
}

function frameRange(name: string, frame: number, level?: number): DataRange | null {
  if (name === SPEED) return speedRangeAt(frame, level);
  const data = store?.get(name, frame)?.data;
  if (!data) return manifestRangeAt(name, frame);
  if (level === undefined) return legendRanges.get(`${name}@${frame}`, () => rangeOfArray(data));
  const n = domain.nx * domain.ny;
  return legendRanges.get(`${name}@${frame}@k${level}`, () => rangeOfArray(data, level * n, (level + 1) * n));
}

function currentDataRange(name: string, level?: number): DataRange | null {
  void legendDataTick.value;
  const { a, b, s } = bracket(tl);
  const first = frameRange(name, a, level);
  if (!first) return null;
  const second = s > 0 ? frameRange(name, b, level) : null;
  return blendRange(first, second, s);
}

function groundStyle(name: string): { colormap: string; range: [number, number] } {
  if (name === "speed0") return { colormap: "viridis", range: displayRange("speed0") ?? displayRange(SPEED) ?? [0, 20] };
  const meta = manifest.value?.variables[name];
  return {
    colormap: meta?.colormap === "rdbu" ? "rdbu" : (meta?.colormap ?? "viridis"),
    range: displayRange(name) ?? (meta ? [meta.data_min, meta.data_max] : [0, 1]),
  };
}

const volumeDataRange = computed(() => currentDataRange(layers.volumeVar));
const volumeDataHint = computed(() => emptyHint(layers.volumeVar, volumeDataRange.value));
const volumeThresholdWarning = computed(() => {
  const range = volumeDataRange.value;
  if (!range || volumeDataHint.value || !thresholdHidesAll(volumeThresholdPhysical.value, range)) return null;
  const unit = prettyUnit(unitsOf(layers.volumeVar));
  const u = unit ? ` ${unit}` : "";
  return `阈值 ${formatLegendValue(volumeThresholdPhysical.value)}${u} 高于当前最大值 ${formatLegendValue(range.max)}${u}，体渲染全透明，调低阈值可见`;
});
const volumeCurrentMaxHint = computed(() => {
  const range = volumeDataRange.value;
  if (!range || !Number.isFinite(range.max)) return "";
  const unit = prettyUnit(unitsOf(layers.volumeVar));
  return ` · 当前最大 ${formatLegendValue(range.max)}${unit ? ` ${unit}` : ""}`;
});
/** Horizontal wind at index i, magnitude-preserving blend (same rule as the GPU pass). */
function windAt(
  u: { A: Float32Array; B: Float32Array | null; s: number },
  v: { A: Float32Array; B: Float32Array | null; s: number },
  i: number,
): [number, number, number] {
  const ua = u.A[i]!, va = v.A[i]!;
  if (!Number.isFinite(ua) || !Number.isFinite(va)) return [Number.NaN, Number.NaN, Number.NaN];
  if (!u.B || !v.B) return [ua, va, Math.hypot(ua, va)];
  const ub = u.B[i]!, vb = v.B[i]!;
  if (!Number.isFinite(ub) || !Number.isFinite(vb)) return [Number.NaN, Number.NaN, Number.NaN];
  const s = u.s;
  const m = Math.hypot(ua, va) + (Math.hypot(ub, vb) - Math.hypot(ua, va)) * s;
  let uu = ua + (ub - ua) * s;
  let vv = va + (vb - va) * s;
  const l = Math.hypot(uu, vv);
  if (l > 1e-5) {
    uu *= m / l;
    vv *= m / l;
  }
  return [uu, vv, m];
}

function request(name: string): void {
  if (!store || name === "none") return;
  const names = name === SPEED || name === "speed0" ? ["u", "v"] : [name];
  for (const n of names) {
    if (!loaded(n) && requestedAt[n] === undefined) requestedAt[n] = performance.now();
  }
  wantsDirty = true;
}

/**
 * Texture of a 3D variable at the current instant: the blended "current time" target that
 * every consumer samples, or null until its first blend.
 */
function binding(name: string): ScalarBinding | null {
  if (!timeFields || !manifest.value) return null;
  if (name === SPEED) {
    if (!timeFields.speedValid) return null;
    return { texture: timeFields.speedTexture, scale: 1, offset: 0, log10: false };
  }
  if (!manifest.value.variables[name] || manifest.value.variables[name]!.dims.length !== 3) return null;
  const r = timeFields.scalars.get(name);
  if (!r?.valid) return null;
  r.lastUsed = performance.now();
  return { texture: r.texture, scale: 1, offset: 0, log10: false };
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
    const sv = speedValuesA();
    if (!sv) return [0, 15];
    [lo, hi] = floatRange(sv, start, end);
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

function volumeWanted(): boolean {
  return layers.volume;
}
function syncStyleToSlice(): void {
  slice.variable = section.variable;
  slice.colormap = section.colormap;
  slice.autoRange = section.autoRange;
  slice.min = section.min;
  slice.max = section.max;
  slice.opacity = section.opacity;
  slice.contours = section.contours;
  slice.lowAlpha = section.lowAlpha;
  slice.lowThreshold = section.lowThreshold;
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
  section.lowAlpha = slice.lowAlpha;
  section.lowThreshold = slice.lowThreshold;
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
  // update() rebuilds slab geometry and disposes the depth twins' materials: GL work, isolated on the globe
  runLayerGl(() => boxStack?.update({ ...section.box, levels: levelsOf(), defined: false, drawing: false }));
}
/** 清除 button: drop the drawn geometry and stay in view mode. */
function clearDrawn(): void {
  if (section.kind === "polyline") clearPolyline();
  if (section.kind === "box") clearBox();
  boxDrawing = false;
  drawStart = null;
  section.drawMode = false;
  updateSection();
}
function leaveKind(prev: SectionKind | null | undefined): void {
  // Mode changes can also arrive through the API during a captured drag.
  if (pointerDown.id >= 0) host?.releasePointer(pointerDown.id);
  pointerDown.active = false;
  drag.active = false;
  drag.kind = "";
  boxDrawing = false;
  boxCorner = vertexIndex = -1;
  drawStart = null;
  host?.setCameraControl(true);
  if (host) host.element.style.cursor = "";
  hslice?.setDragging(false);
  if (prev === "polyline") clearPolyline();
  if (prev === "box") clearBox();
  if (prev === "height") hslice?.setHandleVisible(false);
  if (prev === "lon" || prev === "lat") {
    vsection?.setDragging(false);
    vsection?.setHandleVisible(false);
  }
  annotations?.removePrefixed("section-readout");
  annotations?.removePrefixed("height-readout");
}

// ---------------------------------------------------------------- layer updates
function updateSlice(): void {
  if (!hslice) return;
  const on = section.enabled && section.kind === "height";
  slice.enabled = on;
  hslice.group.visible = on;
  hslice.setHandleVisible(on);
  if (!on) return;
  const b = binding(section.variable);
  if (!b) {
    hslice.group.visible = false;
    hslice.setHandleVisible(false);
    request(section.variable);
    return;
  }
  if (section.autoRange)
    [section.min, section.max] = autoRange(section.variable, section.colormap, slice.heightM);
  commitSectionRange();
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
  vsection.setHandleVisible(on && (kind === "lon" || kind === "lat"));
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
  const stack = boxStack;
  if (on && kind === "box") {
    runLayerGl(() => stack.update({
      ...section.box,
      levels: levelsOf(),
      defined: Boolean(section.box.defined),
      drawing: boxDrawing,
    }));
  } else {
    runLayerGl(() => stack.update({ ...section.box, levels: levelsOf(), defined: false, drawing: false }));
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
    vsection.setHandleVisible(false);
    polyline.group.visible = false;
    boxStack.group.visible = false;
    request(section.variable);
    syncSectionAnnotations();
    return;
  }
  if (section.autoRange) [section.min, section.max] = autoRange(section.variable, section.colormap);
  commitSectionRange();
  syncStyleToSlice();
  vsection.material.bind(b);
  vsection.material.style(section);
  polyline.material.bind(b); polyline.material.style(section);
  boxStack.material.bind(b);
  boxStack.material.setVolumeComposited(false);
  boxStack.material.style(section);
  boxStack.material.depthWrite = section.opacity >= 0.999 && !section.lowAlpha;
  // A low-alpha stack is mostly see-through: don't let its depth-only twins hide the outline.
  boxStack.depthTwins.visible = !section.lowAlpha;
  updateSliceFilter();
  updateComposite();
  syncSectionAnnotations();
}

function updateUnfolded(): void {
  if (!section.enabled || section.kind !== "polyline" || section.points.length < 2 || !manifest.value) { unfolded.value = null; return; }
  const data = section.variable === SPEED ? null : cpuPair(section.variable);
  const u = cpuPair("u"), v = cpuPair("v");
  if (section.variable === SPEED && (!u || !v)) return;
  if (section.variable !== SPEED && !data) return;
  const g = manifest.value.grid;
  unfolded.value = sampleUnfolded(section.points, g.levels_m, domain, (x, y, z) => {
    const ix = THREE.MathUtils.clamp(Math.round((x / domain.sx + .5) * (g.nx - 1)), 0, g.nx - 1);
    const iy = THREE.MathUtils.clamp(Math.round((.5 - z / domain.sz) * (g.ny - 1)), 0, g.ny - 1);
    const k = THREE.MathUtils.clamp(Math.round((y * 1000 - g.levels_m[0]) / (g.levels_m[1] - g.levels_m[0])), 0, g.nz - 1);
    const idx = k * g.nx * g.ny + iy * g.nx + ix;
    return section.variable === SPEED ? windAt(u!, v!, idx)[2] : mixAt(data!, idx);
  });
}

/** Full data range of the current ground variable (slider bounds). */
const groundBounds = ref<[number, number]>([0, 1]);
let groundBoundsKey = "";
const groundUnits = computed(() =>
  layers.groundVar === "speed0" ? "m/s" : (manifest.value?.variables[layers.groundVar]?.units ?? ""),
);

function groundFilterFor(read: (i: number) => number): [number, number] {
  const n = domain.nx * domain.ny;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const v = read(i);
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [-Infinity, Infinity];
  if (!(hi > lo)) hi = lo + 1e-6;
  // Across time frames the bounds only grow (per ground variable), and a filter
  // handle sitting on a bound follows it — otherwise a later, windier frame would be
  // silently clipped by frame 0's maximum.
  const [plo, phi] = groundBounds.value;
  const same = groundBoundsKey === layers.groundVar;
  if (same) {
    lo = Math.min(lo, plo);
    hi = Math.max(hi, phi);
  }
  groundBoundsKey = layers.groundVar;
  groundBounds.value = [lo, hi];
  if (!Number.isFinite(layers.groundFilterMin) || !Number.isFinite(layers.groundFilterMax)) {
    layers.groundFilterMin = lo;
    layers.groundFilterMax = hi;
  } else if (same) {
    const eps = (phi - plo) * 1e-6;
    if (layers.groundFilterMin <= plo + eps) layers.groundFilterMin = lo;
    if (layers.groundFilterMax >= phi - eps) layers.groundFilterMax = hi;
  }
  const fmin = Math.min(layers.groundFilterMin, layers.groundFilterMax);
  const fmax = Math.max(layers.groundFilterMin, layers.groundFilterMax);
  // Covering the whole data range means "no filter" (keeps edge cells fully coloured).
  return [fmin <= lo ? -Infinity : fmin, fmax >= hi ? Infinity : fmax];
}


function globeOpt(): CurvedVolumeOptions | null {
  return props.globeVolume ?? null;
}
function globeK(): number {
  return globeOpt()?.geo.uGeoK.value ?? 1;
}
function globeTerrainOn(): boolean {
  return (globeOpt()?.geo.uGeoTerrain.value ?? 0) > 0.5;
}
function globeGroundField(): GridField | null {
  const g = globeOpt();
  if (!g || !globeTerrainOn()) return null;
  return g.ground;
}
function globeEnuOf(u: number, v: number, aglM: number): { x: number; y: number; z: number } {
  const g = globeOpt()!;
  const p = placeEnuUnits(g.grid, g.map, globeFrame!, u, v, aglM, globeK(), globeGroundField());
  return { x: p[0], y: p[1], z: p[2] };
}
/** ④ globe sections: shared placement inputs (null on the box tabs). */
function sectionGlobe(): SectionGlobe | null {
  const g = globeOpt();
  return g ? { map: g.map, geo: g.geo } : null;
}
/** Box km (first-two-tab layout) -> centre-ENU units on the current shell (exact float64). */
function boxToEnu(p: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return globeEnuOf(p.x / domain.sx + 0.5, 0.5 - p.z / domain.sz, p.y * 1000);
}
/** Centre-ENU units -> box km on the current shell (exact geodetic inverse; valid for cameras too). */
function enuToBox(enu: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 {
  const g = globeOpt()!;
  const s = g.map.enu_unit_m;
  const inv = exactInverse(g.grid, globeFrame!, [enu.x * s, enu.y * s, enu.z * s]);
  const ground = globeGroundField();
  const g0 = ground ? sampleGrid(ground, THREE.MathUtils.clamp(inv.u, 0, 1), THREE.MathUtils.clamp(inv.v, 0, 1)) : 0;
  const agl = (inv.h - g0) / Math.max(globeK(), 1e-9);
  return out.set((inv.u - 0.5) * domain.sx, agl / 1000, (0.5 - inv.v) * domain.sz);
}
/** World-space "up" of the shell at a box point (follows k): direction of increasing AGL. */
function shellUpWorld(p: { x: number; y: number; z: number }): THREE.Vector3 {
  const a = atmos.root.localToWorld(new THREE.Vector3().copy(boxToEnu(p) as THREE.Vector3));
  const b = atmos.root.localToWorld(new THREE.Vector3().copy(boxToEnu({ x: p.x, y: p.y + 0.1, z: p.z }) as THREE.Vector3));
  return b.sub(a).normalize();
}
const camBoxTmp = new THREE.Vector3();

/**
 * Terrain between camera and anchor (terrain on). The building occluder below works in (u, v, AGL),
 * where the ground is flat by construction, so relief has to be tested on the real ENU segment:
 * geo/lineOfSight.ts samples it by distance (step <= 60 m, <= 256 points, DEM domain only) and
 * hides the anchor when one sample is > 3 m, or two consecutive samples are > 1 m, under the ground.
 */
function globeTerrainOccluded(camEnu: THREE.Vector3, anchorEnu: THREE.Vector3): boolean {
  const g = globeOpt()!;
  const ground = globeGroundField();
  if (!ground) return false;
  const s = g.map.enu_unit_m;
  return terrainBlocksSight(
    [camEnu.x * s, camEnu.y * s, camEnu.z * s],
    [anchorEnu.x * s, anchorEnu.y * s, anchorEnu.z * s],
    (p) => polyInverse(g.map, p),
    (u, v) => sampleGrid(ground, u, v),
  );
}

function globeOccluded(camEnu: THREE.Vector3, anchorEnu: THREE.Vector3): boolean {
  if (!globeOpt()) return false;
  if (globeTerrainOccluded(camEnu, anchorEnu)) return true;
  if (!heightOccluder || !layers.buildings) return false;
  const g = globeOpt()!;
  const ground = globeGroundField();
  const cam = enuUnitsToUvAgl(g.map, [camEnu.x, camEnu.y, camEnu.z], globeK(), ground);
  const anc = enuUnitsToUvAgl(g.map, [anchorEnu.x, anchorEnu.y, anchorEnu.z], globeK(), ground);
  const sx = domain.sx, sz = domain.sz;
  occCamBox.set((cam.u - 0.5) * sx, cam.agl / 1000, (0.5 - cam.v) * sz);
  occAncBox.set((anc.u - 0.5) * sx, anc.agl / 1000, (0.5 - anc.v) * sz);
  return heightOccluder.blocked(occCamBox, occAncBox);
}

function updateGround(): void {
  if (!atmos || !manifest.value) return;
  if (globeMode) atmos.ground.visible = false;
  else atmos.ground.visible = layers.ground;
  const name = layers.groundVar;
  if (!layers.ground || name === "none") {
    atmos.setGroundField(null, [0, 1], "viridis", view.theme);
    syncGlobeGround();
    applyBuildings();
    return;
  }
  if (name === "speed0") {
    const u = cpuPair("u");
    const v = cpuPair("v");
    if (!u || !v) return request("speed0");
    const read = (i: number) => windAt(u, v, i)[2];
    const style = groundStyle(name);
    atmos.setGroundField(read, style.range, style.colormap, view.theme, 0.55, groundFilterFor(read));
    syncGlobeGround();
    applyBuildings();
    return;
  }
  const data = loaded(name);
  const pair = cpuPair(name);
  if (!data || !pair) return request(name);
  const meta = data.meta;
  const style = groundStyle(name);
  const range = style.range;
  const read = pair.B ? (i: number) => mixAt(pair, i) : field2D(meta, pair.A);
  atmos.setGroundField(read, range, style.colormap, view.theme, 0.55, groundFilterFor(read));
  syncGlobeGround();
  applyBuildings();
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
  if (layers.volumeVar === SPEED && volumeFilterNeedsSpeedRange.value && speedValuesA()) {
    resetVolumeFilter(SPEED);
  } else if (volumeFilterVariable.value !== layers.volumeVar) {
    resetVolumeFilter(layers.volumeVar);
  }
  if (section.variable === layers.volumeVar && section.autoRange) {
    [section.min, section.max] = autoRange(section.variable, section.colormap);
  }
  const vs = volumeStyleFor(layers.volumeVar);
  volumeColorRange.value = [vs.min, vs.max];
  volume.bind(b, vs.colormap, vs.min, vs.max);
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
    lowAlpha: section.lowAlpha, lowThreshold: section.lowThreshold,
    height: slice.heightM / 1000,
  };
  const s: CompositeSurface | null = (vertOn || polyOn) ? {
    kind: "vertical", binding: "section", field: vb,
    min: section.min, max: section.max, opacity: section.opacity, colormap: section.colormap,
    filterMin, filterMax, filterEnable: layers.filterSlices, contours: section.contours,
    lowAlpha: section.lowAlpha, lowThreshold: section.lowThreshold,
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
    volumeStyle: cutFaceStyle(),
  });
  // Polyline walls go into the raymarch only when all of them fit in the 16 surface slots; otherwise
  // the whole polyline falls back to plain mesh drawing (like box-select below) instead of losing walls.
  let polyComposited = false;
  if (polyOn && vb && s) {
    const walls = section.points.length - 1;
    if (surfaces.length + walls <= 16) {
      for (let i = 0; i < walls; i += 1) {
        const a = section.points[i], b = section.points[i + 1]; const dx = b.x - a.x, dz = b.z - a.z; const len = Math.hypot(dx, dz) || 1;
        surfaces.push({ ...s, kind: "vertical", normalX: -dz / len, normalZ: dx / len, offset: (-dz / len) * a.x + (dx / len) * a.z, ax: a.x, az: a.z, bx: b.x, bz: b.z });
      }
      polyComposited = true;
    } else if (compositing) {
      warnSurfaceOverflow("polyline", surfaces.length, walls);
    }
  }
  // ④ globe: box-select slabs also go into the raymarch when they fit (ray-ordered blending with the
  // volume); the first two tabs keep drawing them as meshes, as before.
  let boxComposited = false;
  const boxOn = section.enabled && section.kind === "box" && Boolean(section.box.defined) && !boxDrawing;
  if (globeMode && compositing && boxOn && boxStack?.group.visible) {
    const bb = binding(section.variable);
    const levels = boxStack.slabs.children.map((m) => m.userData.levelM as number);
    if (bb && levels.length && surfaces.length + levels.length <= 16) {
      const x0 = Math.min(section.box.x0, section.box.x1), x1 = Math.max(section.box.x0, section.box.x1);
      const z0 = Math.min(section.box.z0, section.box.z1), z1 = Math.max(section.box.z0, section.box.z1);
      for (const hM of levels) {
        surfaces.push({
          kind: "horizontal", binding: "section", field: bb,
          min: section.min, max: section.max, opacity: section.opacity, colormap: section.colormap,
          filterMin, filterMax, filterEnable: layers.filterSlices, contours: section.contours,
          lowAlpha: section.lowAlpha, lowThreshold: section.lowThreshold,
          height: hM / 1000, clipX0: x0, clipX1: x1, clipZ0: z0, clipZ1: z1,
        });
      }
      boxComposited = true;
    } else if (bb && levels.length) {
      warnSurfaceOverflow("box", surfaces.length, levels.length);
    }
  }
  volume.setSurfaces(surfaces);
  volume.setCuts(cuts);
  hslice?.material.setVolumeComposited(compositing && Boolean(hslice?.group.visible) && Boolean(hb));
  vsection?.material.setVolumeComposited(compositing && Boolean(vsection?.group.visible) && Boolean(vb));
  polyline?.material.setVolumeComposited(compositing && Boolean(polyline?.group.visible) && polyComposited);
  boxStack?.material.setVolumeComposited(boxComposited);
}

/** Section + volume ray compositing is limited to 16 surfaces (only reachable in debug coexist mode). */
let lastOverflowWarning = "";
function warnSurfaceOverflow(kind: "polyline" | "box", used: number, wanted: number): void {
  const key = `${kind}:${used}:${wanted}`;
  if (key === lastOverflowWarning) return;
  lastOverflowWarning = key;
  console.warn(`[sections] ${kind}: ${wanted} surfaces do not fit next to ${used} others (max 16); drawn as meshes, not ray-composited with the volume`);
}

function updateComposite(): void { syncVolumeSlices(); }


function markReadyStatus(): void {
  if (status.value === "加载数据清单…") status.value = "风场就绪";
}

/**
 * GL work by layers outside the host's draw pass. On the globe the context is Cesium's: isolateGl
 * resets GL around the work and puts Cesium's state cache back (globe/overlay.ts). The box host has
 * no isolateGl, so the work runs exactly as before.
 */
function runLayerGl(work: () => void): void {
  if (host?.isolateGl) host.isolateGl(work);
  else work();
}

function ensureParticles(): void {
  if (particles || !host || !manifest.value || !timeFields?.wind.valid) return;
  const wMeta = manifest.value.variables.w;
  if (!wMeta) return;
  // The particles sample the blended "current time" wind target; it never needs rebinding.
  const texture = timeFields.wind.texture;
  if (timeFields.wind.firstUploadMs !== null) recordUpload("wind", timeFields.wind.firstUploadMs);
  const wAbs = Math.max(Math.abs(wMeta.data_min), Math.abs(wMeta.data_max));
  const colourSpeed = displayRange(SPEED) ?? speedRangeA();
  const wDisplay = displayRange("w");
  const wRange = wDisplay
    ? Math.max(Math.abs(wDisplay[0]), Math.abs(wDisplay[1]))
    : Math.max(0.05, wAbs * 0.6);
  const gv = globeMode ? globeOpt() : null;
  runLayerGl(() => {
    particles = new WindParticles(
      host!.renderer,
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
      gv ? { map: gv.map, geo: gv.geo } : null,
    );
  });
  if (!particles) return;
  atmos.root.add((particles as WindParticles).object);
  speedRange.value = colourSpeed;
  markReadyStatus();
}

/** Objects excluded from the volume depth pre-pass (the volume itself first). Field meshes remain visible when opaque
 * enough to occlude the volume; particles and visual helpers must never write occluder depth. */
function updateDepthOccluders(): void {
  depthOccluders.length = 0;
  if (volume) depthOccluders.push(volume.mesh);
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

function onData(name: string, frame: number): void {
  if (name === "manifest" || name === "error") return;
  wantsDirty = true;
  if (name === "cached" || name === "wind" || name === "aborted") {
    if (name === "cached" || name === "aborted") updateReadyTicks();
    return;
  }
  if (frame === 0 && requestedAt[name] !== undefined && loadMs[name] === undefined)
    loadMs[name] = Math.round(performance.now() - requestedAt[name]);
  publishTimings();
  // CPU readers only care about the frames on screen.
  if (frame !== cur.a && frame !== cur.b) return;
  legendDataTick.value += 1;
  if (
    name === layers.groundVar ||
    ((name === "u" || name === "v") && layers.groundVar === "speed0")
  ) {
    updateGround();
  }
  if (layers.probe && probe.value) refreshProbe();
  if (section.enabled && section.kind === "polyline" && (name === section.variable || ((name === "u" || name === "v") && section.variable === SPEED))) updateUnfolded();
  // first CPU copy of a section / volume variable: style defaults may depend on it
  if (frame === cur.a && (name === section.variable || name === layers.volumeVar)) {
    updateSlice();
    updateSection();
    updateVolume();
  }
}

// ---------------------------------------------------------------- time: data wishes, GPU slots, CPU refresh
let wantsDirty = true;
let lastWantsAt = 0;
let gpuWasValid = new Set<string>();

function currentNeed(): LayerNeed {
  return {
    particles: layers.particles,
    ground: layers.ground,
    groundVar: layers.groundVar,
    volume: layers.volume,
    volumeVar: layers.volumeVar,
    section: section.enabled,
    sectionVar: section.variable,
    probe: layers.probe,
    probeVar: probeVariable.value,
  };
}

function currentPlan() {
  return planOf(currentNeed(), manifest.value?.variables ?? {});
}

/** 3D variables whose blended texture is in use right now (+ whether the speed target is). */
function gpuActive(): { scalars: string[]; speed: boolean } {
  const plan = currentPlan();
  return { scalars: plan.gpuScalars, speed: plan.needSpeed };
}

/** Names whose Float32 the CPU readers need at frames a / b. */
function cpuNames(): string[] {
  return currentPlan().cpuNames;
}

/** Frames in the sliding fetch / decode / GPU window: ⌊t⌋ and the next FETCH_WINDOW_AHEAD frames. */
function windowNow(): number[] {
  return windowFrames(tl.t, tl.frames, { ahead: FETCH_WINDOW_AHEAD, loop: tl.loop });
}

/** Hand arrived half-float frames to their GPU slots; drop ones nobody wants any more. */
function feedSlots(): void {
  if (!timeFields || !store) return;
  const want = windowNow();
  const plan = currentPlan();
  const active = plan.gpuScalars;
  for (const f of want) {
    if (plan.queueWind && !timeFields.wind.holds(f)) {
      const h = store.takeHalf("wind", f);
      if (h) timeFields.wind.offer(f, h, want);
    }
    for (const n of active) {
      const r = timeFields.scalar(n);
      r.lastUsed = performance.now();
      if (!r.holds(f)) {
        const h = store.takeHalf(n, f);
        if (h) r.offer(f, h, want);
      }
    }
  }
  timeFields.wind.releaseOutside(plan.queueWind ? want : []);
  for (const r of timeFields.scalars.values()) r.releaseOutside(want);
  for (const k of [...store.halves.keys()]) {
    const at = k.lastIndexOf("@");
    const name = k.slice(0, at);
    const f = Number(k.slice(at + 1));
    if (name === "wind" && !plan.queueWind) {
      store.halves.delete(k);
      continue;
    }
    const res = name === "wind" ? timeFields.wind : timeFields.scalars.get(name);
    // nobody wants it, or a duplicate of a frame a slot already holds
    if (!want.includes(f) || !res || res.holds(f)) store.halves.delete(k);
  }
  // free GPU slots of scalars that have not been used for a while (keeps VRAM in budget)
  const now = performance.now();
  for (const [n, r] of timeFields.scalars) {
    if (!active.includes(n) && now - r.lastUsed > 15_000) {
      if (layers.volume && layers.volumeVar === n) continue;
      if (section.enabled && section.variable === n) continue;
      timeFields.disposeScalar(n);
    }
  }
}

/** Rebuild the worker's wish list for the current sliding window only. */
function syncWants(now: number): void {
  if (!store || !manifest.value || !timeFields) return;
  if (!wantsDirty && now - lastWantsAt < 250) return;
  wantsDirty = false;
  lastWantsAt = now;
  const jobs: { kind: "fetch" | "decode" | "wind"; name: string; frame: number; half?: boolean; includeW?: boolean }[] = [];
  const frames = windowNow();
  const plan = currentPlan();
  const { gpuScalars: scalars, cpuNames: cpu } = plan;
  if (windPackNeedsRebuild(plan.includeW, frames)) wantsDirty = true;
  for (const f of frames) {
    if (plan.queueWind && !timeFields.wind.holds(f) && !store.halves.has(`wind@${f}`)) {
      jobs.push({ kind: "wind", name: "wind", frame: f, includeW: plan.includeW });
    }
    for (const n of scalars) {
      const r = timeFields.scalars.get(n);
      const needHalf = !r?.holds(f) && !store.halves.has(`${n}@${f}`);
      const needCpu = cpu.includes(n) && !store.get(n, f);
      if (needHalf || needCpu) jobs.push({ kind: "decode", name: n, frame: f, half: needHalf });
    }
    for (const n of cpu) {
      if (scalars.includes(n) || store.get(n, f)) continue;
      jobs.push({ kind: "decode", name: n, frame: f });
    }
  }
  store.want(jobs, frames);
  store.retain((name, f) => frames.includes(f) && (name === "wind" ? plan.queueWind : plan.names.includes(name)));
}

/** Variables currently open: only those the visible layers actually use. */
function openNames(): string[] {
  return currentPlan().names;
}

/** When particles turn on, drop u/v-only wind packs so the worker rebuilds them with w. */
let lastWindIncludeW: boolean | undefined;
function windPackNeedsRebuild(includeW: boolean, frames: number[]): boolean {
  if (lastWindIncludeW === includeW) return false;
  const was = lastWindIncludeW;
  lastWindIncludeW = includeW;
  if (was === undefined || !includeW || !timeFields || !store) return false;
  timeFields.wind.releaseOutside([]);
  for (const f of frames) store.halves.delete(`wind@${f}`);
  return true;
}

function updateReadyTicks(): void {
  if (!store || !manifest.value) return;
  const names = openNames();
  const ready = Array.from({ length: tl.frames }, (_, f) => names.every((n) => store.isCached(n, f)));
  if (ready.some((r, i) => r !== tl.ready[i])) tl.ready = ready;
}

/** Are frames a and b ready for every layer in use? */
function canShow(a: number, b: number): boolean {
  if (!timeFields || !store) return false;
  return canShowFrames(a, b, currentPlan(), {
    wind: (f) => timeFields!.wind.resident(f),
    scalar: (name, f) => timeFields!.scalar(name).resident(f),
    cpu: (name, f) => Boolean(store!.get(name, f)),
  });
}

const timeStats = { blendMs: 0, blends: 0, switchMs: [] as number[], lastSwitchStart: 0, shownT: -1 };
const cpuRefreshAt = { probe: 0, ground: 0, unfolded: 0 };
const cpuShown = { probe: 0, ground: 0, unfolded: 0 };

/** Per animation frame: advance playback, upload slots, blend, refresh CPU readers (throttled). */
function stepTime(now: number, dt: number): void {
  if (!timeFields) return;
  advanceTimeline(tl, dt, canShow);
  const br = bracket(tl);
  const changed = br.a !== cur.a || br.b !== cur.b || br.s !== cur.s;
  if (br.a !== cur.a || br.b !== cur.b) wantsDirty = true;
  if (br.a !== cur.a || br.b !== cur.b) legendRanges.retainFrames(windowNow());
  cur.a = br.a;
  cur.b = br.b;
  cur.s = br.s;
  if (changed && timeStats.lastSwitchStart === 0) timeStats.lastSwitchStart = now;
  feedSlots();
  timeFields.pump();
  const plan = currentPlan();
  const active = { scalars: plan.gpuScalars, speed: plan.needSpeed };
  const res: TimeResource[] = [
    ...(plan.queueWind ? [timeFields.wind] : []),
    ...active.scalars.map((n) => timeFields!.scalar(n)),
  ];
  const shown = timeFields.blend(cur.a, cur.b, cur.s, res, active.speed);
  if (shown && timeStats.lastSwitchStart) {
    timeStats.switchMs.push(performance.now() - timeStats.lastSwitchStart);
    if (timeStats.switchMs.length > 120) timeStats.switchMs.shift();
    timeStats.lastSwitchStart = 0;
  }
  if (shown) timeStats.shownT = tl.t;
  timeStats.blendMs = timeFields.lastBlendMs;
  timeStats.blends = timeFields.blendCount;
  // A target that just became valid: (re)bind the consumers once.
  const valid = new Set<string>();
  if (timeFields.wind.valid) valid.add("wind");
  if (timeFields.speedValid) valid.add(SPEED);
  for (const [n, r] of timeFields.scalars) if (r.valid) valid.add(n);
  let fresh = false;
  for (const n of valid) if (!gpuWasValid.has(n)) fresh = true;
  gpuWasValid = valid;
  if (fresh) {
    ensureParticles();
    updateSlice();
    updateSection();
    updateVolume();
    if (globeMode) markReadyStatus();
  }
  syncWants(now);
  // CPU readers follow the displayed instant: 10 Hz probe, 4 Hz ground / unfolded while
  // moving; immediately once playback / scrubbing stops.
  if (layers.probe && probe.value && cpuDue("probe", now, 100)) refreshProbe();
  if (layers.ground && layers.groundVar !== "none" && cpuDue("ground", now, 250)) updateGround();
  if (section.enabled && section.kind === "polyline" && unfoldedVisible.value && cpuDue("unfolded", now, 250))
    updateUnfolded();
}

function cpuDue(key: keyof typeof cpuRefreshAt, now: number, periodMs: number): boolean {
  if (cpuShown[key] === tl.t) return false;
  if ((tl.playing || tl.scrubbing) && now - cpuRefreshAt[key] < periodMs) return false;
  cpuRefreshAt[key] = now;
  cpuShown[key] = tl.t;
  return true;
}

function onTimelineChange(): void {
  wantsDirty = true;
}

function onTimeKey(e: KeyboardEvent): void {
  if (tl.frames <= 1 || timelineHidden) return;
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
  if (e.key === " " || e.code === "Space") {
    tl.playing = !tl.playing;
    e.preventDefault();
  } else if (e.key === "ArrowLeft") {
    stepTimelineFrame(tl, -1);
    e.preventDefault();
  } else if (e.key === "ArrowRight") {
    stepTimelineFrame(tl, 1);
    e.preventDefault();
  }
}

// ---------------------------------------------------------------- probe / profile
const previewCell = { ix: 0, iy: 0 };
let previewActive = false;
const fixedCell = ref<{ ix: number; iy: number } | null>(null);
let pointerRay: THREE.Raycaster | null = null;
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
  const u = cpuPair("u");
  const v = cpuPair("v");
  if (!u || !v) return;
  const source = cell ?? previewCell;
  const { ix, iy } = source;
  const g = manifest.value.grid;
  const name = probeVariable.value;
  const data = name === SPEED || name === "direction" ? null : cpuPair(name);
  if (name !== SPEED && name !== "direction" && !data) request(name);
  const speed: number[] = [];
  const direction: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < g.nz; k += 1) {
    const i = k * g.nx * g.ny + iy * g.nx + ix;
    const [uu, vv, mag] = windAt(u, v, i);
    speed.push(mag);
    // meteorological direction: where the wind comes from, clockwise from north
    direction.push(Number.isFinite(mag) ? (THREE.MathUtils.radToDeg(Math.atan2(-uu, -vv)) + 360) % 360 : Number.NaN);
    if (name === "direction") values.push(direction[direction.length - 1]!);
    else if (data) values.push(mixAt(data, i));
    else values.push(speed[speed.length - 1]!);
  }
  // If the requested 3D field has not arrived yet, leave values empty so the chart
  // does not briefly show speed under another variable's label.
  if (name !== SPEED && name !== "direction" && !data) values.length = 0;
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
    t: tl.t,
    valid_time: tl.frames > 1 ? `${clockOf(tl).date}T${clockOf(tl).time}` : undefined,
  };
  emit("probe", payload);
  if (window.parent !== window) window.parent.postMessage(payload, "*");
}

function setPointer(event: PointerEvent): void {
  pointerRay = host!.raycaster(event.clientX, event.clientY);
}

function cellPosition(ix: number, iy: number): [number, number] {
  const g = manifest.value!.grid;
  return [
    (ix / (g.nx - 1) - 0.5) * domain.sx,
    (0.5 - iy / (g.ny - 1)) * domain.sz,
  ];
}

function globeStem(ix: number, iy: number): { anchor: { x: number; y: number; z: number }; stemTo: { x: number; y: number; z: number } } {
  const g = globeOpt()!.grid;
  const { u, v } = cellToUv(g.nx, g.ny, ix, iy);
  return { anchor: globeEnuOf(u, v, 0), stemTo: globeEnuOf(u, v, g.top_m) };
}

function updateMarker(): void {
  if (!probeMarker) return;
  if (!layers.probe) return probeMarker.setVisible(false, false);
  const fixed = fixedCell.value;
  const same = fixed !== null && previewCell.ix === fixed.ix && previewCell.iy === fixed.iy;
  if (previewActive && !same) {
    if (globeMode && globeOpt() && globeFrame) {
      const s = globeStem(previewCell.ix, previewCell.iy);
      probeMarker.setPreviewAt(s.anchor, s.stemTo, true);
    } else {
      const [px, pz] = cellPosition(previewCell.ix, previewCell.iy);
      probeMarker.setPreview(px, pz, true);
    }
  } else {
    probeMarker.setPreview(0, 0, false);
  }
  if (fixed) {
    if (globeMode && globeOpt() && globeFrame) {
      const s = globeStem(fixed.ix, fixed.iy);
      probeMarker.setFixedAt(s.anchor, s.stemTo, true);
    } else {
      const [fx, fz] = cellPosition(fixed.ix, fixed.iy);
      probeMarker.setFixed(fx, fz, true);
    }
  } else {
    probeMarker.setFixed(0, 0, false);
  }
}

/** Debug: root-local point of the last probe pick (ENU units on the globe). */
let lastProbeHit: [number, number, number] | null = null;

function pickTargets(): THREE.Object3D[] {
  const list: THREE.Object3D[] = [];
  // globe: section meshes are box km placed in the shader (raycast disabled); globeSectionPick() covers them
  // first two tabs: section surface meshes only (outline lines would snap picks with their 1 km threshold)
  if (!globeMode) list.push(...sectionPickTargets([vsection, hslice, polyline]));
  if (globeGround) list.push(globeGround.mesh);
  else if (atmos.ground.visible) list.push(atmos.ground);
  return list;
}

/**
 * Globe: the same probe targets as the first two tabs (height slice, lon/lat wall, polyline walls),
 * picked analytically: the ENU pointer ray is clipped to the shell's
 * bounding sphere and to the ground hit, then render/sections/globePick finds the first crossing of each
 * section's box-km equation (sign change + bisection). Returns the hit in box km and in ENU units.
 */
function globeSectionPick(groundLocal: THREE.Vector3 | null): { box: THREE.Vector3; enu: THREE.Vector3 } | null {
  const surfaces = globePickSurfaces({
    height: hslice && { visible: hslice.group.visible, y: hslice.group.position.y },
    wall: vsection && { visible: vsection.group.visible, chord: () => vsection!.chord() },
    polyline: polyline && { visible: polyline.group.visible, points: polyline.points },
  }, domain);
  if (!surfaces.length || !globeFrame) return null;
  const o = atmos.root.worldToLocal(pointerRay!.ray.origin.clone());
  const d = atmos.root.worldToLocal(pointerRay!.ray.origin.clone().add(pointerRay!.ray.direction)).sub(o);
  // bounding sphere of the shell (8 box corners, exact placement)
  const centre = new THREE.Vector3().copy(boxToEnu({ x: 0, y: domain.top / 2, z: 0 }) as THREE.Vector3);
  let radius = 0;
  for (const x of [-1, 1]) for (const y of [0, 1]) for (const z of [-1, 1])
    radius = Math.max(radius, centre.distanceTo(boxToEnu({ x: (x * domain.sx) / 2, y: y * domain.top, z: (z * domain.sz) / 2 }) as THREE.Vector3));
  radius *= 1.05;
  const oc = o.clone().sub(centre);
  const a = d.lengthSq(), b = oc.dot(d), c = oc.lengthSq() - radius * radius;
  const disc = b * b - a * c;
  if (disc < 0) return null;
  const t0 = Math.max(0, (-b - Math.sqrt(disc)) / a);
  let t1 = (-b + Math.sqrt(disc)) / a;
  if (groundLocal) t1 = Math.min(t1, groundLocal.clone().sub(o).dot(d) / a);
  if (!(t1 > t0)) return null;
  const tmpEnu = new THREE.Vector3();
  const tmpBox = new THREE.Vector3();
  const hit = pickSections([o.x, o.y, o.z], [d.x, d.y, d.z], t0, t1, (p) => {
    enuToBox(tmpEnu.set(p[0], p[1], p[2]), tmpBox);
    return [tmpBox.x, tmpBox.y, tmpBox.z];
  }, surfaces);
  if (!hit) return null;
  const box = new THREE.Vector3(hit.box[0], hit.box[1], hit.box[2]);
  return { box, enu: new THREE.Vector3().copy(boxToEnu(box) as THREE.Vector3) };
}

function probeFromPointer(pin: boolean): boolean {
  const hit = pointerRay!.intersectObjects(pickTargets(), true)[0];
  const globe = globeMode && globeOpt() && globeFrame;
  let local = hit ? atmos.root.worldToLocal(hit.point.clone()) : null;
  const sec = globe ? globeSectionPick(local) : null;
  if (sec) local = sec.enu;
  if (!local) return false;
  lastProbeHit = [local.x, local.y, local.z];
  const g = manifest.value!.grid;
  if (sec) {
    // section hit: the cell under the box-km point, exactly as on the first two tabs
    const cell = uvToCell(g.nx, g.ny, sec.box.x / domain.sx + 0.5, 0.5 - sec.box.z / domain.sz);
    previewCell.ix = cell.ix;
    previewCell.iy = cell.iy;
  } else if (globe) {
    const inv = enuUnitsToUvAgl(globeOpt()!.map, [local.x, local.y, local.z], globeK(), globeGroundField());
    const cell = uvToCell(g.nx, g.ny, inv.u, inv.v);
    previewCell.ix = cell.ix;
    previewCell.iy = cell.iy;
  } else {
    previewCell.ix = Math.round(
      THREE.MathUtils.clamp((local.x / domain.sx + 0.5) * (g.nx - 1), 0, g.nx - 1),
    );
    previewCell.iy = Math.round(
      THREE.MathUtils.clamp((0.5 - local.z / domain.sz) * (g.ny - 1), 0, g.ny - 1),
    );
  }
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
const pointerDown = { id: -1, x: 0, y: 0, moved: false, active: false };
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
  return pointerRay!.intersectObjects(targets, true)[0];
}

function groundPoint(): THREE.Vector3 | null {
  if (globeMode && globeOpt()) return globeGroundPoint();
  if (!atmos?.ground) return null;
  const hit = pointerRay!.intersectObject(atmos.ground, true)[0];
  if (!hit) return null;
  const p = atmos.root.worldToLocal(hit.point.clone());
  p.x = THREE.MathUtils.clamp(p.x, -domain.sx / 2, domain.sx / 2);
  p.z = THREE.MathUtils.clamp(p.z, -domain.sz / 2, domain.sz / 2);
  p.y = 0;
  return p;
}

/**
 * Globe: pointer on the ground (DEM mesh when present, else the ENU up = 0 plane) -> box km at y = 0.
 * Polyline vertices, box corners and box drawing then work in the same box km as the first two tabs.
 */
function globeGroundPoint(): THREE.Vector3 | null {
  let local: THREE.Vector3 | null = null;
  if (globeGround) {
    const hit = pointerRay!.intersectObject(globeGround.mesh, false)[0];
    if (hit) local = atmos.root.worldToLocal(hit.point.clone());
  }
  if (!local) {
    const o = atmos.root.worldToLocal(pointerRay!.ray.origin.clone());
    const d = atmos.root.worldToLocal(pointerRay!.ray.origin.clone().add(pointerRay!.ray.direction)).sub(o);
    if (Math.abs(d.z) < 1e-12) return null;
    const t = -o.z / d.z;
    if (t <= 0) return null;
    local = o.addScaledVector(d, t);
  }
  const p = enuToBox(local);
  p.x = THREE.MathUtils.clamp(p.x, -domain.sx / 2, domain.sx / 2);
  p.z = THREE.MathUtils.clamp(p.z, -domain.sz / 2, domain.sz / 2);
  p.y = 0;
  return p;
}

/** Globe drags: the pointer-plane intersection as box km (null when the ray misses the plane). */
function dragPointBox(): THREE.Vector3 | null {
  if (!pointerRay!.ray.intersectPlane(drag.plane, tmp)) return null;
  return enuToBox(atmos.root.worldToLocal(tmp.clone()));
}

// ---------------------------------------------------------------- interaction arbiter
// Who owns a plain left click on the map. Explicit drag handles (section grips,
// height handle, polyline vertices, box corners) are always grabbed first; for
// everything else: active drawing tool > probe (if enabled) > camera.
type ClickOwner = "draw" | "probe" | "camera";
function hasGeometry(kind: SectionKind = section.kind): boolean {
  if (kind === "polyline") return section.points.length >= 2;
  if (kind === "box") return Boolean(section.box.defined);
  return true;
}
function clickOwner(): ClickOwner {
  if (section.enabled && section.drawMode && (section.kind === "polyline" || section.kind === "box")) return "draw";
  if (layers.probe) return "probe";
  return "camera";
}
/** Start drawing the current polyline/box (keeps existing geometry unless `fresh`). */
let drawBackup: { points: { x: number; z: number }[]; box: typeof section.box } | null = null;
function startDrawing(fresh = false): void {
  if (section.kind !== "polyline" && section.kind !== "box") return;
  // Esc restores what was there before 编辑 / 重画.
  drawBackup = { points: section.points.map((q) => ({ ...q })), box: { ...section.box } };
  if (fresh) {
    if (section.kind === "polyline") clearPolyline();
    else clearBox();
  }
  section.enabled = true;
  section.drawMode = true;
  if (section.kind === "polyline") unfoldedVisible.value = true;
  updateSection();
}
/** Leave the drawing state; geometry is kept, incomplete geometry is dropped. */
function finishDrawing(): void {
  if (!section.drawMode) return;
  if (boxDrawing) {
    boxDrawing = false;
    drawStart = null;
    host?.setCameraControl(true);
    if (pointerDown.id >= 0) host?.releasePointer(pointerDown.id);
    const area = Math.abs(section.box.x1 - section.box.x0) * Math.abs(section.box.z1 - section.box.z0);
    section.box.defined = area > 0.01;
  }
  drawStart = null;
  if (section.kind === "polyline") {
    // A double-click lands two clicks on the same spot: drop the duplicate tail point.
    const pts = section.points;
    while (pts.length >= 2 && Math.hypot(pts[pts.length - 1]!.x - pts[pts.length - 2]!.x, pts[pts.length - 1]!.z - pts[pts.length - 2]!.z) < 0.05) pts.pop();
    if (pts.length < 2) clearPolyline();
  }
  if (section.kind === "box" && !section.box.defined) clearBox();
  drawBackup = null;
  section.drawMode = false;
  updateSection();
}
/** Esc: abort the drawing. An in-progress box drag is discarded; finished parts stay. */
function cancelDrawing(): void {
  if (!section.drawMode) return;
  if (boxDrawing) {
    boxDrawing = false;
    section.box.defined = false;
    host?.setCameraControl(true);
    if (pointerDown.id >= 0) host?.releasePointer(pointerDown.id);
    pointerDown.active = false;
  }
  const backup = drawBackup;
  if (backup) {
    section.points = backup.points;
    Object.assign(section.box, backup.box);
  }
  finishDrawing();
}
function onDrawKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.tagName === "TEXTAREA")) return;
  if (!section.drawMode) return;
  if (e.key === "Escape") { cancelDrawing(); e.preventDefault(); }
  else if (e.key === "Enter") { finishDrawing(); e.preventDefault(); }
}
function onDoubleClick(event: MouseEvent): void {
  if (clickOwner() !== "draw" || section.kind !== "polyline") return;
  event.preventDefault();
  finishDrawing();
}

const rightDown = { x: 0, y: 0, active: false };
function onPointerDown(event: PointerEvent): void {
  if (event.button === 2) { rightDown.x = event.clientX; rightDown.y = event.clientY; rightDown.active = true; }
  if (!manifest.value || event.button !== 0) return;
  setPointer(event);
  pointerDown.id = event.pointerId;
  pointerDown.x = event.clientX;
  pointerDown.y = event.clientY;
  pointerDown.moved = false;
  pointerDown.active = true;
  const picked = annotations?.pick(event.clientX, event.clientY);
  const pickedKind = (picked?.userData as { pickable?: string; index?: number } | undefined)?.pickable;
  if (section.enabled && section.kind === "polyline" && pickedKind === "polyline-vertex") {
    vertexIndex = (picked?.userData as { index?: number }).index ?? -1;
    if (picked) annotations?.setState(picked.id, "dragging");
    host!.setCameraControl(false); host!.capturePointer(event.pointerId); event.preventDefault(); return;
  }
  if (section.kind === "box" && section.enabled && pickedKind === "box-corner") {
    boxCorner = (picked?.userData as { index?: number }).index ?? -1;
    if (picked) annotations?.setState(picked.id, "dragging");
    host!.setCameraControl(false);
    host!.capturePointer(event.pointerId);
    event.preventDefault();
    return;
  }
  const sectionHandle = pickedKind === "section";
  const heightHandle = pickedKind === "height-handle";
  if (sectionHandle && vsection && section.enabled && (section.kind === "lon" || section.kind === "lat")) {
    drag.active = true;
    drag.kind = section.kind;
    if (globeMode && globeOpt()) {
      // horizontal plane of the shell at the wall's top middle; deltas are taken in box km
      const top = { x: vsection.center.x, y: domain.top, z: vsection.center.y };
      tmp.copy(boxToEnu(top) as THREE.Vector3);
      atmos.root.localToWorld(tmp);
      drag.plane.setFromNormalAndCoplanarPoint(shellUpWorld(top), tmp);
      const s0 = dragPointBox();
      drag.start.set(s0 ? s0.x : top.x, top.y, s0 ? s0.z : top.z);
    } else {
    tmp.set(vsection.center.x, domain.top, vsection.center.y);
    atmos.root.localToWorld(tmp);
    drag.plane.set(new THREE.Vector3(0, 1, 0), -tmp.y);
    if (!pointerRay!.ray.intersectPlane(drag.plane, drag.start)) drag.start.copy(tmp);
    }
    drag.startOffset = vsection.offsetKm();
    vsection.setDragging(true, section.offsetKm);
    if (picked) annotations?.setState(picked.id, "dragging");
    host!.setCameraControl(false);
    host!.capturePointer(event.pointerId);
    event.preventDefault();
    return;
  }
  if (heightHandle && hslice && section.enabled && section.kind === "height") {
    drag.active = true;
    drag.kind = "height";
    const anchorBox = { x: domain.sx / 2, y: slice.heightM / 1000, z: 0 };
    const globeDrag = globeMode && globeOpt();
    const anchor = globeDrag ? new THREE.Vector3().copy(boxToEnu(anchorBox) as THREE.Vector3) : new THREE.Vector3(anchorBox.x, anchorBox.y, anchorBox.z);
    atmos.root.localToWorld(anchor);
    const normal = host!.camera.position.clone().sub(anchor);
    // vertical plane facing the camera: drop the component along the (shell) up direction
    const up = globeDrag ? shellUpWorld(anchorBox) : new THREE.Vector3(0, 1, 0);
    normal.addScaledVector(up, -normal.dot(up));
    if (normal.lengthSq() < 1e-8) host!.camera.getWorldDirection(normal);
    else normal.normalize();
    drag.plane.setFromNormalAndCoplanarPoint(normal, anchor);
    drag.start.copy(anchor);
    drag.startHeight = slice.heightM;
    hslice.setDragging(true, slice.heightM);
    if (picked) annotations?.setState(picked.id, "dragging");
    host!.setCameraControl(false);
    host!.capturePointer(event.pointerId);
    event.preventDefault();
    return;
  }
  if (clickOwner() === "draw") {
    const p = groundPoint();
    if (!p) return;
    if (section.kind === "polyline") {
      drawStart = p;
    } else if (section.kind === "box") {
      drawStart = p;
      boxDrawing = true;
      section.box.defined = false;
      host!.setCameraControl(false);
      host!.capturePointer(event.pointerId);
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
    let yKm: number;
    if (globeMode && globeOpt()) {
      const b = dragPointBox();
      if (!b) return;
      yKm = b.y;
    } else {
      if (!pointerRay!.ray.intersectPlane(drag.plane, tmp)) return;
      yKm = atmos.root.worldToLocal(tmp.clone()).y;
    }
    slice.heightM = THREE.MathUtils.clamp(Math.round(yKm * 1000 * 10) / 10, 12.5, 987.5);
    hslice.setDragging(true, slice.heightM);
    return;
  }
  if (drag.active && vsection && (drag.kind === "lon" || drag.kind === "lat")) {
    let local: THREE.Vector3, start: THREE.Vector3;
    if (globeMode && globeOpt()) {
      const b = dragPointBox();
      if (!b) return;
      local = b;
      start = drag.start;
    } else {
      if (!pointerRay!.ray.intersectPlane(drag.plane, tmp)) return;
      local = atmos.root.worldToLocal(tmp.clone());
      start = atmos.root.worldToLocal(drag.start.clone());
    }
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
  const sectionGripsOn = section.enabled && (section.kind === "lon" || section.kind === "lat");
  vsection?.setHighlight(sectionGripsOn && overSection);
  if (drag.active || vertexIndex >= 0 || boxCorner >= 0 || boxDrawing) host!.element.style.cursor = "grabbing";
  else host!.element.style.cursor = handle ? "grab" : "";
  if (clickOwner() === "probe") probeFromPointer(false);
}

function onPointerUp(event: PointerEvent): void {
  if (event.button === 2) {
    // A right *click* (not a right-drag orbit) while drawing a polyline:
    // on a vertex deletes it, anywhere else finishes the polyline.
    const still = rightDown.active && Math.hypot(event.clientX - rightDown.x, event.clientY - rightDown.y) <= 5;
    rightDown.active = false;
    if (still && clickOwner() === "draw" && section.kind === "polyline") {
      const picked = annotations?.pick(event.clientX, event.clientY);
      const ud = picked?.userData as { pickable?: string; index?: number } | undefined;
      if (ud?.pickable === "polyline-vertex" && ud.index !== undefined) { section.points.splice(ud.index, 1); updateSection(); }
      else finishDrawing();
    }
    return;
  }
  const wasClick = pointerDown.active && !pointerDown.moved && !drag.active && event.button === 0;
  if (drag.active) {
    drag.active = false;
    drag.kind = "";
    host!.setCameraControl(true);
    vsection?.setDragging(false);
    hslice?.setDragging(false);
    vsection?.syncAnnotations();
    hslice?.syncAnnotations();
    host!.releasePointer(event.pointerId);
  }
  if (boxDrawing) {
    const area = Math.abs(section.box.x1 - section.box.x0) * Math.abs(section.box.z1 - section.box.z0);
    section.box.defined = area > 0.01;
    if (!section.box.defined) clearBox();
    boxDrawing = false;
    drawStart = null;
    host!.setCameraControl(true);
    host!.releasePointer(event.pointerId);
    pointerDown.active = false;
    // Mouse-up finishes the box: back to view mode (corners stay draggable).
    if (section.box.defined) section.drawMode = false;
    updateSection();
    return;
  }
  if (vertexIndex >= 0 || boxCorner >= 0) {
    polyline?.syncAnnotations();
    boxStack?.syncAnnotations();
    vertexIndex = -1;
    boxCorner = -1;
    drawStart = null;
    host!.setCameraControl(true);
    host!.releasePointer(event.pointerId);
    pointerDown.active = false;
    return;
  }
  if (clickOwner() === "draw" && section.kind === "polyline" && wasClick && drawStart) {
    section.points = [...section.points, { x: drawStart.x, z: drawStart.z }].slice(-16);
    drawStart = null;
    unfoldedVisible.value = true;
    updateSection();
  }
  pointerDown.active = false;
  if (wasClick && clickOwner() === "probe") {
    setPointer(event);
    probeFromPointer(true);
  }
}

function onContextMenu(event: MouseEvent): void {
  if (clickOwner() !== "draw") return;
  event.preventDefault();
  // Right-click handling (delete vertex / finish) happens on pointerup so a
  // right-drag orbit is not mistaken for a click.
}

function setDrawOrbit(on: boolean): void {
  host?.setDrawMode(on);
}

function selectKind(kind: SectionKind): void {
  if ((kind === "polyline" || kind === "box") && section.kind === kind && section.enabled) {
    // Clicking the active tool again toggles drawing <-> view.
    if (section.drawMode) finishDrawing();
    else startDrawing(false);
    return;
  }
  const prev = section.enabled ? section.kind : null;
  if (prev && prev !== kind) leaveKind(prev);
  section.kind = kind;
  section.enabled = true;
  // Entering a drawing tool with no geometry starts drawing; otherwise view mode.
  section.drawMode = (kind === "polyline" || kind === "box") && !(prev === kind && hasGeometry(kind));
  drawBackup = null;
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

function snapshot(): ViewSnapshot {
  const current = host!.getView();
  return {
    t: tl.t,
    playing: tl.playing,
    rate: tl.rate,
    smooth: tl.smooth,
    loop: tl.loop,
    camera: current.position,
    target: current.target,
    exaggeration: view.exaggeration,
  };
}

function setView(name: string): void {
  const preset = VIEWS[name] ?? VIEWS.overview;
  host!.setView(preset.pos, preset.target);
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

// ---------------------------------------------------------------- render hooks
const hostClockStart = performance.now();
let fpsFrames = 0;
let fpsTime = 0;
let ready = false;

function beforeCamera(now: number, dt: number, realDt: number): void {
  fpsFrames += 1;
  fpsTime += realDt;
  if (fpsTime > 0.5) {
    fps.value = Math.round(fpsFrames / fpsTime);
    fpsFrames = 0;
    fpsTime = 0;
    drawCalls.value = host!.renderer.info.render.calls;
    if (window.__atmosStatus) window.__atmosStatus.fps = fps.value;
  }
  processPointer();
  stepTime(now, dt);
}

function afterCamera(_now: number, dt: number, _realDt: number): void {
  atmos.root.scale.y = globeMode ? 1 : view.exaggeration;
  atmos.root.updateMatrixWorld();
  host!.camera.updateMatrixWorld();
  if (boxStack?.group.visible) {
    const camBox = globeMode && globeOpt()
      ? enuToBox(atmos.root.worldToLocal(camBoxTmp.copy(host!.camera.position)), camBoxTmp)
      : undefined;
    boxStack.sortSlabs(host!.camera, atmos.root, camBox);
  }
  annotations?.update(host!.camera);
  hslice?.setRoot(atmos.root);
  vsection?.setRoot(atmos.root);
  polyline?.material.setRoot(atmos.root);
  boxStack?.material.setRoot(atmos.root);
  if (particles) {
    particles.object.visible = layers.particles;
    if (layers.particles) runLayerGl(() => particles!.step(dt));
  }
  if (volume?.mesh.visible) {
    updateDepthOccluders();
    volume.resize(host!.renderer);
    host!.captureOccluderDepth(volume.depthTarget, atmos.scene, depthOccluders);
    volume.markDepthValid();
    volume.update(host!.camera, atmos.root, host!.renderer);
  }
}

/** Debug only: keep a section and the volume on together to exercise the in-raymarch compositing. */
let debugCoexist = false;
/** Debug (globe): pending section read-back, served from afterRender so GL work stays in frame hooks. */
let sectionProbeRequest: { points: [number, number][]; resolve: (r: unknown) => void } | null = null;

// round-to-nearest half float (as the GPU stores HalfFloat targets); three's toHalfFloat truncates
const f16round: (x: number) => number =
  (Math as unknown as { f16round?: (x: number) => number }).f16round ?? ((x) => THREE.DataUtils.fromHalfFloat(THREE.DataUtils.toHalfFloat(x)));
function trilinearAt(read: (i: number) => number, p: { x: number; y: number; z: number }, half: boolean): number {
  const g = manifest.value!.grid;
  const nx = g.nx, ny = g.ny, nz = g.nz;
  const fx = THREE.MathUtils.clamp((p.x / domain.sx + 0.5) * (nx - 1), 0, nx - 1);
  const fy = THREE.MathUtils.clamp((0.5 - p.z / domain.sz) * (ny - 1), 0, ny - 1);
  const fz = THREE.MathUtils.clamp((p.y / domain.top) * nz - 0.5, 0, nz - 1);
  const x0 = Math.min(Math.floor(fx), nx - 2), y0 = Math.min(Math.floor(fy), ny - 2), z0 = Math.min(Math.floor(fz), nz - 2);
  const ax = fx - x0, ay = fy - y0, az = fz - z0;
  const at = (ix: number, iy: number, iz: number) => {
    const v = read(iz * nx * ny + iy * nx + ix);
    return half ? f16round(v) : v;
  };
  let acc = 0;
  for (const [dz, wz] of [[0, 1 - az], [1, az]] as const)
    for (const [dy, wy] of [[0, 1 - ay], [1, ay]] as const)
      for (const [dx, wx] of [[0, 1 - ax], [1, ax]] as const) acc += wx * wy * wz * at(x0 + dx, y0 + dy, z0 + dz);
  return acc;
}

function runSectionProbe(points: [number, number][]): unknown {
  if (!globeMode || !globeOpt() || !host) return null;
  const meshes: THREE.Mesh[] = [];
  if (hslice?.group.visible) meshes.push(hslice.mesh);
  if (vsection?.group.visible) meshes.push(vsection.mesh);
  if (polyline?.group.visible) meshes.push(polyline.mesh);
  if (boxStack?.group.visible) for (const c of boxStack.slabs.children) meshes.push(c as THREE.Mesh);
  const samples = readSectionSamples(host.renderer, host.camera, meshes, points);
  const name = section.variable;
  let read: ((i: number) => number) | null = null;
  if (name === SPEED) {
    const u = cpuPair("u"), v = cpuPair("v");
    if (u && v) read = (i) => windAt(u, v, i)[2];
  } else {
    const pair = cpuPair(name);
    if (pair) read = (i) => mixAt(pair, i);
  }
  const unit = globeOpt()!.map.enu_unit_m;
  const rows = samples.map((s) => {
    const p = { x: s.local[0], y: s.local[1], z: s.local[2] };
    const exact = boxToEnu(p);
    const resid = Math.hypot(exact.x - s.enu[0], exact.y - s.enu[1], exact.z - s.enu[2]) * unit * 1000;
    const cpu = read ? trilinearAt(read, p, false) : NaN;
    const cpuHalf = read ? trilinearAt(read, p, true) : NaN;
    return { at: s.at, local: s.local, gpu: s.value, cpu, cpuHalf, diff: s.value - cpu, diffHalf: s.value - cpuHalf, residualMm: resid };
  });
  const maxAbs = (f: (r: (typeof rows)[0]) => number) => rows.reduce((m, r) => Math.max(m, Math.abs(f(r))), 0);
  return {
    variable: name, f16: "f16round" in Math, meshes: meshes.length, samples: rows.length,
    maxAbsDiff: maxAbs((r) => r.diff), maxAbsDiffHalf: maxAbs((r) => r.diffHalf), maxResidualMm: maxAbs((r) => r.residualMm),
    rows,
  };
}

function afterRender(_now: number): void {
  if (sectionProbeRequest) {
    const req = sectionProbeRequest;
    sectionProbeRequest = null;
    try { req.resolve(runSectionProbe(req.points)); } catch (e) { req.resolve({ error: String(e) }); }
  }
  if (!ready && (particles || globeMode)) {
    wantsDirty = true;
    ready = true;
    performance.mark("atmos:first-frame");
    const started = (window as any).__atmosStart as number | undefined;
    const firstFrameMs = performance.now() - (started ?? 0);
    publishTimings({ firstFrameMs });
    window.__atmosStatus = {
      frames: tl.frames,
      backend: "WebGL2",
      gpu: gpu.value,
      particlePath: particles?.label ?? "",
      particleCount: particles?.count ?? 0,
      fps: fps.value,
      buildings: buildings?.meta?.count ?? 0,
    };
    window.__atmosReady = true;
    emit("ready", { backend: "WebGL2" });
    if (window.parent !== window) window.parent.postMessage({ type: "atmos:ready" }, "*");
  }
}

function resize(width: number, height: number): void {
  boxStack?.setResolution(width, height);
  volume?.resize(host!.renderer);
}

function exposeApi(): void {
  window.__atmosApi = {
    setView,
    snapshot,
    dataError: () => store?.lastError ?? "",
    setSection: (p: Partial<typeof section>) => {
      const prev = section.enabled ? section.kind : null;
      // Assign the variable first: its (sync) watcher applies per-variable defaults,
      // then explicit colormap / lowAlpha etc. in `p` override them.
      if (p.variable !== undefined) section.variable = p.variable;
      Object.assign(section, { enabled: true }, p);
      if (p.kind && p.kind !== prev) leaveKind(prev);
      if (p.azimuthDeg !== undefined && p.kind === undefined && (section.kind === "lon" || section.kind === "lat" || prev === null)) {
        const az = ((Number(p.azimuthDeg) % 180) + 180) % 180;
        if (section.kind !== "lon" && section.kind !== "lat") section.kind = Math.abs(az - 90) < 45 ? "lat" : "lon";
      }
      if (section.kind === "lon") section.azimuthDeg = 0;
      if (section.kind === "lat") section.azimuthDeg = 90;
      if (p.drawMode === undefined) section.drawMode = (section.kind === "polyline" || section.kind === "box") && !hasGeometry();
      slice.enabled = section.kind === "height";
      updateSection();
    },
    setSectionMode: (kind: SectionKind) => { selectKind(kind); },
    /** Drawing-state controls, mirroring the panel buttons / keys. */
    drawAction: (action: "edit" | "redraw" | "clear" | "finish" | "cancel") => {
      if (action === "edit") startDrawing(false);
      else if (action === "redraw") startDrawing(true);
      else if (action === "clear") clearDrawn();
      else if (action === "finish") finishDrawing();
      else cancelDrawing();
    },
    interactionState: () => ({ owner: clickOwner(), drawing: section.drawMode, kind: section.kind, points: section.points.length, boxDefined: Boolean(section.box.defined), probe: layers.probe, pinned: fixedCell.value ? { ...fixedCell.value } : null, box: { ...section.box } }),
    setPolyline: (points: { x: number; z: number }[]) => {
      if (section.kind !== "polyline") {
        if (section.enabled) leaveKind(section.kind);
      }
      section.kind = "polyline";
      section.enabled = true;
      section.points = points.slice(0, 16);
      section.drawMode = section.points.length < 2;
      unfoldedVisible.value = true;
      updateSection();
    },
    setBox: (p: Partial<BoxStackParams>) => {
      if (section.kind !== "box" && section.enabled) leaveKind(section.kind);
      section.kind = "box";
      section.enabled = true;
      Object.assign(section.box, p);
      const hasArea = Math.abs((section.box.x1 ?? 0) - (section.box.x0 ?? 0)) * Math.abs((section.box.z1 ?? 0) - (section.box.z0 ?? 0)) > 1e-6;
      section.box.defined = p.defined !== undefined ? Boolean(p.defined) : hasArea;
      section.drawMode = !section.box.defined;
      updateSection();
    },
    setCuts: (p: Partial<CutState>) => { if (p.x) cuts.x = [...p.x] as [number, number]; if (p.y) cuts.y = [...p.y] as [number, number]; if (p.z) cuts.z = [...p.z] as [number, number]; if (p.faces !== undefined) cuts.faces = p.faces; clampCuts(cuts); updateVolume(); },
    setSlice: (p: Partial<typeof slice>) => {
      if (p.variable !== undefined) {
        section.variable = p.variable;
        syncStyleToSlice();
      }
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
    setBuildingOpacity: (value: number) => {
      layers.buildingOpacity = THREE.MathUtils.clamp(Number(value) || 0, 0, 1);
    },
    setBuildingTint: (p: { enabled?: boolean; strength?: number }) => {
      if (p.enabled !== undefined) layers.buildingTintEnabled = Boolean(p.enabled);
      if (p.strength !== undefined) {
        const value = Number(p.strength);
        // Accept either the UI/API 0..1 form or a convenient 0..100 percentage.
        layers.buildingTintStrength = THREE.MathUtils.clamp(value > 1 ? value / 100 : value, 0, 1);
      }
    },
    setGroundVar: (name: string) => { layers.groundVar = name; },
    /** Ground value window in physical units; omit a side to keep it. */
    setGroundFilter: (p: { min?: number; max?: number; reset?: boolean }) => {
      if (p.reset) {
        layers.groundFilterMin = groundBounds.value[0];
        layers.groundFilterMax = groundBounds.value[1];
      }
      if (p.min !== undefined) layers.groundFilterMin = p.min;
      if (p.max !== undefined) layers.groundFilterMax = p.max;
    },
    groundBounds: () => [...groundBounds.value],
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
      cutLowAlpha?: boolean;
      cutLowThreshold?: number;
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
      if (p.cutLowAlpha !== undefined) layers.cutLowAlpha = Boolean(p.cutLowAlpha);
      if (p.cutLowThreshold !== undefined) layers.cutLowThreshold = Number(p.cutLowThreshold);
    },
    setVolumeSteps: (steps: number) => volume?.setSteps(Number(steps)),
    setCamera: (pos: [number, number, number], target: [number, number, number]) => {
      host!.setView(pos, target);
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
    setProbeVariable: (name: string) => {
      probeVariable.value = name;
      if (layers.probe && (fixedCell.value || probe.value)) refreshProbe();
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
    probeInfo: () => {
      const cell = fixedCell.value ?? (previewActive ? { ...previewCell } : null);
      const gv = globeOpt();
      let placement: Record<string, unknown> | null = null;
      if (cell && gv && globeFrame) {
        const { u, v } = cellToUv(gv.grid.nx, gv.grid.ny, cell.ix, cell.iy);
        const p0 = placeEnuUnits(gv.grid, gv.map, globeFrame, u, v, 0, globeK(), globeGroundField());
        const inv = enuUnitsToUvAgl(gv.map, p0, globeK(), globeGroundField());
        const p1 = placeEnuUnits(gv.grid, gv.map, globeFrame, inv.u, inv.v, inv.agl, globeK(), globeGroundField());
        placement = {
          ix: cell.ix,
          iy: cell.iy,
          u,
          v,
          residualM: Math.hypot(p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]) * gv.map.enu_unit_m,
        };
      }
      return { probe: probe.value, cell, placement };
    },
    /** run n simulation steps without drawing the scene (screenshots on slow software GL) */
    advance: (steps: number, dt = 1 / 60) => {
      runLayerGl(() => { for (let i = 0; i < steps; i += 1) particles?.step(dt); });
    },
    sampleParticle: () => {
      let r: number[] = [];
      runLayerGl(() => { r = particles?.sample() ?? []; });
      return r;
    },
    sampleHistory: () => {
      let r: number[][] = [];
      runLayerGl(() => { r = particles?.sampleHistory() ?? []; });
      return r;
    },
    debugVisibility: () => {
      const reasons: string[] = [];
      const volOn = Boolean(layers.volume);
      const secOn = Boolean(section.enabled);
      const volBinding = volOn ? Boolean(binding(layers.volumeVar)) : false;
      if (volOn && !volBinding) reasons.push("volume-no-data");
      if (volOn && volume && !volume.mesh.visible) reasons.push("volume-mesh-hidden");
      const vs = volume?.bound ?? (volOn ? volumeStyleFor(layers.volumeVar) : null);
      if (volOn && vs && !Number.isFinite(vs.min + vs.max)) reasons.push("volume-range-nan");
      const kind = section.kind;
      const meshOn = !secOn ? false
        : kind === "height" ? Boolean(hslice?.group.visible)
        : kind === "lon" || kind === "lat" ? Boolean(vsection?.group.visible)
        : kind === "polyline" ? Boolean(polyline?.group.visible) && section.points.length >= 2
        : kind === "box" ? Boolean(boxStack?.group.visible)
        : false;
      const secBinding = secOn ? Boolean(binding(section.variable)) : false;
      if (secOn && !secBinding) reasons.push("section-no-data");
      // A polyline/box tool that is still waiting for its first geometry is not a bug.
      const awaitingDraw = secOn && (kind === "polyline" || kind === "box") && section.drawMode && !hasGeometry();
      const noGeometry = secOn && (kind === "polyline" || kind === "box") && !section.drawMode && !hasGeometry();
      if (noGeometry) reasons.push("section-no-geometry");
      else if (secOn && !meshOn && !awaitingDraw) reasons.push("section-mesh-hidden");
      if (secOn && !Number.isFinite(Number(section.min) + Number(section.max))) reasons.push("section-range-nan");
      let discarded = 0;
      if (secOn && secBinding && !awaitingDraw && !noGeometry) {
        const data = section.variable === SPEED ? speedValuesA() : loaded(section.variable)?.data;
        if (data) {
          discarded = discardedFraction(data, {
            min: section.min, max: section.max,
            lowAlpha: section.lowAlpha, lowThreshold: section.lowThreshold,
          });
          if (discarded > 0.995) reasons.push("section-all-discarded");
        }
      }
      const ok = reasons.length === 0 && (volOn || secOn);
      if (!volOn && !secOn) reasons.push("nothing-enabled");
      return {
        ok,
        reasons,
        volume: {
          on: volOn, visible: Boolean(volume?.mesh.visible), variable: layers.volumeVar,
          colormap: vs?.colormap ?? null, min: vs?.min ?? null, max: vs?.max ?? null,
          threshold: layers.volumeThreshold, thresholdPhysical: volumeThresholdPhysical.value,
          filterMin: layers.volumeFilterMin, filterMax: layers.volumeFilterMax,
          filterSlices: layers.filterSlices, cutFaces: cuts.faces,
          cutLowAlpha: layers.cutLowAlpha, cutLowThreshold: layers.cutLowThreshold,
        },
        section: {
          on: secOn, kind, visible: meshOn, variable: section.variable,
          colormap: section.colormap, min: section.min, max: section.max,
          autoRange: section.autoRange, lowAlpha: section.lowAlpha, lowThreshold: section.lowThreshold,
          opacity: section.opacity, discarded, awaitingDraw,
        },
      };
    },
    hasData: (name: string) => Boolean(loaded(name)),
    /** Percentiles of a loaded variable (subsampled), for checking what a threshold hides. */
    debugStats: (name: string) => {
      const data = name === SPEED ? speedValuesA() : loaded(name)?.data;
      if (!data) return null;
      const step = Math.max(1, Math.floor(data.length / 100_000));
      const s: number[] = [];
      for (let i = 0; i < data.length; i += step) if (Number.isFinite(data[i]!)) s.push(data[i]!);
      if (!s.length) return null;
      s.sort((a, b) => a - b);
      const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
      return { p01: at(0.01), p10: at(0.1), p50: at(0.5), p90: at(0.9), p99: at(0.99), max: s[s.length - 1] };
    },
    debugArgmax: (name: string) => {
      const data = loaded(name)?.data;
      const g = manifest.value?.grid;
      if (!data || !g) return null;
      let best = -1;
      for (let i = 0; i < data.length; i += 1) {
        if (!Number.isFinite(data[i]!)) continue;
        if (best < 0 || data[i]! > data[best]!) best = i;
      }
      if (best < 0) return null;
      const n = g.nx * g.ny;
      return { k: Math.floor(best / n), iy: Math.floor((best % n) / g.nx), ix: best % g.nx, value: data[best] };
    },
    /** Same voxel through the volume mapping and the section mapping (CPU, same LUT). */
    debugCompare: (name: string, ix: number, iy: number, k: number) => {
      const pair = cpuPair(name);
      const g = manifest.value?.grid;
      if (!pair || !g) return null;
      // same instant as the GPU target: frames a, b mixed with weight s
      const value = mixAt(pair, k * g.nx * g.ny + iy * g.nx + ix);
      const bound = layers.volume && layers.volumeVar === name && volume?.bound ? volume.bound : volumeStyleFor(name);
      const norm = (lo: number, hi: number) => THREE.MathUtils.clamp((value - lo) / Math.max(hi - lo, 1e-9), 0, 1);
      const tv = norm(bound.min, bound.max);
      const sameVar = section.variable === name;
      const sec = sameVar
        ? { colormap: section.colormap, min: section.min, max: section.max, lowAlpha: section.lowAlpha, lowThreshold: section.lowThreshold }
        : { colormap: defaultColormap(name), ...(() => { const [min, max] = autoRange(name, defaultColormap(name)); return { min, max }; })(), lowAlpha: isSparseVar(name), lowThreshold: 0.15 };
      const ts = norm(sec.min, sec.max);
      const smooth = (e0: number, e1: number, x: number) => { const u = THREE.MathUtils.clamp((x - e0) / Math.max(e1 - e0, 1e-9), 0, 1); return u * u * (3 - 2 * u); };
      const lowFactor = sec.lowAlpha ? smooth(sec.lowThreshold, Math.min(1, sec.lowThreshold + LOW_ALPHA_RAMP), ts) : 1;
      const rgbV = colormapRGB(bound.colormap, tv);
      const rgbS = colormapRGB(sec.colormap, ts);
      return {
        value,
        heightM: g.levels_m[k],
        volume: { ...bound, threshold: layers.volumeThreshold, t: tv, rgb: rgbV, visible: tv >= layers.volumeThreshold },
        section: { ...sec, sectionVariable: section.variable, t: ts, rgb: rgbS, alpha: section.opacity * lowFactor },
        match: Math.abs(tv - ts) < 1e-6 && rgbV.every((c, i) => Math.abs(c - rgbS[i]!) <= 2),
      };
    },
    status: () => ({
      ...window.__atmosStatus, fps: fps.value, drawCalls: drawCalls.value,
      volumeEnabled: layers.volume, volumeVisible: Boolean(volume?.mesh.visible),
      sectionEnabled: section.enabled, sectionKind: section.kind,
      sectionDrawing: section.drawMode, boxDefined: section.box.defined,
      polylinePoints: section.points.length, unfoldedVisible: unfoldedVisible.value,
      t: tl.t, playing: tl.playing, frames: tl.frames, ready: [...tl.ready],
      ground: { variable: layers.groundVar, bounds: [...groundBounds.value], filter: [layers.groundFilterMin, layers.groundFilterMax] },
    }),
    timings: () => window.__atmosTimings ?? publishTimings(),
    // ---- time axis (state/timeline.ts)
    setTime: (t: number) => {
      tl.playing = false;
      setTimelineTime(tl, t);
      wantsDirty = true;
    },
    play: () => {
      tl.playing = true;
    },
    pause: () => {
      tl.playing = false;
    },
    stepFrame: (dir: number) => {
      stepTimelineFrame(tl, dir < 0 ? -1 : 1);
      wantsDirty = true;
    },
    setPlayback: (p: { rate?: number; smooth?: boolean; loop?: boolean }) => {
      if (p.rate !== undefined && (RATES as readonly number[]).includes(Number(p.rate))) tl.rate = Number(p.rate);
      if (p.smooth !== undefined) tl.smooth = Boolean(p.smooth);
      if (p.loop !== undefined) tl.loop = Boolean(p.loop);
    },
    /** frames ⌊t⌋ and ⌈t⌉ resident on the GPU and the current instant blended into the targets */
    hasFrame: (t?: number) => {
      const tt = t === undefined ? tl.t : Number(t);
      const a = Math.min(Math.floor(tt + 1e-6), tl.frames - 1);
      const b = Math.min(a + 1, tl.frames - 1);
      const resident = canShow(a, tt - a > 1e-6 ? b : a);
      return t === undefined ? resident && timeStats.shownT === tl.t : resident;
    },
    timeline: () => ({
      frames: tl.frames,
      t: tl.t,
      playing: tl.playing,
      rate: tl.rate,
      smooth: tl.smooth,
      loop: tl.loop,
      buffering: tl.buffering,
      ready: [...tl.ready],
      clock: clockOf(tl),
      shownT: timeStats.shownT,
      a: cur.a,
      b: cur.b,
      s: cur.s,
    }),
    /** GPU "current time" texel vs the same blend on the CPU (wind: u, v, w, |V|; scalars: value). */
    debugTimeTexel: (name: string, ix: number, iy: number, k: number) => {
      if (!timeFields || !manifest.value) return null;
      const g = manifest.value.grid;
      const i = k * g.nx * g.ny + iy * g.nx + ix;
      if (name === "wind") {
        const u = cpuPair("u"), v = cpuPair("v");
        if (!u || !v) return null;
        const gpu = timeFields.readTexel(timeFields.wind.target, ix, iy, k);
        const [uu, vv, m] = windAt(u, v, i);
        const lin = [mixAt(u, i), mixAt(v, i)];
        return { gpu, cpu: [uu, vv, m], linearMag: Math.hypot(lin[0]!, lin[1]!), a: cur.a, b: cur.b, s: cur.s };
      }
      const r = timeFields.scalars.get(name);
      const p = cpuPair(name);
      if (!r || !p) return null;
      return { gpu: timeFields.readTexel(r.target, ix, iy, k)[0], cpu: mixAt(p, i), a: cur.a, b: cur.b, s: cur.s };
    },
    fetchWindow: () => windowNow(),
    /** Legend colour ranges plus the current-instant data range, empty hint and threshold warning. */
    legendState: () =>
      legends.value.map((l) => ({
        key: l.key, min: l.min, max: l.max,
        dataMin: l.dataMin ?? null, dataMax: l.dataMax ?? null,
        hint: l.hint ?? null, warn: l.warn ?? null,
      })),
    abortedFetches: () => [...(store?.aborted ?? [])],
    cachedKeys: () => [...(store?.cached ?? [])],
    timeStats: () => ({
      blendMs: timeStats.blendMs,
      blends: timeStats.blends,
      switchMs: [...timeStats.switchMs],
      uploadedLayers: timeFields?.uploadedLayers ?? 0,
      gpuMB: timeFields ? timeFields.gpuBytes() / 1e6 : 0,
      cpuMB: store ? [...store.values.values()].reduce((a, v) => a + v.data.byteLength, 0) / 1e6 : 0,
      pendingHalvesMB: store ? [...store.halves.values()].reduce((a, v) => a + v.byteLength, 0) / 1e6 : 0,
      slots: timeFields
        ? Object.fromEntries(
            [timeFields.wind, ...timeFields.scalars.values()].map((r) => [r.name, r.slots.map((x) => x.frame)]),
          )
        : {},
    }),
  };
  // measurement hooks only in dev or with ?globeDebug=1 (same rule as GlobeViewer's __globeApi)
  if (!debugApis) return;
  Object.assign(window.__atmosApi, {
      lastProbeHit: () => lastProbeHit,
      /** ④ globe: GPU read-back of section value / box km / placed ENU at normalised viewport points. */
      sectionProbe: (points: [number, number][]) =>
        new Promise((resolve) => { sectionProbeRequest = { points, resolve }; }),
      /** Debug: the panel keeps sections and the volume exclusive; measurements may lift that. */
      allowSectionWithVolume: (on: boolean) => { debugCoexist = Boolean(on); },
      /** ④ globe: section state for measurements (composited flags, box placement). */
      sectionInfo: () => ({
        kind: section.kind, enabled: section.enabled, heightM: slice.heightM, offsetKm: section.offsetKm,
        points: section.points.map((q) => ({ ...q })), box: { ...section.box },
        composited: {
          height: hslice?.material.colorWrite === false, vertical: vsection?.material.colorWrite === false,
          polyline: polyline?.material.colorWrite === false, box: boxStack?.material.colorWrite === false,
        },
        visible: {
          height: Boolean(hslice?.group.visible), vertical: Boolean(vsection?.group.visible),
          polyline: Boolean(polyline?.group.visible), box: Boolean(boxStack?.group.visible),
        },
        slabs: boxStack?.slabs.children.length ?? 0,
        domain: { sx: domain.sx, sz: domain.sz, top: domain.top, nx: domain.nx, ny: domain.ny },
      }),
      sectionBoxToEnu: (p: { x: number; y: number; z: number }) => boxToEnu(p),
      /** Same pick path as a pointer move (host ray → pickTargets), at client pixel (x, y). */
      probePickAt: (x: number, y: number) => {
        pointerRay = host!.raycaster(x, y);
        return probeFromPointer(false) ? lastProbeHit : null;
      },
      /** Box km -> normalised device coords with the current tab's placement (globe: exact shell placement). */
      sectionBoxToNdc: (p: { x: number; y: number; z: number }) => {
        const local = new THREE.Vector3().copy((globeMode && globeOpt() && globeFrame ? boxToEnu(p) : p) as THREE.Vector3);
        const ndc = atmos.root.localToWorld(local).project(host!.camera);
        return [ndc.x, ndc.y, ndc.z];
      },
      /** Probe pick along the camera ray through NDC (x, y); returns the picked cell and hit (root-local). */
      probePickNdc: (x: number, y: number) => {
        const ray = new THREE.Raycaster();
        ray.setFromCamera(new THREE.Vector2(x, y), host!.camera);
        pointerRay = ray;
        const ok = probeFromPointer(false);
        if (!ok || !lastProbeHit) return null;
        const h = new THREE.Vector3(...lastProbeHit);
        const hitBox = globeMode && globeOpt() && globeFrame ? enuToBox(h) : h;
        return { cell: { ...previewCell }, hit: lastProbeHit, hitBox: [hitBox.x, hitBox.y, hitBox.z] };
      },
      annotationStates: () => {
        const cam = host!.camera.getWorldPosition(new THREE.Vector3());
        atmos.root.worldToLocal(cam);
        return { camLocal: [cam.x, cam.y, cam.z], items: annotations?.debugItems() ?? [] };
      },
      sampleCell: (name: string, ix: number, iy: number, iz = 0) => {
        const g = manifest.value?.grid;
        if (!g) return null;
        const i = iz * g.nx * g.ny + iy * g.nx + ix;
        if (name === SPEED || name === "speed" || name === "speed0") {
          const u = cpuPair("u");
          const v = cpuPair("v");
          if (!u || !v) return null;
          return windAt(u, v, i)[2];
        }
        const pair = cpuPair(name);
        if (!pair) return null;
        return mixAt(pair, i);
      },
      buildingBaseSamples: (count = 6) => {
        if (!buildings || !globeOpt() || !globeFrame) return null;
        const gv = globeOpt()!;
        const ground = globeGroundField();
        const k = globeK();
        const samples: Record<string, unknown>[] = [];
        const posList: { x: number; y: number; z: number }[] = [];
        buildings.group.traverse((child) => {
          const mesh = child as THREE.Mesh;
          if (!mesh.isMesh) return;
          const pos = mesh.geometry.getAttribute("position");
          if (!pos) return;
          const m = mesh.matrixWorld;
          const v = new THREE.Vector3();
          // a few corners of this batch
          for (const i of [0, Math.floor(pos.count / 3), Math.floor((2 * pos.count) / 3)]) {
            if (i >= pos.count) continue;
            v.fromBufferAttribute(pos, i).applyMatrix4(m);
            posList.push({ x: v.x, y: v.y, z: v.z });
            if (posList.length >= 400) return;
          }
        });
        // keep the lowest vertices (building bases, y is real height km)
        posList.sort((a, b) => a.y - b.y);
        const seen = new Set<string>();
        for (const p of posList) {
          if (p.y > 0.003) continue; // > 3 m, not a base
          const u = p.x / domain.sx + 0.5;
          const vuv = 0.5 - p.z / domain.sz;
          const key = `${u.toFixed(3)},${vuv.toFixed(3)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const placed = placeEnuUnits(gv.grid, gv.map, globeFrame!, u, vuv, 0, k, ground);
          const g0 = ground ? sampleGrid(ground, u, vuv) : 0;
          samples.push({ u, v: vuv, boxY_m: p.y * 1000, groundM: g0, enuUp_m: placed[2] * gv.map.enu_unit_m });
          if (samples.length >= count) break;
        }
        return samples;
      },
      /**
       * ⑤ globe particles: read back the newest trail node of the first n particles (grid and the
       * GPU-placed ENU) and compare with the exact float64 placement (metres). `minAglM` is the lowest
       * live node above its ground (terrain on: the bilinear ground g(u, v)).
       */
      particlePlacement: (n = 4096) => {
        const gv = globeOpt();
        if (!particles || !gv || !globeFrame) return null;
        // nothing placed yet (fresh targets after a count change while hidden, or a pending reset):
        // the history holds no particles, so there is nothing to compare
        if (particlePlacementState(particles.placedKey, particles.resetPending) === "unplaced") {
          return { unplaced: true as const, placeCount: particles.placeCount };
        }
        let nodes: { grid: number[][]; enu: number[][] } = { grid: [], enu: [] };
        runLayerGl(() => { nodes = particles!.sampleNodes(n); });
        const ground = globeGroundField();
        const k = globeK();
        const s = gv.map.enu_unit_m;
        let max = 0, sum = 0, cnt = 0, minAgl = Infinity, maxAgl = -Infinity, outside = 0;
        nodes.grid.forEach((g, i) => {
          const e = nodes.enu[i];
          if (!e) return;
          const [u, v, zKm] = g as [number, number, number];
          if (u < 0 || u > 1 || v < 0 || v > 1) { outside += 1; return; }
          const exact = placeEnuUnits(gv.grid, gv.map, globeFrame!, u, v, zKm * 1000, k, ground);
          const d = Math.hypot(e[0]! - exact[0], e[1]! - exact[1], e[2]! - exact[2]) * s;
          max = Math.max(max, d);
          sum += d;
          cnt += 1;
          minAgl = Math.min(minAgl, zKm * 1000);
          maxAgl = Math.max(maxAgl, zKm * 1000);
        });
        return { n: cnt, outside, k, terrain: Boolean(ground), maxResidualM: max, meanResidualM: cnt ? sum / cnt : 0, minAglM: minAgl, maxAglM: maxAgl, placeCount: particles.placeCount };
      },
  });
}

/** The five input listeners start() puts on host.element (removed symmetrically on unmount). */
let pointerTarget: HTMLElement | null = null;
function pointerListeners(): Array<[string, EventListener]> {
  return [
    ["pointerdown", onPointerDown as EventListener],
    ["pointermove", onPointerMove as EventListener],
    ["pointerup", onPointerUp as EventListener],
    ["contextmenu", onContextMenu as EventListener],
    ["dblclick", onDoubleClick as EventListener],
  ];
}

async function start(): Promise<void> {
  const t0 = performance.now();
  performance.mark("atmos:start");
  (window as any).__atmosStart = t0;
  const openStore = (url: string) => {
    store = new DataStore(url);
    return new Promise<boolean>((resolve) => {
      const off = store.on((name) => {
        if (name === "manifest" || name === "error") {
          off();
          resolve(name === "manifest");
        }
      });
    });
  };
  let opened = false;
  const candidates = await manifestCandidates();
  for (const url of candidates) {
    if (disposed) return;
    if (store) store.dispose();
    opened = await openStore(url);
    if (opened) break;
  }
  if (disposed || !opened || !store?.manifest) {
    status.value =
      !dateOk && !caseParam && !props.manifestUrl
        ? (props.format.missingHint ?? "没有可用数据") + (store?.lastError ? `（${store.lastError}）` : "")
        : store?.lastError || "数据清单加载失败";
    return;
  }
  loadMs.manifest = Math.round(performance.now() - t0);
  manifest.value = store.manifest;
  domain = domainOf(store.manifest);
  tl.times = timesOf(store.manifest);
  tl.frames = tl.times.length;
  tl.ready = Array.from({ length: tl.frames }, () => false);
  if (query.has("t")) setTimelineTime(tl, Number(query.get("t")));
  if (props.initialView) {
    setTimelineTime(tl, props.initialView.t);
    tl.playing = props.initialView.playing;
    tl.rate = props.initialView.rate;
    tl.smooth = props.initialView.smooth;
    tl.loop = props.initialView.loop;
  }
  const b0 = bracket(tl);
  Object.assign(cur, b0);
  resetVolumeFilter(layers.volumeVar);
  store.on(onData);
  // Timing bookmarks for the variables the first window will request (wind = u, v, w).
  for (const n of ["u", "v", "w"]) {
    if (requestedAt[n] === undefined) requestedAt[n] = performance.now();
  }

  host = props.createHost
    ? props.createHost(viewerRoot.value!)
    : createThreeHost(canvas.value!, {
      ...(props.initialView ? {
        initialView: { position: props.initialView.camera, target: props.initialView.target },
      } : {}),
      initialNow: hostClockStart,
    });
  timeFields = new TimeFields(host!.renderer, domain);
  syncWants(performance.now());
  const gl = host!.renderer.getContext();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  gpu.value = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "WebGL2";
  if (!host!.renderer.extensions.has("EXT_color_buffer_float")) {
    status.value = "此 GPU 不支持浮点渲染目标（EXT_color_buffer_float），粒子不可用";
  }

  atmos = new AtmosScene(domain);
  if (globeMode) {
    atmos.hideDecorations();
    atmos.alignLightsForEnu();
  }
  annotations = new AnnotationLayer(host!.element.parentElement ?? host!.element, atmos.root);
  if (globeMode && globeOpt()) {
    const gv = globeOpt()!;
    globeFrame = frameOf(gv.map);
    annotations.setCoordinateFrame("enu");
    annotations.setOcclusionAdapter(globeOccluded);
    if (gv.dem) {
      globeGround = new GlobeGround(gv.grid, gv.map, gv.dem);
      globeGround.setTerrain(globeTerrainOn());
      atmos.root.add(globeGround.mesh);
    }
    shellLabels = new ShellHeightLabels(annotations, gv.grid, gv.map, globeFrame);
    shellLabels.setHeights(shellLabelHeights(gv.grid.top_m, domain.levels));
    shellLabels.update(globeK(), globeGroundField());
  }
  probeMarker = new ProbeMarker(annotations, domain.top);
  // ④ globe: same box-km sections, bent onto the shell in their vertex shaders (null on the box tabs)
  const sg = globeMode ? sectionGlobe() : null;
  hslice = new HorizontalSlice(domain, sg);
  vsection = new AxisSection(domain, "lon", sg);
  polyline = new PolylineSection(domain, sg);
  boxStack = new BoxStack(domain, manifest.value.grid.levels_m, sg);
  if (sg) {
    annotations.setBoxPlacement({ toFrame: boxToEnu, toBox: (p, out) => enuToBox(p, out) });
    const stack = boxStack;
    runLayerGl(() => stack.setPlacement(boxToEnu));
  }
  const initialSize = host!.size();
  boxStack.setResolution(initialSize.width, initialSize.height);
  volume = new VolumeLayer(domain, props.globeVolume);
  volume.setDepthEncoding(host!.depthEncoding);
  // globe only: `?volSteps=` overrides the ray-march step count (box path keeps 128)
  if (globeMode && query.get("volSteps")) volume.setSteps(Number(query.get("volSteps")));
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
  if (props.initialView) {
    if (props.createHost) host!.setView(props.initialView.camera, props.initialView.target);
    view.exaggeration = props.initialView.exaggeration;
  } else if (!globeMode) {
    setView("overview");
  }
  const el = host!.element;
  pointerTarget = el;
  for (const [name, listener] of pointerListeners()) el.addEventListener(name, listener);
  window.addEventListener("keydown", onDrawKey);
  window.addEventListener("keydown", onTimeKey);
  exposeApi();
  updateGround();
  host!.start(atmos.scene, { beforeCamera, afterCamera, afterRender, resize });

  const skipBuildings = new URLSearchParams(location.search).has("noBuildings");
  if (skipBuildings) {
    loadMs.buildings = 0;
    buildingsInfo.value = "已跳过";
    return;
  }
  buildings = new Buildings();
  if (globeMode && globeOpt()) buildings.enableGlobe(globeOpt()!.map, globeOpt()!.geo);
  atmos.root.add(buildings.group);
  const tb = performance.now();
  const ok = await buildings.load(`${dataBase}/data/buildings`);
  loadMs.buildings = Math.round(performance.now() - tb);
  buildingsInfo.value = ok
    ? `${buildings.meta!.count.toLocaleString()} 栋 · 最高 ${buildings.meta!.max_height_m.toFixed(0)} m`
    : "无建筑数据";
  if (window.__atmosStatus) window.__atmosStatus.buildings = buildings.meta?.count ?? 0;
  if (ok && annotations) {
    heightOccluder = new HeightOccluder(domain.sx, domain.sz);
    heightOccluder.ingestObject(buildings.group, atmos.root);
    annotations.setOccluder(heightOccluder, globeMode || layers.buildings);
  }
  applyBuildings();
}

function syncGlobeGround(): void {
  if (!globeGround) return;
  const showField = layers.ground && layers.groundVar !== "none";
  const map = showField ? (atmos?.ground.material.map ?? null) : null;
  globeGround.setField(Boolean(showField && map), map);
  globeGround.setShadows(view.shadows && layers.buildings);
  globeGround.setTerrain(globeTerrainOn());
}

function applyBuildings(): void {
  if (!buildings) return;
  buildings.group.visible = layers.buildings;
  buildings.setOpacity(layers.buildingOpacity);
  buildings.setTint(
    atmos?.getGroundFieldTexture() ?? null,
    domain,
    layers.ground && layers.groundVar !== "none" && layers.buildingTintEnabled,
    layers.buildingTintStrength,
  );
  buildings.setExaggeration(globeMode ? 1 : view.exaggeration);
  buildings.setShadows(view.shadows);
  syncGlobeGround();
}

// ---------------------------------------------------------------- watchers (all cheap)
// a count change reallocates render targets / buffers: on the globe that GL work is isolated from Cesium
watch(particleParams, () => runLayerGl(() => particles?.setParams({ ...particleParams })), { deep: true });
watch(
  () => section.variable,
  (name) => {
    section.colormap = defaultColormap(name);
    section.autoRange = true;
    section.lowAlpha = isSparseVar(name);
    const [lo, hi] = autoRange(name, section.colormap);
    section.min = lo;
    section.max = hi;
  },
  { flush: "sync" },
);
// The volume follows the section's colour mapping when both show the same variable.
watch(
  () => [section.variable, section.colormap, section.min, section.max],
  () => {
    if (layers.volume && section.variable === layers.volumeVar) updateVolume();
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
    section.lowAlpha,
    section.lowThreshold,
  ],
  updateSection,
);
watch(
  () => section.enabled,
  (on, was) => {
    if (on && !debugCoexist) layers.volume = false;
    else if (was) {
      leaveKind(section.kind);
      section.drawMode = false;
      unfolded.value = null;
      unfoldedVisible.value = false;
      updateSection();
    }
  },
  { flush: "sync" },
);
// Last activation wins, including consecutive API calls in the same Vue tick.
watch(
  () => layers.volume,
  (on) => {
    if (on && !debugCoexist) section.enabled = false;
    updateVolume();
  },
  { flush: "sync" },
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
watch(() => [cuts.x[0], cuts.x[1], cuts.y[0], cuts.y[1], cuts.z[0], cuts.z[1], cuts.faces], () => { clampCuts(cuts); volume?.setCuts(cuts); syncVolumeSlices(); });
watch(
  () => layers.groundVar,
  () => {
    layers.groundFilterMin = Number.NaN;
    layers.groundFilterMax = Number.NaN;
  },
  { flush: "sync" },
);
watch(
  () => [
    layers.particles,
    layers.ground,
    layers.groundVar,
    layers.volume,
    layers.volumeVar,
    section.enabled,
    section.variable,
    layers.probe,
    probeVariable.value,
  ],
  () => {
    wantsDirty = true;
  },
);
watch(() => [layers.ground, layers.groundVar, layers.groundFilterMin, layers.groundFilterMax], updateGround);
watch(
  () => [layers.volumeVar, layers.volumeOpacity, layers.volumeThreshold],
  updateVolume,
);
watch(
  () => layers.volumeVar,
  (name) => {
    if (name !== volumeFilterVariable.value) resetVolumeFilter(name);
    layers.cutLowAlpha = isSparseVar(name);
    layers.cutLowThreshold = 0.15;
  },
);
watch(
  () => [layers.volumeFilterMin, layers.volumeFilterMax, layers.filterSlices, layers.cutLowAlpha, layers.cutLowThreshold],
  () => {
    updateVolumeFilter();
    if (layers.volume) syncVolumeSlices();
  },
);
watch(
  () => layers.buildings,
  // globe: terrain occlusion still applies with buildings off (globeOccluded checks the layer)
  (on) => annotations?.setOcclusionEnabled(globeMode || Boolean(on)),
);
watch(
  () => [
    layers.buildings,
    layers.buildingOpacity,
    layers.buildingTintEnabled,
    layers.buildingTintStrength,
    view.exaggeration,
    view.shadows,
  ],
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
watch(probeVariable, () => {
  if (layers.probe && (fixedCell.value || probe.value)) refreshProbe();
});
watch(() => section.drawMode, (on) => { setDrawOrbit(on); });
// Turning the probe on while drawing ends the drawing (geometry is kept).
watch(() => layers.probe, (on) => { if (on && section.drawMode) finishDrawing(); });
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
    overLow?: boolean;
    overHigh?: boolean;
    dataMin?: number;
    dataMax?: number;
    hint?: string | null;
    warn?: string | null;
  }[] = [];
  if (section.enabled) {
    const dataRange = currentDataRange(section.variable, sectionLevel());
    out.push({
      key: "section",
      title: section.kind === "height"
        ? `剖面 ${slice.heightM.toFixed(0)} m · ${labelOf(section.variable)}`
        : `剖面 · ${labelOf(section.variable)}`,
      units: unitsOf(section.variable),
      colormap: section.colormap,
      min: section.min,
      max: section.max,
      dataMin: dataRange?.min,
      dataMax: dataRange?.max,
      hint: emptyHint(section.variable, dataRange),
      ...overRange(section.variable, section.min, section.max),
    });
  }
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
      ...(name === "w" ? overRange("w", range[0], range[1]) : {}),
    });
  }
  if (volumeWanted()) {
    const dataRange = volumeDataRange.value;
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
      dataMin: dataRange?.min,
      dataMax: dataRange?.max,
      hint: volumeDataHint.value,
      warn: volumeThresholdWarning.value,
      ...overRange(layers.volumeVar, volumeColorRange.value[0], volumeColorRange.value[1]),
    });
  }
  if (layers.ground && layers.groundVar !== "none") {
    const name = layers.groundVar;
    const dataRange = currentDataRange(name === "speed0" ? SPEED : name, name === "speed0" ? 0 : undefined);
    const style = groundStyle(name);
    out.push({
      key: "ground",
      title: `地面 · ${name === "speed0" ? "近地面风速" : labelOf(name)}`,
      units: name === "speed0" ? "m/s" : unitsOf(name),
      colormap: style.colormap,
      min: style.range[0],
      max: style.range[1],
      dataMin: dataRange?.min,
      dataMax: dataRange?.max,
      hint: emptyHint(name, dataRange),
      ...overRange(name, style.range[0], style.range[1]),
    });
  }
  return out;
});

/**
 * Legend end arrows: lit when the displayed frame has values beyond the (fixed) colour
 * range. Uses the manifest's per-frame min/max of frame ⌊t⌋ (schema 4), else the file range.
 */
function overRange(name: string, lo: number, hi: number): { overLow: boolean; overHigh: boolean } {
  const meta = manifest.value?.variables[name];
  if (!meta || !Number.isFinite(lo) || !Number.isFinite(hi)) return { overLow: false, overHigh: false };
  const a = bracket(tl).a;
  const st = meta.frames?.[a] ?? meta;
  const eps = Math.abs(hi - lo) * 1e-3;
  return { overLow: st.data_min < lo - eps, overHigh: st.data_max > hi + eps };
}

/** Globe tab: terrain or exaggeration changed (shared uniforms are already updated). */
function refreshShell(): void {
  volume?.refreshShell();
  // ④ section surfaces / outlines read the shared uniforms; the fat box-stack outline is CPU-placed
  runLayerGl(() => boxStack?.refreshPlacement());
  globeGround?.setTerrain(globeTerrainOn());
  shellLabels?.update(globeK(), globeGroundField());
  updateMarker();
}

/** Globe tab debug: the curved volume's ENU box and step count. */
function globeVolumeInfo(): { box: { lo: number[]; hi: number[] } | null; steps: number; visible: boolean } {
  return { box: volume?.shellBox() ?? null, steps: volume?.steps ?? 0, visible: volume?.mesh.visible ?? false };
}

defineExpose({ snapshot, refreshShell, globeVolumeInfo });

onMounted(() => void start());
onBeforeUnmount(() => {
  disposed = true;
  // the Cesium canvas outlives this component: remove exactly what start() added
  if (pointerTarget) for (const [name, listener] of pointerListeners()) pointerTarget.removeEventListener(name, listener);
  pointerTarget = null;
  window.removeEventListener("keydown", onDrawKey);
  window.removeEventListener("keydown", onTimeKey);
  store?.dispose();
  // GL deletes (render targets, buffers, programs) on Cesium's context: isolated like the other particle GL work
  runLayerGl(() => particles?.dispose());
  hslice?.dispose();
  vsection?.dispose();
  polyline?.dispose();
  runLayerGl(() => boxStack?.dispose());
  volume?.dispose();
  buildings?.dispose();
  globeGround?.dispose();
  shellLabels?.dispose();
  timeFields?.dispose();
  host?.dispose();
  probeMarker?.dispose();
  annotations?.dispose();
});
</script>

<template>
  <div ref="viewerRoot" class="viewer" :class="[view.theme, { globe: globeMode }]">
    <canvas v-if="!globeMode" ref="canvas" class="canvas" />

    <div class="hud">
      <b>天津低空三维风场</b>
      <span>WebGL2 · {{ gpu }}{{ manifest?.codec_label ? ` · ${manifest.codec_label}` : "" }}</span>
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
        :over-low="l.overLow"
        :over-high="l.overHigh"
        :data-min="l.dataMin"
        :data-max="l.dataMax"
        :hint="l.hint"
        :warn="l.warn"
      />
    </div>

    <TimelineBar v-if="showTimeline" :tl="tl" @change="onTimelineChange" />

    <ProfileChart
      v-if="layers.probe && probe"
      class="profile-box"
      :lon="probe.lon"
      :lat="probe.lat"
      :pinned="probe.pinned"
      :levels="manifest?.grid.levels_m ?? []"
      :values="probe.values"
      :label="labelOf(probeVariable)"
      :units="unitsOf(probeVariable)"
      :signed="probeSigned(probeVariable)"
      :variable="probeVariable"
      :variables="probeVariables"
      @update:variable="probeVariable = $event"
      @close="probe = null; fixedCell = null; updateMarker()"
    />
    <UnfoldedPlot v-if="unfoldedVisible" :grid="unfolded" :min="section.min" :max="section.max" :colormap="section.colormap" :units="unitsOf(section.variable)" @close="unfoldedVisible = false" />

    <div class="hint" :class="{ 'above-timeline': showTimeline }">
      拖动：旋转 · 右键：平移 · 滚轮：缩放 · 经度/纬度剖面可拖动平移 ·
      折线：左键放点，双击/回车/右键完成；框选：拖拽松开即完成；Esc 取消 ·
      打开探针 → 悬停预览位置（不改读数）→ 单击（非拖动）固定并更新廓线；可选跟随鼠标
    </div>

    <div v-if="section.enabled && section.drawMode" class="draw-chip">
      <span class="dot" />{{ section.kind === "polyline" ? "绘制折线" : "绘制框选" }} · {{ drawHint }}
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
          <input v-model.number="layers.buildingOpacity" type="range" min="0" max="1" step="0.05"
        /></label>
        <label v-if="layers.buildings" class="row"
          ><input v-model="layers.buildingTintEnabled" type="checkbox" :disabled="!layers.ground || layers.groundVar === 'none'" />白膜着色</label
        >
        <label v-if="layers.buildings" class="slider"
          >着色程度 {{ Math.round(layers.buildingTintStrength * 100) }}%
          <input
            v-model.number="layers.buildingTintStrength"
            type="range"
            min="0"
            max="1"
            step="0.05"
            :disabled="!layers.ground || layers.groundVar === 'none'"
          />
        </label>
        <label class="row"
          ><input v-model="layers.ground" type="checkbox" />地面
          <select v-model="layers.groundVar">
            <option v-for="v in variables2D" :key="v.name" :value="v.name">{{ v.label }}</option>
          </select></label
        >
        <div
          v-if="layers.ground && layers.groundVar !== 'none' && Number.isFinite(layers.groundFilterMin)"
          class="slider range-label"
          title="只显示该值域内的地面着色（色带映射不变）；白膜着色同步过滤"
        >
          <span>地面值域</span>
          <RangeSlider
            :min="groundBounds[0]"
            :max="groundBounds[1]"
            :min-value="layers.groundFilterMin"
            :max-value="layers.groundFilterMax"
            :unit="groundUnits"
            :step="Math.max((groundBounds[1] - groundBounds[0]) / 200, 1e-6)"
            @update:min-value="layers.groundFilterMin = $event"
            @update:max-value="layers.groundFilterMax = $event"
          />
        </div>
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
          <label
            class="slider"
            title="色带映射范围上的归一化位置（0–1）。低于此值的体素完全透明，之上逐渐显现。与「数值窗口」不同：窗口是硬裁剪，阈值只改透明度。"
            >透明阈值 {{ volumeThresholdHint }}{{ volumeCurrentMaxHint
            }}<input
              v-model.number="layers.volumeThreshold"
              type="range"
              min="0"
              max="0.95"
              step="0.01"
          /></label>
          <div v-if="volumeDataHint || volumeThresholdWarning" class="panel-warn">{{ volumeDataHint ?? volumeThresholdWarning }}</div>
          <div class="slider range-label"><span>xcut</span><RangeSlider :min="0" :max="1" :min-value="cuts.x[0]" :max-value="cuts.x[1]" :step="0.01" @update:min-value="cuts.x[0] = $event" @update:max-value="cuts.x[1] = $event" /></div>
          <div class="slider range-label"><span>ycut</span><RangeSlider :min="0" :max="1" :min-value="cuts.y[0]" :max-value="cuts.y[1]" :step="0.01" @update:min-value="cuts.y[0] = $event" @update:max-value="cuts.y[1] = $event" /></div>
          <div class="slider range-label"><span>zcut</span><RangeSlider :min="0" :max="1" :min-value="cuts.z[0]" :max-value="cuts.z[1]" :step="0.01" @update:min-value="cuts.z[0] = $event" @update:max-value="cuts.z[1] = $event" /></div>
          <label class="row"><input v-model="cuts.faces" type="checkbox" />切面</label>
          <template v-if="cuts.faces">
            <label
              class="row"
              title="切面上低值按阈值渐隐，避免稀疏场（如风切变、结冰指数）画出不透明的黑墙"
              ><input v-model="layers.cutLowAlpha" type="checkbox" />切面低值透明</label
            >
            <label v-if="layers.cutLowAlpha" class="slider"
              >切面透明阈值 {{ (layers.cutLowThreshold * 100).toFixed(0) }}%
              <input v-model.number="layers.cutLowThreshold" type="range" min="0" max="0.6" step="0.01"
            /></label>
          </template>
          <div class="slider range-label" title="只渲染落在此区间内的体素（硬裁剪）。色带的映射范围不变。">
            <span>数值窗口</span>
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
          <label
            class="row"
            title="切面同时使用体渲染的数值窗口和透明阈值。剖面模式不会套用此窗口，避免换变量后整面被裁掉。"
            ><input v-model="layers.filterSlices" type="checkbox" />切面跟随体渲染过滤</label
          >
        </template>
      </details>

      <details v-if="!globeMode" open>
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
          >粒子高度下限 {{ particleParams.heightMin }} m
          <input
            v-model.number="particleParams.heightMin"
            type="range"
            min="10"
            max="950"
            step="10"
        /></label>
        <label class="slider"
          >粒子高度上限 {{ particleParams.heightMax }} m
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
        <label class="row" title="自动范围使用变量的 display_range，不随时次变化。手填时若某一端为空或非数字，会回退到该变量的默认范围。">
          <input v-model="section.autoRange" type="checkbox" />自动范围
          <input
            v-model.number="section.min"
            class="num"
            type="number"
            step="any"
            :disabled="section.autoRange"
            @blur="commitSectionRange" />–
          <input
            v-model.number="section.max"
            class="num"
            type="number"
            step="any"
            :disabled="section.autoRange"
            @blur="commitSectionRange"
        /></label>
        <label class="slider"
          >不透明度 {{ section.opacity.toFixed(2)
          }}<input v-model.number="section.opacity" type="range" min="0.1" max="1" step="0.01"
        /></label>
        <label class="row" title="按数值淡出低端：低于阈值完全透明，其上 25% 区间渐显（与体渲染阈值一致的思路）"
          ><input v-model="section.lowAlpha" type="checkbox" />低值透明</label
        >
        <label v-if="section.lowAlpha" class="slider"
          >透明阈值 {{ (section.lowThreshold * 100).toFixed(0) }}%
          <input v-model.number="section.lowThreshold" type="range" min="0" max="0.6" step="0.01"
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
        <div v-if="section.enabled && (section.kind === 'polyline' || section.kind === 'box')" class="section-tools">
          <div class="mode-picks draw-actions">
            <template v-if="section.drawMode">
              <button v-if="section.kind === 'polyline'" type="button" class="on" :disabled="section.points.length < 2" @click="finishDrawing()">完成</button>
              <button type="button" @click="cancelDrawing()">取消</button>
            </template>
            <template v-else>
              <button type="button" :disabled="!hasGeometry()" @click="startDrawing(false)">编辑</button>
              <button type="button" @click="startDrawing(true)">重画</button>
              <button type="button" :disabled="!hasGeometry()" @click="clearDrawn()">清除</button>
            </template>
            <button v-if="section.kind === 'polyline'" type="button" :class="{ on: unfoldedVisible }" @click="unfoldedVisible = !unfoldedVisible">{{ unfoldedVisible ? "隐藏展开图" : "显示展开图" }}</button>
          </div>
          <div class="hint-line">{{ drawHint }}</div>
        </div>
        <template v-if="section.kind === 'box'">
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
        <label v-if="!globeMode" class="slider"
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
        <div v-if="!globeMode" class="buttons">
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
/* globe tab: Cesium's canvas sits underneath; only the overlays take input */
.viewer.globe {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.viewer.globe .hud,
.viewer.globe .legends,
.viewer.globe .panel,
.viewer.globe .open-panel,
.viewer.globe .timeline,
.viewer.globe .profile-box {
  pointer-events: auto;
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
.panel-warn {
  margin: -2px 0 6px;
  font-size: 11px;
  line-height: 1.35;
  color: #ffc247;
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
.draw-chip {
  position: absolute;
  z-index: 6;
  top: 60px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: 999px;
  background: rgba(10, 22, 34, 0.86);
  border: 1px solid rgba(92, 225, 255, 0.55);
  color: #d8f6ff;
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}
.draw-chip .dot { width: 7px; height: 7px; border-radius: 50%; background: #5ce1ff; box-shadow: 0 0 6px #5ce1ff; }
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
.hint.above-timeline {
  bottom: 84px;
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
