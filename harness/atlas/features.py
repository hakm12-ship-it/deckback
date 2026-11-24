"""The manifest feature vocabulary: every feature string a slide declares is a checkable promise about THAT slide.

`missing_features(slide, features)` returns the declared features the slide does not show, and any feature the
vocabulary does not know. The tests run it on every slide of every built deck, so a manifest can never claim a
feature its slide lacks, and a new section cannot invent unchecked feature names: register them here.

A feature is either a fixed name in FIXED (checked first) or matches one of the PATTERNS families. A check is an
XPath that must find at least one node in the slide XML, or a callable `(python-pptx Slide) -> bool` for things
outside the slide XML: the pixel format of an embedded image (PNG IHDR colour type, JPEG SOF components), a chart
part (ChartCheck runs an XPath on each chartSpace the slide shows), a hyperlink relationship, or the slide's layout
and master (master shapes, inherited backgrounds).

`prstGeom:<preset>` is not written by hand: AtlasDeck.manifest() derives it for every preset geometry drawn on the
slide (`drawn_presets`: shapes, connectors and pictures; text boxes excluded), so the family is complete and
consistent on every slide. The `pattFill:` and `prstTxWarp:` presets a slide declares must also equal exactly what it
draws (`drawn_patterns`, `drawn_warps`; enforced by the tests).
"""

import functools
import json
import re

from lxml import etree
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn

