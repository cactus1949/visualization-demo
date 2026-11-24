/**
 * 组装画布左下角的色标图例列表（剖面、粒子、体渲染、地面色斑）以及越界三角箭头判定。
 */
import { computed, type Ref } from "vue";
import type { Manifest } from "../data/manifest";
import type { ParticleParams } from "../render/particles";
import type { SectionKind } from "../render/sections/types";
import type { ColorScaleMode } from "../state/colorScale";
import { emptyHint, type DataRange } from "../state/legendRange";
import { bracket, type TimelineState } from "../state/timeline";

export interface LegendEntry {
  key: string;
  title: string;
  units: string;
  colormap: string;
  min: number;
  max: number;
  windowMin?: number;
  windowMax?: number;
  overLow?: boolean;
  overHigh?: boolean;
  dataMin?: number;
  dataMax?: number;
  hint?: string | null;
  warn?: string | null;
}

export interface LegendsDeps {
  speedName: string;
  manifest: Ref<Manifest | undefined>;
  tl: TimelineState;
  legendDataTick: Ref<number>;
  colorScaleMode: Ref<ColorScaleMode>;
  speedRange: Ref<[number, number]>;
  section: {
    enabled: boolean;
    kind: SectionKind;
    variable: string;
    colormap: string;
    min: number;
    max: number;
  };
  slice: { heightM: number };
  layers: {
    particles: boolean;
    ground: boolean;
    groundVar: string;
    volumeVar: string;
    volumeFilterMin: number;
    volumeFilterMax: number;
  };
  particleParams: ParticleParams;
  volumeWanted: () => boolean;
  volumeDataRange: Ref<DataRange | null>;
  volumeColorRange: Ref<[number, number]>;
  volumeDataHint: Ref<string | null>;
  volumeThresholdWarning: Ref<string | null>;
  sectionLevel: () => number | undefined;
  currentDataRange: (name: string, level?: number) => DataRange | null;
  particleLegendRange: (name: string) => [number, number];
  displayRange: (name: string) => [number, number] | null;
  defaultColormap: (name: string) => string;
  groundStyle: (name: string) => { colormap: string; range: [number, number] };
  labelOf: (name: string) => string;
  unitsOf: (name: string) => string;
}

export function useLegends(deps: LegendsDeps) {
  /**
   * Legend end arrows: lit when the displayed frame has values beyond the (fixed) colour
   * range. Uses the manifest's per-frame min/max of frame ⌊t⌋ (schema 4), else the file range.
   */
  function overRange(name: string, lo: number, hi: number): { overLow: boolean; overHigh: boolean } {
    const meta = deps.manifest.value?.variables[name];
    if (!meta || !Number.isFinite(lo) || !Number.isFinite(hi)) return { overLow: false, overHigh: false };
    const a = bracket(deps.tl).a;
    const st = meta.frames?.[a] ?? meta;
    const eps = Math.abs(hi - lo) * 1e-3;
    return { overLow: st.data_min < lo - eps, overHigh: st.data_max > hi + eps };
  }

  const legends = computed<LegendEntry[]>(() => {
    void deps.legendDataTick.value;
    void deps.colorScaleMode.value;
    const { section, slice, layers, particleParams } = deps;
    const out: LegendEntry[] = [];

    if (section.enabled) {
      const dataRange = deps.currentDataRange(section.variable, deps.sectionLevel());
      out.push({
        key: "section",
        title:
          section.kind === "height"
            ? `剖面 ${slice.heightM.toFixed(0)} m · ${deps.labelOf(section.variable)}`
            : `剖面 · ${deps.labelOf(section.variable)}`,
        units: deps.unitsOf(section.variable),
        colormap: section.colormap,
        min: section.min,
        max: section.max,
        dataMin: dataRange?.min,
        dataMax: dataRange?.max,
        hint: emptyHint(section.variable, dataRange),
        ...overRange(section.variable, section.min, section.max),
      });
    }

    if (layers.particles && particleParams.colorMode !== "single") {
      const name =
        particleParams.colorMode === "w"
          ? "w"
          : particleParams.colorMode === "height"
            ? "height"
            : deps.speedName;
      const range: [number, number] =
        deps.colorScaleMode.value === "frame"
          ? deps.particleLegendRange(name)
          : name === deps.speedName
            ? (deps.displayRange(deps.speedName) ?? deps.speedRange.value)
            : name === "w"
              ? (deps.displayRange("w") ?? [-0.2, 0.2])
              : [0, 1000];
      out.push({
        key: "particles",
        title: `粒子 · ${name === "height" ? "高度" : deps.labelOf(name)}`,
        units: name === "height" ? "m" : "m/s",
        colormap: particleParams.colormap,
        min: range[0],
        max: range[1],
        ...(name === "w" ? overRange("w", range[0], range[1]) : {}),
      });
    }

    if (deps.volumeWanted()) {
      const dataRange = deps.volumeDataRange.value;
      const baseCmap = deps.defaultColormap(layers.volumeVar);
      out.push({
        key: "volume",
        title: `体渲染 · ${deps.labelOf(layers.volumeVar)}`,
        units: deps.unitsOf(layers.volumeVar),
        colormap: baseCmap === "rdbu" ? "magma" : baseCmap,
        min: deps.volumeColorRange.value[0],
        max: deps.volumeColorRange.value[1],
        windowMin: layers.volumeFilterMin,
        windowMax: layers.volumeFilterMax,
        dataMin: dataRange?.min,
        dataMax: dataRange?.max,
        hint: deps.volumeDataHint.value,
        warn: deps.volumeThresholdWarning.value,
        ...overRange(layers.volumeVar, deps.volumeColorRange.value[0], deps.volumeColorRange.value[1]),
      });
    }

    if (layers.ground && layers.groundVar !== "none") {
      const name = layers.groundVar;
      const dataRange = deps.currentDataRange(
        name === "speed0" ? deps.speedName : name,
        name === "speed0" ? 0 : undefined,
      );
      const style = deps.groundStyle(name);
      out.push({
        key: "ground",
        title: `地面 · ${name === "speed0" ? "近地面风速" : deps.labelOf(name)}`,
        units: name === "speed0" ? "m/s" : deps.unitsOf(name),
        colormap: style.colormap,
        min: style.range[0],
        max: style.range[1],
        dataMin: dataRange?.min,
        dataMax: dataRange?.max,
        hint: emptyHint(name, dataRange),
        ...overRange(name, style.range[0], style.range[1]),
      });
    }

    return out;
  });

  return { legends };
}
