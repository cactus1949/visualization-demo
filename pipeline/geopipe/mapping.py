"""Polynomial mapping between the atmospheric grid and a local ENU frame."""

from __future__ import annotations

import itertools
from dataclasses import dataclass

import numpy as np

TERMS = tuple(
    (i, j, k)
    for i in range(4)
    for j in range(4 - i)
    for k in range(min(2, 4 - i - j))
)
WGS84_A = 6378137.0
WGS84_F = 1.0 / 298.257223563
WGS84_E2 = WGS84_F * (2.0 - WGS84_F)


@dataclass(frozen=True)
class Mapping:
    terms: tuple[tuple[int, int, int], ...]
    fwd: np.ndarray
    inv: np.ndarray
    lon0: float
    lat0: float
    east_span_m: float
    north_span_m: float


def _ecef(lon: np.ndarray, lat: np.ndarray, height_m: np.ndarray) -> np.ndarray:
    lon_r = np.radians(lon)
    lat_r = np.radians(lat)
    sin_lat = np.sin(lat_r)
    n = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat**2)
    return np.stack(
        [
            (n + height_m) * np.cos(lat_r) * np.cos(lon_r),
            (n + height_m) * np.cos(lat_r) * np.sin(lon_r),
            (n * (1.0 - WGS84_E2) + height_m) * sin_lat,
        ],
        axis=-1,
    )


def enu_coordinates(
    lon: np.ndarray, lat: np.ndarray, height_m: np.ndarray, lon0: float, lat0: float
) -> np.ndarray:
    """Return exact WGS84 ENU coordinates in metres around ``(lon0, lat0, 0)``."""

    lon0_r = np.radians(lon0)
    lat0_r = np.radians(lat0)
    rotation = np.array(
        [
            [-np.sin(lon0_r), np.cos(lon0_r), 0.0],
            [
                -np.sin(lat0_r) * np.cos(lon0_r),
                -np.sin(lat0_r) * np.sin(lon0_r),
                np.cos(lat0_r),
            ],
            [
                np.cos(lat0_r) * np.cos(lon0_r),
                np.cos(lat0_r) * np.sin(lon0_r),
                np.sin(lat0_r),
            ],
        ]
    )
    origin = _ecef(np.asarray(lon0), np.asarray(lat0), np.asarray(0.0))
    ecef = _ecef(np.asarray(lon), np.asarray(lat), np.asarray(height_m))
    return (ecef - origin) @ rotation.T


def basis(u: np.ndarray, v: np.ndarray, w: np.ndarray, dtype=None) -> np.ndarray:
    """Evaluate the fixed 16-term cubic basis in the documented term order."""

    if dtype is None:
        dtype = np.result_type(u, v, w, np.float64)
    u = np.asarray(u, dtype=dtype)
    v = np.asarray(v, dtype=dtype)
    w = np.asarray(w, dtype=dtype)
    return np.stack([u**i * v**j * w**k for i, j, k in TERMS], axis=-1)


def _fit_coefficients(
    lon: np.ndarray,
    lat: np.ndarray,
    height_m: np.ndarray,
    lon_min: float,
    lon_max: float,
    lat_min: float,
    lat_max: float,
    lon0: float,
    lat0: float,
) -> tuple[np.ndarray, np.ndarray, float, float]:
    u = (lon - lon_min) / (lon_max - lon_min)
    v = (lat - lat_min) / (lat_max - lat_min)
    w = height_m / 10000.0
    enu = enu_coordinates(lon, lat, height_m, lon0, lat0)
    fwd_design = basis(u, v, w)
    fwd = np.linalg.lstsq(fwd_design, enu / 10000.0, rcond=None)[0]
    inv_design = basis(enu[:, 0] / 10000.0, enu[:, 1] / 10000.0, enu[:, 2] / 10000.0)
    inv = np.linalg.lstsq(inv_design, np.stack([u, v, w], axis=-1), rcond=None)[0]
    return fwd.T, inv.T, float(fwd_design.shape[1]), float(inv_design.shape[1])


