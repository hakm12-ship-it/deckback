"""Deterministic images for the atlas, drawn with numpy and Pillow (no text, no randomness, no metadata).

The same Pillow and zlib versions always produce the same PNG bytes, so decks that embed these images stay
byte-stable. Images are small: the committed smoke deck (Task 8) has a 3 MB per-file limit.
"""

import io

import numpy as np
from PIL import Image, ImageDraw


def png_bytes(image):
    buf = io.BytesIO()
    image.save(buf, format="PNG", compress_level=9)
    return buf.getvalue()


def texture_tile(size=48):
    """A woven two-tone tile (RGB) whose tiling seams and flips are visible."""
    yy, xx = np.mgrid[0:size, 0:size]
    half = size // 2
    weave = ((xx // half) + (yy // half)) % 2
    stripe = ((xx + yy) // 6) % 2
    r = np.where(weave, 196, 90) - stripe * 30
    g = np.where(weave, 140, 120) - stripe * 20
    b = np.where(weave, 60, 170) - stripe * 10
    rgb = np.stack([r, g, b], axis=-1).clip(0, 255).astype(np.uint8)
    image = Image.fromarray(rgb, "RGB")
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 7, 7], fill=(230, 40, 40))  # marks the tile's top-left corner (shows flips / offsets)
    return image


def picture(width=400, height=250):
    """An RGB 'photo' substitute: a two-axis gradient with a few solid shapes and a grid (orientation visible)."""
    yy, xx = np.mgrid[0:height, 0:width]
    r = 40 + 180 * xx / (width - 1)
    g = 60 + 150 * yy / (height - 1)
    b = 200 - 120 * xx / (width - 1)
    rgb = np.stack([r, g, b], axis=-1).clip(0, 255).astype(np.uint8)
    image = Image.fromarray(rgb, "RGB")
    draw = ImageDraw.Draw(image)
    for x in range(0, width, 50):
        draw.line([(x, 0), (x, height - 1)], fill=(255, 255, 255), width=1)
    for y in range(0, height, 50):
        draw.line([(0, y), (width - 1, y)], fill=(255, 255, 255), width=1)
    draw.ellipse([30, 30, 130, 130], fill=(250, 210, 40), outline=(60, 40, 0), width=3)
    draw.rectangle([width - 150, height - 110, width - 30, height - 30], fill=(30, 30, 90))
    draw.polygon([(width // 2, 20), (width // 2 + 60, 120), (width // 2 - 60, 120)], fill=(220, 60, 60))
    draw.rectangle([0, 0, 15, 15], fill=(0, 0, 0))  # top-left marker
    return image


def picture_rgba(width=320, height=200):
    """An RGBA image whose alpha falls off radially from opaque at the centre to clear at the corners."""
    yy, xx = np.mgrid[0:height, 0:width]
    cx, cy = (width - 1) / 2, (height - 1) / 2
    dist = np.sqrt(((xx - cx) / cx) ** 2 + ((yy - cy) / cy) ** 2)
    alpha = (255 * (1 - dist / np.sqrt(2)) * 1.4).clip(0, 255)
    bands = (xx // 40) % 3
    r = np.choose(bands, [220, 40, 250])
    g = np.choose(bands, [50, 160, 200])
    b = np.choose(bands, [60, 220, 30])
    rgba = np.stack([r, g, b, alpha], axis=-1).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA")
