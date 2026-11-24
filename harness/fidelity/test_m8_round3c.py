"""M8 round 3c: M8-R13, the harness reads family and style of a font whose name table a producer rewrote to the subset tag
the way the converter does (scene/fonts.ts describe and taggedStyle); S7's off-page glyph filter uses each glyph's box.

Fonts here are tiny fontTools fonts (harness.oracle.make_vertical.make_font), their names rewritten as Adobe PDF Library
and iLovePDF do; no installed font is needed.
"""

import io

import pymupdf
from fontTools.ttLib import TTFont

from harness.fidelity import pdf_facts, pptx_facts, structural
from harness.fonts.program import FontProgram, read_program
from harness.oracle.make_vertical import make_font


def rewritten_font(tagged, style_name="Regular", fs_selection=None, drop_os2=False):
    """A font whose nameID 1, 4 and 6 are the tagged PostScript name and nameID 2 is `style_name` (PDFMaker's rewrite)."""
    font = TTFont(io.BytesIO(make_font("Deck Sans", "Regular", "DeckSans-Regular")))
    for record in font["name"].names:
        if record.nameID in (1, 4, 6):
            record.string = tagged
        elif record.nameID == 2:
            record.string = style_name
    if drop_os2:
        del font["OS/2"]
    elif fs_selection is not None:
        font["OS/2"].fsSelection = fs_selection
    buf = io.BytesIO()
    font.save(buf)
    return buf.getvalue()


def pdf_with_font(tmp_path, font_bytes, basefont, descriptor_entries=""):
    """A one-page PDF drawing 'Hello' in the font, the BaseFont and descriptor written as given."""
    doc = pymupdf.open()
    page = doc.new_page(width=960, height=540)
    page.insert_font(fontname="FX", fontbuffer=font_bytes)
    page.insert_text((100, 100), "Hello", fontname="FX", fontsize=20)
    for xref, *_rest in page.get_fonts(full=True):
        targets = [xref]
        kind, value = doc.xref_get_key(xref, "DescendantFonts")
        if kind == "array":
            targets += [int(v) for v in value.strip("[]").split() if v.isdigit()][:1]
        for target in targets:
            doc.xref_set_key(target, "BaseFont", "/" + basefont)
            kind, value = doc.xref_get_key(target, "FontDescriptor")
            if kind == "xref":
                number = int(value.split()[0])
                doc.xref_set_key(number, "FontName", "/" + basefont)
                for key, raw in descriptor_entries:
                    doc.xref_set_key(number, key, raw)
    path = tmp_path / "tagged.pdf"
    doc.save(str(path))
    return path


def facts_of(path):
    page = pdf_facts.page_facts(path, 0)
    span = next(s for s in page.spans if s["text"].strip())
    font = next(f for f in page.fonts if f["embedded"])
    return page, span, font


# ---- the pieces ---------------------------------------------------------------------------------------------------


def test_pdf_text_string_reads_literal_hex_and_utf16():
    assert pdf_facts._pdf_text_string("(Noto Sans)") == "Noto Sans"
    assert pdf_facts._pdf_text_string(r"(a\(b\)\101)") == "a(b)A"
    assert pdf_facts._pdf_text_string("<FEFFD55CAE00>") == "한국"[0] + "글"
    assert pdf_facts._pdf_text_string("<4142>") == "AB"
    assert pdf_facts._pdf_text_string("/Name") is None


def test_tagged_font_is_none_for_a_font_whose_names_are_not_tagged():
    program = FontProgram("sfnt", names={1: "Deck Sans", 2: "Bold"}, fs_selection=0x20)
    assert pdf_facts.tagged_font(program, {"family": "Other"}, "ABCDEF+DeckSans-Bold") is None


def test_tagged_font_family_comes_from_the_descriptor_else_the_untagged_name():
    program = FontProgram("sfnt", names={1: "ABCDEF+DeckSans-Bold", 2: "Regular"}, fs_selection=0x40)
    assert pdf_facts.tagged_font(program, {"family": "Deck Sans"}, "ABCDEF+DeckSans-Bold")[0] == "Deck Sans"
    assert pdf_facts.tagged_font(program, {}, "ABCDEF+DeckSans-Bold")[0] == "DeckSans"
    # a Korean /FontFamily is the family whatever its script
    assert pdf_facts.tagged_font(program, {"family": "맑은 고딕"}, "ABCDEF+X")[0] == "맑은 고딕"


