"""Quantisation and transform helpers used by the NetCDF pipeline."""

from __future__ import annotations

from typing import Any, Mapping

import numpy as np


def transform_values(values: Any, transform: str | None, *, eps: float = 1e-12) -> np.ndarray:
    array = np.asarray(values, dtype=np.float64)
    if transform == "log10":
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.log10(np.maximum(array, eps))
    if transform == "log1p":
        return np.log1p(np.maximum(array, 0.0))
    if transform == "signed_sqrt":
        return np.sign(array) * np.sqrt(np.abs(array))
    return array


def inverse_transform(values: Any, transform: str | None) -> np.ndarray:
    array = np.asarray(values, dtype=np.float64)
    if transform == "log10":
        return np.power(10.0, array)
    if transform == "log1p":
        return np.expm1(array)
    if transform == "signed_sqrt":
        return np.sign(array) * np.square(np.abs(array))
    return array


def quantize(values: Any, lo: float, hi: float, bits: int = 8, transform: str | None = None,
             reserve_nan: bool | None = None):
    """Quantise one array with a global range (legacy API retained).

    Missing cells (NaN/inf) get the reserved top code ``(1 << bits) - 1`` and finite values use
    ``0 .. (1 << bits) - 2``. ``reserve_nan=None`` reserves the code only when this array has
    missing cells, so NaN-free data keeps the full code range and stays byte-identical;
    multi-frame exports pass one value for all frames so they share one grid.
    """
    if bits not in (8, 16):
        raise ValueError("bits must be 8 or 16")
    transformed = transform_values(values, transform)
    if hi <= lo:
        hi = lo + max(abs(lo) * 1e-12, 1e-12)
    nan_mask = ~np.isfinite(transformed)
    if reserve_nan is None:
        reserve_nan = bool(nan_mask.any())
    nan_code = (1 << bits) - 1
    quant_max = nan_code - 1 if reserve_nan else nan_code
    scale = (hi - lo) / quant_max
    safe = np.where(nan_mask, lo, transformed)
    clipped_low = safe < lo
    clipped_high = safe > hi
    clipped = np.clip(safe, lo, hi)
    dtype = np.uint8 if bits == 8 else np.uint16
    quantized = np.rint((clipped - lo) / scale).astype(dtype)
    if nan_mask.any():
        if not reserve_nan:
            raise ValueError("array has missing cells but reserve_nan=False")
        quantized[nan_mask] = nan_code
    physical = np.asarray(values, dtype=np.float64)
    pfinite = physical[np.isfinite(physical)]
    count = max(1, physical.size)
    meta = {
        "scale": float(scale), "offset": float(lo),
        "nan_count": int(nan_mask.sum()),
        "clipped_low_frac": float(clipped_low.sum() / count),
        "clipped_high_frac": float(clipped_high.sum() / count),
        "data_min": float(np.min(pfinite)) if pfinite.size else float("nan"),
        "data_max": float(np.max(pfinite)) if pfinite.size else float("nan"),
    }
    if reserve_nan:
        meta["nan_code"] = nan_code
    return quantized, meta


def dequantize(quantized: Any, scale: float, offset: float, transform: str | None = None,
               nan_code: int | None = None) -> np.ndarray:
    q = np.asarray(quantized)
    out = inverse_transform(q.astype(np.float64) * scale + offset, transform)
    if nan_code is not None:
        out = np.where(q == nan_code, np.nan, out)
    return out


def _range(values: np.ndarray, percentiles: tuple[float, float], fixed: Any, transform: str | None):
    transformed = transform_values(values, transform)
    finite = transformed[np.isfinite(transformed)]
    if not finite.size:
        return 0.0, 1.0
    if fixed is not None:
        lo, hi = (float(x) for x in fixed)
    else:
        lo, hi = (float(x) for x in np.percentile(finite, percentiles))
    if hi <= lo:
        hi = lo + max(abs(lo) * 1e-12, 1e-12)
    return lo, hi


def encoding_transform(encoding: str) -> str | None:
    return {"u8_log10": "log10", "u16_log10": "log10",
            "u8_signed_sqrt": "signed_sqrt", "u16_signed_sqrt": "signed_sqrt"}.get(encoding)


def union_ranges(arrays: Any, encoding: str, range_scope: str) -> Any:
    """Shared quantisation range over several frames (transformed domain).

    Returns ``[(lo, hi), ...]`` per level for ``per_level`` 3D data, otherwise one ``(lo, hi)``.
    Frames are expected to have identical shapes.
    """
    transform = encoding_transform(encoding)
    frames = [transform_values(a, transform) for a in arrays]
    def lohi(parts):
        finite = [p[np.isfinite(p)] for p in parts]
        finite = [f for f in finite if f.size]
        if not finite:
            return (0.0, 1.0)
        lo = float(min(f.min() for f in finite)); hi = float(max(f.max() for f in finite))
        if hi <= lo:
            hi = lo + max(abs(lo) * 1e-12, 1e-12)
        return (lo, hi)
    if range_scope == "per_level" and frames[0].ndim >= 3:
        return [lohi([f[z] for f in frames]) for z in range(frames[0].shape[0])]
    return lohi(frames)


