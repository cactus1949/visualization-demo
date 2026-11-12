"""Cache-Control values for exported web payloads."""

from __future__ import annotations

from pathlib import Path

IMMUTABLE_CACHE = "public, max-age=31536000, immutable"
MANIFEST_CACHE = "no-cache"


def cache_control_for(path: str | Path) -> str | None:
    """Long-lived cache for immutable frame files; manifest may be re-exported."""
    name = Path(path).name
    if name == "manifest.json":
        return MANIFEST_CACHE
    if name.endswith(".bin.br") or name.endswith(".sz3pack") or name.endswith(".json"):
        return IMMUTABLE_CACHE
    return None
