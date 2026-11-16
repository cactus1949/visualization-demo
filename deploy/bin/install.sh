#!/usr/bin/env bash
# 在服务器上装两套虚拟环境：接口一套，按日导出一套。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
# shellcheck disable=SC1091
source "$ROOT/bin/common.sh"
PY=$(pick_python)

# conda 激活时 python 是符号链接。venv 默认也做链接，pip 会装进 base，
# 虚拟环境里就找不到 uvicorn。--copies 让环境带上自己的解释器。
make_venv() {
  local dest=$1
  local req=$2
  rm -rf "$dest"
  "$PY" -m venv --copies "$dest"
  env -u PYTHONPATH -u PYTHONHOME "$dest/bin/python" -m pip install -U pip
  env -u PYTHONPATH -u PYTHONHOME "$dest/bin/python" -m pip install -r "$req"
}

make_venv .venv-server requirements-server.txt
make_venv .venv-pipeline requirements-pipeline.txt

mkdir -p "${ROOT}/data/nc" "${ROOT}/data/web"
echo "installed: .venv-server  .venv-pipeline"
