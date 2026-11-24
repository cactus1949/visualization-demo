<script setup lang="ts">
/**
 * 右侧设置抽屉：分为「粒子」「场景」「色带」三个页签，以及仅在调试模式显示的「调试与裁剪」。
 */
import { computed, ref } from "vue";
import { RotateCcw, Save, X } from "@lucide/vue";
import type { CutState } from "../render/cuts";
import type { ColorMode, ParticleParams } from "../render/particles";
import type { Theme } from "../render/scene";
import type { ColorScaleMode } from "../state/colorScale";
import type { CustomColormap } from "../state/customColormaps";
import {
  applyParticlePreset,
  matchParticlePreset,
  PARTICLE_PRESETS,
  type ParticlePresetId,
} from "../state/particlePresets";
import ColormapManager from "./ColormapManager.vue";
import ColormapSelect, { type ColormapOption } from "./ColormapSelect.vue";
import IconButton from "./IconButton.vue";
import RangeSlider from "./RangeSlider.vue";

export interface SettingsDrawerLayers {
  buildings: boolean;
  buildingOpacity: number;
  volume: boolean;
  volumeThreshold: number;
  cutLowAlpha: boolean;
  cutLowThreshold: number;
  filterSlices: boolean;
}

export interface SettingsDrawerStats {
  status: string;
  gpu: string;
  particleLabel: string;
  loadMs: Record<string, number>;
  buildingsInfo: string;
}

const props = defineProps<{
  globeMode: boolean;
  chromeK: number;
  debugUi: boolean;
  formatId: string;
  prefsMessage: string | null;
  view: { exaggeration: number; theme: Theme; shadows: boolean };
  colorScaleMode: ColorScaleMode;
  layers: SettingsDrawerLayers;
  cuts: CutState;
  particleParams: ParticleParams;
  colorModes: readonly { value: ColorMode; label: string }[];
  colormapOptions: readonly ColormapOption[];
  colormapRevision: number;
  customColormaps: readonly CustomColormap[];
  volumeThresholdHint: string;
  stats: SettingsDrawerStats;
}>();

const emit = defineEmits<{
  close: [];
  save: [];
  restore: [];
  "update:colorScaleMode": [mode: ColorScaleMode];
  "set-globe-k": [k: number];
  "toggle-sz3": [on: boolean];
  "set-particle-height-range": [minM: number, maxM: number];
  "create-colormap": [payload: { label: string; stops: string[] }];
  "update-colormap": [payload: { id: string; label: string; stops: string[] }];
  "delete-colormap": [id: string];
}>();

const settingsTab = ref<"particles" | "scene" | "colormaps">("particles");
const particleAdvancedCollapse = ref<string[]>([]);
const debugCollapse = ref<string[]>([]);

const activeParticlePreset = computed(() => matchParticlePreset(props.particleParams));

function selectParticlePreset(id: ParticlePresetId): void {
  applyParticlePreset(props.particleParams, id);
}
</script>

