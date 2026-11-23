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

const rangeValue = computed<number[]>({
  get: () => [props.minValue, props.maxValue],
  set: (val: number[]) => {
    const low = val[0] ?? props.minValue;
    const high = val[1] ?? props.maxValue;
    const lo = Math.min(low, high);
    const hi = Math.max(low, high);
    if (lo !== props.minValue) emit("update:minValue", lo);
    if (hi !== props.maxValue) emit("update:maxValue", hi);
  },
});

const safeMax = computed(() => (props.max > props.min ? props.max : props.min + (props.step || 1)));
</script>

<template>
  <div class="range-slider">
    <el-slider
      v-model="rangeValue"
      range
      :min="min"
      :max="safeMax"
      :step="step"
      :show-tooltip="false"
      size="small"
    />
    <div class="range-values">
      <span>{{ minValue.toPrecision(4) }}{{ unit ? ` ${unit}` : "" }}</span>
      <span>{{ maxValue.toPrecision(4) }}{{ unit ? ` ${unit}` : "" }}</span>
    </div>
  </div>
</template>

<style scoped>
.range-slider {
  padding: 0 6px;
  margin: 2px 0 4px;
}

.range-slider :deep(.el-slider) {
  height: 20px;
}

.range-values {
  display: flex;
  justify-content: space-between;
  margin-top: 2px;
  color: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
</style>
