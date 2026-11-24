"""Pixel metrics behind the V1 (same renderer) and V2 (cross renderer) fidelity gates.

All images are uint8 H x W x 3 arrays (8-bit RGB). Two images of different size are an error: nothing here
resizes, because a resize would hide exactly the layout errors the gates exist to catch.

Definitions (spec section 5):

* A pixel *differs* when its max channel |a - b| is > 32 (`diff_mask`, `px32`).
* `px32_shift1(a, b)` tolerates one pixel of sub-pixel / anti-aliasing offset: for each pixel of `a` it takes the
  best (smallest) max-channel difference against the 3 x 3 neighbourhood of the same position in `b`, and reports
  the fraction of pixels whose best difference is still > 32. `a` stays fixed and only `b` is shifted, so it is
  not symmetric: a block present in `b` but not in `a` leaves its interior, (w - 2) x (h - 2) pixels, while the
  same block present in `a` but not in `b` leaves all w x h.
* `eroded_residual` counts the differing pixels left after a k x k binary erosion: lines thinner than k (the usual
  anti-aliasing noise) vanish, solid wrong areas keep (width - k + 1) x (height - k + 1) pixels.
* V1 passes when `residual3 <= 25` and `px32_shift1 <= 0.005`, where (ruling M4-R11, the author's choice) the
  residual is judged per text line (`line_residual`, recorded `residual3Lines`): each line of the input PDF's text
  may move by at most 1 px in x and in y in the render, one whole-pixel shift for the whole line, the best of the nine;
  PowerPoint's render rounds a line to its pixels by its text box, which a PDF does not record (M4 Task 6). The raw
  `residual3` stays recorded beside it, with `passRaw`. V2 (ruling M3-R51, the author's choice) passes, on a
  slide with a ground truth, when `residual5 <= noise residual5 + 50` and `px32_shift1 <= noise px32_shift1 + 0.006`,
  the noise floor being the same metrics between the MuPDF render of the PDF and the PowerPoint render of the source
  deck (M1-R57): the spec's numbers become the excess allowed over the original's own renderer difference. On a slide
  without one, V2 passes when `residual5 <= 400` and `px32_shift1 <= 0.01` (the p90 of the atlas noise floor). The
  gates apply per slide; the V2 record says which limits it was held to (`limits`).
* Which image is shifted differs between the gates, as in the calibration probe: V1 fixes the reference render
  (`gt`) and shifts the output, `px32_shift1(gt, out)`; V2 (ruling M1-R36) fixes the PowerPoint render of the
  output and shifts the MuPDF render of the PDF, `px32_shift1(out, pdf_render)`.
"""

from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

from harness.ppt.pngmode import RGB, RGBA, png_bit_depth, png_colour_type

THRESHOLD = 32  # a pixel differs when its max channel difference is greater than this

V1_MAX_RESIDUAL = 25  # differing pixels left after a 3 x 3 erosion
V1_EROSION = 3
V1_MAX_SHIFT1 = 0.005  # px32_shift1, 0.5 %
# Ruling M5-R1 (writing down M4-R13): a slide whose own noise record (v2 of the MuPDF render against the source
# deck's PowerPoint render) leaves more than this residual5 is one no converter can match to V1's limit; V1 is judged
# by V2 there. The M3-R51 absolute V2 limit, 400 px, also the text/20 case (512 px).
V1_NOISE_EXEMPT_RESIDUAL = 400

V2_MAX_RESIDUAL = 50  # differing pixels left after a 5 x 5 erosion, above the noise floor's (M3-R51)
V2_EROSION = 5
V2_MAX_SHIFT1 = 0.006  # px32_shift1, 0.6 %, above the noise floor's (M3-R51)
V2_ALONE_RESIDUAL = 400  # without a ground truth (M3-R51): the p90 of the atlas noise floor
V2_ALONE_SHIFT1 = 0.01  # 1 %
LIMIT_DIGITS = 8  # a limit is rounded as run.py rounds the records (1e-8)

