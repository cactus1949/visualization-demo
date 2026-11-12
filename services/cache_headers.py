"""Cache-Control values for exported web payloads."""

from __future__ import annotations

import re
from pathlib import PurePosixPath

IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
MANIFEST_CACHE = "no-cache"

# Frame directories are t000, t001, ...; files written there never change for a given day.
_FRAME_DIR = re.compile(r"^t\d{3}$")


def _in_frame_dir(p: PurePosixPath) -> bool:
    return bool(_FRAME_DIR.match(p.parent.name))


def cache_control_for(path: str) -> str | None:
    """Long cache for frame payloads and their index json; manifest is revalidated."""
    p = PurePosixPath(str(path).replace("\\", "/"))
    if p.name == "manifest.json":
        return MANIFEST_CACHE
    if p.name.endswith(".bin.br") or p.name.endswith(".sz3pack"):
        return IMMUTABLE_CACHE
    if p.name.endswith(".json") and _in_frame_dir(p):
        return IMMUTABLE_CACHE
    return None
