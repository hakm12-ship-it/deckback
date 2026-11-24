"""fontversion.py (M8-R9): an embedded font against the PC's copy of it, by version. The X slides of
round2-analysis.md are tests by id, from a committed fixture of names and versions (no font bytes)."""

import io
import json
from pathlib import Path

import pytest

from harness.fonts import fontversion

FIXTURE = json.loads(Path(__file__).with_name("font-versions-m8r9.fixture.json").read_text(encoding="utf-8"))


def facts(ps, version, revision, family=None, sub="Regular"):
    return {"ps": ps, "family": family or ps.split("-")[0], "subfamily": sub, "version": version, "revision": revision}


def test_the_fixture_holds_names_and_versions_only():
    allowed = {"ps", "family", "subfamily", "version", "revision"}
    for slide in FIXTURE["slides"].values():
        for item in slide["embedded"] + slide["pc"]:
            assert set(item) - {"advances"} == allowed


@pytest.mark.parametrize("slide, differing", [
    ("b-acb674096b-127", ["Nunito-Bold", "Nunito-ExtraLight"]),  # the PDF embeds Nunito 3.000, the PC's cloud copy is 3.601
    ("b-acb674096b-46", ["Nunito-Black", "Nunito-ExtraLight"]),
    ("b-d629f67e73-16", ["Roboto-Bold"]),  # Roboto Bold 3.004: the PC has Roboto Regular 2.137 only
])
def test_the_x_slides_of_the_analysis_have_a_font_in_another_version(slide, differing):
    entry = FIXTURE["slides"][slide]
    pc = fontversion.PcFonts(entry["pc"])
    assert sorted(e["ps"] for e in fontversion.differing(entry["embedded"], pc)) == differing
    assert sorted(entry["differing"]) == differing  # the fixture was written by the same rule
    assert sorted(e["ps"] for e in fontversion.differing(entry["embedded"], pc, widths=False)) == entry["versionOnly"]


@pytest.mark.parametrize("slide, version_only", [
    ("b-088e7f46c8-9", ["ArialMT"]),  # Arial 7.05 in the PDF, 7.06 here: a patch bump with the same advances
    ("b-186f911a3c-2", ["Calibri"]),  # Calibri 6.26 against 6.27
    ("b-d629f67e73-15", ["Catamaran-Bold", "Catamaran-Regular"]),  # Catamaran 2.000 against 1.100, same advances
])
def test_a_version_difference_with_the_same_advances_is_not_flagged(slide, version_only):
    entry = FIXTURE["slides"][slide]
    pc = fontversion.PcFonts(entry["pc"])
    assert sorted(e["ps"] for e in fontversion.differing(entry["embedded"], pc, widths=False)) == version_only
    assert fontversion.differing(entry["embedded"], pc) == []
    # amended M8-R9: without advances to compare (an unreadable cmap) the version string alone does not count; the font
    # is reported as version-unverifiable instead
    bare = [{k: v for k, v in e.items() if k != "advances"} for e in entry["embedded"]]
    unverifiable = []
    assert fontversion.differing(bare, pc, unverifiable=unverifiable) == []
    assert sorted(e["ps"] for e in unverifiable) == version_only
    assert sorted(e["ps"] for e in fontversion.differing(bare, pc, widths=False)) == version_only  # the literal rule


def test_fonts_with_no_common_glyph_are_unverifiable_not_flagged():
    embedded = dict(facts("Probe-Regular", "Version 1.0", 1.0), advances={"65": 600})
    copy = dict(facts("Probe-Regular", "Version 2.0", 2.0), advances={"66": 700})
    pc = fontversion.PcFonts([copy])
    unverifiable = []
    assert fontversion.differing([embedded], pc, unverifiable=unverifiable) == []
    assert unverifiable == [embedded]
    # a verifiable difference is flagged and not counted as unverifiable
    wider = dict(copy, advances={"65": 700})
    unverifiable = []
    assert fontversion.differing([embedded], fontversion.PcFonts([wider]), unverifiable=unverifiable) == [embedded]
    assert unverifiable == []


@pytest.mark.parametrize("slide", ["b-9d2ceab226-5", "b-9d2ceab226-6"])
def test_a_slide_whose_fonts_are_the_pcs_version_is_not_flagged(slide):
    """b-9d2ceab226-6 is an X slide of the analysis, but the PC's Fira Sans (4.203) is the PDF's: by version it is not
    flagged (the analysis' reason for it is not a version difference, see round2b-report.md)."""
    entry = FIXTURE["slides"][slide]
    assert fontversion.differing(entry["embedded"], fontversion.PcFonts(entry["pc"])) == []


def test_same_version_compares_the_string_and_the_revision():
    a = facts("X-Regular", "Version 3.000", 3.0)
    assert fontversion.same_version(a, dict(a))
    assert not fontversion.same_version(a, facts("X-Regular", "Version 3.601", 3.601))
    assert not fontversion.same_version(a, facts("X-Regular", "Version 3.000", 3.1))  # the revision alone
    assert not fontversion.same_version(a, facts("X-Regular", "Version 3.001", 3.0))  # the string alone
    assert fontversion.same_version({"version": None, "revision": 3.0}, facts("X-Regular", "Version 9", 3.0))  # what both have
    assert not fontversion.same_version({"version": None, "revision": None}, a)  # nothing to compare


