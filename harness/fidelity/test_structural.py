"""Tests for the structural checks S1-S7 (structural.py, roundtrip.py) and the facts they compare (pdf_facts.py,
pptx_facts.py).

Every case is a small synthetic pair built here: a PyMuPDF PDF (one 960 x 540 pt page) and a python-pptx deck
(one 16:9 slide, 12192000 x 6858000 EMU) describing the same scene. The text uses tiny TrueType fonts built with
fontTools in memory (every glyph a box), so no installed font is needed and CI can run all of it. Only the S7 test
on the committed probe drives PowerPoint (`--run-powerpoint`).

The values asserted are the spec's (section 5.2) as the brief states them: bbox within 0.5 pt, sizes within
0.1 pt, colours exact, alpha within 1 %, stroke width within 0.01 pt, a picture of 50 % of the slide or more needs a
PDF image that large, the slide size within 1 EMU of the CropBox.
"""

import io
import math
import shutil
from pathlib import Path

import pymupdf
import pytest
from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.util import Emu

from harness.fidelity import pdf_facts, pptx_facts, roundtrip, structural
from harness.oracle.make_vertical import make_font, vertical_font_pdf
from harness.oracle.mupdf_inventory import inventory

REPO = Path(__file__).resolve().parents[2]
PROBE_PDF = REPO / "corpus" / "generated" / "probe_std.pdf"
PROBE_PPTX = REPO / "corpus" / "generated" / "probe.pptx"

W_PT, H_PT = 960, 540
EMU = 12700
SLIDE_W, SLIDE_H = W_PT * EMU, H_PT * EMU  # 12192000 x 6858000

RED_BOX = (100, 100, 220, 160)
BLUE_BOX = (300, 100, 420, 200)
IMAGE_BOX = (500, 100, 620, 190)
GRAD_BOX = (100, 440, 300, 500)

# ---- fixtures: fonts, images ------------------------------------------------------------------------------------


# Text styles of a scene: font program, BaseFont written into the PDF, PPTX typeface, b, i.
STYLES = {
    "regular": ("Deck Sans", "Regular", "DeckSans-Regular", False, False),
    "bold": ("Deck Sans", "Bold", "DeckSans-Bold", True, False),
    "italic": ("Deck Sans", "Regular", "DeckSans-Regular", False, True),  # PowerPoint-style synthetic italic: shear
    "fakebold": ("Deck Sans", "Regular", "DeckSans-Regular", True, False),  # PowerPoint's simulated bold: 2 Tr + w
}
FAKE_BOLD_WIDTH = 1 / 35  # PowerPoint's simulated bold: line width = font size / 35 (0.456 w at 15.96 pt)


def png_bytes(w=12, h=9, colour=(200, 30, 30)):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), colour).save(buf, format="PNG")
    return buf.getvalue()


# ---- scenes ------------------------------------------------------------------------------------------------------
# A scene is a list of elements, in paint order. Both builders draw the same list, so a pair is "the same slide";
# a test changes one side only.

def fill(box, rgb, alpha=1.0):
    return {"kind": "fill", "box": box, "rgb": rgb, "alpha": alpha}


def stroke(box, rgb, width):
    return {"kind": "stroke", "box": box, "rgb": rgb, "width": width}


def fill_stroke(box, fill_rgb, stroke_rgb, width):
    return {"kind": "fill_stroke", "box": box, "rgb": fill_rgb, "stroke": stroke_rgb, "width": width}


def image(box, line=None):
    """A bitmap; `line` = (rgb, width) gives it an outline (a PDF stroke, a p:pic a:ln)."""
    return {"kind": "image", "box": box, "line": line}


def pattern(box, tiled_picture=False):
    """A tiling-pattern fill: pattFill on the slide (a tiled blipFill with `tiled_picture`), a pattern in the PDF."""
    return {"kind": "pattern", "box": box, "tiled_picture": tiled_picture}


def text(origin, string, size, rgb, style="regular"):
    return {"kind": "text", "origin": origin, "text": string, "size": size, "rgb": rgb, "style": style}


def gradient(box):
    return {"kind": "gradient", "box": box}


def base_scene():
    return [
        fill(RED_BOX, (255, 0, 0)),
        stroke(BLUE_BOX, (0, 0, 255), 2.0),
        image(IMAGE_BOX),
        text((100, 300), "Hello World", 24, (51, 102, 153)),
        text((100, 360), "Bold Words", 18, (0, 0, 0), "bold"),
        text((100, 420), "Lean Words", 18, (0, 0, 0), "italic"),
    ]


def _set_font_names(doc, page, resource, base_font):
    """Make the PDF name a font the way PowerPoint does (BaseFont = PostScript name with a subset tag)."""
    for xref, _ext, _type, _basefont, name, _enc, _ref in page.get_fonts(full=True):
        if name != resource:
            continue
        targets = [xref]
        kind, value = doc.xref_get_key(xref, "DescendantFonts")
        if kind == "array":
            targets += [int(v) for v in value.strip("[]").split() if v.isdigit()][:1]
        for target in targets:
            doc.xref_set_key(target, "BaseFont", "/" + base_font)
            kind, value = doc.xref_get_key(target, "FontDescriptor")
            if kind == "xref":
                doc.xref_set_key(int(value.split()[0]), "FontName", "/" + base_font)


def _add_raw_paint(doc, page, category, name, xref, operators, first=False):
    """Register resource `name` (an object of `category`, e.g. Shading) and add a content stream painting it,
    after the page's content (before it with `first`)."""
    kind, value = doc.xref_get_key(page.xref, "Resources")
    target = int(value.split()[0]) if kind == "xref" else page.xref
    key = category if kind == "xref" else f"Resources/{category}"
    kind, existing = doc.xref_get_key(target, key)
    entries = existing.strip()[2:-2] if kind == "dict" else ""
    doc.xref_set_key(target, key, f"<< {entries} /{name} {xref} 0 R >>")
    content = doc.get_new_xref()
    doc.update_object(content, "<< >>")
    doc.update_stream(content, operators.encode("ascii"))
    xrefs = page.get_contents()
    xrefs = [content] + xrefs if first else xrefs + [content]
    doc.xref_set_key(page.xref, "Contents", "[" + " ".join(f"{x} 0 R" for x in xrefs) + "]")


def _add_shading(doc, page, box, first=False, height=H_PT):
    """An axial shading painted through a clip rectangle (how PowerPoint exports a gradient fill)."""
    x0, y0, x1, y1 = box
    shading = doc.get_new_xref()
    doc.update_object(shading, f"<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [{x0} 0 {x1} 0] /Function "
                               "<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> "
                               "/Extend [true true] >>")
    name = f"Sh{shading}"
    _add_raw_paint(doc, page, "Shading", name, shading,
                   f"q {x0} {height - y1} {x1 - x0} {y1 - y0} re W n /{name} sh Q", first)


def _add_pattern(doc, page, box, first=False, height=H_PT):
    """A rectangle filled with a coloured tiling pattern (how PowerPoint exports pattFill and tiled pictures)."""
    x0, y0, x1, y1 = box
    cell = doc.get_new_xref()
    doc.update_object(cell, "<< /Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 8 8] "
                            "/XStep 8 /YStep 8 /Resources << >> >>")
    doc.update_stream(cell, b"0 0 1 rg 0 0 4 4 re f")
    name = f"P{cell}"
    _add_raw_paint(doc, page, "Pattern", name, cell,
                   f"q /Pattern cs /{name} scn {x0} {height - y1} {x1 - x0} {y1 - y0} re f Q", first)


def build_pdf(path, scene, background=True, size=(W_PT, H_PT), pages=1, font_names=None, page_image=False,
              rotation=0, page_paint=None, scenes=None):
    """The scene as a PDF page. `font_names` overrides the BaseFont per style; `page_image` adds a full-page image;
    `rotation` sets /Rotate; `page_paint` ("gradient" or "pattern") paints the whole page with a shading or a
    tiling pattern as the page's first paint (a gradient or patterned slide background). `scenes` (one scene per
    page) replaces `scene` and `pages`."""
    doc = pymupdf.open()
    for scene in scenes or [scene] * pages:
        page = doc.new_page(width=size[0], height=size[1])
        if background:
            page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
        if page_image:
            page.insert_image(page.rect, stream=png_bytes(32, 18, (20, 120, 40)))
        fonts = {}
        for item in scene:
            kind = item["kind"]
            if kind in ("fill", "stroke", "fill_stroke"):
                rect = pymupdf.Rect(item["box"])
                fill_rgb = [v / 255 for v in item["rgb"]] if kind != "stroke" else None
                stroke_rgb = {"fill_stroke": item.get("stroke"), "stroke": item["rgb"]}.get(kind)
                stroke_rgb = [v / 255 for v in stroke_rgb] if stroke_rgb else None
                page.draw_rect(rect, color=stroke_rgb, fill=fill_rgb, width=item.get("width", 0) or 0,
                               fill_opacity=item.get("alpha", 1.0))
            elif kind == "image":
                page.insert_image(pymupdf.Rect(item["box"]), stream=png_bytes())
                if item.get("line"):  # PowerPoint strokes a picture's outline outside it: the frame grown by w/2
                    rgb, width = item["line"]
                    x0, y0, x1, y1 = item["box"]
                    half = width / 2
                    page.draw_rect(pymupdf.Rect(x0 - half, y0 - half, x1 + half, y1 + half),
                                   color=[v / 255 for v in rgb], width=width)
            elif kind in ("gradient", "pattern"):
                pass  # added after the page content below (raw content stream)
            elif kind == "text":
                family, style, ps_name, _b, italic = STYLES[item["style"]]
                resource = "F" + ps_name.replace("-", "")
                if resource not in fonts:
                    page.insert_font(fontname=resource, fontbuffer=make_font(family, style, ps_name))
                    fonts[resource] = ps_name
                morph = (pymupdf.Point(item["origin"]), pymupdf.Matrix(1, 0, 0.3333, 1, 0, 0)) if italic else None
                rgb = [v / 255 for v in item["rgb"]]
                if item["style"] == "fakebold":  # fill and stroke the glyphs in one colour (2 Tr)
                    page.insert_text(item["origin"], item["text"], fontname=resource, fontsize=item["size"],
                                     color=rgb, fill=rgb, render_mode=2, border_width=FAKE_BOLD_WIDTH)
                else:  # an item's "alpha" draws the glyphs at that opacity (0: invisible, M3-R46)
                    page.insert_text(item["origin"], item["text"], fontname=resource, fontsize=item["size"],
                                     color=rgb, morph=morph, fill_opacity=item.get("alpha", 1.0))
        for resource, ps_name in fonts.items():
            _set_font_names(doc, page, resource, (font_names or {}).get(ps_name, "ABCDEF+" + ps_name))
        for item in scene:
            if item["kind"] == "gradient":
                _add_shading(doc, page, item["box"], height=size[1])
            elif item["kind"] == "pattern":
                _add_pattern(doc, page, item["box"], height=size[1])
        if page_paint == "gradient":
            _add_shading(doc, page, (0, 0, size[0], size[1]), first=True, height=size[1])
        elif page_paint == "pattern":
            _add_pattern(doc, page, (0, 0, size[0], size[1]), first=True, height=size[1])
        if rotation:
            page.set_rotation(rotation)
    doc.save(str(path))
    doc.close()
    return path


def _emu(v):
    return Emu(int(round(v * EMU)))


def _box_args(box):
    x0, y0, x1, y1 = box
    return _emu(x0), _emu(y0), _emu(x1 - x0), _emu(y1 - y0)


NSDECL = ('xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
          'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" '
          'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"')
PATT_FILL = ('<a:pattFill prst="dkDnDiag"><a:fgClr><a:srgbClr val="1F3864"/></a:fgClr><a:bgClr><a:srgbClr '
             'val="FFFFFF"/></a:bgClr></a:pattFill>')
TILED_BLIP = ('<a:blipFill><a:blip r:embed="rId99"/><a:tile tx="0" ty="0" sx="100000" sy="100000" flip="none" '
              'algn="tl"/></a:blipFill>')
STRETCHED_BLIP = '<a:blipFill><a:blip r:embed="rId99"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>'
GRAD_FILL = ('<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr '
             'val="0000FF"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill>')


def _xml(fragment):
    """A DrawingML / PresentationML fragment (the a:, p: and r: prefixes declared)."""
    tag = fragment[1:].split(None, 1)[0].split(">", 1)[0].split("/", 1)[0]
    return etree.fromstring(fragment.replace(f"<{tag}", f"<{tag} {NSDECL}", 1))


def _replace_fill(sp_pr, fill_xml):
    """Put `fill_xml` in place of the fill of an spPr (after its geometry)."""
    for child in list(sp_pr):
        if etree.QName(child).localname in ("noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill"):
            sp_pr.remove(child)
    geometry = [c for c in sp_pr if etree.QName(c).localname in ("prstGeom", "custGeom")]
    position = list(sp_pr).index(geometry[0]) + 1 if geometry else len(sp_pr)
    sp_pr.insert(position, _xml(fill_xml))


def _set_alpha(fill_format_or_colour_parent, alpha):
    """Add <a:alpha> to the srgbClr under a solidFill."""
    clr = fill_format_or_colour_parent.find(".//" + qn("a:srgbClr"))
    el = etree.SubElement(clr, qn("a:alpha"))
    el.set("val", str(int(round(alpha * 100000))))


def build_pptx(path, scene, names=True, size=(SLIDE_W, SLIDE_H), slides=1, typeface="Deck Sans", scenes=None,
               pages=None):
    """The scene as a slide. With `names`, every shape gets a provenance name pdf:p<page>:z<n> in paint order (page
    1, or `pages[i]` for slide i). `scenes` (one scene per slide) replaces `scene` and `slides`."""
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(size[0]), Emu(size[1])
    for number, scene in enumerate(scenes or [scene] * slides):
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        shapes = slide.shapes
        for z, item in enumerate(scene, start=1):
            kind = item["kind"]
            shape = None
            if kind in ("fill", "stroke", "fill_stroke", "gradient", "pattern"):
                shape = shapes.add_shape(MSO_SHAPE.RECTANGLE, *_box_args(item["box"]))
                if kind in ("fill", "fill_stroke"):
                    shape.fill.solid()
                    shape.fill.fore_color.rgb = RGBColor(*item["rgb"])
                    if item.get("alpha", 1.0) < 1.0:
                        _set_alpha(shape._element.spPr.find(qn("a:solidFill")), item["alpha"])
                elif kind == "gradient":
                    shape.fill.gradient()
                elif kind == "pattern":
                    shape.fill.background()
                    _replace_fill(shape._element.spPr, TILED_BLIP if item["tiled_picture"] else PATT_FILL)
                else:
                    shape.fill.background()
                if kind in ("stroke", "fill_stroke"):
                    shape.line.color.rgb = RGBColor(*(item["rgb"] if kind == "stroke" else item["stroke"]))
                    shape.line.width = _emu(item["width"])
                else:
                    shape.line.fill.background()
            elif kind == "image":
                shape = shapes.add_picture(io.BytesIO(png_bytes()), *_box_args(item["box"]))
                if item.get("line"):
                    rgb, width = item["line"]
                    shape.line.color.rgb = RGBColor(*rgb)
                    shape.line.width = _emu(width)
            elif kind == "text":
                x, y = item["origin"]
                shape = shapes.add_textbox(_emu(x), _emu(y - item["size"]), _emu(400), _emu(item["size"] * 1.5))
                run = shape.text_frame.paragraphs[0].add_run()
                run.text = item["text"]
                _family, _style, _ps, bold, italic = STYLES[item["style"]]
                rpr = run.font._rPr
                rpr.set("sz", str(int(round(item["size"] * 100))))
                run.font.bold = bold
                run.font.italic = italic
                run.font.color.rgb = RGBColor(*item["rgb"])
                if item.get("grad"):  # the run filled with a gradient (M5 Task 3: a PDF shading in a glyph clip)
                    solid = rpr.find(qn("a:solidFill"))
                    solid.addprevious(_xml(GRAD_FILL))
                    rpr.remove(solid)
                for tag in ("a:latin", "a:ea"):
                    el = etree.SubElement(rpr, qn(tag))
                    el.set("typeface", typeface)
            if shape is not None and names:
                shape.name = f"pdf:p{pages[number] if pages else 1}:z{z} {kind}"
    prs.save(str(path))
    return path


def facts(tmp_path, pdf_scene, pptx_scene=None, pdf_kwargs=None, pptx_kwargs=None, page=0, slide=0):
    pdf = build_pdf(tmp_path / "in.pdf", pdf_scene, **(pdf_kwargs or {}))
    pptx = build_pptx(tmp_path / "out.pptx", pdf_scene if pptx_scene is None else pptx_scene, **(pptx_kwargs or {}))
    return pdf_facts.page_facts(pdf, page), pptx_facts.slide_facts(pptx, slide)


def run_checks(tmp_path, pdf_scene, pptx_scene=None, **kwargs):
    page, slide = facts(tmp_path, pdf_scene, pptx_scene, **kwargs)
    return structural.check(page, slide)


def replaced(scene, index, **changes):
    out = [dict(item) for item in scene]
    out[index].update(changes)
    return out


def without(scene, index):
    return [dict(item) for i, item in enumerate(scene) if i != index]


# ---- the pair -----------------------------------------------------------------------------------------------------


def test_matching_pair_passes_s1_to_s6(tmp_path):
    result = run_checks(tmp_path, base_scene())
    assert set(result) == {"S1", "S2", "S3", "S4", "S5", "S6"}
    for key, value in result.items():
        assert value["status"] == "pass", (key, value)
        assert isinstance(value["detail"], str) and value["detail"]


# ---- PDF facts ------------------------------------------------------------------------------------------------------


def test_pdf_facts_split_fill_stroke_and_read_the_oracle(tmp_path):
    scene = [fill_stroke(RED_BOX, (255, 0, 0), (0, 0, 255), 1.5), image(IMAGE_BOX), gradient(GRAD_BOX)]
    page = pdf_facts.page_facts(build_pdf(tmp_path / "a.pdf", scene), 0)
    assert page.index == 0 and page.page_count == 1
    assert page.size_pt == pytest.approx((960, 540))
    kinds = [(d["kind"], d["fill"], d["stroke"]) for d in page.drawings]
    # the background first, then the fs rectangle as a fill followed by a stroke
    assert kinds == [("fill", [255, 255, 255], None), ("fill", [255, 0, 0], None), ("stroke", None, [0, 0, 255])]
    assert page.drawings[1]["bbox"] == pytest.approx(list(RED_BOX), abs=0.01)
    assert page.drawings[2]["width"] == pytest.approx(1.5)
    assert page.drawings[2]["dash"] == []
    assert page.images == [pytest.approx(list(IMAGE_BOX), abs=0.01)]
    assert page.shadings == [pytest.approx(list(GRAD_BOX), abs=0.01)]


def test_pdf_facts_spans_and_fonts(tmp_path):
    page = pdf_facts.page_facts(build_pdf(tmp_path / "a.pdf", base_scene()), 0)
    spans = {s["text"]: s for s in page.spans if s["text"].strip()}
    hello = spans["Hello World"]
    assert hello["size"] == pytest.approx(24)
    assert hello["color"] == [51, 102, 153]
    assert hello["font"] == "DeckSans-Regular"
    assert hello["origin"] == pytest.approx((100, 300), abs=0.01)
    assert (hello["bold"], hello["italic"]) == (False, False)
    assert (spans["Bold Words"]["bold"], spans["Bold Words"]["italic"]) == (True, False)
    assert (spans["Lean Words"]["bold"], spans["Lean Words"]["italic"]) == (False, True)
    fonts = {f["basefont"]: f for f in page.fonts}
    assert fonts["ABCDEF+DeckSans-Regular"]["family_name1"] == "Deck Sans"
    assert fonts["ABCDEF+DeckSans-Regular"]["embedded"] is True
    assert fonts["ABCDEF+DeckSans-Bold"]["family_name1"] == "Deck Sans"


def test_bold_follows_the_font_family_member_not_the_weight(tmp_path):
    """A Regular member of its own heavy family (PowerPoint: typeface "Pretendard Black", b=0) is not bold, even
    with a weight of 800 (MuPDF's own bold flag follows the weight); a Bold member is bold."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.insert_font(fontname="FX", fontbuffer=make_font("Deck Sans ExtraBold", "Regular", "DeckSans-ExtraBold", 800))
    page.insert_text((100, 100), "Heavy", fontname="FX", fontsize=20)
    _set_font_names(doc, page, "FX", "ABCDEF+DeckSans-ExtraBold")
    xref = [f[0] for f in page.get_fonts(full=True) if f[4] == "FX"][0]
    descendant = int(doc.xref_get_key(xref, "DescendantFonts")[1].strip("[]").split()[0])
    descriptor = int(doc.xref_get_key(descendant, "FontDescriptor")[1].split()[0])
    doc.xref_set_key(descriptor, "FontWeight", "800")
    doc.save(str(tmp_path / "heavy.pdf"))
    spans = [s for s in pdf_facts.page_facts(tmp_path / "heavy.pdf", 0).spans if s["text"].strip()]
    assert [(s["text"], s["bold"], s["italic"]) for s in spans] == [("Heavy", False, False)]


def test_bold_and_italic_of_fonts_without_a_name_table(tmp_path):
    """Not embedded (base-14): MuPDF's span flags decide."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.insert_text((100, 100), "Strong", fontname="hebo", fontsize=20)
    page.insert_text((100, 200), "Slanted", fontname="heit", fontsize=20)
    page.insert_text((100, 300), "Plain", fontname="helv", fontsize=20)
    doc.save(str(tmp_path / "base14.pdf"))
    page_facts = pdf_facts.page_facts(tmp_path / "base14.pdf", 0)
    styles = {s["text"]: (s["bold"], s["italic"]) for s in page_facts.spans if s["text"].strip()}
    assert styles == {"Strong": (True, False), "Slanted": (False, True), "Plain": (False, False)}
    assert all(f["embedded"] is False and f["family_name1"] is None for f in page_facts.fonts)


