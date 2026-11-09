<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { WebGPURenderer } from "three/webgpu";
import type { Manifest, VariableMeta } from "../data/manifest";
import { DataStore } from "../data/store";
import { makeCross, makeSlice } from "../render/slices";
import { createScene } from "../render/scene";
import { makeSurface, disposeSurface } from "../render/surface";
import { makeVolume, disposeVolume, type VolumeHandle } from "../render/volume";
import { makeParticles, packWindTexture, type ParticleHandle } from "../render/particles";
import { probeAt } from "../render/probe";

const props = withDefaults(
  defineProps<{
    manifestUrl?: string;
    initialVolumeVar?: string;
    initialSurfaceVar?: string;
    showPanel?: boolean;
  }>(),
  {
    manifestUrl: "/data/lowair_atmos/manifest.json",
    initialVolumeVar: "tke",
    initialSurfaceVar: "t2m",
    showPanel: true,
  },
);

const emit = defineEmits<{
  ready: [{ backend: string }];
  probe: [Record<string, unknown>];
}>();

const canvas = ref<HTMLCanvasElement>();
const manifest = ref<Manifest>();
const volumeVar = ref(props.initialVolumeVar);
const surfaceVar = ref(props.initialSurfaceVar);
const volumeWindowLow = ref(0);
const volumeWindowHigh = ref(1);
const volumeThreshold = ref(0);
const volumeOpacity = ref(0.8);
const steps = ref(128);
const exaggeration = ref(5);
const particleCount = ref(30_000);
const particleSpeed = ref(1);
const particlesEnabled = ref(true);
const sliceEnabled = ref(false);
const crossEnabled = ref(false);
const sliceLevel = ref(20);
const crossAxis = ref<"x" | "z">("x");
const crossPosition = ref(0.5);
const panelVisible = ref(props.showPanel && !new URLSearchParams(location.search).has("embed"));
const status = ref("加载清单…");
const backend = ref("");
const particlePath = ref("准备中");
const fps = ref(0);
const probe = ref<Record<string, unknown>>();
const colormap = ref("viridis");

let store: DataStore;
let renderer: any;
let scene: THREE.Scene;
let root: THREE.Group;
let camera: THREE.PerspectiveCamera;
let controls: OrbitControls;
let resizeObserver: ResizeObserver;
let animationFrame = 0;
let lastFrame = performance.now();
let frameCount = 0;
let volume: VolumeHandle | null = null;
let surface: THREE.Mesh | null = null;
let slice: THREE.Mesh | null = null;
let cross: THREE.Mesh | null = null;
let particles: ParticleHandle | null = null;
let windTexture: THREE.Data3DTexture | null = null;

const labels: Record<string, string> = {
  tke: "湍动能",
  icing_index: "结冰指数",
  u_gust: "阵风",
  wind_shear: "风切变",
  sigma_w: "垂直脉动",
  icing_accum: "累积覆冰",
  u: "东向风速",
  v: "北向风速",
};

const volumeOptions = computed(() =>
  Object.entries(manifest.value?.variables ?? {}).filter(([, meta]) => meta.dims.length === 3),
);
const surfaceOptions = computed(() => [
  ["t2m", "2米气温"],
  ["visibility", "能见度"],
  ["risk_level", "风险等级"],
  ["precip", "降水率"],
  ["cloud", "云量"],
  ["q2m", "2米比湿"],
  ["ustar", "摩擦速度"],
  ["wind10", "10米风速"],
  ["none", "无"],
]);

// Debug switch: ?off=volume,particles,surface,slices disables layers (used to bisect GPU issues).
const disabledLayers = new Set(
  (new URLSearchParams(location.search).get("off") ?? "").split(",").filter(Boolean),
);

function loaded(name: string) {
  return store?.loaded.get(name);
}

function removeObject(object: THREE.Object3D | null): void {
  if (!object) return;
  root.remove(object);
  object.traverse((child) => {
    const disposable = child as THREE.Mesh;
    disposable.geometry?.dispose();
    if (Array.isArray(disposable.material)) disposable.material.forEach((item) => item.dispose());
    else disposable.material?.dispose();
  });
}

