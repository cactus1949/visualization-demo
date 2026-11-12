<script setup lang="ts">
import { ref, computed } from "vue";
import AtmosViewer, { type ViewSnapshot } from "./components/AtmosViewer.vue";

const params = new URLSearchParams(location.search);
const embedded = params.get("embed") === "1";
const codec = ref<"current" | "sz3">(params.get("codec") === "sz3" ? "sz3" : "current");
const viewer = ref<InstanceType<typeof AtmosViewer> | null>(null);
const hold = ref<ViewSnapshot | null>(null);

function selectCodec(next: "current" | "sz3"): void {
  if (next === codec.value) return;
  hold.value = viewer.value?.snapshot() ?? null;
  codec.value = next;
  const url = new URL(location.href);
  if (next === "sz3") url.searchParams.set("codec", "sz3");
  else url.searchParams.delete("codec");
  history.replaceState(null, "", url);
}

const showPanel = computed(() => !embedded);
</script>

<template>
  <div class="shell">
    <nav v-if="!embedded" class="codec-nav">
      <button type="button" :class="{ on: codec === 'current' }" @click="selectCodec('current')">当前编码</button>
      <button type="button" :class="{ on: codec === 'sz3' }" @click="selectCodec('sz3')">SZ3</button>
    </nav>
    <AtmosViewer
      :key="codec"
      ref="viewer"
      class="shell-view"
      :codec="codec"
      :initial-view="hold"
      :show-panel="showPanel"
    />
  </div>
</template>
