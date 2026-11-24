"""Ruling M3-R49 in the harness: splits.py decides which PDF paths the writer splits into pieces, as the writer's
``splitPieces`` (packages/core/src/passes/lower/shape.ts) does, and S3 (structural.py) and S7 (roundtrip.py) count
one paint per piece on the PDF's side."""

import json
from pathlib import Path

import pymupdf
import pytest

from harness.fidelity import pdf_facts, pptx_facts, roundtrip, splits, structural
from harness.fidelity.test_structural import EMU, H_PT, W_PT, _deck, _sp, _xml

M, L, Z = "M", "L", "Z"


def rect(x, y, w, h):
    return [[M, x, y], [L, x + w, y], [L, x + w, y + h], [L, x, y + h], [Z]]


def seg(x0, y0, x1, y1):
    return [[M, x0, y0], [L, x1, y1]]


GRID = seg(10, 20, 200, 20) + seg(200, 60, 10, 60) + seg(50, 150, 50, 100)
BARS = rect(10, 100, 20, 80) + rect(40, 60, 20, 120) + rect(70, 140, 20, 40)


# ---- pieces ---------------------------------------------------------------------------------------------------------


def test_stroke_only_single_segments_are_one_piece_each():
    assert splits.pieces(GRID, filled=False, stroked=True) == [[10, 20, 200, 20], [10, 60, 200, 60], [50, 100, 50, 150]]


def test_lone_moves_are_left_out_and_one_piece_is_none():
    assert splits.pieces(seg(10, 20, 200, 20) + [[M, 5, 5]] + seg(0, 0, 9, 9), False, True) == [[10, 20, 200, 20],
                                                                                              [0, 0, 9, 9]]
    assert splits.pieces(seg(10, 20, 200, 20) + [[M, 5, 5]], False, True) is None


@pytest.mark.parametrize("path", [
    seg(10, 20, 200, 20) + [[L, 200, 40]] + seg(0, 0, 9, 9),  # a polyline subpath
    seg(10, 20, 200, 20) + [[Z]] + seg(0, 0, 9, 9),  # a closed segment
    GRID + seg(90, 90, 90, 90),  # a zero-length subpath
    GRID[:2] + [[M, 0, 0], ["C", 1, 1, 2, 2, 3, 3]],  # a curve
])
def test_stroke_only_paths_that_stay_whole(path):
    assert splits.pieces(path, False, True) is None


def test_a_filled_path_of_segments_is_not_split():
    assert splits.pieces(GRID, filled=True, stroked=True) is None


def test_disjoint_rectangles_are_one_piece_each():
    boxes = [[10, 100, 30, 180], [40, 60, 60, 180], [70, 140, 90, 180]]
    assert splits.pieces(BARS, filled=True, stroked=False) == boxes
    assert splits.pieces(BARS, filled=True, stroked=True, width=1) == boxes
    # rectangles that share an edge do not overlap, when only filled
    assert splits.pieces(rect(10, 10, 20, 20) + rect(30, 10, 20, 20), True, False) == [[10, 10, 30, 30], [30, 10, 50, 30]]
    # a fill closes by itself
    assert splits.pieces([s for s in BARS if s[0] != Z], True, False) == boxes


@pytest.mark.parametrize("path, stroked, width, dashed", [
    (rect(60, 20, 100, 100) + rect(110, 70, 100, 100), False, None, False),  # overlapping
    (rect(20, 20, 150, 150) + rect(45, 45, 100, 100), False, None, False),  # nested
    (rect(10, 10, 20, 20) + [[M, 100, 20], [L, 150, 20], [L, 125, 60], [Z]], False, None, False),  # a triangle
    (rect(10, 10, 20, 20) + rect(31, 10, 20, 20), True, 2, False),  # 1 pt apart: 2 pt strokes would meet
    (rect(10, 10, 20, 20) + rect(30.5, 10, 20, 20), True, 0, False),  # a hairline is 0.75 pt wide
    (rect(10, 10, 20, 20) + rect(60, 10, 20, 20), True, 1, True),  # dash start: top left, going right
    ([[M, 10, 10], [L, 30, 10], [L, 30, 30], [L, 10, 30], [L, 10, 10]] + rect(60, 10, 20, 20), True, 1, False),  # open
])
def test_rectangles_that_stay_whole(path, stroked, width, dashed):
    assert splits.pieces(path, True, stroked, width, dashed) is None


