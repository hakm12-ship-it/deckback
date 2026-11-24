"""Facts about one page of a PDF that the structural checks S1-S6 compare (harness/fidelity/structural.py).

    page_facts(pdf, index) -> PageFacts        # index: 0-based page index, as pages[].index of the oracle

Geometry is in points in the slide frame of docs/decisions/0002-inventory-contract.md: origin top-left, y down,
/Rotate and the CropBox offset applied. PyMuPDF's ``get_drawings`` and ``get_text`` give the unrotated page (the
CropBox offset applied), so every path point and glyph origin goes through ``page.rotation_matrix``; the oracle's
paints and the glyph device below are in the slide frame already. PageFacts fields:

* ``index``, ``page_count`` (S5 compares the slide count with it).
* ``size_pt``: (width, height) of the page in that frame, i.e. the CropBox, rotated by /Rotate.
* ``images``: [bbox] of the oracle's ``image`` paints (``fill_image`` and ``fill_image_mask``): the "image paints" of
  spec 5.2 S1 (ruling M1-R37).
* ``shadings``: [bbox] of the oracle's ``shade`` paints (the clip at the time, contract section 5; ruling M1-R35).
* ``patterns``: [bbox] of the oracle's ``pattern`` paints (a tiling pattern fill: pattFill, a tiled picture fill;
  the clip at the time; ruling M1-R42).
* ``first_paint``: ``{"kind", "bbox"}`` of the page's first paint in paint order (the oracle's), ``None`` on a page
  that paints nothing: a full-page shading or pattern painted first is the slide background (M1-R43).
* ``drawings``: [{kind, bbox, fill, stroke, alpha, width, dash, evenOdd, seqno}] from PyMuPDF ``get_drawings``, in
  paint order. A fill+stroke path (``fs``) becomes a ``fill`` entry followed by a ``stroke`` entry, as in the oracle.
  ``fill``/``stroke`` is the sRGB colour as 0-255 integers (``None`` on the other kind), ``alpha`` the fill or stroke
  opacity, ``width`` the line width in pt and ``dash`` the dash array (``[]`` = solid) of a stroke, ``evenOdd`` the
  fill rule of a fill. ``get_drawings`` lists no clip-only path, and no path filled with a pattern or a shading
  (those are ``patterns`` / ``shadings``); the content of tiling-pattern cells is replaced in memory before it runs,
  as the oracle does (``mark_tiling_cells``), so a cell's own paths are not drawings either (contract section 9).
  The bbox is the box of every point of the path, Bezier control points
  included, not widened by the line width (contract section 4, MuPDF's ``fz_bound_path``): PyMuPDF's own ``rect`` can
  miss the start point of a subpath that follows a rectangle (5 pt on a page of the committed atlas), so the bbox is
  computed from the path items instead; on the committed corpus it then equals the oracle's within 0.001 pt.
  ``split`` (rulings M3-R49, M3-R56): what splits.pieces needs to tell the pieces the writer splits the path into (a
  chart's gridlines, one connector each, or its bars, one rect each), from the oracle's own path of the paint; None
  for a path it keeps whole, and for every drawing when the oracle's fill and stroke paints do not line up with the
  drawings.
* ``spans``: [{text, size, color, alpha, font, family, families, bold, italic, origin}] from
  ``get_text('rawdict')`` in its order (content order; the text is unsorted). ``text`` keeps whitespace (S2 removes
  it), ``color`` is sRGB 0-255,
  ``alpha`` 0..1, ``font`` MuPDF's font name (subset tag removed), ``family`` the nameID 1 of that font's embedded
  program (``fonts`` below; ``None`` without one: S6, M1-R71), ``families`` all its nameID 1 records (``[]``
  without one: S6, M3-R44), ``origin`` the span's first glyph origin. A span
  whose glyphs differ in synthetic italic or simulated bold (below) is split there, so every span has one style.
* ``fonts``: [{basefont, family_name1, family_names1, subfamily, embedded}] for every font resource of the page:
  ``basefont`` as the PDF names it (subset tag kept), ``family_name1`` / ``subfamily`` the nameID 1 / nameID 2 of
  the embedded program (fontTools, the English record first; ``None`` without a readable sfnt ``name`` table: a
  damaged program counts as one without), ``family_names1`` every nameID 1 record of it in every language, English
  first (``FontProgram.families``; ``[]`` without), ``embedded`` whether a font program is in the file.

Bold and italic of a span (spec 5.2 S2 compares them with the PPTX ``b`` and ``i``), in this order:

1. The font program's own style. When the font is embedded with a ``name`` table, bold means its subfamily
   (nameID 2) has the word ``Bold`` and italic that it has ``Italic`` or ``Oblique``. This is the Windows family
   model PowerPoint uses: nameID 1 is the family a deck names ("Pretendard Black", "NanumGothicExtraBold") and
   nameID 2 says which of Regular / Bold / Italic / Bold Italic of that family it is. The weight alone does not
   count: "NanumGothicExtraBold" is the Regular member of its own family (``b="0"`` in the deck), although MuPDF's
   bold flag, which follows the weight, is set for it.
   Without a readable ``name`` table (a font that is not embedded, a bare CFF program, a damaged program), MuPDF's
   span flags decide: bold is bit 4 (16), italic bit 1 (2).
2. A simulated style named in the BaseFont: Office writes ``Name,Bold``, ``Name,Italic`` or ``Name,BoldItalic``
   (``simulated_style``). It adds bold / italic.
3. Simulated bold: PowerPoint draws the bold of a family without a Bold face (Pretendard Light / Black,
   NanumGothicExtraBold, ...) by filling and stroking the glyphs in one colour, ``2 Tr`` with a line width of the
   font size / 35. A glyph that is filled and then stroked, as one run, in the same colour with a line width above 0
   is bold. A stroke in another colour (an outline) or a stroke alone (``1 Tr``) is not.
4. Synthetic italic: PowerPoint draws the italic of a family without an italic face (every OFL family of the corpus)
   with a sheared text matrix, ``1 0 0.3333 1 x y Tm``. A glyph whose matrix leans forward by more than
   ``SKEW_ITALIC`` is italic.
MuPDF reports no flag for 3 and 4, so a small device of its own (``glyph_index``) records, per glyph origin, the lean
and whether the glyph was drawn as simulated bold. rawdict gives origins in float32 and the device in double, so an
origin is looked up as the nearest device glyph within ``ORIGIN_TOL`` (rounding both to 0.1 pt lost glyphs on a
0.05 pt boundary).

S7 compares a baseline across each glyph's writing direction (roundtrip.py), and that direction is the PDF's own
(ruling M1-R51), never a guess from neighbouring glyphs: ``text_directions`` gives, per glyph origin, the ``dir`` of
the PyMuPDF rawdict line the character is on. MuPDF derives it from the glyph's text matrix and the font's writing
mode, so it runs down the column for a vertical-mode font (rawdict ``wmode`` 1) and along the line otherwise; a
column of one-glyph horizontal lines is horizontal text.

Errors: every failure to read the input is a ``FactsError`` (harness/fidelity/errors.py) whose message names no file
and no path. A file that is not a PDF (no ``%PDF-`` in its first 1024 bytes: an image, a .pptx) is rejected, never
opened as another format.

Built on PyMuPDF (AGPL): harness only.
"""

