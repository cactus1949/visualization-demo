/**
 * 视觉偏好只留在当前浏览器。不包含要素开关、剖面位置、绘制点、探针、播放时刻和预算档。
 */

export const VISUAL_PREFS_KEY = "atmos.visualPrefs";
export const VISUAL_PREFS_VERSION = 1;

export interface VisualPrefs {
  v: typeof VISUAL_PREFS_VERSION;
  theme?: "dark" | "light";
  shadows?: boolean;
  exaggeration?: number;
  colorScaleMode?: "frame" | "display";
  particles?: {
    count?: number;
    trailLength?: number;
    speed?: number;
    lineWidth?: number;
    lifetime?: number;
    opacity?: number;
    colorMode?: "speed" | "w" | "height" | "single";
    colormap?: string;
    color?: string;
    heightMin?: number;
    heightMax?: number;
    wExaggeration?: number;
    additive?: boolean;
    taper?: boolean;
  };
  buildingOpacity?: number;
  buildingTintEnabled?: boolean;
  buildingTintStrength?: number;
  volumeOpacity?: number;
  volumeThreshold?: number;
  cutLowAlpha?: boolean;
  cutLowThreshold?: number;
  filterSlices?: boolean;
  cuts?: { x: [number, number]; y: [number, number]; z: [number, number]; faces: boolean };
  sectionStyle?: {
    colormap?: string;
    autoRange?: boolean;
    min?: number;
    max?: number;
    opacity?: number;
    lowAlpha?: boolean;
    lowThreshold?: number;
    contours?: number;
    heightM?: number;
    offsetKm?: number;
    boxHeightMinM?: number;
    boxHeightMaxM?: number;
    stepLevels?: 1 | 2 | 5;
  };
  globe?: { k?: number; basemap?: "img" | "vec" };
}

export interface PrefStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PrefRead {
  prefs: VisualPrefs | null;
  /** 没有存档时为 null。损坏、版本不对、存储不可用时给出可读原因。 */
  message: string | null;
}

const COLOR_MODES = new Set(["speed", "w", "height", "single"]);

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = finite(value[0]);
  const b = finite(value[1]);
  if (a === null || b === null) return null;
  const lo = clamp(Math.min(a, b), 0, 1);
  const hi = clamp(Math.max(a, b), 0, 1);
  return [lo, hi];
}

function colormap(value: unknown, known: readonly string[]): string | undefined {
  return typeof value === "string" && known.includes(value) ? value : undefined;
}

function hexColor(value: unknown): string | undefined {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value : undefined;
}

