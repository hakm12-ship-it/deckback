"""A two-line tagged paragraph lowers to one text box whose baselines land within 0.25 pt after a PowerPoint round trip
(M4 Task 1, text assembly).

1. The source: a deck of text boxes (python-pptx, through the atlas framework, `ofl` fonts), one of them holding a
   paragraph that wraps into two lines, exported by PowerPoint to a tagged PDF (`harness.atlas.export`, `std`).
2. deckback converts it (`node packages/cli/dist/deckback.mjs`: run `npm run build:cli` first).
3. Its PPTX holds the paragraph as one text box of two paragraphs (`a:p`), a line each.
4. PowerPoint exports that PPTX to PDF again (`harness.atlas.export`). Paired in order, every glyph's origin lies within
   0.25 pt of the source's across the line (its baseline), and the slide's text is the source's.

M4b Task 1, the drift of a line along it: three atlas slides, built by the atlas's own section builders (text/18
alignment with a justified paragraph, text/25 bullets, text/41 runs of several sizes on one line), go the same way:
PowerPoint's PDF, deckback's PPTX, PowerPoint's PDF of it. Paired on their visible text (difflib, as M4 Task 6 measured
the round trip), every glyph's origin lies within 0.25 pt of the source's along its line and across it (text/18 is an
expected failure, `TEXT_18_NOISE`), and on text/25 the first text glyph after each bullet within 0.1 pt along (an
expected failure for one bullet, `BULLET_UNDER_FLOOR`).

PowerPoint runs only through export.ps1 (DeckbackCom.psm1: GUID-named temp copies, nothing it did not start is closed,
quit or stopped). Everything is written under pytest's tmp_path. Needs `pytest --run-powerpoint` (marker `powerpoint`);
CI never runs it.
"""

import difflib
import subprocess
import zipfile
from pathlib import Path

import pytest
from lxml import etree

REPO = Path(__file__).resolve().parents[2]
CLI = REPO / "packages" / "cli" / "dist" / "deckback.mjs"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
BASELINE_TOL = 0.25  # pt

PARAGRAPH = "Text assembly joins the words of a line, then the lines of one paragraph, into a single text box."
SIZE = 18
BOX = (60, 80, 520, 120)  # x, y, w, h (pt): narrow enough that the paragraph wraps into two lines


def _source(path):
    from harness.atlas.deck import AtlasDeck

    deck = AtlasDeck("ofl", (960, 540), deck="m4-text-assembly")
    slide = deck.slide("text", ["text:assembly"])
    deck.text(slide.shapes, *BOX, PARAGRAPH, "BODY", SIZE, name="Paragraph")
    deck.text(slide.shapes, 60, 300, 520, 40, "A single line of its own.", "BODY", SIZE, name="Line")
    deck.save(path)
    return path


def _export(pptx, out_dir):
    from harness.atlas.export import export

    result = export(pptx, out_dir, ["std"], False)
    std = result["variants"].get("std") or {}
    assert std.get("ok"), f"export failed: exit {std.get('exitCode')} {std.get('reason', '')}"
    return Path(out_dir) / f"{Path(pptx).stem}_std.pdf"


def _glyphs(pdf):
    from harness.oracle.mupdf_inventory import inventory

    page = inventory(str(pdf), [1], detail=False)["pages"][0]
    return [g for g in page["glyphs"] if g["u"].strip()]


def _text_boxes(pptx):
    with zipfile.ZipFile(pptx) as z:
        root = etree.fromstring(z.read("ppt/slides/slide1.xml"))
    out = []
    for sp in root.iter(f"{P}sp"):
        if sp.find(f"{P}nvSpPr/{P}cNvSpPr[@txBox='1']") is None:
            continue
        paras = sp.findall(f"{P}txBody/{A}p")
        out.append(["".join(t.text or "" for t in p.iter(f"{A}t")) for p in paras])
    return out


