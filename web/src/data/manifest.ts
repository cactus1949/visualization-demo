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
  /** codec sidecar next to `file` (SZ3: per-slab offsets) */
  index_file?: string;
  /** `encoding: "derived"`: recipe the codec uses instead of a file */
  derive?: Record<string, unknown>;
  bytes_raw: number;
  /** current: the .bin.br file; SZ3: the .sz3pack only (the index JSON is in bytes_index) */
  bytes_compressed: number;
  /** SZ3 only: bytes of the per-frame index JSON (`index_file`), summed over frames */
  bytes_index?: number;
  data_min: number;
  data_max: number;
  clipped_low_frac: number;
  clipped_high_frac: number;
  nan_count: number;
  /**
   * Current encoding only: integer code that marks a missing cell. Written only when the variable
   * has missing cells (finite values then use codes 0..max-1); absent means no code is reserved.
   */
  nan_code?: number;
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
  /** export format ("current", "sz3", ...); codec-specific fields are read by codecs/*.ts only */
  format?: string;
  codec?: string;
  /** short HUD label of the codec, e.g. "SZ3 T1L" */
  codec_label?: string;
  /**
   * Legacy SZ3 export field ("frames beyond the interpolation pair"). Not read by the client: both
   * formats use FETCH_WINDOW_AHEAD = 2 in state/fetchWindow.ts, i.e. [⌊t⌋, ⌊t⌋+1, ⌊t⌋+2], which is
   * one frame beyond the pair, so the value 1 the exporter writes matches the window.
   */
  prefetch_extra?: number;
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
