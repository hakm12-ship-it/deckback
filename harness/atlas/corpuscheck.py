"""The checks every file of the public test corpus (corpus/generated/) must pass.

One implementation, two users: harness/atlas/publish.py runs `corpus_problems` on the staged files and installs
nothing if it finds a problem (the repository will be public and its history must never receive a bad PDF), and
harness/atlas/test_corpus.py runs the same functions on what is committed. Every function returns a list of problem
strings (empty = fine); none raises for a file that merely breaks a rule.

- Fonts (reviews M1-R21, M1-R22, M1-R29, Task 7b): every font object of a PDF (whether a page uses it, an
  annotation's appearance or nothing at all; minor m10) is embedded as a static TrueType program (`glyf`, no `fvar`)
  whose (nameID 1 family, nameID 6 PostScript name) pair is one file of harness/fonts/fonts.lock.json, with the PDF's
  BaseFont that PostScript name too, and so is every font program embedded in the file. A base-14 or otherwise
  unembedded font is a problem, and so is a program that is not TrueType (a bare CFF or Type 1 program) or cannot be
  read (harness/fonts/program.py reads them; minor m18). Across the corpus the pairs must be exactly the lock's
  TrueType files (M1-R31): the smoke deck alone has to exercise every one.
- Personal data: the PDFs' Info dictionary and XMP name only `deckback harness` as author and PowerPoint as creator and
  producer, and nothing else; the decks' and their embedded workbooks' dc:creator and cp:lastModifiedBy are
  `deckback harness` or empty (an Office account name would otherwise travel into a public repository).
- Decks name only lock families (the OpenType-CFF sample, Source Sans 3, only on the slide atlas/fonts/01).
- Ground-truth PNGs are 1920x1080 and 8-bit truecolour.
"""

import functools
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

import pymupdf
from lxml import etree
from PIL import Image

from harness.atlas.features import cff_families
from harness.fonts import fontcheck
from harness.fonts.program import read_program, strip_subset_tag
from harness.ppt.pngmode import png_colour_type

DEFAULT_LOCK = fontcheck.DEFAULT_LOCK
HARNESS_AUTHOR = "deckback harness"
POWERPOINT = re.compile(r"^Microsoft® PowerPoint®( \S.*)?$")  # e.g. "Microsoft® PowerPoint® 2024"
TITLE = re.compile(r"^deckback feature atlas: [a-z0-9-]+$")
INFO_KEYS = {"Title", "Author", "Subject", "Keywords", "Creator", "Producer", "CreationDate", "ModDate"}
XMP_ELEMENTS = {"xmpmeta", "RDF", "Description", "Producer", "Keywords", "title", "creator", "description",
                "CreatorTool", "CreateDate", "ModifyDate", "DocumentID", "InstanceID", "Alt", "Seq", "li"}
NS = {"rdf": "http://www.w3.org/1999/02/22-rdf-syntax-ns#", "dc": "http://purl.org/dc/elements/1.1/",
      "pdf": "http://ns.adobe.com/pdf/1.3/", "xmp": "http://ns.adobe.com/xap/1.0/",
      "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
      "ep": "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties",
      "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
      "p": "http://schemas.openxmlformats.org/presentationml/2006/main"}
DESCENDANT_FONTS = {"/CIDFontType0", "/CIDFontType2"}  # checked through the Type0 font that uses them
FONT_FILE = re.compile(r"/(FontFile[23]?)\s+(\d+)\s+\d+\s+R")
THEME_REF = re.compile(r"^\+(mj|mn)-(lt|ea|cs)$")
CFF_SLIDE_ID = "atlas/fonts/01"  # the one slide that may name an OpenType-CFF family
LABEL_NAME = "Atlas Label"
GT_SIZE = (1920, 1080)
STEMS = ("probe", "atlas-smoke")
SMOKE_STEM = "atlas-smoke"
PROBE_GT = ["probe_gt/slide1.png", "probe_gt/slide2.png", "probe_gt/slide3.png", "probe_gt/map.json"]


# --- the lock ---------------------------------------------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def _lock():
    return json.loads(DEFAULT_LOCK.read_text(encoding="utf-8"))["families"]