SHIFT_RADIUS = 1  # +-1 px, i.e. the 3 x 3 neighbourhood

V1_LINE_SHIFT = 1  # M4-R11: a text line may move by at most this many px in x and in y, as a whole
V1_LINE_PAD = 2  # px around a line's glyph boxes: their anti-aliasing and the 1 px the line may move


def _check_pair(a, b):
    for name, img in (("a", a), ("b", b)):
        if not isinstance(img, np.ndarray) or img.dtype != np.uint8 or img.ndim != 3 or img.shape[2] != 3:
            raise ValueError(f"image {name} must be a uint8 H x W x 3 array")
    if a.shape != b.shape:
        raise ValueError(
            f"image size mismatch: {a.shape[1]}x{a.shape[0]} vs {b.shape[1]}x{b.shape[0]} (width x height); "
            "the images are compared pixel for pixel and are never resized"
        )


def _max_channel_diff(a, b):
    """Per-pixel max over the colour channels of |a - b|, as int16 (uint8 subtraction would wrap)."""
    return np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)


def shift_min_diff(a, b, r=SHIFT_RADIUS):
    """Per pixel, the smallest max-channel |a - b| over all shifts of `b` by -r..r px in x and y.

    Edges use replicate padding: a position outside the image repeats the nearest edge pixel, so the shifts never
    invent colours that are not in `b`.
    """
    _check_pair(a, b)
    height, width = a.shape[:2]
    a16 = a.astype(np.int16)
    padded = np.pad(b.astype(np.int16), ((r, r), (r, r), (0, 0)), mode="edge")
    best = None
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            shifted = padded[r + dy:r + dy + height, r + dx:r + dx + width]
            diff = np.abs(a16 - shifted).max(axis=2)
            best = diff if best is None else np.minimum(best, diff)
    return best


def diff_mask(a, b, thr=THRESHOLD):
    """Boolean H x W mask: True where the max channel |a - b| is greater than `thr`."""
    _check_pair(a, b)
    return _max_channel_diff(a, b) > thr


def px32(a, b):
    """Fraction (0..1) of pixels whose max channel |a - b| is > 32."""
    mask = diff_mask(a, b)
    return int(np.count_nonzero(mask)) / mask.size


def px32_shift1(a, b):
    """Fraction (0..1) of pixels of `a` that no +-1 px shift of `b` matches to within 32 on every channel.

    `a` is the fixed image and `b` the one that is shifted; swapping them changes the result.
    """
    unexplained = shift_min_diff(a, b) > THRESHOLD
    return int(np.count_nonzero(unexplained)) / unexplained.size


def eroded_residual(mask, k):
    """Number of True pixels left after a k x k binary erosion of `mask` (k odd, so the element is centred).

    Pixels outside the image count as False (scipy's default), so a difference that touches the image border
    loses its outer (k - 1) / 2 pixels there too.
    """
    if not isinstance(k, (int, np.integer)) or k < 1 or k % 2 == 0:
        raise ValueError(f"erosion size k must be an odd positive integer, got {k!r}")
    eroded = ndimage.binary_erosion(mask, structure=np.ones((k, k), dtype=bool))
    return int(np.count_nonzero(eroded))


def largest_blob(mask):
    """Pixel count of the largest 4-connected True region of `mask` (0 for an empty mask)."""
    labels, count = ndimage.label(mask)
    if count == 0:
        return 0
    return int(np.bincount(labels.ravel())[1:].max())


def pixel_regions(boxes, scale, shape, pad=V1_LINE_PAD):
    """Text-line boxes in points (x0, y0, x1, y1: `pdf_facts.text_line_boxes`) as pixel rectangles of an image of
    `shape` (rows, columns) rendered at `scale` px per point: [x0, y0, x1, y1) widened by `pad` px and cut to the
    image; a box that leaves nothing is dropped. In the boxes' order."""
    rows, cols = shape[0], shape[1]
    out = []
    for x0, y0, x1, y1 in boxes:
        a = max(0, int(np.floor(x0 * scale)) - pad)
        b = max(0, int(np.floor(y0 * scale)) - pad)
        c = min(cols, int(np.ceil(x1 * scale)) + pad)
        d = min(rows, int(np.ceil(y1 * scale)) + pad)
        if c > a and d > b:
            out.append((a, b, c, d))
    return out


