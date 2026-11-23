<script setup lang="ts">
/**
 * 带可见说明的图标按钮。悬停和键盘焦点都显示同一句说明，选中态用 aria-pressed。
 */
defineProps<{
  label: string;
  hint: string;
  pressed?: boolean;
  align?: "start" | "end";
  compact?: boolean;
}>();

defineEmits<{ click: [] }>();
</script>

<template>
  <button
    type="button"
    class="icon-btn"
    :class="[align === 'start' ? 'align-start' : 'align-end', { compact }]"
    :aria-label="label"
    :aria-pressed="pressed"
    @click="$emit('click')"
  >
    <slot />
    <span class="tip" role="tooltip">{{ hint }}</span>
  </button>
</template>

<style scoped>
.icon-btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.icon-btn.compact { width: 28px; height: 28px; }
.icon-btn svg {
  display: block;
  width: 18px;
  height: 18px;
}
.icon-btn.compact svg { width: 16px; height: 16px; }
.icon-btn[aria-pressed="true"] {
  background: var(--accent-soft, rgba(95, 211, 230, 0.22));
  color: var(--accent, #5fd3e6);
}
.icon-btn:focus-visible {
  outline: 2px solid var(--accent, #5fd3e6);
  outline-offset: 2px;
}
.tip {
  position: absolute;
  top: calc(100% + 8px);
  z-index: 30;
  width: max-content;
  max-width: 220px;
  padding: 6px 8px;
  border: 1px solid var(--line, rgba(120, 170, 200, 0.28));
  border-radius: 8px;
  background: var(--panel, rgba(8, 16, 28, 0.96));
  color: var(--text, #dce9f2);
  font-size: 12px;
  font-weight: 400;
  line-height: 1.45;
  text-align: left;
  white-space: normal;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  opacity: 0;
  pointer-events: none;
}
.align-end .tip { right: 0; }
.align-start .tip { left: 0; }
.icon-btn:hover .tip,
.icon-btn:focus-visible .tip {
  opacity: 1;
}
</style>
