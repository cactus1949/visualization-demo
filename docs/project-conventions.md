# 项目约定

通用原则见根目录 `AGENTS.md`，这里只写本项目自己的约定。

## 模块拆分

- 读 nc、网格和时间轴是共用部分（`pipeline/ncpipe/ncread.py`），两种格式都依赖它，它不依赖任何一种格式。
- `current` 和 `sz3` 两种格式各自独立：导出、接口目录（`$WEB_ROOT/<格式>/yyyymm/yyyymmdd/`）、前端入口和解码器都分开，互不引用。
- 任一格式都要能单独删除，删掉后另一种照常导出、构建和渲染。要删哪些文件见 `services/README.md`。新增格式时同步更新那份清单。

## 重点测试的行为

- 导出命令：`--date` 解析和非法日期、输入输出目录的拼法、`--format current|sz3|all` 只写对应目录、临时目录改名替换的原子性。
- 编解码：每个变量解码后的误差不超过约定上限；派生变量超限时自动改为存储。
- 时间轴：播放跨整点时，下一帧没到就停在整点等待缓冲，不跳帧、不卡死。
- 接口：已导出的日期返回 200，没导出的返回 404；`.br` 文件带 `Content-Encoding: br`。

## 需要同步维护的文档

- `README.md`：项目说明和运行方式。
- `pipeline/README.md`：数据管线。
- `services/README.md`：环境变量、导出命令、接口、删除某种格式的清单。
- `docs/state-model.md`：前端状态模型。
- `docs/annotation-style.md`：三维标注样式。
- `docs/volume-section-consistency.md`：体渲染和剖面的一致性约定。

## 提交规矩

- 默认先截图给 Jayden 看，确认后再 push；Jayden 明确说直接推的除外。
- 提交作者：`Jayden <djjff1102@gmail.com>`。
- nc 文件、导出结果、编译中间产物不进 git（已写在 `.gitignore`）。
