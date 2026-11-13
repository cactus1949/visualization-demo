"""Behaviour tests for the SZ3 v2 exporter."""
import json
import zlib

import numpy as np
import pytest
import xarray as xr

from sz3pipe import build_sz3 as module
from sz3pipe.build_sz3 import build_sz3, encode_field

pytest.importorskip("pysz")


def _decode(pack, index):
    slabs = []
    for slab in index["slabs"]:
        shape = tuple(index["slab_shape"])
        if slab["kind"] == "const":
            values = np.full(shape, slab["value"], np.float64)
        elif slab["kind"] == "sz3":
            compressed = np.frombuffer(pack[slab["offset"]:slab["offset"] + slab["length"]], np.uint8)
            values, _ = module.sz.decompress(compressed, np.float32, shape)
            values = values.astype(np.float64)
        elif slab["kind"] in ("u8", "f16"):
            raw = zlib.decompress(pack[slab["offset"]:slab["offset"] + slab["length"]])
            values = np.frombuffer(raw, "<u1" if slab["kind"] == "u8" else "<f2").reshape(shape).astype(np.float64)
            if slab["kind"] == "u8":
                values = values * slab["scale"] + slab["add"]
        else:
            raise AssertionError(slab)
        if "nan" in slab:
            mask = np.frombuffer(pack[slab["nan"]["offset"]:slab["nan"]["offset"] + slab["nan"]["length"]], "<u4")
            valid = True; pos = 0
            for count in mask:
                if not valid:
                    values.ravel()[pos:pos + int(count)] = np.nan
                pos += int(count); valid = not valid
        slabs.append(values)
    out = np.stack(slabs) if index["per_level"] else slabs[0]
    if index.get("transform") == "log10":
        out = 10 ** out
    if index.get("round"):
        out = np.rint(out)
    return out


def _write_frame(path, values):
    nz, ny, nx = values.shape
    ds = xr.Dataset({"u": (("z", "lat", "lon"), values)},
                    coords={"z": np.arange(nz) + 0.5, "zf": np.arange(nz + 1),
                            "lat": np.arange(ny), "lon": np.arange(nx),
                            "time": np.datetime64("2026-01-01")}, attrs={"ztop_m": float(nz)})
    ds.to_netcdf(path)


def _level_err(decoded, values):
    err = np.abs(decoded.astype(np.float64) - values.astype(np.float64))
    return np.nanmax(err.reshape(err.shape[0], -1), axis=1)


def test_bound_is_min_of_p_and_level_range_over_512():
    rng = np.random.default_rng(0)
    narrow = 1.0 + 0.1 * rng.random((30, 30))            # range 0.1 -> 0.1/512 < P
    wide = rng.random((30, 30)); wide[3, 4] += 50.0       # spike: range 50 -> P binds
    values = np.stack([narrow, wide]).astype(np.float32)
    pack, index, decoded = encode_field(values, {"name": "u", "P": 0.004, "codec": "sz3"})
    ebs = [s["eb"] for s in index["slabs"]]
    assert ebs[0] == pytest.approx(float(np.ptp(values[0])) / 512)
    assert ebs[1] == pytest.approx(0.004)
    assert np.all(_level_err(decoded, values) <= np.asarray(ebs) * (1 + 1e-5) + 1e-7)
    assert np.allclose(_decode(pack, index), decoded, atol=1e-6)


def test_log10_variable_bound_is_in_log_domain():
    values = np.geomspace(1e-4, 0.2, 900, dtype=np.float32).reshape(1, 30, 30)
    pack, index, decoded = encode_field(values, {"name": "wind_shear", "P": 0.002, "transform": "log10", "codec": "sz3"})
    rel = np.abs(np.log10(decoded) - np.log10(values)).max()
    assert rel <= index["slabs"][0]["eb"] * (1 + 1e-4) + 1e-7
    assert np.allclose(_decode(pack, index), decoded, rtol=1e-5)


