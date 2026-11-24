"""The atlas deck framework: one python-pptx presentation plus the manifest that describes its slides.

    deck = AtlasDeck("ofl", (960, 540))
    slide = deck.slide("shapes", ["prstGeom:rect"], title="...")
    ...draw on slide.shapes with harness.atlas.drawingml...
    deck.save(path)            # writes a byte-stable .pptx (normalize_pptx)
    deck.manifest()            # {deck, fonts, slideSize, slides, excluded}; per slide: n, section, id, features,
                               # hidden, smoke, knownBitmapText

Fonts. Every run names its typeface for latin, ea and cs (`deck.rpr`), so PowerPoint never falls back to a theme or
system font for Hangul. The theme's major/minor fonts are replaced by the HEAD/BODY roles (and its per-script
fallback list, which names Malgun Gothic, MS PGothic and others, is removed), and the master's bullet font becomes
BODY. With `fonts='ofl'` the deck therefore names only families from harness/fonts/fonts.lock.json.

Every slide carries a 9 pt label text box at the bottom-left holding its id `<prefix>/<section>/<nn>`; it is moved
to the top of the z-order when the deck is saved, so content never covers it.

Features. Each manifest feature is a checkable promise about its slide (vocabulary: harness/atlas/features.py). The
manifest adds `prstGeom:<preset>` for every preset geometry drawn on the slide (text boxes excluded), so that family
is complete on every slide; sections declare the rest. `knownBitmapText` marks a slide whose text PowerPoint draws as
a bitmap on purpose (atlas/fonts/01, text in an OpenType-CFF font), so text-based checks skip it.

Slide size. `p:sldSz/@type` and docProps/app.xml PresentationFormat follow the actual size (PowerPoint's values for
16:9 widescreen and 4:3; otherwise custom, A4 included -- see KNOWN_SIZES), and app.xml's slide counts are updated on
save.
"""

import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from lxml import etree
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT
from pptx.oxml.ns import qn
from pptx.util import Emu

from harness.atlas import drawingml as dml
from harness.atlas.features import drawn_presets
from harness.atlas.normalize import normalize_pptx

LABEL_NAME = "Atlas Label"
TITLE_NAME = "Atlas Title"
LABEL_SIZE_PT = 9
BLANK_LAYOUT = 6  # "Blank" in python-pptx's default template
_SLUG = re.compile(r"^[a-z0-9][A-Za-z0-9-]*$")  # first character lowercase; camelCase allowed (atlas-com/pictureEffects)
_A = "http://schemas.openxmlformats.org/drawingml/2006/main"


@dataclass(frozen=True)
class Font:
    family: str  # the Windows family name (name table nameID 1), exactly as PowerPoint looks it up
    bold: bool = False


# Font roles (rulings M1-R20, M1-R29). OFL names are the nameID-1 families of harness/fonts/fonts.lock.json, all of
# them static TrueType that PowerPoint embeds in a PDF as subsets, none with a same-named Windows system font; weights
# that are separate families there (Light, Black, ExtraBold) are separate roles. Glyph gaps to avoid in content:
# NanumGothic lacks the check mark, circled digits and the parenthesised-hangul signs; Gowun Batang lacks the check
# mark; Pretendard lacks the archaic jamo U+3165-318E; none has Hanja.
ROLES = {
    "ofl": {
        "HEAD": Font("Gothic A1", True),
        "BODY": Font("Pretendard"),
        "SERIF": Font("Gowun Batang"),
        "ALT": Font("NanumGothic"),
        "BODY_LIGHT": Font("Pretendard Light"),
        "BODY_BLACK": Font("Pretendard Black"),
        "ALT_XBOLD": Font("NanumGothicExtraBold"),
    },
    "windows": {
        "HEAD": Font("Malgun Gothic", True),
        "BODY": Font("Malgun Gothic"),
        "SERIF": Font("Batang"),
        "ALT": Font("Gulim"),
        "BODY_LIGHT": Font("Malgun Gothic Semilight"),
        "BODY_BLACK": Font("Malgun Gothic", True),
        "ALT_XBOLD": Font("Gulim", True),
    },
}

# (cx, cy) in EMU -> (p:sldSz type, docProps/app.xml PresentationFormat) as PowerPoint writes them. Any other size
# is custom: no type attribute (its default is "custom") and the format "Custom". That includes true A4 (842x595 and
# 595x842 pt, the `sizes-a4l` / `sizes-a4p` decks): PowerPoint's own "A4 Paper" preset is not A4-sized but 780x540
# pt (9906000x6858000 EMU, type="A4", "A4 Paper (210x297 mm)"), so a PowerPoint deck at 842x595 pt is a custom size
# too. The A4 preset is not listed because no atlas deck uses it.
KNOWN_SIZES = {
    (12192000, 6858000): (None, "Widescreen"),
    (9144000, 6858000): ("screen4x3", "On-screen Show (4:3)"),
}
CUSTOM_FORMAT = "Custom"
APP_PART = "/docProps/app.xml"
_EP = "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"

