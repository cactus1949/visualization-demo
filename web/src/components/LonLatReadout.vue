<script setup lang="ts">
import { computed, ref } from "vue";
import {
  activeLonLatFormat,
  formatLonLat,
  lonLatFormatHint,
  nextLonLatFormat,
  setActiveLonLatFormat,
  type LonLatFormat,
} from "../geo/lonLatFormat";

const props = defineProps<{ lon: number; lat: number }>();
const format = ref<LonLatFormat>(activeLonLatFormat());
const text = computed(() => formatLonLat(props.lon, props.lat, format.value));
const hint = computed(() => lonLatFormatHint(format.value));

function toggle(): void {
  format.value = nextLonLatFormat(format.value);
  setActiveLonLatFormat(format.value);
}
</script>

<template>
  <button type="button" class="lonlat" :title="hint" :aria-label="hint" @click="toggle">{{ text }}</button>
</template>

<style scoped>
.lonlat {
  position: absolute;
  z-index: 5;
  left: 16px;
  bottom: 16px;
  margin: 0;
  padding: 4px 10px;
  border-radius: 8px;
  border: 1px solid var(--line, rgba(120, 170, 200, 0.22));
  background: var(--card, rgba(8, 17, 30, 0.78));
  color: var(--text, #dce9f2);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
}
.lonlat:hover {
  border-color: var(--accent, #5fd3e6);
  color: var(--accent, #5fd3e6);
}
</style>