import math
import re
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf
import pymupdf.mupdf as m

from harness.fidelity.errors import FactsError
from harness.fonts.program import is_symbol_family, read_program, strip_subset_tag, symbol_cmap
from harness.fidelity.splits import split_args
from harness.oracle.mupdf_inventory import inventory, mark_tiling_cells

__all__ = ["FactsError", "PageFacts", "page_facts", "pdf_page_count", "glyph_index", "GlyphIndex", "text_directions",
           "text_line_boxes"]

SIMULATED = re.compile(r",(Bold|Italic|BoldItalic)$")
PDF_MAGIC = b"%PDF-"
HEADER_BYTES = 1024  # a PDF header may follow up to 1 KB of junk
SKEW_ITALIC = 0.1  # forward shear (tan of the lean) above which a glyph is synthetic italic; PowerPoint uses 0.3333
FLAG_BOLD = 16  # MuPDF span flags
FLAG_ITALIC = 2
ALIGN_TOL = 0.01  # pt: a drawing's bbox and its oracle paint's (equal within 0.001 pt on the committed corpus)
ORIGIN_TOL = 0.05  # pt: a rawdict glyph origin and the device's are the same glyph within this distance
GRID = 0.1  # pt: cell size of the glyph index (>= 2 * ORIGIN_TOL, so the 3 x 3 neighbourhood suffices)
SAME_ORIGIN = 1e-3  # pt: device records this close are one glyph drawn twice (fill + clip, ...)
# Glyphs outside the page box are kept: the oracle does not clip-cull glyphs, and the walker and the slide keep text
# that runs past the slide edge, so S2 and S7 must see it too. PyMuPDF 2.1 clips the text to the page rect unless a
# clip is given, so the clip is the infinite rectangle; TEXT_MEDIABOX_CLIP is dropped as well (with that clip it
# changes nothing in 2.1; without the flag no version clips to the MediaBox).
TEXT_FLAGS = pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES & ~pymupdf.TEXT_MEDIABOX_CLIP
TEXT_CLIP = pymupdf.INFINITE_RECT()


@dataclass
class PageFacts:
    index: int
    page_count: int
    size_pt: tuple
    images: list = field(default_factory=list)
    shadings: list = field(default_factory=list)
    patterns: list = field(default_factory=list)
    first_paint: dict = None
    drawings: list = field(default_factory=list)
    spans: list = field(default_factory=list)
    fonts: list = field(default_factory=list)
    # (width, height) of the PDF's first page in the same frame: the converter takes the slide's size from it (M8-R7);
    # None when it is not known (a facts object made by hand): the page's own size is used then
    first_size_pt: tuple = None


def simulated_style(base_font):
    """(bold, italic) that a BaseFont suffix ,Bold / ,Italic / ,BoldItalic asks for (Office's simulated styles)."""
    found = SIMULATED.search(strip_subset_tag(base_font))
    if not found:
        return False, False
    style = found.group(1)
    return "Bold" in style, "Italic" in style


def without_style_suffix(base_font):
    """A BaseFont without its subset tag and without Office's ,Bold / ,Italic / ,BoldItalic suffix."""
    return SIMULATED.sub("", strip_subset_tag(base_font))


def rgb255(colour):
    """A PyMuPDF colour tuple (0..1) as sRGB 0-255 integers (half up, as the oracle); None stays None."""
    if colour is None:
        return None
    values = list(colour)
    if len(values) == 1:
        values = values * 3
    elif len(values) == 4:  # CMYK: PyMuPDF normally converts already; naive fallback
        c, mg, y, k = values
        values = [(1 - c) * (1 - k), (1 - mg) * (1 - k), (1 - y) * (1 - k)]
    elif len(values) != 3:
        return None
    return [min(255, max(0, int(v * 255 + 0.5))) for v in values]


def parse_dash(dashes):
    """'[ 3 1 ] 0' -> [3.0, 1.0]; '[] 0' or None -> [] (solid)."""
    if not dashes:
        return []
    found = re.match(r"\s*\[([^\]]*)\]", dashes)
    if not found:
        return []
    return [float(v) for v in found.group(1).split()]


