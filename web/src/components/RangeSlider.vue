<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    min: number;
    max: number;
    minValue: number;
    maxValue: number;
    step?: number;
    unit?: string;
  }>(),
  { step: 0.01, unit: "" },
);
const emit = defineEmits<{
  "update:minValue": [value: number];
  "update:maxValue": [value: number];
}>();

const span = computed(() => Math.max(props.max - props.min, 1e-12));
const left = computed(
  () =>
    `${(Math.max(0, Math.min(1, (props.minValue - props.min) / span.value)) * 100).toFixed(3)}%`,
);
const right = computed(
  () =>
    `${(Math.max(0, Math.min(1, (props.maxValue - props.min) / span.value)) * 100).toFixed(3)}%`,
);

function setMin(value: number): void {
  emit("update:minValue", Math.min(value, props.maxValue));
}
function setMax(value: number): void {
  emit("update:maxValue", Math.max(value, props.minValue));
}
</script>

<template>
  <div class="range-slider">
    <div class="range-track">
      <span class="range-selected" :style="{ left, right: `calc(100% - ${right})` }" />
    </div>
    <input
      class="range-input range-min"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="minValue"
      aria-label="最小值"
      @input="setMin(Number(($event.target as HTMLInputElement).value))"
    />
    <input
      class="range-input range-max"
      type="range"
      :min="min"
      :max="max"
      :step="step"
      :value="maxValue"
      aria-label="最大值"
      @input="setMax(Number(($event.target as HTMLInputElement).value))"
    />
    <div class="range-values">
      <span>{{ minValue.toPrecision(4) }} {{ unit }}</span>
      <span>{{ maxValue.toPrecision(4) }} {{ unit }}</span>
    </div>
  </div>
</template>

<style scoped>
.range-slider {
  position: relative;
  height: 38px;
  margin: 2px 0 4px;
}
.range-track {
  position: absolute;
  top: 8px;
  left: 0;
  right: 0;
  height: 4px;
  border-radius: 3px;
  background: var(--line);
}
.range-selected {
  position: absolute;
  top: 0;
  bottom: 0;
  border-radius: 3px;
  background: var(--accent);
}
.range-input {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 20px;
  margin: 0;
  pointer-events: none;
  appearance: none;
  background: transparent;
}
.range-input::-webkit-slider-thumb {
  width: 14px;
  height: 14px;
  margin-top: -5px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: var(--panel);
  cursor: ew-resize;
  pointer-events: auto;
  appearance: none;
}
.range-input::-moz-range-thumb {
  width: 11px;
  height: 11px;
  border: 2px solid var(--accent);
  border-radius: 50%;
  background: var(--panel);
  cursor: ew-resize;
  pointer-events: auto;
}
.range-input::-webkit-slider-runnable-track {
  height: 4px;
  background: transparent;
}
.range-input::-moz-range-track {
  height: 4px;
  background: transparent;
}
.range-max {
  z-index: 2;
}
.range-min {
  z-index: 3;
}
.range-values {
  position: absolute;
  top: 20px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-between;
  color: var(--muted);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
}
</style>
