# ncpipe
可复用的 NetCDF→浏览器二进制管线。量化区间来自 `config/variables.yaml`，默认 8 位，指定变量可同时生成小端 16 位文件。

SZ3 导出（`sz3pipe/`）的误差上限、编码选择、降档和缺测处理见 `docs/sz3-error-bound.md`，每个变量的 P 和依据写在 `config/sz3_config.yaml`。