def from_bottom_left(x, y, w, h):
    return [[M, x, y + h], [L, x, y], [L, x + w, y], [L, x + w, y + h], [Z]]


def test_a_dashed_outline_from_the_bottom_left_going_up_is_split():
    # M5 Task 4: PowerPoint draws the rect preset's dashes as an open path's from its bottom left corner, going up
    bars = from_bottom_left(10, 100, 20, 80) + from_bottom_left(40, 60, 20, 120) + from_bottom_left(70, 140, 20, 40)
    assert splits.pieces(bars, True, True, 1, dashed=True) is not None
    assert splits.pieces(BARS, True, True, 1, dashed=True) is None


# ---- split_paints: a fill and its stroke decided together -----------------------------------------------------------


def paint(kind, path, alpha=1.0, w=1.0, dash=()):
    out = {"kind": kind, "bbox": [0, 0, 0, 0], "alpha": alpha, "path": path}
    if kind == "stroke":
        out["line"] = {"w": w, "dash": list(dash)}
    return out


def test_split_paints_decides_a_fill_and_its_stroke_together():
    out = splits.split_paints([paint("fill", BARS), paint("stroke", BARS)])
    assert [len(p["pieces"]) for p in out] == [3, 3]
    # the same stroke alone is a stroke-only path of rectangles: whole
    assert splits.split_paints([paint("stroke", BARS)])[0]["pieces"] is None
    # strokes 30 pt wide meet: neither is split
    assert [p["pieces"] for p in splits.split_paints([paint("fill", BARS), paint("stroke", BARS, w=30)])] == [None, None]
    # a fill of alpha 0 is no fill (M3-R45): the gridlines' stroke after it is stroke-only
    out = splits.split_paints([paint("fill", GRID, alpha=0), paint("stroke", GRID)])
    assert out[0]["pieces"] is None and len(out[1]["pieces"]) == 3
    # other kinds, and paints without a path, stay whole
    assert splits.split_paints([{"kind": "shade", "bbox": [0, 0, 1, 1], "alpha": 1}])[0]["pieces"] is None
    assert splits.split_paints([{"kind": "stroke", "bbox": [0, 0, 1, 1], "alpha": 1}])[0]["pieces"] is None


# ---- S3 and S7 on a PDF ---------------------------------------------------------------------------------------------


def chart_pdf(path):
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    shape = page.new_shape()
    for i in range(0, len(GRID), 2):
        shape.draw_line(GRID[i][1:], GRID[i + 1][1:])
    shape.finish(color=(0, 0, 0), width=1, closePath=False)
    for x, y, w, h in ((10, 100, 20, 80), (40, 60, 20, 120), (70, 140, 20, 40)):
        shape.draw_rect(pymupdf.Rect(x, y, x + w, y + h))
    shape.finish(color=None, fill=(1, 0, 0), width=0)
    shape.commit()
    doc.save(str(path))
    return path


def connector(name, x0, y0, x1, y1, sp_id):
    flips = (' flipH="1"' if x1 < x0 else "") + (' flipV="1"' if y1 < y0 else "")
    return _xml(f'<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="{sp_id}" name="{name}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>'
                f'<p:spPr><a:xfrm{flips}><a:off x="{min(x0, x1) * EMU}" y="{min(y0, y1) * EMU}"/><a:ext '
                f'cx="{abs(x1 - x0) * EMU}" cy="{abs(y1 - y0) * EMU}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/>'
                '</a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>'
                '</p:cxnSp>')