<template>
  <aside class="settings-rail" @pointerdown.stop @wheel.stop>
    <div class="panel-head">
      <strong>设置</strong>
      <IconButton compact label="关闭设置" hint="关闭" align="start" @click="emit('close')">
        <X :size="15" />
      </IconButton>
    </div>
    <div class="prefs-actions">
      <el-button type="primary" size="small" @click="emit('save')">
        <Save :size="13" class="btn-ico" />保存
      </el-button>
      <el-button size="small" @click="emit('restore')">
        <RotateCcw :size="13" class="btn-ico" />恢复默认
      </el-button>
    </div>
    <p v-if="prefsMessage" class="prefs-message">{{ prefsMessage }}</p>

    <el-tabs v-model="settingsTab" stretch class="settings-tabs">
      <el-tab-pane label="粒子" name="particles">
        <div class="tab-content">
          <div class="preset-section">
            <div class="preset-head">
              <span class="field-label">风格预设</span>
              <span v-if="activeParticlePreset === 'custom'" class="custom-tag">自定义</span>
            </div>
            <div class="preset-grid">
              <el-button
                v-for="preset in PARTICLE_PRESETS"
                :key="preset.id"
                size="small"
                :type="activeParticlePreset === preset.id ? 'primary' : 'default'"
                :plain="activeParticlePreset !== preset.id"
                @click="selectParticlePreset(preset.id)"
              >
                {{ preset.label }}
              </el-button>
            </div>
          </div>

          <div class="form-row">
            <span class="field-label">着色</span>
            <el-select v-model="particleParams.colorMode" size="small" class="field-control">
              <el-option v-for="m in colorModes" :key="m.value" :label="m.label" :value="m.value" />
            </el-select>
          </div>

          <div v-if="particleParams.colorMode !== 'single'" class="form-row">
            <span class="field-label">色带</span>
            <ColormapSelect
              v-model="particleParams.colormap"
              :options="colormapOptions"
              :revision="colormapRevision"
              class="field-control"
            />
          </div>
          <div v-else class="form-row">
            <span class="field-label">颜色</span>
            <el-color-picker v-model="particleParams.color" size="small" />
          </div>

          <div class="slider-field">
            <div class="slider-head">
              <span>不透明度</span>
              <span class="val">{{ particleParams.opacity.toFixed(2) }}</span>
            </div>
            <el-slider v-model="particleParams.opacity" :min="0.05" :max="1" :step="0.01" :show-tooltip="false" />
          </div>

          <div class="slider-field range-label">
            <div class="slider-head">
              <span>高度范围</span>
              <span class="val">{{ particleParams.heightMin }}–{{ particleParams.heightMax }} m</span>
            </div>
            <RangeSlider
              :min="10"
              :max="1000"
              :min-value="particleParams.heightMin"
              :max-value="particleParams.heightMax"
              :step="10"
              unit="m"
              @update:min-value="emit('set-particle-height-range', $event, particleParams.heightMax)"
              @update:max-value="emit('set-particle-height-range', particleParams.heightMin, $event)"
            />
          </div>

          <el-collapse v-model="particleAdvancedCollapse" class="inline-collapse">
            <el-collapse-item title="高级粒子参数" name="advanced">
              <div class="collapse-stack">
                <div class="slider-field">
                  <div class="slider-head">
                    <span>粒子数量</span>
                    <span class="val">{{ particleParams.count.toLocaleString() }}</span>
                  </div>
                  <el-slider v-model="particleParams.count" :min="4000" :max="262144" :step="4000" :show-tooltip="false" />
                </div>

                <div class="slider-field">
                  <div class="slider-head">
                    <span>尾迹长度</span>
                    <span class="val">{{ particleParams.trailLength }} 步</span>
                  </div>
                  <el-slider
                    v-model="particleParams.trailLength"
                    :min="2"
                    :max="particleParams.count > 70000 ? 32 : 64"
                    :step="1"
                    :show-tooltip="false"
                  />
                </div>

                <div class="slider-field">
                  <div class="slider-head">
                    <span>速度倍率</span>
                    <span class="val">{{ particleParams.speed.toFixed(2) }}×</span>
                  </div>
                  <el-slider v-model="particleParams.speed" :min="0.05" :max="5" :step="0.05" :show-tooltip="false" />
                </div>

                <div class="slider-field">
                  <div class="slider-head">
                    <span>线宽</span>
                    <span class="val">{{ particleParams.lineWidth.toFixed(1) }} px</span>
                  </div>
                  <el-slider v-model="particleParams.lineWidth" :min="0.5" :max="8" :step="0.1" :show-tooltip="false" />
                </div>

                <div class="slider-field">
                  <div class="slider-head">
                    <span>生命周期</span>
                    <span class="val">{{ particleParams.lifetime.toFixed(1) }} s</span>
                  </div>
                  <el-slider v-model="particleParams.lifetime" :min="1" :max="30" :step="0.5" :show-tooltip="false" />
                </div>

                <div class="slider-field">
                  <div class="slider-head">
                    <span>w 垂直放大</span>
                    <span class="val">{{ particleParams.wExaggeration.toFixed(1) }}×</span>
                  </div>
                  <el-slider v-model="particleParams.wExaggeration" :min="0" :max="20" :step="0.5" :show-tooltip="false" />
                </div>

                <div class="row-wrap">
                  <el-checkbox v-model="particleParams.taper">尾迹收细</el-checkbox>
                  <el-checkbox v-model="particleParams.additive">叠加发光</el-checkbox>
                  <el-checkbox v-model="particleParams.paused">暂停</el-checkbox>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </el-tab-pane>

      <el-tab-pane label="场景" name="scene">
        <div class="tab-content">
          <div v-if="!globeMode" class="slider-field">
            <div class="slider-head">
              <span>垂直夸张</span>
              <span class="val">{{ view.exaggeration.toFixed(1) }}×</span>
            </div>
            <el-slider v-model="view.exaggeration" :min="1" :max="10" :step="0.1" :show-tooltip="false" />
          </div>

          <div v-else class="slider-field">
            <div class="slider-head">
              <span>垂直夸张</span>
              <span class="val">{{ chromeK.toFixed(1) }}×</span>
            </div>
            <el-slider
              :model-value="chromeK"
              :min="1"
              :max="10"
              :step="0.1"
              :show-tooltip="false"
              @update:model-value="emit('set-globe-k', Number($event))"
            />
          </div>

          <div class="form-row">
            <span class="field-label">色标</span>
            <el-select
              :model-value="colorScaleMode"
              size="small"
              class="field-control"
              @update:model-value="emit('update:colorScaleMode', $event as ColorScaleMode)"
            >
              <el-option value="frame" label="本帧最小–最大" />
              <el-option value="display" label="固定范围" />
            </el-select>
          </div>

          <div class="form-row">
            <span class="field-label">主题</span>
            <el-select v-model="view.theme" size="small" class="field-control">
              <el-option value="dark" label="深色" />
              <el-option value="light" label="浅色" />
            </el-select>
          </div>

          <template v-if="layers.buildings">
            <div class="slider-field">
              <div class="slider-head">
                <span>建筑不透明度</span>
                <span class="val">{{ layers.buildingOpacity.toFixed(2) }}</span>
              </div>
              <el-slider v-model="layers.buildingOpacity" :min="0" :max="1" :step="0.05" :show-tooltip="false" />
            </div>
            <div class="check-row">
              <el-checkbox v-model="view.shadows">建筑阴影</el-checkbox>
            </div>
          </template>

          <el-collapse v-if="debugUi" v-model="debugCollapse" class="inline-collapse">
            <el-collapse-item title="调试与裁剪" name="debug">
              <div class="collapse-stack">
                <div class="check-row">
                  <el-checkbox :model-value="formatId === 'sz3'" @update:model-value="emit('toggle-sz3', Boolean($event))">
                    SZ3 压缩格式
                  </el-checkbox>
                </div>

                <template v-if="layers.volume">
                  <div class="slider-field">
                    <div class="slider-head">
                      <span>透明阈值</span>
                      <span class="val">{{ volumeThresholdHint }}</span>
                    </div>
                    <el-slider v-model="layers.volumeThreshold" :min="0" :max="0.95" :step="0.01" :show-tooltip="false" />
                  </div>
                  <div class="slider-field range-label">
                    <div class="slider-head"><span>东西裁剪</span></div>
                    <RangeSlider :min="0" :max="1" :min-value="cuts.x[0]" :max-value="cuts.x[1]" :step="0.01" @update:min-value="cuts.x[0] = $event" @update:max-value="cuts.x[1] = $event" />
                  </div>
                  <div class="slider-field range-label">
                    <div class="slider-head"><span>南北裁剪</span></div>
                    <RangeSlider :min="0" :max="1" :min-value="cuts.y[0]" :max-value="cuts.y[1]" :step="0.01" @update:min-value="cuts.y[0] = $event" @update:max-value="cuts.y[1] = $event" />
                  </div>
                  <div class="slider-field range-label">
                    <div class="slider-head"><span>高度裁剪</span></div>
                    <RangeSlider :min="0" :max="1" :min-value="cuts.z[0]" :max-value="cuts.z[1]" :step="0.01" @update:min-value="cuts.z[0] = $event" @update:max-value="cuts.z[1] = $event" />
                  </div>
                  <div class="check-row">
                    <el-checkbox v-model="cuts.faces">切面</el-checkbox>
                  </div>
                  <template v-if="cuts.faces">
                    <div class="check-row">
                      <el-checkbox v-model="layers.cutLowAlpha">切面低值透明</el-checkbox>
                    </div>
                    <div v-if="layers.cutLowAlpha" class="slider-field">
                      <div class="slider-head">
                        <span>切面透明阈值</span>
                        <span class="val">{{ (layers.cutLowThreshold * 100).toFixed(0) }}%</span>
                      </div>
                      <el-slider v-model="layers.cutLowThreshold" :min="0" :max="0.6" :step="0.01" :show-tooltip="false" />
                    </div>
                  </template>
                  <div class="check-row">
                    <el-checkbox v-model="layers.filterSlices">切面跟随体渲染过滤</el-checkbox>
                  </div>
                </template>

                <div class="stats">
                  <div>{{ stats.status }}</div>
                  <div>渲染：WebGL2 · {{ stats.gpu }}</div>
                  <div>粒子路径：{{ stats.particleLabel }}</div>
                  <div>
                    加载耗时：<span v-for="(ms, k) in stats.loadMs" :key="k">{{ k }} {{ ms }} ms · </span>
                  </div>
                  <div>建筑：{{ stats.buildingsInfo }}（3D-GloBFP + OSM）</div>
                </div>
              </div>
            </el-collapse-item>
          </el-collapse>
        </div>
      </el-tab-pane>

      <el-tab-pane label="色带" name="colormaps">
        <div class="tab-content">
          <ColormapManager
            :custom-colormaps="customColormaps"
            @create="emit('create-colormap', $event)"
            @update="emit('update-colormap', $event)"
            @delete="emit('delete-colormap', $event)"
          />
        </div>
      </el-tab-pane>
    </el-tabs>
  </aside>
