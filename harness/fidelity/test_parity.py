"""Tests for `python -m harness.fidelity.parity` (M3 Task 12): the probe-parity verdict on synthetic results JSON.

The results are hand-made deckback.fidelity/1 records; the PPTX files are python-pptx decks with the shapes counted and
the PDFs test_structural.py's PyMuPDF pages (a gradient there is an axial shading through a clip rectangle, as
PowerPoint exports a gradient fill). No PowerPoint is needed.
"""

import io
import json

import pytest
from pptx import Presentation
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.util import Emu

from harness.fidelity import parity
from harness.fidelity.test_structural import (GRAD_BOX, SLIDE_H, SLIDE_W, TILED_BLIP, _replace_fill, build_pdf, gradient,
                                             image, png_bytes)

EMU = 12700
SECRET = "Quarterly-Plan"  # a private file name that must never reach stdout or stderr


# ---- synthetic decks --------------------------------------------------------------------------------------------


def _box(x0, y0, x1, y1):
    return Emu(round(x0 * EMU)), Emu(round(y0 * EMU)), Emu(round((x1 - x0) * EMU)), Emu(round((y1 - y0) * EMU))


def build_deck(path, slides=1, counts=None, gradients=((GRAD_BOX, "rect"),), full_page_picture=False, on_slide=0,
               picture_box=None, tiled_box=None):
    """A deck of `slides` slides; slide `on_slide` holds `counts` of each kind (default: exactly the parity minimums)
    and the gradient shapes `gradients` ((box in pt, "rect" | "custGeom"), ...), each also a rect or a freeform."""
    counts = dict(parity.MIN_COUNTS if counts is None else counts)
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(SLIDE_W), Emu(SLIDE_H)
    for number in range(slides):
        shapes = prs.slides.add_slide(prs.slide_layouts[6]).shapes
        if number != on_slide:
            continue
        for box, kind in gradients:
            if kind in ("rect", "no geometry"):
                shape = shapes.add_shape(MSO_SHAPE.RECTANGLE, *_box(*box))
                counts["rect"] -= 1
                if kind == "no geometry":  # a shape S3 still boxes by its frame, but no rect preset (ledger L198)
                    sp_pr = shape._element.spPr
                    sp_pr.remove(sp_pr.find(qn("a:prstGeom")))
            else:
                x0, y0, x1, y1 = box
                builder = shapes.build_freeform(Emu(round(x0 * EMU)), Emu(round(y0 * EMU)), scale=1.0)
                builder.add_line_segments([(round(x1 * EMU), round(y0 * EMU)), (round(x1 * EMU), round(y1 * EMU)),
                                           (round(x0 * EMU), round(y1 * EMU))], close=True)
                shape = builder.convert_to_shape()
                counts["freeform"] -= 1
            shape.fill.gradient()
        for i in range(max(counts["textbox"], 0)):
            shapes.add_textbox(*_box(10, 10 + i, 60, 11 + i)).text_frame.text = "t"
        # explicit solid fills: python-pptx's shape style would take its fill from the theme
        for i in range(max(counts["rect"], 0)):
            shapes.add_shape(MSO_SHAPE.RECTANGLE, *_box(400, 10 + i * 2, 410, 11 + i * 2)).fill.solid()
        for i in range(max(counts["freeform"], 0)):
            builder = shapes.build_freeform(Emu(500 * EMU), Emu((10 + i * 5) * EMU), scale=1.0)
            builder.add_line_segments([(510 * EMU, (10 + i * 5) * EMU), (505 * EMU, (14 + i * 5) * EMU)], close=True)
            builder.convert_to_shape().fill.solid()
        for i in range(max(counts["line"], 0)):
            shapes.add_connector(MSO_CONNECTOR.STRAIGHT, *_box(600, 10 + i * 3, 700, 10 + i * 3)[:2],
                                 Emu(700 * EMU), Emu((10 + i * 3) * EMU))
        for i in range(max(counts["picture"], 0)):
            shapes.add_picture(io.BytesIO(png_bytes()), *_box(800, 10 + i * 20, 820, 25 + i * 20))
        if full_page_picture:
            shapes.add_picture(io.BytesIO(png_bytes(32, 18)), 0, 0, Emu(SLIDE_W), Emu(SLIDE_H))
        if picture_box is not None:  # one more picture, at this box (pt)
            shapes.add_picture(io.BytesIO(png_bytes(32, 18)), *_box(*picture_box))
        if tiled_box is not None:  # a rect filled with a tiled picture (a pattern to S1), at this box (pt)
            tiled = shapes.add_shape(MSO_SHAPE.RECTANGLE, *_box(*tiled_box))
            _replace_fill(tiled._element.spPr, TILED_BLIP)
    prs.save(str(path))
    return path


