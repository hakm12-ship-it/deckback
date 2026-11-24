"""Tests for the pure parts of the M0-6 gradient spike (stop remapping, stop reduction, deck layout,
text-box exclusion). The PowerPoint rendering itself is exercised by running m0_6_gradient.py."""

import numpy as np
import pytest
from PIL import Image
from pptx import Presentation
from pptx.oxml.ns import qn

from harness.spikes import m0_6_gradient as spike

A_NS = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}


def gradient_stops(shape):
    return [(int(gs.get("pos")), gs[0].get("val")) for gs in shape._element.xpath(".//a:gradFill/a:gsLst/a:gs")]


def gradient_angle(shape):
    return int(shape._element.xpath(".//a:gradFill/a:lin")[0].get("ang"))


# --- CIE76 -----------------------------------------------------------------------------------------

def test_delta_e_of_identical_colours_is_zero():
    assert spike.delta_e76("#1F4E79", "1F4E79") == pytest.approx(0.0)


def test_delta_e_between_black_and_white_is_100():
    assert spike.delta_e76("#000000", "#FFFFFF") == pytest.approx(100.0, abs=0.01)


# --- stop remapping ----------------------------------------------------------------------------------

def test_probe_shading_maps_to_the_second_half_of_the_ramp_pointing_down():
    # The probe: axis (170, 570) -> (170, 330) in shading space, ctm flips y (page height 540):
    # slide frame (170, -30) -> (170, 210); the clip bbox covers y 90..210, i.e. t 0.5..1.
    stops, angle, (tmin, tmax) = spike.remap_stops(
        [(0, "#ffffff"), (0.5, "#0170c0"), (1, "#ffffff")],
        p0=(170, 570), p1=(170, 330), ctm=(1, 0, 0, -1, 0, 540), bbox=(40, 90, 300, 210),
    )
    assert (tmin, tmax) == pytest.approx((0.5, 1.0))
    assert angle == pytest.approx(90.0)
    assert stops == [(pytest.approx(0.0), "#0170C0"), (pytest.approx(1.0), "#FFFFFF")]


def test_interior_stops_are_rescaled_and_edge_colours_interpolated():
    stops, angle, _ = spike.remap_stops(
        [(0, "#000000"), (0.5, "#ff0000"), (1, "#ffffff")],
        p0=(0, 0), p1=(100, 0), ctm=(1, 0, 0, 1, 0, 0), bbox=(25, 0, 75, 10),
    )
    assert angle == pytest.approx(0.0)
    # t = 0.25 is halfway between black and red; t = 0.75 halfway between red and white.
    assert stops == [(pytest.approx(0.0), "#800000"), (pytest.approx(0.5), "#FF0000"), (pytest.approx(1.0), "#FF8080")]


def test_a_gradient_axis_pointing_left_has_angle_180():
    _, angle, _ = spike.remap_stops(
        [(0, "#000000"), (1, "#ffffff")], p0=(100, 0), p1=(0, 0), ctm=(1, 0, 0, 1, 0, 0), bbox=(0, 0, 100, 10),
    )
    assert angle == pytest.approx(180.0)


def test_a_diagonal_axis_projects_the_bbox_corners():
    # Axis along (1, 1) from (0, 0) to (10, 10): corner (0, 0) -> t 0, corner (10, 10) -> t 1.
    stops, angle, (tmin, tmax) = spike.remap_stops(
        [(0, "#000000"), (1, "#ffffff")], p0=(0, 0), p1=(10, 10), ctm=(1, 0, 0, 1, 0, 0), bbox=(0, 0, 10, 10),
    )
    assert angle == pytest.approx(45.0)
    assert (tmin, tmax) == pytest.approx((0.0, 1.0))
    assert [p for p, _ in stops] == pytest.approx([0.0, 1.0])


