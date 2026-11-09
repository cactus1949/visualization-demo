"""Fixed-range quantisation helpers used by the renderer-agnostic pipeline."""

from __future__ import annotations

from typing import Any

import numpy as np


def transform_values(values: Any, transform: str | None) -> np.ndarray:
    """Apply the configured transform before quantisation."""

    array = np.asarray(values, dtype=np.float64)
    if transform == "log10":
        with np.errstate(divide="ignore", invalid="ignore"):
            return np.log10(array)
    return array


def inverse_transform(values: Any, transform: str | None) -> np.ndarray:
    """Undo a transform after dequantisation."""

    array = np.asarray(values, dtype=np.float64)
    if transform == "log10":
        return np.power(10.0, array)
    return array


def quantize(
    values: Any,
    lo: float,
    hi: float,
    bits: int = 8,
    transform: str | None = None,
) -> tuple[np.ndarray, dict[str, float | int]]:
    """Quantise values into an unsigned integer array and return metadata."""

    if bits not in (8, 16):
        raise ValueError("bits must be 8 or 16")
    if hi <= lo:
        raise ValueError("hi must be greater than lo")

    physical = np.asarray(values, dtype=np.float64)
    transformed = transform_values(physical, transform)
    nan_mask = np.isnan(transformed)
    quant_max = (1 << bits) - 1
    scale = (hi - lo) / quant_max
    safe = np.where(nan_mask, lo, transformed)
    clipped_low = safe < lo
    clipped_high = safe > hi
    clipped = np.clip(safe, lo, hi)
    dtype = np.uint8 if bits == 8 else np.uint16
    quantized = np.rint((clipped - lo) / scale).astype(dtype)
    quantized[nan_mask] = 0

    finite = physical[np.isfinite(physical)]
    data_min = float(np.min(finite)) if finite.size else float("nan")
    data_max = float(np.max(finite)) if finite.size else float("nan")
    count = max(1, physical.size)
    metadata: dict[str, float | int] = {
        "scale": float(scale),
        "offset": float(lo),
        "nan_count": int(nan_mask.sum()),
        "clipped_low_frac": float(clipped_low.sum() / count),
        "clipped_high_frac": float(clipped_high.sum() / count),
        "data_min": data_min,
        "data_max": data_max,
    }
    return quantized, metadata


def dequantize(
    quantized: Any,
    scale: float,
    offset: float,
    transform: str | None = None,
) -> np.ndarray:
    """Convert an integer array back to physical units."""

    values = np.asarray(quantized, dtype=np.float64) * scale + offset
    return inverse_transform(values, transform)
