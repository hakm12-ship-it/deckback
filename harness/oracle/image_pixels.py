#!/usr/bin/env python
"""Compares a PNG with MuPDF's pixels of an image in a PDF.

    python -m harness.oracle.image_pixels <pdf> <xref> <png>

prints one integer: the largest difference of any channel of any pixel between the PNG and the image object ``xref``
of ``pdf`` as MuPDF decodes it (``pymupdf.Pixmap(doc, xref)``), its soft mask applied. deckback's Scene writes such a
PNG for every picture that does not pass through as the original JPEG (packages/core/src/scene/media.ts); its tests
expect at most 1, a rounding.

How the two sides are made comparable:

* Colour is compared as RGB. A gray side is widened by repeating its value, as pdf.js does, and not through colour
  management, which would move the values.
* A side with alpha is compared premultiplied (colour times alpha, ``fz_mul255``), because MuPDF premultiplies a PNG it
  loads; a side without alpha is opaque. So where the alpha is 0 the colour does not count.
* ``Pixmap(doc, xref)`` does not apply an image's ``/SMask`` (it does un-blend a ``/Matte``): the soft mask's own pixmap,
  which must have the image's size, is the alpha.
* An image mask (``/ImageMask true``) has no colour of its own; it paints the fill colour. MuPDF's pixmap of it is its
  coverage, so only the PNG's alpha is compared, with that.

Anything else (a ``/Mask``, a soft mask of another size, a PNG of another size) is an error: exit status 2 and a message
on stderr. Image bytes are never printed.
"""

import argparse
import sys

import pymupdf


class ImageError(Exception):
    """The two sides cannot be compared."""


def _mul255(a, b):
    """``a * b / 255`` rounded as MuPDF's ``fz_mul255`` rounds it."""
    x = a * b + 128
    return (x + (x >> 8)) >> 8


def _xref_of(doc, xref, key):
    kind, value = doc.xref_get_key(xref, key)
    if kind == "null":
        return None
    if kind != "xref":
        raise ImageError(f"/{key} of object {xref} is a {kind}, not a reference")
    return int(value.split()[0])


def _colour(pix):
    """The pixmap's colour as RGB bytes, 3 a pixel, its alpha left out; gray is widened, any other space converted."""
    n = pix.n - pix.alpha
    if n not in (1, 3):
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
        n = 3
    samples = pix.samples
    stride = pix.n
    if n == 3:
        if not pix.alpha:
            return bytes(samples)
        return bytes(v for i in range(0, len(samples), stride) for v in samples[i : i + 3])
    return bytes(samples[i] for i in range(0, len(samples), stride) for _ in range(3))


def _alpha(pix):
    return bytes(pix.samples[pix.n - 1 :: pix.n]) if pix.alpha else None


def _premultiplied(colour, alpha):
    if alpha is None:
        return colour
    return bytes(_mul255(c, alpha[i // 3]) for i, c in enumerate(colour))


def difference(pdf, xref, png):
    """The largest channel difference between the PNG file ``png`` and image ``xref`` of the PDF file ``pdf``."""
    doc = pymupdf.open(pdf)
    image = pymupdf.Pixmap(doc, xref)
    loaded = pymupdf.Pixmap(png)
    if (loaded.width, loaded.height) != (image.width, image.height):
        raise ImageError(f"the PNG is {loaded.width} x {loaded.height}, the image {image.width} x {image.height}")

    if doc.xref_get_key(xref, "ImageMask")[1] == "true":
        alpha = _alpha(loaded)
        if alpha is None:
            raise ImageError("the image is an image mask and the PNG has no alpha")
        coverage = bytes(image.samples)  # one alpha channel: 255 where the mask paints
        return max(abs(a - b) for a, b in zip(alpha, coverage))

    if doc.xref_get_key(xref, "Mask")[0] != "null":
        raise ImageError("an image with /Mask is not compared")
    expected_alpha = None
    smask = _xref_of(doc, xref, "SMask")
    if smask is not None:
        mask = pymupdf.Pixmap(doc, smask)
        if (mask.width, mask.height) != (image.width, image.height) or mask.n != 1:
            raise ImageError(f"the soft mask is {mask.width} x {mask.height} with {mask.n} channels")
        expected_alpha = bytes(mask.samples)
    elif image.alpha:
        raise ImageError("MuPDF gave the image an alpha channel of its own")

    actual_alpha = _alpha(loaded)
    actual = _colour(loaded)  # premultiplied already when it has alpha: MuPDF premultiplies a PNG it loads
    expected = _premultiplied(_colour(image), expected_alpha)
    worst = max(abs(a - b) for a, b in zip(actual, expected))
    opaque = bytes([255]) * (image.width * image.height)
    worst_alpha = max(abs(a - b) for a, b in zip(actual_alpha or opaque, expected_alpha or opaque))
    return max(worst, worst_alpha)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Largest channel difference between a PNG and MuPDF's pixels of a PDF image.")
    ap.add_argument("pdf")
    ap.add_argument("xref", type=int)
    ap.add_argument("png")
    args = ap.parse_args(argv)
    try:
        print(difference(args.pdf, args.xref, args.png))
    except ImageError as e:
        print(f"image_pixels: {e}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
