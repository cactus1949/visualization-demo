<script setup lang="ts">
/**
 * 右下角视角按钮：指北针、缩放、多视角切换（悬停左展）、底图切换（地球模式，悬停左展）、主题切换、回到初始视角、全屏。
 * 只负责交互与视觉反馈，相机动作由 AtmosViewer 交给当前宿主。
 */
import { ref } from "vue";
import { Compass, House, Map as MapIcon, Maximize2, Minimize2, Minus, Moon, Plus, Satellite, Sun } from "@lucide/vue";
import { ANNOTATION_TOKENS as TK } from "../render/annotations/tokens";

export interface ViewPresetItem {
  id: "overview" | "close" | "top";
  label: string;
}

defineProps<{
  compassDeg: number;
  fullscreen: boolean;
  basemap?: "img" | "vec";
  theme?: "dark" | "light";
  viewPresets?: readonly ViewPresetItem[];
}>();

const emit = defineEmits<{
  reset: [];
  selectView: [id: "overview" | "close" | "top"];
  zoomIn: [];
  zoomOut: [];
  north: [];
  fullscreen: [];
  selectBasemap: [style: "img" | "vec"];
  toggleTheme: [];
}>();

const needle = TK.colors.fixed;
const openMenu = ref<"view" | "basemap" | null>(null);

function onPickView(id: "overview" | "close" | "top"): void {
  openMenu.value = null;
  emit("selectView", id);
}

function onPickBasemap(style: "img" | "vec"): void {
  openMenu.value = null;
  emit("selectBasemap", style);
}
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

    <div
      v-if="viewPresets && viewPresets.length"
      class="flyout-anchor"
      @mouseenter="openMenu = 'view'"
      @mouseleave="openMenu = openMenu === 'view' ? null : openMenu"
    >
      <button
        type="button"
        class="tool"
        :class="{ active: openMenu === 'view' }"
        aria-label="切换视角"
        @click="openMenu = openMenu === 'view' ? null : 'view'"
      >
        <Compass :size="16" :stroke-width="1.8" />
      </button>
      <div v-if="openMenu === 'view'" class="flyout-wrap">
        <div class="flyout-card">
          <button
            v-for="item in viewPresets"
            :key="item.id"
            type="button"
            class="thumb-option"
            @click="onPickView(item.id)"
          >
            <span class="thumb-img">
              <svg v-if="item.id === 'overview'" viewBox="0 0 72 48" aria-hidden="true">
                <defs>
                  <linearGradient id="ov-bg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color="#0f2538" />
                    <stop offset="100%" stop-color="#193b52" />
                  </linearGradient>
                </defs>
                <rect width="72" height="48" fill="url(#ov-bg)" />
                <polygon points="36,14 62,25 36,38 10,25" fill="#1e516b" stroke="#5fd3e6" stroke-width="1.2" />
                <polygon points="26,24 34,20 34,28 26,31" fill="#8ad8e8" opacity="0.85" />
                <polygon points="36,19 45,23 45,30 36,34" fill="#5fb7cc" opacity="0.85" />
                <polygon points="44,25 51,28 51,32 44,35" fill="#bcebf5" opacity="0.7" />
                <path d="M16 17 Q32 12 52 18" fill="none" stroke="#ffc247" stroke-width="1.3" stroke-linecap="round" opacity="0.85" />
              </svg>
              <svg v-else-if="item.id === 'close'" viewBox="0 0 72 48" aria-hidden="true">
                <rect width="72" height="48" fill="#112638" />
                <rect x="0" y="34" width="72" height="14" fill="#19445b" />
                <rect x="9" y="18" width="11" height="22" rx="1" fill="#5da9be" />
                <rect x="24" y="10" width="14" height="30" rx="1" fill="#92dff0" />
                <rect x="42" y="15" width="12" height="25" rx="1" fill="#68bdd2" />
                <rect x="57" y="22" width="9" height="18" rx="1" fill="#468ea5" />
                <path d="M6 15 C22 10, 44 18, 66 11" fill="none" stroke="#ffc247" stroke-width="1.4" stroke-linecap="round" />
              </svg>
              <svg v-else viewBox="0 0 72 48" aria-hidden="true">
                <rect width="72" height="48" fill="#0f2436" />
                <g stroke="#2a5570" stroke-width="1">
                  <line x1="18" y1="6" x2="18" y2="42" />
                  <line x1="36" y1="6" x2="36" y2="42" />
                  <line x1="54" y1="6" x2="54" y2="42" />
                  <line x1="8" y1="16" x2="64" y2="16" />
                  <line x1="8" y1="32" x2="64" y2="32" />
                </g>
                <rect x="10" y="8" width="52" height="32" rx="2" fill="none" stroke="#5fd3e6" stroke-width="1.2" />
                <rect x="21" y="18" width="12" height="10" rx="1" fill="#77d6ea" opacity="0.8" />
                <rect x="39" y="11" width="11" height="16" rx="1" fill="#57b4cb" opacity="0.8" />
                <circle cx="36" cy="24" r="2.2" fill="#ffc247" />
              </svg>
            </span>
            <span class="thumb-label">{{ item.label }}</span>
          </button>
        </div>
      </div>
    </div>

    <div
      v-if="basemap"
      class="flyout-anchor"
      @mouseenter="openMenu = 'basemap'"
      @mouseleave="openMenu = openMenu === 'basemap' ? null : openMenu"
    >
      <button
        type="button"
        class="tool"
        :class="{ active: openMenu === 'basemap' }"
        aria-label="切换底图"
        @click="openMenu = openMenu === 'basemap' ? null : 'basemap'"
      >
        <Satellite v-if="basemap === 'img'" :size="16" :stroke-width="1.8" />
        <MapIcon v-else :size="16" :stroke-width="1.8" />
      </button>
      <div v-if="openMenu === 'basemap'" class="flyout-wrap">
        <div class="flyout-card">
          <button
            type="button"
            class="thumb-option"
            :class="{ selected: basemap === 'img' }"
            @click="onPickBasemap('img')"
          >
            <span class="thumb-img">
              <svg viewBox="0 0 72 48" aria-hidden="true">
                <defs>
                  <linearGradient id="sat-bg" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stop-color="#17382e" />
                    <stop offset="55%" stop-color="#214d3d" />
                    <stop offset="100%" stop-color="#193344" />
                  </linearGradient>
                </defs>
                <rect width="72" height="48" fill="url(#sat-bg)" />
                <path d="M-4 32 Q22 24 40 30 T76 22 L76 34 Q42 42 20 35 T-4 42 Z" fill="#174463" />
                <ellipse cx="22" cy="14" rx="14" ry="7" fill="#2e6347" opacity="0.85" />
                <ellipse cx="52" cy="39" rx="16" ry="7" fill="#3a6745" opacity="0.75" />
                <rect x="34" y="10" width="18" height="10" rx="2" fill="#4f6b5a" opacity="0.7" />
              </svg>
            </span>
            <span class="thumb-label">卫星影像</span>
          </button>
          <button
            type="button"
            class="thumb-option"
            :class="{ selected: basemap === 'vec' }"
            @click="onPickBasemap('vec')"
          >
            <span class="thumb-img">
              <svg viewBox="0 0 72 48" aria-hidden="true">
                <rect width="72" height="48" fill="#e7edf2" />
                <path d="M-4 34 Q24 26 42 32 T76 24 L76 33 Q42 41 20 35 T-4 42 Z" fill="#9bc9e8" />
                <rect x="8" y="6" width="18" height="14" rx="2" fill="#cde3c7" />
                <path d="M0 18 L72 12" stroke="#f5c26b" stroke-width="2.6" />
                <path d="M26 0 L34 48" stroke="#ffffff" stroke-width="2.2" />
                <path d="M48 0 L54 48" stroke="#ffffff" stroke-width="1.6" />
                <path d="M0 28 L72 22" stroke="#ffffff" stroke-width="1.4" />
              </svg>
            </span>
            <span class="thumb-label">矢量地图</span>
          </button>
        </div>
      </div>
    </div>

    <el-tooltip
      v-if="theme"
      :content="theme === 'dark' ? '切换浅色主题' : '切换深色主题'"
      placement="left"
      :show-after="200"
      :hide-after="0"
    >
      <button
        type="button"
        class="tool"
        :aria-label="theme === 'dark' ? '切换浅色主题' : '切换深色主题'"
        @click="emit('toggleTheme')"
      >
        <Sun v-if="theme === 'dark'" :size="16" :stroke-width="1.8" />
        <Moon v-else :size="16" :stroke-width="1.8" />
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

