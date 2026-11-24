"""Facts about one slide of a .pptx that the structural checks S1-S6 compare (harness/fidelity/structural.py).

    slide_facts(pptx, index) -> SlideFacts     # index: 0-based slide index
    split_fills(pptx) -> [[{"boxes", "rgb", "alpha"}, ...], ...]   # S7: per page of the std export, the split shapes

Geometry is in points in the slide frame (origin top-left, y down; 1 pt = 12700 EMU). What the slide paints comes, in
z-order, from its background, then the master's shapes, the layout's shapes and the slide's own shapes: PowerPoint
draws the non-placeholder shapes of the layout and of the master on the slide (placeholders of a layout or a master
are prompts, never drawn), unless the slide says ``showMasterSp="0"`` (both hidden) or the layout does (the master's
hidden). SlideFacts fields:

* ``index``, ``slide_count`` (every slide of the deck; S5 compares it with the page count).
* ``size_emu``: (cx, cy) of ``p:sldSz``; ``size_pt`` the same in points.
* ``background``: ``{"source": "slide" | "layout" | "master", "fill": <fill>}`` of the first ``p:bg`` of the slide,
  else its layout, else its master (``p:bgPr`` fill or ``p:bgRef`` through the theme), ``None`` without any.
* ``pictures``: [bbox] of every bitmap drawn on the slide (M1-R45): a stretched background ``a:blipFill`` (the whole
  slide), and every ``p:pic`` and every shape filled with a stretched ``a:blipFill``, of the master, the layout and
  the slide. The bbox is the region the bitmap is stretched to: the frame inset by ``a:stretch/a:fillRect``. A
  *tiled* picture fill (``a:tile``) is not a picture: PowerPoint exports it as a tiling pattern, so it is a pattern
  fill (M1-R42).
* ``shapes``: [{name, bbox, bbox_kind, geom, open, fill, line, line_w, dash}] for everything that paints a fill or a
  visible line: every ``p:sp`` and ``p:cxnSp`` with a fill or a line; every ``p:pic`` with an outline (``a:ln``) or
  a tiled fill; and every cell of a native table (``a:tbl``) with a fill, and every visible cell border, as entries
  of their own named ``<table> r<row>c<col>`` / ``<table> r<row>c<col> <side>`` at the cell's bbox (M1-R45; see
  Tables). A text box with neither fill nor line (a text-only box) paints nothing and is not a shape; charts are not
  shapes.
  * ``fill``: ``None`` (no fill), ``{"kind": "solid", "rgb": [r, g, b], "alpha": a}``, ``{"kind": "grad"}``,
    ``{"kind": "blip", "tiled": bool, "fill_rect": (l, t, r, b) | None}`` or ``{"kind": "pattern"}``.
  * ``line``: ``None`` (no line, or ``a:noFill``) or ``{"kind", "rgb", "alpha", "width", "dash", "join",
    "miter_limit", "cap"}``; ``line_w`` (pt) and ``dash`` (``prstDash`` value, ``"custom"`` or ``"solid"``) repeat
    width and dash. ``join`` is ``"round"``, ``"bevel"`` or ``"miter"`` from ``a:ln``, else from the theme line
    style, else ``"round"``: PowerPoint joins round when neither says (measured: its PDF export writes ``1 j`` then).
    ``miter_limit`` is a miter join's ``lim`` / 100000, and 8 for an ``a:miter`` without ``lim``: ECMA-376 gives
    that attribute no default, and PowerPoint exports ``<a:miter/>`` with ``8 M``, as it does ``lim="800000"``
    (measured on an acute triangle: its miter tip stops at 8 x w/2 past the vertex); ``None`` for other joins.
    ``cap`` is ``"flat"``, ``"rnd"`` or ``"sq"`` from ``a:ln@cap``, else from the theme line style, else ``"flat"``:
    PowerPoint ends a line flat when neither says (measured: the gradient connectors of atlas lines/11 have no cap
    anywhere, and their exported outlines end at the end points). A table border reads its own line element only.
  * ``bbox`` / ``bbox_kind`` (M1-R47): the box S3 compares, where M1 can compute it from the geometry. ``"path"``:
    the box of all the path points of a ``a:custGeom``, Bezier control points included (as MuPDF's
    ``fz_bound_path``; an ``a:arcTo`` counts as the Bezier curves of at most 90 degrees each that approximate it),
    and of the two end points of the ``line`` and ``straightConnector1`` presets (one segment from the frame's
    top-left to its bottom-right corner), through the frame, ``rot`` and flips. ``"frame"``: the box of the ``rect``
    preset's four corners through the frame, ``rot`` and flips (also used for a shape without geometry and for a
    custGeom whose coordinates are guide names). ``"preset"``: any other preset, turned or not. Its path box is not
    computed in M1 (preset geometry is plan 3's), so ``bbox`` is only the box of its turned frame, shown in
    details, and S3 does not check its position.
  * ``geom``: the geometry as written: ``"custGeom"``, the ``prstGeom`` preset's name (``"rect"``, ``"line"``, ...), or
    ``None`` (no geometry element, and a table cell or border).
  * ``open``: every subpath of the geometry is one open segment (the line presets, a custGeom of such subpaths, a
    table border), so its stroke has no join (M1-R48).
  * ``ends``: some subpath of the geometry is open (``open`` shapes, and a custGeom with a subpath that draws a
    segment and has no ``a:close``), so its stroke has ends drawn with the line's cap.
  * ``fill_paths``: for a custGeom with a fill, the box of each of its ``a:path``s that fills (its ``fill`` is not
    ``none``) and draws (two points or more), in path order, control points included and through the frame, ``rot``
    and flips as ``bbox``; ``None`` for any other shape, and where a coordinate is a guide name. PowerPoint fills each
    ``a:path`` on its own (0001 M0-5) and exports one fill per ``a:path``: the writer splits a nonzero fill so
    (passes/fillrule.ts), and S7 counts the fills of such a shape as one paint (``split_fills``; M3-R55, M4 Task 4).
  Fill and line come from ``p:spPr``, else from the shape style (``p:style`` ``a:fillRef`` / ``a:lnRef``) through the
  theme's format scheme, else there are none. ``a:grpFill`` takes the group's fill.
* ``runs``: [{text, size, color, typeface_latin, typeface_ea, typeface_cs, typeface_sym, bold, italic, shape}] for every ``a:r``
  and ``a:fld`` of every shape and table cell, in z-order, then paragraph and run order (``typeface_*``: the run's
  ``a:latin`` / ``a:ea`` / ``a:cs``, theme references resolved; ``color`` unresolved for text that is not a solid
  colour, with ``no_fill`` true for ``a:noFill`` text, M3-R46). A paragraph's bullet or number is a run
  of its own before the paragraph's runs, because PowerPoint exports it as glyphs of the text layer: ``a:buChar``
  gives its character, ``a:buAutoNum`` its label (arabic, alpha and roman schemes; one counter per paragraph level,
  continued by the next paragraph at that level with the same scheme, ended by an unnumbered one, and restarted at
  ``startAt`` for every level deeper than a paragraph's own), sized by ``buSzPct`` / ``buSzPts``, coloured by
  ``buClr`` and set in ``buFont``, otherwise like the paragraph's first run. An empty paragraph gets none. A
  numbering scheme not computed here gives a run with empty text and ``"unresolved"`` set (S2 fails on it).
* ``text_gradients``: [{name, bbox, size}] for every ``p:sp`` whose text has a run filled with an ``a:gradFill``
  (M5 Task 3 writes a PDF shading in a glyph clip so): ``bbox`` is the box of its turned frame, as a ``rect``'s, and
  ``size`` the largest size of its runs (0 when none is known). S3 matches such a box to the PDF's shadings of its
  glyphs (M5-R7).
* ``order``: [name] of every leaf shape (``sp``, ``cxnSp``, ``pic``, ``graphicFrame``) drawn on the slide, in z-order
  (master, layout, then the slide; document order, groups flattened; the group containers are not listed).
* ``typefaces``: every ``a:latin`` / ``a:ea`` typeface of the slide part and of its runs (theme references resolved).

Colours. ``a:srgbClr`` is read directly; ``a:schemeClr`` is resolved through the colour map (slide, else layout
override, else master ``p:clrMap``) and the theme's colour scheme; ``a:sysClr`` uses its ``lastClr``; ``phClr`` takes
the colour of the style reference. ``a:alpha`` (per 100000) is the alpha. Any other colour transform (``lumMod``,
``shade``, ``tint``, ...) and any other colour model is not computed: such a colour is
``{"rgb": None, "alpha": None, "unresolved": "<why>"}`` and the checks fail on it ("unresolved colour") instead of
guessing.

Text properties of a run come from the first source that sets them: the run's ``a:rPr``; the shape's ``a:lstStyle``
for the paragraph level; the shape style's ``a:fontRef`` (colour, theme font); then, for a placeholder, the layout
and master placeholders' list styles and the master's ``p:txStyles`` (title, body or other style), and for any other
shape the presentation's ``p:defaultTextStyle``. Bold and italic default to off; a size or colour no source sets is
``None`` / unresolved. Table cell text only uses explicit properties: its bold and italic are ``None`` (unresolved)
when not explicit, unless the table has no table style or the empty built-in "No Style, No Grid".

Tables (M1-R45). The cell grid is the frame's offset plus the ``a:gridCol`` widths and the ``a:tr`` heights; a cell
spans ``gridSpan`` columns and ``rowSpan`` rows, and the cells it covers (``hMerge`` / ``vMerge``) draw nothing of
their own. A cell's fill is its ``a:tcPr`` fill; its borders are its ``a:lnL`` / ``a:lnR`` / ``a:lnT`` / ``a:lnB``
(segments of the cell's edges, an edge two cells give alike counted once) and ``a:lnTlToBr`` / ``a:lnBlToTr``
(diagonals: the cell's bbox). Table styles are not resolved: what the cell does not set itself comes from the table
style, so under any style but "No Style, No Grid" (or none) an unset fill or border is a paint with an unresolved
colour ("table style ... not resolved") and S3 fails on it instead of guessing. The model is fail-closed where it
differs from PowerPoint's export (rows that grow to fit their text, border segments PowerPoint joins).

Geometry: ``a:off`` / ``a:ext`` with ``rot``, ``flipH`` and ``flipV``, through every enclosing group's
``chOff`` / ``chExt`` mapping. A placeholder without its own ``a:xfrm`` takes the layout's, else the master's; a shape
without any has ``bbox`` ``None``. Hidden shapes (``hidden="1"``) are listed in ``order`` only.

Errors: every failure to read the deck is a ``FactsError`` (harness/fidelity/errors.py) whose message names no file
and no path.
"""

