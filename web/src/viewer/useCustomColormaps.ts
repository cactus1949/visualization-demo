/**
 * 自定义色带的响应式列表、下拉选项组装与增删改持久化。
 */
import { computed, ref } from "vue";
import type { ColormapOption } from "../components/ColormapSelect.vue";
import { COLORMAPS, COLORMAP_LABELS, registerCustomColormaps } from "../render/colormaps";
import {
  createCustomColormap,
  deleteCustomColormap,
  loadCustomColormaps,
  saveCustomColormaps,
  updateCustomColormap,
  type CustomColormap,
} from "../state/customColormaps";

export interface CustomColormapDeps {
  onSync: () => void;
  onDeleteFallback: (id: string) => void;
}

export function useCustomColormaps(deps: CustomColormapDeps) {
  const customColormaps = ref<CustomColormap[]>(
    typeof localStorage !== "undefined" ? loadCustomColormaps(localStorage) : [],
  );
  registerCustomColormaps(customColormaps.value);
  const colormapRevision = ref(0);

  const colormapOptions = computed<ColormapOption[]>(() => [
    ...COLORMAPS.map((id) => ({ id, label: COLORMAP_LABELS[id] ?? id })),
    ...customColormaps.value.map((c) => ({ id: c.id, label: c.label, custom: true })),
  ]);

  function sync(next: CustomColormap[]): void {
    customColormaps.value = next;
    if (typeof localStorage !== "undefined") saveCustomColormaps(localStorage, next);
    registerCustomColormaps(next);
    colormapRevision.value += 1;
    deps.onSync();
  }

  function onCreateColormap(payload: { label: string; stops: string[] }): void {
    const res = createCustomColormap(customColormaps.value, payload.label, payload.stops);
    if (!res) return;
    sync(res.list);
  }

  function onUpdateColormap(payload: { id: string; label: string; stops: string[] }): void {
    const next = updateCustomColormap(customColormaps.value, payload.id, payload.label, payload.stops);
    if (!next) return;
    sync(next);
  }

  function onDeleteColormap(id: string): void {
    const next = deleteCustomColormap(customColormaps.value, id);
    deps.onDeleteFallback(id);
    sync(next);
  }

  return {
    customColormaps,
    colormapRevision,
    colormapOptions,
    onCreateColormap,
    onUpdateColormap,
    onDeleteColormap,
  };
}
