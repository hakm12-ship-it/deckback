"""harness/fonts/baseline_calib.py: the baseline calibration's arithmetic and its output (the PowerPoint run is local)."""

import json
import re
import tempfile
from pathlib import Path

import pymupdf
import pytest

from harness.fonts import baseline_calib
from harness.fonts.baseline_calib import Box

REPO = Path(__file__).resolve().parents[2]
COMMITTED = REPO / "packages" / "core" / "src" / "passes" / "baseline-calib.ts"
WRITER_CASES = REPO / "packages" / "ooxml" / "test" / "calibration-text-box.json"


def test_k_from_a_known_box(tmp_path):
    # A synthetic PDF whose baselines are known: insert_text puts the first glyph's origin at the point given.
    pdf = tmp_path / "known.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((50, 100), "Hxg", fontsize=20, fontname="helv")
    page.insert_text((50, 160), "Hxg", fontsize=10, fontname="helv")
    doc.save(pdf)
    doc.close()
    boxes = [Box(0, "Known Sans", False, 20, 50, 82), Box(0, "Known Sans", True, 10, 50, 151)]
    baselines = baseline_calib.read_baselines(pdf, boxes)
    assert baselines == pytest.approx([100, 160], abs=1e-3)
    assert [baseline_calib.k_of(b, y) for b, y in zip(boxes, baselines)] == pytest.approx([0.9, 0.9], abs=1e-4)
    # no glyph where a box says its text is (PowerPoint drew it as a bitmap): no baseline
    assert baseline_calib.read_baselines(pdf, [Box(0, "Known Sans", False, 20, 200, 82)]) == [None]
    # a box's first glyph is its own text's first character
    assert baseline_calib.read_baselines(pdf, [Box(0, "Known Sans", False, 20, 50, 82, "Hx")]) == pytest.approx([100])
    assert baseline_calib.read_baselines(pdf, [Box(0, "Known Sans", False, 20, 50, 82, "xH")]) == [None]


def test_a_line_drawn_in_two_fonts_is_seen(tmp_path):
    # PowerPoint draws a character the font lacks in another font (NanumGothic's Á in Cambria): that line's baseline is
    # not the font's own
    pdf = tmp_path / "two.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((50, 100), "Hxg ", fontsize=20, fontname="helv")
    page.insert_text((100, 100), "Ag", fontsize=20, fontname="tiro")
    page.insert_text((50, 160), "Hxg", fontsize=20, fontname="helv")
    doc.save(pdf)
    doc.close()
    boxes = [Box(0, "Known Sans", False, 20, 50, 82), Box(0, "Known Sans", False, 20, 50, 142), Box(0, "K", False, 20,
                                                                                                    250, 82)]
    baselines = baseline_calib.read_baselines(pdf, boxes)
    fonts = baseline_calib.line_fonts(pdf, boxes, baselines)
    assert [len(f) for f in fonts] == [2, 1, 0]


def test_the_sample_text_leaves_out_what_a_face_lacks():
    full = {ord(c) for c in baseline_calib.SAMPLE_TEXT}
    assert baseline_calib.sample_text([full, full]) == baseline_calib.SAMPLE_TEXT
    assert baseline_calib.sample_text([]) == baseline_calib.SAMPLE_TEXT
    assert baseline_calib.sample_text([full, full - {ord("Á"), ord("ÿ")}]) == "Hxg 한글 g"


def test_summary_per_family_and_per_weight_where_both_are_measured():
    # ruling M3-R36: a family measured in both weights is keyed by weight too (NanumGothic: Regular and Bold are two
    # files with two baselines); measured in one, by the family alone
    boxes = [Box(0, "A", False, 10, 0, 0), Box(0, "A", False, 20, 0, 0), Box(1, "A", True, 10, 0, 0),
             Box(2, "B", False, 10, 0, 0)]
    table = baseline_calib.summarise(boxes, [1.0, 1.002, 0.998, 0.95])
    assert table == {
        "A": {"k": 1.0, "n": 3, "spread": 0.004, "regular": {"k": 1.001, "n": 2, "spread": 0.002},
              "bold": {"k": 0.998, "n": 1, "spread": 0.0}},
        "B": {"k": 0.95, "n": 1, "spread": 0.0},
    }
    # a box without a baseline is not a sample: A's Bold was not measured, so A is keyed by family alone
    assert baseline_calib.summarise(boxes[:3], [None, 0.9, None]) == {"A": {"k": 0.9, "n": 1, "spread": 0.0}}