</template>

<style scoped>
.settings-rail {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: 320px;
  overflow-y: auto;
  background: var(--panel);
  backdrop-filter: blur(16px);
  border-left: 1px solid var(--line);
  color: var(--text);
  z-index: 10;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
}

.panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.panel-head strong {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.prefs-message {
  color: var(--accent);
  font-size: 11px;
  margin: 6px 0 0;
}

.prefs-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.prefs-actions :deep(.el-button) {
  flex: 1;
  margin-left: 0;
}

.btn-ico {
  margin-right: 4px;
}

.settings-tabs {
  margin-top: 8px;
}

.settings-tabs :deep(.el-tabs__header) {
  margin-bottom: 10px;
}

.settings-tabs :deep(.el-tabs__item) {
  font-size: 12px;
  height: 32px;
  line-height: 32px;
  padding: 0 8px;
}

.tab-content {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 12px;
}

.preset-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.preset-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.custom-tag {
  font-size: 11px;
  color: var(--accent);
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--accent-soft);
}

.preset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.preset-grid :deep(.el-button) {
  margin-left: 0;
  width: 100%;
}

.stats {
  color: var(--muted);
  font-size: 11px;
  display: grid;
  gap: 4px;
  word-break: break-all;
}

@media (max-width: 1100px) {
  .settings-rail {
    width: min(320px, calc(100% - 320px));
  }
}
</style>
