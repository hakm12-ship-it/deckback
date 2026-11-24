"""Ruling M8-R8 (review C1): a font is symbolic only when its family is a known symbol family AND it is flagged symbolic
or has no Unicode cmap subtable. One list, packages/core/src/fonts/symbol-families.ts, read by the converter and here."""

import io

import pytest
from fontTools.ttLib import TTFont
from fontTools.ttLib.tables._c_m_a_p import CmapSubtable

from harness.fonts.program import is_symbol_family, symbol_cmap, symbol_families
from harness.fonts.test_program import ttf


def with_cmap(family, tables):
    """A tiny program named `family` whose cmap has exactly `tables`: [(platformID, platEncID, {code: glyph name})]."""
    font = TTFont(io.BytesIO(ttf(names={"familyName": family, "styleName": "Regular", "psName": family.replace(" ", "")})))
    cmap = font["cmap"]
    cmap.tables = []
    for platform, encoding, mapping in tables:
        sub = CmapSubtable.newSubtable(4)
        sub.platformID, sub.platEncID, sub.language, sub.cmap = platform, encoding, 0, dict(mapping)
        cmap.tables.append(sub)
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


def test_the_list_is_the_converters_one_and_has_the_office_symbol_fonts():
    families = symbol_families()
    for name in ("Wingdings", "Wingdings 2", "Wingdings 3", "Webdings", "Symbol", "SymbolMT", "MT Extra", "Marlett",
                 "Bookshelf Symbol 7", "MS Reference Specialty"):
        assert name in families
    assert len(families) == len(set(families))


@pytest.mark.parametrize("name", ["Wingdings", "BCDIEE+Wingdings-Regular", "Wingdings2", "SymbolMT", "MT-Extra",
                                  "ABCDEF+Webdings", "Symbol,Bold", "MS-ReferenceSpecialty", "BookshelfSymbolSeven"])
def test_symbol_family_names(name):
    assert is_symbol_family(name)


@pytest.mark.parametrize("name", ["MicrosoftSansSerif", "Arial-BoldMT", "Segoe UI Symbol", "SymbolicSans", "", None,
                                  "Constantia"])
def test_text_family_names_are_not_symbol_families(name):
    assert not is_symbol_family(name)


def test_a_text_font_with_a_3_0_cmap_beside_a_mac_one_and_flags_6_is_not_symbolic_microsoftsansserif():
    data = with_cmap("Microsoft Sans Serif", [(1, 0, {65: "A"}), (3, 0, {0xF041: "A", 65: "A"})])
    assert symbol_cmap(data, "ABCDEF+MicrosoftSansSerif", flagged=True) is None
    assert symbol_cmap(data, "ABCDEF+MicrosoftSansSerif", flagged=False) is None


def test_a_symbol_family_needs_the_flag_or_a_cmap_with_no_unicode_subtable():
    only = with_cmap("Wingdings", [(3, 0, {0xF041: "A"})])
    assert symbol_cmap(only, "ABCDEF+Wingdings-Regular") == {0xF041: 1}  # the family, a (3,0)-only cmap
    assert symbol_cmap(only, "") == {0xF041: 1}  # the program's own nameID 1 says it
    mac = with_cmap("Wingdings 2", [(1, 0, {65: "A"}), (3, 0, {0xF041: "A"})])
    assert symbol_cmap(mac, "") == {0xF041: 1}
    both = with_cmap("Wingdings", [(3, 0, {0xF041: "A"}), (3, 1, {65: "A"})])
    assert symbol_cmap(both, "Wingdings") is None  # a Unicode subtable, no flag
    assert symbol_cmap(both, "Wingdings", flagged=True) == {0xF041: 1}
    assert symbol_cmap(with_cmap("Wingdings", [(3, 1, {65: "A"})]), "Wingdings", flagged=True) is None  # no (3,0) at all


def test_a_numbered_font_is_known_by_its_basefont_or_nameid_16():
    data = with_cmap("1", [(3, 0, {0xF041: "A"})])
    assert symbol_cmap(data, "BCDIEE+Wingdings-Regular") == {0xF041: 1}
    assert symbol_cmap(data, "BCDIEE+SomethingElse") is None


def _type0_pdf(program, flags=4, base_font="BCDIEE+Wingdings-Regular"):
    """An in-memory PDF with one Type0 Identity-H font holding `program`; its ToUnicode names CID 1 an arrow."""
    import pymupdf

    doc = pymupdf.open()
    doc.new_page()
    refs = [doc.get_new_xref() for _ in range(5)]
    font, descendant, descriptor, file, to_unicode = refs
    doc.update_object(font, f"<< /Type /Font /Subtype /Type0 /BaseFont /{base_font} /Encoding /Identity-H "
                            f"/DescendantFonts [{descendant} 0 R] /ToUnicode {to_unicode} 0 R >>")
    doc.update_object(descendant, f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{base_font} /CIDSystemInfo "
                                  f"<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
                                  f"/FontDescriptor {descriptor} 0 R >>")
    doc.update_object(descriptor, f"<< /Type /FontDescriptor /FontName /{base_font} /Flags {flags} "
                                  f"/FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 "
                                  f"/StemV 80 /FontFile2 {file} 0 R >>")
    doc.update_object(file, "<< >>")
    doc.update_stream(file, program)
    doc.update_object(to_unicode, "<< >>")
    doc.update_stream(to_unicode, b"begincmap 1 beginbfchar <0001> <2192> endbfchar endcmap")
    return doc, font


def test_the_pua_of_a_glyph_whose_lowest_code_is_not_in_f000_f0ff_is_f000_plus_that_code_review_m4():
    """The converter's `own` takes F000 + the LOWEST cmap code of the glyph, not the CID (they differ here: CID 1,
    code 0x41)."""
    from harness.fidelity.pdf_facts import symbol_codes

    program = with_cmap("Wingdings", [(3, 0, {0x41: "A"})])
    doc, font = _type0_pdf(program)
    assert symbol_codes(doc, font, program, "BCDIEE+Wingdings-Regular") == {"→": [0xF041]}


def test_a_flag_6_text_font_has_no_symbol_codes_even_with_a_3_0_cmap():
    from harness.fidelity.pdf_facts import symbol_codes

    program = with_cmap("Microsoft Sans Serif", [(1, 0, {0x41: "A"}), (3, 0, {0x41: "A"})])
    doc, font = _type0_pdf(program, flags=6, base_font="ABCDEF+MicrosoftSansSerif")
    assert symbol_codes(doc, font, program, "ABCDEF+MicrosoftSansSerif") is None
