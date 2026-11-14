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

import json, time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np, xarray as xr, yaml

from .build import _jsonable, _parse_names, _write_compressed
from .quantize import encode_variable, encoding_transform, transform_values, union_ranges
from .ncread import TIME_NOTE, frame_times, grid_meta, kept_attrs, open_frames, read_values as _values


def build_multi(inputs: Sequence[str | Path], config_path: str | Path, out_dir: str | Path,
                quant_config_path: str | Path | None = None, vars_filter: Iterable[str] | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    paths, datasets = open_frames(inputs)
    output = Path(out_dir); output.mkdir(parents=True, exist_ok=True)
    labels = yaml.safe_load(Path(config_path).read_text(encoding="utf-8")) or {}
    quant_path = Path(quant_config_path) if quant_config_path else Path(config_path).with_name("quant_config.yaml")
    quant_cfg = (yaml.safe_load(quant_path.read_text(encoding="utf-8")) if quant_path.exists() else {}) or {}
    defaults = quant_cfg.get("defaults", {})
    ref = datasets[0]
    selected = _parse_names(vars_filter)
    names = [n for n in labels if all(n in ds for ds in datasets) or n == "w"]
    if selected:
        names = [n for n in names if n in selected]

    grid = grid_meta(ref)
    times = frame_times(paths, datasets)
    for t in times:
        (output / t["dir"]).mkdir(parents=True, exist_ok=True)

    variables: dict[str, Any] = {}
    total_raw = total_compressed = 0
    for name in names:
        frames = [_values(ds, name) for ds in datasets]
        arrays = [f[0] for f in frames]
        _, dims, attrs, staggered = frames[0]
        spec = dict(defaults); spec.update(quant_cfg.get(name, {}))
        encoding = spec.get("encoding", "u8_linear"); scope = spec.get("range_scope", "global")
        shared = None if encoding in ("f16", "u8_int") else union_ranges(arrays, encoding, scope)
        # one NaN code decision for all frames, so every frame keeps the same quantisation grid
        reserve_nan = None if encoding == "f16" else any(
            bool((~np.isfinite(transform_values(a, encoding_transform(encoding)))).any()) for a in arrays)
        frame_meta, meta0 = [], None
        for i, array in enumerate(arrays):
            encoded, meta = encode_variable(array, encoding, scope, tuple(spec.get("clip_percentiles", [0, 100])),
                                            spec.get("fixed_range"), shared_range=shared,
                                            reserve_nan=reserve_nan)
            dtype = "<f2" if meta["dtype"] == "float16" else ("<u2" if meta["dtype"] == "uint16" else "u1")
            raw = encoded.astype(dtype, copy=False).tobytes(order="C")
            compressed = _write_compressed(output / times[i]["dir"] / f"{name}.bin.br", raw)
            frame_meta.append({"bytes_compressed": compressed, "data_min": meta["data_min"], "data_max": meta["data_max"],
                               "clipped_low_frac": meta["clipped_low_frac"], "clipped_high_frac": meta["clipped_high_frac"],
                               "nan_count": meta["nan_count"]})
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
                 "clipped_high_frac": max(f["clipped_high_frac"] for f in frame_meta), "nan_count": int(sum(f["nan_count"] for f in frame_meta)),
                 "display_range": [float(display[0]), float(display[1])],
                 "range": labels.get(name, {}).get("range", [dmin, dmax]), "units": attrs.get("units", ""),
                 "long_name": attrs.get("long_name", name), "label_zh": labels.get(name, {}).get("label_zh", name),
                 "colormap": labels.get(name, {}).get("colormap", "viridis"), "frames": frame_meta}
        for key in ("scale", "offset", "level_scale", "level_offset", "nan_code"):
            if key in meta: entry[key] = meta[key]
        if staggered: entry["staggered_from"] = staggered
        variables[name] = entry
        print(f"{name}: {len(paths)} frames br={entry['bytes_compressed']/1e6:.2f}MB range=[{dmin:.4g}, {dmax:.4g}]")

    selected_attrs = kept_attrs(ref)
    derived = {}
    for key, value in (quant_cfg.get("derived") or {}).items():
        if isinstance(value, dict) and value.get("display_range"):
            lo, hi = value["display_range"]; derived[key] = {"display_range": [float(lo), float(hi)]}
    manifest = {"schema_version": 4, "case": str(ref.attrs.get("case", "")), "source_file": [str(p) for p in paths],
                "created_utc": datetime.now(timezone.utc).isoformat(), "global_attrs": selected_attrs, "grid": grid,
                "times": times, "time_zone": None, "format": "current", "codec": "current", "codec_label": "",
                "time_note": TIME_NOTE,
                "variables": variables, "derived": derived,
                "timing": {"load_s": 0.0, "total_s": time.perf_counter() - started, "bytes_raw": total_raw, "bytes_compressed": total_compressed}}
    (output / "manifest.json").write_text(json.dumps(_jsonable(manifest), ensure_ascii=False, indent=2), encoding="utf-8")
    for ds in datasets: ds.close()
    return manifest
