"""Build the SZ3 format described by ``docs/sz3-error-bound.md``.

The encoder is intentionally independent from ``ncpipe.quantize``. Each frame
gets its own per-level bounds and codec decision; NetCDF reading, grid discovery,
and the existing process-pool structure remain shared with the other pipelines.
"""
from __future__ import annotations

import json
import os
import time
import zlib
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Sequence

import numpy as np
import xarray as xr
import yaml
from pysz import sz, szConfig, szErrorBoundMode

from ncpipe.ncread import TIME_NOTE, frame_times, grid_meta, jsonable, kept_attrs, open_frames, read_values

_ACCEPT_REL = 1e-5
_ACCEPT_ABS = 1e-7
_F32_EPS = float(np.finfo(np.float32).eps)  # one float32 rounding step, relative


def _compress(a32: np.ndarray, eb: float) -> tuple[bytes, np.ndarray]:
    """Compress and immediately decode one transform-domain slab."""
    cfg = szConfig()
    cfg.errorBoundMode = szErrorBoundMode.ABS
    cfg.absErrorBound = float(eb)
    compressed, _ = sz.compress(np.ascontiguousarray(a32, np.float32), cfg)
    reconstructed, _ = sz.decompress(compressed, np.float32, a32.shape)
    return compressed.tobytes(), reconstructed


def _domain(values: np.ndarray, transform: str | None) -> np.ndarray:
    values64 = np.asarray(values, np.float64)
    if transform == "log10":
        out = np.full(values64.shape, np.nan, np.float64)
        finite = np.isfinite(values64)
        out[finite] = np.log10(np.maximum(values64[finite], 1e-12))
        return out
    return values64


def _inverse(values: np.ndarray, transform: str | None) -> np.ndarray:
    if transform == "log10":
        return np.power(10.0, np.asarray(values, np.float64))
    return np.asarray(values, np.float64)


def _slabs(values: np.ndarray) -> list[np.ndarray]:
    return [values[z] for z in range(values.shape[0])] if values.ndim == 3 else [values]


def _clean_values(values: np.ndarray, attrs: dict[str, Any]) -> np.ndarray:
    """Apply still-present NetCDF missing-value attributes and non-finite rules."""
    out = np.asarray(values, np.float64).copy()
    missing = ~np.isfinite(out)
    for key in ("_FillValue", "missing_value"):
        marker = attrs.get(key)
        if marker is None:
            continue
        try:
            marker_values = np.asarray(marker).reshape(-1)
        except Exception:
            continue
        for value in marker_values:
            if np.isfinite(value):
                missing |= out == float(value)
    out[missing] = np.nan
    return out.astype(np.float32)


def _mask_runs(valid: np.ndarray) -> bytes:
    """Run lengths (uint32 LE) alternating valid/missing, starting with valid (may be 0)."""
    flat = np.asarray(valid, bool).ravel()
    if flat.size == 0:
        return b""
    edges = np.flatnonzero(flat[1:] != flat[:-1]) + 1
    counts = np.diff(np.concatenate(([0], edges, [flat.size])))
    if not flat[0]:
        counts = np.concatenate(([0], counts))
    return counts.astype("<u4").tobytes()


def _mask_bytes(info: dict[str, Any]) -> bytes:
    """Mask only for levels with some, not all, cells missing (all-NaN is const null)."""
    valid = info["valid"]
    return b"" if valid.all() or not valid.any() else _mask_runs(valid)


def _finite_range(slab: np.ndarray) -> tuple[np.ndarray, float | None, float | None]:
    finite = np.isfinite(slab)
    if not finite.any():
        return finite, None, None
    vals = slab[finite]
    return finite, float(vals.min()), float(vals.max())


