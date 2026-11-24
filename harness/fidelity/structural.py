"""Structural checks S1-S6 of spec section 5.2: one PDF page against one slide of the converter's output, from the
PDF and the slide XML alone (no renderer, so they run in CI as well). S7, the PowerPoint round trip, is in
roundtrip.py.

    check(pdf_page: PageFacts, slide: SlideFacts) -> {"S1": {"status", "detail"}, ..., "S6": {...}}

``status`` is ``"pass"``, ``"fail"`` or ``"n/a"``. A check the converter or the input cannot support is ``"n/a"``
with the reason, never a pass; a check that is satisfied because there is nothing to compare (no text on either side,
no shapes, no typeface) passes (ruling M1-R70). ``detail`` goes into results JSON that may be committed: it names page
and slide numbers, shape names, typeface names and numbers only, never a file name, a path or any text of the slide.
A check that raises is recorded as a fail ("internal error") so that one odd slide does not stop a run.

The checks (values verbatim from the spec and the brief; rulings M1-R34, R35, R37, R38, R39, R40, R41, R42, R43,
R45, R47 (which amends R44), R48, R50, R52, R53 (which amends R39), R70, R71; M3-R18, R44, R45, R46, R47, R49):

S1 pictures. Bitmaps only where the PDF painted one: the slide has no more pictures than the page has image paints;
   every picture lies inside some PDF image paint's bbox (+0.5 pt; inside, not equal, so a cropped picture passes;
   M1-R37); and no picture covers 50 % of the slide or more unless a PDF image that large contains it. "Pictures"
   are every bitmap drawn on the slide (pptx_facts): ``p:pic`` and stretched ``blipFill`` shapes of the slide, its
   layout and its master, and a stretched background ``blipFill`` as a full-slide picture (M1-R45); a tiled picture
   fill is a pattern (S3). "Image paints" are the oracle's ``image`` paints, on a page of another size than the first
   (or turned by /Rotate) at the placement the converter gives the page: scaled uniformly to fit the slide and centred
   (M8-R7, ``placement``).
S2 text. The page's text and the slide's text with all whitespace removed (the PDF text layer has no space glyphs
   between Hangul words), each concatenated in its own paint order (PDF spans in order; slide shapes in z-order,
   then runs, a paragraph's bullet or number first, as PowerPoint exports it, M1-R41), must be equal (CER 0). When
   they are, every character's size (within 0.1 pt), colour (exact; alpha within 1 %), bold and italic are compared
   through that alignment (M1-R34). The spec's "line baseline within 0.5 pt" is checked by S7, from the round
   trip: the slide XML has no baseline without font metrics. Two empty texts have CER 0: a pass (M1-R70). A fail
   when a numbering scheme of the slide is not computed (pptx_facts). A PDF glyph of alpha 0 (invisible, as
   PowerPoint exports WordArt's text over its outlines) matches a run written ``a:noFill``, and its colour is never
   compared, only its alpha; colour is compared where the glyph is visible (M3-R46). A symbol font names a
   character by its code (M8): a slide character U+F000 + c in a run set in a symbol font (Wingdings, Webdings,
   Symbol, ...) equals the PDF's character of a symbol font when it is the private-use character deckback writes for
   that PDF character (the font's ToUnicode map through round 1a's mapping, ``same_symbol``), or the code itself.
S3 vectors. Paint for paint (M1-R38): every PDF drawing (``get_drawings``; a fill+stroke path is a fill and a
   stroke) against every slide paint: a shape's solid fill and its visible solid line (a shape with both counts as a
   fill and a stroke), a picture's outline, a table cell's fill and each visible cell border (M1-R45). Subtracted on
   the PDF side: every paint that paints nothing (M3-R45, M3-R47: a fill or a stroke drawing of alpha 0, exactly 0;
   the writer writes such a paint as a:noFill, which no slide paint counts), the background (the first fill drawing
   that covers 99 % of the page or more), clip-only paths
   (``get_drawings`` lists none) and same-MCID merges (0: the converters measured in M1 do not merge). Added: a
   drawing the writer splits (M3-R49: a stroke-only path of single segments, one connector each, a translucent one only
   where the segments do not meet, M3-R56; a filled path of disjoint rectangles, one rect each; pdf_facts ``split``,
   splits.py, at the page's scale on its slide) is one drawing per piece, with its box. Every
   drawing must find a slide paint of its kind, in three steps, each a maximum matching of the drawings left with the
   paints left (M1-R52: augmenting paths, so a chain of sub-0.5 pt tolerances cannot leave a drawing unmatched;
   ties go by paint order, each drawing in PDF order taking the first free paint it fits in z-order where it can):
   (1) a paint whose bbox is within 0.5 pt and whose colour (exact), alpha (within 1 %) and, for strokes, width
   (within 0.01 pt) match; (2) a paint of a preset outside the M1 geometry model (below) whose colour, alpha and
   width match; (3) only then a paint whose bbox is within 0.5 pt, as an attribute mismatch. So a preset under a
   same-frame rect of another colour (a button under a translucent overlay) is matched as drawn. Only after the
   matching is the background looked for on the slide side (M1-R53, amending M1-R39): at most one full-slide fill
   left unmatched (both bboxes clipped to the page, within 0.5 pt) whose colour and alpha are the background
   drawing's (colour exact, alpha within 1 %, as everywhere here) is removed, so the background may be a slide
   background or a shape, while a full-slide shape that matched a later drawing (a wash over the page) stays. The
   counts must then be equal.
   The slide-side bbox comes from the geometry where M1 can compute it (M1-R47, pptx_facts ``bbox_kind``): a
   custGeom's path points, a rect's four corners, the two end points of a line or straightConnector1, each through
   the frame, rot and flips. Every other preset, turned or not, is outside the M1 geometry model: its paints still
   count, and each is matched by kind, colour, alpha and width alone to a drawing no paint matched in step 1, but
   its position is not checked. Then S3 is n/a, "N preset shapes outside the M1 geometry model (positions not
   checked)", unless it fails for another reason.
   Gradients (M1-R35): every PDF shading must be matched (bbox within 0.5 pt, both clipped to the page; a maximum
   matching, M1-R52) by a gradFill, every gradFill by a shading, and no picture may cover a shading. A full-page
   shading painted first may be matched by a gradFill slide background instead (slide, else layout, else master;
   M1-R43), and a gradFill slide background needs one. Patterns (M1-R42) the same way: every PDF pattern paint must
   be matched by a pattFill or a tiled picture fill, every such fill by a pattern paint, no picture may cover a
   pattern, and a full-page pattern painted first may be a patterned slide background (pattFill or a tiled picture:
   M1-R43 applied to patterns, as PowerPoint exports both as one full-page pattern paint). A line filled with a
   gradient or a pattern is painted through its stroke's outline, so it is matched by containment both ways
   (M1-R48): its path bbox must lie inside the PDF bbox (+0.5 pt), and the PDF bbox inside the path bbox grown by g
   (+0.5 pt), where g is w/2 for round and bevel joins and for open single segments, and w/2 x the miter limit for
   miter joins (pptx_facts: the join and limit, 8 for an a:miter without lim); a square cap (cap="sq") reaches
   w / sqrt 2 past an open end, so g is w / sqrt 2 for an open single segment with square caps, and an open
   polyline's g is the larger of its cap's and its join's reach. A preset's gradient or pattern (fill or line) is
   matched to a shading or pattern paint no other fill matched, its position not checked (M1-R47). A stretched
   picture fill is a picture (S1), not a paint here. A text run filled with an a:gradFill (M5 Task 3: a shading in a
   glyph clip, or text filled with a shading pattern) is the shading of its glyphs (M5-R7): after the gradFill shapes,
   a shading left is matched by the text boxes with such a run (pptx_facts ``text_gradients``) when it lies inside
   their frames together, each frame grown by 0.5 pt + a quarter of its largest size (TEXT_INK_REACH: italics and
   side bearings reach past the advances), and every such box must match a shading.
   (M8-S3) Three cases that are no miss: a picture that is one of the PDF's own image paints (it lies inside one: S1's
   rule) is no cover of a shading or pattern, the PDF painted the shading under that image and both are kept; a PDF
   shading without width or height (clipped to the page, 0.01 pt) paints nothing and needs no gradFill; a gradFill
   (a fill, not a line: a straight connector's frame is flat) without width or height paints nothing and stands for
   one PDF shading left over, its position unchecked.
S4 order. A slide without shapes passes (nothing is out of order; M1-R70). Otherwise n/a unless every shape name
   (``order``: every leaf shape drawn, in z-order) starts with the provenance
   ``pdf:p<page>:z<op> ``. Then every name must give this page's number, counted from 1 (M1-R50: the oracle's
   0-based index + 1), and all pairs must be concordant: the op index never decreases along the z-order (no pair
   out of PDF paint order). Pairs with the same op index (one PDF operation split into several shapes) are neither
   concordant nor discordant and are ignored. A link hotspot, named exactly ``pdf:p<page>:a<i> link``, is no paint
   and is left out of the order, counted as ``links`` (ruling M3-R18); its page number must be this page's too.
S5 page. The slide size equals the first page's CropBox (rotated by /Rotate; scaled into PowerPoint's 72 to 4032 pt
   range when a side is out of it, as the converter makes the slide: M8-R7) within 1 EMU in each direction, and the deck
   has as many slides as the PDF has pages.
S6 fonts. The typeface is the real family name (spec: "글꼴 이름이 진짜 가족 이름이다"), in two ways:
   (M1-R40) no ``a:latin`` / ``a:ea`` typeface of the slide equals an embedded PDF font's BaseFont (subset tag
   removed, with or without Office's ``,Bold``-style suffix) or that font's family name (nameID 1) with its spaces
   removed, where that string differs from the family name (and is no other embedded font's family name, in any
   language): ``MalgunGothic`` for "Malgun Gothic", ``GothicA1`` for "Gothic A1", ``Pretendard-Bold`` for
   "Pretendard";
   (M1-R71, M3-R44, M3-R63) through S2's alignment, every character's typeface is a family name of the embedded PDF
   font that drew it, in the slot the character needs (``script_of``): ``a:ea`` for an East Asian character, which
   may be any of the font's nameID 1 records, in any language ("Malgun Gothic" or "맑은 고딕", spec 5.2 and 7:
   PowerPoint writes the Korean name in ``a:ea``); ``a:latin`` for Latin letters and ASCII and ``a:cs`` for a
   complex-script character, which must be its English (0x409) nameID 1, else its first (``family``,
   harness.fonts.program: spec 7 gives them the English family); either for punctuation and symbols both kinds of
   text use (PowerPoint picks by its language rules): the English family in ``a:latin`` or any in ``a:ea``. A character whose PDF font has no family name (not embedded, no name
   table) is skipped and counted in the detail; a run without the typeface its character needs fails. Fonts that
   are not embedded are listed in the detail. A slide without text passes unless a typeface is a BaseFont-style
   name (M1-R70). n/a when the texts differ (S2 fails: there is no alignment, and a guessed one would pair characters
   of different shapes) or when no aligned character's PDF font has a family name.
   (M4 Task 3) and no typeface of the slide is a known family without its spaces (``MalgunGothic``), whatever the
   PDF's fonts are: the known families are those of the PostScript-name table (packages/core/src/fonts/ps-family.ts,
   harness.fonts.ps_family), and a family spelled without spaces (NanumGothic) is no other's. M1-R40 sees only the
   page's embedded fonts; a font that is not embedded, or has no name table, is where deckback took names from the
   PDF (counted as "spaceless names"). Where a PDF font's own family is such a name, the spaced family is accepted
   for its characters too.
"""