def line_owners(shape, regions):
    """Which line region each pixel is judged in (M4-R11): an int array of `shape` (rows, columns), the index of a
    region or -1 for a pixel in none. A pixel inside several regions belongs to exactly one, the region it lies
    deepest in: the smallest of max(|x - cx| / (w / 2), |y - cy| / (h / 2)) from each region's centre, ties to the
    earlier region. So no pixel is judged twice, under two lines' shifts."""
    owner = np.full(shape[:2], -1, dtype=np.int32)
    depth = np.full(shape[:2], np.inf)
    for i, (x0, y0, x1, y1) in enumerate(regions):
        cx, cy = (x0 + x1 - 1) / 2, (y0 + y1 - 1) / 2
        hw, hh = max((x1 - x0) / 2, 0.5), max((y1 - y0) / 2, 0.5)
        ys, xs = np.mgrid[y0:y1, x0:x1]
        d = np.maximum(np.abs(xs - cx) / hw, np.abs(ys - cy) / hh)
        here = d < depth[y0:y1, x0:x1]
        owner[y0:y1, x0:x1][here] = i
        depth[y0:y1, x0:x1][here] = d[here]
    return owner


def shifted(image, dx, dy):
    """`image` moved so that result[y, x] = image[y + dy, x + dx], the edge rows and columns repeated outside it."""
    r = max(abs(dx), abs(dy))
    if r == 0:
        return image
    padded = np.pad(image, ((r, r), (r, r), (0, 0)), mode="edge")
    rows, cols = image.shape[:2]
    return padded[r + dy:r + dy + rows, r + dx:r + dx + cols]


LINE_SHIFTS = sorted(((dx, dy) for dx in range(-V1_LINE_SHIFT, V1_LINE_SHIFT + 1)
                      for dy in range(-V1_LINE_SHIFT, V1_LINE_SHIFT + 1)),
                     key=lambda s: (abs(s[0]) + abs(s[1]), s))  # (0, 0) first: a tie keeps the line where it is


def line_residual(gt, out, regions, k=V1_EROSION):
    """V1's residual judged per text line (ruling M4-R11): (residual, shifts).

    For every shift (dx, dy) of `LINE_SHIFTS` (at most 1 px each way, (0, 0) among them) the differing pixels of `gt`
    against `out` moved by it (`shifted`) are eroded k x k over the whole image. Each line region takes the shift that
    leaves the fewest eroded pixels among the pixels it owns (`line_owners`), (0, 0) on a tie; a pixel owned by no
    region is judged unshifted. The residual is the sum over the regions of what their shift leaves, plus the
    unshifted residual of the pixels no region owns. Every pixel is counted once, so it is never more than the raw
    residual (`eroded_residual(diff_mask(gt, out), k)`). `shifts` is each region's (dx, dy)."""
    _check_pair(gt, out)
    owner = line_owners(gt.shape, regions)
    count = len(regions)
    left = {}
    for dx, dy in LINE_SHIFTS:
        eroded = ndimage.binary_erosion(diff_mask(gt, shifted(out, dx, dy)), structure=np.ones((k, k), dtype=bool))
        # pixels left per owner: index 0 is "no region", region i is i + 1
        left[(dx, dy)] = np.bincount(owner[eroded] + 1, minlength=count + 1)
    base = left[(0, 0)]
    total = int(base[0])
    shifts = []
    for i in range(count):
        best = min(LINE_SHIFTS, key=lambda s: (int(left[s][i + 1]), LINE_SHIFTS.index(s)))
        shifts.append(best)
        total += int(left[best][i + 1])
    return total, shifts


