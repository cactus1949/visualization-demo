"""Current encoding (f16 / u8 + Brotli, shared quantisation grid). Delete this file to drop the format."""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

from ..paths import REPO_ROOT

NAME = "current"


def export(nc_files: Sequence[Path], out_dir: Path) -> None:
    config = REPO_ROOT / "pipeline" / "config" / "variables.yaml"
    from ncpipe.build_multi import build_multi
    build_multi([str(p) for p in nc_files], config, out_dir, REPO_ROOT / "pipeline" / "config" / "quant_config_6h.yaml")
