/**
 * 视觉偏好（localStorage）的收集、应用、保存与恢复默认。
 */
import { ref, type Ref } from "vue";
import { allColormapIds } from "../render/colormaps";
import { DEFAULT_CUTS, type CutState } from "../render/cuts";
import { DEFAULT_PARTICLES, type ParticleParams } from "../render/particles";
import type { Theme } from "../render/scene";
import { colorScaleModeOf, type ColorScaleMode } from "../state/colorScale";
import {
  clearVisualPrefs,
  loadVisualPrefs,
  saveVisualPrefs,
  type VisualPrefs,
} from "../state/visualPrefs";

export interface VisualPrefsDeps {
  globeMode: boolean;
  queryColorscale: string | null;
  view: { exaggeration: number; theme: Theme; shadows: boolean };
  colorScaleMode: Ref<ColorScaleMode>;
  particleParams: ParticleParams;
  layers: {
    buildingOpacity: number;
    buildingTintEnabled: boolean;
    buildingTintStrength: number;
    volumeOpacity: number;
    volumeThreshold: number;
    cutLowAlpha: boolean;
    cutLowThreshold: number;
    filterSlices: boolean;
  };
  cuts: CutState;
  section: {
    colormap: string;
    autoRange: boolean;
    min: number;
    max: number;
    opacity: number;
    lowAlpha: boolean;
    lowThreshold: number;
    contours: number;
    offsetKm: number;
    box: { heightMinM: number; heightMaxM: number; stepLevels: number };
  };
  slice: { heightM: number };
  chromeK: Ref<number>;
  globeBasemap: Ref<"img" | "vec">;
  setGlobeK: (k: number) => void;
  setGlobeBasemap: (style: "img" | "vec") => void;
}

