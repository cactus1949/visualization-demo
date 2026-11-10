<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, shallowRef, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Manifest, VariableMeta } from "../data/manifest";
import { DataStore } from "../data/store";
import { AtmosScene, field2D, type Theme } from "../render/scene";
import { FieldTextures, byteRange, dequantize, domainOf, type Domain } from "../render/fields";
import { HorizontalSlice, VerticalSection, type ScalarBinding } from "../render/slices";
import { VolumeLayer } from "../render/volume";
import { Buildings } from "../render/buildings";
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
  variable: SPEED,
  offsetKm: 0,
  azimuthDeg: 90,
  colormap: "viridis",
  autoRange: true,
  min: 0,
  max: 15,
  opacity: 1,
  contours: 12,
});
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
  return meta.transform === "log10"
    ? [Math.pow(10, meta.range[0]), Math.pow(10, meta.range[1])]
    : [meta.data_min, meta.data_max];
}

function resetVolumeFilter(name: string): void {
  const [lo, hi] = volumeFullRange(name);
  layers.volumeFilterMin = lo;
  layers.volumeFilterMax = hi;
  volumeFilterVariable.value = name;
  volumeFilterNeedsSpeedRange.value = name === SPEED && !fields.speedBytes;
}

function updateSliceFilter(): void {
  const enabled = layers.filterSlices;
  hslice?.material.setFilter(layers.volumeFilterMin, layers.volumeFilterMax, enabled);
  vsection?.material.setFilter(layers.volumeFilterMin, layers.volumeFilterMax, enabled);
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
let buildings: Buildings | null = null;
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
      texture: fields.speed(u.data, v.data, u.meta, v.meta, MAX_SPEED),
      scale: MAX_SPEED / 255,
      offset: 0,
      log10: false,
    };
  }
  const data = loaded(name);
  if (!data) return null;
  return {
    texture: fields.scalar(name, data.data),
    scale: data.meta.scale,
    offset: data.meta.offset,
    log10: data.meta.transform === "log10",
  };
}

/**
 * Auto colour range: 2nd–98th percentile of the whole 3D field, or of one model level when
 * `heightM` is given (horizontal slices). Diverging colormaps get a symmetric range.
 */
function autoRange(name: string, colormap: string, heightM?: number): [number, number] {
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
    if (!fields.speedBytes) return [0, 15];
    const [a, b] = byteRange(fields.speedBytes, start, end);
    [lo, hi] = [(a * MAX_SPEED) / 255, (b * MAX_SPEED) / 255];
  } else {
    const data = loaded(name);
    if (!data) return [0, 1];
    const [a, b] = byteRange(data.data, start, end);
    [lo, hi] = [dequantize(data.meta, a), dequantize(data.meta, b)];
  }
  if (DIVERGING.has(colormap)) {
    const m = Math.max(Math.abs(lo), Math.abs(hi));
    return [-m, m];
  }
  return [lo, hi];
}

// ---------------------------------------------------------------- layer updates
function updateSlice(): void {
  if (!hslice) return;
  hslice.group.visible = slice.enabled;
  if (!slice.enabled) return;
  const b = binding(slice.variable);
  if (!b) {
    hslice.group.visible = false;
    request(slice.variable);
    return;
  }
  if (slice.autoRange)
    [slice.min, slice.max] = autoRange(slice.variable, slice.colormap, slice.heightM);
  hslice.material.bind(b);
  hslice.material.style(slice);
  updateSliceFilter();
  hslice.setHeightKm(slice.heightM / 1000);
}