def _bounds(values: np.ndarray, spec: dict[str, Any]) -> tuple[list[dict[str, Any]], list[float]]:
    """Describe slabs, including filled values and transform-domain bounds."""
    p = spec.get("P")
    if p is None:
        raise ValueError(f"missing P for variable {spec.get('name', '<unknown>')}")
    transform = spec.get("transform")
    domain = _domain(values, transform)
    ratio = float(spec.get("ratio", 1.0 / 512.0))
    integer = p == "integer"
    p_value = None if integer else float(p)
    infos: list[dict[str, Any]] = []
    ebs: list[float] = []
    for original, slab in zip(_slabs(values), _slabs(domain)):
        valid, lo, hi = _finite_range(slab)
        if lo is None:
            info = {"valid": valid, "domain": slab, "filled": np.zeros_like(slab), "const": True,
                    "const_value": None, "eb": 0.0, "lo": None, "hi": None}
        elif hi == lo:
            value = float(np.asarray(original, np.float64)[valid][0])
            filled = np.full(slab.shape, lo, np.float64)
            info = {"valid": valid, "domain": slab, "filled": filled, "const": True,
                    "const_value": value, "eb": 0.0, "lo": lo, "hi": hi}
        else:
            filled = slab.copy()
            filled[~valid] = float(np.nanmean(slab[valid]))
            eb = 0.0 if integer else min(float(p_value), ratio * (hi - lo))
            info = {"valid": valid, "domain": slab, "filled": filled, "const": False,
                    "const_value": None, "eb": eb, "lo": lo, "hi": hi}
        infos.append(info)
        ebs.append(float(info["eb"]))
    return infos, ebs


def _restore_missing(values: np.ndarray, infos: list[dict[str, Any]]) -> np.ndarray:
    out = np.asarray(values, np.float64).copy()
    if out.ndim == 3:
        for z, info in enumerate(infos):
            out[z][~info["valid"]] = np.nan
    else:
        out[~infos[0]["valid"]] = np.nan
    return out


def _acceptance(true_dom: np.ndarray, rec_dom: np.ndarray, infos: list[dict[str, Any]],
                rmse_ratio: float, ebs: Sequence[float] | None = None) -> tuple[bool, str, dict[str, Any]]:
    """Apply ordered SZ3 checks and return the first failure reason."""
    finite = np.isfinite(true_dom)
    errors = np.asarray(rec_dom, np.float64) - np.asarray(true_dom, np.float64)
    per_max: list[float] = []
    per_rmse: list[float] = []
    check_ebs = list(ebs) if ebs is not None else [float(info["eb"]) for info in infos]
    for z, (true_slab, err, info, check_eb) in enumerate(zip(_slabs(true_dom), _slabs(errors), infos, check_ebs)):
        cells = np.isfinite(true_slab)
        if not cells.any():
            per_max.append(0.0); per_rmse.append(0.0)
            continue
        vals = err[cells]
        per_max.append(float(np.abs(vals).max()))
        per_rmse.append(float(np.sqrt(np.mean(vals * vals))))
        eb = float(check_eb)
        # SZ3 bounds the error against the float32 input; allow that one rounding step
        slack = _ACCEPT_ABS + _F32_EPS * float(np.abs(true_slab[cells]).max())
        if per_max[-1] > eb * (1.0 + _ACCEPT_REL) + slack:
            return False, f"max_err level {z}", {"per_max": per_max, "per_rmse": per_rmse}
        if per_rmse[-1] > float(rmse_ratio) * eb + slack:
            return False, f"rmse level {z}", {"per_max": per_max, "per_rmse": per_rmse}
    if not finite.any():
        return True, "", {"per_max": per_max, "per_rmse": per_rmse}
    true_flat = true_dom.ravel(); rec_flat = rec_dom.ravel(); finite_flat = finite.ravel()
    finite_indices = np.flatnonzero(finite_flat)
    true_max_index = int(finite_indices[np.argmax(true_flat[finite_flat])])
    true_min_index = int(finite_indices[np.argmin(true_flat[finite_flat])])
    rec_max_index = int(finite_indices[np.argmax(rec_flat[finite_flat])])
    rec_min_index = int(finite_indices[np.argmin(rec_flat[finite_flat])])
    true_max = float(true_flat[true_max_index]); true_min = float(true_flat[true_min_index])
    max_level = np.unravel_index(true_max_index, true_dom.shape)[0] if true_dom.ndim == 3 else 0
    min_level = np.unravel_index(true_min_index, true_dom.shape)[0] if true_dom.ndim == 3 else 0
    max_eb = float(check_ebs[max_level]); min_eb = float(check_ebs[min_level])
    slack = _ACCEPT_ABS + _F32_EPS * max(abs(true_max), abs(true_min))
    metrics = {"per_max": per_max, "per_rmse": per_rmse,
               "max_err": float(np.abs(errors[finite]).max()),
               "rmse": float(np.sqrt(np.mean(errors[finite] ** 2)))}
    if abs(float(rec_flat[rec_max_index]) - true_max) > max_eb * (1.0 + _ACCEPT_REL) + slack:
        return False, "max value", metrics
    if abs(float(rec_flat[rec_min_index]) - true_min) > min_eb * (1.0 + _ACCEPT_REL) + slack:
        return False, "min value", metrics
    if rec_max_index != true_max_index and float(true_flat[rec_max_index]) < true_max - 2.0 * max_eb:
        return False, "max position", metrics
    if rec_min_index != true_min_index and float(true_flat[rec_min_index]) > true_min + 2.0 * min_eb:
        return False, "min position", metrics
    return True, "", metrics


