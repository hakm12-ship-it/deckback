"""Tests for the pixel metrics (metrics.py) and the PyMuPDF page renderer (render_pdf.py).

The numbers asserted here are the spec's: a pixel differs when its max channel |a-b| is > 32; V1 passes with a
3x3-eroded residual <= 25 px and px32_shift1 <= 0.5 %; V2 (ruling M3-R51), with a ground truth, with a 5x5-eroded
residual at most 50 px and a px32_shift1 at most 0.6 % above the noise floor's (the same metrics between MuPDF's render
and the ground truth), and without one with a residual <= 400 px and px32_shift1 <= 1 %. The images are 1920x1080
(2 px/pt for a 16:9 slide).
"""

import struct
import zlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from harness.fidelity import metrics, render_pdf
from harness.ppt.pngmode import PNG_SIGNATURE, png_bit_depth, png_colour_type

REPO = Path(__file__).resolve().parents[2]
PROBE_PDF = REPO / "corpus" / "generated" / "probe_std.pdf"
PROBE_GT = REPO / "corpus" / "generated" / "probe_gt"

H, W = 1080, 1920
N = H * W
CLEAN = {"residual5": 0, "px32_shift1": 0.0}  # a noise floor of nothing: V2's limits are then the spec's, 50 px and 0.6 %


def blank(value=255):
    return np.full((H, W, 3), value, dtype=np.uint8)


def with_block(img, y, x, size, value=0):
    out = img.copy()
    out[y:y + size, x:x + size] = value
    return out


def brute_force_unexplained(a, b, y0, y1, x0, x1):
    """Pixels in [y0:y1, x0:x1] of `a` that no +-1 px shift of `b` matches within 32, by plain loops.

    An independent check of px32_shift1 on a small crop (the window must keep one pixel clear of the image edge).
    """
    count = 0
    for y in range(y0, y1):
        for x in range(x0, x1):
            explained = False
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    diff = max(abs(int(a[y, x, c]) - int(b[y + dy, x + dx, c])) for c in range(3))
                    if diff <= 32:
                        explained = True
            if not explained:
                count += 1
    return count


# -- diff_mask / px32 ----------------------------------------------------------------------------------------

def test_identical_images_are_all_zero_and_pass():
    rng = np.random.default_rng(0)
    a = rng.integers(0, 256, size=(H, W, 3), dtype=np.uint8)
    b = a.copy()
    assert not metrics.diff_mask(a, b).any()
    assert metrics.px32(a, b) == 0
    assert metrics.px32_shift1(a, b) == 0
    assert metrics.largest_blob(metrics.diff_mask(a, b)) == 0
    v1 = metrics.v1(a, b)
    v2 = metrics.v2(a, b)
    assert v1 == {"raw_px32": 0.0, "px32_shift1": 0.0, "residual3": 0, "residual3Lines": 0, "lines": 0,
                  "shiftedLines": 0, "passRaw": True, "pass": True}
    assert v2 == {"raw_px32": 0.0, "px32_shift1": 0.0, "residual5": 0, "pass": True,
                  "limits": {"basis": "absolute", "residual5": 400, "px32_shift1": 0.01}}


def test_diff_mask_uses_max_channel_and_a_strict_threshold():
    a = blank(100)
    b = a.copy()
    b[0, 0] = (100 + 32, 100, 100)  # exactly 32 on one channel: not different
    b[0, 1] = (100, 100, 100 + 33)  # 33 on the blue channel only: different
    b[0, 2] = (100 - 33, 100, 100)  # negative direction counts too
    b[0, 3] = (100 + 20, 100 + 20, 100 + 20)  # many small channel differences: not different
    mask = metrics.diff_mask(a, b)
    assert mask.dtype == bool and mask.shape == (H, W)
    assert mask[0, :4].tolist() == [False, True, True, False]
    assert mask.sum() == 2
    assert metrics.diff_mask(a, b, thr=19)[0, 3]  # the threshold is a parameter