def test_tagged_font_style_is_the_os2_bits_then_the_descriptor_then_the_basefont_suffix():
    def style(fs, descriptor, basefont="ABCDEF+DeckSans"):
        names = {1: "ABCDEF+DeckSans", 2: "Regular"}
        return pdf_facts.tagged_font(FontProgram("sfnt", names=names, fs_selection=fs), descriptor, basefont)[1:]

    assert style(0x20 | 0x01, {"family": "F"}) == (True, True)
    assert style(0x40, {"family": "F", "weight": 700, "flags": 1 << 6}) == (False, False)  # OS/2 is believed
    assert style(None, {"family": "F", "weight": 700}) == (True, False)
    assert style(None, {"family": "F", "flags": 1 << 18}) == (True, False)  # ForceBold
    assert style(None, {"family": "F", "flags": 1 << 6}) == (False, True)  # Italic
    # no /FontFamily: the BaseFont's style suffix counts, whatever OS/2 says
    assert style(0x40, {}, "ABCDEF+DeckSans-BoldItalic") == (True, True)
    assert style(None, {"flags": 32}, "ABCDEF+DeckSans,Bold") == (True, False)
    # with a /FontFamily the suffix adds nothing
    assert style(0x40, {"family": "F"}, "ABCDEF+DeckSans-BoldItalic") == (False, False)


def test_program_reads_fs_selection():
    assert read_program(rewritten_font("ABCDEF+X", fs_selection=0x21)).fs_selection == 0x21
    assert read_program(rewritten_font("ABCDEF+X", drop_os2=True)).fs_selection is None


# ---- the PDF's facts ----------------------------------------------------------------------------------------------


def test_facts_of_a_rewritten_font_use_font_family_and_os2(tmp_path):
    path = pdf_with_font(tmp_path, rewritten_font("ABCDEF+DeckSans-BoldItalic", fs_selection=0x01), "ABCDEF+DeckSans-BoldItalic",
                         [("FontFamily", "(Deck Sans)")])
    _page, span, font = facts_of(path)
    assert font["family_name1"] == "Deck Sans" and span["family"] == "Deck Sans"
    assert (span["bold"], span["italic"]) == (False, True)  # OS/2 bit 0; the name's own ,BoldItalic is no SIMULATED suffix


def test_facts_read_a_utf16_font_family_in_the_latin_slot(tmp_path):
    path = pdf_with_font(tmp_path, rewritten_font("ABCDEF+KoreanSans", fs_selection=0x40), "ABCDEF+KoreanSans",
                         [("FontFamily", "<FEFF" + "맑은 고딕".encode("utf-16-be").hex() + ">")])
    _page, span, font = facts_of(path)
    assert font["family_name1"] == "맑은 고딕"
    assert "맑은 고딕" in font["family_names1"]


def test_facts_of_a_font_with_no_os2_use_the_descriptor_flags(tmp_path):
    path = pdf_with_font(tmp_path, rewritten_font("ABCDEF+DeckSerif", drop_os2=True), "ABCDEF+DeckSerif",
                         [("FontFamily", "(Deck Serif)"), ("FontWeight", "700"), ("Flags", str((1 << 6) | 32))])
    _page, span, _font = facts_of(path)
    assert span["family"] == "Deck Serif" and (span["bold"], span["italic"]) == (True, True)


def test_facts_without_font_family_keep_the_basefont_suffix_and_family(tmp_path):
    path = pdf_with_font(tmp_path, rewritten_font("ABCDEF+DeckMono-Bold", fs_selection=0x40), "ABCDEF+DeckMono-Bold")
    _page, span, font = facts_of(path)
    assert font["family_name1"] == "DeckMono" and (span["bold"], span["italic"]) == (True, False)