def _pack_slabs(raw_slabs: list[bytes], slab_records: list[dict[str, Any]], masks: list[bytes]) -> bytes:
    offset = 0
    chunks: list[bytes] = []
    for raw, record in zip(raw_slabs, slab_records):
        if raw:
            record["offset"] = offset
            record["length"] = len(raw)
            chunks.append(raw); offset += len(raw)
    for record, mask in zip(slab_records, masks):
        if mask:
            record["nan"] = {"offset": offset, "length": len(mask)}
            chunks.append(mask); offset += len(mask)
    return b"".join(chunks)


def _quantised(values: np.ndarray, spec: dict[str, Any], infos: list[dict[str, Any]],
               ebs: list[float], reason: str) -> tuple[bytes, dict[str, Any], np.ndarray]:
    transform = spec.get("transform")
    integer = spec.get("P") == "integer"
    fallback = str(spec.get("fallback", "u8"))
    raw_slabs: list[bytes] = []; records: list[dict[str, Any]] = []
    masks: list[bytes] = []; rec_domain: list[np.ndarray] = []
    if integer:
        finite_values = values[np.isfinite(values)]
        if not np.all(np.isclose(finite_values, np.rint(finite_values), rtol=0, atol=0)):
            raise ValueError(f"integer variable {spec['name']} contains non-integer values")
        if np.any(finite_values < 0) or np.any(finite_values > 255):
            raise ValueError(f"integer variable {spec['name']} is outside 0..255")
    for index, info in enumerate(infos):
        valid = info["valid"]
        masks.append(_mask_bytes(info))
        if info["const"]:
            records.append({"kind": "const", "value": info["const_value"]}); raw_slabs.append(b"")
            rec_domain.append(np.full(info["domain"].shape, np.nan if info["const_value"] is None else info["lo"]))
            continue
        filled = info["filled"]
        if integer:
            q = np.rint(filled).astype(np.uint8)
            records.append({"kind": "u8", "scale": 1.0, "add": 0.0})
        elif fallback == "f16":
            q = filled.astype("<f2")
            records.append({"kind": "f16"})
        else:
            lo, hi = float(info["lo"]), float(info["hi"])
            scale = (hi - lo) / 255.0
            q = np.rint((filled - lo) / scale).clip(0, 255).astype(np.uint8)
            records.append({"kind": "u8", "scale": scale, "add": lo})
        raw_slabs.append(zlib.compress(np.ascontiguousarray(q).tobytes(), 9))
        if records[-1]["kind"] == "f16":
            rec_domain.append(q.astype(np.float64))
        elif integer:
            rec_domain.append(q.astype(np.float64))
        else:
            rec_domain.append(q.astype(np.float64) * records[-1]["scale"] + records[-1]["add"])
    pack = _pack_slabs(raw_slabs, records, masks)
    rec_dom = np.stack(rec_domain) if values.ndim == 3 else rec_domain[0]
    rec_physical = _restore_missing(_inverse(rec_dom, transform), infos).astype(np.float32)
    index = {"version": 2, "name": spec["name"], "shape": list(values.shape),
             "slab_shape": list(_slabs(values)[0].shape), "per_level": values.ndim == 3,
             "transform": transform, "round": integer, "codec": "quant", "tier": "quant",
             "fallback": reason, "slabs": records}
    return pack, index, rec_physical


