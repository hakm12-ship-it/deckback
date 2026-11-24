#!/usr/bin/env python
"""PyMuPDF paint/glyph inventory oracle.

Runs MuPDF's page interpreter against a custom device and prints one
``Inventory`` JSON document on stdout. The TypeScript walker must reproduce
this inventory within 0.05 pt, so this file defines the ground truth.

    harness/.venv/Scripts/python harness/oracle/mupdf_inventory.py <pdf> [--pages 1,2]

``--pages`` takes 1-based page numbers (default: all pages). In the output,
``pages[].index`` is the 0-based page index (contract §2 page index).

Inventory contract: docs/decisions/0002-inventory-contract.md states it in
full; "§n" below cites its sections. In short:

* Geometry is in points, slide frame (origin top-left, y down, page /Rotate and
  CropBox offset applied). MuPDF's page transform already gives this frame.
  Numbers are rounded to 3 decimals.
* ``paints`` are in paint order: ``fill``, ``stroke``, ``shade``, ``image``,
  ``pattern``. Clip-only paths are not paints. A fill+stroke operator yields a
  ``fill`` then a ``stroke`` paint.
* Path bbox is ``fz_bound_path(path, NULL, ctm)``: strokes are NOT expanded by
  the line width, and curves are bounded by their control points (that is what
  ``fz_bound_path`` does), not by their tight extents (§4 path bbox).
* ``fill`` and ``stroke`` carry ``path``, the segments of the ``fz_path`` in the
  slide frame (§14 path geometry); ``stroke`` also carries ``line``, its line
  style, with width, dash and phase in slide-frame points (§15 line style).
  ``inventory(..., detail=False)`` leaves both out: the fidelity harness reads
  neither and does not pay for walking every path.
* ``rgb`` is sRGB 0-255 (integers) for fill/stroke and for an image that is a
  stencil (an image mask: the fill colour it paints with), ``null`` for
  shade/pattern and for any other image.
* ``shade`` and ``pattern`` bbox is the current clip: the intersection of all
  active clip bboxes, clipped to the page (§5 shade bbox); MuPDF has just
  pushed the painted shape as a clip (for a stroke, ``clip_stroke_path`` with
  the stroke's bounds, §15). ``image`` bbox is the unit square under ctm.
* An ``image`` also carries ``ctm`` (the unit square's matrix, in the PDF's own
  orientation: MuPDF hands it over with the y axis flipped, and the oracle flips it
  back), ``px`` (the width and height of the ``fz_image``) and ``stencil``; a
  ``shade`` its ``shading`` kind: ``function``, ``axial``, ``radial`` or ``mesh``
  (§16 images and shadings). ``inventory(..., detail=False)`` leaves these out.
* Every paint also carries its ``clip`` (the clip stack below, without the
  soft-mask areas, and for an image without its own soft mask), its
  ``groupAlpha`` (the product of the alphas of the open groups), its ``blend``
  (the first blend mode that is not normal, from the innermost group outward:
  MuPDF opens a group for a paint's own blend mode) and ``masked`` (a soft-mask
  area is on the clip stack); each glyph its ``groupAlpha`` (§17).
  ``inventory(..., detail=False)`` leaves these out.
* The oracle never sets ``approx`` or ``clipApprox``: only the walker marks its
  approximate text-clip boxes (§5).
* ``glyphs`` are glyph origins on the baseline, one per text item. Whitespace
  glyphs are kept in the output (comparisons drop them on both sides; §8
  whitespace). Each also has its state (§6 glyphs): ``font`` (fz_font_name, 31
  bytes at most), ``size`` (the y axis of the span's trm under ctm), ``rgb`` and
  ``alpha`` (of its fill, else of its stroke), ``paint`` and ``wmode``; a glyph
  in a Type 3 font also has ``type3``, and its name is only MuPDF's.
* ``invisible`` is the text run with Tr 3 (``ignore_text``): ``u``, ``x``, ``y``,
  ``font`` and, for a Type 3 font, ``type3``.
* ``inventory(..., detail=False)`` leaves out all of these but ``u``, ``x`` and
  ``y``, and ``invisible`` altogether.

Clip stack (shade bboxes, §5): ``clip_path``, ``clip_stroke_path``,
``clip_text``, ``clip_stroke_text``, ``clip_image_mask`` and the masked area
reported at ``end_mask`` each push the intersection of their bbox with the
current clip; every ``pop_clip`` pops one entry. The bottom entry is the page
rectangle. An empty intersection is ``[0, 0, 0, 0]``.

Page content only (§3): the page is run with ``fz_run_page_contents``, so
annotations and form widgets are NOT part of the inventory (the walker uses
pdf.js ``AnnotationMode.DISABLE``).

Glyphs (§6): every text run drawn with a render mode other than 3 is reported
exactly once, i.e. Tr 0-2 and 4-7. MuPDF reports a run through ``fill_text``
and/or ``stroke_text``, but a run filled with a shading or tiling pattern, and
clip-only text (Tr 7, which MuPDF cannot tell apart from a pattern-filled run),
arrive only as ``clip_text``. So glyphs are emitted from ``fill_text`` and
``stroke_text``, and from ``clip_text``/``clip_stroke_text`` only for glyphs
not already emitted. Duplicates are recognised as follows:

* ``stroke_text`` of the same run as the preceding ``fill_text``/``clip_text``
  (Tr 2 and 6: same text object, same glyphs) is skipped, and so is a
  ``clip_stroke_text`` (the same stroke with a pattern). Different runs that
  merely follow each other (``0 Tr (A) Tj 1 Tr (B) Tj``) are both emitted.
* Modes 4-6 also send the whole BT..ET text as one accumulated ``clip_text``
  at ET; its glyphs match glyphs emitted before, each emitted glyph cancelling
  at most one clip glyph (same character at the same position).
* Invisible text (Tr 3, ``ignore_text``) is not a glyph: it goes to ``invisible``.

A glyph's ``paint``: ``fill_text`` is a fill, ``stroke_text`` a stroke, and the
stroke half of the run before it makes that run a ``fillStroke``. A run seen only
through ``clip_text`` is a ``clip`` (Tr 7), unless it is painted through at once:
a pattern fill is ``clip_text``, one shade or tile, ``pop_clip``, and nothing else
under that clip. (Tr 7 followed by one ``sh`` and then ``Q`` makes the same calls:
an oracle limit, §13.)

Type 3 fonts (§6): the content of a glyph is not page content. ``inventory``
replaces, in memory only, every glyph's content with an empty ``d1`` when it has
``detail`` (``mark_type3_glyphs``), so that MuPDF caches every glyph: otherwise a
``d0`` glyph in the inherited colour is drawn straight onto the page, and its text
comes as ``ignore_text``, which is not invisible text there.

Known limit (MuPDF text clips, §11): MuPDF sends the accumulated BT..ET text
clip only when the render mode in effect at ET is a clip mode (4-7). When the
block ends in mode 0-3, no ``clip_text`` arrives: the text clip is not applied
and the glyphs of its Tr 7 runs are lost (``BT 7 Tr (B) Tj 0 Tr (A) Tj ET``
reports only ``A``). The walker keeps the contract (every Tr other than 3 is a
glyph, and the clip applies at ET, as in the PDF spec and pdf.js), so such
blocks are an oracle limit, not a walker error.

Further rules:

* Paints and glyphs drawn *inside* a soft-mask definition (``begin_mask`` ..
  ``end_mask``) or a tiling-pattern cell are mask/pattern data, not page
  content, so they are not reported. The area MuPDF reports for a mask is the
  bounds of the masked object (slide frame), not the mask form's BBox; the
  walker pushes it for a ``sh`` whose shading has bounds of its own (§10
  soft-mask area).
* Whatever is filled or stroked with a tiling pattern (a path, an image mask,
  text) is one ``pattern`` paint (§9 mask and pattern contents). MuPDF pushes
  the shape as a clip and then draws the cell. When the filled area, seen in
  pattern space, is wider than XStep or taller than YStep, it draws the cell once into a tile
  (``begin_tile`` .. ``end_tile``). Otherwise it calls no ``begin_tile`` and
  draws the cell straight onto the page, once for every cell the area overlaps
  (1, 2 or 4; PowerPoint's picture fills use a cell as large as the picture).
  A device cannot tell such a cell from page content, so ``inventory`` first
  replaces, in memory only, every tiling pattern's cell content with a marker
  (``TILE_MARKER_CONTENT``). The paint is emitted at ``begin_tile`` or at the
  first marker of a directly drawn fill, and at most once per shape clip: the
  later markers of the same fill come while the same clip entry is on top.
  Nothing else of the cell remains to report. Cell content is never inventory,
  so the replacement changes nothing else; MuPDF's choice between tile and
  direct cells does not depend on it.
* A ``pattern`` paint's alpha: MuPDF does not pass one with the cell. When it
  fills or strokes a *path* with a tiling pattern under an alpha below 1, it wraps
  it in a group with that alpha, opened just before the shape clip; the
  oracle reads it there. For text and image masks MuPDF ignores the alpha
  and draws the pattern opaque, so the oracle reports 1 (§11, an oracle limit).
* Glyphs are not clip-culled: a glyph outside the current clip is still
  reported (MuPDF's own text extraction would drop it; §7 no clip culling).
* A paint's ``alpha`` is the alpha MuPDF passes with that paint; transparency
  group alpha is not folded in (§1 types): that is ``groupAlpha``. The group
  MuPDF opens only for a tiling fill's alpha is the paint's alpha, not a group.
* Optional content (§18) is MuPDF's own: what it hides it does not draw. It
  still sends the clips of hidden content, its Tr 3 text (``ignore_text``) and
  its text in a clip mode (``clip_text``), so those are reported as ever.
"""

