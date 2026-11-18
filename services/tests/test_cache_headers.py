"""Cache-Control on exported payload files served by the data API."""

from __future__ import annotations

import gzip
import os
from pathlib import Path

# services.api creates $WEB_ROOT on import; use a writable default in tests.
if not os.environ.get("WEB_ROOT"):
    os.environ["WEB_ROOT"] = "/tmp/webroot-cache-test"
Path(os.environ["WEB_ROOT"]).mkdir(parents=True, exist_ok=True)

from fastapi import FastAPI
from fastapi.testclient import TestClient

import brotli

from services.api import PayloadFiles, accepts_brotli, accepts_gzip
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

        br = client.head(
            "/data/current/202611/20261111/t000/u.bin.br",
            headers={"Accept-Encoding": "gzip, deflate, br"},
        )
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


def test_accepts_brotli_ignores_zero_quality():
    assert accepts_brotli(None) is False
    assert accepts_brotli("gzip, deflate") is False
    assert accepts_brotli("gzip, deflate, br") is True
    assert accepts_brotli("br;q=0, gzip") is False


def test_accepts_gzip_ignores_zero_quality():
    assert accepts_gzip(None) is False
    assert accepts_gzip("gzip, deflate") is True
    assert accepts_gzip("br") is False
    assert accepts_gzip("gzip;q=0, deflate") is False


def test_brotli_file_is_decompressed_when_client_does_not_accept_br():
    import tempfile

    payload = b"\x01\x02\x03\x04"
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        frame = root / "geo"
        frame.mkdir()
        (frame / "dem.u16.bin.br").write_bytes(brotli.compress(payload))
        app = FastAPI()
        app.mount("/data", PayloadFiles(directory=str(root), html=False))
        client = TestClient(app)

        plain = client.get("/data/geo/dem.u16.bin.br", headers={"Accept-Encoding": "identity"})
        assert plain.status_code == 200
        assert "content-encoding" not in plain.headers
        assert plain.content == payload

        gzipped = client.get("/data/geo/dem.u16.bin.br", headers={"Accept-Encoding": "gzip, deflate"})
        assert gzipped.status_code == 200
        assert gzipped.headers["content-encoding"] == "gzip"
        assert gzipped.headers["vary"] == "Accept-Encoding"
        wire = gzipped.content
        if wire[:2] == b"\x1f\x8b":
            wire = gzip.decompress(wire)
        assert wire == payload

        encoded = client.get(
            "/data/geo/dem.u16.bin.br",
            headers={"Accept-Encoding": "gzip, deflate, br"},
        )
        assert encoded.status_code == 200
        assert encoded.headers["content-encoding"] == "br"
        # 测试客户端会按 Content-Encoding 解开，这里拿到的是原始字节。
        assert encoded.content == payload

        ranged = client.get(
            "/data/geo/dem.u16.bin.br",
            headers={"Accept-Encoding": "br", "Range": "bytes=0-3"},
        )
        assert ranged.status_code == 200
        assert ranged.headers["content-encoding"] == "br"
        assert "content-range" not in ranged.headers