RECT = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
RED = '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>'
NO_LINE = "<a:ln><a:noFill/></a:ln>"


def split_slide(path):
    lines = [connector(f"pdf:p1:z5 line {k + 1}", *GRID[2 * k][1:], *GRID[2 * k + 1][1:], 10 + k) for k in range(3)]
    bars = [_sp(f"pdf:p1:z6 rect {k + 1}", x, y, w, h, RECT, RED, NO_LINE, sp_id=20 + k)
            for k, (x, y, w, h) in enumerate(((10, 100, 20, 80), (40, 60, 20, 120), (70, 140, 20, 40)))]
    return _deck(path, *lines, *bars)


def _count(drawing, scale=1.0):
    args = drawing["split"]
    boxes = None if args is None else splits.pieces(**args, scale=scale)
    return None if boxes is None else len(boxes)


def test_pdf_facts_gives_each_drawing_its_split(tmp_path):
    page = pdf_facts.page_facts(chart_pdf(tmp_path / "chart.pdf"), 0)
    assert [(d["kind"], _count(d)) for d in page.drawings] == [("fill", None), ("stroke", 3), ("fill", 3)]


def test_attach_pieces_splits_nothing_when_the_oracle_does_not_line_up():
    drawings = [{"kind": "stroke", "bbox": [10, 20, 200, 150]}]
    oracle = [{**paint("stroke", GRID), "bbox": [10, 20, 200, 150]}]
    assert pdf_facts.attach_pieces(drawings, oracle) is True and _count(drawings[0]) == 3
    assert pdf_facts.attach_pieces(drawings, oracle + oracle) is False and drawings[0]["split"] is None
    moved = [{**oracle[0], "bbox": [10, 20, 200, 151]}]
    assert pdf_facts.attach_pieces(drawings, moved) is False and drawings[0]["split"] is None


# ---- the shared cases (split_vectors.json; lower-shape.test.ts runs them through the writer) --------------------------

VECTORS = json.loads((Path(__file__).with_name("split_vectors.json")).read_text(encoding="utf-8"))["cases"]


def oracle_paints(case):
    """A case as the oracle lists it (mupdf_inventory paths=True): a solid fill or stroke as a fill or stroke paint, a
    gradient one as a shade under a clip of the path (a stroke's clip for a stroke)."""
    path, ga, out = case["path"], case["groupAlpha"], []
    if case["fill"] == "solid":
        out.append({"kind": "fill", "bbox": [0, 0, 0, 0], "alpha": 1.0, "groupAlpha": ga, "path": path})
    elif case["fill"] == "gradient":
        out.append({"kind": "shade", "bbox": [0, 0, 0, 0], "alpha": 1.0, "groupAlpha": ga, "clipPath": path,
                    "clipStroke": False})
    stroke = case["stroke"]
    if stroke is not None and stroke["paint"] == "solid":
        out.append({"kind": "stroke", "bbox": [0, 0, 0, 0], "alpha": stroke["alpha"], "groupAlpha": ga, "path": path,
                    "line": {"w": stroke["w"], "dash": stroke["dash"]}})
    elif stroke is not None:
        out.append({"kind": "shade", "bbox": [0, 0, 0, 0], "alpha": stroke["alpha"], "groupAlpha": ga,
                    "clipPath": path, "clipStroke": True})
    return out


@pytest.mark.parametrize("case", VECTORS, ids=[c["name"] for c in VECTORS])
def test_shared_split_vectors(case):
    split = splits.split_paints(oracle_paints(case), case["scale"])
    counts = [None if p["pieces"] is None else len(p["pieces"]) for p in split if p["kind"] in ("fill", "stroke")]
    # a case with no solid fill or stroke has nothing to split
    assert all(c == case["pieces"] for c in counts) and (counts or case["pieces"] is None), counts


