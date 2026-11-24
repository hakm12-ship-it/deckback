"""Reads the colour type of a PNG file, to tell truecolour renders from palette ones."""

import struct

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

GREYSCALE, RGB, PALETTE, GREYSCALE_ALPHA, RGBA = 0, 2, 3, 4, 6


def _ihdr_head(path):
    with open(path, "rb") as f:
        head = f.read(26)
    if len(head) < 26 or not head.startswith(PNG_SIGNATURE) or head[12:16] != b"IHDR":
        raise ValueError(f"not a PNG file: {path}")
    return head


def png_colour_type(path):
    """The PNG colour type (IHDR byte 25): 0 greyscale, 2 RGB, 3 palette, 4 greyscale + alpha, 6 RGBA.

    The harness compares only 8-bit RGB (2) or RGBA (6) renders; a palette PNG (3) is an error because its
    quantised colours would add noise to every pixel metric. Raises ValueError for a file that is not a PNG.
    """
    return struct.unpack("B", _ihdr_head(path)[25:26])[0]


def png_bit_depth(path):
    """The PNG bit depth per channel (IHDR byte 24): 1, 2, 4, 8 or 16. Raises ValueError if it is not a PNG."""
    return struct.unpack("B", _ihdr_head(path)[24:25])[0]
