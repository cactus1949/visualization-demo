"""Command line entry point for ``python -m ncpipe``."""

from __future__ import annotations

import sys

from .build import main as build_main


def main() -> None:
    """Dispatch subcommands while accepting the historical direct form."""

    if len(sys.argv) > 1 and sys.argv[1] == "build":
        sys.argv.pop(1)
    build_main()


if __name__ == "__main__":
    main()
