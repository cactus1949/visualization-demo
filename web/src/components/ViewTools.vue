<script setup lang="ts">
/**
 * 右下角视角按钮：指北针、缩放、底图切换（地球模式）、回到初始视角、全屏。
 * 只负责点击和指北针转角，相机动作由 AtmosViewer 交给当前宿主。
 */
import { House, Map as MapIcon, Maximize2, Minimize2, Minus, Plus, Satellite } from "@lucide/vue";
import { ANNOTATION_TOKENS as TK } from "../render/annotations/tokens";

defineProps<{
  compassDeg: number;
  fullscreen: boolean;
  basemap?: "img" | "vec";
}>();

const emit = defineEmits<{
  reset: [];
  zoomIn: [];
  zoomOut: [];
  north: [];
  fullscreen: [];
  toggleBasemap: [];
}>();

const needle = TK.colors.fixed;
</script>

<template>
  <div class="view-tools" @pointerdown.stop @wheel.stop>
    <el-tooltip content="正北朝上" placement="left" :show-after="200" :hide-after="0">
      <button type="button" class="tool compass" aria-label="正北朝上" @click="emit('north')">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.25" opacity="0.55" />
          <g :transform="`rotate(${compassDeg} 12 12)`">
            <path d="M12 3.6 L14.4 12.2 L12 10.4 L9.6 12.2 Z" :fill="needle" />
            <path d="M12 20.4 L9.6 11.8 L12 13.6 L14.4 11.8 Z" fill="currentColor" opacity="0.45" />
          </g>
        </svg>
      </button>
    </el-tooltip>

    <div class="zoom">
      <el-tooltip content="放大" placement="left" :show-after="200" :hide-after="0">
        <button type="button" class="tool" aria-label="放大" @click="emit('zoomIn')">
          <Plus :size="16" :stroke-width="2" />
        </button>
      </el-tooltip>
      <el-tooltip content="缩小" placement="left" :show-after="200" :hide-after="0">
        <button type="button" class="tool" aria-label="缩小" @click="emit('zoomOut')">
          <Minus :size="16" :stroke-width="2" />
        </button>
      </el-tooltip>
    </div>

    <el-tooltip
      v-if="basemap"
      :content="basemap === 'img' ? '切换矢量底图' : '切换影像底图'"
      placement="left"
      :show-after="200"
      :hide-after="0"
    >
      <button
        type="button"
        class="tool"
        :aria-label="basemap === 'img' ? '切换矢量底图' : '切换影像底图'"
        @click="emit('toggleBasemap')"
      >
        <Satellite v-if="basemap === 'img'" :size="16" :stroke-width="1.8" />
        <MapIcon v-else :size="16" :stroke-width="1.8" />
      </button>
    </el-tooltip>

    <el-tooltip content="回到初始视角" placement="left" :show-after="200" :hide-after="0">
      <button type="button" class="tool" aria-label="回到初始视角" @click="emit('reset')">
        <House :size="16" :stroke-width="1.8" />
      </button>
    </el-tooltip>

    <el-tooltip :content="fullscreen ? '退出全屏' : '全屏'" placement="left" :show-after="200" :hide-after="0">
      <button
        type="button"
        class="tool"
        :class="{ active: fullscreen }"
        :aria-label="fullscreen ? '退出全屏' : '全屏'"
        :aria-pressed="fullscreen"
        @click="emit('fullscreen')"
      >
        <Minimize2 v-if="fullscreen" :size="16" :stroke-width="1.8" />
        <Maximize2 v-else :size="16" :stroke-width="1.8" />
      </button>
    </el-tooltip>
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
  background: var(--card, rgba(8, 17, 30, 0.8));
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
  transition: border-color 140ms ease;
}

.zoom .tool {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  backdrop-filter: none;
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
  background: var(--card, rgba(8, 17, 30, 0.8));
  color: var(--text, #dce9f2);
  cursor: pointer;
  backdrop-filter: blur(12px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.22);
  transition:
    background-color 140ms ease,
    border-color 140ms ease,
    color 140ms ease;
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

.tool.active {
  background: var(--accent-soft, rgba(95, 211, 230, 0.2));
  border-color: var(--accent, #5fd3e6);
  color: var(--accent, #5fd3e6);
}

.zoom:hover {
  border-color: var(--accent, #5fd3e6);
}
</style>