def test_diff_mask_does_not_wrap_around_in_uint8():
    a = np.zeros((2, 2, 3), dtype=np.uint8)
    b = np.full((2, 2, 3), 255, dtype=np.uint8)
    assert metrics.diff_mask(a, b).all()  # |0 - 255| = 255, not 1 (uint8 wrap)
    assert metrics.diff_mask(b, a).all()


def test_px32_is_the_fraction_of_differing_pixels():
    a = blank()
    b = with_block(a, 100, 100, 10)  # 100 differing pixels
    assert metrics.px32(a, b) == 100 / N


def test_size_mismatch_is_an_error_not_a_resize():
    a = blank()
    b = np.zeros((H, W - 1, 3), dtype=np.uint8)
    for fn in (metrics.diff_mask, metrics.px32, metrics.px32_shift1, metrics.v1, metrics.v2):
        with pytest.raises(ValueError, match="size"):
            fn(a, b)


@pytest.mark.parametrize("bad", [
    np.zeros((H, W), dtype=np.uint8),  # greyscale
    np.zeros((H, W, 4), dtype=np.uint8),  # RGBA array
    np.zeros((H, W, 3), dtype=np.float32),  # not uint8
])
def test_inputs_must_be_uint8_hxwx3(bad):
    with pytest.raises(ValueError):
        metrics.px32(bad, bad)


# -- px32_shift1 ---------------------------------------------------------------------------------------------

def sharp_edge_image():
    """White page with sharp black rectangles, vertical and horizontal edges, away from the image border."""
    img = blank()
    img[200:400, 300:900] = 0
    img[600:640, 100:1800] = 30
    img[700:1000, 1000:1010] = 0  # a 10 px wide bar
    return img


@pytest.mark.parametrize("dy, dx", [(0, 1), (1, 0), (1, 1), (-1, -1), (1, -1)])
def test_one_pixel_shift_of_a_sharp_edge_image_costs_nothing_after_the_shift_tolerance(dy, dx):
    a = sharp_edge_image()
    b = np.roll(a, shift=(dy, dx), axis=(0, 1))  # margins are white, so the wrap-around moves white onto white
    assert metrics.px32(a, b) > 0
    assert metrics.px32_shift1(a, b) == 0
    assert metrics.v1(a, b)["pass"] is True
    assert metrics.v2(a, b)["pass"] is True


def test_a_two_pixel_shift_is_not_tolerated():
    a = sharp_edge_image()
    b = np.roll(a, shift=(0, 2), axis=(0, 1))
    assert metrics.px32_shift1(a, b) > 0


def test_px32_shift1_uses_replicate_padding_at_the_image_edge():
    a = blank()
    b = blank()
    a[0, :] = 0  # top row black in a only
    b[0, :] = 0
    b[1, :] = 0  # b has two black rows: shifted by one row it matches a's top row
    # a's second row is white; b shifted up by one is b's third row (white) -> explained; no padding involved.
    assert metrics.px32_shift1(a, b) == 0
    # With replicate padding the row above the image repeats row 0, so a black top row in b explains a black
    # top row in a even for the outermost pixels, and a black-in-a, white-in-b top row is NOT explained.
    c = blank()
    assert metrics.px32_shift1(a, c) == W / N  # white b never matches a black row, edge or not


def test_px32_shift1_is_asymmetric_it_shifts_b_only():
    # `a` is fixed and `b` is shifted. A block present in b but not in a: its border pixels (white in a) are
    # matched by white pixels of b next to the block, leaving the interior (16 - 2) ** 2 = 196. The same block
    # present in a but not in b is matched by nothing: all 16 * 16 = 256 pixels stay.
    a = blank()
    b = with_block(a, 500, 800, 16)
    assert metrics.px32_shift1(a, b) == 196 / N
    assert metrics.px32_shift1(b, a) == 256 / N


