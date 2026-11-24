<script setup lang="ts">
/**
 * 可拖拽的剖面配置悬浮窗：类型切换、变量、高度/偏移/绘制/框选控制、等值线与折叠样式项。
 */
import { ref } from "vue";
import { ChevronDown, ChevronUp, GripHorizontal, X } from "@lucide/vue";
import type { SectionKind } from "../render/sections/types";
import ColormapSelect, { type ColormapOption } from "./ColormapSelect.vue";
import IconButton from "./IconButton.vue";
import type { VariableOption } from "./LayerRail.vue";
import RangeSlider from "./RangeSlider.vue";

export interface SectionFloatState {
  enabled: boolean;
  kind: SectionKind;
  drawMode: boolean;
  variable: string;
  offsetKm: number;
  colormap: string;
  autoRange: boolean;
  min: number;
  max: number;
  opacity: number;
  contours: number;
  lowAlpha: boolean;
  lowThreshold: number;
  points: unknown[];
  box: {
    heightMinM: number;
    heightMaxM: number;
    stepLevels: number;
  };
}

defineProps<{
  collapsed: boolean;
  pos: { x: number; y: number } | null;
  section: SectionFloatState;
  slice: { heightM: number };
  variables3D: readonly VariableOption[];
  colormapOptions: readonly ColormapOption[];
  colormapRevision: number;
  drawHint: string;
  hasGeometry: boolean;
  unfoldedVisible: boolean;
}>();

const emit = defineEmits<{
  "drag-start": [event: PointerEvent];
  "toggle-collapse": [];
  close: [];
  "select-kind": [kind: SectionKind];
  "commit-range": [];
  "finish-drawing": [];
  "cancel-drawing": [];
  "start-drawing": [fresh: boolean];
  "clear-drawn": [];
  "toggle-unfolded": [];
}>();

const sectionStyleCollapse = ref<string[]>([]);

const SECTION_KINDS: readonly { id: SectionKind; label: string }[] = [
  { id: "height", label: "高度" },
  { id: "lon", label: "经度" },
  { id: "lat", label: "纬度" },
  { id: "polyline", label: "折线" },
  { id: "box", label: "框选" },
];
</script>

