"""Round-trip the regenerated web payload against the source NetCDF."""
from pathlib import Path
import json
import brotli
import numpy as np
import xarray as xr
from ncpipe.quantize import decode_variable


NC = Path("data/lowair_atmos.nc")
WEB = Path("data/web/lowair_atmos")


def _load(name, meta):
    raw = brotli.decompress((WEB / meta["file"]).read_bytes())
    dtype = {"uint8": np.uint8, "uint16": "<u2", "float16": "<f2"}[meta["dtype"]]
    arr = np.frombuffer(raw, dtype=dtype).reshape(meta["shape"])
    return decode_variable(arr, meta)


def test_built_payload_error_bounds():
    if not (NC.exists() and (WEB / "manifest.json").exists()):
        return
    manifest = json.loads((WEB / "manifest.json").read_text())
    ds = xr.open_dataset(NC)
    w = 0.5 * (ds.w.isel(zf=slice(0, -1)).values + ds.w.isel(zf=slice(1, None)).values)

    rec_u = _load("u", manifest["variables"]["u"])
    err_u = np.max(np.abs(ds.u.values.astype(np.float64) - rec_u))
    assert err_u < 0.004, err_u

    rec_w = _load("w", manifest["variables"]["w"])
    w_scales = np.asarray(manifest["variables"]["w"]["level_scale"])
    err_w = np.max(np.abs(w.astype(np.float64) - rec_w))
    assert err_w <= w_scales.max() / 2 + 1e-6, (err_w, w_scales.max())

    rec_tke = _load("tke", manifest["variables"]["tke"])
    tke = ds.tke.values.astype(np.float64)
    # per-level u8: error is at most half a level scale
    scales = np.asarray(manifest["variables"]["tke"]["level_scale"])
    err_tke = np.max(np.abs(tke - rec_tke))
    assert err_tke <= scales.max() / 2 + 1e-6, (err_tke, scales.max())

    rec_sh = _load("wind_shear", manifest["variables"]["wind_shear"])
    sh = np.maximum(ds.wind_shear.values.astype(np.float64), 1e-12)
    rec_sh = np.maximum(rec_sh, 1e-12)
    log_err = np.max(np.abs(np.log10(sh) - np.log10(rec_sh)))
    assert log_err < 0.02, log_err

    rec_t2m = _load("t2m", manifest["variables"]["t2m"])
    t2m = ds.t2m.values.astype(np.float64)
    scale = manifest["variables"]["t2m"]["scale"]
    assert np.max(np.abs(t2m - rec_t2m)) <= scale / 2 + 1e-6