@pytest.mark.parametrize(
    "p0_slide, p1_slide, angle",
    [
        ((20, 50), (60, 90), 45.0),    # down-right: the extremes are the top-left and bottom-right corners
        ((120, 50), (80, 90), 135.0),  # down-left: the extremes are the top-right and bottom-left corners
    ],
)
def test_the_range_comes_from_all_four_corners_of_a_non_square_bbox_under_a_scaled_flipped_ctm(p0_slide, p1_slide, angle):
    # A 100 x 40 pt bbox, a diagonal axis (length 40 * sqrt 2) and ctm x' = x / 2 + 10, y' = 300 - y / 2.
    # Projecting only one diagonal pair of corners gives the right range for one of the two axes and
    # [0.5, 1.25] (instead of [0, 1.75]) for the other, so each case catches a two-corner shortcut.
    ctm = (0.5, 0, 0, -0.5, 10, 300)
    to_shading = lambda p: (2 * p[0] - 20, 600 - 2 * p[1])  # noqa: E731  the inverse of the ctm
    stops, got_angle, (tmin, tmax) = spike.remap_stops(
        [(0, "#000000"), (0.5, "#ff0000"), (1, "#ffffff")],
        p0=to_shading(p0_slide), p1=to_shading(p1_slide), ctm=ctm, bbox=(20, 50, 120, 90),
    )
    assert got_angle == pytest.approx(angle)
    assert (tmin, tmax) == pytest.approx((0.0, 1.75))
    # t = 0.5 and 1.0 sit at 0.5 / 1.75 and 1 / 1.75 of the range; beyond the last stop (t = 1) white is held.
    assert [p for p, _ in stops] == pytest.approx([0.0, 0.5 / 1.75, 1 / 1.75, 1.0])
    assert [c for _, c in stops] == ["#000000", "#FF0000", "#FFFFFF", "#FFFFFF"]


def test_a_degenerate_axis_is_rejected():
    with pytest.raises(ValueError, match="axis"):
        spike.remap_stops([(0, "#000000"), (1, "#ffffff")], p0=(5, 5), p1=(5, 5), ctm=(1, 0, 0, 1, 0, 0), bbox=(0, 0, 10, 10))


# --- stop reduction ----------------------------------------------------------------------------------

def test_collinear_stops_are_all_dropped_but_the_ends():
    ramp = [(k / 11, "#" + "%02X" % round(255 * k / 11) * 3) for k in range(12)]
    reduced, worst = spike.reduce_stops(ramp)
    assert reduced == [ramp[0], ramp[-1]]
    assert worst <= 1.0


def test_stops_that_cannot_be_dropped_within_delta_e_1_are_forced_down_to_the_limit_and_reported():
    zigzag = [(k / 11, "#C00000" if k % 2 == 0 else "#0070C0") for k in range(12)]
    reduced, worst = spike.reduce_stops(zigzag, max_stops=10)
    assert len(reduced) == 10
    assert reduced[0] == zigzag[0] and reduced[-1] == zigzag[-1]
    assert worst > 1.0


def test_stops_within_the_limit_that_matter_are_kept():
    peak = [(0.0, "#000000"), (0.5, "#FF0000"), (1.0, "#000000")]
    assert spike.reduce_stops(peak)[0] == peak


# --- deck layout -------------------------------------------------------------------------------------

def test_slide_one_is_a_600_by_100_rectangle_with_twelve_alternating_stops(tmp_path):
    probe_stops = [(0.0, "#0170C0"), (1.0, "#FFFFFF")]
    spike.build(tmp_path / "g.pptx", probe_stops, 90.0, (40, 90, 300, 210), None)
    prs = Presentation(str(tmp_path / "g.pptx"))
    assert len(prs.slides) == 2
    shape = prs.slides[0].shapes[-1]
    assert (shape.width, shape.height) == (600 * 12700, 100 * 12700)
    stops = gradient_stops(shape)
    assert [p for p, _ in stops] == [round(k / 11 * 100000) for k in range(12)]
    assert [c for _, c in stops] == ["C00000", "0070C0"] * 6
    assert gradient_angle(shape) == 0
    assert (shape.left, shape.top) == (180 * 12700, 220 * 12700)


def test_gradient_shapes_carry_no_theme_style(tmp_path):
    # python-pptx's autoshape brings a p:style whose effectRef draws a drop shadow under the rectangle;
    # in the first M0-6 render that shadow moved slide 2 to 0.0008, close to the 0.001 limit.
    stops = [(0.0, "#0170C0"), (1.0, "#FFFFFF")]
    spike.build(tmp_path / "g.pptx", stops, 90.0, (40, 90, 300, 210), stops)
    prs = Presentation(str(tmp_path / "g.pptx"))
    assert len(prs.slides) == 3
    for slide in prs.slides:
        shapes = list(slide.shapes)
        assert len(shapes) == 1
        element = shapes[0]._element
        assert element.find(qn("p:style")) is None
        assert element.xpath("./p:spPr/a:ln/a:noFill")
        assert not element.xpath(".//a:effectLst | .//a:effectRef")