import hashlib
import io
import math
import re
import zipfile
from dataclasses import dataclass, field
from math import cos, radians, sin
from pathlib import Path

from lxml import etree
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT

from harness.fidelity.errors import FactsError

__all__ = ["FactsError", "SlideFacts", "slide_facts", "split_fills"]

EMU_PER_PT = 12700

A = "http://schemas.openxmlformats.org/drawingml/2006/main"
P = "http://schemas.openxmlformats.org/presentationml/2006/main"
MC = "http://schemas.openxmlformats.org/markup-compatibility/2006"
NS = {"a": A, "p": P, "mc": MC}

COLOUR_TAGS = ("srgbClr", "schemeClr", "sysClr", "prstClr", "hslClr", "scrgbClr")
FILL_TAGS = ("noFill", "solidFill", "gradFill", "blipFill", "pattFill", "grpFill")
GRADIENT_TEXT = "text gradFill"  # the unresolved colour of a run filled with an a:gradFill
LEAF_TAGS = ("sp", "cxnSp", "pic", "graphicFrame")
TITLE_TYPES = ("title", "ctrTitle")
BODY_TYPES = ("body", "subTitle", "obj", None)
LINE_PRESETS = ("line", "straightConnector1")  # one segment from the frame's top-left to its bottom-right (M1-R47)
LINE_JOINS = ("round", "bevel", "miter")
DEFAULT_JOIN = "round"  # no join in a:ln nor in the theme line: PowerPoint joins round (measured, "1 j")
DEFAULT_MITER_LIMIT = 8.0  # a:miter without lim: no default in ECMA-376; PowerPoint exports "8 M" (measured)
LINE_CAPS = ("flat", "rnd", "sq")
DEFAULT_CAP = "flat"  # no cap in a:ln nor in the theme line: PowerPoint ends the line flat (measured, atlas lines/11)
SEGMENT_TAGS = ("lnTo", "cubicBezTo", "quadBezTo", "arcTo")
NO_STYLE_NO_GRID = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"  # PowerPoint's empty built-in table style
BORDER_SIDES = (("lnL", "left"), ("lnR", "right"), ("lnT", "top"), ("lnB", "bottom"), ("lnTlToBr", "diagonal down"),
                ("lnBlToTr", "diagonal up"))


@dataclass
class SlideFacts:
    index: int
    slide_count: int
    size_emu: tuple
    size_pt: tuple
    pictures: list = field(default_factory=list)
    shapes: list = field(default_factory=list)
    runs: list = field(default_factory=list)
    text_gradients: list = field(default_factory=list)
    order: list = field(default_factory=list)
    typefaces: list = field(default_factory=list)
    background: dict = None


def _local(el):
    return etree.QName(el).localname


def _a(tag):
    return f"{{{A}}}{tag}"


def _p(tag):
    return f"{{{P}}}{tag}"


def _truthy(value):
    return value in ("1", "true", "on")


def unresolved(reason):
    return {"rgb": None, "alpha": None, "unresolved": reason}


