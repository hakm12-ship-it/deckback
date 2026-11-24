"""Atlas section `hidden`: two hidden slides (p:sld show="0"). PowerPoint leaves hidden slides out of a PDF export
by default, so the harness must skip them when it pairs manifest slides with PDF pages; their content is ordinary."""

from harness.atlas import drawingml as dml

SECTION = "hidden"


def build(deck):
    for n, colour in ((1, "C00000"), (2, "7030A0")):
        slide = deck.slide(SECTION, ["slide:hidden", "txBody:in-shape"], hidden=True, title=f"숨긴 슬라이드 {n}")
        x, y, w, h = deck.content
        sppr = dml.sp_pr(x + w / 2 - 260, y + h / 2 - 90, 520, 180, prst="roundRect", fill=dml.solid_fill(colour))
        dml.add_sp(slide.shapes, sppr, name=f"Hidden marker {n}", txbody=dml.tx_body(
            [deck.para(f"숨긴 슬라이드 {n} — PDF에 나오면 안 됨", "HEAD", 28, align="ctr", color="FFFFFF"),
             deck.para(f"Hidden slide {n} (show=0)", "BODY", 18, align="ctr", color="FFFFFF")],
            body=dml.body_pr(anchor="ctr")))
