"""V1 judged per text line (ruling M4-R11, the author's choice, M4 Task 7).

PowerPoint's render rounds each text line to its pixels by its text box, which a PDF does not record: a converted line
whose glyphs PowerPoint's own export puts within 0.1 pt of the source's can still render 1 px off and fail V1 (M4 Task
6). So V1 lets each whole text line of the input PDF move by at most 1 px in x and in y, the best of the nine shifts
for the whole line, and keeps the raw residual beside it. A line may not move further, its glyphs may not move apart,
and a pixel two line regions share is judged once.
"""

import numpy as np
import pymupdf
import pytest

from harness.fidelity import metrics, pdf_facts, run

H, W = 60, 200
BLOCK, GAP = 10, 6


def white(h=H, w=W):
    return np.full((h, w, 3), 255, dtype=np.uint8)


def checker(img, x, y, size=BLOCK):
    """A size x size "glyph" at (x, y) whose red channel steps by 60 a pixel across it and whose green steps by 60 a
    pixel down it: moved by 1 to 3 whole pixels any way, every pixel of it differs by more than 32 from the one under
    it, so a misplaced glyph leaves a solid residual after V1's 3 x 3 erosion, as a misplaced glyph of text does."""
    ys, xs = np.mgrid[0:size, 0:size]
    img[y:y + size, x:x + size, 0] = (60 * xs) % 256
    img[y:y + size, x:x + size, 1] = (60 * ys) % 256
    img[y:y + size, x:x + size, 2] = 0


def line(offsets, x0=20, y=20, dy=0, img=None):
    """A line of glyphs, glyph i moved offsets[i] px along it and the whole line dy px down."""
    img = white() if img is None else img
    for i, off in enumerate(offsets):
        checker(img, x0 + i * (BLOCK + GAP) + off, y + dy)
    return img


def region_of(n, x0=20, y=20):
    """The pixel region of a line of n glyphs, as pixel_regions gives it: the glyph boxes and V1_LINE_PAD."""
    return metrics.pixel_regions([(x0, y, x0 + n * (BLOCK + GAP) - GAP, y + BLOCK)], 1, (H, W))


N = 8