def encode_variable(values: Any, encoding: str, range_scope: str = "global",
                    clip_percentiles=(0.0, 100.0), fixed_range=None,
                    shared_range: Any = None, reserve_nan: bool | None = None) -> tuple[np.ndarray, dict[str, Any]]:
    """Encode a physical array and return encoded values plus manifest metadata.

    ``shared_range`` (from :func:`union_ranges`) pins the quantisation grid so that several
    time steps share one scale/offset; it overrides percentiles and ``fixed_range``.
    ``reserve_nan`` (see :func:`quantize`) is forwarded to the u8/u16 encodings; ``None`` means
    "reserve the top code only if this array has missing cells". f16 keeps NaN natively.
    """
    array = np.asarray(values, dtype=np.float64)
    if encoding == "u8_int":
        # Categorical integers (risk_level): stored as-is, scale 1 / offset 0, no rounding error.
        missing = ~np.isfinite(array)
        finite = array[~missing]
        reserve = bool(missing.any()) if reserve_nan is None else reserve_nan
        top = 254 if reserve else 255
        if finite.size and (np.max(np.abs(finite - np.rint(finite))) > 1e-6 or finite.min() < 0 or finite.max() > top):
            raise ValueError(f"u8_int needs integer values in 0..{top}")
        if missing.any() and not reserve:
            raise ValueError("array has missing cells but reserve_nan=False")
        rounded = np.rint(np.where(missing, 255.0, array))
        meta = {
            "encoding": encoding, "range_scope": "global", "dtype": "uint8", "bits": 8,
            "transform": None, "scale": 1.0, "offset": 0.0,
            "data_min": float(finite.min()) if finite.size else float("nan"),
            "data_max": float(finite.max()) if finite.size else float("nan"),
            "clipped_low_frac": 0.0, "clipped_high_frac": 0.0, "nan_count": int(missing.sum()),
        }
        if reserve:
            meta["nan_code"] = 255
        return rounded.astype(np.uint8), meta
    transform = encoding_transform(encoding)
    if encoding == "f16":
        finite = array[np.isfinite(array)]
        return array.astype("<f2"), {
            "encoding": encoding, "range_scope": "global", "dtype": "float16", "bits": 16,
            "transform": None, "scale": 1.0, "offset": 0.0,
            "data_min": float(np.min(finite)) if finite.size else float("nan"),
            "data_max": float(np.max(finite)) if finite.size else float("nan"),
            "clipped_low_frac": 0.0, "clipped_high_frac": 0.0, "nan_count": int((~np.isfinite(array)).sum()),
        }
    bits = 16 if encoding.startswith("u16") else 8
    dtype = np.uint16 if bits == 16 else np.uint8
    if reserve_nan is None:
        reserve_nan = bool((~np.isfinite(transform_values(array, transform))).any())
    if range_scope == "per_level" and array.ndim >= 3:
        encoded = np.empty(array.shape, dtype=dtype)
        scales, offsets = [], []
        lows = highs = nan = 0.0
        for z in range(array.shape[0]):
            if shared_range is not None:
                lo, hi = (float(x) for x in shared_range[z])
            else:
                lo, hi = _range(array[z], clip_percentiles, fixed_range, transform)
            q, m = quantize(array[z], lo, hi, bits, transform, reserve_nan)
            encoded[z] = q; scales.append(m["scale"]); offsets.append(m["offset"])
            lows += m["clipped_low_frac"] * array[z].size; highs += m["clipped_high_frac"] * array[z].size; nan += m["nan_count"]
        finite = array[np.isfinite(array)]
        meta = {"encoding": encoding, "range_scope": "per_level", "dtype": f"uint{bits}", "bits": bits,
                "transform": transform, "level_scale": scales, "level_offset": offsets,
                "data_min": float(np.min(finite)) if finite.size else float("nan"),
                "data_max": float(np.max(finite)) if finite.size else float("nan"),
                "clipped_low_frac": lows / max(1, array.size), "clipped_high_frac": highs / max(1, array.size), "nan_count": int(nan)}
        if reserve_nan:
            meta["nan_code"] = (1 << bits) - 1
        return encoded, meta
    if shared_range is not None:
        lo, hi = (float(x) for x in shared_range)
    else:
        lo, hi = _range(array, clip_percentiles, fixed_range, transform)
    q, m = quantize(array, lo, hi, bits, transform, reserve_nan)
    m.update({"encoding": encoding, "range_scope": "global", "dtype": f"uint{bits}", "bits": bits, "transform": transform})
    return q, m


def decode_variable(encoded: Any, metadata: Mapping[str, Any]) -> np.ndarray:
    """Decode an encoded array using manifest metadata."""
    a = np.asarray(encoded)
    if metadata.get("dtype") == "float16" or metadata.get("encoding") == "f16":
        return a.astype(np.float32)
    if metadata.get("range_scope") == "per_level" and a.ndim >= 3:
        out = np.empty(a.shape, dtype=np.float64)
        for z, (scale, offset) in enumerate(zip(metadata["level_scale"], metadata["level_offset"])):
            out[z] = dequantize(a[z], float(scale), float(offset), metadata.get("transform"), metadata.get("nan_code"))
        return out
    return dequantize(a, float(metadata["scale"]), float(metadata["offset"]), metadata.get("transform"),
                      metadata.get("nan_code"))