function updateSection(): void {
  if (!vsection) return;
  vsection.group.visible = section.enabled;
  if (!section.enabled) return;
  const b = binding(section.variable);
  if (!b) {
    vsection.group.visible = false;
    request(section.variable);
    return;
  }
  if (section.autoRange) [section.min, section.max] = autoRange(section.variable, section.colormap);
  vsection.material.bind(b);
  vsection.material.style(section);
  updateSliceFilter();
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
      Math.hypot(dequantize(u.meta, u.data[i]), dequantize(v.meta, v.data[i]));
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < domain.nx * domain.ny; i += 1) {
      const s = read(i);
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
    atmos.setGroundField(read, [lo, hi], "viridis", view.theme, 0.55);
    return;
  }
  const data = loaded(name);
  if (!data) return request(name);
  const meta = data.meta;
  const cmap = meta.colormap === "rdbu" ? "rdbu" : meta.colormap;
  const range: [number, number] =
    meta.transform === "log10"
      ? [Math.pow(10, meta.range[0]), Math.pow(10, meta.range[1])]
      : [meta.data_min, meta.data_max];
  atmos.setGroundField(field2D(meta, data.data), range, cmap, view.theme, 0.55);
}

function updateVolume(): void {
  if (!volume || !manifest.value) return;
  volume.mesh.visible = layers.volume;
  if (!layers.volume) {
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
  if (layers.volumeVar === SPEED && volumeFilterNeedsSpeedRange.value && fields.speedBytes) {
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
  const compositing = Boolean(layers.volume && volume.mesh.visible);
  const filterMin = layers.volumeFilterMin;
  const filterMax = layers.volumeFilterMax;
  const hb = slice.enabled ? binding(slice.variable) : null;
  const vb = section.enabled ? binding(section.variable) : null;
  volume.setHorizontalSlice({
    enabled: compositing && Boolean(hslice?.group.visible),
    field: hb,
    min: slice.min,
    max: slice.max,
    opacity: slice.opacity,
    colormap: slice.colormap,
    filterMin,
    filterMax,
    filterEnable: layers.filterSlices,
    contours: slice.contours,
    height: slice.heightM / 1000,
  });
  volume.setVerticalSlice({
    enabled: compositing && Boolean(vsection?.group.visible),
    field: vb,
    min: section.min,
    max: section.max,
    opacity: section.opacity,
    colormap: section.colormap,
    filterMin,
    filterMax,
    filterEnable: layers.filterSlices,
    contours: section.contours,
    normal: vsection?.normal(),
    offset: vsection?.offsetKm(),
  });
  hslice?.material.setVolumeComposited(
    compositing && Boolean(hslice?.group.visible) && Boolean(hb),
  );
  vsection?.material.setVolumeComposited(
    compositing && Boolean(vsection?.group.visible) && Boolean(vb),
  );
}

function ensureParticles(): void {
  if (particles || !renderer || !manifest.value) return;
  const u = loaded("u");
  const v = loaded("v");
  const w = loaded("w");
  if (!u || !v || !w) return;
  const texture = fields.windTexture(u.data, v.data, w.data, u.meta, v.meta, MAX_SPEED);
  fields.speed(u.data, v.data, u.meta, v.meta, MAX_SPEED);
  const wAbs = Math.max(Math.abs(w.meta.data_min), Math.abs(w.meta.data_max));
  particles = new WindParticles(
    renderer,
    domain,
    {
      texture,
      scale: new THREE.Vector3(u.meta.scale, v.meta.scale, w.meta.scale),
      offset: new THREE.Vector3(u.meta.offset, v.meta.offset, w.meta.offset),
      maxSpeed: MAX_SPEED,
      speedRange: [...fields.speedRange] as [number, number],
      wRange: Math.max(0.05, wAbs * 0.6),
    },
    { ...particleParams },
  );
  atmos.root.add(particles.object);
  speedRange.value = [...fields.speedRange] as [number, number];
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
    depthOccluders.push(vsection.outline, vsection.handle);
    depthOccluders.push(vsection.mesh);
  }
}

function onData(name: string): void {
  if (name === "manifest") return;
  if (requestedAt[name] !== undefined)
    loadMs[name] = Math.round(performance.now() - requestedAt[name]);
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
  if (probe.value) refreshProbe();
}

// ---------------------------------------------------------------- probe / profile
const probeCell = { ix: 0, iy: 0 };
const pointer = new THREE.Vector2();
const raycaster = new THREE.Raycaster();
let pointerDirty = false;
let pointerEvent: PointerEvent | null = null;

function profileVariable(): string {
  return section.enabled ? section.variable : slice.enabled ? slice.variable : SPEED;
}

function refreshProbe(pinned = probe.value?.pinned ?? false): void {
  if (!manifest.value) return;
  const u = loaded("u");
  const v = loaded("v");
  if (!u || !v) return;
  const { ix, iy } = probeCell;
  const g = manifest.value.grid;
  const name = profileVariable();
  const data = name === SPEED ? null : loaded(name);
  const speed: number[] = [];
  const direction: number[] = [];
  const values: number[] = [];
  for (let k = 0; k < g.nz; k += 1) {
    const i = k * g.nx * g.ny + iy * g.nx + ix;
    const uu = dequantize(u.meta, u.data[i]);
    const vv = dequantize(v.meta, v.data[i]);
    speed.push(Math.hypot(uu, vv));
    // meteorological direction: where the wind comes from, clockwise from north
    direction.push((THREE.MathUtils.radToDeg(Math.atan2(-uu, -vv)) + 360) % 360);
    values.push(data ? dequantize(data.meta, data.data[i]) : Math.hypot(uu, vv));
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

function pickTargets(): THREE.Object3D[] {
  const list: THREE.Object3D[] = [];
  if (vsection?.group.visible) list.push(vsection.group);
  if (hslice?.group.visible) list.push(hslice.mesh);
  if (atmos.ground.visible) list.push(atmos.ground);
  return list;
}

function probeFromPointer(pin: boolean): void {
  const hit = raycaster.intersectObjects(pickTargets(), true)[0];
  if (!hit) return;
  const local = atmos.root.worldToLocal(hit.point.clone());
  const g = manifest.value!.grid;
  probeCell.ix = Math.round(
    THREE.MathUtils.clamp((local.x / domain.sx + 0.5) * (g.nx - 1), 0, g.nx - 1),
  );
  probeCell.iy = Math.round(
    THREE.MathUtils.clamp((0.5 - local.z / domain.sz) * (g.ny - 1), 0, g.ny - 1),
  );
  refreshProbe(pin);
}

// ---------------------------------------------------------------- section dragging
const drag = {
  active: false,
  rotate: false,
  plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), 0),
  start: new THREE.Vector3(),
  startOffset: 0,
};
const tmp = new THREE.Vector3();

function sectionHit(): THREE.Intersection | undefined {
  if (!vsection?.group.visible) return undefined;
  return raycaster.intersectObject(vsection.group, true)[0];
}

function onPointerDown(event: PointerEvent): void {
  if (!manifest.value || event.button !== 0) return;
  setPointer(event);
  const hit = sectionHit();
  if (hit && vsection) {
    drag.active = true;
    drag.rotate = event.shiftKey || hit.object !== vsection.mesh;
    drag.plane.set(new THREE.Vector3(0, 1, 0), -hit.point.y);
    drag.start.copy(hit.point);
    drag.startOffset = vsection.offsetKm();
    controls.enabled = false;
    canvas.value!.setPointerCapture(event.pointerId);
    event.preventDefault();
  }
}

function onPointerMove(event: PointerEvent): void {
  pointerEvent = event;
  pointerDirty = true;
}

/** Pointer handling is batched to one raycast per animation frame. */
function processPointer(): void {
  if (!pointerDirty || !pointerEvent || !manifest.value) return;
  pointerDirty = false;
  setPointer(pointerEvent);
  if (drag.active && vsection) {
    if (!raycaster.ray.intersectPlane(drag.plane, tmp)) return;
    const local = atmos.root.worldToLocal(tmp.clone());
    if (drag.rotate) {
      const c = vsection.center;
      // azimuth of the pointer around the wall centre, folded to 0..180°
      const az =
        (THREE.MathUtils.radToDeg(Math.atan2(local.x - c.x, -(local.z - c.y))) + 360) % 180;
      section.azimuthDeg = Math.round(az * 10) / 10;
    } else {
      const start = atmos.root.worldToLocal(drag.start.clone());
      const n = vsection.normal();
      const delta = (local.x - start.x) * n.x + (local.z - start.z) * n.y;
      section.offsetKm = Math.round((drag.startOffset + delta) * 1000) / 1000;
    }
    return;
  }
  const hover = Boolean(sectionHit());
  vsection?.setHighlight(hover);
  canvas.value!.style.cursor = hover ? "grab" : "";
  if (!probe.value?.pinned) probeFromPointer(false);
}

function onPointerUp(event: PointerEvent): void {
  if (drag.active) {
    drag.active = false;
    controls.enabled = true;
    canvas.value!.releasePointerCapture(event.pointerId);
  }
}

function onClick(event: MouseEvent): void {
  if (!manifest.value || event.detail > 1) return;
  if (event.altKey || event.ctrlKey || event.metaKey) {
    setPointer(event as PointerEvent);
    probeFromPointer(true);
  }
}

function onDoubleClick(event: MouseEvent): void {
  setPointer(event as PointerEvent);
  probeFromPointer(true);
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
    slice.enabled = true;
    section.enabled = false;
  } else if (name === "section") {
    section.enabled = true;
    slice.enabled = false;
  } else if (name === "overview") {
    slice.enabled = false;
    section.enabled = false;
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
  vsection?.setHandleScale(view.exaggeration);
  hslice?.material.setRoot(atmos.root);
  vsection?.material.setRoot(atmos.root);
  syncVolumeSlices();
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
    setSection: (p: Partial<typeof section>) => Object.assign(section, { enabled: true }, p),
    setSlice: (p: Partial<typeof slice>) => Object.assign(slice, { enabled: true }, p),
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
    probeAt: (ix: number, iy: number) => {
      probeCell.ix = ix;
      probeCell.iy = iy;
      refreshProbe(true);
    },
    /** run n simulation steps without drawing the scene (screenshots on slow software GL) */
    advance: (steps: number, dt = 1 / 60) => {
      for (let i = 0; i < steps; i += 1) particles?.step(dt);
    },
    sampleParticle: () => particles?.sample() ?? [],
    sampleHistory: () => particles?.sampleHistory() ?? [],
    status: () => ({ ...window.__atmosStatus, fps: fps.value, drawCalls: drawCalls.value }),
  };
}

