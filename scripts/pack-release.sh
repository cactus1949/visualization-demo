#!/usr/bin/env bash
# 打线上包到 release/atmos-viz-YYYYMMDD/，并打同名 tar.gz。
# 内容：frontend dist、接口、管线、data/web。原始 nc 不进包。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
STAMP=$(date +%Y%m%d)
NAME="atmos-viz-${STAMP}"
DEST="$ROOT/release/$NAME"
NODE22="${NODE22:-$HOME/.nvm/versions/node/v22.22.3/bin}"

if [[ ! -x "$NODE22/node" ]]; then
  echo "找不到 Node 22：$NODE22" >&2
  exit 1
fi
if [[ ! -d "$ROOT/data/web/buildings" || ! -d "$ROOT/data/web/geo" ]]; then
  echo "缺少 data/web/buildings 或 data/web/geo" >&2
  exit 1
fi

# 用 Node 22 跑构建。不走 pnpm run：换了 Node 版本时 pnpm 会想删掉 node_modules。
export PATH="$NODE22:$PATH"
if [[ ! -x "$ROOT/web/node_modules/.bin/vite" ]]; then
  echo "web/node_modules 不完整，先在 web/ 里执行 pnpm install" >&2
  exit 1
fi

cd "$ROOT/web"
echo "node $(node -v)"
# package.json 的 build 会先跑 vue-tsc。当前 vue-tsc 3.3 读不了 TypeScript 7，类型检查过不去。
# 线上包只需要 vite 的生产构建。
"$ROOT/web/node_modules/.bin/vite" build

rm -rf "$DEST"
mkdir -p "$DEST/bin"

# 生产数据只放 data/web，由接口提供。dist 里那份复制的 data 不带上。
rsync -a --exclude 'data/' "$ROOT/web/dist/" "$DEST/frontend/"

rsync -a \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude 'tests/' \
  --exclude '.pytest_cache/' \
  --exclude '.env' \
  "$ROOT/services/" "$DEST/services/"

rsync -a \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  --exclude 'tests/' \
  --exclude '.pytest_cache/' \
  "$ROOT/pipeline/" "$DEST/pipeline/"

rsync -a \
  --exclude '__pycache__/' \
  --exclude '*.pyc' \
  "$ROOT/nc_export/" "$DEST/nc_export/"

mkdir -p "$DEST/data"
rsync -a --exclude '.DS_Store' --exclude '.*tmp*' "$ROOT/data/web/" "$DEST/data/web/"

cp "$ROOT/deploy/README.md" "$DEST/README.md"
cp "$ROOT/deploy/nginx.conf" "$DEST/nginx.conf"
cp "$ROOT/deploy/nginx.https.conf" "$DEST/nginx.https.conf"
cp "$ROOT/deploy/atmos-viz.service" "$DEST/atmos-viz.service"
cp "$ROOT/deploy/requirements-server.txt" "$DEST/requirements-server.txt"
cp "$ROOT/deploy/requirements-pipeline.txt" "$DEST/requirements-pipeline.txt"
cp "$ROOT/pipeline/requirements-geo.txt" "$DEST/requirements-geo.txt"
cp "$ROOT/pipeline/requirements-buildings.txt" "$DEST/requirements-buildings.txt"
cp "$ROOT/deploy/env.example" "$DEST/.env"
cp "$ROOT/deploy/env.example" "$DEST/env.example"
cp "$ROOT/deploy/bin/common.sh" "$ROOT/deploy/bin/install.sh" "$ROOT/deploy/bin/serve.sh" "$ROOT/deploy/bin/export-day.sh" "$ROOT/deploy/bin/self-signed.sh" "$DEST/bin/"
chmod +x "$DEST/bin/"*.sh

tar -C "$ROOT/release" -czf "$ROOT/release/${NAME}.tar.gz" "$NAME"

echo "目录  $DEST"
echo "压缩包  $ROOT/release/${NAME}.tar.gz"
du -sh "$DEST" "$ROOT/release/${NAME}.tar.gz"