def lock_truetype_pairs():
    """{(nameID 1 family, nameID 6 PostScript name)} of every TrueType (`ttf`) file in the lock."""
    return {(family["family"], file["postscriptName"])
            for family in _lock() for file in family["files"] if file["format"] == "ttf"}


def lock_pairs():
    """The same for every lock file, the OpenType-CFF one included."""
    return {(family["family"], file["postscriptName"]) for family in _lock() for file in family["files"]}


def lock_families():
    return {family["family"] for family in _lock()}


# --- PDF fonts --------------------------------------------------------------------------------------------------------


def program_problems(label, data):
    """(problems, (family, PostScript name) or None) of one embedded font program: TrueType (glyf; so no CFF and no
    Type 1, wrapped or bare), not variable (no fvar), readable, and its (nameID 1, nameID 6) pair one lock file."""
    font = read_program(data)
    if font.format == "empty":
        return [f"{label}: no font program"], None
    if font.format == "raw-cff-or-type1":
        return [f"{label}: not TrueType (a bare CFF or Type 1 program, no sfnt wrapper)"], None
    if font.format == "damaged":
        return [f"{label}: the font program cannot be read ({font.error})"], None
    problems = []
    if "glyf" not in font.tables:
        problems.append(f"{label}: not TrueType (no glyf)")
    if font.variable:
        problems.append(f"{label}: variable font (fvar)")
    pair = (font.name(1), font.name(6))
    if pair not in lock_pairs():
        problems.append(f"{label}: family/PostScript name {pair!r} is not one lock file")
    return problems, (pair if None not in pair else None)


def pdf_font_problems(pdf):
    """(problems, {(family, PostScript name)}) for every font object of `pdf` and every font program embedded in it
    (minor m10: not only the fonts the pages' resources name; an annotation's appearance stream or an object nothing
    refers to may hold one too).

    Each font (a Type0 font is checked with its descendant) must be embedded, its program must pass
    `program_problems`, and its BaseFont (subset tag removed) must be a lock PostScript name. A font that is not
    embedded (a base-14 font, or any other name only) is a problem of its own. Then every FontFile, FontFile2 and
    FontFile3 stream of the file whose program no font has shown is checked the same way."""
    problems, pairs, checked = [], set(), set()
    ps_names = fontcheck.lock_postscript_names()
    with pymupdf.open(pdf) as doc:
        for xref in range(1, doc.xref_length()):
            if doc.xref_get_key(xref, "Type") != ("name", "/Font"):
                continue
            subtype = doc.xref_get_key(xref, "Subtype")[1]
            if subtype in DESCENDANT_FONTS:
                continue
            base_font, ext, _kind, program = doc.extract_font(xref)
            base = strip_subset_tag(base_font)
            label = f"{base} (xref {xref}, {subtype.lstrip('/')})"
            if ext == "n/a" or not program:
                problems.append(f"{label}: not embedded")
                continue
            checked.add(hashlib.sha256(program).hexdigest())
            found, pair = program_problems(label, program)
            problems += found
            if base not in ps_names:
                problems.append(f"{label}: BaseFont is not a lock PostScript name")
            if pair is not None:
                pairs.add(pair)
        for xref in range(1, doc.xref_length()):
            text = doc.xref_object(xref, compressed=True)
            if "/FontFile" not in text:
                continue
            for match in FONT_FILE.finditer(text):
                program = doc.xref_stream(int(match.group(2)))
                digest = hashlib.sha256(program or b"").hexdigest()
                if digest in checked:
                    continue
                checked.add(digest)
                found, pair = program_problems(f"font program (xref {match.group(2)}, {match.group(1)})", program)
                problems += found
                if pair is not None:
                    pairs.add(pair)
    return problems, pairs


def coverage_problems(pairs):
    """The embedded pairs must be exactly the lock's TrueType files (M1-R31)."""
    wanted = lock_truetype_pairs()
    problems = [f"lock font {family} / {ps} is never embedded" for family, ps in sorted(wanted - set(pairs))]
    problems += [f"embedded font {family} / {ps} is not a lock TrueType file"
                 for family, ps in sorted(set(pairs) - wanted)]
    return problems


# --- PDF metadata -----------------------------------------------------------------------------------------------------


