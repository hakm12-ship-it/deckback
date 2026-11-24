#!/usr/bin/env python
"""Write a PDF whose text runs down the page: a Type0 font with the Identity-V CMap (writing mode 1).

The walker's vertical maths is checked against the oracle on it (inventory contract,
docs/decisions/0002-inventory-contract.md §6 glyphs); the fidelity tests use the same builder. The font program is
generated here, so the PDF holds no third-party font.

    harness/.venv/Scripts/python harness/oracle/make_vertical.py <out.pdf>

The page holds the text ABCD in the vertical font, at x 300 from y 100, and a horizontal "Flat" that stays put.
"""

import argparse
import io
import sys
from pathlib import Path

import pymupdf
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

W_PT, H_PT = 960, 540

GLYPHS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789가"  # 가: an East Asian character

IDENTITY_UCS = """/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def
/CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange
4 beginbfchar <0002> <0041> <0003> <0042> <0004> <0043> <0005> <0044> endbfchar
endcmap CMapName currentdict /CMap defineresource pop end end"""


def make_font(family, style, ps_name, weight=None):
    """A TrueType font with a box for every glyph of GLYPHS; nameID 1 = family, 2 = style, 6 = ps_name."""
    fb = FontBuilder(1000, isTTF=True)
    names = [".notdef", "space"] + ["g%04x" % ord(c) for c in GLYPHS]
    fb.setupGlyphOrder(names)
    cmap = {32: "space"}
    cmap.update({ord(c): "g%04x" % ord(c) for c in GLYPHS})
    fb.setupCharacterMap(cmap)
    glyphs = {}
    for name in names:
        pen = TTGlyphPen(None)
        if name != "space":
            pen.moveTo((50, 0))
            pen.lineTo((50, 700))
            pen.lineTo((550, 700))
            pen.lineTo((550, 0))
            pen.closePath()
        glyphs[name] = pen.glyph()
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (600, 50) for name in names})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable({"familyName": family, "styleName": style, "psName": ps_name})
    bold = "Bold" in style.split()
    fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200,
                usWeightClass=weight or (700 if bold else 400), fsSelection=0x20 if bold else 0x40)
    fb.setupPost()
    fb.font["head"].macStyle = 1 if bold else 0
    buf = io.BytesIO()
    fb.save(buf)
    return buf.getvalue()


def vertical_font_pdf(path, dx=0.0, dy=0.0):
    """The text ABCD in a vertical-mode font (Type0, Identity-V: wmode 1, written down the page) at x 300 from
    y 100, and a horizontal "Flat" that stays put."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.insert_text((500, 300), "Flat", fontname="helv", fontsize=24)

    def obj(source, stream=None):
        xref = doc.get_new_xref()
        doc.update_object(xref, source)
        if stream is not None:
            doc.update_stream(xref, stream)
        return xref

    program = obj("<< >>", make_font("Deck Sans", "Regular", "DeckSans-Regular"))
    descriptor = obj("<< /Type /FontDescriptor /FontName /DeckSans-Regular /Flags 32 /FontBBox [0 -200 1000 800] "
                     f"/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 {program} 0 R >>")
    cid = obj("<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DeckSans-Regular /CIDSystemInfo << /Registry (Adobe) "
              f"/Ordering (Identity) /Supplement 0 >> /FontDescriptor {descriptor} 0 R /DW 600 "
              "/CIDToGIDMap /Identity >>")
    to_unicode = obj("<< >>", IDENTITY_UCS.encode("ascii"))
    font = obj(f"<< /Type /Font /Subtype /Type0 /BaseFont /DeckSans-Regular /Encoding /Identity-V /DescendantFonts "
               f"[{cid} 0 R] /ToUnicode {to_unicode} 0 R >>")

    kind, value = doc.xref_get_key(page.xref, "Resources")
    target = int(value.split()[0]) if kind == "xref" else page.xref
    key = "Font" if kind == "xref" else "Resources/Font"
    kind, existing = doc.xref_get_key(target, key)
    entries = existing.strip()[2:-2] if kind == "dict" else ""
    doc.xref_set_key(target, key, f"<< {entries} /FV {font} 0 R >>")
    operators = f"BT /FV 24 Tf 1 0 0 1 {300 + dx} {H_PT - 100 - dy} Tm <0002000300040005> Tj ET"
    content = obj("<< >>", operators.encode("ascii"))
    xrefs = page.get_contents() + [content]
    doc.xref_set_key(page.xref, "Contents", "[" + " ".join(f"{x} 0 R" for x in xrefs) + "]")

    Path(path).parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(path))
    return path


def main(argv=None):
    ap = argparse.ArgumentParser(description="Write a PDF with an Identity-V Type0 font.")
    ap.add_argument("out")
    args = ap.parse_args(argv)
    pymupdf.set_messages(stream=sys.stderr)
    vertical_font_pdf(args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