def test_all_zero_and_constant_levels_store_no_bytes_and_are_exact():
    values = np.zeros((3, 8, 8), np.float32); values[1] = 2.5
    pack, index, decoded = encode_field(values, {"name": "u", "P": 0.004, "codec": "sz3"})
    assert [s["kind"] for s in index["slabs"]] == ["const", "const", "const"]
    assert len(pack) == 0 and np.array_equal(decoded, values) and np.array_equal(_decode(pack, index), values)


def test_mixed_const_and_sz3_levels_decode_in_order():
    values = np.zeros((3, 8, 8), np.float32); values[1] = np.linspace(0, 1, 64).reshape(8, 8)
    pack, index, decoded = encode_field(values, {"name": "u", "P": 0.004, "codec": "sz3"})
    assert [s["kind"] for s in index["slabs"]] == ["const", "sz3", "const"]
    out = _decode(pack, index)
    assert np.array_equal(out[[0, 2]], values[[0, 2]]) and np.abs(out[1] - values[1]).max() <= 1 / 512 + 1e-6


def test_nan_mask_restores_missing_cells_exactly():
    values = np.linspace(0, 1, 2 * 10 * 10, dtype=np.float32).reshape(2, 10, 10)
    values[0, 0, 0] = np.nan                               # mask starting with a missing run
    values[0, 4:6, 2:9] = np.nan
    values[1] = np.nan                                     # all-NaN level -> const null
    pack, index, decoded = encode_field(values, {"name": "u", "P": 0.004, "codec": "sz3"})
    assert index["slabs"][1] == {"kind": "const", "value": None}
    out = _decode(pack, index)
    assert np.array_equal(np.isnan(out), np.isnan(values)) and np.array_equal(np.isnan(decoded), np.isnan(values))
    finite = np.isfinite(values)
    assert np.abs(out[finite] - values[finite]).max() <= index["slabs"][0]["eb"] * (1 + 1e-5) + 1e-7


def test_fill_value_and_missing_value_are_treated_as_missing(tmp_path):
    raw = np.arange(2 * 4 * 5, dtype=np.float32).reshape(2, 4, 5); raw[0, 1, 1] = -999.0
    cleaned = module._clean_values(raw, {"missing_value": -999.0})
    assert np.isnan(cleaned[0, 1, 1]) and np.isfinite(cleaned).sum() == raw.size - 1
    nc = tmp_path / "f000.nc"; _write_frame(nc, raw)
    with xr.open_dataset(nc) as ds:
        enc = {"u": {"_FillValue": -999.0}}
        ds.load().to_netcdf(tmp_path / "f.nc", encoding=enc)
    variables = tmp_path / "variables.yaml"; variables.write_text("u: {}\n")
    config = tmp_path / "sz3.yaml"; config.write_text("defaults: {P: 0.004, codec: sz3}\n")
    out = tmp_path / "out"; manifest = build_sz3([tmp_path / "f.nc"], variables, out, config, workers=1)
    assert manifest["variables"]["u"]["nan_count"] == 1 and manifest["variables"]["u"]["data_min"] == 0.0
    index = json.loads((out / "t000" / "u.json").read_text())
    dec = _decode((out / "t000" / "u.sz3pack").read_bytes(), index)
    assert np.isnan(dec[0, 1, 1]) and np.isfinite(dec).sum() == raw.size - 1


def test_codec_choice_sparse_quant_dense_sz3_and_integer_exact():
    sparse = np.zeros((2, 10, 10), np.float32); sparse[0, 0, 0] = 10
    _, sparse_index, _ = encode_field(sparse, {"name": "icing_index", "P": 0.002, "codec": "auto", "sparse_frac": 0.01})
    assert sparse_index["codec"] == "quant" and sparse_index["fallback"] == "sparse"
    dense = np.random.default_rng(1).random((2, 10, 10)).astype(np.float32)
    _, dense_index, _ = encode_field(dense, {"name": "u", "P": 0.004, "codec": "auto", "sparse_frac": 0.01})
    assert dense_index["codec"] == "sz3" and dense_index["tier"] == "x1"
    integer = np.array([[0, 1], [2, 255]], np.float32)
    pack, index, _decoded = encode_field(integer, {"name": "risk_level", "P": "integer", "codec": "quant"})
    assert index["slabs"][0]["kind"] == "u8"
    assert np.array_equal(_decode(pack, index), integer)
    with pytest.raises(ValueError, match="risk_level"):
        encode_field(integer + 0.5, {"name": "risk_level", "P": "integer", "codec": "quant"})


