# 线上目录

解压到 `/opt/atmos-viz`（nginx 和 systemd 单元按这个路径写的）。程序和数据在同一棵目录里，数据以后可以挪走，只改 `.env`。

```
frontend/          前端静态文件（vite dist）
services/          接口。bin/serve.sh 只起这个
pipeline/          按日导出用的处理代码
nc_export/         导出命令入口（python -m nc_export）
data/web/          处理后的数据。current/、sz3/、buildings/、geo/
```

原始 nc 不在包里。`NC_ROOT` 默认 `./data/nc`，`bin/install.sh` 会建这个空目录，把文件放到服务器上再导出。

接口和管线分进程、分虚拟环境。导出会用到 `services/formats/`，所以管线代码和接口代码放在同一份程序根下，不要拆成两个互找不到的目录。

需要 Python 3.10 或更高（`bin/install.sh` 会自己找）。系统里的 `python3` 如果是 3.9，接口会在启动时失败。已 `conda activate` 时，脚本用 `venv --copies` 建环境；默认的符号链接会让 pip 装进 conda base，接口里就没有 uvicorn。前端构建时已经写进天地图 key，服务器上不用再配。

## 第一次

```bash
cd /opt/atmos-viz
bin/install.sh
bin/serve.sh          # 或装 systemd：见文末
```

nginx 使用旁边的 `nginx.conf`：页面走 `frontend/`，`/api/` 和 `/data/` 反代到 `127.0.0.1:8000`。`.br` 的 `Content-Encoding` 由接口加，不要改成 nginx 直接读 `data/web`。用 IP 走 HTTP 时浏览器通常只声明 `gzip, deflate`，接口把 `.br` 解开后再用 gzip 返回。

打开 `http://服务器/?format=sz3`。`data/web` 里已经有导出时，不带日期会打开最新一天。

## 自签 HTTPS

证书按浏览器地址栏里的 IP 或域名来签。私钥留在服务器的 `certs/`，不要拷进仓库。

```bash
cd /opt/atmos-viz
bin/self-signed.sh 203.0.113.10
# 用 nginx.https.conf 换掉正在生效的站点配置，不要和原来的 80 配置并存
nginx -t && systemctl reload nginx
```

把 `203.0.113.10` 换成浏览器地址栏里的 IP。然后打开 `https://这个地址/?format=sz3`。浏览器会警告证书不受信任，选继续访问。这条连接是 HTTPS 之后，浏览器会声明 `br`，接口直接回 Brotli。80 端口仍然可用，那种请求走 gzip。安装目录不是 `/opt/atmos-viz` 时，同时改 `nginx.https.conf` 里的证书路径和 `root`。

## 再导一天

原始 nc 放到 `$NC_ROOT/yyyymm/yyyymmdd/*.nc`（默认 `data/nc/`），然后：

```bash
bin/export-day.sh --date 20261111 --format all
```

`--format current` 或 `--format sz3` 只导一种。SZ3 单帧峰值大约 2 GB 内存，按 CPU 和内存并行。写到同级临时目录，完成后再替换，导到一半旧数据还在。

建筑白膜和地球页地理底座不在按日导出里，已经在 `data/web/buildings/` 和 `data/web/geo/`。要重做时再装 `requirements-buildings.txt`、`requirements-geo.txt`，命令见仓库 `pipeline/README.md`。

## systemd

```bash
cp atmos-viz.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now atmos-viz
```

安装路径不是 `/opt/atmos-viz` 时，同时改 `atmos-viz.service` 和 `nginx.conf`。
