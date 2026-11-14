/**
 * Debug-only sky / atmosphere overrides for the 地球 tab (window.__globeApi.sky).
 *
 * Purpose: bisect "dark theme, top view, basemap black" on a real GPU (ANGLE Metal) by turning
 * the dark-theme sky pieces off one by one from the Console. The app rewrites some of these every
 * frame (applyNadirAtmosphere) or on theme change (applySky), so an override is "sticky": the
 * viewer re-applies the table on postUpdate and again on preRender, after the app's own listeners,
 * right before Cesium draws. A key that is not in the table is left to the app.
 *
 * Pure logic, no Cesium import: the viewer passes a SkyTarget that reads / writes the scene.
 */
export const SKY_KEYS = [
  "skyAtmosphere", // scene.skyAtmosphere.show
  "groundAtmosphere", // scene.globe.showGroundAtmosphere
  "skyBox", // scene.skyBox.show
  "moon", // scene.moon.show
  "backgroundColor", // scene.backgroundColor (CSS colour string)
  "dynamicAtmosphereLighting", // scene.globe.dynamicAtmosphereLighting
  "dynamicAtmosphereLightingFromSun", // scene.globe.dynamicAtmosphereLightingFromSun
] as const;

export type SkyKey = (typeof SKY_KEYS)[number];
export type SkyValue = boolean | string;
export type SkyOverrides = Partial<Record<SkyKey, SkyValue>>;

/** Read / write one scene property. read() is undefined when the scene has no such object (e.g. no skyBox). */
export interface SkyTarget {
  read(key: SkyKey): SkyValue | undefined;
  write(key: SkyKey, value: SkyValue): void;
}

const ALIASES: Record<string, SkyKey> = {
  showGroundAtmosphere: "groundAtmosphere",
  "globe.showGroundAtmosphere": "groundAtmosphere",
  "skyAtmosphere.show": "skyAtmosphere",
  "skyBox.show": "skyBox",
  "moon.show": "moon",
  background: "backgroundColor",
  "globe.dynamicAtmosphereLighting": "dynamicAtmosphereLighting",
  "globe.dynamicAtmosphereLightingFromSun": "dynamicAtmosphereLightingFromSun",
};

export function skyKey(name: string): SkyKey {
  if ((SKY_KEYS as readonly string[]).includes(name)) return name as SkyKey;
  const k = ALIASES[name];
  if (k) return k;
  throw new Error(`unknown sky key "${name}", expected one of ${SKY_KEYS.join(", ")}`);
}

/**
 * Normalise a Console value. null / undefined clears the override. Booleans accept true/false,
 * 1/0, "on"/"off", "true"/"false", "show"/"hide". backgroundColor accepts any CSS colour that
 * isColor() accepts (the viewer passes Cesium's parser).
 */
export function normalizeSkyValue(key: SkyKey, value: unknown, isColor: (css: string) => boolean): SkyValue | null {
  if (value === null || value === undefined) return null;
  if (key === "backgroundColor") {
    if (typeof value !== "string" || !isColor(value.trim())) throw new Error(`backgroundColor needs a CSS colour string, got ${JSON.stringify(value)}`);
    return value.trim();
  }
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const s = value.trim().toLowerCase();
    if (s === "true" || s === "on" || s === "show" || s === "1") return true;
    if (s === "false" || s === "off" || s === "hide" || s === "0") return false;
  }
  throw new Error(`${key} needs true / false, got ${JSON.stringify(value)}`);
}

export class SkyDebugState {
  /** Keys the app should not decide right now. */
  readonly overrides: SkyOverrides = {};
  /** Value the scene had before the first override of each key, put back on clear / reset. */
  readonly saved: SkyOverrides = {};
  /** How many frames the table was applied (each postUpdate and each preRender counts once). */
  applied = 0;

  set(key: SkyKey, value: SkyValue | null, target: SkyTarget): void {
    if (value === null) {
      this.clear(key, target);
      return;
    }
    if (!(key in this.overrides)) {
      const before = target.read(key);
      if (before !== undefined) this.saved[key] = before;
    }
    this.overrides[key] = value;
    target.write(key, value);
  }

  clear(key: SkyKey, target: SkyTarget): void {
    if (!(key in this.overrides)) return;
    delete this.overrides[key];
    const before = this.saved[key];
    delete this.saved[key];
    if (before !== undefined) target.write(key, before);
  }

  /** Drop every override and put the saved values back; the caller then lets the app logic run again. */
  reset(target: SkyTarget): SkyKey[] {
    const keys = Object.keys(this.overrides) as SkyKey[];
    for (const k of keys) this.clear(k, target);
    return keys;
  }

  /** Re-apply the table (called after the app's per-frame logic, before drawing). */
  apply(target: SkyTarget): void {
    for (const k of Object.keys(this.overrides) as SkyKey[]) target.write(k, this.overrides[k]!);
    this.applied++;
  }

  read(target: SkyTarget): Record<SkyKey, SkyValue | null> {
    const out = {} as Record<SkyKey, SkyValue | null>;
    for (const k of SKY_KEYS) out[k] = target.read(k) ?? null;
    return out;
  }
}