def path_bbox(drawing, matrix=None):
    """Box of every point of a get_drawings path (control points included, no line width), each point mapped by
    `matrix` first (the page's rotation_matrix: get_drawings is unrotated)."""
    points = []
    for item in drawing.get("items") or ():
        for value in item[1:]:
            if isinstance(value, pymupdf.Point):
                points.append(value)
            elif isinstance(value, pymupdf.Rect):
                points += [value.tl, value.tr, value.bl, value.br]
            elif isinstance(value, pymupdf.Quad):
                points += [value.ul, value.ur, value.ll, value.lr]
    if not points:
        rect = drawing["rect"]
        points = [rect.tl, rect.tr, rect.bl, rect.br]
    if matrix is not None:
        points = [p * matrix for p in points]
    xs, ys = [p.x for p in points], [p.y for p in points]
    return [min(xs), min(ys), max(xs), max(ys)]


def attach_pieces(drawings, paints):
    """Rulings M3-R49 and M3-R56: each drawing's ``split``, what splits.pieces needs to tell the pieces the writer
    splits its path into (splits.split_args, from the oracle's paths; S3 gives it the page's scale on its slide), None
    for one it keeps whole. The oracle's fill and stroke paints are the drawings in the same order; where they do not
    line up (count, kind or bbox within ALIGN_TOL), no drawing is split, so S3 counts every drawing whole as before.
    Returns whether they lined up."""
    oracle = [(p, args) for p, args in zip(paints, split_args(paints)) if p["kind"] in ("fill", "stroke")]
    aligned = len(oracle) == len(drawings) and all(
        o["kind"] == d["kind"] and all(abs(a - b) <= ALIGN_TOL for a, b in zip(o["bbox"], d["bbox"]))
        for (o, _), d in zip(oracle, drawings))
    for i, drawing in enumerate(drawings):
        drawing["split"] = oracle[i][1] if aligned else None
    return aligned


def _drawings(page):
    out = []
    matrix = page.rotation_matrix
    for d in page.get_drawings():
        kind = d.get("type")
        if kind not in ("f", "s", "fs"):
            continue
        bbox = path_bbox(d, matrix)
        if kind in ("f", "fs"):
            alpha = d.get("fill_opacity")
            out.append({"kind": "fill", "bbox": bbox, "fill": rgb255(d.get("fill")), "stroke": None,
                        "alpha": 1.0 if alpha is None else float(alpha), "width": None, "dash": None,
                        "evenOdd": bool(d.get("even_odd")), "seqno": d.get("seqno")})
        if kind in ("s", "fs"):
            alpha = d.get("stroke_opacity")
            width = d.get("width")
            out.append({"kind": "stroke", "bbox": bbox, "fill": None, "stroke": rgb255(d.get("color")),
                        "alpha": 1.0 if alpha is None else float(alpha),
                        "width": None if width is None else float(width), "dash": parse_dash(d.get("dashes")),
                        "evenOdd": None, "seqno": d.get("seqno")})
    return out


# ---- fonts ------------------------------------------------------------------------------------------------------


def program_names(data):
    """(nameID 1, nameID 2, nameID 6) of an sfnt font program (harness.fonts.program); (None, None, None) without a
    readable name table, for a bare CFF or Type 1 program and for a damaged one (then the span flags decide)."""
    font = read_program(data)
    return font.name(1), font.name(2), font.name(6)


_HEX = r"<([0-9A-Fa-f]+)>"
_BFCHAR = re.compile(r"beginbfchar(.*?)endbfchar", re.S)
_BFRANGE = re.compile(r"beginbfrange(.*?)endbfrange", re.S)


def _utf16(hexstring):
    try:
        return bytes.fromhex(hexstring).decode("utf-16-be")
    except ValueError:
        return ""


def to_unicode_map(text):
    """{code: str} of a ToUnicode CMap's text (bfchar and bfrange); malformed entries are skipped."""
    out = {}
    for block in _BFCHAR.findall(text):
        for src, dst in re.findall(_HEX + r"\s*" + _HEX, block):
            out[int(src, 16)] = _utf16(dst)
    for block in _BFRANGE.findall(text):
        for lo, hi, dst in re.findall(_HEX + r"\s*" + _HEX + r"\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])", block):
            first, last = int(lo, 16), int(hi, 16)
            if last < first or last - first > 0xFFFF:
                continue
            if dst.startswith("["):
                for code, one in zip(range(first, last + 1), re.findall(_HEX, dst)):
                    out[code] = _utf16(one)
            else:
                base = _utf16(dst[1:-1])
                if base:
                    for n, code in enumerate(range(first, last + 1)):
                        out[code] = base[:-1] + chr(ord(base[-1]) + n)
    return out


