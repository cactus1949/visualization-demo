# 天津低空大气三维可视化

## 项目简介

`three` 分支提供 Vue 3、three.js 0.187 和 TSL 实现的低空大气浏览器可视化。体数据使用 `VolumeNodeMaterial` 的真实盒体射线步进，风场粒子使用 TSL storage buffer 计算内核；同一组件在 WebGPU 和 WebGL2 后端运行。

## 目录结构

`pipeline/` 是与渲染器无关的 NetCDF 处理包，`data/web/lowair_atmos/` 保存 manifest 与默认 8 位 Brotli 文件，`web/` 是 three.js 渲染器。其他渲染方案分支可以复用 pipeline 和 data/web，只替换 web 目录。

## 数据处理管线

```bash
PYTHONPATH=pipeline /workspace/.venv-nc/bin/python -m ncpipe build \
  --input data/lowair_atmos.nc \
  --config pipeline/config/variables.yaml \
  --out data/web/lowair_atmos
```

每个变量使用配置中的固定物理范围，按 `round((x-offset)/scale)` 量化为 Uint8；`--bits16 u v w tke icing_index` 会额外生成小端 Uint16 文件（这些可选文件被 `.gitignore` 忽略）。`visibility` 在量化前存储 `log10(m)`。manifest 记录网格、单位、缩放、实际数据范围、NaN、裁剪比例、原始和压缩字节数；`w` 从 zf 接口层相邻平均到 z 层中心。固定范围保证不同时间步的颜色含义一致。

默认生成的 23 个变量共约 44.19 MB 原始、4.34 MB Brotli 压缩数据，生成耗时约 3.8 秒；8 位文件已放在 data/web。重新生成会覆盖它们。

## 前端运行

```bash
cd web
npm install
npm run dev
npm run typecheck
npm run build
npm run format
npx vite preview --port 4173 --strictPort
```

支持 WebGPU 的浏览器会使用 WebGPU；`?webgl=1` 强制 WebGL2 后端。浏览器至少需要 WebGL2。`?embed=1` 隐藏面板，iframe 父页面可以发送 `postMessage({type:'setVolumeVar'|'setSurfaceVar'|'setParticles', value})`。

## 架构

数据流为 `nc → pipeline → data/web → Worker → Uint8 纹理 → TSL 体渲染、粒子和切片`。`AtmosViewer.vue` 负责资源生命周期、OrbitControls、控制面板、探针和事件；渲染模块位于 `web/src/render/`，数据加载位于 `web/src/data/`。体渲染从盒体相交的相机射线开始，沿射线采样 3D 纹理、应用色带和窗口阈值并进行前向合成。粒子在 WebGPU 使用 `instancedArray` 位置和年龄缓冲，计算内核从打包 RGBA 风场采样；不支持计算的 WebGL2 环境报告 `粒子: CPU (降级)`，并保留可见的移动降级路径。

## 生产部署

开发服务器和 preview 通过 Vite 插件从 `../data/web` 提供 `/data/**`，不会复制整个仓库。生产 nginx 可以直接提供预压缩文件：

```nginx
location /data/ {
    root /srv/atmos;
    types { application/octet-stream bin; }
    gzip_static on;
    add_header Content-Encoding br;
}
```

## 分支规划

`main` 保留原始数据，`three` 使用本方案，`cesium` 等分支复用 pipeline 与 data/web，只替换前端渲染层。

## 已知限制

WebGL2 后端的 three.js TSL 计算能力取决于浏览器后端；检测到不支持时会明确显示 CPU 降级路径。8 位纹理是有损量化，探针优先使用内存中的 8 位值，存在可选 Uint16 文件时可由上层扩展读取。体渲染关闭深度写入并按固定渲染顺序绘制，复杂透明物体的排序仍受限于实时图形管线。无 WebGPU 的浏览器无法使用 GPU 粒子计算，但仍可查看体、切片、地面和降级粒子。
