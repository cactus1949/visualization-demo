"""Small FastAPI service that serves exported web payloads from $WEB_ROOT."""
from __future__ import annotations

import gzip
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


def _coding_quality(header: str | None, coding: str) -> float | None:
    """读取 Accept-Encoding 里某种编码的 q 值。

    Args:
        header (str | None): 请求头 Accept-Encoding 的原文。没有该头时为 None。
        coding (str): 编码名，例如 ``br`` 或 ``gzip``。比较时忽略大小写。

    Returns:
        float | None: 该编码的 q。未出现时为 None。q 写了但无法解析时按 0。

    Examples:
        >>> _coding_quality("gzip, br;q=0", "br")
        0.0
        >>> _coding_quality("gzip", "br") is None
        True
    """
    if not header:
        return None
    want = coding.lower()
    for part in header.split(","):
        token, _, params = part.strip().partition(";")
        if token.strip().lower() != want:
            continue
        quality = 1.0
        for param in params.split(";"):
            name, sep, value = param.strip().partition("=")
            if sep and name.strip().lower() == "q":
                try:
                    quality = float(value)
                except ValueError:
                    quality = 0.0
        return quality
    return None


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
    quality = _coding_quality(header, "br")
    return quality is not None and quality > 0


def accepts_gzip(header: str | None) -> bool:
    """判断 Accept-Encoding 是否接受 gzip。

    Args:
        header (str | None): 请求头 Accept-Encoding 的原文。没有该头时为 None。

    Returns:
        bool: 含 ``gzip`` 且 q 大于 0 时为 True。``*`` 不视为接受 gzip。

    Examples:
        >>> accepts_gzip("gzip, deflate")
        True
        >>> accepts_gzip("br")
        False
        >>> accepts_gzip("gzip;q=0")
        False
    """
    quality = _coding_quality(header, "gzip")
    return quality is not None and quality > 0


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
    """按 Accept-Encoding 发送磁盘上的 ``.br`` 文件。

    客户端接受 ``br`` 时原样返回，并带 ``Content-Encoding: br``。不接受 ``br``
    但接受 ``gzip`` 时先解开再压成 gzip。两种都不接受时返回解开后的原始字节。
    直接给不接受 ``br`` 的浏览器发 ``Content-Encoding: br`` 会得到
    ``ERR_CONTENT_DECODING_FAILED``。
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        """按客户端接受的编码返回预压缩文件。

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
            header = _accept_encoding(scope)
            if not accepts_brotli(header):
                return _decompressed_brotli(full_path, name, status_code, gzip_ok=accepts_gzip(header))
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


def _decompressed_brotli(full_path, name: str, status_code: int, gzip_ok: bool = False) -> Response:
    """把磁盘上的 Brotli 文件解开后返回。

    客户端接受 gzip 时，解开后的字节再用 gzip 压缩。压缩级别固定为 6。

    Args:
        full_path: ``.br`` 文件路径。
        name (str): 用来判断缓存头的文件名或路径。
        status_code (int): 成功时的 HTTP 状态码。
        gzip_ok (bool): 为 True 时响应带 ``Content-Encoding: gzip``。

    Returns:
        Response: 解开后的字节，或这些字节的 gzip。文件损坏时状态码为 500。

    Examples:
        >>> import tempfile
        >>> folder = Path(tempfile.mkdtemp())
        >>> target = folder / "a.bin.br"
        >>> _ = target.write_bytes(brotli.compress(b"abc"))
        >>> bytes(_decompressed_brotli(target, "t000/a.bin.br", 200).body)
        b'abc'
        >>> encoded = _decompressed_brotli(target, "t000/a.bin.br", 200, gzip_ok=True)
        >>> encoded.headers["content-encoding"]
        'gzip'
        >>> gzip.decompress(bytes(encoded.body))
        b'abc'
    """
    try:
        raw = brotli.decompress(Path(full_path).read_bytes())
    except brotli.error:
        return Response(content=b"brotli decompress failed", status_code=500, media_type="text/plain")
    body = gzip.compress(raw, compresslevel=6) if gzip_ok else raw
    headers = {"vary": "Accept-Encoding", "accept-ranges": "none"}
    if gzip_ok:
        headers["content-encoding"] = "gzip"
    cache = cache_control_for(name)
    if cache:
        headers["cache-control"] = cache
    return Response(content=body, status_code=status_code, media_type="application/octet-stream", headers=headers)


app.mount("/data", PayloadFiles(directory=str(ROOT), html=False), name="data")