def _sz3_attempt(values: np.ndarray, spec: dict[str, Any], infos: list[dict[str, Any]],
                 ebs: list[float], factor: float) -> tuple[bytes, dict[str, Any], np.ndarray, np.ndarray]:
    transform = spec.get("transform")
    raw_slabs: list[bytes] = []; records: list[dict[str, Any]] = []
    masks: list[bytes] = []; rec_domain: list[np.ndarray] = []
    for info, eb in zip(infos, ebs):
        valid = info["valid"]
        masks.append(_mask_bytes(info))
        if info["const"]:
            records.append({"kind": "const", "value": info["const_value"]}); raw_slabs.append(b"")
            rec_domain.append(np.full(info["domain"].shape, np.nan if info["const_value"] is None else info["lo"]))
            continue
        compressed, reconstructed = _compress(info["filled"].astype(np.float32), eb * factor)
        records.append({"kind": "sz3", "eb": float(eb * factor)})
        raw_slabs.append(compressed); rec_domain.append(np.asarray(reconstructed, np.float64))
    pack = _pack_slabs(raw_slabs, records, masks)
    rec_dom = np.stack(rec_domain) if values.ndim == 3 else rec_domain[0]
    rec_physical = _restore_missing(_inverse(rec_dom, transform), infos).astype(np.float32)
    index = {"version": 2, "name": spec["name"], "shape": list(values.shape),
             "slab_shape": list(_slabs(values)[0].shape), "per_level": values.ndim == 3,
             "transform": transform, "round": False, "codec": "sz3", "tier": "",
             "fallback": "", "slabs": records}
    return pack, index, rec_physical, rec_dom


def _metrics(values: np.ndarray, rec: np.ndarray) -> tuple[float | None, float | None, float | None, float | None, int]:
    finite = np.isfinite(values)
    nan_count = int(np.size(values) - np.count_nonzero(finite))
    if not finite.any():
        return None, None, None, None, nan_count
    error = np.asarray(rec, np.float64) - np.asarray(values, np.float64)
    err = error[finite]; finite_values = np.asarray(values, np.float64)[finite]
    return float(np.abs(err).max()), float(np.sqrt(np.mean(err * err))), float(finite_values.min()), float(finite_values.max()), nan_count


