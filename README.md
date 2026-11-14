# 天津低空大气三维可视化（three 分支）

## 项目简介

`three` 分支用 Vue 3 和 three.js 0.187 在浏览器里展示天津 18 km × 18 km、0–1000 m 高度的稳态三维风场。第三版把渲染层整体换成了经典 `WebGLRenderer`（WebGL2）加手写 GLSL，功能分为下面四部分。

- **建筑白膜**：13 万栋建筑，按真实高度拉伸，和风场网格对齐。
- **GPGPU 风粒子**：粒子位置和历史轨迹都放在 GPU 浮点纹理里计算，拖尾是真实的三维几何，转动相机时不会断。尾迹长度、线宽、数量、配色等参数都能实时调。
- **GPU 采样切片**：水平切片和可拖动、可旋转的垂直剖面直接在片元着色器里采样 3D 纹理，拖动时只改变换矩阵或 4 个顶点，CPU 不重新生成数据。
- **探针廓线**：打开“探针”后悬停只预览 3D 气象站位置（不改读数），单击（非拖动）固定并更新该点 40 层的风速、风向和所选变量廓线；可选“跟随鼠标”实时更新读数。
- **体渲染切面**：体渲染面板提供 xcut / ycut / zcut 双端滑块（0–1），只改变体盒的根局部 AABB；“切面”打开时，新生成的盒面会和剖面走同一条 v4.2 光线内合成路径。
- **四种剖面**：经度方向（x 常量）和纬度方向（z 常量）是可拖动的轴对齐竖墙；折线和框选进入绘制模式，左键在地面放点或拖框，右键旋转视角，Esc 退出。折线达到两个点立即显示折墙和左下展开图；框选按模型层生成水平板并显示高度标签。
- **时间维度与播放（v6.11）**：默认打开 6 小时连续数据（f000–f006，7 帧，间隔 1 小时，个例 torch-abl3d）。底部时间轴可播放 / 暂停、上一帧 / 下一帧、0.5×–4× 倍速（1× = 1 小时数据播 4 秒）、循环、拖动进度条；帧间平滑默认开（GPU 混合，风场保模长插值），关掉后按整点切换。时刻按文件里的字面时间显示，文件未标时区，不加时区标签。规则见 `docs/state-model.md`「时间轴」。
- **屏幕空间标注**：探针、剖面手柄、折线顶点和层高标签由 `web/src/render/annotations/` 统一绘制，样式见 `docs/annotation-style.md`。标记按 CSS 像素定尺寸，不受垂直夸张或框选拉伸影响。

## 目录结构

| 路径                     | 内容                                                  |
| ------------------------ | ----------------------------------------------------- |
| `pipeline/ncpipe/`       | NetCDF → 按变量配置量化 + Brotli + manifest，与渲染器无关 |
| `pipeline/bldpipe/`      | 建筑白膜管线：裁剪、投影、拉伸、meshopt 压缩          |
| `pipeline/geopipe/`      | 地球页地理底座：坐标映射系数、自建 DEM、每列地面高度（见 `docs/globe-geo.md`） |
| `data/web/lowair_atmos/` | 23 个变量的 `.bin.br` 和 `manifest.json`（约 7.5 MB） |
| `data/web/lowair_atmos_6h/` | 6 小时 7 帧：`manifest.json`（schema 4）+ `t000/` … `t006/`，每帧 23 个 `.bin.br`（合计约 39.3 MB） |
| `data/web/buildings/`    | `buildings.glb`（约 6.4 MB）和 `buildings.json`       |
| `web/`                   | three.js 前端                                         |

## 数据处理

### 风场

```bash
PYTHONPATH=pipeline /workspace/.venv-nc/bin/python -m ncpipe build \
  --input data/lowair_atmos.nc \
  --config pipeline/config/variables.yaml \
  --out data/web/lowair_atmos
```

每个变量按 `pipeline/config/quant_config.yaml` 编码，再经 Brotli（quality 9）压缩。配置里可以写编码（`u8_linear`、`u16_linear`、`f16`、`u8_log10` 等）、区间范围（`global` 或 `per_level`），以及可选的分位数裁剪。本案例中 u、v 存成 float16；w 用逐层 8 位线性（比 float16 小很多，首屏更快）；温度、湿度等窄区间的 2D 变量，以及多数脉动、结冰类 3D 变量，也用 8 位线性；`visibility` 和跨数量级的 `wind_shear` 用 log10。`tke` 在这份数据里大约 2.4–12.7，没有跨数量级，所以仍用逐层 8 位线性。量化区间默认按数据的 min/max（或分位数）计算，只影响存储。色带和色例使用配置里的固定 `display_range`（物理单位），与量化范围无关，后一个时次也会用同一套颜色。`variables.yaml` 仍只保留中文名、色带和参考范围。`w` 仍从 41 个界面层平均到 40 个层中心。manifest 记录 encoding、dtype，以及全局或逐层的 scale/offset。

### 多时次（6 小时连续数据）

```bash
PYTHONPATH=pipeline /workspace/.venv-nc/bin/python -m ncpipe build \
  --inputs /workspace/data/lowair_atmos_tianjin_6h/f00*.nc \
  --config pipeline/config/variables.yaml \
  --quant pipeline/config/quant_config_6h.yaml \
  --out data/web/lowair_atmos_6h
```

`--inputs` 走 `ncpipe/build_multi.py`：先校验各帧网格相同，再按变量（逐层变量按层）统计所有帧的并集 min/max，**7 帧共用一套量化网格**，然后逐帧写 `tNNN/<变量>.bin.br`。编码仍是上面的现有格式（这一版不换 C 方案 / SZ3 / 时间差分）；一帧一目录、manifest 记 `times` 和共用的 scale/offset，以后换编码只动 Worker 解码。manifest（schema 4）新增 `times[]`（`dir`、`valid_time` 为文件里解码出的字面时间，未标时区）和每个变量的 `frames[]`（逐帧 min/max、字节数）；`data_min/max` 是 7 帧并集。`risk_level` 改用 `u8_int` 整数原样存储（scale 1、offset 0），不再出现 2 解成 2.0039。`quant_config_6h.yaml` 只放宽了 7 帧并集超出原色带的四个量：w ±0.25、t2m 270–295 K、dirdz ±0.3、visibility 200–30000 m。

### 建筑白膜

```bash
pip install -r pipeline/requirements-buildings.txt
PYTHONPATH=pipeline python -m bldpipe \
  --shp <3D-GloBFP 2292 号瓦片>.shp \
  --osm-pbf tianjin-latest.osm.pbf \
  --simplify-m 1.5 --min-area-m2 20
```

1. **3D-GloBFP**（Che 等，2024，ESSD 16:5357，[Zenodo 15459025](https://zenodo.org/records/15459025)，CC BY 4.0）。这是全球单体建筑轮廓加高度的数据集，研究区落在 2292 号瓦片（116.25–117.5°E，38.75–40°N，zip 约 232 MB）里。网格范围内有 136,779 个轮廓，**全部带高度**。它的高度来自 XGBoost 回归，对超高层明显低估，这一块最高只有 132 m。
2. **OpenStreetMap**（Geofabrik 天津抽取，ODbL 1.0，© OpenStreetMap contributors）。网格内有 26,612 栋建筑，其中只有 589 栋带 `height` 或 `building:levels`（约 2.2%），但地标楼的高度准确，例如天津环球金融中心 337 m、天津国际金融中心 338 m。
3. **合并方式**：以 3D-GloBFP 的轮廓为主。某个轮廓和带高度的 OSM 建筑重叠超过轮廓面积的 30% 时，取两者中较高的值，这一步更新了 471 栋。另有 49 栋 OSM 带高度建筑在 3D-GloBFP 里没有对应轮廓，直接补进来。
4. **处理**：裁剪到网格范围，按和前端一致的线性经纬度映射投影到局部坐标（单位 km，x 向东，z 向南，y 为真实高度），轮廓简化 1.5 m，丢掉面积小于 20 m² 的碎片。屋顶用 earcut 三角化，墙和屋顶共用顶点，不存法线（前端 `flatShading` 用屏幕空间导数求面法线）。最后用 `gltfpack -cc` 做 meshopt 压缩，位置量化为 16 位（18 km 范围内精度约 0.3 m）。
5. **结果**：130,232 栋，145 万个顶点，192 万个三角形，最高 415 m，平均 14.8 m。`buildings.glb` 约 6.4 MB，构建约 15 秒。

原始下载文件放在仓库外（例如 `/workspace/buildings-raw/`），不提交。合并结果中包含 OSM 派生数据，再分发时需要同时署名 3D-GloBFP（CC BY 4.0）和 OpenStreetMap（ODbL）。

## 前端运行

```bash
cd web
npm install
npm run dev            # 开发
npm run build          # 类型检查 + 生产构建（同时把 data/web 复制到 dist/data）
npx vite preview --port 4173 --strictPort
```

默认打开 `data/web/lowair_atmos_6h`（不存在时自动退回单时次 `lowair_atmos`）；`?data=lowair_atmos` 强制单时次，`?t=2.5` 打开指定时刻，`?timeline=0` 隐藏时间轴。

顶部第三个 tab「地球」（`?tab=globe`）用 CesiumJS，懒加载，前两个 tab 不下载 Cesium。它需要先生成地理底座（`pipeline/README.md` 的 geopipe），并在 `web/.env.local` 里写天地图 key `VITE_TIANDITU_TK=...`（参考 `web/.env.example`）。说明见 `docs/globe-geo.md`。

浏览器需要支持 WebGL2 和 `EXT_color_buffer_float`（桌面端 Chrome、Edge、Firefox、Safari 17+ 都支持）。`?embed=1` 会隐藏控制面板；在 iframe 中运行时，组件会向父页面发送 `atmos:ready` 和 `atmos:probe` 消息。

### 交互

- 左键拖动旋转视角，右键平移，滚轮缩放，相机带阻尼；折线和框选绘制模式下左键放点/拖框，右键旋转，Esc 退出。
- 经度/纬度剖面上拖动可以平移墙面。折线和框选绘制模式下，左键放点或拖框，右键旋转视角，Esc 或再点同一模式退出绘制。
- 打开右侧“探针”：悬停显示预览标记（青色细杆和地面圆环），单击（非拖动）固定位置并更新左侧廓线；“跟随鼠标”开启后悬停也会更新读数。
- 三维标注（探针、剖面拖动手柄、折线顶点、框选层高）走统一的屏幕空间标注层，字号和点的大小不随缩放或垂直夸张变化。规则写在 `docs/annotation-style.md`。

### 控制面板参数

| 分组     | 参数                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 图层     | 建筑白膜开关、建筑不透明度、地面底图（近地面风速、2 米气温、能见度等 2D 变量，或纯色）、风粒子、体渲染（默认关闭，可选变量、不透明度、阈值、物理单位的“显示范围”双端滑块和可选“截面同步过滤”）；体渲染色带会标出当前窗口 |
| 粒子样式 | 粒子数量（4k–262k）、尾迹长度（2–64 步）、速度倍率、线宽（像素）、生命周期、不透明度、着色方式（按风速 / 按 w / 按高度 / 单色）、色带、高度下限和上限、w 垂直放大、尾迹收细、叠加发光、暂停                              |
| 水平切片 | 开关、变量（水平风速和全部 3D 变量）、高度（12.5–987.5 m 连续可调）、色带、自动或手动范围、不透明度、等值线条数                                                                                                          |
| 垂直剖面 | 经度方向、纬度方向、折线、框选四种模式；变量、色带、自动或手动范围、不透明度、等值线。框选支持高度范围、层间距、拉伸和每 1/2/5 层取样（默认每 5 层，最多 16 层） |
| 视图     | 垂直夸张（1–10 倍）、建筑阴影、深色 / 浅色主题、总览 / 近景 / 俯视                                                                                                                                                       |

色带有 Glacier（粒子默认）、Viridis、Magma、Turbo、Cividis、Inferno、Blues，以及发散型 RdBu 和 Coolwarm。`w`、`u`、`v` 这类有正有负的变量默认用 RdBu，范围关于 0 对称。自动范围使用配置里的固定 `display_range`，不按当前时次重算分位数；也可以改成手动范围。体渲染的“显示范围”过滤器仍按物理值裁剪，和色带范围相互独立。

## 架构

```
nc ─ ncpipe ─▶ data/web/<case>/tNNN/*.bin.br ─ Worker 缓存字节、解码 Float32 + 半精度 ─▶ 每帧槽位 DataArrayTexture
                                                 └─ GPU 混合 pass（⌊t⌋, ⌊t⌋+1, s）─▶ “当前时刻” WebGL3DRenderTarget
                                                 ├─ 切片 / 剖面：片元着色器直接采样物理值
                                                 ├─ 粒子：RGBA16F 风场纹理（u, v, w, |V|）
                                                 └─ 体渲染：光线步进
3D-GloBFP + OSM ─ bldpipe ─▶ buildings.glb（meshopt）─ GLTFLoader ─▶ 一个合并网格
```

- 所有图层都挂在同一个 `root` 组下，局部单位是 km，y 是真实高度。垂直夸张只改 `root.scale.y`，不重建任何几何体或纹理。
- **粒子**（`web/src/render/particles.ts`）：
  - 状态存在两张 RGBA32F 纹理里，每个粒子一个纹素，xyz 是网格坐标，w 是年龄，两张纹理轮流读写（ping-pong）。
  - 平流在全屏片元着色器里完成：用硬件三线性插值采样风场 3D 纹理，按 RK2 中点法积分。粒子超出寿命、离开计算域或离开高度范围时，用 PCG 哈希重新生成位置。
  - 每一步把新状态写入 `WebGLArrayRenderTarget` 的一层，N 层（64 层，粒子超过 7 万时为 32 层）组成每个粒子的历史环形缓冲。
  - 拖尾用一次实例化绘制完成。每个实例是 N 个节点的带状网格，顶点着色器用 `texelFetch` 取第 (head − k) mod N 层的位置，投影到屏幕后按像素线宽外扩，从头到尾逐渐变细、变透明。颜色在顶点着色器里按该节点处的风速、w 或高度查色带。
  - 整个循环里没有逐粒子的 CPU 计算，也没有 GPU 回读。
- **切片**（`slices.ts`）：片元着色器把片元的 root 局部坐标换算成 3D 纹理坐标后采样（高度层在层中心，所以纹理 r 坐标正好是 h / 1000 m），查色带，等值线用 `fwidth` 做抗锯齿。开启“截面同步过滤”时，切片和剖面也会按体渲染的物理区间丢弃片元；这适合它们显示同一个变量或同单位变量。垂直剖面在 CPU 上按方位角和偏移把四个顶点裁剪到计算域内，每次拖动只更新 4 个顶点。
- **体渲染**（`volume.ts`）：每帧先把体和粒子隐藏，在带深度纹理的目标中渲染地面和建筑；半透明切片、剖面、折墙、板层和切面在光线步进里按交点合成，背后的体可以透过并受不透明度减弱，不透明度约为 1 时仍挡住后面的体。体盒随 x/y/z cut 缩放，最多 16 个表面按距离排序后一次合成；体渲染关闭时这些网格仍正常绘制。
- **建筑**（`buildings.ts`）：`MeshStandardMaterial`，开启 flatShading，并通过 `onBeforeCompile` 把墙脚约 28 m 压暗，模拟环境光遮蔽；配合方向光阴影（4096² 阴影贴图）。
- **探针**：直接读内存中解码后的 Float32 数组（每次 40 个值），每帧最多做一次射线检测，只检测地面和切片，不检测 192 万个建筑三角形；固定点是贯穿场景高度的细杆加地面圆环，由标注层投影到屏幕。
- **标注层**（`web/src/render/annotations/`）：功能模块只提供锚点，层负责按像素绘制 HTML/SVG 标记、标签和手柄，并做廉价的建筑高度场遮挡淡出。
- **时间维度**（`web/src/render/timeFields.ts`、`web/src/state/timeline.ts`、`web/src/components/TimelineBar.vue`）：Worker 按帧缓存编码字节（LRU 220 MB），在 Worker 里解码并转半精度（f16 直接拷贝，其余查表转换），风场直接打包成 RGBA16F。每个在用的 3D 量有 3 个半精度 `DataArrayTexture` 槽位（⌊t⌋、⌊t⌋+1、预取帧）和一张 `WebGL3DRenderTarget`；混合 pass 只在 t 变化时跑，40 层逐层写入，所有消费者采样同一张目标纹理。换槽按层分批上传（每帧 6 层），首帧仍只拉 t000。
- `window.__atmosApi` 提供 `setView / setSection / setSlice / setParticles / setLayer / setVolume / setCamera / setExaggeration / setProbeEnabled / setProbeFollowMouse / probeAt / probeHoverAt / setPolyline / selectPolylineVertex / setBox / setCuts / advance / status`，以及时间轴的 `setTime / play / pause / stepFrame / setPlayback / hasFrame / timeline / timeStats`，供截图和录屏脚本调用（`web/scripts/screenshot.mjs`、`web/scripts/record.mjs`）。

## 生产部署

Vite 的 dev 和 preview 通过插件从 `../data/web` 提供 `/data/**`。`npm run build` 会把数据复制到 `dist/data`。nginx 示例：

```nginx
location /data/ {
    root /srv/atmos;
    location ~ \.bin\.br$ { types { application/octet-stream br; } add_header Content-Encoding br; }
    location ~ \.glb$ { types { model/gltf-binary glb; } gzip_static on; }
}
```

### 部署在子路径（例：`/viz/`）

用 `npm run build -- --base /viz/` 构建。前端所有请求都会带上 base：页面和资源在 `/viz/`、`/viz/assets/`，Cesium 在 `/viz/cesium/`，数据在 `/viz/data/`，接口在 `/viz/api/`（`VITE_DATA_BASE` 设成非空值时，数据和接口改走它）。`vite preview` 和 dev 会自动把 `/viz/data`、`/viz/api` 代理到 `DATA_API`，并去掉前缀。生产环境由 nginx 做同样的转发：

```nginx
location /viz/ {
    alias /srv/atmos/dist/;          # vite build 的输出
    try_files $uri $uri/ /viz/index.html;
}
location /viz/data/ {
    proxy_pass http://127.0.0.1:8000/data/;   # 末尾的 /data/ 会把 /viz 前缀去掉
}
location /viz/api/ {
    proxy_pass http://127.0.0.1:8000/api/;
}
```

如果 `/viz/data/` 不经接口、直接由 nginx 提供静态文件，`.bin.br` 和 `.glb` 的写法和上面根路径的例子一样，只是把 `location /data/` 换成 `location /viz/data/`，`root` 换成 `alias`。漏配 `/viz/data/` 或 `/viz/api/` 时，`try_files` 会把请求回落到 index.html（200 text/html），页面不报错，但拿不到数据。

## 分支规划

`main` 保留原始数据，`three` 是本方案。`cesium` 等其他方案的分支可以复用 `pipeline/` 和 `data/web/`，只替换 `web/`。

## 已知限制

- 第三版去掉了 WebGPU/TSL 路径（第二版里 WebGPU 白屏，TSL 计算在 WebGL2 后端也跑不起来），现在只有 WebGL2 这一条路径。所有桌面浏览器都能运行，以后需要时可以再加 WebGPU compute 分支。
- 无头截图环境只有 SwiftShader 软件渲染，大约 1 FPS，测不出真实帧率。丝不丝滑需要在带 GPU 的机器上实测，状态栏会显示 FPS 和 draw call 数。
- 3D-GloBFP 的高度是模型估计值（论文报告 RMSE 1.9–14.6 m），没有 OSM 高度的超高层仍可能偏低。
- 风场 u、v 存成 float16，精度大约 0.004 m/s；w 用逐层 8 位，这份数据里最大绝对误差大约 7×10⁻⁴ m/s。探针读的是解码后的物理值。整包压缩体积约 7.5 MB。
- 粒子每帧走一步，所以尾迹的实际长度会随帧率变化。
- 建筑开启透明（不透明度小于 1）时，合并网格内部的三角形不排序，可能出现轻微的穿插。
- 建筑不透明度小于 1 时仍然写入深度；体光线会在墙面终止，所以不会透过半透明白膜看到墙后的体素。
- 标注被建筑挡住时用 128×128 的最大高度场做近似淡出（约 35% 透明度），不是逐三角形求交，密集街区边缘可能有轻微误差。
