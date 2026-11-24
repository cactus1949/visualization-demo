<script setup lang="ts">
/**
 * 左侧图层与场景面板：地面色斑、体渲染、风粒子卡片（支持就地展开常用参数）及场景开关。
 */
import { reactive } from "vue";
import { Box, ChevronDown, ChevronUp, Layers, PanelLeftClose, PanelLeftOpen, Wind } from "@lucide/vue";
import IconButton from "./IconButton.vue";
import RangeSlider from "./RangeSlider.vue";

export interface VariableOption {
  name: string;
  label: string;
}

export interface LayerRailLayers {
  buildings: boolean;
  buildingTintEnabled: boolean;
  buildingTintStrength: number;
  ground: boolean;
  groundVar: string;
  groundFilterMin: number;
  groundFilterMax: number;
  particles: boolean;
  volume: boolean;
  volumeVar: string;
  volumeOpacity: number;
  volumeFilterMin: number;
  volumeFilterMax: number;
}

defineProps<{
  open: boolean;
  globeMode: boolean;
  globeTerrain: boolean;
  layers: LayerRailLayers;
  particleHeightMin: number;
  particleHeightMax: number;
  variables2D: readonly VariableOption[];
  variables3D: readonly VariableOption[];
  groundBounds: readonly [number, number];
  groundUnits: string;
  volumeBounds: readonly [number, number];
  volumeUnits: string;
  volumeLowAlpha: boolean;
  volumeNotice: string | null;
}>();

const emit = defineEmits<{
  "toggle-open": [];
  "toggle-ground": [];
  "select-ground-var": [name: string];
  "toggle-volume": [];
  "select-volume-var": [name: string];
  "update:volumeLowAlpha": [on: boolean];
  "toggle-particles": [];
  "set-particle-height-range": [minM: number, maxM: number];
  "toggle-cesium": [on: boolean];
  "toggle-terrain": [on: boolean];
}>();

const layerExpanded = reactive({
  ground: false,
  volume: true,
  particles: false,
});
</script>