@pytest.mark.powerpoint
def test_two_line_tagged_paragraph_is_one_box_and_round_trips(tmp_path):
    assert CLI.is_file(), "packages/cli/dist/deckback.mjs is missing: run `npm run build:cli` first"
    source = _export(_source(tmp_path / "source.pptx"), tmp_path)
    src = _glyphs(source)
    # the source paragraph wraps: its glyphs stand on two baselines
    lines = sorted({round(g["y"], 1) for g in src if BOX[1] <= g["y"] <= BOX[1] + BOX[3]})
    assert len(lines) == 2, f"the source paragraph is on {len(lines)} lines"

    out = tmp_path / "converted.pptx"
    done = subprocess.run(["node", str(CLI), str(source), "-o", str(out)], capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr[-500:]
    boxes = _text_boxes(out)
    paragraph = [b for b in boxes if b[0].startswith("Text assembly")]
    assert len(paragraph) == 1 and len(paragraph[0]) == 2, boxes
    assert "".join(paragraph[0]).replace(" ", "") == PARAGRAPH.replace(" ", "")

    back = _glyphs(_export(out, tmp_path / "round-trip"))
    assert [g["u"] for g in back] == [g["u"] for g in src]
    worst = max(abs(b["y"] - s["y"]) for s, b in zip(src, back))
    assert worst <= BASELINE_TOL, f"a baseline is {worst:.3f} pt off"


# --- M4b Task 1: drift along the line -------------------------------------------------------------------------------

DRIFT_TOL = 0.25  # pt, along the line and across it
BULLET_TOL = 0.1  # pt, along: the first text glyph after a bullet
ATLAS_SLIDES = ("text/18", "text/25", "text/41")  # the slides of `_atlas_source`, in order

# text/18 after M4b Task 1: the justified line's spaces are exact (7.08 -> 0.31 pt), but two causes the PDF does not
# give stay over 0.25 pt. The right-aligned cell's lines come back up to 0.64 pt long: the same written line is exact
# when its box stands at x 37.2 pt, and across 41 box positions 0.01 pt apart near its own (653.57) PowerPoint's export
# drew it 0 to 0.60 pt long, not by any grid of the position. The justified cell's words whose letters PowerPoint
# spread unevenly (0.44 to 0.65 pt a pair, "alignment") are written at their median and drift up to 0.44 pt. Strict:
# a pass is news.
TEXT_18_NOISE = pytest.mark.xfail(strict=True, reason="text/18: PowerPoint export noise by box position, uneven justify spread (M4b Task 1)")

# text/25 after M4b Task 1: every bullet's text within 0.07 pt but the '■' line's, 0.12 pt short (one 600 dpi step): its
# space is 0.076 pt over the font's, under SPACING_FLOOR_PT, so it is written at the letters' spacing. Written 0.08 the
# text landed at 0.00, but the same for the first symbol of text/37's lists moved them 0.12 pt the other way.
class OverBulletTol(AssertionError):
    """A bullet's text off by more than BULLET_TOL, though within DRIFT_TOL: the only failure BULLET_UNDER_FLOOR expects."""


BULLET_UNDER_FLOOR = pytest.mark.xfail(strict=True, raises=OverBulletTol, reason="text/25 '■': a bullet's space 0.076 pt over a space, under the spacing floor (M4b Task 1)")


def _atlas_source(path):
    """The three atlas slides, by the atlas's own builders, in a deck of the atlas's size and fonts."""
    from harness.atlas.deck import AtlasDeck
    from harness.atlas.sections import text

    deck = AtlasDeck("ofl", (960, 540), deck="m4b-drift", id_prefix="atlas")
    text._alignment(deck, english=True)  # atlas/text/18: algn l, ctr, r and just, a 15 pt serif paragraph each
    text._bullets(deck)  # atlas/text/25: buChar, buClr, buSzPct, marL and indent
    text._mixed_sizes(deck)  # atlas/text/41: 12, 24, 36 and 18 pt on one line, fontAlgn base, ctr, t and b
    deck.save(path)
    return path


def _pairs(source, back, page):
    """The page's visible glyphs of `source` and `back` paired on their text (difflib), with each pair's offset along
    and across its source line (`text_directions`: the line's direction, else horizontal)."""
    import pymupdf

    from harness.fidelity.pdf_facts import text_directions
    from harness.oracle.mupdf_inventory import inventory

    ga = [g for g in inventory(str(source), [page], detail=False)["pages"][0]["glyphs"] if g["u"].strip()]
    gb = [g for g in inventory(str(back), [page], detail=False)["pages"][0]["glyphs"] if g["u"].strip()]
    matcher = difflib.SequenceMatcher(None, "".join(g["u"] for g in ga), "".join(g["u"] for g in gb), autojunk=False)
    with pymupdf.open(str(source)) as doc:
        index = text_directions(doc[page - 1])
    out = []
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            a, b = ga[block.a + k], gb[block.b + k]
            found = index.find(a["x"], a["y"])
            dx, dy = (found or {}).get("direction") or (1.0, 0.0)
            ox, oy = b["x"] - a["x"], b["y"] - a["y"]
            out.append((a, ox * dx + oy * dy, oy * dx - ox * dy))
    return ga, out


@pytest.fixture(scope="module")
def atlas_round_trip(tmp_path_factory):
    """{slide: (source glyphs, [(source glyph, along, across)])} for the three slides, after one round trip."""
    assert CLI.is_file(), "packages/cli/dist/deckback.mjs is missing: run `npm run build:cli` first"
    tmp = tmp_path_factory.mktemp("m4b-drift")
    source = _export(_atlas_source(tmp / "source.pptx"), tmp)
    out = tmp / "converted.pptx"
    done = subprocess.run(["node", str(CLI), str(source), "-o", str(out)], capture_output=True, text=True, timeout=300)
    assert done.returncode == 0, done.stderr[-500:]
    back = _export(out, tmp / "round-trip")
    return {name: _pairs(source, back, page) for page, name in enumerate(ATLAS_SLIDES, start=1)}


@pytest.mark.powerpoint
@pytest.mark.parametrize("slide", [pytest.param("text/18", marks=TEXT_18_NOISE), "text/25", "text/41"])
def test_atlas_text_round_trips_within_a_quarter_point(atlas_round_trip, slide):
    glyphs, pairs = atlas_round_trip[slide]
    assert len(pairs) >= len(glyphs) - 1, f"{slide}: {len(pairs)} of {len(glyphs)} glyphs paired"
    along = max(pairs, key=lambda p: abs(p[1]))
    across = max(pairs, key=lambda p: abs(p[2]))
    assert abs(along[1]) <= DRIFT_TOL, f"{slide}: a glyph is {along[1]:+.3f} pt off along its line (at x {along[0]['x']:.1f}, y {along[0]['y']:.1f})"
    assert abs(across[2]) <= DRIFT_TOL, f"{slide}: a glyph is {across[2]:+.3f} pt off across its line (at x {across[0]['x']:.1f}, y {across[0]['y']:.1f})"


@pytest.mark.powerpoint
@BULLET_UNDER_FLOOR
def test_first_text_glyph_after_a_bullet_lands_on_its_origin(atlas_round_trip):
    from harness.atlas.sections.text import BULLETS

    glyphs, pairs = atlas_round_trip["text/25"]
    offset = {id(a): along for a, along, _ in pairs}
    lines = {}
    for g in glyphs:
        lines.setdefault(round(g["y"], 1), []).append(g)
    off = []
    for y, line in sorted(lines.items()):
        line.sort(key=lambda g: g["x"])
        if len(line) < 2 or line[0]["u"] not in BULLETS:
            continue
        first = line[1]
        assert id(first) in offset, f"the text after the bullet at y {y} came back as something else"
        # within a quarter point always (the bullet indent of '◆' was 1.92 pt off before M4b Task 1)
        assert abs(offset[id(first)]) <= DRIFT_TOL, f"the text after the bullet {line[0]['u']!r} at y {y} is {offset[id(first)]:+.3f} pt off"
        off.append((line[0]["u"], y, offset[id(first)]))
    assert len(off) == len(BULLETS), f"{len(off)} bulleted lines found"
    over = [f"{u!r} at y {y}: {d:+.3f} pt" for u, y, d in off if abs(d) > BULLET_TOL]
    if over:
        raise OverBulletTol("the text after a bullet is more than 0.1 pt off: " + "; ".join(over))
