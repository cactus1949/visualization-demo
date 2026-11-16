/**
 * Which imagery the globe tab shows. Pure (no Cesium) so the production rule is testable:
 * production always uses Tianditu; the Esri World Imagery fallback exists only in `vite dev`
 * and only when explicitly asked for (VITE_DEV_BASEMAP=esri or ?devBasemap=esri), because the
 * box's egress IP is blocked by Tianditu (HTTP 418) and screenshots still need a basemap.
 */
export type BasemapStyle = "img" | "vec";
export type BasemapSource = "tianditu" | "esri-dev";

export interface BasemapEnv {
  dev: boolean;
  devFlag?: string;
  query?: string | null;
}

export function pickBasemapSource(env: BasemapEnv): BasemapSource {
  if (!env.dev) return "tianditu";
  return env.devFlag === "esri" || env.query === "esri" ? "esri-dev" : "tianditu";
}

export const TIANDITU_SUBDOMAINS = "01234567";
export const TIANDITU_MAX_LEVEL = 18;

/** Tianditu Web-Mercator layers: the base map and the annotation layer drawn on top of it. */
export function tiandituLayers(style: BasemapStyle): [string, string] {
  return style === "img" ? ["img", "cia"] : ["vec", "cva"];
}

export function tiandituUrl(layer: string, tk: string): string {
  return `https://t{s}.tianditu.gov.cn/DataServer?T=${layer}_w&x={x}&y={y}&l={z}&tk=${encodeURIComponent(tk)}`;
}