import argparse
import collections
import json
import math
import re
import sys

import pymupdf
import pymupdf.mupdf as m

NDIGITS = 3
REPLACEMENT_CHAR = chr(0xFFFD)

# What every Type 3 glyph's content becomes before the page is run (see the module docstring).
TYPE3_GLYPH_CONTENT = b"0 0 0 0 0 0 d1"

# What every tiling pattern's cell content becomes before the page is run (see
# the module docstring): a marked-content span whose ActualText reaches the
# device as ``begin_metatext``, the one call a cell drawn onto the page makes.
TILE_MARKER = "deckback oracle: tiling pattern cell"
TILE_MARKER_CONTENT = b"/Span << /ActualText (" + TILE_MARKER.encode("ascii") + b") >> BDC EMC"


def r3(value):
    """Round to 3 decimals and normalise -0.0 to 0.0."""
    v = round(float(value), NDIGITS)
    return 0.0 if v == 0 else v


# fz_shade.type -> the kind a ``shade`` paint names (§16): FZ_FUNCTION_BASED, FZ_LINEAR, FZ_RADIAL, FZ_MESH_TYPE4 to 7.
SHADING_KINDS = {1: "function", 2: "axial", 3: "radial", 4: "mesh", 5: "mesh", 6: "mesh", 7: "mesh"}


