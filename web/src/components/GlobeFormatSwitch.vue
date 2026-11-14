<script setup lang="ts">
/**
 * In-globe encoding switch. Removable: delete this file and the
 * <GlobeFormatSwitch> block in GlobeViewer.vue (the @switch-format
 * wiring in App.vue can stay unused). Top-nav 「当前编码 / SZ3」
 * buttons go back to the box tabs and are not this control.
 */
import { loadFormats } from "../formats/types";

defineProps<{ modelValue: string }>();
const emit = defineEmits<{ "update:modelValue": [id: string] }>();
const formats = loadFormats();
</script>

<template>
  <div class="row globe-format">
    <span>编码</span>
    <button
      v-for="f in formats"
      :key="f.id"
      type="button"
      :class="{ on: modelValue === f.id }"
      @click="emit('update:modelValue', f.id)"
    >
      {{ f.label }}
    </button>
  </div>
</template>