def build_input(path, slides=1, shadings=(GRAD_BOX,), on_page=0, images=()):
    """A PDF of `slides` pages; page `on_page` paints one shading per box of `shadings` and one bitmap per box of
    `images`."""
    scenes = [[gradient(box) for box in shadings] + [image(box) for box in images] if number == on_page else []
              for number in range(slides)]
    return build_pdf(path, None, scenes=scenes)


def v1(raw_percent, eroded):
    return {"raw_px32": raw_percent / 100, "px32_shift1": 0.0, "residual3": eroded, "pass": True}


def record(deck_id="probe", variant="std", v1s=((0.2, 3),), public=True):
    """A results record with one slide per (V1 raw %, V1 eroded px) of `v1s` (None: no V1)."""
    slides = [{"index": i, "label": None, "v1": None if v is None else v1(*v), "v2": None, "noise": None, "s": {},
               "known": [], "pass": False, "heatmaps": {}} for i, v in enumerate(v1s)]
    return {"id": deck_id, "public": public, "set": "public" if public else "private", "variant": variant,
            "pages": len(slides), "slides": slides}


def results_file(path, *records):
    path.write_text(json.dumps({"schema": "deckback.fidelity/1", "decks": list(records)}), encoding="utf-8")
    return path


def verdict(tmp_path, rec=None, images=(), **deck):
    slides = len((rec or record())["slides"])
    pptx = build_deck(tmp_path / "out.pptx", slides=slides, **deck)
    pdf = build_input(tmp_path / "in.pdf", slides=slides, images=images)
    return parity.verdict(rec or record(), pptx, pdf)


# ---- the verdict ------------------------------------------------------------------------------------------------


def test_every_criterion_holds_passes(tmp_path):
    result = verdict(tmp_path, record(v1s=((0.20, 3), (0.32, 25), (0.26, 0))))
    assert result["pass"] is True, result["reasons"]
    assert result["reasons"] == []
    assert result["meanV1Raw"] == pytest.approx(0.26)
    assert result["slides"] == [{"n": 1, "v1Eroded": 3, "v1Raw": 0.2}, {"n": 2, "v1Eroded": 25, "v1Raw": 0.32},
                                {"n": 3, "v1Eroded": 0, "v1Raw": 0.26}]
    assert result["counts"] == parity.MIN_COUNTS
    assert result["fullPagePictures"] == 0
    assert result["gradientShapes"] == 1
    assert set(result) == {"meanV1Raw", "slides", "counts", "fullPagePictures", "gradientShapes", "pass", "reasons"}


def test_mean_v1_raw_above_026_percent_fails(tmp_path):
    result = verdict(tmp_path, record(v1s=((0.26, 3), (0.27, 3))))
    assert result["pass"] is False
    assert result["meanV1Raw"] == pytest.approx(0.265)
    assert result["reasons"] == ["mean V1 raw px32 above 0.26 %"]


def test_a_slide_with_v1_eroded_above_25_fails_and_is_named(tmp_path):
    result = verdict(tmp_path, record(v1s=((0.1, 25), (0.1, 26))))
    assert result["pass"] is False
    assert result["reasons"] == ["slide 2: V1 eroded above 25 px"]


def test_a_slide_without_v1_fails(tmp_path):
    rec = record(v1s=((0.1, 3), None))
    error = record(v1s=((0.1, 3), (0.1, 3)))
    error["slides"][1]["v1"] = {"pass": False, "error": "no ground truth"}
    for case in (rec, error):
        result = verdict(tmp_path, case)
        assert result["pass"] is False
        assert result["meanV1Raw"] is None
        assert result["slides"][1] == {"n": 2, "v1Eroded": None, "v1Raw": None}
        assert result["reasons"] == ["slide 2: no V1"]


@pytest.mark.parametrize("kind", sorted(parity.MIN_COUNTS))
def test_each_count_below_its_minimum_fails(tmp_path, kind):
    counts = dict(parity.MIN_COUNTS)
    counts[kind] -= 1
    result = verdict(tmp_path, counts=counts)
    assert result["counts"][kind] == parity.MIN_COUNTS[kind] - 1
    assert result["pass"] is False
    assert result["reasons"] == [f"{kind} count below {parity.MIN_COUNTS[kind]}"]


