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

const PLOT_W = 280;
const PLOT_H = 148;

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
      const value = values[y * columns + x]!;
      const i = ((rows - 1 - y) * columns + x) * 4;
      if (!Number.isFinite(value)) { img.data[i + 3] = 0; continue; }
      const n = Math.max(0, Math.min(1, (value - props.min) / span));
      const ci = Math.round(n * 255) * 4;
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
  // Keep endpoints only when they are not crowded against a nice step tick.
  const gap = step * 0.55;
  if (!out.length || out[0]! - min > gap) out.unshift(min);
  if (!out.length || max - out[out.length - 1]! > gap) out.push(max);
  return out;
}

function tickLabel(v: number, span: number): string {
  if (Math.abs(v - Math.round(v)) < 1e-6 && (Math.abs(v) >= 10 || span >= 10)) return String(Math.round(v));
  if (span < 2) return v.toFixed(2);
  if (span < 20 && Math.abs(v) < 10) return v.toFixed(1);
  if (Math.abs(v) >= 100 || Math.abs(v - Math.round(v)) < 1e-6) return v.toFixed(0);
  return v.toFixed(1);
}

const yTicks = computed(() => {
  const max = props.grid?.heightMaxM ?? 1000;
  return niceTicks(0, max, 5).map((v) => ({
    value: v,
    label: tickLabel(v, max),
    t: max === 0 ? 0 : v / max,
  }));
});

const xTicks = computed(() => {
  const max = props.grid?.distanceKm ?? 1;
  return niceTicks(0, max, 5).map((v) => ({
    value: v,
    label: tickLabel(v, max),
    t: max === 0 ? 0 : v / max,
  }));
});

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function tickShift(t: number, axis: "x" | "y"): string {
  if (axis === "x") {
    if (t <= 0.02) return "translateX(0)";
    if (t >= 0.98) return "translateX(-100%)";
    return "translateX(-50%)";
  }
  if (t <= 0.02) return "translateY(0)";
  if (t >= 0.98) return "translateY(100%)";
  return "translateY(50%)";
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
    <div class="plot-body">
      <div class="y-col">
        <div class="y-title">高度 (m)</div>
        <div class="y-axis" :style="{ height: plotH + 'px' }">
          <span
            v-for="t in yTicks"
            :key="'y' + t.value"
            class="tick"
            :style="{ bottom: `${t.t * 100}%`, transform: tickShift(t.t, 'y') }"
          >{{ t.label }}</span>
        </div>
      </div>
      <div class="plot-col">
        <div class="plot-frame" :style="{ width: plotW + 'px', height: plotH + 'px' }">
          <img :src="pixels" :width="plotW" :height="plotH" alt="距离–高度展开图" />
        </div>
        <div class="x-axis" :style="{ width: plotW + 'px' }">
          <span
            v-for="t in xTicks"
            :key="'x' + t.value"
            class="tick"
            :style="{ left: `${t.t * 100}%`, transform: tickShift(t.t, 'x') }"
          >{{ t.label }}</span>
        </div>
        <div class="x-title">距离 (km)</div>
      </div>
      <div class="cbar" :style="{ height: plotH + 'px' }">
        <img :src="bar" alt="" />
        <span class="cbar-max">{{ fmt(max) }}</span>
        <span class="cbar-min">{{ fmt(min) }}</span>
        <span v-if="units" class="cbar-unit">{{ units }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.unfolded-plot {
  position: absolute;
  left: 18px;
  /* Sit above the bottom-left ColorLegend so axis titles are never covered. */
  bottom: 108px;
  box-sizing: border-box;
  padding: 10px 12px 10px;
  background: rgba(8, 14, 22, 0.9);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 10px;
  z-index: 5;
  color: #f4fbff;
  font: 500 11px/1.2 Inter, ui-sans-serif, system-ui, "Noto Sans SC", sans-serif;
  font-variant-numeric: tabular-nums;
  pointer-events: auto;
}
.plot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
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
.plot-body {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  gap: 6px;
}
.y-col {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex: none;
  width: 46px;
}
.y-title {
  width: 100%;
  text-align: right;
  color: #9ab2bf;
  font-size: 10px;
  line-height: 1.2;
  margin-bottom: 4px;
  white-space: nowrap;
}
.y-axis {
  position: relative;
  width: 100%;
  flex: none;
}
.y-axis .tick {
  position: absolute;
  right: 0;
  color: #9ab2bf;
  white-space: nowrap;
}
.plot-col {
  display: flex;
  flex-direction: column;
  flex: none;
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
.x-axis {
  position: relative;
  height: 16px;
  margin-top: 4px;
  flex: none;
}
.x-axis .tick {
  position: absolute;
  top: 0;
  color: #9ab2bf;
  white-space: nowrap;
}
.x-title {
  text-align: center;
  color: #9ab2bf;
  margin-top: 2px;
  font-size: 10px;
  line-height: 1.2;
}
.cbar {
  position: relative;
  width: 54px;
  flex: none;
  margin-top: 16px; /* align with the plot frame under the y-title */
}
.cbar img {
  position: absolute;
  left: 0;
  top: 0;
  width: 8px;
  height: 100%;
  border: 1px solid rgba(255, 255, 255, 0.18);
  image-rendering: pixelated;
  box-sizing: border-box;
}
.cbar-max,
.cbar-min,
.cbar-unit {
  position: absolute;
  left: 12px;
  color: #9ab2bf;
  white-space: nowrap;
}
.cbar-max { top: 0; }
.cbar-min { bottom: 0; }
.cbar-unit {
  top: 100%;
  margin-top: 4px;
  font-size: 9px;
  white-space: nowrap;
  line-height: 1.15;
}
</style>
