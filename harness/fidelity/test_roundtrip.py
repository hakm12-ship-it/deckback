"""S7's two causes (ruling M3-R55; M4 Task 4), on round trips PowerPoint recorded.

(a) The writer splits a nonzero fill into several ``a:path``s (0001 M0-5, passes/fillrule.ts), and PowerPoint exports
one fill per ``a:path``. S7 reads the split from the converter's PPTX (pptx_facts ``fill_paths``) and counts such a
shape's exported fills as one paint; the input side still counts each PDF paint once, and a missing or moved piece
still fails.

(b) A slide without a ``p:bg`` shows the master's background. The writer's master had the theme's white (``bgRef``),
which PowerPoint exports as one more full-page fill; with ``noFill`` it exports none and renders the same.

The recorded round trips: deckback (``a4f2703``) converted the INPUT page below, and PowerPoint 16.0.17932.20976
exported the PPTX (``harness.atlas.export``, ``std``) on 2026-11-14. RECORDED_WHITE is that export's page content,
copied from the PDF; RECORDED_NO_FILL is the export of the same PPTX with the master's background ``noFill`` (the
writer's master since Task 4). WRITER_ARROW is the writer's shape, copied from its slide XML.

The ``powerpoint`` test at the end converts and round-trips a slide without a background through PowerPoint itself.
"""

import subprocess
import zipfile
from pathlib import Path

import pymupdf
import pytest

from harness.fidelity import pptx_facts, roundtrip
from harness.fidelity.test_structural import EMU, H_PT, W_PT, FakeExport, _deck, _sp, _xml

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "packages" / "cli" / "dist" / "deckback.mjs"

# A nonzero fill of two subpaths that overlap and run the same way: an arrow's body and head (0001 M0-5 case 4).
INPUT = "1 0 0 rg 100 250 m 400 250 l 400 290 l 100 290 l h 380 220 m 480 270 l 380 320 l h f"
BODY, HEAD = [100.0, 250.0, 400.0, 290.0], [380.0, 220.0, 480.0, 320.0]

# PowerPoint's export of the writer's slide: the master's white as an artifact, then the shape's two a:paths, one fill
# each (even-odd, as PowerPoint fills every a:path).
WHITE = ("/Artifact BMC q\n0 0.00012207 960 540 re\nW* n\n/GS5 gs\n1 g\n0 0.000061035 960 540 re\nf*\nQ\n EMC ")
ARROW = ("/P <</MCID 0>> BDC 1 0 0 rg\n100 250 300 40 re\nf*\n380 220 m\n480 270 l\n380 320 l\nh\nf*\n EMC ")
RECORDED_WHITE = WHITE + ARROW
RECORDED_NO_FILL = ARROW

PATHS = ('<a:path w="4826000" h="1270000" stroke="0"><a:moveTo><a:pt x="0" y="889000"/></a:moveTo><a:lnTo><a:pt '
         'x="3810000" y="889000"/></a:lnTo><a:lnTo><a:pt x="3810000" y="381000"/></a:lnTo><a:lnTo><a:pt x="0" '
         'y="381000"/></a:lnTo><a:close/></a:path><a:path w="4826000" h="1270000" stroke="0"><a:moveTo><a:pt '
         'x="3556000" y="1270000"/></a:moveTo><a:lnTo><a:pt x="4826000" y="635000"/></a:lnTo><a:lnTo><a:pt '
         'x="3556000" y="0"/></a:lnTo><a:close/></a:path>')
OUTLINE = ('<a:path w="4826000" h="1270000" fill="none"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt '
           'x="4826000" y="1270000"/></a:lnTo></a:path>')
RED = '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>'
NO_LINE = "<a:ln><a:noFill/></a:ln>"
BLACK_LINE = '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'


def _geometry(paths):
    return ('<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>'
            f'<a:pathLst>{paths}</a:pathLst></a:custGeom>')


def writer_arrow(name="pdf:p1:z1 freeform", paths=PATHS, fill=RED, line=NO_LINE, sp_id=2):
    """WRITER_ARROW: the writer's shape for INPUT, frame x 100..480, y 220..320 (pt)."""
    return _sp(name, 100, 220, 380, 100, _geometry(paths), fill, line, sp_id=sp_id)


