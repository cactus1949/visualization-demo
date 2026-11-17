# 渲染宿主（ViewHost）与图层挂载

`AtmosViewer.vue` 只通过 `ViewHost` 接口使用渲染器、相机、相机控制、输入元素和渲染循环；图层、面板、时间轴、探针、剖面交互仍在组件里。目的：地球 tab 以后换一个宿主（Cesium），复用同一套图层逻辑。

## 文件

| 文件 | 内容 |
| --- | --- |
| `web/src/host/types.ts` | `ViewHost` 接口、`FrameHooks` 每帧回调类型 |
| `web/src/host/threeHost.ts` | `createThreeHost(canvas, { initialView?, initialNow? })`：前两个 tab 的 three.js 宿主（WebGLRenderer、PerspectiveCamera、OrbitControls、rAF 循环、ResizeObserver、Raycaster） |
| `web/src/host/rendererConfig.ts` | `applyLayerRendererConfig(renderer)`：两个宿主共用的外观（sRGB 输出、Neutral 色调映射、曝光 1）。阴影走同一条 PCF 路径：`applyLayerRendererConfig` 里打开 `shadowMap`（⑥ 建筑接入后两个宿主共用，不再各开一条） |
| `web/src/host/hidden.ts` | `withHidden(objects, draw)`：深度预渲染时临时隐藏一组对象 |
| `web/src/globe/overlay.ts` | `GlobeOverlay`：Cesium 宿主（地球 tab） |
| `web/src/components/AtmosViewer.vue` | 可选 prop `createHost?: (container) => ViewHost`（传入组件根 `div`，宿主自己决定 `element`），不传时用 `createThreeHost(组件自己的 canvas)`；`globeVolume` 不为空时是地球模式 |

## ViewHost

| 成员 | 作用 |
| --- | --- |
| `renderer: THREE.WebGLRenderer` | 图层用它建 GPU 资源（TimeFields、粒子 GPGPU、体渲染深度捕获） |
| `camera: THREE.PerspectiveCamera` | 世界坐标相机；标注、盒子排序、体渲染读取 |
| `element: HTMLCanvasElement` | 指针事件挂在它上面（组件卸载时对同一个元素对称移除 5 个监听）；标注层挂在 `element.parentElement` |
| `depthEncoding` | 遮挡深度的编码：`linear`（NDC z）或 `log`（three `logarithmicDepthBuffer`） |
| `captureOccluderDepth(target, scene, hide)` | 把遮挡物深度画进体渲染的深度目标：`scene` 去掉 `hide`（体渲染自身、粒子、剖面等），Cesium 宿主还先画地形代理 |
| `size()` | CSS 像素尺寸 |
| `start(scene, hooks)` | 开始循环；每帧顺序固定：`beforeCamera` → 相机控制更新 → `afterCamera` → 渲染 `scene` → `afterRender`；尺寸变化先改 renderer / camera，再调 `hooks.resize(w, h)` |
| `raycaster(clientX, clientY)` | 返回已对准该屏幕点的射线（探针、剖面拖动、绘制） |
| `setCameraControl(on)` | 拖手柄 / 画框时关掉相机交互 |
| `setDrawMode(on)` | 绘制模式下左键让给绘制、右键旋转 |
| `capturePointer(id)` / `releasePointer(id)` | 拖动期间的指针捕获（未捕获时 release 是空操作） |
| `getView()` / `setView(pos, target)` | 相机位置和注视点（`snapshot()`、`setCamera`、视角预设、切 tab 保留视角、右下角复位都走这里） |
| `zoomBy(scale)` | 距离乘 `scale`（小于 1 靠近）。盒体夹在轨道控件的最近/最远距离；地球沿视线按屏幕中心到地表的距离走，最近 80 m |
| `faceNorth()` | 地理北朝屏幕上方，注视点和俯仰不变。盒体把相机挪到注视点正南；地球绕屏幕中心地表点转航向 |
| `dispose()` | 停循环、断 ResizeObserver、释放控件和 renderer |
| `isolateGl?(work)` | 可选。图层在绘制 pass 之外做的 GL 工作（粒子模拟 / 放置 pass、调试读回）放进来；Cesium 宿主前后 `resetState()` 并复位 Cesium 的状态缓存，盒体宿主不实现，调用方直接执行 |

`FrameHooks`（组件提供）：`beforeCamera(now, dt, realDt)` 做 FPS 统计、指针处理、时间步进；`afterCamera` 做根节点夸张（地球上不设，夸张走 `uGeoK`）、标注更新、剖面材质 `setRoot`、粒子 `step(dt)`、体渲染深度捕获（`host.captureOccluderDepth`）；`afterRender` 做首帧就绪；`resize(w, h)` 更新盒子分辨率和体渲染目标。

## 新宿主怎么接

实现 `ViewHost`，通过 `createHost` prop 传给 `AtmosViewer`：

```ts
<AtmosViewer :create-host="(container) => createMyHost(container)" />
```

## Cesium 宿主（`GlobeOverlay`）