def test_an_untagged_font_is_read_as_before(tmp_path):
    path = pdf_with_font(tmp_path, make_font("Deck Sans", "Bold", "DeckSans-Bold"), "ABCDEF+DeckSans-Bold",
                         [("FontFamily", "(Other Family)")])
    _page, span, font = facts_of(path)
    assert font["family_name1"] == "Deck Sans" and span["bold"] is True


def _s6_for(page, typeface):
    run = {"text": "Hello", "size": 20.0, "color": {"rgb": [0, 0, 0], "alpha": 1.0}, "typeface_latin": typeface,
           "typeface_ea": typeface, "typeface_cs": typeface, "bold": False, "italic": False, "shape": "box"}
    slide = pptx_facts.SlideFacts(index=0, slide_count=1, size_emu=(12192000, 6858000), size_pt=(960, 540), runs=[run],
                                  typefaces=[typeface])
    return structural.s6(page, slide)


def test_s6_accepts_the_descriptor_family_a_rewritten_font_is_written_with(tmp_path):
    path = pdf_with_font(tmp_path, rewritten_font("ABCDEF+DeckSans-Bold", fs_selection=0x20), "ABCDEF+DeckSans-Bold",
                         [("FontFamily", "(Deck Sans)")])
    page = pdf_facts.page_facts(path, 0)
    assert _s6_for(page, "Deck Sans")["status"] == "pass"
    assert _s6_for(page, "DeckSans-Bold")["status"] == "fail"


# ---- S7's off-page glyph filter uses the glyph's real box -----------------------------------------------------------


def _page_of(tmp_path, texts):
    from harness.fidelity import roundtrip
    from harness.oracle.mupdf_inventory import inventory

    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)
    for point, text, size in texts:
        page.insert_text(point, text, fontsize=size)
    path = tmp_path / "glyphs.pdf"
    doc.save(str(path))
    return roundtrip.on_page(inventory(str(path), detail=False, paths=True, glyph_sizes=True)["pages"][0])


def test_a_glyph_wholly_off_the_page_by_its_real_box_is_ignored_though_its_reach_square_touches_the_page(tmp_path):
    # 'H' at 40 pt, origin x = -45: its box (x -41.7 .. -19.2) is off the page; the 1.5 x size square around the origin
    # (x -105 .. 15) overlaps it, which the old filter kept
    page = _page_of(tmp_path, [((-45, 100), "H", 40), ((100, 100), "OK", 20)])
    assert "".join(g["u"] for g in page["glyphs"]) == "OK"


def test_a_glyph_partly_on_the_page_is_kept(tmp_path):
    # 'H' origin x = -5: the box reaches x 6.6 on the page
    page = _page_of(tmp_path, [((-5, 100), "H", 40)])
    assert "".join(g["u"] for g in page["glyphs"]) == "H"


def test_a_space_off_the_page_by_its_origin_is_ignored_and_one_on_the_page_kept(tmp_path):
    page = _page_of(tmp_path, [((-60, 100), "A ", 20), ((100, 100), "B ", 20)])
    assert "".join(g["u"] for g in page["glyphs"]) == "B "


def test_an_encrypted_pdf_is_read_by_names_alone_as_the_converter_cannot_read_its_descriptors(tmp_path):
    """The converter's raw reader refuses an encrypted file (M2-R6): its fonts get names from pdf.js only, so a rewritten
    name table is read as before (the tag taken off), not through /FontFamily and OS/2."""
    path = pdf_with_font(tmp_path, rewritten_font("ABCDEF+DeckSans-Bold", fs_selection=0x40), "ABCDEF+DeckSans-Bold",
                         [("FontFamily", "(Deck Sans)")])
    with pymupdf.open(str(path)) as doc:
        doc.save(str(tmp_path / "locked.pdf"), encryption=pymupdf.PDF_ENCRYPT_RC4_128, owner_pw="owner", user_pw="")
    _page, span, font = facts_of(tmp_path / "locked.pdf")
    assert font["family_name1"] == "ABCDEF+DeckSans-Bold"  # the tagged name: S6 and S2 take the tag off
    assert (span["bold"], span["italic"]) == (False, False)
