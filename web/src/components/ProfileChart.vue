<script setup lang="ts">
import { computed, ref } from "vue";

export type ProbeVariableOption = { name: string; label: string };

const props = defineProps<{
  lon: number;
  lat: number;
  pinned: boolean;
  levels: number[];
  values: number[];
  label: string;
  units: string;
  signed: boolean;
  variable: string;
  variables: ProbeVariableOption[];
}>();
const emit = defineEmits<{ close: []; "update:variable": [name: string] }>();

const W = 268;
const H = 176;
const PAD = { l: 40, r: 12, t: 22, b: 28 };

function niceTicks(min: number, max: number, count: number): number[] {
  const span = Math.max(1e-9, max - min);
  const raw = span / Math.max(1, count - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const err = raw / pow;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * pow;
  const start = Math.ceil((min - 1e-9) / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(8)));
  const gap = step * 0.55;
  if (!out.length || out[0]! - min > gap) out.unshift(min);
  if (!out.length || max - out[out.length - 1]! > gap) out.push(max);
  return out;
}

function prettyUnit(units: string): string {
  const map: Record<string, string> = {
    "m s-1": "m/s",
    "m2 s-2": "m²/s²",
    "s-1": "s⁻¹",
    "deg/m": "°/m",
    "kg/kg": "kg/kg",
    Pa: "Pa",
    "mm/h": "mm/h",
    mm: "mm",
    "0-1": "",
    level: "",
    "%": "%",
  };
  return map[units] ?? units;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

function thicknesses(levels: number[]): number[] {
  return levels.map((h, i) => {
    const lo = i === 0 ? Math.max(0, h - ((levels[1] ?? h + 25) - h) / 2) : (levels[i - 1]! + h) / 2;
    const hi = i === levels.length - 1 ? h + (h - levels[i - 1]!) / 2 : (h + levels[i + 1]!) / 2;
    return Math.max(1e-6, hi - lo);
  });
}

function circularMean(values: number[], weights: number[]): number {
  let xs = 0;
  let ys = 0;
  for (let i = 0; i < values.length; i += 1) {
    const w = weights[i] ?? 1;
    const r = ((values[i] ?? 0) * Math.PI) / 180;
    xs += w * Math.sin(r);
    ys += w * Math.cos(r);
  }
  return ((Math.atan2(xs, ys) * 180) / Math.PI + 360) % 360;
}

const unitText = computed(() => prettyUnit(props.units));

const scale = computed(() => {
  const series = props.values.filter((v) => Number.isFinite(v));
  if (!series.length) return { lo: -1, hi: 1 };
  let lo = Math.min(...series);
  let hi = Math.max(...series);
  if (props.signed) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (hi - lo < 1e-6) {
    lo -= 1;
    hi += 1;
  }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
});

const yMax = computed(() => {
  const top = props.levels[props.levels.length - 1] ?? 1000;
  return Math.max(1000, Math.ceil(top / 50) * 50);
});

const xTicks = computed(() => niceTicks(scale.value.lo, scale.value.hi, 5));
const yTicks = computed(() => niceTicks(0, yMax.value, 5));

function xOf(v: number): number {
  const { lo, hi } = scale.value;
  return PAD.l + ((v - lo) / (hi - lo)) * (W - PAD.l - PAD.r);
}
function yOf(h: number): number {
  return H - PAD.b - (h / yMax.value) * (H - PAD.t - PAD.b);
}

const linePath = computed(() => {
  if (props.values.length < 2 || props.levels.length !== props.values.length) return "";
  return props.values
    .map((v, i) => `${i ? "L" : "M"}${xOf(v).toFixed(1)},${yOf(props.levels[i]!).toFixed(1)}`)
    .join("");
});

const zeroX = computed(() => {
  if (!props.signed || scale.value.lo >= 0 || scale.value.hi <= 0) return null;
  return xOf(0);
});

const extrema = computed(() => {
  const { values, levels } = props;
  if (!values.length || values.length !== levels.length) return { max: null, min: null };
  let iMax = 0;
  let iMin = 0;
  for (let i = 1; i < values.length; i += 1) {
    if (values[i]! > values[iMax]!) iMax = i;
    if (values[i]! < values[iMin]!) iMin = i;
  }
  return {
    max: { i: iMax, value: values[iMax]!, level: levels[iMax]! },
    min: { i: iMin, value: values[iMin]!, level: levels[iMin]! },
  };
});

const stats = computed(() => {
  const { values, levels } = props;
  const empty = !values.length || values.length !== levels.length;
  const near = empty ? null : { value: values[0]!, level: levels[0]! };
  const top = empty ? null : { value: values[values.length - 1]!, level: levels[levels.length - 1]! };
  let mean: number | null = null;
  if (!empty) {
    const w = thicknesses(levels);
    if (props.variable === "direction") mean = circularMean(values, w);
    else {
      let acc = 0;
      let den = 0;
      for (let i = 0; i < values.length; i += 1) {
        acc += values[i]! * w[i]!;
        den += w[i]!;
      }
      mean = acc / den;
    }
  }
  const signed = props.signed && extrema.value.max && extrema.value.min && extrema.value.max.i !== extrema.value.min.i;
  return { near, top, mean, signed, max: extrema.value.max, min: extrema.value.min };
});

// ---------------------------------------------------------------- hover tooltip
// ECharts-style: horizontal crosshair snapped to the nearest model level, a dot on
// the curve and a small dark tooltip with 高度 and the value.
const hoverIndex = ref<number | null>(null);
const svgEl = ref<SVGSVGElement | null>(null);
function onChartMove(event: PointerEvent): void {
  const svg = svgEl.value;
  const { levels, values } = props;
  if (!svg || !levels.length || levels.length !== values.length) { hoverIndex.value = null; return; }
  const rect = svg.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * W;
  const y = ((event.clientY - rect.top) / rect.height) * H;
  if (x < PAD.l - 4 || x > W - PAD.r + 4 || y < PAD.t - 6 || y > H - PAD.b + 6) { hoverIndex.value = null; return; }
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < levels.length; i += 1) {
    const d = Math.abs(yOf(levels[i]!) - y);
    if (d < bestD) { bestD = d; best = i; }
  }
  hoverIndex.value = best;
}
function onChartLeave(): void { hoverIndex.value = null; }
const hover = computed(() => {
  const i = hoverIndex.value;
  if (i === null || i >= props.values.length) return null;
  const value = props.values[i]!;
  const level = props.levels[i]!;
  if (!Number.isFinite(value)) return null;
  const cx = xOf(value);
  const cy = yOf(level);
  const text = `${fmt(value)}${unitText.value ? " " + unitText.value : ""}`;
  // Tooltip box (SVG units): flip to the left of the dot near the right edge.
  const w = Math.max(74, 18 + Math.max(text.length, 8) * 5.6);
  const h = 32;
  let bx = cx + 8;
  if (bx + w > W - 2) bx = cx - 8 - w;
  bx = Math.max(PAD.l + 2, bx);
  let by = cy - h - 6;
  if (by < 2) by = cy + 6;
  return { i, value, level, cx, cy, text, bx, by, w, h };
});

