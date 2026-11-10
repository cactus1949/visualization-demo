<script setup lang="ts">
import { computed } from "vue";
import { colormapBytes } from "../render/colormaps";

const props = defineProps<{
  grid: { values: Float32Array; columns: number; rows: number; distanceKm: number; heightMaxM: number } | null;
  min: number;
  max: number;
  colormap: string;
}>();
const emit = defineEmits<{ close: [] }>();

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
      // rows are stored bottom-to-top (low height first); flip so height increases upward
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
</script>

<template>
  <div v-if="grid" class="unfolded-plot">
    <button type="button" title="关闭" @click="emit('close')">×</button>
    <div class="plot-title">折线展开图（距离–高度）</div>
    <img :src="pixels" alt="distance-height plot" />
    <small>距离 {{ grid.distanceKm.toFixed(2) }} km · 高度 0–{{ grid.heightMaxM.toFixed(0) }} m</small>
  </div>
</template>

<style scoped>
.unfolded-plot {
  position: absolute;
  left: 18px;
  bottom: 54px;
  width: 320px;
  padding: 8px;
  background: rgba(5, 15, 25, 0.9);
  border: 1px solid #3b7183;
  z-index: 4;
}
.unfolded-plot img {
  display: block;
  width: 100%;
  height: 140px;
  image-rendering: pixelated;
}
.unfolded-plot button {
  float: right;
  background: none;
  border: 0;
  color: #dff8ff;
  font-size: 18px;
}
.plot-title {
  font-size: 12px;
  margin-bottom: 4px;
}
.unfolded-plot small {
  color: #9ab2bf;
}
</style>