def pdf_metadata_problems(pdf):
    """The Info dictionary and the XMP packet of a PowerPoint export of a harness deck: the author is the deck's
    (`deckback harness`), creator and producer are PowerPoint, the title is the deck's, there are no other fields and no
    other XMP elements. PowerPoint takes the author from the file's properties, so an Office account name would show
    up here."""
    problems = []
    with pymupdf.open(pdf) as doc:
        info, packet = doc.metadata, doc.get_xml_metadata()
        kind, value = doc.xref_get_key(-1, "Info")
        keys = set(doc.xref_get_keys(int(value.split()[0]))) if kind == "xref" else set()
    if info["author"] != HARNESS_AUTHOR:
        problems.append(f"Info Author is {info['author']!r}, not {HARNESS_AUTHOR!r}")
    for field in ("creator", "producer"):
        if not POWERPOINT.match(info[field] or ""):
            problems.append(f"Info {field.capitalize()} is {info[field]!r}, not PowerPoint's")
    if not TITLE.match(info["title"] or ""):
        problems.append(f"Info Title is {info['title']!r}, not a deckback feature atlas title")
    for field in ("subject", "keywords"):
        if info[field]:
            problems.append(f"Info {field.capitalize()} is not empty: {info[field]!r}")
    problems += [f"Info key {key} is not expected" for key in sorted(keys - INFO_KEYS)]

    if not packet.strip():
        return [*problems, "no XMP metadata"]
    try:
        root = etree.fromstring(packet.encode("utf-8"))
    except etree.XMLSyntaxError as exc:
        return [*problems, f"XMP metadata is not XML ({exc})"]
    creators = root.xpath("//dc:creator//rdf:li/text()", namespaces=NS)
    if creators != [HARNESS_AUTHOR]:
        problems.append(f"XMP dc:creator is {creators!r}, not [{HARNESS_AUTHOR!r}]")
    for path, name in (("//xmp:CreatorTool/text()", "xmp:CreatorTool"), ("//pdf:Producer/text()", "pdf:Producer")):
        values = root.xpath(path, namespaces=NS)
        if not values or not all(POWERPOINT.match(v) for v in values):
            problems.append(f"XMP {name} is {values!r}, not PowerPoint's")
    unexpected = {etree.QName(e).localname for e in root.iter() if isinstance(e.tag, str)} - XMP_ELEMENTS
    problems += [f"XMP element {name} is not expected" for name in sorted(unexpected)]
    return problems


# --- decks ------------------------------------------------------------------------------------------------------------


def _packages(label, data):
    """(label, zipfile) of an Office package and of every package nested in it (a chart's embedded workbook)."""
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        yield label, zf
        for part in list(zf.namelist()):
            if part.endswith((".xlsx", ".docx", ".pptx")):
                yield from _packages(f"{label} [embedded {part}]", zf.read(part))


def _metadata_problems(label, zf):
    problems = []
    if "docProps/core.xml" in zf.namelist():
        core = etree.fromstring(zf.read("docProps/core.xml"))
        for path, name in (("//dc:creator", "dc:creator"), ("//cp:lastModifiedBy", "cp:lastModifiedBy")):
            values = [(e.text or "") for e in core.xpath(path, namespaces=NS)]
            problems += [f"{label}: {name} is {v!r}, not {HARNESS_AUTHOR!r} or empty" for v in values
                         if v not in (HARNESS_AUTHOR, "")]
    if "docProps/app.xml" in zf.namelist():
        app = etree.fromstring(zf.read("docProps/app.xml"))
        for name in ("Company", "Manager"):
            problems += [f"{label}: {name} is {e.text!r}, not empty" for e in app.xpath(f"//ep:{name}", namespaces=NS)
                         if e.text]
    return problems


def _slide_label(slide_xml):
    root = etree.fromstring(slide_xml)
    texts = root.xpath(f'//p:sp[p:nvSpPr/p:cNvPr/@name="{LABEL_NAME}"]//a:t/text()', namespaces=NS)
    return "".join(texts)