def test_v1_shifts_the_output_and_v2_shifts_the_pdf_render():
    # V1: reference (gt) fixed, output shifted. V2 (M1-R36, as in the calibration probe): the PowerPoint render
    # of the output is fixed and the MuPDF render of the PDF is shifted. Same block, same two images, so the two
    # gates must report opposite counts for the same argument order.
    with_it = with_block(blank(), 500, 800, 16)
    without = blank()
    # V1(gt, out): block only in gt -> nothing in `out` explains it -> 256; block only in out -> 196.
    assert metrics.v1(with_it, without)["px32_shift1"] == 256 / N
    assert metrics.v1(without, with_it)["px32_shift1"] == 196 / N
    # V2(pdf_render, out): block only in the PDF render -> the out image (fixed) is white there and a shifted
    # PDF render has white next to the block -> 196; block only in out -> 256.
    assert metrics.v2(with_it, without)["px32_shift1"] == 196 / N
    assert metrics.v2(without, with_it)["px32_shift1"] == 256 / N
    # and they are exactly px32_shift1 with the fixed image first
    rng = np.random.default_rng(1)
    pdf_render = rng.integers(0, 256, size=(40, 50, 3), dtype=np.uint8)
    out = rng.integers(0, 256, size=(40, 50, 3), dtype=np.uint8)
    assert metrics.v1(pdf_render, out)["px32_shift1"] == metrics.px32_shift1(pdf_render, out)
    assert metrics.v2(pdf_render, out)["px32_shift1"] == metrics.px32_shift1(out, pdf_render)


# -- eroded_residual / largest_blob --------------------------------------------------------------------------

def test_eroded_residual_counts_what_survives_a_kxk_erosion():
    mask = np.zeros((H, W), dtype=bool)
    mask[500:516, 800:816] = True  # a 16 x 16 block
    assert metrics.eroded_residual(mask, 3) == 14 * 14
    assert metrics.eroded_residual(mask, 5) == 12 * 12
    assert metrics.eroded_residual(mask, 1) == 256
    assert isinstance(metrics.eroded_residual(mask, 5), int)


def test_eroded_residual_removes_lines_thinner_than_the_element():
    mask = np.zeros((H, W), dtype=bool)
    mask[300, 100:1800] = True  # 1 px high line
    mask[500:502, 100:1800] = True  # 2 px high line
    mask[:, 50] = True  # 1 px wide column
    assert metrics.eroded_residual(mask, 3) == 0
    assert metrics.eroded_residual(mask, 5) == 0


@pytest.mark.parametrize("k", [0, -3, 2, 4])
def test_eroded_residual_wants_an_odd_positive_k(k):
    with pytest.raises(ValueError):
        metrics.eroded_residual(np.zeros((9, 9), dtype=bool), k)


def test_largest_blob_is_the_biggest_4_connected_component():
    mask = np.zeros((H, W), dtype=bool)
    mask[10:13, 10:13] = True  # 9
    mask[100:110, 100:105] = True  # 50
    mask[500, 500:503] = True  # 3
    mask[600, 600] = mask[601, 601] = True  # touch only diagonally: two blobs of 1
    assert metrics.largest_blob(mask) == 50
    assert isinstance(metrics.largest_blob(mask), int)
    assert metrics.largest_blob(np.zeros((H, W), dtype=bool)) == 0


# -- V1 / V2 on a missing block (M1-R9) -----------------------------------------------------------------------