def _encode_field(values32: np.ndarray, spec: dict[str, Any]) -> tuple[bytes, dict[str, Any], np.ndarray, dict[str, Any]]:
    """Encode one variable/frame and return pack, index, reconstruction, metrics."""
    values = np.asarray(values32, np.float32)
    spec = dict(spec); spec.setdefault("name", "<unknown>")
    infos, ebs = _bounds(values, spec)
    p = spec.get("P"); finite = np.isfinite(values); finite_count = int(finite.sum())
    nonzero_fraction = (float(np.count_nonzero(values[finite])) / finite_count) if finite_count else 0.0
    codec = str(spec.get("codec", "auto"))
    used_ebs = list(ebs)
    if p == "integer":
        pack, index, rec = _quantised(values, spec, infos, ebs, "config"); tier = "quant"
    elif codec == "quant" or (codec == "auto" and nonzero_fraction < float(spec.get("sparse_frac", 0.01))):
        reason = "config" if codec == "quant" else "sparse"
        pack, index, rec = _quantised(values, spec, infos, ebs, reason); tier = "quant"
    else:
        transform = spec.get("transform"); true_dom = _domain(values, transform)
        tier = "quant"; reason = ""; pack = b""; index = {}; rec = values.copy(); first_failure = ""
        for factor, tier_name in zip(spec.get("ladder", [1.0, 0.25, 0.0625]), ("x1", "x0.25", "x0.0625")):
            candidate_pack, candidate_index, candidate_rec, candidate_dom = _sz3_attempt(values, spec, infos, ebs, float(factor))
            ok, failure, _metrics_info = _acceptance(true_dom, candidate_dom, infos, float(spec.get("rmse_ratio", 0.6)),
                                                      [eb * float(factor) for eb in ebs])
            if ok:
                pack, index, rec, tier = candidate_pack, candidate_index, candidate_rec, tier_name
                used_ebs = [eb * float(factor) for eb in ebs]
                break
            if not first_failure:
                first_failure = failure
        else:
            pack, index, rec = _quantised(values, spec, infos, ebs, first_failure or "ladder")
            reason = first_failure or "ladder"
        index["tier"] = tier; index["fallback"] = reason
    max_err, rmse, data_min, data_max, nan_count = _metrics(values, rec)
    slab_kinds: dict[str, int] = {}
    for slab in index["slabs"]:
        slab_kinds[slab["kind"]] = slab_kinds.get(slab["kind"], 0) + 1
    metrics = {"bytes": len(pack), "max_err": max_err, "rmse": rmse, "data_min": data_min, "data_max": data_max,
               "nan_count": nan_count, "codec": index["codec"], "tier": index["tier"], "fallback": index["fallback"],
               "eb_max": float(max(used_ebs) if used_ebs else 0.0), "slab_kinds": slab_kinds}
    return pack, index, rec, metrics


def encode_field(values32: np.ndarray, spec: dict[str, Any]) -> tuple[bytes, dict[str, Any], np.ndarray]:
    """Compatibility wrapper for callers that only need the encoded field."""
    pack, index, rec, _metrics_info = _encode_field(values32, spec)
    return pack, index, rec


def derive(op: dict[str, Any], get, levels_m: Sequence[float], ztop: float) -> np.ndarray:
    """Same formulas as the browser (web/src/data/codecs/sz3.ts)."""
    if op["op"] == "copy":
        return get(op["from"]).astype(np.float64)
    if op["op"] == "profile":
        z = np.asarray(levels_m, np.float64)
        prof = np.maximum(1.0 - z / ztop, 0.0) ** float(op.get("exponent", 1 / 3))
        return float(op["coef"]) * get(op["from"]).astype(np.float64)[None] * prof[:, None, None]
    if op["op"] == "gust":
        u, v, sigma = (get(op[k]).astype(np.float64) for k in ("u", "v", "sigma"))
        return np.hypot(u, v) + 2.0 * sigma
    raise ValueError(f"unknown derive op {op['op']!r}")


def _derive_order(names: list[str], specs: dict[str, dict]) -> list[str]:
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


