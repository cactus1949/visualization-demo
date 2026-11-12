"""Small FastAPI service that serves exported web payloads from $WEB_ROOT."""
from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

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


@app.get("/api/days")
def days() -> dict[str, object]:
    items: list[dict[str, object]] = []
    if ROOT.is_dir():
        for month in sorted(p for p in ROOT.iterdir() if p.is_dir() and p.name.isdigit() and len(p.name) == 6):
            for day in sorted(p for p in month.iterdir() if p.is_dir() and p.name.isdigit() and len(p.name) == 8):
                manifest = day / "manifest.json"
                if manifest.is_file():
                    items.append({
                        "date": day.name,
                        "path": f"/data/{month.name}/{day.name}/",
                        "manifest": f"/data/{month.name}/{day.name}/manifest.json",
                    })
    return {"web_root": str(ROOT), "days": items}


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
        return response


app.mount("/data", PayloadFiles(directory=str(ROOT), html=False), name="data")
