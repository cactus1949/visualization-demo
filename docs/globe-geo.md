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

- 相机（`globe/rtcCamera.ts`）：在 JS 里用 float64 算 `Cesium viewMatrix × 中心 ENU × 单位缩放`，交给 three，GPU 上的坐标只有几个单位大。默认 `log`：three `logarithmicDepthBuffer`，near/far 按图层包围盒的最近/最远点收紧；`?globeDepth=linear` 或 `near` 用同样的包围盒和线性深度；`legacy` 保留 PR ① 的包围球算法作对照。宿主接口和帧顺序见 `docs/view-host.md`。
- 每帧在 Cesium 的 `postRender` 里：`resetState()`，清深度，画只写深度的地形代理网格（`globe/depthProxy.ts`，同一份 DEM，关地形时是弯曲椭球面片），再画图层，最后 `resetState()`。Cesium 画完后的深度不能直接用，所以靠代理网格做遮挡。
- WebGL 上下文丢失（`webglcontextlost`）时停止 three 绘制，页面提示刷新。卸载 tab 时释放 `layers` 下所有几何体和材质、代理网格、three 渲染器和 Viewer。

### 升级 Cesium 要复查的私有字段

Cesium 没有公开接口，`globe/overlay.ts` 直接用了 `scene.context` 上这些字段：

- `_gl`：共用的 WebGL 上下文。
- `_currentRenderState`、`_defaultRenderState`、`_currentPassState`、`_defaultPassState`、`_currentFramebuffer`：three 每帧结束 `resetState()` 把 GL 状态恢复成默认值，之后把 Cesium 缓存的当前状态也设回默认（帧缓冲设为 `undefined`）。不这样做，Cesium 下一帧只按它以为的状态差异去设置，和真实 GL 状态对不上。

## 体渲染（PR ③）

- 地球 tab 是 `GlobeViewer.vue` 里套一个 `AtmosViewer`（Cesium 宿主 + `globeVolume`），面板、时间轴、过滤、色带、图例与前两个 tab 是同一套代码。地球面板（底图、地形、夸张、视角）在它左边。
- 弯壳步进（`render/volume.ts` 的弯壳着色器）：光线在中心 ENU 里是直线，包围盒由 `geo/mapping.ts` 的 `shellBounds` 用精确 float64 坐标在 41×41 个 (u, v) 上取地面和顶面再外扩 20 m，域四角因地球曲率比中心低约 13 m，已算在盒里。每一步 `geoInverse`（ENU → u, v, h），`AGL = (h − 地形开关 × g(u, v)) / k`，按与盒体相同的节点 / 层中心约定采样；过滤窗口、透明阈值、低值渐显、色带都与盒体一致；每步不透明度按「去掉夸张后的公里数」算，所以 k 和步数改变时浓淡一致。裁切用 (u, AGL 比例, v)，z 方向与盒体一样从北往南。
- 地形开关和 k 只改共享 uniform、代理网格、Cesium 地形和体渲染包围盒，不重新取数据。
- 遮挡深度：宿主把地形代理（和场景里其余遮挡物）画进体渲染的深度纹理，体渲染据此截短光线。编码默认 `log`（three 渲染器开 `logarithmicDepthBuffer`，体渲染按 three 的 logdepthbuf 公式反解深度）；`?globeDepth=linear` 切回线性（NDC z）。这是任务 A 定下的默认值。
- 步数默认 128，`?volSteps=` 可改（调试）。
- ⑥ 已接入（只在地球 tab 改放置，前两个 tab 不受影响）：探针按经纬 / AGL 取样并在弯曲壳体上插标注；层高标签挂在壳体西南角；建筑白膜按真实经纬贴在 DEM / 椭球面上（k 只乘离地高度）；地面 2D 场贴在壳体地面，开关不重新取体数据；图例与盒体 tab 共用。粒子（⑤）见下节。
- ④ 剖面已接入：经度、纬度、高度、折线、框选五种剖面和统一剖面面板、拖动手柄与前两个 tab 共用代码。剖面几何仍是盒体公里坐标（只做细分：高度剖面每个网格单元一格，竖墙和框选层按 0.06 km，约等于地面网格间距），顶点着色器里走 `盒体 km → (u, v, AGL) → h = 地形开关 × g + k × AGL → geoPlace`（`render/sections/globe.ts`），所以跟随 k 和地形开关、不重新取数据；片元仍在插值后的盒体坐标上采样，数值与盒体 tab 同一纹素。深度按 three 的 logdepthbuf 公式写 `gl_FragDepth`。剖面和体渲染在面板里互斥（和前两个 tab 一样），所以剖面与体按光线顺序合成只在调试模式（`allowSectionWithVolume`）下能走到；正常使用时合成的只有体渲染的切面。（仅调试）两者同时打开时，剖面（含框选的各层，最多 16 个面）在弯壳光线步进里按光线顺序合成：每步把采样点换回盒体坐标，用符号变化找穿越点，再做两次割线细化。超过 16 个面时，折线和框选整组退回普通网格绘制，并在控制台警告一次。探针拾取剖面和前两个 tab 的目标一样（高度剖面、经/纬剖面、折线各段墙面；前两个 tab 只拾取剖面网格，不拾取边框线），但剖面网格在着色器里放置、CPU 射线打不中，所以用解析方法：指针射线在 ENU 里按壳体包围球和地面命中点截断，逐点换回盒体坐标，找每个剖面方程第一次变号的位置，再二分细化（`render/sections/globePick.ts`）。标注和手柄用盒体坐标登记（`space: "box"`），每帧经精确 float64 放置映射到 ENU；拖动时相机输入关闭。
- 标注地形遮挡（`geo/lineOfSight.ts`）：相机到锚点的 ENU 线段先裁到 DEM 域内，按距离采样，步长不超过 60 m，最多 256 点；任一点低于地面超过 3 m，或连续两点低于地面超过 1 m，即判为遮挡。DEM 范围以外的地形不参与遮挡。线性深度调试模式（`?globeDepth=linear`）下，相机很低又在数据域外时 near 会退到 1 m，可能出现 z-fighting。
- 建筑阴影走 `host/rendererConfig.ts` 里共用的 PCF 路径，不另开一条。Cesium 宿主的灯光在 ENU（z 向上）下重新对准。
- 调试接口（仅 `npm run dev` 或 `?globeDebug=1`）：`__globeApi.measureInverseResidual()`（在 GPU 上跑生产用的 `geoInverse`，读回后与精确坐标比，单位米）、`benchFrames(n)`（同步渲染 n 帧，用 1 像素 `readPixels` 等 GPU，毫秒）、`volumeInfo()`；`__atmosApi.setVolumeSteps(n)`。