from harness.atlas import drawingml as dml
from harness.fonts import fontcheck

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_RGB = 2  # IHDR colour types
PNG_RGBA = 6
JPEG_SOF = (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF)
_ROTATED_SP = "p:sp[p:spPr/a:xfrm/@rot]"
_TEXT_BOX = "p:sp[p:nvSpPr/p:cNvSpPr/@txBox='1']"
_PLACEHOLDER = "p:sp[p:nvSpPr/p:nvPr/p:ph]"
# the label, title and captions every slide gets from AtlasDeck (they never count as a sample)
_FRAMEWORK_TEXT = ("p:nvSpPr/p:cNvPr[@name='Atlas Label' or @name='Atlas Title' or starts-with(@name, 'Caption ')]")
# Text checks look at content text only: runs, paragraph and body properties outside the framework's own text, which
# is on every slide (HEAD bold title, BODY 9 pt label and captions) and would otherwise satisfy typeface:, fontSize:,
# rPr:b, text:solidFill:srgb, algn:, anchor: and more on any slide.
_IN_FRAMEWORK = f"ancestor::p:sp[{_FRAMEWORK_TEXT}]"
_RUN = f"a:r[not({_IN_FRAMEWORK})]"
_PPR = f"a:pPr[not({_IN_FRAMEWORK})]"
_BODY = f"a:bodyPr[not({_IN_FRAMEWORK})]"
_NS = {
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
    "p": "http://schemas.openxmlformats.org/presentationml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
_HANGUL = re.compile("[가-힣]")
# a chart CT_Boolean element that is true: its val defaults to true, and python-pptx omits it then
_TRUE = "[not(@val) or @val='1' or @val='true']"


def drawn_presets(slide_element):
    """Preset geometries of the slide's shapes, connectors and pictures, in document order, unique; text boxes
    excluded (graphic frames -- tables, charts -- carry no geometry)."""
    found = slide_element.xpath(
        ".//p:sp[not(p:nvSpPr/p:cNvSpPr/@txBox='1')]/p:spPr/a:prstGeom/@prst"
        " | .//p:cxnSp/p:spPr/a:prstGeom/@prst | .//p:pic/p:spPr/a:prstGeom/@prst"
    )
    return list(dict.fromkeys(str(value) for value in found))


def drawn_patterns(slide_element):
    return list(dict.fromkeys(str(value) for value in slide_element.xpath(".//a:pattFill/@prst")))


def drawn_warps(slide_element):
    """WordArt transforms (a:prstTxWarp presets) of the slide's text, in document order, unique."""
    return list(dict.fromkeys(str(value) for value in slide_element.xpath(".//a:bodyPr/a:prstTxWarp/@prst")))


def _xpath(element, expr):
    """XPath with the a/c/p/r prefixes on any element (python-pptx's own classes and plain lxml ones alike)."""
    return etree.XPath(expr, namespaces=_NS)(element)


def _embedded_images(slide, with_alpha_mod=None, xpath=".//a:blip[@r:embed]"):
    """Blobs of the images the slide's a:blip elements embed (optionally only those with/without alphaModFix)."""
    for blip in _xpath(slide._element, xpath):
        if with_alpha_mod is not None and bool(_xpath(blip, "./a:alphaModFix")) != with_alpha_mod:
            continue
        yield slide.part.related_part(blip.get(qn("r:embed"))).blob


def _png_colour_type(blob):
    return blob[25] if blob[:8] == PNG_SIGNATURE else None


def _is_rgba_png(blob):
    return _png_colour_type(blob) == PNG_RGBA


def jpeg_components(blob):
    """Number of colour components in a JPEG's first SOF segment (3 = YCbCr/RGB, 4 = CMYK/YCCK); None when the blob
    is not a JPEG."""
    if blob[:2] != b"\xff\xd8":
        return None
    i = 2
    while i + 4 <= len(blob) and blob[i] == 0xFF:
        marker = blob[i + 1]
        if marker == 0xFF:  # fill byte
            i += 1
            continue
        if marker in JPEG_SOF:
            return blob[i + 9]  # FF Cn, length (2), precision (1), height (2), width (2), components (1)
        i += 2 + int.from_bytes(blob[i + 2:i + 4], "big")
    return None


def _pictures(predicate):
    """A check: some p:pic on the slide embeds an image for which predicate(blob) is true."""
    return lambda slide: any(predicate(b) for b in _embedded_images(slide, xpath=".//p:pic/p:blipFill/a:blip"))


class ChartCheck:
    """A check that runs `xpath` on the chartSpace of every chart drawn on the slide (charts live in their own
    parts); true when any chart matches. `xpath` is kept so the tests can compile it."""

    def __init__(self, xpath):
        self.xpath = xpath
        self._compiled = etree.XPath(xpath, namespaces=_NS)

    def __call__(self, slide):
        return any(self._compiled(space) for space in chart_spaces(slide))


def chart_spaces(slide):
    """chartSpace elements of the charts drawn on the slide."""
    rids = _xpath(slide._element, ".//p:graphicFrame/a:graphic/a:graphicData/c:chart/@r:id")
    return [slide.part.related_part(str(rid))._element for rid in rids]


def _korean_categories(slide):
    return any(_HANGUL.search("".join(_xpath(space, ".//c:cat//c:pt/c:v/text()"))) for space in chart_spaces(slide))


def _korean_chart_text(slide):
    texts = lambda space: "".join(_xpath(space, ".//c:strCache/c:pt/c:v/text() | .//a:t/text()"))  # noqa: E731
    return any(_HANGUL.search(texts(space)) for space in chart_spaces(slide))


def _external_hyperlink(slide):
    for rid in _xpath(slide._element, f".//{_RUN}/a:rPr/a:hlinkClick/@r:id"):
        rel = slide.part.rels.get(str(rid))
        if rel is not None and rel.reltype == RT.HYPERLINK and rel.is_external:
            return True
    return False


def _shows_master_shapes(slide):
    return slide._element.get("showMasterSp") != "0" and slide.slide_layout._element.get("showMasterSp") != "0"


def _drawn_shapes(owner_element):
    """Non-placeholder shapes and pictures of a layout or master."""
    return _xpath(owner_element, "./p:cSld/p:spTree/*[self::p:sp or self::p:pic or self::p:cxnSp][not(*/p:nvPr/p:ph)]")


def _master_shapes(slide):
    return _shows_master_shapes(slide) and bool(_drawn_shapes(slide.slide_layout.slide_master._element))


def _layout_shapes(slide):
    return slide._element.get("showMasterSp") != "0" and bool(_drawn_shapes(slide.slide_layout._element))


def _background_from_layout(slide):
    return not _xpath(slide._element, "./p:cSld/p:bg") and bool(_xpath(slide.slide_layout._element, "./p:cSld/p:bg"))


def _mixed_table_fonts(slide):
    return any(len(set(_xpath(tbl, ".//a:r/a:rPr/a:latin/@typeface"))) >= 3 for tbl in _xpath(slide._element,
                                                                                           ".//a:tbl"))


@functools.lru_cache(maxsize=1)
def cff_families():
    """The lock families whose files are OpenType-CFF (harness/fonts/fonts.lock.json): PowerPoint's PDF export does
    not embed them and draws their text as a bitmap."""
    lock = json.loads(fontcheck.DEFAULT_LOCK.read_text(encoding="utf-8"))
    return frozenset(fam["family"] for fam in lock["families"] if all(f["format"] == "otf-cff" for f in fam["files"]))


def _cff_text(slide):
    """Content text in a locked OpenType-CFF family."""
    return bool(set(map(str, _xpath(slide._element, f".//{_RUN}/a:rPr/a:latin/@typeface"))) & cff_families())


def _emoji(slide):
    for run in _xpath(slide._element, f".//{_RUN}"):
        if any(ord(ch) >= 0x1F000 for ch in "".join(_xpath(run, "./a:t/text()"))):
            return True
    return False


def _distorted_picture(slide):
    """A picture stretched out of its image's aspect ratio (no crop) by more than 10 %."""
    from io import BytesIO

    from PIL import Image

    for pic in _xpath(slide._element, ".//p:pic[not(p:blipFill/a:srcRect)]"):
        ext = _xpath(pic, "./p:spPr/a:xfrm/a:ext")[0]
        blob = slide.part.related_part(_xpath(pic, "./p:blipFill/a:blip/@r:embed")[0]).blob
        width, height = Image.open(BytesIO(blob)).size
        shown = int(ext.get("cx")) / max(1, int(ext.get("cy")))
        if abs(shown / (width / height) - 1) > 0.10:
            return True
    return False


FIXED = {
    # transforms and text in transformed shapes
    "xfrm:rot": ".//p:sp/p:spPr/a:xfrm[@rot]",
    "xfrm:flipH": ".//p:sp/p:spPr/a:xfrm[@flipH='1']",
    "xfrm:flipV": ".//p:sp/p:spPr/a:xfrm[@flipV='1']",
    "xfrm:flipH+flipV": ".//p:sp/p:spPr/a:xfrm[@flipH='1' and @flipV='1']",
    "xfrm:rot+flip": ".//p:sp/p:spPr/a:xfrm[@rot][@flipH='1' or @flipV='1']",
    "txBody:rotated-with-shape": f".//{_ROTATED_SP}[p:txBody]",
    "txBody:flipped": ".//p:sp[p:spPr/a:xfrm[@flipH='1' or @flipV='1']][p:txBody]",
    "avLst:adjusted": ".//a:prstGeom/a:avLst/a:gd",
    # groups
    "grpSp": ".//p:grpSp",
    "grpSp:nested": ".//p:grpSp//p:grpSp",
    "grpSp:connector": ".//p:grpSp/p:cxnSp",
    "grpSp:text": ".//p:grpSp/p:sp[p:nvSpPr/p:cNvSpPr/@txBox='1']",
    "grpSp:rot": ".//p:grpSp/p:grpSpPr/a:xfrm[@rot]",
    "grpSp:flipH": ".//p:grpSp/p:grpSpPr/a:xfrm[@flipH='1']",
    "grpSp:flipV": ".//p:grpSp/p:grpSpPr/a:xfrm[@flipV='1']",
    "grpSp:scaled": ".//p:grpSp/p:grpSpPr/a:xfrm[a:ext/@cx != a:chExt/@cx or a:ext/@cy != a:chExt/@cy]",
    "grpSp:rot-child": f".//p:grpSp[p:grpSpPr/a:xfrm/@rot]/{_ROTATED_SP}",
    "grpSp:nested-rot": ".//p:grpSp/p:grpSp[p:grpSpPr/a:xfrm/@rot]",
    # text inside a rotated group: PowerPoint's PDF export draws it as outlines (known class textAsOutlines)
    "grpSp:rot-text": ".//p:grpSp[p:grpSpPr/a:xfrm/@rot]//p:sp[p:txBody//a:t[normalize-space()]]",
    # lines and connectors
    "custGeom:open-path": ".//a:custGeom/a:pathLst/a:path[@fill='none']",
    "lineEnd:w-len-mixed": ".//a:ln/a:tailEnd[@w != @len]",
    "lineEnd:head+tail": ".//a:ln[a:headEnd][a:tailEnd]",
    "lineEnd:thick-line": f".//a:ln[number(@w) >= {dml.emu(8)}][a:tailEnd]",
    "lineEnd:diagonal": (".//p:cxnSp[p:spPr/a:prstGeom/@prst='straightConnector1']"
                         "[p:spPr/a:xfrm/a:ext[@cx != '0' and @cy != '0']][p:spPr/a:ln/a:tailEnd]"),
    "cxn:stCxn": ".//p:cxnSp/p:nvCxnSpPr/p:cNvCxnSpPr/a:stCxn",
    "cxn:endCxn": ".//p:cxnSp/p:nvCxnSpPr/p:cNvCxnSpPr/a:endCxn",
    "cxn:flipH": ".//p:cxnSp/p:spPr/a:xfrm[@flipH='1']",
    "cxn:flipV": ".//p:cxnSp/p:spPr/a:xfrm[@flipV='1']",
    "ln:solidFill:srgb": ".//a:ln/a:solidFill/a:srgbClr",
    "ln:solidFill:scheme": ".//a:ln/a:solidFill/a:schemeClr",
    "ln:alpha": ".//a:ln/a:solidFill/*/a:alpha",
    "ln:gradFill": ".//a:ln/a:gradFill",
    "ln:pattFill": ".//a:ln/a:pattFill",
    "ln:noFill": ".//p:cxnSp/p:spPr/a:ln/a:noFill",
    "outline:custDash": ".//p:sp/p:spPr/a:ln/a:custDash",
    # fills
    "solidFill:srgb": ".//p:spPr/a:solidFill/a:srgbClr",
    "solidFill:scheme": ".//p:spPr/a:solidFill/a:schemeClr",
    "solidFill:alpha": ".//p:spPr/a:solidFill/*/a:alpha",
    "color:lumMod": ".//a:lumMod",
    "color:lumOff": ".//a:lumOff",
    "color:shade": ".//a:shade",
    "color:tint": ".//a:tint",
    "gradFill:scaled": ".//a:gradFill/a:lin[@scaled='1']",
    "gradFill:rotWithShape": f".//{_ROTATED_SP}/p:spPr/a:gradFill[@rotWithShape='0']",
    "gradFill:fillToRect": ".//a:gradFill/a:path/a:fillToRect[@l != '50000' or @t != '50000']",
    "gradFill:multi-stop": ".//a:gradFill[count(a:gsLst/a:gs) >= 3]",
    "gradFill:alpha-stops": ".//a:gradFill/a:gsLst/a:gs/*/a:alpha",
    "gradFill:hard-stop": ".//a:gradFill/a:gsLst/a:gs[@pos = following-sibling::a:gs[1]/@pos]",
    "gradFill:tileRect": ".//a:gradFill/a:tileRect",
    "gradFill:flip": ".//a:gradFill[@flip and @flip != 'none']",
    "gradFill:scheme": ".//a:gradFill/a:gsLst/a:gs/a:schemeClr",
    "gradFill:custGeom": ".//p:spPr[a:custGeom]/a:gradFill",
    "pattFill:alpha": ".//a:pattFill/a:bgClr/*/a:alpha",
    "blipFill:tile": ".//p:spPr/a:blipFill/a:tile",
    "blipFill:stretch": ".//p:spPr/a:blipFill/a:stretch",
    "blipFill:srcRect": ".//a:blipFill/a:srcRect",
    "blipFill:fillRect": ".//a:blipFill/a:stretch/a:fillRect[@l or @t or @r or @b]",
    "blipFill:rotWithShape": f".//{_ROTATED_SP}/p:spPr/a:blipFill[@rotWithShape='0']",
    "blipFill:alphaModFix": ".//a:blipFill/a:blip/a:alphaModFix",
    "blipFill:rgba": lambda slide: any(_is_rgba_png(b) for b in _embedded_images(slide)),
    "blipFill:rgba+alphaModFix": lambda slide: any(_is_rgba_png(b) for b in _embedded_images(slide, True)),
    "tile:scale": ".//a:blipFill/a:tile[@sx != '100000' or @sy != '100000']",
    "tile:flip": ".//a:blipFill/a:tile[@flip != 'none']",
    "tile:offset": ".//a:blipFill/a:tile[@tx != '0' or @ty != '0']",
    "tile:algn": ".//a:blipFill/a:tile[@algn != 'tl']",
    # effects and 3-D
    "effect:bevel:shape": ".//p:spPr/a:sp3d/a:bevelT",
    "effect:bevel:text": f".//{_BODY}/a:sp3d/a:bevelT",
    "effect:3dRotation:shape": ".//p:spPr/a:scene3d/a:camera[a:rot or @prst != 'orthographicFront']",
    "effect:3dRotation:text": f".//{_BODY}/a:scene3d/a:camera[a:rot or @prst != 'orthographicFront']",
    "camera:rot": ".//a:scene3d/a:camera/a:rot",
    "sp3d:extrusion": ".//a:sp3d[@extrusionH]",
    # text runs
    "rPr:b": f".//{_RUN}/a:rPr[@b='1']",
    "rPr:i": f".//{_RUN}/a:rPr[@i='1']",
    "rPr:b+i": f".//{_RUN}/a:rPr[@b='1' and @i='1']",
    "baseline:super": f".//{_RUN}/a:rPr[number(@baseline) > 0]",
    "baseline:sub": f".//{_RUN}/a:rPr[number(@baseline) < 0]",
    "kern": f".//{_RUN}/a:rPr[@kern]",
    "highlight": f".//{_RUN}/a:rPr/a:highlight",
    "hlinkClick": _external_hyperlink,
    "text:solidFill:srgb": f".//{_RUN}/a:rPr/a:solidFill/a:srgbClr",
    "text:solidFill:scheme": f".//{_RUN}/a:rPr/a:solidFill/a:schemeClr",
    "text:gradFill": f".//{_RUN}/a:rPr/a:gradFill",
    "text:noFill": f".//{_RUN}/a:rPr/a:noFill",
    "text:ln": f".//{_RUN}/a:rPr/a:ln[not(a:noFill)]",
    "text:outline-only": f".//{_RUN}/a:rPr[a:noFill][a:ln[not(a:noFill)]]",
    "text:emoji": _emoji,
    "font:cff": _cff_text,  # the bitmap sample (atlas/fonts/01): text PowerPoint will not embed
    "br": f".//a:br[not({_IN_FRAMEWORK})]",
    "fld:slidenum": ".//a:fld[@type='slidenum']",
    # paragraphs
    "buChar": f".//{_PPR}/a:buChar",
    "buClr": f".//{_PPR}/a:buClr",
    "buSzPct": f".//{_PPR}/a:buSzPct",
    "buNone": f".//{_PPR}/a:buNone",
    "marL+indent": f".//{_PPR}[@marL and @indent and @indent != '0']",
    "lnSpc:pct": f".//{_PPR}/a:lnSpc/a:spcPct",
    "lnSpc:pts": f".//{_PPR}/a:lnSpc/a:spcPts",
    "spcBef": f".//{_PPR}/a:spcBef",
    "spcAft": f".//{_PPR}/a:spcAft",
    "eaLnBrk:off": f".//{_PPR}[@eaLnBrk='0']",
    "latinLnBrk:on": f".//{_PPR}[@latinLnBrk='1']",
    "fontAlgn": f".//{_PPR}[@fontAlgn]",
    # text bodies
    "spAutoFit": f".//{_BODY}/a:spAutoFit",
    "noAutofit": f".//{_BODY}/a:noAutofit",
    "wrap:none": f".//{_TEXT_BOX}/p:txBody/{_BODY}[@wrap='none']",
    "wrap:square": f".//p:txBody/{_BODY}[@wrap='square']",
    "insets:wide": f".//{_BODY}[number(@lIns) >= {dml.emu(18)} and number(@tIns) >= {dml.emu(18)}]",
    "anchorCtr": f".//{_BODY}[@anchorCtr='1']",
    "txBody:in-shape": ".//p:sp[not(p:nvSpPr/p:cNvSpPr/@txBox='1')][p:spPr/a:prstGeom[@prst != 'rect']][p:txBody//a:t]",
    # tables
    "tbl": ".//p:graphicFrame/a:graphic/a:graphicData/a:tbl",
    "tbl:styleId": ".//a:tbl/a:tblPr/a:tableStyleId",
    "tbl:firstRow": ".//a:tbl/a:tblPr[@firstRow='1']",
    "tbl:lastRow": ".//a:tbl/a:tblPr[@lastRow='1']",
    "tbl:firstCol": ".//a:tbl/a:tblPr[@firstCol='1']",
    "tbl:lastCol": ".//a:tbl/a:tblPr[@lastCol='1']",
    "tbl:bandRow": ".//a:tbl/a:tblPr[@bandRow='1']",
    "tbl:bandCol": ".//a:tbl/a:tblPr[@bandCol='1']",
    "tbl:gridSpan": ".//a:tc[number(@gridSpan) > 1]",
    "tbl:rowSpan": ".//a:tc[number(@rowSpan) > 1]",
    "tbl:hMerge": ".//a:tc[@hMerge='1']",
    "tbl:vMerge": ".//a:tc[@vMerge='1']",
    "tbl:mixed-fonts": _mixed_table_fonts,
    "tc:lnL": ".//a:tcPr/a:lnL[not(a:noFill)]",
    "tc:lnR": ".//a:tcPr/a:lnR[not(a:noFill)]",
    "tc:lnT": ".//a:tcPr/a:lnT[not(a:noFill)]",
    "tc:lnB": ".//a:tcPr/a:lnB[not(a:noFill)]",
    "tc:lnTlToBr": ".//a:tcPr/a:lnTlToBr[not(a:noFill)]",
    "tc:lnBlToTr": ".//a:tcPr/a:lnBlToTr[not(a:noFill)]",
    "tc:solidFill": ".//a:tcPr/a:solidFill",
    "tc:gradFill": ".//a:tcPr/a:gradFill",
    "tc:pattFill": ".//a:tcPr/a:pattFill",
    "tc:noFill": ".//a:tcPr/a:noFill",
    "tc:margins": ".//a:tcPr[@marL or @marR or @marT or @marB]",
    # charts (checked in the chart parts)
    "chart:marker": ChartCheck(f".//c:lineChart[c:marker{_TRUE}]/c:ser[not(c:marker/c:symbol/@val='none')]"),
    "chart:marker:symbol": ChartCheck(".//c:ser/c:marker/c:symbol[@val != 'none' and @val != 'auto']"),
    "chart:dLbls": ChartCheck(f".//c:dLbls[c:showVal{_TRUE} or c:showPercent{_TRUE} or c:showCatName{_TRUE}]"),
    "chart:legend": ChartCheck("./c:chart/c:legend"),
    "chart:title": ChartCheck("./c:chart/c:title/c:tx/c:rich"),
    "chart:axisTitle": ChartCheck("./c:chart/c:plotArea/*[self::c:catAx or self::c:valAx]/c:title"),
    "chart:gridlines": ChartCheck(".//c:majorGridlines"),
    "chart:smooth": ChartCheck(f".//c:ser/c:smooth{_TRUE}"),
    "chart:explosion": ChartCheck(".//c:ser/c:explosion[number(@val) > 0] | .//c:dPt/c:explosion[number(@val) > 0]"),
    "chart:holeSize": ChartCheck(".//c:doughnutChart/c:holeSize"),
    "chart:varyColors": ChartCheck(f".//c:varyColors{_TRUE}"),
    "chart:ser:solidFill": ChartCheck(".//c:ser/c:spPr/a:solidFill"),
    "chart:dPt": ChartCheck(".//c:ser/c:dPt"),
    "chart:fonts": ChartCheck("./c:txPr/a:p/a:pPr/a:defRPr[a:latin and a:ea and a:cs]"),
    "chart:korean-categories": _korean_categories,
    "chart:korean": _korean_chart_text,
    # pictures
    "pic": ".//p:pic",
    "pic:srcRect": ".//p:pic/p:blipFill/a:srcRect[@l or @t or @r or @b]",
    "pic:rot": ".//p:pic/p:spPr/a:xfrm[@rot]",
    "pic:flipH": ".//p:pic/p:spPr/a:xfrm[@flipH='1']",
    "pic:flipV": ".//p:pic/p:spPr/a:xfrm[@flipV='1']",
    "pic:grayscl": ".//p:pic/p:blipFill/a:blip/a:grayscl",
    "pic:duotone": ".//p:pic/p:blipFill/a:blip/a:duotone",
    "pic:biLevel": ".//p:pic/p:blipFill/a:blip/a:biLevel",
    "pic:lum": ".//p:pic/p:blipFill/a:blip/a:lum",
    "pic:alphaModFix": ".//p:pic/p:blipFill/a:blip/a:alphaModFix",
    "pic:ln": ".//p:pic/p:spPr/a:ln[not(a:noFill)]",
    "pic:geom": ".//p:pic/p:spPr/a:prstGeom[@prst != 'rect']",
    "pic:distorted": _distorted_picture,
    "pic:png:rgb": _pictures(lambda blob: _png_colour_type(blob) == PNG_RGB),
    "pic:png:rgba": _pictures(lambda blob: _png_colour_type(blob) == PNG_RGBA),
    "pic:jpeg:rgb": _pictures(lambda blob: jpeg_components(blob) == 3),
    "pic:jpeg:cmyk": _pictures(lambda blob: jpeg_components(blob) == 4),
    "grpSp:pic": ".//p:grpSp/p:pic",
    # slides, backgrounds, masters and placeholders
    "slide:hidden": "self::p:sld[@show='0']",
    "bg:solidFill": "./p:cSld/p:bg/p:bgPr/a:solidFill",
    "bg:solidFill:scheme": "./p:cSld/p:bg/p:bgPr/a:solidFill/a:schemeClr",
    "bg:gradFill:lin": "./p:cSld/p:bg/p:bgPr/a:gradFill/a:lin",
    "bg:gradFill:path": "./p:cSld/p:bg/p:bgPr/a:gradFill/a:path",
    "bg:blipFill:stretch": "./p:cSld/p:bg/p:bgPr/a:blipFill/a:stretch",
    "bg:blipFill:tile": "./p:cSld/p:bg/p:bgPr/a:blipFill/a:tile",
    "bg:pattFill": "./p:cSld/p:bg/p:bgPr/a:pattFill",
    "bg:bgRef": "./p:cSld/p:bg/p:bgRef",
    "bg:from-layout": _background_from_layout,
    "master:sp": _master_shapes,
    "layout:sp": _layout_shapes,
    "ph:dt": f".//{_PLACEHOLDER}/p:nvSpPr/p:nvPr/p:ph[@type='dt']",
    "ph:ftr": f".//{_PLACEHOLDER}/p:nvSpPr/p:nvPr/p:ph[@type='ftr']",
    "ph:sldNum": f".//{_PLACEHOLDER}/p:nvSpPr/p:nvPr/p:ph[@type='sldNum']",
}

_WORD = r"(?P<v>[A-Za-z0-9]+)"
PATTERNS = [
    (rf"prstGeom:{_WORD}", lambda m: f".//a:prstGeom[@prst='{m['v']}']"),
    (rf"cxnSp:{_WORD}", lambda m: f".//p:cxnSp/p:spPr/a:prstGeom[@prst='{m['v']}']"),
    (rf"sp:{_WORD}", lambda m: f".//p:sp/p:spPr/a:prstGeom[@prst='{m['v']}']"),
    (rf"pattFill:{_WORD}", lambda m: f".//a:pattFill[@prst='{m['v']}']"),
    (rf"prstDash:{_WORD}", lambda m: f".//a:ln/a:prstDash[@val='{m['v']}']"),
    (rf"outline:prstDash:{_WORD}", lambda m: f".//p:sp/p:spPr/a:ln/a:prstDash[@val='{m['v']}']"),
    (r"lineWidth:(?P<v>[0-9.]+)", lambda m: f".//a:ln[@w='{dml.emu(float(m['v']))}']"),
    (rf"lineCap:{_WORD}", lambda m: f".//a:ln[@cap='{m['v']}']"),
    (r"lineJoin:(?P<v>round|bevel|miter)", lambda m: f".//a:ln/a:{m['v']}"),
    (rf"cmpd:{_WORD}", lambda m: f".//a:ln[@cmpd='{m['v']}']"),
    (r"lineEnd:(?P<t>[a-z]+):(?P<s>sm|med|lg)",
     lambda m: " | ".join(f".//a:ln/a:{end}[@type='{m['t']}' and @w='{m['s']}' and @len='{m['s']}']"
                          for end in ("headEnd", "tailEnd"))),
    (rf"lineEnd:on-{_WORD}",
     lambda m: f".//p:cxnSp[p:spPr/a:prstGeom/@prst='{m['v']}'][p:spPr/a:ln/a:tailEnd or p:spPr/a:ln/a:headEnd]"),
    (r"alpha:(?P<v>[0-9]+)", lambda m: f".//p:spPr/a:solidFill/*/a:alpha[@val='{dml.pct(int(m['v']))}']"),
    (r"gradFill:lin:(?P<v>[0-9]+)", lambda m: f".//a:gradFill/a:lin[@ang='{dml.ang(int(m['v']))}']"),
    (r"gradFill:path:(?P<v>circle|rect|shape)", lambda m: f".//a:gradFill/a:path[@path='{m['v']}']"),
    (r"effect:(?P<v>glow|innerShdw|outerShdw|reflection|softEdge):shape",
     lambda m: f".//p:spPr/a:effectLst/a:{m['v']}"),
    (r"effect:(?P<v>glow|innerShdw|outerShdw|reflection|softEdge):text",
     lambda m: f".//{_RUN}/a:rPr/a:effectLst/a:{m['v']}"),
    (rf"bevel:{_WORD}", lambda m: f".//a:sp3d/a:bevelT[@prst='{m['v']}']"),
    (rf"camera:{_WORD}", lambda m: f".//a:scene3d/a:camera[@prst='{m['v']}']"),
    # text (Task 6b)
    (r"typeface:(?P<v>[A-Za-z][A-Za-z0-9 ]*[A-Za-z0-9])",  # "Gothic A1", "Source Sans 3"
     lambda m: f".//{_RUN}/a:rPr/a:latin[@typeface='{m['v']}']"),
    (r"fontSize:(?P<v>[0-9]+)", lambda m: f".//{_RUN}/a:rPr[@sz='{int(m['v']) * 100}']"),
    (rf"u:{_WORD}", lambda m: f".//{_RUN}/a:rPr[@u='{m['v']}']"),
    (r"strike:(?P<v>sngStrike|dblStrike)", lambda m: f".//{_RUN}/a:rPr[@strike='{m['v']}']"),
    (r"spc:(?P<v>-?[0-9]+)", lambda m: f".//{_RUN}/a:rPr[@spc='{int(m['v']) * 100}']"),
    (r"cap:(?P<v>small|all)", lambda m: f".//{_RUN}/a:rPr[@cap='{m['v']}']"),
    (rf"algn:{_WORD}", lambda m: f".//{_PPR}[@algn='{m['v']}']"),
    (rf"vert:{_WORD}", lambda m: f".//{_BODY}[@vert='{m['v']}']"),
    (r"textbox:rot:(?P<v>[0-9]+)",
     lambda m: f".//{_TEXT_BOX}[not({_FRAMEWORK_TEXT})]/p:spPr/a:xfrm[@rot='{dml.ang(int(m['v']))}']"),
    (r"bodyPr:rot:(?P<v>[0-9]+)", lambda m: f".//{_BODY}[@rot='{dml.ang(int(m['v']))}']"),
    (r"normAutofit:(?P<v>[0-9]+)", lambda m: f".//{_BODY}/a:normAutofit[@fontScale='{dml.pct(int(m['v']))}']"),
    (r"numCol:(?P<v>[0-9]+)", lambda m: f".//{_BODY}[@numCol='{m['v']}']"),
    (rf"buAutoNum:{_WORD}", lambda m: f".//{_PPR}/a:buAutoNum[@type='{m['v']}']"),
    (r"lvl:(?P<v>[0-8])", lambda m: f".//{_PPR}[@lvl='{m['v']}']"),
    (r"anchor:(?P<v>t|ctr|b)", lambda m: f".//p:txBody/{_BODY}[@anchor='{m['v']}']"),
    (r"tab:(?P<v>l|ctr|r|dec)", lambda m: f".//{_PPR}/a:tabLst/a:tab[@algn='{m['v']}']"),
    (rf"prstTxWarp:{_WORD}", lambda m: f".//{_BODY}/a:prstTxWarp[@prst='{m['v']}']"),
    # tables
    (r"tc:anchor:(?P<v>t|ctr|b)", lambda m: f".//a:tcPr[@anchor='{m['v']}']"),
    (rf"tc:vert:{_WORD}", lambda m: f".//a:tcPr[@vert='{m['v']}']"),
    # charts (checked in the chart parts)
    (r"chart:(?P<v>barChart|lineChart|pieChart|doughnutChart|areaChart|scatterChart|radarChart|bubbleChart)",
     lambda m: ChartCheck(f"./c:chart/c:plotArea/c:{m['v']}")),
    (r"chart:barDir:(?P<v>col|bar)", lambda m: ChartCheck(f".//c:barChart/c:barDir[@val='{m['v']}']")),
    (r"chart:grouping:(?P<v>clustered|stacked|percentStacked|standard)",
     lambda m: ChartCheck(f"./c:chart/c:plotArea/*/c:grouping[@val='{m['v']}']")),
    (r"chart:radarStyle:(?P<v>standard|marker|filled)",
     lambda m: ChartCheck(f".//c:radarChart/c:radarStyle[@val='{m['v']}']")),
    (r"chart:scatterStyle:(?P<v>lineMarker|line|marker|smoothMarker|smooth|none)",
     lambda m: ChartCheck(f".//c:scatterChart/c:scatterStyle[@val='{m['v']}']")),
    # pictures
    (r"pic:rot:(?P<v>[0-9]+)", lambda m: f".//p:pic/p:spPr/a:xfrm[@rot='{dml.ang(int(m['v']))}']"),
    (r"pic:effect:(?P<v>glow|innerShdw|outerShdw|reflection|softEdge)",
     lambda m: f".//p:pic/p:spPr/a:effectLst/a:{m['v']}"),
]
_COMPILED = [(re.compile(rf"^{regex}$"), make) for regex, make in PATTERNS]


def check_for(feature):
    """The check for a feature (XPath string or callable), or None when the vocabulary does not know it."""
    if feature in FIXED:
        return FIXED[feature]
    for regex, make in _COMPILED:
        match = regex.match(feature)
        if match:
            return make(match)
    return None


def missing_features(slide, features):
    """Declared features the python-pptx `slide` does not show; unknown features are reported as such."""
    missing = []
    for feature in features:
        check = check_for(feature)
        if check is None:
            missing.append(f"{feature} (not in the feature vocabulary)")
        elif callable(check):
            if not check(slide):
                missing.append(feature)
        elif not slide._element.xpath(check):
            missing.append(feature)
    return missing
