"""Tests for the second half of the atlas (Task 6b): text, WordArt, tables, charts, pictures, backgrounds, hidden
slides, the `probe` and `sizes` recipes, and the font rules for every --fonts ofl deck.

The decks are re-opened with python-pptx; section membership comes from the manifest, which
`test_build.py::test_every_slide_has_label_matching_manifest` ties to the on-slide labels.
"""

import io
import json
import re
import zipfile
from collections import Counter

import pytest
from lxml import etree
from PIL import Image
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.util import Pt

from harness.atlas import decks
from harness.atlas.conftest import feature_problems
from harness.atlas.deck import ROLES
from harness.atlas.drawingml import PRST_TX_WARP
from harness.atlas.sections.fonts import CFF_FAMILY
from harness.atlas.test_build import LOCK, LOCK_FAMILIES, NOT_DRAWN, OFL_FACES, THEME_REF, _installed_cmaps

MINIMA = {"text": 40, "wordart": 7, "tables": 6, "charts": 12, "pictures": 10, "backgrounds": 8}
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
P_NS = "http://schemas.openxmlformats.org/presentationml/2006/main"
HANGUL = re.compile(r"[가-힣]")
NS = {"a": A_NS, "c": C_NS, "p": P_NS, "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
EXCLUDED_REASON = "not authorable with python-pptx/DrawingML in M1 — add via COM authoring later"
SIZES = {"sizes-43": (720, 540), "sizes-a4l": (842, 595), "sizes-a4p": (595, 842), "sizes-custom": (1000, 1000)}


@pytest.fixture(scope="module")
def atlas(atlas_ofl):
    """(prs, manifest, {section: [(slide, entry), ...]})"""
    pptx_path, manifest = atlas_ofl
    prs = Presentation(str(pptx_path))
    sections = {}
    for slide, entry in zip(prs.slides, manifest["slides"], strict=True):
        sections.setdefault(entry["section"], []).append((slide, entry))
    return prs, manifest, sections


def xp(element, expr):
    """XPath on any element (python-pptx's own elements and plain lxml ones alike)."""
    return etree.XPath(expr, namespaces=NS)(element)


def found(slides, xpath):
    out = []
    for slide, _ in slides:
        out.extend(slide._element.xpath(xpath))
    return out


def chart_spaces(slide):
    """chartSpace elements of the charts drawn on the slide."""
    return [slide.part.related_part(rid)._element
            for rid in xp(slide._element, ".//p:graphicFrame/a:graphic/a:graphicData/c:chart/@r:id")]


def jpeg_sof_components(blob):
    """Number of components in the first SOF segment of a JPEG (3 = YCbCr/RGB, 4 = CMYK/YCCK)."""
    assert blob[:2] == b"\xff\xd8", "not a JPEG"
    i = 2
    while i + 4 <= len(blob):
        assert blob[i] == 0xFF, f"bad marker at {i}"
        marker = blob[i + 1]
        if marker == 0xFF:
            i += 1
            continue
        length = int.from_bytes(blob[i + 2:i + 4], "big")
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            return blob[i + 9]  # FF Cn, length (2), precision (1), height (2), width (2), components (1)
        i += 2 + length
    raise AssertionError("no SOF segment")


def picture_blobs(slides):
    for slide, _ in slides:
        for blip in xp(slide._element, ".//p:pic/p:blipFill/a:blip"):
            yield blip, slide.part.related_part(blip.get(qn("r:embed"))).blob


# --- counts, smoke and hidden slides --------------------------------------------------------------------------------


def test_sections_b_minima_and_two_hidden_slides(atlas):
    _, manifest, sections = atlas
    counts = Counter(entry["section"] for entry in manifest["slides"])
    for section, minimum in MINIMA.items():
        assert counts[section] >= minimum, f"{section}: {counts[section]} slides < {minimum}"
    hidden = [entry for entry in manifest["slides"] if entry["hidden"]]
    assert len(hidden) == 2
    assert {entry["section"] for entry in hidden} == {"hidden"}
    for slide, entry in sections["hidden"]:
        assert slide._element.get("show") == "0" and entry["hidden"] and not entry["smoke"]


def test_atlas_has_150_visible_slides_and_30_smoke_slides_in_every_section(atlas):
    prs, manifest, sections = atlas
    visible = [entry for entry in manifest["slides"] if not entry["hidden"]]
    assert len(visible) >= 150
    smoke = [entry for entry in manifest["slides"] if entry["smoke"]]
    assert len(smoke) >= 30
    assert not any(entry["hidden"] for entry in smoke)
    for section, members in sections.items():
        if section != "hidden":
            assert any(entry["smoke"] for _, entry in members), f"{section} has no smoke slide"
    assert len(prs.slides) == len(manifest["slides"])


def test_excluded_lists_the_unauthorable_features():
    expected = {"svgIcon", "smartArt", "artisticEffects", "3dModel"}
    ofl = decks.atlas("ofl")[0].excluded
    windows = decks.atlas("windows")[0].excluded
    assert {feature for feature, _ in ofl} == expected | {"emoji"}
    assert {feature for feature, _ in windows} == expected  # the windows build draws emoji (Segoe UI Emoji)
    for feature, reason in ofl + windows:
        if feature != "emoji":
            assert reason == EXCLUDED_REASON, feature
    # emoji are authorable (the windows build has them); the OFL build leaves them out for want of an OFL emoji font
    (emoji,) = [reason for feature, reason in ofl if feature == "emoji"]
    assert "not authorable" not in emoji
    assert "emoji font" in emoji and "fonts.lock.json" in emoji and "--fonts windows" in emoji


def test_atlas_manifest_carries_the_exclusions(atlas):
    _, manifest, _ = atlas
    reasons = {item["feature"]: item["reason"] for item in manifest["excluded"]}
    assert set(reasons) == {"svgIcon", "smartArt", "artisticEffects", "3dModel", "emoji"}
    assert reasons == dict(decks.atlas("ofl")[0].excluded)


# --- fonts: the OpenType-CFF bitmap sample (Task 7b) ----------------------------------------------------------------


def cff_families():
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    return {fam["family"] for fam in lock["families"] if all(f["format"] == "otf-cff" for f in fam["files"])}


def run_faces(slide):
    """Typefaces of the slide's runs (framework text included)."""
    return set(xp(slide._element, ".//a:r/a:rPr/a:latin/@typeface"))


def test_fonts_section_is_one_known_bitmap_slide_in_the_locked_cff_font(atlas):
    _, manifest, sections = atlas
    assert cff_families() == {CFF_FAMILY}
    ((slide, entry),) = sections["fonts"]
    assert entry["id"] == "atlas/fonts/01"
    assert entry["knownBitmapText"] is True and entry["smoke"] and not entry["hidden"]
    assert {"font:cff", f"typeface:{CFF_FAMILY}"} <= set(entry["features"])
    content = xp(slide._element, ".//p:sp[not(p:nvSpPr/p:cNvPr[@name='Atlas Label' or @name='Atlas Title' or "
                                 "starts-with(@name, 'Caption ')])]//a:r")
    assert content and {xp(r, "./a:rPr/a:latin/@typeface")[0] for r in content} == {CFF_FAMILY}
    text = "".join(xp(slide._element, f".//p:sp[.//a:latin/@typeface='{CFF_FAMILY}']//a:t/text()"))
    assert text and all(" " <= ch <= "~" for ch in text), "Latin (ASCII) text only"
    for run in content:  # every run still names latin, ea and cs
        assert [xp(run, f"./a:rPr/a:{tag}/@typeface") for tag in ("latin", "ea", "cs")] == [[CFF_FAMILY]] * 3


def test_known_bitmap_text_is_declared_exactly_where_a_cff_font_is_used(atlas, probe_ofl, sizes_ofl):
    # Later text-based checks skip knownBitmapText slides; every other slide must carry real (embeddable) text, so
    # the CFF family appears nowhere else, in no deck.
    prs, manifest, _ = atlas
    for slide, entry in zip(prs.slides, manifest["slides"], strict=True):
        uses_cff = bool(run_faces(slide) & cff_families())
        assert entry["knownBitmapText"] == uses_cff == ("font:cff" in entry["features"]), entry["id"]
    for pptx_path, other in [probe_ofl, *sizes_ofl.values()]:
        assert not any(entry["knownBitmapText"] for entry in other["slides"])
        with zipfile.ZipFile(pptx_path) as zf:
            xml = b"".join(zf.read(n) for n in zf.namelist() if n.endswith(".xml"))
        assert not any(f'typeface="{family}"'.encode() in xml for family in cff_families()), pptx_path.name


def test_windows_atlas_has_the_same_fonts_slide(tmp_path):
    from harness.atlas.conftest import run_build

    pptx_path, manifest = run_build(tmp_path, "atlas", "windows")
    (entry,) = [e for e in manifest["slides"] if e["section"] == "fonts"]
    assert entry["id"] == "atlas/fonts/01" and entry["knownBitmapText"]
    slide = Presentation(str(pptx_path)).slides[entry["n"] - 1]
    assert CFF_FAMILY in run_faces(slide)  # Windows ships no CFF font, so the windows build uses the same one


# --- text -----------------------------------------------------------------------------------------------------------


def test_text_section_covers_roles_sizes_and_run_properties(atlas):
    _, _, sections = atlas
    text = sections["text"]
    for role in ("HEAD", "BODY", "SERIF", "ALT"):
        family = ROLES["ofl"][role].family
        for size in (8, 12, 18, 24, 36, 54):
            assert found(text, f".//a:r/a:rPr[@sz='{size * 100}'][a:latin/@typeface='{family}']"), (role, size)
    for xpath in (".//a:r/a:rPr[@b='1']", ".//a:r/a:rPr[@i='1']", ".//a:r/a:rPr[@u='sng']",
                  ".//a:r/a:rPr[@strike='sngStrike']", ".//a:r/a:rPr[number(@baseline) > 0]",
                  ".//a:r/a:rPr[number(@baseline) < 0]", ".//a:r/a:rPr/a:highlight",
                  ".//a:r/a:rPr/a:solidFill", ".//a:r/a:rPr/a:gradFill",
                  ".//a:r/a:rPr[a:noFill][a:ln[not(a:noFill)]]"):
        assert found(text, xpath), xpath
    assert {"-100", "0", "300", "600"} <= set(found(text, ".//a:r/a:rPr/@spc"))


def test_text_section_hyperlinks_are_external_relationships(atlas):
    _, _, sections = atlas
    targets = []
    for slide, _ in sections["text"]:
        for rid in slide._element.xpath(".//a:r/a:rPr/a:hlinkClick/@r:id"):
            rel = slide.part.rels[rid]
            assert rel.reltype == RT.HYPERLINK and rel.is_external
            targets.append(rel.target_ref)
    assert targets and all(t.startswith("https://example.com/") for t in targets)


def test_text_section_covers_paragraph_and_body_properties(atlas):
    _, _, sections = atlas
    text = sections["text"]
    assert {"l", "ctr", "r", "just"} <= set(found(text, ".//a:pPr/@algn"))
    for vert in ("eaVert", "vert270"):
        bodies = [b for b in found(text, f".//p:txBody[a:bodyPr/@vert='{vert}']")
                  if HANGUL.search("".join(xp(b, ".//a:t/text()")))]
        assert bodies, f"{vert} with Korean text"
    rotations = {int(v) for v in found(text, ".//p:sp[p:txBody]/p:spPr/a:xfrm/@rot | .//a:bodyPr/@rot")}
    assert {a * 60000 for a in (15, 30, 45, 90, 135, 270)} <= rotations
    assert found(text, ".//a:bodyPr/a:normAutofit[@fontScale='70000']")
    assert found(text, ".//a:bodyPr[@numCol='2']")
    assert found(text, ".//a:pPr/a:buChar") and found(text, ".//a:pPr/a:buAutoNum")
    assert {"0", "1", "2", "3", "4"} <= set(found(text, ".//a:pPr/@lvl"))


# --- WordArt --------------------------------------------------------------------------------------------------------


def test_every_prsttxwarp_preset_occurs_six_per_slide(atlas):
    _, _, sections = atlas
    assert len(PRST_TX_WARP) == len(set(PRST_TX_WARP)) == 41  # ECMA-376 ST_TextShapeType
    seen = []
    for slide, _ in sections["wordart"]:
        presets = xp(slide._element, ".//a:bodyPr/a:prstTxWarp/@prst")
        assert 1 <= len(presets) <= 6
        seen += presets
    assert set(seen) == set(PRST_TX_WARP)


# --- tables ---------------------------------------------------------------------------------------------------------


def test_tables_section_merges_borders_fills_and_fonts(atlas):
    _, _, sections = atlas
    tables = sections["tables"]
    for xpath in (".//a:tc[@gridSpan > 1]", ".//a:tc[@rowSpan > 1]", ".//a:tc[@hMerge='1']", ".//a:tc[@vMerge='1']",
                  ".//a:tcPr/a:solidFill", ".//a:tcPr/a:gradFill", ".//a:tcPr/a:pattFill"):
        assert found(tables, xpath), xpath
    # one cell whose four sides all have a line, each side different
    sides = []
    for tcpr in found(tables, ".//a:tcPr[a:lnL and a:lnR and a:lnT and a:lnB]"):
        lines = [etree.tostring(tcpr.find(f"{{{A_NS}}}ln{s}")).replace(f"ln{s}".encode(), b"ln") for s in "LRTB"]
        sides.append(len(set(lines)))
    assert 4 in sides, "a cell with four different borders"
    mixed = [tbl for tbl in found(tables, ".//a:tbl")
             if len(set(xp(tbl, ".//a:r/a:rPr/a:latin/@typeface"))) >= 3]
    assert mixed, "a table with three or more fonts"


# --- charts ---------------------------------------------------------------------------------------------------------


def test_chart_parts_types_and_korean_labels(atlas):
    _, _, sections = atlas
    spaces = [cs for slide, _ in sections["charts"] for cs in chart_spaces(slide)]
    assert len(spaces) >= 12
    kinds = set()
    for cs in spaces:
        for plot in xp(cs, "./c:chart/c:plotArea/*[c:ser]"):
            name = etree.QName(plot).localname
            if name == "barChart":
                name += ":" + xp(plot, "./c:barDir/@val")[0] + ":" + xp(plot, "./c:grouping/@val")[0]
            if name == "lineChart" and xp(plot, "./c:marker[@val='1']"):
                name += ":markers"
            kinds.add(name)
        assert xp(cs, "./c:txPr/a:p/a:pPr/a:defRPr[a:latin and a:ea and a:cs]"), "chart-wide fonts"
        texts = "".join(xp(cs, ".//c:strCache/c:pt/c:v/text()"))
        assert HANGUL.search(texts), "Korean labels"
        if xp(cs, ".//c:cat"):
            assert HANGUL.search("".join(xp(cs, ".//c:cat//c:pt/c:v/text()"))), "Korean category labels"
    for kind in ("barChart:col:clustered", "barChart:col:stacked", "barChart:col:percentStacked",
                 "barChart:bar:clustered", "lineChart:markers", "pieChart", "doughnutChart", "areaChart",
                 "scatterChart", "radarChart", "bubbleChart"):
        assert kind in kinds, kind


def test_chart_xml_keeps_to_the_schema_where_python_pptx_does_not(atlas, probe_ofl):
    # python-pptx's chart templates carry negative axis ids (ECMA-376: xs:unsignedInt) and a c:smooth in radar series
    # (CT_RadarSer has none); the atlas rewrites both so every chart part validates against the schema.
    _, _, sections = atlas
    spaces = [cs for slide, _ in sections["charts"] for cs in chart_spaces(slide)]
    spaces += chart_spaces(Presentation(str(probe_ofl[0])).slides[2])
    for cs in spaces:
        ids = [int(v) for v in xp(cs, ".//c:axId/@val | .//c:crossAx/@val")]
        assert all(0 <= v < 2 ** 31 for v in ids), ids
        declared = set(xp(cs, "./c:chart/c:plotArea/*[c:axPos]/c:axId/@val"))
        used = set(xp(cs, ".//c:crossAx/@val")) | set(xp(cs, "./c:chart/c:plotArea/*[c:ser]/c:axId/@val"))
        assert used <= declared, "axis references still resolve"
        assert not xp(cs, ".//c:radarChart/c:ser/c:smooth")


def test_chart_part_count_in_the_package(atlas_ofl):
    pptx_path, _ = atlas_ofl
    with zipfile.ZipFile(pptx_path) as zf:
        charts = [n for n in zf.namelist() if re.fullmatch(r"ppt/charts/chart\d+\.xml", n)]
    assert len(charts) >= 12


# --- pictures -------------------------------------------------------------------------------------------------------


def test_a_cmyk_jpeg_is_embedded(atlas_ofl):
    pptx_path, _ = atlas_ofl
    components = []
    with zipfile.ZipFile(pptx_path) as zf:
        for name in zf.namelist():
            data = zf.read(name)
            if name.startswith("ppt/media/") and data[:2] == b"\xff\xd8":
                components.append(jpeg_sof_components(data))
                if components[-1] == 4:
                    assert Image.open(io.BytesIO(data)).mode == "CMYK"
    assert 4 in components, "a CMYK JPEG"
    assert 3 in components, "an RGB (YCbCr) JPEG"


def test_pictures_section_covers_the_brief(atlas):
    _, _, sections = atlas
    pictures = sections["pictures"]
    for xpath in (".//p:pic/p:blipFill/a:srcRect", f".//p:pic/p:spPr/a:xfrm[@rot='{15 * 60000}']",
                  ".//p:pic/p:spPr/a:xfrm[@flipH='1']", ".//p:pic/p:spPr/a:xfrm[@flipV='1']",
                  ".//p:pic/p:blipFill/a:blip/a:grayscl", ".//p:pic/p:blipFill/a:blip/a:duotone",
                  ".//p:pic/p:spPr[a:ln[not(a:noFill)]][a:effectLst/a:outerShdw]",
                  ".//p:pic/p:spPr/a:prstGeom[@prst='roundRect']"):
        assert found(pictures, xpath), xpath
    kinds = set()
    for _, blob in picture_blobs(pictures):
        image = Image.open(io.BytesIO(blob))
        kinds.add((image.format, image.mode))
    assert {("PNG", "RGB"), ("PNG", "RGBA"), ("JPEG", "RGB"), ("JPEG", "CMYK")} <= kinds


# --- backgrounds ----------------------------------------------------------------------------------------------------


def test_backgrounds_section_covers_fills_master_shapes_and_footers(atlas):
    prs, _, sections = atlas
    backgrounds = sections["backgrounds"]
    for xpath in ("./p:cSld/p:bg/p:bgPr/a:solidFill", "./p:cSld/p:bg/p:bgPr/a:gradFill",
                  "./p:cSld/p:bg/p:bgPr/a:blipFill", ".//p:sp/p:nvSpPr/p:nvPr/p:ph[@type='ftr']",
                  ".//p:sp/p:nvSpPr/p:nvPr/p:ph[@type='sldNum']", ".//p:sp/p:nvSpPr/p:nvPr/p:ph[@type='dt']",
                  ".//a:fld[@type='slidenum']"):
        assert found(backgrounds, xpath), xpath
    master = prs.slide_master._element
    assert xp(master, "./p:cSld/p:spTree/p:sp[not(p:nvSpPr/p:nvPr/p:ph)]"), "a master shape"

    def shows_master(slide):
        return slide._element.get("showMasterSp") != "0" and slide.slide_layout._element.get("showMasterSp") != "0"

    showing = {slide.slide_id for slide, _ in backgrounds if shows_master(slide)}
    assert showing, "a slide that shows the master shapes"
    # every other slide of the atlas hides them (its layout does), so the master shapes appear only where declared
    assert {slide.slide_id for slide in prs.slides if shows_master(slide)} == showing


# --- probe and sizes ------------------------------------------------------------------------------------------------


def test_probe_recreates_the_m0_probe_deck(probe_ofl):
    pptx_path, manifest = probe_ofl
    prs = Presentation(str(pptx_path))
    assert manifest["deck"] == "probe" and manifest["slideSize"] == [960, 540]
    assert len(prs.slides) == len(manifest["slides"]) == 3
    s1, s2, _ = (slide._element for slide in prs.slides)
    assert set(xp(s1, ".//p:sp/p:spPr/a:prstGeom/@prst")) >= {"rect", "roundRect", "ellipse", "rightArrow",
                                                              "chevron"}
    assert xp(s1, ".//p:cxnSp[p:spPr/a:ln/a:tailEnd/@type='triangle']")
    assert xp(s1, ".//p:cxnSp/p:spPr/a:ln/a:prstDash[@val='dash']")
    assert len(xp(s1, ".//a:p[a:pPr/a:buChar]")) == 4
    assert xp(s2, ".//p:sp/p:spPr/a:gradFill") and xp(s2, ".//p:sp/p:spPr/a:solidFill/*/a:alpha")
    assert len(xp(s2, ".//a:tbl/a:tr")) == 3 and len(xp(s2, ".//a:tbl/a:tblGrid/a:gridCol")) == 3
    assert xp(s2, ".//p:pic") and len(xp(s2, ".//p:grpSp/p:sp")) == 3
    with zipfile.ZipFile(pptx_path) as zf:
        assert any(re.fullmatch(r"ppt/charts/chart\d+\.xml", n) for n in zf.namelist()), "a chart part"
    (cs,) = chart_spaces(prs.slides[2])
    assert xp(cs, "./c:chart/c:plotArea/c:barChart[c:barDir/@val='col'][c:grouping/@val='clustered']")
    assert HANGUL.search("".join(xp(cs, ".//c:cat//c:pt/c:v/text()")))
    assert len(xp(cs, ".//c:ser")) == 2


def test_probe_follows_the_m0_original_where_fonts_allow(probe_ofl):
    # Facts of the M0 probe's original.pptx (PowerPoint COM build, Office 2023 theme), kept by the re-creation.
    pptx_path, _ = probe_ofl
    prs = Presentation(str(pptx_path))
    with zipfile.ZipFile(pptx_path) as zf:
        theme = etree.fromstring(zf.read("ppt/theme/theme1.xml"))
    scheme = {etree.QName(c).localname: (c[0].get("val"), c[0].get("lastClr"))
              for c in xp(theme, ".//a:clrScheme/*")}
    assert scheme["accent1"][0] == "156082" and scheme["accent2"][0] == "E97132" and scheme["dk2"][0] == "0E2841"
    s1, s2, _ = (slide._element for slide in prs.slides)
    bullets = xp(s1, ".//a:pPr[a:buChar]")
    assert len(bullets) == 4
    assert {(p.get("marL"), p.get("indent")) for p in bullets} == {("457200", "-457200")}
    assert set(xp(s1, ".//a:pPr/a:buFont/@typeface")) == {ROLES["ofl"]["HEAD"].family}  # M0: +mj-lt (theme major)
    # the group's outline is the shape style's: accent1 shade 15 %, the theme's second line width (1.5 pt)
    for line in xp(s2, ".//p:grpSp/p:sp/p:spPr/a:ln"):
        assert line.get("w") == "19050"
        assert xp(line, "./a:solidFill/a:schemeClr[@val='accent1']/a:shade/@val") == ["15000"]
    # table text: only size and font; header bold and white come from the table style
    assert not xp(s2, ".//a:tbl//a:r/a:rPr[a:solidFill or @b]")
    assert set(xp(s2, ".//a:tbl//a:r/a:rPr/@sz")) == {"1600"}
    assert xp(s2, ".//p:sp/p:spPr/a:gradFill/a:lin[@ang='5400000'][@scaled='1']")
    (cs,) = chart_spaces(prs.slides[2])
    assert not xp(cs, ".//c:gapWidth[@val != '150'] | .//c:overlap[@val != '0']")  # M0 keeps the defaults
    (legend,) = xp(cs, "./c:chart/c:legend")
    assert len(legend) == 0, "a bare <c:legend/>"
    assert xp(cs, "./c:chart/c:autoTitleDeleted/@val") == ["0"]
    assert not xp(cs, ".//c:ser/c:spPr"), "series colours come from the theme"
    assert xp(cs, "./c:txPr/a:p/a:pPr/a:defRPr/@sz") == ["1800"]


def test_probe_and_sizes_declare_only_features_on_their_slides(probe_ofl, sizes_ofl):
    problems = []
    for pptx_path, manifest in [probe_ofl, *sizes_ofl.values()]:
        problems += feature_problems(Presentation(str(pptx_path)), manifest)
    assert not problems, "\n".join(problems)


def test_sizes_decks_have_their_slide_size(sizes_ofl):
    assert set(sizes_ofl) == set(SIZES)
    for name, (pptx_path, manifest) in sizes_ofl.items():
        width, height = SIZES[name]
        assert manifest["deck"] == name and manifest["slideSize"] == [width, height]
        assert len(manifest["slides"]) == 4
        with zipfile.ZipFile(pptx_path) as zf:
            presentation = etree.fromstring(zf.read("ppt/presentation.xml"))
            app = etree.fromstring(zf.read("docProps/app.xml"))
        sld_sz = presentation.find(f"{{{P_NS}}}sldSz")
        assert (int(sld_sz.get("cx")), int(sld_sz.get("cy"))) == (Pt(width), Pt(height))
        # PowerPoint's own A4 preset is 780x540 pt (type="A4"); true A4 at 842x595 pt is a custom size for it
        assert sld_sz.get("type") == ("screen4x3" if (width, height) == (720, 540) else None)
        formats = {etree.QName(e).localname: e.text for e in app}
        assert formats["PresentationFormat"] == ("On-screen Show (4:3)" if name == "sizes-43" else "Custom")
        prs = Presentation(str(pptx_path))
        for slide in prs.slides:  # nothing is drawn outside the slide
            for shape in slide.shapes:
                assert shape.left >= 0 and shape.top >= 0, (name, shape.name)
                assert shape.left + shape.width <= Pt(width) and shape.top + shape.height <= Pt(height), (
                    name, shape.name)


# --- fonts in every --fonts ofl deck ----------------------------------------------------------------------------------


def all_ofl_decks(atlas_ofl, probe_ofl, sizes_ofl):
    return [atlas_ofl, probe_ofl, *sizes_ofl.values()]


def test_every_ofl_deck_names_only_lock_families(atlas_ofl, probe_ofl, sizes_ofl):
    checked_charts = 0
    for pptx_path, _ in all_ofl_decks(atlas_ofl, probe_ofl, sizes_ofl):
        with zipfile.ZipFile(pptx_path) as zf:
            parts = {n: zf.read(n) for n in zf.namelist() if n.endswith(".xml")}
        for name, xml in parts.items():
            root = etree.fromstring(xml)
            for face in root.iter(f"{{{A_NS}}}latin", f"{{{A_NS}}}ea", f"{{{A_NS}}}cs", f"{{{A_NS}}}buFont",
                                  f"{{{A_NS}}}sym"):
                typeface = face.get("typeface")
                assert typeface in LOCK_FAMILIES or THEME_REF.match(typeface), f"{pptx_path.name} {name}: {typeface}"
            for typeface in re.findall(rb'typeface="([^"]*)"', xml):
                typeface = typeface.decode("utf-8")
                assert typeface in LOCK_FAMILIES or THEME_REF.match(typeface), f"{pptx_path.name} {name}: {typeface}"
            if re.match(r"ppt/(slides/slide|charts/chart)\d+\.xml$", name):
                checked_charts += name.startswith("ppt/charts/")
                for rpr in root.iter(f"{{{A_NS}}}rPr", f"{{{A_NS}}}endParaRPr", f"{{{A_NS}}}defRPr"):
                    faces = [rpr.find(f"{{{A_NS}}}{tag}") for tag in ("latin", "ea", "cs")]
                    assert all(f is not None for f in faces), f"{pptx_path.name} {name}: a run without latin/ea/cs"
                    assert len({f.get("typeface") for f in faces}) == 1, f"{name}: latin/ea/cs differ"
    assert checked_charts >= 13  # the atlas charts and the probe chart


def test_embedded_chart_workbooks_name_only_lock_families(atlas_ofl, probe_ofl, sizes_ofl):
    # python-pptx embeds each chart's data as an .xlsx (XlsxWriter) whose styles and theme name Calibri, Cambria and
    # per-script fonts; never drawn, but a committed deck may name only lock-file fonts
    workbooks = 0
    for pptx_path, _ in all_ofl_decks(atlas_ofl, probe_ofl, sizes_ofl):
        with zipfile.ZipFile(pptx_path) as outer:
            for name in [n for n in outer.namelist() if n.endswith(".xlsx")]:
                workbooks += 1
                with zipfile.ZipFile(io.BytesIO(outer.read(name))) as inner:
                    for part in [n for n in inner.namelist() if n.endswith(".xml")]:
                        xml = inner.read(part)
                        faces = re.findall(rb'typeface="([^"]+)"', xml) + re.findall(rb'<name val="([^"]+)"', xml)
                        for face in faces:
                            assert face.decode("utf-8") in LOCK_FAMILIES, f"{pptx_path.name} {name} {part}: {face!r}"
                        assert b"<a:font " not in xml, f"{name} {part}: per-script theme fonts"
    assert workbooks >= 13


def _text_uses(root, *, placeholders):
    """(typeface, text) of every a:t (runs and fields) and every bullet character under `root`."""
    uses = []
    for t in root.iter(f"{{{A_NS}}}t"):
        if not placeholders and xp(t, "ancestor::p:sp[p:nvSpPr/p:nvPr/p:ph]"):
            continue  # layout/master placeholder prompts are never drawn on a slide
        latin = t.getparent().find(f"{{{A_NS}}}rPr/{{{A_NS}}}latin")
        assert latin is not None, f"a run without a font: {t.text!r}"
        uses.append((latin.get("typeface"), t.text or ""))
    for bullet in root.iter(f"{{{A_NS}}}buChar"):
        font = bullet.getparent().find(f"{{{A_NS}}}buFont")
        assert font is not None, f"a bullet without buFont: {bullet.get('char')!r}"
        uses.append((font.get("typeface"), bullet.get("char")))
    return uses


def _glyph_uses(pptx_path):
    """(typeface, text) for everything PowerPoint draws with a named font: slide runs and fields, bullet characters,
    master/layout shapes, chart rich text and the cached chart strings (categories, series names) that the chart's
    own text properties draw."""
    prs = Presentation(str(pptx_path))
    uses = []
    for slide in prs.slides:
        uses += _text_uses(slide._element, placeholders=True)
        for cs in chart_spaces(slide):
            default = xp(cs, "./c:txPr/a:p/a:pPr/a:defRPr/a:latin/@typeface")[0]
            uses += [(default, v) for v in xp(cs, ".//c:strCache/c:pt/c:v/text()")]
            uses += _text_uses(cs, placeholders=True)
    for part in [prs.slide_master.part, *(layout.part for layout in prs.slide_layouts)]:
        uses += _text_uses(part._element, placeholders=False)
    return uses


def test_ofl_glyphs_exist_in_their_fonts_in_every_deck(atlas_ofl, probe_ofl, sizes_ofl):
    # PowerPoint substitutes another font (e.g. Malgun Gothic) for a glyph the named font lacks, and that font then
    # ends up embedded in the public PDF.
    uses = [use for pptx_path, _ in all_ofl_decks(atlas_ofl, probe_ofl, sizes_ofl) for use in _glyph_uses(pptx_path)]
    assert {face for face, _ in uses} == OFL_FACES  # every family is checked, against its own installed files
    cmaps = _installed_cmaps({face for face, _ in uses})
    lacking = {(face, ch) for face, text in uses for ch in text if ch not in NOT_DRAWN and ord(ch) not in cmaps[face]}
    assert not lacking, f"glyphs missing from their font: {sorted(lacking)}"


def test_windows_build_draws_emoji_with_an_emoji_font(tmp_path):
    from harness.atlas.conftest import run_build

    pptx_path, manifest = run_build(tmp_path, "atlas", "windows")
    assert "emoji" not in {item["feature"] for item in manifest["excluded"]}
    prs = Presentation(str(pptx_path))
    emoji = [entry for entry in manifest["slides"] if "text:emoji" in entry["features"]]
    assert len(emoji) == 1
    slide = prs.slides[emoji[0]["n"] - 1]
    faces = {xp(run, "./a:rPr/a:latin/@typeface")[0] for run in xp(slide._element, ".//a:r")
             if any(ord(c) >= 0x1F300 for c in "".join(xp(run, "./a:t/text()")))}
    assert faces == {"Segoe UI Emoji"}