def recorded_pdf(path, *streams):
    """A PDF of 960 x 540 pt pages, one per content stream, with the ExtGState PowerPoint's export names (GS5)."""
    doc = pymupdf.open()
    gs = doc.get_new_xref()
    doc.update_object(gs, "<< /Type /ExtGState /BM /Normal /ca 1 >>")
    for stream in streams:
        page = doc.new_page(width=W_PT, height=H_PT)
        xref = doc.get_new_xref()
        doc.update_object(xref, "<<>>")
        doc.update_stream(xref, stream.encode("ascii"))
        doc.xref_set_key(page.xref, "Contents", f"{xref} 0 R")
        doc.xref_set_key(page.xref, "Resources", f"<< /ExtGState << /GS5 {gs} 0 R >> >>")
    doc.save(str(path))
    return path


def split_shape(boxes=(BODY, HEAD), rgb=(255, 0, 0), alpha=1.0):
    """A shape of pptx_facts.split_fills: its a:paths' boxes, and its fill's colour and alpha."""
    return {"boxes": [pytest.approx(box) for box in boxes], "rgb": list(rgb), "alpha": pytest.approx(alpha)}


def arrow_deck(path, *elements):
    return _deck(path, *(elements or (writer_arrow(),)))


# ---- pptx_facts: the a:paths that fill ------------------------------------------------------------------------------


def test_fill_paths_are_the_boxes_of_the_paths_that_fill(tmp_path):
    deck = _deck(tmp_path / "d.pptx", writer_arrow(paths=PATHS + OUTLINE),
                 writer_arrow("one path", PATHS.split("</a:path>")[0] + "</a:path>", sp_id=3),
                 writer_arrow("no fill", fill="<a:noFill/>", line=BLACK_LINE, sp_id=4),
                 _sp("preset", 10, 10, 50, 50, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', RED, NO_LINE,
                     sp_id=5))
    shapes = pptx_facts.slide_facts(deck, 0).shapes
    # the stroke-only a:path (fill="none") fills nothing and is not listed
    assert shapes[0]["fill_paths"] == [pytest.approx(BODY), pytest.approx(HEAD)]
    assert shapes[1]["fill_paths"] == [pytest.approx(BODY)]
    assert shapes[2]["name"] == "no fill" and shapes[2]["fill_paths"] is None  # its outline only
    assert shapes[3]["fill_paths"] is None  # not a custGeom


def test_split_fills_lists_each_visible_slides_shapes_of_two_fill_paths_or_more(tmp_path):
    deck = _deck(tmp_path / "d.pptx", writer_arrow(),
                 writer_arrow("one path", PATHS.split("</a:path>")[0] + "</a:path>", sp_id=3))
    assert pptx_facts.split_fills(deck) == [[split_shape()]]
    # the shape's own colour and alpha come with its boxes (S7 joins only pieces of that colour)
    half = '<a:solidFill><a:srgbClr val="4472C4"><a:alpha val="50000"/></a:srgbClr></a:solidFill>'
    assert pptx_facts.split_fills(_deck(tmp_path / "h.pptx", writer_arrow(fill=half))) == [
        [split_shape(rgb=[0x44, 0x72, 0xC4], alpha=0.5)]]
    # a gradient fill is exported as shades, not fills: not a split fill S7 joins
    grad = ('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr '
            'val="0000FF"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>')
    assert pptx_facts.split_fills(_deck(tmp_path / "g.pptx", writer_arrow(fill=grad))) == [[]]


def test_split_fills_raises_facts_errors_only(tmp_path):
    broken = tmp_path / "Private-Deck.pptx"
    broken.write_bytes(b"not a zip")
    with pytest.raises(pptx_facts.FactsError) as error:
        pptx_facts.split_fills(broken)
    assert "Private-Deck" not in str(error.value) and str(tmp_path) not in str(error.value)


# ---- (a) a split fill is one paint ----------------------------------------------------------------------------------


