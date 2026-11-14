# ncpipe
可复用的 NetCDF→浏览器二进制管线。量化区间来自 `config/variables.yaml`，默认 8 位，指定变量可同时生成小端 16 位文件。

SZ3 导出（`sz3pipe/`）的误差上限、编码选择、降档和缺测处理见 `docs/sz3-error-bound.md`，每个变量的 P 和依据写在 `config/sz3_config.yaml`。

## geopipe

给地球页生成地理底座：`geo.json`（网格四角、网格 ↔ 中心 ENU 的 16 项三次多项式系数和拟合残差）、`dem.u16.bin.br`（自建椭球高 DEM）、`ground.u16.bin.br`（每一列的地面椭球高）。都是构建产物，不进 git。设计和验收见 `docs/globe-geo.md`。

```bash
pip install -r pipeline/requirements-geo.txt
cd pipeline
python -m geopipe --nc /path/to/f000.nc --dem /path/to/Copernicus_DSM_COG_10_N39_00_E117_00_DEM.tif --out ../data/web/geo
```

- DEM：Copernicus GLO-30，<https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_N39_00_E117_00_DEM/Copernicus_DSM_COG_10_N39_00_E117_00_DEM.tif>（约 50 MB，放在仓库外）。它是地表模型，先做 150 m 开运算和闭运算再轻微高斯平滑，去掉建筑尖刺。
- EGM2008 大地水准面差距由 pyproj 从 PROJ CDN 取，第一次运行要联网。
- 部署时把输出目录放到 `$WEB_ROOT/geo/`。
- 前端统一按 `h = g(lon, lat) + k × 离地高度` 放置，`g` 是地面椭球高，`k` 是垂直夸张。
