# SZ3 分层误差上限（规格）

只管 SZ3 格式（`pipeline/sz3pipe/`、`web/src/data/codecs/sz3*`）。当前编码格式不受影响。对比数据和方案草稿见分析目录 `sz3-robust-eb/plan.md`。

## 误差上限

每帧、每个存储变量、每一层（3D 按层，2D 整场为一层），在变换域（`transform: log10` 的变量在 log10 域，其余在物理量）里：

```
eb = min(P, ratio × 本层本帧有限值的范围)        ratio = 1/512
范围 = 0（含全 NaN）→ 常数层：index 里只记一个常数，不写字节
```

P 是每个变量的物理下限，和地区、时间无关，写在 `pipeline/config/sz3_config.yaml`，每个变量都写了依据。默认规则：探针显示位数的半个末位和色带半档（display_range 跨度 / 512）取较严的一条（例如 w、icing_index 按探针 3 位小数取 0.0005）。配置里没写 P 的存储变量导出时直接报错。

不按默认规则取的变量（依据都在配置注释里）：

| 变量 | P | 默认规则会给 | 原因 |
|---|---|---|---|
| u、v | 0.004 | 0.005 | 任务指定；也和当前编码 f16 在 16 m/s 以下的舍入误差（0.0039）对齐 |
| ustar | 0.0002 | 0.0005 | sigma_u/v/w 由 ustar 现算，系数最大 2.4：2.4 × 0.0002 = 0.00048 ≤ sigma 的 P |
| wind_shear | 0.002（log10 域） | — | 方案值。相对误差 0.46 %，0.1 1/s 时误差 0.00046，小于探针第 3 位的半个末位 |
| q2m | 1.5×10⁻⁵ | 1.6×10⁻⁵ | 色带半档向下取整 |
| icing_accum | 0.05 | — | 样例日没有结冰，常见量级 10–100 是假设的 |
| visibility | 7×10⁻⁶（log10 域） | — | 按色带顶端 30000 m 处整米显示折成相对误差 |
| u_gust（派生） | 0.005 | 0.005 | 不存；现算核对允许 max_err 0.0094，见下文「派生量」 |
| risk_level | 无损 | — | 分类量，u8 存整数 |

P 只约束 SZ3 段。量化段（配置 `codec: quant`、稀疏场、降档后的回退）的误差由本层范围 / 255（u8）或 float16 精度决定，**不保证 ≤ P**；导出报告里每帧的 `max_err` 是实测值。

当前编码格式（`ncpipe`，不是上面的 SZ3 量化段）在变量有缺测时，把最高码留给缺测（manifest 写 `nan_code`），所以 u8 的步长变成范围 / 254，u16 变成范围 / 65534，（变换域里）误差上限是半个步长。多时次导出时整个变量的所有帧共用一套 scale/offset：只要有任何一帧出现 NaN，所有帧都会改用 / 254 的步长并带同一个 `nan_code`，没有缺测的帧的码值也会变。SZ3 格式里的量化段缺测走游程掩码，步长仍是本帧本层范围 / 255。

## 派生量

sigma_u/v/w、u_gust、cloud_low 不存，浏览器按配置里的公式用已解码的源变量现算。导出时用重建后的源变量算一遍、和 nc 比：误差不超过 P（u_gust 是配置里的 `max_err`）就不存，超过就改成普通存储变量按 SZ3 存。

u_gust 的核对上限是 0.0094 m/s（当前编码 u_gust 各层误差的最小值），**比它的 P（0.005）宽**：u、v 各有 0.004 的误差，再加 2·sigma_u，hypot 之后很难压到 0.005。11-11 七帧实测最大误差 0.00654 m/s，超过 P、在 0.0094 以内，所以没有存。也就是说 u_gust 的误差不受 P 约束，只受 0.0094 约束。

## 编码选择

每帧每变量从下面选一种，结果写进 index 和 manifest：

| 情况 | 编码 |
|---|---|
| 配置 `codec: quant`（risk_level） | 量化（u8 整数） |
| `codec: auto`（默认），本帧有限值里非零占比 < `sparse_frac`（0.01） | 量化 |
| 其余 | SZ3 + 验收降档 |

