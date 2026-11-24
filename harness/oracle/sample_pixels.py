#!/usr/bin/env python
"""Samples MuPDF's rendering of a PDF page at points of the slide frame.

    python -m harness.oracle.sample_pixels <pdf> <page> <x,y> [<x,y> ...]

renders page ``page`` (1-based, as the oracle's ``--pages``) of ``pdf`` with MuPDF at 2 px/pt, opaque RGB on white and
the page contents only (no annotations, as the inventory: docs/decisions/0002-inventory-contract.md §3), and prints one
line ``r g b`` (0-255) for each point ``x,y``: the pixel that holds that point of the slide frame (pt, origin top left,
y down, the page's /Rotate and crop box applied: 0002 §1). deckback's tests compare the colours the Scene's gradients
give with it (packages/core/test/scene/gradient.local.test.ts). It prints numbers only.

A page outside the document, a point outside the page or an argument that is not two numbers is an error: exit status 2
and a message on stderr.
"""

import argparse
import math
import sys

import pymupdf

SCALE = 2
"""Pixels per pt."""


class SampleError(Exception):
    """The arguments name no page or no point of it."""


def _point(text):
    parts = text.split(",")
    try:
        x, y = (float(p) for p in parts)
    except ValueError:
        raise SampleError(f"{text!r} is not a point x,y") from None
    if not (math.isfinite(x) and math.isfinite(y)):
        raise SampleError(f"{text!r} is not a point x,y")
    return x, y


def samples(pdf, page, points):
    """The RGB of the pixel of a 2 px/pt render of page ``page`` (1-based) of ``pdf`` that holds each slide-frame point."""
    doc = pymupdf.open(pdf)
    if not 1 <= page <= doc.page_count:
        raise SampleError(f"page {page} is not in the document ({doc.page_count} pages)")
    pix = doc[page - 1].get_pixmap(matrix=pymupdf.Matrix(SCALE, SCALE), colorspace=pymupdf.csRGB, alpha=False, annots=False)
    out = []
    for x, y in points:
        px, py = math.floor(x * SCALE), math.floor(y * SCALE)
        if not (0 <= px < pix.width and 0 <= py < pix.height):
            raise SampleError(f"the point {x},{y} is outside the page")
        out.append(tuple(pix.pixel(px, py)[:3]))
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description="The RGB MuPDF paints at slide-frame points of a PDF page (2 px/pt).")
    ap.add_argument("pdf")
    ap.add_argument("page", type=int)
    ap.add_argument("points", nargs="+", metavar="x,y")
    args = ap.parse_args(argv)
    try:
        rows = samples(args.pdf, args.page, [_point(p) for p in args.points])
    except SampleError as e:
        print(f"sample_pixels: {e}", file=sys.stderr)
        return 2
    for rgb in rows:
        print(" ".join(str(v) for v in rgb))
    return 0


if __name__ == "__main__":
    sys.exit(main())
