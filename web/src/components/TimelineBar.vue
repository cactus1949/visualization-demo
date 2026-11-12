<script setup lang="ts">
/**
 * Bottom timeline: play / pause, previous / next frame, speed, smoothing switch and a
 * clickable, draggable progress bar with one tick per time step. 2D panel control; it uses
 * the annotation colour and type tokens (docs/annotation-style.md) so it matches the
 * in-scene handles: playhead / current tick = fixed amber, hover = preview cyan,
 * not-yet-loaded ticks = disabled grey at 0.40.
 */
import { computed, ref } from "vue";
import { ANNOTATION_TOKENS as TK } from "../render/annotations/tokens";
import { RATES, clockOf, setTime, stepFrame, type TimelineState } from "../state/timeline";

const props = defineProps<{ tl: TimelineState }>();
const emit = defineEmits<{ change: [] }>();

const track = ref<HTMLDivElement>();
const hover = ref(false);
const last = computed(() => Math.max(1, props.tl.frames - 1));
const pct = (t: number) => `${(t / last.value) * 100}%`;
const clock = computed(() => clockOf(props.tl));
const tickLabels = computed(() =>
  Array.from({ length: props.tl.frames }, (_, i) => clockOf(props.tl, i).time || `+${i}h`),
);
const leadText = computed(() => {
  const t = props.tl.t;
  return `+${(Math.round(t * 100) / 100).toFixed(t % 1 === 0 ? 0 : 2)} h`;
});
const frameIndex = computed(() => Math.min(Math.floor(props.tl.t + 1e-6), props.tl.frames - 1));

const vars = computed(() => ({
  "--tl-fixed": TK.colors.fixed,
  "--tl-preview": TK.colors.preview,
  "--tl-disabled": TK.colors.disabled,
  "--tl-text": TK.colors.labelText,
  "--tl-handle": `${TK.sizes.handlePx}px`,
  "--tl-font": TK.type.fontFamily,
}));

