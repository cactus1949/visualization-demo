"""Build compressed browser data and its manifest from the NetCDF case."""
from __future__ import annotations

import argparse, json, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import brotli, numpy as np, xarray as xr, yaml
from .quantize import encode_variable


def _jsonable(value: Any) -> Any:
    if isinstance(value, np.generic): return value.item()
    if isinstance(value, dict): return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)): return [_jsonable(v) for v in value]
    return value


def _parse_names(values: Iterable[str] | None) -> set[str]:
    out: set[str] = set()
    for value in values or (): out.update(x for x in value.split(",") if x)
    return out


def _write_compressed(path: Path, raw: bytes) -> int:
    compressed = brotli.compress(raw, quality=9); path.write_bytes(compressed); return len(compressed)


def build(input_path: str | Path, config_path: str | Path, out_dir: str | Path,
          bits16: Iterable[str] | None = None, vars_filter: Iterable[str] | None = None,
          quant_config_path: str | Path | None = None) -> dict[str, Any]:
    started = time.perf_counter(); output = Path(out_dir); output.mkdir(parents=True, exist_ok=True)
    labels = yaml.safe_load(Path(config_path).read_text(encoding="utf-8")) or {}
    quant_path = Path(quant_config_path) if quant_config_path else Path(config_path).with_name("quant_config.yaml")
    quant_cfg = yaml.safe_load(quant_path.read_text(encoding="utf-8")) if quant_path.exists() else {}
    defaults = (quant_cfg or {}).get("defaults", {})
    selected = _parse_names(vars_filter)
    dataset = xr.open_dataset(input_path); load_seconds = time.perf_counter() - started
    names = [name for name in labels if name in dataset or name == "w"]
    if selected: names = [name for name in names if name in selected]
    lat, lon = np.asarray(dataset.lat.values), np.asarray(dataset.lon.values)
    levels, interfaces = np.asarray(dataset.z.values), np.asarray(dataset.zf.values)
    spacing = float(dataset.attrs.get("dx_m", 60.0))
    grid = {"nx": int(lon.size), "ny": int(lat.size), "nz": int(levels.size), "lon_min": float(lon.min()), "lon_max": float(lon.max()),
            "lat_min": float(lat.min()), "lat_max": float(lat.max()), "dx_m": spacing, "dy_m": float(dataset.attrs.get("dy_m", spacing)),
            "levels_m": levels.astype(float).tolist(), "level_interfaces_m": interfaces.astype(float).tolist(), "order": "C (z,lat,lon)",
            "lat_ascending": bool(np.all(np.diff(lat) > 0))}
    variables, total_raw, total_compressed = {}, 0, 0
    for name in names:
        if name == "w":
            values = 0.5 * (dataset.w.isel(zf=slice(0, -1)).values + dataset.w.isel(zf=slice(1, None)).values)
            dims, attrs, staggered = ["z", "lat", "lon"], dataset.w.attrs, "zf -> z layer centres (mean adjacent interfaces)"
        else:
            da = dataset[name]; values, dims, attrs, staggered = da.values, list(da.dims), da.attrs, None
        spec = dict(defaults); spec.update((quant_cfg or {}).get(name, {}))
        encoded, meta = encode_variable(values, spec.get("encoding", "u8_linear"), spec.get("range_scope", "global"),
                                        tuple(spec.get("clip_percentiles", [0, 100])), spec.get("fixed_range"))
        raw = encoded.astype("<f2" if meta["dtype"] == "float16" else ("<u2" if meta["dtype"] == "uint16" else "u1"), copy=False).tobytes(order="C")
        filename = f"{name}.bin.br"; compressed = _write_compressed(output / filename, raw)
        display = spec.get("display_range") or labels.get(name, {}).get("range") or [meta["data_min"], meta["data_max"]]
        entry = {"dims": dims, "shape": list(encoded.shape), "encoding": meta["encoding"], "range_scope": meta["range_scope"],
                 "dtype": meta["dtype"], "bits": meta["bits"], "transform": meta.get("transform"), "file": filename,
                 "bytes_raw": len(raw), "bytes_compressed": compressed, "data_min": meta["data_min"], "data_max": meta["data_max"],
                 "clipped_low_frac": meta["clipped_low_frac"], "clipped_high_frac": meta["clipped_high_frac"], "nan_count": meta["nan_count"],
                 "display_range": [float(display[0]), float(display[1])],
                 "range": labels.get(name, {}).get("range", [meta["data_min"], meta["data_max"]]), "units": attrs.get("units", ""),
                 "long_name": attrs.get("long_name", name), "label_zh": labels.get(name, {}).get("label_zh", name),
                 "colormap": labels.get(name, {}).get("colormap", "viridis")}
        for key in ("scale", "offset", "level_scale", "level_offset"):
            if key in meta: entry[key] = meta[key]
        if staggered: entry["staggered_from"] = staggered
        variables[name] = entry; total_raw += len(raw); total_compressed += compressed
        print(f"{name}: raw={len(raw)/1e6:.2f}MB br={compressed/1e6:.2f}MB")
    for stale in output.glob("*.u16.bin.br"): stale.unlink()
    selected_attrs = {k: _jsonable(v) for k, v in dataset.attrs.items() if k in {"case", "solver", "backend", "dx_m", "dy_m", "dz_m", "ztop_m"}}
    derived = {}
    for key, value in ((quant_cfg or {}).get("derived") or {}).items():
        if isinstance(value, dict) and value.get("display_range"):
            lo, hi = value["display_range"]
            derived[key] = {"display_range": [float(lo), float(hi)]}
    manifest = {"schema_version": 3, "case": str(dataset.attrs.get("case", "")), "source_file": str(input_path), "created_utc": datetime.now(timezone.utc).isoformat(),
                "global_attrs": selected_attrs, "grid": grid, "variables": variables, "derived": derived,
                "timing": {"load_s": load_seconds, "total_s": time.perf_counter()-started, "bytes_raw": total_raw, "bytes_compressed": total_compressed}}
    (output / "manifest.json").write_text(json.dumps(_jsonable(manifest), ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__); p.add_argument("--input", default=None)
    p.add_argument("--inputs", nargs="+", default=None, help="several time steps (f000.nc ... f006.nc) -> manifest schema 4, one tNNN/ dir per frame"); p.add_argument("--config", required=True); p.add_argument("--quant", default=None); p.add_argument("--out", required=True); p.add_argument("--bits16", nargs="*", default=[]); p.add_argument("--vars", nargs="*", default=None)
    a = p.parse_args(argv)
    if a.inputs:
        from .build_multi import build_multi
        build_multi(sorted(a.inputs), a.config, a.out, a.quant, a.vars); return
    if not a.input: p.error("--input or --inputs is required")
    build(a.input, a.config, a.out, a.bits16, a.vars, a.quant)


if __name__ == "__main__": main()
