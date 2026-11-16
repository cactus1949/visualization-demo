"""Small FastAPI service that serves exported web payloads from $WEB_ROOT."""
from __future__ import annotations

from pathlib import Path

import brotli
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import Response

from .cache_headers import cache_control_for
from .paths import load_dotenv, web_root

load_dotenv()
ROOT = web_root()
ROOT.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="visualization-demo data", version="0.1")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health() -> dict[str, object]:
    return {"ok": True, "web_root": str(ROOT)}


def _is_month(p) -> bool:
    return p.is_dir() and p.name.isdigit() and len(p.name) == 6


def _is_day(p) -> bool:
    return p.is_dir() and p.name.isdigit() and len(p.name) == 8


def _format_dirs() -> list:
    """Every $WEB_ROOT/<format>/ that has yyyymm/yyyymmdd/manifest.json (no format names hard-coded)."""
    if not ROOT.is_dir():
        return []
    return sorted(p for p in ROOT.iterdir() if p.is_dir() and not p.name.startswith(".") and not p.name.isdigit())


@app.get("/api/days")
def days(format: str | None = None) -> dict[str, object]:
    """Exported days and which formats each one has; ``?format=sz3`` keeps only that format."""
    by_day: dict[str, dict[str, str]] = {}
    for fmt_dir in _format_dirs():
        if format and fmt_dir.name != format:
            continue
        for month in sorted(filter(_is_month, fmt_dir.iterdir())):
            for day in sorted(filter(_is_day, month.iterdir())):
                if (day / "manifest.json").is_file():
                    by_day.setdefault(day.name, {})[fmt_dir.name] = f"/data/{fmt_dir.name}/{month.name}/{day.name}/manifest.json"
    items = [{"date": d, "formats": sorted(f), "manifests": f} for d, f in sorted(by_day.items())]
    latest: dict[str, str] = {}
    for item in items:
        for fmt in item["formats"]:
            latest[fmt] = item["date"]
    return {"web_root": str(ROOT), "formats": sorted(latest), "latest": latest, "days": items}


def accepts_brotli(header: str | None) -> bool:
    """判断 Accept-Encoding 是否接受 Brotli。

    Args:
        header (str | None): 请求头 Accept-Encoding 的原文。没有该头时为 None。

    Returns:
        bool: 含 ``br`` 且 q 大于 0 时为 True。

    Examples:
        >>> accepts_brotli("gzip, deflate")
        False
        >>> accepts_brotli("gzip, deflate, br")
        True
        >>> accepts_brotli("br;q=0")
        False
    """
    if not header:
        return False
    for part in header.split(","):
        token, _, params = part.strip().partition(";")
        if token.strip().lower() != "br":
            continue
        quality = 1.0
        for param in params.split(";"):
            name, sep, value = param.strip().partition("=")
            if sep and name.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        return quality > 0
    return False


def _accept_encoding(scope) -> str | None:
    """读取 ASGI 请求里的 Accept-Encoding。

    Args:
        scope: ASGI 请求范围。请求头名字是小写字节串。

    Returns:
        str | None: 头的文本。没有该头时为 None。

    Examples:
        >>> _accept_encoding({"headers": [(b"accept-encoding", b"gzip, br")]})
        'gzip, br'
    """
    for key, value in scope.get("headers", []):
        if key == b"accept-encoding":
            return value.decode("latin-1")
    return None


class PayloadFiles(StaticFiles):
    """Static files where *.br is served as pre-compressed bytes.

    The exporter writes Brotli-compressed frames (*.bin.br). When the client
    accepts ``br``, the file is sent with ``Content-Encoding: br`` so the browser
    decompresses it. Otherwise the bytes are decompressed here: a browser that
    did not advertise ``br`` (Chrome behind a proxy) fails the response with
    ``ERR_CONTENT_DECODING_FAILED``.
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        """按客户端是否接受 br 返回预压缩文件。

        Args:
            full_path: 磁盘上的文件路径。
            stat_result: 该文件的 stat 结果。
            scope: ASGI 请求范围，用来读 Accept-Encoding 和 Range。
            status_code: 成功时的 HTTP 状态码。

        Returns:
            Response: 文件响应。``.br`` 不按 Range 切片。
        """
        name = str(full_path)
        if name.endswith(".br"):
            # 一段 Brotli 切开会解失败，忽略 Range。
            scope["headers"] = [(key, value) for key, value in scope.get("headers", []) if key != b"range"]
            if not accepts_brotli(_accept_encoding(scope)):
                return _decompressed_brotli(full_path, name, status_code)
        response = super().file_response(full_path, stat_result, scope, status_code)
        if name.endswith(".br"):
            response.headers["content-encoding"] = "br"
            response.headers["content-type"] = "application/octet-stream"
            response.headers["accept-ranges"] = "none"
            response.headers["vary"] = "Accept-Encoding"
        elif name.endswith(".sz3pack"):
            response.headers["content-type"] = "application/octet-stream"
        cache = cache_control_for(name)
        if cache:
            response.headers["Cache-Control"] = cache
        return response


def _decompressed_brotli(full_path, name: str, status_code: int) -> Response:
    """把磁盘上的 Brotli 文件解开后返回。

    Args:
        full_path: ``.br`` 文件路径。
        name (str): 用来判断缓存头的文件名或路径。
        status_code (int): 成功时的 HTTP 状态码。

    Returns:
        Response: 解开后的字节，不带 Content-Encoding。文件损坏时状态码为 500。

    Examples:
        >>> import tempfile
        >>> folder = Path(tempfile.mkdtemp())
        >>> target = folder / "a.bin.br"
        >>> _ = target.write_bytes(brotli.compress(b"abc"))
        >>> bytes(_decompressed_brotli(target, "t000/a.bin.br", 200).body)
        b'abc'
    """
    try:
        raw = brotli.decompress(Path(full_path).read_bytes())
    except brotli.error:
        return Response(content=b"brotli decompress failed", status_code=500, media_type="text/plain")
    headers = {"vary": "Accept-Encoding", "accept-ranges": "none"}
    cache = cache_control_for(name)
    if cache:
        headers["cache-control"] = cache
    return Response(content=raw, status_code=status_code, media_type="application/octet-stream", headers=headers)


app.mount("/data", PayloadFiles(directory=str(ROOT), html=False), name="data")