- `renderer` 建在 Cesium 的 WebGL 上下文上（`context._gl`），`autoClear = false`，不调 `setSize`：画布尺寸和像素比归 Cesium，宿主每帧比较 CSS 尺寸，变了才调 `hooks.resize`。
- 每帧在 `scene.postRender` 里：`beforeCamera` → RTC 相机同步（代替 `controls.update()`）→ `afterCamera` → 清深度、画只写深度的地形代理、宿主自己的测试图层、图层场景 → `afterRender` → `resetState()` 并把 Cesium 缓存的渲染状态设回默认。
- 帧外 GL：数据回调里的 TimeFields 上传 / 混合不在 `postRender` 里，所以 `scene.preRender` 上也做一次 `resetState()` + 复位 Cesium 缓存，Cesium 每帧开始时都按真实 GL 状态重设。
- 相机：`matrixAutoUpdate` 和 `matrixWorldAutoUpdate` 都关掉，RTC 同步写 `matrixWorld`，同时分解进 `position / quaternion`（体渲染用 `camera.position` 当光线起点）。`afterCamera` 里的 `camera.updateMatrixWorld()` 因此不会覆盖它。near / far 只由宿主按图层包围球设置，钩子不改。
- `setCameraControl` 对应 `screenSpaceCameraController.enableInputs`；`setDrawMode` 为空操作；`getView / setView` 在 ENU 单位和 Cesium 相机之间换算。`zoomBy` 用 `camera.zoomIn / zoomOut`；`faceNorth` 对屏幕中心的地表交点 `lookAt` 到航向 0，再 `lookAtTransform(IDENTITY)` 解开锁定。
- `dispose` 只释放宿主自己的对象和 three 渲染器，Viewer 由 `GlobeViewer.vue` 在图层卸载之后销毁。

## 图层怎么挂

所有图层都是 `AtmosScene.root`（`web/src/render/scene.ts`）下的 `Object3D`，宿主只渲染 `scene`，不认识具体图层：

- 粒子：`new WindParticles(host.renderer, domain, …)`（`render/particles.ts`），`atmos.root.add(particles.object)`，每帧在 `afterCamera` 里 `particles.step(dt)`。
- 剖面 / 切片：`HorizontalSlice`、`AxisSection`、`PolylineSection`、`BoxStack`（`render/slices.ts`、`render/sections/planes.ts`、`polyline.ts`、`boxStack.ts`）的 `group` 加到 `atmos.root`；每帧 `material.setRoot(atmos.root)`；拖动 / 拾取用 `host.raycaster`；手柄和读数走 `AnnotationLayer(host.element.parentElement, atmos.root)`，每帧 `annotations.update(host.camera)`。
- 体渲染：`VolumeLayer` 的 `mesh` 加到 `atmos.root`，`captureDepth / update / resize` 用 `host.renderer` 和 `host.camera`。

在地球上，`atmos.root` 是单位矩阵，局部坐标就是中心 ENU（单位 `map.enu_unit_m`）。体渲染用弯壳模式（`new VolumeLayer(domain, curvedOptions)`）；剖面仍是盒坐标，在地球 tab 上暂时关闭，由 ④ 用 `globe/geoShader.ts` 的 `geoPlace` / `geoInverse` 接上；粒子（⑤）的模拟仍在网格空间，绘制时放到弯曲壳体上，见 `docs/globe-geo.md`「粒子（⑤）」。

## 帧预算

`render/frameBudget.ts` 按最近稳态帧的 p95 在五档之间升降，有降档后 5 秒内不回升、升档后 1 秒内不降的滞回。启动、打开体渲染、相机跳转和上下文恢复后的半秒记为尖峰，不进入 p95。滑条、色标、阈值和图层开关不改；界面左下角只显示当前生效的绘制预算。上一版没有把地球画布分辨率放进预算，只改了 MSAA 和地形误差，所以拖动地球时底图仍按满分辨率画。现在最低档还会把 `resolutionScale` 降到 0.67，并在帧时间允许时回到 1。阴影最低档不画阴影通道，勾选保持。遮挡预通道改用深度材质（地球白膜用已有的放置深度材质），不再把光照着色器跑第二遍。左下角「导出诊断」把 SHA、分辨率、实际体缓冲和步数、预算历史下载到本机，不上传。

体渲染画进与预算同分辨率的离屏目标，再合成到主画面。相机每一帧都重画当前视角，不复用上一帧。遮挡预通道用同一分辨率，材质仍是原来的（地球放置和对数深度不变），只关掉颜色写出，阴影留到主通道。尾迹用 `setRenderTrailDivisor` 少画段数，不重新分配历史缓冲。盒体像素比从 1 起，测得快可以回到 2；抗锯齿仍在创建上下文时打开。地球 `msaaSamples` 从 1 起、屏幕空间误差从 6 起，都可以加回去。OIT 保持关闭。

30 FPS 是验收线，不是这一档算通过。`web/scripts/frame-budget-check.mjs` 在指定页面上采样 p50/p95/p99、超过 33.3 ms 的比例、尖峰和上下文丢失次数，并写明浏览器渲染器。软件渲染的结果不能当成 GT730。

诊断里的 `p50` 是 rAF 间隔，不是帧率；`callbackHz` 是窗口内回调次数。`cpuSubmitMs` 在 GPU 完成前就返回，体积通道接近 0 不表示体渲染免费。`spikes[].kind` 是抑制窗原因，`levelHistory` 才是档位变化。`buildingTriangles` 为 0 表示白膜还没进场景。相机和遮挡物都没变时跳过遮挡深度预通道（`depthReused`），体颜色仍每帧按当前视角重画。`resources` 记录 dem、白膜、GlobeViewer 和 wasm 的 Resource Timing；`transferSize` 为 0 多半是跨域没给 Timing-Allow-Origin。

`dem.u16.bin.br` 在勾选「地形（自建 DEM）」之前不下载。风速「地面」和这张 DEM 不是同一层。线上静态资源的 Cache-Control 和 wasm 的 Content-Type 仍是部署配置，这一版没有改服务器。
