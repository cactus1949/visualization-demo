import type { FormatDef } from "./types";

/** Current encoding (f16 / u8 + Brotli). Decoder: data/codecs/current.ts. */
const format: FormatDef = {
  id: "current",
  label: "当前编码",
  order: 0,
  fallbackCases: ["lowair_atmos_6h", "lowair_atmos"],
  missingHint: "没有可用的当前编码数据：先运行 python -m nc_export --date YYYYMMDD",
};

export default format;