function rebuildLayers(): void {
  if (!manifest.value || !root) return;
  if (volume) disposeVolume(volume);
  removeObject(surface);
  removeObject(slice);
  removeObject(cross);
  volume = null;
  surface = null;
  slice = null;
  cross = null;

  const volumeData = loaded(volumeVar.value);
  if (volumeData && !disabledLayers.has("volume")) {
    volume = makeVolume(manifest.value, volumeData.meta, volumeData.data, exaggeration.value);
    volume.steps.value = steps.value;
    volume.windowLow.value = volumeWindowLow.value;
    volume.windowHigh.value = volumeWindowHigh.value;
    volume.threshold.value = volumeThreshold.value;
    volume.opacity.value = volumeOpacity.value;
    root.add(volume.object);
  }

  if (surfaceVar.value !== "none" && !disabledLayers.has("surface")) {
    const surfaceData = loaded(surfaceVar.value);
    if (surfaceData) {
      surface = makeSurface(manifest.value, surfaceData.meta, surfaceData.data, exaggeration.value);
      root.add(surface);
    }
  }

  const sliceData = loaded(volumeVar.value);
  if (sliceEnabled.value && sliceData) {
    slice = makeSlice(
      manifest.value,
      sliceData.meta,
      sliceData.data,
      exaggeration.value,
      sliceLevel.value,
    );
    root.add(slice);
  }
  if (crossEnabled.value && sliceData) {
    cross = makeCross(
      manifest.value,
      sliceData.meta,
      sliceData.data,
      exaggeration.value,
      crossAxis.value,
      crossPosition.value,
    );
    root.add(cross);
  }
}

function createParticleLayer(): void {
  if (
    !renderer ||
    !root ||
    !manifest.value ||
    particles ||
    disabledLayers.has("particles") ||
    !loaded("u") ||
    !loaded("v") ||
    !loaded("w")
  )
    return;
  windTexture = packWindTexture(
    manifest.value,
    loaded("u")!.data,
    loaded("v")!.data,
    loaded("w")!.data,
  );
  particles = makeParticles(
    renderer,
    manifest.value,
    windTexture,
    exaggeration.value,
    particleCount.value,
    { u: loaded("u")!.data, v: loaded("v")!.data, w: loaded("w")!.data },
  );
  particles.speed.value = particleSpeed.value;
  particlePath.value = particles.label;
  root.add(particles.object);
}

function updateStatus(): void {
  if (!manifest.value) return;
  const bytes = [...store.loaded.values()].reduce((sum, item) => sum + item.data.byteLength, 0);
  status.value = `数据就绪 · 纹理约 ${(bytes / 1e6).toFixed(1)} MB · 首帧 ${manifest.value.timing.load_s.toFixed(2)} s`;
}

function resetView(): void {
  camera.position.set(20, 13, 22);
  controls.target.set(0, 2, 0);
  controls.update();
}

function handlePointer(event: PointerEvent): void {
  if (!canvas.value || !manifest.value) return;
  const bounds = canvas.value.getBoundingClientRect();
  const pointer = new THREE.Vector2(
    ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
    -((event.clientY - bounds.top) / bounds.height) * 2 + 1,
  );
  const raycaster = new THREE.Raycaster();
  raycaster.setFromCamera(pointer, camera);
  const point = raycaster.intersectObjects(root.children, true)[0]?.point;
  if (!point) {
    probe.value = undefined;
    return;
  }
  const result = probeAt(
    manifest.value,
    point,
    exaggeration.value,
    volume ? loaded(volumeVar.value)?.meta : undefined,
    loaded(volumeVar.value)?.data,
    surfaceVar.value === "none" ? undefined : loaded(surfaceVar.value)?.meta,
    surfaceVar.value === "none" ? undefined : loaded(surfaceVar.value)?.data,
    loaded("u")?.data,
    loaded("v")?.data,
  );
  probe.value = result as unknown as Record<string, unknown>;
  emit("probe", result as unknown as Record<string, unknown>);
}

function renderFrame(now: number): void {
  const delta = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;
  frameCount += 1;
  if (frameCount % 30 === 0) fps.value = Math.round(1 / Math.max(delta, 1e-4));
  if (particles && particlesEnabled.value) {
    particles.speed.value = particleSpeed.value;
    particles.step(delta);
  }
  renderer.render(scene, camera);
  if (!window.__atmosReady) {
    window.__atmosReady = true;
    window.__atmosStatus = { backend: backend.value, particlePath: particlePath.value };
    emit("ready", { backend: backend.value });
  }
  if (window.__atmosStatus && particles && frameCount % 20 === 0) {
    window.__atmosStatus.particlePath = particles.path;
    particles.sample().then((value) => {
      if (window.__atmosStatus) window.__atmosStatus.particleSample = value;
    });
  }
  animationFrame = requestAnimationFrame(renderFrame);
}