async function start(): Promise<void> {
  store = new DataStore(props.manifestUrl);
  const t0 = performance.now();
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
  for (const n of ["u", "v", "w"]) request(n);

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
  hslice = new HorizontalSlice(domain);
  vsection = new VerticalSection(domain);
  volume = new VolumeLayer(domain);
  hslice.group.visible = false;
  vsection.group.visible = false;
  volume.mesh.visible = false;
  atmos.root.add(hslice.group, vsection.group, volume.mesh);
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
  el.addEventListener("click", onClick);
  el.addEventListener("dblclick", onDoubleClick);
  exposeApi();
  updateGround();
  raf = requestAnimationFrame(frame);

  buildings = new Buildings();
  atmos.root.add(buildings.group);
  const tb = performance.now();
  const ok = await buildings.load();
  loadMs.buildings = Math.round(performance.now() - tb);
  buildingsInfo.value = ok
    ? `${buildings.meta!.count.toLocaleString()} 栋 · 最高 ${buildings.meta!.max_height_m.toFixed(0)} m`
    : "无建筑数据";
  if (window.__atmosStatus) window.__atmosStatus.buildings = buildings.meta?.count ?? 0;
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
  () => slice.variable,
  (name) => {
    slice.colormap = defaultColormap(name);
    slice.autoRange = true;
  },
);
watch(
  () => section.variable,
  (name) => {
    section.colormap = defaultColormap(name);
    section.autoRange = true;
  },
);
watch(slice, updateSlice, { deep: true });
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
  () => [section.offsetKm, section.azimuthDeg],
  () => {
    if (!vsection) return;
    vsection.azimuthDeg = section.azimuthDeg;
    vsection.setOffset(section.offsetKm);
  },
);
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
    if (probe.value) refreshProbe();
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
      title: `剖面 · ${labelOf(section.variable)}`,
      units: unitsOf(section.variable),
      colormap: section.colormap,
      min: section.min,
      max: section.max,
    });
  if (slice.enabled)
    out.push({
      key: "slice",
      title: `切片 ${slice.heightM.toFixed(0)} m · ${labelOf(slice.variable)}`,
      units: unitsOf(slice.variable),
      colormap: slice.colormap,
      min: slice.min,
      max: slice.max,
    });
  if (layers.particles && particleParams.colorMode !== "single") {
    const name =
      particleParams.colorMode === "w"
        ? "w"
        : particleParams.colorMode === "height"
          ? "height"
          : SPEED;
    const range: [number, number] =
      name === SPEED ? speedRange.value : name === "w" ? [-0.3, 0.3] : [0, 1000];
    out.push({
      key: "particles",
      title: `粒子 · ${name === "height" ? "高度" : labelOf(name)}`,
      units: name === "height" ? "m" : "m/s",
      colormap: particleParams.colormap,
      min: range[0],
      max: range[1],
    });
  }
  if (layers.volume) {
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
  volume?.dispose();
  buildings?.dispose();
  fields?.dispose();
  controls?.dispose();
  renderer?.dispose();
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
      v-if="probe"
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
      @close="probe = null"
    />

    <div class="hint">
      拖动：旋转 · 右键：平移 · 滚轮：缩放 · 拖剖面：平移剖面 · Shift+拖剖面 / 拖顶部手柄：旋转 ·
      双击：固定探针
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
          水平切片 <em>{{ slice.enabled ? `${slice.heightM.toFixed(0)} m` : "关" }}</em>
        </summary>
        <label class="row"
          ><input v-model="slice.enabled" type="checkbox" />显示
          <select v-model="slice.variable">
            <option v-for="v in variables3D" :key="v.name" :value="v.name">{{ v.label }}</option>
          </select></label
        >
        <label class="slider"
          >高度 {{ slice.heightM.toFixed(1) }} m
          <input v-model.number="slice.heightM" type="range" min="12.5" max="987.5" step="0.5"
        /></label>
        <label class="row"
          >色带
          <select v-model="slice.colormap">
            <option v-for="c in COLORMAPS" :key="c" :value="c">
              {{ COLORMAP_LABELS[c] ?? c }}
            </option>
          </select></label
        >
        <label class="row"
          ><input v-model="slice.autoRange" type="checkbox" />自动范围
          <input
            v-model.number="slice.min"
            class="num"
            type="number"
            step="any"
            :disabled="slice.autoRange" />–
          <input
            v-model.number="slice.max"
            class="num"
            type="number"
            step="any"
            :disabled="slice.autoRange"
        /></label>
        <label class="slider"
          >不透明度 {{ slice.opacity.toFixed(2)
          }}<input v-model.number="slice.opacity" type="range" min="0.1" max="1" step="0.01"
        /></label>
        <label class="slider"
          >等值线 {{ slice.contours || "关"
          }}<input v-model.number="slice.contours" type="range" min="0" max="30" step="1"
        /></label>
      </details>

      <details open>
        <summary>
          垂直剖面 <em>{{ section.enabled ? `${section.azimuthDeg.toFixed(0)}°` : "关" }}</em>
        </summary>
        <label class="row"
          ><input v-model="section.enabled" type="checkbox" />显示
          <select v-model="section.variable">
            <option v-for="v in variables3D" :key="v.name" :value="v.name">{{ v.label }}</option>
          </select></label
        >
        <label class="slider"
          >位置偏移 {{ section.offsetKm.toFixed(2) }} km
          <input v-model.number="section.offsetKm" type="range" min="-12" max="12" step="0.01"
        /></label>
        <label class="slider"
          >方位角 {{ section.azimuthDeg.toFixed(1) }}°
          <input v-model.number="section.azimuthDeg" type="range" min="0" max="180" step="0.5"
        /></label>
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
  left: 16px;
  bottom: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.profile-box {
  position: absolute;
  left: 16px;
  top: 60px;
}
.hint {
  position: absolute;
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
