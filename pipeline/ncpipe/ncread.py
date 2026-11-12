"""Shared NetCDF reading for every export format (current / sz3 / ...).

Only reads the nc files and describes grid and time; no encoding here, so an export
format can be deleted without touching this module.
"""
from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from typing import Any, Sequence

import numpy as np, xarray as xr

W_NOTE = "zf -> z layer centres (mean adjacent interfaces)"
KEEP_ATTRS = {"case", "solver", "backend", "dx_m", "dy_m", "dz_m", "ztop_m"}


def jsonable(value: Any) -> Any:
    if isinstance(value, np.generic): return value.item()
    if isinstance(value, dict): return {k: jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)): return [jsonable(v) for v in value]
    return value


def read_values(ds: xr.Dataset, name: str) -> tuple[np.ndarray, list[str], dict, str | None]:
    """(float64 values, dims, attrs, staggered note). w is averaged from zf to z layer centres."""
    if name == "w":
        w = ds.w.values.astype(np.float64)
        return 0.5 * (w[:-1] + w[1:]), ["z", "lat", "lon"], dict(ds.w.attrs), W_NOTE
    da = ds[name]
    return np.asarray(da.values, dtype=np.float64), list(da.dims), dict(da.attrs), None


def valid_time(ds: xr.Dataset, path: Path, index: int) -> tuple[str, float | None]:
    """Literal clock of a frame. Time zone is not stated in the files, so none is added."""
    if "time" in ds.coords or "time" in ds.variables:
        value = np.asarray(ds["time"].values).reshape(-1)[0]
        if np.issubdtype(np.asarray(value).dtype, np.datetime64):
            return np.datetime_as_string(np.datetime64(value, "s"), unit="s"), None
    for key in ("valid_time", "time", "init_time"):
        if key in ds.attrs:
            return str(ds.attrs[key]), None
    m = re.search(r"f(\d{3})", path.stem)
    return f"+{float(m.group(1)) if m else float(index):g}h", float(m.group(1)) if m else float(index)


def check_same_grid(ref: xr.Dataset, ds: xr.Dataset, path: Path) -> None:
    for coord in ("z", "zf", "lat", "lon"):
        a, b = np.asarray(ref[coord].values), np.asarray(ds[coord].values)
        if a.shape != b.shape or not np.allclose(a, b, rtol=0, atol=1e-9):
            raise ValueError(f"{path.name}: coordinate {coord} differs from the first frame")


def grid_meta(ds: xr.Dataset) -> dict[str, Any]:
    lat, lon = np.asarray(ds.lat.values), np.asarray(ds.lon.values)
    levels, interfaces = np.asarray(ds.z.values), np.asarray(ds.zf.values)
    spacing = float(ds.attrs.get("dx_m", 60.0))
    return {"nx": int(lon.size), "ny": int(lat.size), "nz": int(levels.size), "lon_min": float(lon.min()), "lon_max": float(lon.max()),
            "lat_min": float(lat.min()), "lat_max": float(lat.max()), "dx_m": spacing, "dy_m": float(ds.attrs.get("dy_m", spacing)),
            "levels_m": levels.astype(float).tolist(), "level_interfaces_m": interfaces.astype(float).tolist(), "order": "C (z,lat,lon)",
            "lat_ascending": bool(np.all(np.diff(lat) > 0))}


def frame_times(paths: Sequence[Path], datasets: Sequence[xr.Dataset]) -> list[dict[str, Any]]:
    """Timeline shared by every format: one tNNN/ dir per frame plus its literal clock and lead."""
    times, t0 = [], None
    for i, (p, ds) in enumerate(zip(paths, datasets)):
        valid, lead = valid_time(ds, p, i)
        if lead is None:
            try:
                dt = datetime.fromisoformat(valid)
                t0 = t0 or dt
                lead = (dt - t0).total_seconds() / 3600.0
            except ValueError:
                lead = float(i)
        times.append({"index": i, "dir": f"t{i:03d}/", "valid_time": valid, "lead_h": lead, "source": p.name})
    return times


def open_frames(inputs: Sequence[str | Path]) -> tuple[list[Path], list[xr.Dataset]]:
    paths = [Path(p) for p in inputs]
    if not paths:
        raise ValueError("no inputs")
    datasets = [xr.open_dataset(p) for p in paths]
    for p, ds in zip(paths[1:], datasets[1:]):
        check_same_grid(datasets[0], ds, p)
    return paths, datasets


def kept_attrs(ds: xr.Dataset) -> dict[str, Any]:
    return {k: jsonable(v) for k, v in ds.attrs.items() if k in KEEP_ATTRS}


TIME_NOTE = "valid_time is the literal clock decoded from each file; the files do not state a time zone"