def symbol_codes(doc, xref, data, basefont=""):
    """M8 round 1c (S2's exact PUA rule): for an embedded symbol-font program (a (3,0) cmap subtable and no Unicode one)
    the PDF's Unicode character (MuPDF reads it from ToUnicode) to the private-use characters deckback writes for it
    (the mapping of round 1a: Type0 Identity-H/V: CID = code, GID through /CIDToGIDMap, the lowest code the (3,0)
    subtable maps to that GID, used as is in U+F000-U+F0FF, else U+F000 + CID up to 0xFF; simple TrueType: U+F000 +
    the code where the subtable maps it as code, F000+code, F100+code or F200+code). {char: [code point, ...]}, empty
    when the font has no ToUnicode; None when the program is no symbol font (ruling M8-R8: a symbol family that is
    flagged symbolic or has a (3,0)-only cmap) or cannot be read."""
    try:
        cmap = symbol_cmap(data, basefont, _descriptor_flags(doc, xref) & 4 != 0)  # {code: glyph id} of the (3,0) subtable (harness.fonts.program, the one reader)
        if cmap is None:
            return None
        kind, value = doc.xref_get_key(xref, "ToUnicode")
        if kind != "xref":
            return {}
        unicode_of = to_unicode_map((doc.xref_stream(int(value.split()[0])) or b"").decode("latin-1"))
        _, subtype = doc.xref_get_key(xref, "Subtype")
        type0 = None
        if subtype == "/Type0":
            lowest = {}
            for code, gid in sorted(cmap.items()):
                lowest.setdefault(gid, code)
            kind, value = doc.xref_get_key(xref, "DescendantFonts")
            if kind == "xref":  # an indirect array (PowerPoint's export writes /DescendantFonts 134 0 R)
                value, kind = doc.xref_object(int(value.split()[0]), compressed=True), "array"
            refs = re.findall(r"([0-9]+)\s+0\s+R", value) if kind == "array" else []
            gid_map = None
            if refs:
                kind, value = doc.xref_get_key(int(refs[0]), "CIDToGIDMap")
                if kind == "xref":
                    gid_map = doc.xref_stream(int(value.split()[0]))
            type0 = (lowest, gid_map)
        out = {}
        for code, text in unicode_of.items():
            if len(text) != 1:
                continue
            pua = None
            if type0 is not None:
                lowest, gid_map = type0
                gid = code
                if gid_map is not None:
                    gid = int.from_bytes(gid_map[2 * code:2 * code + 2], "big") if 2 * code + 2 <= len(gid_map) else 0
                low = lowest.get(gid)
                if low is not None and 0xF000 <= low <= 0xF0FF:
                    pua = low
                elif low is not None and low <= 0xFF:  # as the converter's `own`: F000 + the lowest cmap code, not the CID
                    pua = 0xF000 + low
            elif code <= 0xFF and any(base + code in cmap for base in (0, 0xF000, 0xF100, 0xF200)):
                pua = 0xF000 + code
            if pua is not None:
                out.setdefault(text, []).append(pua)
        return {char: sorted(set(codes)) for char, codes in out.items()}
    except Exception:  # a damaged program or map: no exact mapping (S2 then accepts the code itself only)
        return None


def _descriptor_flags(doc, xref):
    """FontDescriptor /Flags of a font (of its descendant for Type0); 0 if none. Bit 3 (value 4) is symbolic."""
    target = xref
    kind, value = doc.xref_get_key(xref, "DescendantFonts")
    if kind == "xref":
        value, kind = doc.xref_object(int(value.split()[0]), compressed=True), "array"
    if kind == "array":
        refs = re.findall(r"([0-9]+)\s+0\s+R", value)
        if refs:
            target = int(refs[0])
    kind, value = doc.xref_get_key(target, "FontDescriptor/Flags")
    try:
        return int(value) if kind == "int" else 0
    except ValueError:
        return 0


def _descriptor_name(doc, xref):
    """FontDescriptor /FontName of a font (of its descendant for Type0), subset tag removed; '' if none."""
    target = xref
    kind, value = doc.xref_get_key(xref, "DescendantFonts")
    if kind == "array":
        refs = re.findall(r"([0-9]+)\s+0\s+R", value)
        if refs:
            target = int(refs[0])
    kind, value = doc.xref_get_key(target, "FontDescriptor/FontName")
    if kind == "name":
        return strip_subset_tag(value.lstrip("/"))
    return ""


def _pdf_text_string(raw):
    """A PDF text string object ``(...)`` or ``<...>`` as the converter reads it (engine/fonts.ts textEntry): UTF-16BE
    after a byte order mark, else one character a byte; None for anything else."""
    raw = raw.strip()
    if raw.startswith("<") and not raw.startswith("<<") and raw.endswith(">"):
        digits = re.sub(r"\s+", "", raw[1:-1])
        digits += "0" * (len(digits) % 2)
        try:
            data = bytes.fromhex(digits)
        except ValueError:
            return None
    elif raw.startswith("(") and raw.endswith(")"):
        out, i, body = bytearray(), 0, raw[1:-1]
        escapes = {"n": 10, "r": 13, "t": 9, "b": 8, "f": 12}
        while i < len(body):
            c = body[i]
            if c == "\\" and i + 1 < len(body):
                i += 1
                c = body[i]
                octal = re.match(r"[0-7]{1,3}", body[i:])
                if c in escapes:
                    out.append(escapes[c])
                elif octal:
                    out.append(int(octal.group(), 8) & 0xFF)
                    i += len(octal.group()) - 1
                elif c not in "\r\n":
                    out += c.encode("latin-1", "replace")
            else:
                out += c.encode("latin-1", "replace")
            i += 1
        data = bytes(out)
    else:
        return None
    if data[:2] == b"\xfe\xff":
        return data[2:].decode("utf-16-be", "ignore")
    return data.decode("latin-1")


def _descriptor_entries(doc, xref):
    """The FontDescriptor entries the converter reads (engine/fonts.ts) of a font, of its descendant for Type0:
    {flags, weight, family}, None for an absent entry (all None without an indirect descriptor); /FontFamily is a text
    string."""
    entries = {"flags": None, "weight": None, "family": None}
    try:
        target = xref
        kind, value = doc.xref_get_key(xref, "DescendantFonts")
        if kind == "xref":
            value, kind = doc.xref_object(int(value.split()[0]), compressed=True), "array"
        if kind == "array":
            refs = re.findall(r"([0-9]+)\s+0\s+R", value)
            if refs:
                target = int(refs[0])
        kind, value = doc.xref_get_key(target, "FontDescriptor")
        if kind != "xref":
            return entries
        descriptor = int(value.split()[0])
        for key, name in (("Flags", "flags"), ("FontWeight", "weight")):
            kind, value = doc.xref_get_key(descriptor, key)
            if kind in ("int", "float"):
                entries[name] = int(float(value))
        found = re.search(r"/FontFamily\s*(\((?:\\.|[^\\)])*\)|<[0-9A-Fa-f\s]*>)", doc.xref_object(descriptor, compressed=True))
        if found:
            entries["family"] = _pdf_text_string(found.group(1)) or None
    except Exception:
        pass
    return entries