def test_a_translucent_stroke_splits_only_where_its_segments_do_not_meet():
    """Ruling M3-R56: the PDF composites a stroke's union once; connectors that cross or share an end would composite
    it twice there."""
    cross = seg(10, 50, 200, 50) + seg(100, 10, 100, 150)
    assert len(splits.pieces(cross, False, True, 1, opaque=True)) == 2
    assert splits.pieces(cross, False, True, 1, opaque=False) is None
    # the group alphas count too: alpha 1 under a group of 0.5 is translucent
    paints = [{**paint("stroke", cross), "groupAlpha": 0.5}]
    assert splits.split_paints(paints)[0]["pieces"] is None
    assert len(splits.split_paints([{**paint("stroke", GRID), "groupAlpha": 0.5}])[0]["pieces"]) == 3


def test_the_inventory_keeps_group_alphas_and_clip_paths_with_paths(tmp_path):
    from harness.oracle.mupdf_inventory import inventory

    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_line((10, 20), (200, 20), color=(0, 0, 0), width=1, stroke_opacity=0.5)
    doc.save(str(tmp_path / "a.pdf"))
    [stroke] = [p for p in inventory(str(tmp_path / "a.pdf"), detail=False, paths=True)["pages"][0]["paints"]
                if p["kind"] == "stroke"]
    assert stroke["alpha"] == 0.5 and stroke["groupAlpha"] == 1.0 and stroke["path"]
    plain = inventory(str(tmp_path / "a.pdf"), detail=False)["pages"][0]["paints"]
    assert all("groupAlpha" not in p and "path" not in p for p in plain)


def test_s3_counts_one_drawing_per_piece(tmp_path):
    page = pdf_facts.page_facts(chart_pdf(tmp_path / "chart.pdf"), 0)
    s3 = structural.check(page, pptx_facts.slide_facts(split_slide(tmp_path / "split.pptx"), 0))["S3"]
    assert s3["status"] == "pass", s3
    assert s3["counts"]["split pieces"] == 4 and s3["counts"]["pdf drawings"] == 6
    assert "split pieces 4 (M3-R49)" in s3["detail"]
    # the same chart as one shape per paint is now two paints short of six
    whole = _deck(tmp_path / "whole.pptx", connector("pdf:p1:z5 line", 10, 20, 200, 20, 10),
                  _sp("pdf:p1:z6 rect", 10, 60, 80, 120, RECT, RED, NO_LINE, sp_id=11))
    s3 = structural.check(page, pptx_facts.slide_facts(whole, 0))["S3"]
    assert s3["status"] == "fail" and "count 6 vs 2" in s3["detail"], s3


def test_s7_counts_the_input_one_paint_per_piece(tmp_path):
    from harness.oracle.mupdf_inventory import inventory

    paints = inventory(str(chart_pdf(tmp_path / "chart.pdf")), detail=False, paths=True)["pages"][0]["paints"]
    split = roundtrip.split_input(paints)
    assert [p["kind"] for p in split] == ["fill"] + ["stroke"] * 3 + ["fill"] * 3
    assert [p["bbox"] for p in split[1:4]] == [[10, 20, 200, 20], [10, 60, 200, 60], [50, 100, 50, 150]]
    assert all("pieces" not in p for p in split)


