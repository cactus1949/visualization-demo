<script setup lang="ts">
/**
 * 右下角视角按钮：指北针、缩放、回到初始视角、全屏。
 * 只负责点击和指北针转角，相机动作由 AtmosViewer 交给当前宿主。
 */
import { ANNOTATION_TOKENS as TK } from "../render/annotations/tokens";

defineProps<{
  compassDeg: number;
  fullscreen: boolean;
}>();

const emit = defineEmits<{
  reset: [];
  zoomIn: [];
  zoomOut: [];
  north: [];
  fullscreen: [];
}>();

const needle = TK.colors.fixed;
</script>

<template>
  <div class="view-tools" @pointerdown.stop @wheel.stop>
    <button type="button" class="tool compass" title="正北朝上" aria-label="正北朝上" @click="emit('north')">
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.2" />
        <g :transform="`rotate(${compassDeg} 12 12)`">
          <path d="M12 3.6 L14.4 12.2 L12 10.4 L9.6 12.2 Z" :fill="needle" />
          <path d="M12 20.4 L9.6 11.8 L12 13.6 L14.4 11.8 Z" fill="currentColor" opacity="0.4" />
        </g>
      </svg>
    </button>
    <div class="zoom">
      <button type="button" class="tool" title="放大" aria-label="放大" @click="emit('zoomIn')">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
      <button type="button" class="tool" title="缩小" aria-label="缩小" @click="emit('zoomOut')">
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path d="M5 12h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
        </svg>
      </button>
    </div>
    <button type="button" class="tool" title="回到初始视角" aria-label="回到初始视角" @click="emit('reset')">
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M4 11.2 12 4.5l8 6.7V20a1 1 0 0 1-1 1h-5.2v-5.6H10.2V21H5a1 1 0 0 1-1-1v-8.8Z"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linejoin="round"
        />
      </svg>
    </button>
    <button
      type="button"
      class="tool"
      :title="fullscreen ? '退出全屏' : '全屏'"
      :aria-label="fullscreen ? '退出全屏' : '全屏'"
      :aria-pressed="fullscreen"
      @click="emit('fullscreen')"
    >
      <svg v-if="!fullscreen" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M9 4H4v5M15 4h5v5M20 15v5h-5M4 15v5h5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
      <svg v-else viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M4 9h5V4M15 4v5h5M20 15h-5v5M9 20v-5H4"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.view-tools {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.zoom {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid var(--line, rgba(120, 170, 200, 0.22));
  background: var(--card, rgba(8, 17, 30, 0.78));
  backdrop-filter: blur(10px);
}
.zoom .tool {
  border: 0;
  border-radius: 0;
  background: transparent;
}
.zoom .tool + .tool {
  border-top: 1px solid var(--line, rgba(120, 170, 200, 0.22));
}
.tool {
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border-radius: 10px;
  border: 1px solid var(--line, rgba(120, 170, 200, 0.22));
  background: var(--card, rgba(8, 17, 30, 0.78));
  color: var(--text, #dce9f2);
  cursor: pointer;
  backdrop-filter: blur(10px);
}
.tool.compass {
  width: 40px;
  height: 40px;
  border-radius: 999px;
}
.tool:hover {
  border-color: var(--accent, #5fd3e6);
  color: var(--accent, #5fd3e6);
}
.zoom:hover {
  border-color: var(--accent, #5fd3e6);
}
</style>