export function useVisualPrefs(deps: VisualPrefsDeps) {
  const prefsMessage = ref<string | null>(null);

  function collectVisualPrefs(): VisualPrefs {
    const { view, colorScaleMode, particleParams, layers, cuts, section, slice, chromeK, globeBasemap } = deps;
    return {
      v: 1,
      theme: view.theme,
      shadows: view.shadows,
      exaggeration: view.exaggeration,
      colorScaleMode: colorScaleMode.value,
      particles: {
        count: particleParams.count,
        trailLength: particleParams.trailLength,
        speed: particleParams.speed,
        lineWidth: particleParams.lineWidth,
        lifetime: particleParams.lifetime,
        opacity: particleParams.opacity,
        colorMode: particleParams.colorMode,
        colormap: particleParams.colormap,
        color: particleParams.color,
        heightMin: particleParams.heightMin,
        heightMax: particleParams.heightMax,
        wExaggeration: particleParams.wExaggeration,
        additive: particleParams.additive,
        taper: particleParams.taper,
      },
      buildingOpacity: layers.buildingOpacity,
      buildingTintEnabled: layers.buildingTintEnabled,
      buildingTintStrength: layers.buildingTintStrength,
      volumeOpacity: layers.volumeOpacity,
      volumeThreshold: layers.volumeThreshold,
      cutLowAlpha: layers.cutLowAlpha,
      cutLowThreshold: layers.cutLowThreshold,
      filterSlices: layers.filterSlices,
      cuts: {
        x: [...cuts.x] as [number, number],
        y: [...cuts.y] as [number, number],
        z: [...cuts.z] as [number, number],
        faces: cuts.faces,
      },
      sectionStyle: {
        colormap: section.colormap,
        autoRange: section.autoRange,
        min: section.min,
        max: section.max,
        opacity: section.opacity,
        lowAlpha: section.lowAlpha,
        lowThreshold: section.lowThreshold,
        contours: section.contours,
        heightM: slice.heightM,
        offsetKm: section.offsetKm,
        boxHeightMinM: section.box.heightMinM,
        boxHeightMaxM: section.box.heightMaxM,
        stepLevels: section.box.stepLevels === 2 || section.box.stepLevels === 5 ? section.box.stepLevels : 1,
      },
      globe: { k: chromeK.value, basemap: globeBasemap.value },
    };
  }

  function applyVisualPrefs(prefs: VisualPrefs): void {
    const { view, colorScaleMode, particleParams, layers, cuts, section, slice } = deps;
    if (prefs.theme) view.theme = prefs.theme;
    if (prefs.shadows !== undefined) view.shadows = prefs.shadows;
    if (prefs.exaggeration !== undefined) view.exaggeration = prefs.exaggeration;
    if (prefs.colorScaleMode) colorScaleMode.value = prefs.colorScaleMode;
    if (prefs.particles) Object.assign(particleParams, prefs.particles);
    if (prefs.buildingOpacity !== undefined) layers.buildingOpacity = prefs.buildingOpacity;
    if (prefs.buildingTintEnabled !== undefined) layers.buildingTintEnabled = prefs.buildingTintEnabled;
    if (prefs.buildingTintStrength !== undefined) layers.buildingTintStrength = prefs.buildingTintStrength;
    if (prefs.volumeOpacity !== undefined) layers.volumeOpacity = prefs.volumeOpacity;
    if (prefs.volumeThreshold !== undefined) layers.volumeThreshold = prefs.volumeThreshold;
    if (prefs.cutLowAlpha !== undefined) layers.cutLowAlpha = prefs.cutLowAlpha;
    if (prefs.cutLowThreshold !== undefined) layers.cutLowThreshold = prefs.cutLowThreshold;
    if (prefs.filterSlices !== undefined) layers.filterSlices = prefs.filterSlices;
    if (prefs.cuts) {
      cuts.x = [...prefs.cuts.x];
      cuts.y = [...prefs.cuts.y];
      cuts.z = [...prefs.cuts.z];
      cuts.faces = prefs.cuts.faces;
    }
    const style = prefs.sectionStyle;
    if (style) {
      if (style.colormap) section.colormap = style.colormap;
      if (style.autoRange !== undefined) section.autoRange = style.autoRange;
      if (style.min !== undefined) section.min = style.min;
      if (style.max !== undefined) section.max = style.max;
      if (style.opacity !== undefined) section.opacity = style.opacity;
      if (style.lowAlpha !== undefined) section.lowAlpha = style.lowAlpha;
      if (style.lowThreshold !== undefined) section.lowThreshold = style.lowThreshold;
      if (style.contours !== undefined) section.contours = style.contours;
      if (style.heightM !== undefined) slice.heightM = style.heightM;
      if (style.offsetKm !== undefined) section.offsetKm = style.offsetKm;
      if (style.boxHeightMinM !== undefined) section.box.heightMinM = style.boxHeightMinM;
      if (style.boxHeightMaxM !== undefined) section.box.heightMaxM = style.boxHeightMaxM;
      if (style.stepLevels) section.box.stepLevels = style.stepLevels;
    }
    if (prefs.globe?.k !== undefined) deps.setGlobeK(prefs.globe.k);
    if (prefs.globe?.basemap) deps.setGlobeBasemap(prefs.globe.basemap);
  }

  function readSavedVisualPrefs(): void {
    const read = loadVisualPrefs(localStorage, allColormapIds());
    prefsMessage.value = read.message;
    if (read.prefs) applyVisualPrefs(read.prefs);
  }

  function saveVisualSettings(): void {
    const result = saveVisualPrefs(localStorage, collectVisualPrefs());
    prefsMessage.value = result.message;
  }

  function restoreVisualDefaults(): void {
    const { view, colorScaleMode, particleParams, layers, cuts, section, slice } = deps;
    view.theme = "dark";
    view.shadows = true;
    view.exaggeration = deps.globeMode ? 1 : 3;
    colorScaleMode.value = colorScaleModeOf(deps.queryColorscale);
    Object.assign(particleParams, { ...DEFAULT_PARTICLES, paused: particleParams.paused });
    layers.buildingOpacity = 1;
    layers.buildingTintEnabled = false;
    layers.buildingTintStrength = 0.6;
    layers.volumeOpacity = 0.6;
    layers.volumeThreshold = 0.2;
    layers.cutLowAlpha = false;
    layers.cutLowThreshold = 0.15;
    layers.filterSlices = true;
    cuts.x = [...DEFAULT_CUTS.x];
    cuts.y = [...DEFAULT_CUTS.y];
    cuts.z = [...DEFAULT_CUTS.z];
    cuts.faces = DEFAULT_CUTS.faces;
    section.colormap = "viridis";
    section.autoRange = true;
    section.min = 0;
    section.max = 15;
    section.opacity = 0.85;
    section.contours = 12;
    section.lowAlpha = false;
    section.lowThreshold = 0.15;
    slice.heightM = 150;
    section.offsetKm = 0;
    section.box.heightMinM = 0;
    section.box.heightMaxM = 1000;
    section.box.stepLevels = 1;
    const cleared = clearVisualPrefs(localStorage);
    prefsMessage.value = cleared.message;
  }

  return {
    prefsMessage,
    readSavedVisualPrefs,
    saveVisualSettings,
    restoreVisualDefaults,
  };
}