# M8-R13: the family and style of a font whose name table a producer rewrote to the subset tag (Adobe PDF Library's
# PDFMaker, iLovePDF, ...): the converter's rule (scene/fonts.ts describe and taggedStyle), read the same way here
SUBSET_TAG_RE = re.compile(r"^[A-Z]{6}\+")
_NAME_STYLE_TAIL = re.compile(r"-(?:Regular|Roman|Normal|Bold|Italic|Oblique|BoldItalic|BoldOblique)$", re.I)
_NAME_BOLD = re.compile(r"[-,](?:Bold|BoldItalic|BoldOblique)$", re.I)
_NAME_ITALIC = re.compile(r"[-,](?:Italic|Oblique|BoldItalic|BoldOblique)$", re.I)
_NUMBER_ALONE = re.compile(r"^\s*[0-9]+\s*$")
_FS_ITALIC, _FS_BOLD = 1, 1 << 5
_DESC_ITALIC, _DESC_FORCE_BOLD = 1 << 6, 1 << 18


def family_of_name(name):
    """scene/fonts.ts familyOfName: a name without its subset tag and style; None when nothing is left."""
    family = _NAME_STYLE_TAIL.sub("", SUBSET_TAG_RE.sub("", name or "").split(",", 1)[0])
    return family or None


def tagged_font(program, descriptor, basefont):
    """(family, bold, italic) of a font whose nameID 1 is subset-tagged, as the converter reads it; None for any other
    font (its names are believed). The family is the descriptor's /FontFamily, else the name without its tag and style
    (not a number alone: then the family `FontProgram.family_name` gives). The style is the OS/2 fsSelection (bit 0
    italic, bit 5 bold); without an OS/2 table the descriptor's Italic and ForceBold flags and a FontWeight of 700 or
    more; without a /FontFamily the BaseFont's style suffix counts as well, so no style is lost."""
    own = program.name(1)
    if own is None or not SUBSET_TAG_RE.match(own):
        return None
    untagged = family_of_name(own)
    from_tag = descriptor.get("family") or (untagged if untagged is not None and not _NUMBER_ALONE.match(untagged) else None)
    family = from_tag or program.family_name
    if program.fs_selection is not None:
        bold, italic = bool(program.fs_selection & _FS_BOLD), bool(program.fs_selection & _FS_ITALIC)
    else:
        flags = descriptor.get("flags") or 0
        bold = (descriptor.get("weight") or 0) >= 700 or bool(flags & _DESC_FORCE_BOLD)
        italic = bool(flags & _DESC_ITALIC)
    if not descriptor.get("family"):
        name = SUBSET_TAG_RE.sub("", basefont or "")
        bold, italic = bold or bool(_NAME_BOLD.search(name)), italic or bool(_NAME_ITALIC.search(name))
    return family, bold, italic


def _fonts(doc, page):
    """The page's fonts, plus a map from every name MuPDF may give a span to that font's record."""
    fonts, by_name, seen = [], {}, set()
    # the converter's raw reader cannot read an encrypted file (M2-R6): it names a font from pdf.js alone, never through
    # its descriptor or OS/2, so a rewritten name table is read by names there (M8-R13)
    encrypted = doc.xref_get_key(-1, "Encrypt")[0] != "null"
    for xref, _ext, font_type, basefont, _resource, _encoding, _referencer in page.get_fonts(full=True):
        try:
            _name, _ext2, _type2, data = doc.extract_font(xref)
        except Exception:
            data = b""
        program = read_program(data)
        family, subfamily, ps_name = program.family_name, program.name(2), program.name(6)
        family_names = list(program.family_names)
        tagged = tagged_font(program, _descriptor_entries(doc, xref), basefont or "") if data and not encrypted else None
        if tagged is not None:  # M8-R13: the names are the subset tag's, not the font's: the converter's reading
            family = tagged[0]
            family_names = [family] + [n for n in family_names if n != family]
            subfamily = " ".join((["Bold"] if tagged[1] else []) + (["Italic"] if tagged[2] else [])) or "Regular"
        record = {"basefont": basefont, "family_name1": family, "family_names1": family_names,
                  "subfamily": subfamily, "embedded": bool(data) or font_type == "Type3",
                  "symbol_codes": symbol_codes(doc, xref, data, basefont or "") if data else None}
        key = (basefont, family, subfamily, record["embedded"])
        if key not in seen:
            seen.add(key)
            fonts.append(record)
        for name in (strip_subset_tag(basefont), _descriptor_name(doc, xref), ps_name):
            if name:
                by_name.setdefault(name, record)
    return fonts, by_name


def span_style(font_name, flags, font_record):
    """(bold, italic) of a span before simulated bold and synthetic italic: rules 1 and 2 of the module docstring."""
    if font_record is not None and font_record.get("subfamily") is not None:
        words = font_record["subfamily"].split()
        bold, italic = "Bold" in words, ("Italic" in words or "Oblique" in words)
    else:
        bold, italic = bool(flags & FLAG_BOLD), bool(flags & FLAG_ITALIC)
    names = [font_name] + ([font_record["basefont"]] if font_record else [])
    for name in names:
        sim_bold, sim_italic = simulated_style(name)
        bold, italic = bold or sim_bold, italic or sim_italic
    return bold, italic


# ---- the glyph device: lean, simulated bold -----------------------------------------------------------------------


def _unit(x, y):
    length = math.hypot(x, y)
    return (x / length, y / length) if length > 1e-9 else None


