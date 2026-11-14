import type { ScalarBinding } from "../slices";
import type { CutBounds } from "../cuts";
import type { SectionKind } from "./types";

export interface CompositeSurface {
  kind: "horizontal" | "vertical";
  binding: "slice" | "section" | "volume";
  field: ScalarBinding | null;
  min: number; max: number; opacity: number; colormap: string; contours: number;
  filterMin: number; filterMax: number; filterEnable: boolean;
  lowAlpha?: boolean; lowThreshold?: number;
  height?: number; normalX?: number; normalZ?: number; offset?: number;
  clipX0?: number; clipX1?: number; clipZ0?: number; clipZ1?: number;
  ax?: number; az?: number; bx?: number; bz?: number;
}

export function buildCompositeSurfaces(args: {
  slice?: CompositeSurface | null;
  section?: CompositeSurface | null;
  kind?: SectionKind;
  cutBounds?: CutBounds;
  domain: { sx: number; sz: number; top: number };
  cutFaces?: boolean;
  volumeField?: ScalarBinding | null;
  volumeStyle?: Omit<CompositeSurface, "kind" | "binding" | "field" | "height" | "normalX" | "normalZ" | "offset" | "clipX0" | "clipX1" | "clipZ0" | "clipZ1">;
}): CompositeSurface[] {
  const out: CompositeSurface[] = [];
  if (args.slice?.field && args.slice.opacity > 0) out.push(args.slice);
  if (args.section?.field && args.section.opacity > 0) out.push(args.section);
  const b = args.cutBounds;
  const st = args.volumeStyle;
  if (args.cutFaces && b && args.volumeField && st) {
    const eps = 1e-5, d = args.domain;
    if (b.lo.x > -d.sx / 2 + eps) out.push({ ...st, kind: "vertical", binding: "volume", field: args.volumeField, normalX: -1, normalZ: 0, offset: b.lo.x, clipX0: b.lo.x, clipX1: b.lo.x, clipZ0: b.lo.z, clipZ1: b.hi.z });
    if (b.hi.x < d.sx / 2 - eps) out.push({ ...st, kind: "vertical", binding: "volume", field: args.volumeField, normalX: 1, normalZ: 0, offset: b.hi.x, clipX0: b.hi.x, clipX1: b.hi.x, clipZ0: b.lo.z, clipZ1: b.hi.z });
    if (b.lo.z > -d.sz / 2 + eps) out.push({ ...st, kind: "vertical", binding: "volume", field: args.volumeField, normalX: 0, normalZ: -1, offset: b.lo.z, clipX0: b.lo.x, clipX1: b.hi.x, clipZ0: b.lo.z, clipZ1: b.lo.z });
    if (b.hi.z < d.sz / 2 - eps) out.push({ ...st, kind: "vertical", binding: "volume", field: args.volumeField, normalX: 0, normalZ: 1, offset: b.hi.z, clipX0: b.lo.x, clipX1: b.hi.x, clipZ0: b.hi.z, clipZ1: b.hi.z });
    if (b.lo.y > eps) out.push({ ...st, kind: "horizontal", binding: "volume", field: args.volumeField, height: b.lo.y, clipX0: b.lo.x, clipX1: b.hi.x, clipZ0: b.lo.z, clipZ1: b.hi.z });
    if (b.hi.y < d.top - eps) out.push({ ...st, kind: "horizontal", binding: "volume", field: args.volumeField, height: b.hi.y, clipX0: b.lo.x, clipX1: b.hi.x, clipZ0: b.lo.z, clipZ1: b.hi.z });
  }
  return out.slice(0, 16);
}
