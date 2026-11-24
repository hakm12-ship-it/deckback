"""The preset pattern table (ruling M5-R10): harness/atlas/pattern_presets.py's output, checked without PowerPoint."""

import re

import pymupdf

from harness.atlas import pattern_presets
from harness.atlas.drawingml import PRST_PATTERN


def committed():
    text = pattern_presets.TABLE.read_text(encoding="utf-8")
    return [(name, [int(v, 16) for v in rows.split(", ")])
            for name, rows in re.findall(r"\{ prst: '(\w+)', rows: \[([0-9a-fx, ]+)\] \}", text)]


def test_the_committed_table_is_what_the_script_writes_of_its_entries():
    entries = committed()
    assert pattern_presets.table_text(entries) == pattern_presets.TABLE.read_text(encoding="utf-8")


def test_the_table_holds_valid_presets_in_order_the_legacy_hatches_last():
    names = [name for name, _ in committed()]
    assert len(names) == len(set(names)) == 51
    assert set(names) <= set(PRST_PATTERN)
    picker = [n for n in names if n not in pattern_presets.LEGACY]
    legacy = [n for n in names if n in pattern_presets.LEGACY]
    assert names == picker + legacy
    assert picker == [n for n in PRST_PATTERN if n in picker]
    assert all(len(rows) == 8 and all(0 <= r <= 255 for r in rows) for _, rows in committed())


def test_cell_bits_reads_a_2x_cell_and_refuses_three_colours(tmp_path):
    """A one-page PDF with a tiling pattern of one 16 x 16 image (narHorz at 2 px a bit), as PowerPoint writes one."""
    def pdf_of(pixels, name):
        doc = pymupdf.open()
        page = doc.new_page(width=960, height=540)
        image = doc.get_new_xref()
        doc.update_object(image, "<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceRGB "
                                 "/BitsPerComponent 8 >>")
        doc.update_stream(image, bytes(pixels))
        pattern = doc.get_new_xref()
        doc.update_object(pattern, f"<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 16 16] "
                                   f"/XStep 16 /YStep 16 /Matrix [.375 0 0 .375 72 468] "
                                   f"/Resources << /XObject << /Im1 {image} 0 R >> >> >>")
        doc.update_stream(pattern, b"q 16 0 0 16 0 0 cm /Im1 Do Q")
        doc.xref_set_key(page.xref, "Resources", f"<< /Pattern << /P1 {pattern} 0 R >> >>")
        path = tmp_path / name
        doc.save(path)
        doc.close()
        return pymupdf.open(path)

    rows = [0xFF, 0x00] * 4
    pixels = []
    for y in range(16):
        for x in range(16):
            on = rows[y // 2] >> (7 - x // 2) & 1
            pixels += [0, 0, 0] if on else [255, 255, 255]
    doc = pdf_of(pixels, "two.pdf")
    bits, k, _ = pattern_presets.cell_bits(doc, doc[0])
    assert (bits, k) == (rows, 2)
    pixels[:3] = [21, 21, 21]
    doc = pdf_of(pixels, "three.pdf")
    try:
        pattern_presets.cell_bits(doc, doc[0])
        raise AssertionError("a third colour was read")
    except pattern_presets.NotTwoColour:
        pass
