#!/usr/bin/env python3
"""Export one day's NetCDF files into $WEB_ROOT/<format>/yyyymm/yyyymmdd/.

    python -m nc_export --date 20261111                 # current (default)
    python -m nc_export --date 20261111 --format sz3
    python -m nc_export --date 20261111 --format all    # every format in services/formats/

Reads $NC_ROOT/yyyymm/yyyymmdd/*.nc (default /data/nc). Each format is written to its own
directory with its own manifest; each write is atomic (temp dir, then rename).
"""
from __future__ import annotations

import argparse, shutil, sys, time
from pathlib import Path

from .paths import REPO_ROOT, day_dir, load_dotenv, nc_root, parse_date, web_root

sys.path.insert(0, str(REPO_ROOT / "pipeline"))

from . import formats  # noqa: E402


def _collect_nc(folder: Path) -> list[Path]:
    files = sorted(p for p in folder.glob("*.nc") if p.is_file())
    if not files:
        raise FileNotFoundError(f"no .nc files in {folder}")
    return files


def _atomic_replace(tmp: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    old = dest.parent / f".{dest.name}.old"
    if old.exists():
        shutil.rmtree(old)
    if dest.exists():
        dest.rename(old)
    tmp.rename(dest)
    if old.exists():
        shutil.rmtree(old)


def _dir_bytes(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file())


def export_one(fmt: str, files: list[Path], dest: Path) -> Path:
    module = formats.available()[fmt]
    tmp = dest.parent / f".{dest.name}.tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    try:
        module.export(files, tmp)
        _atomic_replace(tmp, dest)
    except BaseException:
        if tmp.exists():
            shutil.rmtree(tmp)
        raise
    print(f"[{fmt}] {len(files)} nc -> {dest}  {time.perf_counter() - t0:.1f}s  {_dir_bytes(dest) / 1e6:.2f} MB")
    return dest


def export_day(date_text: str, fmt: str = "current", nc: Path | None = None, web: Path | None = None) -> list[Path]:
    yyyymm, yyyymmdd = parse_date(date_text)
    src = day_dir(nc or nc_root(), yyyymm, yyyymmdd)
    files = _collect_nc(src)
    names = list(formats.available()) if fmt == "all" else [fmt]
    root = web or web_root()
    return [export_one(name, files, day_dir(root / name, yyyymm, yyyymmdd)) for name in names]


def main(argv: list[str] | None = None) -> None:
    load_dotenv()
    choices = list(formats.available())
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--date", required=True, help="YYYYMMDD or YYYY-MM-DD")
    default = "current" if "current" in choices else choices[0]
    parser.add_argument("--format", default=default, choices=[*choices, "all"], help=f"which export format (default: {default})")
    parser.add_argument("--nc-root", default=None, help="override NC_ROOT")
    parser.add_argument("--web-root", default=None, help="override WEB_ROOT")
    args = parser.parse_args(argv)
    export_day(args.date, args.format, Path(args.nc_root) if args.nc_root else None, Path(args.web_root) if args.web_root else None)


if __name__ == "__main__":
    main()
