# 地球页：地理底座

第三个 tab「地球」用 CesiumJS 画地球和底图，风场图层继续用 three.js，画在 Cesium 同一块画布、同一个 WebGL 上下文里。这一页只写地理底座：坐标怎么放、地形开关、相机同步和遮挡。调研和取舍见分析目录 `cesium-research/report.md` 第二轮。

## 目标和验收

- 每个网格点放在它真实的（经度，纬度，椭球高）上，网格位置用 nc 四角经纬度，不用 `dx_m`。
- 映射残差（对比 Cesium `Cartesian3.fromDegrees`）：正向 float64 < 0.1 mm，float32 < 6 mm；反向 float64 < 6 mm，float32 < 8 mm。由 `web/src/geo/mapping.test.ts` 检查。
- 地形开关只换 `terrainProvider`、深度代理网格和着色器里的地面开关，不重新取数据。
- 前两个 tab 的首屏代码和画面不变；Cesium 只在点开「地球」时下载。
- 不用 Cesium ion，不用 VoxelPrimitive。

## 统一的放置公式

```
椭球高 h = g(经, 纬) + k × 离地高度
```

- `g`：地面椭球高。关地形时为 0（光滑 WGS84 椭球）；开地形时来自自建 DEM。
- `k`：垂直夸张，只乘离地高度。Cesium 的 `scene.verticalExaggeration` 固定为 1，地形本身不夸张。
- 所有图层（以后的体渲染、剖面、粒子、建筑、标注）和 Cesium 画的参考线都用这一个公式，代码在 `web/src/geo/placement.ts`。

## 坐标

- 网格坐标：`u = (lon − lon_min)/(lon_max − lon_min)`，`v` 同理，`h` 为椭球高（米）。
- 中心 ENU：以域中心 `(lon0, lat0, 0)` 为原点的东北天坐标。three 场景单位是 `map.enu_unit_m`（10 km）。
- 精确路径（CPU，float64）：大地坐标 → ECEF → ENU，`geo/mapping.ts` 的 `exactEnu`。
- 多项式路径（GPU）：16 项三次多项式 `u^i v^j w^k`（`w = h/1e4`），正向 `(u, v, w) → ENU`，反向 `ENU → (u, v, w)`。系数由 `pipeline/geopipe` 拟合，写在 `geo.json` 的 `map`，适用高度 −100 到 10100 m（覆盖 10 倍夸张）。着色器代码由 `globe/geoShader.ts` 生成。

## 管线产物（`$WEB_ROOT/geo/`，不进 git）

| 文件 | 内容 |
|---|---|
| `geo.json` | 网格四角、多项式系数和拟合残差、DEM 和地面网格的元数据 |
| `dem.u16.bin.br` | 去尖刺后的椭球高 DEM，域外各放 0.2°，u16（0.01 m）+ Brotli，行从北到南 |
| `ground.u16.bin.br` | 每一列的地面椭球高，300 × 300，行从南到北（和 nc 一致） |

DEM 处理：Copernicus GLO-30 → 150 m 开运算 + 闭运算 + 轻微高斯 → 加 EGM2008 大地水准面差距 N。生成命令见 `pipeline/README.md`。

## 渲染

- 相机（`globe/rtcCamera.ts`）：在 JS 里用 float64 算 `Cesium viewMatrix × 中心 ENU × 单位缩放`，交给 three，GPU 上的坐标只有几个单位大。three 的 near/far 按图层包围球单独算。
- 每帧在 Cesium 的 `postRender` 里：`resetState()`，清深度，画只写深度的地形代理网格（`globe/depthProxy.ts`，同一份 DEM，关地形时是弯曲椭球面片），再画图层，最后 `resetState()`。Cesium 画完后的深度不能直接用，所以靠代理网格做遮挡。
- WebGL 上下文取自 `scene.context._gl`，Cesium 没有公开接口，升级 Cesium 时要复查。

## 底图

- 正式版只用天地图：`img_w + cia_w`（影像）或 `vec_w + cva_w`（矢量），`UrlTemplateImageryProvider`，子域 `01234567`，`WebMercatorTilingScheme`，最大 18 级。key 从 `VITE_TIANDITU_TK` 读，真实值写在不提交的 `web/.env.local`。这是浏览器端 key，打包后可见。
- 开发用 Esri 影像：只在 `npm run dev` 下、并且设了 `VITE_DEV_BASEMAP=esri` 或 `?devBasemap=esri` 时启用，给访问不了天地图的机器截图用。`vite build` 里这段代码被去掉。
- 隐藏 Cesium 标志，保留影像署名。

## 测试图层（临时）

`globe/testLayer.ts` 在真实图层搬过来之前用来验收对齐和遮挡：品红色域边框、离地 250/500/750 m 三层半透明水平面、`v = 0.5` 处一面从地下 300 m 到离地 600 m 的竖幕（地下部分红色）。顶点都用 GPU 多项式放置。Cesium 用精确坐标画青色边框做对照（`globe/referenceOutline.ts`）。`window.__globeApi.measureAlignment()` 在页面里测两者的毫米和像素差。真实图层接入后删除这三个文件。

## 限制

- nc 没有地形变量，模型在平地上算。开地形只是把风场贴在真实地面上显示。
- 域外 0.2° 以外地形回到椭球面（约 7 m 台阶，离域 20 km 以上）。
- 地形代理网格约 105 m 一格，和 Cesium 地形瓦片的细节层级不完全一样，贴地处可能有几个像素的出入。