import math
import re

import numpy as np

from harness.fidelity.pdf_facts import strip_subset_tag, without_style_suffix
from harness.fidelity.pptx_facts import DEFAULT_MITER_LIMIT
from harness.fidelity.splits import pieces
from harness.fonts import ps_family
from harness.fonts.program import is_symbol_family

BBOX_TOL = 0.5  # pt
SIZE_TOL = 0.1  # pt
ALPHA_TOL = 0.01  # alpha 0..1, i.e. 1 %
WIDTH_TOL = 0.01  # pt
PICTURE_MAX_SHARE = 0.5  # of the slide area
BACKGROUND_COVER = 0.99  # of the page area
SIZE_EMU_TOL = 1
SAME_MCID_MERGES = 0  # the converters measured in M1 do not merge same-tag paths
EMU_PER_PT = 12700
EPS = 1e-6  # float noise in the comparisons above
EXAMPLES = 3  # problems listed per kind in a detail
NO_AREA = 0.01  # pt: a paint whose width or height is this small or smaller has no area and paints nothing (M8-S3)
SYMBOL_PUA = range(0xF020, 0xF100)  # U+F000 + the font's code: how PowerPoint names a symbol-font character
SYMBOL_MARK = ""  # S2: stands for a symbol-font character on both sides once their codes agree
TEXT_INK_REACH = 0.25  # of a text box's largest size: how far its glyphs' ink may pass its frame (M5-R7)
PROVENANCE = re.compile(r"^pdf:p([0-9]+):z([0-9]+) ")
HOTSPOT = re.compile(r"pdf:p([0-9]+):a[0-9]+ link")  # a link hotspot's whole name (fullmatch; ruling M3-R18)
INVISIBLE = {"​", "‌", "‍", "⁠", "﻿"}  # dropped with the whitespace
BASELINE_NOTE = ("line baselines (0.5 pt) are checked by S7, the round trip: the slide XML has no baseline without "
                 "font metrics")


# Names of the counts a check reports besides its detail (``counts``): a private deck's results carry the status and
# these numbers only, never the detail (ruling M1-R75; run.py). Fixed words, lower case.
COUNT_NAMES = frozenset((
    "pictures", "image paints", "problems",  # S1
    "pdf characters", "slide characters", "edits", "character problems", "unresolved paragraphs",
    "invisible characters",  # S2
    "pdf drawings", "slide paints", "unmatched pdf", "unmatched slide", "mismatches", "shadings", "gradients",
    "patterns", "pattern fills", "preset shapes", "invisible paints", "split pieces", "text gradients",  # S3
    "shapes", "unnamed shapes", "other page shapes", "pairs out of order", "links",  # S4
    "slides", "pages",  # S5
    "typefaces", "wrong names", "characters compared", "characters skipped", "missing typefaces",
    "fonts not embedded", "spaceless names",  # S6
))


def _result(status, detail, counts=None):
    """A check's result; `counts` ({name in COUNT_NAMES: int}) go with it for private decks (M1-R75)."""
    out = {"status": status, "detail": detail}
    if counts is not None:
        out["counts"] = {name: int(value) for name, value in counts.items()}
    return out


def _n(count, noun):
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _box(box):
    return "[" + ", ".join(f"{v:.1f}" for v in box) + "]" if box is not None else "[no position]"


def _hex(rgb):
    return "#" + "".join(f"{v:02X}" for v in rgb) if rgb is not None else "none"


def _within(a, b, tol):
    return a is not None and b is not None and all(abs(x - y) <= tol + EPS for x, y in zip(a, b))


def _inside(inner, outer, tol):
    return (inner is not None and outer is not None and inner[0] >= outer[0] - tol - EPS
            and inner[1] >= outer[1] - tol - EPS and inner[2] <= outer[2] + tol + EPS
            and inner[3] <= outer[3] + tol + EPS)


def _area(box):
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _clipped_share(box, width, height):
    clipped = [max(box[0], 0.0), max(box[1], 0.0), min(box[2], width), min(box[3], height)]
    total = width * height
    return _area(clipped) / total if total > 0 else 0.0


def _examples(items, render):
    shown = [render(item) for item in items[:EXAMPLES]]
    more = f", ... ({len(items) - EXAMPLES} more)" if len(items) > EXAMPLES else ""
    return "; ".join(shown) + more


# ---- S1 -----------------------------------------------------------------------------------------------------------


SIDE_MIN_PT, SIDE_MAX_PT = 72.0, 4032.0  # PowerPoint's range for a slide side (convert.ts)


