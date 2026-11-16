/** Cesium imagery layers for the globe tab (see basemapChoice.ts for the rules). */
import { Credit, ImageryLayer, UrlTemplateImageryProvider, WebMercatorTilingScheme, type ImageryLayerCollection } from "cesium";
import {
  TIANDITU_MAX_LEVEL,
  TIANDITU_SUBDOMAINS,
  tiandituLayers,
  tiandituUrl,
  type BasemapSource,
  type BasemapStyle,
} from "./basemapChoice";

function tianditu(layer: string, tk: string): UrlTemplateImageryProvider {
  return new UrlTemplateImageryProvider({
    url: tiandituUrl(layer, tk),
    subdomains: TIANDITU_SUBDOMAINS,
    tilingScheme: new WebMercatorTilingScheme(),
    maximumLevel: TIANDITU_MAX_LEVEL,
    credit: new Credit("天地图 © 国家地理信息公共服务平台", true),
  });
}

/** Dev-only; `import.meta.env.DEV` is false in `vite build`, so this URL is not in the production bundle. */
function esriDev(): UrlTemplateImageryProvider | null {
  if (!import.meta.env.DEV) return null;
  return new UrlTemplateImageryProvider({
    url: "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    maximumLevel: 18,
    credit: new Credit("开发用底图：Esri, Maxar, Earthstar Geographics", true),
  });
}

/** Replace all imagery layers with the chosen source and style. */
export function applyBasemap(layers: ImageryLayerCollection, source: BasemapSource, style: BasemapStyle, tk: string): void {
  layers.removeAll();
  const esri = source === "esri-dev" ? esriDev() : null;
  if (esri) {
    layers.add(new ImageryLayer(esri));
    return;
  }
  for (const layer of tiandituLayers(style)) layers.add(new ImageryLayer(tianditu(layer, tk)));
}
