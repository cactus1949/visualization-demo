<script setup lang="ts">
import { computed } from "vue";
import { colormapCss } from "../render/colormaps";
import { formatLegendValue, markerFraction } from "../state/legendRange";

const props = defineProps<{
  title: string;
  units: string;
  colormap: string;
  min: number;
  max: number;
  windowMin?: number;
  windowMax?: number;
  /** current frame has values below / above the colour range: light the end arrow */
  overLow?: boolean;
  overHigh?: boolean;
  dataMin?: number;
  dataMax?: number;
  hint?: string | null;
  warn?: string | null;
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
const hasData = computed(() => Number.isFinite(props.dataMin) && Number.isFinite(props.dataMax));
const dataMinMarker = computed(() => hasData.value ? markerFraction(props.dataMin!, props.min, props.max) : null);
const dataMaxMarker = computed(() => hasData.value ? markerFraction(props.dataMax!, props.min, props.max) : null);
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
    <div class="legend-bar-row">
    <span class="over low" :class="{ lit: overLow }" :title="overLow ? '当前时刻有低于色带下限的值' : ''" />
    <div class="legend-bar" :style="{ background: gradient }">
      <span v-if="hasWindow" class="legend-dim left" :style="{ width: windowLeft }" />
      <span v-if="hasWindow" class="legend-dim right" :style="{ left: windowRight }" />
      <template v-if="hasData && !hint">
        <span class="data-marker data-marker-min" :class="{ clipped: dataMinMarker?.clipped }" :style="{ left: `${(dataMinMarker?.f ?? 0) * 100}%` }" />
        <span class="data-marker data-marker-max" :class="{ clipped: dataMaxMarker?.clipped }" :style="{ left: `${(dataMaxMarker?.f ?? 0) * 100}%` }" />
      </template>
    </div>
    <span class="over high" :class="{ lit: overHigh }" :title="overHigh ? '当前时刻有高于色带上限的值' : ''" />
    </div>
    <div class="legend-ticks">
      <span v-for="(tick, i) in ticks" :key="i">{{ tick }}</span>
    </div>
    <div v-if="hint" class="legend-hint">{{ hint }}</div>
    <div v-else-if="hasData" class="legend-data">当前 {{ formatLegendValue(dataMin!) }} – {{ formatLegendValue(dataMax!) }} {{ units }}</div>
    <div v-if="warn" class="legend-warn">{{ warn }}</div>
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
.legend-bar-row {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 6px;
}
.legend-bar {
  position: relative;
  flex: 1;
  height: 10px;
  border-radius: 5px;
}
.data-marker {
  position: absolute;
  top: -7px;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 5px solid transparent;
  border-right: 5px solid transparent;
  border-top: 6px solid #ffc247;
  filter: drop-shadow(0 0 0.5px #08101a);
  z-index: 2;
}
.data-marker.clipped {
  filter: drop-shadow(0 0 0.5px #08101a) brightness(1.15);
}
/* end arrows: dim outline normally, fixed-amber when the frame exceeds the colour range */
.over {
  width: 0;
  height: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
  opacity: 0.22;
}
.over.low {
  border-right: 7px solid var(--muted, #87a3b5);
}
.over.high {
  border-left: 7px solid var(--muted, #87a3b5);
}
.over.lit {
  opacity: 1;
}
.over.low.lit {
  border-right-color: #ffc247;
}
.over.high.lit {
  border-left-color: #ffc247;
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
  margin-left: 10px;
  margin-right: 10px;
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
.legend-data,
.legend-hint,
.legend-warn {
  margin-top: 3px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
.legend-data { color: var(--text, #f4fbff); }
.legend-hint,
.legend-warn { color: #ffc247; font-size: 11px; }
</style>
