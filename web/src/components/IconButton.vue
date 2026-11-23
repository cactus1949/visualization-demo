<script setup lang="ts">
/**
 * 带可见说明的图标按钮。悬停和键盘焦点都显示同一句说明，选中态用 aria-pressed。
 */
import { computed } from "vue";

const props = defineProps<{
  label: string;
  hint: string;
  pressed?: boolean;
  align?: "start" | "end";
  placement?: "top" | "bottom" | "left" | "right" | "bottom-start" | "bottom-end";
  compact?: boolean;
}>();

defineEmits<{ click: [] }>();

const tipPlacement = computed(
  () => props.placement ?? (props.align === "start" ? "bottom-start" : "bottom-end"),
);
</script>

<template>
  <el-tooltip
    :content="hint"
    :placement="tipPlacement"
    :show-after="220"
    :hide-after="0"
    :enterable="false"
    popper-class="icon-btn-tooltip"
  >
    <button
      type="button"
      class="icon-btn"
      :class="{ compact }"
      :aria-label="label"
      :aria-pressed="pressed"
      @click="$emit('click')"
    >
      <slot />
    </button>
  </el-tooltip>
</template>

<style scoped>
.icon-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: var(--text, #dce9f2);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
}

.icon-btn.compact {
  width: 28px;
  height: 28px;
  border-radius: 6px;
}

.icon-btn :deep(svg) {
  display: block;
  width: 17px;
  height: 17px;
  stroke-width: 1.8;
}

.icon-btn.compact :deep(svg) {
  width: 15px;
  height: 15px;
}

.icon-btn:hover {
  background: var(--el-fill-color, rgba(120, 170, 200, 0.14));
  color: var(--accent, #5fd3e6);
}

.icon-btn[aria-pressed="true"] {
  background: var(--accent-soft, rgba(95, 211, 230, 0.2));
  border-color: rgba(95, 211, 230, 0.35);
  color: var(--accent, #5fd3e6);
}

.icon-btn:focus-visible {
  outline: 2px solid var(--accent, #5fd3e6);
  outline-offset: 2px;
}
</style>
