<script setup lang="ts">
import { ref, computed, defineAsyncComponent } from "vue";
import AtmosViewer, { type ViewSnapshot } from "./components/AtmosViewer.vue";
import { loadFormats } from "./formats/types";

// Cesium is only downloaded when the globe tab is opened.
const GlobeViewer = defineAsyncComponent(() => import("./components/GlobeViewer.vue"));

const formats = loadFormats();
const params = new URLSearchParams(location.search);
const embedded = params.get("embed") === "1";
// `?format=sz3` (v6.12 links used `?codec=sz3`)
const asked = params.get("format") ?? params.get("codec") ?? "";
const format = ref<string>(formats.find((f) => f.id === asked)?.id ?? formats[0]?.id ?? "current");
// `?tab=globe` opens the globe tab
const globe = ref(params.get("tab") === "globe");
const viewer = ref<InstanceType<typeof AtmosViewer> | null>(null);
const hold = ref<ViewSnapshot | null>(null);
const current = computed(() => formats.find((f) => f.id === format.value) ?? formats[0]!);

function setUrl(edit: (url: URL) => void): void {
  const url = new URL(location.href);
  edit(url);
  history.replaceState(null, "", url);
}

function selectFormat(next: string): void {
  if (next === format.value) return;
  if (!globe.value) hold.value = viewer.value?.snapshot() ?? null;
  format.value = next;
  setUrl((url) => {
    url.searchParams.delete("codec");
    if (next === formats[0]?.id) url.searchParams.delete("format");
    else url.searchParams.set("format", next);
    if (globe.value) url.searchParams.set("tab", "globe");
  });
}

function selectGlobe(): void {
  if (globe.value) return;
  hold.value = viewer.value?.snapshot() ?? null;
  globe.value = true;
  setUrl((url) => url.searchParams.set("tab", "globe"));
}

const showPanel = computed(() => !embedded);
</script>

<template>
  <div class="shell">
    <nav v-if="!embedded" class="codec-nav">
      <button
        v-for="f in formats"
        :key="f.id"
        type="button"
        :class="{ on: format === f.id }"
        @click="selectFormat(f.id)"
      >
        {{ f.label }}
      </button>
      <button type="button" :class="{ on: globe }" @click="selectGlobe">地球</button>
    </nav>
    <GlobeViewer v-if="globe" :key="current.id" class="shell-view" :format="current" />
    <AtmosViewer
      v-else
      :key="format"
      ref="viewer"
      class="shell-view"
      :format="current"
      :initial-view="hold"
      :show-panel="showPanel"
    />
  </div>
</template>