def test_simulated_style_suffix_of_the_base_font():
    """Office names a simulated style in the BaseFont: Name,Bold / Name,Italic / Name,BoldItalic."""
    assert pdf_facts.simulated_style("Pretendard-Light,Bold") == (True, False)
    assert pdf_facts.simulated_style("ABCDEF+Pretendard,Italic") == (False, True)
    assert pdf_facts.simulated_style("Pretendard,BoldItalic") == (True, True)
    assert pdf_facts.simulated_style("GothicA1-Bold") == (False, False)


def test_drawing_bbox_includes_every_subpath_point(tmp_path):
    """The bbox is that of all path points (contract 0002 section 4), not PyMuPDF's `rect`, which can miss the start
    point of a subpath that follows a rectangle (5 pt on a corpus page)."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    shape = page.new_shape()
    shape.draw_rect(pymupdf.Rect(130, 168.75, 326.25, 171.25))
    shape.draw_polyline([(325, 167.5), (330, 170), (325, 172.5), (325, 167.5)])
    shape.finish(color=None, fill=(0, 0, 0))
    shape.commit()
    doc.save(str(tmp_path / "arrow.pdf"))
    drawings = pdf_facts.page_facts(tmp_path / "arrow.pdf", 0).drawings
    assert drawings[0]["bbox"] == pytest.approx([130, 167.5, 330, 172.5], abs=0.01)


# ---- PPTX facts -----------------------------------------------------------------------------------------------------


def test_pptx_facts_shapes_pictures_runs_order(tmp_path):
    slide = pptx_facts.slide_facts(build_pptx(tmp_path / "a.pptx", base_scene()), 0)
    assert slide.index == 0 and slide.slide_count == 1
    assert slide.size_emu == (SLIDE_W, SLIDE_H)
    assert slide.size_pt == pytest.approx((960, 540))
    assert slide.pictures == [pytest.approx(list(IMAGE_BOX), abs=0.01)]
    # text boxes paint nothing: not shapes
    assert [s["name"] for s in slide.shapes] == ["pdf:p1:z1 fill", "pdf:p1:z2 stroke"]
    red, blue = slide.shapes
    assert red["bbox"] == pytest.approx(list(RED_BOX), abs=0.01)
    assert red["fill"] == {"kind": "solid", "rgb": [255, 0, 0], "alpha": 1.0}
    assert red["line"] is None and red["line_w"] is None
    assert blue["fill"] is None
    assert blue["line"]["rgb"] == [0, 0, 255] and blue["line_w"] == pytest.approx(2.0)
    assert blue["dash"] == "solid"
    assert slide.order == [f"pdf:p1:z{z} {item['kind']}" for z, item in enumerate(base_scene(), start=1)]
    runs = {r["text"]: r for r in slide.runs}
    assert runs["Hello World"]["size"] == pytest.approx(24)
    assert runs["Hello World"]["color"] == {"rgb": [51, 102, 153], "alpha": 1.0}
    assert runs["Hello World"]["typeface_latin"] == "Deck Sans" and runs["Hello World"]["typeface_ea"] == "Deck Sans"
    assert (runs["Bold Words"]["bold"], runs["Lean Words"]["italic"]) == (True, True)
    assert (runs["Hello World"]["bold"], runs["Hello World"]["italic"]) == (False, False)


def test_pptx_facts_group_transform_and_theme_colours(tmp_path):
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(SLIDE_W), Emu(SLIDE_H)
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    group = slide.shapes.add_group_shape()
    inner = group.shapes.add_shape(MSO_SHAPE.RECTANGLE, _emu(0), _emu(0), _emu(100), _emu(50))
    inner.name = "inner"
    # python-pptx's default style: fill from fillRef (accent1), line from lnRef; nothing explicit in spPr
    xfrm = group._element.grpSpPr.get_or_add_xfrm()
    xfrm.get_or_add_off().x, xfrm.get_or_add_off().y = _emu(200), _emu(100)
    xfrm.get_or_add_ext().cx, xfrm.get_or_add_ext().cy = _emu(200), _emu(100)  # child space 100 x 50 -> 200 x 100
    xfrm.get_or_add_chOff().x, xfrm.get_or_add_chOff().y = _emu(0), _emu(0)
    xfrm.get_or_add_chExt().cx, xfrm.get_or_add_chExt().cy = _emu(100), _emu(50)
    prs.save(str(tmp_path / "g.pptx"))
    facts_ = pptx_facts.slide_facts(tmp_path / "g.pptx", 0)
    [shape] = facts_.shapes
    assert shape["name"] == "inner"
    assert shape["bbox"] == pytest.approx([200, 100, 400, 200], abs=0.01)
    # python-pptx's style: fillRef idx 3 = the theme's third fill style, a gradient
    assert shape["fill"] == {"kind": "grad"}
    # lnRef idx 1: the theme's first line style, 9525 EMU, phClr with shade/satMod (not computed: unresolved)
    assert shape["line_w"] == pytest.approx(0.75)
    assert shape["line"]["rgb"] is None and "shade" in shape["line"]["unresolved"]
    assert facts_.order == ["inner"]
    # fillRef idx 1: the theme's solid phClr fill, coloured by the reference (accent1 of the default theme)
    prs = Presentation(str(tmp_path / "g.pptx"))
    style = prs.slides[0].shapes[0].shapes[0]._element.find(qn("p:style"))
    style.find(qn("a:fillRef")).set("idx", "1")
    prs.save(str(tmp_path / "g.pptx"))
    [shape] = pptx_facts.slide_facts(tmp_path / "g.pptx", 0).shapes
    assert shape["fill"] == {"kind": "solid", "rgb": [0x4F, 0x81, 0xBD], "alpha": 1.0}


def test_hidden_shapes_and_groups_paint_nothing(tmp_path):
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(SLIDE_W), Emu(SLIDE_H)
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    group = slide.shapes.add_group_shape()
    group.name = "group"
    inner = group.shapes.add_shape(MSO_SHAPE.RECTANGLE, _emu(10), _emu(10), _emu(50), _emu(50))
    inner.name = "inner"
    group._element.find(qn("p:nvGrpSpPr")).find(qn("p:cNvPr")).set("hidden", "1")
    loose = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, _emu(100), _emu(10), _emu(50), _emu(50))
    loose.name = "loose"
    loose._element.nvSpPr.cNvPr.set("hidden", "1")
    shown = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, _emu(200), _emu(10), _emu(50), _emu(50))
    shown.name = "shown"
    prs.save(str(tmp_path / "h.pptx"))
    facts_ = pptx_facts.slide_facts(tmp_path / "h.pptx", 0)
    assert facts_.order == ["inner", "loose", "shown"]
    assert [s["name"] for s in facts_.shapes] == ["shown"]


def _bullet_deck(path, paragraphs):
    """One text box; paragraphs = [(level, bullet XML or "", text)], 20 pt, colour 262626."""
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(SLIDE_W), Emu(SLIDE_H)
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    box = slide.shapes.add_textbox(_emu(50), _emu(50), _emu(400), _emu(400))
    box.name = "List"
    body = box.text_frame._txBody
    for p in body.findall(qn("a:p")):
        body.remove(p)
    for level, bullet, string in paragraphs:
        xml = (f'<a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:pPr lvl="{level}">{bullet}'
               f'</a:pPr>' + (f'<a:r><a:rPr sz="2000"><a:solidFill><a:srgbClr val="262626"/></a:solidFill>'
                              f'</a:rPr><a:t>{string}</a:t></a:r>' if string else "") + "</a:p>")
        body.append(etree.fromstring(xml))
    prs.save(str(path))
    return path


def test_bullets_and_numbers_are_text(tmp_path):
    """PowerPoint exports a paragraph's bullet (a:buChar) and number (a:buAutoNum) as glyphs of the text layer:
    the slide's text has them too, sized by buSzPct, coloured by buClr, else like the paragraph's first run.
    Numbers count per level; a paragraph at a shallower level restarts the deeper ones; empty paragraphs get none."""
    char = ('<a:buClr><a:srgbClr val="C00000"/></a:buClr><a:buSzPct val="120000"/><a:buFont typeface="Pretendard"/>'
            '<a:buChar char="&#8226;"/>')
    arabic = '<a:buAutoNum type="arabicPeriod"/>'
    alpha = '<a:buAutoNum type="alphaLcParenR" startAt="5"/>'
    roman = '<a:buAutoNum type="romanUcPeriod"/>'
    path = _bullet_deck(tmp_path / "b.pptx", [
        (0, char, "One"), (0, char, ""), (0, arabic, "Two"), (1, alpha, "Sub"), (1, alpha, "Sub"),
        (0, arabic, "Three"), (1, alpha, "Sub"), (2, roman, "Deep"), (2, roman, "Deep"), (0, "<a:buNone/>", "Plain"),
    ])
    runs = pptx_facts.slide_facts(path, 0).runs
    assert "".join(r["text"] for r in runs) == "•One1.Twoe)Subf)Sub2.Threee)SubI.DeepII.DeepPlain"
    bullet = runs[0]
    assert bullet["size"] == pytest.approx(24.0) and bullet["color"]["rgb"] == [0xC0, 0, 0]
    assert bullet["typeface_latin"] == "Pretendard" and bullet["shape"] == "List"
    number = runs[2]
    assert number["text"] == "1." and number["size"] == pytest.approx(20.0)
    assert number["color"]["rgb"] == [0x26, 0x26, 0x26]


def test_unknown_numbering_scheme_is_unresolved(tmp_path):
    path = _bullet_deck(tmp_path / "b.pptx", [(0, '<a:buAutoNum type="hebrew2Minus"/>', "Item")])
    runs = pptx_facts.slide_facts(path, 0).runs
    assert runs[0]["text"] == "" and "hebrew2Minus" in runs[0]["unresolved"]


def test_s2_reports_unresolved_numbering(tmp_path):
    pdf = build_pdf(tmp_path / "in.pdf", [text((100, 300), "Item", 20, (38, 38, 38))])
    path = _bullet_deck(tmp_path / "b.pptx", [(0, '<a:buAutoNum type="hebrew2Minus"/>', "Item")])
    s2 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S2"]
    assert s2["status"] == "fail" and "unresolved bullet" in s2["detail"]


def test_unresolvable_colour_is_reported_not_guessed(tmp_path):
    path = build_pptx(tmp_path / "a.pptx", base_scene())
    prs = Presentation(str(path))
    rpr = [r for s in prs.slides[0].shapes if s.has_text_frame for p in s.text_frame.paragraphs for r in p.runs
           if r.text == "Hello World"][0].font._rPr
    srgb = rpr.find(qn("a:solidFill")).find(qn("a:srgbClr"))
    scheme = etree.SubElement(rpr.find(qn("a:solidFill")), qn("a:schemeClr"))
    scheme.set("val", "accent1")
    etree.SubElement(scheme, qn("a:lumMod")).set("val", "75000")
    rpr.find(qn("a:solidFill")).remove(srgb)
    prs.save(str(path))
    run = [r for r in pptx_facts.slide_facts(path, 0).runs if r["text"] == "Hello World"][0]
    assert run["color"]["rgb"] is None and "lumMod" in run["color"]["unresolved"]


# ---- S1 -----------------------------------------------------------------------------------------------------------


def _with_full_slide_picture(path):
    prs = Presentation(str(path))
    prs.slides[0].shapes.add_picture(io.BytesIO(png_bytes(32, 18)), 0, 0, Emu(SLIDE_W), Emu(SLIDE_H))
    prs.save(str(path))
    return path


def test_full_slide_picture_fails_s1(tmp_path):
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    pptx = _with_full_slide_picture(build_pptx(tmp_path / "out.pptx", base_scene()))
    s1 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S1"]
    assert s1["status"] == "fail"
    assert "50 %" in s1["detail"]


def test_full_slide_picture_alone_fails_s1_by_size(tmp_path):
    """One picture for one PDF image (count fine), but it covers the slide and the PDF image is small."""
    scene = without(base_scene(), 2)
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    pptx = _with_full_slide_picture(build_pptx(tmp_path / "out.pptx", scene))
    s1 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S1"]
    assert s1["status"] == "fail"
    assert "100.0 % of the slide" in s1["detail"]


def test_full_slide_picture_passes_s1_when_the_pdf_image_is_that_size(tmp_path):
    scene = without(base_scene(), 2)
    pdf = build_pdf(tmp_path / "in.pdf", scene, page_image=True)
    pptx = _with_full_slide_picture(build_pptx(tmp_path / "out.pptx", scene))
    s1 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S1"]
    assert s1["status"] == "pass", s1


def test_picture_where_the_pdf_painted_no_bitmap_fails_s1(tmp_path):
    """M1-R37: every picture lies inside a PDF image paint (+0.5 pt); 0.4 pt off passes, 0.6 pt fails."""
    near = replaced(base_scene(), 2, box=(500.4, 100, 620.4, 190))
    assert run_checks(tmp_path, base_scene(), near)["S1"]["status"] == "pass"
    off = replaced(base_scene(), 2, box=(500.6, 100, 620.6, 190))
    s1 = run_checks(tmp_path, base_scene(), off)["S1"]
    assert s1["status"] == "fail"
    assert "inside no PDF image" in s1["detail"]


def test_more_pictures_than_pdf_images_fails_s1(tmp_path):
    scene = base_scene() + [image((510, 110, 520, 120))]  # inside the PDF image, but a second picture
    s1 = run_checks(tmp_path, base_scene(), scene)["S1"]
    assert s1["status"] == "fail"
    assert "2 pictures" in s1["detail"] and "1 PDF image" in s1["detail"]


# ---- S2 -----------------------------------------------------------------------------------------------------------


def test_changed_character_fails_s2(tmp_path):
    s2 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 3, text="Hellp World"))["S2"]
    assert s2["status"] == "fail"
    assert "CER" in s2["detail"]


def test_s2_ignores_all_whitespace(tmp_path):
    """M1-R34: the PDF text layer has no spaces between Hangul words; whitespace is removed on both sides."""
    s2 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 3, text="Hello  World "))["S2"]
    assert s2["status"] == "pass", s2
    s2 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 3, text="HelloWorld"))["S2"]
    assert s2["status"] == "pass", s2


def test_s2_says_baselines_are_checked_by_s7(tmp_path):
    s2 = run_checks(tmp_path, base_scene())["S2"]
    assert "S7" in s2["detail"] and "baseline" in s2["detail"]


def test_s2_text_in_another_order_fails(tmp_path):
    scene = base_scene()
    swapped = scene[:3] + [scene[4], scene[3], scene[5]]
    assert run_checks(tmp_path, scene, swapped)["S2"]["status"] == "fail"


@pytest.mark.parametrize("size,status", [(24.05, "pass"), (24.1, "pass"), (24.2, "fail"), (23.8, "fail")])
def test_s2_size_within_a_tenth_of_a_point(tmp_path, size, status):
    s2 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 3, size=size))["S2"]
    assert s2["status"] == status, s2
    if status == "fail":
        assert "size" in s2["detail"]


def test_s2_colour_must_be_exact(tmp_path):
    s2 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 3, rgb=(51, 102, 154)))["S2"]
    assert s2["status"] == "fail"
    assert "colour" in s2["detail"]


def test_s2_bold_must_match(tmp_path):
    s2 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 4, style="regular"))["S2"]
    assert s2["status"] == "fail"
    assert "bold" in s2["detail"]


def test_s2_italic_must_match(tmp_path):
    s2 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 5, style="regular"))["S2"]
    assert s2["status"] == "fail"
    assert "italic" in s2["detail"]


def test_s2_unresolved_colour_fails(tmp_path):
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    path = build_pptx(tmp_path / "out.pptx", base_scene())
    prs = Presentation(str(path))
    for shape in prs.slides[0].shapes:
        if shape.has_text_frame:
            for paragraph in shape.text_frame.paragraphs:
                for run in paragraph.runs:
                    clr = run.font._rPr.find(qn("a:solidFill")).find(qn("a:srgbClr"))
                    etree.SubElement(clr, qn("a:lumMod")).set("val", "100000")
    prs.save(str(path))
    s2 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S2"]
    assert s2["status"] == "fail"
    assert "unresolved colour" in s2["detail"]


def test_s2_passes_without_text_on_either_side(tmp_path):
    """M1-R70: two empty texts have CER 0, so S2 passes; n/a is only for what the converter cannot support."""
    s2 = run_checks(tmp_path, base_scene()[:3])["S2"]
    assert s2["status"] == "pass", s2
    assert "no text" in s2["detail"]


def test_s2_keeps_glyphs_past_the_page_edge(tmp_path):
    """F4: text that runs past the slide edge is in the content stream, and the oracle, the walker and the slide keep
    it; S2 must not clip the PDF's glyphs to the page box (TEXT_MEDIABOX_CLIP)."""
    scene = [text((W_PT - 60, 300), "Hello World", 24, (51, 102, 153))]  # "World" lies right of the page
    s2 = run_checks(tmp_path, scene)["S2"]
    assert s2["status"] == "pass", s2
    page = pdf_facts.page_facts(tmp_path / "in.pdf", 0)
    assert "".join(s["text"] for s in page.spans).replace(" ", "") == "HelloWorld"
    directions = pdf_facts.text_directions(pymupdf.open(str(tmp_path / "in.pdf"))[0])
    assert directions.find(W_PT - 60 + 6 * 24 * 0.6, 300) is not None  # "W", past the edge, has its direction (S7)


def test_s2_fails_when_the_slide_lacks_the_text(tmp_path):
    assert run_checks(tmp_path, base_scene(), base_scene()[:3])["S2"]["status"] == "fail"


# ---- S3 -----------------------------------------------------------------------------------------------------------


def test_missing_rectangle_fails_s3(tmp_path):
    s3 = run_checks(tmp_path, base_scene(), without(base_scene(), 0))["S3"]
    assert s3["status"] == "fail"
    assert "unmatched" in s3["detail"]


def test_extra_rectangle_fails_s3(tmp_path):
    scene = base_scene() + [fill((700, 300, 800, 350), (0, 255, 0))]
    assert run_checks(tmp_path, base_scene(), scene)["S3"]["status"] == "fail"


@pytest.mark.parametrize("shift,status", [(0.4, "pass"), (0.6, "fail")])
def test_s3_bbox_within_half_a_point(tmp_path, shift, status):
    x0, y0, x1, y1 = RED_BOX
    scene = replaced(base_scene(), 0, box=(x0 + shift, y0, x1 + shift, y1))
    assert run_checks(tmp_path, base_scene(), scene)["S3"]["status"] == status


def test_s3_colour_must_be_exact(tmp_path):
    s3 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 0, rgb=(254, 0, 0)))["S3"]
    assert s3["status"] == "fail"
    assert "colour" in s3["detail"]


@pytest.mark.parametrize("alpha,status", [(0.505, "pass"), (0.49, "pass"), (0.52, "fail")])
def test_s3_alpha_within_one_percent(tmp_path, alpha, status):
    pdf_scene = replaced(base_scene(), 0, alpha=0.5)
    s3 = run_checks(tmp_path, pdf_scene, replaced(base_scene(), 0, alpha=alpha))["S3"]
    assert s3["status"] == status, s3


@pytest.mark.parametrize("width,status", [(2.005, "pass"), (2.02, "fail")])
def test_s3_stroke_width_within_a_hundredth_of_a_point(tmp_path, width, status):
    s3 = run_checks(tmp_path, base_scene(), replaced(base_scene(), 1, width=width))["S3"]
    assert s3["status"] == status, s3


def test_s3_fill_and_stroke_may_be_merged_or_split(tmp_path):
    """M1-R38: a PDF fs path is a fill + a stroke; one shape with fill and line, or two shapes, both match."""
    pdf_scene = [fill_stroke(RED_BOX, (255, 0, 0), (0, 0, 255), 1.0)]
    assert run_checks(tmp_path, pdf_scene)["S3"]["status"] == "pass"
    split = [fill(RED_BOX, (255, 0, 0)), stroke(RED_BOX, (0, 0, 255), 1.0)]
    assert run_checks(tmp_path, pdf_scene, split)["S3"]["status"] == "pass"
    merged_pdf = [fill(RED_BOX, (255, 0, 0)), stroke(RED_BOX, (0, 0, 255), 1.0)]
    assert run_checks(tmp_path, merged_pdf, pdf_scene)["S3"]["status"] == "pass"


def test_s3_background_may_be_a_full_slide_shape(tmp_path):
    """M1-R39: the PDF background is subtracted; a matching full-slide shape on the slide is removed too."""
    with_bg = [fill((0, 0, W_PT, H_PT), (255, 255, 255))] + base_scene()
    assert run_checks(tmp_path, base_scene(), with_bg)["S3"]["status"] == "pass"
    wrong_bg = [fill((0, 0, W_PT, H_PT), (250, 250, 250))] + base_scene()
    assert run_checks(tmp_path, base_scene(), wrong_bg)["S3"]["status"] == "fail"


def test_s3_counts_a_full_page_fill_painted_later_as_content(tmp_path):
    """No background drawing first: a later full-page fill is the first drawing covering the page, subtracted
    on both sides (M1-R39), so the counts still agree."""
    scene = base_scene() + [fill((0, 0, W_PT, H_PT), (10, 20, 30), alpha=0.3)]
    assert run_checks(tmp_path, scene, pdf_kwargs={"background": False})["S3"]["status"] == "pass"


def test_s3_gradient_must_be_a_gradfill_shape(tmp_path):
    """M1-R35: every PDF shading is matched by a gradFill shape (bbox within 0.5 pt); never by a picture."""
    scene = base_scene() + [gradient(GRAD_BOX)]
    assert run_checks(tmp_path, scene)["S3"]["status"] == "pass"
    solid = base_scene() + [fill(GRAD_BOX, (128, 0, 128))]
    s3 = run_checks(tmp_path, scene, solid)["S3"]
    assert s3["status"] == "fail" and "shading" in s3["detail"]
    as_picture = base_scene() + [image(GRAD_BOX)]
    s3 = run_checks(tmp_path, scene, as_picture)["S3"]
    assert s3["status"] == "fail" and "picture" in s3["detail"]


