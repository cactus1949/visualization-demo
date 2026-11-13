/**
 * Height labels at the south-west corner of the data shell. Anchors use exact
 * float64 ENU placement so they stay on the curved shell when k or terrain changes.
 */
import type { AnnotationLayer } from "./layer";
import type { EnuFrame, GeoGrid, GeoMap } from "../../geo/mapping";
import { placeEnuUnits } from "../../geo/boxEnu";
import type { GridField } from "../../geo/placement";

const PREFIX = "shell-height-";

export function shellLabelHeights(topM: number, levels: number[]): number[] {
  const step = topM >= 800 ? 250 : 200;
  const out: number[] = [0];
  for (let h = step; h < topM - 1; h += step) out.push(h);
  if (out[out.length - 1] !== Math.round(topM)) out.push(Math.round(topM));
  // Prefer official grid levels that land close to a step so the text matches the data.
  for (const lv of levels) {
    const nearest = out.reduce((a, b) => (Math.abs(b - lv) < Math.abs(a - lv) ? b : a));
    if (Math.abs(nearest - lv) <= 1) {
      const i = out.indexOf(nearest);
      if (i >= 0) out[i] = lv;
    }
  }
  return out;
}

export class ShellHeightLabels {
  private heights: number[] = [];

  constructor(
    private readonly layer: AnnotationLayer,
    private readonly grid: GeoGrid,
    private readonly map: GeoMap,
    private readonly frame: EnuFrame,
  ) {}

  setHeights(heights: number[]): void {
    this.heights = heights;
  }

  update(k: number, ground: GridField | null): void {
    const inside = placeEnuUnits(this.grid, this.map, this.frame, 0.08, 0.08, 0, k, ground);
    for (const h of this.heights) {
      const p = placeEnuUnits(this.grid, this.map, this.frame, 0, 0, h, k, ground);
      this.layer.addLabel(`${PREFIX}${h}`, {
        anchor: { x: p[0], y: p[1], z: p[2] },
        text: `${Number.isInteger(h) ? h.toFixed(0) : h.toFixed(1)} m`,
        leader: true,
        awayFrom: { x: inside[0], y: inside[1], z: inside[2] },
        priority: h === 0 ? 20 : Math.round(1000 - h),
        cluster: "shell-height",
      });
    }
  }

  dispose(): void {
    this.layer.removePrefixed(PREFIX);
  }
}
