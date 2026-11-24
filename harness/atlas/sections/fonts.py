"""Atlas section `fonts`: one slide (atlas/fonts/01) of Latin text in an OpenType-CFF font, the known bitmap case.

PowerPoint's PDF export embeds TrueType (glyf) fonts as subsets, but not OpenType fonts with CFF outlines: it draws
text in such a font as a bitmap, so that text has no text layer in the PDF (Task 7). Every role font of the atlas is
TrueType for that reason (ruling M1-R29). This slide keeps one sample of the bitmap case on purpose, in the lock's
only CFF family, Source Sans 3 (OFL, Latin only, no Windows system font of that name). The manifest marks the slide
`knownBitmapText` so text-based checks skip it, and its feature `font:cff` is checked against the lock. Its title,
captions and label are framework text in the TrueType roles and still embed.

The windows build has the same slide in the same font (Windows ships no CFF font of its own)."""

from harness.atlas import drawingml as dml

SECTION = "fonts"
CFF_FAMILY = "Source Sans 3"  # harness/fonts/fonts.lock.json: format otf-cff
INK = "262626"
LINES = (  # (size pt, text): unwrapped, each narrower than the 852 pt box at its size
    (12, "Source Sans 3 Regular (OpenType-CFF): The quick brown fox jumps over the lazy dog. 0123456789"),
    (18, "The quick brown fox jumps over the lazy dog. 0123456789"),
    (24, "Sphinx of black quartz, judge my vow. 0123456789"),
    (36, "Pack my box with five dozen jugs"),
    (54, "Hamburgefonstiv 0123"),
)
PARA = (
    "PowerPoint embeds TrueType fonts in a PDF as subsets, but it draws text set in an OpenType font with CFF "
    "outlines as a picture, so a PDF reader finds no text for it. This slide keeps that case on purpose; every other "
    "slide of the atlas uses TrueType fonts only."
)
PARA_SIZE = 14


def _para(text, size, **kwargs):
    run = dml.rpr(CFF_FAMILY, size, color=INK, lang="en-US")
    return dml.paragraph([(text, run)], end_rpr=dml.rpr(CFF_FAMILY, size, tag="a:endParaRPr"), **kwargs)


def build(deck):
    features = ["font:cff", f"typeface:{CFF_FAMILY}", "wrap:square"] + [
        f"fontSize:{size}" for size in sorted({s for s, _ in LINES} | {PARA_SIZE})]
    slide = deck.slide(SECTION, features, smoke=True, known_bitmap_text=True,
                       title="OpenType-CFF 글꼴: PowerPoint가 글자를 그림으로 넣는 경우 (Source Sans 3)")
    x, y, w, _ = deck.content
    for size, text in LINES:
        height = size * 1.5
        deck.caption(slide.shapes, x, y + (height - 14) / 2, 50, f"{size} pt", align="r")
        body = dml.body_pr(wrap=False, anchor="ctr", insets=(0, 0, 0, 0))
        deck.textbox(slide.shapes, x + 60, y, w - 60, height, [_para(text, size)], name=f"CFF {size} pt", body=body)
        y += height + 6
    y += 10
    deck.caption(slide.shapes, x, y, 300, f"{PARA_SIZE} pt, wrapped", align="l")
    deck.textbox(slide.shapes, x + 60, y + 18, w - 60, 80, [_para(PARA, PARA_SIZE)], name="CFF paragraph",
                 body=dml.body_pr(wrap=True, anchor="t", insets=(0, 0, 0, 0)))