async function start(): Promise<void> {
  store = new DataStore(props.manifestUrl);
  await new Promise<void>((resolve) => {
    const unsubscribe = store.on((name) => {
      if (name === "manifest") {
        manifest.value = store.manifest ?? undefined;
        volumeWindowLow.value = manifest.value?.variables[volumeVar.value].data_min ?? 0;
        volumeWindowHigh.value = manifest.value?.variables[volumeVar.value].data_max ?? 1;
        store.request("u");
        store.request("v");
        store.request("w");
        store.request(volumeVar.value);
        store.request(surfaceVar.value);
      }
      if (store.loaded.has("u") && store.loaded.has("v") && store.loaded.has("w")) resolve();
      if (manifest.value && store.loaded.has(volumeVar.value)) {
        updateStatus();
        rebuildLayers();
      }
      createParticleLayer();
    });
    window.setTimeout(() => {
      unsubscribe();
      resolve();
    }, 15_000);
  });
  if (!manifest.value || !canvas.value) return;
  const forceWebGL = new URLSearchParams(location.search).has("webgl");
  renderer = new WebGPURenderer({ canvas: canvas.value, antialias: true, forceWebGL });
  await renderer.init();
  renderer.setClearColor?.(0x050913, 1);
  backend.value = renderer.backend.isWebGPUBackend === true ? "WebGPU" : "WebGL2";
  const created = createScene(manifest.value, exaggeration.value);
  scene = created.scene;
  root = created.root;
  camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
  camera.position.set(20, 13, 22);
  controls = new OrbitControls(camera, canvas.value);
  controls.target.set(0, 2, 0);
  controls.update();
  resizeObserver = new ResizeObserver(() => {
    if (!canvas.value) return;
    renderer.setSize(canvas.value.clientWidth, canvas.value.clientHeight, false);
    camera.aspect = canvas.value.clientWidth / canvas.value.clientHeight;
    camera.updateProjectionMatrix();
  });
  resizeObserver.observe(canvas.value);
  canvas.value.addEventListener("pointermove", handlePointer);
  createParticleLayer();
  rebuildLayers();
  status.value = "渲染中";
  animationFrame = requestAnimationFrame(renderFrame);
}

function setVolume(name: string): void {
  volumeVar.value = name;
  store?.request(name);
  // Default the transfer window to the actual data extent (the fixed quantization range
  // is usually much wider), so the volume uses the whole colormap.
  const meta = manifest.value?.variables[name];
  if (meta) {
    volumeWindowLow.value = meta.data_min;
    volumeWindowHigh.value = meta.data_max;
    volumeThreshold.value = meta.range[0];
  }
}

watch(
  [
    volumeVar,
    surfaceVar,
    exaggeration,
    sliceEnabled,
    crossEnabled,
    sliceLevel,
    crossAxis,
    crossPosition,
  ],
  () => {
    if (manifest.value) {
      store.request(volumeVar.value);
      if (surfaceVar.value !== "none") store.request(surfaceVar.value);
      rebuildLayers();
    }
  },
);
watch(particleCount, () => {
  if (!particles) return;
  root.remove(particles.object);
  particles.dispose();
  particles = null;
  createParticleLayer();
});

watch([steps, volumeWindowLow, volumeWindowHigh, volumeThreshold, volumeOpacity], () => {
  if (!volume) return;
  volume.steps.value = steps.value;
  volume.windowLow.value = volumeWindowLow.value;
  volume.windowHigh.value = volumeWindowHigh.value;
  volume.threshold.value = volumeThreshold.value;
  volume.opacity.value = volumeOpacity.value;
});

onMounted(() => {
  window.addEventListener("message", (event) => {
    if (event.data?.type === "setVolumeVar") setVolume(event.data.value);
    if (event.data?.type === "setSurfaceVar") surfaceVar.value = event.data.value;
    if (event.data?.type === "setParticles") particlesEnabled.value = Boolean(event.data.value);
  });
  void start();
});

onBeforeUnmount(() => {
  cancelAnimationFrame(animationFrame);
  resizeObserver?.disconnect();
  canvas.value?.removeEventListener("pointermove", handlePointer);
  store?.dispose();
  windTexture?.dispose();
  renderer?.dispose?.();
});
</script>