class _GlyphDevice(m.FzDevice2):
    """Records every glyph of the page contents in the slide frame: origin, forward lean (tan of the shear angle) and
    whether it was drawn as simulated bold."""

    def __init__(self):
        super().__init__()
        for name in ("fill_text", "stroke_text", "clip_text", "clip_stroke_text", "ignore_text"):
            getattr(self, "use_virtual_" + name)()
        self.glyphs = []  # dicts: x, y, lean, bold
        self._last_fill = None  # (origins, rgb, first record) of the latest fill_text run

    def _run(self, text, ctm):
        start = len(self.glyphs)
        run = m.FzText(m.ll_fz_keep_text(text))
        span = run.m_internal.head
        while span:
            t = span.trm
            # glyph axes in the slide frame: u = x axis, v = y axis of trm x ctm (linear part). The lean is the
            # component of v along u over the area |u x v|: 0 upright, 0.3333 for PowerPoint's synthetic italic,
            # whatever the rotation or size.
            a = t.a * ctm.a + t.b * ctm.c
            b = t.a * ctm.b + t.b * ctm.d
            c = t.c * ctm.a + t.d * ctm.c
            d = t.c * ctm.b + t.d * ctm.d
            cross = a * d - b * c
            lean = (a * c + b * d) / abs(cross) if cross else 0.0
            items = m.FzTextSpan(span)
            for i in range(span.len):
                item = items.items(i)
                x = ctm.a * item.x + ctm.c * item.y + ctm.e
                y = ctm.b * item.x + ctm.d * item.y + ctm.f
                self.glyphs.append({"x": x, "y": y, "lean": lean, "bold": False})
            span = span.next
        return [(g["x"], g["y"]) for g in self.glyphs[start:]], start

    @staticmethod
    def _rgb(colorspace, color, color_params):
        try:
            r, g, b, _ = m.ll_fz_convert_color(colorspace, color, m.ll_fz_device_rgb(), None, color_params)
        except Exception:
            return None
        return [min(255, max(0, int(v * 255 + 0.5))) for v in (r, g, b)]

    def fill_text(self, ctx, text, ctm, colorspace, color, alpha, color_params):
        origins, start = self._run(text, ctm)
        self._last_fill = (origins, self._rgb(colorspace, color, color_params), start)

    def stroke_text(self, ctx, text, stroke, ctm, colorspace, color, alpha, color_params):
        last, self._last_fill = self._last_fill, None
        start = len(self.glyphs)
        origins, _ = self._run(text, ctm)
        if last is None or origins != last[0]:
            return  # a stroke on its own (1 Tr): an outline, not bold
        del self.glyphs[start:]  # the stroke half of a fill + stroke run (2 Tr): the glyphs are recorded already
        width = getattr(stroke, "linewidth", 0) or 0
        rgb = self._rgb(colorspace, color, color_params)
        if width > 0 and rgb is not None and rgb == last[1]:
            for glyph in self.glyphs[last[2]:last[2] + len(origins)]:
                glyph["bold"] = True

    def clip_text(self, ctx, text, ctm, *args):
        self._run(text, ctm)

    def clip_stroke_text(self, ctx, text, stroke, ctm, *args):
        self._run(text, ctm)

    def ignore_text(self, ctx, text, ctm, *args):
        self._run(text, ctm)


class OriginIndex:
    """Records with a glyph origin ``x``, ``y`` (slide frame), found by origin: ``find(x, y)`` gives the nearest
    record within ORIGIN_TOL, else ``None``. Records closer than SAME_ORIGIN are one glyph drawn twice (filled, then
    clipped at ET, ...): the first is kept, merged with the others by ``_merge``."""

    def __init__(self, records):
        self.cells = {}
        for record in records:
            key = (math.floor(record["x"] / GRID), math.floor(record["y"] / GRID))
            bucket = self.cells.setdefault(key, [])
            same = next((g for g in bucket if math.hypot(g["x"] - record["x"], g["y"] - record["y"]) <= SAME_ORIGIN),
                        None)
            if same is None:
                bucket.append(dict(record))
            else:
                self._merge(same, record)

    @staticmethod
    def _merge(kept, record):
        pass

    def find(self, x, y):
        kx, ky = math.floor(x / GRID), math.floor(y / GRID)
        best, best_distance = None, ORIGIN_TOL
        for i in (kx - 1, kx, kx + 1):
            for j in (ky - 1, ky, ky + 1):
                for glyph in self.cells.get((i, j), ()):
                    distance = math.hypot(glyph["x"] - x, glyph["y"] - y)
                    if distance <= best_distance:
                        best, best_distance = glyph, distance
        return best


class GlyphIndex(OriginIndex):
    """The device's glyphs of one page: ``find(x, y)`` gives ``{"lean", "bold"}`` of the glyph at that origin."""

    @staticmethod
    def _merge(kept, record):
        kept["bold"] = kept["bold"] or record["bold"]
        kept["lean"] = max(kept["lean"], record["lean"])


def glyph_index(page):
    """GlyphIndex of every glyph drawn by the page's contents (slide frame: the page transform is applied)."""
    device = _GlyphDevice()
    m.fz_run_page_contents(page.this, device, m.FzMatrix(), m.FzCookie())
    return GlyphIndex(device.glyphs)