def slide_frame(size):
    """The slide (width, height in pt) the converter makes for a first page of `size` (convert.ts `slideFrame`): that
    size, scaled uniformly into PowerPoint's 72 to 4032 pt range when a side is out of it, each side then held to it."""
    width, height = size
    long_side, short_side = max(width, height), min(width, height)
    k = 1.0
    if long_side > SIDE_MAX_PT:
        k = SIDE_MAX_PT / long_side
    elif short_side < SIDE_MIN_PT:
        k = min(SIDE_MIN_PT / short_side, SIDE_MAX_PT / long_side)
    return tuple(min(SIDE_MAX_PT, max(SIDE_MIN_PT, v * k)) for v in (width, height))


def placement(size, frame):
    """M8-R7, convert.ts `placement`: where a page of `size` (pt) lands on a slide of `frame` (pt): the largest uniform
    scale that fits it, centred. (scale, (offset x, offset y)); (1, (0, 0)) for a page without a size."""
    width, height = size
    if not (width > 0 and height > 0):
        return 1.0, (0.0, 0.0)
    scale = min(frame[0] / width, frame[1] / height)
    return scale, ((frame[0] - width * scale) / 2, (frame[1] - height * scale) / 2)


def placed(box, scale, offset):
    """A box of the page's frame on the slide, at the page's `placement`."""
    return [box[0] * scale + offset[0], box[1] * scale + offset[1], box[2] * scale + offset[0],
            box[3] * scale + offset[1]]


def oversized_picture(box, images, width, height):
    """S1's rule for a large picture: the share of the slide (`width` x `height` pt) the picture's `box` covers when it
    is 50 % or more and no PDF image paint of `images` contains it (0.5 pt), else None. The probe-parity verdict counts
    its full-page pictures with it too (ruling M3-R54)."""
    share = _clipped_share(box, width, height)
    if share >= PICTURE_MAX_SHARE - EPS and not any(_inside(box, image, BBOX_TOL) for image in images):
        return share
    return None


def s1(page, slide):
    pictures = slide.pictures
    width, height = slide.size_pt or page.size_pt
    # M8-R7: a page of another size than the first, or turned by /Rotate, is scaled to fit the slide and centred on it;
    # its image paints are compared at that placement
    scale, offset = placement(page.size_pt, (width, height))
    images = [placed(image, scale, offset) for image in page.images]
    problems = []
    if len(pictures) > len(images):
        problems.append(f"{_n(len(pictures), 'picture')} for {_n(len(images), 'PDF image paint')}")
    for number, box in enumerate(pictures, start=1):
        if box is None:
            problems.append(f"picture {number} has no position")
            continue
        inside = [image for image in images if _inside(box, image, BBOX_TOL)]
        if not inside:
            problems.append(f"picture {number} {_box(box)} lies inside no PDF image paint (0.5 pt)")
        share = oversized_picture(box, images, width, height)
        if share is not None:
            problems.append(f"picture {number} covers {share * 100:.1f} % of the slide (50 % or more) and no PDF "
                            "image paint that large contains it")
    summary = f"{_n(len(pictures), 'picture')}, {_n(len(images), 'PDF image paint')}"
    counts = {"pictures": len(pictures), "image paints": len(images), "problems": len(problems)}
    if problems:
        return _result("fail", f"{summary}: " + "; ".join(problems), counts)
    return _result("pass", f"{summary}: every picture lies inside a PDF image paint (0.5 pt) and none covers 50 % "
                           "of the slide without a PDF image that large", counts)


# ---- S2 -----------------------------------------------------------------------------------------------------------


def _visible(text):
    return not text.isspace() and text not in INVISIBLE


def edit_distance(a, b):
    """Levenshtein distance (unit costs), one numpy row per character of `a`."""
    if a == b:
        return 0
    if not a or not b:
        return len(a) or len(b)
    codes = np.fromiter((ord(c) for c in b), dtype=np.int64, count=len(b))
    steps = np.arange(len(b) + 1, dtype=np.int64)
    previous = steps.copy()
    for i, char in enumerate(a, start=1):
        current = np.empty_like(previous)
        current[0] = i
        current[1:] = np.minimum(previous[1:] + 1, previous[:-1] + (codes != ord(char)))
        current = np.minimum.accumulate(current - steps) + steps  # insertions
        previous = current
    return int(previous[-1])


def _symbolic_run(run):
    """Whether a slide run is set in a symbol font (Wingdings, Webdings, Symbol, ...: any of its typefaces, a:sym too)."""
    return any(is_symbol_family(run.get(key)) for key in ("typeface_latin", "typeface_ea", "typeface_cs", "typeface_sym"))


def same_symbol(pdf_char, span, slide_char, run):
    """M8 (S2 for symbol fonts): a symbol font names a character by its code, not by Unicode. The slide's character is
    a private-use character of a symbol-font run (round 1a: U+F000 + the font's code); the PDF's is what MuPDF reads from
    the font's ToUnicode map (a Unicode character), or the code itself where the font has none. Exact rule (round 1c):
    the PDF span's font is a symbol font and the slide's character is one of the private-use characters deckback writes
    for the PDF character (``span["symbol_codes"]``, pdf_facts.symbol_codes: the PDF font's ToUnicode map through the
    mapping of round 1a); a character the map does not name is the code itself, accepted at U+F000 + that code up to
    U+00FF. A PDF character above U+00FF that the font's map does not give is no match."""
    if ord(slide_char) not in SYMBOL_PUA or not _symbolic_run(run) or not is_symbol_family(span.get("font")):
        return False
    mapped = (span.get("symbol_codes") or {}).get(pdf_char)
    if mapped is not None:
        return ord(slide_char) in mapped
    return ord(pdf_char) <= 0xFF and ord(pdf_char) == ord(slide_char) - 0xF000


def _symbol_aligned(pdf_chars, slide_chars):
    """(pdf text, slide text) of the visible characters, a pair `same_symbol` accepts written as one mark on both
    sides. The pairs are those of the two texts position by position, so only when they have as many characters."""
    pdf_text = [c for c, _ in pdf_chars]
    slide_text = [c for c, _ in slide_chars]
    if len(pdf_text) == len(slide_text):
        for k, ((a, span), (b, run)) in enumerate(zip(pdf_chars, slide_chars)):
            if a != b and same_symbol(a, span, b, run):
                pdf_text[k] = slide_text[k] = SYMBOL_MARK
    return "".join(pdf_text), "".join(slide_text)


