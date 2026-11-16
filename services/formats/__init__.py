"""Export formats, discovered from the modules in this package.

Each module defines ``NAME`` and ``export(nc_files, out_dir)``. Deleting a module
(e.g. ``sz3.py``) removes that format from ``--format`` without touching the others.
"""
from __future__ import annotations

import importlib, pkgutil
from types import ModuleType


def available() -> dict[str, ModuleType]:
    found: dict[str, ModuleType] = {}
    for info in sorted(pkgutil.iter_modules(__path__), key=lambda i: i.name):
        if info.name.startswith("_"):
            continue
        module = importlib.import_module(f"{__name__}.{info.name}")
        name = getattr(module, "NAME", None)
        if name and callable(getattr(module, "export", None)):
            found[name] = module
    # current first, then the rest alphabetically
    return dict(sorted(found.items(), key=lambda kv: (kv[0] != "current", kv[0])))
