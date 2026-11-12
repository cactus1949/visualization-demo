"""SZ3 T1L format (pipeline/sz3pipe). Delete this file together with pipeline/sz3pipe/ to drop the format."""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

from ..paths import REPO_ROOT

NAME = "sz3"


def export(nc_files: Sequence[Path], out_dir: Path) -> None:
    cfg = REPO_ROOT / "pipeline" / "config"
    from sz3pipe.build_sz3 import build_sz3
    build_sz3([str(p) for p in nc_files], cfg / "variables.yaml", out_dir, cfg / "sz3_config.yaml", cfg / "quant_config_6h.yaml")
