<script setup lang="ts">
import { ref, computed, defineAsyncComponent } from "vue";
import AtmosViewer, { type ViewSnapshot } from "./components/AtmosViewer.vue";
import { loadFormats } from "./formats/types";

// Cesium is only downloaded when the globe view is opened.
const GlobeViewer = defineAsyncComponent(() => import("./components/GlobeViewer.vue"));

const formats = loadFormats();
const params = new URLSearchParams(location.search);
const embedded = params.get("embed") === "1";
// `?format=sz3` (v6.12 links used `?codec=sz3`). No format → SZ3.
const asked = params.get("format") ?? params.get("codec") ?? "";
const known = formats.find((f) => f.id === asked)?.id;
const format = ref<string>(known ?? formats.find((f) => f.id === "sz3")?.id ?? formats[0]?.id ?? "sz3");
// `?tab=globe` opens the Cesium globe.
const globe = ref(params.get("tab") === "globe");
const viewer = ref<InstanceType<typeof AtmosViewer> | null>(null);
const hold = ref<ViewSnapshot | null>(null);
const current = computed(() => formats.find((f) => f.id === format.value) ?? formats[0]!);

function setUrl(edit: (url: URL) => void): void {
  const url = new URL(location.href);
  edit(url);
  history.replaceState(null, "", url);
}

function writeFormatParam(url: URL, next: string): void {
  url.searchParams.delete("codec");
  url.searchParams.set("format", next);
}

// Keep the address bar aligned with the checkbox state, including a bare `/` → `?format=sz3`.
if (params.get("codec") || params.get("format") !== format.value) {
  setUrl((url) => writeFormatParam(url, format.value));
}

/** Layer-panel SZ3 checkbox. Stays on the box or the globe, whichever is open. */
function onSetFormat(next: string): void {
  if (!formats.some((f) => f.id === next) || next === format.value) return;
  if (!globe.value) hold.value = viewer.value?.snapshot() ?? null;
  format.value = next;
  setUrl((url) => {
    writeFormatParam(url, next);
    if (globe.value) url.searchParams.set("tab", "globe");
  });
}

/** Layer-panel Cesium checkbox. On → `?format=sz3&tab=globe`; off → `?format=sz3`. */
function onSetCesium(on: boolean): void {
  const sz3 = formats.find((f) => f.id === "sz3")?.id;
  if (!sz3) return;
  if (on === globe.value && format.value === sz3) return;
  if (on && !globe.value) hold.value = viewer.value?.snapshot() ?? null;
  format.value = sz3;
  globe.value = on;
  setUrl((url) => {
    writeFormatParam(url, sz3);
    if (on) url.searchParams.set("tab", "globe");
    else url.searchParams.delete("tab");
  });
}

const showPanel = computed(() => !embedded);
</script>

<template>
  <div class="shell">
    <GlobeViewer
      v-if="globe"
      class="shell-view"
      :format="current"
      @set-format="onSetFormat"
      @set-cesium="onSetCesium"
    />
    <AtmosViewer
      v-else
      :key="format"
      ref="viewer"
      class="shell-view"
      :format="current"
      :initial-view="hold"
      :show-panel="showPanel"
      @set-format="onSetFormat"
      @set-cesium="onSetCesium"
    />
  </div>
</template>
