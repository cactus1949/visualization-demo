import type { ScalarBinding } from "../slices";

export type SectionKind = "height" | "lon" | "lat" | "polyline" | "box";
export interface SectionStyle {
  variable: string;
  binding?: ScalarBinding | null;
  colormap: string;
  min: number;
  max: number;
  opacity: number;
  contours: number;
  filterMin: number;
  filterMax: number;
  filterEnable: boolean;
}
export interface SectionDefinition {
  kind: SectionKind;
  offsetKm?: number;
  points?: { x: number; z: number }[];
  x0?: number;
  z0?: number;
  x1?: number;
  z1?: number;
  heightMinM?: number;
  heightMaxM?: number;
  stepLevels?: number;
  defined?: boolean;
}