@pytest.fixture
def recorded(tmp_path):
    """The input, the recorded round trips and the writer's deck."""
    return {"input": recorded_pdf(tmp_path / "input.pdf", INPUT),
            "white": recorded_pdf(tmp_path / "white.pdf", RECORDED_WHITE),
            "no_fill": recorded_pdf(tmp_path / "no-fill.pdf", RECORDED_NO_FILL),
            "deck": arrow_deck(tmp_path / "deck.pptx")}


def test_the_recorded_round_trip_has_one_fill_per_path(recorded):
    from harness.oracle.mupdf_inventory import inventory

    paints = inventory(str(recorded["no_fill"]), detail=False, paths=True)["pages"][0]["paints"]
    assert [(p["kind"], p["bbox"]) for p in paints] == [("fill", BODY), ("fill", HEAD)]
    paints = inventory(str(recorded["input"]), detail=False, paths=True)["pages"][0]["paints"]
    assert [(p["kind"], p["bbox"]) for p in paints] == [("fill", [100.0, 220.0, 480.0, 320.0])]


def test_s7_counts_a_split_fill_as_one_paint(recorded):
    split = pptx_facts.split_fills(recorded["deck"])
    assert roundtrip.compare(recorded["input"], recorded["no_fill"], split) == []
    # without the writer's record, the two a:paths are two fills (cause (a))
    assert roundtrip.compare(recorded["input"], recorded["no_fill"]) == ["page 1: paints fill 1 vs 2"]


def test_join_split_fills_joins_the_run_of_the_shapes_boxes():
    fill = {"kind": "fill", "rgb": [255, 0, 0], "alpha": 1.0}
    other = {"kind": "fill", "rgb": [0, 0, 255], "alpha": 1.0, "bbox": [0, 0, 10, 10]}
    paints = [other, {**fill, "bbox": BODY}, {**fill, "bbox": HEAD}, {"kind": "stroke", "bbox": BODY}]
    red = {"boxes": [BODY, HEAD], "rgb": [255, 0, 0], "alpha": 1.0}
    joined = roundtrip.join_split_fills(paints, [red])
    assert [p["kind"] for p in joined] == ["fill", "fill", "stroke"]
    assert joined[1]["bbox"] == [100.0, 220.0, 480.0, 320.0] and joined[1]["rgb"] == [255, 0, 0]
    assert paints[1]["bbox"] == BODY  # the input list is not changed
    # pieces of other colours are not one shape's fill
    assert len(roundtrip.join_split_fills([{**fill, "bbox": BODY}, {**other, "bbox": HEAD}], [red])) == 2
    # a piece with something between it and the next is not one shape's fill either
    apart = [{**fill, "bbox": BODY}, {"kind": "stroke", "bbox": BODY}, {**fill, "bbox": HEAD}]
    assert len(roundtrip.join_split_fills(apart, [red])) == 3
    # shapes are found in z-order: the second shape's run comes after the first's
    twice = [{**fill, "bbox": BODY}, {**fill, "bbox": HEAD}] * 2
    assert len(roundtrip.join_split_fills(twice, [red, red])) == 2
    assert len(roundtrip.join_split_fills(twice[:2], [red, red])) == 1


def test_join_split_fills_joins_only_pieces_of_the_shapes_own_colour():
    """Task 4's review: the run must also be the colour and alpha the PPTX gives the shape (within 1 of 255 and
    0.01: PowerPoint's export writes the colour as fractions), not just one colour; a shape without a colour joins
    nothing."""
    blue = [{"kind": "fill", "rgb": [0, 0, 255], "alpha": 1.0, "bbox": box} for box in (BODY, HEAD)]
    red = {"boxes": [BODY, HEAD], "rgb": [255, 0, 0], "alpha": 1.0}
    assert len(roundtrip.join_split_fills(blue, [red])) == 2
    assert len(roundtrip.join_split_fills(blue, [{**red, "rgb": [1, 0, 254]}])) == 1  # within 1 of 255
    assert len(roundtrip.join_split_fills(blue, [{**red, "rgb": [0, 0, 253]}])) == 2
    assert len(roundtrip.join_split_fills(blue, [{**red, "rgb": [0, 0, 255], "alpha": 0.5}])) == 2
    half = [{**p, "alpha": 0.502} for p in blue]
    assert len(roundtrip.join_split_fills(half, [{**red, "rgb": [0, 0, 255], "alpha": 0.5}])) == 1
    grouped = [{**p, "alpha": 1.0, "groupAlpha": 0.5} for p in blue]  # the alpha an enclosing group gives
    assert len(roundtrip.join_split_fills(grouped, [{**red, "rgb": [0, 0, 255], "alpha": 0.5}])) == 1
    assert len(roundtrip.join_split_fills(blue, [{**red, "rgb": None}])) == 2


