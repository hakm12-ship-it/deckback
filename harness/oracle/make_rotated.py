#!/usr/bin/env python
"""Write ``out/m0/rot90.pdf``: page 1 of ``original.pdf`` with ``/Rotate 90``.

Rotated pages: the slide frame applies the page's /Rotate (inventory contract,
docs/decisions/0002-inventory-contract.md §1 types), so the walker and the
oracle must still agree on a rotated page. The walker's local test runs this
script before it compares.

    harness/.venv/Scripts/python harness/oracle/make_rotated.py [src.pdf] [dst.pdf]

Defaults: ``corpus/private/probe/original.pdf`` -> ``out/m0/rot90.pdf`` (both
relative to the repository root).
"""

import argparse
import sys
from pathlib import Path

import pymupdf

REPO = Path(__file__).resolve().parents[2]
DEFAULT_SRC = REPO / "corpus" / "private" / "probe" / "original.pdf"
DEFAULT_DST = REPO / "out" / "m0" / "rot90.pdf"


def make_rotated(src, dst, rotation=90):
    """Copy page 1 of `src` into a new PDF at `dst` and set its /Rotate."""
    with pymupdf.open(src) as source, pymupdf.open() as out:
        out.insert_pdf(source, from_page=0, to_page=0)
        out[0].set_rotation(rotation)
        Path(dst).parent.mkdir(parents=True, exist_ok=True)
        out.save(dst)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Write page 1 of a PDF with /Rotate 90.")
    ap.add_argument("src", nargs="?", default=str(DEFAULT_SRC))
    ap.add_argument("dst", nargs="?", default=str(DEFAULT_DST))
    args = ap.parse_args(argv)
    pymupdf.set_messages(stream=sys.stderr)
    make_rotated(args.src, args.dst)
    return 0


if __name__ == "__main__":
    sys.exit(main())
