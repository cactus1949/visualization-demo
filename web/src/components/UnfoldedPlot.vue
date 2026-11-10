<script setup lang="ts">
import { computed } from "vue";
import { colormapBytes } from "../render/colormaps";

const props = defineProps<{
  grid: { values: Float32Array; columns: number; rows: number; distanceKm: number; heightMaxM: number } | null;
  min: number;
  max: number;
  colormap: string;
  units?: string;
}>();
const emit = defineEmits<{ close: [] }>();

const PLOT_W = 260;
const PLOT_H = 140;

const pixels = computed(() => {
  if (!props.grid) return "";
  const { values, columns, rows } = props.grid;
  const canvas = document.createElement("canvas");
  canvas.width = columns;
  canvas.height = rows;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(columns, rows);
  const cmap = colormapBytes(props.colormap);
  const span = Math.max(1e-9, props.max - props.min);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < columns; x++) {
      const n = Math.max(0, Math.min(1, (values[y * columns + x] - props.min) / span));
      const ci = Math.round(n * 255) * 4;
      const i = ((rows - 1 - y) * columns + x) * 4;
      img.data[i] = cmap[ci]!;
      img.data[i + 1] = cmap[ci + 1]!;
      img.data[i + 2] = cmap[ci + 2]!;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
});

const bar = computed(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  const img = ctx.createImageData(1, 256);
  const cmap = colormapBytes(props.colormap);
  for (let y = 0; y < 256; y++) {
    const ci = (255 - y) * 4;
    const i = y * 4;
    img.data[i] = cmap[ci]!;
    img.data[i + 1] = cmap[ci + 1]!;
    img.data[i + 2] = cmap[ci + 2]!;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas.toDataURL();
});

function niceTicks(min: number, max: number, count: number): number[] {
  const span = Math.max(1e-9, max - min);
  const raw = span / Math.max(1, count - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const err = raw / pow;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * pow;
  const start = Math.ceil((min - 1e-9) / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(8)));
  if (!out.length || Math.abs(out[0]! - min) > 1e-6) out.unshift(min);
  if (Math.abs(out[out.length - 1]! - max) > 1e-6) out.push(max);
  return out;
}

const yTicks = computed(() => {
  const max = props.grid?.heightMaxM ?? 1000;
  return niceTicks(0, max, 5).map((v) => ({
    value: v,
    label: v >= 100 || v === 0 ? v.toFixed(0) : v.toFixed(1),
    t: max === 0 ? 0 : v / max,
  }));
});

const xTicks = computed(() => {
  const max = props.grid?.distanceKm ?? 1;
  return niceTicks(0, max, 5).map((v) => ({
    value: v,
    label: max < 2 ? v.toFixed(2) : v.toFixed(1),
    t: max === 0 ? 0 : v / max,
  }));
});

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

const plotW = PLOT_W;
const plotH = PLOT_H;
</script>

<template>
  <div v-if="grid" class="unfolded-plot">
    <div class="plot-head">
      <div class="plot-title">折线展开图</div>
      <button type="button" title="关闭" @click="emit('close')">×</button>
    </div>
    <div class="plot-main">
      <div class="y-title">高度 (m)</div>
      <div class="y-axis" :style="{ height: plotH + 'px' }">
        <span
          v-for="t in yTicks"
          :key="'y' + t.value"
          class="tick"
          :style="{ bottom: `${t.t * 100}%` }"
        >{{ t.label }}</span>
      </div>
      <div class="plot-frame" :style="{ width: plotW + 'px', height: plotH + 'px' }">
        <img :src="pixels" :width="plotW" :height="plotH" alt="距离–高度展开图" />
      </div>
      <div class="cbar" :style="{ height: plotH + 'px' }">
        <img :src="bar" alt="" />
        <span class="cbar-max">{{ fmt(max) }}</span>
        <span class="cbar-min">{{ fmt(min) }}</span>
      </div>
    </div>
    <div class="x-row">
      <div class="x-axis" :style="{ width: plotW + 'px' }">
        <span
          v-for="t in xTicks"
          :key="'x' + t.value"
          class="tick"
          :style="{ left: `${t.t * 100}%` }"
        >{{ t.label }}</span>
      </div>
      <span v-if="units" class="cbar-unit">{{ units }}</span>
    </div>
    <div class="x-title">距离 (km)</div>
  </div>
</template>

<style scoped>
.unfolded-plot {
  position: absolute;
  left: 18px;
  bottom: 54px;
  width: 390px;
  box-sizing: border-box;
  padding: 8px 10px 6px;
  background: rgba(8, 14, 22, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 8px;
  z-index: 4;
  color: #f4fbff;
  font: 500 11px/1.2 Inter, ui-sans-serif, system-ui, "Noto Sans SC", sans-serif;
  font-variant-numeric: tabular-nums;
}
.plot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.plot-title { font-size: 12px; }
.unfolded-plot button {
  background: none;
  border: 0;
  color: #dff8ff;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  padding: 0 2px;
}
.plot-main {
  display: flex;
  flex-direction: row;
  align-items: stretch;
  gap: 4px;
}
.y-title {
  width: 14px;
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  text-align: center;
  color: #9ab2bf;
  font-size: 11px;
}
.y-axis {
  position: relative;
  width: 36px;
  flex: none;
}
.y-axis .tick {
  position: absolute;
  right: 2px;
  transform: translateY(50%);
  color: #9ab2bf;
  white-space: nowrap;
}
.plot-frame {
  flex: none;
  border: 1px solid rgba(255, 255, 255, 0.18);
  overflow: hidden;
  box-sizing: content-box;
}
.plot-frame img {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}
.cbar {
  position: relative;
  width: 40px;
  flex: none;
}
.cbar img {
  position: absolute;
  left: 4px;
  top: 0;
  width: 8px;
  height: 100%;
  border: 1px solid rgba(255, 255, 255, 0.18);
  image-rendering: pixelated;
  box-sizing: border-box;
}
.cbar-max,
.cbar-min {
  position: absolute;
  left: 14px;
  color: #9ab2bf;
  white-space: nowrap;
}
.cbar-max { top: 0; }
.cbar-min { bottom: 0; }
.cbar-unit {
  color: #9ab2bf;
  font-size: 10px;
  margin-left: 8px;
  align-self: start;
}
.x-row {
  display: flex;
  margin-left: 54px;
  margin-top: 2px;
  height: 16px;
  align-items: flex-start;
}
.x-axis {
  position: relative;
  height: 16px;
  flex: none;
}
.x-axis .tick {
  position: absolute;
  top: 2px;
  transform: translateX(-50%);
  color: #9ab2bf;
  white-space: nowrap;
}
.x-axis .tick:first-child { transform: translateX(0); }
.x-axis .tick:last-child { transform: translateX(-100%); }
.x-title {
  text-align: center;
  color: #9ab2bf;
  margin: 0 40px 0 54px;
  font-size: 11px;
}
</style>
