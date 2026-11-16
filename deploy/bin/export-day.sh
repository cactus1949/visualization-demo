#!/usr/bin/env bash
# 按日导出，和接口进程分开跑。
#   bin/export-day.sh --date 20261111 --format all
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# NC_ROOT / WEB_ROOT 由 nc_export 自己读 .env，已有环境变量不会被盖掉。

# shellcheck disable=SC1091
source "$ROOT/bin/common.sh"
if [[ -x .venv-pipeline/bin/python ]]; then
  PY=$(pick_python .venv-pipeline/bin/python)
else
  PY=$(pick_python)
fi

exec "$PY" -m nc_export "$@"
