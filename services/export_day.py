#!/usr/bin/env python3
"""Export one day's NetCDF files into $WEB_ROOT/yyyymm/yyyymmdd/.

Reads $NC_ROOT (default /data/nc). Example:

    python -m services.export_day --date 20261111

Looks for /data/nc/202611/20261111/*.nc and writes the web payload to
/data/web/202611/20261111/. The write is atomic (temp dir, then rename).
"""
from __future__ import annotations

import argparse, shutil, sys
from pathlib import Path

from .paths import REPO_ROOT, day_dir, load_dotenv, nc_root, parse_date, web_root

sys.path.insert(0, str(REPO_ROOT / "pipeline"))


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


def export_day(date_text: str, nc: Path | None = None, web: Path | None = None) -> Path:
    yyyymm, yyyymmdd = parse_date(date_text)
    src = day_dir(nc or nc_root(), yyyymm, yyyymmdd)
    dest = day_dir(web or web_root(), yyyymm, yyyymmdd)
    files = _collect_nc(src)
    from ncpipe.build import build
    from ncpipe.build_multi import build_multi
    tmp = dest.parent / f".{yyyymmdd}.tmp"
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True, exist_ok=True)
    config = REPO_ROOT / "pipeline" / "config" / "variables.yaml"
    if len(files) > 1:
        quant = REPO_ROOT / "pipeline" / "config" / "quant_config_6h.yaml"
        try:
            build_multi([str(p) for p in files], config, tmp, quant)
            _atomic_replace(tmp, dest)
        except Exception:
            if tmp.exists():
                shutil.rmtree(tmp)
            raise
    else:
        quant = REPO_ROOT / "pipeline" / "config" / "quant_config.yaml"
        try:
            build(str(files[0]), config, tmp, [], None, quant)
            _atomic_replace(tmp, dest)
        except Exception:
            if tmp.exists():
                shutil.rmtree(tmp)
            raise
    print(f"exported {len(files)} nc file(s) from {src} -> {dest}")
    return dest


def main(argv: list[str] | None = None) -> None:
    load_dotenv()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", required=True, help="YYYYMMDD or YYYY-MM-DD")
    parser.add_argument("--nc-root", default=None, help="override NC_ROOT")
    parser.add_argument("--web-root", default=None, help="override WEB_ROOT")
    args = parser.parse_args(argv)
    export_day(args.date, Path(args.nc_root) if args.nc_root else None, Path(args.web_root) if args.web_root else None)


if __name__ == "__main__":
    main()