def box_from_rect(rect):
    return (rect.x0, rect.y0, rect.x1, rect.y1)


def intersect(a, b):
    """Intersection of two (x0, y0, x1, y1) boxes; an empty result is (0, 0, 0, 0)."""
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[2], b[2]), min(a[3], b[3])
    if x1 < x0 or y1 < y0:
        return (0.0, 0.0, 0.0, 0.0)
    return (x0, y0, x1, y1)


def unit_square_bbox(ctm):
    """Bounding box of the unit square (0,0)-(1,1) transformed by ctm."""
    xs, ys = [], []
    for ux, uy in ((0, 0), (1, 0), (0, 1), (1, 1)):
        xs.append(ctm.a * ux + ctm.c * uy + ctm.e)
        ys.append(ctm.b * ux + ctm.d * uy + ctm.f)
    return (min(xs), min(ys), max(xs), max(ys))


def image_facts(image, ctm, stencil):
    """``ctm``, ``px`` and ``stencil`` of an image paint (§16 images and shadings).

    MuPDF hands the device the matrix of an image with the y axis flipped: its unit square starts at the image's top left
    corner and runs down. The PDF's unit square starts at the bottom left corner and runs up, which is what the walker has
    (pdf.js paints under the CTM as it is). The two differ by the flip (x, y) -> (x, 1 - y), and that is its own inverse:
    the oracle undoes it, so that the contract's matrix is the PDF's.
    """
    return {
        "ctm": [r3(v) for v in (ctm.a, ctm.b, -ctm.c, -ctm.d, ctm.c + ctm.e, ctm.d + ctm.f)],
        "px": [image.w, image.h],
        "stencil": stencil,
    }


def srgb255(colorspace, color, color_params):
    """Convert a MuPDF colour to sRGB, integers 0-255 (half-up rounding)."""
    r, g, b, _ = m.ll_fz_convert_color(colorspace, color, m.ll_fz_device_rgb(), None, color_params)
    return [min(255, max(0, int(v * 255 + 0.5))) for v in (r, g, b)]


def codepoint_to_str(ucs):
    if ucs < 0 or 0xD800 <= ucs <= 0xDFFF or ucs > 0x10FFFF:
        return REPLACEMENT_CHAR
    return chr(ucs)


def span_font_name(span):
    """fz_font_name. A PDF name need not be UTF-8, and MuPDF keeps 31 bytes of it, which may end inside a sequence (§13).

    SWIG hands such bytes over as lone surrogates, which the JSON on stdout could not encode: they become U+FFFD.
    """
    return m.ll_fz_font_name(span.font).encode("utf-8", "surrogateescape").decode("utf-8", "replace")


def span_facts(span, ctm):
    """What every glyph of an ``fz_text`` span shares (§6 glyphs); ``trm`` holds Tf, Tz and Tm, not the ctm."""
    trm = span.trm
    facts = {
        "font": span_font_name(span),
        "size": r3(math.hypot(trm.c * ctm.a + trm.d * ctm.c, trm.c * ctm.b + trm.d * ctm.d)),
        "wmode": span.wmode,
    }
    if span.font.t3procs:
        facts["type3"] = True
    return facts


