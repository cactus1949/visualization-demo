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


def quantize(values: Any, lo: float, hi: float, bits: int = 8, transform: str | None = None):
    """Quantise one array with a global range (legacy API retained)."""
    if bits not in (8, 16):
        raise ValueError("bits must be 8 or 16")
    transformed = transform_values(values, transform)
    if hi <= lo:
        hi = lo + max(abs(lo) * 1e-12, 1e-12)
    quant_max = (1 << bits) - 1
    scale = (hi - lo) / quant_max
    nan_mask = ~np.isfinite(transformed)
    safe = np.where(nan_mask, lo, transformed)
    clipped_low = safe < lo
    clipped_high = safe > hi
    clipped = np.clip(safe, lo, hi)
    dtype = np.uint8 if bits == 8 else np.uint16
    quantized = np.rint((clipped - lo) / scale).astype(dtype)
    quantized[nan_mask] = 0
    physical = np.asarray(values, dtype=np.float64)
    pfinite = physical[np.isfinite(physical)]
    count = max(1, physical.size)
    return quantized, {
        "scale": float(scale), "offset": float(lo),
        "nan_count": int(nan_mask.sum()),
        "clipped_low_frac": float(clipped_low.sum() / count),
        "clipped_high_frac": float(clipped_high.sum() / count),
        "data_min": float(np.min(pfinite)) if pfinite.size else float("nan"),
        "data_max": float(np.max(pfinite)) if pfinite.size else float("nan"),
    }


def dequantize(quantized: Any, scale: float, offset: float, transform: str | None = None) -> np.ndarray:
    return inverse_transform(np.asarray(quantized, dtype=np.float64) * scale + offset, transform)


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
                    shared_range: Any = None) -> tuple[np.ndarray, dict[str, Any]]:
    """Encode a physical array and return encoded values plus manifest metadata.

    ``shared_range`` (from :func:`union_ranges`) pins the quantisation grid so that several
    time steps share one scale/offset; it overrides percentiles and ``fixed_range``.
    """
    array = np.asarray(values, dtype=np.float64)
    if encoding == "u8_int":
        # Categorical integers (risk_level): stored as-is, scale 1 / offset 0, no rounding error.
        finite = array[np.isfinite(array)]
        rounded = np.rint(np.where(np.isfinite(array), array, 0.0))
        if finite.size and (np.max(np.abs(finite - np.rint(finite))) > 1e-6 or finite.min() < 0 or finite.max() > 255):
            raise ValueError("u8_int needs integer values in 0..255")
        return rounded.astype(np.uint8), {
            "encoding": encoding, "range_scope": "global", "dtype": "uint8", "bits": 8,
            "transform": None, "scale": 1.0, "offset": 0.0,
            "data_min": float(finite.min()) if finite.size else float("nan"),
            "data_max": float(finite.max()) if finite.size else float("nan"),
            "clipped_low_frac": 0.0, "clipped_high_frac": 0.0, "nan_count": int((~np.isfinite(array)).sum()),
        }
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
    if range_scope == "per_level" and array.ndim >= 3:
        encoded = np.empty(array.shape, dtype=dtype)
        scales, offsets = [], []
        lows = highs = nan = 0.0
        for z in range(array.shape[0]):
            if shared_range is not None:
                lo, hi = (float(x) for x in shared_range[z])
            else:
                lo, hi = _range(array[z], clip_percentiles, fixed_range, transform)
            q, m = quantize(array[z], lo, hi, bits, transform)
            encoded[z] = q; scales.append(m["scale"]); offsets.append(m["offset"])
            lows += m["clipped_low_frac"] * array[z].size; highs += m["clipped_high_frac"] * array[z].size; nan += m["nan_count"]
        finite = array[np.isfinite(array)]
        return encoded, {"encoding": encoding, "range_scope": "per_level", "dtype": f"uint{bits}", "bits": bits,
                         "transform": transform, "level_scale": scales, "level_offset": offsets,
                         "data_min": float(np.min(finite)), "data_max": float(np.max(finite)),
                         "clipped_low_frac": lows / max(1, array.size), "clipped_high_frac": highs / max(1, array.size), "nan_count": int(nan)}
    if shared_range is not None:
        lo, hi = (float(x) for x in shared_range)
    else:
        lo, hi = _range(array, clip_percentiles, fixed_range, transform)
    q, m = quantize(array, lo, hi, bits, transform)
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
            out[z] = dequantize(a[z], float(scale), float(offset), metadata.get("transform"))
        return out
    return dequantize(a, float(metadata["scale"]), float(metadata["offset"]), metadata.get("transform"))