# M5-R7: a run's gradFill is the shading of its glyphs. The text item at (100, 300), 24 pt, is a text box whose frame
# is (100, 276, 500, 312) on the slide; a shading in its glyph clip has the glyphs' box, inside that frame.
GLYPH_BOX = (100.4, 282, 230, 306)


def grad_text(origin, string, size):
    """Text whose run is filled with a gradient on the slide (an a:gradFill in its rPr); plain text in the PDF."""
    return {**text(origin, string, size, (0, 0, 0)), "grad": True}


def test_pptx_facts_list_text_boxes_with_a_gradient_run(tmp_path):
    slide = pptx_facts.slide_facts(build_pptx(tmp_path / "a.pptx", [grad_text((100, 300), "Hello", 24),
                                                                    text((100, 400), "Plain", 18, (0, 0, 0))]), 0)
    assert slide.text_gradients == [{"name": "pdf:p1:z1 text", "bbox": pytest.approx([100, 276, 500, 312], abs=0.01),
                                     "size": pytest.approx(24)}]
    assert slide.shapes == []  # a text box paints nothing of its own
    assert [r["color"].get("unresolved") for r in slide.runs] == ["text gradFill", None]


def test_s3_a_text_gradfill_matches_the_shading_of_its_glyphs(tmp_path):
    """M5-R7: a shading the slide writes as the gradFill of a text run is matched by that text box: the shading's box
    lies inside the box's frame, grown by the glyphs' reach (0.5 pt + a quarter of the size)."""
    pdf = [text((100, 300), "Hello World", 24, (0, 0, 0)), gradient(GLYPH_BOX)]
    s3 = run_checks(tmp_path, pdf, [grad_text((100, 300), "Hello World", 24)])["S3"]
    assert s3["status"] == "pass", s3["detail"]
    assert "1 text gradFill" in s3["detail"] and s3["counts"]["text gradients"] == 1
    plain = run_checks(tmp_path, pdf, [text((100, 300), "Hello World", 24, (0, 0, 0))])["S3"]
    assert plain["status"] == "fail" and "shadings without a gradFill" in plain["detail"]


@pytest.mark.parametrize("box, status", [
    ((94.5, 270.5, 505.5, 317.5), "pass"),  # 5.5 pt past every side: 0.5 + 24 / 4 = 6.5 pt is the reach
    ((92.5, 282, 230, 306), "fail"),  # 7.5 pt past the left side
    ((100.4, 282, 230, 330), "fail"),  # 18 pt below the frame
])
def test_s3_a_text_gradfill_reaches_a_quarter_of_its_size_past_its_frame(tmp_path, box, status):
    pdf = [text((100, 300), "Hello World", 24, (0, 0, 0)), gradient(box)]
    assert run_checks(tmp_path, pdf, [grad_text((100, 300), "Hello World", 24)])["S3"]["status"] == status


def test_s3_one_shading_over_the_lines_of_several_text_boxes(tmp_path):
    """One glyph clip over two lines, each written as its own text box with a gradient run: the shading lies inside
    the two frames together, and both text gradFills are matched by it."""
    lines = [text((100, 300), "Hello World", 24, (0, 0, 0)), text((100, 330), "Hello Again", 24, (0, 0, 0))]
    pdf = lines + [gradient((100.4, 282, 300, 336))]
    slide = [grad_text((100, 300), "Hello World", 24), grad_text((100, 330), "Hello Again", 24)]
    s3 = run_checks(tmp_path, pdf, slide)["S3"]
    assert s3["status"] == "pass", s3["detail"]


def test_s3_a_text_gradfill_does_not_excuse_a_missing_gradient_shape(tmp_path):
    """A shading behind the text (a gradient panel) is not inside the text box: without its own gradFill shape it is
    still missing, even where the text over it has a gradient run."""
    pdf = [gradient((60, 250, 600, 420)), text((100, 300), "Hello World", 24, (0, 0, 0)), gradient(GLYPH_BOX)]
    s3 = run_checks(tmp_path, pdf, [grad_text((100, 300), "Hello World", 24)])["S3"]
    assert s3["status"] == "fail" and "shadings without a gradFill (0.5 pt): 1" in s3["detail"]
    with_panel = [gradient((60, 250, 600, 420)), grad_text((100, 300), "Hello World", 24)]
    assert run_checks(tmp_path, pdf, with_panel)["S3"]["status"] == "pass"


def test_s3_a_text_gradfill_without_a_shading_fails(tmp_path):
    s3 = run_checks(tmp_path, [text((100, 300), "Hello World", 24, (0, 0, 0))],
                    [grad_text((100, 300), "Hello World", 24)])["S3"]
    assert s3["status"] == "fail" and "text gradFills without a shading: 1" in s3["detail"]


# ---- S4 -----------------------------------------------------------------------------------------------------------


def test_s4_passes_without_shapes_on_the_slide(tmp_path):
    """M1-R70: a slide with no shapes has nothing out of order: S4 passes (a blank page, a blank slide)."""
    s4 = run_checks(tmp_path, [])["S4"]
    assert s4["status"] == "pass", s4
    assert "no shapes" in s4["detail"]


def test_deck_without_provenance_names_gives_s4_na(tmp_path):
    s4 = run_checks(tmp_path, base_scene(), pptx_kwargs={"names": False})["S4"]
    assert s4["status"] == "n/a"
    assert s4["detail"]


def test_s4_out_of_order_fails(tmp_path):
    path = build_pptx(tmp_path / "out.pptx", base_scene())
    prs = Presentation(str(path))
    shapes = list(prs.slides[0].shapes)
    shapes[0].name, shapes[1].name = "pdf:p1:z2 fill", "pdf:p1:z1 stroke"  # op 2 below op 1
    prs.save(str(path))
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == "fail"
    assert "not all pairs concordant" in s4["detail"]


def test_s4_equal_op_index_keeps_order(tmp_path):
    """A fill and a stroke split from one PDF path share one op index: not out of order."""
    path = build_pptx(tmp_path / "out.pptx", base_scene())
    prs = Presentation(str(path))
    shapes = list(prs.slides[0].shapes)
    shapes[1].name = "pdf:p1:z1 stroke"
    prs.save(str(path))
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == "pass", s4


def _with_hotspots(path, names, swap=False):
    """The deck at `path` with a hotspot per name on top, as deckback writes a link (a rectangle with no fill and no
    line); `swap` puts the first two shapes out of PDF paint order."""
    prs = Presentation(str(path))
    slide = prs.slides[0]
    if swap:
        shapes = list(slide.shapes)
        shapes[0].name, shapes[1].name = "pdf:p1:z2 fill", "pdf:p1:z1 stroke"
    for name in names:
        shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, *_box_args((700, 400, 760, 420)))
        shape.fill.background()
        shape.line.fill.background()
        shape.name = name
    prs.save(str(path))
    return path


def test_s4_ignores_link_hotspots(tmp_path):
    """Ruling M3-R18: a hotspot is named pdf:p<page>:a<i> link and sits above every paint; an annotation is no paint,
    so S4 leaves it out instead of finding the slide without provenance (n/a)."""
    path = _with_hotspots(build_pptx(tmp_path / "out.pptx", base_scene()), ["pdf:p1:a0 link", "pdf:p1:a1 link"])
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == "pass", s4
    assert s4["counts"]["shapes"] == len(base_scene()) and s4["counts"]["links"] == 2, s4
    assert "2 link hotspots ignored" in s4["detail"], s4


def test_s4_link_hotspots_do_not_hide_paints_out_of_order(tmp_path):
    path = _with_hotspots(build_pptx(tmp_path / "out.pptx", base_scene()), ["pdf:p1:a0 link"], swap=True)
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == "fail" and "not all pairs concordant" in s4["detail"], s4


@pytest.mark.parametrize("name", ["pdf:p1:a0 rect", "pdf:p1:a0 link 1", "pdf:p1:a0link", "pdf:p1:ax link",
                                  "pdf:p1:a0 link ", "xpdf:p1:a0 link"])
def test_s4_ignores_only_names_of_the_hotspot_form(tmp_path, name):
    """Only `pdf:p<page>:a<i> link` exactly is a hotspot (M3-R18); any other name without provenance still makes S4
    n/a."""
    path = _with_hotspots(build_pptx(tmp_path / "out.pptx", base_scene()), [name])
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == "n/a", s4


def test_s4_slide_of_hotspots_alone_passes(tmp_path):
    """M1-R70 with M3-R18: a slide whose only shapes are hotspots has no paint out of order."""
    path = _with_hotspots(build_pptx(tmp_path / "out.pptx", []), ["pdf:p1:a0 link"])
    pdf = build_pdf(tmp_path / "in.pdf", [])
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == "pass", s4
    assert s4["counts"] == {"shapes": 0, "links": 1}, s4


# ---- S5 -----------------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("extra,status", [(0, "pass"), (1, "pass"), (2, "fail"), (-2, "fail")])
def test_s5_slide_size_within_one_emu(tmp_path, extra, status):
    s5 = run_checks(tmp_path, base_scene(), pptx_kwargs={"size": (SLIDE_W + extra, SLIDE_H)})["S5"]
    assert s5["status"] == status, s5
    s5 = run_checks(tmp_path, base_scene(), pptx_kwargs={"size": (SLIDE_W, SLIDE_H + extra)})["S5"]
    assert s5["status"] == status, s5


def test_s5_slide_count_must_equal_page_count(tmp_path):
    s5 = run_checks(tmp_path, base_scene(), pdf_kwargs={"pages": 2})["S5"]
    assert s5["status"] == "fail"
    assert "1 slide" in s5["detail"] and "2 pages" in s5["detail"]


# ---- S6 -----------------------------------------------------------------------------------------------------------


def test_typeface_malgungothic_fails_s6(tmp_path):
    """The PDF BaseFont MalgunGothic is a PostScript name; the family (nameID 1) is "Malgun Gothic"."""
    real = dict(STYLES)
    try:
        STYLES["regular"] = ("Malgun Gothic", "Regular", "MalgunGothic", False, False)
        scene = [text((100, 300), "Hello World", 24, (51, 102, 153))]
        fonts = {"MalgunGothic": "MalgunGothic"}
        s6 = run_checks(tmp_path, scene, pdf_kwargs={"font_names": fonts},
                        pptx_kwargs={"typeface": "MalgunGothic"})["S6"]
        assert s6["status"] == "fail"
        assert "MalgunGothic" in s6["detail"]
        s6 = run_checks(tmp_path, scene, pdf_kwargs={"font_names": fonts},
                        pptx_kwargs={"typeface": "Malgun Gothic"})["S6"]
        assert s6["status"] == "pass", s6
    finally:
        STYLES.clear()
        STYLES.update(real)


def test_s6_catches_the_family_name_with_its_spaces_removed(tmp_path):
    """"DeckSans" for the family "Deck Sans" (BaseFont DeckSans-Regular): the same defect without the style."""
    s6 = run_checks(tmp_path, base_scene(), pptx_kwargs={"typeface": "DeckSans"})["S6"]
    assert s6["status"] == "fail"


def test_s6_lists_fonts_that_are_not_embedded(tmp_path):
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    doc = pymupdf.open(str(pdf))
    doc[0].insert_text((600, 500), "Note", fontname="helv", fontsize=10)
    doc.save(str(tmp_path / "in2.pdf"))
    pptx = build_pptx(tmp_path / "out.pptx", base_scene() + [text((600, 500), "Note", 10, (0, 0, 0))])
    s6 = structural.check(pdf_facts.page_facts(tmp_path / "in2.pdf", 0), pptx_facts.slide_facts(pptx, 0))["S6"]
    assert s6["status"] == "pass", s6
    assert "not embedded" in s6["detail"] and "Helvetica" in s6["detail"]
    assert "4 characters skipped" in s6["detail"]  # "Note": its PDF font has no family name (M1-R71)


@pytest.mark.parametrize("typeface", ["Arial", "Comic Sans MS"])
def test_s6_fails_a_typeface_that_is_not_the_pdf_fonts_family(tmp_path, typeface):
    """M1-R71 (F5): every character's typeface must be the family (nameID 1) of the PDF font that drew it; a wrong
    family passed S2 and S6 before."""
    result = run_checks(tmp_path, base_scene(), pptx_kwargs={"typeface": typeface})
    assert result["S2"]["status"] == "pass"
    s6 = result["S6"]
    assert s6["status"] == "fail", s6
    assert typeface in s6["detail"] and "Deck Sans" in s6["detail"]


def _set_run_typefaces(path, **typefaces):
    """Set a:latin / a:ea / a:cs of every run of the deck at `path` (None removes the element)."""
    prs = Presentation(str(path))
    for shape in prs.slides[0].shapes:
        if not shape.has_text_frame:
            continue
        for paragraph in shape.text_frame.paragraphs:
            for run in paragraph.runs:
                rpr = run.font._rPr
                for tag, typeface in typefaces.items():
                    for old in rpr.findall(qn(f"a:{tag}")):
                        rpr.remove(old)
                    if typeface is not None:
                        etree.SubElement(rpr, qn(f"a:{tag}")).set("typeface", typeface)
    prs.save(str(path))
    return path


@pytest.mark.parametrize("latin, ea, status", [
    ("Deck Sans", "Deck Sans", "pass"),
    ("Deck Sans", "Other Sans", "fail"),  # the Hangul character takes a:ea
    ("Other Sans", "Deck Sans", "fail"),  # the Latin characters take a:latin
])
def test_s6_takes_a_latin_or_a_ea_by_the_character(tmp_path, latin, ea, status):
    """M1-R71: an East Asian character is drawn in the run's a:ea typeface, any other in its a:latin one."""
    scene = [text((100, 300), "A가B", 24, (0, 0, 0))]
    pdf = build_pdf(tmp_path / "in.pdf", scene)
    pptx = _set_run_typefaces(build_pptx(tmp_path / "out.pptx", scene), latin=latin, ea=ea)
    result = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))
    assert result["S2"]["status"] == "pass", result["S2"]
    assert result["S6"]["status"] == status, result["S6"]
    if status == "fail":
        assert "Other Sans" in result["S6"]["detail"]


def test_run_typefaces_resolve_a_cs_too(tmp_path):
    scene = [text((100, 300), "Hello", 24, (0, 0, 0))]
    pptx = _set_run_typefaces(build_pptx(tmp_path / "out.pptx", scene), cs="Script Sans")
    run = [r for r in pptx_facts.slide_facts(pptx, 0).runs if r["text"].strip()][0]
    assert (run["typeface_latin"], run["typeface_ea"], run["typeface_cs"]) == ("Deck Sans", "Deck Sans",
                                                                               "Script Sans")


def _s6(spans, runs, fonts=None, names=None):
    """S6 on hand-made facts: `spans` (text, PDF family) and `runs` (text, latin, ea, cs). `names` gives a family's
    every nameID 1 record (`family_names1`), else the family alone."""
    families = {family for _, family in spans if family}
    every = lambda family: list((names or {}).get(family, [family])) if family else []  # noqa: E731
    page = pdf_facts.PageFacts(index=0, page_count=1, size_pt=(W_PT, H_PT), spans=[
        {"text": t, "size": 10.0, "color": [0, 0, 0], "alpha": 1.0, "font": f"F-{family}", "family": family,
         "families": every(family), "bold": False, "italic": False, "origin": (0, 0)} for t, family in spans],
        fonts=fonts if fonts is not None else [
            {"basefont": f"ABCDEF+F-{family}", "family_name1": family, "family_names1": every(family),
             "subfamily": "Regular", "embedded": True}
            for family in sorted(families)])
    slide = pptx_facts.SlideFacts(index=0, slide_count=1, size_emu=(SLIDE_W, SLIDE_H), size_pt=(W_PT, H_PT), runs=[
        {"text": t, "size": 10.0, "color": {"rgb": [0, 0, 0], "alpha": 1.0}, "typeface_latin": latin,
         "typeface_ea": ea, "typeface_cs": cs, "bold": False, "italic": False, "shape": "box"}
        for t, latin, ea, cs in runs], typefaces=sorted({v for _, *names in runs for v in names if v}))
    return structural.s6(page, slide)


def test_s6_accepts_the_family_without_the_subset_tag_a_program_that_carries_it_in_nameid_1():
    """A font whose own nameID 1 is 'WRJSDB+Gulim' (a Korean deck, off the bar): the converter writes 'Gulim' (the tag is
    no part of a family), so S6 must not call that a PostScript-style name, nor a wrong family."""
    assert _s6([("가나", "WRJSDB+Gulim")], [("가나", "Gulim", "Gulim", None)])["status"] == "pass"
    assert _s6([("가나", "WRJSDB+Gulim")], [("가나", "Other Sans", "Other Sans", None)])["status"] == "fail"


def test_s6_takes_a_cs_for_complex_scripts():
    assert _s6([("שלום", "Script Sans")], [("שלום", "Latin Sans", "EA Sans", "Script Sans")])["status"] == "pass"
    s6 = _s6([("שלום", "Script Sans")], [("שלום", "Script Sans", "Script Sans", "Latin Sans")])
    assert s6["status"] == "fail" and "Latin Sans" in s6["detail"]


def test_s6_accepts_a_latin_or_a_ea_for_shared_punctuation():
    """Symbols and punctuation both scripts use (•, ※, “) are drawn in either typeface, by PowerPoint's language
    rules: either is accepted. A Latin letter or a Hangul syllable has one."""
    runs = [("•※“A가", "Latin Sans", "EA Sans", None)]
    assert _s6([("•※“", "EA Sans"), ("A", "Latin Sans"), ("가", "EA Sans")], runs)["status"] == "pass"
    assert _s6([("•※“", "Latin Sans"), ("A", "Latin Sans"), ("가", "EA Sans")], runs)["status"] == "pass"
    assert _s6([("•※“", "Latin Sans"), ("A", "EA Sans"), ("가", "EA Sans")], runs)["status"] == "fail"
    assert _s6([("•※“", "Latin Sans"), ("A", "Latin Sans"), ("가", "Latin Sans")], runs)["status"] == "fail"


def test_s6_skips_characters_whose_pdf_font_has_no_family_name():
    """M1-R71: a character whose PDF font has no family name (not embedded, no name table) is listed and skipped; when
    nothing could be compared, S6 is n/a (the input cannot support it)."""
    s6 = _s6([("Hello", None), ("World", "Deck Sans")], [("HelloWorld", "Deck Sans", "Deck Sans", None)])
    assert s6["status"] == "pass", s6
    assert "5 characters" in s6["detail"] and "no family name" in s6["detail"]
    s6 = _s6([("Hello", None)], [("Hello", "Deck Sans", "Deck Sans", None)])
    assert s6["status"] == "n/a", s6
    s6 = _s6([("Hello", None), ("World", "Deck Sans")], [("HelloWorld", "Arial", "Arial", None)])
    assert s6["status"] == "fail", s6


def test_s6_fails_a_run_without_a_typeface():
    s6 = _s6([("Hello", "Deck Sans")], [("Hello", None, None, None)])
    assert s6["status"] == "fail" and "no typeface" in s6["detail"], s6


def test_s6_fails_a_known_family_without_its_spaces_whatever_the_pdf_font():
    """M4 Task 3: no typeface may be a known family (packages/core/src/fonts/ps-family.ts) without its spaces, even
    where the PDF's font is not embedded or has no name (M1-R40 sees only the PDF's own families): `MalgunGothic` is
    a font PowerPoint does not have. Counted as "spaceless names"."""
    s6 = _s6([("Hello", None)], [("Hello", "MalgunGothic", "MalgunGothic", None)], fonts=[])
    assert s6["status"] == "fail", s6
    assert "MalgunGothic (family 'Malgun Gothic')" in s6["detail"]
    assert s6["counts"]["spaceless names"] == 1
    for typeface in ("TimesNewRoman", "NotoSansKR", "SegoeUI"):
        assert _s6([("Hello", None)], [("Hello", typeface, None, None)], fonts=[])["status"] == "fail", typeface
    # the family itself, a family spelled without spaces (NanumGothic) and a name the table does not know pass
    for typeface in ("Malgun Gothic", "NanumGothic", "DeckbackSans"):
        s6 = _s6([("Hello", None)], [("Hello", typeface, typeface, None)], fonts=[])
        assert s6["status"] == "n/a" and s6["counts"]["spaceless names"] == 0, (typeface, s6)
    # a PDF font whose own family (nameID 1) is that name too: the typeface is still flagged, and the spaced family is
    # what the character's typeface may be
    assert _s6([("Hello", "MalgunGothic")], [("Hello", "MalgunGothic", "MalgunGothic", None)])["status"] == "fail"
    assert _s6([("Hello", "MalgunGothic")], [("Hello", "Malgun Gothic", "Malgun Gothic", None)])["status"] == "pass"


def test_s6_counts_spaceless_names_among_its_counts():
    assert "spaceless names" in structural.COUNT_NAMES


def test_s6_compares_characters_only_through_s2s_alignment():
    """M1-R71: characters are paired through S2's alignment, which exists when the texts are equal. When they differ
    (S2 fails), no character is paired with a character of another shape (a guessed alignment did that on five pages
    of the source decks): S6 is n/a with the reason, unless a typeface is a BaseFont-style name (M1-R40), which fails
    without any alignment."""
    s6 = _s6([("Hello", "Deck Sans"), ("World", "Deck Sans")],
             [("HelloX", "Deck Sans", "Deck Sans", None), ("World", "Arial", "Arial", None)])
    assert s6["status"] == "n/a" and "differ" in s6["detail"], s6
    s6 = _s6([("Hello", "Deck Sans")], [("HelloX", "DeckSans", "DeckSans", None)])
    assert s6["status"] == "fail" and "DeckSans" in s6["detail"], s6
    assert _s6([("Hello", "Deck Sans")], [("Hello", "Arial", "Arial", None)])["status"] == "fail"


