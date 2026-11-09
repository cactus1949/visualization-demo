<script setup lang="ts">
import { computed } from "vue";

/** Vertical profile at the probe: selected variable (line) + horizontal wind speed (dashed). */
const props = defineProps<{
  lon: number;
  lat: number;
  pinned: boolean;
  levels: number[];
  values: number[];
  speed: number[];
  direction: number[];
  label: string;
  units: string;
  showVariable: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const W = 248;
const H = 150;
const PAD = { l: 34, r: 10, t: 8, b: 20 };
const TABLE_LEVELS = [12.5, 62.5, 112.5, 187.5, 262.5, 362.5, 562.5, 787.5, 987.5];

function scale(series: number[]) {
  let lo = Math.min(...series);
  let hi = Math.max(...series);
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}

function path(series: number[]): string {
  if (!series.length) return "";
  const { lo, hi } = scale(series);
  const top = props.levels[props.levels.length - 1] + 12.5;
  return series
    .map((v, i) => {
      const x = PAD.l + ((v - lo) / (hi - lo)) * (W - PAD.l - PAD.r);
      const y = H - PAD.b - (props.levels[i] / top) * (H - PAD.t - PAD.b);
      return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join("");
}

const variablePath = computed(() => (props.showVariable ? path(props.values) : ""));
const speedPath = computed(() => path(props.speed));
const speedScale = computed(() => scale(props.speed));
const variableScale = computed(() => scale(props.values));
const rows = computed(() =>
  TABLE_LEVELS.map((level) => {
    const i = props.levels.findIndex((l) => Math.abs(l - level) < 1);
    return {
      level,
      speed: props.speed[i],
      dir: props.direction[i],
      value: props.values[i],
    };
  }).filter((r) => r.speed !== undefined),
);
const fmt = (v: number) =>
  Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2);
</script>

<template>
  <div class="profile">
    <div class="head">
      <b>{{ pinned ? "📍 固定探针" : "探针" }}</b>
      <span>{{ lon.toFixed(4) }}°E {{ lat.toFixed(4) }}°N</span>
      <button v-if="pinned" class="x" @click="emit('close')">×</button>
    </div>
    <svg :width="W" :height="H" class="chart">
      <g class="axis">
        <line :x1="PAD.l" :y1="H - PAD.b" :x2="W - PAD.r" :y2="H - PAD.b" />
        <line :x1="PAD.l" :y1="PAD.t" :x2="PAD.l" :y2="H - PAD.b" />
        <text
          v-for="h in [0, 250, 500, 750, 1000]"
          :key="h"
          :x="PAD.l - 4"
          :y="H - PAD.b - (h / 1000) * (H - PAD.t - PAD.b) + 3"
          text-anchor="end"
        >
          {{ h }}
        </text>
        <text :x="W - PAD.r" :y="H - 6" text-anchor="end" class="speed-label">
          风速 {{ speedScale.lo.toFixed(1) }}–{{ speedScale.hi.toFixed(1) }} m/s
        </text>
        <text v-if="showVariable" :x="PAD.l + 2" :y="H - 6" class="var-label">
          {{ label }} {{ fmt(variableScale.lo) }}–{{ fmt(variableScale.hi) }}
        </text>
      </g>
      <path :d="speedPath" class="speed" />
      <path v-if="showVariable" :d="variablePath" class="variable" />
    </svg>
    <table>
      <thead>
        <tr>
          <th>高度 m</th>
          <th>风速 m/s</th>
          <th>风向 °</th>
          <th v-if="showVariable">{{ label }} {{ units }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.level">
          <td>{{ r.level }}</td>
          <td>{{ r.speed.toFixed(2) }}</td>
          <td>{{ r.dir.toFixed(0) }}</td>
          <td v-if="showVariable">{{ fmt(r.value) }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.profile {
  width: 268px;
  padding: 10px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid var(--line);
  backdrop-filter: blur(12px);
  font-size: 11px;
  color: var(--text);
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.head span {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.x {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
}
.chart .axis line {
  stroke: var(--line);
}
.chart text {
  fill: var(--muted);
  font-size: 9px;
}
.chart .speed-label {
  fill: #7fdcff;
}
.chart .var-label {
  fill: #ffc36b;
}
.speed {
  fill: none;
  stroke: #7fdcff;
  stroke-width: 1.6;
  stroke-dasharray: 4 3;
}
.variable {
  fill: none;
  stroke: #ffc36b;
  stroke-width: 2;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
th {
  font-weight: 500;
  color: var(--muted);
  text-align: right;
  padding: 2px 3px;
}
td {
  text-align: right;
  padding: 1px 3px;
  border-top: 1px solid var(--line);
}
</style>
