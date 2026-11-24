"""The characters PowerPoint's PDF export draws as pictures when they are in a text run, measured (M5 Task 5): the table
packages/ooxml/src/emoji-runs.ts.

    harness/.venv/Scripts/python -m harness.atlas.emoji_runs [--out out/emoji-runs] [--pdf <exported pdf>]

PowerPoint exports a run's character of Unicode's Emoji property as a picture of its glyph, whatever the run's font has,
`u`, `lang`, `a:sym` or a variation selector say (measured on ▶ U+25B6 in Pretendard, atlas text/25 and text/26); a
paragraph's bullet (`a:buChar`) it exports as a glyph of text. The writer writes such a character, first in its
paragraph, as the bullet.

1. The candidates: every code point with Unicode's Emoji property but ASCII (`\\p{Emoji}` of Node's own Unicode, whose
   version the table records). Builds `<out>/emoji.pptx`: each candidate in a text box of its own (14 pt, no insets, no
   wrap) on a grid of 40 x 20 cells of 24 x 26 pt a slide, first all of them in Segoe UI Symbol (a Windows font with most
   of their glyphs; this is a local measurement), then those of the Basic Multilingual Plane in Pretendard (the atlas'
   body face).
2. Exports it to `<out>/emoji_std.pdf` through export.py (export.ps1 and DeckbackCom.psm1: a GUID temp copy, only the
   PowerPoint it started is quit, nothing is stopped; POWERPNT is recorded before and after). With `--pdf` it reads that
   PDF instead and PowerPoint is not used.
3. Reads each page's images: a cell that holds the middle of one is a character drawn as a picture.
4. Writes the table: the code points drawn as a picture in either face, as ranges. Only code points: nothing of a deck.

Exit codes: 0 written; 1 the export failed or the PDF is not the deck's; 2 bad arguments.
"""

import argparse
import json
import subprocess
import sys
from pathlib import Path

import pymupdf

from harness.atlas.export import export

ROOT = Path(__file__).resolve().parents[2]
TABLE = ROOT / "packages" / "ooxml" / "src" / "emoji-runs.ts"
EMU_PER_PT = 12700
SLIDE_PT = (960, 540)
COLS, ROWS, CELL_W, CELL_H = 40, 20, 24, 26
FACES = ("Segoe UI Symbol", "Pretendard")
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"

CANDIDATES_JS = (
    "const out = []; for (let c = 0x80; c <= 0x10ffff; c++) { if (c >= 0xd800 && c <= 0xdfff) continue;"
    " if (/\\p{Emoji}/u.test(String.fromCodePoint(c))) out.push(c); }"
    " console.log(JSON.stringify({ unicode: process.versions.unicode, points: out }));"
)


def candidates():
    """Node's Unicode version and the code points with the Emoji property, ASCII left out."""
    out = subprocess.run(["node", "-e", CANDIDATES_JS], capture_output=True, text=True, check=True)
    data = json.loads(out.stdout)
    return data["unicode"], data["points"]


def pages_of(points):
    """The deck's slides: (face, the code points of each cell in order), every face's in turn."""
    per = COLS * ROWS
    slides = []
    for face in FACES:
        chosen = points if face == FACES[0] else [c for c in points if c < 0x10000]
        slides += [(face, chosen[i:i + per]) for i in range(0, len(chosen), per)]
    return slides