def s2(page, slide):
    pdf_chars = [(c, span) for span in page.spans for c in span["text"] if _visible(c)]
    slide_chars = [(c, run) for run in slide.runs for c in run["text"] if _visible(c)]
    counts = {"pdf characters": len(pdf_chars), "slide characters": len(slide_chars)}
    if not pdf_chars and not slide_chars:  # M1-R70: two empty texts have CER 0
        return _result("pass", "no text on the page or the slide (whitespace removed): CER 0; " + BASELINE_NOTE,
                       counts)
    pdf_text, slide_text = _symbol_aligned(pdf_chars, slide_chars)
    unknown = [run for run in slide.runs if run.get("unresolved")]
    if unknown:
        return _result("fail", f"unresolved bullet numbering in {_n(len(unknown), 'paragraph')} ("
                               + _examples(unknown, lambda r: f"shape '{r['shape']}': {r['unresolved']}")
                               + f"): the slide's text is not known; {BASELINE_NOTE}",
                       {**counts, "unresolved paragraphs": len(unknown)})
    if pdf_text != slide_text:
        edits = edit_distance(pdf_text, slide_text)
        first = next((k for k, (x, y) in enumerate(zip(pdf_text, slide_text)) if x != y),
                     min(len(pdf_text), len(slide_text)))
        cer = edits / max(1, len(pdf_text))
        return _result("fail", f"text differs: CER {cer:.4f} ({_n(edits, 'edit')} over {len(pdf_text)} PDF "
                               f"characters, {len(slide_text)} on the slide; first difference at character "
                               f"{first + 1}; whitespace removed on both sides); {BASELINE_NOTE}",
                       {**counts, "edits": edits})
    problems = {key: [] for key in ("unresolved size", "size", "unresolved colour", "colour", "alpha",
                                    "unresolved bold", "bold", "unresolved italic", "italic")}
    invisible = 0  # M3-R46: glyphs of alpha 0, whose colour is not compared
    for k, ((_, span), (_, run)) in enumerate(zip(pdf_chars, slide_chars), start=1):
        where = f"character {k} in shape '{run['shape']}'"
        if run["size"] is None:
            problems["unresolved size"].append(where)
        elif abs(span["size"] - run["size"]) > SIZE_TOL + EPS:
            problems["size"].append(f"{where}: PDF {span['size']:.2f} pt, slide {run['size']:.2f} pt")
        colour = run["color"]
        unseen = span["alpha"] <= EPS
        invisible += unseen
        if unseen and colour.get("no_fill"):
            pass  # M3-R46: a glyph of alpha 0 matches a run written noFill; neither paints
        elif colour.get("rgb") is None:
            problems["unresolved colour"].append(f"{where}: {colour.get('unresolved', 'unknown')}")
        else:
            if not unseen and list(colour["rgb"]) != list(span["color"]):  # M3-R46: only where the glyph shows
                problems["colour"].append(f"{where}: PDF {_hex(span['color'])}, slide {_hex(colour['rgb'])}")
            if abs(span["alpha"] - colour["alpha"]) > ALPHA_TOL + EPS:
                problems["alpha"].append(f"{where}: PDF {span['alpha']:.3f}, slide {colour['alpha']:.3f}")
        for attr in ("bold", "italic"):
            if run[attr] is None:
                problems[f"unresolved {attr}"].append(where)
            elif bool(run[attr]) != bool(span[attr]):
                problems[attr].append(f"{where}: PDF {span[attr]}, slide {run[attr]}")
    found = []
    for key, items in problems.items():
        if items:
            verb = "on" if key.startswith("unresolved") else "differs on"
            found.append(f"{key} {verb} {_n(len(items), 'character')} ({_examples(items, str)})")
    summary = f"text equal ({len(pdf_text)} characters, whitespace removed)" + (
        f"; {_n(invisible, 'glyph')} of alpha 0: colour not compared, a noFill run matches (M3-R46)"
        if invisible else "")
    counts["character problems"] = sum(len(items) for items in problems.values())
    if invisible:
        counts["invisible characters"] = invisible
    if found:
        return _result("fail", f"{summary}; " + "; ".join(found) + f"; {BASELINE_NOTE}", counts)
    return _result("pass", f"{summary}; size (0.1 pt), colour, alpha (1 %), bold and italic match on every "
                           f"character; {BASELINE_NOTE}", counts)


# ---- S3 -----------------------------------------------------------------------------------------------------------


def _grown(box, g):
    return [box[0] - g, box[1] - g, box[2] + g, box[3] + g]


def _clip(box, width, height):
    """`box` clipped to the page (the oracle clips shading and pattern bboxes to it; contract section 5)."""
    if box is None:
        return None
    return [max(box[0], 0.0), max(box[1], 0.0), min(box[2], width), min(box[3], height)]


def _bbox_matches(paint, pdf_box):
    """A slide paint's bbox against a PDF bbox: within 0.5 pt, or for a line filled with a gradient or a pattern
    (``outline_growth`` set) by containment both ways (M1-R48). A preset outside the M1 geometry model (bbox_kind
    "preset", M1-R47) never matches by position: it is matched by its attributes alone (s3, _match_fills)."""
    box = paint["bbox"]
    if box is None or pdf_box is None or paint.get("bbox_kind") == "preset":
        return False
    if "outline_growth" in paint:
        g = paint["outline_growth"]
        return (g is not None and _inside(box, pdf_box, BBOX_TOL)
                and _inside(pdf_box, _grown(box, g), BBOX_TOL))
    return _within(box, pdf_box, BBOX_TOL)


def _outline_growth(line, open_path, ends):
    """g of M1-R48: how far the stroke outline of `line` reaches past its path bbox; None without a width.

    A join reaches w/2 (round, bevel) or w/2 x the miter limit (miter). A cap at an open end reaches w/2 (flat: w/2
    across the line; round) or, square, (w/2)(|cos| + |sin|) per axis past the end point: w / sqrt 2 at most, at
    45 degrees. `open_path` (open single segments) has caps and no join; a geometry with `ends` (an open subpath)
    has caps besides its joins, and reaches the larger of the two; a closed one has joins only."""
    width = line.get("width")
    if width is None:
        return None
    cap = width / math.sqrt(2) if line.get("cap") == "sq" else width / 2
    if open_path:
        return cap
    if line.get("join") == "miter":
        limit = line.get("miter_limit")
        join = width / 2 * (DEFAULT_MITER_LIMIT if limit is None else limit)
    else:
        join = width / 2
    return max(join, cap) if ends else join


def _slide_paints(slide):
    """(drawing paints, gradient fills, pattern fills) of the slide's shapes (M1-R38, R35, R42).

    A solid fill is a fill paint and a solid visible line a stroke paint; a gradFill (fill or line) is matched
    against the PDF's shadings and a pattFill or tiled picture fill (fill or line) against its patterns. A line
    filled with a gradient or a pattern is painted through the stroke's outline: it carries ``outline_growth`` (g of
    M1-R48). A stretched picture fill is a picture (S1). ``shape`` numbers the shape a paint comes from."""
    paints, gradients, patterns = [], [], []
    for number, shape in enumerate(slide.shapes):
        base = {"name": shape["name"], "bbox": shape["bbox"], "bbox_kind": shape.get("bbox_kind", "frame"),
                "shape": number}
        fill = shape["fill"]
        if fill is not None:
            entry = {**base, "part": "fill"}
            if fill["kind"] == "solid":
                paints.append({**entry, "kind": "fill", "rgb": fill.get("rgb"), "alpha": fill.get("alpha"),
                               "width": None, "unresolved": fill.get("unresolved")})
            elif fill["kind"] == "grad":
                gradients.append(entry)
            elif fill["kind"] == "pattern" or (fill["kind"] == "blip" and fill.get("tiled")):
                patterns.append(entry)
        line = shape["line"]
        if line is not None:
            entry = {**base, "part": "line"}
            outline = {**entry, "outline_growth": _outline_growth(line, shape.get("open", False),
                                                                  shape.get("ends", False))}
            if line["kind"] == "grad":
                gradients.append(outline)
            elif line["kind"] == "pattern" or (line["kind"] == "blip" and line.get("tiled")):
                patterns.append(outline)
            else:
                paints.append({**entry, "kind": "stroke", "rgb": line.get("rgb"), "alpha": line.get("alpha"),
                               "width": line.get("width"), "unresolved": line.get("unresolved")})
    return paints, gradients, patterns


def _paint_differences(drawing, paint):
    out = []
    pdf_rgb = drawing["fill"] if drawing["kind"] == "fill" else drawing["stroke"]
    if paint["rgb"] is None:
        out.append(f"unresolved colour ({paint.get('unresolved') or 'unknown'})")
    else:
        if list(paint["rgb"]) != list(pdf_rgb or []):
            out.append(f"colour {_hex(pdf_rgb)} vs {_hex(paint['rgb'])}")
        if abs(drawing["alpha"] - paint["alpha"]) > ALPHA_TOL + EPS:
            out.append(f"alpha {drawing['alpha']:.3f} vs {paint['alpha']:.3f}")
    if drawing["kind"] == "stroke":
        if paint["width"] is None:
            out.append("unresolved line width")
        elif drawing["width"] is None or abs(drawing["width"] - paint["width"]) > WIDTH_TOL + EPS:
            pdf_width = "none" if drawing["width"] is None else f"{drawing['width']:.3f}"
            out.append(f"width {pdf_width} vs {paint['width']:.3f} pt")
    return out


