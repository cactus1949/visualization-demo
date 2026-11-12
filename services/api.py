"""Small FastAPI service that serves exported web payloads from $WEB_ROOT."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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


class PayloadFiles(StaticFiles):
    """Static files where *.br is served as pre-compressed bytes.

    The exporter writes Brotli-compressed frames (*.bin.br). Sending them with
    ``Content-Encoding: br`` lets the browser decompress them transparently,
    which is what the frontend loader expects (same as the Vite dev server).
    """

    def file_response(self, full_path, stat_result, scope, status_code=200):
        response = super().file_response(full_path, stat_result, scope, status_code)
        name = str(full_path)
        if name.endswith(".br"):
            response.headers["content-encoding"] = "br"
            response.headers["content-type"] = "application/octet-stream"
        elif name.endswith(".sz3pack"):
            response.headers["content-type"] = "application/octet-stream"
        cache = cache_control_for(name)
        if cache:
            response.headers["Cache-Control"] = cache
        return response


app.mount("/data", PayloadFiles(directory=str(ROOT), html=False), name="data")
