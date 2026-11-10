# 三维标注样式（annotation style）

三维场景里的探针、剖面拖动手柄、折线顶点、层高标签，一律走 `web/src/render/annotations/` 这一套标注层，不要再各自做球体、胶囊、Sprite 或 canvas 贴图。功能代码只声明「标什么、锚点在哪」；尺寸、颜色、状态和投影都由标注层统一处理。

坐标系与场景其余部分相同：锚点是 root 局部坐标，单位 km，x 向东、z 向南、y 为真实高度。垂直夸张只作用在 `root.scale.y` 上。标注在投影到屏幕之后按 CSS 像素定尺寸，因此不会被垂直夸张拉成椭圆，也不会跟着框选拉伸变成大块。

## 模块 API

```ts
import { AnnotationLayer, ANNOTATION_TOKENS } from "../render/annotations";

const layer = new AnnotationLayer(overlayParent, atmos.root);

layer.addMarker(id, { anchor, role: "preview" | "fixed", stemTo?, ring? });
layer.addLabel(id, { anchor, text, leader?, awayFrom?, priority? });
layer.addHandle(id, { anchor, role?, draggable, userData });

layer.set(id, patch);
layer.setState(id, "idle" | "hover" | "active" | "dragging" | "disabled" | "selected");
layer.setVisible(id, on);
layer.remove(id);
layer.removePrefixed(prefix);

layer.update(camera);            // 每帧调用一次，相机和 root 矩阵更新之后
layer.pick(clientX, clientY);    // 手柄命中：20 px 热区，不依赖三维网格
layer.setOccluder(heightField, enabled);
layer.dispose();
```

新增任何三维标注都走上面这些方法。不要在功能模块里新建 `THREE.Sprite`、`SphereGeometry` 或 canvas 纹理当文字用。

## Token（必须使用这些值）

来源：`web/src/render/annotations/tokens.ts`（`ANNOTATION_TOKENS`）。

### 颜色

标注必须能从 viridis、glacier 等色带上分辨出来，不要用纯绿或纯蓝。

| 用途 | 值 |
| --- | --- |
| 预览 / 悬停 | `#5CE1FF` |
| 固定 / 激活 | `#FFC247` |
| 选中描边 | `#FFFFFF` |
| 禁用 | `#8A97A3` |
| 标签文字 | `#F4FBFF` |
| 标签背景 | `rgba(8, 14, 22, 0.60)` |
| 标签边框 | `rgba(255, 255, 255, 0.18)` |
| 竖杆 / 引线 | `rgba(244, 251, 255, 0.70)` |

### 尺寸（CSS 像素，不随缩放或垂直夸张变化）

| 用途 | 值 |
| --- | --- |
| 标记直径 | `8 px`（允许 6–10） |
| 手柄直径 | `11 px`（允许 10–12） |
| 手柄热区 | `20 px` |
| 竖杆 / 引线宽 | `1.5 px` |
| 地面圆环 | 投影直径 `12 px`，描边 `1.5 px`，无填充 |
| 标签字号 | `11 px`（允许 11–12） |
| 标签内边距 | `2 px 6 px` |
| 标签边框 | `1 px` |
| 标签圆角 | 全圆胶囊（`999 px`） |
| 选中描边 | `2 px` |
| 悬停缩放 | `1.15` |
| 拖动缩放 | `1.25`（上限） |
| 默认引线 | `12 px` |

### 透明度

| 状态 | 值 |
| --- | --- |
| 常规标记 / 手柄 | `1.0` |
| 预览标记 | `0.85` |
| 被遮挡 | `0.35` |
| 禁用 | `0.40` |
| 标签背景 | `0.60` |

### 字体

与界面一致：`Inter, ui-sans-serif, system-ui, "Noto Sans SC", sans-serif`；字重 `500`；行高 `1.2`；数字用 `tabular-nums`。标签必须带单位，例如 `112.5 m`。

## 几何：三维里只留很轻的线

- **探针**：从地面 `(x, 0, z)` 到顶面 `(x, top, z)` 画 1.5 px 屏幕空间竖杆，地面加一个 12 px 的圆环。预览用青色，固定用琥珀色。不要球体或粗圆柱。
- **层高标签**：HTML 胶囊，短引线连到该层在屏幕上的角点（用拉伸和层间距之后的显示高度）。不要 canvas 贴图 Sprite。
- **手柄 / 折线顶点**：11 px 的 HTML 圆，20 px 热区。不要三维球体。

## 状态

`idle`、`hover`、`active`、`dragging`、`disabled`、`selected`。状态变化只改描边、缩放（不超过 1.25）和透明度，以及可拖动手柄的光标（`grab` / `grabbing`）。

- 预览 / 悬停 → 青色
- 固定 / 激活 / 拖动 → 琥珀色
- 选中 → 在语义色填充上加 2 px 白描边
- 禁用 → 灰色，透明度 0.40，不可点

## 遮挡与重叠

锚点落在建筑或地面之后时，整条标注淡到约 35%，不要直接消失。遮挡检测必须便宜：对建筑使用粗高度场（`HeightOccluder`），不要每帧对 192 万个三角形做射线检测，也不要每帧 `readPixels`。半透明的体和剖面不应把标签完全隐去。

框选层高标签如果在屏幕上重叠，沿引线把优先级较低的标签（较矮或较远）稍稍推开；实在让不开再隐藏。在屏幕外或相机背后的标注要摘掉。

## 性能

目标 60 FPS。复用 DOM 节点，不要在 `update()` 里分配新对象或重建 innerHTML。投影位移小于 0.5 px 且状态未变时，应避免无谓的样式写入（实现上以 transform 字符串更新为主，尽量保持廉价）。遮挡检测按相机运动节流。

## 现有交互必须保持

探针开关、悬停预览、单击固定（移动小于 5 px）、跟随鼠标；折线左键加点 / 拖顶点，第二个点出现墙；框选拖拽；经度 / 纬度拖动手柄；绘制模式下右键旋转；Esc 退出。手柄命中走 `layer.pick`，不要再依赖会被拉长的三维拾取体。
