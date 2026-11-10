<script setup lang="ts">
import { computed } from "vue";
import { colormapCss } from "../render/colormaps";

const props = defineProps<{
  title: string;
  units: string;
  colormap: string;
  min: number;
  max: number;
  windowMin?: number;
  windowMax?: number;
}>();

const gradient = computed(() => colormapCss(props.colormap));
const windowMin = computed(() => props.windowMin ?? props.min);
const windowMax = computed(() => props.windowMax ?? props.max);
const windowLeft = computed(
  () =>
    `${Math.max(0, Math.min(100, ((windowMin.value - props.min) / (props.max - props.min || 1)) * 100))}%`,
);
const windowRight = computed(
  () =>
    `${Math.max(0, Math.min(100, ((windowMax.value - props.min) / (props.max - props.min || 1)) * 100))}%`,
);
const hasWindow = computed(() => props.windowMin !== undefined && props.windowMax !== undefined);
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
    <div class="legend-bar" :style="{ background: gradient }">
      <span v-if="hasWindow" class="legend-dim left" :style="{ width: windowLeft }" />
      <span v-if="hasWindow" class="legend-dim right" :style="{ left: windowRight }" />
    </div>
    <div class="legend-ticks">
      <span v-for="(tick, i) in ticks" :key="i">{{ tick }}</span>
    </div>
    <div v-if="hasWindow" class="legend-window">
      窗口 {{ windowMin.toPrecision(4) }} – {{ windowMax.toPrecision(4) }} {{ units }}
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
  position: relative;
  height: 10px;
  margin-top: 6px;
  border-radius: 5px;
}
.legend-dim {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.48);
}
.legend-dim.left {
  left: 0;
}
.legend-dim.right {
  right: 0;
}
.legend-ticks {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  font-size: 10px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.legend-window {
  margin-top: 3px;
  color: var(--muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
</style>
