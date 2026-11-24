"""Render one PDF page to an RGB array with PyMuPDF (the V2 reference image), and the size that render has.

    render(pdf, page, scale=2.0) -> uint8 H x W x 3
    pixmap_sizes(pdf, scale=2.0) -> [(width, height), ...]   # px, one per page, without rendering
"""

from pathlib import Path

import numpy as np
import pymupdf


def render(pdf: Path, page: int, scale: float = 2.0) -> np.ndarray:
    """Render page `page` (0-based) of `pdf` at `scale` pixels per point; returns a uint8 H x W x 3 array.

    The pixmap is RGB without alpha, on the page's white paper. A 960 x 540 pt slide at the default scale of 2
    gives 1920 x 1080 px, the size of the harness's PowerPoint renders. The array owns its memory, so it stays
    valid after the document is closed.
    """
    if not scale > 0:
        raise ValueError(f"scale must be positive, got {scale!r}")
    with pymupdf.open(str(pdf)) as doc:
        if not 0 <= page < doc.page_count:
            raise ValueError(f"page {page} is out of range: the PDF has {doc.page_count} page(s) (0-based)")
        pix = doc[page].get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
        return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3).copy()


def pixmap_sizes(pdf: Path, scale: float = 2.0) -> list:
    """(width, height) in px of the pixmap `render` makes of every page of `pdf`, computed without rendering.

    MuPDF sizes a page's pixmap by its own rule: the page box (rotated by /Rotate) scaled by `scale` and rounded
    outwards to whole pixels (fz_round_rect). So an A5 page of 419.53 pt is 840 px wide at 2 px/pt, where
    round(839.06) would give 839. Every image of a page is compared at this size (ruling M1-R61).
    """
    if not scale > 0:
        raise ValueError(f"scale must be positive, got {scale!r}")
    with pymupdf.open(str(pdf)) as doc:
        boxes = [(page.rect * pymupdf.Matrix(scale, scale)).irect for page in doc]
    return [(box.width, box.height) for box in boxes]