def test_slide_two_uses_the_bbox_and_the_angle_and_slide_three_the_reduced_stops(tmp_path):
    probe_stops = [(0.0, "#0170C0"), (0.5, "#80B8E0"), (1.0, "#FFFFFF")]
    reduced = [(0.0, "#0170C0"), (1.0, "#FFFFFF")]
    spike.build(tmp_path / "g.pptx", probe_stops, 90.0, (40, 90, 300, 210), reduced)
    prs = Presentation(str(tmp_path / "g.pptx"))
    assert len(prs.slides) == 3
    full, small = prs.slides[1].shapes[-1], prs.slides[2].shapes[-1]
    for shape in (full, small):
        assert (shape.left, shape.top, shape.width, shape.height) == (40 * 12700, 90 * 12700, 260 * 12700, 120 * 12700)
        assert gradient_angle(shape) == 90 * 60000
    assert len(gradient_stops(full)) == 3
    assert len(gradient_stops(small)) == 2


# --- text exclusion ----------------------------------------------------------------------------------

def test_text_exclusions_are_line_boxes_inside_the_region_scaled_and_dilated():
    glyphs = [
        {"u": "A", "y": 156.9, "bbox": [86.0, 137.0, 98.0, 161.0]},
        {"u": " ", "y": 156.9, "bbox": [98.0, 137.0, 104.0, 161.0]},   # whitespace: not part of the span
        {"u": "B", "y": 156.9, "bbox": [104.0, 137.0, 116.0, 161.0]},
        {"u": "T", "y": 40.0, "bbox": [47.0, 20.0, 77.0, 60.0]},        # outside the region
    ]
    boxes = spike.text_boxes_px(glyphs, region_pt=(40, 90, 300, 210), scale=2.0, dilate_px=2)
    assert boxes == [(170.0, 272.0, 234.0, 324.0)]


# --- the probe evaluation record ---------------------------------------------------------------------

def test_probe_record_carries_the_threshold_the_extremes_and_the_stricter_ratios(tmp_path, monkeypatch):
    # Region (40, 90, 300, 210) pt at 2 px/pt = (80, 180, 600, 420) px: 520 x 240 = 124800 pixels.
    gt = np.full((1080, 1920, 3), 200, dtype=np.uint8)
    got = gt.copy()
    got[200, 300] = (200 + 40, 200, 200)             # one pixel, diff 40: counted at 32, 24, 20 and 16
    got[250:252, 100:600] = (200, 170, 200)          # 2 rows x 500 px, diff 30: counted at 24, 20 and 16
    got[300:303, 100:600] = (200, 200, 222)          # 3 rows x 500 px, diff 22: counted at 20 and 16
    got[310:312, 100:600] = (200, 182, 200)          # 2 rows x 500 px, diff 18: counted at 16 only
    got[205, 205] = (0, 0, 0)                        # diff 200, but inside the text line: excluded
    Image.fromarray(gt, "RGB").save(tmp_path / "gt.png")
    Image.fromarray(got, "RGB").save(tmp_path / "got.png")
    monkeypatch.setattr(spike, "GT_PNG", tmp_path / "gt.png")
    glyphs = [{"u": "A", "y": 105.0, "bbox": [100.0, 100.0, 110.0, 110.0]}]   # px (200, 200)-(220, 220), +2 dilation

    record = spike.evaluate_probe(tmp_path / "got.png", (40, 90, 300, 210), glyphs)

    compared = 520 * 240 - (24 * 24)   # the dilated text box is 24 x 24 px
    assert record["thr"] == 32
    assert record["limit"] == 0.001
    assert record["max_diff"] == 40
    assert record["mean_diff"] == pytest.approx((40 + 1000 * 30 + 1500 * 22 + 1000 * 18) / compared, abs=1e-3)  # rounded to 3 decimals
    assert record["diff_ratio"] == pytest.approx(1 / compared)
    assert record["sensitivity"] == {
        "24": pytest.approx(1001 / compared),
        "20": pytest.approx(2501 / compared),
        "16": pytest.approx(3501 / compared),
    }
    assert record["pass"] is True                       # 1 / 124224 = 8.0e-06 <= 0.001
    assert "thr 32" in record["verdict"] and "max diff 40" in record["verdict"]