def glyph_box(span, item, ctm):
    """The box of one glyph in the slide frame, ``[x0, y0, x1, y1]`` (MuPDF's fz_bound_glyph under the glyph's own text
    matrix and the ctm), or None for a glyph with no box (a space) or no gid."""
    try:
        trm = span.trm
        made = m.fz_make_matrix(trm.a, trm.b, trm.c, trm.d, item.x, item.y)
        matrix = m.ll_fz_concat(made.internal() if hasattr(made, "internal") else made, ctm)
        rect = m.ll_fz_bound_glyph(span.font, item.gid, matrix)
    except Exception:
        return None
    box = [r3(rect.x0), r3(rect.y0), r3(rect.x1), r3(rect.y1)]
    return box if all(abs(v) < 1e9 for v in box) and box[2] > box[0] and box[3] > box[1] else None


def text_glyphs(text, ctm, boxes=False):
    """Glyph origins of an ``fz_text`` run as ``(u, x, y)`` tuples (slide frame), and their spans' facts (one per glyph);
    with ``boxes`` each glyph's facts also hold its ``box`` (``glyph_box``; a glyph without one has none)."""
    glyphs = []
    facts = []
    run = m.FzText(m.ll_fz_keep_text(text))
    span = run.m_internal.head
    while span:
        items = m.FzTextSpan(span)
        shared = span_facts(span, ctm)
        for i in range(span.len):
            item = items.items(i)
            glyphs.append(
                (
                    codepoint_to_str(item.ucs),
                    r3(ctm.a * item.x + ctm.c * item.y + ctm.e),
                    r3(ctm.b * item.x + ctm.d * item.y + ctm.f),
                )
            )
            box = glyph_box(span, item, ctm) if boxes else None
            facts.append({**shared, "box": box} if box is not None else shared)
        span = span.next
    return glyphs, facts


class PathSegments(m.FzPathWalker2):
    """Reads an ``fz_path`` as ``PathSeg`` lists in the slide frame (§14 path geometry).

    With only these four callbacks, ``fz_walk_path`` expands rectto, quadto,
    curvetov and curvetoy into them. It must get ``m_internal`` for both the walker
    and its argument: the walker object itself crashes the process.
    """

    def __init__(self):
        super().__init__()
        self.use_virtual_moveto()
        self.use_virtual_lineto()
        self.use_virtual_curveto()
        self.use_virtual_closepath()
        self._ctm = None
        self._segments = []

    def _xy(self, x, y):
        ctm = self._ctm
        return r3(ctm.a * x + ctm.c * y + ctm.e), r3(ctm.b * x + ctm.d * y + ctm.f)

    def moveto(self, ctx, x, y):
        self._segments.append(["M", *self._xy(x, y)])

    def lineto(self, ctx, x, y):
        self._segments.append(["L", *self._xy(x, y)])

    def curveto(self, ctx, x1, y1, x2, y2, x3, y3):
        self._segments.append(["C", *self._xy(x1, y1), *self._xy(x2, y2), *self._xy(x3, y3)])

    def closepath(self, ctx):
        self._segments.append(["Z"])

    def walk(self, path, ctm):
        self._ctm = ctm
        self._segments = []
        m.ll_fz_walk_path(path, self.m_internal, self.m_internal)
        return self._segments


def line_style(stroke, ctm):
    """An ``fz_stroke_state`` as a ``LineInv``: width, dash and phase in slide-frame points (§15 line style)."""
    scale = math.sqrt(abs(ctm.a * ctm.d - ctm.b * ctm.c))
    return {
        "w": r3(stroke.linewidth * scale),
        "cap": stroke.start_cap,  # a PDF sets all three caps with one J
        "join": stroke.linejoin,
        "miter": r3(stroke.miterlimit),
        "dash": [r3(m.floats_getitem(stroke.dash_list, i) * scale) for i in range(stroke.dash_len)],
        "phase": r3(stroke.dash_phase * scale),
    }