def test_s6_passes_without_typefaces(tmp_path):
    """M1-R70: a slide that names no typeface has no wrong one: S6 passes."""
    s6 = run_checks(tmp_path, base_scene()[:3])["S6"]
    assert s6["status"] == "pass", s6
    assert "no typeface" in s6["detail"]


# ---- privacy, robustness, the baseline ----------------------------------------------------------------------------


@pytest.mark.parametrize("case", ["pair", "missing rect", "changed text", "no names", "wrong typeface", "no text",
                                  "two pages"])
def test_counts_use_the_fixed_vocabulary(tmp_path, case):
    """M1-R75: a private deck's details are its status and counts only, so every count a check reports is named from
    structural.COUNT_NAMES (fixed words) and is an integer."""
    scene = base_scene()
    pdf_scene, pptx_scene, pdf_kwargs, pptx_kwargs = scene, scene, {}, {}
    if case == "missing rect":
        pptx_scene = without(scene, 0)
    elif case == "changed text":
        pptx_scene = replaced(scene, 3, text="Hellp World")
    elif case == "no names":
        pptx_kwargs = {"names": False}
    elif case == "wrong typeface":
        pptx_kwargs = {"typeface": "Arial"}
    elif case == "no text":
        pdf_scene = pptx_scene = scene[:3]
    elif case == "two pages":
        pdf_kwargs = {"pages": 2}
    result = run_checks(tmp_path, pdf_scene, pptx_scene, pdf_kwargs=pdf_kwargs, pptx_kwargs=pptx_kwargs)
    for key, value in result.items():
        assert set(value["counts"]) <= structural.COUNT_NAMES, (key, value["counts"])
        assert all(type(n) is int for n in value["counts"].values()), (key, value["counts"])


def test_details_name_no_file_or_path(tmp_path):
    secret = tmp_path / "Private-Quarterly-Deck"
    secret.mkdir()
    pdf = build_pdf(secret / "Private-Quarterly-Deck.pdf", base_scene())
    pptx = _with_full_slide_picture(build_pptx(secret / "Private-Quarterly-Deck.pptx", without(base_scene(), 0)))
    result = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))
    for value in result.values():
        assert "Private-Quarterly-Deck" not in value["detail"]
        assert str(tmp_path) not in value["detail"] and tmp_path.name not in value["detail"]


def test_baseline_converter_output_is_checked_without_errors(tmp_path):
    """The M0 prototype's output for the committed probe: every check runs and reports (no pass expected)."""
    from harness.baseline.proto import convert

    out = tmp_path / "probe_out.pptx"
    convert(PROBE_PDF, out)
    for index in range(3):
        result = structural.check(pdf_facts.page_facts(PROBE_PDF, index), pptx_facts.slide_facts(out, index))
        assert set(result) == {"S1", "S2", "S3", "S4", "S5", "S6"}
        for key, value in result.items():
            assert value["status"] in ("pass", "fail", "n/a"), (index, key, value)
            assert "internal error" not in value["detail"], (index, key, value)
        assert result["S4"]["status"] == "n/a"  # the prototype writes no provenance names
        assert result["S5"]["status"] == "pass"


def test_page_and_slide_facts_of_the_committed_probe():
    page = pdf_facts.page_facts(PROBE_PDF, 1)
    # one picture and one gradient (PyMuPDF's get_image_info would list the shading as a second, xref-0 image)
    assert page.page_count == 3 and len(page.images) == 1 and len(page.shadings) == 1
    slide = pptx_facts.slide_facts(PROBE_PPTX, 1)
    assert slide.slide_count == 3 and slide.size_emu == (SLIDE_W, SLIDE_H)


# ---- S7 (round trip) without PowerPoint: the export is replaced ---------------------------------------------------


class FakeExport:
    """Stands in for harness.atlas.export.export: records the call and writes what the test asks for."""

    def __init__(self, pdf=None, record=None, raises=None):
        self.pdf, self.record, self.raises = pdf, record, raises
        self.calls = []

    def __call__(self, pptx, out_dir, variants, ground_truth, timeout_sec=None):
        self.calls.append({"pptx": Path(pptx), "out_dir": Path(out_dir), "variants": list(variants),
                           "ground_truth": ground_truth})
        if self.raises is not None:
            raise self.raises
        if self.pdf is not None:
            shutil.copyfile(self.pdf, Path(out_dir) / f"{Path(pptx).stem}_std.pdf")
        record = self.record or {"ok": True, "exitCode": 0, "pages": 1, "seconds": 1.0, "expectedPages": 1}
        return {"variants": {"std": record}, "scriptExitCode": record["exitCode"],
                "stderr": "stderr quoting the secret input name", "fonts": {}}


@pytest.fixture
def pair(tmp_path):
    pdf = build_pdf(tmp_path / "Private-Deck.pdf", base_scene() + [gradient(GRAD_BOX)])
    pptx = build_pptx(tmp_path / "Private-Deck.pptx", base_scene())
    return pdf, pptx


def _fake(monkeypatch, fake):
    monkeypatch.setattr(roundtrip, "export", fake)
    monkeypatch.setattr(roundtrip, "on_windows", lambda: True)
    return fake


def _assert_private(result, tmp_path, powerpoint=None):
    """status and detail, plus the "powerpoint" marker ("timeout" / "busy", ruling M1-R74) only where expected."""
    assert set(result) - {"drift"} == {"status", "detail"} | ({"powerpoint"} if powerpoint else set())  # M8-R12: drift
    assert result.get("powerpoint") == powerpoint
    assert "Private-Deck" not in result["detail"] and str(tmp_path) not in result["detail"]
    assert "secret" not in result["detail"]


def test_s7_identical_round_trip_passes(tmp_path, monkeypatch, pair):
    pdf, pptx = pair
    fake = _fake(monkeypatch, FakeExport(pdf=pdf))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "pass", result
    assert "bbox proxy for Hausdorff (M1)" in result["detail"]
    _assert_private(result, tmp_path)
    [call] = fake.calls
    assert call["variants"] == ["std"] and call["ground_truth"] is False
    assert call["pptx"] == pptx
    assert not call["out_dir"].exists()  # the temp dir is removed
    assert REPO not in call["out_dir"].parents  # never under the repository (corpus/)


@pytest.mark.parametrize("record,words,powerpoint", [
    ({"ok": False, "exitCode": 2, "pages": 0, "seconds": 9.0, "reason": "timeout"}, "timed out", "timeout"),
    ({"ok": False, "exitCode": 3, "pages": 0, "seconds": 2.0, "reason": "error"}, "could not open", None),
    ({"ok": False, "exitCode": 3, "pages": 0, "seconds": 2.0, "reason": "slide-count-mismatch"}, "slide count", None),
    ({"ok": False, "exitCode": 2, "pages": 0, "seconds": 0, "reason": "skipped-after-stuck"}, "timed out", "timeout"),
])
def test_s7_open_error_or_timeout_fails(tmp_path, monkeypatch, pair, record, words, powerpoint):
    """A timeout fails S7 of this deck and is marked (powerpoint: timeout), so that the run skips its later PowerPoint
    steps (ruling M1-R74)."""
    pdf, pptx = pair
    fake = _fake(monkeypatch, FakeExport(record=record))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "fail"
    assert words in result["detail"]
    _assert_private(result, tmp_path, powerpoint)
    assert not fake.calls[0]["out_dir"].exists()


def test_s7_powerpoint_busy_is_na_not_a_fault_of_the_deck(tmp_path, monkeypatch, pair):
    """M1-R74: PowerPoint refusing the calls (busy, as while a dialog is open in it) says nothing about the deck: S7 is
    n/a with the reason powerpoint-busy, and marked busy for the run's count."""
    pdf, pptx = pair
    _fake(monkeypatch, FakeExport(record={"ok": False, "exitCode": 3, "pages": 0, "seconds": 1.0,
                                          "reason": "powerpoint-busy"}))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "n/a"
    assert result["detail"].startswith("powerpoint-busy: ") and "busy" in result["detail"]
    _assert_private(result, tmp_path, "busy")


def test_s7_export_left_running_is_a_timeout(tmp_path, monkeypatch, pair):
    """export.py gives up on an export script that overran its limit and leaves it running (ExportError with
    left_running): PowerPoint may be held, so S7 fails and is marked timeout (M1-R74)."""
    pdf, pptx = pair
    error = roundtrip.ExportError("export.ps1 (process 1) did not finish within 9 s; it was left running", "",
                                  left_running=True)
    _fake(monkeypatch, FakeExport(raises=error))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "fail" and "left running" in result["detail"]
    _assert_private(result, tmp_path, "timeout")


def test_s7_missing_pdf_fails(tmp_path, monkeypatch, pair):
    pdf, pptx = pair
    _fake(monkeypatch, FakeExport())  # reports ok, writes nothing
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "fail" and "missing" in result["detail"]
    _assert_private(result, tmp_path)


@pytest.mark.parametrize("error", [
    roundtrip.ExportError("export.ps1 exited 3 without a result line", "stderr quoting the secret input"),
    FileNotFoundError("powershell.exe"),
    RuntimeError("boom: the secret input name"),
])
def test_s7_never_raises(tmp_path, monkeypatch, pair, error):
    pdf, pptx = pair
    fake = _fake(monkeypatch, FakeExport(raises=error))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "fail"
    _assert_private(result, tmp_path)
    assert not fake.calls[0]["out_dir"].exists()


def test_s7_is_na_off_windows(tmp_path, monkeypatch, pair):
    pdf, pptx = pair
    fake = FakeExport(pdf=pdf)
    monkeypatch.setattr(roundtrip, "export", fake)
    monkeypatch.setattr(roundtrip, "on_windows", lambda: False)
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "n/a" and not fake.calls


def test_s7_different_paints_fail(tmp_path, monkeypatch, pair):
    pdf, pptx = pair
    other = build_pdf(tmp_path / "other.pdf", base_scene())  # the gradient is missing
    _fake(monkeypatch, FakeExport(pdf=other))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "fail" and "shade" in result["detail"]
    assert "bbox proxy for Hausdorff (M1)" in result["detail"]


def test_s7_different_text_fails(tmp_path, monkeypatch, pair):
    pdf, pptx = pair
    other = build_pdf(tmp_path / "other.pdf", replaced(base_scene(), 3, text="Hellp World") + [gradient(GRAD_BOX)])
    _fake(monkeypatch, FakeExport(pdf=other))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "fail" and "text" in result["detail"]


@pytest.mark.parametrize("dy,status", [(0.4, "pass"), (0.7, "fail")])
def test_s7_baselines_within_half_a_point(tmp_path, monkeypatch, pair, dy, status):
    pdf, pptx = pair
    other = build_pdf(tmp_path / "other.pdf", replaced(base_scene(), 3, origin=(100, 300 + dy)) + [gradient(GRAD_BOX)])
    _fake(monkeypatch, FakeExport(pdf=other))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == status, result
    if status == "fail":
        assert "baseline" in result["detail"]


@pytest.mark.parametrize("dx,status", [(0.4, "pass"), (0.7, "fail")])
def test_s7_path_bbox_within_half_a_point(tmp_path, monkeypatch, pair, dx, status):
    pdf, pptx = pair
    x0, y0, x1, y1 = RED_BOX
    other = build_pdf(tmp_path / "other.pdf",
                      replaced(base_scene(), 0, box=(x0 + dx, y0, x1 + dx, y1)) + [gradient(GRAD_BOX)])
    _fake(monkeypatch, FakeExport(pdf=other))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == status, result
    if status == "fail":
        assert "bbox" in result["detail"]


def test_s7_page_count_must_match(tmp_path, monkeypatch, pair):
    pdf, pptx = pair
    other = build_pdf(tmp_path / "other.pdf", base_scene() + [gradient(GRAD_BOX)], pages=2)
    _fake(monkeypatch, FakeExport(pdf=other))
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "fail" and "pages" in result["detail"]


# ---- facts errors: one exception type, no path in its message --------------------------------------------------------


SECRET = "Private-Quarterly-Deck"


def _assert_private_error(error, tmp_path):
    message = str(error.value)
    assert message
    assert SECRET not in message and str(tmp_path) not in message and tmp_path.name not in message
    assert error.value.__cause__ is None and error.value.__suppress_context__  # raised "from None"


def test_both_facts_modules_raise_one_exception_type():
    assert pdf_facts.FactsError is pptx_facts.FactsError
    assert issubclass(pdf_facts.FactsError, Exception)