def _take(drawings, paints, free, accepts):
    """One step of S3's matching (M1-R52): a maximum bipartite matching of `drawings` with the paints of `free`
    (indices into `paints`, in paint order; the paints taken are removed from it) on `accepts(drawing, paint)`, found
    by augmenting paths, so a chain of sub-0.5 pt tolerances cannot leave a drawing without the paint it needs.

    Ties go by paint order: each drawing, in paint order, takes the first free paint it accepts. Only a drawing with
    none searches, depth first, for a path of drawings that can each move to another paint they accept, the last to
    a free one (every candidate list in paint order, free paints first). So where first-fit matches every drawing
    this is first-fit's matching, and a drawing is left only when it cannot be matched together with the drawings
    matched before it. Returns (drawings left, [(drawing, paint)]), both in the drawings' order."""
    pool = list(free)
    owner = {}  # paint index -> index of the drawing holding it
    accepted = {}  # drawing index -> the paints of `pool` it accepts, in paint order (computed when needed)

    def candidates(i):
        if i not in accepted:
            accepted[i] = [j for j in pool if accepts(drawings[i], paints[j])]
        return accepted[i]

    def first_free(i):
        return next((j for j in candidates(i) if j not in owner), None)

    for start, drawing in enumerate(drawings):
        hit = next((j for j in pool if j not in owner and accepts(drawing, paints[j])), None)
        if hit is not None:
            owner[hit] = start
            continue
        # `stack` holds the drawings of the path searched, with the candidates each has left to try; `via[k]` is the
        # paint stack[k] wants, held by stack[k + 1]. Paints on the stack's candidate lists are all held (a drawing is
        # pushed only when it has no free paint), and none changes hands until a path is found.
        seen, stack, via = set(), [(start, iter(candidates(start)))], []
        while stack:
            i, rest = stack[-1]
            j = next((j for j in rest if j not in seen), None)
            if j is None:
                stack.pop()
                if via:
                    via.pop()
                continue
            seen.add(j)
            holder = owner[j]
            moved = first_free(holder)
            if moved is not None:  # the holder moves to a free paint; each drawing on the path takes the next one's
                owner[moved] = holder
                for (d, _), p in zip(stack, via + [j]):
                    owner[p] = d
                break
            via.append(j)
            stack.append((holder, iter(candidates(holder))))
    held = {i: j for j, i in owner.items()}
    free[:] = [j for j in free if j not in owner]
    return ([d for i, d in enumerate(drawings) if i not in held],
            [(d, paints[held[i]]) for i, d in enumerate(drawings) if i in held])


def _match_fills(pdf_boxes, shapes, width, height):
    """PDF shading / pattern bboxes against the gradient / pattern fills and lines of the slide, in two maximum
    matchings (M1-R52): by bbox (both clipped to the page, as the oracle's), then the boxes left against the fills of
    presets outside the M1 geometry model, whose position is not checked (M1-R47). Returns (unmatched PDF boxes,
    unmatched slide fills)."""
    free = list(range(len(shapes)))
    left, _ = _take(pdf_boxes, shapes, free,
                    lambda box, s: _bbox_matches({**s, "bbox": _clip(s["bbox"], width, height)}, box))
    left, _ = _take(left, shapes, free, lambda box, s: s["bbox_kind"] == "preset")
    return left, [shapes[j] for j in free]


def _intersection(a, b):
    return [max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])]


def _meets(box, frame):
    """Whether `box` and `frame` share some area (a box of no area: whether it lies inside the frame)."""
    if _area(box) <= EPS:
        return _inside(box, frame, 0.0)
    return _area(_intersection(box, frame)) > EPS


def _inside_union(box, frames):
    """Whether `box` lies inside the union of the boxes `frames` (a box of no area: inside one of them). The box is
    cut at every edge of the frames, and each cell must lie in a frame."""
    if _area(box) <= EPS:
        return any(_inside(box, frame, 0.0) for frame in frames)
    parts = [_intersection(box, frame) for frame in frames]
    parts = [part for part in parts if _area(part) > EPS]
    xs = sorted({box[0], box[2], *(part[0] for part in parts), *(part[2] for part in parts)})
    ys = sorted({box[1], box[3], *(part[1] for part in parts), *(part[3] for part in parts)})
    for x0, x1 in zip(xs, xs[1:]):
        for y0, y1 in zip(ys, ys[1:]):
            if x1 - x0 <= EPS or y1 - y0 <= EPS:
                continue
            x, y = (x0 + x1) / 2, (y0 + y1) / 2
            if box[0] < x < box[2] and box[1] < y < box[3] and not any(
                    part[0] <= x <= part[2] and part[1] <= y <= part[3] for part in parts):
                return False
    return True


def _match_text_gradients(pdf_boxes, texts, width, height):
    """M5-R7: the PDF shadings left after the gradFill shapes against the text boxes with a gradient run. A shading is
    matched when it lies inside the frames of those boxes (each grown by 0.5 pt + TEXT_INK_REACH of its size) that
    it meets; one shading may cover the lines of several boxes and one box hold several shadings. Returns (unmatched
    PDF boxes, text boxes that matched no shading)."""
    grown = [_grown(_clip(t["bbox"], width, height), BBOX_TOL + TEXT_INK_REACH * (t["size"] or 0))
             if t["bbox"] is not None else None for t in texts]
    used, left = set(), []
    for box in pdf_boxes:
        clipped = _clip(box, width, height)
        meeting = [i for i, frame in enumerate(grown) if frame is not None and _meets(clipped, frame)]
        if meeting and _inside_union(clipped, [grown[i] for i in meeting]):
            used.update(meeting)
        else:
            left.append(box)
    return left, [t for i, t in enumerate(texts) if i not in used]


def _covers_page(box, width, height):
    return box is not None and _clipped_share(box, width, height) >= BACKGROUND_COVER - EPS


def _no_area(box):
    """Whether `box` has no width or no height (NO_AREA): such a gradient paints nothing."""
    return box is not None and (box[2] - box[0] <= NO_AREA or box[3] - box[1] <= NO_AREA)


def _background_fill(page, slide, width, height):
    """M1-R43 (and M1-R42 for patterns): a full-page shading or pattern painted first may be the slide background.
    Returns (shadings, patterns) left for the shapes, a note for the summary and a problem (or None)."""
    shadings, patterns = list(page.shadings), list(page.patterns)
    background = slide.background or {}
    fill = background.get("fill") or {}
    source = background.get("source", "slide")
    first = page.first_paint
    first_kind = first["kind"] if first and _covers_page(first["bbox"], width, height) else None
    if fill.get("kind") == "grad":
        if first_kind == "shade" and shadings:
            shadings.pop(0)
            return shadings, patterns, f"; the full-page shading painted first is the gradFill slide background " \
                                       f"({source})", None
        return shadings, patterns, "", f"gradFill slide background ({source}) without a full-page shading painted " \
                                       "first"
    if fill.get("kind") == "pattern" or (fill.get("kind") == "blip" and fill.get("tiled")):
        if first_kind == "pattern" and patterns:
            patterns.pop(0)
            return shadings, patterns, f"; the full-page pattern painted first is the patterned slide background " \
                                       f"({source})", None
        return shadings, patterns, "", f"patterned slide background ({source}) without a full-page pattern painted " \
                                       "first"
    return shadings, patterns, "", None


def _painting_nothing(drawings):
    """M3-R45 and M3-R47: every PDF paint that paints nothing, a fill or a stroke drawing of alpha 0 (exactly 0, as the
    writer's invisible pass tests it; EPS is float noise). A path's fill and stroke are paints of their own (M1-R38),
    so a fill of alpha 0 under a stroke that paints goes and the stroke stays. The writer writes a paint of alpha 0 as
    ``a:noFill``, which no slide paint counts, so both sides leave such paints out."""
    return [d for d in drawings if d["alpha"] <= EPS]


def _split(drawings, scale):
    """Rulings M3-R49, M3-R56: a drawing the writer splits into pieces (a chart's gridlines or bars: pdf_facts
    ``split``, splits.pieces at the page's `scale` on its slide) is one drawing per piece, each with the piece's box and
    the drawing's paint. Returns (drawings, pieces added)."""
    out, added = [], 0
    for drawing in drawings:
        args = drawing.get("split")
        boxes = None if not args else pieces(**args, scale=scale)
        if not boxes:
            out.append(drawing)
            continue
        out += [{**drawing, "bbox": list(box), "split": None} for box in boxes]
        added += len(boxes) - 1
    return out, added


def _page_scale(page, slide):
    """The scale convert draws the page at on its slide: fitted into it (1 for a slide of the page's size)."""
    (pw, ph), (sw, sh) = page.size_pt, (slide.size_pt or page.size_pt)
    return min(sw / pw, sh / ph) if pw > 0 and ph > 0 and sw > 0 and sh > 0 else 1.0


