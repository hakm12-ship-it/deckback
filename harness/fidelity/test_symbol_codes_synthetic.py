"""pdf_facts.symbol_codes on a synthetic PDF (round 1 review M6): a Type0 symbol font whose /DescendantFonts is an
indirect array (as PowerPoint's export writes it) and whose descendant has a /CIDToGIDMap stream. The case was found on
a real tier-B deck; this test needs no corpus, so CI covers it."""

import pymupdf

from harness.fidelity import pdf_facts
from harness.fonts.program import symbol_cmap
from harness.fonts.test_symbol_families import with_cmap


def build_pdf(path, indirect_array):
    program = with_cmap("Wingdings", [(3, 0, {0xF06C: "A"})])
    gid = symbol_cmap(program, "Wingdings", True)[0xF06C]
    doc = pymupdf.open()
    doc.new_page()

    def new(body, stream=None):
        xref = doc.get_new_xref()
        doc.update_object(xref, body)
        if stream is not None:
            doc.update_stream(xref, stream, new=True)
        return xref

    font_file = new("<<>>", program)
    descriptor = new(f"<</Type/FontDescriptor/FontName/ABCDEF+Wingdings/Flags 4/FontFile2 {font_file} 0 R>>")
    cid_to_gid = new("<<>>", b"\x00\x00" + gid.to_bytes(2, "big"))  # CID 1 draws glyph `gid`
    cid_font = new(f"<</Type/Font/Subtype/CIDFontType2/BaseFont/ABCDEF+Wingdings/FontDescriptor {descriptor} 0 R"
                   f"/CIDToGIDMap {cid_to_gid} 0 R>>")
    descendants = f"{new(f'[{cid_font} 0 R]')} 0 R" if indirect_array else f"[{cid_font} 0 R]"
    to_unicode = new("<<>>", b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 beginbfchar <0001> "
                             b"<2022> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end")
    type0 = new(f"<</Type/Font/Subtype/Type0/BaseFont/ABCDEF+Wingdings/Encoding/Identity-H"
                f"/DescendantFonts {descendants}/ToUnicode {to_unicode} 0 R>>")
    return doc, type0, program


def test_an_indirect_descendant_fonts_array_and_a_cid_to_gid_map_give_the_pua_code(tmp_path):
    for indirect in (True, False):
        doc, type0, program = build_pdf(tmp_path / "x.pdf", indirect)
        assert pdf_facts.symbol_codes(doc, type0, program, "ABCDEF+Wingdings") == {"•": [0xF06C]}
        assert pdf_facts._descriptor_flags(doc, type0) & 4  # the flags are read through the indirect array too
        doc.close()


def test_a_text_font_name_gives_no_symbol_codes_even_with_the_same_structure(tmp_path):
    doc, type0, _ = build_pdf(tmp_path / "x.pdf", True)
    text_font = with_cmap("Microsoft Sans Serif", [(1, 0, {65: "A"}), (3, 0, {0xF041: "A", 65: "A"})])
    assert pdf_facts.symbol_codes(doc, type0, text_font, "ABCDEF+MicrosoftSansSerif") is None
    doc.close()