def test_a_missing_16px_block_fails_v2_by_its_residual():
    # 16 x 16 px = 8 x 8 pt at 2 px/pt. The reference render has the block, the output lacks it.
    reference = with_block(blank(), 500, 800, 16)
    out = blank()
    mask = metrics.diff_mask(reference, out)
    assert mask.sum() == 256
    assert metrics.eroded_residual(mask, 5) == 144  # (16 - 4) ** 2
    assert metrics.eroded_residual(mask, 3) == 196  # (16 - 2) ** 2

    v2 = metrics.v2(reference, out, CLEAN)
    assert v2["residual5"] == 144
    assert v2["pass"] is False  # 144 > 0 + 50: it fails by the residual

    # V2 (M1-R36) keeps the output fixed and shifts the PDF render. The fixed output is white over the block, and
    # a shifted PDF render has white pixels next to the block, so a block pixel is explained whenever one step
    # leaves the block: only the interior (16 - 2) ** 2 = 196 pixels stay unexplained, not all 256. Checked
    # against plain loops on a crop around the block (fixed image first).
    expected = brute_force_unexplained(out, reference, 490, 530, 790, 830)
    assert expected == (16 - 2) ** 2 == 196
    assert v2["px32_shift1"] == expected / N
    assert v2["raw_px32"] == 256 / N


def test_an_extra_16px_block_in_the_output_has_a_larger_shift_count():
    # The mirror case: the output has a block the PDF render lacks. The fixed output is black over the block and
    # the shifted PDF render is flat white, so no shift explains any of the block's 16 * 16 = 256 pixels.
    reference = blank()
    out = with_block(blank(), 500, 800, 16)
    mask = metrics.diff_mask(reference, out)
    assert metrics.eroded_residual(mask, 5) == 144

    v2 = metrics.v2(reference, out, CLEAN)
    assert v2["residual5"] == 144
    assert v2["pass"] is False

    expected = brute_force_unexplained(out, reference, 490, 530, 790, 830)
    assert expected == 256
    assert v2["px32_shift1"] == expected / N


def test_a_missing_block_also_fails_v1_by_its_residual():
    reference = with_block(blank(), 500, 800, 16)
    v1 = metrics.v1(reference, blank())
    assert v1["residual3"] == 196
    assert v1["pass"] is False


def test_scattered_one_pixel_lines_leave_no_residual():
    # Anti-aliasing noise: 1 px lines (horizontal, vertical, diagonal) where one render has a dark pixel row and
    # the other does not.
    a = blank()
    b = blank()
    for y in range(50, 1000, 97):
        b[y, 100:1700] = 0
    for x in range(200, 1800, 131):
        b[100:900, x] = 0
    for i in range(300):
        b[600 + i, 1000 + i] = 0
    assert metrics.px32(a, b) > 0
    assert metrics.eroded_residual(metrics.diff_mask(a, b), 3) == 0
    v1 = metrics.v1(a, b)
    v2 = metrics.v2(a, b)
    assert v1["residual3"] == 0
    assert v2["residual5"] == 0
    assert v1["raw_px32"] > 0


# -- gate boundaries -----------------------------------------------------------------------------------------

def one_pixel_rows(n_pixels):
    """(rows, flat): `rows` has n_pixels dark pixels in 1 px high rows (spaced 4 apart), `flat` is all white.

    px32_shift1 with `rows` as the fixed image and `flat` as the shifted one is n_pixels / N: nothing in `flat`
    explains a dark pixel. (The other way round it is 0, the white pixels all find white next to them.)
    """
    rows = blank()
    left = n_pixels
    y = 0
    while left > 0:
        n = min(W, left)
        rows[y, :n] = 0
        left -= n
        y += 4
    return rows, blank()


def test_v1_boundary_on_the_residual():
    # A k x k block eroded 3x3 leaves (k-2)^2: 7 -> 25 (pass), 8 -> 36 (fail).
    ok = metrics.v1(with_block(blank(), 500, 800, 7), blank())
    assert ok["residual3"] == 25 and ok["pass"] is True
    bad = metrics.v1(with_block(blank(), 500, 800, 8), blank())
    assert bad["residual3"] == 36 and bad["pass"] is False