def s3(page, slide):
    width, height = page.size_pt
    total = len(page.drawings)
    nothing = _painting_nothing(page.drawings)  # M3-R45, M3-R47: subtracted, as clip-only paths are
    drawings, added = _split([d for d in page.drawings if not any(d is n for n in nothing)], _page_scale(page, slide))
    background = None
    for i, drawing in enumerate(drawings):
        if drawing["kind"] == "fill" and _covers_page(drawing["bbox"], width, height):
            background = drawings.pop(i)
            break
    expected = len(drawings) - SAME_MCID_MERGES
    paints, gradients, patterns = _slide_paints(slide)

    # three steps, each a maximum matching of the drawings left with the paints left (M1-R52)
    free = list(range(len(paints)))
    # 1. a paint of the drawing's kind whose bbox matches and whose colour, alpha and width match too
    left, _ = _take(drawings, paints, free, lambda d, p: p["kind"] == d["kind"] and _bbox_matches(p, d["bbox"])
                    and not _paint_differences(d, p))
    # 2. M1-R47: a paint of the drawing's kind of a preset outside the M1 geometry model whose colour, alpha and width
    # match; its position is not checked
    left, _ = _take(left, paints, free, lambda d, p: p["bbox_kind"] == "preset" and p["kind"] == d["kind"]
                    and not _paint_differences(d, p))
    # 3. only then a paint of the drawing's kind whose bbox matches, as an attribute mismatch
    unmatched_pdf, pairs = _take(left, paints, free, lambda d, p: p["kind"] == d["kind"]
                                 and _bbox_matches(p, d["bbox"]))
    mismatched = [(drawing, paint, _paint_differences(drawing, paint)) for drawing, paint in pairs]
    # M1-R53 (amends M1-R39): only now, at most one full-slide fill the matching left over is the page background,
    # if its colour and alpha are the subtracted background drawing's; a full-slide shape that matched a later
    # drawing (a wash) is never removed
    background_shape = None
    if background is not None:
        page_box = _clip(background["bbox"], width, height)
        hit = next((j for j in free if paints[j]["kind"] == "fill"
                    and _within(_clip(paints[j]["bbox"], width, height), page_box, BBOX_TOL)
                    and not _paint_differences(background, paints[j])), None)
        if hit is not None:
            free.remove(hit)
            background_shape = paints[hit]
    unmatched_slide = [paints[j] for j in free]
    paints = [p for p in paints if p is not background_shape]

    shadings, pdf_patterns, background_note, background_problem = _background_fill(page, slide, width, height)
    # M8-S3: a shading with no area (clipped to the page) paints nothing: it needs no gradFill and nothing covers it
    flat_shadings = [box for box in shadings if _no_area(_clip(box, width, height))]
    shadings = [box for box in shadings if not any(box is flat for flat in flat_shadings)]
    # M8-S3: a gradFill with no width or no height is a gradient that paints nothing; it stands for one PDF shading
    # left over (its position is not checked), so the counts still have to agree
    flat_gradients = [g for g in gradients if g["part"] == "fill" and _no_area(g["bbox"])]  # a line may be flat
    gradients = [g for g in gradients if not any(g is flat for flat in flat_gradients)]
    unmatched_shadings, extra_gradients = _match_fills(shadings, gradients, width, height)
    texts = slide.text_gradients
    unmatched_shadings, extra_texts = _match_text_gradients(unmatched_shadings, texts, width, height)
    absorbed = min(len(flat_gradients), len(unmatched_shadings))
    unmatched_shadings = unmatched_shadings[absorbed:]
    extra_gradients = extra_gradients + flat_gradients[absorbed:]
    unmatched_patterns, extra_patterns = _match_fills(pdf_patterns, patterns, width, height)
    # M8-S3: a picture that is one of the PDF's own image paints (S1's rule: it lies inside one) is no cover: the PDF
    # painted the shading under that image, and the converter keeps both. Only a picture the PDF has no image for (the
    # converter's own, a raster standing in for a shading) covers one.
    own = {number for number, picture in enumerate(slide.pictures, start=1)
           if any(_inside(picture, image, BBOX_TOL) for image in page.images)}
    covering = [(number, kind, box) for kind, boxes in (("shading", [box for box in page.shadings if not _no_area(_clip(box, width, height))]),
                                ("pattern", page.patterns))
                for box in boxes for number, picture in enumerate(slide.pictures, start=1)
                if number not in own and _inside(box, picture, BBOX_TOL)]
    every = paints + gradients + patterns + ([background_shape] if background_shape else [])
    presets = {p["shape"] for p in every if p["bbox_kind"] == "preset"}
    outlines = sum(1 for p in gradients + patterns if "outline_growth" in p)

    fills = sum(1 for d in drawings if d["kind"] == "fill")
    slide_fills = sum(1 for p in paints if p["kind"] == "fill")
    summary = (f"PDF: {_n(total, 'drawing paint')} + split pieces {added} (M3-R49) - background "
               f"{1 if background else 0} - painting nothing {len(nothing)} (alpha 0, M3-R45, M3-R47) - clip-only 0 (not "
               f"drawings) - same-MCID merges {SAME_MCID_MERGES} = {expected} (fill {fills}, stroke "
               f"{len(drawings) - fills}); slide: {_n(len(paints), 'paint')} (fill {slide_fills}, stroke "
               f"{len(paints) - slide_fills}) from {_n(len(slide.shapes), 'shape')}"
               + (", full-slide background shape removed" if background_shape else "")
               + f"; {_n(len(page.shadings), 'shading')}, {_n(len(gradients) + len(flat_gradients), 'gradFill')}"
               + (f" ({len(flat_shadings)} shading(s) and {len(flat_gradients)} gradFill(s) of no area paint nothing, "
                  "M8-S3)" if flat_shadings or flat_gradients else "")
               + (f" and {_n(len(texts), 'text gradFill')} (M5-R7)" if texts else "") + "; "
               f"{_n(len(page.patterns), 'pattern')}, {_n(len(patterns), 'pattern fill')} (pattFill or tiled "
               "picture)" + background_note
               + (f"; {outlines} gradient / pattern line(s) matched by containment (M1-R48)" if outlines else "")
               + (f"; the paints of {_n(len(presets), 'preset shape')} compared by colour, alpha and width only "
                  "(M1-R47)" if presets else ""))
    problems = []
    if expected != len(paints):
        problems.append(f"count {expected} vs {len(paints)}")
    if unmatched_pdf:
        problems.append(f"unmatched PDF drawings: {len(unmatched_pdf)} ("
                        + _examples(unmatched_pdf, lambda d: f"{d['kind']} {_box(d['bbox'])} "
                                    f"{_hex(d['fill'] if d['kind'] == 'fill' else d['stroke'])}") + ")")
    if unmatched_slide:
        problems.append(f"unmatched slide paints: {len(unmatched_slide)} ("
                        + _examples(unmatched_slide, lambda p: f"{p['kind']} of '{p['name']}' {_box(p['bbox'])}"
                                    + (f" ({p['unresolved']})" if p.get("unresolved") else "")) + ")")
    if mismatched:
        problems.append(f"attribute mismatches: {len(mismatched)} ("
                        + _examples(mismatched, lambda m: f"{m[1]['kind']} of '{m[1]['name']}': "
                                    + ", ".join(m[2])) + ")")
    if background_problem:
        problems.append(background_problem)
    if unmatched_shadings:
        problems.append(f"shadings without a gradFill (0.5 pt): {len(unmatched_shadings)} ("
                        + _examples(unmatched_shadings, _box) + ")")
    if extra_gradients:
        problems.append(f"gradFills without a shading: {len(extra_gradients)} ("
                        + _examples(extra_gradients, lambda s: f"{s['part']} of '{s['name']}' {_box(s['bbox'])}")
                        + ")")
    if extra_texts:
        problems.append(f"text gradFills without a shading: {len(extra_texts)} ("
                        + _examples(extra_texts, lambda t: f"'{t['name']}' {_box(t['bbox'])}") + ")")
    if unmatched_patterns:
        problems.append(f"pattern paints without a pattern fill (0.5 pt): {len(unmatched_patterns)} ("
                        + _examples(unmatched_patterns, _box) + ")")
    if extra_patterns:
        problems.append(f"pattern fills without a PDF pattern paint: {len(extra_patterns)} ("
                        + _examples(extra_patterns, lambda s: f"{s['part']} of '{s['name']}' {_box(s['bbox'])}")
                        + ")")
    if covering:
        problems.append("pictures covering a shading or pattern: "
                        + _examples(covering, lambda c: f"picture {c[0]} covers {c[1]} {_box(c[2])}"))
    counts = {"pdf drawings": expected, "slide paints": len(paints), "unmatched pdf": len(unmatched_pdf),
              "unmatched slide": len(unmatched_slide), "mismatches": len(mismatched), "shadings": len(page.shadings),
              "gradients": len(gradients) + len(flat_gradients), "patterns": len(page.patterns), "pattern fills": len(patterns),
              "preset shapes": len(presets), "invisible paints": len(nothing), "split pieces": added,
              "text gradients": len(texts), "problems": len(problems)}
    if problems:
        return _result("fail", summary + "; " + "; ".join(problems), counts)
    matched = ("every drawing matched (bbox 0.5 pt" + (" but for the preset shapes" if presets else "")
               + ", colour exact, alpha 1 %, width 0.01 pt)"
               + ("; every shading matched by a gradFill" if page.shadings else "")
               + ("; every pattern matched by a pattern fill" if page.patterns else ""))
    if presets:
        return _result("n/a", f"{_n(len(presets), 'preset shape')} outside the M1 geometry model (positions not "
                              f"checked); {summary}; {matched}", counts)
    return _result("pass", f"{summary}; {matched}", counts)


