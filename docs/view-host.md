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
| `getView()` / `setView(pos, target)` | 相机位置和注视点（`snapshot()`、`setCamera`、视角预设、切 tab 保留视角都走这里） |
| `dispose()` | 停循环、断 ResizeObserver、释放控件和 renderer |

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
- `setCameraControl` 对应 `screenSpaceCameraController.enableInputs`；`setDrawMode` 为空操作；`getView / setView` 在 ENU 单位和 Cesium 相机之间换算。
- `dispose` 只释放宿主自己的对象和 three 渲染器，Viewer 由 `GlobeViewer.vue` 在图层卸载之后销毁。

## 图层怎么挂

所有图层都是 `AtmosScene.root`（`web/src/render/scene.ts`）下的 `Object3D`，宿主只渲染 `scene`，不认识具体图层：

- 粒子：`new WindParticles(host.renderer, domain, …)`（`render/particles.ts`），`atmos.root.add(particles.object)`，每帧在 `afterCamera` 里 `particles.step(dt)`。
- 剖面 / 切片：`HorizontalSlice`、`AxisSection`、`PolylineSection`、`BoxStack`（`render/slices.ts`、`render/sections/planes.ts`、`polyline.ts`、`boxStack.ts`）的 `group` 加到 `atmos.root`；每帧 `material.setRoot(atmos.root)`；拖动 / 拾取用 `host.raycaster`；手柄和读数走 `AnnotationLayer(host.element.parentElement, atmos.root)`，每帧 `annotations.update(host.camera)`。
- 体渲染：`VolumeLayer` 的 `mesh` 加到 `atmos.root`，`captureDepth / update / resize` 用 `host.renderer` 和 `host.camera`。

在地球上，`atmos.root` 是单位矩阵，局部坐标就是中心 ENU（单位 `map.enu_unit_m`）。体渲染用弯壳模式（`new VolumeLayer(domain, curvedOptions)`）；剖面、粒子仍是盒坐标，在地球 tab 上暂时关闭，由 ④ / ⑤ 用 `globe/geoShader.ts` 的 `geoPlace` / `geoInverse` 接上。