def pptx_problems(pptx):
    """Metadata of the deck and of its embedded workbooks (dc:creator and cp:lastModifiedBy are `deckback harness` or
    empty, no Company or Manager) and the fonts it names: slides, masters, theme, charts and the workbooks' styles name
    lock families or theme references (+mj-lt, ...) only, and an OpenType-CFF family only on the slide
    atlas/fonts/01."""
    pptx = Path(pptx)
    problems, named = [], 0
    ordinary = lock_families() - set(cff_families())
    for label, zf in _packages(pptx.name, pptx.read_bytes()):
        problems += _metadata_problems(label, zf)
        top = label == pptx.name
        for part in zf.namelist():
            if top and part.endswith(".xml"):
                data = zf.read(part)
                faces = [t.decode("utf-8") for t in re.findall(rb'typeface="([^"]*)"', data)]
                allowed = set(ordinary)
                if re.fullmatch(r"ppt/slides/slide\d+\.xml", part) and _slide_label(data) == CFF_SLIDE_ID:
                    allowed |= set(cff_families())
                place = part
            elif not top and part == "xl/styles.xml":
                faces = [t.decode("utf-8") for t in re.findall(rb'<name val="([^"]*)"', zf.read(part))]
                allowed, place = set(ordinary), f"{label}:{part}"
            else:
                continue
            named += len(faces)
            for face in faces:
                if face not in allowed and not THEME_REF.match(face):
                    where = "" if face not in cff_families() else f" (an OpenType-CFF family: only on {CFF_SLIDE_ID})"
                    problems.append(f"{pptx.name}/{place}: typeface {face!r} is not allowed here{where}")
    if not named:
        problems.append(f"{pptx.name}: names no typeface at all")
    return problems


# --- ground truth and the whole corpus --------------------------------------------------------------------------------


def png_problems(path):
    """A ground-truth PNG is 1920x1080 and 8-bit RGB or RGBA (colour type 2 or 6); a palette PNG is an error."""
    try:
        with Image.open(path) as image:
            size = image.size
        colour_type = png_colour_type(path)
    except (OSError, ValueError) as exc:
        return [f"{Path(path).name}: not a readable PNG ({type(exc).__name__})"]
    problems = []
    if size != GT_SIZE:
        problems.append(f"{Path(path).name}: {size[0]}x{size[1]}, not {GT_SIZE[0]}x{GT_SIZE[1]}")
    if colour_type not in (2, 6):
        problems.append(f"{Path(path).name}: PNG colour type {colour_type}, not 2 (RGB) or 6 (RGBA)")
    return problems


def corpus_problems(root):
    """Every problem of the corpus laid out under `root` as in corpus/generated/: the files are all there, every PDF is
    the export its stamp records of the committed deck and manifest (ruling M1-R77), the PDFs and decks pass the
    checks above, the ground truth is sound, and the fonts embedded across the PDFs are exactly the lock's TrueType
    files (the smoke deck's own PDFs too)."""
    from harness.atlas.export import stamp_path, stamp_problem

    root = Path(root)
    required = []
    for stem in STEMS:
        required += [f"{stem}.pptx", f"{stem}_std.pdf", f"{stem}_notags.pdf", f"{stem}.manifest.json",
                     stamp_path(".", stem).name]
    required += PROBE_GT
    problems = [f"{rel}: missing" for rel in required if not (root / rel).is_file()]

    def present(rel):
        return (root / rel).is_file()

    all_pairs, complete = set(), True
    for stem in STEMS:
        if present(f"{stem}.pptx"):
            problems += pptx_problems(root / f"{stem}.pptx")
        for variant in ("std", "notags"):
            rel = f"{stem}_{variant}.pdf"
            if not present(rel):
                complete = False
                continue
            if present(stamp_path(".", stem).name):  # M1-R77: the export of the committed deck and manifest
                stale = stamp_problem(root / rel, variant, root / f"{stem}.pptx", root / f"{stem}.manifest.json")
                problems += [f"{rel}: {stale}"] if stale else []
            font_problems, pairs = pdf_font_problems(root / rel)
            problems += [f"{rel}: {p}" for p in font_problems]
            if not pairs:
                problems.append(f"{rel}: embeds no font at all")
            problems += [f"{rel}: {p}" for p in pdf_metadata_problems(root / rel)]
            if stem == SMOKE_STEM:
                problems += [f"{rel}: {p}" for p in coverage_problems(pairs)]
            all_pairs |= pairs
    for rel in PROBE_GT:
        if rel.endswith(".png") and present(rel):
            problems += [f"{rel}: {p}" for p in png_problems(root / rel)]
    if complete:
        problems += [f"corpus: {p}" for p in coverage_problems(all_pairs)]
    return problems