def outside_lines(a, b, regions, k):
    """Ruling M8-R12: V1's or V2's two measures over the pixels outside every text-line region (``pixel_regions``), the
    residual and the px32_shift1, as `{"residual": eroded pixels left outside, "px32_shift1": the fraction of all the
    image's pixels that are unexplained and outside}`: a fraction of the whole image, so the gate's own limit applies
    to it unchanged. `a` is the fixed image of px32_shift1 and `b` the shifted one, as in the gate."""
    outside = line_owners(a.shape, regions) < 0
    eroded = ndimage.binary_erosion(diff_mask(a, b), structure=np.ones((k, k), dtype=bool))
    unexplained = shift_min_diff(a, b) > THRESHOLD
    return {"residual": int(np.count_nonzero(eroded & outside)),
            "px32_shift1": int(np.count_nonzero(unexplained & outside)) / unexplained.size}


def v1(gt, out, lines=None):
    """V1, same renderer: `gt` is the PowerPoint render of the source deck, `out` that of the converted deck; `lines`
    the pixel rectangles of the page's text lines (`pixel_regions`), none when the page has no text.

    Returns {raw_px32, px32_shift1, residual3, residual3Lines, lines, shiftedLines, passRaw, pass}. `px32_shift1` is
    `px32_shift1(gt, out)`: the reference is fixed and the output is shifted. `residual3` is the raw eroded residual,
    `residual3Lines` the one judged per text line (`line_residual`, ruling M4-R11), never more; `shiftedLines` how many
    lines took a shift other than (0, 0). `pass` is V1's status, judged on `residual3Lines`; `passRaw` the same test on
    `residual3`.
    """
    shift1 = px32_shift1(gt, out)
    mask = diff_mask(gt, out)
    residual = eroded_residual(mask, V1_EROSION)
    regions = list(lines or [])
    if regions:
        by_line, shifts = line_residual(gt, out, regions)
    else:
        by_line, shifts = residual, []
    record = {
        "raw_px32": int(np.count_nonzero(mask)) / mask.size,
        "px32_shift1": shift1,
        "residual3": residual,
        "residual3Lines": by_line,
        "lines": len(regions),
        "shiftedLines": sum(1 for s in shifts if s != (0, 0)),
        "passRaw": bool(residual <= V1_MAX_RESIDUAL and shift1 <= V1_MAX_SHIFT1),
        "pass": bool(by_line <= V1_MAX_RESIDUAL and shift1 <= V1_MAX_SHIFT1),
    }
    if regions:  # ruling M8-R12: the same two measures outside the text lines, with V1's own limits
        rest = outside_lines(gt, out, regions, V1_EROSION)
        record["outside"] = {"residual3": rest["residual"], "px32_shift1": rest["px32_shift1"],
                             "pass": bool(rest["residual"] <= V1_MAX_RESIDUAL and rest["px32_shift1"] <= V1_MAX_SHIFT1)}
    return record


def v2_limits(noise=None):
    """V2's limits (ruling M3-R51): {"basis", "residual5", "px32_shift1"}. With a noise floor (`noise`, a V2 record of
    the MuPDF render against the ground truth, not an error record), its own numbers plus 50 px and 0.6 % (basis
    "noise"); without one, 400 px and 1 % (basis "absolute")."""
    if noise is None or "error" in noise:
        return {"basis": "absolute", "residual5": V2_ALONE_RESIDUAL, "px32_shift1": V2_ALONE_SHIFT1}
    return {"basis": "noise", "residual5": int(noise["residual5"]) + V2_MAX_RESIDUAL,
            "px32_shift1": round(float(noise["px32_shift1"]) + V2_MAX_SHIFT1, LIMIT_DIGITS)}


