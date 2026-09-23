"""Compatibility entry point for the reusable Word exporter.

The implementation lives in :mod:`word_exporter` (an import-safe Python
module); this hyphenated script keeps the path intuitive for shell users and
older local tooling.
"""

from word_exporter import main


if __name__ == "__main__":
    raise SystemExit(main())
