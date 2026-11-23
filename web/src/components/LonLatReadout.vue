<script setup lang="ts">
import { computed, ref } from "vue";
import { MapPin } from "@lucide/vue";
import {
  activeLonLatFormat,
  formatLonLat,
  lonLatFormatHint,
  nextLonLatFormat,
  setActiveLonLatFormat,
  type LonLatFormat,
} from "../geo/lonLatFormat";

const props = defineProps<{ lon: number | null; lat: number | null }>();
const format = ref<LonLatFormat>(activeLonLatFormat());
const hasCoords = computed(
  () => props.lon !== null && props.lat !== null && Number.isFinite(props.lon) && Number.isFinite(props.lat),
);
const text = computed(() => (hasCoords.value ? formatLonLat(props.lon!, props.lat!, format.value) : "-"));
const hint = computed(() => lonLatFormatHint(format.value));

function toggle(): void {
  format.value = nextLonLatFormat(format.value);
  setActiveLonLatFormat(format.value);
}
</script>

<template>
  <el-tooltip :content="hint" placement="top" :show-after="250" :hide-after="0">
    <button type="button" class="lonlat" :class="{ empty: !hasCoords }" :aria-label="hint" @click="toggle">
      <MapPin :size="13" class="pin" />
      <span>{{ text }}</span>
    </button>
  </el-tooltip>
</template>

<style scoped>
.lonlat {
  position: absolute;
  z-index: 5;
  left: calc(var(--rail-left, 0px) + 16px);
  bottom: 16px;
  min-width: 96px;
  height: 28px;
  margin: 0;
  padding: 0 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 8px;
  border: 1px solid var(--line, rgba(120, 170, 200, 0.22));
  background: var(--card, rgba(8, 17, 30, 0.8));
  backdrop-filter: blur(12px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  color: var(--text, #dce9f2);
  font: inherit;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
  white-space: nowrap;
  cursor: pointer;
  user-select: none;
  pointer-events: auto;
  transition:
    left 160ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.lonlat.empty {
  color: var(--muted, #87a3b5);
}

.pin {
  color: var(--accent, #5fd3e6);
  flex: none;
}

.lonlat.empty .pin {
  opacity: 0.55;
}

.lonlat:hover {
  border-color: var(--accent, #5fd3e6);
  color: var(--accent, #5fd3e6);
}
</style>