@pytest.mark.parametrize("case", ["truncated", "missing", "index", "empty"])
def test_slide_facts_errors_are_facts_errors_without_paths(tmp_path, case):
    folder = tmp_path / SECRET
    folder.mkdir()
    path = folder / f"{SECRET}.pptx"
    index = 0
    if case == "truncated":
        data = build_pptx(path, base_scene()).read_bytes()
        path.write_bytes(data[: len(data) // 2])
    elif case == "index":
        build_pptx(path, base_scene())
        index = 5
    elif case == "empty":
        path.write_bytes(b"")
    with pytest.raises(pptx_facts.FactsError) as error:
        pptx_facts.slide_facts(path, index)
    _assert_private_error(error, tmp_path)


@pytest.mark.parametrize("case", ["missing", "empty", "index", "png", "pptx", "garbage"])
def test_page_facts_errors_are_facts_errors_without_paths(tmp_path, case):
    """page_facts reads PDFs only: a PNG or a .pptx renamed to .pdf is rejected, not opened as another format."""
    folder = tmp_path / SECRET
    folder.mkdir()
    path = folder / f"{SECRET}.pdf"
    index = 0
    if case == "empty":
        path.write_bytes(b"")
    elif case == "index":
        build_pdf(path, base_scene())
        index = 1
    elif case == "png":
        path.write_bytes(png_bytes())
    elif case == "pptx":
        path.write_bytes(build_pptx(tmp_path / "deck.pptx", base_scene()).read_bytes())
    elif case == "garbage":
        path.write_bytes(b"this is not a PDF at all\n" * 40)
    with pytest.raises(pdf_facts.FactsError) as error:
        pdf_facts.page_facts(path, index)
    _assert_private_error(error, tmp_path)


def test_check_records_an_internal_error_without_its_message(tmp_path, monkeypatch):
    page, slide = facts(tmp_path, base_scene())

    def boom(_page, _slide):
        raise RuntimeError(f"a message quoting {tmp_path / SECRET}")

    monkeypatch.setattr(structural, "CHECKS", (("S1", structural.s1), ("S3", boom), ("S5", structural.s5)))
    result = structural.check(page, slide)
    assert result["S3"] == {"status": "fail", "detail": "internal error in S3 (RuntimeError)"}
    assert result["S1"]["status"] == "pass" and result["S5"]["status"] == "pass"  # the others still run


def test_damaged_font_program_falls_back_to_the_span_flags(tmp_path):
    """A font program whose name table lies past its end (a broken subset): no family name, no crash."""
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    doc = pymupdf.open(str(pdf))
    damaged = 0
    for xref in range(1, doc.xref_length()):
        if not doc.xref_is_stream(xref):
            continue
        data = bytearray(doc.xref_stream(xref))
        if data[:4] != b"\x00\x01\x00\x00":
            continue
        for i in range(int.from_bytes(data[4:6], "big")):
            record = 12 + 16 * i
            if data[record:record + 4] == b"name":
                data[record + 8:record + 12] = (len(data) + 64).to_bytes(4, "big")
                damaged += 1
        doc.update_stream(xref, bytes(data))
    doc.save(str(tmp_path / "damaged.pdf"))
    assert damaged >= 2
    page = pdf_facts.page_facts(tmp_path / "damaged.pdf", 0)
    assert all(font["family_name1"] is None for font in page.fonts)
    texts = [s["text"] for s in page.spans if s["text"].strip()]
    assert texts == ["Hello World", "Bold Words", "Lean Words"]


# ---- /Rotate pages (F5, F11) -------------------------------------------------------------------------------------


def _rotated(box, rotation=90, size=(W_PT, H_PT)):
    """`box` of an unrotated page in the frame of the page turned by /Rotate `rotation`."""
    doc = pymupdf.open()
    page = doc.new_page(width=size[0], height=size[1])
    page.set_rotation(rotation)
    rect = pymupdf.Rect(box) * page.rotation_matrix
    return tuple(round(v, 6) for v in (rect.x0, rect.y0, rect.x1, rect.y1))


def _rotated_scene(scene, rotation=90):
    out = []
    for item in scene:
        item = dict(item)
        if "box" in item:
            item["box"] = _rotated(item["box"], rotation)
        out.append(item)
    return out


def test_rotated_page_facts_are_in_the_slide_frame(tmp_path):
    page = pdf_facts.page_facts(build_pdf(tmp_path / "in.pdf", base_scene(), rotation=90), 0)
    assert page.size_pt == pytest.approx((540, 960))
    assert page.drawings[0]["bbox"] == pytest.approx([0, 0, 540, 960], abs=0.01)  # the white background
    assert page.drawings[1]["bbox"] == pytest.approx([380, 100, 440, 220], abs=0.01)  # RED_BOX turned
    assert page.images == [pytest.approx(list(_rotated(IMAGE_BOX)), abs=0.01)]
    spans = {s["text"]: s for s in page.spans if s["text"].strip()}
    assert spans["Hello World"]["origin"] == pytest.approx((240, 100), abs=0.01)  # (100, 300) turned
    assert spans["Lean Words"]["italic"] is True  # synthetic italic found on a rotated page
    assert (spans["Hello World"]["italic"], spans["Bold Words"]["bold"]) == (False, True)


def test_rotated_page_against_a_faithful_and_a_misplaced_slide(tmp_path):
    pdf = build_pdf(tmp_path / "in.pdf", base_scene(), rotation=90)
    page = pdf_facts.page_facts(pdf, 0)
    faithful = build_pptx(tmp_path / "ok.pptx", _rotated_scene(base_scene()), size=(SLIDE_H, SLIDE_W))
    result = structural.check(page, pptx_facts.slide_facts(faithful, 0))
    for key in ("S1", "S2", "S3", "S5"):
        assert result[key]["status"] == "pass", (key, result[key])
    assert "background 1" in result["S3"]["detail"]
    misplaced = build_pptx(tmp_path / "bad.pptx", base_scene(), size=(SLIDE_H, SLIDE_W))  # unrotated geometry
    assert structural.check(page, pptx_facts.slide_facts(misplaced, 0))["S3"]["status"] == "fail"


# ---- bold and italic of the PDF (F1, F2) ---------------------------------------------------------------------------


def test_simulated_bold_is_bold(tmp_path):
    """PowerPoint draws bold for a family without a Bold face as fill + stroke in one colour (2 Tr, w = size / 35).
    A stroke in another colour (a text outline) and stroke-only text (1 Tr) are not bold."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.insert_font(fontname="FR", fontbuffer=make_font("Deck Sans", "Regular", "DeckSans-Regular"))
    black, red = (0, 0, 0), (1, 0, 0)
    page.insert_text((100, 100), "Fake Bold", fontname="FR", fontsize=20, render_mode=2, color=black, fill=black,
                     border_width=FAKE_BOLD_WIDTH)
    page.insert_text((100, 200), "Outlined", fontname="FR", fontsize=20, render_mode=2, color=red, fill=black,
                     border_width=FAKE_BOLD_WIDTH)
    page.insert_text((100, 300), "Hollow", fontname="FR", fontsize=20, render_mode=1, color=black,
                     border_width=FAKE_BOLD_WIDTH)
    page.insert_text((100, 400), "Plain", fontname="FR", fontsize=20, color=black)
    _set_font_names(doc, page, "FR", "ABCDEF+DeckSans-Regular")
    doc.save(str(tmp_path / "bold.pdf"))
    spans = pdf_facts.page_facts(tmp_path / "bold.pdf", 0).spans
    styles = {s["text"]: (s["bold"], s["italic"]) for s in spans if s["text"].strip()}
    assert styles == {"Fake Bold": (True, False), "Outlined": (False, False), "Hollow": (False, False),
                      "Plain": (False, False)}


def test_simulated_bold_passes_s2_against_b1(tmp_path):
    scene = [text((100, 300), "Fake Bold", 15.96, (38, 38, 38), "fakebold")]
    assert run_checks(tmp_path, scene)["S2"]["status"] == "pass"
    s2 = run_checks(tmp_path, scene, replaced(scene, 0, style="regular"))["S2"]
    assert s2["status"] == "fail" and "bold" in s2["detail"]


@pytest.mark.parametrize("origin", [(100, 420), (100, 420.05), (100.05, 420), (100, 300.25), (100, 300.35),
                                    (100.15, 133.45), (99.95, 87.65)])
def test_synthetic_italic_survives_rounding_boundaries(tmp_path, origin):
    """Glyph origins on a .x5 boundary round differently in float32 (rawdict) and double (the device)."""
    scene = [text(origin, "Lean Words", 18, (0, 0, 0), "italic")]
    page = pdf_facts.page_facts(build_pdf(tmp_path / "a.pdf", scene), 0)
    assert [(s["text"], s["italic"]) for s in page.spans if s["text"].strip()] == [("Lean Words", True)]
    assert run_checks(tmp_path, scene)["S2"]["status"] == "pass"


# ---- S3: patterns (F4, M1-R42) -------------------------------------------------------------------------------------

PATTERN_BOX = (700, 300, 860, 380)


@pytest.mark.parametrize("tiled_picture", [False, True])
def test_s3_pattern_matched_by_a_pattfill_or_tiled_picture_shape(tmp_path, tiled_picture):
    pdf_scene = base_scene() + [pattern(PATTERN_BOX)]
    result = run_checks(tmp_path, pdf_scene, base_scene() + [pattern(PATTERN_BOX, tiled_picture)])
    assert result["S3"]["status"] == "pass", result["S3"]
    assert "pattern" in result["S3"]["detail"]
    assert result["S1"]["status"] == "pass", result["S1"]  # a tiled picture fill is a pattern, not a picture


def test_s3_pattern_paints_must_be_matched(tmp_path):
    pdf_scene = base_scene() + [pattern(PATTERN_BOX)]
    dropped = run_checks(tmp_path, pdf_scene, base_scene())["S3"]
    assert dropped["status"] == "fail" and "pattern" in dropped["detail"]
    solid = run_checks(tmp_path, pdf_scene, base_scene() + [fill(PATTERN_BOX, (31, 56, 100))])["S3"]
    assert solid["status"] == "fail" and "pattern" in solid["detail"]
    as_picture = run_checks(tmp_path, pdf_scene, base_scene() + [image(PATTERN_BOX)])
    assert as_picture["S3"]["status"] == "fail" and "picture" in as_picture["S3"]["detail"]
    extra = run_checks(tmp_path, base_scene(), base_scene() + [pattern(PATTERN_BOX)])["S3"]
    assert extra["status"] == "fail" and "pattern" in extra["detail"]


# ---- S3: the slide-side bbox from the geometry (F6, M1-R44) -----------------------------------------------------

CURVE = [(100, 300), (166.6667, 100), (233.3333, 500), (300, 300)]  # an S-curve; control points beyond its extent


def _curve_extent():
    """The tight y extent of CURVE (what a writer framing the curve by its own bounds uses)."""
    ys = []
    for k in range(2001):
        t = k / 2000
        ys.append(sum(c * p[1] for c, p in zip(((1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3),
                                                CURVE)))
    return min(ys), max(ys)


def _curve_pdf(path):
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    shape = page.new_shape()
    shape.draw_bezier(*CURVE)
    shape.finish(color=(0, 0, 0), fill=None, width=2, closePath=False)
    shape.commit()
    doc.save(str(path))
    return path


def _sp(name, x, y, cx, cy, geometry, fill="<a:noFill/>", line='<a:ln w="25400"><a:solidFill><a:srgbClr '
        'val="000000"/></a:solidFill></a:ln>', rot=0, sp_id=10, flip_h=False):
    """A p:sp: frame in points, `geometry` the prstGeom / custGeom XML."""
    rot_attr = (f' rot="{int(rot * 60000)}"' if rot else "") + (' flipH="1"' if flip_h else "")
    return _xml(f'<p:sp><p:nvSpPr><p:cNvPr id="{sp_id}" name="{name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>'
                f'<a:xfrm{rot_attr}><a:off x="{int(round(x * EMU))}" y="{int(round(y * EMU))}"/><a:ext '
                f'cx="{int(round(cx * EMU))}" cy="{int(round(cy * EMU))}"/></a:xfrm>{geometry}{fill}{line}</p:spPr>'
                '</p:sp>')


def _deck(path, *elements, size=(SLIDE_W, SLIDE_H)):
    """A deck of one blank slide holding `elements` (lxml elements) in z-order."""
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(size[0]), Emu(size[1])
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    for element in elements:
        slide.shapes._spTree.append(element)
    prs.save(str(path))
    return path


def _cust_curve(name, frame_y0, frame_y1, dy=0.0):
    """CURVE as a custGeom framed by x 100..300, y frame_y0..frame_y1 (path units = points, 1 per EMU-pt)."""
    w, h = 200, frame_y1 - frame_y0
    points = "".join(f'<a:pt x="{int(round((x - 100) * EMU))}" y="{int(round((y - frame_y0 + dy) * EMU))}"/>'
                     for x, y in CURVE[1:])
    geometry = (f'<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>'
                f'<a:pathLst><a:path w="{int(round(w * EMU))}" h="{int(round(h * EMU))}"><a:moveTo><a:pt x="0" '
                f'y="{int(round((CURVE[0][1] - frame_y0 + dy) * EMU))}"/></a:moveTo><a:cubicBezTo>{points}'
                '</a:cubicBezTo></a:path></a:pathLst></a:custGeom>')
    return _sp(name, 100, frame_y0, w, h, geometry)


def test_s3_custgeom_bbox_comes_from_its_path_points(tmp_path):
    """The PDF bbox has the control points (fz_bound_path); a custGeom framed by the curve's tight extent still
    matches, because its bbox is computed from its path points through the frame."""
    pdf = pdf_facts.page_facts(_curve_pdf(tmp_path / "curve.pdf"), 0)
    assert pdf.drawings[1]["bbox"] == pytest.approx([100, 100, 300, 500], abs=0.01)
    low, high = _curve_extent()
    for name, y0, y1 in (("tight frame", low, high), ("control frame", 100, 500)):
        slide = pptx_facts.slide_facts(_deck(tmp_path / "c.pptx", _cust_curve(name, y0, y1)), 0)
        assert slide.shapes[0]["bbox"] == pytest.approx([100, 100, 300, 500], abs=0.01), name
        s3 = structural.check(pdf, slide)["S3"]
        assert s3["status"] == "pass", (name, s3)
    moved = pptx_facts.slide_facts(_deck(tmp_path / "m.pptx", _cust_curve("moved", low, high, dy=1.0)), 0)
    assert structural.check(pdf, moved)["S3"]["status"] == "fail"


def _rotated_points(points, centre, degrees):
    r = math.radians(degrees)
    cx, cy = centre
    return [(cx + (x - cx) * math.cos(r) - (y - cy) * math.sin(r), cy + (x - cx) * math.sin(r) + (y - cy) * math.cos(r))
            for x, y in points]


def _ellipse_beziers(box):
    """An ellipse as four cubic Beziers (kappa), starting at its right end, clockwise in the y-down frame."""
    x0, y0, x1, y1 = box
    cx, cy, rx, ry = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2, (y1 - y0) / 2
    k = 0.5522847498
    return [(cx + rx, cy), (cx + rx, cy + k * ry), (cx + k * rx, cy + ry), (cx, cy + ry),
            (cx - k * rx, cy + ry), (cx - rx, cy + k * ry), (cx - rx, cy),
            (cx - rx, cy - k * ry), (cx - k * rx, cy - ry), (cx, cy - ry),
            (cx + k * rx, cy - ry), (cx + rx, cy - k * ry), (cx + rx, cy)]


def _polygon_pdf(path, points, beziers=False):
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    shape = page.new_shape()
    if beziers:
        for i in range(0, len(points) - 1, 3):
            shape.draw_bezier(*points[i:i + 4])
    else:
        shape.draw_polyline(points + points[:1])
    shape.finish(color=None, fill=(1, 0, 0), closePath=True)
    shape.commit()
    doc.save(str(path))
    return path


ROT_BOX = (400, 200, 600, 300)
RED_FILL = '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>'
NO_LINE = "<a:ln><a:noFill/></a:ln>"


def test_s3_rotated_rect_uses_the_rotated_frame(tmp_path):
    x0, y0, x1, y1 = ROT_BOX
    corners = _rotated_points([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], ((x0 + x1) / 2, (y0 + y1) / 2), 30)
    page = pdf_facts.page_facts(_polygon_pdf(tmp_path / "r.pdf", corners), 0)
    rect = _sp("rect", x0, y0, x1 - x0, y1 - y0, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', RED_FILL,
               NO_LINE, rot=30)
    s3 = structural.check(page, pptx_facts.slide_facts(_deck(tmp_path / "r.pptx", rect), 0))["S3"]
    assert s3["status"] == "pass", s3


def _segment_pdf(path, ends, width=2.0):
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    page.draw_line(ends[0], ends[1], color=(0, 0, 0), width=width)
    doc.save(str(path))
    return path


@pytest.mark.parametrize("prst,flip_h", [("line", False), ("straightConnector1", False), ("line", True)])
def test_s3_rotated_line_uses_its_two_end_points(tmp_path, prst, flip_h):
    """M1-R47: the line preset is one segment from the frame's top-left to its bottom-right corner (top-right to
    bottom-left with flipH); turned 30 degrees, its bbox is the segment's, not the turned frame's."""
    x0, y0, x1, y1 = ROT_BOX
    ends = [(x1, y0), (x0, y1)] if flip_h else [(x0, y0), (x1, y1)]
    centre = ((x0 + x1) / 2, (y0 + y1) / 2)
    page = pdf_facts.page_facts(_segment_pdf(tmp_path / "l.pdf", _rotated_points(ends, centre, 30)), 0)
    for shift, status in ((0.0, "pass"), (1.0, "fail")):
        line = _sp(prst, x0 + shift, y0, x1 - x0, y1 - y0, f'<a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>',
                   rot=30, flip_h=flip_h)
        s3 = structural.check(page, pptx_facts.slide_facts(_deck(tmp_path / "l.pptx", line), 0))["S3"]
        assert s3["status"] == status, (shift, s3)


def _triangle(box, prst="triangle"):
    """The outline of the triangle (apex top centre) or rtTriangle (right angle bottom left) preset in `box`."""
    x0, y0, x1, y1 = box
    return [((x0 + x1) / 2, y0) if prst == "triangle" else (x0, y0), (x1, y1), (x0, y1)]


def _preset_pdf(path, prst, rot, line=None):
    """The preset as PowerPoint draws it in ROT_BOX turned by `rot`: a red fill, and a stroke with `line` = (rgb,
    width). The heart stands for a preset whose path box is not its frame (its lobes overflow it)."""
    x0, y0, x1, y1 = ROT_BOX
    points = {"ellipse": _ellipse_beziers(ROT_BOX), "heart": [(500, 180), (620, 170), (500, 300), (380, 170)]}.get(
        prst) or _triangle(ROT_BOX, prst)
    points = _rotated_points(points, ((x0 + x1) / 2, (y0 + y1) / 2), rot)
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    shape = page.new_shape()
    if prst == "ellipse":
        for i in range(0, len(points) - 1, 3):
            shape.draw_bezier(*points[i:i + 4])
    else:
        shape.draw_polyline(points + points[:1])
    rgb, width = line if line else (None, 0)
    shape.finish(color=rgb, fill=(1, 0, 0), width=width, closePath=True)
    shape.commit()
    doc.save(str(path))
    return path


def _preset(prst, rot, shift=0.0, fill=RED_FILL, line=NO_LINE, sp_id=10):
    x0, y0, x1, y1 = ROT_BOX
    return _sp(f"{prst} {sp_id}", x0 + shift, y0, x1 - x0, y1 - y0,
               f'<a:prstGeom prst="{prst}"><a:avLst/></a:prstGeom>', fill, line, rot=rot, sp_id=sp_id)


PRESET_NA = "1 preset shape outside the M1 geometry model (positions not checked)"
BLACK_LINE = '<a:ln w="25400"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln>'


@pytest.mark.parametrize("prst,rot", [("triangle", 30), ("rtTriangle", 30), ("ellipse", 30), ("heart", 0)])
@pytest.mark.parametrize("shift", [0.0, 1.0])
def test_s3_preset_position_is_not_checked(tmp_path, prst, rot, shift):
    """M1-R47: a preset other than rect and line has no geometry in M1, turned or not: its paint is counted and
    matched by colour, alpha and width only, and S3 is n/a with the reason (never a pass)."""
    page = pdf_facts.page_facts(_preset_pdf(tmp_path / "p.pdf", prst, rot), 0)
    slide = pptx_facts.slide_facts(_deck(tmp_path / "p.pptx", _preset(prst, rot, shift)), 0)
    s3 = structural.check(page, slide)["S3"]
    assert s3["status"] == "n/a", s3
    assert s3["detail"].startswith(PRESET_NA), s3
    assert "centre" not in s3["detail"] and "M1-R44" not in s3["detail"]


@pytest.mark.parametrize("case", ["colour", "width", "extra", "missing", "other fail"])
def test_s3_preset_paints_are_still_counted_and_compared(tmp_path, case):
    """M1-R47: n/a only when nothing else fails. A preset paint in another colour or width, one preset too many or
    too few, or another unmatched drawing fails S3."""
    page = pdf_facts.page_facts(_preset_pdf(tmp_path / "p.pdf", "triangle", 30, line=((0, 0, 0), 2.0)), 0)
    shapes = {
        "colour": [_preset("triangle", 30, fill='<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill>',
                           line=BLACK_LINE)],
        "width": [_preset("triangle", 30, line=BLACK_LINE.replace("25400", "38100"))],
        "extra": [_preset("triangle", 30, line=BLACK_LINE), _preset("triangle", 30, line=BLACK_LINE, sp_id=11)],
        "missing": [_preset("triangle", 30)],
        "other fail": [_preset("triangle", 30, line=BLACK_LINE),
                       _sp("rect", 100, 100, 50, 50, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>', RED_FILL,
                           NO_LINE, sp_id=11)],
    }[case]
    s3 = structural.check(page, pptx_facts.slide_facts(_deck(tmp_path / "p.pptx", *shapes), 0))["S3"]
    assert s3["status"] == "fail", s3
    faithful = _deck(tmp_path / "f.pptx", _preset("triangle", 30, line=BLACK_LINE))
    assert structural.check(page, pptx_facts.slide_facts(faithful, 0))["S3"]["status"] == "n/a"


def _solid(rgb, alpha=None):
    alpha_xml = f'<a:alpha val="{int(alpha * 100000)}"/>' if alpha is not None else ""
    return f'<a:solidFill><a:srgbClr val="{rgb}">{alpha_xml}</a:srgbClr></a:solidFill>'


def _solid_line(rgb, width):
    return f'<a:ln w="{int(width * EMU)}">{_solid(rgb)}</a:ln>'


def _same_frame_pdf(path, paints):
    """A page painting, in order, `paints` in ROT_BOX: "button" (a rounded rectangle filled blue), "overlay" (a
    rectangle filled white at 50 %), "ring" (an ellipse stroked red, 2 pt) or "frame" (a rectangle stroked black,
    1 pt)."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    for paint in paints:
        if paint == "button":
            page.draw_rect(pymupdf.Rect(ROT_BOX), color=None, fill=(0, 0, 1), width=0, radius=0.1)
        elif paint == "overlay":
            page.draw_rect(pymupdf.Rect(ROT_BOX), color=None, fill=(1, 1, 1), width=0, fill_opacity=0.5)
        elif paint == "ring":
            shape = page.new_shape()
            points = _ellipse_beziers(ROT_BOX)
            for i in range(0, len(points) - 1, 3):
                shape.draw_bezier(*points[i:i + 4])
            shape.finish(color=(1, 0, 0), fill=None, width=2, closePath=True)
            shape.commit()
        else:
            page.draw_rect(pymupdf.Rect(ROT_BOX), color=(0, 0, 0), fill=None, width=1)
    doc.save(str(path))
    return path


def _same_frame_shape(paint, overlay_alpha=0.5):
    """The slide shape of a _same_frame_pdf paint: a roundRect or ellipse preset, or a rect."""
    x0, y0, x1, y1 = ROT_BOX
    geometry, fill_xml, line = {
        "button": ("roundRect", _solid("0000FF"), NO_LINE),
        "overlay": ("rect", _solid("FFFFFF", overlay_alpha), NO_LINE),
        "ring": ("ellipse", "<a:noFill/>", _solid_line("FF0000", 2)),
        "frame": ("rect", "<a:noFill/>", _solid_line("000000", 1)),
    }[paint]
    return _sp(paint, x0, y0, x1 - x0, y1 - y0, f'<a:prstGeom prst="{geometry}"><a:avLst/></a:prstGeom>', fill_xml,
               line, sp_id=10 + ["button", "overlay", "ring", "frame"].index(paint))


@pytest.mark.parametrize("paints", [("button", "overlay"), ("overlay", "button"), ("ring", "frame"),
                                    ("frame", "ring")])
def test_s3_preset_under_a_same_frame_shape_of_another_colour(tmp_path, paints):
    """Three-step matching (M1-R47): a drawing first takes a slide paint of its kind whose bbox matches only when
    colour, alpha and width match too; a drawing left then takes a preset's paint of its kind with the same colour,
    alpha and width; only a drawing still left is paired with a bbox match as an attribute mismatch. So a preset
    under a same-frame rect of the same paint kind in another colour, alpha or width, painted first or last, is
    matched: a roundRect button under a translucent overlay, an ellipse stroke inside a rect stroke. n/a, as for any
    preset, never a fail."""
    page = pdf_facts.page_facts(_same_frame_pdf(tmp_path / "in.pdf", paints), 0)
    slide = pptx_facts.slide_facts(_deck(tmp_path / "out.pptx", *[_same_frame_shape(p) for p in paints]), 0)
    s3 = structural.check(page, slide)["S3"]
    assert s3["status"] == "n/a", s3
    assert s3["detail"].startswith(PRESET_NA), s3


def test_s3_attribute_mismatch_goes_to_the_drawing_the_preset_did_not_take(tmp_path):
    """Step 3 of the matching: an overlay at the wrong alpha is reported against the overlay's own drawing (alpha
    0.500 vs 0.800), after the button's drawing went to the button (step 2)."""
    page = pdf_facts.page_facts(_same_frame_pdf(tmp_path / "in.pdf", ("button", "overlay")), 0)
    deck = _deck(tmp_path / "out.pptx", _same_frame_shape("button"), _same_frame_shape("overlay", overlay_alpha=0.8))
    s3 = structural.check(page, pptx_facts.slide_facts(deck, 0))["S3"]
    assert s3["status"] == "fail", s3
    assert "attribute mismatches: 1 (fill of 'overlay': alpha 0.500 vs 0.800)" in s3["detail"], s3
    assert "unmatched" not in s3["detail"], s3


def test_s3_preset_paint_takes_a_drawing_of_its_own_kind_only(tmp_path):
    """M1-R47 matches a preset's paint by kind too: an ellipse's red line does not stand for a red fill."""
    page = pdf_facts.page_facts(_preset_pdf(tmp_path / "p.pdf", "ellipse", 0), 0)  # a red fill, no stroke
    lined = _deck(tmp_path / "l.pptx", _preset("ellipse", 0, fill="<a:noFill/>", line=_solid_line("FF0000", 2)))
    s3 = structural.check(page, pptx_facts.slide_facts(lined, 0))["S3"]
    assert s3["status"] == "fail", s3
    assert "unmatched PDF drawings: 1 (fill" in s3["detail"] and "unmatched slide paints: 1 (stroke" in s3["detail"]
    filled = _deck(tmp_path / "f.pptx", _preset("ellipse", 0))
    assert structural.check(page, pptx_facts.slide_facts(filled, 0))["S3"]["status"] == "n/a"


@pytest.mark.parametrize("paint", ["gradient", "pattern"])
@pytest.mark.parametrize("part", ["fill", "line"])
def test_s3_gradient_and_pattern_presets_are_matched_without_position(tmp_path, paint, part):
    """M1-R47 for gradients and patterns: a preset's gradient or pattern (its fill or its line) takes a PDF shading
    or pattern paint no other fill matched, its position not checked: n/a. Without that PDF paint it fails."""
    box = GRAD_BOX if paint == "gradient" else PATTERN_BOX
    fill_xml = GRAD_FILL if paint == "gradient" else PATT_FILL
    x0, y0, x1, y1 = box
    ellipse = _sp("ellipse", x0, y0, x1 - x0, y1 - y0, '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>',
                  fill_xml if part == "fill" else "<a:noFill/>",
                  NO_LINE if part == "fill" else f'<a:ln w="76200">{fill_xml}</a:ln>')
    slide = pptx_facts.slide_facts(_deck(tmp_path / "out.pptx", ellipse), 0)
    painted = build_pdf(tmp_path / "in.pdf", [gradient(box) if paint == "gradient" else pattern(box)])
    s3 = structural.check(pdf_facts.page_facts(painted, 0), slide)["S3"]
    assert s3["status"] == "n/a", s3
    assert s3["detail"].startswith(PRESET_NA), s3
    bare = build_pdf(tmp_path / "bare.pdf", [])
    assert structural.check(pdf_facts.page_facts(bare, 0), slide)["S3"]["status"] == "fail"


# ---- S1: background, layout and master pictures (F7, M1-R45) -------------------------------------------------------


def _set_background(path, where, fill_xml):
    """Give the slide, its layout or its master a p:bg with `fill_xml`."""
    prs = Presentation(str(path))
    slide = prs.slides[0]
    part = {"slide": slide, "layout": slide.slide_layout, "master": slide.slide_layout.slide_master}[where]
    c_sld = part._element.find(qn("p:cSld"))
    old = c_sld.find(qn("p:bg"))
    if old is not None:
        c_sld.remove(old)
    c_sld.insert(0, _xml(f"<p:bg><p:bgPr>{fill_xml}<a:effectLst/></p:bgPr></p:bg>"))
    prs.save(str(path))
    return path


def _add_to_tree(path, where, element):
    prs = Presentation(str(path))
    slide = prs.slides[0]
    part = {"slide": slide, "layout": slide.slide_layout, "master": slide.slide_layout.slide_master}[where]
    part._element.find(qn("p:cSld")).find(qn("p:spTree")).append(element)
    prs.save(str(path))
    return path


def _pic(name, box, sp_id=40, line=""):
    x0, y0, x1, y1 = box
    return _xml(f'<p:pic><p:nvPicPr><p:cNvPr id="{sp_id}" name="{name}"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>'
                f'{STRETCHED_BLIP.replace("a:blipFill", "p:blipFill")}<p:spPr><a:xfrm><a:off '
                f'x="{int(x0 * EMU)}" y="{int(y0 * EMU)}"/><a:ext cx="{int((x1 - x0) * EMU)}" '
                f'cy="{int((y1 - y0) * EMU)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>{line}'
                '</p:spPr></p:pic>')


@pytest.mark.parametrize("where", ["slide", "layout", "master"])
def test_s1_counts_a_background_picture(tmp_path, where):
    """The classic hybrid conversion: the page as a background picture, text on top. A stretched background
    blipFill is a full-slide picture; it passes only over a PDF image that large."""
    scene = without(base_scene(), 2)
    pdf = build_pdf(tmp_path / "in.pdf", scene)
    pptx = _set_background(build_pptx(tmp_path / "out.pptx", scene), where, STRETCHED_BLIP)
    slide = pptx_facts.slide_facts(pptx, 0)
    assert slide.pictures == [pytest.approx([0, 0, W_PT, H_PT])]
    s1 = structural.check(pdf_facts.page_facts(pdf, 0), slide)["S1"]
    assert s1["status"] == "fail" and "100.0 % of the slide" in s1["detail"]
    pdf = build_pdf(tmp_path / "in2.pdf", scene, page_image=True)
    assert structural.check(pdf_facts.page_facts(pdf, 0), slide)["S1"]["status"] == "pass"


@pytest.mark.parametrize("where", ["layout", "master"])
def test_s1_counts_layout_and_master_pictures(tmp_path, where):
    scene = without(base_scene(), 2)
    pdf = build_pdf(tmp_path / "in.pdf", scene)
    pptx = _add_to_tree(build_pptx(tmp_path / "out.pptx", scene), where, _pic("logo", (800, 20, 940, 80)))
    s1 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S1"]
    assert s1["status"] == "fail" and "inside no PDF image" in s1["detail"]


def test_hidden_background_graphics_are_not_painted(tmp_path):
    """showMasterSp="0" on the slide hides the layout's and the master's shapes."""
    scene = without(base_scene(), 2)
    pptx = _add_to_tree(build_pptx(tmp_path / "out.pptx", scene), "master", _pic("logo", (800, 20, 940, 80)))
    prs = Presentation(str(pptx))
    prs.slides[0]._element.set("showMasterSp", "0")
    prs.save(str(pptx))
    assert pptx_facts.slide_facts(pptx, 0).pictures == []


# ---- S3: gradient and pattern page backgrounds (F8, M1-R43) ----------------------------------------------------------


@pytest.mark.parametrize("where", ["slide", "layout", "master"])
def test_s3_gradient_page_background_matches_a_gradfill_slide_background(tmp_path, where):
    pdf = build_pdf(tmp_path / "in.pdf", base_scene(), background=False, page_paint="gradient")
    page = pdf_facts.page_facts(pdf, 0)
    assert page.first_paint["kind"] == "shade"
    plain = build_pptx(tmp_path / "plain.pptx", base_scene())
    s3 = structural.check(page, pptx_facts.slide_facts(plain, 0))["S3"]
    assert s3["status"] == "fail" and "shading" in s3["detail"]
    with_bg = _set_background(build_pptx(tmp_path / "bg.pptx", base_scene()), where, GRAD_FILL)
    s3 = structural.check(page, pptx_facts.slide_facts(with_bg, 0))["S3"]
    assert s3["status"] == "pass", s3
    assert "slide background" in s3["detail"]


def test_s3_gradfill_slide_background_needs_a_page_shading(tmp_path):
    page = pdf_facts.page_facts(build_pdf(tmp_path / "in.pdf", base_scene()), 0)
    with_bg = _set_background(build_pptx(tmp_path / "bg.pptx", base_scene()), "slide", GRAD_FILL)
    s3 = structural.check(page, pptx_facts.slide_facts(with_bg, 0))["S3"]
    assert s3["status"] == "fail" and "background" in s3["detail"]


@pytest.mark.parametrize("fill_xml", [PATT_FILL, TILED_BLIP])
def test_s3_pattern_page_background_matches_a_patterned_slide_background(tmp_path, fill_xml):
    pdf = build_pdf(tmp_path / "in.pdf", base_scene(), background=False, page_paint="pattern")
    page = pdf_facts.page_facts(pdf, 0)
    with_bg = _set_background(build_pptx(tmp_path / "bg.pptx", base_scene()), "slide", fill_xml)
    result = structural.check(page, pptx_facts.slide_facts(with_bg, 0))
    assert result["S3"]["status"] == "pass", result["S3"]
    assert result["S1"]["status"] == "pass", result["S1"]  # a tiled background picture is a pattern


# ---- S3: picture outlines and table cells (F9, M1-R45) ---------------------------------------------------------------


def test_s3_picture_outline_is_a_stroke_paint(tmp_path):
    lined = replaced(base_scene(), 2, line=((0, 0, 0), 3.0))
    assert run_checks(tmp_path, lined)["S3"]["status"] == "pass"
    missing = run_checks(tmp_path, lined, base_scene())["S3"]
    assert missing["status"] == "fail" and "unmatched PDF drawings" in missing["detail"]
    extra = run_checks(tmp_path, base_scene(), lined)["S3"]
    assert extra["status"] == "fail" and "unmatched slide paints" in extra["detail"]


NO_STYLE_NO_GRID = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"
TABLE_BOX = (100, 100, 300, 150)
CELL_BOXES = ((100, 100, 200, 150), (200, 100, 300, 150))


def _table_deck(path, fills=True, border=False, style=NO_STYLE_NO_GRID):
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(SLIDE_W), Emu(SLIDE_H)
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    frame = slide.shapes.add_table(1, 2, *_box_args(TABLE_BOX))
    frame.name = "Cells"
    tbl = frame._element.find(".//" + qn("a:tbl"))
    tbl_pr = tbl.find(qn("a:tblPr"))
    for attr in list(tbl_pr.attrib):
        del tbl_pr.attrib[attr]
    tbl_pr.find(qn("a:tableStyleId")).text = style
    for cell, rgb in zip(frame.table.rows[0].cells, ((255, 0, 0), (0, 0, 255))):
        if fills:
            cell.fill.solid()
            cell.fill.fore_color.rgb = RGBColor(*rgb)
    if border:
        tc_pr = frame.table.cell(0, 0)._tc.get_or_add_tcPr()
        tc_pr.insert(0, _xml('<a:lnR w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:lnR>'))
    prs.save(str(path))
    return path


def test_s3_table_cell_fills_and_borders_are_paints(tmp_path):
    cells = [fill(CELL_BOXES[0], (255, 0, 0)), fill(CELL_BOXES[1], (0, 0, 255))]
    pdf = build_pdf(tmp_path / "in.pdf", cells)
    page = pdf_facts.page_facts(pdf, 0)
    s3 = structural.check(page, pptx_facts.slide_facts(_table_deck(tmp_path / "t.pptx"), 0))["S3"]
    assert s3["status"] == "pass", s3
    bare = structural.check(page, pptx_facts.slide_facts(_table_deck(tmp_path / "b.pptx", fills=False), 0))["S3"]
    assert bare["status"] == "fail" and "unmatched PDF drawings: 2" in bare["detail"]
    doc = pymupdf.open(str(pdf))
    doc[0].draw_line((200, 100), (200, 150), color=(0, 0, 0), width=1)
    doc.save(str(tmp_path / "lined.pdf"))
    lined = pdf_facts.page_facts(tmp_path / "lined.pdf", 0)
    s3 = structural.check(lined, pptx_facts.slide_facts(_table_deck(tmp_path / "l.pptx", border=True), 0))["S3"]
    assert s3["status"] == "pass", s3
    assert structural.check(lined, pptx_facts.slide_facts(_table_deck(tmp_path / "n.pptx"), 0))["S3"]["status"] \
        == "fail"


def test_s3_table_style_it_cannot_resolve_fails_closed(tmp_path):
    """A table style that is not in the file (PowerPoint's built-in styles): its fills and borders are unknown,
    so S3 fails instead of passing on a guess."""
    pdf = build_pdf(tmp_path / "in.pdf", [fill(CELL_BOXES[0], (255, 0, 0)), fill(CELL_BOXES[1], (0, 0, 255))])
    styled = _table_deck(tmp_path / "s.pptx", style="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}")
    s3 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(styled, 0))["S3"]
    assert s3["status"] == "fail" and "table style" in s3["detail"]


