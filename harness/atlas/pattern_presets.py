"""PowerPoint's preset pattern bitmaps, measured (ruling M5-R10): the table packages/core/src/passes/pattern-presets.ts.

    harness/.venv/Scripts/python -m harness.atlas.pattern_presets [--out out/patterns] [--pdf <exported pdf>]

1. Builds `<out>/presets.pptx`: one 16:9 slide per ST_PresetPatternVal (drawingml.PRST_PATTERN, 54), each a rect of
   130 x 80 pt filled with the preset in black on white, no line, at a position that moves by a whole pt or two from
   slide to slide (so the export shows where PowerPoint anchors a pattern: on the slide's grid, not the shape's corner).
2. Exports it to `<out>/presets_std.pdf` through export.py (export.ps1 and DeckbackCom.psm1: a GUID temp copy, only the
   PowerPoint it started is quit, nothing is stopped; POWERPNT is recorded before and after). With `--pdf` it reads that
   PDF instead and PowerPoint is not used.
3. Reads each page's one tiling pattern: its cell is one image. Where the image is an exact k x k upscale of an 8 x 8
   cell of two colours, black (the foreground: bit 1) and white, the bits are read by rows from the top of the cell as
   it lies on the slide; a preset PowerPoint exports otherwise (measured: dnDiag, upDiag and diagCross, the legacy
   diagonal hatches, come out smoothed, in three greys) is left out of the table, and keeps its picture tile. The cell's
   corner on the slide must lie on the 6 pt grid of the slide (8 px at 96 dpi), which is where PowerPoint anchors its
   patterns (measured: every cell at the grid, whichever pt the shape is at); a page without one pattern of one image,
   or off that grid, stops the script.
4. Writes the table, each preset as 8 rows of bytes (bit 7 the leftmost column), in PRST_PATTERN order but for the
   legacy hatches (LEGACY: not in PowerPoint's picker), which come last: where two presets draw the same cell (cross
   and lgGrid), a reader that takes the first takes the picker's. Only bit patterns and preset names: nothing of a deck.

Exit codes: 0 written; 1 the export failed or a page did not read as a preset; 2 bad arguments.
"""

import argparse
import subprocess
import sys
from pathlib import Path

import pymupdf
from pptx import Presentation
from pptx.util import Emu

from harness.atlas.drawingml import PRST_PATTERN, patt_fill
from harness.atlas.export import export

ROOT = Path(__file__).resolve().parents[2]
TABLE = ROOT / "packages" / "core" / "src" / "passes" / "pattern-presets.ts"
EMU_PER_PT = 12700
SLIDE_PT = (960, 540)
GRID_PT = 6.0  # 8 px at 96 dpi
# 20.1.10.51's six legacy hatches, which PowerPoint's picker does not offer (drawingml.PRST_PATTERN's note).
LEGACY = ("horz", "vert", "cross", "dnDiag", "upDiag", "diagCross")
TOL = 1e-3

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"


def build(path):
    """The deck of step 1."""
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(SLIDE_PT[0] * EMU_PER_PT), Emu(SLIDE_PT[1] * EMU_PER_PT)
    blank = prs.slide_layouts[6]
    from lxml import etree

    for i, prst in enumerate(PRST_PATTERN):
        slide = prs.slides.add_slide(blank)
        x, y = 73 + i % 5, 72 + 2 * (i % 3)
        xml = (
            f'<p:sp xmlns:p="{P}" xmlns:a="{A}"><p:nvSpPr><p:cNvPr id="2" name="{prst}"/><p:cNvSpPr/>'
            f'<p:nvPr/></p:nvSpPr>'
            f'<p:spPr><a:xfrm><a:off x="{x * EMU_PER_PT}" y="{y * EMU_PER_PT}"/>'
            f'<a:ext cx="{130 * EMU_PER_PT}" cy="{80 * EMU_PER_PT}"/></a:xfrm>'
            f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
            f'{patt_fill(prst, "000000", "FFFFFF")}<a:ln><a:noFill/></a:ln></p:spPr></p:sp>'
        )
        slide.shapes._spTree.append(etree.fromstring(xml))
    prs.save(path)


def powerpoint_ids():
    out = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                          "(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object Id) -join ','"],
                         capture_output=True, text=True)
    return out.stdout.strip()


class NotTwoColour(ValueError):
    """A cell that is no k x k upscale of 8 x 8 black and white."""