def _metrics(win=(900, 300), typo=(800, -200, 0), fs_selection=0, hhea=(900, -250, 0), upm=1000):
    return {"upm": upm, "hheaAsc": hhea[0], "hheaDesc": hhea[1], "hheaLineGap": hhea[2], "winAsc": win[0],
            "winDesc": win[1], "typoAsc": typo[0], "typoDesc": typo[1], "typoLineGap": typo[2],
            "fsSelection": fs_selection}


def test_the_line_share_is_win_or_typo_with_its_line_gap_by_use_typo_metrics():
    # ruling M3-R35: A / (A + D), A and D Windows' line metrics; USE_TYPO_METRICS (bit 7) takes the typo ones, the line
    # gap over the ascent; the hhea line gap is never read
    assert baseline_calib.line_share(_metrics(win=(900, 300))) == pytest.approx(0.75)
    typo = _metrics(win=(900, 300), typo=(800, -300, 400), fs_selection=0x80)
    assert baseline_calib.line_share(typo) == pytest.approx(0.8)
    assert baseline_calib.line_share({**typo, "fsSelection": 0x40}) == pytest.approx(0.75)
    assert baseline_calib.line_share(_metrics(hhea=(900, -250, 500))) == pytest.approx(0.75)
    for bad in (_metrics(win=(0, 300)), _metrics(win=(3001, 300)), _metrics(upm=0), _metrics(win=(900, -1))):
        assert baseline_calib.line_share(bad) is None, bad


def test_the_fallback_fit_is_the_scale_of_the_line_share():
    # k = 1.2 x A / (A + D) exactly
    points = {
        "A": (1.2 * 0.75, _metrics(win=(900, 300))),
        "B": (1.2 * 0.8, _metrics(win=(800, 200))),
        "C": (1.2 * 0.8, _metrics(win=(500, 500), typo=(800, -300, 400), fs_selection=0x80)),
    }
    fit = baseline_calib.fit_fallback(points)
    assert fit["scale"] == pytest.approx(1.2, abs=1e-6)
    assert fit["worst"] == pytest.approx(0, abs=1e-6)
    assert set(fit["errors"]) == {"A", "B", "C"}
    # a point without plausible metrics is left out of the fit
    fit = baseline_calib.fit_fallback({**points, "D": (5.0, _metrics(win=(0, 0)))})
    assert fit["scale"] == pytest.approx(1.2, abs=1e-6) and "D" not in fit["errors"]
    with pytest.raises(ValueError):
        baseline_calib.fit_fallback({"D": (5.0, _metrics(win=(0, 0)))})


def test_output_has_family_names_and_numbers_only():
    table = {
        "Gothic A1": {"k": 0.95, "n": 6, "spread": 0.0},
        "Malgun Gothic": {"k": 1.0123, "n": 6, "spread": 0.0011, "regular": {"k": 1.0125, "n": 3, "spread": 0.0004},
                          "bold": {"k": 1.0121, "n": 3, "spread": 0.0011}},
        "_alias": {"고딕 A1": "Gothic A1", "맑은 고딕": "Malgun Gothic"},
        "_fallback": {"scale": 1.2036},
    }
    text = baseline_calib.render_ts(table)
    assert "export const BASELINE_CALIB = {" in text and text.rstrip().endswith("} as const;")
    assert baseline_calib.parse_ts(text) == table
    assert baseline_calib.render_ts(baseline_calib.parse_ts(text)) == text

    # every string in it is a family name, an alias (a family's Korean name), a field name or the metric's name
    strings = set(re.findall(r'"((?:[^"\\]|\\.)*)"', text))
    assert strings == {"Gothic A1", "Malgun Gothic", "고딕 A1", "맑은 고딕", "k", "n", "spread", "regular", "bold", "_alias",
                       "_fallback", "scale"}
    # and nothing that names this PC: no drive, no user folder, no path
    assert not re.search(r"[A-Za-z]:[\\/]|\\\\|Users|AppData|/home/|\.pptx|\.pdf", text)

    # only names and numbers: anything else is refused
    fallback = table["_fallback"]
    bad = [
        {"X": {"k": "1.0", "n": 6, "spread": 0}, "_alias": {}, "_fallback": fallback},
        {"X": {"k": 1.0, "n": 6, "spread": 0, "path": 1}, "_alias": {}, "_fallback": fallback},
        {"X": {"k": 1.0, "n": 6, "spread": 0, "regular": {"k": 1.0, "n": 3, "spread": 0}}, "_alias": {},
         "_fallback": fallback},  # one weight alone
        {"X": {"k": 1.0, "n": 6, "spread": 0}, "_alias": {}, "_fallback": {"scale": "C:\\fonts"}},
        {"X": {"k": 1.0, "n": 6, "spread": 0}, "_alias": {}, "_fallback": {"scale": 1.2, "metric": "winAsc"}},
        {"X": {"k": 1.0, "n": 6, "spread": 0}, "_alias": {}, "_fallback": {"scale": 0}},
        {"C:\\Windows\\Fonts\\x.ttf": {"k": 1.0, "n": 6, "spread": 0}, "_alias": {}, "_fallback": fallback},
        {"X": {"k": 1.0, "n": 6, "spread": 0}, "_alias": {"Y": "Z"}, "_fallback": fallback},  # an alias of nothing
        {"X": {"k": 1.0, "n": 6, "spread": 0}, "_alias": {"Y": 1}, "_fallback": fallback},
    ]
    for case in bad:
        with pytest.raises(ValueError):
            baseline_calib.render_ts(case)