def fit_mapping(
    lon_min: float,
    lon_max: float,
    lat_min: float,
    lat_max: float,
    seed: int = 0,
    sample_count: int = 200000,
) -> tuple[Mapping, dict[str, float]]:
    """Fit the forward/inverse maps and return fixed-seed residual maxima in metres."""

    if not lon_max > lon_min or not lat_max > lat_min:
        raise ValueError("longitude and latitude bounds must be increasing")
    lon0 = (lon_min + lon_max) / 2.0
    lat0 = (lat_min + lat_max) / 2.0
    lattice = np.array(
        list(
            itertools.product(
                np.linspace(lon_min, lon_max, 41),
                np.linspace(lat_min, lat_max, 41),
                np.linspace(-100.0, 10100.0, 11),
            )
        ),
        dtype=np.float64,
    )
    fwd, inv, _, _ = _fit_coefficients(
        lattice[:, 0],
        lattice[:, 1],
        lattice[:, 2],
        lon_min,
        lon_max,
        lat_min,
        lat_max,
        lon0,
        lat0,
    )
    sin_lat0 = np.sin(np.radians(lat0))
    n0 = WGS84_A / np.sqrt(1.0 - WGS84_E2 * sin_lat0**2)
    m0 = WGS84_A * (1.0 - WGS84_E2) / (1.0 - WGS84_E2 * sin_lat0**2) ** 1.5
    east_span = np.radians(lon_max - lon_min) * n0 * np.cos(np.radians(lat0))
    north_span = np.radians(lat_max - lat_min) * m0
    mapping = Mapping(tuple(TERMS), fwd, inv, lon0, lat0, east_span, north_span)

    rng = np.random.default_rng(seed)
    points = np.column_stack(
        [
            rng.uniform(lon_min, lon_max, sample_count),
            rng.uniform(lat_min, lat_max, sample_count),
            rng.uniform(-100.0, 10100.0, sample_count),
        ]
    )
    u = (points[:, 0] - lon_min) / (lon_max - lon_min)
    v = (points[:, 1] - lat_min) / (lat_max - lat_min)
    w = points[:, 2] / 10000.0
    exact_enu = enu_coordinates(points[:, 0], points[:, 1], points[:, 2], lon0, lat0)
    forward64 = basis(u, v, w) @ fwd.T * 10000.0
    forward32 = (basis(u, v, w, dtype=np.float32) @ fwd.astype(np.float32).T).astype(
        np.float64
    ) * 10000.0
    fwd_f64 = np.linalg.norm(forward64 - exact_enu, axis=1)
    fwd_f32 = np.linalg.norm(forward32 - exact_enu, axis=1)
    true_uvw = np.stack([u, v, w], axis=-1)
    inv_design = basis(
        exact_enu[:, 0] / 10000.0,
        exact_enu[:, 1] / 10000.0,
        exact_enu[:, 2] / 10000.0,
    )
    inv_design32 = basis(
        exact_enu[:, 0] / 10000.0,
        exact_enu[:, 1] / 10000.0,
        exact_enu[:, 2] / 10000.0,
        dtype=np.float32,
    )
    inverse64 = inv_design @ inv.T
    inverse32 = (inv_design32 @ inv.astype(np.float32).T).astype(np.float64)
    def inverse_error(values: np.ndarray) -> np.ndarray:
        components = np.column_stack(
            [
                (values[:, 0] - true_uvw[:, 0]) * east_span,
                (values[:, 1] - true_uvw[:, 1]) * north_span,
                (values[:, 2] - true_uvw[:, 2]) * 10000.0,
            ]
        )
        return np.linalg.norm(components, axis=1)

    residuals = {
        "fwd_f64": float(fwd_f64.max()),
        "fwd_f32": float(fwd_f32.max()),
        "inv_f64": float(inverse_error(inverse64).max()),
        "inv_f32": float(inverse_error(inverse32).max()),
    }
    return mapping, residuals

