# 按日导出与取数服务

两种导出格式完全分开：**当前编码**（`current`，f16/u8 + Brotli）和 **SZ3**（`sz3`，T1L）。各自一个输出目录、一份 manifest，互不引用。以后只留一种时，按文末清单删文件即可，另一种不受影响。

## 环境变量

也可以写在 `services/.env`，参考 `services/.env.example`。

| 变量 | 默认 | 含义 |
|---|---|---|
| `NC_ROOT` | `/data/nc` | 某天的 nc 放在 `$NC_ROOT/yyyymm/yyyymmdd/*.nc` |
| `WEB_ROOT` | `/data/web` | 导出到 `$WEB_ROOT/<格式>/yyyymm/yyyymmdd/` |
| `DATA_API` | `http://127.0.0.1:8000` | 只给 `npm run dev` 用，Vite 把 `/api`、`/data` 转发到这里 |
| `VITE_DATA_BASE` | 空 | 前端单独部署时，接口的完整地址 |
| `VITE_TIANDITU_TK` | 空 | 地球页天地图 key，写在 `web/.env.local`（不提交） |
| `VITE_DEV_BASEMAP` | 空 | 设为 `esri` 时地球页在 `npm run dev` 下改用 Esri 影像；生产构建忽略 |

地球页的地理底座放在 `$WEB_ROOT/geo/`（`python -m geopipe` 生成，见 `pipeline/README.md`），接口按静态文件提供，`.br` 文件带 `Content-Encoding: br`。

`/data/nc`、`/data/web` 不在仓库里，要自己建好目录，或者把这两个变量改到别的路径。

## 导出

以下命令都在仓库根目录运行。

```bash
pip install -r pipeline/requirements.txt             # current 需要
pip install -r pipeline/sz3pipe/requirements.txt     # sz3 还需要 pysz（内置 SZ3 3.4.0）

python -m nc_export --date 20261111                  # 默认 --format current
python -m nc_export --date 20261111 --format sz3
python -m nc_export --date 20261111 --format all     # services/formats/ 里有的格式都导
```

输出：

```
$WEB_ROOT/current/202611/20261111/manifest.json   t000/u.bin.br …
$WEB_ROOT/sz3/202611/20261111/manifest.json       t000/u.sz3pack + u.json …
```

每种格式先写到同级的 `.20261111.tmp`，写完再整体改名替换，导到一半失败时旧数据不受影响。

当前编码（`--format current`）的缺测：f16 直接存 NaN。u8/u16/u8_int 只有在该变量（多时次按所有帧合起来看）出现缺测时，才把最高码值（255 / 65535）留作缺测码，manifest 写 `nan_code`，有限值只用 0 到最高码值减 1；没有缺测的变量不留码值，输出和以前逐字节一致。浏览器 `codecs/current.ts` 把等于 `nan_code` 的格子解成 NaN。以前 NaN 被记成 0 号码，解出来是本层最小值。

SZ3 的设置在 `pipeline/config/sz3_config.yaml`：
- 每个变量、每帧、每层在变换域使用 `min(P, ratio × 有限值范围)` 作为上限；常数层只写常数。
- `codec: quant` 或自动识别到稀疏帧时使用独立的 u8/f16 量化，其余帧使用 SZ3 并按验收阶梯降档。实际 codec、tier、fallback、缺测数和层类型写入 index v2、manifest 和 `sz3_report.json`。
- `risk_level` 以 u8 整数精确保存。`sigma_u`、`sigma_v`、`sigma_w`、`u_gust`、`cloud_low` 默认由浏览器派生；导出时公式检查失败才改为存储。
- 规则细节见 `docs/sz3-error-bound.md`。导出按帧并行，进程数取 CPU 数减 1 和可用内存 / 2.5 GB 中较小的（40×300×300 单帧峰值约 1.9 GB）。

## 取数接口

```bash
pip install -r services/requirements.txt
uvicorn services.api:app --host 0.0.0.0 --port 8000
```

- `GET /api/health`
- `GET /api/days`：列出每天有哪些格式（`days[].formats`），以及每种格式的最新一天（`latest`）。`?format=sz3` 只看一种格式。
- `GET /data/<格式>/yyyymm/yyyymmdd/manifest.json`，以及同目录下的帧文件。`.br` 文件带 `Content-Encoding: br` 返回。帧文件（`.bin.br`、`.sz3pack`、按帧的 index json）带 `Cache-Control: public, max-age=31536000, immutable`；`manifest.json` 用 `no-cache`，因为可能被重新导出。没导出的日期返回 404。

接口按目录发现格式，代码里没有写死格式名。

## 前端怎么选数据

顶部菜单一项对应一种格式，切换时相机和时间保持不变。地址参数：

- `?format=sz3`：选 SZ3 页，不带就是当前编码。旧链接里的 `?codec=sz3` 也认。
- `?date=20261111`：打开这一天，读 `/data/<格式>/202611/20261111/manifest.json`。
- 不带 `?date`：先问 `/api/days` 要这种格式最新的一天。接口不通或还没导出时，当前编码退回仓库自带的样例 `data/web/lowair_atmos_6h`；SZ3 没有样例，会提示先导出。
- `?data=lowair_atmos`：打开仓库里的样例。

本地开发：

```bash
uvicorn services.api:app --port 8000      # 终端 1，WEB_ROOT 指向导出目录
cd web && npm run dev                      # 终端 2，打开 http://localhost:5173/?format=sz3
```

开发服务器先在仓库的 `data/web/` 里找样例，找不到的 `/data/*` 和 `/api/*` 转发给 `DATA_API`，所以不用设 `VITE_DATA_BASE`。前端和接口分开部署时，构建前设 `VITE_DATA_BASE=http://接口地址`。

## 只留一种格式：要删的文件

共用、两种都不能删的有：`pipeline/ncpipe/ncread.py`（读 nc、网格、时间轴）、`pipeline/config/variables.yaml`、`pipeline/config/quant_config_6h.yaml`（色标范围）、`services/paths.py`、`services/api.py`、`services/formats/__init__.py`、`nc_export/`，以及前端的 `data/codecs/types.ts`、`data/loader.worker.ts`、`formats/types.ts`、时间轴和渲染。导出命令、接口和前端菜单都按文件自动发现格式，删文件以后不用改代码。

**删 SZ3：**
```
pipeline/sz3pipe/
pipeline/config/sz3_config.yaml
pipeline/tests/test_sz3.py
services/formats/sz3.py
web/src/formats/sz3.ts
web/src/data/codecs/sz3.ts
web/src/data/codecs/sz3/          (WASM 解码器)
$WEB_ROOT/sz3/                    (导出数据)
```

**删当前编码：**
```
pipeline/ncpipe/build_multi.py
pipeline/tests/test_multi.py
services/formats/current.py
web/src/formats/current.ts
web/src/data/codecs/current.ts
$WEB_ROOT/current/
data/web/lowair_atmos_6h/  data/web/lowair_atmos/   (仓库样例，没有 current 解码器就打不开了)
```
`pipeline/ncpipe/build.py`、`quantize.py` 是单时次样例和建筑管线用的旧工具，跟导出命令无关，可以留着。

只剩一种格式时，顶部菜单自动隐藏。
