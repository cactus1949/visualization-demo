"""DEM loading, smoothing, geoid conversion, interpolation and compact storage."""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Callable

import brotli
import numpy as np
import rasterio
from rasterio.windows import Window, from_bounds
from scipy import ndimage

GeoidFunction = Callable[[float, float], float]


@dataclass
class DemGrid:
    height: np.ndarray
    raw: np.ndarray
    geoid: np.ndarray
    lons: np.ndarray
    lats: np.ndarray
    west: float
    east: float
    south: float
    north: float


@lru_cache(maxsize=1)
def _geoid_transformer():
    import pyproj

    pyproj.network.set_network_enabled(True)
    return pyproj.Transformer.from_crs("EPSG:4979", "EPSG:4326+3855", always_xy=True)


def default_geoid_undulation(lon: float, lat: float) -> float:
    """Return EGM2008 N (ellipsoidal minus orthometric height) in metres."""

    transformer = _geoid_transformer()
    # At h=0 the compound transform returns the orthometric height (-N).
    value = float(-transformer.transform(float(lon), float(lat), 0.0)[2])
    if not np.isfinite(value):
        raise RuntimeError(
            "EGM2008 grid is unavailable; enable PROJ network access or provide a geoid function"
        )
    return value


def _window_for_bounds(src: rasterio.DatasetReader, west: float, south: float, east: float, north: float) -> Window:
    requested = from_bounds(west, south, east, north, src.transform)
    full = Window(0, 0, src.width, src.height)
    return requested.round_offsets().round_lengths().intersection(full)


def smoothing_window_pixels(transform, metres: float = 150.0) -> int:
    pixel_m = min(abs(float(transform.a)), abs(float(transform.e))) * 111320.0
    return max(3, int(math.ceil(metres / pixel_m)) | 1)


def _sample_geoid_grid(
    west: float, east: float, south: float, north: float, function: GeoidFunction, size: int = 9
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    coarse_lons = np.linspace(west, east, size)
    coarse_lats = np.linspace(south, north, size)
    values = np.array(
        [[float(function(lon, lat)) for lon in coarse_lons] for lat in coarse_lats],
        dtype=np.float64,
    )
    return coarse_lons, coarse_lats, values


def _bilinear_regular(
    lons: np.ndarray, lats: np.ndarray, values: np.ndarray, query_lon: np.ndarray, query_lat: np.ndarray
) -> np.ndarray:
    """Bilinear interpolation on a regular grid, accepting either latitude order."""

    if lats[0] > lats[-1]:
        lats = lats[::-1]
        values = values[::-1]
    qlon = np.asarray(query_lon, dtype=np.float64)
    qlat = np.asarray(query_lat, dtype=np.float64)
    qlon = np.clip(qlon, lons[0], lons[-1])
    qlat = np.clip(qlat, lats[0], lats[-1])
    fx = (qlon - lons[0]) / (lons[-1] - lons[0]) * (len(lons) - 1)
    fy = (qlat - lats[0]) / (lats[-1] - lats[0]) * (len(lats) - 1)
    ix = np.clip(np.floor(fx).astype(int), 0, len(lons) - 2)
    iy = np.clip(np.floor(fy).astype(int), 0, len(lats) - 2)
    tx = fx - ix
    ty = fy - iy
    a = values[iy, ix]
    b = values[iy, ix + 1]
    c = values[iy + 1, ix]
    d = values[iy + 1, ix + 1]
    return (1.0 - ty) * ((1.0 - tx) * a + tx * b) + ty * ((1.0 - tx) * c + tx * d)


def load_dem(
    path: str | Path,
    lon_min: float,
    lon_max: float,
    lat_min: float,
    lat_max: float,
    geoid_function: GeoidFunction | None = None,
    margin_deg: float = 0.2,
) -> DemGrid:
    """Load and smooth a DEM window, then convert orthometric H to ellipsoidal h."""

    geoid_function = geoid_function or default_geoid_undulation
    west, east = lon_min - margin_deg, lon_max + margin_deg
    south, north = lat_min - margin_deg, lat_max + margin_deg
    with rasterio.open(path) as src:
        window = _window_for_bounds(src, west, south, east, north)
        raw = src.read(1, window=window).astype(np.float64)
        transform = src.window_transform(window)
    if raw.ndim != 2 or min(raw.shape) < 2:
        raise ValueError("DEM window is empty or too small")
    ny, nx = raw.shape
    lons = transform.c + transform.a * (np.arange(nx) + 0.5)
    lats = transform.f + transform.e * (np.arange(ny) + 0.5)
    size = smoothing_window_pixels(transform)
    smoothed = ndimage.grey_opening(raw, size=(size, size))
    smoothed = ndimage.grey_closing(smoothed, size=(size, size))
    smoothed = ndimage.gaussian_filter(smoothed, sigma=1.0)
    coarse_lons, coarse_lats, coarse_values = _sample_geoid_grid(
        west, east, south, north, geoid_function
    )
    query_lon, query_lat = np.meshgrid(lons, lats)
    geoid = _bilinear_regular(
        coarse_lons, coarse_lats, coarse_values, query_lon, query_lat
    )
    if lats[0] < lats[-1]:
        lats = lats[::-1]
        raw = raw[::-1]
        smoothed = smoothed[::-1]
        geoid = geoid[::-1]
    return DemGrid(
        height=smoothed + geoid,
        raw=raw,
        geoid=geoid,
        lons=lons,
        lats=lats,
        west=float(lons[0]),
        east=float(lons[-1]),
        south=float(min(lats[0], lats[-1])),
        north=float(max(lats[0], lats[-1])),
    )


def sample_dem(grid: DemGrid | tuple[np.ndarray, np.ndarray, np.ndarray], lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    if isinstance(grid, DemGrid):
        return _bilinear_regular(grid.lons, grid.lats, grid.height, lon, lat)
    lons, lats, values = grid
    return _bilinear_regular(np.asarray(lons), np.asarray(lats), np.asarray(values), lon, lat)


def choose_scale(values: np.ndarray) -> float:
    value_range = float(np.nanmax(values) - np.nanmin(values))
    minimum = 0.01
    if value_range <= minimum * 65535.0:
        return minimum
    raw = value_range / 65535.0
    exponent = math.floor(math.log10(raw))
    unit = 10.0**exponent
    for factor in (1.0, 2.0, 5.0, 10.0):
        candidate = factor * unit
        if candidate >= raw:
            return candidate
    return 10.0 * unit


def encode_u16(values: np.ndarray) -> tuple[np.ndarray, float, float]:
    values = np.asarray(values, dtype=np.float64)
    offset = float(np.nanmin(values))
    scale = choose_scale(values)
    encoded = np.rint((values - offset) / scale).clip(0, 65535).astype("<u2")
    return encoded, offset, scale


def write_u16_brotli(path: str | Path, values: np.ndarray) -> dict[str, float | int | str]:
    encoded, offset, scale = encode_u16(values)
    raw = encoded.astype("<u2", copy=False).tobytes(order="C")
    Path(path).write_bytes(brotli.compress(raw, quality=9))
    return {
        "offset": offset,
        "scale": scale,
        "bytes_raw": len(raw),
        "bytes_compressed": Path(path).stat().st_size,
        "encoding": "u16le+br",
    }