const xTitle = computed(() => (unitText.value ? `${props.label} (${unitText.value})` : props.label));
</script>

<template>
  <div class="profile">
    <div class="head">
      <b>{{ pinned ? "固定探针" : "探针" }}</b>
      <span>{{ lon.toFixed(4) }}°E {{ lat.toFixed(4) }}°N</span>
      <button v-if="pinned" class="x" type="button" title="关闭" @click="emit('close')">×</button>
    </div>
    <label class="var-row">
      变量
      <select :value="variable" @change="emit('update:variable', ($event.target as HTMLSelectElement).value)">
        <option v-for="opt in variables" :key="opt.name" :value="opt.name">{{ opt.label }}</option>
      </select>
    </label>
    <svg
      ref="svgEl"
      :width="W"
      :height="H"
      class="chart"
      aria-label="垂直廓线"
      @pointermove="onChartMove"
      @pointerleave="onChartLeave"
    >
      <text class="y-title" :x="PAD.l" :y="11" text-anchor="start">高度 (m)</text>
      <g class="grid">
        <line
          v-for="t in yTicks"
          :key="'yg' + t"
          :x1="PAD.l"
          :x2="W - PAD.r"
          :y1="yOf(t)"
          :y2="yOf(t)"
        />
        <line
          v-for="t in xTicks"
          :key="'xg' + t"
          :x1="xOf(t)"
          :x2="xOf(t)"
          :y1="PAD.t"
          :y2="H - PAD.b"
        />
      </g>
      <line
        v-if="zeroX !== null"
        class="zero"
        :x1="zeroX"
        :x2="zeroX"
        :y1="PAD.t"
        :y2="H - PAD.b"
      />
      <g class="axis">
        <line :x1="PAD.l" :y1="H - PAD.b" :x2="W - PAD.r" :y2="H - PAD.b" />
        <line :x1="PAD.l" :y1="PAD.t" :x2="PAD.l" :y2="H - PAD.b" />
        <text
          v-for="t in yTicks"
          :key="'y' + t"
          :x="PAD.l - 5"
          :y="yOf(t) + 3"
          text-anchor="end"
        >{{ t >= 100 || t === 0 ? t.toFixed(0) : fmt(t) }}</text>
        <text
          v-for="t in xTicks"
          :key="'x' + t"
          :x="xOf(t)"
          :y="H - PAD.b + 12"
          text-anchor="middle"
        >{{ fmt(t) }}</text>
      </g>
      <text class="x-title" :x="(PAD.l + W - PAD.r) / 2" :y="H - 4" text-anchor="middle">{{ xTitle }}</text>
      <path v-if="linePath" :d="linePath" class="series" />
      <g v-if="stats.max" class="peak">
        <circle :cx="xOf(stats.max.value)" :cy="yOf(stats.max.level)" r="3" />
      </g>
      <g v-if="stats.signed && stats.min" class="peak is-min">
        <circle :cx="xOf(stats.min.value)" :cy="yOf(stats.min.level)" r="3" />
      </g>
      <g v-if="hover" class="hover" pointer-events="none">
        <line class="cross" :x1="PAD.l" :x2="W - PAD.r" :y1="hover.cy" :y2="hover.cy" />
        <line class="cross-v" :x1="hover.cx" :x2="hover.cx" :y1="hover.cy" :y2="H - PAD.b" />
        <circle class="halo" :cx="hover.cx" :cy="hover.cy" r="6" />
        <circle class="dot" :cx="hover.cx" :cy="hover.cy" r="3.5" />
        <rect class="tip" :x="hover.bx" :y="hover.by" :width="hover.w" :height="hover.h" rx="5" />
        <text class="tip-k" :x="hover.bx + 7" :y="hover.by + 12">高度 {{ hover.level.toFixed(1) }} m</text>
        <circle class="tip-mark" :cx="hover.bx + 10" :cy="hover.by + 23" r="2.5" />
        <text class="tip-v" :x="hover.bx + 16" :y="hover.by + 26">{{ label }} <tspan class="tip-num">{{ hover.text }}</tspan></text>
      </g>
    </svg>
    <div class="stats">
      <div class="stat">
        <span class="k">近地面 <small v-if="stats.near">{{ stats.near.level.toFixed(1) }} m</small></span>
        <span class="v">{{ stats.near ? `${fmt(stats.near.value)} ${unitText}` : "—" }}</span>
      </div>
      <div class="stat">
        <span class="k">顶层 <small v-if="stats.top">{{ stats.top.level.toFixed(1) }} m</small></span>
        <span class="v">{{ stats.top ? `${fmt(stats.top.value)} ${unitText}` : "—" }}</span>
      </div>
      <div class="stat">
        <span class="k">{{ stats.signed ? "峰值最大" : "峰值" }} <small v-if="stats.max">@ {{ stats.max.level.toFixed(1) }} m</small></span>
        <span class="v">{{ stats.max ? `${fmt(stats.max.value)} ${unitText}` : "—" }}</span>
      </div>
      <div v-if="stats.signed" class="stat">
        <span class="k">峰值最小 <small v-if="stats.min">@ {{ stats.min.level.toFixed(1) }} m</small></span>
        <span class="v">{{ stats.min ? `${fmt(stats.min.value)} ${unitText}` : "—" }}</span>
      </div>
      <div class="stat">
        <span class="k">整柱平均</span>
        <span class="v">{{ stats.mean !== null ? `${fmt(stats.mean)} ${unitText}` : "—" }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile {
  width: 288px;
  padding: 10px 10px 8px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid var(--line);
  backdrop-filter: blur(12px);
  font-size: 11px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.head span {
  color: var(--muted);
}
.x {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.var-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--muted);
}
.var-row select {
  flex: 1;
  min-width: 0;
  max-width: 210px;
  background: rgba(8, 14, 22, 0.7);
  color: var(--text);
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 2px 6px;
  font: inherit;
}
.chart .grid line {
  stroke: rgba(255, 255, 255, 0.08);
  stroke-width: 1;
}
.chart .axis line {
  stroke: rgba(255, 255, 255, 0.28);
}
.chart .zero {
  stroke: rgba(255, 194, 71, 0.55);
  stroke-width: 1;
  stroke-dasharray: 3 3;
}
.chart text {
  fill: #9ab2bf;
  font-size: 9px;
}
.chart .y-title,
.chart .x-title {
  fill: #9ab2bf;
  font-size: 10px;
}
.series {
  fill: none;
  stroke: #5ce1ff;
  stroke-width: 2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.chart { cursor: crosshair; }
.hover .cross {
  stroke: rgba(92, 225, 255, 0.55);
  stroke-width: 1;
  stroke-dasharray: 4 3;
}
.hover .cross-v {
  stroke: rgba(92, 225, 255, 0.22);
  stroke-width: 1;
  stroke-dasharray: 2 3;
}
.hover .halo { fill: rgba(92, 225, 255, 0.22); }
.hover .dot { fill: #5ce1ff; stroke: #08141c; stroke-width: 1.5; }
.hover .tip {
  fill: rgba(8, 16, 24, 0.92);
  stroke: rgba(92, 225, 255, 0.45);
  stroke-width: 1;
  filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.45));
}
.chart .hover .tip-k { fill: #9ab2bf; font-size: 9px; }
.chart .hover .tip-v { fill: #cfe7f0; font-size: 9.5px; }
.chart .hover .tip-num { fill: #ffffff; font-weight: 600; }
.hover .tip-mark { fill: #5ce1ff; }
.peak circle {
  fill: #ffc247;
  stroke: #08141c;
  stroke-width: 1;
}
.peak.is-min circle {
  fill: #5ce1ff;
}
.stats {
  display: flex;
  flex-direction: column;
  gap: 3px;
  margin-top: 6px;
}
.stat {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  padding: 3px 6px;
  border-radius: 6px;
  background: rgba(8, 14, 22, 0.45);
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.stat .k {
  color: var(--muted);
}
.stat .k small {
  margin-left: 4px;
}
.stat .v {
  color: var(--text);
  white-space: nowrap;
}
</style>
