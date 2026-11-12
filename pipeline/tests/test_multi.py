"""Multi-time export: shared quantisation grid, frame dirs, literal times, integer risk_level."""
import json

import brotli
import numpy as np
import pandas as pd
import xarray as xr

from ncpipe.build_multi import build_multi
from ncpipe.quantize import decode_variable


def _frame(path, hour, rng, base):
    z, zf, lat, lon = np.arange(3) * 25 + 12.5, np.arange(4) * 25.0, np.linspace(39, 39.1, 5), np.linspace(117, 117.1, 6)
    shape = (3, 5, 6)
    ds = xr.Dataset(
        {
            "u": (("z", "lat", "lon"), base + hour + rng.normal(0, 1, shape)),
            "v": (("z", "lat", "lon"), base - hour + rng.normal(0, 1, shape)),
            "w": (("zf", "lat", "lon"), rng.normal(0, 0.05 * (hour + 1), (4, 5, 6))),
            "tke": (("z", "lat", "lon"), np.abs(rng.normal(hour + 1, 1, shape))),
            "risk_level": (("lat", "lon"), rng.integers(1, 4, (5, 6)).astype(np.float64)),
        },
        coords={"z": z, "zf": zf, "lat": lat, "lon": lon, "time": pd.Timestamp(f"2026-11-11T{hour:02d}:00:00")},
        attrs={"case": "synthetic", "dx_m": 60.0, "dy_m": 60.0},
    )
    ds.to_netcdf(path)


def test_build_multi_roundtrip(tmp_path):
    rng = np.random.default_rng(0)
    paths = []
    for h in range(3):
        p = tmp_path / f"f{h:03d}.nc"
        _frame(p, h, rng, 5.0)
        paths.append(p)
    cfg = tmp_path / "variables.yaml"
    cfg.write_text("u: {}\nv: {}\nw: {}\ntke: {}\nrisk_level: {}\n")
    quant = tmp_path / "quant.yaml"
    quant.write_text(
        "u: {encoding: f16, display_range: [-15, 15]}\nv: {encoding: f16, display_range: [-15, 15]}\n"
        "w: {encoding: u8_linear, range_scope: per_level}\ntke: {encoding: u8_linear, range_scope: per_level}\n"
        "risk_level: {encoding: u8_int}\n"
    )
    out = tmp_path / "web"
    m = build_multi(paths, cfg, out, quant)
    assert m["schema_version"] == 4
    assert [t["dir"] for t in m["times"]] == ["t000/", "t001/", "t002/"]
    assert m["times"][2]["valid_time"] == "2026-11-11T02:00:00"
    assert m["times"][2]["lead_h"] == 2
    disk = json.loads((out / "manifest.json").read_text())
    assert disk["variables"]["tke"]["level_scale"] == m["variables"]["tke"]["level_scale"]
    for name in ("tke", "w", "risk_level", "u"):
        meta = m["variables"][name]
        assert len(meta["frames"]) == 3
        for i, p in enumerate(paths):
            raw = brotli.decompress((out / f"t{i:03d}" / meta["file"]).read_bytes())
            dtype = {"float16": "<f2", "uint16": "<u2", "uint8": "u1"}[meta["dtype"]]
            q = np.frombuffer(raw, dtype=dtype).reshape(meta["shape"])
            decoded = decode_variable(q, meta)  # one shared scale/offset for every frame
            with xr.open_dataset(p) as ds:
                ref = ds[name].values if name != "w" else 0.5 * (ds.w.values[:-1] + ds.w.values[1:])
            err = np.abs(decoded - ref).max()
            if name == "risk_level":
                assert err == 0
            elif name == "u":
                assert err < 0.01
            else:
                step = max(meta["level_scale"])
                assert err <= step * 0.5 + 1e-9
    # union range covers every frame
    tke = m["variables"]["tke"]
    assert tke["data_min"] == min(f["data_min"] for f in tke["frames"])
    assert tke["data_max"] == max(f["data_max"] for f in tke["frames"])