def build(path, slides):
    """The deck of step 1."""
    from lxml import etree
    from pptx import Presentation
    from pptx.util import Emu

    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(SLIDE_PT[0] * EMU_PER_PT), Emu(SLIDE_PT[1] * EMU_PER_PT)
    blank = prs.slide_layouts[6]
    for face, cells in slides:
        slide = prs.slides.add_slide(blank)
        for k, c in enumerate(cells):
            x, y = (k % COLS) * CELL_W, (k // COLS) * CELL_H
            xml = (
                f'<p:sp xmlns:p="{P}" xmlns:a="{A}"><p:nvSpPr><p:cNvPr id="{k + 2}" name="U+{c:04X}"/>'
                f'<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{x * EMU_PER_PT}" '
                f'y="{y * EMU_PER_PT}"/><a:ext cx="{CELL_W * EMU_PER_PT}" cy="{CELL_H * EMU_PER_PT}"/></a:xfrm>'
                f'<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody>'
                f'<a:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0"/><a:lstStyle/><a:p><a:r>'
                f'<a:rPr lang="en-US" sz="1400"><a:latin typeface="{face}"/><a:ea typeface="{face}"/>'
                f'<a:cs typeface="{face}"/></a:rPr><a:t>&#x{c:X};</a:t></a:r></a:p></p:txBody></p:sp>'
            )
            slide.shapes._spTree.append(etree.fromstring(xml))
    prs.save(path)


def powerpoint_ids():
    out = subprocess.run(["powershell.exe", "-NoProfile", "-Command",
                          "(Get-Process POWERPNT -ErrorAction SilentlyContinue | ForEach-Object Id) -join ','"],
                         capture_output=True, text=True)
    return out.stdout.strip()


def pictured(doc, slides):
    """Per face, the code points whose cell holds the middle of an image of the exported PDF."""
    found = {face: set() for face in FACES}
    for page, (face, cells) in zip(doc, slides):
        for info in page.get_image_info():
            x0, y0, x1, y1 = info["bbox"]
            col, row = int(((x0 + x1) / 2) // CELL_W), int(((y0 + y1) / 2) // CELL_H)
            k = row * COLS + col
            if 0 <= col < COLS and 0 <= k < len(cells):
                found[face].add(cells[k])
    return found


def ranges(points):
    """Sorted code points as [first, last] runs."""
    out = []
    for c in sorted(points):
        if out and out[-1][1] == c - 1:
            out[-1][1] = c
        else:
            out.append([c, c])
    return out


def table_text(unicode, runs, counts):
    lines = [
        "// Generated by harness/atlas/emoji_runs.py (M5 Task 5) from PowerPoint's own PDF export of each code point of",
        f"// Unicode's Emoji property (Unicode {unicode}, ASCII left out) alone in a text run: do not edit. The code points",
        "// it drew as a picture, in Segoe UI Symbol or in Pretendard, as [first, last] ranges:",
        f"// {counts}.",
        "",
        "/** The code points PowerPoint's PDF export draws as a picture when they are in a text run. */",
        "export const EMOJI_RUNS: readonly (readonly [number, number])[] = [",
    ]
    for first, last in runs:
        lines.append(f"  [0x{first:04x}, 0x{last:04x}],")
    lines.append("];")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--out", default=str(ROOT / "out" / "emoji-runs"))
    parser.add_argument("--pdf", default=None, help="read this export instead of making one (no PowerPoint)")
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    unicode, points = candidates()
    slides = pages_of(points)
    if args.pdf is None:
        deck = out / "emoji.pptx"
        build(deck, slides)
        print(f"POWERPNT before: [{powerpoint_ids()}]")
        result = export(deck, out, ["std"], False)
        print(f"POWERPNT after: [{powerpoint_ids()}]")
        record = result["variants"].get("std") or {}
        if not record.get("ok"):
            print(f"export failed: exit {record.get('exitCode')} {record.get('reason', '')}", file=sys.stderr)
            return 1
        pdf = out / "emoji_std.pdf"
    else:
        pdf = Path(args.pdf)
    doc = pymupdf.open(pdf)
    if doc.page_count != len(slides):
        print(f"{doc.page_count} pages for {len(slides)} slides", file=sys.stderr)
        return 1
    found = pictured(doc, slides)
    union = found[FACES[0]] | found[FACES[1]]
    bmp = [c for c in points if c < 0x10000]
    counts = (f"{len(found[FACES[0]])} of {len(points)} in {FACES[0]}, {len(found[FACES[1]])} of {len(bmp)} in "
              f"{FACES[1]}, {len(union)} in all")
    for face in FACES:
        chosen = points if face == FACES[0] else bmp
        print(f"{face}: {len(found[face])} of {len(chosen)} drawn as pictures; as text: "
              + " ".join(f"{c:04x}" for c in chosen if c not in found[face]))
    TABLE.write_text(table_text(unicode, ranges(union), counts), encoding="utf-8", newline="\n")
    print(f"wrote {TABLE.relative_to(ROOT).as_posix()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