def cell_bits(doc, page):
    """The 8 rows (bytes, bit 7 leftmost) of the page's one pattern cell, and its scale k; raises ValueError."""
    resources = doc.xref_get_key(page.xref, "Resources")
    patterns = doc.xref_get_key(page.xref, "Resources/Pattern")
    if patterns[0] != "dict":
        raise ValueError(f"page {page.number + 1}: no pattern ({resources[0]})")
    refs = [int(tok) for tok in patterns[1].replace("<<", " ").replace(">>", " ").split() if tok.isdigit()]
    xrefs = refs[0::2]
    if len(xrefs) != 1:
        raise ValueError(f"page {page.number + 1}: {len(xrefs)} patterns")
    pat = xrefs[0]
    matrix = [float(v) for v in doc.xref_get_key(pat, "Matrix")[1].strip("[]").split()]
    images = doc.xref_get_key(pat, "Resources/XObject")
    img_refs = [int(tok) for tok in images[1].replace("<<", " ").replace(">>", " ").split() if tok.isdigit()][0::2]
    if len(img_refs) != 1:
        raise ValueError(f"page {page.number + 1}: the cell holds {len(img_refs)} images")
    check_grid(page, matrix)
    pix = pymupdf.Pixmap(doc, img_refs[0])
    if pix.alpha:
        pix = pymupdf.Pixmap(pix, 0)
    if pix.n != 3:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
    w, h = pix.width, pix.height
    if w != h or w % 8 != 0:
        raise NotTwoColour(f"page {page.number + 1}: a {w} x {h} cell image")
    k = w // 8
    samples = pix.samples
    rows = []
    for r in range(8):
        byte = 0
        for c in range(8):
            values = {samples[((r * k + dy) * w + c * k + dx) * 3:((r * k + dy) * w + c * k + dx) * 3 + 3]
                      for dy in range(k) for dx in range(k)}
            if len(values) != 1:
                raise NotTwoColour(f"page {page.number + 1}: cell pixel ({r}, {c}) is not one colour")
            rgb = next(iter(values))
            if rgb == b"\x00\x00\x00":
                byte |= 0x80 >> c
            elif rgb != b"\xff\xff\xff":
                raise NotTwoColour(f"page {page.number + 1}: colour {rgb.hex()} is neither black nor white")
        rows.append(byte)
    return rows, k, matrix


def check_grid(page, matrix):
    """The pattern's origin on the slide's 6 pt grid (the matrix maps the cell, y up, onto the page, PDF y up)."""
    a, b, c_, d, e, f = matrix
    if abs(b) > TOL or abs(c_) > TOL:
        raise ValueError(f"page {page.number + 1}: a turned pattern {matrix}")
    page_h = page.rect.height
    for value in (e, page_h - f):
        if abs(value / GRID_PT - round(value / GRID_PT)) > TOL:
            raise ValueError(f"page {page.number + 1}: the cell's origin {value} pt is off the slide's 6 pt grid")


def table_text(entries):
    lines = [
        "// Generated by harness/atlas/pattern_presets.py (ruling M5-R10) from PowerPoint's own PDF export of each",
        "// ST_PresetPatternVal in black on white: do not edit. Each preset's 8 x 8 cell, 8 rows from the top as it",
        "// lies on the slide's 6 pt grid (8 px at 96 dpi, where PowerPoint anchors a pattern), bit 7 the leftmost",
        "// column, 1 the foreground. The legacy hatches last: of two presets that draw the same cell (cross and",
        "// lgGrid), the picker's comes first.",
        "",
        "/** PowerPoint's preset patterns: name (ST_PresetPatternVal) and cell rows. */",
        "export const PRESET_PATTERNS: readonly { prst: string; rows: readonly number[] }[] = [",
    ]
    for prst, rows in entries:
        lines.append(f"  {{ prst: '{prst}', rows: [{', '.join(f'0x{r:02x}' for r in rows)}] }},")
    lines.append("];")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=str(ROOT / "out" / "patterns"))
    parser.add_argument("--pdf", default=None, help="read this export instead of making one (no PowerPoint)")
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    if args.pdf is None:
        deck = out / "presets.pptx"
        build(deck)
        print(f"POWERPNT before: [{powerpoint_ids()}]")
        result = export(deck, out, ["std"], False)
        print(f"POWERPNT after: [{powerpoint_ids()}]")
        record = result["variants"].get("std") or {}
        if not record.get("ok"):
            print(f"export failed: exit {record.get('exitCode')} {record.get('reason', '')}", file=sys.stderr)
            return 1
        pdf = out / "presets_std.pdf"
    else:
        pdf = Path(args.pdf)
    doc = pymupdf.open(pdf)
    if doc.page_count != len(PRST_PATTERN):
        print(f"{doc.page_count} pages for {len(PRST_PATTERN)} presets", file=sys.stderr)
        return 1
    entries = []
    for prst, page in zip(PRST_PATTERN, doc):
        try:
            rows, k, matrix = cell_bits(doc, page)
        except NotTwoColour as exc:
            print(f"{prst}: left out ({exc})")
            continue
        except ValueError as exc:
            print(f"{prst}: {exc}", file=sys.stderr)
            return 1
        print(f"{prst}: k {k}, matrix {matrix}, rows {' '.join(f'{r:08b}' for r in rows)}")
        entries.append((prst, rows))
    entries.sort(key=lambda entry: entry[0] in LEGACY)  # stable: PRST_PATTERN order within each part
    TABLE.write_text(table_text(entries), encoding="utf-8", newline="\n")
    print(f"wrote {TABLE.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