def test_v2_boundary_on_the_residual():
    # A k x k block eroded 5x5 leaves (k-4)^2: 11 -> 49 (pass); 12 -> 64 (fail). 51 is not reachable by a square.
    ok = metrics.v2(with_block(blank(), 500, 800, 11), blank(), CLEAN)
    assert ok["residual5"] == 49 and ok["pass"] is True
    bad = metrics.v2(with_block(blank(), 500, 800, 12), blank(), CLEAN)
    assert bad["residual5"] == 64 and bad["pass"] is False
    # Exactly 50: a 9 x 14 rectangle leaves (9 - 4) * (14 - 4) = 5 * 10.
    rect = blank()
    rect[500:509, 800:814] = 0
    exact = metrics.v2(rect, blank(), CLEAN)
    assert exact["residual5"] == 50 and exact["pass"] is True


def test_v1_boundary_on_px32_shift1_is_half_a_percent():
    limit = round(0.005 * N)  # 10368 pixels
    assert limit == 10368
    rows, flat = one_pixel_rows(limit)
    at_limit = metrics.v1(rows, flat)  # V1: reference fixed (rows), output shifted (flat)
    assert at_limit["residual3"] == 0
    assert at_limit["px32_shift1"] == 0.005 and at_limit["pass"] is True
    rows, flat = one_pixel_rows(limit + 1)
    over = metrics.v1(rows, flat)
    assert over["residual3"] == 0
    assert over["px32_shift1"] > 0.005 and over["pass"] is False


def test_v2_boundary_on_px32_shift1_is_six_tenths_of_a_percent():
    # V2 (M1-R36): the output is fixed and the PDF render is shifted, so the dark rows go in `out`.
    rows, flat = one_pixel_rows(12441)  # 0.006 * N = 12441.6
    at_limit = metrics.v2(flat, rows, CLEAN)
    assert at_limit["residual5"] == 0
    assert at_limit["px32_shift1"] <= 0.006 and at_limit["pass"] is True
    rows, flat = one_pixel_rows(12442)
    over = metrics.v2(flat, rows, CLEAN)
    assert over["residual5"] == 0
    assert over["px32_shift1"] > 0.006 and over["pass"] is False


# -- V2's limits, ruling M3-R51 -------------------------------------------------------------------------------

def test_v2_with_a_ground_truth_allows_the_noise_floor_and_the_spec_above_it():
    """With a noise floor (v2(MuPDF render, ground truth)), V2 passes at most 50 px and 0.6 % above it."""
    noise = {"raw_px32": 0.01, "px32_shift1": 0.004, "residual5": 100, "pass": True}
    # a 16 x 16 px block leaves 144 px after the 5 x 5 erosion: within 100 + 50
    v2 = metrics.v2(with_block(blank(), 500, 800, 16), blank(), noise)
    assert v2["residual5"] == 144 and v2["pass"] is True
    assert v2["limits"] == {"basis": "noise", "residual5": 150, "px32_shift1": 0.01}
    # 17 x 17 leaves 169: over
    assert metrics.v2(with_block(blank(), 500, 800, 17), blank(), noise)["pass"] is False
    # px32_shift1 0.4 % + 0.6 % = 1 %: 20736 px of N, then one more
    rows, flat = one_pixel_rows(round(0.01 * N))
    assert metrics.v2(flat, rows, noise)["pass"] is True
    rows, flat = one_pixel_rows(round(0.01 * N) + 1)
    assert metrics.v2(flat, rows, noise)["pass"] is False
    # both must hold: the residual within, the shift over
    rows, flat = one_pixel_rows(round(0.011 * N))
    assert metrics.v2(flat, rows, {**noise, "residual5": 0})["pass"] is False


def test_v2_without_a_ground_truth_passes_at_400_px_and_1_percent():
    # 24 x 24 leaves (24 - 4)^2 = 400: within; 25 x 25 leaves 441
    ok = metrics.v2(with_block(blank(), 500, 800, 24), blank())
    assert ok["residual5"] == 400 and ok["pass"] is True
    assert ok["limits"] == {"basis": "absolute", "residual5": 400, "px32_shift1": 0.01}
    assert metrics.v2(with_block(blank(), 500, 800, 25), blank())["pass"] is False
    rows, flat = one_pixel_rows(20736)  # 0.01 * N = 20736 exactly
    assert metrics.v2(flat, rows)["pass"] is True
    rows, flat = one_pixel_rows(20737)
    assert metrics.v2(flat, rows)["pass"] is False
    # a noise floor that could not be computed is no ground truth
    no_floor = metrics.v2(with_block(blank(), 500, 800, 24), blank(), {"pass": False, "error": "x"})
    assert no_floor["limits"]["basis"] == "absolute"