def test_the_postscript_name_decides_then_the_family_and_a_missing_font_is_not_flagged():
    pc = fontversion.PcFonts([facts("Roboto-Regular", "Version 2.137", 2.137, "Roboto"),
                              facts("Nunito-Bold", "Version 3.000", 3.0, "Nunito", "Bold")])
    # same PostScript name, same version: fine, even if the family has another copy
    assert fontversion.differing([facts("Nunito-Bold", "Version 3.000", 3.0, "Nunito", "Bold")], pc) == []
    # no copy by name, the family's copy is another version: flagged
    assert fontversion.differing([facts("Roboto-Bold", "Version 3.004", 3.004, "Roboto", "Bold")], pc, widths=False)  # names and versions: the literal rule
    # the PC does not have the font at all: not this exception
    assert fontversion.differing([facts("Calibri-Bold", "Version 6", 6.0, "Calibri", "Bold")], pc) == []
    assert fontversion.differing([None], pc) == []
    # case does not matter
    assert fontversion.differing([facts("nunito-bold", "Version 3.000", 3.0, "NUNITO")], pc) == []


def build_font(path, version, revision, ps="Probe-Regular", family="Probe", advance=600):
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    builder = FontBuilder(1000, isTTF=True)
    builder.setupGlyphOrder([".notdef", "A"])
    builder.setupCharacterMap({65: "A"})
    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((0, 500))
    pen.lineTo((500, 500))
    pen.closePath()
    glyph = pen.glyph()
    builder.setupGlyf({".notdef": glyph, "A": glyph})
    builder.setupHorizontalMetrics({".notdef": (500, 0), "A": (advance, 0)})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": family, "styleName": "Regular", "psName": ps,
                            "version": version, "fullName": f"{family} Regular"})
    builder.setupOS2()
    builder.setupPost()
    builder.font["head"].fontRevision = revision
    if path is None:
        buffer = io.BytesIO()
        builder.save(buffer)
        return buffer.getvalue()
    builder.save(path)
    return path


def test_program_version_reads_the_names_and_the_version_of_a_font_program():
    got = fontversion.program_version(build_font(None, "Version 3.601; hinted", 3.601))
    assert got == {"ps": "Probe-Regular", "family": "Probe", "subfamily": "Regular", "version": "Version 3.601; hinted",
                   "revision": 3.601}
    assert fontversion.program_version(b"") is None
    assert fontversion.program_version(b"%!PS-AdobeFont not an sfnt") is None  # a bare Type 1 / CFF: nothing to read
    assert fontversion.program_version(b"\x00\x01\x00\x00" + b"\x00" * 8) is None  # damaged: never raises


def test_the_pcs_fonts_come_from_the_registry_files_and_the_cloud_folder(tmp_path, monkeypatch):
    cloud = tmp_path / "Probe"
    cloud.mkdir()
    build_font(cloud / "123.ttf", "Version 2.0", 2.0)
    monkeypatch.setattr(fontversion, "pc_font_files", lambda cloud_folder=None: [str(cloud / "123.ttf")])
    fontversion.pc_index.cache_clear()
    try:
        index = fontversion.pc_index()
        assert [c["version"] for c in index.versions_of(facts("Probe-Regular", "Version 1.0", 1.0))] == ["Version 2.0"]
        assert fontversion.differing([facts("Probe-Regular", "Version 1.0", 1.0)], index, widths=False)
    finally:
        fontversion.pc_index.cache_clear()


def test_pc_font_files_lists_the_cloud_folder(tmp_path, monkeypatch):
    (tmp_path / "Fam").mkdir()
    (tmp_path / "Fam" / "1.ttf").write_bytes(b"x")
    (tmp_path / "Fam" / "notes.txt").write_bytes(b"x")
    monkeypatch.setattr("harness.fonts.fontcheck._registry_font_files", lambda: [])
    assert fontversion.pc_font_files(tmp_path) == [str(tmp_path / "Fam" / "1.ttf")]


def test_advances_are_read_from_the_program_and_compared_with_the_pcs_copy(tmp_path):
    embedded = fontversion.program_version(build_font(None, "Version 3.000", 3.0), advances=True)
    assert embedded["advances"] == {"65": 600.0}
    same = build_font(tmp_path / "same.ttf", "Version 3.001", 3.001)  # a patch bump: the same advance
    wider = build_font(tmp_path / "wider.ttf", "Version 3.601", 3.601, advance=640)
    copy_same, copy_wider = fontversion.file_versions(same)[0], fontversion.file_versions(wider)[0]
    assert fontversion.layout_differs(embedded, copy_same) is False
    assert fontversion.layout_differs(embedded, copy_wider) is True
    assert fontversion.layout_differs({"advances": {}}, copy_wider) is None  # nothing to compare
    assert fontversion.differing([embedded], fontversion.PcFonts([copy_same])) == []
    assert fontversion.differing([embedded], fontversion.PcFonts([copy_same]), widths=False) == [embedded]
    assert fontversion.differing([embedded], fontversion.PcFonts([copy_wider])) == [embedded]
    assert fontversion.needs_advances(embedded, fontversion.PcFonts([copy_wider]))
    assert not fontversion.needs_advances(embedded, fontversion.PcFonts([{**copy_same, "version": "Version 3.000",
                                                                         "revision": 3.0}]))