def _derived_check(name: str, values: np.ndarray, exact: np.ndarray, got: np.ndarray,
                   spec: dict[str, Any]) -> dict[str, Any]:
    infos, ebs = _bounds(values.astype(np.float32), spec)
    formula_error = np.abs(exact - values); recomputed_error = np.abs(got - values)
    finite = np.isfinite(values) & np.isfinite(exact) & np.isfinite(got)
    per_formula: list[float] = []; per_recomputed: list[float] = []
    for ef, er, mask in zip(_slabs(formula_error), _slabs(recomputed_error), _slabs(finite)):
        if not mask.any():
            per_formula.append(0.0); per_recomputed.append(0.0); continue
        per_formula.append(float(ef[mask].max())); per_recomputed.append(float(er[mask].max()))
    max_err_limit = spec.get("max_err")
    # Float32 source fields can differ from the browser's float64 formula by a
    # few ulps even when a level is constant and therefore has eb == 0.
    formula_ok = all(e <= max(0.05 * eb, 1e-6) + _ACCEPT_ABS for e, eb in zip(per_formula, ebs))
    recomputed_ok = all(e <= (float(max_err_limit) if max_err_limit is not None else 2.0 * eb) + _ACCEPT_ABS
                        for e, eb in zip(per_recomputed, ebs))
    # cells whose inputs are missing come out missing in the browser too; compare the rest
    max_err, rmse, _lo, _hi, _n = _metrics(np.where(finite, values, np.nan).astype(np.float32), got.astype(np.float32))
    _e, _r, data_min, data_max, nan_count = _metrics(values.astype(np.float32), values.astype(np.float32))
    return {"ok": bool(formula_ok and recomputed_ok), "formula_max_err": float(max(per_formula, default=0.0)),
            "max_err": max_err, "rmse": rmse, "data_min": data_min, "data_max": data_max,
            "nan_count": nan_count, "eb_max": float(max(ebs, default=0.0))}


def _encode_frame(job: tuple) -> dict[str, Any]:
    path, names, specs, levels_m, ztop, frame_dir = job
    started = time.perf_counter(); ds = xr.open_dataset(path)
    true: dict[str, np.ndarray] = {}
    for name in names:
        raw, _dims, attrs, _note = read_values(ds, name)
        true[name] = _clean_values(raw.squeeze() if name != "w" else raw, attrs)
    stored = [n for n in names if "derive" not in specs[n]]; derived = _derive_order(names, specs)
    out: dict[str, Any] = {"vars": {}, "derive": {}}; rec: dict[str, np.ndarray] = {}
    for name in stored:
        pack, index, reconstructed, metrics = _encode_field(true[name], {**specs[name], "name": name})
        (frame_dir / f"{name}.sz3pack").write_bytes(pack)
        (frame_dir / f"{name}.json").write_text(json.dumps(index, allow_nan=False), encoding="utf-8")
        rec[name] = reconstructed; metrics["index_bytes"] = (frame_dir / f"{name}.json").stat().st_size
        out["vars"][name] = metrics
    for name in derived:
        op = specs[name]["derive"]; exact = derive(op, lambda n: true[n], levels_m, ztop)
        got = derive(op, lambda n: rec[n], levels_m, ztop)
        out["derive"][name] = _derived_check(name, true[name].astype(np.float64), exact, got, {**specs[name], "name": name})
        rec[name] = got.astype(np.float32)
    ds.close(); out["secs"] = time.perf_counter() - started
    return out


_WORKER_BYTES = 2.5e9  # peak RSS of one frame job on the 40x300x300 case is about 1.9 GB


