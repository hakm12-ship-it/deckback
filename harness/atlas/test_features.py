"""Tests for harness/atlas/features.py (the manifest feature vocabulary) and its use in the manifest."""

import io
import re

import pytest
from lxml import etree
from PIL import Image
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Pt

from harness.atlas import drawingml as dml
from harness.atlas import images
from harness.atlas.deck import AtlasDeck
from harness.atlas.features import (
    FIXED,
    PATTERNS,
    check_for,
    drawn_presets,
    drawn_warps,
    jpeg_components,
    missing_features,
)

NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}

PRESET_FAMILIES = {
    "prstGeom": dml.ST_SHAPE_TYPE,
    "cxnSp": dml.ST_SHAPE_TYPE,
    "sp": dml.ST_SHAPE_TYPE,
    "pattFill": dml.PRST_PATTERN,
    "prstDash": dml.PRST_DASH,
    "bevel": dml.BEVEL_PRESETS,
}


def new_deck():
    return AtlasDeck("ofl", (960, 540))


def test_a_declared_feature_missing_from_its_slide_is_reported():
    # the review's case: a slide that declares leftRightArrow but draws rtTriangle (rotated and flipped)
    deck = new_deck()
    slide = deck.slide("shapes", ["xfrm:rot+flip"])
    dml.add_sp(slide.shapes, dml.sp_pr(100, 100, 80, 60, prst="rtTriangle", rot=30, flip_h=True), name="t")
    declared = ["prstGeom:leftRightArrow", "xfrm:rot+flip", "prstGeom:rtTriangle", "xfrm:flipV"]
    assert missing_features(slide, declared) == ["prstGeom:leftRightArrow", "xfrm:flipV"]


def test_rotated_group_text_needs_text_inside_a_rotated_group():
    """grpSp:rot-text (m9): text in a rotated group, which PowerPoint exports as outlines; a rotated group of shapes
    without text, or text in a group that is not rotated, is not it."""
    def slide_with(rot, text):
        deck = new_deck()
        slide = deck.slide("shapes", ["grpSp"])
        group = slide.shapes.add_group_shape()
        txbody = dml.tx_body([deck.para(text, "BODY", 14)]) if text else None
        dml.add_sp(group.shapes, dml.sp_pr(100, 100, 80, 60, prst="rect"), name="child", txbody=txbody)
        dml.set_group_transform(group, rot=rot)
        return slide

    assert missing_features(slide_with(30, "그룹"), ["grpSp:rot-text"]) == []
    assert missing_features(slide_with(30, None), ["grpSp:rot-text"]) == ["grpSp:rot-text"]
    assert missing_features(slide_with(0, "그룹"), ["grpSp:rot-text"]) == ["grpSp:rot-text"]
    # an autoshape has a text body even without text: that is not text
    deck = new_deck()
    slide = deck.slide("shapes", ["grpSp"])
    group = slide.shapes.add_group_shape()
    group.shapes.add_shape(1, Pt(100), Pt(100), Pt(80), Pt(60))
    dml.set_group_transform(group, rot=30)
    assert slide.shapes[-1]._element.find(".//p:txBody", NS) is not None
    assert missing_features(slide, ["grpSp:rot-text"]) == ["grpSp:rot-text"]


def test_unknown_features_are_reported():
    deck = new_deck()
    slide = deck.slide("shapes", ["grpSp"])
    assert missing_features(slide, ["madeUp:thing", "lineCap:dashed"]) == [
        "madeUp:thing (not in the feature vocabulary)",
        "lineCap:dashed",  # a known family, but no line on the slide has cap="dashed"
    ]
    assert check_for("prstGeom:not-a-word!") is None


