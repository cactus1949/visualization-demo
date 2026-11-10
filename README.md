# 天津低空大气三维可视化（three 分支）

## 项目简介

`three` 分支用 Vue 3 和 three.js 0.187 在浏览器里展示天津 18 km × 18 km、0–1000 m 高度的稳态三维风场。第三版把渲染层整体换成了经典 `WebGLRenderer`（WebGL2）加手写 GLSL，功能分为下面四部分。

- **建筑白膜**：13 万栋建筑，按真实高度拉伸，和风场网格对齐。
- **GPGPU 风粒子**：粒子位置和历史轨迹都放在 GPU 浮点纹理里计算，拖尾是真实的三维几何，转动相机时不会断。尾迹长度、线宽、数量、配色等参数都能实时调。
- **GPU 采样切片**：水平切片和可拖动、可旋转的垂直剖面直接在片元着色器里采样 3D 纹理，拖动时只改变换矩阵或 4 个顶点，CPU 不重新生成数据。
- **探针廓线**：鼠标悬停或双击固定一个位置，显示该点 40 层的风速、风向和所选变量的垂直廓线。

## 目录结构

| 路径                     | 内容                                                  |
| ------------------------ | ----------------------------------------------------- |
| `pipeline/ncpipe/`       | NetCDF → 8 位量化 + Brotli + manifest，与渲染器无关   |
| `pipeline/bldpipe/`      | 建筑白膜管线：裁剪、投影、拉伸、meshopt 压缩          |
| `data/web/lowair_atmos/` | 23 个变量的 `.bin.br` 和 `manifest.json`（约 4.3 MB） |
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

每个变量按配置里的固定物理范围量化为 Uint8（`物理值 = 字节 × scale + offset`），`visibility` 先取 `log10`。`w` 从 41 个界面层平均到 40 个层中心。固定范围能保证不同时间步之间颜色含义一致。

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

浏览器需要支持 WebGL2 和 `EXT_color_buffer_float`（桌面端 Chrome、Edge、Firefox、Safari 17+ 都支持）。`?embed=1` 会隐藏控制面板；在 iframe 中运行时，组件会向父页面发送 `atmos:ready` 和 `atmos:probe` 消息。

### 交互

- 左键拖动旋转视角，右键平移，滚轮缩放，相机带阻尼。
- 鼠标按在垂直剖面上拖动可以平移剖面；按住 Shift 拖动，或拖剖面顶部的青色手柄，可以旋转剖面。
- 鼠标悬停时左上角显示探针廓线，双击固定探针。

### 控制面板参数

| 分组     | 参数                                                                                                                                                                                                                     |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 图层     | 建筑白膜开关、建筑不透明度、地面底图（近地面风速、2 米气温、能见度等 2D 变量，或纯色）、风粒子、体渲染（默认关闭，可选变量、不透明度、阈值、物理单位的“显示范围”双端滑块和可选“截面同步过滤”）；体渲染色带会标出当前窗口 |
| 粒子样式 | 粒子数量（4k–262k）、尾迹长度（2–64 步）、速度倍率、线宽（像素）、生命周期、不透明度、着色方式（按风速 / 按 w / 按高度 / 单色）、色带、高度下限和上限、w 垂直放大、尾迹收细、叠加发光、暂停                              |
| 水平切片 | 开关、变量（水平风速和全部 3D 变量）、高度（12.5–987.5 m 连续可调）、色带、自动或手动范围、不透明度、等值线条数                                                                                                          |
| 垂直剖面 | 开关、变量、位置偏移、方位角（0–180°）、色带、自动或手动范围、不透明度、等值线条数                                                                                                                                       |
| 视图     | 垂直夸张（1–10 倍）、建筑阴影、深色 / 浅色主题、总览 / 近景 / 俯视                                                                                                                                                       |

色带有 Glacier（粒子默认）、Viridis、Magma、Turbo、Cividis、Inferno、Blues，以及发散型 RdBu 和 Coolwarm。`w`、`u`、`v` 这类有正有负的变量默认用 RdBu，范围关于 0 对称。自动范围取 2%–98% 分位数（水平切片按当前高度层统计），极端值不会把颜色压扁。