def _default_workers(n_jobs: int) -> int:
    """One process per frame, capped by CPUs and by free memory (7 workers on a 16 GB box ran out)."""
    cpus = max(1, (os.cpu_count() or 2) - 1)
    try:
        free = os.sysconf("SC_AVPHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (ValueError, OSError, AttributeError):
        free = 0
    by_memory = max(1, int(free // _WORKER_BYTES)) if free else cpus
    return max(1, min(n_jobs, cpus, by_memory))


def _run_jobs(jobs: list[tuple], workers: int) -> list[dict[str, Any]]:
    if workers > 1:
        with ProcessPoolExecutor(workers) as pool:
            return list(pool.map(_encode_frame, jobs))
    return [_encode_frame(job) for job in jobs]


def build_sz3(inputs: Sequence[str | Path], config_path: str | Path, out_dir: str | Path,
              sz3_config_path: str | Path, display_config_path: str | Path | None = None,
              workers: int | None = None) -> dict[str, Any]:
    started = time.perf_counter(); paths, datasets = open_frames(inputs); ref = datasets[0]
    output = Path(out_dir); output.mkdir(parents=True, exist_ok=True)
    labels = yaml.safe_load(Path(config_path).read_text(encoding="utf-8")) or {}
    cfg = yaml.safe_load(Path(sz3_config_path).read_text(encoding="utf-8")) or {}
    display_cfg = (yaml.safe_load(Path(display_config_path).read_text(encoding="utf-8"))
                   if display_config_path and Path(display_config_path).exists() else {}) or {}
    names = [n for n in labels if all(n in ds for ds in datasets) or n == "w"]
    specs = {n: {**cfg.get("defaults", {}), **(cfg.get(n) or {})} for n in names}
    for n in names:
        op = specs[n].get("derive")
        if op and not all(op[k] in names for k in ("from", "u", "v", "sigma") if k in op):
            specs[n].pop("derive")
        specs[n]["name"] = n
        if "derive" not in specs[n] and specs[n].get("P") is None:
            raise ValueError(f"missing P for variable {n}")
    grid = grid_meta(ref); times = frame_times(paths, datasets)
    ztop = float(ref.attrs.get("ztop_m", grid["level_interfaces_m"][-1]))
    attrs = {n: read_values(ref, n)[1:3] for n in names}
    for ds in datasets: ds.close()
    for t in times: (output / t["dir"]).mkdir(parents=True, exist_ok=True)
    jobs = [(str(path), names, specs, grid["levels_m"], ztop, output / t["dir"])
            for path, t in zip(paths, times)]
    n_workers = workers or _default_workers(len(jobs)); results = _run_jobs(jobs, n_workers)
    fallback = [n for n in names if "derive" in specs[n] and not all(r["derive"][n]["ok"] for r in results)]
    for n in fallback:
        print(f"{n}: formula check failed, storing it with SZ3 instead")
        specs[n].pop("derive")
        specs[n]["codec"] = "sz3"
    if fallback: results = _run_jobs(jobs, n_workers)

    variables: dict[str, Any] = {}; total_bytes = 0; report_variables: dict[str, Any] = {}
    tier_totals: dict[str, Any] = {"x1": 0, "x0.25": 0, "x0.0625": 0, "quant": {"config": 0, "sparse": 0, "ladder": 0}}
    for name in names:
        dims, attrs_for_var = attrs[name]
        if name == "w": dims = ["z", "lat", "lon"]
        dims = [d for d in dims if d != "time"]
        shape = [grid["nz"], grid["ny"], grid["nx"]] if len(dims) == 3 else [grid["ny"], grid["nx"]]
        disp = (display_cfg.get(name) or {}).get("display_range") or labels.get(name, {}).get("range")
        common = {"dims": dims, "shape": shape, "dtype": "float32", "bits": 32,
                  "range_scope": "per_level" if len(shape) == 3 else "global", "units": attrs_for_var.get("units", ""),
                  "long_name": attrs_for_var.get("long_name", name), "label_zh": labels.get(name, {}).get("label_zh", name),
                  "colormap": labels.get(name, {}).get("colormap", "viridis"),
                  "nan_count": int(sum((r.get("vars", {}).get(name) or r.get("derive", {}).get(name, {})).get("nan_count", 0) for r in results)),
                  "clipped_low_frac": 0.0, "clipped_high_frac": 0.0}
        if "derive" in specs[name]:
            stats = [r["derive"][name] for r in results]; op = dict(specs[name]["derive"])
            if op["op"] == "profile": op.update(ztop_m=ztop, levels_m=grid["levels_m"])
            frames = [{"bytes_compressed": 0, "codec": "derived", "tier": "", "fallback": "", "eb_max": s["eb_max"],
                       "slab_kinds": {}, "nan_count": s["nan_count"], "data_min": s["data_min"], "data_max": s["data_max"],
                       "max_err": s["max_err"], "rmse": s["rmse"], "formula_max_err": s["formula_max_err"]} for s in stats]
            entry = {**common, "encoding": "derived", "derive": op, "transform": None, "file": "", "bytes_raw": 0,
                     "bytes_compressed": 0, "frames": frames}
            report_variables[name] = {"frames": [{k: f[k] for k in ("codec", "tier", "fallback", "bytes_compressed", "max_err", "rmse", "eb_max")} for f in frames]}
            stat_values = stats
        else:
            stats = [r["vars"][name] for r in results]
            entry = {**common, "encoding": "sz3", "sz3_bound": "per_level", "transform": None,
                     "domain_transform": specs[name].get("transform"), "file": f"{name}.sz3pack", "index_file": f"{name}.json",
                     "bytes_raw": int(np.prod(shape)) * 4, "bytes_compressed": int(sum(s["bytes"] for s in stats)),
                     "frames": [{"bytes_compressed": s["bytes"], "codec": s["codec"], "tier": s["tier"], "fallback": s["fallback"],
                                 "eb_max": s["eb_max"], "slab_kinds": s["slab_kinds"], "nan_count": s["nan_count"],
                                 "data_min": s["data_min"], "data_max": s["data_max"], "max_err": s["max_err"], "rmse": s["rmse"]} for s in stats]}
            total_bytes += entry["bytes_compressed"]; stat_values = stats
            report_variables[name] = {"frames": [{k: s[k] for k in ("codec", "tier", "fallback", "bytes", "max_err", "rmse", "eb_max")} for s in stats]}
            for s in stats:
                if s["tier"] in ("x1", "x0.25", "x0.0625"): tier_totals[s["tier"]] += 1
                elif s["tier"] == "quant": tier_totals["quant"][s["fallback"] if s["fallback"] in ("config", "sparse") else "ladder"] += 1
        finite_mins = [s["data_min"] for s in stat_values if s["data_min"] is not None]; finite_maxs = [s["data_max"] for s in stat_values if s["data_max"] is not None]
        entry["data_min"] = float(min(finite_mins)) if finite_mins else None; entry["data_max"] = float(max(finite_maxs)) if finite_maxs else None
        entry["display_range"] = [float(x) for x in (disp or [entry["data_min"] or 0.0, entry["data_max"] or 0.0])]
        entry["range"] = labels.get(name, {}).get("range", [entry["data_min"], entry["data_max"]]); variables[name] = entry
        print(f"{name}: {entry['encoding']} {entry['bytes_compressed']/1e6:.3f}MB")
    derived_display = {k: {"display_range": [float(x) for x in v["display_range"]]} for k, v in (display_cfg.get("derived") or {}).items() if isinstance(v, dict) and v.get("display_range")}
    manifest = {"schema_version": 4, "format": "sz3", "codec": "sz3", "sz3_tier": cfg.get("tier", "T1L"),
                "codec_label": f"SZ3 {cfg.get('tier', 'T1L')}", "prefetch_extra": 1, "case": str(ref.attrs.get("case", "")),
                "source_file": [str(p) for p in paths], "created_utc": datetime.now(timezone.utc).isoformat(), "global_attrs": kept_attrs(ref),
                "grid": grid, "times": times, "time_zone": None, "time_note": TIME_NOTE, "variables": variables, "derived": derived_display,
                "timing": {"load_s": 0.0, "total_s": time.perf_counter() - started, "bytes_raw": 0, "bytes_compressed": total_bytes,
                           "frame_encode_s": [round(r["secs"], 2) for r in results], "workers": n_workers}}
    (output / "manifest.json").write_text(json.dumps(jsonable(manifest), ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    report = {"version": 1, "variables": report_variables, "totals": {"tiers": tier_totals}}
    (output / "sz3_report.json").write_text(json.dumps(jsonable(report), ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
    return manifest
