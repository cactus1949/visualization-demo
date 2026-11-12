"""Several NetCDF time steps -> SZ3 (T1L) web payload, schema 4 manifest.

Layout (same timeline as the current format)::

    out/manifest.json                 codec "sz3", every variable encoding "sz3" or "derived"
    out/t000/u.sz3pack + u.json       SZ3 streams back to back + index (offsets/lengths/shape)

Reading the nc files and building grid/timeline is shared (``ncpipe.ncread``); everything
about SZ3 lives here and in ``config/sz3_config.yaml``.
"""
from __future__ import annotations

import json, os, time
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import numpy as np, xarray as xr, yaml
from pysz import sz, szConfig, szErrorBoundMode

from ncpipe.ncread import TIME_NOTE, frame_times, grid_meta, jsonable, kept_attrs, open_frames, read_values

INT_BOUND = 0.49


def _compress(a32: np.ndarray, eb: float) -> tuple[bytes, np.ndarray]:
    cfg = szConfig(); cfg.errorBoundMode = szErrorBoundMode.ABS; cfg.absErrorBound = float(eb)
    c, _ = sz.compress(np.ascontiguousarray(a32, np.float32), cfg)
    r, _ = sz.decompress(c, np.float32, a32.shape)
    return c.tobytes(), r


def _domain(values32: np.ndarray, transform: str | None) -> np.ndarray:
    v = values32.astype(np.float64)
    if transform == "log10":
        return np.log10(np.maximum(v, 1e-12))
    return v


def _inverse(dom32: np.ndarray, transform: str | None) -> np.ndarray:
    if transform == "log10":
        return (10 ** dom32.astype(np.float64)).astype(np.float32)
    return dom32


def _half_step(dom: np.ndarray) -> float:
    finite = dom[np.isfinite(dom)]
    lo, hi = (float(finite.min()), float(finite.max())) if finite.size else (0.0, 1.0)
    if hi <= lo:
        hi = lo + max(abs(lo) * 1e-12, 1e-12)
    return max((hi - lo) / 255.0 / 2.0, 1e-12)


def _budgets(values32: np.ndarray, dom: np.ndarray, rule: str) -> list[float]:
    levels = values32.shape[0] if values32.ndim >= 3 else 1
    if rule == "integer":
        return [INT_BOUND] * levels
    if rule == "f16_err":
        err = float(np.abs(values32.astype(np.float16).astype(np.float32).astype(np.float64) - values32.astype(np.float64)).max())
        return [max(err, 1e-12)] * levels
    if rule == "u8_half_step":
        return [_half_step(dom[z]) for z in range(levels)] if values32.ndim >= 3 else [_half_step(dom)]
    raise ValueError(f"unknown bound {rule!r}")


def encode_field(values32: np.ndarray, spec: dict[str, Any]) -> tuple[bytes, dict[str, Any], np.ndarray]:
    """One variable, one frame -> (pack bytes, index json, reconstructed float32 physical values)."""
    transform = spec.get("transform")
    dom = _domain(values32, transform)
    rule = spec.get("bound", "u8_half_step")
    budgets = _budgets(values32, dom, rule)
    per_level = values32.ndim >= 3
    slabs = [np.ascontiguousarray(dom[z], np.float32) for z in range(values32.shape[0])] if per_level else [np.ascontiguousarray(dom, np.float32)]
    blobs, recs = [], []
    for a, b in zip(slabs, budgets):
        c, r = _compress(a, b); blobs.append(c); recs.append(r)
    rec = _inverse(np.stack(recs) if per_level else recs[0], transform)
    if rule == "integer":
        rec = np.rint(rec).astype(np.float32)
    lengths = [len(x) for x in blobs]
    index = {"name": spec["name"], "shape": list(values32.shape), "per_level": per_level, "slab_shape": list(slabs[0].shape),
             "transform": transform, "round": rule == "integer", "bound": rule,
             "offsets": np.cumsum([0] + lengths).tolist()[:-1], "lengths": lengths, "budgets": budgets}
    return b"".join(blobs), index, rec


def derive(op: dict[str, Any], get, levels_m: Sequence[float], ztop: float) -> np.ndarray:
    """Same formulas as the browser (web/src/data/codecs/sz3.ts)."""
    if op["op"] == "copy":
        return get(op["from"]).astype(np.float64)
    if op["op"] == "profile":
        z = np.asarray(levels_m, np.float64)
        prof = np.maximum(1.0 - z / ztop, 0.0) ** float(op.get("exponent", 1 / 3))
        return float(op["coef"]) * get(op["from"]).astype(np.float64)[None] * prof[:, None, None]
    if op["op"] == "gust":
        u, v, s = (get(op[k]).astype(np.float64) for k in ("u", "v", "sigma"))
        return np.hypot(u, v) + 2.0 * s
    raise ValueError(f"unknown derive op {op['op']!r}")


