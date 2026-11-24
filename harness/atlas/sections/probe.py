"""Deck `probe`, section `m0`: the three slides of the M0 probe deck, re-created with python-pptx in the OFL roles.

Slide 1: title, a four-item bullet list (item 2 red and bold), a rectangle and a rounded rectangle with text, an
         ellipse, a right arrow, a chevron, a straight connector with an arrowhead and a dashed line.
Slide 2: title, a two-colour linear gradient with text, two overlapping circles (the second 50 % transparent), a 3x3
         table in the default table style, a picture, and a group of a rectangle, a circle and a triangle.
Slide 3: title and a native clustered column chart (categories 1분기..4분기, series 매출 and Cost).

Kept from the M0 original (its build script and original.pptx): positions, sizes, colours, the text and its sizes,
bold and colours; bullets at marL 36 pt / indent -36 pt; the theme's colour scheme (Office 2023), so the default
table style (header white and bold), the shape-style outline of the group (accent1 shade 15 %, the theme's 1.5 pt
line) and the chart's series colours resolve as there; table cells carrying only size and font; the chart's
python-pptx-shaped XML with the default gap and overlap, a bare legend and autoTitleDeleted 0.

Differences, by design or unavoidable:
- fonts: Gothic A1 (HEAD, bold) for the titles and Pretendard (BODY) for everything else instead of Malgun Gothic;
  the bullet font is named as HEAD, which is what M0's "+mj-lt" (the theme's major font) resolves to here, and the
  chart's text properties name BODY explicitly;
- M0's shapes take their white text and their outline from p:style references; here the same values are written
  on the shapes (white text, the group's accent1 shade 15 % 1.5 pt line);
- the picture is a Pillow re-drawing of the probe picture, not its pixels;
- every slide carries the 9 pt atlas label at the bottom left;
- the chart's axis ids are renumbered (the schema wants unsigned ids; M0 has python-pptx's negative ones)."""

import numpy as np
from PIL import Image, ImageDraw
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Pt

from harness.atlas import drawingml as dml
from harness.atlas import images
from harness.atlas.sections.charts import add_chart, category_data, keep_to_schema, workbook_fonts
from harness.atlas.sections.tables import add_table, set_cell

SECTION = "m0"
WHITE = "FFFFFF"
# The M0 deck's theme colour scheme (Office 2023); dk1/lt1 are the same window-text/window system colours.
M0_COLORS = {
    "dk2": "0E2841", "lt2": "E8E8E8", "accent1": "156082", "accent2": "E97132", "accent3": "196B24",
    "accent4": "0F9ED5", "accent5": "A02B93", "accent6": "4EA72E", "hlink": "467886", "folHlink": "96607D",
}
# M0's group shapes take their outline from the shape style: lnRef idx 2 (the theme's 1.5 pt line), accent1
# shade 15 %.
STYLE_OUTLINE = dml.ln(1.5, fill=dml.solid_fill("accent1", shade=15), cap="flat", cmpd="sng", algn="ctr", dash="solid",
                       join="miter", miter_limit=800)


def _rgb(r, g, b):
    return f"{r:02X}{g:02X}{b:02X}"


def probe_picture(width=240, height=160):
    """The probe's picture: a blue field with yellow rays and a red disc, drawn deterministically."""
    image = Image.new("RGB", (width, height), (31, 90, 160))
    draw = ImageDraw.Draw(image)
    cx, cy = width // 2, height // 2
    for angle in np.linspace(0, 2 * np.pi, 32, endpoint=False):
        if abs(np.cos(angle)) < 0.25:  # leave the left and right of the disc clear, as in the original
            continue
        x = cx + np.sin(angle) * width
        y = cy - np.cos(angle) * width
        draw.line([(cx, cy), (int(round(x)), int(round(y)))], fill=(255, 200, 0), width=3)
    draw.ellipse([cx - 40, cy - 40, cx + 40, cy + 40], fill=(220, 40, 60))
    return image


def _shape(deck, slide, prst, x, y, w, h, fill, line=None, *, text=None, name):
    txbody = None
    if text is not None:
        txbody = dml.tx_body([deck.para(text, "BODY", 16, align="ctr", color=WHITE)], body=dml.body_pr(anchor="ctr"))
    sppr = dml.sp_pr(x, y, w, h, prst=prst, fill=fill, line=line if line is not None else dml.ln(fill=dml.no_fill()))
    return dml.add_sp(slide.shapes, sppr, name=name, txbody=txbody)


def _title(deck, slide, y, h, text, size, color=None):
    body = dml.body_pr(wrap=True, autofit="sp")
    deck.textbox(slide.shapes, 40, y, 880, h, [deck.para(text, "HEAD", size, color=color)], name="Title", body=body)