.flyout-anchor {
  position: relative;
  display: flex;
  align-items: center;
}

.flyout-wrap {
  position: absolute;
  right: 100%;
  top: 50%;
  transform: translateY(-50%);
  padding-right: 10px;
  z-index: 20;
}

.flyout-card {
  display: flex;
  gap: 8px;
  padding: 8px;
  border-radius: 12px;
  border: 1px solid var(--line, rgba(120, 170, 200, 0.22));
  background: var(--panel, rgba(9, 19, 33, 0.94));
  backdrop-filter: blur(14px);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.38);
}

.thumb-option {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 8px;
  border: 1px solid var(--line, rgba(120, 170, 200, 0.22));
  background: var(--surface, rgba(255, 255, 255, 0.04));
  color: var(--text, #dce9f2);
  cursor: pointer;
  transition:
    border-color 140ms ease,
    background-color 140ms ease,
    transform 120ms ease;
}

.thumb-option:hover {
  border-color: var(--accent, #5fd3e6);
  background: var(--surface-active, rgba(95, 211, 230, 0.08));
}

.thumb-option.selected {
  border-color: var(--accent, #5fd3e6);
  background: var(--accent-soft, rgba(95, 211, 230, 0.18));
  color: var(--accent, #5fd3e6);
}

.thumb-img {
  display: block;
  width: 72px;
  height: 48px;
  border-radius: 6px;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.12);
}

.thumb-img svg {
  display: block;
  width: 100%;
  height: 100%;
}

.thumb-label {
  font-size: 11px;
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
}
</style>
