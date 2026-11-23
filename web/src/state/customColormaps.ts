/**
 * 自定义色带存储与增删改查。只保留在当前浏览器 localStorage。
 */
import type { PrefStore } from "./visualPrefs.ts";

export const CUSTOM_COLORMAPS_KEY = "atmos.customColormaps";
export const CUSTOM_COLORMAPS_VERSION = 1;

export interface CustomColormap {
  id: string;
  label: string;
  /** 至少 2 个 #rrggbb 颜色节点，从低值到高值均匀分布。 */
  stops: string[];
}

export function normalizeHexColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  return match ? `#${match[1]!.toLowerCase()}` : null;
}

export function sanitizeStops(stops: unknown): string[] | null {
  if (!Array.isArray(stops)) return null;
  const clean: string[] = [];
  for (const item of stops) {
    const hex = normalizeHexColor(item);
    if (hex) clean.push(hex);
  }
  return clean.length >= 2 ? clean : null;
}

export function stopsToHexString(stops: readonly string[]): string {
  return stops.map((s) => s.replace(/^#/, "").toLowerCase()).join("");
}

export function parseCustomColormaps(raw: string | null): CustomColormap[] {
  if (!raw || !raw.trim()) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!data || typeof data !== "object" || (data as { v?: unknown }).v !== CUSTOM_COLORMAPS_VERSION) {
    return [];
  }
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: CustomColormap[] = [];
  for (const entry of items) {
    if (!entry || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    const id = typeof rec.id === "string" ? rec.id.trim() : "";
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    const stops = sanitizeStops(rec.stops);
    if (!id || !label || !stops || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label, stops });
  }
  return out;
}

export function loadCustomColormaps(store: PrefStore): CustomColormap[] {
  try {
    return parseCustomColormaps(store.getItem(CUSTOM_COLORMAPS_KEY));
  } catch {
    return [];
  }
}

export function saveCustomColormaps(store: PrefStore, items: readonly CustomColormap[]): boolean {
  try {
    store.setItem(
      CUSTOM_COLORMAPS_KEY,
      JSON.stringify({ v: CUSTOM_COLORMAPS_VERSION, items }),
    );
    return true;
  } catch {
    return false;
  }
}

export function createCustomColormap(
  existing: readonly CustomColormap[],
  label: string,
  stops: readonly string[],
  now = Date.now(),
): { list: CustomColormap[]; created: CustomColormap } | null {
  const cleanLabel = label.trim();
  const cleanStops = sanitizeStops(stops);
  if (!cleanLabel || !cleanStops) return null;
  const used = new Set(existing.map((c) => c.id));
  let id = `custom_${now.toString(36)}`;
  let suffix = 1;
  while (used.has(id)) {
    id = `custom_${now.toString(36)}_${suffix}`;
    suffix += 1;
  }
  const created: CustomColormap = { id, label: cleanLabel, stops: cleanStops };
  return { list: [...existing, created], created };
}

export function updateCustomColormap(
  existing: readonly CustomColormap[],
  id: string,
  label: string,
  stops: readonly string[],
): CustomColormap[] | null {
  const cleanLabel = label.trim();
  const cleanStops = sanitizeStops(stops);
  if (!cleanLabel || !cleanStops) return null;
  if (!existing.some((c) => c.id === id)) return null;
  return existing.map((c) => (c.id === id ? { ...c, label: cleanLabel, stops: cleanStops } : c));
}

export function deleteCustomColormap(existing: readonly CustomColormap[], id: string): CustomColormap[] {
  return existing.filter((c) => c.id !== id);
}
