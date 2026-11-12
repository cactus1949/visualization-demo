export interface VariableMeta {
  dims: string[];
  shape: number[];
  encoding: string;
  range_scope: "global" | "per_level";
  dtype: "uint8" | "uint16" | "float16" | "float32";
  bits: 8 | 16 | 32;
  scale?: number;
  offset?: number;
  level_scale?: number[];
  level_offset?: number[];
  transform: "log10" | "log1p" | "signed_sqrt" | null;
  display_range: [number, number];
  range: [number, number];
  units: string;
  long_name: string;
  label_zh: string;
  colormap: string;
  file: string;
  /** SZ3 sidecar with per-slab offsets (T1L). */
  index_file?: string;
  bytes_raw: number;
  bytes_compressed: number;
  data_min: number;
  data_max: number;
  clipped_low_frac: number;
  clipped_high_frac: number;
  nan_count: number;
  staggered_from?: string;
  /** schema 4: per-frame stats; quantisation (scale/offset) is shared by all frames. */
  frames?: FrameStats[];
}

export interface FrameStats {
  bytes_compressed: number;
  data_min: number;
  data_max: number;
}

/** One time step (schema 4). `valid_time` is the literal clock from the file; no time zone is implied. */
export interface TimeEntry {
  index: number;
  dir: string;
  valid_time: string;
  lead_h: number;
  source: string;
}

export interface GridMeta {
  nx: number;
  ny: number;
  nz: number;
  lon_min: number;
  lon_max: number;
  lat_min: number;
  lat_max: number;
  dx_m: number;
  dy_m: number;
  levels_m: number[];
  level_interfaces_m: number[];
  order: string;
  lat_ascending: boolean;
}

export interface Manifest {
  schema_version: number;
  case: string;
  source_file: string | string[];
  created_utc: string;
  global_attrs: Record<string, unknown>;
  grid: GridMeta;
  variables: Record<string, VariableMeta>;
  derived?: Record<string, { display_range: [number, number] }>;
  /** schema 4 only; a schema-3 manifest is treated as one frame in the manifest directory. */
  times?: TimeEntry[];
  time_zone?: string | null;
  /** "sz3" when this case uses T1L (or another SZ3 tier) for the main 3D fields. */
  codec?: string;
  sz3_tier?: string;
  timing: {
    load_s: number;
    total_s: number;
    bytes_raw: number;
    bytes_compressed: number;
  };
}

/** Frames of a manifest; schema 3 (single time) becomes one frame with an empty dir. */
export function timesOf(manifest: Manifest): TimeEntry[] {
  if (manifest.times?.length) return manifest.times;
  return [{ index: 0, dir: "", valid_time: "", lead_h: 0, source: String(manifest.source_file ?? "") }];
}
