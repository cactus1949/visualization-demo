"""Multi-time export: several NetCDF time steps -> one manifest (schema 4) + one directory per frame.

Layout::

    out/manifest.json        schema_version 4, shared by all frames
    out/t000/u.bin.br ...    one file per variable per frame (same names as schema 3)
    out/t001/...

Every variable uses ONE quantisation grid across all frames (union of the per-frame
min/max, per level for ``per_level`` variables), so frames can be blended on the GPU and
the Worker decodes every frame with the same scale/offset. Encoding itself is the current
schema-3 encoding (f16 / u8 / u8_log10 ...); the per-frame directory keeps it swappable.
"""
from __future__ import annotations

import json, re, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np, xarray as xr, yaml

from .build import _jsonable, _parse_names, _write_compressed
from .quantize import encode_variable, union_ranges


def _values(ds: xr.Dataset, name: str) -> tuple[np.ndarray, list[str], dict, str | None]:
    if name == "w":
        w = ds.w.values.astype(np.float64)
        return 0.5 * (w[:-1] + w[1:]), ["z", "lat", "lon"], dict(ds.w.attrs), "zf -> z layer centres (mean adjacent interfaces)"
    da = ds[name]
    return np.asarray(da.values, dtype=np.float64), list(da.dims), dict(da.attrs), None


def _valid_time(ds: xr.Dataset, path: Path, index: int) -> tuple[str, float | None]:
    """Literal clock of a frame. Time zone is not stated in the files, so none is added."""
    if "time" in ds.coords or "time" in ds.variables:
        value = np.asarray(ds["time"].values).reshape(-1)[0]
        if np.issubdtype(np.asarray(value).dtype, np.datetime64):
            text = np.datetime_as_string(np.datetime64(value, "s"), unit="s")
            return text, None
    for key in ("valid_time", "time", "init_time"):
        if key in ds.attrs:
            return str(ds.attrs[key]), None
    m = re.search(r"f(\d{3})", path.stem)
    lead = float(m.group(1)) if m else float(index)
    return f"+{lead:g}h", lead


def _check_same_grid(ref: xr.Dataset, ds: xr.Dataset, path: Path) -> None:
    for coord in ("z", "zf", "lat", "lon"):
        a, b = np.asarray(ref[coord].values), np.asarray(ds[coord].values)
        if a.shape != b.shape or not np.allclose(a, b, rtol=0, atol=1e-9):
            raise ValueError(f"{path.name}: coordinate {coord} differs from the first frame")