def _corrupting(module, when):
    original = module._compress

    def compress(values, eb):
        compressed, reconstructed = original(values, eb)
        if when(eb):
            reconstructed = reconstructed.copy(); reconstructed.flat[0] += eb * 3
        return compressed, reconstructed
    return compress


def test_ladder_steps_down_when_x1_fails(monkeypatch):
    values = np.arange(16, dtype=np.float32).reshape(2, 2, 4)
    full = min(0.004, 7 / 512)
    monkeypatch.setattr(module, "_compress", _corrupting(module, lambda eb: eb > full * 0.5))
    _, index, _ = encode_field(values, {"name": "u", "P": 0.004, "codec": "sz3"})
    assert index["tier"] == "x0.25" and index["fallback"] == ""
    assert all(s["eb"] == pytest.approx(full * 0.25) for s in index["slabs"])


def test_ladder_falls_back_to_quant_with_reason(monkeypatch):
    values = np.linspace(-3, 5, 2 * 6 * 6, dtype=np.float32).reshape(2, 6, 6)
    monkeypatch.setattr(module, "_compress", _corrupting(module, lambda eb: True))
    pack, index, decoded = encode_field(values, {"name": "v", "P": 0.004, "codec": "sz3", "fallback": "u8"})
    assert index["codec"] == "quant" and index["tier"] == "quant" and index["fallback"].startswith("max_err level")
    half_step = np.ptp(values.reshape(2, -1), axis=1) / 255 / 2
    assert np.all(_level_err(_decode(pack, index), values) <= half_step * 1.001)
    _, f16_index, f16_dec = encode_field(values, {"name": "u", "P": 0.004, "codec": "sz3", "fallback": "f16"})
    assert {s["kind"] for s in f16_index["slabs"]} == {"f16"}
    assert np.abs(f16_dec - values).max() <= 0.004


def test_missing_p_is_rejected_and_report_matches_manifest(tmp_path):
    values = np.arange(16, dtype=np.float32).reshape(2, 2, 4)
    nc = tmp_path / "f000.nc"; _write_frame(nc, values)
    variables = tmp_path / "variables.yaml"; variables.write_text("u: {}\n")
    missing = tmp_path / "missing.yaml"; missing.write_text("defaults: {codec: auto}\n")
    with pytest.raises(ValueError, match="u"):
        build_sz3([nc], variables, tmp_path / "missing-out", missing, workers=1)
    config = tmp_path / "sz3.yaml"; config.write_text("defaults: {P: 0.004, codec: auto}\n")
    out = tmp_path / "out"; manifest = build_sz3([nc], variables, out, config, workers=1)
    report = json.loads((out / "sz3_report.json").read_text())
    frame = manifest["variables"]["u"]["frames"][0]
    assert frame["tier"] == report["variables"]["u"]["frames"][0]["tier"] == "x1"
    assert report["totals"]["tiers"]["x1"] == 1


def _synthetic_frame(path, hour, rng):
    z, zf, lat, lon = np.arange(4) * 25 + 12.5, np.arange(5) * 25.0, np.linspace(39, 39.1, 20), np.linspace(117, 117.1, 24)
    shape = (4, 20, 24)
    yy, xx = np.meshgrid(np.linspace(0, 3, 20), np.linspace(0, 3, 24), indexing="ij")
    u = 5 + hour + np.sin(xx)[None] + 0.1 * rng.normal(size=shape)
    v = 3 - hour + np.cos(yy)[None] + 0.1 * rng.normal(size=shape)
    ustar = 0.5 + 0.1 * np.sin(xx + yy)
    su = 2.4 * ustar[None] * ((1 - z / 100.0) ** (1 / 3))[:, None, None]
    ds = xr.Dataset({"u": (("z", "lat", "lon"), u), "v": (("z", "lat", "lon"), v), "ustar": (("lat", "lon"), ustar),
                     "sigma_u": (("z", "lat", "lon"), su), "u_gust": (("z", "lat", "lon"), np.hypot(u, v) + 2 * su)},
                    coords={"z": z, "zf": zf, "lat": lat, "lon": lon, "time": np.datetime64(f"2026-11-11T{hour:02d}:00")},
                    attrs={"dx_m": 60.0, "ztop_m": 100.0})
    ds.to_netcdf(path)