def test_s7_a_split_shape_exported_in_another_colour_still_fails(tmp_path, recorded):
    blue = recorded_pdf(tmp_path / "blue.pdf", ARROW.replace("1 0 0 rg", "0 0 1 rg"))
    blue_input = recorded_pdf(tmp_path / "blue-input.pdf", INPUT.replace("1 0 0 rg", "0 0 1 rg"))
    split = pptx_facts.split_fills(recorded["deck"])  # the writer's shape is red
    assert roundtrip.compare(blue_input, blue, split) == ["page 1: paints fill 1 vs 2"]


@pytest.mark.parametrize("trip,problem", [
    (ARROW.replace("380 220 m\n480 270 l\n380 320 l\nh\nf*\n", ""), "path bbox"),  # the head is missing
    (ARROW.replace("380 220 m\n480 270 l\n380 320 l", "381 220 m\n481 270 l\n381 320 l"), "fill 1 vs 2"),  # moved
    (ARROW + "/P <</MCID 1>> BDC 1 0 0 rg\n500 20 30 30 re\nf*\n EMC ", "fill 1 vs 2"),  # a fill too many
])
def test_s7_a_missing_moved_or_extra_piece_still_fails(tmp_path, recorded, trip, problem):
    split = pptx_facts.split_fills(recorded["deck"])
    problems = roundtrip.compare(recorded["input"], recorded_pdf(tmp_path / "trip.pdf", trip), split)
    assert problems and problem in problems[0], problems


def test_s7_the_input_still_counts_each_paint_once(tmp_path, recorded):
    """Two PDF fills are two paints, even where the round trip has the shape the writer split into those two."""
    two = recorded_pdf(tmp_path / "two.pdf", "1 0 0 rg 100 250 m 400 250 l 400 290 l 100 290 l h f "
                                             "380 220 m 480 270 l 380 320 l h f")
    split = pptx_facts.split_fills(recorded["deck"])
    assert roundtrip.compare(two, recorded["no_fill"], split) == ["page 1: paints fill 2 vs 1"]


def test_s7_without_the_pptx_is_unchanged_and_reflexive(recorded):
    for pdf in (recorded["input"], recorded["white"], recorded["no_fill"]):
        assert roundtrip.compare(pdf, pdf) == []


# ---- (b) the master's background ------------------------------------------------------------------------------------


def test_s7_the_masters_white_is_one_more_fill(recorded):
    """Cause (b), recorded: the master's white comes back as a full-page fill the input does not have. S7 does not
    excuse it; the writer's master has no fill since Task 4 (RECORDED_NO_FILL)."""
    split = pptx_facts.split_fills(recorded["deck"])
    assert roundtrip.compare(recorded["input"], recorded["white"], split) == ["page 1: paints fill 1 vs 2"]


# ---- S7 end to end, the export replaced by the recorded one --------------------------------------------------------


def test_s7_reads_the_split_from_the_converters_pptx(tmp_path, monkeypatch, recorded):
    fake = FakeExport(pdf=recorded["no_fill"])
    monkeypatch.setattr(roundtrip, "export", fake)
    monkeypatch.setattr(roundtrip, "on_windows", lambda: True)
    result = roundtrip.s7(recorded["deck"], recorded["input"])
    assert result["status"] == "pass", result
    fake.pdf = recorded["white"]
    result = roundtrip.s7(recorded["deck"], recorded["input"])
    assert result["status"] == "fail" and "fill 1 vs 2" in result["detail"], result


