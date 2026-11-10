export interface VariableMeta {
  dims: string[];
  shape: number[];
  encoding: string;
  range_scope: "global" | "per_level";
  dtype: "uint8" | "uint16" | "float16";
  bits: 8 | 16;
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
  bytes_raw: number;
  bytes_compressed: number;
  data_min: number;
  data_max: number;
  clipped_low_frac: number;
  clipped_high_frac: number;
  nan_count: number;
  staggered_from?: string;
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
  source_file: string;
  created_utc: string;
  global_attrs: Record<string, unknown>;
  grid: GridMeta;
  variables: Record<string, VariableMeta>;
  derived?: Record<string, { display_range: [number, number] }>;
  timing: {
    load_s: number;
    total_s: number;
    bytes_raw: number;
    bytes_compressed: number;
  };
}
