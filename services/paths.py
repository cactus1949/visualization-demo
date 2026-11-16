"""Shared path helpers for the day-export job and the small data API."""
from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_NC_ROOT = "/data/nc"
DEFAULT_WEB_ROOT = "/data/web"


def load_dotenv() -> None:
    for path in (Path(__file__).parent / ".env", REPO_ROOT / ".env"):
        if not path.is_file():
            continue
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip("'").strip('"')
            if key:
                os.environ.setdefault(key, value)


def parse_date(text: str) -> tuple[str, str]:
    digits = text.replace("-", "").replace("/", "")
    if len(digits) != 8 or not digits.isdigit():
        raise ValueError(f"date must be YYYYMMDD, got {text!r}")
    return digits[:6], digits


def env_path(name: str, default: str) -> Path:
    return Path(os.environ.get(name, default)).expanduser()


def nc_root() -> Path:
    return env_path("NC_ROOT", DEFAULT_NC_ROOT)


def web_root() -> Path:
    return env_path("WEB_ROOT", DEFAULT_WEB_ROOT)


def day_dir(root: Path, yyyymm: str, yyyymmdd: str) -> Path:
    return root / yyyymm / yyyymmdd