def test_s7_fails_when_the_pptx_cannot_be_read_and_names_no_path(tmp_path, monkeypatch, recorded):
    broken = tmp_path / "Private-Deck.pptx"
    broken.write_bytes(b"not a zip")
    monkeypatch.setattr(roundtrip, "export", FakeExport(pdf=recorded["no_fill"]))
    monkeypatch.setattr(roundtrip, "on_windows", lambda: True)
    result = roundtrip.s7(broken, recorded["input"])
    assert result["status"] == "fail" and "could not be read" in result["detail"], result
    assert "Private-Deck" not in result["detail"] and str(tmp_path) not in result["detail"]


# ---- PowerPoint: a slide without a background round-trips ----------------------------------------------------------


def _input_pdf(path):
    """Two pages without a background: the arrow (two a:paths) and a plain rect."""
    return recorded_pdf(path, INPUT, "0 0 1 rg 200 200 300 100 re f")


@pytest.mark.powerpoint
def test_s7_a_slide_without_a_background_round_trips(tmp_path):
    """deckback converts two pages that paint no background (``npm run build:cli`` first); its slides have no
    ``p:bg`` and the master's background is noFill; PowerPoint opens the PPTX and exports it with no full-page fill,
    and S7 passes (the arrow's two a:paths counted as one fill)."""
    assert CLI.is_file(), "packages/cli/dist/deckback.mjs is missing: run `npm run build:cli` first"
    pdf = _input_pdf(tmp_path / "input.pdf")
    pptx = tmp_path / "out.pptx"
    subprocess.run(["node", str(CLI), str(pdf), "-o", str(pptx)], check=True, capture_output=True)
    with zipfile.ZipFile(pptx) as z:
        assert all(b"<p:bg>" not in z.read(f"ppt/slides/slide{n}.xml") for n in (1, 2))
        assert b"<p:bg><p:bgPr><a:noFill/>" in z.read("ppt/slideMasters/slideMaster1.xml")
    assert pptx_facts.split_fills(pptx) == [[split_shape()], []]
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "pass", result


# ---- M5 Task 1: the problems of each page ---------------------------------------------------------------------------


def test_page_problems_splits_the_problems_by_page():
    problems = ["page 3: paints fill 1 vs 2", "page 3: text differs (5 vs 4 characters, whitespace removed)",
                "page 12: 1 glyph baseline(s) off by more than 0.5 pt (worst 0.90 pt)"]
    pages, deck_wide = roundtrip.page_problems(problems)
    assert deck_wide == [] and sorted(pages) == [3, 12]
    assert pages[3].startswith("paints fill 1 vs 2; text differs") and pages[12].startswith("1 glyph baseline")


def test_page_problems_keeps_a_problem_of_the_whole_deck_apart():
    pages, deck_wide = roundtrip.page_problems(["3 pages exported for 2 pages in the input", "page 1: text differs"])
    assert deck_wide == ["3 pages exported for 2 pages in the input"] and sorted(pages) == [1]


def test_s7_names_the_failing_pages(monkeypatch, recorded):
    monkeypatch.setattr(roundtrip, "export", FakeExport(pdf=recorded["white"]))
    monkeypatch.setattr(roundtrip, "on_windows", lambda: True)
    result = roundtrip.s7(recorded["deck"], recorded["input"])
    assert result["status"] == "fail" and sorted(result["pages"]) == [1]
    assert "fill 1 vs 2" in result["pages"][1]


def test_s7_a_deck_wide_problem_names_no_pages(monkeypatch, recorded):
    monkeypatch.setattr(roundtrip, "export", FakeExport(pdf=recorded["white"]))
    monkeypatch.setattr(roundtrip, "on_windows", lambda: True)
    monkeypatch.setattr(roundtrip, "compare", lambda *args, **kw: ["3 pages exported for 2 pages in the input"])
    result = roundtrip.s7(recorded["deck"], recorded["input"])
    assert result["status"] == "fail" and "pages" not in result