class InventoryDevice(m.FzDevice2):
    """MuPDF device that records paints and glyphs instead of drawing them."""

    VIRTUALS = (
        "fill_path",
        "stroke_path",
        "clip_path",
        "clip_stroke_path",
        "fill_text",
        "stroke_text",
        "clip_text",
        "clip_stroke_text",
        "ignore_text",
        "fill_shade",
        "fill_image",
        "fill_image_mask",
        "clip_image_mask",
        "pop_clip",
        "begin_mask",
        "end_mask",
        "begin_tile",
        "end_tile",
        "begin_metatext",
        "begin_group",
        "end_group",
    )

    def __init__(self, page_box, detail=True, paths=False, glyph_sizes=False):
        super().__init__()
        self._glyph_sizes = glyph_sizes  # each glyph's size too, without ``detail`` (S7's M8-R5 box)
        for name in self.VIRTUALS:
            getattr(self, "use_virtual_" + name)()
        self.paints = []
        self.glyphs = []
        self.invisible = []
        self._detail = detail  # False: no glyph state and no invisible text
        # None: no path or line on the paints (``paths``: with them, the rest left as ``detail`` says)
        self._segments = PathSegments() if detail or paths else None
        # ``paths`` without ``detail``: each paint's groupAlpha too, and a shade's or pattern's clipPath (the path of the
        # innermost clip, when clip_path or clip_stroke_path pushed it) and clipStroke (the latter did)
        self._paths = paths and not detail
        # Stack of cumulative clip boxes; the bottom entry is the page itself.
        # Each entry also gets a serial number (_clip_ids), so that the cells of
        # one directly drawn tiling fill, which all come under the same shape
        # clip, yield one pattern paint (_tiled_clip: the entry that got it).
        # _paint_clips is the same stack without the soft-mask areas: the clip a
        # paint reports (§17). _clip_kinds says what pushed each entry: "clip",
        # "mask" (the area at end_mask) or "image" (clip_image_mask).
        self._clips = [tuple(page_box)]
        self._paint_clips = [tuple(page_box)]
        self._clip_kinds = ["page"]
        self._clip_geoms = [None]  # with ``paths``: (path, stroked) of each entry clip_path / clip_stroke_path pushed
        self._clip_ids = [0]
        self._clip_serial = 0
        self._tiled_clip = None
        self._hidden = 0  # >0 while inside a soft-mask definition or a pattern cell
        self._mask_areas = []
        # Open groups as (alpha, clip depth when opened, blend mode), for pattern alphas and §17.
        self._groups = []
        # Glyph de-duplication (see the module docstring): glyphs emitted so far
        # that a later clip run may still cancel, and the glyphs of the run whose
        # stroke_text may still follow (Tr 2 and 6).
        self._unmatched = collections.Counter()
        self._last_run = None
        # The glyph records of that run, whose paint its stroke half changes.
        self._last_records = []
        # A run so far seen only through clip_text or clip_stroke_text, and the depth of its clip: whether a
        # pattern paints through that clip decides what it was. Entries: records, depth, whether a paint came.
        self._through = None

    # -- helpers -----------------------------------------------------------

    @property
    def _recording(self):
        return self._hidden == 0

    def _push_clip(self, box, kind="clip", geom=None):
        self._clip_geoms.append(geom)
        self._clips.append(intersect(self._clips[-1], box))
        # A soft mask's area is the masked object's own bounds: it is no part of the clip a paint reports (§17).
        self._paint_clips.append(self._paint_clips[-1] if kind == "mask" else intersect(self._paint_clips[-1], box))
        self._clip_kinds.append(kind)
        self._clip_serial += 1
        self._clip_ids.append(self._clip_serial)

    def _group_alpha(self, own_group=False):
        """The product of the alphas of the open groups (§17); ``own_group``: without the innermost, the paint's own alpha."""
        product = 1.0
        for alpha, _depth, _blend in self._groups[:-1] if own_group else self._groups:
            product *= alpha
        return product

    def _blend(self):
        """The first blend mode that is not normal from the paint outward (§17). MuPDF opens a group for a paint's own mode."""
        for _alpha, _depth, blend in reversed(self._groups):
            if blend != 0:
                return m.fz_blendmode_name(blend).lower()
        return "normal"

    def _add_paint(self, kind, box, rgb, alpha, even_odd=False, clip=None, own_group=False):
        """The paint, or None when it is not page content.

        ``clip``: the clip it reports, if not the current one; ``own_group``: the innermost group is the paint's alpha (§9).
        """
        if not self._recording:
            return None
        if kind not in ("shade", "pattern") or not self._painted_through(alpha):
            self._through = None
        paint = {
            "kind": kind,
            "bbox": [r3(v) for v in box],
            "rgb": rgb,
            "alpha": r3(alpha),
            "evenOdd": bool(even_odd),
        }
        if self._detail:
            paint["clip"] = [r3(v) for v in (self._paint_clips[-1] if clip is None else clip)]
            paint["groupAlpha"] = r3(self._group_alpha(own_group))
            paint["blend"] = self._blend()
            paint["masked"] = "mask" in self._clip_kinds
        elif self._paths:
            paint["groupAlpha"] = r3(self._group_alpha(own_group))
            if kind in ("shade", "pattern") and self._clip_geoms[-1] is not None:
                paint["clipPath"], paint["clipStroke"] = self._clip_geoms[-1]
        self.paints.append(paint)
        return paint

    def _tiling_fill(self):
        """A tiling pattern is painted: one ``pattern`` paint, bounded by the clip (§9).

        MuPDF has just pushed the painted shape (path, text or image mask) as a
        clip, so the current clip is the shape's bbox intersected with the clip.
        A fill drawn as several direct cells calls this once per cell, all under
        that same clip entry: only the first one counts.
        """
        if self._clip_ids[-1] == self._tiled_clip:
            return
        self._tiled_clip = self._clip_ids[-1]
        self._add_paint("pattern", self._clips[-1], None, self._pattern_alpha(), own_group=self._pattern_group())

    def _painted_through(self, alpha):
        """A shade or tile just came. True when it is the first thing under the clip of the run in ``_through``."""
        through = self._through
        if through is None or through["depth"] != len(self._clips) or through["painted"]:
            return False
        through["painted"] = True
        through["alpha"] = alpha
        return True

    def _pattern_alpha(self):
        """The fill alpha of a tiling fill: that of the group MuPDF opened right before the shape clip, else 1.

        Real transparency groups (form XObjects) push their BBox as a clip after
        the group opens, so between them and a pattern there are two clips or more.
        """
        return self._groups[-1][0] if self._pattern_group() else 1.0

    def _pattern_group(self):
        """The innermost group was opened right before the shape clip of a tiling fill: its alpha is the fill's (§9).

        Its alpha is then the paint's own, and not a group alpha (§17). The page's own group, or one MuPDF opens for a blend
        mode or a knockout (fill and stroke in one), can be there instead: its alpha is 1, so that does not matter.
        """
        return bool(self._groups) and self._groups[-1][1] == len(self._clips) - 1

    def _emit_glyphs(self, glyphs, facts, paint, rgb, alpha):
        """Reports glyphs, in their run's state; returns their records."""
        self._unmatched.update(glyphs)
        records = []
        for (u, x, y), shared in zip(glyphs, facts):
            record = {"u": u, "x": x, "y": y}
            if self._glyph_sizes:
                record["size"] = shared["size"]
                if "box" in shared:
                    record["box"] = shared["box"]
            if self._detail:
                record.update({k: v for k, v in shared.items() if k != "box"})
                record.update(rgb=rgb, alpha=r3(alpha), groupAlpha=r3(self._group_alpha()), paint=paint)
            records.append(record)
        self.glyphs.extend(records)
        return records

    def _clip_run(self, text, ctm, paint, painted_as):
        """A clip_text/clip_stroke_text run: report only the glyphs not yet emitted.

        They are ``paint`` for now; ``painted_as`` if a pattern then paints through this clip (``pop_clip``).
        """
        glyphs, facts = text_glyphs(text, ctm, self._glyph_sizes)
        if not self._recording:
            return
        new = []
        new_facts = []
        for glyph, shared in zip(glyphs, facts):
            if self._unmatched[glyph] > 0:
                self._unmatched[glyph] -= 1  # already emitted by fill_text/stroke_text/an earlier clip run
            else:
                new.append(glyph)
                new_facts.append(shared)
        records = self._emit_glyphs(new, new_facts, paint, None, 1.0)
        # A run seen only through clip_text (pattern fill) may still get a stroke_text.
        self._last_run = glyphs if new else None
        self._last_records = records
        # The clip is pushed right after this: pop_clip of that entry ends the run's chance to be painted through.
        self._through = None
        if new:
            self._through = {"records": records, "depth": len(self._clips) + 1, "painted": False, "as": painted_as, "alpha": 1.0}

    def _end_through(self):
        """``pop_clip`` of a run's clip: painted through, it was a pattern fill or stroke, not a Tr 7 clip."""
        through = self._through
        if through is None or through["depth"] != len(self._clips):
            return
        self._through = None
        if through["painted"] and self._detail:
            for record in through["records"]:
                record.update(paint=through["as"], alpha=r3(through["alpha"]))

    def _stroke_half(self):
        """The stroke half of the run before it: Tr 2 and 6 with whatever fill and stroke."""
        if self._detail:
            for record in self._last_records:
                record["paint"] = "fillStroke"
        self._last_run = None

    # -- paints ------------------------------------------------------------

    def fill_path(self, ctx, path, even_odd, ctm, colorspace, color, alpha, color_params):
        box = box_from_rect(m.ll_fz_bound_path(path, None, ctm))
        paint = self._add_paint("fill", box, srgb255(colorspace, color, color_params), alpha, even_odd)
        if paint is not None and self._segments is not None:
            paint["path"] = self._segments.walk(path, ctm)

    def stroke_path(self, ctx, path, stroke, ctm, colorspace, color, alpha, color_params):
        box = box_from_rect(m.ll_fz_bound_path(path, None, ctm))  # NOT expanded by line width
        paint = self._add_paint("stroke", box, srgb255(colorspace, color, color_params), alpha)
        if paint is not None and self._segments is not None:
            paint["path"] = self._segments.walk(path, ctm)
            paint["line"] = line_style(stroke, ctm)

    def fill_shade(self, ctx, shade, ctm, alpha, color_params):
        # Extended axial shadings have infinite bounds: use the clip instead.
        paint = self._add_paint("shade", self._clips[-1], None, alpha)
        if paint is not None and self._detail:
            paint["shading"] = SHADING_KINDS[shade.type]

    def fill_image(self, ctx, image, ctm, alpha, color_params):
        # An image with a soft mask of its own comes right after clip_image_mask of that mask: no part of its clip (§17).
        own_mask = self._clip_kinds[-1] == "image"
        paint = self._add_paint("image", unit_square_bbox(ctm), None, alpha, clip=self._paint_clips[-2] if own_mask else None)
        if paint is not None and self._detail:
            paint.update(image_facts(image, ctm, False))

    def fill_image_mask(self, ctx, image, ctm, colorspace, color, alpha, color_params):
        # A stencil paints with the fill colour (§16). Without detail it stays null, as it always was.
        rgb = srgb255(colorspace, color, color_params) if self._detail else None
        paint = self._add_paint("image", unit_square_bbox(ctm), rgb, alpha)
        if paint is not None and self._detail:
            paint.update(image_facts(image, ctm, True))

    # -- text --------------------------------------------------------------

    def fill_text(self, ctx, text, ctm, colorspace, color, alpha, color_params):
        glyphs, facts = text_glyphs(text, ctm, self._glyph_sizes)
        if self._recording:
            self._through = None
            rgb = srgb255(colorspace, color, color_params) if self._detail else None
            self._last_records = self._emit_glyphs(glyphs, facts, "fill", rgb, alpha)  # a fill_text always starts a new run
            self._last_run = glyphs

    def stroke_text(self, ctx, text, stroke, ctm, colorspace, color, alpha, color_params):
        glyphs, facts = text_glyphs(text, ctm, self._glyph_sizes)
        if self._recording:
            self._through = None
            if glyphs == self._last_run:
                self._stroke_half()
            else:
                rgb = srgb255(colorspace, color, color_params) if self._detail else None
                self._emit_glyphs(glyphs, facts, "stroke", rgb, alpha)
            self._last_run = None  # a run has at most one stroke_text

    def ignore_text(self, ctx, text, ctm):
        # With no detail, Tr 3 is as if it were not there.
        if not self._detail or not self._recording:
            return
        self._through = None
        self._last_run = None
        glyphs, facts = text_glyphs(text, ctm, self._glyph_sizes)
        self.invisible.extend(
            {"u": u, "x": x, "y": y, "font": shared["font"], **({"type3": True} if "type3" in shared else {})}
            for (u, x, y), shared in zip(glyphs, facts)
        )

    # -- clips (every push is matched by one pop_clip) ---------------------

    def clip_path(self, ctx, path, even_odd, ctm, scissor):
        self._through = None
        geom = (self._segments.walk(path, ctm), False) if self._paths else None
        self._push_clip(box_from_rect(m.ll_fz_bound_path(path, None, ctm)), geom=geom)

    def clip_stroke_path(self, ctx, path, stroke, ctm, scissor):
        self._through = None
        geom = (self._segments.walk(path, ctm), True) if self._paths else None
        self._push_clip(box_from_rect(m.ll_fz_bound_path(path, stroke, ctm)), geom=geom)

    def clip_text(self, ctx, text, ctm, scissor):
        self._clip_run(text, ctm, "clip", "fill")
        self._push_clip(box_from_rect(m.ll_fz_bound_text(text, None, ctm)))

    def clip_stroke_text(self, ctx, text, stroke, ctm, scissor):
        # A stroke with a pattern. Like stroke_text it may be the stroke half of a fill+stroke run: then its
        # glyphs must stay unmatched, for the accumulated clip_text of Tr 6 at ET to cancel.
        if self._recording and text_glyphs(text, ctm)[0] == self._last_run:
            self._through = None
            self._stroke_half()
        else:
            self._clip_run(text, ctm, "stroke", "stroke")
        self._push_clip(box_from_rect(m.ll_fz_bound_text(text, stroke, ctm)))

    def clip_image_mask(self, ctx, image, ctm, scissor):
        self._through = None
        self._push_clip(unit_square_bbox(ctm), "image")

    def pop_clip(self, ctx):
        self._end_through()
        if len(self._clips) > 1:
            self._clips.pop()
            self._paint_clips.pop()
            self._clip_kinds.pop()
            self._clip_geoms.pop()
            self._clip_ids.pop()

    def begin_mask(self, ctx, area, luminosity, colorspace, bc, color_params):
        self._through = None
        self._hidden += 1
        self._mask_areas.append(box_from_rect(area))

    def end_mask(self, ctx, fn):
        self._hidden -= 1
        self._push_clip(self._mask_areas.pop(), "mask")

    # -- groups: their alpha and blend mode (§17), and the alpha of pattern paints (§9) --

    def begin_group(self, ctx, area, colorspace, isolated, knockout, blendmode, alpha):
        self._groups.append((alpha, len(self._clips), blendmode))

    def end_group(self, ctx):
        if self._groups:
            self._groups.pop()

    # -- tiling patterns (cell content is not page geometry; §9) ------------

    def begin_tile(self, ctx, area, view, xstep, ystep, ctm, id, doc_id):
        # A fill wider than XStep or taller than YStep: the cell is drawn once, into a tile.
        if self._recording:
            self._tiling_fill()
        self._hidden += 1
        return 0  # 0 = MuPDF must send the cell content (it is then skipped above)

    def end_tile(self, ctx):
        self._hidden -= 1

    def begin_metatext(self, ctx, meta, text):
        # TILE_MARKER outside begin_tile: a cell drawn straight onto the page, one
        # per cell the area overlaps; _tiling_fill counts the fill once.
        if text == TILE_MARKER and self._recording:
            self._tiling_fill()


