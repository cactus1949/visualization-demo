# 渲染宿主（ViewHost）与图层挂载

`AtmosViewer.vue` 只通过 `ViewHost` 接口使用渲染器、相机、相机控制、输入元素和渲染循环；图层、面板、时间轴、探针、剖面交互仍在组件里。目的：地球 tab 以后换一个宿主（Cesium），复用同一套图层逻辑。

## 文件

| 文件 | 内容 |
| --- | --- |
| `web/src/host/types.ts` | `ViewHost` 接口、`FrameHooks` 每帧回调类型 |
| `web/src/host/threeHost.ts` | `createThreeHost(canvas, { initialView?, initialNow? })`：现有 three.js 宿主（WebGLRenderer、PerspectiveCamera、OrbitControls、rAF 循环、ResizeObserver、Raycaster） |
| `web/src/components/AtmosViewer.vue` | 新增可选 prop `createHost?: (canvas) => ViewHost`，不传时用 `createThreeHost` |

## ViewHost

| 成员 | 作用 |
| --- | --- |
| `renderer: THREE.WebGLRenderer` | 图层用它建 GPU 资源（TimeFields、粒子 GPGPU、体渲染深度捕获） |
| `camera: THREE.PerspectiveCamera` | 世界坐标相机；标注、盒子排序、体渲染读取 |
| `element: HTMLCanvasElement` | 指针事件挂在它上面；标注层挂在它的父节点 |
| `size()` | CSS 像素尺寸 |
| `start(scene, hooks)` | 开始循环；每帧顺序固定：`beforeCamera` → 相机控制更新 → `afterCamera` → 渲染 `scene` → `afterRender`；尺寸变化先改 renderer / camera，再调 `hooks.resize(w, h)` |
| `raycaster(clientX, clientY)` | 返回已对准该屏幕点的射线（探针、剖面拖动、绘制） |
| `setCameraControl(on)` | 拖手柄 / 画框时关掉相机交互 |
| `setDrawMode(on)` | 绘制模式下左键让给绘制、右键旋转 |
| `capturePointer(id)` / `releasePointer(id)` | 拖动期间的指针捕获（未捕获时 release 是空操作） |
| `getView()` / `setView(pos, target)` | 相机位置和注视点（`snapshot()`、`setCamera`、视角预设、切 tab 保留视角都走这里） |
| `dispose()` | 停循环、断 ResizeObserver、释放控件和 renderer |

`FrameHooks`（组件提供）：`beforeCamera(now, dt, realDt)` 做 FPS 统计、指针处理、时间步进；`afterCamera` 做根节点夸张、标注更新、剖面材质 `setRoot`、粒子 `step(dt)`、体渲染深度捕获；`afterRender` 做首帧就绪；`resize(w, h)` 更新盒子分辨率和体渲染目标。

## 新宿主怎么接

实现 `ViewHost`，通过 `createHost` prop 传给 `AtmosViewer`：

```ts
<AtmosViewer :create-host="(canvas) => createMyHost(canvas)" />
```

Cesium 宿主的对应关系（计划，未实现）：`renderer` 用 Cesium 的 WebGL 上下文建 three 渲染器（同 `web/src/globe/overlay.ts`）；`start` 挂到 `scene.postRender`，用 RTC 相机同步代替 `controls.update()`，渲染后复位 Cesium 的 GL 状态缓存；`setCameraControl` 对应 `screenSpaceCameraController.enableInputs`；`getView/setView` 在 ENU 和 Cesium 相机之间换算；`element` 用 Cesium 的 canvas。

## 图层怎么挂

所有图层都是 `AtmosScene.root`（`web/src/render/scene.ts`）下的 `Object3D`，宿主只渲染 `scene`，不认识具体图层：

- 粒子：`new WindParticles(host.renderer, domain, …)`（`render/particles.ts`），`atmos.root.add(particles.object)`，每帧在 `afterCamera` 里 `particles.step(dt)`。
- 剖面 / 切片：`HorizontalSlice`、`AxisSection`、`PolylineSection`、`BoxStack`（`render/slices.ts`、`render/sections/planes.ts`、`polyline.ts`、`boxStack.ts`）的 `group` 加到 `atmos.root`；每帧 `material.setRoot(atmos.root)`；拖动 / 拾取用 `host.raycaster`；手柄和读数走 `AnnotationLayer(host.element.parentElement, atmos.root)`，每帧 `annotations.update(host.camera)`。
- 体渲染：`VolumeLayer` 的 `mesh` 加到 `atmos.root`，`captureDepth / update / resize` 用 `host.renderer` 和 `host.camera`。

在地球上，`atmos.root` 的局部坐标仍是现在的网格坐标；落到地球上的变换（`geo/mapping` 多项式、`globe/geoShader.ts`）属于 ④ 剖面 / ⑤ 粒子的工作，不在本接口里。