def test_derived_fields_stay_derived_when_inputs_are_accurate(tmp_path):
    rng = np.random.default_rng(1); paths = []
    for h in range(2):
        p = tmp_path / f"f{h:03d}.nc"; _synthetic_frame(p, h, rng); paths.append(p)
    variables = tmp_path / "variables.yaml"; variables.write_text("u: {}\nv: {}\nustar: {}\nsigma_u: {}\nu_gust: {}\n")
    config = tmp_path / "sz3.yaml"
    config.write_text("defaults: {codec: auto}\nu: {P: 0.004}\nv: {P: 0.004}\nustar: {P: 0.0002}\n"
                      "sigma_u: {P: 0.0005, derive: {op: profile, from: ustar, coef: 2.4, exponent: 0.3333333333333333}}\n"
                      "u_gust: {P: 0.005, derive: {op: gust, u: u, v: v, sigma: sigma_u}, max_err: 0.0094}\n")
    m = build_sz3(paths, variables, tmp_path / "web", config, workers=1)
    assert m["variables"]["sigma_u"]["encoding"] == "derived" and m["variables"]["u_gust"]["encoding"] == "derived"
    assert max(f["max_err"] for f in m["variables"]["sigma_u"]["frames"]) <= 0.0005 * 2


def test_acceptance_allows_the_float32_rounding_of_the_input():
    # SZ3 guarantees eb against the float32 input; the true (float64) value can be half an ulp away.
    true = np.array([[-2.1061543295741734, -1.0, -3.0]], np.float64)
    eb = 4.32e-4
    rec = true.astype(np.float32).astype(np.float64) - np.array([[eb, 0.0, 0.0]])
    assert np.abs(rec - true).max() > eb * (1 + 1e-5) + 1e-7    # would have failed without the slack
    info = {"valid": np.ones(true.shape, bool), "eb": eb}
    ok, why, _ = module._acceptance(true, rec, [info], 0.6, [eb])
    assert ok, why


def test_missing_input_of_a_derived_field_keeps_manifest_strict_json(tmp_path):
    rng = np.random.default_rng(2)
    p = tmp_path / "f000.nc"; _synthetic_frame(p, 0, rng)
    with xr.open_dataset(p) as ds:
        ds = ds.load()
    u = ds["u"].values.copy(); u[0, 2:5, 3:7] = np.nan; ds["u"].values[:] = u
    p2 = tmp_path / "nan.nc"; ds.to_netcdf(p2, encoding={"u": {"_FillValue": -9999.0}})
    variables = tmp_path / "variables.yaml"; variables.write_text("u: {}\nv: {}\nustar: {}\nsigma_u: {}\nu_gust: {}\n")
    config = tmp_path / "sz3.yaml"
    config.write_text("defaults: {codec: auto}\nu: {P: 0.004}\nv: {P: 0.004}\nustar: {P: 0.0002}\n"
                      "sigma_u: {P: 0.0005, derive: {op: profile, from: ustar, coef: 2.4, exponent: 0.3333333333333333}}\n"
                      "u_gust: {P: 0.005, derive: {op: gust, u: u, v: v, sigma: sigma_u}, max_err: 0.0094}\n")
    out = tmp_path / "web"; build_sz3([p2], variables, out, config, workers=1)
    strict = lambda text: json.loads(text, parse_constant=lambda c: (_ for _ in ()).throw(ValueError(c)))
    m = strict((out / "manifest.json").read_text())
    strict((out / "sz3_report.json").read_text())
    assert m["variables"]["u"]["nan_count"] == 12
    assert m["variables"]["u_gust"]["encoding"] == "derived" and np.isfinite(m["variables"]["u_gust"]["frames"][0]["max_err"])
