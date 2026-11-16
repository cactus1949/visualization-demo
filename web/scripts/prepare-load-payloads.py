#!/usr/bin/env python3
"""Build payload variants used by bench-load.mjs (w encodings + a v4-style baseline)."""
from __future__ import annotations

import argparse, json, shutil, sys
from pathlib import Path

import brotli, numpy as np, xarray as xr, yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "pipeline"))
from ncpipe.quantize import encode_variable, decode_variable  # noqa: E402


def destagger_w(ds):
    return 0.5 * (ds.w.isel(zf=slice(0, -1)).values + ds.w.isel(zf=slice(1, None)).values)


def metrics(truth, rec):
    t = np.asarray(truth, dtype=np.float64)
    r = np.asarray(rec, dtype=np.float64)
    diff = r - t
    return {
        "maxabs": float(np.max(np.abs(diff))),
        "rmse": float(np.sqrt(np.mean(diff**2))),
        "rel": float(np.sqrt(np.mean(diff**2)) / max(float(np.max(np.abs(t))), 1e-12)),
    }


def write_var(out: Path, name: str, encoded: np.ndarray, meta: dict) -> tuple[int, int]:
    raw = encoded.astype(
        "<f2" if meta["dtype"] == "float16" else ("<u2" if meta["dtype"] == "uint16" else "u1"),
        copy=False,
    ).tobytes(order="C")
    compressed = brotli.compress(raw, quality=9)
    (out / f"{name}.bin.br").write_bytes(compressed)
    return len(raw), len(compressed)


def patch_entry(entry: dict, meta: dict, raw: int, comp: int) -> dict:
    out = dict(entry)
    out.update({
        "encoding": meta["encoding"],
        "range_scope": meta["range_scope"],
        "dtype": meta["dtype"],
        "bits": meta["bits"],
        "transform": meta.get("transform"),
        "bytes_raw": raw,
        "bytes_compressed": comp,
        "data_min": meta["data_min"],
        "data_max": meta["data_max"],
        "clipped_low_frac": meta["clipped_low_frac"],
        "clipped_high_frac": meta["clipped_high_frac"],
        "nan_count": meta["nan_count"],
        "file": f"{entry.get('name', 'w')}.bin.br" if False else out.get("file", "w.bin.br"),
    })
    for key in ("scale", "offset", "level_scale", "level_offset"):
        out.pop(key, None)
        if key in meta:
            out[key] = meta[key]
    return out


def copy_tree(src: Path, dst: Path) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--out", default="/tmp/atmos-load-payloads")
    p.add_argument("--current", default=str(ROOT / "data/web/lowair_atmos"))
    p.add_argument("--v4", default="/workspace/visualization-demo-analysis/lowair_atmos-v4-baseline")
    p.add_argument("--nc", default=str(ROOT / "data/lowair_atmos.nc"))
    args = p.parse_args()
    out_root = Path(args.out)
    out_root.mkdir(parents=True, exist_ok=True)
    current = Path(args.current)
    base_manifest = json.loads((current / "manifest.json").read_text())
    ds = xr.open_dataset(args.nc)
    w = destagger_w(ds)

    variants = {
        "w-f16": ("f16", "global"),
        "w-u8-per-level": ("u8_linear", "per_level"),
        "w-u16-per-level": ("u16_linear", "per_level"),
    }
    report = []
    for name, (encoding, scope) in variants.items():
        dest = out_root / name
        copy_tree(current, dest)
        encoded, meta = encode_variable(w, encoding, scope)
        rec = decode_variable(encoded, meta)
        err = metrics(w, rec)
        raw, comp = write_var(dest, "w", encoded, meta)
        manifest = json.loads((dest / "manifest.json").read_text())
        manifest["variables"]["w"] = patch_entry(manifest["variables"]["w"], meta, raw, comp)
        manifest["timing"]["bytes_raw"] = sum(v["bytes_raw"] for v in manifest["variables"].values())
        manifest["timing"]["bytes_compressed"] = sum(v["bytes_compressed"] for v in manifest["variables"].values())
        (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
        row = {"variant": name, "encoding": encoding, "range_scope": scope, "w_raw": raw, "w_br": comp,
               "payload_br": manifest["timing"]["bytes_compressed"], **err}
        report.append(row)
        print(f"{name}: w br={comp} maxabs={err['maxabs']:.6g} rmse={err['rmse']:.6g}")

    # v4 baseline payload, patched so the v5 frontend can decode it
    v4_src = Path(args.v4)
    dest = out_root / "v4-all-u8"
    copy_tree(v4_src, dest)
    manifest = json.loads((dest / "manifest.json").read_text())
    for n, entry in manifest["variables"].items():
        transform = entry.get("transform")
        entry["encoding"] = "u8_log10" if transform == "log10" else "u8_linear"
        entry["range_scope"] = "global"
        if n in base_manifest["variables"] and "display_range" in base_manifest["variables"][n]:
            entry["display_range"] = base_manifest["variables"][n]["display_range"]
        entry.setdefault("dtype", "uint8")
    manifest["schema_version"] = 3
    if "derived" in base_manifest:
        manifest["derived"] = base_manifest["derived"]
    # errors for v4 w (global u8 linear)
    raw = brotli.decompress((dest / "w.bin.br").read_bytes())
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(manifest["variables"]["w"]["shape"])
    rec = decode_variable(arr, manifest["variables"]["w"])
    err = metrics(w, rec)
    manifest["timing"] = manifest.get("timing") or {}
    manifest["timing"]["bytes_compressed"] = sum(
        (dest / v["file"]).stat().st_size for v in manifest["variables"].values()
    )
    manifest["timing"]["bytes_raw"] = sum(v.get("bytes_raw", 0) for v in manifest["variables"].values())
    (dest / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    row = {"variant": "v4-all-u8", "encoding": "u8_linear", "range_scope": "global",
           "w_raw": manifest["variables"]["w"]["bytes_raw"],
           "w_br": manifest["variables"]["w"]["bytes_compressed"],
           "payload_br": manifest["timing"]["bytes_compressed"], **err}
    report.append(row)
    print(f"v4-all-u8: w br={row['w_br']} maxabs={err['maxabs']:.6g} rmse={err['rmse']:.6g} total={row['payload_br']}")
    (out_root / "w-errors.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print("wrote", out_root / "w-errors.json")


if __name__ == "__main__":
    main()