def text_directions(page):
    """The writing direction of every character of the page's text, as the PDF gives it (M1-R51): an OriginIndex
    whose ``find(x, y)`` gives ``{"direction": (dx, dy)}`` (a unit vector in the slide frame, ``None`` if MuPDF
    gives none) for the glyph whose origin is (x, y), as the oracle records it.

    The direction is the rawdict ``dir`` of the character's line: MuPDF takes it from the glyph's text matrix and
    the font's writing mode (``wmode`` 1, a vertical font, runs down its column). The glyph origin is the rawdict
    origin for horizontal text. In a vertical-mode line rawdict gives the far end of the glyph's advance instead
    (MuPDF's character box runs from the glyph origin to that point along the line), so the origin is that point
    moved back along ``dir`` by the box's length in that direction: exact for a column along an axis (upright
    vertical text). Points go through ``page.rotation_matrix`` (rawdict gives the unrotated page)."""
    matrix = page.rotation_matrix
    linear = pymupdf.Matrix(matrix.a, matrix.b, matrix.c, matrix.d, 0, 0)
    records = []
    for block in page.get_text("rawdict", flags=TEXT_FLAGS, clip=TEXT_CLIP)["blocks"]:
        for line in block.get("lines", ()):
            vector = pymupdf.Point(line["dir"]) * linear
            direction = _unit(vector.x, vector.y)
            for span in line["spans"]:
                for char in span.get("chars") or ():
                    origin = pymupdf.Point(char["origin"]) * matrix
                    if line.get("wmode") == 1 and direction is not None:
                        box = pymupdf.Rect(char["bbox"]) * matrix
                        length = abs(direction[0]) * box.width + abs(direction[1]) * box.height
                        origin = pymupdf.Point(origin.x - direction[0] * length, origin.y - direction[1] * length)
                    records.append({"x": origin.x, "y": origin.y, "direction": direction})
    return OriginIndex(records)


# ---- spans ------------------------------------------------------------------------------------------------------


def _span_entry(base, chars, style, origin):
    entry = dict(base)
    entry["text"] = "".join(c["c"] for c in chars)
    entry["bold"], entry["italic"] = bool(style[0]), bool(style[1])
    entry["origin"] = origin
    return entry


def _spans(page, by_name):
    glyphs = glyph_index(page)
    matrix = page.rotation_matrix
    out = []
    for block in page.get_text("rawdict", flags=TEXT_FLAGS, clip=TEXT_CLIP)["blocks"]:
        for line in block.get("lines", ()):
            for span in line["spans"]:
                chars = span.get("chars") or []
                if not chars:
                    continue
                record = by_name.get(span["font"])
                bold, italic = span_style(span["font"], span.get("flags", 0), record)
                colour = span.get("color", 0)
                base = {"size": float(span["size"]),
                        "color": [(colour >> 16) & 255, (colour >> 8) & 255, colour & 255],
                        "alpha": span.get("alpha", 255) / 255, "font": span["font"],
                        "family": record["family_name1"] if record else None,
                        "families": list(record["family_names1"]) if record else [],
                        "symbol_codes": record["symbol_codes"] if record else None}
                # split where simulated bold or synthetic italic changes; whitespace joins the current group
                group, group_style, group_origin = [], None, None
                for char in chars:
                    point = pymupdf.Point(char["origin"]) * matrix
                    if group_origin is None:
                        group_origin = (point.x, point.y)
                    if char["c"].strip():
                        glyph = glyphs.find(point.x, point.y)
                        style = (bold or bool(glyph and glyph["bold"]),
                                 italic or bool(glyph and glyph["lean"] > SKEW_ITALIC))
                        if group and group_style is not None and style != group_style:
                            out.append(_span_entry(base, group, group_style, group_origin))
                            group, group_origin = [], (point.x, point.y)
                        group_style = style
                    group.append(char)
                out.append(_span_entry(base, group, (bold, italic) if group_style is None else group_style,
                                       group_origin))
    return out


# ---- the page -----------------------------------------------------------------------------------------------------


def _open_pdf(pdf):
    """The document at `pdf`, checked to be a readable PDF; FactsError (no path in it) otherwise."""
    try:
        with open(Path(pdf), "rb") as handle:
            head = handle.read(HEADER_BYTES)
    except FileNotFoundError:
        raise FactsError("missing input: no such file") from None
    except IsADirectoryError:
        raise FactsError("missing input: a directory, not a file") from None
    except OSError as exc:
        raise FactsError(f"unreadable input ({type(exc).__name__})") from None
    if not head:
        raise FactsError("empty input: the file has no bytes")
    if PDF_MAGIC not in head:
        raise FactsError(f"not a PDF: no %PDF- header in the first {HEADER_BYTES} bytes")
    try:
        doc = pymupdf.open(str(pdf), filetype="pdf")
    except Exception as exc:
        raise FactsError(f"unreadable PDF ({type(exc).__name__})") from None
    if not doc.is_pdf:
        doc.close()
        raise FactsError("not a PDF: the file opened as another format")
    if doc.needs_pass:
        doc.close()
        raise FactsError("encrypted PDF: a password is needed")
    return doc


def page_fonts_not_embedded(pdf, index):
    """The fonts of page `index` (0-based) whose dictionaries carry no font program (no FontFile, FontFile2 or
    FontFile3; a Type3 font draws its own glyphs and is left out), by BaseFont without subset tag, sorted. MuPDF must
    substitute one of these when it draws the page (ruling M8-R3). Raises FactsError only."""
    try:
        doc = _open_pdf(pdf)
        with doc:
            if not isinstance(index, int) or not 0 <= index < len(doc):
                raise FactsError("page index out of range")
            found = set()
            for xref, _ext, font_type, basefont, *_ in doc[index].get_fonts(full=True):
                if font_type == "Type3":
                    continue
                try:
                    data = doc.extract_font(xref)[3]
                except Exception:
                    data = b""
                if not data:
                    found.add(strip_subset_tag(basefont))
            return sorted(found)
    except FactsError as exc:
        raise FactsError(str(exc)) from None
    except Exception as exc:
        raise FactsError(f"unreadable PDF page ({type(exc).__name__})") from None


