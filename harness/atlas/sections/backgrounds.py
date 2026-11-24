"""Atlas section `backgrounds`: slide backgrounds (solid, theme colour, linear and path gradients, stretched picture,
texture tile, pattern, theme background style), shapes from the slide master and a layout, a background inherited
from the layout, and the footer, slide-number and date placeholders.

Master shapes. The section puts two shapes on the slide master and gives one layout (the template's "Title Only",
renamed "Atlas Master Shapes") its own shape and background. The Blank layout, which every other atlas slide uses,
is set to hide the master shapes (showMasterSp="0"), so they appear only on the slides that declare `master:sp`.

Footers. The date is fixed text, not a date field: a field would show the day of the PowerPoint export. The slide
number is a real `slidenum` field (PowerPoint numbers hidden slides too)."""

from pptx.oxml.ns import qn

from harness.atlas import drawingml as dml
from harness.atlas import images
from harness.atlas.deck import BLANK_LAYOUT

SECTION = "backgrounds"
MASTER_LAYOUT = 5  # "Title Only" in python-pptx's default template
LAYOUT_NAME = "Atlas Master Shapes"
SLIDENUM_FIELD_ID = "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}"
DATE_TEXT = "2026. 11. 4."
INK = "262626"


def _content(deck, slide, *, colour=INK, shade="FFFFFF"):
    """The same small sample on every background slide: a card with text and three shapes."""
    x, y, w, h = deck.content
    card = dml.sp_pr(x + 40, y + 40, 360, 160, prst="roundRect", fill=dml.solid_fill(shade, alpha=85),
                     line=dml.ln(1, color="7F7F7F"))
    dml.add_sp(slide.shapes, card, name="Card", txbody=dml.tx_body(
        [deck.para("배경 위의 글자와 도형", "HEAD", 22, color="1F1F1F"),
         deck.para("Text and shapes on a background", "BODY", 16, color="404040")], body=dml.body_pr(anchor="ctr")))
    for i, (prst, fill) in enumerate((("ellipse", "C00000"), ("triangle", "FFC000"), ("star5", "00B050"))):
        dml.add_sp(slide.shapes, dml.sp_pr(x + 460 + i * 140, y + 70, 110, 110, prst=prst, fill=dml.solid_fill(fill),
                                           line=dml.ln(1.5, color="1F1F1F")), name=f"Shape {prst}")
    deck.text(slide.shapes, x + 40, y + 250, w - 80, 40, "다람쥐 헌 쳇바퀴에 타고파 — 0123456789", "BODY", 20,
              name="Line", color=colour, wrap=False)


def _slide_with_background(deck, features, title, bg_xml, *, smoke=False, title_color="1F1F1F", colour=INK):
    slide = deck.slide(SECTION, features, smoke=smoke, title=title, title_color=title_color)
    dml.set_background(slide._element, bg_xml)
    _content(deck, slide, colour=colour)
    return slide


def _prepare_master(deck):
    """Master shapes (top band, corner mark), a layout with its own shape and background, and the Blank layout
    hiding master shapes. Returns the layout."""
    width, height = deck.width, deck.height
    master = deck.prs.slide_master
    deck.prs.slide_layouts[BLANK_LAYOUT]._element.set("showMasterSp", "0")
    dml.add_sp(master.shapes, dml.sp_pr(0, 0, width, 8, fill=dml.solid_fill("1F3864")), name="Master Band")
    body = dml.body_pr(wrap=False, anchor="ctr", insets=(0, 0, 0, 0))
    dml.add_sp(master.shapes, dml.sp_pr(width - 190, height - 22, 180, 16, fill=dml.no_fill()), name="Master Mark",
               textbox=True, txbody=dml.tx_body([deck.para("deckback 마스터 도형", "BODY", 9, align="r",
                                                            color="1F3864")], body=body))
    layout = deck.prs.slide_layouts[MASTER_LAYOUT]
    layout._element.find(qn("p:cSld")).set("name", LAYOUT_NAME)
    dml.add_sp(layout.shapes, dml.sp_pr(0, 56, 10, height - 84, fill=dml.solid_fill("C55A11")), name="Layout Bar")
    dml.set_background(layout._element, dml.background(dml.grad_fill([(0, "FFFFFF"), (100, "DEEBF7")], angle=90)))
    return layout