<template>
  <div
    class="section-float"
    :class="{ collapsed }"
    :style="pos ? { left: pos.x + 'px', top: pos.y + 'px', right: 'auto' } : undefined"
    @pointerdown.stop
    @wheel.stop
  >
    <div class="float-head" @pointerdown="emit('drag-start', $event)">
      <div class="float-title">
        <GripHorizontal :size="14" class="drag-grip" />
        <strong>剖面配置</strong>
      </div>
      <span class="float-actions">
        <IconButton
          compact
          :label="collapsed ? '展开剖面配置' : '收起剖面配置'"
          :hint="collapsed ? '展开' : '收起'"
          @click="emit('toggle-collapse')"
        >
          <ChevronDown v-if="collapsed" :size="15" />
          <ChevronUp v-else :size="15" />
        </IconButton>
        <IconButton compact label="关闭剖面配置" hint="关闭" @click="emit('close')">
          <X :size="15" />
        </IconButton>
      </span>
    </div>

    <div v-show="!collapsed" class="float-body">
      <div class="mode-picks">
        <el-button
          v-for="item in SECTION_KINDS"
          :key="item.id"
          size="small"
          :type="section.enabled && section.kind === item.id ? 'primary' : 'default'"
          :plain="!(section.enabled && section.kind === item.id)"
          :aria-pressed="section.enabled && section.kind === item.id"
          @click="emit('select-kind', item.id)"
        >
          {{ item.label }}
        </el-button>
      </div>

      <div class="form-row">
        <span class="field-label">变量</span>
        <el-select v-model="section.variable" size="small" class="field-control">
          <el-option v-for="v in variables3D" :key="v.name" :label="v.label" :value="v.name" />
        </el-select>
      </div>

      <div v-if="section.kind === 'height'" class="slider-field">
        <div class="slider-head">
          <span>高度</span>
          <span class="val">{{ slice.heightM.toFixed(1) }} m</span>
        </div>
        <el-slider v-model="slice.heightM" :min="12.5" :max="987.5" :step="0.5" :show-tooltip="false" />
      </div>

      <div v-if="section.kind === 'lon' || section.kind === 'lat'" class="slider-field">
        <div class="slider-head">
          <span>位置偏移</span>
          <span class="val">{{ section.offsetKm.toFixed(2) }} km</span>
        </div>
        <el-slider v-model="section.offsetKm" :min="-12" :max="12" :step="0.01" :show-tooltip="false" />
      </div>

      <div v-if="section.enabled && (section.kind === 'polyline' || section.kind === 'box')" class="section-tools">
        <div class="draw-actions">
          <template v-if="section.drawMode">
            <el-button
              v-if="section.kind === 'polyline'"
              size="small"
              type="primary"
              :disabled="section.points.length < 2"
              @click="emit('finish-drawing')"
            >
              完成
            </el-button>
            <el-button size="small" @click="emit('cancel-drawing')">取消</el-button>
          </template>
          <template v-else>
            <el-button size="small" :disabled="!hasGeometry" @click="emit('start-drawing', false)">编辑</el-button>
            <el-button size="small" @click="emit('start-drawing', true)">重画</el-button>
            <el-button size="small" :disabled="!hasGeometry" @click="emit('clear-drawn')">清除</el-button>
          </template>
          <el-button
            v-if="section.kind === 'polyline'"
            size="small"
            :type="unfoldedVisible ? 'primary' : 'default'"
            @click="emit('toggle-unfolded')"
          >
            {{ unfoldedVisible ? "隐藏展开图" : "显示展开图" }}
          </el-button>
        </div>
        <div class="hint-line">{{ drawHint }}</div>
      </div>

      <template v-if="section.kind === 'box'">
        <div class="slider-field range-label">
          <div class="slider-head">
            <span>高度范围</span>
            <span class="val">{{ section.box.heightMinM.toFixed(0) }}–{{ section.box.heightMaxM.toFixed(0) }} m</span>
          </div>
          <RangeSlider
            :min="0"
            :max="1000"
            :min-value="section.box.heightMinM"
            :max-value="section.box.heightMaxM"
            :step="12.5"
            @update:min-value="section.box.heightMinM = $event"
            @update:max-value="section.box.heightMaxM = $event"
          />
        </div>
        <div class="form-row">
          <span class="field-label">间隔</span>
          <el-select v-model="section.box.stepLevels" size="small" class="field-control">
            <el-option :value="1" label="每 1 层" />
            <el-option :value="2" label="每 2 层" />
            <el-option :value="5" label="每 5 层" />
          </el-select>
        </div>
      </template>

      <div class="slider-field">
        <div class="slider-head">
          <span>等值线</span>
          <span class="val">{{ section.contours || "关" }}</span>
        </div>
        <el-slider v-model="section.contours" :min="0" :max="30" :step="1" :show-tooltip="false" />
      </div>

      <el-collapse v-model="sectionStyleCollapse" class="inline-collapse">
        <el-collapse-item title="显示样式" name="style">
          <div class="collapse-stack">
            <div class="form-row">
              <span class="field-label">色带</span>
              <ColormapSelect
                v-model="section.colormap"
                :options="colormapOptions"
                :revision="colormapRevision"
                class="field-control"
              />
            </div>

            <div class="form-row range-inputs">
              <el-checkbox v-model="section.autoRange">自动</el-checkbox>
              <el-input-number
                v-model="section.min"
                size="small"
                :controls="false"
                :disabled="section.autoRange"
                class="num-input"
                @blur="emit('commit-range')"
              />
              <span class="dash">–</span>
              <el-input-number
                v-model="section.max"
                size="small"
                :controls="false"
                :disabled="section.autoRange"
                class="num-input"
                @blur="emit('commit-range')"
              />
            </div>

            <div class="slider-field">
              <div class="slider-head">
                <span>不透明度</span>
                <span class="val">{{ section.opacity.toFixed(2) }}</span>
              </div>
              <el-slider v-model="section.opacity" :min="0.1" :max="1" :step="0.01" :show-tooltip="false" />
            </div>

            <div class="check-row">
              <el-checkbox v-model="section.lowAlpha">低值透明</el-checkbox>
            </div>

            <div v-if="section.lowAlpha" class="slider-field">
              <div class="slider-head">
                <span>透明阈值</span>
                <span class="val">{{ (section.lowThreshold * 100).toFixed(0) }}%</span>
              </div>
              <el-slider v-model="section.lowThreshold" :min="0" :max="0.6" :step="0.01" :show-tooltip="false" />
            </div>
          </div>
        </el-collapse-item>
      </el-collapse>
    </div>
  </div>
</template>

<style scoped>
.section-float {
  position: absolute;
  z-index: 9;
  top: 64px;
  right: calc(var(--rail-right, 0px) + 12px);
  width: min(308px, calc(100% - var(--rail-left, 0px) - var(--rail-right, 0px) - 24px));
  max-height: calc(100% - 88px);
  overflow: hidden;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid var(--line);
  backdrop-filter: blur(16px);
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.36);
}

.section-float.collapsed {
  max-height: none;
}

.float-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  cursor: grab;
  user-select: none;
}

.section-float.collapsed .float-head {
  border-bottom: 0;
}

.float-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.drag-grip {
  color: var(--muted);
}

.float-actions {
  display: inline-flex;
  gap: 2px;
}

.float-body {
  padding: 10px 12px 12px;
  max-height: min(560px, calc(100vh - 150px));
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mode-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.mode-picks :deep(.el-button) {
  margin-left: 0;
  padding: 5px 9px;
}

.range-inputs {
  gap: 6px;
}

.range-inputs :deep(.el-checkbox) {
  margin-right: 2px;
}

.num-input {
  flex: 1;
  min-width: 0;
}

.num-input :deep(.el-input__inner) {
  text-align: left;
  font-variant-numeric: tabular-nums;
}

.dash {
  color: var(--muted);
  flex: none;
}

.section-tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
}

.draw-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.draw-actions :deep(.el-button) {
  margin-left: 0;
}

.hint-line {
  color: var(--muted);
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