def test_v1_and_v2_results_are_plain_json_types():
    import json

    a = with_block(blank(), 500, 800, 16)
    for result in (metrics.v1(a, blank()), metrics.v2(a, blank())):
        assert type(result["pass"]) is bool
        assert type(result["raw_px32"]) is float and type(result["px32_shift1"]) is float
        json.dumps(result)


# -- PNG loading ---------------------------------------------------------------------------------------------

def test_load_png_reads_rgb_as_uint8_hxwx3(tmp_path):
    arr = np.arange(4 * 6 * 3, dtype=np.uint8).reshape(4, 6, 3)
    Image.fromarray(arr, "RGB").save(tmp_path / "x.png")
    out = metrics.load_png(tmp_path / "x.png")
    assert out.dtype == np.uint8 and out.shape == (4, 6, 3)
    assert np.array_equal(out, arr)


def test_load_png_drops_a_fully_opaque_alpha_channel(tmp_path):
    arr = np.arange(4 * 6 * 3, dtype=np.uint8).reshape(4, 6, 3)
    rgba = np.dstack([arr, np.full((4, 6), 255, dtype=np.uint8)])
    Image.fromarray(rgba, "RGBA").save(tmp_path / "x.png")
    assert np.array_equal(metrics.load_png(tmp_path / "x.png"), arr)


def test_load_png_rejects_a_transparent_rgba_png(tmp_path):
    rgba = np.zeros((4, 6, 4), dtype=np.uint8)
    rgba[..., 3] = 255
    rgba[1, 1, 3] = 254
    Image.fromarray(rgba, "RGBA").save(tmp_path / "x.png")
    with pytest.raises(ValueError, match="alpha"):
        metrics.load_png(tmp_path / "x.png")


@pytest.mark.parametrize("mode", ["P", "L", "LA"])
def test_load_png_rejects_palette_and_greyscale_pngs(tmp_path, mode):
    Image.new(mode, (4, 6)).save(tmp_path / "x.png")
    with pytest.raises(ValueError, match="colour type"):
        metrics.load_png(tmp_path / "x.png")


def write_png_16bit(path, colour_type, width=4, height=3):
    """A valid 16-bit truecolour PNG written by hand (Pillow cannot save one): colour type 2 or 6."""
    channels = {2: 3, 6: 4}[colour_type]
    row = bytes([0]) + bytes([0x12, 0x34]) * (width * channels)  # filter type 0, then 16-bit samples

    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 16, colour_type, 0, 0, 0)
    path.write_bytes(
        PNG_SIGNATURE + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(row * height)) + chunk(b"IEND", b"")
    )


@pytest.mark.parametrize("colour_type", [2, 6])
def test_load_png_rejects_16_bit_pngs_instead_of_letting_pillow_reduce_them(tmp_path, colour_type):
    path = tmp_path / "x.png"
    write_png_16bit(path, colour_type)
    assert png_colour_type(path) == colour_type and png_bit_depth(path) == 16
    with Image.open(path) as img:  # Pillow reads it happily, as 8 bit: this is what the check guards against
        assert np.asarray(img).dtype == np.uint8
    with pytest.raises(ValueError, match="bit depth 16"):
        metrics.load_png(path)


def test_png_bit_depth_reads_ihdr(tmp_path):
    Image.new("RGB", (3, 2)).save(tmp_path / "x.png")
    assert png_bit_depth(tmp_path / "x.png") == 8
    (tmp_path / "y.png").write_bytes(b"BM" + bytes(40))
    with pytest.raises(ValueError):
        png_bit_depth(tmp_path / "y.png")