CORE_TITLE = "deckback feature atlas"
CORE_AUTHOR = "deckback harness"
FIXED_DATETIME = datetime(1980, 1, 1)


def _number(value):
    return int(value) if float(value).is_integer() else float(value)


class AtlasDeck:
    """A presentation being authored, plus its manifest entries."""

    def __init__(self, fonts, size_pt, *, deck="atlas", id_prefix=None):
        if fonts not in ROLES:
            raise ValueError(f"fonts must be one of {sorted(ROLES)}: {fonts!r}")
        width, height = size_pt
        if not (width > 0 and height > 0):
            raise ValueError(f"bad slide size {size_pt!r}")
        self.fonts = fonts
        self.deck = deck
        self.id_prefix = id_prefix or deck
        self.size_pt = (_number(width), _number(height))
        self.roles = ROLES[fonts]
        self.excluded = []
        self._entries = []
        self._per_section = Counter()

        self.prs = Presentation()
        old_w, old_h = self.prs.slide_width, self.prs.slide_height
        self.prs.slide_width, self.prs.slide_height = Emu(dml.emu(width)), Emu(dml.emu(height))
        self._size_type, self._size_format = KNOWN_SIZES.get(
            (self.prs.slide_width, self.prs.slide_height), (None, CUSTOM_FORMAT))
        sld_sz = self.prs.part._element.find(qn("p:sldSz"))
        sld_sz.attrib.pop("type", None)  # the template says screen4x3 whatever the size
        if self._size_type:
            sld_sz.set("type", self._size_type)
        self._rescale_master_and_layouts(self.prs.slide_width / old_w, self.prs.slide_height / old_h)
        self._set_theme_fonts()
        self._set_bullet_fonts()
        self._set_core_properties()
        self._blank = self.prs.slide_layouts[BLANK_LAYOUT]

    # --- geometry ---------------------------------------------------------------------------------------------

    @property
    def width(self):
        return self.size_pt[0]

    @property
    def height(self):
        return self.size_pt[1]

    @property
    def content(self):
        """(x, y, w, h) of the area between the title band and the label band."""
        return (24, 56, self.width - 48, self.height - 56 - 28)

    def grid(self, cols, rows, area=None):
        """Cells (x, y, w, h), row by row, that split `area` (default: the content area) evenly."""
        x, y, w, h = area or self.content
        cw, ch = w / cols, h / rows
        return [(x + c * cw, y + r * ch, cw, ch) for r in range(rows) for c in range(cols)]

    # --- text -------------------------------------------------------------------------------------------------

    def font(self, role):
        return self.roles[role]

    def rpr(self, role="BODY", size=12, *, bold=None, tag="a:rPr", **kwargs):
        """a:rPr (or endParaRPr) naming the role's family for latin, ea and cs."""
        font = self.roles[role]
        return dml.rpr(font.family, size, bold=font.bold if bold is None else bold, tag=tag, **kwargs)

    def para(self, text, role="BODY", size=12, *, align=None, ppr=None, **kwargs):
        """One paragraph with one run (text may be '' for an empty paragraph); ppr: a dml.p_pr() instead of align."""
        end = self.rpr(role, size, tag="a:endParaRPr", bold=kwargs.get("bold"))
        runs = [(text, self.rpr(role, size, **kwargs))] if text else []
        return dml.paragraph(runs, align=align, ppr=ppr, end_rpr=end)

    def rich(self, parts, *, align=None, ppr=None):
        """One paragraph of several runs: parts = [(text, role, size[, rpr keyword arguments]), ...]; the text '\\n'
        is a line break. The end-of-paragraph properties follow the last part."""
        runs = []
        for part in parts:
            text, role, size = part[:3]
            kwargs = part[3] if len(part) > 3 else {}
            runs.append((text, self.rpr(role, size, **kwargs)))
        _, role, size = parts[-1][:3]
        end = self.rpr(role, size, tag="a:endParaRPr")
        return dml.paragraph(runs, align=align, ppr=ppr, end_rpr=end)

    def bullet_ppr(self, role="BODY", *, char="•", **kwargs):
        """dml.p_pr() for a bullet paragraph whose bullet character is drawn in the role's family (named, so
        PowerPoint never looks for the glyph in the template's bullet font)."""
        return dml.p_pr(bullet=("char", char), bu_font=self.roles[role].family, **kwargs)

    def textbox(self, shapes, x, y, w, h, paragraphs, *, name, body=None):
        """A text box (p:sp txBox="1", no fill, no line) holding the given a:p XML strings."""
        sppr = dml.sp_pr(x, y, w, h, fill=dml.no_fill(), line=dml.ln(fill=dml.no_fill()))
        return dml.add_sp(shapes, sppr, name=name, textbox=True, txbody=dml.tx_body(paragraphs, body=body))

    def text(self, shapes, x, y, w, h, text, role="BODY", size=12, *, name="Text", align=None, anchor="t",
             wrap=True, **kwargs):
        body = dml.body_pr(anchor=anchor, wrap=wrap)
        return self.textbox(shapes, x, y, w, h, [self.para(text, role, size, align=align, **kwargs)], name=name,
                            body=body)

    def caption(self, shapes, x, y, w, text, size=9, align="ctr"):
        """A small one-line BODY caption (feature names under the sample they describe)."""
        body = dml.body_pr(anchor="t", wrap=False, insets=(0, 0, 0, 0))
        return self.textbox(shapes, x, y, w, size * 1.6, [self.para(text, "BODY", size, align=align,
                                                                      color="404040")],
                            name=f"Caption {text}", body=body)

    # --- slides and manifest ------------------------------------------------------------------------------------

    def slide(self, section, features, hidden=False, smoke=False, *, title=None, layout=None, title_color="1F1F1F",
              known_bitmap_text=False):
        """Add a slide to `section` (on the Blank layout, or on `layout` with its placeholders not copied onto the
        slide); returns the python-pptx Slide.

        known_bitmap_text: the slide deliberately holds text that PowerPoint's PDF export draws as a bitmap (text in
        a font it does not embed); the manifest says so (`knownBitmapText`) and text-based checks skip the slide."""
        if not _SLUG.match(section):
            raise ValueError(f"section must be a slug (letters, digits and hyphens, the first one lowercase): {section!r}")
        if not features or not all(isinstance(f, str) and f for f in features):
            raise ValueError("every slide needs a non-empty list of feature strings")
        self._per_section[section] += 1
        slide_id = f"{self.id_prefix}/{section}/{self._per_section[section]:02d}"
        slide = self.prs.slides.add_slide(layout or self._blank)
        for placeholder in slide.shapes._spTree.xpath("./p:sp[p:nvSpPr/p:nvPr/p:ph]"):
            placeholder.getparent().remove(placeholder)  # python-pptx copies the layout's title/body placeholders
        if hidden:
            slide._element.set("show", "0")
        if title:
            self.text(slide.shapes, 24, 12, self.width - 48, 36, title, "HEAD", 20, name=TITLE_NAME,
                      color=title_color, anchor="ctr", wrap=False)
        body = dml.body_pr(anchor="b", wrap=False, insets=(0, 0, 0, 0))
        self.textbox(slide.shapes, 8, self.height - 20, 360, 14,
                     [self.para(slide_id, "BODY", LABEL_SIZE_PT, color="595959", lang="en-US")],
                     name=LABEL_NAME, body=body)
        self._entries.append({
            "n": len(self._entries) + 1,
            "section": section,
            "id": slide_id,
            "features": list(features),
            "hidden": bool(hidden),
            "smoke": bool(smoke),
            "knownBitmapText": bool(known_bitmap_text),
        })
        return slide

    def keep_only(self, predicate):
        """Drop every slide whose manifest entry `predicate(entry)` rejects (see drop_slides)."""
        self.drop_slides([entry["id"] for entry in self._entries if not predicate(entry)])

    def drop_slides(self, ids):
        """Remove the slides with these ids, before the deck is saved: their parts (charts, pictures, embedded
        workbooks) are not written, the remaining slides keep their ids and labels, and the manifest entries are
        renumbered (`n` is the position in this deck; the id is the key). Raises ValueError for an unknown id or
        when no slide would be left."""
        ids = set(ids)
        known = {entry["id"] for entry in self._entries}
        if ids - known:
            raise ValueError(f"no such slide id(s): {sorted(ids - known)}")
        if ids == known:
            raise ValueError("no slide would be left")
        id_list = self.prs.slides._sldIdLst
        for sld_id, entry in zip(list(id_list), self._entries, strict=True):
            if entry["id"] in ids:
                self.prs.part.drop_rel(sld_id.rId)
                id_list.remove(sld_id)
        self.prs.part.rename_slide_parts([sld_id.rId for sld_id in id_list])  # slide1.xml .. slideN.xml again
        self._entries = [entry for entry in self._entries if entry["id"] not in ids]
        for n, entry in enumerate(self._entries, 1):
            entry["n"] = n

    def exclude(self, feature, reason):
        """Record a feature the atlas cannot author (manifest `excluded`)."""
        self.excluded.append({"feature": feature, "reason": reason})

    def manifest(self):
        """The manifest; each slide's features are the declared ones plus a `prstGeom:` per drawn preset."""
        slides = []
        for entry, slide in zip(self._entries, self.prs.slides, strict=True):
            features = list(entry["features"])
            features += [f for f in (f"prstGeom:{p}" for p in drawn_presets(slide._element)) if f not in features]
            slides.append(dict(entry, features=features))
        return {
            "deck": self.deck,
            "fonts": self.fonts,
            "slideSize": list(self.size_pt),
            "slides": slides,
            "excluded": [dict(item) for item in self.excluded],
        }

    def save(self, path):
        """Write the .pptx (labels raised to the top of every slide) and make it byte-stable."""
        for slide in self.prs.slides:
            tree = slide.shapes._spTree
            for label in [sp for sp in tree.iterchildren(qn("p:sp")) if sp.xpath("./p:nvSpPr/p:cNvPr/@name") ==
                          [LABEL_NAME]]:
                tree.remove(label)
                tree.insert_element_before(label, "p:extLst")
        self._update_app_properties()
        self.prs.save(str(path))
        normalize_pptx(path)
        return path

    # --- template clean-up ------------------------------------------------------------------------------------

    def _rescale_master_and_layouts(self, sx, sy):
        """python-pptx's template is 4:3; move and size the master/layout placeholders to the new slide size."""
        if sx == 1 and sy == 1:
            return
        for part in [self.prs.slide_master, *self.prs.slide_layouts]:
            element = part._element
            for off in element.xpath(".//a:xfrm/a:off | .//a:xfrm/a:chOff"):
                off.set("x", str(int(round(int(off.get("x")) * sx))))
                off.set("y", str(int(round(int(off.get("y")) * sy))))
            for ext in element.xpath(".//a:xfrm/a:ext | .//a:xfrm/a:chExt"):
                ext.set("cx", str(int(round(int(ext.get("cx")) * sx))))
                ext.set("cy", str(int(round(int(ext.get("cy")) * sy))))

    def _set_theme_fonts(self):
        """Theme major font = HEAD, minor font = BODY for latin, ea and cs; drop the per-script fallbacks."""
        theme = self.prs.slide_master.part.part_related_by(RT.THEME)
        root = etree.fromstring(theme.blob)
        scheme = root.find(f".//{{{_A}}}fontScheme")
        scheme.set("name", f"deckback {self.fonts}")
        for tag, role in (("majorFont", "HEAD"), ("minorFont", "BODY")):
            collection = scheme.find(f"{{{_A}}}{tag}")
            for child in list(collection):
                name = etree.QName(child).localname
                if name == "font":
                    collection.remove(child)
                elif name in ("latin", "ea", "cs"):
                    child.attrib.clear()
                    child.set("typeface", self.roles[role].family)
        theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

    def set_theme_colors(self, colors):
        """Set colour-scheme slots of the theme: colors = {'accent1': 'RRGGBB', ...}, written as srgbClr. For a deck
        that re-creates another deck's theme colours (the probe), so table styles, shape-style colours and chart
        series resolve as they did there."""
        theme = self.prs.slide_master.part.part_related_by(RT.THEME)
        root = etree.fromstring(theme.blob)
        scheme = root.find(f".//{{{_A}}}clrScheme")
        for name, value in colors.items():
            slot = scheme.find(f"{{{_A}}}{name}")
            if slot is None:
                raise ValueError(f"not a theme colour slot: {name!r}")
            for child in list(slot):
                slot.remove(child)
            etree.SubElement(slot, f"{{{_A}}}srgbClr", val=dml._hex(value))
        theme._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

    def _set_bullet_fonts(self):
        """The template's bullets name Arial; use the BODY family instead."""
        for part in [self.prs.slide_master, *self.prs.slide_layouts]:
            for bu_font in part._element.xpath(".//a:buFont"):
                bu_font.attrib.clear()
                bu_font.set("typeface", self.roles["BODY"].family)

    def _update_app_properties(self):
        """docProps/app.xml: the presentation format of the actual slide size and the actual slide counts."""
        part = next(p for p in self.prs.part.package.iter_parts() if str(p.partname) == APP_PART)
        root = etree.fromstring(part.blob)
        values = {
            "PresentationFormat": self._size_format,
            "Slides": str(len(self._entries)),
            "HiddenSlides": str(sum(entry["hidden"] for entry in self._entries)),
        }
        for tag, value in values.items():
            element = root.find(f"{{{_EP}}}{tag}")
            if element is not None:
                element.text = value
        part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)

    def _set_core_properties(self):
        props = self.prs.core_properties
        props.title = f"{CORE_TITLE}: {self.deck}"
        props.author = CORE_AUTHOR
        props.last_modified_by = CORE_AUTHOR
        props.comments = "generated by harness/atlas (python-pptx)"
        props.subject = ""
        props.keywords = ""
        props.category = ""
        props.revision = 1
        props.created = FIXED_DATETIME
        props.modified = FIXED_DATETIME