def _footers(deck, slide, *, colour="404040"):
    """Date, footer and slide-number placeholders, placed above the label band."""
    y = deck.height - 28 - 26
    number = str(len(deck.prs.slides))
    run = deck.rpr("BODY", 12, color=colour)
    end = deck.rpr("BODY", 12, tag="a:endParaRPr")
    body = dml.body_pr(anchor="ctr", wrap=False)
    dml.add_placeholder(slide.shapes, "dt", 10, 24, y, 200, 24, [dml.paragraph([(DATE_TEXT, run)], end_rpr=end)],
                        name="Date Placeholder", body=body)
    dml.add_placeholder(slide.shapes, "ftr", 11, deck.width / 2 - 200, y, 400, 24,
                        [dml.paragraph([("deckback 기능 지도 — 바닥글 Footer", run)], align="ctr", end_rpr=end)],
                        name="Footer Placeholder", body=body)
    dml.add_placeholder(slide.shapes, "sldNum", 12, deck.width - 224, y, 200, 24,
                        [dml.paragraph([dml.field("slidenum", SLIDENUM_FIELD_ID, number, run)], align="r",
                                       end_rpr=end)], name="Slide Number Placeholder", body=body)


def build(deck):
    tile = images.png_bytes(images.texture_tile())
    photo = images.png_bytes(images.picture())

    _slide_with_background(deck, ["bg:solidFill"], "배경: 단색 (RGB)", dml.background(dml.solid_fill("FFF2CC")),
                           smoke=True)
    _slide_with_background(deck, ["bg:solidFill", "bg:solidFill:scheme"], "배경: 테마 색 (accent1 어둡게)",
                           dml.background(dml.solid_fill("accent1", lum_mod=50)), title_color="FFFFFF",
                           colour="FFFFFF")
    _slide_with_background(deck, ["bg:gradFill:lin"], "배경: 선형 그라데이션",
                           dml.background(dml.grad_fill([(0, "DEEBF7"), (60, "9DC3E6"), (100, "2F5597")], angle=90)))
    _slide_with_background(deck, ["bg:gradFill:path"], "배경: 원형 그라데이션",
                           dml.background(dml.grad_fill([(0, "FFFFFF"), (100, "F4B183")], path="circle")))

    slide = deck.slide(SECTION, ["bg:blipFill:stretch"], title="배경: 그림 (늘이기)", title_color="FFFFFF")
    dml.set_background(slide._element, dml.background(dml.blip_fill(dml.image_rid(slide, photo))))
    _content(deck, slide, colour="FFFFFF")

    slide = deck.slide(SECTION, ["bg:blipFill:tile"], title="배경: 질감 바둑판 (tile)", title_color="FFFFFF")
    dml.set_background(slide._element, dml.background(dml.blip_fill(dml.image_rid(slide, tile), tile={"sx": 100,
                                                                                                    "sy": 100})))
    _content(deck, slide, colour="FFFFFF")

    _slide_with_background(deck, ["bg:pattFill", "pattFill:dkUpDiag"], "배경: 무늬 (dkUpDiag)",
                           dml.background(dml.patt_fill("dkUpDiag", "BDD7EE", "FFFFFF")))
    _slide_with_background(deck, ["bg:bgRef"], "배경: 테마 배경 스타일 (bgRef 1003)",
                           dml.background(ref=(1003, "accent1")))

    layout = _prepare_master(deck)
    slide = deck.slide(SECTION, ["master:sp", "layout:sp", "bg:from-layout"], smoke=True, layout=layout,
                       title="마스터 도형과 레이아웃 도형, 레이아웃 배경")
    _content(deck, slide)

    slide = deck.slide(SECTION, ["master:sp", "layout:sp", "bg:blipFill:tile", "ph:dt", "ph:ftr", "ph:sldNum",
                                 "fld:slidenum"], layout=layout, title="마스터 도형 + 슬라이드 배경 + 바닥글",
                       title_color="FFFFFF")
    dml.set_background(slide._element, dml.background(dml.blip_fill(dml.image_rid(slide, tile), tile={"sx": 50,
                                                                                                    "sy": 50})))
    _content(deck, slide, colour="FFFFFF")
    _footers(deck, slide, colour="FFFFFF")

    slide = deck.slide(SECTION, ["ph:dt", "ph:ftr", "ph:sldNum", "fld:slidenum", "bg:gradFill:lin"], smoke=True,
                       title="바닥글, 슬라이드 번호, 날짜 개체 틀")
    dml.set_background(slide._element, dml.background(dml.grad_fill([(0, "FFFFFF"), (100, "E2F0D9")], angle=0)))
    _content(deck, slide)
    _footers(deck, slide)