def embedded_versions(doc, page, pc=None):
    """The version facts (harness/fonts/fontversion.py: PostScript name, family, subfamily, nameID 5 string, head
    revision) of every font program embedded on `page` of the open `doc`, each distinct font once. A font with no
    readable sfnt program is left out. Names and versions only (ruling M8-R9); with `pc` (fontversion.PcFonts) a font
    the PC has in another version also carries its ``advances`` (what its glyphs advance, per 1000 em), which
    ``fontversion.differing`` compares with the PC's copy."""
    from harness.fonts.fontversion import needs_advances, program_version

    found, seen = [], set()
    for xref, _ext, font_type, *_ in page.get_fonts(full=True):
        if font_type == "Type3":
            continue
        try:
            data = doc.extract_font(xref)[3]
        except Exception:
            continue
        facts = program_version(data)
        if facts is None:
            continue
        if pc is not None and needs_advances(facts, pc):
            facts = program_version(data, advances=True) or facts
        key = tuple(facts[k] for k in ("ps", "family", "subfamily", "version", "revision"))
        if key not in seen:
            seen.add(key)
            found.append(facts)
    return found


def page_embedded_versions(pdf, index, pc=None):
    """``embedded_versions`` of page `index` (0-based) of the PDF at `pdf`. Raises FactsError only."""
    try:
        doc = _open_pdf(pdf)
        with doc:
            if not isinstance(index, int) or not 0 <= index < len(doc):
                raise FactsError("page index out of range")
            return embedded_versions(doc, doc[index], pc)
    except FactsError as exc:
        raise FactsError(str(exc)) from None
    except Exception as exc:
        raise FactsError(f"unreadable PDF page ({type(exc).__name__})") from None


def pdf_page_count(pdf):
    """The page count of the PDF at `pdf` after the checks page_facts makes; FactsError (no path) if unreadable."""
    try:
        with _open_pdf(pdf) as doc:
            count = len(doc)
    except FactsError as exc:
        raise FactsError(str(exc)) from None
    except Exception as exc:
        raise FactsError(f"unreadable PDF ({type(exc).__name__})") from None
    if count == 0:
        raise FactsError("unreadable PDF: no pages")
    return count


def _page_facts(pdf, index):
    doc = _open_pdf(pdf)
    with doc:
        mark_tiling_cells(doc)  # in memory only: a pattern cell's content is not page content (contract section 9)
        page_count = len(doc)
        if page_count == 0:
            raise FactsError("unreadable PDF: no pages")
        if not isinstance(index, int) or not 0 <= index < page_count:
            shown = index if isinstance(index, int) else type(index).__name__
            raise FactsError(f"page index out of range: {shown} (the PDF has {page_count} pages)")
        page = doc[index]
        rect = page.rect
        first = doc[0].rect
        fonts, by_name = _fonts(doc, page)
        facts = PageFacts(index=index, page_count=page_count, size_pt=(rect.width, rect.height),
                          first_size_pt=(first.width, first.height),
                          drawings=_drawings(page), spans=_spans(page, by_name), fonts=fonts)
    paints = inventory(str(pdf), pages=[index + 1], detail=False, paths=True)["pages"][0]["paints"]
    attach_pieces(facts.drawings, paints)
    facts.images = [list(p["bbox"]) for p in paints if p["kind"] == "image"]
    facts.shadings = [list(p["bbox"]) for p in paints if p["kind"] == "shade"]
    facts.patterns = [list(p["bbox"]) for p in paints if p["kind"] == "pattern"]
    facts.first_paint = {"kind": paints[0]["kind"], "bbox": list(paints[0]["bbox"])} if paints else None
    return facts


def _line_boxes(page):
    boxes = []
    matrix = page.rotation_matrix
    for block in page.get_text("rawdict", flags=TEXT_FLAGS, clip=TEXT_CLIP)["blocks"]:
        for line in block.get("lines", ()):
            box = None
            for span in line["spans"]:
                if span.get("alpha", 255) == 0:
                    continue  # invisible (Tr 3) or fully transparent text draws nothing
                for char in span.get("chars") or ():
                    if not char["c"].strip():
                        continue
                    rect = pymupdf.Rect(char["bbox"]) * matrix
                    box = rect if box is None else box | rect
            if box is not None and not box.is_empty:
                boxes.append((box.x0, box.y0, box.x1, box.y1))
    return boxes


def page_line_boxes(page):
    """``text_line_boxes`` of an open page (the caller has marked the tiling cells, as ``text_line_boxes`` does): the
    same boxes in the same order."""
    return _line_boxes(page)


def text_line_boxes(pdf, index):
    """The text lines of page `index` (0-based) of the PDF at `pdf`, for V1 judged per line (ruling M4-R11): one box
    (x0, y0, x1, y1, pt, slide frame) per MuPDF rawdict line, the union of the boxes of its visible characters
    (whitespace and spans of alpha 0, invisible Tr 3 text among them, left out), in MuPDF's order; a line with none is
    left out. These are the lines whose writing direction S7 reads (`text_directions`). Raises FactsError only."""
    try:
        doc = _open_pdf(pdf)
        with doc:
            mark_tiling_cells(doc)  # in memory only: a pattern cell's text is not page content (contract section 9)
            if not isinstance(index, int) or not 0 <= index < len(doc):
                raise FactsError("page index out of range")
            return _line_boxes(doc[index])
    except FactsError as exc:
        raise FactsError(str(exc)) from None
    except Exception as exc:  # the type only, its text may quote a path
        raise FactsError(f"unreadable PDF page ({type(exc).__name__})") from None


def page_facts(pdf, index):
    """Facts of page `index` (0-based) of the PDF at `pdf`; see the module docstring. Raises FactsError only."""
    try:
        return _page_facts(pdf, index)
    except FactsError as exc:
        raise FactsError(str(exc)) from None
    except Exception as exc:  # MuPDF or fontTools on a damaged file: the type only, its text may quote a path
        raise FactsError(f"unreadable PDF page ({type(exc).__name__})") from None