/** 丢掉坏字段。版本不对或 JSON 坏掉时整份不用。 */
export function parseVisualPrefs(raw: string | null, knownColormaps: readonly string[]): PrefRead {
  if (raw === null || raw.trim() === "") return { prefs: null, message: null };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { prefs: null, message: "已保存的视觉设置不是有效 JSON，已忽略" };
  }
  if (!data || typeof data !== "object" || (data as { v?: unknown }).v !== VISUAL_PREFS_VERSION) {
    return { prefs: null, message: "已保存的视觉设置版本不符，已忽略" };
  }
  const src = data as Record<string, unknown>;
  const prefs: VisualPrefs = { v: VISUAL_PREFS_VERSION };
  if (src.theme === "dark" || src.theme === "light") prefs.theme = src.theme;
  const shadows = bool(src.shadows);
  if (shadows !== undefined) prefs.shadows = shadows;
  const exaggeration = finite(src.exaggeration);
  if (exaggeration !== null) prefs.exaggeration = clamp(exaggeration, 1, 10);
  if (src.colorScaleMode === "frame" || src.colorScaleMode === "display") prefs.colorScaleMode = src.colorScaleMode;

  if (src.particles && typeof src.particles === "object") {
    const p = src.particles as Record<string, unknown>;
    const particles: NonNullable<VisualPrefs["particles"]> = {};
    const count = finite(p.count);
    if (count !== null) particles.count = clamp(Math.round(count), 4000, 262144);
    const trail = finite(p.trailLength);
    if (trail !== null) particles.trailLength = clamp(Math.round(trail), 2, 64);
    const speed = finite(p.speed);
    if (speed !== null) particles.speed = clamp(speed, 0.05, 5);
    const line = finite(p.lineWidth);
    if (line !== null) particles.lineWidth = clamp(line, 0.5, 8);
    const life = finite(p.lifetime);
    if (life !== null) particles.lifetime = clamp(life, 1, 30);
    const opacity = finite(p.opacity);
    if (opacity !== null) particles.opacity = clamp(opacity, 0.05, 1);
    if (typeof p.colorMode === "string" && COLOR_MODES.has(p.colorMode)) {
      particles.colorMode = p.colorMode as NonNullable<VisualPrefs["particles"]>["colorMode"];
    }
    const map = colormap(p.colormap, knownColormaps);
    if (map) particles.colormap = map;
    const color = hexColor(p.color);
    if (color) particles.color = color;
    const heightMin = finite(p.heightMin);
    if (heightMin !== null) particles.heightMin = clamp(heightMin, 10, 950);
    const heightMax = finite(p.heightMax);
    if (heightMax !== null) particles.heightMax = clamp(heightMax, 40, 1000);
    if (particles.heightMin !== undefined && particles.heightMax !== undefined && particles.heightMax < particles.heightMin) {
      particles.heightMax = particles.heightMin;
    }
    const wEx = finite(p.wExaggeration);
    if (wEx !== null) particles.wExaggeration = clamp(wEx, 0, 20);
    const additive = bool(p.additive);
    if (additive !== undefined) particles.additive = additive;
    const taper = bool(p.taper);
    if (taper !== undefined) particles.taper = taper;
    prefs.particles = particles;
  }

  const buildingOpacity = finite(src.buildingOpacity);
  if (buildingOpacity !== null) prefs.buildingOpacity = clamp(buildingOpacity, 0, 1);
  const tint = bool(src.buildingTintEnabled);
  if (tint !== undefined) prefs.buildingTintEnabled = tint;
  const tintStrength = finite(src.buildingTintStrength);
  if (tintStrength !== null) prefs.buildingTintStrength = clamp(tintStrength, 0, 1);
  const volumeOpacity = finite(src.volumeOpacity);
  if (volumeOpacity !== null) prefs.volumeOpacity = clamp(volumeOpacity, 0.05, 2);
  const volumeThreshold = finite(src.volumeThreshold);
  if (volumeThreshold !== null) prefs.volumeThreshold = clamp(volumeThreshold, 0, 0.95);
  const cutLow = bool(src.cutLowAlpha);
  if (cutLow !== undefined) prefs.cutLowAlpha = cutLow;
  const cutThr = finite(src.cutLowThreshold);
  if (cutThr !== null) prefs.cutLowThreshold = clamp(cutThr, 0, 0.6);
  const filterSlices = bool(src.filterSlices);
  if (filterSlices !== undefined) prefs.filterSlices = filterSlices;

  if (src.cuts && typeof src.cuts === "object") {
    const c = src.cuts as Record<string, unknown>;
    const x = pair(c.x);
    const y = pair(c.y);
    const z = pair(c.z);
    const faces = bool(c.faces);
    if (x && y && z && faces !== undefined) prefs.cuts = { x, y, z, faces };
  }

  if (src.sectionStyle && typeof src.sectionStyle === "object") {
    const s = src.sectionStyle as Record<string, unknown>;
    const style: NonNullable<VisualPrefs["sectionStyle"]> = {};
    const map = colormap(s.colormap, knownColormaps);
    if (map) style.colormap = map;
    const autoRange = bool(s.autoRange);
    if (autoRange !== undefined) style.autoRange = autoRange;
    const min = finite(s.min);
    if (min !== null) style.min = min;
    const max = finite(s.max);
    if (max !== null) style.max = max;
    const opacity = finite(s.opacity);
    if (opacity !== null) style.opacity = clamp(opacity, 0.1, 1);
    const lowAlpha = bool(s.lowAlpha);
    if (lowAlpha !== undefined) style.lowAlpha = lowAlpha;
    const lowThreshold = finite(s.lowThreshold);
    if (lowThreshold !== null) style.lowThreshold = clamp(lowThreshold, 0, 0.6);
    const contours = finite(s.contours);
    if (contours !== null) style.contours = clamp(Math.round(contours), 0, 30);
    const heightM = finite(s.heightM);
    if (heightM !== null) style.heightM = clamp(heightM, 12.5, 987.5);
    const offsetKm = finite(s.offsetKm);
    if (offsetKm !== null) style.offsetKm = clamp(offsetKm, -12, 12);
    const boxMin = finite(s.boxHeightMinM);
    if (boxMin !== null) style.boxHeightMinM = clamp(boxMin, 0, 1000);
    const boxMax = finite(s.boxHeightMaxM);
    if (boxMax !== null) style.boxHeightMaxM = clamp(boxMax, 0, 1000);
    if (s.stepLevels === 1 || s.stepLevels === 2 || s.stepLevels === 5) style.stepLevels = s.stepLevels;
    prefs.sectionStyle = style;
  }

  if (src.globe && typeof src.globe === "object") {
    const g = src.globe as Record<string, unknown>;
    const globe: NonNullable<VisualPrefs["globe"]> = {};
    const k = finite(g.k);
    if (k !== null) globe.k = clamp(k, 1, 10);
    if (g.basemap === "img" || g.basemap === "vec") globe.basemap = g.basemap;
    prefs.globe = globe;
  }

  return { prefs, message: null };
}

export function loadVisualPrefs(store: PrefStore, knownColormaps: readonly string[]): PrefRead {
  try {
    return parseVisualPrefs(store.getItem(VISUAL_PREFS_KEY), knownColormaps);
  } catch {
    return { prefs: null, message: "这台浏览器不能读取本地设置" };
  }
}

export function saveVisualPrefs(store: PrefStore, prefs: VisualPrefs): { ok: boolean; message: string } {
  try {
    store.setItem(VISUAL_PREFS_KEY, JSON.stringify(prefs));
    return { ok: true, message: "视觉设置已保存在这台浏览器" };
  } catch {
    return { ok: false, message: "这台浏览器不能保存设置" };
  }
}

export function clearVisualPrefs(store: PrefStore): { ok: boolean; message: string } {
  try {
    store.removeItem(VISUAL_PREFS_KEY);
    return { ok: true, message: "已恢复默认视觉设置" };
  } catch {
    return { ok: false, message: "这台浏览器不能清除本地设置" };
  }
}