def test_manifest_adds_a_prstgeom_feature_per_drawn_preset_but_not_for_text_boxes():
    deck = new_deck()
    slide = deck.slide("shapes", ["grpSp"], title="제목")
    group = slide.shapes.add_group_shape()
    dml.add_sp(group.shapes, dml.sp_pr(10, 60, 50, 50, prst="ellipse"), name="e")
    dml.add_sp(group.shapes, dml.sp_pr(80, 60, 50, 50, prst="star5"), name="s")
    dml.add_cxn(slide.shapes, "bentConnector3", (10, 200), (200, 300), line=dml.ln(1, color="000000"))
    deck.caption(slide.shapes, 10, 400, 100, "caption")
    assert drawn_presets(slide._element) == ["ellipse", "star5", "bentConnector3"]
    features = deck.manifest()["slides"][0]["features"]
    assert features == ["grpSp", "prstGeom:ellipse", "prstGeom:star5", "prstGeom:bentConnector3"]


def test_declared_prstgeom_features_are_not_duplicated():
    deck = new_deck()
    slide = deck.slide("shapes", ["prstGeom:heart"])
    dml.add_sp(slide.shapes, dml.sp_pr(10, 60, 50, 50, prst="heart"), name="h")
    assert deck.manifest()["slides"][0]["features"] == ["prstGeom:heart"]


def test_fixed_names_never_shadow_a_preset_value():
    for name in FIXED:
        family, _, value = name.partition(":")
        if family in PRESET_FAMILIES:
            assert value not in PRESET_FAMILIES[family], name


def test_every_check_compiles_to_a_valid_xpath():
    deck = new_deck()
    slide = deck.slide("shapes", ["grpSp"])
    samples = [
        "prstGeom:rect", "cxnSp:bentConnector3", "sp:line", "pattFill:pct5", "prstDash:dot", "outline:prstDash:dot",
        "lineWidth:0.25", "lineCap:rnd", "lineJoin:miter", "cmpd:dbl", "lineEnd:oval:sm",
        "lineEnd:on-bentConnector3", "alpha:10", "gradFill:lin:45", "gradFill:path:circle", "effect:glow:shape",
        "effect:glow:text", "bevel:circle", "camera:perspectiveLeft",
        # Task 6b
        "typeface:Gothic A1", "fontSize:12", "u:dbl", "strike:dblStrike", "spc:-1", "cap:small", "algn:just",
        "vert:eaVert", "textbox:rot:15", "bodyPr:rot:90", "normAutofit:70", "numCol:2", "buAutoNum:arabicPeriod",
        "lvl:3", "anchor:ctr", "tab:dec", "prstTxWarp:textArchUp", "tc:anchor:b", "tc:vert:vert270",
        "chart:barChart", "chart:barDir:col", "chart:grouping:percentStacked", "chart:radarStyle:filled",
        "chart:scatterStyle:lineMarker", "pic:rot:15", "pic:effect:glow",
    ]
    for regex, _ in PATTERNS:  # every family has a sample here
        assert any(re.match(rf"^{regex}$", s) for s in samples), regex
    for feature in samples + list(FIXED):
        check = check_for(feature)
        assert check is not None, feature
        if hasattr(check, "xpath"):  # a callable check that runs an XPath elsewhere (chart parts)
            etree.XPath(check.xpath, namespaces=NS)
        elif not callable(check):
            slide._element.xpath(check)  # raises on a malformed expression


def test_rgba_feature_reads_the_embedded_image():
    deck = new_deck()
    rgb_slide = deck.slide("fills", ["blipFill:stretch"])
    r_id = dml.image_rid(rgb_slide, images.png_bytes(images.picture()))
    dml.add_sp(rgb_slide.shapes, dml.sp_pr(10, 60, 100, 60, fill=dml.blip_fill(r_id)), name="rgb")
    rgba_slide = deck.slide("fills", ["blipFill:rgba"])
    r_id = dml.image_rid(rgba_slide, images.png_bytes(images.picture_rgba()))
    dml.add_sp(rgba_slide.shapes, dml.sp_pr(10, 60, 100, 60, fill=dml.blip_fill(r_id, alpha=50)), name="rgba")
    assert missing_features(rgb_slide, ["blipFill:rgba"]) == ["blipFill:rgba"]
    assert missing_features(rgba_slide, ["blipFill:rgba", "blipFill:rgba+alphaModFix"]) == []