# ---- S4 -----------------------------------------------------------------------------------------------------------


def _inversions(values):
    """Pairs i < j with values[i] > values[j] (merge sort)."""
    def sort(items):
        if len(items) <= 1:
            return items, 0
        middle = len(items) // 2
        left, a = sort(items[:middle])
        right, b = sort(items[middle:])
        merged, count, i, j = [], a + b, 0, 0
        while i < len(left) and j < len(right):
            if left[i] <= right[j]:
                merged.append(left[i])
                i += 1
            else:
                merged.append(right[j])
                count += len(left) - i
                j += 1
        return merged + left[i:] + right[j:], count

    return sort(list(values))[1]


def s4(page, slide):
    """S4 order (module docstring). The page number in a provenance name ``pdf:p<page>:z<op>`` counts from 1 (ruling
    M1-R50: the spec shows it to the user in PowerPoint's selection pane), so it must equal the oracle's 0-based page
    index + 1: the first page is ``pdf:p1:...``, and a ``pdf:p0:...`` name fails. Plan 3's writer follows it.

    A link hotspot, named exactly ``pdf:p<page>:a<i> link`` (``HOTSPOT``), is left out of the order (ruling M3-R18):
    an annotation is not a paint and the writer puts it above every paint; the detail and ``links`` count it. Its
    page number is checked as a paint's is: a hotspot of another page fails like a paint of another page."""
    number = page.index + 1
    link_pages = {i: int(found.group(1)) for i, name in enumerate(slide.order) if (found := HOTSPOT.fullmatch(name))}
    names = [name for i, name in enumerate(slide.order) if i not in link_pages]
    extra = {"links": len(link_pages)} if link_pages else {}
    ignored = (f"; {_n(len(link_pages), 'link hotspot')} ignored in the order (ruling M3-R18: an annotation is not a "
               "paint)" if link_pages else "")
    ops, pages = [], []
    for name in names:
        found = PROVENANCE.match(name)
        if found:
            pages.append(int(found.group(1)))
            ops.append(int(found.group(2)))
    if len(ops) != len(names):
        return _result("n/a", f"{len(names) - len(ops)} of {_n(len(names), 'shape name')} carry no provenance "
                              "'pdf:p<page>:z<op> ': the slide does not record the PDF paint order" + ignored,
                       {"shapes": len(names), "unnamed shapes": len(names) - len(ops), **extra})
    # every name gives this page, the paints' and the hotspots' (M1-R50), the first other one found in z-order
    paint_pages = iter(pages)
    named = [(name, link_pages[i] if i in link_pages else next(paint_pages)) for i, name in enumerate(slide.order)]
    elsewhere = [(name, p) for name, p in named if p != number]
    if not names and not elsewhere:  # M1-R70: nothing on the slide can be out of order
        return _result("pass", "no shapes on the slide: nothing out of PDF paint order" + ignored,
                       {"shapes": 0, **extra})
    if elsewhere:
        name, other = elsewhere[0]
        return _result("fail", f"{_n(len(elsewhere), 'shape name')} carry the provenance of another page (first: "
                               f"'{name}' names page {other}; this is page {number})" + ignored,
                       {"shapes": len(names), "other page shapes": len(elsewhere), **extra})
    n = len(ops)
    tied = sum(c * (c - 1) // 2 for c in np.unique(ops, return_counts=True)[1]) if n else 0
    discordant = _inversions(ops)
    summary = f"{_n(n, 'shape')} in z-order on page {number}, {tied} tied pair(s) ignored"
    if discordant:
        k = next(i for i in range(n - 1) if ops[i] > ops[i + 1])
        return _result("fail", f"not all pairs concordant: {_n(discordant, 'pair')} out of PDF paint order ({summary}; "
                               f"first: '{names[k]}' below '{names[k + 1]}')" + ignored,
                       {"shapes": n, "pairs out of order": discordant, **extra})
    return _result("pass", f"all pairs concordant: the op index never decreases in z-order ({summary})" + ignored,
                   {"shapes": n, "pairs out of order": 0, **extra})


# ---- S5 -----------------------------------------------------------------------------------------------------------


def s5(page, slide):
    # M8-R7: the slide's size is the first page's (scaled into PowerPoint's range), whichever page this is; the other
    # pages are placed on it (s1)
    width, height = slide_frame(page.first_size_pt or page.size_pt)
    want = (width * EMU_PER_PT, height * EMU_PER_PT)
    problems = []
    if slide.size_emu is None:
        problems.append("the deck has no slide size")
    else:
        dx, dy = slide.size_emu[0] - want[0], slide.size_emu[1] - want[1]
        if abs(dx) > SIZE_EMU_TOL + EPS or abs(dy) > SIZE_EMU_TOL + EPS:
            problems.append(f"slide {slide.size_emu[0]} x {slide.size_emu[1]} EMU, CropBox {want[0]:.1f} x "
                            f"{want[1]:.1f} EMU ({width:.3f} x {height:.3f} pt): off by {dx:+.1f}, {dy:+.1f} EMU "
                            "(limit 1)")
    if slide.slide_count != page.page_count:
        problems.append(f"{_n(slide.slide_count, 'slide')} for {_n(page.page_count, 'page')}")
    counts = {"slides": slide.slide_count, "pages": page.page_count, "problems": len(problems)}
    if problems:
        return _result("fail", "; ".join(problems), counts)
    return _result("pass", f"slide size within 1 EMU of the CropBox ({width:.3f} x {height:.3f} pt); "
                           f"{_n(slide.slide_count, 'slide')} for {_n(page.page_count, 'page')}", counts)


# ---- S6 -----------------------------------------------------------------------------------------------------------

# Which of a run's typefaces draws a character (M1-R71): a:ea for East Asian characters, a:cs for complex scripts,
# a:latin for Latin letters and ASCII; punctuation and symbols both kinds of text use (•, ※, “, ①, arrows, Greek,
# Cyrillic, ...) are drawn in either one by PowerPoint's language rules, so either is accepted.
EA_RANGES = ((0x1100, 0x11FF), (0x2E80, 0x2FFF), (0x3000, 0x303F), (0x3040, 0x30FF), (0x3100, 0x312F),
             (0x3130, 0x318F), (0x3190, 0x31FF), (0x3200, 0x33FF), (0x3400, 0x4DBF), (0x4E00, 0x9FFF),
             (0xA000, 0xA4CF), (0xA960, 0xA97F), (0xAC00, 0xD7AF), (0xD7B0, 0xD7FF), (0xF900, 0xFAFF),
             (0xFE30, 0xFE4F), (0xFF00, 0xFFEF), (0x20000, 0x3FFFF))
CS_RANGES = ((0x0590, 0x08FF), (0x0900, 0x0DFF), (0x0E00, 0x0EFF), (0x0F00, 0x0FFF), (0x1780, 0x17FF),
             (0xFB1D, 0xFDFF), (0xFE70, 0xFEFF))
SCRIPT_KEYS = {"latin": ("typeface_latin",), "ea": ("typeface_ea",), "cs": ("typeface_cs",),
               "either": ("typeface_latin", "typeface_ea")}


_SPACELESS = None


def spaceless_families():
    """{a known family without its spaces: the family}, for the known families (ps-family.ts) that have a space and
    whose spaceless form is no known family itself (read once)."""
    global _SPACELESS
    if _SPACELESS is None:
        families = ps_family.known_families()
        _SPACELESS = {}
        for family in sorted(families):
            bare = family.replace(" ", "")
            if bare != family and bare not in families:
                _SPACELESS.setdefault(bare, family)
    return _SPACELESS


def _in_ranges(code, ranges):
    return any(low <= code <= high for low, high in ranges)


def script_of(char):
    """"ea", "cs", "latin" or "either": which typeface of a run draws `char` (see SCRIPT_KEYS)."""
    code = ord(char)
    if _in_ranges(code, EA_RANGES):
        return "ea"
    if _in_ranges(code, CS_RANGES):
        return "cs"
    if 0x20 <= code <= 0x7E or (0xC0 <= code <= 0x24F and code not in (0xD7, 0xF7)) or 0x1E00 <= code <= 0x1EFF:
        return "latin"
    return "either"


def aligned_characters(page, slide):
    """[(k, (char, span), (char, run))]: S2's alignment of the page's and the slide's visible characters, character
    for character, k the 1-based position in the text; None when the texts differ (S2 fails), as then there is no
    alignment to go by (a guessed one pairs characters of different shapes)."""
    pdf_chars = [(c, span) for span in page.spans for c in span["text"] if _visible(c)]
    slide_chars = [(c, run) for run in slide.runs for c in run["text"] if _visible(c)]
    pdf_text, slide_text = _symbol_aligned(pdf_chars, slide_chars)
    if pdf_text != slide_text:
        return None
    return [(k, a, b) for k, (a, b) in enumerate(zip(pdf_chars, slide_chars), start=1)]


def _family_problems(page, slide):
    """M1-R71: (characters compared, characters skipped, [mismatch], [no typeface]) over S2's aligned characters;
    None when the texts differ."""
    pairs = aligned_characters(page, slide)
    if pairs is None:
        return None
    checked, skipped, mismatched, unresolved = 0, 0, [], []
    for k, (char, span), (_, run) in pairs:
        family = span.get("family")
        if not family:
            skipped += 1
            continue
        checked += 1
        # M3-R63: a:ea any nameID 1 record of the font, any language (M3-R44); a:latin and a:cs the English (0x409)
        # nameID 1, else the first (`family`); a family that is a known one without its spaces, that one too (M4)
        spaced = {spaceless_families().get(family)} - {None}
        # a program whose own nameID 1 carries the subset tag ('WRJSDB+Gulim') is the family without it (converter:
        # names.ts typefaceFamily): the typeface is that, not the tag
        untagged = {strip_subset_tag(family)}
        names = {"typeface_ea": set(span.get("families") or ()) | {strip_subset_tag(n) for n in span.get("families") or ()}
                 | {family} | untagged | spaced,
                 "typeface_latin": {family} | untagged | spaced, "typeface_cs": {family} | untagged | spaced}
        script = script_of(char)
        keys = [key for key in SCRIPT_KEYS[script] if run.get(key)]
        allowed = [run[key] for key in keys]
        where = f"character {k} in shape '{run['shape']}'"
        if not allowed:
            unresolved.append(f"{where} (a:{'latin / a:ea' if script == 'either' else script})")
        elif not any(run[key] in names[key] for key in keys):
            mismatched.append(f"{where}: PDF '{family}', slide '{' / '.join(allowed)}'")
    return checked, skipped, mismatched, unresolved


def s6(page, slide):
    typefaces = set(slide.typefaces)
    missing = sorted({strip_subset_tag(f["basefont"]) for f in page.fonts if not f["embedded"]})
    note = f"; not embedded: {', '.join(missing)}" if missing else ""
    named = [f for f in page.fonts if f["family_name1"]]
    # every family name of the page's fonts, in every language (M3-R44): none of them is a BaseFont-style name
    families = {name for f in named for name in [f["family_name1"], *(f.get("family_names1") or ())]}
    families |= {strip_subset_tag(name) for name in families}  # a program whose own nameID 1 carries the subset tag
    wrong = {}
    for font in named:
        family = font["family_name1"]
        candidates = {strip_subset_tag(font["basefont"]), without_style_suffix(font["basefont"]),
                      family.replace(" ", "")}
        for candidate in candidates:
            # M1-R40: a typeface that is the BaseFont or the space-less family, where that is not the family itself
            # (nor another font's family, in any language)
            if candidate and candidate in typefaces and candidate not in families:
                wrong.setdefault(candidate, family)
    # M4 Task 3: a known family without its spaces, whatever the page's fonts
    spaceless = {t: spaceless_families()[t] for t in typefaces if t in spaceless_families()}
    compared = _family_problems(page, slide)
    differ = compared is None
    checked, skipped, mismatched, unresolved = compared or (0, 0, [], [])
    slide_text = any(_visible(c) for run in slide.runs for c in run["text"])
    problems = []
    if wrong:
        problems.append("typeface is not the family name: "
                        + ", ".join(f"{name} (family '{family}')" for name, family in sorted(wrong.items())))
    if spaceless:
        problems.append("typeface is a known family without its spaces: "
                        + ", ".join(f"{name} (family '{family}')" for name, family in sorted(spaceless.items())))
    if mismatched:
        problems.append(f"typeface is not the family of the PDF font that drew the character on "
                        f"{_n(len(mismatched), 'character')} ({_examples(mismatched, str)})")
    if unresolved:
        problems.append(f"no typeface for {_n(len(unresolved), 'character')} ({_examples(unresolved, str)})")
    skipped_note = (f"; {_n(skipped, 'character')} skipped: the PDF font that drew it has no family name (nameID 1)"
                    if skipped else "")
    counts = {"typefaces": len(typefaces), "wrong names": len(wrong), "characters compared": checked,
              "characters skipped": skipped, "mismatches": len(mismatched), "missing typefaces": len(unresolved),
              "fonts not embedded": len(missing), "spaceless names": len(spaceless)}
    if problems:
        return _result("fail", "; ".join(problems) + skipped_note + note, counts)
    if not slide_text:  # M1-R70: no text on the slide, and no typeface of it is a BaseFont-style name
        return _result("pass", ("no typeface on the slide" if not typefaces else
                                f"no text on the slide; none of its {_n(len(typefaces), 'typeface')} is the BaseFont "
                                "or the space-less family name of an embedded PDF font") + note, counts)
    if differ:
        return _result("n/a", "the page's and the slide's texts differ (S2), so no character's typeface was compared "
                              "with the PDF font that drew it; no typeface is the BaseFont or the space-less family "
                              "name" + note, counts)
    if not checked:
        return _result("n/a", "no PDF font of the slide's characters has a family name (nameID 1) to compare with"
                       + skipped_note + note, counts)
    return _result("pass", f"{_n(checked, 'character')} drawn in the family (nameID 1) of the PDF font that drew "
                           "it (a:latin, a:ea or a:cs by the character); no typeface is the BaseFont or the "
                           "space-less family name" + skipped_note + note, counts)


CHECKS = (("S1", s1), ("S2", s2), ("S3", s3), ("S4", s4), ("S5", s5), ("S6", s6))


def check(pdf_page, slide):
    """S1-S6 for one page and the slide made from it; see the module docstring."""
    out = {}
    for key, function in CHECKS:
        try:
            out[key] = function(pdf_page, slide)
        except Exception as exc:  # recorded, so one odd slide does not end a long run
            out[key] = _result("fail", f"internal error in {key} ({type(exc).__name__})")
    return out