def test_s7_compare_matches_a_round_trip_of_the_pieces(tmp_path):
    """The round trip of the split slide is a PDF that draws each piece as a path of its own."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    for i in range(0, len(GRID), 2):
        page.draw_line(GRID[i][1:], GRID[i + 1][1:], color=(0, 0, 0), width=1)
    for x, y, w, h in ((10, 100, 20, 80), (40, 60, 20, 120), (70, 140, 20, 40)):
        page.draw_rect(pymupdf.Rect(x, y, x + w, y + h), color=None, fill=(1, 0, 0), width=0)
    doc.save(str(tmp_path / "trip.pdf"))
    assert roundtrip.compare(chart_pdf(tmp_path / "chart.pdf"), tmp_path / "trip.pdf") == []
    # ruling M3-R58: the round trip is split by the same rule, so a deck that keeps the chart one path (the source
    # deck, PowerPoint's own export) has the same composition as the input, and so do the pieces the other way round
    assert roundtrip.compare(chart_pdf(tmp_path / "chart.pdf"), chart_pdf(tmp_path / "same.pdf")) == []
    assert roundtrip.compare(tmp_path / "trip.pdf", chart_pdf(tmp_path / "again.pdf")) == []
    # a piece missing on the round trip still shows
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    for i in range(0, len(GRID) - 2, 2):  # the last gridline left out
        page.draw_line(GRID[i][1:], GRID[i + 1][1:], color=(0, 0, 0), width=1)
    for x, y, w, h in ((10, 100, 20, 80), (40, 60, 20, 120), (70, 140, 20, 40)):
        page.draw_rect(pymupdf.Rect(x, y, x + w, y + h), color=None, fill=(1, 0, 0), width=0)
    doc.save(str(tmp_path / "short.pdf"))
    problems = roundtrip.compare(chart_pdf(tmp_path / "chart.pdf"), tmp_path / "short.pdf")
    assert any("stroke 3 vs 2" in p for p in problems), problems


CORPUS_PDFS = sorted((Path(__file__).resolve().parents[2] / "corpus" / "generated").glob("*.pdf"))


def test_the_committed_corpus_has_pdfs_to_compare():
    assert len(CORPUS_PDFS) >= 4


@pytest.mark.parametrize("pdf", CORPUS_PDFS, ids=[p.name for p in CORPUS_PDFS])
def test_s7_compare_finds_no_difference_between_a_committed_pdf_and_itself(pdf):
    """Ruling M3-R58: S7 is reflexive. The source deck's own export (M1-R46: S7's perfect converter) keeps a chart one
    path; a comparison that split only the input side failed it (M3 Task 13, found by the PowerPoint test
    test_s7_probe_round_trip_passes, which CI does not run). This one runs without PowerPoint."""
    assert roundtrip.compare(pdf, pdf) == []


# ---- S7 subtracts paints of alpha 0 on both sides (ruling M3-R53) ---------------------------------------------------


def _page(path, invisible_stroke=False, invisible_fill=False):
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(pymupdf.Rect(100, 100, 220, 160), color=None, fill=(1, 0, 0), width=0)
    if invisible_stroke:  # a border of alpha 0 round a visible fill
        page.draw_rect(pymupdf.Rect(300, 100, 420, 200), color=(0, 0, 0), fill=(0, 0, 1), width=2, stroke_opacity=0)
    else:
        page.draw_rect(pymupdf.Rect(300, 100, 420, 200), color=None, fill=(0, 0, 1), width=0)
    if invisible_fill:
        page.draw_rect(pymupdf.Rect(500, 100, 620, 200), color=None, fill=(0, 1, 0), width=0, fill_opacity=0)
    doc.save(str(path))
    return path


def test_s7_leaves_out_paints_of_alpha_0_on_both_sides(tmp_path):
    visible = _page(tmp_path / "visible.pdf")
    with_nothing = _page(tmp_path / "nothing.pdf", invisible_stroke=True, invisible_fill=True)
    # the writer drops what paints nothing, so PowerPoint's export lacks it: the same composition
    assert roundtrip.compare(with_nothing, visible) == []
    # and the other way round
    assert roundtrip.compare(visible, with_nothing) == []
    # a paint that does paint still counts
    trimmed = tmp_path / "trimmed.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(pymupdf.Rect(100, 100, 220, 160), color=None, fill=(1, 0, 0), width=0)
    doc.save(str(trimmed))
    assert any("fill 2 vs 1" in p for p in roundtrip.compare(visible, trimmed))