def test_s7_a_passing_deck_has_no_pages(monkeypatch, recorded):
    monkeypatch.setattr(roundtrip, "export", FakeExport(pdf=recorded["no_fill"]))
    monkeypatch.setattr(roundtrip, "on_windows", lambda: True)
    assert "pages" not in roundtrip.s7(recorded["deck"], recorded["input"])


# ---- M8-R5: content wholly outside the page is not round-trip-checked ---------------------------------------------

ON_PAGE = "0 0 1 rg 100 100 200 100 re f"
OFF_PAGE = "1 0 0 rg 1000 100 50 50 re f 0 1 0 rg 100 -200 50 50 re f"  # right of and below the 960 x 540 page


def test_s7_ignores_a_fill_wholly_outside_the_page_on_either_side(tmp_path):
    with_off = recorded_pdf(tmp_path / "with.pdf", ON_PAGE + " " + OFF_PAGE)
    without = recorded_pdf(tmp_path / "without.pdf", ON_PAGE)
    assert roundtrip.compare(with_off, without) == []  # PowerPoint's export dropped it
    assert roundtrip.compare(without, with_off) == []  # and the other way round


def test_s7_still_counts_a_fill_that_touches_the_page(tmp_path):
    partly = recorded_pdf(tmp_path / "partly.pdf", ON_PAGE + " 1 0 0 rg 940 100 50 50 re f")
    without = recorded_pdf(tmp_path / "without.pdf", ON_PAGE)
    assert roundtrip.compare(partly, without) == ["page 1: paints fill 2 vs 1"]


def _text_pdf(path, *lines):
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    for point, text in lines:
        page.insert_text(point, text, fontname="helv", fontsize=12)
    doc.save(str(path))
    return path


def test_s7_ignores_text_wholly_outside_the_page_but_not_text_on_it(tmp_path):
    both = _text_pdf(tmp_path / "both.pdf", ((100, 100), "inside"), ((1200, 100), "beyond"), ((100, 700), "below"))
    inside = _text_pdf(tmp_path / "inside.pdf", ((100, 100), "inside"))
    assert roundtrip.compare(both, inside) == []
    assert roundtrip.compare(inside, both) == []
    other = _text_pdf(tmp_path / "other.pdf", ((100, 100), "insidf"))
    assert roundtrip.compare(both, other) != []


def test_on_page_keeps_the_input_unchanged():
    page = {"size": (100, 100), "paints": [{"kind": "fill", "bbox": [10, 10, 20, 20]},
                                           {"kind": "fill", "bbox": [100, 0, 120, 10]}],
            "glyphs": [{"u": "a", "x": 5, "y": 5}, {"u": "b", "x": 101, "y": 5}]}
    kept = roundtrip.on_page(page)
    assert len(kept["paints"]) == 1 and len(kept["glyphs"]) == 1 and len(page["paints"]) == 2


def test_on_page_drops_a_glyph_only_when_its_whole_box_is_outside_review_m1():
    """M8-R5 is "wholly outside": a glyph with its origin just below the page whose body reaches onto it stays; one
    far past the edge (by more than its box) goes. A glyph with no size is its origin alone, as before."""
    page = {"size": (100, 100), "paints": [],
            "glyphs": [{"u": "a", "x": 50, "y": 104, "size": 12},   # origin past the bottom, body on the page
                       {"u": "b", "x": -5, "y": 50, "size": 12},    # origin left of the edge, body on the page
                       {"u": "c", "x": 50, "y": 130, "size": 12},   # the whole box is past the bottom
                       {"u": "d", "x": 50, "y": 104}]}             # no size: the origin alone
    assert [g["u"] for g in roundtrip.on_page(page)["glyphs"]] == ["a", "b"]


def test_s7_asks_the_oracle_for_glyph_sizes(tmp_path):
    pdf = _text_pdf(tmp_path / "a.pdf", ((100, 100), "hello"))
    from harness.oracle.mupdf_inventory import inventory
    glyphs = inventory(str(pdf), detail=False, paths=True, glyph_sizes=True)["pages"][0]["glyphs"]
    assert glyphs and all(g["size"] > 0 for g in glyphs)
    assert all("size" not in g for g in inventory(str(pdf), detail=False, paths=True)["pages"][0]["glyphs"])
