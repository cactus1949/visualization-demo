# 按日导出与取数服务

环境变量（也可写在 `services/.env`）：

- `NC_ROOT` 默认 `/data/nc`，某天的 nc 放在 `$NC_ROOT/yyyymm/yyyymmdd/*.nc`
- `WEB_ROOT` 默认 `/data/web`，导出结果在 `$WEB_ROOT/yyyymm/yyyymmdd/`

以下命令都在仓库根目录运行。导出需要先装好 `pipeline/requirements.txt`：

```bash
python -m nc_export --date 20261111
```

取数接口：

```bash
pip install -r services/requirements.txt
uvicorn services.api:app --host 0.0.0.0 --port 8000
```

- `GET /api/health`
- `GET /api/days`
- `GET /data/202611/20261111/manifest.json` 以及同目录下的帧文件

前端把 `VITE_DATA_BASE` 设成接口地址（例如 `http://127.0.0.1:8000`），用 `?date=20261111` 打开对应天。

`.br` 帧文件带 `Content-Encoding: br` 返回，浏览器自动解压。`/data/nc`、`/data/web` 不在仓库内，需要自己建好目录或改环境变量。