function togglePlay(): void {
  const tl = props.tl;
  if (!tl.playing && tl.t >= tl.frames - 1 - 1e-6 && !tl.loop) tl.t = 0;
  tl.playing = !tl.playing;
  emit("change");
}
function step(dir: 1 | -1): void {
  stepFrame(props.tl, dir);
  emit("change");
}
function fromPointer(e: PointerEvent): void {
  const el = track.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)));
  let t = f * last.value;
  // Without smoothing only original time steps exist; near a tick it snaps either way.
  if (!props.tl.smooth || Math.abs(t - Math.round(t)) < 0.06) t = Math.round(t);
  setTime(props.tl, t);
  emit("change");
}
function down(e: PointerEvent): void {
  if (e.button !== 0) return;
  props.tl.playing = false;
  props.tl.scrubbing = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  fromPointer(e);
}
function move(e: PointerEvent): void {
  if (props.tl.scrubbing) fromPointer(e);
}
function up(e: PointerEvent): void {
  if (!props.tl.scrubbing) return;
  props.tl.scrubbing = false;
  (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
  emit("change");
}
function jump(i: number): void {
  props.tl.playing = false;
  setTime(props.tl, i);
  emit("change");
}
function setRate(r: number): void {
  props.tl.rate = r;
  emit("change");
}
function toggleSmooth(): void {
  props.tl.smooth = !props.tl.smooth;
  emit("change");
}
</script>

<template>
  <div class="timeline" :style="vars" @pointerdown.stop @wheel.stop>
    <div class="buttons">
      <button type="button" class="tb" title="上一帧（←）" aria-label="上一帧" @click="step(-1)">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M3 3h2v10H3zM13 3v10L6 8z" fill="currentColor" /></svg>
      </button>
      <button
        type="button"
        class="tb play"
        :class="{ on: tl.playing }"
        :title="tl.playing ? '暂停（空格）' : '播放（空格）'"
        :aria-label="tl.playing ? '暂停' : '播放'"
        @click="togglePlay"
      >
        <svg v-if="!tl.playing" viewBox="0 0 16 16" width="16" height="16"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor" /></svg>
        <svg v-else viewBox="0 0 16 16" width="16" height="16"><path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor" /></svg>
      </button>
      <button type="button" class="tb" title="下一帧（→）" aria-label="下一帧" @click="step(1)">
        <svg viewBox="0 0 16 16" width="14" height="14"><path d="M11 3h2v10h-2zM3 3v10l7-5z" fill="currentColor" /></svg>
      </button>
    </div>

    <div class="track-wrap">
      <div class="tick-labels">
        <button
          v-for="(label, i) in tickLabels"
          :key="i"
          type="button"
          class="tick-label"
          :class="{ current: i === frameIndex && Math.abs(tl.t - i) < 1e-6, pending: !tl.ready[i] }"
          :style="{ left: pct(i) }"
          :title="tl.ready[i] ? `跳到 ${label}` : `${label}（加载中）`"
          @click="jump(i)"
        >
          {{ label }}
        </button>
      </div>
      <div
        ref="track"
        class="track"
        :class="{ hover, scrubbing: tl.scrubbing }"
        @pointerdown="down"
        @pointermove="move"
        @pointerup="up"
        @pointercancel="up"
        @pointerenter="hover = true"
        @pointerleave="hover = false"
      >
        <div class="rail" />
        <div class="fill" :style="{ width: pct(tl.t) }" />
        <span
          v-for="(_, i) in tl.frames"
          :key="i"
          class="tick"
          :class="{ passed: i <= tl.t + 1e-6, pending: !tl.ready[i] }"
          :style="{ left: pct(i) }"
        />
        <span class="head" :class="{ buffering: tl.buffering }" :style="{ left: pct(tl.t) }">
          <svg v-if="tl.buffering" class="ring" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8" /></svg>
        </span>
      </div>
    </div>

    <div class="readout" title="文件中的时刻（文件未标注时区）">
      <span class="date">{{ clock.date }}</span>
      <b>{{ clock.time }}</b>
      <small>{{ leadText }}</small>
      <small v-if="tl.buffering" class="buf">缓冲中</small>
    </div>

    <div class="rates" role="group" aria-label="倍速">
      <button
        v-for="r in RATES"
        :key="r"
        type="button"
        :class="{ on: tl.rate === r }"
        :title="`1 小时数据播 ${(4 / r).toString()} 秒`"
        @click="setRate(r)"
      >
        {{ r }}×
      </button>
    </div>
    <button
      type="button"
      class="smooth"
      :class="{ on: tl.smooth }"
      title="帧间平滑：在相邻两个整点之间做 GPU 插值（风场保模长）。关闭后按整点切换。"
      @click="toggleSmooth"
    >
      平滑
    </button>
  </div>
</template>

<style scoped>
.timeline {
  position: absolute;
  z-index: 6;
  left: 50%;
  bottom: 14px;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 8px 10px;
  border-radius: 12px;
  background: rgba(8, 14, 22, 0.78);
  border: 1px solid rgba(255, 255, 255, 0.14);
  backdrop-filter: blur(10px);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
  color: var(--tl-text);
  font-family: var(--tl-font);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.buttons {
  display: flex;
  align-items: center;
  gap: 4px;
}
.tb {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: transparent;
  color: var(--tl-text);
  cursor: pointer;
  padding: 0;
}
.tb:hover {
  border-color: var(--tl-preview);
  color: var(--tl-preview);
}
.tb.play {
  width: 34px;
  height: 34px;
  border-color: var(--tl-fixed);
  color: var(--tl-fixed);
}
.tb.play.on {
  background: rgba(255, 194, 71, 0.16);
}
.track-wrap {
  position: relative;
  width: 420px;
  padding-top: 15px;
}
.tick-labels {
  position: absolute;
  left: 8px;
  right: 8px;
  top: 0;
  height: 14px;
}
.tick-label {
  position: absolute;
  transform: translateX(-50%);
  border: 0;
  background: transparent;
  padding: 0 2px;
  color: rgba(244, 251, 255, 0.62);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.tick-label:hover {
  color: var(--tl-preview);
}
.tick-label.current {
  color: var(--tl-fixed);
}
.tick-label.pending {
  color: var(--tl-disabled);
  opacity: 0.4;
}
.track {
  position: relative;
  height: 20px;
  margin: 0 8px;
  cursor: pointer;
  touch-action: none;
}
.rail,
.fill {
  position: absolute;
  top: 50%;
  height: 4px;
  margin-top: -2px;
  border-radius: 999px;
}
.rail {
  left: 0;
  right: 0;
  background: rgba(255, 255, 255, 0.16);
}
.fill {
  left: 0;
  background: var(--tl-fixed);
  opacity: 0.75;
}
.tick {
  position: absolute;
  top: 50%;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: rgba(244, 251, 255, 0.85);
  box-shadow: 0 0 0 1.5px rgba(8, 14, 22, 0.9);
}
.tick.passed {
  background: var(--tl-fixed);
}
.tick.pending {
  background: var(--tl-disabled);
  opacity: 0.4;
}
.head {
  position: absolute;
  top: 50%;
  width: var(--tl-handle);
  height: var(--tl-handle);
  margin: calc(var(--tl-handle) / -2) 0 0 calc(var(--tl-handle) / -2);
  border-radius: 50%;
  background: var(--tl-fixed);
  box-shadow:
    0 0 0 2px rgba(8, 14, 22, 0.9),
    0 0 8px rgba(255, 194, 71, 0.55);
  transition: transform 80ms ease;
  pointer-events: none;
}
.track.hover .head {
  transform: scale(1.15);
  background: var(--tl-preview);
  box-shadow:
    0 0 0 2px rgba(8, 14, 22, 0.9),
    0 0 8px rgba(92, 225, 255, 0.55);
}
.track.scrubbing .head {
  transform: scale(1.25);
  background: var(--tl-fixed);
}
.ring {
  position: absolute;
  left: -6px;
  top: -6px;
  width: 23px;
  height: 23px;
  fill: none;
  stroke: var(--tl-fixed);
  stroke-width: 1.5;
  stroke-dasharray: 12 40;
  animation: spin 0.9s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.readout {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 78px;
  gap: 1px;
}
.readout .date {
  font-size: 10px;
  color: rgba(244, 251, 255, 0.62);
}
.readout b {
  font-size: 16px;
  font-weight: 600;
  color: var(--tl-fixed);
  letter-spacing: 0.02em;
}
.readout small {
  font-size: 10px;
  color: rgba(244, 251, 255, 0.62);
}
.readout .buf {
  color: var(--tl-fixed);
}
.rates {
  display: flex;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
  overflow: hidden;
}
.rates button,
.smooth {
  border: 0;
  background: transparent;
  color: rgba(244, 251, 255, 0.75);
  font: inherit;
  font-size: 11px;
  padding: 4px 8px;
  cursor: pointer;
  white-space: nowrap;
}
.rates button + button {
  border-left: 1px solid rgba(255, 255, 255, 0.12);
}
.rates button:hover,
.smooth:hover {
  color: var(--tl-preview);
}
.rates button.on {
  background: rgba(255, 194, 71, 0.18);
  color: var(--tl-fixed);
}
.smooth {
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 999px;
}
.smooth.on {
  border-color: var(--tl-fixed);
  color: var(--tl-fixed);
  background: rgba(255, 194, 71, 0.12);
}
</style>
