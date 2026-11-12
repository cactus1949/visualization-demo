import type { FormatDef } from "./types";

/** SZ3 T1L. Decoder: data/codecs/sz3.ts + data/codecs/sz3/. */
const format: FormatDef = {
  id: "sz3",
  label: "SZ3",
  order: 1,
  missingHint: "没有 SZ3 导出：先运行 python -m nc_export --date YYYYMMDD --format sz3，并启动 uvicorn services.api:app",
};

export default format;
