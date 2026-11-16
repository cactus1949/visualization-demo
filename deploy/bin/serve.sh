#!/usr/bin/env bash
# 只提供 /api 和 /data。前端静态文件由 nginx 从 frontend/ 发。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"

# 已经导出的变量优先。.env 只补缺省，和 Python 里的 load_dotenv 一致。
if [[ -z ${PORT:-} && -f .env ]]; then
  line=$(grep -E '^[[:space:]]*PORT=' .env | tail -n 1 || true)
  PORT=${line#*=}
  PORT=${PORT//\"/}
  PORT=${PORT//\'/}
fi

# shellcheck disable=SC1091
source "$ROOT/bin/common.sh"
if [[ -x .venv-server/bin/python ]]; then
  PY=$(pick_python .venv-server/bin/python)
else
  PY=$(pick_python)
fi

exec "$PY" -m uvicorn services.api:app --host 127.0.0.1 --port "${PORT:-8000}"