@pytest.mark.parametrize("dx,dy", [(1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (-1, 1)])
def test_a_whole_line_shifted_1_px_passes(dx, dy):
    gt = line([0] * N)
    out = line([dx] * N, dy=dy)
    v1 = metrics.v1(gt, out, region_of(N))
    assert v1["residual3"] > metrics.V1_MAX_RESIDUAL and v1["passRaw"] is False  # raw V1 fails it
    assert v1["residual3Lines"] == 0 and v1["pass"] is True
    assert v1["lines"] == 1 and v1["shiftedLines"] == 1


@pytest.mark.parametrize("dx,dy", [(2, 0), (0, 2), (-2, 0), (2, 2)])
def test_a_whole_line_shifted_2_px_fails(dx, dy):
    gt = line([0] * N)
    out = line([dx] * N, dy=dy)
    v1 = metrics.v1(gt, out, region_of(N))
    assert v1["residual3Lines"] > metrics.V1_MAX_RESIDUAL and v1["pass"] is False


def test_a_line_whose_glyphs_drift_apart_still_fails():
    # glyph i moved round(3 i / (N - 1)) px: the first in place, the last 3 px off; no one shift fits them all
    drift = [round(3 * i / (N - 1)) for i in range(N)]
    assert drift[0] == 0 and drift[-1] == 3
    v1 = metrics.v1(line([0] * N), line(drift), region_of(N))
    assert v1["residual3Lines"] > metrics.V1_MAX_RESIDUAL and v1["pass"] is False


def test_only_the_lines_move_not_the_rest_of_the_slide():
    # a shape outside every line region, 1 px off, stays a difference: only text lines may move
    gt, out = line([0] * N), line([0] * N)
    checker(gt, 40, 42, 14)
    checker(out, 41, 42, 14)
    v1 = metrics.v1(gt, out, region_of(N))
    assert v1["residual3Lines"] == v1["residual3"] > metrics.V1_MAX_RESIDUAL


def test_without_lines_v1_is_the_raw_v1():
    gt, out = line([0] * N), line([1] * N)
    v1 = metrics.v1(gt, out)
    assert v1["residual3Lines"] == v1["residual3"] and v1["pass"] == v1["passRaw"] is False and v1["lines"] == 0


@pytest.mark.parametrize("seed", range(25))
def test_per_line_is_never_more_than_raw(seed):
    rng = np.random.default_rng(seed)
    h, w = 40, 64
    gt = white(h, w)
    out = white(h, w)
    for img in (gt, out):
        for _ in range(int(rng.integers(1, 6))):
            x, y = int(rng.integers(0, w - 8)), int(rng.integers(0, h - 8))
            size = int(rng.integers(3, 9))
            img[y:y + size, x:x + size] = rng.integers(0, 256, size=(size, size, 3), dtype=np.uint8)
    regions = []
    for _ in range(int(rng.integers(0, 5))):
        x0, y0 = int(rng.integers(0, w - 4)), int(rng.integers(0, h - 4))
        regions.append((x0, y0, int(rng.integers(x0 + 1, w + 1)), int(rng.integers(y0 + 1, h + 1))))
    v1 = metrics.v1(gt, out, regions)
    assert v1["residual3Lines"] <= v1["residual3"]
    total, shifts = metrics.line_residual(gt, out, regions)
    assert total == v1["residual3Lines"] and len(shifts) == len(regions)
    assert all(abs(dx) <= 1 and abs(dy) <= 1 for dx, dy in shifts)


# ---- a pixel two line regions share is judged once ----------------------------------------------------------------


def test_a_pixel_in_two_regions_belongs_to_the_one_it_lies_deepest_in():
    owner = metrics.line_owners((20, 20), [(0, 0, 10, 10), (5, 0, 20, 10)])
    # columns 5..9 lie in both: column 5 and 6 are nearer the first's centre (4.5), 8 and 9 the second's (12)
    assert owner[3, 5] == 0 and owner[3, 9] == 1
    assert (owner[10:] == -1).all()  # no region
    # a tie goes to the earlier region
    tie = metrics.line_owners((10, 10), [(0, 0, 10, 10), (0, 0, 10, 10)])
    assert (tie == 0).all()


def test_a_shared_pixel_is_not_forgiven_by_the_other_lines_shift():
    """Two line regions overlap. The first (rows 10..40) is drawn in place; the second (rows 30..60) is drawn 1 px lower
    in the render. A glyph in the shared rows 31..35, deeper in the first region, moved with the second: judged under
    the first line's shift (none), it stays a difference. Were each region judged on every pixel it covers, the second
    line's shift would forgive it."""
    h, w = 64, 64
    gt, out = white(h, w), white(h, w)
    checker(gt, 10, 14, 8)  # the first line's own glyph, in place in both
    checker(out, 10, 14, 8)
    checker(gt, 10, 48, 8)  # the second line's glyph, 1 px lower in the render
    checker(out, 10, 49, 8)
    checker(gt, 30, 31, 5)  # the shared glyph, moved with the second line
    checker(out, 30, 32, 5)
    first, second = (5, 10, 60, 41), (5, 30, 60, 61)
    total, shifts = metrics.line_residual(gt, out, [first, second])
    assert shifts == [(0, 0), (0, 1)]
    assert total > 0  # the shared glyph is counted once, under the first line's shift
    # the second region alone takes its pixels and forgives it
    alone, _ = metrics.line_residual(gt, out, [second])
    assert alone == 0
    assert total <= metrics.eroded_residual(metrics.diff_mask(gt, out), 3)


def test_pixel_regions_scale_pad_and_cut_to_the_image():
    regions = metrics.pixel_regions([(10, 10, 20.2, 15), (-5, -5, 1, 1), (500, 0, 600, 10), (3, 3, 3, 3)], 2, (40, 60))
    assert regions == [(18, 18, 43, 32), (0, 0, 4, 4), (4, 4, 8, 8)]


# ---- the lines come from the input PDF ----------------------------------------------------------------------------


def test_text_line_boxes_are_the_visible_lines_of_the_pdf(tmp_path):
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((20, 50), "visible line", fontsize=20)
    page.insert_text((20, 100), "invisible", fontsize=20, render_mode=3)
    page.insert_text((20, 150), "transparent", fontsize=20, fill_opacity=0)
    page.insert_text((20, 180), "   ", fontsize=20)
    pdf = tmp_path / "lines.pdf"
    doc.save(str(pdf))
    boxes = pdf_facts.text_line_boxes(pdf, 0)
    assert len(boxes) == 1
    x0, y0, x1, y1 = boxes[0]
    assert 19 <= x0 <= 21 and y0 < 50 < y1 and x1 > 100
    assert run.line_boxes(pdf, 0) == boxes


def test_an_unreadable_pdf_gives_no_lines_and_names_no_path(tmp_path):
    broken = tmp_path / "Private-Deck.pdf"
    broken.write_bytes(b"not a pdf")
    with pytest.raises(pdf_facts.FactsError) as error:
        pdf_facts.text_line_boxes(broken, 0)
    assert "Private-Deck" not in str(error.value) and str(tmp_path) not in str(error.value)
    assert run.line_boxes(broken, 0) == []  # V1 is then judged raw


# ---- M5 Task 1, ruling M5-R1: V1 judged by V2 where the slide's own noise record is over 400 px ----------------------


def noise(residual5, shift1=0.001):
    return {"raw_px32": 0.01, "px32_shift1": shift1, "residual5": residual5, "pass": True,
            "limits": {"basis": "absolute", "residual5": 400, "px32_shift1": 0.01}}


RAW = {"raw_px32": 0.1, "px32_shift1": 0.02, "residual3": 900, "residual3Lines": 800, "pass": False}


def test_512_px_of_noise_is_exempt_and_400_and_20_px_are_not():
    assert run.judge_v1(RAW, {"pass": True}, noise(512))["noiseExempt"] is True
    assert run.judge_v1(RAW, {"pass": True}, noise(401))["noiseExempt"] is True
    assert run.judge_v1(RAW, {"pass": True}, noise(400))["noiseExempt"] is False  # over 400, not at it
    assert run.judge_v1(RAW, {"pass": True}, noise(20))["noiseExempt"] is False


def test_a_high_px32_shift1_alone_does_not_exempt():
    assert run.judge_v1(RAW, {"pass": True}, noise(24, shift1=0.2))["noiseExempt"] is False


def test_an_exempt_slide_takes_its_v2_verdict_and_keeps_raw_v1():
    kept = run.judge_v1(RAW, {"pass": True}, noise(512))
    assert kept["pass"] is True and kept["passMeasured"] is False and kept["noiseFloor"] == 512
    assert kept["residual3Lines"] == 800 and kept["px32_shift1"] == 0.02
    assert run.judge_v1(RAW, {"pass": False}, noise(512))["pass"] is False
    own = run.judge_v1(RAW, {"pass": True}, noise(20))
    assert own["pass"] is False and own["noiseFloor"] == 20 and "passMeasured" not in own


def test_no_noise_record_or_an_error_record_leaves_v1_alone():
    assert run.judge_v1(RAW, {"pass": True}, None) == RAW
    assert run.judge_v1(RAW, {"pass": True}, {"pass": False, "error": "no render"}) == RAW
    assert run.judge_v1(None, {"pass": True}, noise(512)) is None
