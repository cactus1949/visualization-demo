<script setup lang="ts">
import { computed } from "vue";
import { colormapCss } from "../render/colormaps";

const props = defineProps<{
  title: string;
  units: string;
  colormap: string;
  min: number;
  max: number;
}>();

const gradient = computed(() => colormapCss(props.colormap));
const ticks = computed(() => {
  const out: string[] = [];
  for (let i = 0; i <= 4; i += 1) {
    const value = props.min + ((props.max - props.min) * i) / 4;
    out.push(
      Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(Math.abs(value) < 1 ? 2 : 1),
    );
  }
  return out;
});
</script>

<template>
  <div class="legend">
    <div class="legend-title">
      <span>{{ title }}</span>
      <small>{{ units }}</small>
    </div>
    <div class="legend-bar" :style="{ background: gradient }" />
    <div class="legend-ticks">
      <span v-for="(tick, i) in ticks" :key="i">{{ tick }}</span>
    </div>
  </div>
</template>

<style scoped>
.legend {
  min-width: 220px;
  padding: 8px 10px 6px;
  border-radius: 10px;
  background: var(--card);
  border: 1px solid var(--line);
  backdrop-filter: blur(10px);
}
.legend-title {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--text);
}
.legend-title small {
  color: var(--muted);
}
.legend-bar {
  height: 10px;
  margin-top: 6px;
  border-radius: 5px;
}
.legend-ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-size: 10px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