<template>
  <div class="viewer">
    <canvas ref="canvas" class="canvas" />
    <aside v-if="panelVisible" class="panel">
      <h1>天津低空大气三维场</h1>
      <p class="status">
        {{ status }}<br />{{ backend }} · {{ particlePath }} · FPS {{ fps || "…" }}
      </p>
      <label
        >体变量<select
          :value="volumeVar"
          @change="setVolume(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="[name, meta] in volumeOptions" :key="name" :value="name">
            {{ labels[name] || meta.label_zh }}
          </option>
        </select></label
      >
      <label
        >地面图层<select v-model="surfaceVar">
          <option v-for="[name, label] in surfaceOptions" :key="name" :value="name">
            {{ label }}
          </option>
        </select></label
      >
      <label
        >色带<select v-model="colormap">
          <option>viridis</option>
          <option>magma</option>
          <option>turbo</option>
          <option>blues</option>
          <option>coolwarm</option>
        </select></label
      >
      <label
        >窗口下限 {{ volumeWindowLow.toFixed(2)
        }}<input
          v-model.number="volumeWindowLow"
          type="range"
          :min="manifest?.variables[volumeVar]?.range[0]"
          :max="manifest?.variables[volumeVar]?.range[1]"
          step="any"
      /></label>
      <label
        >窗口上限 {{ volumeWindowHigh.toFixed(2)
        }}<input
          v-model.number="volumeWindowHigh"
          type="range"
          :min="manifest?.variables[volumeVar]?.range[0]"
          :max="manifest?.variables[volumeVar]?.range[1]"
          step="any"
      /></label>
      <label
        >阈值 {{ volumeThreshold.toFixed(2)
        }}<input
          v-model.number="volumeThreshold"
          type="range"
          :min="manifest?.variables[volumeVar]?.range[0]"
          :max="manifest?.variables[volumeVar]?.range[1]"
          step="any"
      /></label>
      <label
        >透明度 {{ volumeOpacity.toFixed(2)
        }}<input v-model.number="volumeOpacity" type="range" min="0" max="2" step="0.05"
      /></label>
      <label
        >步数 {{ steps }}<input v-model.number="steps" type="range" min="32" max="256" step="16"
      /></label>
      <label
        >垂直夸大 {{ exaggeration.toFixed(1) }}×<input
          v-model.number="exaggeration"
          type="range"
          min="1"
          max="20"
          step="0.5"
      /></label>
      <label
        >粒子数 {{ particleCount
        }}<input v-model.number="particleCount" type="range" min="10000" max="200000" step="10000"
      /></label>
      <label
        >粒子速度 {{ particleSpeed.toFixed(1) }}×<input
          v-model.number="particleSpeed"
          type="range"
          min="0.1"
          max="4"
          step="0.1"
      /></label>
      <label><input v-model="particlesEnabled" type="checkbox" />显示粒子</label>
      <label><input v-model="sliceEnabled" type="checkbox" />水平切片</label>
      <label v-if="sliceEnabled"
        >高度 {{ manifest?.grid.levels_m[sliceLevel] }} m<input
          v-model.number="sliceLevel"
          type="range"
          min="0"
          max="39"
      /></label>
      <label><input v-model="crossEnabled" type="checkbox" />垂直截面</label>
      <label v-if="crossEnabled"
        >轴向<select v-model="crossAxis">
          <option value="x">东西向</option>
          <option value="z">南北向</option></select
        ><input v-model.number="crossPosition" type="range" min="0" max="1" step="0.01"
      /></label>
      <button type="button" @click="resetView">重置视角</button>
      <div class="legend">
        <div class="legend-bar" />
        <small
          >{{ labels[volumeVar] || volumeVar }} · {{ manifest?.variables[volumeVar]?.units }}</small
        >
      </div>
      <div v-if="probe" class="probe">
        经度 {{ Number(probe.lon).toFixed(4) }} · 纬度 {{ Number(probe.lat).toFixed(4) }}<br />高度
        {{ Number(probe.height).toFixed(0) }} m · 风速
        {{ Number(probe.windSpeed).toFixed(2) }} m/s<br />风向
        {{ Number(probe.windDirection).toFixed(0) }}°
      </div>
    </aside>
  </div>
</template>

<style scoped>
.viewer {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #050913;
}
.canvas {
  display: block;
  width: 100%;
  height: 100%;
}
.panel {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 300px;
  max-height: calc(100% - 28px);
  overflow: auto;
  padding: 15px;
  border: 1px solid #2d4567;
  border-radius: 12px;
  background: rgba(7, 14, 26, 0.94);
  color: #e6eef8;
  font-size: 13px;
  box-shadow: 0 8px 30px #0008;
}
h1 {
  margin: 0 0 9px;
  font-size: 18px;
}
.status {
  margin: 0 0 10px;
  color: #9db7d6;
  line-height: 1.5;
}
label {
  display: block;
  margin: 8px 0;
  color: #d7e3f2;
}
select,
input[type="range"] {
  width: 100%;
  margin-top: 4px;
}
select {
  padding: 5px;
  border: 1px solid #38506e;
  border-radius: 5px;
  background: #15243a;
  color: #fff;
}
button {
  width: 100%;
  margin-top: 8px;
  padding: 7px;
  border: 0;
  border-radius: 6px;
  background: #1e6fe8;
  color: #fff;
}
.legend-bar {
  height: 10px;
  margin-top: 10px;
  border-radius: 4px;
  background: linear-gradient(90deg, #440154, #31688e, #35b779, #fde725);
}
.legend small,
.probe {
  color: #9db7d6;
  line-height: 1.5;
}
.probe {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid #2d4567;
}
</style>