<template>
  <aside class="element-rail" :class="{ collapsed: !open }" @pointerdown.stop @wheel.stop>
    <div class="rail-head">
      <strong v-if="open" class="rail-title">图层</strong>
      <IconButton
        class="rail-fold"
        compact
        :label="open ? '收起图层' : '展开图层'"
        :hint="open ? '收起图层' : '展开图层'"
        align="start"
        placement="right"
        @click="emit('toggle-open')"
      >
        <PanelLeftClose v-if="open" :size="16" />
        <PanelLeftOpen v-else :size="16" />
      </IconButton>
    </div>

    <div v-show="open" class="rail-body">
      <div class="layer-block">
        <div class="layer-card" :class="{ active: layers.ground }">
          <div class="layer-row">
            <Layers class="layer-mark" :size="15" />
            <span class="layer-name">地面色斑</span>
            <button
              v-if="layers.ground && layers.groundVar !== 'none' && Number.isFinite(layers.groundFilterMin)"
              type="button"
              class="layer-expand"
              :aria-expanded="layerExpanded.ground"
              :title="layerExpanded.ground ? '收起参数' : '展开参数'"
              @click="layerExpanded.ground = !layerExpanded.ground"
            >
              <ChevronUp v-if="layerExpanded.ground" :size="14" />
              <ChevronDown v-else :size="14" />
            </button>
            <el-switch
              :model-value="layers.ground"
              size="small"
              aria-label="地面色斑"
              @change="emit('toggle-ground')"
            />
          </div>
          <el-select
            class="layer-select"
            :class="{ idle: !layers.ground }"
            :model-value="layers.groundVar"
            size="small"
            aria-label="地面变量"
            @update:model-value="emit('select-ground-var', String($event))"
          >
            <el-option v-for="v in variables2D" :key="v.name" :label="v.label" :value="v.name" />
          </el-select>
          <div
            v-if="layers.ground && layers.groundVar !== 'none' && Number.isFinite(layers.groundFilterMin) && layerExpanded.ground"
            class="layer-extras"
          >
            <div class="slider-field range-label">
              <div class="slider-head"><span>地面值域</span></div>
              <RangeSlider
                :min="groundBounds[0]"
                :max="groundBounds[1]"
                :min-value="layers.groundFilterMin"
                :max-value="layers.groundFilterMax"
                :unit="groundUnits"
                :step="Math.max((groundBounds[1] - groundBounds[0]) / 200, 1e-6)"
                @update:min-value="layers.groundFilterMin = $event"
                @update:max-value="layers.groundFilterMax = $event"
              />
            </div>
          </div>
        </div>

        <div class="layer-card" :class="{ active: layers.volume }">
          <div class="layer-row">
            <Box class="layer-mark" :size="15" />
            <span class="layer-name">体渲染</span>
            <button
              v-if="layers.volume"
              type="button"
              class="layer-expand"
              :aria-expanded="layerExpanded.volume"
              :title="layerExpanded.volume ? '收起参数' : '展开参数'"
              @click="layerExpanded.volume = !layerExpanded.volume"
            >
              <ChevronUp v-if="layerExpanded.volume" :size="14" />
              <ChevronDown v-else :size="14" />
            </button>
            <el-switch
              :model-value="layers.volume"
              size="small"
              aria-label="体渲染"
              @change="emit('toggle-volume')"
            />
          </div>
          <el-select
            class="layer-select"
            :class="{ idle: !layers.volume }"
            :model-value="layers.volumeVar"
            size="small"
            aria-label="体渲染变量"
            @update:model-value="emit('select-volume-var', String($event))"
          >
            <el-option v-for="v in variables3D" :key="v.name" :label="v.label" :value="v.name" />
          </el-select>
          <div v-if="layers.volume && layerExpanded.volume" class="layer-extras">
            <div class="slider-field">
              <div class="slider-head">
                <span>不透明度</span>
                <span class="val">{{ layers.volumeOpacity.toFixed(2) }}</span>
              </div>
              <el-slider v-model="layers.volumeOpacity" :min="0.05" :max="2" :step="0.05" :show-tooltip="false" />
            </div>

            <div class="check-row">
              <el-checkbox
                :model-value="volumeLowAlpha"
                @update:model-value="emit('update:volumeLowAlpha', Boolean($event))"
              >
                低值透明
              </el-checkbox>
            </div>

            <div v-if="volumeNotice" class="panel-warn">{{ volumeNotice }}</div>

            <div class="slider-field range-label">
              <div class="slider-head"><span>数值窗口</span></div>
              <RangeSlider
                :min="volumeBounds[0]"
                :max="volumeBounds[1]"
                :min-value="layers.volumeFilterMin"
                :max-value="layers.volumeFilterMax"
                :unit="volumeUnits"
                :step="Math.max((volumeBounds[1] - volumeBounds[0]) / 200, 1e-6)"
                @update:min-value="layers.volumeFilterMin = $event"
                @update:max-value="layers.volumeFilterMax = $event"
              />
            </div>
          </div>
        </div>

        <div class="layer-card" :class="{ active: layers.particles }">
          <div class="layer-row">
            <Wind class="layer-mark" :size="15" />
            <span class="layer-name">风粒子</span>
            <button
              v-if="layers.particles"
              type="button"
              class="layer-expand"
              :aria-expanded="layerExpanded.particles"
              :title="layerExpanded.particles ? '收起参数' : '展开参数'"
              @click="layerExpanded.particles = !layerExpanded.particles"
            >
              <ChevronUp v-if="layerExpanded.particles" :size="14" />
              <ChevronDown v-else :size="14" />
            </button>
            <el-switch
              :model-value="layers.particles"
              size="small"
              aria-label="风粒子"
              @change="emit('toggle-particles')"
            />
          </div>
          <div v-if="layers.particles && layerExpanded.particles" class="layer-extras">
            <div class="slider-field range-label">
              <div class="slider-head">
                <span>高度范围</span>
                <span class="val">{{ particleHeightMin }}–{{ particleHeightMax }} m</span>
              </div>
              <RangeSlider
                :min="10"
                :max="1000"
                :min-value="particleHeightMin"
                :max-value="particleHeightMax"
                :step="10"
                unit="m"
                @update:min-value="emit('set-particle-height-range', $event, particleHeightMax)"
                @update:max-value="emit('set-particle-height-range', particleHeightMin, $event)"
              />
            </div>
          </div>
        </div>
      </div>

      <div class="scene-group">
        <div class="scene-title">场景</div>
        <div class="check-stack">
          <el-checkbox :model-value="globeMode" @update:model-value="emit('toggle-cesium', Boolean($event))">
            Cesium 地球
          </el-checkbox>
          <el-checkbox v-model="layers.buildings">建筑白膜</el-checkbox>
          <div v-if="layers.buildings" class="scene-sub">
            <el-checkbox
              v-model="layers.buildingTintEnabled"
              :disabled="!layers.ground || layers.groundVar === 'none'"
            >
              白膜着色
            </el-checkbox>
            <div v-if="layers.buildingTintEnabled" class="slider-field">
              <div class="slider-head">
                <span>着色程度</span>
                <span class="val">{{ Math.round(layers.buildingTintStrength * 100) }}%</span>
              </div>
              <el-slider
                v-model="layers.buildingTintStrength"
                :min="0"
                :max="1"
                :step="0.05"
                :disabled="!layers.ground || layers.groundVar === 'none'"
                :show-tooltip="false"
              />
            </div>
          </div>
          <el-checkbox
            v-if="globeMode"
            :model-value="globeTerrain"
            @update:model-value="emit('toggle-terrain', Boolean($event))"
          >
            地形
          </el-checkbox>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.element-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 256px;
  overflow-y: auto;
  background: var(--panel);
  backdrop-filter: blur(16px);
  border-right: 1px solid var(--line);
  color: var(--text);
  z-index: 10;
  transition: width 160ms ease;
}

.element-rail.collapsed {
  width: 44px;
}

.rail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}

.rail-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.element-rail.collapsed .rail-head {
  justify-content: center;
  padding: 8px 4px;
}

.layer-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
}

.layer-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--surface);
  border: 1px solid var(--line);
  transition:
    background-color 140ms ease,
    border-color 140ms ease;
}

.layer-card.active {
  background: var(--surface-active);
  border-color: rgba(95, 211, 230, 0.35);
}

:global(.viewer.light) .layer-card.active {
  border-color: rgba(15, 138, 163, 0.35);
}

.layer-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 24px;
}

.layer-mark {
  flex: none;
  color: var(--muted);
  transition: color 140ms ease;
}

.layer-card.active .layer-mark {
  color: var(--accent);
}

.layer-name {
  flex: 1;
  min-width: 0;
  font-weight: 500;
}

.layer-select {
  width: 100%;
}

.layer-select.idle {
  opacity: 0.65;
}

.layer-expand {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 120ms ease,
    color 120ms ease;
}

.layer-expand:hover {
  background: var(--surface);
  color: var(--accent);
}

.layer-extras {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--line);
}

.scene-group {
  padding: 10px 12px 14px;
  border-top: 1px solid var(--line);
}

.scene-title {
  color: var(--muted);
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.check-stack {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.scene-sub {
  margin: 2px 0 4px 12px;
  padding: 4px 0 4px 10px;
  border-left: 2px solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