def v2(pdf_render, out, noise=None, lines=None):
    """V2, cross renderer: `pdf_render` is the MuPDF render of the input PDF, `out` the PowerPoint render of the
    converted deck; `noise` the slide's noise floor, v2(MuPDF render, ground truth), None without a ground truth.

    Returns {raw_px32, px32_shift1, residual5, pass, limits}: `limits` is `v2_limits(noise)` (M3-R51), and it passes
    when both metrics are within them. Ruling M1-R36 (as in the calibration probe): `px32_shift1` is
    `px32_shift1(out, pdf_render)`: the PowerPoint render of the output is fixed and the MuPDF render is shifted.
    `raw_px32` and `residual5` do not depend on the direction. `lines`: the pixel rectangles of the page's text lines
    (`pixel_regions`); with them the record also has `outside` (ruling M8-R12): the same two measures over the pixels
    outside the lines, judged by the same limits.
    """
    shift1 = px32_shift1(out, pdf_render)
    mask = diff_mask(pdf_render, out)
    residual = eroded_residual(mask, V2_EROSION)
    limits = v2_limits(noise)
    record = {
        "raw_px32": int(np.count_nonzero(mask)) / mask.size,
        "px32_shift1": shift1,
        "residual5": residual,
        "pass": bool(residual <= limits["residual5"] and round(shift1, LIMIT_DIGITS) <= limits["px32_shift1"]),
        "limits": limits,
    }
    if lines:  # ruling M8-R12
        rest = outside_lines(out, pdf_render, list(lines), V2_EROSION)
        record["outside"] = {"residual5": rest["residual"], "px32_shift1": rest["px32_shift1"],
                             "pass": bool(rest["residual"] <= limits["residual5"]
                                          and round(rest["px32_shift1"], LIMIT_DIGITS) <= limits["px32_shift1"])}
    return record


def heatmap(a, b, path):
    """Write a truecolour PNG showing where `a` and `b` differ.

    A washed-out greyscale copy of `a` is the backdrop. Pixels that differ by more than 32 are orange when a +-1 px
    shift of `b` explains them (anti-aliasing / sub-pixel offset) and red when nothing does (a real difference).
    """
    _check_pair(a, b)
    grey = a.astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    backdrop = np.rint(0.35 * grey + 0.65 * 255).astype(np.uint8)
    heat = np.repeat(backdrop[:, :, None], 3, axis=2)
    differs = _max_channel_diff(a, b) > THRESHOLD
    unexplained = shift_min_diff(a, b) > THRESHOLD
    heat[differs] = (255, 165, 0)
    heat[unexplained] = (255, 0, 0)
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(heat, "RGB").save(path)


def load_png(path):
    """Read a harness render as a uint8 H x W x 3 array.

    Only 8-bit truecolour PNGs are accepted: RGB (colour type 2), or RGBA (type 6) whose alpha channel is
    entirely 255, in which case the alpha channel is dropped (an opaque slide render loses nothing). A palette
    (type 3), greyscale, 16-bit or partly transparent PNG is an error, never a silent conversion, because
    quantised, rounded or composited colours would add noise to every pixel metric (Pillow would quietly reduce a
    16-bit PNG to 8 bits, so the bit depth is checked in the file header first).
    """
    colour_type = png_colour_type(path)
    if colour_type not in (RGB, RGBA):
        raise ValueError(f"{path}: PNG colour type {colour_type} is not truecolour (need 2 = RGB or 6 = RGBA)")
    depth = png_bit_depth(path)
    if depth != 8:
        raise ValueError(f"{path}: PNG bit depth {depth} is not 8 (the harness compares 8-bit renders only)")
    with Image.open(path) as img:
        arr = np.asarray(img)
    if arr.dtype != np.uint8:
        raise ValueError(f"{path}: expected an 8-bit PNG, got {arr.dtype}")
    if colour_type == RGBA:
        if not (arr[:, :, 3] == 255).all():
            raise ValueError(f"{path}: RGBA PNG has non-opaque alpha pixels; refusing to drop the alpha channel")
        arr = arr[:, :, :3]
    return np.ascontiguousarray(arr)
