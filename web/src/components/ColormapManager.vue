<script setup lang="ts">
/**
 * 设置面板内的色带管理模块：浏览内置色带（可一键复制为自定义），并对自定义色带进行增删改。
 */
import { computed, reactive, ref } from "vue";
import { Copy, Pencil, Plus, Trash2, X } from "@lucide/vue";
import {
  COLORMAPS,
  COLORMAP_LABELS,
  colormapCss,
  colormapStopsCss,
  sampleColormapStops,
} from "../render/colormaps";
import type { CustomColormap } from "../state/customColormaps";

const props = defineProps<{
  customColormaps: readonly CustomColormap[];
}>();

const emit = defineEmits<{
  create: [payload: { label: string; stops: string[] }];
  update: [payload: { id: string; label: string; stops: string[] }];
  delete: [id: string];
}>();

const editing = ref(false);
const editingId = ref<string | null>(null);
const draft = reactive({
  label: "",
  stops: ["#1d4e89", "#6dd3ee", "#ffc65a"] as string[],
});
const errorMsg = ref<string | null>(null);

const previewGradient = computed(() => colormapStopsCss(draft.stops));

function startCreate(seedLabel = "", seedStops: string[] = ["#1d4e89", "#45b6de", "#fff3b0", "#e63946"]): void {
  editing.value = true;
  editingId.value = null;
  draft.label = seedLabel;
  draft.stops = [...seedStops];
  errorMsg.value = null;
}

function startEdit(item: CustomColormap): void {
  editing.value = true;
  editingId.value = item.id;
  draft.label = item.label;
  draft.stops = [...item.stops];
  errorMsg.value = null;
}

function duplicateBuiltin(id: string): void {
  const baseName = COLORMAP_LABELS[id] ?? id;
  startCreate(`${baseName} 副本`, sampleColormapStops(id, 5));
}

function cancelEdit(): void {
  editing.value = false;
  editingId.value = null;
  errorMsg.value = null;
}

function addStop(): void {
  if (draft.stops.length >= 8) return;
  draft.stops.push(draft.stops[draft.stops.length - 1] ?? "#ffffff");
}

function removeStop(index: number): void {
  if (draft.stops.length <= 2) return;
  draft.stops.splice(index, 1);
}

function saveDraft(): void {
  const label = draft.label.trim();
  if (!label) {
    errorMsg.value = "请输入色带名称";
    return;
  }
  if (draft.stops.length < 2) {
    errorMsg.value = "至少保留 2 个颜色节点";
    return;
  }
  const stops = [...draft.stops];
  if (editingId.value) emit("update", { id: editingId.value, label, stops });
  else emit("create", { label, stops });
  cancelEdit();
}
</script>

<template>
  <div class="cmap-manager">
    <div class="mgr-head">
      <span class="mgr-hint">自定义色带保存在本地浏览器，粒子与剖面通用。</span>
      <el-button v-if="!editing" type="primary" size="small" @click="startCreate()">
        <Plus :size="13" class="btn-ico" />新建
      </el-button>
    </div>

    <div v-if="editing" class="editor-card">
      <div class="editor-title">
        <span>{{ editingId ? "编辑色带" : "新建色带" }}</span>
        <button type="button" class="mini-btn" aria-label="取消" @click="cancelEdit">
          <X :size="14" />
        </button>
      </div>
      <el-input v-model="draft.label" size="small" placeholder="色带名称，如：暖风强对比" maxlength="24" />
      <div class="preview-bar" :style="{ background: previewGradient }" />
      <div class="stops-wrap">
        <div v-for="(_, i) in draft.stops" :key="i" class="stop-chip">
          <el-color-picker v-model="draft.stops[i]" size="small" />
          <button
            v-if="draft.stops.length > 2"
            type="button"
            class="stop-del"
            title="删除节点"
            @click="removeStop(i)"
          >
            <X :size="11" />
          </button>
        </div>
        <el-button v-if="draft.stops.length < 8" size="small" plain @click="addStop">
          <Plus :size="12" />色标
        </el-button>
      </div>
      <p v-if="errorMsg" class="editor-err">{{ errorMsg }}</p>
      <div class="editor-actions">
        <el-button type="primary" size="small" @click="saveDraft">保存色带</el-button>
        <el-button size="small" @click="cancelEdit">取消</el-button>
      </div>
    </div>

    <div class="section-label">自定义色带（{{ customColormaps.length }}）</div>
    <div v-if="customColormaps.length === 0" class="empty-tip">暂无自定义色带，可点右上「新建」或复制下方内置色带。</div>
    <div v-else class="cmap-list">
      <div v-for="item in customColormaps" :key="item.id" class="cmap-row">
        <div class="row-top">
          <span class="row-name">{{ item.label }}</span>
          <span class="row-actions">
            <button type="button" class="mini-btn" title="编辑" @click="startEdit(item)">
              <Pencil :size="13" />
            </button>
            <button type="button" class="mini-btn danger" title="删除" @click="emit('delete', item.id)">
              <Trash2 :size="13" />
            </button>
          </span>
        </div>
        <div class="row-bar" :style="{ background: colormapStopsCss(item.stops) }" />
      </div>
    </div>

    <div class="section-label">内置色带</div>
    <div class="cmap-list">
      <div v-for="id in COLORMAPS" :key="id" class="cmap-row">
        <div class="row-top">
          <span class="row-name">{{ COLORMAP_LABELS[id] ?? id }}</span>
          <button type="button" class="mini-btn" title="复制为自定义色带" @click="duplicateBuiltin(id)">
            <Copy :size="13" />
          </button>
        </div>
        <div class="row-bar" :style="{ background: colormapCss(id) }" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.cmap-manager {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mgr-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.mgr-hint {
  font-size: 11px;
  color: var(--muted);
  line-height: 1.35;
}

.btn-ico {
  margin-right: 3px;
}

.editor-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 10px;
  background: var(--surface);
  border: 1px solid var(--accent);
}

.editor-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  font-weight: 600;
}

.preview-bar,
.row-bar {
  width: 100%;
  height: 12px;
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.14);
}

.row-bar {
  height: 8px;
}

.stops-wrap {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.stop-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
}

.stop-del {
  position: absolute;
  top: -5px;
  right: -5px;
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  padding: 0;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--panel);
  color: var(--text);
  cursor: pointer;
}

.stop-del:hover {
  border-color: #f56c6c;
  color: #f56c6c;
}

.editor-err {
  margin: 0;
  font-size: 11px;
  color: #f56c6c;
}

.editor-actions {
  display: flex;
  gap: 6px;
}

.editor-actions :deep(.el-button) {
  flex: 1;
  margin-left: 0;
}

.section-label {
  margin-top: 2px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted);
}

.empty-tip {
  font-size: 11px;
  color: var(--muted);
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px dashed var(--line);
}

.cmap-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cmap-row {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--surface);
  border: 1px solid var(--line);
}

.row-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}

.row-name {
  font-size: 12px;
  color: var(--text);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-actions {
  display: inline-flex;
  gap: 2px;
}

.mini-btn {
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
}

.mini-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: var(--accent);
}

.mini-btn.danger:hover {
  color: #f56c6c;
}
</style>
