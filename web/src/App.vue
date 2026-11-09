<script setup lang="ts">
import AtmosViewer from "./components/AtmosViewer.vue";

const embedded = new URLSearchParams(location.search).get("embed") === "1";
</script>

<template>
  <AtmosViewer :show-panel="!embedded" />
</template>
