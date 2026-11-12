<script setup lang="ts">
import { ref, computed } from "vue";
import AtmosViewer, { type ViewSnapshot } from "./components/AtmosViewer.vue";
import { loadFormats } from "./formats/types";

const formats = loadFormats();
const params = new URLSearchParams(location.search);
const embedded = params.get("embed") === "1";
// `?format=sz3` (v6.12 links used `?codec=sz3`)
const asked = params.get("format") ?? params.get("codec") ?? "";
const format = ref<string>(formats.find((f) => f.id === asked)?.id ?? formats[0]?.id ?? "current");
const viewer = ref<InstanceType<typeof AtmosViewer> | null>(null);
const hold = ref<ViewSnapshot | null>(null);
const current = computed(() => formats.find((f) => f.id === format.value) ?? formats[0]!);

function selectFormat(next: string): void {
  if (next === format.value) return;
  hold.value = viewer.value?.snapshot() ?? null;
  format.value = next;
  const url = new URL(location.href);
  url.searchParams.delete("codec");
  if (next === formats[0]?.id) url.searchParams.delete("format");
  else url.searchParams.set("format", next);
  history.replaceState(null, "", url);
}

const showPanel = computed(() => !embedded);
</script>

<template>
  <div class="shell">
    <nav v-if="!embedded && formats.length > 1" class="codec-nav">
      <button
        v-for="f in formats"
        :key="f.id"
        type="button"
        :class="{ on: format === f.id }"
        @click="selectFormat(f.id)"
      >
        {{ f.label }}
      </button>
    </nav>
    <AtmosViewer
      :key="format"
      ref="viewer"
      class="shell-view"
      :format="current"
      :initial-view="hold"
      :show-panel="showPanel"
    />
  </div>
</template>
