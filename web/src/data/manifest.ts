export interface VariableMeta {
  dims: string[];
  shape: number[];
  dtype: "uint8";
  bits: 8;
  scale: number;
  offset: number;
  transform: "log10" | null;
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
  u16?: {
    file: string;
    scale: number;
    offset: number;
    bytes_raw: number;
    bytes_compressed: number;
    dtype: "uint16";
    bits: 16;
  };
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
  timing: {
    load_s: number;
    total_s: number;
    bytes_raw: number;
    bytes_compressed: number;
  };
}