@pytest.mark.parametrize("feature", ["prstGeom:x' or '1'='1", "pattFill:pct5]", "typeface:Noto' or '1",
                                     "typeface:Gothic A1']|//*['", "chart:grouping:x']|//*['",
                                     "prstTxWarp:textArchUp]"])
def test_feature_values_cannot_inject_xpath(feature):
    assert check_for(feature) is None


def test_typeface_names_may_carry_digits():
    # the lock's families "Gothic A1" and "Source Sans 3" end in a digit
    deck = new_deck()
    slide = deck.slide("text", ["rPr:b"])
    deck.text(slide.shapes, 24, 100, 300, 40, "고딕 A1", "HEAD", 20, name="Content")
    assert missing_features(slide, ["typeface:Gothic A1", "typeface:Source Sans 3"]) == ["typeface:Source Sans 3"]


def test_font_cff_finds_content_text_in_a_locked_cff_family_only():
    deck = new_deck()
    plain = deck.slide("fonts", ["rPr:b"], title="Title")  # framework text and TrueType content only
    deck.text(plain.shapes, 24, 100, 300, 40, "TrueType", "BODY", 20, name="Content")
    assert missing_features(plain, ["font:cff"]) == ["font:cff"]
    cff = deck.slide("fonts", ["rPr:b"], title="Title")
    deck.textbox(cff.shapes, 24, 100, 300, 40, [dml.paragraph([("CFF text", dml.rpr("Source Sans 3", 20))])],
                 name="Content")
    assert missing_features(cff, ["font:cff", "typeface:Source Sans 3"]) == []


# --- Task 6b --------------------------------------------------------------------------------------------------------


# Text features that the framework's own text would satisfy if the checks looked at it: the title (HEAD bold 20 pt,
# srgb, anchor ctr, no wrap), the label (BODY 9 pt, srgb, anchor b) and captions (BODY 9 pt, srgb, algn ctr, anchor t).
FRAMEWORK_LOOKALIKES = (
    "typeface:Gothic A1", "typeface:Pretendard", "fontSize:20", "fontSize:9", "rPr:b", "text:solidFill:srgb",
    "algn:ctr", "anchor:t", "anchor:ctr", "anchor:b", "wrap:none",
)


def test_text_checks_ignore_the_framework_title_label_and_captions():
    # A slide holding only the title, the label and a caption shows none of these features: the checks look at
    # content text only, so a declaration can never be satisfied by the framework's own text.
    deck = new_deck()
    slide = deck.slide("text", ["rPr:b"], title="제목 Title")
    deck.caption(slide.shapes, 24, 100, 200, "캡션 caption")
    assert missing_features(slide, FRAMEWORK_LOOKALIKES) == list(FRAMEWORK_LOOKALIKES)
    # the same properties on content text are found
    content = deck.slide("text", ["rPr:b"], title="제목 Title")
    deck.text(content.shapes, 24, 100, 300, 40, "본문", "HEAD", 20, name="Content", anchor="ctr", wrap=False,
              color="1F1F1F", ppr=dml.p_pr(align="ctr"))
    deck.text(content.shapes, 24, 200, 300, 40, "본문", "BODY", 9, name="Content 2", anchor="t", color="595959")
    deck.text(content.shapes, 24, 300, 300, 40, "본문", "BODY", 9, name="Content 3", anchor="b")
    assert missing_features(content, FRAMEWORK_LOOKALIKES) == []


def test_drawn_presets_include_pictures_but_not_text_boxes_or_tables():
    deck = new_deck()
    slide = deck.slide("pictures", ["pic"])
    r_id = dml.image_rid(slide, images.png_bytes(images.picture()))
    dml.add_pic(slide.shapes, r_id, 10, 60, 100, 60, name="p1", prst="roundRect")
    dml.add_pic(slide.shapes, r_id, 120, 60, 100, 60, name="p2")
    slide.shapes.add_table(2, 2, Pt(10), Pt(200), Pt(200), Pt(60))
    deck.caption(slide.shapes, 10, 400, 100, "caption")
    assert drawn_presets(slide._element) == ["roundRect", "rect"]
    features = deck.manifest()["slides"][0]["features"]
    assert features == ["pic", "prstGeom:roundRect", "prstGeom:rect"]
    assert missing_features(slide, ["pic:geom", "tbl", "pic:rot"]) == ["pic:rot"]


