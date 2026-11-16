#!/usr/bin/env bash
# 选出 3.10 及以上的解释器。3.9 会在加载接口时因为 str | None 直接失败。

python_ok() {
  "$1" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
}

pick_python() {
  local candidate
  if [[ -n "${1:-}" ]]; then
    if python_ok "$1"; then
      echo "$1"
      return 0
    fi
    echo "虚拟环境是 $("$1" -V 2>&1)，需要 3.10 或更高。删掉该虚拟环境后重新运行 bin/install.sh。" >&2
    return 1
  fi
  for candidate in python3.13 python3.12 python3.11 python3.10 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 && python_ok "$candidate"; then
      command -v "$candidate"
      return 0
    fi
  done
  echo "需要 Python 3.10 或更高。当前能找到的 python3 太旧，接口起不来。" >&2
  return 1
}
