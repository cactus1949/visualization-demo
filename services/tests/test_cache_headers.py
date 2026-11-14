"""Cache-Control on exported payload files served by the data API."""

from __future__ import annotations

import os
from pathlib import Path

# services.api creates $WEB_ROOT on import; use a writable default in tests.
if not os.environ.get("WEB_ROOT"):
    os.environ["WEB_ROOT"] = "/tmp/webroot-cache-test"
Path(os.environ["WEB_ROOT"]).mkdir(parents=True, exist_ok=True)

from fastapi import FastAPI
from fastapi.testclient import TestClient

from services.api import PayloadFiles
from services.cache_headers import IMMUTABLE_CACHE, MANIFEST_CACHE, cache_control_for


def test_cache_control_for_distinguishes_manifest_from_immutable_frames():
    assert cache_control_for("manifest.json") == MANIFEST_CACHE
    assert cache_control_for("/data/current/202611/20261111/manifest.json") == MANIFEST_CACHE
    assert cache_control_for("t000/u.bin.br") == IMMUTABLE_CACHE
    assert cache_control_for("t000/u.sz3pack") == IMMUTABLE_CACHE
    assert cache_control_for("/data/sz3/202611/20261111/t003/u.json") == IMMUTABLE_CACHE
    assert cache_control_for("readme.txt") is None


def test_json_outside_frame_directories_is_not_immutable():
    assert cache_control_for("/data/buildings/buildings.json") is None
    assert cache_control_for("/data/current/202611/20261111/other.json") is None
    assert cache_control_for("/data/web/lowair_atmos/t0/u.json") is None


def _tree(root: Path) -> None:
    day = root / "current" / "202611" / "20261111"
    frame = day / "t000"
    frame.mkdir(parents=True)
    (day / "manifest.json").write_text('{"ok": true}', encoding="utf-8")
    (frame / "u.bin.br").write_bytes(b"br")
    (frame / "u.sz3pack").write_bytes(b"sz")
    (frame / "u.json").write_text('{"index": []}', encoding="utf-8")
    buildings = root / "buildings"
    buildings.mkdir()
    (buildings / "buildings.json").write_text('{"features": []}', encoding="utf-8")


def test_payload_files_set_cache_headers_and_keep_content_encoding():
    import tempfile

    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        _tree(root)
        app = FastAPI()
        app.mount("/data", PayloadFiles(directory=str(root), html=False))
        client = TestClient(app)

        br = client.head("/data/current/202611/20261111/t000/u.bin.br")
        assert br.status_code == 200
        assert br.headers["cache-control"] == IMMUTABLE_CACHE
        assert br.headers["content-encoding"] == "br"
        assert br.headers["content-type"] == "application/octet-stream"

        pack = client.head("/data/current/202611/20261111/t000/u.sz3pack")
        assert pack.status_code == 200
        assert pack.headers["cache-control"] == IMMUTABLE_CACHE
        assert pack.headers["content-type"] == "application/octet-stream"

        index = client.head("/data/current/202611/20261111/t000/u.json")
        assert index.status_code == 200
        assert index.headers["cache-control"] == IMMUTABLE_CACHE

        manifest = client.head("/data/current/202611/20261111/manifest.json")
        assert manifest.status_code == 200
        assert manifest.headers["cache-control"] == MANIFEST_CACHE
        assert "immutable" not in manifest.headers["cache-control"]

        bld = client.head("/data/buildings/buildings.json")
        assert bld.status_code == 200
        assert "immutable" not in bld.headers.get("cache-control", "")

        missing = client.head("/data/current/202611/20261111/t000/missing.bin.br")
        assert missing.status_code == 404
