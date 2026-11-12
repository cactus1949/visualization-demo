"""SZ3 export format (pipeline/sz3pipe): error bounds per level, integer round trip, derived fields.
Delete together with pipeline/sz3pipe/ when the SZ3 format is dropped."""
import json

import numpy as np
import pandas as pd
import pytest
import xarray as xr

pysz = pytest.importorskip("pysz")
from pysz import sz  # noqa: E402

from sz3pipe.build_sz3 import build_sz3  # noqa: E402


def _frame(path, hour, rng):
    z, zf, lat, lon = np.arange(4) * 25 + 12.5, np.arange(5) * 25.0, np.linspace(39, 39.1, 20), np.linspace(117, 117.1, 24)
    shape = (4, 20, 24)
    yy, xx = np.meshgrid(np.linspace(0, 3, 20), np.linspace(0, 3, 24), indexing="ij")
    u = 5 + hour + np.sin(xx)[None] + 0.1 * rng.normal(size=shape)
    v = 3 - hour + np.cos(yy)[None] + 0.1 * rng.normal(size=shape)
    ustar = 0.5 + 0.1 * np.sin(xx + yy)
    prof = (1 - z / 100.0) ** (1 / 3)
    su = 2.4 * ustar[None] * prof[:, None, None]
    ds = xr.Dataset(
        {
            "u": (("z", "lat", "lon"), u), "v": (("z", "lat", "lon"), v),
            "w": (("zf", "lat", "lon"), 0.05 * rng.normal(size=(5, 20, 24))),
            "tke": (("z", "lat", "lon"), 1 + np.abs(np.sin(xx + hour))[None] * np.ones(shape)),
            "ustar": (("lat", "lon"), ustar), "sigma_u": (("z", "lat", "lon"), su),
            "u_gust": (("z", "lat", "lon"), np.hypot(u, v) + 2 * su),
            "risk_level": (("lat", "lon"), rng.integers(1, 4, (20, 24)).astype(np.float64)),
        },
        coords={"z": z, "zf": zf, "lat": lat, "lon": lon, "time": pd.Timestamp(f"2026-11-11T{hour:02d}:00:00")},
        attrs={"case": "synthetic", "dx_m": 60.0, "dy_m": 60.0, "ztop_m": 100.0},
    )
    ds.to_netcdf(path)


def test_build_sz3_roundtrip(tmp_path):
    rng = np.random.default_rng(1)
    paths = []
    for h in range(2):
        p = tmp_path / f"f{h:03d}.nc"; _frame(p, h, rng); paths.append(p)
    cfg = tmp_path / "variables.yaml"
    cfg.write_text("u: {}\nv: {}\nw: {}\ntke: {}\nustar: {}\nsigma_u: {}\nu_gust: {}\nrisk_level: {}\n")
    sz3cfg = tmp_path / "sz3.yaml"
    sz3cfg.write_text(
        "defaults: {bound: u8_half_step}\nu: {bound: f16_err}\nv: {bound: f16_err}\nrisk_level: {bound: integer}\n"
        "sigma_u: {derive: {op: profile, from: ustar, coef: 2.4, exponent: 0.3333333333333333}}\n"
        "u_gust: {derive: {op: gust, u: u, v: v, sigma: sigma_u}, max_err: 1.0}\n"
    )
    out = tmp_path / "web"
    m = build_sz3(paths, cfg, out, sz3cfg, workers=1)
    assert m["codec"] == "sz3" and m["prefetch_extra"] == 1
    assert [t["dir"] for t in m["times"]] == ["t000/", "t001/"]
    assert m["variables"]["sigma_u"]["encoding"] == "derived"
    assert m["variables"]["u_gust"]["encoding"] == "derived"
    for i, p in enumerate(paths):
        with xr.open_dataset(p) as ds:
            for name in ("tke", "risk_level", "u"):
                meta = m["variables"][name]
                idx = json.loads((out / f"t{i:03d}" / meta["index_file"]).read_text())
                blob = (out / f"t{i:03d}" / meta["file"]).read_bytes()
                parts = []
                for off, n in zip(idx["offsets"], idx["lengths"]):
                    r, _ = sz.decompress(np.frombuffer(blob[off:off + n], np.uint8), np.float32, tuple(idx["slab_shape"]))
                    parts.append(r)
                dec = np.stack(parts) if idx["per_level"] else parts[0]
                if idx.get("round"): dec = np.rint(dec)
                ref = ds[name].values.astype(np.float32).astype(np.float64)
                if name == "risk_level":
                    assert np.array_equal(dec, ref)
                else:
                    err = np.abs(dec - ref)
                    lv = err.reshape(err.shape[0], -1).max(axis=1)
                    assert np.all(lv <= np.asarray(idx["budgets"]) * 1.001 + 1e-9)
