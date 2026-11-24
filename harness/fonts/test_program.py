"""Tests for harness/fonts/program.py, the one reader of embedded font programs (minor m18)."""

import io

import pymupdf
import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

from harness.fonts import program
from harness.fonts.program import read_program, strip_subset_tag


def ttf(names=None, fvar=False, records=()):
    """A tiny TrueType program. `names` as FontBuilder.setupNameTable takes them (Windows English and Mac records);
    `records` adds (nameID, platformID, platEncID, langID, text) records on top."""
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder([".notdef", "A"])
    fb.setupCharacterMap({65: "A"})
    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((0, 500))
    pen.lineTo((500, 500))
    pen.closePath()
    glyph = pen.glyph()
    fb.setupGlyf({".notdef": glyph, "A": glyph})
    fb.setupHorizontalMetrics({".notdef": (500, 0), "A": (500, 0)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable(names if names is not None else
                      {"familyName": "Test Sans", "styleName": "Bold", "psName": "TestSans-Bold"})
    for name_id, platform, encoding, language, text in records:
        fb.font["name"].setName(text, name_id, platform, encoding, language)
    fb.setupOS2()
    fb.setupPost()
    if fvar:
        fb.setupFvar([("wght", 100, 400, 900, "Weight")], [])
    buf = io.BytesIO()
    fb.save(buf)
    return buf.getvalue()


def test_an_sfnt_program_gives_its_tables_and_names():
    font = read_program(ttf())
    assert font.format == "sfnt" and font.error is None
    assert (font.name(1), font.name(2), font.name(6)) == ("Test Sans", "Bold", "TestSans-Bold")
    assert "glyf" in font.tables and "CFF " not in font.tables
    assert font.variable is False and font.num_glyphs == 2
    assert read_program(ttf(fvar=True)).variable is True


def test_names_prefer_the_windows_english_record_then_any_windows_record_then_the_mac_one():
    # NanumGothic-ExtraBold: its Mac record says "NanumGothic", its Windows record "NanumGothicExtraBold"
    both = read_program(ttf(records=[(1, 1, 0, 0, "Mac Family"), (1, 3, 1, 0x409, "Windows Family")]))
    assert both.name(1) == "Windows Family"
    korean = ttf(names={"psName": "Only-Korean"}, records=[(1, 3, 1, 0x412, "한국어 가족"), (1, 1, 0, 0, "Mac Family")])
    assert read_program(korean).name(1) == "한국어 가족"
    mac_only = ttf(names={"psName": "Only-Mac"}, records=[(1, 1, 0, 0, "Mac Family")])
    assert read_program(mac_only).name(1) == "Mac Family"
    assert read_program(mac_only).name(16) is None


def test_families_lists_every_nameid_1_record_english_first():
    # ruling M3-R44: S6 takes a typeface that is any nameID 1 record of the font, in any language ("Malgun Gothic /
    # 맑은 고딕"); `names` keeps one record per nameID, English first, for S2's styles
    font = read_program(ttf(names={"familyName": "Malgun Gothic", "styleName": "Regular", "psName": "MalgunGothic"},
                            records=[(1, 3, 1, 0x412, "맑은 고딕"), (1, 3, 1, 0x411, "マルグン")]))
    assert font.name(1) == "Malgun Gothic"
    assert font.families[0] == "Malgun Gothic"
    assert set(font.families) == {"Malgun Gothic", "맑은 고딕", "マルグン"}
    assert len(font.families) == len(set(font.families))  # the Mac and Windows English records give one name
    assert "MalgunGothic" not in font.families  # nameID 6 is no family
    assert read_program(ttf()).families == ("Test Sans",)
    assert read_program(b"").families == () and read_program(ttf()[:60]).families == ()


def test_a_bare_cff_program_is_reported_not_raised():
    cff = pymupdf.Font("tiro").buffer  # MuPDF's built-in Nimbus Roman: a CFF program without an sfnt wrapper
    assert cff[:4] == b"\x01\x00\x04\x02"
    font = read_program(cff)
    assert font.format == "raw-cff-or-type1"
    assert font.names == {} and font.tables == () and font.error is None


def test_a_damaged_sfnt_program_is_reported_with_the_error_type_only():
    damaged = ttf()[:60]  # the table directory points past the end
    font = read_program(damaged)
    assert font.format == "damaged"
    assert font.error and " " not in font.error  # an exception type name, never its text
    assert font.names == {}


def test_no_program_at_all():
    assert read_program(b"").format == "empty"
    assert read_program(None).format == "empty"


def test_strip_subset_tag():
    assert strip_subset_tag("ABCDEF+GothicA1-Regular") == "GothicA1-Regular"
    assert strip_subset_tag("GothicA1-Regular") == "GothicA1-Regular"
    assert strip_subset_tag("abcdef+Lower") == "abcdef+Lower"  # a subset tag is six capitals
    assert strip_subset_tag(None) == ""


@pytest.mark.parametrize("module", ["harness.atlas.export", "harness.atlas.corpuscheck", "harness.fidelity.pdf_facts"])
def test_the_harness_has_one_embedded_font_reader(module):
    import importlib
    import inspect

    source = inspect.getsource(importlib.import_module(module))
    assert "TTFont(" not in source and "SFNT_MAGICS" not in source and "getName(" not in source, module
    assert program.SUBSET_TAG.pattern == r"^[A-Z]{6}\+"


# ---- M8 round 1c: a numbered family is read the way the converter's numberedFamily reads it -------------------------

def _prog(**names):
    from harness.fonts.program import FontProgram
    ids = {"family": 1, "sub": 2, "full": 4, "ps": 6, "typo": 16, "typosub": 17}
    return FontProgram("sfnt", names={ids[k]: v for k, v in names.items()}, families=(names["family"],))


def test_numbered_family_prefers_the_typographic_family_with_a_non_plain_weight():
    assert _prog(family="1", typo="Catamaran", typosub="Light").family_name == "Catamaran Light"
    assert _prog(family="1", typo="Catamaran", typosub="Bold Italic").family_name == "Catamaran"
    assert _prog(family="1", typo="Catamaran", typosub="Regular").family_name == "Catamaran"


def test_numbered_family_falls_back_to_the_full_name_without_number_and_style():
    assert _prog(family="2", sub="Bold", full="2Proxima Nova Bold").family_name == "Proxima Nova"


def test_numbered_family_falls_back_to_the_postscript_name():
    assert _prog(family="11", ps="Catamaran-Bold").family_name == "Catamaran"
    assert _prog(family="11", ps="Catamaran-Light").family_name == "Catamaran Light"
    assert _prog(family="11", ps="Catamaran").family_name == "Catamaran"


def test_numbered_family_keeps_the_number_when_nothing_else_is_a_name():
    assert _prog(family="7").family_name == "7"
    assert _prog(family="7", typo="12", ps="3").family_name == "7"


def test_a_real_family_is_untouched_and_the_number_leaves_family_names():
    assert _prog(family="Malgun Gothic", typo="Zzz").family_name == "Malgun Gothic"
    p = _prog(family="1", typo="Catamaran", typosub="Light")
    assert p.family_names[0] == "Catamaran Light" and "1" not in p.family_names
    q = _prog(family="Arial")
    assert q.family_names == ("Arial",)