## 粒子（⑤）

- 模拟不变：和盒体 tab 同一个 `WindParticles`（`render/particles.ts`），状态仍在网格空间（`gx = u`、`gy = v`、高度为离地 km），采样同一张「当前时刻」风场纹理。地球 tab 走单独的 `globe` 分支，盒体 tab 的着色器文本和绘制路径不变。
- 放置：每步模拟后多一个全屏 pass，把历史环形缓冲里最新那一层按 `(u, v, 离地 m)` → `geoPlace`（上面的统一公式）换成中心 ENU，写进第二个环形缓冲；轨迹顶点着色器只读 ENU，不再每个顶点算三次多项式。地形开关或 k 变化时（`geo/particlePlace.ts` 的 `placementKey`），所有历史层重新放置一遍（64 个 pass），暂停时也一样，所以轨迹不会一半是旧 k、一半是新 k。CPU 参考实现和单测在 `geo/particlePlace.ts`、`particlePlace.test.ts`。
- 深度：轨迹写 three 的对数深度（`LOGDEPTH_*`，和测试层同一公式），`depthWrite: false`、`renderOrder` 仍是 10。地形代理和建筑先写深度，所以粒子会被地形、建筑挡住；体渲染的遮挡深度不含粒子（和盒体 tab 一样）。
- 共享 GL 上下文：粒子的创建、改参数（数量变化会重新分配渲染目标和几何）、每步的模拟 / 拷贝 / 放置 pass 和调试读回都放在 `host.isolateGl()` 里。Cesium 宿主在前后各 `resetState()` 一次，再把 Cesium 缓存的渲染状态设回默认（同 `captureOccluderDepth`）；盒体宿主没有这个方法，直接执行。
- 屏幕线宽按上下文的 `drawingBufferWidth / Height` 算（Cesium 宿主不调 `renderer.setSize`，three 缓存的尺寸不准）。
- 剖面挡粒子（和盒体 tab 同一套规则，`slices.ts` 的 depthWrite / colorWrite 策略不变）：高度、经 / 纬、折线剖面画在 renderOrder 2 / 3，不透明且没开「低值透明」时写深度（地球页写对数深度），粒子（10）在它们之后画，所以剖面后面的粒子被挡住、前面的照常显示。框选层的层片只有不透明度为 1 时写深度；半透明层片不挡粒子（盒体 tab 也是这样），它们的深度 twin 只写深度不写颜色，renderOrder 10.5，在粒子之后画，给轮廓线的「被遮挡虚线」用。地球页的 twin 用 `GlobeDepthMaterial`（`render/sections/globe.ts`），和层片同一个顶点着色器、同一组地形 / k uniform，所以开地形、改 k 时 twin 跟着层片一起变，不用 CPU 重建。剖面和体渲染在面板里互斥；只有调试的同开模式下剖面并入体渲染合成，这时剖面不写深度，也不挡粒子。
- 调试接口（`?globeDebug=1`）：`__atmosApi.particlePlacement(n)` 读回前 n 个粒子最新节点的 GPU 放置结果，和 float64 精确放置比较（米）；还没放置过（刚重新分配、或重置还没执行）时返回 `{ unplaced: true, placeCount }`。