def mark_tiling_cells(doc):
    """Replace every tiling pattern's cell content with TILE_MARKER_CONTENT, in memory only (§9).

    Run before any page: then a cell MuPDF draws straight onto the page shows
    up as the marker instead of passing for page content. The file is untouched.
    """
    for xref in range(1, doc.xref_length()):
        if doc.xref_is_stream(xref) and doc.xref_get_key(xref, "PatternType") == ("int", "1"):
            doc.update_stream(xref, TILE_MARKER_CONTENT)


def mark_type3_glyphs(doc):
    """Replace every Type 3 glyph's content with TYPE3_GLYPH_CONTENT, in memory only (§6).

    Run before any page: MuPDF then caches every glyph and reports it through ``fill_text``.
    The file is untouched. Advances come from /Widths, not from the glyph.
    """
    for xref in range(1, doc.xref_length()):
        if doc.xref_get_key(xref, "Subtype") != ("name", "/Type3"):
            continue
        kind, value = doc.xref_get_key(xref, "CharProcs")
        source = doc.xref_object(int(value.split()[0])) if kind == "xref" else value
        for reference in re.findall(r"(\d+) 0 R", source):
            doc.update_stream(int(reference), TYPE3_GLYPH_CONTENT)


def page_inventory(page, index, detail=True, paths=False, glyph_sizes=False):
    rect = page.rect
    dev = InventoryDevice((0.0, 0.0, rect.width, rect.height), detail, paths, glyph_sizes)
    # Page contents only: fz_run_page would also draw annotations and widgets.
    m.fz_run_page_contents(page.this, dev, m.FzMatrix(), m.FzCookie())
    result = {
        "index": index,
        "size": [r3(rect.width), r3(rect.height)],
        "paints": dev.paints,
        "glyphs": dev.glyphs,
    }
    if detail:
        result["invisible"] = dev.invisible
    return result


