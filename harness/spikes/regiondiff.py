"""Pixel-difference ratio of two same-size images over a region, minus excluded sub-regions."""

import math

import numpy as np
from PIL import Image


def _load(path):
    with Image.open(path) as img:
        return np.asarray(img.convert("RGB"), dtype=np.int16)


def _clip_box(box, width, height):
    """(x0, y0, x1, y1) in pixels, half-open, -> integer slice bounds clipped to the image.
    Fractional edges are widened to whole pixels (floor / ceil)."""
    x0, y0, x1, y1 = box
    return (
        max(0, math.floor(x0)),
        max(0, math.floor(y0)),
        min(width, math.ceil(x1)),
        min(height, math.ceil(y1)),
    )


def diff_stats(a_png, b_png, box_px, exclude_boxes_px=(), thresholds=(32,)):
    """The numbers behind a diff ratio, over box_px minus exclude_boxes_px (same box rules as diff_ratio).

    Per pixel the difference is its max channel difference. Returns
    {"pixels": compared pixel count, "max_diff": int, "mean_diff": float,
     "ratios": {thr: fraction of compared pixels whose difference exceeds thr}}.
    Raises ValueError when the images differ in size or the box holds no pixel to compare.
    """
    a, b = _load(a_png), _load(b_png)
    if a.shape != b.shape:
        raise ValueError(f"image size differs: {a.shape[1]}x{a.shape[0]} vs {b.shape[1]}x{b.shape[0]}")
    height, width = a.shape[:2]
    x0, y0, x1, y1 = _clip_box(box_px, width, height)
    keep = np.zeros((height, width), dtype=bool)
    keep[y0:y1, x0:x1] = True
    for box in exclude_boxes_px:
        ex0, ey0, ex1, ey1 = _clip_box(box, width, height)
        keep[ey0:ey1, ex0:ex1] = False
    if not keep.any():
        raise ValueError("the box holds no pixels to compare (empty, outside the image, or fully excluded)")
    worst = np.abs(a - b).max(axis=2)[keep]
    return {
        "pixels": int(worst.size),
        "max_diff": int(worst.max()),
        "mean_diff": float(worst.mean()),
        "ratios": {thr: float((worst > thr).sum()) / worst.size for thr in thresholds},
    }


def diff_ratio(a_png, b_png, box_px, exclude_boxes_px=(), thr=32):
    """Fraction of pixels in box_px whose max channel difference exceeds thr, ignoring pixels inside
    any of exclude_boxes_px.

    Boxes are (x0, y0, x1, y1) in pixels, half-open (x1 / y1 are not included), clipped to the image.
    The excluded pixels are removed from the denominator as well as the numerator.
    Raises ValueError when the images differ in size or the box holds no pixel to compare.
    """
    return diff_stats(a_png, b_png, box_px, exclude_boxes_px, (thr,))["ratios"][thr]