def build_multi(inputs: Sequence[str | Path], config_path: str | Path, out_dir: str | Path,
                quant_config_path: str | Path | None = None, vars_filter: Iterable[str] | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    paths = [Path(p) for p in inputs]
    if not paths:
        raise ValueError("no inputs")
    output = Path(out_dir); output.mkdir(parents=True, exist_ok=True)
    labels = yaml.safe_load(Path(config_path).read_text(encoding="utf-8")) or {}
    quant_path = Path(quant_config_path) if quant_config_path else Path(config_path).with_name("quant_config.yaml")
    quant_cfg = (yaml.safe_load(quant_path.read_text(encoding="utf-8")) if quant_path.exists() else {}) or {}
    defaults = quant_cfg.get("defaults", {})
    datasets = [xr.open_dataset(p) for p in paths]
    ref = datasets[0]
    for p, ds in zip(paths[1:], datasets[1:]):
        _check_same_grid(ref, ds, p)
    selected = _parse_names(vars_filter)
    names = [n for n in labels if all(n in ds for ds in datasets) or n == "w"]
    if selected:
        names = [n for n in names if n in selected]

    lat, lon = np.asarray(ref.lat.values), np.asarray(ref.lon.values)
    levels, interfaces = np.asarray(ref.z.values), np.asarray(ref.zf.values)
    spacing = float(ref.attrs.get("dx_m", 60.0))
    grid = {"nx": int(lon.size), "ny": int(lat.size), "nz": int(levels.size), "lon_min": float(lon.min()), "lon_max": float(lon.max()),
            "lat_min": float(lat.min()), "lat_max": float(lat.max()), "dx_m": spacing, "dy_m": float(ref.attrs.get("dy_m", spacing)),
            "levels_m": levels.astype(float).tolist(), "level_interfaces_m": interfaces.astype(float).tolist(), "order": "C (z,lat,lon)",
            "lat_ascending": bool(np.all(np.diff(lat) > 0))}

    times = []
    t0 = None
    for i, (p, ds) in enumerate(zip(paths, datasets)):
        valid, lead = _valid_time(ds, p, i)
        if lead is None:
            try:
                dt = datetime.fromisoformat(valid)
                t0 = t0 or dt
                lead = (dt - t0).total_seconds() / 3600.0
            except ValueError:
                lead = float(i)
        d = f"t{i:03d}/"
        (output / d).mkdir(parents=True, exist_ok=True)
        times.append({"index": i, "dir": d, "valid_time": valid, "lead_h": lead, "source": p.name})

    variables: dict[str, Any] = {}
    total_raw = total_compressed = 0
    for name in names:
        frames = [_values(ds, name) for ds in datasets]
        arrays = [f[0] for f in frames]
        _, dims, attrs, staggered = frames[0]
        spec = dict(defaults); spec.update(quant_cfg.get(name, {}))
        encoding = spec.get("encoding", "u8_linear"); scope = spec.get("range_scope", "global")
        shared = None if encoding in ("f16", "u8_int") else union_ranges(arrays, encoding, scope)
        frame_meta, meta0 = [], None
        for i, array in enumerate(arrays):
            encoded, meta = encode_variable(array, encoding, scope, tuple(spec.get("clip_percentiles", [0, 100])),
                                            spec.get("fixed_range"), shared_range=shared)
            dtype = "<f2" if meta["dtype"] == "float16" else ("<u2" if meta["dtype"] == "uint16" else "u1")
            raw = encoded.astype(dtype, copy=False).tobytes(order="C")
            compressed = _write_compressed(output / times[i]["dir"] / f"{name}.bin.br", raw)
            frame_meta.append({"bytes_compressed": compressed, "data_min": meta["data_min"], "data_max": meta["data_max"],
                               "clipped_low_frac": meta["clipped_low_frac"], "clipped_high_frac": meta["clipped_high_frac"]})
            total_raw += len(raw); total_compressed += compressed
            meta0 = meta0 or (meta, encoded.shape, len(raw))
        meta, shape, nraw = meta0
        dmin = float(min(f["data_min"] for f in frame_meta)); dmax = float(max(f["data_max"] for f in frame_meta))
        display = spec.get("display_range") or labels.get(name, {}).get("range") or [dmin, dmax]
        entry = {"dims": dims, "shape": list(shape), "encoding": meta["encoding"], "range_scope": meta["range_scope"],
                 "dtype": meta["dtype"], "bits": meta["bits"], "transform": meta.get("transform"), "file": f"{name}.bin.br",
                 "bytes_raw": nraw, "bytes_compressed": int(sum(f["bytes_compressed"] for f in frame_meta)),
                 "data_min": dmin, "data_max": dmax,
                 "clipped_low_frac": max(f["clipped_low_frac"] for f in frame_meta),
                 "clipped_high_frac": max(f["clipped_high_frac"] for f in frame_meta), "nan_count": meta["nan_count"],
                 "display_range": [float(display[0]), float(display[1])],
                 "range": labels.get(name, {}).get("range", [dmin, dmax]), "units": attrs.get("units", ""),
                 "long_name": attrs.get("long_name", name), "label_zh": labels.get(name, {}).get("label_zh", name),
                 "colormap": labels.get(name, {}).get("colormap", "viridis"), "frames": frame_meta}
        for key in ("scale", "offset", "level_scale", "level_offset"):
            if key in meta: entry[key] = meta[key]
        if staggered: entry["staggered_from"] = staggered
        variables[name] = entry
        print(f"{name}: {len(paths)} frames br={entry['bytes_compressed']/1e6:.2f}MB range=[{dmin:.4g}, {dmax:.4g}]")

    selected_attrs = {k: _jsonable(v) for k, v in ref.attrs.items() if k in {"case", "solver", "backend", "dx_m", "dy_m", "dz_m", "ztop_m"}}
    derived = {}
    for key, value in (quant_cfg.get("derived") or {}).items():
        if isinstance(value, dict) and value.get("display_range"):
            lo, hi = value["display_range"]; derived[key] = {"display_range": [float(lo), float(hi)]}
    manifest = {"schema_version": 4, "case": str(ref.attrs.get("case", "")), "source_file": [str(p) for p in paths],
                "created_utc": datetime.now(timezone.utc).isoformat(), "global_attrs": selected_attrs, "grid": grid,
                "times": times, "time_zone": None,
                "time_note": "valid_time is the literal clock decoded from each file; the files do not state a time zone",
                "variables": variables, "derived": derived,
                "timing": {"load_s": 0.0, "total_s": time.perf_counter() - started, "bytes_raw": total_raw, "bytes_compressed": total_compressed}}
    (output / "manifest.json").write_text(json.dumps(_jsonable(manifest), ensure_ascii=False, indent=2), encoding="utf-8")
    for ds in datasets: ds.close()
    return manifest