def _derive_order(names: list[str], specs: dict[str, dict]) -> list[str]:
    """Derived names after the names they need (sigma_u before u_gust)."""
    done, out = set(n for n in names if "derive" not in specs[n]), []
    pending = [n for n in names if "derive" in specs[n]]
    while pending:
        progress = False
        for n in list(pending):
            op = specs[n]["derive"]
            deps = [op[k] for k in ("from", "u", "v", "sigma") if k in op]
            if all(d in done for d in deps):
                out.append(n); done.add(n); pending.remove(n); progress = True
        if not progress:
            raise ValueError(f"derive cycle or missing input: {pending}")
    return out


def _encode_frame(job: tuple) -> dict[str, Any]:
    path, names, specs, levels_m, ztop, frame_dir = job
    t0 = time.perf_counter()
    ds = xr.open_dataset(path)
    true: dict[str, np.ndarray] = {}
    rec: dict[str, np.ndarray] = {}
    out: dict[str, Any] = {"vars": {}, "derive": {}}
    for name in names:
        true[name] = read_values(ds, name)[0].squeeze().astype(np.float32) if name != "w" else read_values(ds, name)[0].astype(np.float32)
    stored = [n for n in names if "derive" not in specs[n]]
    derived = _derive_order(names, specs)

    def write(name: str) -> None:
        pack, index, r = encode_field(true[name], dict(specs[name], name=name))
        (frame_dir / f"{name}.sz3pack").write_bytes(pack)
        (frame_dir / f"{name}.json").write_text(json.dumps(index))
        rec[name] = r
        d = r.astype(np.float64) - true[name].astype(np.float64)
        out["vars"][name] = {"bytes": len(pack), "index_bytes": (frame_dir / f"{name}.json").stat().st_size,
                             "max_err": float(np.abs(d).max()), "rmse": float(np.sqrt((d * d).mean())),
                             "data_min": float(np.nanmin(true[name])), "data_max": float(np.nanmax(true[name]))}

    for name in stored:
        write(name)
    for name in derived:
        op = specs[name]["derive"]
        t = true[name].astype(np.float64)
        exact = derive(op, lambda n: true[n], levels_m, ztop)
        got = derive(op, lambda n: rec[n], levels_m, ztop)
        # What storing it would guarantee: this frame's own SZ3 bound (half 8-bit step per level).
        dom = _domain(true[name], specs[name].get("transform"))
        b = np.asarray(_budgets(true[name], dom, specs[name].get("bound", "u8_half_step")))
        e_exact, e_got = np.abs(exact - t), np.abs(got - t)
        lv = (lambda e: e.reshape(e.shape[0], -1).max(axis=1)) if t.ndim >= 3 else (lambda e: np.array([e.max()]))
        tol = specs[name].get("max_err")  # absolute tolerance in physical units, else 2 x half step per level
        ok_err = bool(e_got.max() <= float(tol)) if tol is not None else bool(np.all(lv(e_got) <= 2.0 * b))
        ok = bool(np.all(lv(e_exact) <= 0.05 * b)) and ok_err
        out["derive"][name] = {"ok": ok, "formula_max_err": float(e_exact.max()), "max_err": float(e_got.max()),
                               "max_err_over_bound": float((lv(e_got) / b).max()),
                               "rmse": float(np.sqrt(((got - t) ** 2).mean())),
                               "data_min": float(np.nanmin(t)), "data_max": float(np.nanmax(t))}
        rec[name] = got.astype(np.float32)
    ds.close()
    out["secs"] = time.perf_counter() - t0
    return out