## 架构

```
nc ─ ncpipe ─▶ data/web/*.bin.br ─ Worker 解压 ─▶ Uint8 Data3DTexture（每个变量只上传一次）
                                                 ├─ 切片 / 剖面：片元着色器 texture(sampler3D)
                                                 ├─ 粒子：RGBA8 风场纹理（u, v, w, |V|）
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
- **切片**（`slices.ts`）：片元着色器把片元的 root 局部坐标换算成 3D 纹理坐标后采样（高度层在层中心，所以纹理 r 坐标正好是 h / 1000 m），再反量化、查色带，等值线用 `fwidth` 做抗锯齿。开启“截面同步过滤”时，切片和剖面也会按体渲染的物理区间丢弃片元；这适合它们显示同一个变量或同单位变量。垂直剖面在 CPU 上按方位角和偏移把四个顶点裁剪到计算域内，每次拖动只更新 4 个顶点。
- **体渲染**（`volume.ts`）：每帧先把体和粒子隐藏，在带深度纹理的目标中渲染地面、建筑以及可见的水平切片和垂直剖面，再让光线步进在最近的不透明表面终止，白膜嵌在体里，墙前仍可见体雾、墙后体素被遮挡；切片不透明度低于 0.5 时不作为遮挡体。体盒从地面 0 m 开始，第一层中心为 12.5 m，半层由纹理坐标处理，顶部为 1000 m；建筑和体渲染共用 `root.scale.y` 的垂直夸张。
- **建筑**（`buildings.ts`）：`MeshStandardMaterial`，开启 flatShading，并通过 `onBeforeCompile` 把墙脚约 28 m 压暗，模拟环境光遮蔽；配合方向光阴影（4096² 阴影贴图）。
- **探针**：直接读内存中的 8 位数组（每次 40 个值），每帧最多做一次射线检测，只检测地面和切片，不检测 192 万个建筑三角形。
- `window.__atmosApi` 提供 `setView / setSection / setSlice / setParticles / setLayer / setVolume / setCamera / probeAt / advance / status`，供截图和录屏脚本调用（`web/scripts/screenshot.mjs`、`web/scripts/record.mjs`）。

## 生产部署

Vite 的 dev 和 preview 通过插件从 `../data/web` 提供 `/data/**`。`npm run build` 会把数据复制到 `dist/data`。nginx 示例：

```nginx
location /data/ {
    root /srv/atmos;
    location ~ \.bin\.br$ { types { application/octet-stream br; } add_header Content-Encoding br; }
    location ~ \.glb$ { types { model/gltf-binary glb; } gzip_static on; }
}
```

## 分支规划

`main` 保留原始数据，`three` 是本方案。`cesium` 等其他方案的分支可以复用 `pipeline/` 和 `data/web/`，只替换 `web/`。

## 已知限制

- 第三版去掉了 WebGPU/TSL 路径（第二版里 WebGPU 白屏，TSL 计算在 WebGL2 后端也跑不起来），现在只有 WebGL2 这一条路径。所有桌面浏览器都能运行，以后需要时可以再加 WebGPU compute 分支。
- 无头截图环境只有 SwiftShader 软件渲染，大约 1 FPS，测不出真实帧率。丝不丝滑需要在带 GPU 的机器上实测，状态栏会显示 FPS 和 draw call 数。
- 3D-GloBFP 的高度是模型估计值（论文报告 RMSE 1.9–14.6 m），没有 OSM 高度的超高层仍可能偏低。
- 风场是 8 位量化（u、v 的精度约 0.16 m/s），探针读的也是 8 位值。
- 粒子每帧走一步，所以尾迹的实际长度会随帧率变化。
- 建筑开启透明（不透明度小于 1）时，合并网格内部的三角形不排序，可能出现轻微的穿插。
- 建筑不透明度小于 1 时仍然写入深度；体光线会在墙面终止，所以不会透过半透明白膜看到墙后的体素。