理由（分析目录实测，7 帧）：risk_level 用 SZ3 整数模式（eb 0.49 后取整）是 27,747 字节；当前编码格式 u8_int + brotli 是 18,890 字节；SZ3 格式里的量化段用 zlib，pack 19,043 字节，加上每帧的 index JSON 共 20,974 字节（v6.18 导出）。icing 注入小块时 SZ3 32 KB，量化 9 KB，误差相同。非零占比按帧判定，所以同一变量不同帧可能用不同编码。全零的层在两种编码下都是常数层。

## 验收和降档（只对 SZ3）

编码后立即解压，在变换域、只看有限值：

1. 每层 max_err ≤ eb（相对容差 1e-5）；
2. 每层 RMSE ≤ 0.6 × eb；
3. 全场最大值、最小值：|重建极值 − 真实极值| ≤ eb（真实极值所在层的 eb）；
4. 极值位置：重建 argmax 和真实 argmax 同格，或者真实场在重建 argmax 处的值 ≥ 真实最大值 − 2·eb（并列平台）。argmin 同理。

第 1、3 条的容差另加一个 float32 舍入步长（|真值|×2⁻²³），因为 SZ3 的上限是对 float32 输入保证的，真值按 float64 比较会多出半个 ulp。

全部通过记 tier `x1`。不通过时所有 SZ3 层的 eb 乘 1/4 重试（`x0.25`），再乘 1/16（`x0.0625`），仍不通过改用量化（tier `quant`，`fallback` 写第一次失败的原因）。

## 量化（SZ3 格式内的「当前编码」）

和当前编码同样的量化方式，但不引用当前编码的代码，按本帧本层自己的范围：

- `fallback: u8`（默认）：变换域线性 u8，`x = q·scale + add`；
- `fallback: f16`（u、v）：float16；
- 整数变量（risk_level）：u8 存整数值。

每层的码值用 zlib（deflate，level 9）压缩后写进 pack，浏览器用 `DecompressionStream("deflate")` 解。文件名不变，不需要改服务端。

## NaN 和缺测

导出前把 `_FillValue`、`missing_value` 和非有限值都当缺测（xarray 默认已把 `_FillValue` 解成 NaN）。有缺测的层：缺测处先填本层有限值的均值再编码；另存一段游程掩码（uint32 小端，交替表示有效、缺测的个数，从有效开始，可为 0），解码后把这些格子置回 NaN。全 NaN 的层是常数层，常数为 null。验收只看有限值。

派生量（sigma_*、u_gust、cloud_low）的输入缺测时，浏览器算出来也是缺测；导出核对公式只比两边都有限的格子。manifest、index、报告都按严格 JSON 写（不允许 NaN），缺的统计值写 null。

前端约定：解出来的数组里 NaN 就是缺测。渲染当透明，探针显示「缺测」，图例 min/max 和阈值统计跳过 NaN，粒子走到 NaN 格子就重生。

## index json（版本 2）

```json
{"version": 2, "name": "u", "shape": [40,300,300], "slab_shape": [300,300], "per_level": true,
 "transform": null, "round": false, "codec": "sz3", "tier": "x1", "fallback": "",
 "slabs": [
   {"kind": "sz3",   "offset": 0, "length": 38758, "eb": 0.004},
   {"kind": "const", "value": 0.0},
   {"kind": "u8",    "offset": 38758, "length": 812, "scale": 0.01, "add": -1.2},
   {"kind": "f16",   "offset": 39570, "length": 9000},
   {"kind": "sz3",   "offset": 48570, "length": 30000, "eb": 0.004, "nan": {"offset": 78570, "length": 24}}
 ]}
```

没有 `slabs` 的旧 index（`offsets` / `lengths`）按全部 SZ3 解。

## 导出报告

`manifest.json` 的 `variables[name].frames[i]` 增加 `codec`、`tier`、`fallback`、`eb_max`、`slab_kinds`、`nan_count`。`bytes_compressed`（变量级、帧级和 `timing` 里的合计）只算 `.sz3pack`，每帧 index JSON 的字节另记在 `bytes_index`；算「浏览器要下载多少」时两者相加（v6.18 七帧：pack 10,574,611 + index 179,985 = 10,754,596 字节）。

`prefetch_extra: 1` 只是说明字段，前端不读。两种格式都用 `web/src/state/fetchWindow.ts` 的 `FETCH_WINDOW_AHEAD = 2`，窗口是 ⌊t⌋、⌊t⌋+1、⌊t⌋+2，即插值用的两帧之外多拉 1 帧，和这个 1 一致。

输出目录另写 `sz3_report.json`，按变量列出每帧的编码、tier、误差和字节数，再给降档统计。