# ---- checker false fails found by the source-deck calibration (M1-R46) -----------------------------------------------


def _set_run_attrs(path, text_value, **attrs):
    """Set rPr attributes on the run whose text is `text_value`; `hlink` adds an a:hlinkClick (theme hyperlink)."""
    prs = Presentation(str(path))
    for shape in prs.slides[0].shapes:
        if not shape.has_text_frame:
            continue
        for paragraph in shape.text_frame.paragraphs:
            for run in paragraph.runs:
                if run.text != text_value:
                    continue
                rpr = run.font._rPr
                hlink = attrs.pop("hlink", None)
                for key, value in attrs.items():
                    rpr.set(key, value)
                if hlink:
                    rpr.append(_xml(hlink))
    prs.save(str(path))
    return path


def test_caps_are_compared_as_powerpoint_draws_them(tmp_path):
    """cap="all" draws capitals; cap="small" draws lower-case letters as capitals at 80 % of the size."""
    pdf_scene = [text((100, 300), "HELLO WORLD", 24, (0, 0, 0)), text((100, 360), "S", 24, (0, 0, 0)),
                 text((116, 360), "MALL", 19.2, (0, 0, 0))]
    slide_scene = [text((100, 300), "Hello World", 24, (0, 0, 0)), text((100, 360), "Small", 24, (0, 0, 0))]
    pdf = build_pdf(tmp_path / "in.pdf", pdf_scene)
    pptx = build_pptx(tmp_path / "out.pptx", slide_scene)
    _set_run_attrs(pptx, "Hello World", cap="all")
    _set_run_attrs(pptx, "Small", cap="small")
    s2 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S2"]
    assert s2["status"] == "pass", s2
    runs = [(r["text"], r["size"]) for r in pptx_facts.slide_facts(pptx, 0).runs]
    assert runs == [("HELLO WORLD", 24.0), ("S", 24.0), ("MALL", pytest.approx(19.2))]


HLINK = '<a:hlinkClick r:id="rId42"/>'
HLINK_TEXT_COLOUR = ('<a:hlinkClick r:id="rId42"><a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}">'
                     '<ahyp:hlinkClr xmlns:ahyp="http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor" '
                     'val="tx"/></a:ext></a:extLst></a:hlinkClick>')


@pytest.mark.parametrize("hlink,pdf_rgb", [(HLINK, (0, 0, 255)), (HLINK_TEXT_COLOUR, (51, 102, 153))])
def test_hyperlink_text_takes_the_theme_hyperlink_colour(tmp_path, hlink, pdf_rgb):
    """PowerPoint draws a hyperlink in the theme's hlink colour, whatever the run's colour, unless the link says
    hlinkClr val="tx" (use the text colour)."""
    pdf = build_pdf(tmp_path / "in.pdf", [text((100, 300), "Link", 24, pdf_rgb)])
    pptx = _set_run_attrs(build_pptx(tmp_path / "out.pptx", [text((100, 300), "Link", 24, (51, 102, 153))]), "Link",
                          hlink=hlink)
    s2 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S2"]
    assert s2["status"] == "pass", s2


def test_layout_and_master_shapes_and_text_are_painted(tmp_path):
    """The non-placeholder shapes of the layout and the master (a bar, a footer text) are drawn on the slide."""
    bar = fill((0, 0, W_PT, 8), (31, 56, 100))
    pdf = build_pdf(tmp_path / "in.pdf", [bar, text((40, 520), "Footer", 10, (0, 0, 0))] + base_scene())
    pptx = build_pptx(tmp_path / "out.pptx", base_scene())
    _add_to_tree(pptx, "master", _sp("bar", 0, 0, W_PT, 8, '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>',
                                     '<a:solidFill><a:srgbClr val="1F3864"/></a:solidFill>', NO_LINE, sp_id=50))
    footer = _xml('<p:sp><p:nvSpPr><p:cNvPr id="51" name="footer"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
                  '<p:spPr><a:xfrm><a:off x="508000" y="6477000"/><a:ext cx="2540000" cy="254000"/></a:xfrm>'
                  '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/>'
                  '<a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1000" b="0" i="0"><a:solidFill><a:srgbClr '
                  'val="000000"/></a:solidFill><a:latin typeface="Deck Sans"/><a:ea typeface="Deck Sans"/></a:rPr>'
                  '<a:t>Footer</a:t></a:r></a:p></p:txBody></p:sp>')
    _add_to_tree(pptx, "layout", footer)
    result = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))
    assert result["S2"]["status"] == "pass", result["S2"]
    assert result["S3"]["status"] == "pass", result["S3"]


def test_stretched_picture_fill_region_is_the_fill_rect(tmp_path):
    """a:stretch/a:fillRect insets the region the bitmap is drawn into; the picture is that region."""
    path = build_pptx(tmp_path / "out.pptx", base_scene())
    prs = Presentation(str(path))
    pic = [s for s in prs.slides[0].shapes if s.shape_type == 13][0]  # MSO_SHAPE_TYPE.PICTURE
    stretch = pic._element.find(qn("p:blipFill")).find(qn("a:stretch"))
    stretch.find(qn("a:fillRect")).attrib.update({"l": "10000", "t": "10000", "r": "10000", "b": "10000"})
    prs.save(str(path))
    x0, y0, x1, y1 = IMAGE_BOX
    inset = (x0 + 12, y0 + 9, x1 - 12, y1 - 9)  # 10 % of 120 x 90
    assert pptx_facts.slide_facts(path, 0).pictures == [pytest.approx(list(inset), abs=0.01)]


# ---- S6 (M1-R40) -------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("typeface,status", [("Pretendard-Bold", "fail"), ("Pretendard", "pass")])
def test_s6_flags_the_basefont_of_a_family_without_a_space(tmp_path, typeface, status):
    """M1-R40: the BaseFont (subset tag removed) fails whenever it differs from the family name, spaces or not."""
    real = dict(STYLES)
    try:
        STYLES["bold"] = ("Pretendard", "Bold", "Pretendard-Bold", True, False)
        scene = [text((100, 300), "Bold Words", 24, (0, 0, 0), "bold")]
        s6 = run_checks(tmp_path, scene, pptx_kwargs={"typeface": typeface})["S6"]
        assert s6["status"] == status, s6
    finally:
        STYLES.clear()
        STYLES.update(real)


def test_s6_flags_the_full_basefont_with_a_space_in_the_family(tmp_path):
    s6 = run_checks(tmp_path, base_scene(), pptx_kwargs={"typeface": "DeckSans-Regular"})["S6"]
    assert s6["status"] == "fail" and "DeckSans-Regular" in s6["detail"]


# ---- minors: S3 background clip, S4 provenance page and wording, S7 input and temp dir ---------------------------


def test_s3_background_shape_matches_the_page_clipped_background(tmp_path):
    """A background drawn past the page edges is matched by a full-slide shape (bbox clipped to the page)."""
    pdf_scene = [fill((-10, -10, W_PT + 10, H_PT + 10), (255, 255, 255))] + base_scene()
    slide_scene = [fill((0, 0, W_PT, H_PT), (255, 255, 255))] + base_scene()
    s3 = run_checks(tmp_path, pdf_scene, slide_scene, pdf_kwargs={"background": False})["S3"]
    assert s3["status"] == "pass", s3
    assert "full-slide background shape removed" in s3["detail"]


def test_s4_checks_the_page_number_of_the_provenance(tmp_path):
    path = build_pptx(tmp_path / "out.pptx", base_scene())
    prs = Presentation(str(path))
    for shape in prs.slides[0].shapes:
        shape.name = shape.name.replace("pdf:p1:", "pdf:p2:")
    prs.save(str(path))
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == "fail" and "page 2" in s4["detail"] and "page 1" in s4["detail"]


def test_s4_detail_says_all_pairs_concordant(tmp_path):
    s4 = run_checks(tmp_path, base_scene())["S4"]
    assert s4["status"] == "pass" and "all pairs concordant" in s4["detail"]
    assert "Kendall" not in s4["detail"] and "tau" not in s4["detail"]


def test_s7_unreadable_input_pdf_fails_before_powerpoint(tmp_path, monkeypatch, pair):
    _pdf, pptx = pair
    broken = tmp_path / "Private-Deck-broken.pdf"
    broken.write_bytes(b"not a pdf")
    fake = _fake(monkeypatch, FakeExport())
    result = roundtrip.s7(pptx, broken)
    assert result["status"] == "fail" and "input PDF" in result["detail"]
    assert not fake.calls  # PowerPoint was never started
    _assert_private(result, tmp_path)


def test_s7_reports_a_temp_dir_it_could_not_remove(tmp_path, monkeypatch, pair):
    pdf, pptx = pair
    fake = _fake(monkeypatch, FakeExport(pdf=pdf))
    monkeypatch.setattr(roundtrip.shutil, "rmtree", lambda *args, **kwargs: None)
    result = roundtrip.s7(pptx, pdf)
    left = fake.calls[0]["out_dir"]
    try:
        assert result["status"] == "pass", result
        assert "temp directory could not be removed" in result["detail"]
        assert str(left) not in result["detail"] and left.name not in result["detail"]
        _assert_private(result, tmp_path)
    finally:
        monkeypatch.undo()
        shutil.rmtree(left, ignore_errors=True)


# ---- S7: the baseline across the writing direction (F3) -------------------------------------------------------------


def _vertical_text_pdf(path, dx=0.0, dy=0.0):
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.insert_text((300 + dx, 400 + dy), "Upwards", fontname="helv", fontsize=24, rotate=90)
    page.insert_text((500, 300), "Flat", fontname="helv", fontsize=24)
    doc.save(str(path))
    return path


@pytest.mark.parametrize("dx,dy,status", [(0.4, 0, "pass"), (0.7, 0, "fail"), (-2.0, 0, "fail"), (0, 2.0, "pass")])
def test_s7_compares_the_baseline_across_the_writing_direction(tmp_path, dx, dy, status):
    """Text turned 90 degrees runs along y: its baseline offset is in x; an offset along the line is not a baseline
    error."""
    a = _vertical_text_pdf(tmp_path / "a.pdf")
    b = _vertical_text_pdf(tmp_path / "b.pdf", dx, dy)
    problems = roundtrip.compare(a, b)
    assert any("baseline" in p for p in problems) == (status == "fail"), problems


# ---- S7: the writing direction is the PDF's own (M1-R51) ------------------------------------------------------------


def _stacked_pdf(path, letters, dx=0.0, dy=0.0):
    """One-glyph horizontal lines stacked 1.2 em apart (a step-number column, one syllable per line)."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    for k, letter in enumerate(letters):
        page.insert_text((100 + dx, 100 + 28.8 * k + dy), letter, fontname="helv", fontsize=24)
    doc.save(str(path))
    return path


@pytest.mark.parametrize("letters", ["ABC", "1234"])
@pytest.mark.parametrize("dx,dy,status", [(0, 2.0, "fail"), (0, 0.4, "pass"), (2.0, 0, "pass")])
def test_s7_stacked_one_glyph_lines_keep_a_horizontal_baseline(tmp_path, letters, dx, dy, status):
    """M1-R51: the writing direction is the PDF's own (rawdict line dir), not a guess from neighbours: a column of
    one-glyph horizontal lines is horizontal text, so 2 pt down is a baseline error and 2 pt along its lines is not."""
    a = _stacked_pdf(tmp_path / "a.pdf", letters)
    b = _stacked_pdf(tmp_path / "b.pdf", letters, dx, dy)
    problems = roundtrip.compare(a, b)
    assert any("baseline" in p for p in problems) == (status == "fail"), problems


@pytest.mark.parametrize("dx,dy,status", [(2.0, 0, "fail"), (0.4, 0, "pass"), (0, 2.0, "pass")])
def test_s7_vertical_mode_text_is_written_down_its_column(tmp_path, dx, dy, status):
    """M1-R51: a vertical-mode font (rawdict wmode 1) writes down the page, so its baseline offset is across the
    column (x), and an offset along the column is not a baseline error."""
    a = vertical_font_pdf(tmp_path / "a.pdf")
    b = vertical_font_pdf(tmp_path / "b.pdf", dx, dy)
    assert "".join(g["u"] for g in inventory(str(a))["pages"][0]["glyphs"] if g["u"].strip()) == "FlatABCD"
    with pymupdf.open(str(a)) as doc:
        assert {line["wmode"] for block in doc[0].get_text("rawdict")["blocks"] for line in block["lines"]} == {0, 1}
    problems = roundtrip.compare(a, b)
    assert any("baseline" in p for p in problems) == (status == "fail"), problems


def _turned_text_pdf(path, rotation, dx=0.0, dy=0.0):
    """Horizontal text in the content of a page turned by /Rotate `rotation`, moved by (dx, dy) in the content's
    own (unturned) frame: dy moves it across its line, dx along it. Turned, the line runs down (90) or up (270)."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.insert_text((100 + dx, 300 + dy), "Turned", fontname="helv", fontsize=24)
    page.set_rotation(rotation)
    doc.save(str(path))
    return path


@pytest.mark.parametrize("rotation,direction", [(90, (0, 1)), (270, (0, -1))])
def test_text_directions_on_a_rotated_page(tmp_path, rotation, direction):
    """M1-R51 on a /Rotate page: rawdict gives the unturned page, so text_directions turns each line's dir (by the
    rotation's linear part) and each glyph origin (by page.rotation_matrix) into the frame the oracle's glyphs use."""
    pdf = _turned_text_pdf(tmp_path / "t.pdf", rotation)
    glyphs = [g for g in inventory(str(pdf))["pages"][0]["glyphs"] if g["u"].strip()]
    with pymupdf.open(str(pdf)) as doc:
        index = pdf_facts.text_directions(doc[0])
    found = [index.find(g["x"], g["y"]) for g in glyphs]
    assert len(glyphs) == 6 and all(f is not None for f in found), found
    assert all(f["direction"] == pytest.approx(direction, abs=1e-9) for f in found), found


@pytest.mark.parametrize("rotation", [90, 270])
@pytest.mark.parametrize("dx,dy,status", [(0, 2.0, "fail"), (0, 0.4, "pass"), (2.0, 0, "pass")])
def test_s7_baseline_on_a_rotated_page_is_across_the_turned_line(tmp_path, rotation, dx, dy, status):
    """M1-R51 on a /Rotate page: the baseline offset is measured across the line as the page shows it, so 2 pt across
    the line fails and 2 pt along it passes (an unturned direction would swap the two verdicts)."""
    a = _turned_text_pdf(tmp_path / "a.pdf", rotation)
    b = _turned_text_pdf(tmp_path / "b.pdf", rotation, dx, dy)
    problems = roundtrip.compare(a, b)
    assert any("baseline" in p for p in problems) == (status == "fail"), problems


