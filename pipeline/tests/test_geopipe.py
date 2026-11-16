import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

pytest.importorskip("scipy")
pytest.importorskip("rasterio")
pytest.importorskip("pyproj")

import rasterio
import xarray as xr
from rasterio.transform import from_origin

from geopipe.build import build
from geopipe.dem import encode_u16, load_dem, sample_dem
from geopipe.mapping import fit_mapping


LON_MIN, LON_MAX = 117.09612370490512, 117.30387629509488
LAT_MIN, LAT_MAX = 39.04887785555375, 39.21112214444626


def _write_inputs(tmp_path, values=None, irregular=False):
    nc = tmp_path / "f000.nc"
    lon = np.linspace(LON_MIN, LON_MAX, 6)
    lat = np.linspace(LAT_MIN, LAT_MAX, 5)
    if irregular:
        lon[3] += 1e-4
    ds = xr.Dataset(
        {"u": (("z", "lat", "lon"), np.zeros((2, lat.size, lon.size)))},
        coords={"lon": lon, "lat": lat, "z": [12.5, 37.5], "zf": [0.0, 25.0, 50.0]},
    )
    ds.to_netcdf(nc)
    dem = tmp_path / "dem.tif"
    data = np.asarray(values if values is not None else np.full((500, 500), 10.0), dtype="float32")
    with rasterio.open(
        dem,
        "w",
        driver="GTiff",
        width=data.shape[1],
        height=data.shape[0],
        count=1,
        dtype="float32",
        crs="EPSG:4326",
        transform=from_origin(116.6, 39.6, 0.002, 0.002),
    ) as dst:
        dst.write(data, 1)
    return nc, dem


def test_mapping_residuals_meet_tianjin_error_budget():
    _, residuals = fit_mapping(LON_MIN, LON_MAX, LAT_MIN, LAT_MAX)
    assert residuals["fwd_f64"] < 1e-4
    assert residuals["fwd_f32"] < 6e-3
    assert residuals["inv_f64"] < 6e-3
    assert residuals["inv_f32"] < 8e-3


def test_dem_smoothing_removes_small_spike_and_keeps_broad_hill(tmp_path):
    values = np.full((500, 500), 100.0)
    values[249:251, 249:251] = 140.0
    values[220:281, 350:451] += 20.0
    _, dem_path = _write_inputs(tmp_path, values)
    dem = load_dem(dem_path, LON_MIN, LON_MAX, LAT_MIN, LAT_MAX, lambda lon, lat: 0.0)
    assert abs(float(dem.height[101, 101]) - 100.0) < 1.0
    assert float(np.max(dem.height)) > 115.0


def test_geoid_is_added_and_u16_round_trip_is_bounded(tmp_path):
    _, dem_path = _write_inputs(tmp_path, np.full((500, 500), 10.0))
    dem = load_dem(dem_path, LON_MIN, LON_MAX, LAT_MIN, LAT_MAX, lambda lon, lat: -7.0)
    assert np.allclose(dem.height, 3.0)
    values = np.array([0.0, 1.234, 12.345])
    encoded, offset, scale = encode_u16(values)
    decoded = offset + encoded.astype(float) * scale
    assert np.max(np.abs(decoded - values)) <= scale / 2 + 1e-12


def test_ground_grid_is_south_to_north_and_matches_corners(tmp_path):
    rows = np.arange(500, dtype=float)[::-1, None]
    values = np.broadcast_to(rows, (500, 500))
    nc, dem_path = _write_inputs(tmp_path, values)
    result = build(nc, dem_path, tmp_path / "out", geoid_function=lambda lon, lat: -7.0)
    assert result["ground"]["stats"]["max"] > result["ground"]["stats"]["min"]
    raw = np.frombuffer(
        __import__("brotli").decompress((tmp_path / "out" / "ground.u16.bin.br").read_bytes()),
        dtype="<u2",
    ).reshape(5, 6)
    decoded = result["ground"]["offset"] + raw * result["ground"]["scale"]
    assert np.all(np.diff(decoded[:, 0]) > 0)
    assert decoded[0, 0] == pytest.approx(result["ground"]["stats"]["min"], abs=0.1)


def test_irregular_longitude_is_rejected(tmp_path):
    nc, dem = _write_inputs(tmp_path, irregular=True)
    with pytest.raises(ValueError, match="lon"):
        build(nc, dem, tmp_path / "out", geoid_function=lambda lon, lat: 0.0)


def test_cli_like_build_writes_only_documented_artifacts(tmp_path):
    nc, dem = _write_inputs(tmp_path)
    out = tmp_path / "out"
    result = build(nc, dem, out, geoid_function=lambda lon, lat: -7.0)
    assert sorted(p.name for p in out.iterdir()) == ["dem.u16.bin.br", "geo.json", "ground.u16.bin.br"]
    metadata = json.loads((out / "geo.json").read_text())
    assert metadata["version"] == 1
    assert {"grid", "map", "dem", "ground", "stats", "source"} <= metadata.keys()
    assert metadata["map"]["residual_m"] == result["map"]["residual_m"]


def test_frontend_fixture_matches_the_fitter():
    """web/src/geo/testdata/tianjin-map.json (used by the TS mapping tests) is what geopipe fits."""
    fixture = json.loads((Path(__file__).resolve().parents[2] / "web/src/geo/testdata/tianjin-map.json").read_text())
    grid = fixture["grid"]
    mapping, _ = fit_mapping(grid["lon_min"], grid["lon_max"], grid["lat_min"], grid["lat_max"], sample_count=1000)
    assert [list(t) for t in mapping.terms] == fixture["map"]["terms"]
    np.testing.assert_allclose(mapping.fwd, fixture["map"]["fwd"], rtol=1e-9, atol=1e-12)
    np.testing.assert_allclose(mapping.inv, fixture["map"]["inv"], rtol=1e-9, atol=1e-12)