AUTONUM = re.compile(r"^(arabic|alphaLc|alphaUc|romanLc|romanUc)(Period|ParenR|ParenBoth|Plain)$")
ROMAN = ((1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"),
         (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i"))


def autonumber(scheme, number):
    """The label PowerPoint draws for number `number` of an a:buAutoNum scheme ("arabicPeriod", 3 -> "3."); None
    for a scheme not computed here (only arabic / alpha / roman with Period, ParenR, ParenBoth or Plain)."""
    found = AUTONUM.match(scheme or "")
    if not found or number < 1:
        return None
    family, punctuation = found.groups()
    if family == "arabic":
        label = str(number)
    elif family.startswith("alpha"):
        label = chr(ord("a") + (number - 1) % 26) * ((number - 1) // 26 + 1)
    else:
        label, rest = "", number
        for value, letters in ROMAN:
            while rest >= value:
                label += letters
                rest -= value
    if family.endswith("Uc"):
        label = label.upper()
    return {"Period": f"{label}.", "ParenR": f"{label})", "ParenBoth": f"({label})", "Plain": label}[punctuation]


# ---- theme ------------------------------------------------------------------------------------------------------


class Theme:
    """Colour scheme, colour map, format scheme and font scheme of a slide's theme."""

    def __init__(self, theme_xml, clr_map):
        self.colours = {}
        scheme = theme_xml.find(f".//{_a('clrScheme')}")
        if scheme is not None:
            for child in scheme:
                self.colours[_local(child)] = child[0] if len(child) else None
        self.clr_map = dict(clr_map)
        fmt = theme_xml.find(f".//{_a('fmtScheme')}")

        def styles(tag):
            node = fmt.find(_a(tag)) if fmt is not None else None
            return list(node) if node is not None else []

        self.fill_styles = styles("fillStyleLst")
        self.bg_fill_styles = styles("bgFillStyleLst")
        self.line_styles = styles("lnStyleLst")
        self.fonts = {}
        for major, prefix in (("majorFont", "+mj"), ("minorFont", "+mn")):
            node = theme_xml.find(f".//{_a('fontScheme')}/{_a(major)}")
            if node is None:
                continue
            for script, suffix in (("latin", "lt"), ("ea", "ea"), ("cs", "cs")):
                el = node.find(_a(script))
                self.fonts[f"{prefix}-{suffix}"] = (el.get("typeface") or None) if el is not None else None

    def fill_style(self, idx):
        if 1 <= idx <= 999 and idx <= len(self.fill_styles):
            return self.fill_styles[idx - 1]
        if idx >= 1001 and idx - 1000 <= len(self.bg_fill_styles):
            return self.bg_fill_styles[idx - 1001]
        return None

    def line_style(self, idx):
        if 1 <= idx <= len(self.line_styles):
            return self.line_styles[idx - 1]
        return None

    def typeface(self, name):
        """A typeface attribute with theme references (+mn-lt, +mj-ea, ...) resolved; None if empty."""
        if not name:
            return None
        if name.startswith("+"):
            return self.fonts.get(name)
        return name


def _colour_child(el):
    if el is None:
        return None
    for child in el:
        if _local(child) in COLOUR_TAGS:
            return child
    return None


def resolve_colour(el, theme, ph=None, depth=0):
    """{"rgb": [r, g, b], "alpha": a} of a colour element, or unresolved(...)."""
    if el is None or depth > 4:
        return unresolved("no colour")
    tag = _local(el)
    own_alpha = None
    for child in el:
        name = _local(child)
        if name == "alpha":
            own_alpha = int(child.get("val", "100000")) / 100000
        else:
            return unresolved(f"colour transform {name}")
    if tag == "srgbClr":
        value = el.get("val", "")
        try:
            rgb = [int(value[i:i + 2], 16) for i in (0, 2, 4)]
        except ValueError:
            return unresolved("bad srgbClr")
        return {"rgb": rgb, "alpha": 1.0 if own_alpha is None else own_alpha}
    if tag == "sysClr":
        last = el.get("lastClr")
        if not last:
            return unresolved("sysClr without lastClr")
        return {"rgb": [int(last[i:i + 2], 16) for i in (0, 2, 4)], "alpha": 1.0 if own_alpha is None else own_alpha}
    if tag == "schemeClr":
        value = el.get("val")
        if value == "phClr":
            if ph is None:
                return unresolved("phClr without a style colour")
            base = resolve_colour(ph, theme, None, depth + 1)
        else:
            target = theme.colours.get(theme.clr_map.get(value, value))
            if target is None:
                return unresolved(f"scheme colour {value}")
            base = resolve_colour(target, theme, None, depth + 1)
        if base["rgb"] is None:
            return base
        return {"rgb": base["rgb"], "alpha": base["alpha"] if own_alpha is None else own_alpha}
    return unresolved(f"{tag} colour")


def _fill_element(parent):
    if parent is None:
        return None
    for child in parent:
        if _local(child) in FILL_TAGS:
            return child
    return None


def blip_fill(el):
    """{"kind": "blip", "tiled", "fill_rect"} of an a:blipFill / p:blipFill: tiled with a:tile, else stretched into
    the frame inset by a:stretch/a:fillRect (l, t, r, b as fractions of the frame; None for the whole frame)."""
    tiled = el.find(_a("tile")) is not None
    rect = el.find(f"{_a('stretch')}/{_a('fillRect')}")
    fill_rect = None
    if not tiled and rect is not None and any(rect.get(k) for k in ("l", "t", "r", "b")):
        try:
            fill_rect = tuple(int(rect.get(k, "0")) / 100000 for k in ("l", "t", "r", "b"))
        except ValueError:
            fill_rect = None
    return {"kind": "blip", "tiled": tiled, "fill_rect": fill_rect}


def _fill_from(el, theme, ph=None, group_fill=None):
    tag = _local(el)
    if tag == "noFill":
        return None
    if tag == "solidFill":
        colour = resolve_colour(_colour_child(el), theme, ph)
        return {"kind": "solid", **colour}
    if tag == "gradFill":
        return {"kind": "grad"}
    if tag == "blipFill":
        return blip_fill(el)
    if tag == "pattFill":
        return {"kind": "pattern"}
    if tag == "grpFill":
        return group_fill
    return None


def shape_fill(sp_pr, style, theme, group_fill=None):
    el = _fill_element(sp_pr)
    if el is not None:
        return _fill_from(el, theme, None, group_fill)
    ref = style.find(_a("fillRef")) if style is not None else None
    if ref is None:
        return None
    idx = int(ref.get("idx", "0"))
    if idx == 0:
        return None
    entry = theme.fill_style(idx)
    if entry is None:
        return {"kind": "solid", **unresolved(f"fillRef {idx} not in the theme")}
    return _fill_from(entry, theme, _colour_child(ref), group_fill)


def shape_line(sp_pr, style, theme):
    ln = sp_pr.find(_a("ln")) if sp_pr is not None else None
    ref = style.find(_a("lnRef")) if style is not None else None
    theme_ln, ph = None, None
    if ref is not None:
        idx = int(ref.get("idx", "0"))
        ph = _colour_child(ref)
        if idx > 0:
            theme_ln = theme.line_style(idx)
    fill_el = _fill_element(ln)
    if fill_el is not None:
        fill = _fill_from(fill_el, theme, None)
    elif theme_ln is not None and _fill_element(theme_ln) is not None:
        fill = _fill_from(_fill_element(theme_ln), theme, ph)
    else:
        fill = None
    if fill is None:
        return None
    width = None
    for source in (ln, theme_ln):
        if source is not None and source.get("w") is not None:
            width = int(source.get("w")) / EMU_PER_PT
            break
    dash = "solid"
    for source in (ln, theme_ln):
        if source is None:
            continue
        if source.find(_a("custDash")) is not None:
            dash = "custom"
            break
        prst = source.find(_a("prstDash"))
        if prst is not None:
            dash = prst.get("val", "solid")
            break
    join, miter_limit = line_join((ln, theme_ln))
    line = {"kind": fill["kind"], "rgb": fill.get("rgb"), "alpha": fill.get("alpha"), "width": width, "dash": dash,
            "join": join, "miter_limit": miter_limit, "cap": line_cap((ln, theme_ln))}
    if fill.get("rgb") is None:
        line["unresolved"] = fill.get("unresolved") or f"{fill['kind']} line"
    return line


def line_cap(sources):
    """The ``cap`` of the first of `sources` (a:ln elements or None) that sets one; DEFAULT_CAP without any."""
    for source in sources:
        if source is not None and source.get("cap") in LINE_CAPS:
            return source.get("cap")
    return DEFAULT_CAP


def line_join(sources):
    """(join, miter_limit) of the first of `sources` (a:ln elements or None) with a join element; (DEFAULT_JOIN,
    None) without any. A miter's limit is lim / 100000, DEFAULT_MITER_LIMIT without (or with an unreadable) lim."""
    for source in sources:
        if source is None:
            continue
        for child in source:
            join = _local(child)
            if join not in LINE_JOINS:
                continue
            if join != "miter":
                return join, None
            try:
                return join, int(child.get("lim")) / 100000
            except (TypeError, ValueError):
                return join, DEFAULT_MITER_LIMIT
    return DEFAULT_JOIN, None


# ---- geometry -----------------------------------------------------------------------------------------------------

IDENTITY = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)


def _mul(m1, m2):
    """m1 after m2; a matrix (a, b, c, d, e, f) maps (x, y) to (a x + c y + e, b x + d y + f)."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (a1 * a2 + c1 * b2, b1 * a2 + d1 * b2, a1 * c2 + c1 * d2, b1 * c2 + d1 * d2,
            a1 * e2 + c1 * f2 + e1, b1 * e2 + d1 * f2 + f1)


def _xfrm_parts(xfrm):
    off, ext = xfrm.find(_a("off")), xfrm.find(_a("ext"))
    if off is None or ext is None:
        return None
    return (int(off.get("x", "0")), int(off.get("y", "0")), int(ext.get("cx", "0")), int(ext.get("cy", "0")),
            int(xfrm.get("rot", "0")) / 60000, _truthy(xfrm.get("flipH")), _truthy(xfrm.get("flipV")))


def _box_matrix(parts):
    """Local box (0..cx, 0..cy) -> parent space: flip and rotate (clockwise, y down) about the centre, then move."""
    x, y, cx, cy, rot, flip_h, flip_v = parts
    hx, hy = cx / 2, cy / 2
    r = radians(rot)
    rotate = (cos(r), sin(r), -sin(r), cos(r), 0.0, 0.0)
    flip = (-1.0 if flip_h else 1.0, 0.0, 0.0, -1.0 if flip_v else 1.0, 0.0, 0.0)
    m = _mul(rotate, _mul(flip, (1.0, 0.0, 0.0, 1.0, -hx, -hy)))
    return _mul((1.0, 0.0, 0.0, 1.0, x + hx, y + hy), m)


def _group_matrix(xfrm):
    """Child space of a group -> its parent space."""
    parts = _xfrm_parts(xfrm) if xfrm is not None else None
    if parts is None:
        return IDENTITY
    ch_off, ch_ext = xfrm.find(_a("chOff")), xfrm.find(_a("chExt"))
    cx, cy = parts[2], parts[3]
    ox = int(ch_off.get("x", "0")) if ch_off is not None else 0
    oy = int(ch_off.get("y", "0")) if ch_off is not None else 0
    ccx = int(ch_ext.get("cx", "0")) if ch_ext is not None else 0
    ccy = int(ch_ext.get("cy", "0")) if ch_ext is not None else 0
    sx = cx / ccx if ccx else 1.0
    sy = cy / ccy if ccy else 1.0
    return _mul(_box_matrix(parts), (sx, 0.0, 0.0, sy, -ox * sx, -oy * sy))


def _points_bbox(m, points):
    """Axis-aligned box, in points, of local EMU `points` mapped by matrix `m`."""
    xs = [m[0] * px + m[2] * py + m[4] for px, py in points]
    ys = [m[1] * px + m[3] * py + m[5] for px, py in points]
    return [min(xs) / EMU_PER_PT, min(ys) / EMU_PER_PT, max(xs) / EMU_PER_PT, max(ys) / EMU_PER_PT]


def _bbox(matrix, parts, inset=None, grow=0.0):
    """Box of a shape's frame, or of the part of it inset by `inset` (l, t, r, b fractions: a:fillRect), or of the
    frame grown by `grow` EMU on every side (in the shape's own frame, before its rotation)."""
    cx, cy = parts[2], parts[3]
    x0, y0, x1, y1 = -grow, -grow, cx + grow, cy + grow
    if inset is not None:
        left, top, right, bottom = inset
        x0, x1 = left * cx, cx - right * cx
        y0, y1 = top * cy, cy - bottom * cy
    return _points_bbox(_mul(matrix, _box_matrix(parts)), ((x0, y0), (x1, y0), (x0, y1), (x1, y1)))


def _number(value):
    """A custGeom coordinate: an integer literal, else None (guide names are not evaluated)."""
    try:
        return float(int(value))
    except (TypeError, ValueError):
        return None


def _arc_points(start, w_r, h_r, st_ang, sw_ang):
    """The Bezier points (control points included) of a DrawingML a:arcTo from `start`, and its end point.

    The angles are DrawingML's (degrees, clockwise in the y-down frame) and visual: the point at angle a lies on the
    ellipse in direction a from its centre, i.e. at the ellipse parameter atan2(wR sin a, hR cos a). The arc is cut
    into pieces of at most 90 degrees of parameter, each a cubic Bezier with the usual 4/3 tan(t/4) handles."""
    def parameter(angle):
        return math.atan2(w_r * math.sin(angle), h_r * math.cos(angle))

    a0, sweep = math.radians(st_ang), math.radians(sw_ang)
    t0 = parameter(a0)
    if abs(sweep) >= 2 * math.pi - 1e-9:
        dt = sweep
    else:
        dt = parameter(a0 + sweep) - t0
        if sweep > 0 and dt < 0:
            dt += 2 * math.pi
        elif sweep < 0 and dt > 0:
            dt -= 2 * math.pi
    cx, cy = start[0] - w_r * math.cos(t0), start[1] - h_r * math.sin(t0)
    pieces = max(1, math.ceil(abs(dt) / (math.pi / 2) - 1e-9))
    points, step = [], dt / pieces
    for i in range(pieces):
        ta, tb = t0 + i * step, t0 + (i + 1) * step
        k = 4 / 3 * math.tan((tb - ta) / 4)
        p0 = (cx + w_r * math.cos(ta), cy + h_r * math.sin(ta))
        p3 = (cx + w_r * math.cos(tb), cy + h_r * math.sin(tb))
        points += [(p0[0] - k * w_r * math.sin(ta), p0[1] + k * h_r * math.cos(ta)),
                   (p3[0] + k * w_r * math.sin(tb), p3[1] - k * h_r * math.cos(tb)), p3]
    end = (cx + w_r * math.cos(t0 + dt), cy + h_r * math.sin(t0 + dt))
    return points, end


def _path_points(path, cx, cy):
    """Every point of one a:path in the shape's local EMU box (control points included), or None when a coordinate is
    not a number (a guide name)."""
    w, h = _number(path.get("w", "0")), _number(path.get("h", "0"))
    if w is None or h is None:
        return None
    sx, sy = (cx / w if w else 1.0), (cy / h if h else 1.0)
    local, current = [], (0.0, 0.0)
    for command in path:
        tag = _local(command)
        if tag in ("moveTo", "lnTo", "cubicBezTo", "quadBezTo"):
            for pt in command.findall(_a("pt")):
                x, y = _number(pt.get("x")), _number(pt.get("y"))
                if x is None or y is None:
                    return None
                current = (x, y)
                local.append(current)
        elif tag == "arcTo":
            values = [_number(command.get(k)) for k in ("wR", "hR", "stAng", "swAng")]
            if any(v is None for v in values):
                return None
            arc, current = _arc_points(current, values[0], values[1], values[2] / 60000, values[3] / 60000)
            local += arc
    return [(x * sx, y * sy) for x, y in local]


def custgeom_points(cust, cx, cy):
    """Every point of an a:custGeom's paths in the shape's local EMU box (control points included), or None when a
    coordinate is not a number (a guide name) or there is no point."""
    points = []
    for path in cust.iterfind("a:pathLst/a:path", NS):
        local = _path_points(path, cx, cy)
        if local is None:
            return None
        points += local
    return points or None


def custgeom_fill_paths(cust, cx, cy):
    """The points of each a:path of an a:custGeom that fills (its ``fill`` is not ``none``) and draws (two points or
    more), in path order, each in the shape's local EMU box (control points included); None when a coordinate is not a
    number (a guide name)."""
    out = []
    for path in cust.iterfind("a:pathLst/a:path", NS):
        if path.get("fill") == "none":
            continue
        local = _path_points(path, cx, cy)
        if local is None:
            return None
        if len(local) >= 2:
            out.append(local)
    return out


def custgeom_open(cust):
    """Whether every subpath of an a:custGeom is one open segment (no a:close, one lnTo / cubicBezTo / quadBezTo /
    arcTo after its moveTo): its stroke then has no join (M1-R48)."""
    for path in cust.iterfind("a:pathLst/a:path", NS):
        segments = 0
        for command in path:
            tag = _local(command)
            if tag == "moveTo":
                segments = 0
            elif tag == "close":
                return False
            elif tag in SEGMENT_TAGS:
                segments += 1
                if segments > 1:
                    return False
    return True


def custgeom_ends(cust):
    """Whether an a:custGeom has an open subpath (one that draws a segment and is not ended by a:close): its stroke
    then has two ends, drawn with the line's cap."""
    for path in cust.iterfind("a:pathLst/a:path", NS):
        drawn = 0  # segments of the current subpath
        for command in path:
            tag = _local(command)
            if tag == "moveTo" and drawn:
                return True  # the subpath before it ended open
            if tag == "close":
                drawn = 0
            elif tag in SEGMENT_TAGS:
                drawn += 1
        if drawn:
            return True
    return False


# ---- placeholders -------------------------------------------------------------------------------------------------


def _ph_of(el):
    for path in ("p:nvSpPr/p:nvPr/p:ph", "p:nvPicPr/p:nvPr/p:ph", "p:nvGraphicFramePr/p:nvPr/p:ph",
                 "p:nvCxnSpPr/p:nvPr/p:ph"):
        found = el.find(path, NS)
        if found is not None:
            return found
    return None


def _matching_placeholder(ph, tree):
    """The shape of a layout or master spTree that the placeholder `ph` inherits from (idx, else type)."""
    if tree is None:
        return None
    idx, kind = ph.get("idx"), ph.get("type")
    by_type = None
    for el in tree.iter(_p("sp"), _p("pic")):
        other = _ph_of(el)
        if other is None:
            continue
        if idx is not None and other.get("idx") == idx:
            return el
        if by_type is None and (other.get("type") or "body") == (kind or "body"):
            by_type = el
    return by_type


# ---- run text as PowerPoint draws it ------------------------------------------------------------------------------

SMALL_CAPS_SCALE = 0.8  # PowerPoint draws small capitals at 80 % of the size (19.2 pt for 24 pt in the atlas)
HYPERLINK_COLOUR = "{http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor}hlinkClr"


def _hyperlink_colour(rpr):
    """Whether a run is drawn in the theme's hyperlink colour: it has an a:hlinkClick, and that link does not say
    hlinkClr val="tx" (Office's extension to keep the text colour)."""
    link = rpr.find(_a("hlinkClick")) if rpr is not None else None
    if link is None:
        return False
    keep = link.find(f".//{HYPERLINK_COLOUR}")
    return keep is None or keep.get("val") != "tx"


def _capitalised(run, cap):
    """The run as PowerPoint draws it under rPr@cap: "all" in capitals; "small" with every lower-case letter as a
    capital at SMALL_CAPS_SCALE of the size (so split into runs of one size each)."""
    if cap == "all":
        return [{**run, "text": run["text"].upper()}]
    if cap != "small" or not run["text"]:
        return [run]
    out, current, lower = [], "", None
    for char in run["text"]:
        is_lower = char != char.upper()
        if current and is_lower != lower:
            out.append((current, lower))
            current = ""
        current, lower = current + (char.upper() if is_lower else char), is_lower
    out.append((current, lower))
    size = run["size"]
    return [{**run, "text": part, "size": size * SMALL_CAPS_SCALE if small and size is not None else size}
            for part, small in out]


# ---- the slide walk -----------------------------------------------------------------------------------------------


class _Slide:
    def __init__(self, prs, index):
        self.prs = prs
        slide = prs.slides[index]
        self.slide_el = slide._element
        layout = slide.slide_layout
        master = layout.slide_master
        self.layout_tree = layout._element.find("p:cSld/p:spTree", NS)
        self.master_tree = master._element.find("p:cSld/p:spTree", NS)
        self.master_el = master._element
        clr_map = dict(master._element.find(_p("clrMap")).attrib) if master._element.find(_p("clrMap")) is not None \
            else {}
        for el in (layout._element, self.slide_el):
            override = el.find("p:clrMapOvr/a:overrideClrMapping", NS)
            if override is not None:
                clr_map = dict(override.attrib)
        theme_xml = etree.fromstring(master.part.part_related_by(RT.THEME).blob)
        self.theme = Theme(theme_xml, clr_map)
        self.default_text = prs.part._element.find(_p("defaultTextStyle"))
        self.layout_el = layout._element
        self.table_style_default = self._table_style_default(prs)
        self.pictures, self.shapes, self.runs, self.order = [], [], [], []
        self.text_gradients = []

    @staticmethod
    def _table_style_default(prs):
        """The `def` table style of ppt/tableStyles.xml (what a table without a:tableStyleId gets), or None."""
        try:
            part = prs.part.part_related_by(RT.TABLE_STYLES)
            return etree.fromstring(part.blob).get("def")
        except Exception:  # no tableStyles part
            return None

    # -- what the slide paints besides its own shapes --

    def background(self):
        """{"source", "fill"} of the first p:bg of the slide, its layout, its master; None without any."""
        for element, source in ((self.slide_el, "slide"), (self.layout_el, "layout"), (self.master_el, "master")):
            bg = element.find("p:cSld/p:bg", NS)
            if bg is None:
                continue
            bg_pr, bg_ref = bg.find(_p("bgPr")), bg.find(_p("bgRef"))
            fill = None
            if bg_pr is not None:
                el = _fill_element(bg_pr)
                fill = _fill_from(el, self.theme) if el is not None else None
            elif bg_ref is not None:
                idx = int(bg_ref.get("idx", "0"))
                entry = self.theme.fill_style(idx) if idx else None
                if entry is not None:
                    fill = _fill_from(entry, self.theme, _colour_child(bg_ref))
                elif idx:
                    fill = {"kind": "solid", **unresolved(f"bgRef {idx} not in the theme")}
            return {"source": source, "fill": fill}
        return None

    def background_trees(self):
        """The spTrees whose non-placeholder shapes the slide shows under its own: master, then layout."""
        if self.slide_el.get("showMasterSp") in ("0", "false"):
            return []
        trees = [self.layout_tree]
        if self.layout_el.get("showMasterSp") not in ("0", "false"):
            trees.insert(0, self.master_tree)
        return [tree for tree in trees if tree is not None]

    # -- text --

    def _rpr_source(self, el):
        """The text properties an rPr / defRPr element sets (None where it sets nothing)."""
        if el is None:
            return None
        fill = _fill_element(el)
        latin, ea, cs, sym = (el.find(_a("latin")), el.find(_a("ea")), el.find(_a("cs")), el.find(_a("sym")))
        return {"sz": el.get("sz"), "b": el.get("b"), "i": el.get("i"), "colour": fill, "cap": el.get("cap"),
                "latin": latin.get("typeface") if latin is not None else None,
                "ea": ea.get("typeface") if ea is not None else None,
                "cs": cs.get("typeface") if cs is not None else None,
                "sym": sym.get("typeface") if sym is not None else None}

    def _font_ref_source(self, style):
        ref = style.find(_a("fontRef")) if style is not None else None
        if ref is None:
            return None
        idx = ref.get("idx")
        prefix = {"major": "+mj", "minor": "+mn"}.get(idx)
        colour = _colour_child(ref)
        return {"sz": None, "b": None, "i": None, "colour": colour,
                "latin": f"{prefix}-lt" if prefix else None, "ea": f"{prefix}-ea" if prefix else None,
                "cs": f"{prefix}-cs" if prefix else None}

    @staticmethod
    def _level_ppr(list_style, level):
        if list_style is None:
            return None
        return list_style.find(f"a:lvl{level + 1}pPr", NS)

    def _inherited_pprs(self, shape_el, level, table):
        """The level's paragraph properties a paragraph inherits after its own shape's list style."""
        if table:
            return []
        ph = _ph_of(shape_el) if shape_el is not None else None
        if ph is None:
            out = [self._level_ppr(self.default_text, level)]
            if self.default_text is not None:
                out.append(self.default_text.find(_a("defPPr")))
            return out
        out = []
        for tree in (self.layout_tree, self.master_tree):
            match = _matching_placeholder(ph, tree)
            if match is not None:
                out.append(self._level_ppr(match.find("p:txBody/a:lstStyle", NS), level))
        kind = ph.get("type")
        style = "titleStyle" if kind in TITLE_TYPES else ("bodyStyle" if kind in BODY_TYPES else "otherStyle")
        out.append(self._level_ppr(self.master_el.find(f"p:txStyles/p:{style}", NS), level))
        return out

    def _bullet_run(self, pprs, level, counters, first, name):
        """The run PowerPoint draws for a paragraph's bullet or number (None if it has none); updates `counters`."""
        def first_of(tags):
            for ppr in pprs:
                if ppr is None:
                    continue
                for child in ppr:
                    if _local(child) in tags:
                        return child
            return None

        for deeper in [lvl for lvl in counters if lvl > level]:
            del counters[deeper]
        kind = first_of(("buNone", "buChar", "buAutoNum", "buBlip"))
        if kind is None or _local(kind) != "buAutoNum":
            counters.pop(level, None)  # an unnumbered paragraph ends the numbering at its level
        if kind is None or _local(kind) in ("buNone", "buBlip"):
            return None  # a picture bullet is an image paint, not text
        run = dict(first)
        run["shape"] = name
        if _local(kind) == "buChar":
            run["text"] = kind.get("char", "")
        else:
            scheme = kind.get("type", "")
            previous = counters.get(level)
            count = previous[1] + 1 if previous and previous[0] == scheme else int(kind.get("startAt", "1"))
            counters[level] = (scheme, count)
            run["text"] = autonumber(scheme, count)
            if run["text"] is None:
                return {**run, "text": "", "unresolved": f"bullet numbering {scheme} not computed"}
        size = first_of(("buSzTx", "buSzPct", "buSzPts"))
        if size is not None and _local(size) == "buSzPct" and first["size"] is not None:
            run["size"] = first["size"] * int(size.get("val", "100000")) / 100000
        elif size is not None and _local(size) == "buSzPts":
            run["size"] = int(size.get("val", "0")) / 100
        colour = first_of(("buClrTx", "buClr"))
        if colour is not None and _local(colour) == "buClr":
            run["color"] = resolve_colour(_colour_child(colour), self.theme)
        font = first_of(("buFontTx", "buFont"))
        if font is not None and _local(font) == "buFont":
            typeface = self.theme.typeface(font.get("typeface"))
            run["typeface_latin"] = run["typeface_ea"] = run["typeface_cs"] = typeface
        return run

    def _resolve_run(self, sources, table):
        def first(key):
            for source in sources:
                if source is not None and source.get(key) is not None:
                    return source[key]
            return None

        size = first("sz")
        colour_el = first("colour")
        if colour_el is None:
            colour = unresolved("no text colour")
        elif _local(colour_el) in COLOUR_TAGS:  # fontRef colour
            colour = resolve_colour(colour_el, self.theme)
        elif _local(colour_el) == "solidFill":
            colour = resolve_colour(_colour_child(colour_el), self.theme)
        elif _local(colour_el) == "noFill":  # text painted in no way: no colour, and S2 knows it (M3-R46)
            colour = {**unresolved("text noFill"), "no_fill": True}
        else:
            colour = unresolved(f"text {_local(colour_el)}")  # GRADIENT_TEXT for a:gradFill
        bold, italic = first("b"), first("i")
        default = None if table == "styled" else False  # a table style may set them: unknown
        return {"size": int(size) / 100 if size is not None else None,
                "color": colour,
                "typeface_latin": self.theme.typeface(first("latin")),
                "typeface_ea": self.theme.typeface(first("ea")),
                "typeface_cs": self.theme.typeface(first("cs")),
                "typeface_sym": self.theme.typeface(first("sym")),  # the font of the run's symbol characters (M8)
                "bold": _truthy(bold) if bold is not None else default,
                "italic": _truthy(italic) if italic is not None else default}

    def _text(self, tx_body, name, shape_el=None, style=None, table=False):
        if tx_body is None:
            return
        list_style = tx_body.find(_a("lstStyle"))
        font_ref = self._font_ref_source(style)
        counters = {}  # paragraph level -> (numbering scheme, last number)
        for paragraph in tx_body.findall(_a("p")):
            ppr = paragraph.find(_a("pPr"))
            level = int(ppr.get("lvl", "0")) if ppr is not None else 0
            inherited = [self._level_ppr(list_style, level)] + self._inherited_pprs(shape_el, level, table)
            tail = [self._rpr_source(inherited[0].find(_a("defRPr")) if inherited[0] is not None else None),
                    font_ref]
            tail += [self._rpr_source(p.find(_a("defRPr")) if p is not None else None) for p in inherited[1:]]
            runs, drawn = [], []
            for run in paragraph:
                if _local(run) not in ("r", "fld"):
                    continue
                t = run.find(_a("t"))
                rpr = run.find(_a("rPr"))
                sources = [self._rpr_source(rpr)] + tail
                props = self._resolve_run(sources, table)
                if _hyperlink_colour(rpr):  # PowerPoint draws a hyperlink in the theme's hyperlink colour
                    props["color"] = resolve_colour(etree.Element(_a("schemeClr"), val="hlink"), self.theme)
                cap = next((s["cap"] for s in sources if s is not None and s.get("cap")), None)
                runs.append({"text": (t.text or "") if t is not None else "", **props, "shape": name})
                drawn += _capitalised(runs[-1], cap)
            texted = [r for r in runs if r["text"]]
            if texted:  # PowerPoint draws no bullet or number on an empty paragraph
                bullet = self._bullet_run([ppr] + inherited, level, counters, texted[0], name)
                if bullet is not None:
                    self.runs.append(bullet)
            self.runs.extend(drawn)

    # -- shapes --

    def _xfrm_of(self, el, sp_pr):
        xfrm = sp_pr.find(_a("xfrm")) if sp_pr is not None else None
        if xfrm is None and _local(el) == "graphicFrame":
            xfrm = el.find(_p("xfrm"))
        if xfrm is None:
            ph = _ph_of(el)
            if ph is not None:
                for tree in (self.layout_tree, self.master_tree):
                    match = _matching_placeholder(ph, tree)
                    found = match.find("p:spPr/a:xfrm", NS) if match is not None else None
                    if found is not None:
                        xfrm = found
                        break
        return _xfrm_parts(xfrm) if xfrm is not None else None

    def _add_shape(self, name, bbox, bbox_kind, fill, line, open_path=False, ends=False, geom=None, fill_paths=None):
        self.shapes.append({"name": name, "bbox": bbox, "bbox_kind": bbox_kind, "geom": geom, "open": open_path,
                            "ends": open_path or ends, "fill": fill, "line": line,
                            "line_w": line["width"] if line else None, "dash": line["dash"] if line else None,
                            "fill_paths": fill_paths})

    @staticmethod
    def _fill_paths(sp_pr, matrix, parts, fill):
        """``fill_paths`` of a shape (see the module docstring): the box of each a:path of its custGeom that fills."""
        cust = sp_pr.find(_a("custGeom")) if sp_pr is not None else None
        if fill is None or cust is None or parts is None:
            return None
        paths = custgeom_fill_paths(cust, parts[2], parts[3])
        if paths is None:
            return None
        to_slide = _mul(matrix, _box_matrix(parts))
        return [_points_bbox(to_slide, points) for points in paths]

    @staticmethod
    def _geometry_name(sp_pr):
        """``"custGeom"``, the preset's name, or None for a shape without a geometry element (``geom``)."""
        if sp_pr is None:
            return None
        if sp_pr.find(_a("custGeom")) is not None:
            return "custGeom"
        preset = sp_pr.find(_a("prstGeom"))
        return preset.get("prst") if preset is not None else None

    def _geometry_bbox(self, sp_pr, matrix, parts):
        """(bbox, bbox_kind, open, ends) of a shape from its geometry (M1-R47, R48; see the module docstring)."""
        if parts is None:
            return None, "frame", False, False
        to_slide = _mul(matrix, _box_matrix(parts))
        cust = sp_pr.find(_a("custGeom")) if sp_pr is not None else None
        if cust is not None:
            points = custgeom_points(cust, parts[2], parts[3])
            if points is not None:
                return _points_bbox(to_slide, points), "path", custgeom_open(cust), custgeom_ends(cust)
            return _bbox(matrix, parts), "frame", False, False
        preset = sp_pr.find(_a("prstGeom")) if sp_pr is not None else None
        name = preset.get("prst") if preset is not None else None
        if name in LINE_PRESETS:
            return _points_bbox(to_slide, ((0, 0), (parts[2], parts[3]))), "path", True, True
        if name is None or name == "rect":
            return _bbox(matrix, parts), "frame", False, False
        return _bbox(matrix, parts), "preset", False, False

    def _picture(self, el, name, matrix, parts):
        """A p:pic: a picture (stretched) or a pattern fill (tiled), plus its outline as a line."""
        sp_pr = el.find(_p("spPr"))
        blip = el.find(_p("blipFill"))
        fill = blip_fill(blip) if blip is not None else None
        bbox, bbox_kind, open_path, ends = self._geometry_bbox(sp_pr, matrix, parts)
        if fill is not None and not fill["tiled"]:
            self.pictures.append(_bbox(matrix, parts, fill["fill_rect"]) if parts is not None else None)
        line = shape_line(sp_pr, el.find(_p("style")), self.theme)
        pattern = fill if fill is not None and fill["tiled"] else None
        geom = self._geometry_name(sp_pr)
        if pattern is not None:
            self._add_shape(name, bbox, bbox_kind, pattern, None, open_path, ends, geom)
        if line is not None:
            # PowerPoint strokes a picture's outline outside the picture: its path is the frame grown by half the
            # line width (a shape's outline is centred on its path instead)
            if parts is not None and line["width"] and bbox_kind == "frame":
                bbox = _bbox(matrix, parts, grow=line["width"] * EMU_PER_PT / 2)
            self._add_shape(name, bbox, bbox_kind, None, line, open_path, ends, geom)

    def _table_cells(self, tbl, name, matrix, parts):
        """Cell fills and visible cell borders of a native table as shapes (M1-R45), and the cells' text."""
        style_el = tbl.find("a:tblPr/a:tableStyleId", NS)
        style_id = (style_el.text or "").strip() if style_el is not None else self.table_style_default
        plain = style_id in (None, "", NO_STYLE_NO_GRID)
        widths = [int(col.get("w", "0")) for col in tbl.iterfind("a:tblGrid/a:gridCol", NS)]
        rows = tbl.findall(_a("tr"))
        heights = [int(row.get("h", "0")) for row in rows]
        xs = [sum(widths[:i]) for i in range(len(widths) + 1)]
        ys = [sum(heights[:i]) for i in range(len(heights) + 1)]
        origin = _mul(matrix, (1.0, 0.0, 0.0, 1.0, parts[0], parts[1])) if parts is not None else None
        edges = {}
        for r, row in enumerate(rows):
            for c, cell in enumerate(row.findall(_a("tc"))):
                self._text(cell.find(_a("txBody")), name, table="plain" if plain else "styled")
                if _truthy(cell.get("hMerge")) or _truthy(cell.get("vMerge")) or origin is None:
                    continue
                c1 = min(len(widths), c + max(1, int(cell.get("gridSpan", "1"))))
                r1 = min(len(heights), r + max(1, int(cell.get("rowSpan", "1"))))
                if c >= len(widths) or r >= len(heights):
                    continue
                x0, x1, y0, y1 = xs[c], xs[c1], ys[r], ys[r1]
                cell_name = f"{name} r{r + 1}c{c + 1}"
                box = _points_bbox(origin, ((x0, y0), (x1, y1)))
                tc_pr = cell.find(_a("tcPr"))
                fill_el = _fill_element(tc_pr)
                if fill_el is not None:
                    fill = _fill_from(fill_el, self.theme)
                elif plain:
                    fill = None
                else:
                    fill = {"kind": "solid", **unresolved("table style fill not resolved")}
                if fill is not None:
                    self._add_shape(cell_name, box, "frame", fill, None)
                segments = {"lnL": ((x0, y0), (x0, y1)), "lnR": ((x1, y0), (x1, y1)), "lnT": ((x0, y0), (x1, y0)),
                            "lnB": ((x0, y1), (x1, y1)), "lnTlToBr": ((x0, y0), (x1, y1)),
                            "lnBlToTr": ((x0, y1), (x1, y0))}
                for tag, side in BORDER_SIDES:
                    line = self._cell_border(tc_pr.find(_a(tag)) if tc_pr is not None else None, plain,
                                             diagonal=tag in ("lnTlToBr", "lnBlToTr"))
                    if line is None:
                        continue
                    seg = _points_bbox(origin, segments[tag])
                    key = (tuple(round(v, 3) for v in seg), tuple(line["rgb"] or ()), line["width"], line["dash"])
                    if key not in edges:  # an edge two cells give alike is one line
                        edges[key] = True
                        self._add_shape(f"{cell_name} {side}", seg, "frame", None, line, open_path=True)

    def _cell_border(self, ln, plain, diagonal):
        """The line of a cell border element (None: no visible line)."""
        join, miter_limit = line_join((ln,))
        cap = line_cap((ln,))
        if ln is None or _fill_element(ln) is None:
            if plain or (diagonal and ln is None):  # table styles draw no diagonals
                return None
            return {"kind": "solid", **unresolved("table style border not resolved"),
                    "width": int(ln.get("w")) / EMU_PER_PT if ln is not None and ln.get("w") else None,
                    "dash": "solid", "join": join, "miter_limit": miter_limit, "cap": cap}
        fill = _fill_from(_fill_element(ln), self.theme)
        if fill is None:
            return None
        width = int(ln.get("w")) / EMU_PER_PT if ln.get("w") is not None else None
        if width == 0:
            return None
        prst = ln.find(_a("prstDash"))
        dash = "custom" if ln.find(_a("custDash")) is not None else (prst.get("val", "solid") if prst is not None
                                                                      else "solid")
        line = {"kind": fill["kind"], "rgb": fill.get("rgb"), "alpha": fill.get("alpha"), "width": width,
                "dash": dash, "join": join, "miter_limit": miter_limit, "cap": cap}
        if fill.get("rgb") is None:
            line["unresolved"] = fill.get("unresolved") or f"{fill['kind']} line"
        return line

    def walk(self, tree, matrix=IDENTITY, group_fill=None, hidden=False, background=False):
        """Collect the leaf shapes of `tree` in document order; inside a hidden group only their names. With
        `background` (a layout's or master's tree) placeholders are skipped: they are never drawn on a slide."""
        for el in tree:
            tag = _local(el)
            if tag == "AlternateContent":
                branch = el.find("mc:Choice", NS)
                if branch is None:
                    branch = el.find("mc:Fallback", NS)
                if branch is not None:
                    self.walk(branch, matrix, group_fill, hidden, background)
                continue
            if tag == "grpSp":
                gpr = el.find(_p("grpSpPr"))
                xfrm = gpr.find(_a("xfrm")) if gpr is not None else None
                own_fill = _fill_element(gpr)
                fill = _fill_from(own_fill, self.theme, None, group_fill) if own_fill is not None else group_fill
                group_pr = el.find("p:nvGrpSpPr/p:cNvPr", NS)
                group_hidden = hidden or (group_pr is not None and _truthy(group_pr.get("hidden")))
                self.walk(el, _mul(matrix, _group_matrix(xfrm)), fill, group_hidden, background)
                continue
            if tag not in LEAF_TAGS or (background and _ph_of(el) is not None):
                continue
            c_nv_pr = el.find(".//p:cNvPr", NS)
            name = c_nv_pr.get("name", "") if c_nv_pr is not None else ""
            self.order.append(name)
            if hidden or (c_nv_pr is not None and _truthy(c_nv_pr.get("hidden"))):
                continue
            sp_pr = el.find(_p("spPr"))
            parts = self._xfrm_of(el, sp_pr)
            if tag == "pic":
                self._picture(el, name, matrix, parts)
                continue
            if tag == "graphicFrame":
                for tbl in el.iterfind(".//a:tbl", NS):
                    self._table_cells(tbl, name, matrix, parts)
                continue
            style = el.find(_p("style"))
            fill = shape_fill(sp_pr, style, self.theme, group_fill)
            line = shape_line(sp_pr, style, self.theme)
            bbox, bbox_kind, open_path, ends = self._geometry_bbox(sp_pr, matrix, parts)
            if fill is not None and fill["kind"] == "blip" and not fill["tiled"]:
                self.pictures.append(_bbox(matrix, parts, fill["fill_rect"]) if parts is not None else None)
            if fill is not None or line is not None:
                self._add_shape(name, bbox, bbox_kind, fill, line, open_path, ends, self._geometry_name(sp_pr),
                                self._fill_paths(sp_pr, matrix, parts, fill))
            if tag == "sp":
                first = len(self.runs)
                self._text(el.find(_p("txBody")), name, el, style)
                written = self.runs[first:]
                if any(r["color"].get("unresolved") == GRADIENT_TEXT for r in written):  # M5-R7
                    self.text_gradients.append({
                        "name": name, "bbox": _bbox(matrix, parts) if parts is not None else None,
                        "size": max((r["size"] for r in written if r["size"] is not None), default=0)})

    def typefaces(self):
        names = set()
        for tag in ("latin", "ea"):
            for el in self.slide_el.iter(_a(tag)):
                resolved = self.theme.typeface(el.get("typeface"))
                if resolved:
                    names.add(resolved)
        for run in self.runs:
            for key in ("typeface_latin", "typeface_ea"):
                if run[key]:
                    names.add(run[key])
        return sorted(names)


# The last deck opened, by the SHA-256 of its bytes: the fidelity run asks for the facts of every slide of a deck in
# turn, and python-pptx parses every part of the package on open, so opening it once per slide made a deck of N slides
# cost N opens (M8 Task 2: a 914-slide tier-B deck took hours and ~10 GB). The facts only read the presentation, never
# change it, so the parsed deck is reused while the file's bytes are the same. One deck is kept, never more.
_LAST_DECK = {}


def _open_deck(pptx):
    """The presentation at `pptx`, checked to be a readable zip package; FactsError (no path in it) otherwise. The
    deck last opened is reused when the file still has the same bytes (``_LAST_DECK``)."""
    path = Path(pptx)
    try:
        if not path.exists():
            raise FactsError("missing input: no such file")
        if not path.is_file():
            raise FactsError("missing input: a directory, not a file")
        if path.stat().st_size == 0:
            raise FactsError("empty input: the file has no bytes")
        if not zipfile.is_zipfile(path):
            raise FactsError("not a PPTX: the file is not a zip package (truncated or another format)")
        data = path.read_bytes()
    except OSError as exc:
        raise FactsError(f"unreadable input ({type(exc).__name__})") from None
    key = hashlib.sha256(data).hexdigest()
    if key in _LAST_DECK:
        return _LAST_DECK[key]
    try:
        prs = Presentation(io.BytesIO(data))
    except Exception as exc:  # python-pptx quotes the path in some messages: the type only
        raise FactsError(f"unreadable PPTX ({type(exc).__name__})") from None
    _LAST_DECK.clear()
    _LAST_DECK[key] = prs
    return prs


def _slide_facts(pptx, index):
    prs = _open_deck(pptx)
    count = len(prs.slides)
    if not isinstance(index, int) or not 0 <= index < count:
        shown = index if isinstance(index, int) else type(index).__name__
        raise FactsError(f"slide index out of range: {shown} (the deck has {count} slides)")
    walk = _Slide(prs, index)
    background = walk.background()
    fill = background["fill"] if background else None
    if fill is not None and fill["kind"] == "blip" and not fill["tiled"]:
        cx, cy = prs.slide_width, prs.slide_height
        if cx is not None and cy is not None:  # a stretched background picture covers the slide (M1-R45)
            walk.pictures.append(_bbox(IDENTITY, (0, 0, int(cx), int(cy), 0.0, False, False), fill["fill_rect"]))
    for tree in walk.background_trees():
        walk.walk(tree, background=True)
    walk.walk(walk.slide_el.find("p:cSld/p:spTree", NS))
    cx, cy = prs.slide_width, prs.slide_height
    size_emu = (int(cx), int(cy)) if cx is not None and cy is not None else None
    size_pt = (size_emu[0] / EMU_PER_PT, size_emu[1] / EMU_PER_PT) if size_emu else None
    return SlideFacts(index=index, slide_count=count, size_emu=size_emu, size_pt=size_pt, pictures=walk.pictures,
                      shapes=walk.shapes, runs=walk.runs, text_gradients=walk.text_gradients, order=walk.order,
                      typefaces=walk.typefaces(),
                      background=background)


def slide_facts(pptx, index):
    """Facts of slide `index` (0-based) of the deck at `pptx`; see the module docstring. Raises FactsError only."""
    try:
        return _slide_facts(pptx, index)
    except FactsError as exc:
        raise FactsError(str(exc)) from None
    except Exception as exc:  # a malformed part: the type only, its text may quote a path
        raise FactsError(f"unreadable PPTX slide ({type(exc).__name__})") from None


def _split_fills(pptx):
    prs = _open_deck(pptx)
    out = []
    for index, slide in enumerate(prs.slides):
        if slide._element.get("show") in ("0", "false"):
            continue  # a hidden slide is no page of the std export
        walk = _Slide(prs, index)
        for tree in walk.background_trees():
            walk.walk(tree, background=True)
        walk.walk(walk.slide_el.find("p:cSld/p:spTree", NS))
        out.append([{"boxes": shape["fill_paths"], "rgb": shape["fill"].get("rgb"), "alpha": shape["fill"].get("alpha")}
                    for shape in walk.shapes
                    if shape["fill_paths"] is not None and len(shape["fill_paths"]) >= 2
                    and (shape["fill"] or {}).get("kind") == "solid"])
    return out


def split_fills(pptx):
    """S7's record of the writer's split fills (M3-R55, M4 Task 4): for every slide the std export has as a page (the
    slides that are not hidden, in order), each shape it draws with a solid fill and two or more ``a:path``s that fill,
    in z-order (master, layout, then the slide), as ``{"boxes": <its fill_paths>, "rgb": [r, g, b] | None, "alpha"}``
    (its fill's colour, None where it could not be resolved). PowerPoint exports such a shape as one fill per
    ``a:path``, each of the shape's colour (a gradient, picture or pattern fill comes back as shades, images or
    patterns, which are not joined). Opens the deck once. Raises FactsError only."""
    try:
        return _split_fills(pptx)
    except FactsError as exc:
        raise FactsError(str(exc)) from None
    except Exception as exc:  # a malformed part: the type only, its text may quote a path
        raise FactsError(f"unreadable PPTX slide ({type(exc).__name__})") from None