def _slide1(deck):
    head, body = deck.font("HEAD").family, deck.font("BODY").family
    slide = deck.slide(SECTION, [f"typeface:{head}", f"typeface:{body}", "rPr:b", "buChar", "marL+indent",
                                 "text:solidFill:srgb", "txBody:in-shape", "cxnSp:straightConnector1", "cxnSp:line",
                                 "lineEnd:triangle:med", "prstDash:dash"], smoke=True)
    _title(deck, slide, 24, 60, "분기 실적 보고 Q3 Business Review", 36, _rgb(20, 40, 90))
    items = ("매출 성장률 12% 달성", "New customers: 1,240명", "해외 시장 진출 (Japan, Vietnam)",
             "다음 분기 목표: 효율 개선")
    paragraphs = []
    for i, item in enumerate(items):
        red = i == 1
        paragraphs.append(deck.para(item, "BODY", 20, ppr=deck.bullet_ppr("HEAD", mar_l=36, indent=-36),
                                    color=_rgb(200, 30, 30) if red else _rgb(50, 50, 50), bold=red or None))
    deck.textbox(slide.shapes, 40, 100, 420, 200, paragraphs, name="Bullets", body=dml.body_pr(autofit="sp"))
    _shape(deck, slide, "rect", 520, 110, 160, 90, dml.solid_fill(_rgb(68, 114, 196)),
           dml.ln(2, color=_rgb(30, 60, 120)), text="사각형 Rect", name="Rectangle")
    _shape(deck, slide, "roundRect", 720, 110, 180, 90, dml.solid_fill(_rgb(112, 173, 71)), text="둥근 사각형",
           name="Rounded Rectangle")
    _shape(deck, slide, "ellipse", 540, 240, 130, 130, dml.solid_fill(_rgb(237, 125, 49)),
           dml.ln(3, color=_rgb(120, 60, 20)), name="Oval")
    _shape(deck, slide, "rightArrow", 700, 270, 120, 60, dml.solid_fill(_rgb(255, 192, 0)), name="Right Arrow")
    _shape(deck, slide, "chevron", 830, 270, 70, 60, dml.solid_fill(_rgb(165, 165, 165)), name="Chevron")
    dml.add_cxn(slide.shapes, "straightConnector1", (60, 420), (460, 470), name="Straight Arrow Connector",
                line=dml.ln(2.5, color=_rgb(192, 0, 0), tail=("triangle", "med", "med")))
    dml.add_cxn(slide.shapes, "line", (60, 490), (900, 490), name="Dashed Line",
                line=dml.ln(1.5, color=_rgb(100, 100, 100), dash="dash"))


def _slide2(deck):
    head, body = deck.font("HEAD").family, deck.font("BODY").family
    slide = deck.slide(SECTION, [f"typeface:{head}", f"typeface:{body}", "gradFill:lin:90", "gradFill:scaled",
                                 "alpha:50", "tbl", "tbl:styleId", "tbl:firstRow", "tbl:bandRow", "pic",
                                 "pic:png:rgb", "grpSp"])
    _title(deck, slide, 20, 50, "세부 데이터 Detail", 30)
    gradient = dml.grad_fill([(0, _rgb(0, 112, 192)), (100, WHITE)], angle=90, scaled=True, flip="none",
                             tile_rect=(0, 0, 0, 0))
    sppr = dml.sp_pr(40, 90, 260, 120, fill=gradient, line=dml.ln(fill=dml.no_fill()))
    dml.add_sp(slide.shapes, sppr, name="Gradient", txbody=dml.tx_body(
        [deck.para("그라데이션 Gradient", "BODY", 18, align="ctr", color="000000")], body=dml.body_pr(anchor="ctr")))
    _shape(deck, slide, "ellipse", 330, 90, 140, 140, dml.solid_fill(_rgb(255, 0, 0)), name="Red Circle")
    _shape(deck, slide, "ellipse", 400, 120, 140, 140, dml.solid_fill(_rgb(0, 0, 255), alpha=50), name="Blue Circle")
    table = add_table(slide, 3, 3, 40, 280, 480, 150, name="Table")
    values = (("항목", "2024", "2025"), ("매출 Sales", "120", "150"), ("이익 Profit", "30", "42"))
    for r, row in enumerate(values):
        for c, text in enumerate(row):  # size and font only: the table style colours the header white and bold
            set_cell(table.cell(r, c), [deck.para(text, "BODY", 16, ppr=dml.p_pr(latin_ln_brk=True))])
    dml.add_pic(slide.shapes, dml.image_rid(slide, images.png_bytes(probe_picture())), 580, 90, 180, 120,
                name="Picture")
    group = slide.shapes.add_group_shape()
    group.name = "MyGroup"
    members = (("rect", 600, 100, 60, _rgb(112, 48, 160)), ("ellipse", 720, 80, 80, _rgb(0, 176, 80)),
               ("triangle", 820, 90, 80, _rgb(255, 102, 153)))
    for prst, x, w, h, colour in members:
        dml.add_sp(group.shapes, dml.sp_pr(x, 300, w, h, prst=prst, fill=dml.solid_fill(colour), line=STYLE_OUTLINE),
                   name=f"Group {prst}")


def _slide3(deck):
    body = deck.font("BODY").family
    slide = deck.slide(SECTION, [f"typeface:{deck.font('HEAD').family}", "chart:barChart", "chart:barDir:col",
                                 "chart:grouping:clustered", "chart:legend", "chart:gridlines",
                                 "chart:korean-categories", "chart:fonts"], smoke=True)
    _title(deck, slide, 20, 50, "차트 Chart", 30)
    data = category_data(("1분기", "2분기", "3분기", "4분기"),
                         (("매출", (120, 135, 150, 170)), ("Cost", (80, 90, 95, 100))))
    chart = add_chart(deck, slide, XL_CHART_TYPE.COLUMN_CLUSTERED, data, area=(80, 90, 800, 420))
    chart.has_legend = True  # a bare <c:legend/>, as in M0
    chart.font.size = Pt(18)
    dml.apply_fonts(chart._chartSpace, body)
    keep_to_schema(chart)
    workbook_fonts(chart, body)


def build(deck):
    deck.set_theme_colors(M0_COLORS)
    _slide1(deck)
    _slide2(deck)
    _slide3(deck)
