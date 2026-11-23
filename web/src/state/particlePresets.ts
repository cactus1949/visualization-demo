/**
 * 粒子展示预设。只改密度、尾迹、线宽、速度、发光等渲染手感，不覆盖高度范围、着色方式和暂停状态。
 */

export type ParticlePresetId = "balanced" | "streamline" | "vivid" | "light";

export interface ParticlePresetValues {
  count: number;
  trailLength: number;
  speed: number;
  lineWidth: number;
  lifetime: number;
  opacity: number;
  wExaggeration: number;
  taper: boolean;
  additive: boolean;
}

export interface ParticlePreset {
  id: ParticlePresetId;
  label: string;
  values: ParticlePresetValues;
}

const PRESET_KEYS: readonly (keyof ParticlePresetValues)[] = [
  "count",
  "trailLength",
  "speed",
  "lineWidth",
  "lifetime",
  "opacity",
  "wExaggeration",
  "taper",
  "additive",
];

export const PARTICLE_PRESETS: readonly ParticlePreset[] = [
  {
    id: "balanced",
    label: "默认均衡",
    values: {
      count: 32000,
      trailLength: 48,
      speed: 1,
      lineWidth: 1.3,
      lifetime: 8,
      opacity: 0.55,
      wExaggeration: 1,
      taper: true,
      additive: false,
    },
  },
  {
    id: "streamline",
    label: "细密流线",
    values: {
      count: 64000,
      trailLength: 60,
      speed: 0.9,
      lineWidth: 1.0,
      lifetime: 10,
      opacity: 0.5,
      wExaggeration: 1,
      taper: true,
      additive: false,
    },
  },
  {
    id: "vivid",
    label: "醒目演示",
    values: {
      count: 40000,
      trailLength: 52,
      speed: 1.35,
      lineWidth: 2.2,
      lifetime: 8,
      opacity: 0.85,
      wExaggeration: 1.5,
      taper: true,
      additive: true,
    },
  },
  {
    id: "light",
    label: "轻量流畅",
    values: {
      count: 12000,
      trailLength: 28,
      speed: 1,
      lineWidth: 1.4,
      lifetime: 7,
      opacity: 0.6,
      wExaggeration: 1,
      taper: true,
      additive: false,
    },
  },
];

function equalValue(a: number | boolean, b: number | boolean): boolean {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return a === b;
}

/** 当前粒子参数完全吻合某个预设时返回其 id，否则返回 "custom"。 */
export function matchParticlePreset(params: ParticlePresetValues): ParticlePresetId | "custom" {
  for (const preset of PARTICLE_PRESETS) {
    if (PRESET_KEYS.every((k) => equalValue(params[k], preset.values[k]))) return preset.id;
  }
  return "custom";
}

/** 按预设更新粒子渲染参数，保留高度范围、着色和暂停状态。 */
export function applyParticlePreset<T extends ParticlePresetValues>(target: T, id: ParticlePresetId): void {
  const preset = PARTICLE_PRESETS.find((p) => p.id === id);
  if (!preset) return;
  Object.assign(target, preset.values);
}

/** 限制粒子高度区间在有效范围内，避免下限越过上限。 */
export function clampParticleHeightRange(minM: number, maxM: number): [number, number] {
  const lo = Math.min(950, Math.max(10, Math.round(minM / 10) * 10));
  const hi = Math.min(1000, Math.max(40, Math.round(maxM / 10) * 10));
  return lo <= hi ? [lo, hi] : [Math.min(lo, 950), Math.max(lo, 40)];
}
