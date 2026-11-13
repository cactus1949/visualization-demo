"""Build Cesium geo-foundation artifacts from one NetCDF grid and a DEM."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import xarray as xr

from ncpipe.ncread import grid_meta

from .dem import DemGrid, GeoidFunction, load_dem, sample_dem, write_u16_brotli
from .mapping import fit_mapping


def _regular_axis(values: np.ndarray, name: str) -> tuple[float, float]:
    values = np.asarray(values, dtype=np.float64)
    expected = np.linspace(values[0], values[-1], values.size)
    if np.max(np.abs(values - expected)) >= 1e-6:
        raise ValueError(f"{name} coordinates are not regular")
    increasing = bool(np.all(np.diff(values) > 0))
    decreasing = bool(np.all(np.diff(values) < 0))
    if values.size < 2 or not (increasing or decreasing):
        raise ValueError(f"{name} coordinates must be monotonic")
    return float(min(values[0], values[-1])), float(max(values[0], values[-1]))


def _read_grid(path: str | Path) -> dict[str, Any]:
    with xr.open_dataset(path) as dataset:
        lon_min, lon_max = _regular_axis(dataset.lon.values, "lon")
        lat_min, lat_max = _regular_axis(dataset.lat.values, "lat")
        meta = grid_meta(dataset)
        meta.update({"lon_min": lon_min, "lon_max": lon_max, "lat_min": lat_min, "lat_max": lat_max})
        meta["top_m"] = float(np.max(np.asarray(dataset.zf.values, dtype=np.float64)))
        return meta


def _domain_sample(dem: DemGrid, grid: dict[str, Any]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    lons = np.linspace(grid["lon_min"], grid["lon_max"], int(grid["nx"]))
    lats = np.linspace(grid["lat_min"], grid["lat_max"], int(grid["ny"]))
    query_lat, query_lon = np.meshgrid(lats, lons, indexing="ij")
    ground = sample_dem(dem, query_lon, query_lat)
    raw = sample_dem((dem.lons, dem.lats, dem.raw), query_lon, query_lat)
    geoid = sample_dem((dem.lons, dem.lats, dem.geoid), query_lon, query_lat)
    return ground, raw, geoid


def _metadata(
    nc_path: Path,
    dem_path: Path,
    grid: dict[str, Any],
    dem: DemGrid,
    ground: np.ndarray,
    raw_domain: np.ndarray,
    geoid_domain: np.ndarray,
    map_data,
    residuals: dict[str, float],
    dem_meta: dict[str, Any],
    ground_meta: dict[str, Any],
) -> dict[str, Any]:
    return {
        "version": 1,
        "source": {
            "dem": dem_path.name,
            "geoid": "EGM2008",
            "smoothing": "grey opening + grey closing (~150 m) + gaussian sigma 1 px",
            "nc": nc_path.name,
        },
        "grid": {
            "lon_min": grid["lon_min"],
            "lon_max": grid["lon_max"],
            "lat_min": grid["lat_min"],
            "lat_max": grid["lat_max"],
            "nx": grid["nx"],
            "ny": grid["ny"],
            "nz": grid["nz"],
            "top_m": grid["top_m"],
        },
        "map": {
            "terms": [list(term) for term in map_data.terms],
            "fwd": map_data.fwd.tolist(),
            "inv": map_data.inv.tolist(),
            "lon0": map_data.lon0,
            "lat0": map_data.lat0,
            "h_valid_m": [-100.0, 10100.0],
            "enu_unit_m": 10000,
            "residual_m": residuals,
        },
        "dem": {
            "file": "dem.u16.bin.br",
            "nx": int(dem.height.shape[1]),
            "ny": int(dem.height.shape[0]),
            "west": dem.west,
            "east": dem.east,
            "south": dem.south,
            "north": dem.north,
            "offset": dem_meta["offset"],
            "scale": dem_meta["scale"],
            "encoding": "u16le+br",
            "row_order": "north_to_south",
        },
        "ground": {
            "file": "ground.u16.bin.br",
            "nx": int(ground.shape[1]),
            "ny": int(ground.shape[0]),
            "offset": ground_meta["offset"],
            "scale": ground_meta["scale"],
            "encoding": "u16le+br",
            "row_order": "south_to_north",
            "stats": {
                "min": float(np.min(ground)),
                "max": float(np.max(ground)),
                "mean": float(np.mean(ground)),
            },
        },
        "stats": {
            "raw_dsm_min": float(np.min(raw_domain)),
            "raw_dsm_max": float(np.max(raw_domain)),
            "geoid_n_min": float(np.min(geoid_domain)),
            "geoid_n_max": float(np.max(geoid_domain)),
            "ellipsoid_min": float(np.min(ground)),
            "ellipsoid_max": float(np.max(ground)),
        },
    }


def _replace_atomically(temp_dir: Path, output: Path) -> None:
    backup = output.with_name(f".{output.name}.old")
    if backup.exists():
        shutil.rmtree(backup)
    if output.exists():
        os.replace(output, backup)
    try:
        os.replace(temp_dir, output)
    except Exception:
        if backup.exists() and not output.exists():
            os.replace(backup, output)
        raise
    if backup.exists():
        shutil.rmtree(backup)


def build(
    nc_path: str | Path,
    dem_path: str | Path,
    out_dir: str | Path = "data/web/geo",
    geoid_function: GeoidFunction | None = None,
) -> dict[str, Any]:
    """Build geo.json and the two compressed uint16 height fields."""

    nc_path, dem_path, output = Path(nc_path), Path(dem_path), Path(out_dir)
    grid = _read_grid(nc_path)
    dem = load_dem(
        dem_path,
        grid["lon_min"],
        grid["lon_max"],
        grid["lat_min"],
        grid["lat_max"],
        geoid_function=geoid_function,
    )
    ground, raw_domain, geoid_domain = _domain_sample(dem, grid)
    map_data, residuals = fit_mapping(
        grid["lon_min"], grid["lon_max"], grid["lat_min"], grid["lat_max"]
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(tempfile.mkdtemp(prefix=f".{output.name}.tmp-", dir=output.parent))
    temp_dir.chmod(0o755)  # mkdtemp is 0700; the data API may run as another user
    try:
        dem_meta = write_u16_brotli(temp_dir / "dem.u16.bin.br", dem.height)
        ground_meta = write_u16_brotli(temp_dir / "ground.u16.bin.br", ground)
        metadata = _metadata(
            nc_path,
            dem_path,
            grid,
            dem,
            ground,
            raw_domain,
            geoid_domain,
            map_data,
            residuals,
            dem_meta,
            ground_meta,
        )
        (temp_dir / "geo.json").write_text(
            json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        _replace_atomically(temp_dir, output)
    except Exception:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        raise
    return metadata


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nc", type=Path, required=True)
    parser.add_argument("--dem", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=Path("data/web/geo"))
    args = parser.parse_args(argv)
    metadata = build(args.nc, args.dem, args.out)
    print(json.dumps(metadata, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