def build_sz3(inputs: Sequence[str | Path], config_path: str | Path, out_dir: str | Path,
              sz3_config_path: str | Path, display_config_path: str | Path | None = None,
              workers: int | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    paths, datasets = open_frames(inputs)
    ref = datasets[0]
    output = Path(out_dir); output.mkdir(parents=True, exist_ok=True)
    labels = yaml.safe_load(Path(config_path).read_text(encoding="utf-8")) or {}
    cfg = yaml.safe_load(Path(sz3_config_path).read_text(encoding="utf-8")) or {}
    display_cfg = (yaml.safe_load(Path(display_config_path).read_text(encoding="utf-8")) if display_config_path and Path(display_config_path).exists() else {}) or {}
    names = [n for n in labels if all(n in ds for ds in datasets) or n == "w"]
    specs = {n: {**cfg.get("defaults", {}), **(cfg.get(n) or {})} for n in names}
    for n in names:  # a derive needs its inputs present
        op = specs[n].get("derive")
        if op and not all(op[k] in names for k in ("from", "u", "v", "sigma") if k in op):
            specs[n].pop("derive")
    grid = grid_meta(ref)
    times = frame_times(paths, datasets)
    ztop = float(ref.attrs.get("ztop_m", grid["level_interfaces_m"][-1]))
    attrs = {n: read_values(ref, n)[1:3] for n in names}
    for ds in datasets: ds.close()
    for t in times:
        (output / t["dir"]).mkdir(parents=True, exist_ok=True)
    jobs = [(str(p), names, specs, grid["levels_m"], ztop, output / t["dir"]) for p, t in zip(paths, times)]
    n_workers = workers or min(len(jobs), max(1, (os.cpu_count() or 2) - 1))
    if n_workers > 1:
        with ProcessPoolExecutor(n_workers) as pool:
            results = list(pool.map(_encode_frame, jobs))
    else:
        results = [_encode_frame(j) for j in jobs]

    # A derived field must hold in every frame; otherwise store it (SZ3) in every frame.
    fallback = [n for n in names if "derive" in specs[n] and not all(r["derive"][n]["ok"] for r in results)]
    for n in fallback:
        print(f"{n}: formula check failed, storing it with SZ3 instead")
        specs[n].pop("derive")
    if fallback:
        for r in results:
            for n in fallback: r["derive"].pop(n, None)
        refit = [(j[0], names, specs, j[3], j[4], j[5]) for j in jobs]
        with ProcessPoolExecutor(n_workers) as pool:
            results = list(pool.map(_encode_frame, refit))

    levels = grid["levels_m"]
    variables: dict[str, Any] = {}
    total_bytes = 0
    for n in names:
        dims, a = attrs[n]
        if n == "w": dims = ["z", "lat", "lon"]
        dims = [d for d in dims if d not in ("time",)]
        disp = (display_cfg.get(n) or {}).get("display_range") or labels.get(n, {}).get("range")
        shape = [grid["nz"], grid["ny"], grid["nx"]] if len(dims) == 3 else [grid["ny"], grid["nx"]]
        common = {"dims": dims, "shape": shape, "dtype": "float32", "bits": 32, "range_scope": "per_level" if len(shape) == 3 else "global",
                  "units": a.get("units", ""), "long_name": a.get("long_name", n), "label_zh": labels.get(n, {}).get("label_zh", n),
                  "colormap": labels.get(n, {}).get("colormap", "viridis"), "nan_count": 0, "clipped_low_frac": 0.0, "clipped_high_frac": 0.0}
        if "derive" in specs[n]:
            st = [r["derive"][n] for r in results]
            op = dict(specs[n]["derive"])
            if op["op"] == "profile": op.update(ztop_m=ztop, levels_m=levels)
            entry = {**common, "encoding": "derived", "derive": op, "transform": None, "file": "", "bytes_raw": 0, "bytes_compressed": 0,
                     "frames": [{"bytes_compressed": 0, "data_min": s["data_min"], "data_max": s["data_max"], "max_err": s["max_err"],
                                 "formula_max_err": s["formula_max_err"]} for s in st]}
        else:
            st = [r["vars"][n] for r in results]
            entry = {**common, "encoding": "sz3", "sz3_bound": specs[n].get("bound", "u8_half_step"), "transform": None,
                     "domain_transform": specs[n].get("transform"), "file": f"{n}.sz3pack", "index_file": f"{n}.json",
                     "bytes_raw": int(np.prod(shape)) * 4, "bytes_compressed": int(sum(s["bytes"] for s in st)),
                     "frames": [{"bytes_compressed": s["bytes"], "data_min": s["data_min"], "data_max": s["data_max"],
                                 "max_err": s["max_err"], "rmse": s["rmse"]} for s in st]}
            total_bytes += entry["bytes_compressed"]
        entry["data_min"] = float(min(s["data_min"] for s in st)); entry["data_max"] = float(max(s["data_max"] for s in st))
        entry["display_range"] = [float(x) for x in (disp or [entry["data_min"], entry["data_max"]])]
        entry["range"] = labels.get(n, {}).get("range", [entry["data_min"], entry["data_max"]])
        variables[n] = entry
        print(f"{n}: {entry['encoding']} {entry['bytes_compressed']/1e6:.3f}MB")
    derived_display = {k: {"display_range": [float(x) for x in v["display_range"]]}
                       for k, v in (display_cfg.get("derived") or {}).items() if isinstance(v, dict) and v.get("display_range")}
    manifest = {"schema_version": 4, "format": "sz3", "codec": "sz3", "sz3_tier": cfg.get("tier", "T1L"),
                "codec_label": f"SZ3 {cfg.get('tier', 'T1L')}", "prefetch_extra": 1,
                "case": str(ref.attrs.get("case", "")), "source_file": [str(p) for p in paths],
                "created_utc": datetime.now(timezone.utc).isoformat(), "global_attrs": kept_attrs(ref), "grid": grid,
                "times": times, "time_zone": None, "time_note": TIME_NOTE, "variables": variables, "derived": derived_display,
                "timing": {"load_s": 0.0, "total_s": time.perf_counter() - started, "bytes_raw": 0, "bytes_compressed": total_bytes,
                           "frame_encode_s": [round(r["secs"], 2) for r in results], "workers": n_workers}}
    (output / "manifest.json").write_text(json.dumps(jsonable(manifest), ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest
