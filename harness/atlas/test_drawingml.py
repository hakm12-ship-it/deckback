"""Tests for harness/atlas/drawingml.py: the OOXML enumerations and the schema order of the XML it writes."""

import io

import pytest
from lxml import etree
from pptx import Presentation
from pptx.enum.dml import MSO_LINE_DASH_STYLE, MSO_PATTERN_TYPE
from pptx.enum.shapes import MSO_AUTO_SHAPE_TYPE
from pptx.oxml import parse_xml
from pptx.oxml.ns import nsdecls
from pptx.util import Pt

from harness.atlas import drawingml as dml
from harness.atlas import images
from harness.spikes import pptx_xml

LINE_AND_CONNECTORS = {
    "line",
    "straightConnector1",
    "bentConnector2",
    "bentConnector3",
    "bentConnector4",
    "bentConnector5",
    "curvedConnector2",
    "curvedConnector3",
    "curvedConnector4",
    "curvedConnector5",
}


def tags(element):
    return [etree.QName(child).localname for child in element]


def frag(xml):
    return parse_xml(f'<root {nsdecls("a", "r")}>{xml}</root>')[0]


def blank_slide():
    prs = Presentation()
    prs.slide_width, prs.slide_height = Pt(960), Pt(540)
    return prs, prs.slides.add_slide(prs.slide_layouts[6])


def test_st_shape_type_is_the_full_preset_list():
    assert len(dml.ST_SHAPE_TYPE) == 187
    assert len(set(dml.ST_SHAPE_TYPE)) == 187
    pptx_values = {m.xml_value for m in MSO_AUTO_SHAPE_TYPE if m.xml_value}
    assert pptx_values <= set(dml.ST_SHAPE_TYPE)
    assert set(dml.ST_SHAPE_TYPE) - pptx_values == LINE_AND_CONNECTORS


def test_prst_pattern_is_the_full_preset_list():
    # ECMA-376 ST_PresetPatternVal has 54 values; PowerPoint's pattern picker shows 48 of them (it omits
    # horz, vert, cross, dnDiag, upDiag and diagCross, which older Office versions wrote).
    assert len(dml.PRST_PATTERN) == len(set(dml.PRST_PATTERN)) == 54
    assert set(dml.PRST_PATTERN) == {m.xml_value for m in MSO_PATTERN_TYPE if m.xml_value}


def test_prst_dash_is_the_full_preset_list():
    assert len(dml.PRST_DASH) == len(set(dml.PRST_DASH)) == 11
    assert {m.xml_value for m in MSO_LINE_DASH_STYLE if m.xml_value} <= set(dml.PRST_DASH)


def test_line_enumerations():
    assert dml.LINE_CAPS == ("flat", "rnd", "sq")
    assert dml.LINE_JOINS == ("round", "bevel", "miter")
    assert dml.COMPOUND_LINES == ("sng", "dbl", "thickThin", "thinThick", "tri")
    assert dml.LINE_END_TYPES == ("none", "triangle", "stealth", "diamond", "oval", "arrow")
    assert dml.LINE_END_SIZES == ("sm", "med", "lg")
    assert len(dml.BEVEL_PRESETS) == 12


def test_spikes_helpers_are_reused_not_copied():
    assert dml.add_custgeom is pptx_xml.add_custgeom
    assert dml.add_gradfill is pptx_xml.add_gradfill
    assert dml.EMU_PER_PT == pptx_xml.EMU_PER_PT == 12700


def test_colour_srgb_scheme_and_alpha():
    srgb = frag(dml.color("1f4e79", alpha=25))
    assert etree.QName(srgb).localname == "srgbClr" and srgb.get("val") == "1F4E79"
    assert srgb.xpath("./a:alpha/@val") == ["25000"]
    scheme = frag(dml.color("accent2", lum_mod=75))
    assert etree.QName(scheme).localname == "schemeClr" and scheme.get("val") == "accent2"
    with pytest.raises(ValueError):
        dml.color("notacolour")


def test_line_children_follow_the_schema_order():
    ln = frag(
        dml.ln(
            4,
            color="000000",
            dash="sysDot",
            cap="rnd",
            cmpd="dbl",
            join="miter",
            head=("oval", "sm", "lg"),
            tail=("triangle", "lg", "lg"),
        )
    )
    assert tags(ln) == ["solidFill", "prstDash", "miter", "headEnd", "tailEnd"]
    assert (ln.get("w"), ln.get("cap"), ln.get("cmpd")) == (str(4 * 12700), "rnd", "dbl")
    with pytest.raises(ValueError):
        dml.ln(1, dash="dotted")


def test_line_rejects_conflicting_or_ignored_arguments():
    with pytest.raises(ValueError):
        dml.ln(1, color="000000", fill=dml.no_fill())
    with pytest.raises(ValueError):
        dml.ln(1, alpha=50, fill=dml.no_fill())
    with pytest.raises(ValueError):
        dml.ln(1, alpha=50)  # an alpha needs a colour
    with pytest.raises(ValueError):
        dml.ln(1, color="000000", dash="dot", cust_dash=[(100, 100)])
    with pytest.raises(ValueError):
        dml.ln(1, color="000000", join="round", miter_limit=800)
    with pytest.raises(ValueError):
        dml.ln(1, color="000000", miter_limit=800)


def test_other_builders_reject_ignored_arguments():
    stops = [(0, "000000"), (100, "FFFFFF")]
    with pytest.raises(ValueError):
        dml.grad_fill(stops, angle=0, focus=(0, 0, 100, 100))
    with pytest.raises(ValueError):
        dml.grad_fill(stops, path="circle", scaled=True)
    with pytest.raises(ValueError):
        dml.blip_fill("rId9", tile={}, fill_rect=(10, 10, 10, 10))
    with pytest.raises(ValueError):
        dml.rpr("Pretendard", 12, color="000000", fill=dml.no_fill())


def test_connectors_glue_only_to_presets_with_verified_connection_sites():
    _, slide = blank_slide()
    line = dml.ln(1, color="000000")
    rect = dml.add_sp(slide.shapes, dml.sp_pr(10, 10, 80, 40, prst="rect"), name="rect")
    rounded = dml.add_sp(slide.shapes, dml.sp_pr(300, 10, 80, 40, prst="roundRect"), name="roundRect")
    oval = dml.add_sp(slide.shapes, dml.sp_pr(10, 200, 80, 40, prst="ellipse"), name="ellipse")
    turned = dml.add_sp(slide.shapes, dml.sp_pr(300, 200, 80, 40, prst="rect", rot=30), name="turned")
    dml.add_cxn(slide.shapes, "straightConnector1", start=(rect, 3), end=(rounded, 1), line=line)
    with pytest.raises(ValueError, match="ellipse"):  # 8 sites in another order
        dml.add_cxn(slide.shapes, "straightConnector1", start=(oval, 3), end=(rect, 1), line=line)
    with pytest.raises(ValueError, match="rotated or flipped"):
        dml.add_cxn(slide.shapes, "straightConnector1", start=(rect, 3), end=(turned, 1), line=line)
    with pytest.raises(ValueError, match="site"):
        dml.add_cxn(slide.shapes, "straightConnector1", start=(rect, 4), end=(rounded, 1), line=line)
    assert len(slide.shapes) == 5  # nothing was added by the refused calls


def test_effect_list_is_written_in_schema_order():
    lst = frag(dml.effect_lst(dml.soft_edge(3), dml.reflection(), dml.outer_shdw(), dml.glow(5, "FFC000"),
                              dml.inner_shdw()))
    assert tags(lst) == ["glow", "innerShdw", "outerShdw", "reflection", "softEdge"]


def test_shape_properties_follow_the_schema_order():
    sp_pr = frag(
        dml.sp_pr(
            10, 20, 100, 50,
            prst="roundRect",
            av={"adj": 20000},
            fill=dml.solid_fill("FF0000"),
            line=dml.ln(1, color="000000"),
            effects=dml.effect_lst(dml.outer_shdw()),
            scene=dml.scene3d("perspectiveLeft"),
            shape3d=dml.sp3d(bevel_top=(6, 6, "circle")),
            rot=30,
            flip_h=True,
        ).replace("<p:spPr>", f'<p:spPr {nsdecls("p", "a")}>')
    )
    assert tags(sp_pr) == ["xfrm", "prstGeom", "solidFill", "ln", "effectLst", "scene3d", "sp3d"]
    xfrm = sp_pr[0]
    assert (xfrm.get("rot"), xfrm.get("flipH")) == (str(30 * 60000), "1")
    with pytest.raises(ValueError):
        dml.sp_pr(0, 0, 10, 10, prst="notAShape")


def test_run_properties_name_latin_ea_and_cs():
    rpr = frag(dml.rpr("Pretendard", 12, bold=True, color="333333",
                       effects=dml.effect_lst(dml.glow(4, "00B0F0"))))
    assert tags(rpr) == ["solidFill", "effectLst", "latin", "ea", "cs"]
    assert [rpr[i].get("typeface") for i in (2, 3, 4)] == ["Pretendard"] * 3
    assert (rpr.get("sz"), rpr.get("b"), rpr.get("lang")) == ("1200", "1", "ko-KR")


def test_added_shapes_connectors_and_groups_survive_a_save():
    prs, slide = blank_slide()
    a = dml.add_sp(slide.shapes, dml.sp_pr(100, 100, 80, 40, fill=dml.solid_fill("4472C4")), name="A")
    b = dml.add_sp(slide.shapes, dml.sp_pr(400, 300, 80, 40, fill=dml.solid_fill("ED7D31")), name="B")
    cxn = dml.add_cxn(slide.shapes, "bentConnector3", start=(a, 3), end=(b, 1), line=dml.ln(2, color="000000"))
    group = slide.shapes.add_group_shape()
    dml.add_sp(group.shapes, dml.sp_pr(600, 100, 50, 50, prst="ellipse"), name="in group")
    buf = io.BytesIO()
    prs.save(buf)
    reopened = Presentation(io.BytesIO(buf.getvalue())).slides[0]
    names = [s.name for s in reopened.shapes]
    assert names[:2] == ["A", "B"]
    cxn_el = reopened.shapes[2]._element
    assert cxn_el.xpath("./p:nvCxnSpPr/p:cNvCxnSpPr/a:stCxn/@id") == [str(a.shape_id)]
    assert cxn_el.xpath("./p:nvCxnSpPr/p:cNvCxnSpPr/a:endCxn/@idx") == ["1"]
    # begin at A's right-middle site (180, 120), end at B's left-middle site (400, 320)
    assert (cxn.left, cxn.top, cxn.width, cxn.height) == (Pt(180), Pt(120), Pt(220), Pt(200))
    assert reopened.shapes[3].shapes[0].name == "in group"
    assert len({s.shape_id for s in reopened.shapes}) == 4


# --- Task 6b: text, paragraphs, WordArt, tables, pictures, backgrounds, fonts ------------------------------------


def test_text_enumerations_match_the_schema():
    assert len(dml.PRST_TX_WARP) == len(set(dml.PRST_TX_WARP)) == 41  # ST_TextShapeType
    assert dml.PRST_TX_WARP[0] == "textNoShape" and dml.PRST_TX_WARP[-1] == "textCascadeDown"
    assert len(dml.UNDERLINE_TYPES) == 18 and dml.UNDERLINE_TYPES[:3] == ("none", "words", "sng")
    assert len(dml.AUTONUM_SCHEMES) == 41 and "arabicPeriod" in dml.AUTONUM_SCHEMES
    assert dml.TEXT_VERT == ("horz", "vert", "vert270", "wordArtVert", "eaVert", "mongolianVert", "wordArtVertRtl")
    assert dml.TEXT_ALIGN == ("l", "ctr", "r", "just", "justLow", "dist", "thaiDist")


def test_run_properties_new_attributes_and_children_in_schema_order():
    gradient = dml.grad_fill([(0, "FF0000"), (100, "0000FF")], angle=0)
    rpr = frag(dml.rpr("Pretendard", 12, underline="dbl", strike="sngStrike", baseline=30, spc=-1, kern=12,
                       cap="small", line=dml.ln(1, color="000000"), fill=gradient,
                       effects=dml.effect_lst(dml.glow(3, "FFC000")), highlight="FFFF00", hlink_rid="rId7"))
    assert tags(rpr) == ["ln", "gradFill", "effectLst", "highlight", "latin", "ea", "cs", "hlinkClick"]
    attrs = tuple(rpr.get(name) for name in ("u", "strike", "baseline", "spc", "kern", "cap"))
    assert attrs == ("dbl", "sngStrike", "30000", "-100", "1200", "small")
    assert rpr[-1].get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id") == "rId7"
    assert frag(dml.rpr("Pretendard", 12, spc=0)).get("spc") == "0"
    for bad in (dict(underline="single"), dict(strike="strike"), dict(cap="caps")):
        with pytest.raises(ValueError):
            dml.rpr("Pretendard", 12, **bad)


def test_paragraph_properties_children_in_schema_order():
    ppr = frag(dml.p_pr(align="just", lvl=2, mar_l=36, indent=-18, ln_spc=("pct", 150), spc_bef=("pts", 6),
                        spc_aft=("pct", 50), bu_color="C00000", bu_size=120, bu_font="Pretendard",
                        bullet=("char", "•"), tabs=[(72, "l"), (200, "dec")], ea_ln_brk=False))
    assert tags(ppr) == ["lnSpc", "spcBef", "spcAft", "buClr", "buSzPct", "buFont", "buChar", "tabLst"]
    attrs = tuple(ppr.get(name) for name in ("algn", "lvl", "marL", "indent", "eaLnBrk"))
    assert attrs == ("just", "2", str(36 * 12700), str(-18 * 12700), "0")
    assert ppr[0][0].get("val") == "150000" and ppr[1][0].get("val") == "600"
    numbered = frag(dml.p_pr(bullet=("autonum", "romanUcPeriod", 3), bu_font="Pretendard"))
    assert tags(numbered) == ["buFont", "buAutoNum"]
    assert (numbered[1].get("type"), numbered[1].get("startAt")) == ("romanUcPeriod", "3")
    assert tags(frag(dml.p_pr(bullet="none"))) == ["buNone"]
    with pytest.raises(ValueError):
        dml.p_pr(bullet=("autonum", "arabicDot"))
    with pytest.raises(ValueError):
        dml.p_pr(align="centre")


def test_paragraph_runs_breaks_fields_and_ppr():
    run = dml.rpr("Pretendard", 12)
    field = dml.field("slidenum", "{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}", "7", run)
    p = frag(dml.paragraph([("가", run), ("\n", run), ("나", run), field], ppr=dml.p_pr(align="r"),
                           end_rpr=run.replace("a:rPr", "a:endParaRPr")))
    assert tags(p) == ["pPr", "r", "br", "r", "fld", "endParaRPr"]
    assert tags(p[4]) == ["rPr", "t"] and p[4].get("type") == "slidenum"
    with pytest.raises(ValueError):
        dml.paragraph([("x", run)], align="l", ppr=dml.p_pr(align="r"))


def test_body_properties_warp_autofit_columns_in_schema_order():
    body = frag(dml.body_pr(warp="textArchUp", autofit="norm", font_scale=70, ln_spc_reduction=20, num_col=2,
                            spc_col=12, vert="eaVert", rot=30, scene=dml.scene3d("perspectiveLeft"),
                            shape3d=dml.sp3d(bevel_top=(3, 3, "circle"))))
    assert tags(body) == ["prstTxWarp", "normAutofit", "scene3d", "sp3d"]
    attrs = tuple(body.get(name) for name in ("numCol", "spcCol", "vert", "rot"))
    assert attrs == ("2", str(12 * 12700), "eaVert", str(30 * 60000))
    assert (body[1].get("fontScale"), body[1].get("lnSpcReduction")) == ("70000", "20000")
    assert tags(body[0]) == ["avLst"] and body[0].get("prst") == "textArchUp"
    assert tags(frag(dml.body_pr(autofit="none"))) == ["noAutofit"]
    for bad in (dict(warp="textArch"), dict(vert="sideways"), dict(font_scale=70), dict(autofit="shrink")):
        with pytest.raises(ValueError):
            dml.body_pr(**bad)


def test_table_cell_properties_in_schema_order():
    borders = {"B": dict(width_pt=3, color="C00000"), "TlToBr": dict(width_pt=1, color="000000"),
               "L": dict(width_pt=1, color="00B050", dash="dash"), "T": dict(width_pt=6, color="0070C0"),
               "R": dict(width_pt=2, color="7030A0")}
    tcpr = frag(dml.tc_pr(borders=borders, fill=dml.solid_fill("FFF2CC"), anchor="ctr", vert="eaVert",
                          margins=(4, 2, 4, 2)))
    assert tags(tcpr) == ["lnL", "lnR", "lnT", "lnB", "lnTlToBr", "solidFill"]
    attrs = tuple(tcpr.get(name) for name in ("anchor", "vert", "marL", "marT"))
    assert attrs == ("ctr", "eaVert", str(4 * 12700), str(2 * 12700))
    assert tags(tcpr[0]) == ["solidFill", "prstDash"]
    with pytest.raises(ValueError):
        dml.tc_pr(borders={"Top": dict(width_pt=1, color="000000")})
    with pytest.raises(ValueError):
        dml.ln(1, color="000000", tag="a:lnX")


def test_pictures_with_blip_effects_crop_geometry_and_effects_survive_a_save():
    prs, slide = blank_slide()
    r_id = dml.image_rid(slide, images.png_bytes(images.picture()))
    pic = dml.add_pic(slide.shapes, r_id, 100, 80, 200, 125, name="P",
                      blip_effects=(dml.grayscl(), dml.duotone("000000", "4472C4"), dml.bi_level(50),
                                    dml.lum(bright=20, contrast=-10)),
                      alpha=60, src_rect=(10, 0, 5, 20), prst="roundRect", line=dml.ln(3, color="1F3864"),
                      effects=dml.effect_lst(dml.outer_shdw()), rot=15, flip_h=True)
    element = pic._element
    assert tags(element) == ["nvPicPr", "blipFill", "spPr"]
    assert tags(element[1]) == ["blip", "srcRect", "stretch"]
    assert tags(element[1][0]) == ["grayscl", "duotone", "biLevel", "lum", "alphaModFix"]
    assert tags(element[2]) == ["xfrm", "prstGeom", "ln", "effectLst"]
    buf = io.BytesIO()
    prs.save(buf)
    reopened = Presentation(io.BytesIO(buf.getvalue())).slides[0].shapes[0]
    assert reopened.name == "P" and reopened.shape_type == 13  # MSO_SHAPE_TYPE.PICTURE
    assert reopened.crop_left == pytest.approx(0.10) and reopened.rotation == pytest.approx(15)


def test_backgrounds_are_the_first_child_of_csld():
    _, slide = blank_slide()
    dml.set_background(slide._element, dml.background(dml.solid_fill("FFF2CC")))
    dml.set_background(slide._element, dml.background(dml.grad_fill([(0, "000000"), (100, "FFFFFF")], angle=90)))
    c_sld = slide._element[0]
    assert tags(c_sld)[:2] == ["bg", "spTree"] and tags(c_sld).count("bg") == 1  # replaced, not added twice
    assert tags(c_sld[0][0]) == ["gradFill", "effectLst"]
    ref = frag(dml.background(ref=(1003, "accent1")).replace("<p:bg>", f'<p:bg {nsdecls("p", "a")}>'))
    assert tags(ref) == ["bgRef"] and ref[0].get("idx") == "1003"
    with pytest.raises(ValueError):
        dml.background(dml.no_fill(), ref=(1001, "bg1"))


def test_apply_fonts_names_latin_ea_cs_in_schema_order():
    root = parse_xml(
        f'<a:p {nsdecls("a", "r")}><a:pPr><a:defRPr sz="1200"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>'
        '<a:latin typeface="Calibri"/></a:defRPr></a:pPr><a:r><a:rPr lang="ko-KR"><a:hlinkClick r:id="rId2"/>'
        '</a:rPr><a:t>x</a:t></a:r><a:endParaRPr lang="en-US"/></a:p>'
    )
    dml.apply_fonts(root, "Pretendard")
    def_rpr, rpr, end = root[0][0], root[1][0], root[2]
    assert tags(def_rpr) == ["solidFill", "latin", "ea", "cs"]
    assert tags(rpr) == ["latin", "ea", "cs", "hlinkClick"]
    assert tags(end) == ["latin", "ea", "cs"]
    assert {e.get("typeface") for e in (*def_rpr[1:], *rpr[:3], *end)} == {"Pretendard"}


def test_master_shape_ids_stay_within_int32():
    """python-pptx's own _next_shape_id counts every `id` attribute of the part, and a slide master carries
    p:sldLayoutId ids from 2147483649 up, so a shape added to a master got id 2147483660. PowerPoint stores shape ids
    as 32-bit signed integers and refuses to open such a deck (E_FAIL on Presentations.Open)."""
    prs = Presentation()
    master = prs.slide_master
    first = dml.add_sp(master.shapes, dml.sp_pr(0, 0, 100, 8), name="Band")
    second = dml.add_sp(master.shapes, dml.sp_pr(0, 20, 100, 8), name="Mark")
    layout_shape = dml.add_sp(prs.slide_layouts[6].shapes, dml.sp_pr(0, 40, 10, 10), name="Bar")
    for shape in (first, second, layout_shape):
        assert 0 < shape.shape_id < 2**31
    assert first.shape_id != second.shape_id
    ids = master._element.xpath("//p:cNvPr/@id")
    assert len(ids) == len(set(ids))