def test_load_png_reads_the_committed_ground_truth_render():
    img = metrics.load_png(PROBE_GT / "slide1.png")
    assert png_colour_type(PROBE_GT / "slide1.png") == 2
    assert img.shape == (H, W, 3) and img.dtype == np.uint8


# -- heatmap -------------------------------------------------------------------------------------------------

def test_heatmap_writes_a_truecolour_png_marking_the_unexplained_pixels(tmp_path):
    a = with_block(blank(), 500, 800, 16)
    b = blank()
    path = tmp_path / "sub" / "heat.png"
    metrics.heatmap(a, b, path)
    assert png_colour_type(path) == 2
    heat = np.asarray(Image.open(path))
    assert heat.shape == (H, W, 3)
    assert tuple(heat[507, 807]) == (255, 0, 0)  # differs and no shift explains it: red
    assert tuple(heat[0, 0]) == tuple(heat[1000, 1900])  # untouched pixels share one background colour
    assert tuple(heat[0, 0]) != (255, 0, 0)


def test_heatmap_marks_shift_explained_pixels_differently(tmp_path):
    a = sharp_edge_image()
    b = np.roll(a, shift=(0, 1), axis=(0, 1))
    path = tmp_path / "heat.png"
    metrics.heatmap(a, b, path)
    heat = np.asarray(Image.open(path))
    differs = metrics.diff_mask(a, b)
    assert differs.any()
    assert not (heat[differs] == (255, 0, 0)).all(axis=1).any()  # nothing red: a shift explains all of it
    assert (heat[differs] != heat[0, 0]).any(axis=1).all()  # but every raw difference is visible


# -- render_pdf ----------------------------------------------------------------------------------------------

def test_render_pdf_page_0_is_1920x1080_rgb():
    img = render_pdf.render(PROBE_PDF, 0)
    assert img.shape == (1080, 1920, 3)
    assert img.dtype == np.uint8
    assert img.flags.writeable and img.std() > 0  # an owned copy with content, not the page-free blank


def test_render_pdf_scale_changes_the_size_and_is_deterministic():
    one = render_pdf.render(PROBE_PDF, 1, scale=1.0)
    assert one.shape == (540, 960, 3)
    assert np.array_equal(render_pdf.render(PROBE_PDF, 1), render_pdf.render(PROBE_PDF, 1))


def test_render_pdf_accepts_a_string_path_and_rejects_a_bad_page():
    assert render_pdf.render(str(PROBE_PDF), 2).shape == (1080, 1920, 3)
    for page in (-1, 3):
        with pytest.raises(ValueError, match="page"):
            render_pdf.render(PROBE_PDF, page)


def test_render_pdf_rejects_a_non_positive_scale():
    with pytest.raises(ValueError, match="scale"):
        render_pdf.render(PROBE_PDF, 0, scale=0)


def test_pixmap_sizes_are_the_render_sizes_on_odd_pages(tmp_path):
    """M1-R61: the expected size of every compared image is MuPDF's own pixmap size. MuPDF rounds the scaled page
    box outwards, so round(2 x pt) is 1 px short on A5 (419.53 pt: 840 px, round gives 839) and on 425.197 x 300.1."""
    import pymupdf

    sizes = [(419.53, 595.28), (595.3, 841.9), (425.197, 300.1), (960, 540)]
    doc = pymupdf.open()
    for width, height in sizes:
        doc.new_page(width=width, height=height)
    doc.new_page(width=419.53, height=595.28).set_rotation(90)
    pdf = tmp_path / "odd.pdf"
    doc.save(str(pdf))
    doc.close()

    found = render_pdf.pixmap_sizes(pdf)
    assert found == [(840, 1191), (1191, 1684), (851, 601), (1920, 1080), (1191, 840)]
    for index, (width, height) in enumerate(found):
        assert render_pdf.render(pdf, index).shape == (height, width, 3)
    assert round(2 * 419.53) == 839  # what the old rule expected
