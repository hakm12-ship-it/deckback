"""Section `size` of the `sizes-*` decks: four slides laid out relative to the slide size, so the same content is
measured at 4:3 (720x540), A4 landscape (842x595), A4 portrait (595x842) and a custom 1000x1000 pt square.

Corner marks sit at three slide corners (the fourth is the label's), so a render that crops or scales the page is
visible."""

from pptx.enum.chart import XL_CHART_TYPE

from harness.atlas import drawingml as dml
from harness.atlas import images
from harness.atlas.sections.charts import add_chart, category_data, colour_series, style_chart
from harness.atlas.sections.tables import add_table, fill_cells

SECTION = "size"
INK = "262626"
MARK = 12


def _corner_marks(deck, slide):
    w, h = deck.width, deck.height
    for name, x, y in (("top-left", 0, 0), ("top-right", w - MARK, 0), ("bottom-right", w - MARK, h - MARK)):
        dml.add_sp(slide.shapes, dml.sp_pr(x, y, MARK, MARK, fill=dml.solid_fill("C00000")), name=f"Corner {name}")


def _text(deck):
    body, serif = (deck.font(role).family for role in ("BODY", "SERIF"))
    slide = deck.slide(SECTION, [f"typeface:{body}", f"typeface:{serif}", "buChar", "rPr:i"],
                       smoke=True, title=f"글자와 목록 ({deck.width:g}×{deck.height:g} pt)")
    _corner_marks(deck, slide)
    x, y, w, h = deck.content
    paragraphs = [deck.para("슬라이드 크기가 달라도 글자와 도형의 위치가 그대로여야 한다.", "BODY", 18, color=INK)]
    paragraphs += [deck.para(item, "BODY", 16, ppr=deck.bullet_ppr("BODY", mar_l=22, indent=-16), color=INK)
                   for item in ("4:3 화면 720×540 pt", "A4 가로 842×595 pt, A4 세로 595×842 pt",
                                "정사각형 1000×1000 pt")]
    paragraphs.append(deck.para("“The page size is part of the document.”", "SERIF", 16, italic=True,
                                color="595959"))
    sppr = dml.sp_pr(x, y, w, min(h, 300), fill=dml.no_fill(), line=dml.ln(0.75, color="A6A6A6"))
    dml.add_sp(slide.shapes, sppr, name="Body text", textbox=True, txbody=dml.tx_body(paragraphs, body=dml.body_pr()))


def _shapes(deck):
    slide = deck.slide(SECTION, ["gradFill:lin:45", "xfrm:rot", "cxnSp:straightConnector1", "lineEnd:triangle:med",
                                 "txBody:in-shape"], title="도형과 연결선")
    _corner_marks(deck, slide)
    presets = ("rect", "ellipse", "star5", "rightArrow", "roundRect", "hexagon")
    cells = deck.grid(3, 2) if deck.width >= deck.height else deck.grid(2, 3)
    shapes = []
    for i, ((x, y, w, h), prst) in enumerate(zip(cells, presets)):
        size = min(w, h) * 0.6
        fill = dml.grad_fill([(0, "9DC3E6"), (100, "1F3864")], angle=45) if i == 0 else dml.solid_fill("5B9BD5")
        txbody = None
        if prst == "roundRect":
            txbody = dml.tx_body([deck.para("도형 글자", "BODY", 14, align="ctr", color="FFFFFF")],
                                 body=dml.body_pr(anchor="ctr"))
        shapes.append(dml.add_sp(slide.shapes, dml.sp_pr(x + (w - size) / 2, y + (h - size) / 2, size, size,
                                                         prst=prst, fill=fill, line=dml.ln(1, color="1F3864"),
                                                         rot=30 if prst == "star5" else 0),
                                 name=f"Shape {prst}", txbody=txbody))
    first, last = shapes[0], shapes[-1]
    dml.add_cxn(slide.shapes, "straightConnector1", start=(first, 3), finish=(last.left.pt, last.top.pt),
                line=dml.ln(1.5, color="C00000", tail=("triangle", "med", "med")), name="Connector")


def _table_and_picture(deck):
    slide = deck.slide(SECTION, ["tbl", "tbl:firstRow", "pic", "pic:png:rgb"], title="표와 그림")
    _corner_marks(deck, slide)
    x, y, w, h = deck.content
    landscape = deck.width >= deck.height
    table_w = w * 0.55 if landscape else w
    table = add_table(slide, 4, 3, x, y, table_w, 160, name="Table")
    fill_cells(deck, table, [["항목", "2025", "2026"], ["매출", "1,250", "1,580"], ["비용", "830", "960"],
                             ["이익", "420", "620"]], size=14)
    pic_w = w * 0.4 if landscape else w * 0.8
    pic_h = pic_w * 250 / 400
    px, py = (x + w - pic_w, y) if landscape else (x + (w - pic_w) / 2, y + 200)
    dml.add_pic(slide.shapes, dml.image_rid(slide, images.png_bytes(images.picture())), px, py, pic_w, pic_h,
                name="Picture")


def _chart_and_vertical_text(deck):
    slide = deck.slide(SECTION, ["chart:barChart", "chart:korean-categories", "chart:fonts", "vert:eaVert"],
                       title="차트와 세로 쓰기")
    _corner_marks(deck, slide)
    x, y, w, h = deck.content
    chart_w = w - 70
    chart = add_chart(deck, slide, XL_CHART_TYPE.COLUMN_CLUSTERED,
                      category_data(("1분기", "2분기", "3분기", "4분기"), (("매출", (120, 135, 150, 170)),
                                                                        ("비용", (80, 90, 95, 100)))),
                      area=(x, y, chart_w, min(h, chart_w)))
    colour_series(chart)
    style_chart(deck, chart, size=12)
    body = dml.body_pr(vert="eaVert", anchor="t")
    deck.textbox(slide.shapes, x + w - 60, y, 60, min(h, 360), [deck.para("세로 쓰기 2026년", "BODY", 18, color=INK)],
                 name="Vertical text", body=body)


def build(deck):
    _text(deck)
    _shapes(deck)
    _table_and_picture(deck)
    _chart_and_vertical_text(deck)