class PageRangeError(ValueError):
    """A requested page number does not exist in the document."""


def inventory(pdf_path, pages=None, detail=True, paths=False, glyph_sizes=False):
    """Inventory of a PDF. ``pages`` are 1-based page numbers (None = all).

    ``detail=False`` leaves out each paint's ``path``, ``line``, ``clip``, ``groupAlpha``, ``blend`` and ``masked``, an image's
    ``ctm``, ``px`` and ``stencil`` (and the colour of a stencil), a shade's ``shading``, each glyph's state and
    ``invisible``, and does not touch Type 3 glyphs; everything else is the same. ``paths=True`` with it keeps the
    ``path`` and ``line`` of the fill and stroke paints and every paint's ``groupAlpha``, and gives a ``shade`` or
    ``pattern`` paint the path of the innermost clip when a path clip pushed it (``clipPath``, and ``clipStroke`` true
    for a stroke's clip, as for a gradient or pattern stroke); the fidelity harness's S3 and S7 read them (rulings
    M3-R49, M3-R56). ``glyph_sizes=True`` gives each glyph its ``size`` (pt) without the rest of the detail (S7's M8-R5
    box for a glyph). Nothing else changes.
    """
    doc = pymupdf.open(pdf_path)
    numbers = list(range(1, len(doc) + 1)) if pages is None else list(pages)
    for number in numbers:
        if not 1 <= number <= len(doc):
            raise PageRangeError(f"page {number} out of range (document has {len(doc)} pages)")
    mark_tiling_cells(doc)
    if detail:
        mark_type3_glyphs(doc)
    return {"pages": [page_inventory(doc[n - 1], n - 1, detail, paths, glyph_sizes) for n in numbers]}


def parse_pages(text):
    try:
        return [int(part) for part in text.split(",") if part.strip()]
    except ValueError:
        raise argparse.ArgumentTypeError(f"--pages expects 1-based page numbers like 1,2 (got {text!r})")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Dump a MuPDF paint/glyph inventory of a PDF as JSON.")
    ap.add_argument("pdf")
    ap.add_argument("--pages", type=parse_pages, default=None, help="1-based page numbers, e.g. 1,2 (default: all)")
    args = ap.parse_args(argv)
    pymupdf.set_messages(stream=sys.stderr)  # MuPDF errors must not corrupt the JSON on stdout
    try:
        inv = inventory(args.pdf, args.pages)
    except PageRangeError as err:
        ap.error(str(err))
    out = json.dumps(inv, ensure_ascii=False, separators=(",", ":")) + "\n"
    sys.stdout.buffer.write(out.encode("utf-8"))  # UTF-8 explicitly (Korean glyphs on Windows)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