def test_the_committed_table_is_what_render_ts_writes():
    text = COMMITTED.read_text(encoding="utf-8")
    assert baseline_calib.render_ts(baseline_calib.parse_ts(text)).encode("utf-8") == COMMITTED.read_bytes()


def test_the_calibration_text_boxes_are_the_writers_own():
    # ruling M3-R37: PowerPoint takes the line's height from its runs and its paragraph mark, so the deck the baseline is
    # measured in must hold exactly the text boxes the writer writes; packages/ooxml/test/text.test.ts checks the writer
    # against the same cases
    cases = json.loads(WRITER_CASES.read_text(encoding="utf-8"))["cases"]
    assert len(cases) >= 2
    # an italic run and a box of several runs (ledger L145): drift in the mark's i or lang fails here
    assert any(run["i"] for case in cases for run in case["box"]["runs"])
    assert any(len(case["box"]["runs"]) > 1 for case in cases)
    for case in cases:
        assert baseline_calib.text_box_xml(case["box"]) == case["xml"]


def test_the_calibration_deck_names_ea_by_the_korean_name(tmp_path, monkeypatch):
    # rulings M3-R37 and M3-R44 (spec section 7): lowering writes a run's a:ea as the font's Korean family name where it
    # has one, a:latin and a:cs as the family, so the deck the run builds does the same and stays byte for byte the
    # writer's. The installed fonts and the export are stand-ins: the run stops before PowerPoint, its deck written.
    import zipfile

    from harness.atlas import export as atlas_export

    face = baseline_calib.Face("Regular", {}, frozenset(map(ord, baseline_calib.SAMPLE_TEXT)), korean="맑은 고딕")
    monkeypatch.setattr(baseline_calib, "WINDOWS_FAMILIES", ("Malgun Gothic",))
    monkeypatch.setattr(baseline_calib, "font_faces", lambda families: {"Malgun Gothic": [face]})
    monkeypatch.setattr(baseline_calib, "_powerpoint_state", lambda: 0)

    def no_export(*args, **kwargs):
        raise atlas_export.ExportError("not in this test")

    monkeypatch.setattr(atlas_export, "export", no_export)
    out = tmp_path / "calib"
    assert baseline_calib.main(["--fonts", "windows", "--out", str(out), "--ts", str(tmp_path / "calib.ts")]) == 3
    with zipfile.ZipFile(out / "baseline-calib-windows.pptx") as deck:
        slides = [deck.read(name).decode("utf-8") for name in deck.namelist()
                  if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
    box = re.compile(r'<p:sp>(?:(?!</p:sp>).)*name="Calibration .*?</p:sp>', re.S)
    boxes = [sp for xml in slides for sp in box.findall(xml)]
    assert len(boxes) == 2 * len(baseline_calib.SIZES)
    for box in boxes:
        faces = re.findall(r'<a:(latin|ea|cs) typeface="([^"]*)"', box)
        assert {tag for tag, _ in faces} == {"latin", "ea", "cs"}
        assert {name for tag, name in faces if tag == "ea"} == {"맑은 고딕"}, box
        assert {name for tag, name in faces if tag != "ea"} == {"Malgun Gothic"}, box


def test_calibration_output_stays_in_out_or_temp():
    assert baseline_calib.output_allowed(REPO / "out" / "baseline-calib")
    assert baseline_calib.output_allowed(Path(tempfile.gettempdir()) / "calib")
    for refused in (REPO, REPO / "harness", REPO / "corpus" / "generated", REPO / "corpus" / "private",
                    REPO / "packages" / "core"):
        assert not baseline_calib.output_allowed(refused), refused


def _font(path, family, korean=None):
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder([".notdef", "H"])
    fb.setupCharacterMap({ord("H"): "H"})
    pen = TTGlyphPen(None)
    pen.moveTo((0, 0)), pen.lineTo((0, 700)), pen.lineTo((500, 700)), pen.closePath()
    glyph = pen.glyph()
    fb.setupGlyf({".notdef": glyph, "H": glyph})
    fb.setupHorizontalMetrics({".notdef": (500, 0), "H": (500, 0)})
    fb.setupHorizontalHeader(ascent=900, descent=-250)
    fb.setupNameTable({"familyName": family, "styleName": "Regular"})
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=950, usWinDescent=260)
    fb.setupPost()
    if korean is not None:
        fb.font["name"].setName(korean, 1, 3, 1, 0x412)
    return fb.font