# ---- S3: gradient and pattern lines are matched by containment (M1-R48) ----------------------------------------------

RECT_GEOM = '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
CONNECTOR_GEOM = '<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom>'
ACUTE = (40, 150, 240, 210)  # a custGeom triangle with a 17 degree apex at its right: a miter reaches 6.74 x w/2 past


def _acute_geom():
    x0, y0, x1, y1 = ACUTE
    w, h = int((x1 - x0) * EMU), int((y1 - y0) * EMU)
    return (f'<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>'
            f'<a:path w="{w}" h="{h}"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="{w}" y="{h // 2}"/>'
            f'</a:lnTo><a:lnTo><a:pt x="0" y="{h}"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>')


def _custgeom(w, h, commands):
    """An a:custGeom of one path (`w` x `h` path units) of `commands`: ("M" | "L", x, y) or ("Z",)."""
    tags = {"M": "moveTo", "L": "lnTo"}
    body = "".join("<a:close/>" if c[0] == "Z" else f'<a:{tags[c[0]]}><a:pt x="{c[1]}" y="{c[2]}"/></a:{tags[c[0]]}>'
                   for c in commands)
    return (f'<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst>'
            f'<a:path w="{w}" h="{h}">{body}</a:path></a:pathLst></a:custGeom>')


# one lnTo across the middle of its frame: an open single segment, as a custGeom (what deckback writes for a line)
OPEN_SEGMENT_GEOM = _custgeom(1000, 1000, [("M", 0, 500), ("L", 1000, 500)])
MITER_BOX = (35, 144.19, 273.71, 215.81)  # PowerPoint's export of ACUTE, 10 pt line, miter join: tip 33.71 pt past


@pytest.mark.parametrize("paint,geometry,frame,width,join,pdf_box,status", [
    # a rect outline: the PDF clip is the path grown by w/2 (a right-angle miter reaches no further)
    ("gradient", RECT_GEOM, (100, 440, 300, 500), 8, "", (96, 436, 304, 504), "pass"),
    # a 10 x 10 outline whose centre is the 200 x 60 shading's (the slide box must contain the PDF box, less g)
    ("gradient", RECT_GEOM, (195, 465, 205, 475), 3, "", (100, 440, 300, 500), "fail"),
    # an open single segment (atlas lines/11): grown by w/2 across it, flat caps
    ("gradient", CONNECTOR_GEOM, (276, 263, 456, 263), 10, "", (276, 258, 456, 268), "pass"),
    ("gradient", CONNECTOR_GEOM, (286, 263, 446, 263), 10, "", (276, 258, 456, 268), "fail"),  # 20 pt short
    ("pattern", CONNECTOR_GEOM, (276, 263, 456, 263), 14, "", (276, 256, 456, 270), "pass"),
    ("pattern", CONNECTOR_GEOM, (286, 263, 446, 263), 14, "", (276, 256, 456, 270), "fail"),  # 20 pt short
    ("pattern", CONNECTOR_GEOM, (266, 263, 466, 263), 14, "", (276, 256, 456, 270), "fail"),  # 20 pt long
    # an open single segment has no join, so a miter join does not widen it (g stays w/2, not w/2 x 8 = 40 pt):
    # the straightConnector1 preset and a custGeom of one lnTo, each exact and 20 pt short
    ("gradient", CONNECTOR_GEOM, (276, 263, 456, 263), 10, '<a:miter lim="800000"/>', (276, 258, 456, 268), "pass"),
    ("gradient", CONNECTOR_GEOM, (286, 263, 446, 263), 10, '<a:miter lim="800000"/>', (276, 258, 456, 268), "fail"),
    ("pattern", OPEN_SEGMENT_GEOM, (276, 256, 456, 270), 14, "<a:miter/>", (276, 256, 456, 270), "pass"),
    ("pattern", OPEN_SEGMENT_GEOM, (286, 256, 446, 270), 14, "<a:miter/>", (276, 256, 456, 270), "fail"),
    # miter joins: g = w/2 x the miter limit; <a:miter/> without lim is 8 (measured: PowerPoint writes "8 M"), and
    # the PDF box is the one PowerPoint exported for this triangle (its miter tip 33.71 pt past the apex)
    ("gradient", None, ACUTE, 10, "<a:miter/>", MITER_BOX, "pass"),
    ("gradient", None, ACUTE, 10, '<a:miter lim="800000"/>', MITER_BOX, "pass"),
    ("gradient", None, ACUTE, 10, '<a:miter lim="200000"/>', MITER_BOX, "fail"),
    ("gradient", None, ACUTE, 10, "<a:round/>", MITER_BOX, "fail"),
    ("gradient", None, ACUTE, 10, "<a:bevel/>", MITER_BOX, "fail"),
    # no join anywhere: PowerPoint joins round (measured: "1 j"), and exported this box for it
    ("gradient", None, ACUTE, 10, "", MITER_BOX, "fail"),
    ("gradient", None, ACUTE, 10, "", (35, 144.84, 245, 215.16), "pass"),
])
def test_s3_gradient_and_pattern_lines_are_matched_by_containment(tmp_path, paint, geometry, frame, width, join,
                                                                  pdf_box, status):
    """M1-R48: a line filled with a gradient or a pattern is painted through its stroke outline. Its path bbox must
    lie inside the PDF shading / pattern bbox (+0.5 pt), and that bbox inside the path bbox grown by g (+0.5 pt):
    g = w/2 for round and bevel joins and for open single segments, w/2 x the miter limit for miter joins."""
    element = gradient(pdf_box) if paint == "gradient" else pattern(pdf_box)
    pdf = build_pdf(tmp_path / "in.pdf", base_scene() + [element])
    fill_xml = GRAD_FILL if paint == "gradient" else PATT_FILL
    x0, y0, x1, y1 = frame
    line = _sp("outline", x0, y0, x1 - x0, y1 - y0, geometry or _acute_geom(), "<a:noFill/>",
               f'<a:ln w="{int(width * EMU)}">{fill_xml}{join}</a:ln>', sp_id=60)
    pptx = _add_to_tree(build_pptx(tmp_path / "out.pptx", base_scene()), "slide", line)
    s3 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S3"]
    assert s3["status"] == status, s3
    assert "centre" not in s3["detail"]


LN_REF_STYLE = ('<p:style><a:lnRef idx="2"><a:srgbClr val="000000"/></a:lnRef><a:fillRef idx="0"><a:srgbClr '
                'val="000000"/></a:fillRef><a:effectRef idx="0"><a:srgbClr val="000000"/></a:effectRef><a:fontRef '
                'idx="minor"><a:schemeClr val="tx1"/></a:fontRef></p:style>')


def _theme_line_style(path, idx, cap=None, join=None):
    """Give the theme's line style `idx` (1-based; what a shape's lnRef idx names) a cap and / or a join element."""
    prs = Presentation(str(path))
    theme = prs.slide_masters[0].part.part_related_by(RT.THEME)
    root = etree.fromstring(theme.blob)
    ln = root.find(".//" + qn("a:lnStyleLst"))[idx - 1]
    if cap is not None:
        ln.set("cap", cap)
    if join is not None:
        ln.append(_xml(join))  # after the fill and prstDash, as CT_LineProperties orders them
    theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    prs.save(str(path))
    return path


def _gradient_line_deck(path, geometry, frame, width, ln_attrs="", ln_join="", styled=False, theme_cap=None,
                        theme_join=None):
    """base_scene's deck plus one gradient-filled line ("outline"): its a:ln has `ln_attrs` and `ln_join`; with
    `styled` the shape refers to the theme's line style 2 (lnRef), which gets `theme_cap` and `theme_join`."""
    x0, y0, x1, y1 = frame
    line = _sp("outline", x0, y0, x1 - x0, y1 - y0, geometry, "<a:noFill/>",
               f'<a:ln w="{int(width * EMU)}"{ln_attrs}>{GRAD_FILL}{ln_join}</a:ln>', sp_id=60)
    if styled:
        line.append(_xml(LN_REF_STYLE))
    pptx = _add_to_tree(build_pptx(path, base_scene()), "slide", line)
    if theme_cap is not None or theme_join is not None:
        _theme_line_style(pptx, 2, cap=theme_cap, join=theme_join)
    return pptx


@pytest.mark.parametrize("ln_join,theme_join,status", [
    ("", '<a:miter lim="800000"/>', "pass"),  # the join of the theme line style the shape refers to
    ("<a:round/>", '<a:miter lim="800000"/>', "fail"),  # the a:ln's own join comes first
    ("", None, "fail"),  # no join anywhere: round
])
def test_s3_gradient_line_join_from_the_theme_line_style(tmp_path, ln_join, theme_join, status):
    """M1-R48 with the join from the theme: a closed custGeom whose a:ln sets no join takes the join of its lnRef
    line style; a miter there reaches MITER_BOX, a round join does not."""
    pdf = build_pdf(tmp_path / "in.pdf", base_scene() + [gradient(MITER_BOX)])
    pptx = _gradient_line_deck(tmp_path / "out.pptx", _acute_geom(), ACUTE, 10, ln_join=ln_join, styled=True,
                               theme_join=theme_join)
    line = next(s["line"] for s in pptx_facts.slide_facts(pptx, 0).shapes if s["name"] == "outline")
    assert line["join"] == ("miter" if theme_join and not ln_join else "round")
    s3 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S3"]
    assert s3["status"] == status, s3


DIAGONAL = (300, 200, 400, 300)  # a straightConnector1 at 45 degrees, from (300, 200) to (400, 300)
# the outline box of its 6 pt line, as MuPDF bounds the stroke: a flat cap ends at the end points (w/2 across the
# line: 2.12 pt per axis at 45 degrees), a round cap reaches w/2 = 3 pt past them, and a square cap
# (w/2)(|cos| + |sin|) = w / sqrt 2 = 4.24 pt per axis (the most it can reach, at 45 degrees)
DIAGONAL_FLAT = (297.8787, 197.8787, 402.1213, 302.1213)
DIAGONAL_ROUND = (297, 197, 403, 303)
DIAGONAL_SQUARE = (295.7574, 195.7574, 404.2426, 304.2426)
DIAGONAL_SQUARE_LONG = (294.7574, 194.7574, 405.2426, 305.2426)  # 1 pt further out
# an open polyline (a V of two 45 degree segments) in (300, 200, 400, 250): square caps at its two open ends, a
# round join at its vertex (350, 250) reaching 253
V_GEOM = _custgeom(100, 50, [("M", 0, 0), ("L", 50, 50), ("L", 100, 0)])
V_FRAME = (300, 200, 400, 250)
V_SQUARE = (295.7574, 195.7574, 404.2426, 253)


@pytest.mark.parametrize("geometry,frame,ln_cap,theme_cap,pdf_box,status", [
    (CONNECTOR_GEOM, DIAGONAL, "flat", None, DIAGONAL_FLAT, "pass"),
    (CONNECTOR_GEOM, DIAGONAL, "rnd", None, DIAGONAL_ROUND, "pass"),
    (CONNECTOR_GEOM, DIAGONAL, "sq", None, DIAGONAL_SQUARE, "pass"),
    (CONNECTOR_GEOM, DIAGONAL, "sq", None, DIAGONAL_SQUARE_LONG, "fail"),
    (CONNECTOR_GEOM, DIAGONAL, "flat", None, DIAGONAL_SQUARE, "fail"),
    # no cap anywhere: PowerPoint ends the line flat (measured: atlas lines/11, whose a:ln has no cap)
    (CONNECTOR_GEOM, DIAGONAL, None, None, DIAGONAL_SQUARE, "fail"),
    # the cap of the theme line style the shape refers to (lnRef); the a:ln's own cap comes first
    (CONNECTOR_GEOM, DIAGONAL, None, "sq", DIAGONAL_SQUARE, "pass"),
    (CONNECTOR_GEOM, DIAGONAL, "flat", "sq", DIAGONAL_SQUARE, "fail"),
    # the same custGeom segment
    (_custgeom(100, 100, [("M", 0, 0), ("L", 100, 100)]), DIAGONAL, "sq", None, DIAGONAL_SQUARE, "pass"),
    # an open polyline has caps as well as joins: g is the larger reach
    (V_GEOM, V_FRAME, "sq", None, V_SQUARE, "pass"),
    (V_GEOM, V_FRAME, "flat", None, V_SQUARE, "fail"),
], ids=["flat", "round", "square", "square, 1 pt long", "flat, square box", "no cap, square box", "theme square",
        "flat over theme square", "custGeom square", "polyline square", "polyline flat, square box"])
def test_s3_square_caps_reach_w_over_root_two(tmp_path, geometry, frame, ln_cap, theme_cap, pdf_box, status):
    """M1-R48 with caps: at an open end a square cap reaches (w/2)(|cos| + |sin|) per axis past the end point, up to
    w / sqrt 2 at 45 degrees, so g = w / sqrt 2 for cap="sq" (w/2 for flat and round caps); an open polyline's g is
    the larger of its cap's and its join's reach."""
    pdf = build_pdf(tmp_path / "in.pdf", base_scene() + [gradient(pdf_box)])
    pptx = _gradient_line_deck(tmp_path / "out.pptx", geometry, frame, 6,
                               ln_attrs=f' cap="{ln_cap}"' if ln_cap else "", styled=theme_cap is not None,
                               theme_cap=theme_cap)
    s3 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S3"]
    assert s3["status"] == status, s3


@pytest.mark.parametrize("cap", [None, "sq"])
def test_line_cap_of_a_table_border(tmp_path, cap):
    """A cell border's cap comes from its own line element (flat without one), like a shape's."""
    path = _table_deck(tmp_path / "t.pptx", border=True)
    if cap:
        prs = Presentation(str(path))
        prs.slides[0].shapes[0]._element.find(".//" + qn("a:lnR")).set("cap", cap)
        prs.save(str(path))
    [border] = [s for s in pptx_facts.slide_facts(path, 0).shapes if s["line"]]
    assert border["line"]["cap"] == (cap or "flat")
    assert border["open"] and border["ends"]


# DIAGONAL's frame as a closed square: its 6 pt outline, joined round, reaches w/2 = 3 pt past every side
CLOSED_SQUARE = _custgeom(100, 100, [("M", 0, 0), ("L", 100, 0), ("L", 100, 100), ("L", 0, 100), ("Z",)])
CLOSED_REACH = (297, 197, 403, 303)
# subpaths for one custGeom in DIAGONAL: the open 45 degree segment corner to corner, and a closed square inside it
OPEN_DIAGONAL = [("M", 0, 0), ("L", 100, 100)]
INNER_SQUARE = [("M", 40, 40), ("L", 60, 40), ("L", 60, 60), ("L", 40, 60), ("Z",)]


@pytest.mark.parametrize("geometry,ln_cap,pdf_box,status", [
    # a closed path has no ends: its square cap never shows, so g stays the join's w/2
    (RECT_GEOM, "sq", CLOSED_REACH, "pass"),
    (RECT_GEOM, "sq", DIAGONAL_SQUARE, "fail"),
    (CLOSED_SQUARE, "sq", CLOSED_REACH, "pass"),
    (CLOSED_SQUARE, "sq", DIAGONAL_SQUARE, "fail"),
    # one open subpath among others gives the stroke ends, whichever subpath comes first
    (_custgeom(100, 100, OPEN_DIAGONAL + INNER_SQUARE), "sq", DIAGONAL_SQUARE, "pass"),
    (_custgeom(100, 100, OPEN_DIAGONAL + INNER_SQUARE), "flat", DIAGONAL_SQUARE, "fail"),
    (_custgeom(100, 100, INNER_SQUARE + OPEN_DIAGONAL), "sq", DIAGONAL_SQUARE, "pass"),
], ids=["closed rect", "closed rect, square box", "closed custGeom", "closed custGeom, square box",
        "open subpath first", "open subpath first, flat", "open subpath last"])
def test_s3_square_caps_reach_only_past_open_ends(tmp_path, geometry, ln_cap, pdf_box, status):
    """M1-R48 with caps: a cap is drawn only at the ends of an open subpath. A closed rect or custGeom with cap="sq"
    reaches w/2 past its path (its round join), not w / sqrt 2; a custGeom whose open subpath is followed or preceded
    by a closed one has ends, so its square caps reach w / sqrt 2."""
    pdf = build_pdf(tmp_path / "in.pdf", base_scene() + [gradient(pdf_box)])
    pptx = _gradient_line_deck(tmp_path / "out.pptx", geometry, DIAGONAL, 6, ln_attrs=f' cap="{ln_cap}"')
    s3 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S3"]
    assert s3["status"] == status, s3


# ---- S3: only the full-page paint painted first is the slide background (M1-R43) ------------------------------------


@pytest.mark.parametrize("paint", ["gradient", "pattern"])
@pytest.mark.parametrize("case", ["full page, painted later", "painted first, not full page",
                                  "full page, after a full-page fill"])
def test_s3_slide_background_needs_the_full_page_paint_painted_first(tmp_path, paint, case):
    """M1-R43: only a shading (pattern) that covers the page and is painted first is the slide background. One
    painted after other paints, one painted first that does not cover the page, or one painted after a full-page
    paint of another kind (a white page fill: the first paint covers the page but is no shading / pattern) is not
    matched by a gradFill (patterned) p:bg."""
    scene = base_scene()
    add, element, box = ((_add_shading, gradient, GRAD_BOX) if paint == "gradient" else
                         (_add_pattern, pattern, PATTERN_BOX))
    if case.startswith("full page"):
        pdf = build_pdf(tmp_path / "in.pdf", scene + [element((0, 0, W_PT, H_PT))],
                        background=case == "full page, after a full-page fill")
    else:
        doc = pymupdf.open(str(build_pdf(tmp_path / "plain.pdf", scene, background=False)))
        add(doc, doc[0], box, first=True)
        pdf = tmp_path / "in.pdf"
        doc.save(str(pdf))
        doc.close()
    page = pdf_facts.page_facts(pdf, 0)
    kind = "shade" if paint == "gradient" else "pattern"
    assert len(page.shadings if paint == "gradient" else page.patterns) == 1
    assert (page.first_paint["kind"] == kind) == (case == "painted first, not full page")
    if case == "full page, after a full-page fill":
        assert page.first_paint == {"kind": "fill", "bbox": pytest.approx([0, 0, W_PT, H_PT], abs=0.01)}
    pptx = _set_background(build_pptx(tmp_path / "out.pptx", scene), "slide",
                           GRAD_FILL if paint == "gradient" else PATT_FILL)
    s3 = structural.check(page, pptx_facts.slide_facts(pptx, 0))["S3"]
    assert s3["status"] == "fail", s3
    assert "slide background" in s3["detail"] and "painted first" in s3["detail"]


# ---- S3: every matching step is a maximum matching (M1-R52) ---------------------------------------------------------

RED = (255, 0, 0)
BLUE = (0, 0, 255)
WHITE = (255, 255, 255)


def _right(box, dx):
    x0, y0, x1, y1 = box
    return (x0 + dx, y0, x1 + dx, y1)


# A tolerance chain: two drawings 0.3 and 0.7 pt right of a box, two slide paints 0.7 pt (exact for the second
# drawing, 0.4 off the first) and 0 pt right (0.3 off the first, 0.7 off the second). Only the first drawing takes
# the 0 pt paint; first-fit gives it the 0.7 pt paint when the slide paints that first, and leaves the second
# drawing without one.
CHAIN_PDF = (0.3, 0.7)
CHAIN_ORDERS = pytest.mark.parametrize("slide_shifts", [(0.7, 0.0), (0.0, 0.7)], ids=["exact first", "exact last"])


@CHAIN_ORDERS
def test_s3_tolerance_chain_is_matched_in_any_slide_order(tmp_path, slide_shifts):
    """M1-R52, step 1: a maximum matching pairs both drawings of the chain, in either slide order."""
    pdf_scene = [fill(_right(RED_BOX, dx), RED) for dx in CHAIN_PDF]
    slide_scene = [fill(_right(RED_BOX, dx), RED) for dx in slide_shifts]
    s3 = run_checks(tmp_path, pdf_scene, slide_scene)["S3"]
    assert s3["status"] == "pass", s3


@CHAIN_ORDERS
def test_s3_attribute_mismatches_pair_a_tolerance_chain(tmp_path, slide_shifts):
    """M1-R52, step 3: the chain in another colour is two attribute mismatches, never a drawing and a paint left
    unmatched."""
    pdf_scene = [fill(_right(RED_BOX, dx), RED) for dx in CHAIN_PDF]
    slide_scene = [fill(_right(RED_BOX, dx), BLUE) for dx in slide_shifts]
    s3 = run_checks(tmp_path, pdf_scene, slide_scene)["S3"]
    assert s3["status"] == "fail", s3
    assert "attribute mismatches: 2 (fill of 'pdf:p1:z" in s3["detail"], s3
    assert s3["detail"].count(": colour #FF0000 vs #0000FF") == 2, s3
    assert "unmatched" not in s3["detail"], s3


@CHAIN_ORDERS
def test_s3_gradient_tolerance_chain_is_matched_in_any_slide_order(tmp_path, slide_shifts):
    """M1-R52 in the gradient / pattern matching: the chain of shadings is matched by the gradFills either way."""
    pdf_scene = [gradient(_right(GRAD_BOX, dx)) for dx in CHAIN_PDF]
    slide_scene = [gradient(_right(GRAD_BOX, dx)) for dx in slide_shifts]
    s3 = run_checks(tmp_path, pdf_scene, slide_scene)["S3"]
    assert s3["status"] == "pass", s3