## 底图

- 正式版只用天地图：`img_w + cia_w`（影像）或 `vec_w + cva_w`（矢量），`UrlTemplateImageryProvider`，子域 `01234567`，`WebMercatorTilingScheme`，最大 18 级。key 从 `VITE_TIANDITU_TK` 读，真实值写在不提交的 `web/.env.local`。这是浏览器端 key，打包后可见。
- 开发用 Esri 影像：只在 `npm run dev` 下、并且设了 `VITE_DEV_BASEMAP=esri` 或 `?devBasemap=esri` 时启用，给访问不了天地图的机器截图用。`vite build` 里这段代码被去掉。
- 隐藏 Cesium 标志，保留影像署名。

## 测试图层（临时）

`globe/testLayer.ts`（默认关，面板「对齐测试图层」打开）用来验收对齐和遮挡：品红色域边框、离地 250/500/750 m 三层半透明水平面、`v = 0.5` 处一面从地下 300 m 到离地 600 m 的竖幕（地下部分红色）。顶点都用 GPU 多项式放置。Cesium 用精确坐标画青色边框做对照（`globe/referenceOutline.ts`）。`window.__globeApi.measureAlignment()` 在页面里测两者的毫米和像素差。真实图层接入后删除这三个文件。

## 限制

- nc 没有地形变量，模型在平地上算。开地形只是把风场贴在真实地面上显示。
- 域外 0.2° 以外地形回到椭球面（约 7 m 台阶，离域 20 km 以上）。
- 开地形时，只有高度剖面的顶点正好落在地面网格节点上（每个网格单元一格）；竖墙、折线和框选层沿长度每 0.06 km 细分一次，顶点一般不在节点上。两种情况下三角面内部都是平的，而着色器里的地面是双线性的，两者高度差最大约 1 m（`ground.npy` 单元扭曲 |g00+g11−g10−g01|/4 最大 1.01 m，99 分位 0.21 m）；实测放置残差 0.15–0.23 m，关地形时只有几 mm。
- 地形代理网格约 105 m 一格，和 Cesium 地形瓦片的细节层级不完全一样，贴地处可能有几个像素的出入。

## 深度和数据解码实现约定

深度比较脚本在 `/workspace/visualization-demo-analysis/globe-depth-deploy/`。默认 `log`。自定义 ShaderMaterial 要按 three 的 logdepthbuf 公式写深度（测试层即便 `depthWrite: false` 也会写 `gl_FragDepth`，否则对着对数缓冲做线性深度测试会错）；体渲染写 `gl_FragDepth` 时用同一套编码。`CESIUM_BASE_URL` 跟随 Vite `base`（`vite build --base /sub/` 也能找到拷贝出来的 Workers / Assets）。DEM 和 ground 的 u16 解码在 `geo/geoDecode.worker.ts` module worker 中执行，数组通过 transferable 传递；`dequantize` 是纯函数，供 Node 单测使用。数据 URL 默认跟随 Vite base，设置 `VITE_DATA_BASE` 时用显式地址。
