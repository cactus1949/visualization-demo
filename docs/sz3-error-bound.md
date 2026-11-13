# SZ3 分层误差上限（规格）

只管 SZ3 格式（`pipeline/sz3pipe/`、`web/src/data/codecs/sz3*`）。当前编码格式不受影响。对比数据和方案草稿见分析目录 `sz3-robust-eb/plan.md`。

## 误差上限

每帧、每个存储变量、每一层（3D 按层，2D 整场为一层），在变换域（`transform: log10` 的变量在 log10 域，其余在物理量）里：

```
eb = min(P, ratio × 本层本帧有限值的范围)        ratio = 1/512
范围 = 0（含全 NaN）→ 常数层：index 里只记一个常数，不写字节
```

P 是每个变量的物理下限，和地区、时间无关，写在 `pipeline/config/sz3_config.yaml`，每个变量都写了依据。配置里没写 P 的存储变量导出时直接报错。

## 编码选择

每帧每变量从下面选一种，结果写进 index 和 manifest：

| 情况 | 编码 |
|---|---|
| 配置 `codec: quant`（risk_level） | 量化（u8 整数） |
| `codec: auto`（默认），本帧有限值里非零占比 < `sparse_frac`（0.01） | 量化 |
| 其余 | SZ3 + 验收降档 |

理由（分析目录实测，7 帧）：risk_level SZ3 整数模式 27.7 KB，u8_int + brotli 18.9 KB；icing 注入小块时 SZ3 32 KB，量化 9 KB，误差相同。非零占比按帧判定，所以同一变量不同帧可能用不同编码。全零的层在两种编码下都是常数层。

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

`manifest.json` 的 `variables[name].frames[i]` 增加 `codec`、`tier`、`fallback`、`eb_max`、`slab_kinds`、`nan_count`；输出目录另写 `sz3_report.json`，按变量列出每帧的编码、tier、误差和字节数，再给降档统计。