@pytest.mark.parametrize("slide_alphas", [(0.508, 0.494), (0.494, 0.508)], ids=["exact first", "exact last"])
def test_s3_preset_alpha_chain_is_matched_in_any_slide_order(tmp_path, slide_alphas):
    """M1-R52, step 2 (M1-R47): an alpha chain among presets matched by colour, alpha and width. Red ellipses at
    alpha 0.500 and 0.508; the slide's at 0.508 (0.008 off the first) and 0.494 (0.006 off the first, 0.014 off the
    second, beyond 1 %). Only the first drawing takes the 0.494 ellipse; a maximum matching pairs both: n/a."""
    doc = pymupdf.open()
    page = doc.new_page(width=W_PT, height=H_PT)
    page.draw_rect(page.rect, color=None, fill=(1, 1, 1), width=0)
    boxes = (ROT_BOX, _right(ROT_BOX, 250))
    for box, alpha in zip(boxes, (0.5, 0.508)):
        page.draw_oval(pymupdf.Rect(box), color=None, fill=(1, 0, 0), width=0, fill_opacity=alpha)
    doc.save(str(tmp_path / "in.pdf"))
    doc.close()
    ellipses = [_sp(f"ellipse {k}", box[0], box[1], box[2] - box[0], box[3] - box[1],
                    '<a:prstGeom prst="ellipse"><a:avLst/></a:prstGeom>', _solid("FF0000", alpha), NO_LINE, sp_id=k)
                for k, (box, alpha) in enumerate(zip(boxes, slide_alphas), start=10)]
    slide = pptx_facts.slide_facts(_deck(tmp_path / "out.pptx", *ellipses), 0)
    s3 = structural.check(pdf_facts.page_facts(tmp_path / "in.pdf", 0), slide)["S3"]
    assert s3["status"] == "n/a", s3
    assert s3["detail"].startswith("2 preset shapes outside the M1 geometry model (positions not checked)"), s3


def test_s3_matching_follows_augmenting_paths_of_two_hops():
    """M1-R52 (carried from Task 11): first-fit gives drawing 0 paint 0 and drawing 1 paint 1; drawing 2 fits only
    paint 0. A maximum matching moves drawing 1 to paint 2 and drawing 0 to paint 1 (two hops), so all three are
    matched; a search that only lets the holder of paint 0 move to a free paint leaves drawing 2 out."""
    fits = {0: {0, 1}, 1: {1, 2}, 2: {0}}
    drawings, paints = [0, 1, 2], [0, 1, 2]
    free = [0, 1, 2]
    left, pairs = structural._take(drawings, paints, free, lambda d, p: p in fits[d])
    assert left == [] and free == []
    assert sorted(pairs) == [(0, 1), (1, 2), (2, 0)]


@pytest.mark.parametrize("pdf_shifts,slide_shifts,left", [
    ((0.0, 0.3), (0.1,), "unmatched PDF drawings: 1 (fill [100.3, "),  # one paint for two drawings: the first keeps it
    ((0.2,), (0.0, 0.4), "unmatched slide paints: 1 (fill of 'pdf:p1:z2 fill'"),  # two paints: the first is taken
], ids=["two drawings, one paint", "one drawing, two paints"])
def test_s3_matching_ties_go_by_paint_order(tmp_path, pdf_shifts, slide_shifts, left):
    """M1-R52: where maximum matchings differ, paint order decides: the drawing painted first takes a paint two
    drawings can take, and a drawing takes the first of two paints it fits in z-order."""
    pdf_scene = [fill(_right(RED_BOX, dx), RED) for dx in pdf_shifts]
    slide_scene = [fill(_right(RED_BOX, dx), RED) for dx in slide_shifts]
    s3 = run_checks(tmp_path, pdf_scene, slide_scene)["S3"]
    assert s3["status"] == "fail", s3
    assert left in s3["detail"], s3


@pytest.mark.parametrize("pdf_paint,slide_paint", [("fill", "stroke"), ("stroke", "fill")])
def test_s3_paint_matches_a_drawing_of_its_own_kind_only(tmp_path, pdf_paint, slide_paint):
    """Steps 1 and 3 match by kind: an unfilled rect with a red 2 pt line does not stand for a red filled rect (a
    fill drawing compares no width, so step 1 would take it otherwise), and a red filled rect does not stand for a
    red 2 pt stroke, not even as an attribute mismatch (step 3)."""
    paints = {"fill": fill(RED_BOX, RED), "stroke": stroke(RED_BOX, RED, 2.0)}
    s3 = run_checks(tmp_path, [paints[pdf_paint]], [paints[slide_paint]])["S3"]
    assert s3["status"] == "fail", s3
    assert f"unmatched PDF drawings: 1 ({pdf_paint} " in s3["detail"], s3
    assert f"unmatched slide paints: 1 ({slide_paint} " in s3["detail"], s3
    assert "attribute mismatches" not in s3["detail"], s3


# ---- S3: a background shape is removed only after matching (M1-R53) -------------------------------------------------

FULL_PAGE = (0, 0, W_PT, H_PT)


@pytest.mark.parametrize("pdf_scene,slide_scene,status,removed", [
    # a white wash at 50 % over the white page: the slide's wash matches the PDF's wash and is not removed
    (base_scene() + [fill(FULL_PAGE, WHITE, 0.5)], base_scene() + [fill(FULL_PAGE, WHITE, 0.5)], "pass", False),
    # an opaque full-slide white shape painted over the white page, which the PDF paints too: matched, not removed
    ([fill(FULL_PAGE, WHITE)] + base_scene(), [fill(FULL_PAGE, WHITE)] + base_scene(), "pass", False),
    # the page background as a shape: no PDF drawing is left for it, so it is removed
    (base_scene(), [fill(FULL_PAGE, WHITE)] + base_scene(), "pass", True),
    # the same at 50 %: its alpha is not the background's, so it is an extra paint
    (base_scene(), [fill(FULL_PAGE, WHITE, 0.5)] + base_scene(), "fail", False),
    # two of them: at most one is the background
    (base_scene(), [fill(FULL_PAGE, WHITE), fill(FULL_PAGE, WHITE)] + base_scene(), "fail", True),
    # a full-slide outline in the background colour paints a stroke, not the background fill
    (base_scene(), [stroke(FULL_PAGE, WHITE, 2.0)] + base_scene(), "fail", False),
    # a white box that is not full-slide is never the background: its bbox must be the page's (carried from Task 11)
    (base_scene(), [fill((0, 0, W_PT - 1, H_PT), WHITE)] + base_scene(), "fail", False),
], ids=["white wash 50 %", "opaque duplicate", "background shape", "background shape at 50 %",
        "two background shapes", "background-coloured outline", "background-coloured box short of the slide"])
def test_s3_background_shape_is_removed_only_after_matching(tmp_path, pdf_scene, slide_scene, status, removed):
    """M1-R53 (amends M1-R39): the slide's paints are matched first; only then is at most one full-slide fill left
    over removed, and only if its colour and alpha are the subtracted background drawing's. A full-slide shape that
    matched a later PDF drawing (a wash, a duplicate) stays."""
    s3 = run_checks(tmp_path, pdf_scene, slide_scene)["S3"]
    assert s3["status"] == status, s3
    assert ("full-slide background shape removed" in s3["detail"]) == removed, s3


# ---- S4: the provenance page number counts from 1 (M1-R50) ----------------------------------------------------------


@pytest.mark.parametrize("number,status", [(1, "pass"), (0, "fail")])
def test_s4_provenance_page_number_is_one_based(tmp_path, number, status):
    """M1-R50: the page in pdf:p<page>:z<op> counts from 1, as the selection pane shows it: the first page (oracle
    index 0) is p1, never p0."""
    path = build_pptx(tmp_path / "out.pptx", base_scene())
    prs = Presentation(str(path))
    for shape in prs.slides[0].shapes:
        shape.name = shape.name.replace("pdf:p1:", f"pdf:p{number}:")
    prs.save(str(path))
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == status, s4


# ---- Task 11 fix round 1: S6 any nameID 1 (M3-R44), S3 paints that paint nothing (M3-R45), S2 invisible glyphs
# (M3-R46), S4 hotspot pages ---------------------------------------------------------------------------------------


KOREAN_FAMILY = "덱 산스"


def _korean_named(font_bytes, korean=KOREAN_FAMILY):
    """`font_bytes` with a Windows Korean (0x412) nameID 1 record besides its English one."""
    from fontTools.ttLib import TTFont

    font = TTFont(io.BytesIO(font_bytes))
    font["name"].setName(korean, 1, 3, 1, 0x412)
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


@pytest.mark.parametrize("ea, status", [(KOREAN_FAMILY, "pass"), ("Deck Sans", "pass"), ("DeckSans", "fail"),
                                        ("Other Sans", "fail")])
def test_s6_takes_the_korean_nameid_1_in_a_ea(tmp_path, monkeypatch, ea, status):
    """M3-R44 (spec section 7): a:ea may carry the font's Korean family name, as PowerPoint writes it; a typeface
    passes when it is any nameID 1 record of the PDF font that drew the character. A PostScript-style name and
    another family still fail."""
    real = make_font
    monkeypatch.setitem(globals(), "make_font", lambda *args, **kwargs: _korean_named(real(*args, **kwargs)))
    scene = [text((100, 300), "A가B", 24, (0, 0, 0))]
    pdf = build_pdf(tmp_path / "in.pdf", scene)
    page = pdf_facts.page_facts(pdf, 0)
    assert page.fonts[0]["family_name1"] == "Deck Sans"
    assert set(page.fonts[0]["family_names1"]) == {"Deck Sans", KOREAN_FAMILY}
    assert all(set(span["families"]) == {"Deck Sans", KOREAN_FAMILY} for span in page.spans)
    pptx = _set_run_typefaces(build_pptx(tmp_path / "out.pptx", scene), latin="Deck Sans", ea=ea, cs="Deck Sans")
    result = structural.check(page, pptx_facts.slide_facts(pptx, 0))
    assert result["S2"]["status"] == "pass", result["S2"]
    assert result["S6"]["status"] == status, result["S6"]
    if status == "fail":
        assert ea in result["S6"]["detail"]


def test_s6_any_nameid_1_of_the_font_that_drew_the_character_only():
    """M3-R44 on hand-made facts: each character's typeface may be any nameID 1 record of its own PDF font; the Korean
    name of another font on the page fails, and so does a PostScript-style name (M1-R40)."""
    names = {"Deck Sans": ["Deck Sans", KOREAN_FAMILY], "Other Sans": ["Other Sans", "다른 산스"]}
    spans = [("A가", "Deck Sans"), ("B나", "Other Sans")]
    good = _s6(spans, [("A가", "Deck Sans", KOREAN_FAMILY, "Deck Sans"), ("B나", "Other Sans", "다른 산스", "Other Sans")],
               names=names)
    assert good["status"] == "pass", good
    swapped = _s6(spans, [("A가", "Deck Sans", "다른 산스", "Deck Sans"), ("B나", "Other Sans", "다른 산스", "Other Sans")],
                  names=names)
    assert swapped["status"] == "fail" and "다른 산스" in swapped["detail"], swapped
    postscript = _s6(spans, [("A가", "Deck Sans", "DeckSans", "Deck Sans"),
                             ("B나", "Other Sans", "다른 산스", "Other Sans")], names=names)
    assert postscript["status"] == "fail" and "DeckSans" in postscript["detail"], postscript
    assert postscript["counts"]["wrong names"] == 1


def test_s6_latin_and_cs_take_the_english_family_only():
    """M3-R63 (spec section 7): any nameID 1 record of the font passes in a:ea only; a:latin and a:cs need its English
    (0x409) nameID 1, else its first one (`family`). Punctuation both scripts use passes on the English family in a:latin
    or on any of the font's names in a:ea. M3-R44 let a Korean family pass in a:latin for Latin text."""
    names = {"Deck Sans": ["Deck Sans", KOREAN_FAMILY]}
    latin = [("A", "Deck Sans")]
    assert _s6(latin, [("A", "Deck Sans", KOREAN_FAMILY, "Deck Sans")], names=names)["status"] == "pass"
    korean_latin = _s6(latin, [("A", KOREAN_FAMILY, KOREAN_FAMILY, "Deck Sans")], names=names)
    assert korean_latin["status"] == "fail" and KOREAN_FAMILY in korean_latin["detail"], korean_latin
    hebrew = [("שלום", "Deck Sans")]
    assert _s6(hebrew, [("שלום", "Deck Sans", KOREAN_FAMILY, "Deck Sans")], names=names)["status"] == "pass"
    assert _s6(hebrew, [("שלום", "Deck Sans", "Deck Sans", KOREAN_FAMILY)], names=names)["status"] == "fail"
    # a:ea takes either name
    for ea in ("Deck Sans", KOREAN_FAMILY):
        assert _s6([("가", "Deck Sans")], [("가", "Deck Sans", ea, "Deck Sans")], names=names)["status"] == "pass"
    # shared punctuation: the English family in a:latin, or any name in a:ea
    dot = [("•", "Deck Sans")]
    assert _s6(dot, [("•", "Deck Sans", "Other Sans", None)], names=names)["status"] == "pass"
    assert _s6(dot, [("•", "Other Sans", KOREAN_FAMILY, None)], names=names)["status"] == "pass"
    assert _s6(dot, [("•", KOREAN_FAMILY, "Other Sans", None)], names=names)["status"] == "fail"
    # a font with no English record: its first nameID 1 (here its only one) is its family, and passes in a:latin
    only_korean = {KOREAN_FAMILY: [KOREAN_FAMILY]}
    assert _s6([("A", KOREAN_FAMILY)], [("A", KOREAN_FAMILY, KOREAN_FAMILY, None)], names=only_korean)["status"] == "pass"
    # a PostScript-style name still fails (M1-R40)
    assert _s6(latin, [("A", "DeckSans", KOREAN_FAMILY, "Deck Sans")], names=names)["status"] == "fail"


def _pdf_with(path, scene, *paints):
    """build_pdf's page with `paints` drawn on top: (box, draw_rect keyword arguments)."""
    build_pdf(path, scene)
    doc = pymupdf.open(str(path))
    for box, kwargs in paints:
        doc[0].draw_rect(pymupdf.Rect(box), **kwargs)
    out = path.with_name(path.stem + "-painted.pdf")
    doc.save(str(out))
    doc.close()
    return out


FRAME = (24, 56, 936, 512)


@pytest.mark.parametrize("kwargs, slide_extra, subtracted", [
    ({"color": (0, 0, 0), "width": 0.14, "stroke_opacity": 0}, [], 1),  # a stroke of alpha 0, no fill
    ({"color": (0, 0, 0), "fill": (1, 0, 0), "width": 1, "stroke_opacity": 0, "fill_opacity": 0}, [], 2),  # both 0
    ({"color": None, "fill": (1, 0, 0), "width": 0, "fill_opacity": 0}, [], 1),  # a fill of alpha 0 alone (M3-R47)
    # a path's fill of alpha 0 under a stroke that paints: the fill goes, the stroke stays and is matched
    ({"color": (0, 0, 0), "fill": (1, 0, 0), "width": 1, "fill_opacity": 0}, [stroke(FRAME, (0, 0, 0), 1)], 1),
    # a path's stroke of alpha 0 on a fill that paints: the stroke goes, the fill stays and is matched
    ({"color": (0, 0, 0), "fill": (1, 0, 0), "width": 1, "stroke_opacity": 0}, [fill(FRAME, (255, 0, 0))], 1),
])
def test_s3_subtracts_every_pdf_paint_that_paints_nothing(tmp_path, kwargs, slide_extra, subtracted):
    """M3-R45 and M3-R47: every PDF paint (a path's fill, a path's stroke) of alpha 0 paints nothing and is subtracted
    as clip-only paths are; the slide need not have it (a chart's invisible frame), as the writer writes alpha 0 as
    a:noFill, which no slide paint counts. A paint of the same path that does paint stays and must be matched."""
    pdf = _pdf_with(tmp_path / "in.pdf", base_scene(), (FRAME, kwargs))
    pptx = build_pptx(tmp_path / "out.pptx", base_scene() + slide_extra)
    s3 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S3"]
    assert s3["status"] == "pass", s3
    assert f"painting nothing {subtracted}" in s3["detail"], s3
    assert s3["counts"]["invisible paints"] == subtracted


@pytest.mark.parametrize("kwargs, subtracted", [
    ({"color": (0, 0, 0), "width": 1, "stroke_opacity": 0.5}, 0),  # a translucent stroke paints
    ({"color": None, "fill": (1, 0, 0), "width": 0, "fill_opacity": 0.01}, 0),  # alpha 0.01 is not alpha 0
    ({"color": (0, 0, 0), "fill": (1, 0, 0), "width": 1, "fill_opacity": 0}, 1),  # the stroke paints, unmatched
])
def test_s3_still_counts_every_pdf_paint_that_paints(tmp_path, kwargs, subtracted):
    """Only paints of alpha 0 (exactly, as the writer's invisible pass tests it) are subtracted: a paint that paints
    stays a drawing the slide must have."""
    pdf = _pdf_with(tmp_path / "in.pdf", base_scene(), (FRAME, kwargs))
    pptx = build_pptx(tmp_path / "out.pptx", base_scene())
    s3 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S3"]
    assert s3["status"] == "fail", s3
    assert f"painting nothing {subtracted}" in s3["detail"], s3


def _set_run_fills(path, fill_xml):
    """Replace the fill of every run of the deck at `path` with `fill_xml` (an a:noFill or a:solidFill element)."""
    prs = Presentation(str(path))
    for shape in prs.slides[0].shapes:
        if not shape.has_text_frame:
            continue
        for paragraph in shape.text_frame.paragraphs:
            for run in paragraph.runs:
                rpr = run.font._rPr
                old = rpr.find(qn("a:solidFill"))
                new = _xml(fill_xml)
                if old is not None:
                    old.addprevious(new)
                    rpr.remove(old)
                else:
                    rpr.insert(0, new)
    prs.save(str(path))
    return path


NO_FILL = "<a:noFill/>"
INVISIBLE_RED = '<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="0"/></a:srgbClr></a:solidFill>'
OPAQUE_RED = '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>'


@pytest.mark.parametrize("pdf_alpha, fill_xml, status, problem", [
    (0.0, NO_FILL, "pass", None),  # invisible both ways: noFill matches a glyph of alpha 0
    (0.0, INVISIBLE_RED, "pass", None),  # the colour of an invisible glyph is not compared, its alpha is
    (0.0, OPAQUE_RED, "fail", "alpha differs"),
    (1.0, NO_FILL, "fail", "unresolved colour"),  # a visible glyph needs its colour
    (1.0, INVISIBLE_RED, "fail", "colour differs"),
])
def test_s2_matches_an_invisible_glyph_with_a_nofill_run(tmp_path, pdf_alpha, fill_xml, status, problem):
    """M3-R46: S2 counts a PDF glyph of alpha 0 as matching a run written noFill (WordArt's editable text over its
    outlines, spec section 6); colour is compared only where the glyph is visible."""
    scene = [{**text((100, 300), "Hello World", 24, (51, 102, 153)), "alpha": pdf_alpha}]
    pdf = build_pdf(tmp_path / "in.pdf", scene)
    pptx = _set_run_fills(build_pptx(tmp_path / "out.pptx", scene), fill_xml)
    s2 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(pptx, 0))["S2"]
    assert s2["status"] == status, s2
    if problem:
        assert problem in s2["detail"], s2


def test_s4_checks_the_page_of_a_hotspot_name(tmp_path):
    """A hotspot names its page as a paint does (M3-R18 with M1-R50): pdf:p2:a0 link on page 1 is another page's."""
    path = _with_hotspots(build_pptx(tmp_path / "out.pptx", base_scene()), ["pdf:p2:a0 link"])
    pdf = build_pdf(tmp_path / "in.pdf", base_scene())
    s4 = structural.check(pdf_facts.page_facts(pdf, 0), pptx_facts.slide_facts(path, 0))["S4"]
    assert s4["status"] == "fail" and "names page 2" in s4["detail"], s4
    assert s4["counts"]["other page shapes"] == 1 and s4["counts"]["links"] == 1, s4
    alone = _with_hotspots(build_pptx(tmp_path / "alone.pptx", []), ["pdf:p2:a0 link"])
    s4 = structural.check(pdf_facts.page_facts(build_pdf(tmp_path / "empty.pdf", []), 0),
                          pptx_facts.slide_facts(alone, 0))["S4"]
    assert s4["status"] == "fail" and s4["counts"]["other page shapes"] == 1, s4


# ---- S7 with PowerPoint ---------------------------------------------------------------------------------------------


@pytest.mark.powerpoint
def test_s7_probe_round_trip_passes():
    """PowerPoint opens the committed probe deck (a temp copy, read-only) and exports it again; the inventory of
    that PDF equals the committed probe_std.pdf."""
    result = roundtrip.s7(PROBE_PPTX, PROBE_PDF)
    assert result["status"] == "pass", result
    assert "bbox proxy for Hausdorff (M1)" in result["detail"]


def test_slide_facts_open_a_deck_once_and_again_when_its_bytes_change(tmp_path, monkeypatch):
    """M8 Task 2: the run asks for every slide of a deck in turn; the parsed deck is reused while the file has the same
    bytes (a 914-slide deck was parsed 914 times), and read again when it changes."""
    opened = []
    real = pptx_facts.Presentation
    monkeypatch.setattr(pptx_facts, "Presentation", lambda source: opened.append(1) or real(source))
    path = tmp_path / "deck.pptx"
    prs = Presentation()
    for _ in range(3):
        prs.slides.add_slide(prs.slide_layouts[6])
    prs.save(str(path))
    pptx_facts._LAST_DECK.clear()
    for index in range(3):
        pptx_facts.slide_facts(path, index)
    assert len(opened) == 1
    prs.slides.add_slide(prs.slide_layouts[6])
    prs.save(str(path))  # same path, new bytes
    assert pptx_facts.slide_facts(path, 3) is not None and len(opened) == 2
    with pytest.raises(pptx_facts.FactsError):
        pptx_facts.slide_facts(path, 4)
    assert len(pptx_facts._LAST_DECK) == 1