def test_every_face_of_a_collection_is_read_and_korean_names_become_aliases(tmp_path):
    from fontTools.ttLib import TTCollection

    collection = TTCollection()
    collection.fonts = [_font(None, "Test One", "테스트 하나"), _font(None, "Test Two"), _font(None, "Test Three", "테스트 셋")]
    ttc = tmp_path / "test.ttc"
    collection.save(str(ttc))
    faces = baseline_calib.faces_in([str(ttc)], ["Test One", "Test Two", "Test Three"])
    assert sorted(faces) == ["Test One", "Test Three", "Test Two"]  # not only the first face of the collection
    assert faces["Test Two"][0].metrics == {"upm": 1000, "hheaAsc": 900, "hheaDesc": -250, "hheaLineGap": 0,
                                            "winAsc": 950, "winDesc": 260, "typoAsc": 800, "typoDesc": -200,
                                            "typoLineGap": 0, "fsSelection": 0}
    assert baseline_calib.aliases(faces) == {"테스트 하나": "Test One", "테스트 셋": "Test Three"}


def test_a_run_merges_into_the_table_it_does_not_redo():
    old = {"Gothic A1": {"k": 0.95, "n": 6, "spread": 0.0}, "Batang": {"k": 0.8, "n": 6, "spread": 0.0},
           "_alias": {"고딕 A1": "Gothic A1", "옛 바탕": "Batang"}, "_fallback": {"scale": 1.2}}
    new = {"Batang": {"k": 0.81, "n": 6, "spread": 0.001}, "Gulim": {"k": 0.82, "n": 6, "spread": 0.0}}
    merged = baseline_calib.merge(old, new, {"바탕": "Batang", "굴림": "Gulim"})
    assert merged == {"Batang": new["Batang"], "Gothic A1": old["Gothic A1"], "Gulim": new["Gulim"],
                      "_alias": {"고딕 A1": "Gothic A1", "굴림": "Gulim", "바탕": "Batang"}}
    assert list(merged) == ["Batang", "Gothic A1", "Gulim", "_alias"]


def test_the_table_keeps_only_the_families_of_the_two_runs_lists():
    # ruling M4-R8: a family neither the lock nor WINDOWS_FAMILIES lists (one an older run measured) leaves the table,
    # and so do its aliases; the fallback stays for the refit
    table = {"Gothic A1": {"k": 0.95, "n": 6, "spread": 0.0}, "Batang": {"k": 0.8, "n": 6, "spread": 0.0},
             "Bodoni MT": {"k": 0.97, "n": 6, "spread": 0.0}, "HYGothic-Medium": {"k": 1.03, "n": 6, "spread": 0.0},
             "_alias": {"고딕 A1": "Gothic A1", "HY중고딕": "HYGothic-Medium"}, "_fallback": {"scale": 1.2}}
    assert baseline_calib.pruned(table) == {
        "Batang": table["Batang"], "Gothic A1": table["Gothic A1"], "_alias": {"고딕 A1": "Gothic A1"},
        "_fallback": {"scale": 1.2}}
    assert "Bodoni MT" not in baseline_calib.WINDOWS_FAMILIES
    assert set(baseline_calib.WINDOWS_FAMILIES) == {
        "Malgun Gothic", "Malgun Gothic Semilight", "Batang", "Gulim", "Dotum", "Gungsuh", "Noto Sans KR", "Arial",
        "Calibri", "Cambria", "Consolas", "Segoe UI", "Times New Roman"}
