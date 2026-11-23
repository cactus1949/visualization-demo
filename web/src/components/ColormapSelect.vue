<script setup lang="ts">
/**
 * 带渐变预览条的色带选择器：下拉选项与已选展示均直接呈现颜色分布。
 */
import { computed } from "vue";
import { colormapCss } from "../render/colormaps";

export interface ColormapOption {
  id: string;
  label: string;
  custom?: boolean;
}

const props = defineProps<{
  modelValue: string;
  options: readonly ColormapOption[];
  revision?: number;
}>();

const emit = defineEmits<{
  "update:modelValue": [id: string];
}>();

const swatches = computed(() => {
  void props.revision;
  const map: Record<string, string> = {};
  for (const opt of props.options) map[opt.id] = colormapCss(opt.id);
  return map;
});

function gradientOf(id: string): string {
  return swatches.value[id] ?? colormapCss(id);
}
</script>

<template>
  <el-select
    :model-value="modelValue"
    size="small"
    class="cmap-select"
    @update:model-value="emit('update:modelValue', String($event))"
  >
    <template #label="{ label, value }">
      <span class="cmap-picked">
        <span class="cmap-swatch" :style="{ background: gradientOf(String(value)) }" />
        <span class="cmap-name">{{ label }}</span>
      </span>
    </template>
    <el-option v-for="opt in options" :key="opt.id" :label="opt.label" :value="opt.id">
      <div class="cmap-option">
        <span class="cmap-swatch" :style="{ background: gradientOf(opt.id) }" />
        <span class="cmap-name">{{ opt.label }}</span>
        <span v-if="opt.custom" class="cmap-badge">自定义</span>
      </div>
    </el-option>
  </el-select>
</template>

<style scoped>
.cmap-select {
  width: 100%;
}

.cmap-picked,
.cmap-option {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
}

.cmap-swatch {
  flex: none;
  width: 48px;
  height: 10px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.16);
}

.cmap-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmap-badge {
  flex: none;
  font-size: 10px;
  color: var(--accent, #5fd3e6);
  opacity: 0.9;
}
</style>