def test_counts_are_for_the_whole_deck(tmp_path):
    """The minimums are for the deck, as the experimental converter's counts were: every slide adds to them."""
    pptx = tmp_path / "out.pptx"
    prs = Presentation(str(build_deck(pptx, slides=2)))
    shapes = prs.slides[1].shapes
    shapes.add_textbox(*_box(10, 10, 20, 20))
    prs.save(str(pptx))
    counts = parity.shape_counts(pptx)
    assert counts == {**parity.MIN_COUNTS, "textbox": parity.MIN_COUNTS["textbox"] + 1}


def test_a_full_page_picture_fails(tmp_path):
    result = verdict(tmp_path, full_page_picture=True)
    assert result["fullPagePictures"] == 1
    assert result["counts"]["picture"] == parity.MIN_COUNTS["picture"] + 1
    assert result["pass"] is False
    assert result["reasons"] == ["full-page pictures"]


# 75 % of the 960 x 540 pt slide, as a 4:3 box: the PDF bitmap (png_bytes' 12 x 9 px) fills it exactly
BIG = (0, 0, 720, 540)


def test_a_picture_over_half_the_slide_without_a_pdf_bitmap_that_large_is_full_page(tmp_path):
    """Ruling M3-R54: S1's own rule, a picture covering 50 % of the slide or more that no PDF image paint contains."""
    result = verdict(tmp_path, picture_box=BIG)
    assert result["fullPagePictures"] == 1 and result["reasons"] == ["full-page pictures"]
    # a PDF bitmap smaller than the picture justifies nothing
    small = verdict(tmp_path, picture_box=BIG, images=((0, 0, 360, 270),))
    assert small["fullPagePictures"] == 1


def test_a_picture_over_half_the_slide_a_pdf_bitmap_that_large_justifies_is_not_full_page(tmp_path):
    result = verdict(tmp_path, picture_box=BIG, images=(BIG,))
    assert result["fullPagePictures"] == 0 and result["pass"] is True, result["reasons"]


def test_a_tiled_picture_fill_is_a_pattern_as_in_s1_not_a_picture(tmp_path):
    """Ruling M3-R54: parity takes exactly S1's pictures; S1 has a tiled picture fill as a pattern (S3's)."""
    result = verdict(tmp_path, tiled_box=(0, 0, 960, 540))
    assert result["fullPagePictures"] == 0 and result["pass"] is True, result["reasons"]


def test_a_picture_under_half_the_slide_is_never_full_page(tmp_path):
    assert verdict(tmp_path, picture_box=(0, 0, 960, 259))["fullPagePictures"] == 0  # 48 %


def test_parity_uses_s1s_own_predicate(monkeypatch, tmp_path):
    """No second threshold: parity counts what structural.oversized_picture says."""
    from harness.fidelity import structural

    calls = []
    real = structural.oversized_picture

    def spy(*args):
        calls.append(args)
        return real(*args)

    monkeypatch.setattr(structural, "oversized_picture", spy)
    assert verdict(tmp_path, picture_box=BIG)["fullPagePictures"] == 1
    assert calls
    assert not hasattr(parity, "FULL_PAGE")


def test_gradient_as_custgeom_passes_too(tmp_path):
    """Ruling M3-R24: one editable shape with a gradFill, a rect preset or a custGeom."""
    result = verdict(tmp_path, gradients=((GRAD_BOX, "custGeom"),))
    assert result["gradientShapes"] == 1
    assert result["pass"] is True, result["reasons"]


def test_gradient_as_slivers_or_a_picture_fails(tmp_path):
    """No gradFill where the PDF has its gradient: slivers of solid fills or a picture would look like this."""
    result = verdict(tmp_path, gradients=())
    assert result["gradientShapes"] == 0
    assert result["pass"] is False
    assert result["reasons"] == ["slide 1: 0 shapes with gradFill for 1 PDF gradient"]


def test_two_gradient_shapes_for_one_gradient_fail(tmp_path):
    x0, y0, x1, y1 = GRAD_BOX
    halves = (((x0, y0, (x0 + x1) / 2, y1), "rect"), (((x0 + x1) / 2, y0, x1, y1), "rect"))
    result = verdict(tmp_path, gradients=halves)
    assert result["gradientShapes"] == 2
    assert result["reasons"] == ["slide 1: 2 shapes with gradFill for 1 PDF gradient"]


def test_a_gradient_shape_without_a_rect_preset_or_custgeom_fails(tmp_path):
    """Ledger L198: only the rect preset counts besides custGeom; a shape with no geometry (which S3 boxes by its
    frame, as it does a rect) does not."""
    result = verdict(tmp_path, gradients=((GRAD_BOX, "no geometry"),))
    assert result["gradientShapes"] == 1
    assert "slide 1: gradFill shape is not a rect or custGeom" in result["reasons"]
    assert result["pass"] is False