def test_drawn_warps_and_text_checks():
    deck = new_deck()
    slide = deck.slide("wordart", ["prstTxWarp:textWave1"])
    body = dml.body_pr(warp="textWave1", wrap=False)
    deck.textbox(slide.shapes, 10, 60, 300, 80, [deck.para("물결", "HEAD", 28, underline="sng", spc=3)],
                 name="w", body=body)
    assert drawn_warps(slide._element) == ["textWave1"]
    family = deck.font("HEAD").family
    assert missing_features(slide, ["prstTxWarp:textWave1", "u:sng", "spc:3", f"typeface:{family}",
                                    "fontSize:28", "prstTxWarp:textWave2", "spc:-1"]) == [
        "prstTxWarp:textWave2", "spc:-1"]


def test_hyperlink_check_needs_an_external_hyperlink_relationship():
    deck = new_deck()
    slide = deck.slide("text", ["hlinkClick"])
    r_id = dml.hyperlink_rid(slide, "https://example.com/deckback")
    deck.text(slide.shapes, 10, 60, 300, 40, "링크", hlink_rid=r_id)
    assert missing_features(slide, ["hlinkClick"]) == []
    other = deck.slide("text", ["hlinkClick"])
    deck.text(other.shapes, 10, 60, 300, 40, "가짜 링크", hlink_rid="rId99")  # no such relationship
    assert missing_features(other, ["hlinkClick"]) == ["hlinkClick"]


def test_chart_checks_read_the_chart_part():
    deck = new_deck()
    slide = deck.slide("charts", ["chart:barChart"])
    data = CategoryChartData()
    data.categories = ["서울", "부산"]
    data.add_series("매출", (1, 2))
    slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_STACKED, Pt(10), Pt(60), Pt(300), Pt(200), data)
    assert missing_features(slide, ["chart:barChart", "chart:barDir:col", "chart:grouping:stacked",
                                    "chart:korean-categories", "chart:pieChart", "chart:barDir:bar"]) == [
        "chart:pieChart", "chart:barDir:bar"]
    empty = deck.slide("charts", ["chart:barChart"])
    assert missing_features(empty, ["chart:barChart", "chart:korean"]) == ["chart:barChart", "chart:korean"]


def _jpeg(mode):
    buf = io.BytesIO()
    images.picture(64, 40).convert(mode).save(buf, "JPEG", quality=90)
    return buf.getvalue()


def test_jpeg_checks_read_the_sof_segment():
    assert jpeg_components(_jpeg("RGB")) == 3
    assert jpeg_components(_jpeg("CMYK")) == 4
    assert jpeg_components(images.png_bytes(images.picture(8, 8))) is None
    deck = new_deck()
    slide = deck.slide("pictures", ["pic"])
    for i, blob in enumerate((_jpeg("RGB"), images.png_bytes(images.picture_rgba(64, 40)))):
        dml.add_pic(slide.shapes, dml.image_rid(slide, blob), 10 + 120 * i, 60, 100, 60, name=f"p{i}")
    assert Image.open(io.BytesIO(_jpeg("CMYK"))).mode == "CMYK"
    assert missing_features(slide, ["pic:jpeg:rgb", "pic:png:rgba", "pic:jpeg:cmyk", "pic:png:rgb"]) == [
        "pic:jpeg:cmyk", "pic:png:rgb"]


def test_background_and_master_checks():
    deck = new_deck()
    plain = deck.slide("backgrounds", ["bg:solidFill"])
    assert missing_features(plain, ["bg:solidFill", "master:sp", "slide:hidden"]) == [
        "bg:solidFill", "master:sp", "slide:hidden"]
    dml.set_background(plain._element, dml.background(dml.solid_fill("FFF2CC")))
    hidden = deck.slide("hidden", ["slide:hidden"], hidden=True)
    assert missing_features(plain, ["bg:solidFill"]) == [] and missing_features(hidden, ["slide:hidden"]) == []
