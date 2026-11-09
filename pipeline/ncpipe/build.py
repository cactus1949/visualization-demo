"""Build compressed browser data and its manifest from the NetCDF case."""

from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import brotli
import numpy as np
import xarray as xr
import yaml

from .quantize import quantize


def _jsonable(value: Any) -> Any:
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {key: _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _parse_names(values: Iterable[str] | None) -> set[str]:
    names: set[str] = set()
    for value in values or ():
        names.update(item for item in value.split(",") if item)
    return names


def _write_compressed(path: Path, raw: bytes) -> int:
    compressed = brotli.compress(raw, quality=9)
    path.write_bytes(compressed)
    return len(compressed)


def build(
    input_path: str | Path,
    config_path: str | Path,
    out_dir: str | Path,
    bits16: Iterable[str] | None = None,
    vars_filter: Iterable[str] | None = None,
) -> dict[str, Any]:
    """Generate all configured variables as 8-bit files and optional 16-bit files."""

    started = time.perf_counter()
    output = Path(out_dir)
    output.mkdir(parents=True, exist_ok=True)
    config = yaml.safe_load(Path(config_path).read_text(encoding="utf-8"))
    bits16_set = _parse_names(bits16)
    selected = _parse_names(vars_filter)

    print(f"load: opening {input_path}")
    dataset = xr.open_dataset(input_path)
    load_seconds = time.perf_counter() - started
    print(f"load: {load_seconds:.2f}s")

    names = [name for name in config if name in dataset or name == "w"]
    if selected:
        names = [name for name in names if name in selected]

    lat = np.asarray(dataset.lat.values)
    lon = np.asarray(dataset.lon.values)
    levels = np.asarray(dataset.z.values)
    interfaces = np.asarray(dataset.zf.values)
    spacing = float(dataset.attrs.get("dx_m", 60.0))
    grid = {
        "nx": int(lon.size),
        "ny": int(lat.size),
        "nz": int(levels.size),
        "lon_min": float(lon.min()),
        "lon_max": float(lon.max()),
        "lat_min": float(lat.min()),
        "lat_max": float(lat.max()),
        "dx_m": spacing,
        "dy_m": float(dataset.attrs.get("dy_m", spacing)),
        "levels_m": levels.astype(float).tolist(),
        "level_interfaces_m": interfaces.astype(float).tolist(),
        "order": "C (z,lat,lon)",
        "lat_ascending": bool(np.all(np.diff(lat) > 0)),
    }

    variables: dict[str, Any] = {}
    total_raw = 0
    total_compressed = 0
    for name in names:
        variable_started = time.perf_counter()
        spec = config[name]
        transform = spec.get("transform")
        lo, hi = (float(item) for item in spec["range"])

        if name == "w":
            lower = dataset.w.isel(zf=slice(0, -1)).values
            upper = dataset.w.isel(zf=slice(1, None)).values
            values = 0.5 * (lower + upper)
            dims = ["z", "lat", "lon"]
            attrs = dataset.w.attrs
            staggered_from = "zf -> z layer centres (mean adjacent interfaces)"
        else:
            data_array = dataset[name]
            values = data_array.values
            dims = list(data_array.dims)
            attrs = data_array.attrs
            staggered_from = None

        quantized, metadata = quantize(values, lo, hi, 8, transform)
        raw = quantized.tobytes(order="C")
        filename = f"{name}.bin.br"
        compressed_bytes = _write_compressed(output / filename, raw)
        entry: dict[str, Any] = {
            "dims": dims,
            "shape": list(quantized.shape),
            "dtype": "uint8",
            "bits": 8,
            "scale": metadata["scale"],
            "offset": metadata["offset"],
            "transform": transform or None,
            "range": [lo, hi],
            "units": attrs.get("units", ""),
            "long_name": attrs.get("long_name", name),
            "label_zh": spec.get("label_zh", name),
            "colormap": spec.get("colormap", "viridis"),
            "file": filename,
            "bytes_raw": len(raw),
            "bytes_compressed": compressed_bytes,
            "data_min": metadata["data_min"],
            "data_max": metadata["data_max"],
            "clipped_low_frac": metadata["clipped_low_frac"],
            "clipped_high_frac": metadata["clipped_high_frac"],
            "nan_count": metadata["nan_count"],
        }
        if staggered_from:
            entry["staggered_from"] = staggered_from

        if name in bits16_set:
            quantized16, metadata16 = quantize(values, lo, hi, 16, transform)
            raw16 = quantized16.astype("<u2", copy=False).tobytes(order="C")
            filename16 = f"{name}.u16.bin.br"
            compressed16 = _write_compressed(output / filename16, raw16)
            entry["u16"] = {
                "file": filename16,
                "scale": metadata16["scale"],
                "offset": metadata16["offset"],
                "bytes_raw": len(raw16),
                "bytes_compressed": compressed16,
                "dtype": "uint16",
                "bits": 16,
            }

        low = float(metadata["clipped_low_frac"])
        high = float(metadata["clipped_high_frac"])
        if low > 0 or high > 0:
            print(f"warning: {name} clipped low={low:.3g} high={high:.3g}")
        elapsed = time.perf_counter() - variable_started
        total_raw += len(raw)
        total_compressed += compressed_bytes
        variables[name] = entry
        print(
            f"{name}: {elapsed:.2f}s raw={len(raw) / 1e6:.2f}MB "
            f"br={compressed_bytes / 1e6:.2f}MB"
        )

    selected_attrs = {
        key: _jsonable(value)
        for key, value in dataset.attrs.items()
        if key in {"case", "solver", "backend", "dx_m", "dy_m", "dz_m", "ztop_m"}
    }
    manifest = {
        "schema_version": 1,
        "case": str(dataset.attrs.get("case", "")),
        "source_file": str(input_path),
        "created_utc": datetime.now(timezone.utc).isoformat(),
        "global_attrs": selected_attrs,
        "grid": grid,
        "variables": variables,
        "timing": {
            "load_s": load_seconds,
            "total_s": time.perf_counter() - started,
            "bytes_raw": total_raw,
            "bytes_compressed": total_compressed,
        },
    }
    (output / "manifest.json").write_text(
        json.dumps(_jsonable(manifest), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        f"total: {total_compressed / 1e6:.2f} MB compressed "
        f"({total_raw / 1e6:.2f} MB raw), {manifest['timing']['total_s']:.2f}s"
    )
    return manifest


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--bits16", nargs="*", default=[])
    parser.add_argument("--vars", nargs="*", default=None)
    args = parser.parse_args(argv)
    build(args.input, args.config, args.out, args.bits16, args.vars)


if __name__ == "__main__":
    main()