def test_a_gradient_shape_on_another_slide_fails(tmp_path):
    pptx = build_deck(tmp_path / "out.pptx", slides=2, on_slide=1)
    pdf = build_input(tmp_path / "in.pdf", slides=2, on_page=0)
    result = parity.verdict(record(v1s=((0.1, 1), (0.1, 1))), pptx, pdf)
    assert result["gradientShapes"] == 1
    assert result["reasons"] == ["slide 1: 0 shapes with gradFill for 1 PDF gradient",
                                 "slide 2: 1 shapes with gradFill for 0 PDF gradient"]


def test_a_gradient_shape_that_does_not_cover_the_gradient_fails(tmp_path):
    x0, y0, x1, y1 = GRAD_BOX
    short = ((x0, y0, x1 - 20, y1), "rect")
    result = verdict(tmp_path, gradients=(short,))
    assert result["reasons"] == ["slide 1: gradFill shape does not cover the PDF gradient"]
    near = ((x0 + 0.5, y0 - 0.5, x1 - 0.5, y1 + 0.5), "rect")  # within COVER_TOL
    assert verdict(tmp_path, gradients=(near,))["pass"] is True


# ---- the command ------------------------------------------------------------------------------------------------


def run_main(argv, capsys, root=None):
    code = parity.main(argv, root=root) if root is not None else parity.main(argv)
    out, err = capsys.readouterr()
    return code, out, err


def test_main_prints_the_verdict_as_json_and_exits_0_on_pass(tmp_path, capsys):
    pptx = build_deck(tmp_path / "out.pptx")
    pdf = build_input(tmp_path / "in.pdf")
    results = results_file(tmp_path / "results.json", record(), record(variant="notags", v1s=((9.0, 900),)))
    code, out, err = run_main(["--results", str(results), "--deck", "probe_std", "--pptx", str(pptx),
                               "--pdf", str(pdf)], capsys)
    assert code == 0, err
    printed = json.loads(out)
    assert printed["deck"] == "probe_std"
    assert printed["pass"] is True
    code, out, _ = run_main(["--results", str(results), "--deck", "probe_notags", "--pptx", str(pptx),
                             "--pdf", str(pdf)], capsys)
    assert code == 1
    assert json.loads(out)["reasons"] == ["mean V1 raw px32 above 0.26 %", "slide 1: V1 eroded above 25 px"]


def test_main_needs_the_variant_when_a_name_has_several(tmp_path, capsys):
    pptx = build_deck(tmp_path / "out.pptx")
    pdf = build_input(tmp_path / "in.pdf")
    results = results_file(tmp_path / "results.json", record(), record(variant="notags"))
    code, _, err = run_main(["--results", str(results), "--deck", "probe", "--pptx", str(pptx), "--pdf", str(pdf)],
                            capsys)
    assert code == 3
    assert "probe" in err and "variant" in err
    code, _, err = run_main(["--results", str(results), "--deck", "nothing", "--pptx", str(pptx), "--pdf", str(pdf)],
                            capsys)
    assert code == 3
    assert "not in the results" in err


def test_a_private_deck_is_found_by_its_id_and_printed_by_it_only(tmp_path, capsys):
    """The private probe: the PDF is found under corpus/private by its id; stdout and stderr name the id only."""
    root = tmp_path / "repo"
    pdf = build_input(tmp_path / "staging.pdf")
    private = root / "corpus" / "private" / "clientDir"
    private.mkdir(parents=True)
    target = private / f"{SECRET}.pdf"
    target.write_bytes(pdf.read_bytes())
    from harness.fidelity.decks import private_id

    deck_id = private_id(target)
    pptx = build_deck(private / f"{SECRET}-out.pptx")
    results = results_file(tmp_path / "results.json", record(deck_id=deck_id, variant="pdf", public=False))
    code, out, err = run_main(["--results", str(results), "--deck", deck_id, "--pptx", str(pptx)], capsys, root=root)
    assert code == 0, err
    assert json.loads(out)["deck"] == deck_id
    for text in (out, err):
        assert SECRET not in text and "clientDir" not in text and str(tmp_path) not in text
        assert tmp_path.as_posix() not in text


def test_an_unreadable_pptx_is_exit_3_without_its_path(tmp_path, capsys):
    pdf = build_input(tmp_path / "in.pdf")
    bad = tmp_path / f"{SECRET}.pptx"
    bad.write_bytes(b"not a zip")
    results = results_file(tmp_path / "results.json", record())
    code, out, err = run_main(["--results", str(results), "--deck", "probe_std", "--pptx", str(bad), "--pdf",
                               str(pdf)], capsys)
    assert code == 3
    assert out == ""
    assert SECRET not in err and str(tmp_path) not in err
