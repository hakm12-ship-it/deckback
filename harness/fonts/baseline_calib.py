"""Baseline calibration (M3 Task 8): where PowerPoint puts the first baseline of a text box, per font family and weight.

    harness/.venv/Scripts/python -m harness.fonts.baseline_calib --fonts lock|windows --out <dir> [--ts <file>]
    harness/.venv/Scripts/python -m harness.fonts.baseline_calib --refit [--ts <file>]

deckback writes each PDF text line as a text box with no insets, no wrapping and the text anchored at the top
(packages/ooxml/src/text.ts), and must place the box so that PowerPoint draws the line's first glyph where the PDF has
it. PowerPoint puts the first baseline `k` x the font size below the box's top, with `k` a property of the font (of its
line metrics) that PowerPoint does not document. This measures it:

1. a deck (python-pptx, through the atlas framework `harness.atlas.deck.AtlasDeck`) with one slide per family and
   weight (Regular, Bold), each holding three text boxes of the text `Hxg 한글 Ágÿ` (`SAMPLE_TEXT`) at 10, 18 and
   36 pt, at known tops (`layout`). Each box is the writer's own text box, byte for byte (`text_box_xml`, ruling
   M3-R37): PowerPoint takes a line's height from its runs and from its paragraph mark, so the run and the mark carry
   exactly the attributes and typeface elements the writer gives them (`packages/ooxml/test/calibration-text-box.json`
   holds cases both sides are tested against). As lowering does, `ea` is the family's Korean name where it has one.
   A character the family's installed faces lack is left out of its text (`sample_text`; NanumGothic has no `Á` or
   `ÿ`): PowerPoint would draw it in another font (Cambria), and a line of two fonts has another baseline. Measured
   with the font alone, k does not depend on the text: Latin only, Hangul only and both give the same k;
2. PowerPoint exports it to PDF (`harness.atlas.export`, the `std` variant: the safe path, rulings M1-R27, M1-R73);
3. each box's baseline is the y of its first glyph's origin in the PDF, read with the PyMuPDF oracle
   (`harness/oracle/mupdf_inventory.py`; ruling M3-R33: the walker equals it within 0.05 pt on every gate page), and
   `k = (baseline - top) / size` (`read_baselines`, `k_of`). A sample whose line still holds glyphs of another font
   (`line_fonts`) is left out;
4. per family: `k` the mean of its samples, `n` their number, `spread` their largest minus smallest k; where both
   weights were measured, the same for each (`regular`, `bold`; ruling M3-R36: NanumGothic's Regular and Bold are two
   files whose baselines differ by 0.08 of the size) (`summarise`);
5. the fallback (`fit_fallback`; ruling M3-R35, M4 Task 3): for a font the table does not hold, deckback takes
   `k = scale x A / (A + D)` (`line_share`): PowerPoint's single line, 1.2 x the size, shared between the font's line
   ascent A and descent D as Windows takes them, the OS/2 win ascent and descent, or for a font with USE_TYPO_METRICS
   (fsSelection bit 7) the typo ascent with the typo line gap over it and the typo descent. `scale` is the least-squares
   fit through the origin over the calibrated families (each weight a point where both were measured). The metrics are
   the installed font files' (`font_faces`): the fit covers every run's families, and the families of another run are
   not in this run's PDF. The run checks them against the programs PowerPoint embedded and says where they differ.

Each run merges its families into `packages/core/src/passes/baseline-calib.ts` (`--ts`; the families of the other font
set stay) and fits the fallback again over the whole table. That file holds family names and numbers only: the families,
`_alias` (each calibrated family's Korean name, nameID 1 for 0x412, which a PDF's font may carry alone, mapped to the
family; `aliases`) and `_fallback`. It is committed. Nothing else of a run is (ruling M3-R3): the deck, the PDF and
`baseline-calib-<fonts>.json` (the samples) stay in `--out`, which must be under out/ or the system temp directory
(`output_allowed`).

- `--fonts lock`: the families of harness/fonts/fonts.lock.json, after `fontcheck` (exit 3 when a locked font is not
  ready). Source Sans 3, the lock's one OpenType-CFF family, is skipped: PowerPoint draws its text as a bitmap, so the
  PDF has no glyph to read.
- `--fonts windows`: Windows and Office fonts (`WINDOWS_FAMILIES`, ruling M4-R8: public sources only): the Windows
  fonts of spec section 7's list (Malgun Gothic, Gulim, Batang, Dotum, Gungsuh, Noto Sans KR, Arial, Calibri, Segoe
  UI, Times New Roman, Cambria, Consolas) and of the atlas-win build (Malgun Gothic Semilight). The deck and PDF embed
  Microsoft fonts. A family that is not installed, or whose text PowerPoint draws as a bitmap or in another font, gives
  no sample and is left out.
- `--refit`: no deck and no PowerPoint; the fallback's `scale` fitted again over the committed table's families.

The table keeps only the families of the two runs' lists (`pruned`): one an older run measured that neither list names
any more leaves it, with its aliases, on the next run or refit (ruling M4-R8).

PowerPoint runs only through `harness.atlas.export` (export.ps1 and DeckbackCom.psm1: a GUID temp copy, never closing
anything it did not start). Exit codes: 0 written; 2 usage error, a refused `--out`, or the export did not finish in
time (left running, nothing stopped: look for a dialog); 3 fonts not ready, the export failed, or no family could be
measured.
"""

import argparse
import json
import math
import os
import re
import sys
import tempfile
from collections import OrderedDict
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_TS = REPO / "packages" / "core" / "src" / "passes" / "baseline-calib.ts"
LOCK = Path(__file__).with_name("fonts.lock.json")

SAMPLE_TEXT = "Hxg 한글 Ágÿ"
SIZES = (10, 18, 36)
TOPS = (60, 140, 260)  # pt from the slide's top, one per size: room for two lines of each below
LEFT = 48
BOX_WIDTH = 720
SLIDE = (960, 540)
STYLES = (False, True)  # bold: Regular, then Bold (synthetic where the family has no Bold)
WINDOWS_FAMILIES = ("Malgun Gothic", "Malgun Gothic Semilight", "Batang", "Gulim", "Dotum", "Gungsuh",
                    "Noto Sans KR", "Arial", "Calibri", "Cambria", "Consolas", "Segoe UI", "Times New Roman")
KOREAN = 0x412
USE_TYPO_METRICS = 0x80  # OS/2 fsSelection bit 7
MAX_ASC = 3  # an ascent past 3 em, or at 0 or below, is not believed (packages/core/src/passes/baseline.ts)

ENTRY_FIELDS = ("k", "n", "spread")
WEIGHTS = ("regular", "bold")
ALIAS_KEY = "_alias"
FALLBACK_KEY = "_fallback"
FALLBACK_FIELDS = ("scale",)

TS_HEAD = """/**
 * The baseline calibration (M3 Task 8): where PowerPoint puts the first baseline of a text box with no insets, as a
 * share `k` of the font size below the box's top, per font family (nameID 1, the typeface name); `n` samples (Regular
 * and Bold at 10, 18 and 36 pt) and the `spread` of their k (largest minus smallest). Where both weights were measured,
 * `regular` and `bold` hold each weight's (ruling M3-R36). `_alias`: a calibrated family's Korean name (nameID 1 for
 * 0x412) to the family. `_fallback`: `scale` in k = scale x A / (A + D) for another font (ruling M3-R35, M4 Task 3), A
 * and D its line ascent and descent (baseline.ts `lineShare`), fitted on the calibrated families.
 *
 * Generated by `python -m harness.fonts.baseline_calib --fonts lock|windows --out <dir>`, which merges each run into this
 * file: do not edit it by hand. Family names and numbers only.
 */
export const BASELINE_CALIB = """
TS_TAIL = " as const;\n"
_TS_BODY = re.compile(r"export const BASELINE_CALIB = (\{.*\}) as const;", re.S)
# A family name: printable, and nothing a path could need.
_BAD_NAME = re.compile(r"[\x00-\x1f\x7f/\\:*?\"<>|]")


@dataclass(frozen=True)
class Box:
    """One calibration text box: on PDF page `page` (0-based), the family and weight it is set in, its font size, its
    left and top edges on the slide (pt, y down) and its text."""

    page: int
    family: str
    bold: bool
    size: float
    left: float
    top: float
    text: str = SAMPLE_TEXT


def sample_text(cmaps):
    """`SAMPLE_TEXT` without the characters that one of a family's faces (`cmaps`: the code points of each) lacks;
    spaces stay. With no face known, `SAMPLE_TEXT` as it is."""
    return "".join(c for c in SAMPLE_TEXT if c == " " or all(ord(c) in cmap for cmap in cmaps))


def layout(families, texts=None):
    """The boxes of a deck of these families: one page per family and weight (Regular, Bold), one box per size, each
    with the family's text (`texts`, else `SAMPLE_TEXT`)."""
    boxes = []
    for family in families:
        text = (texts or {}).get(family, SAMPLE_TEXT)
        for bold in STYLES:
            page = len(boxes) // len(SIZES)
            boxes += [Box(page, family, bold, size, LEFT, top, text) for size, top in zip(SIZES, TOPS)]
    return boxes


# ---- the writer's text box (packages/ooxml/src/text.ts) -------------------------------------------------------------

# packages/ooxml/src/text.ts HANGUL and LINE_BREAK, packages/ooxml/src/xml.ts NOT_XML_CHAR and esc.
_HANGUL = re.compile("[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7a3\ud7b0-\ud7ff\uffa0-\uffdc]")
_NOT_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")
_ESCAPES = {"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"}


def _text_node(text):
    return re.sub(r"[&<>\"']", lambda m: _ESCAPES[m.group(0)], _NOT_XML.sub("", text))


def _faces(run):
    out = ""
    for tag in ("latin", "ea", "cs"):
        face = "" if run.get(tag) is None else _text_node(run[tag])
        out += f'<a:{tag} typeface="{face}"/>' if face else ""
    return out


def text_box_xml(box):
    """The `p:sp` the writer writes (`textBoxXml`) for a text box of the calibration's kind: `box` is {id, name,
    frame: [x, y, w, h] EMU, runs: [{text, sz (100ths of a point), b, i, latin, ea, cs}]}, upright and unflipped, no
    link, `horz`, each run filled black and opaque with no outline, spacing or rise. The run's `a:rPr` and the
    paragraph mark's `a:endParaRPr` (lang, sz, b, i and the typefaces of the last run) are the writer's. None when no
    run has text."""
    written = []
    for run in box["runs"]:
        text = _text_node(run["text"].replace("\n", " ").replace("\r", " "))
        if text:
            written.append((run, text, "ko-KR" if _HANGUL.search(text) else "en-US"))
    if not written:
        return None
    runs = "".join(
        f'<a:r><a:rPr lang="{lang}" sz="{run["sz"]}" b="{int(run["b"])}" i="{int(run["i"])}" spc="0" baseline="0" '
        f'dirty="0"><a:solidFill><a:srgbClr val="000000"/></a:solidFill>{_faces(run)}</a:rPr><a:t>{text}</a:t></a:r>'
        for run, text, lang in written)
    last, _, lang = written[-1]
    attrs = f'lang="{lang}" sz="{last["sz"]}" b="{int(last["b"])}" i="{int(last["i"])}" dirty="0"'
    faces = _faces(last)
    end = f"<a:endParaRPr {attrs}>{faces}</a:endParaRPr>" if faces else f"<a:endParaRPr {attrs}/>"
    x, y, w, h = box["frame"]
    return (f'<p:sp><p:nvSpPr><p:cNvPr id="{box["id"]}" name="{_text_node(box["name"])}"/><p:cNvSpPr txBox="1"/>'
            f'<p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="{x}" y="{y}"/><a:ext cx="{w}" cy="{h}"/></a:xfrm>'
            '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody>'
            '<a:bodyPr vert="horz" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"><a:noAutofit/></a:bodyPr>'
            f"<a:lstStyle/><a:p>{runs}{end}</a:p></p:txBody></p:sp>")


def build_deck(boxes, font_set, path, ea_names=None):
    """Writes the deck of `boxes` to `path`: each box the writer's own text box (`text_box_xml`) holding one run of its
    text in black, its typefaces the family for latin and cs and its Korean name (`ea_names`), else the family, for ea,
    as lowering names them."""
    from pptx.oxml import parse_xml
    from pptx.oxml.ns import nsdecls

    from harness.atlas import drawingml as dml
    from harness.atlas.deck import AtlasDeck

    deck = AtlasDeck("ofl" if font_set == "lock" else "windows", SLIDE, deck=f"baseline-calib-{font_set}")
    pages = {}
    for box in boxes:
        if box.page not in pages:
            pages[box.page] = deck.slide("calib", ["text:baseline-calibration"])
        shapes = pages[box.page].shapes
        run = {"text": box.text, "sz": round(box.size * 100), "b": box.bold, "i": False, "latin": box.family,
               "ea": (ea_names or {}).get(box.family, box.family), "cs": box.family}
        xml = text_box_xml({"id": dml.next_shape_id(shapes), "name": f"Calibration {box.size} pt",
                            "frame": [dml.emu(box.left), dml.emu(box.top), dml.emu(BOX_WIDTH), dml.emu(2 * box.size)],
                            "runs": [run]})
        dml._insert(shapes, parse_xml(xml.replace("<p:sp>", f"<p:sp {nsdecls('p', 'a', 'r')}>", 1)))
    deck.save(path)
    return path


# ---- reading the PDF ---------------------------------------------------------------------------------------------


def _glyphs(pdf, boxes, detail):
    from harness.oracle.mupdf_inventory import inventory

    pages = sorted({box.page + 1 for box in boxes})
    return {page["index"]: page["glyphs"] for page in inventory(str(pdf), pages, detail=detail)["pages"]}


def _in_box(glyph, box):
    return box.left - box.size / 4 <= glyph["x"] and box.top <= glyph["y"] <= box.top + 2 * box.size


def read_baselines(pdf, boxes):
    """Each box's baseline: the y of the origin of its first glyph (its text's first character) in `pdf`, the glyph
    nearest the box's left edge within a quarter of the size, between the box's top and two sizes below it; None when
    there is no such glyph (text PowerPoint drew as a bitmap)."""
    glyphs = _glyphs(pdf, boxes, False)
    out = []
    for box in boxes:
        near = [g for g in glyphs.get(box.page, []) if g["u"] == box.text[0] and _in_box(g, box)
                and abs(g["x"] - box.left) <= box.size / 4]
        out.append(min(near, key=lambda g: abs(g["x"] - box.left))["y"] if near else None)
    return out


def line_fonts(pdf, boxes, baselines):
    """The fonts (the PDF's names, subset tag dropped) of the glyphs on each box's baseline within the box: one, unless
    PowerPoint drew some of its text in another font. An empty set for a box without a baseline."""
    glyphs = _glyphs(pdf, boxes, True)
    out = []
    for box, y in zip(boxes, baselines):
        on = [] if y is None else [g for g in glyphs.get(box.page, []) if _in_box(g, box) and abs(g["y"] - y) <= 0.05]
        out.append({re.sub(r"^[A-Z]{6}\+", "", g["font"]) for g in on})
    return out


def k_of(box, baseline):
    """The baseline's distance below the box's top, as a share of the size."""
    return (baseline - box.top) / box.size


def _stats(ks):
    return {"k": round(sum(ks) / len(ks), 4), "n": len(ks), "spread": round(max(ks) - min(ks), 4)}


def summarise(boxes, ks):
    """Per family, in first-seen order: k the mean of its samples (4 decimals), n their number and spread their
    largest minus smallest k (4 decimals); where both weights have samples, `regular` and `bold` the same of each
    weight's (ruling M3-R36). A box without a sample (None) is left out; a family without any is too."""
    samples = OrderedDict()
    for box, k in zip(boxes, ks):
        if k is not None:
            samples.setdefault(box.family, {False: [], True: []})[box.bold].append(k)
    table = {}
    for family, by_weight in samples.items():
        entry = _stats(by_weight[False] + by_weight[True])
        if by_weight[False] and by_weight[True]:
            entry["regular"], entry["bold"] = _stats(by_weight[False]), _stats(by_weight[True])
        table[family] = entry
    return table


# ---- the fallback ------------------------------------------------------------------------------------------------


def line_share(metrics):
    """A / (A + D) of a font's line metrics (`metrics` as FontInfo holds them, `_metrics_of`): A and D the OS/2 win
    ascent and descent, or with USE_TYPO_METRICS (fsSelection bit 7) the typo ascent plus the typo line gap and minus
    the typo descent, as packages/core/src/passes/baseline.ts `lineShare`; None where they are not plausible (A over
    upm at most 0 or over `MAX_ASC`, a negative D, upm 0)."""
    if metrics["fsSelection"] & USE_TYPO_METRICS:
        a, d = metrics["typoAsc"] + metrics["typoLineGap"], -metrics["typoDesc"]
    else:
        a, d = metrics["winAsc"], metrics["winDesc"]
    if metrics["upm"] <= 0 or a <= 0 or a / metrics["upm"] > MAX_ASC or d < 0:
        return None
    return a / (a + d)


def fit_fallback(points):
    """The fallback's scale over `points` ({label: (k, metrics)}): the least-squares k = scale x `line_share(metrics)`
    through the origin, over the points with a plausible share. Returns {scale (6 decimals), worst (the largest |error|
    with it), rms, errors: {label: error}}. ValueError without a point to fit."""
    shares = {label: line_share(metrics) for label, (_, metrics) in points.items()}
    labels = [label for label, share in shares.items() if share is not None]
    if not labels:
        raise ValueError("no calibrated family to fit")
    scale = round(sum(points[label][0] * shares[label] for label in labels)
                  / sum(shares[label] ** 2 for label in labels), 6)
    errors = {label: scale * shares[label] - points[label][0] for label in labels}
    return {"scale": scale, "worst": max(abs(e) for e in errors.values()),
            "rms": math.sqrt(sum(e * e for e in errors.values()) / len(errors)), "errors": errors}


# ---- the table ---------------------------------------------------------------------------------------------------


def _number(value, what):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError(f"{what} must be a finite number, not {value!r}")
    return value


def _name(name, what):
    if not isinstance(name, str) or not name.strip() or name.startswith("_") or _BAD_NAME.search(name):
        raise ValueError(f"not a {what}: {name!r}")
    return name


def _check_stats(entry, what):
    if not isinstance(entry, dict) or tuple(entry)[:3] != ENTRY_FIELDS:
        raise ValueError(f"{what}: an entry starts with exactly {ENTRY_FIELDS}")
    for field in ENTRY_FIELDS:
        _number(entry[field], f"{what}.{field}")


def _check_table(table):
    """The table's family names, aliases and numbers, and the fallback's metric and numbers; ValueError for anything
    else (a family's entry is k, n, spread, and both weights' or neither; an alias names a family of the table)."""
    families = [key for key in table if not key.startswith("_")]
    extra = set(table) - set(families) - {ALIAS_KEY, FALLBACK_KEY}
    if extra or ALIAS_KEY not in table or FALLBACK_KEY not in table:
        raise ValueError(f"the table holds families, {ALIAS_KEY} and {FALLBACK_KEY}, not {sorted(extra)}")
    for family in families:
        entry = table[_name(family, "family name")]
        _check_stats(entry, family)
        if tuple(entry) not in (ENTRY_FIELDS, ENTRY_FIELDS + WEIGHTS):
            raise ValueError(f"{family}: an entry is {ENTRY_FIELDS}, and {WEIGHTS} both or neither")
        for weight in WEIGHTS[: len(entry) - len(ENTRY_FIELDS)]:
            _check_stats(entry[weight], f"{family}.{weight}")
            if tuple(entry[weight]) != ENTRY_FIELDS:
                raise ValueError(f"{family}.{weight}: exactly {ENTRY_FIELDS}")
    aliases = table[ALIAS_KEY]
    if not isinstance(aliases, dict):
        raise ValueError(f"{ALIAS_KEY} maps names to families")
    for alias, family in aliases.items():
        if _name(alias, "alias") in families or family not in families:
            raise ValueError(f"the alias {alias!r} must name a family of the table and not be one")
    fallback = table[FALLBACK_KEY]
    if not isinstance(fallback, dict) or tuple(fallback) != FALLBACK_FIELDS:
        raise ValueError(f"the fallback is exactly {FALLBACK_FIELDS}")
    if _number(fallback["scale"], "scale") <= 0:
        raise ValueError("the fallback's scale is positive")


def _dump(value):
    return json.dumps(value, ensure_ascii=False)


def _fields(entry, fields):
    return "{ " + ", ".join(f"{_dump(k)}: {_dump(entry[k])}" for k in fields) + " }"


def render_ts(table):
    """The TypeScript module `baseline-calib.ts` of `table` (families, `_alias`, `_fallback`): the families in name
    order, each on a line, then the aliases in name order, then the fallback. ValueError for a name that is not a
    family name or a value that is not a number (`_check_table`)."""
    _check_table(table)
    lines = []
    for family in sorted(key for key in table if not key.startswith("_")):
        entry = table[family]
        weights = "".join(f", {_dump(w)}: {_fields(entry[w], ENTRY_FIELDS)}" for w in WEIGHTS if w in entry)
        lines.append(f"  {_dump(family)}: {_fields(entry, ENTRY_FIELDS)[:-2]}{weights} }},")
    aliases = table[ALIAS_KEY]
    if aliases:
        lines.append(f"  {_dump(ALIAS_KEY)}: {{")
        lines += [f"    {_dump(alias)}: {_dump(aliases[alias])}," for alias in sorted(aliases)]
        lines[-1] = lines[-1][:-1]
        lines.append("  },")
    else:
        lines.append(f"  {_dump(ALIAS_KEY)}: {{}},")
    lines.append(f"  {_dump(FALLBACK_KEY)}: {_fields(table[FALLBACK_KEY], FALLBACK_FIELDS)}")
    return TS_HEAD + "{\n" + "\n".join(lines) + "\n}" + TS_TAIL


def parse_ts(text):
    """`BASELINE_CALIB` of a file `render_ts` wrote, as a dict."""
    found = _TS_BODY.search(text)
    if found is None:
        raise ValueError("not a baseline-calib.ts this script wrote")
    return json.loads(found.group(1))


def merge(old, new, new_aliases=None):
    """The families of `old` with those of `new` over them, in name order, and `_alias`: the aliases of `old` but those
    of a family `new` measures again, with `new_aliases` over them, in name order (no `_fallback`: it is fitted
    again)."""
    families = {key: entry for key, entry in old.items() if not key.startswith("_")}
    families.update(new)
    aliases = {alias: family for alias, family in old.get(ALIAS_KEY, {}).items() if family not in new}
    aliases.update(new_aliases or {})
    merged = {family: families[family] for family in sorted(families)}
    merged[ALIAS_KEY] = {alias: aliases[alias] for alias in sorted(aliases)}
    return merged


def pruned(table):
    """`table` with only the families of the two runs' lists (the lock's and `WINDOWS_FAMILIES`), and only the
    aliases of those (ruling M4-R8); its `_fallback` as it is."""
    kept, skipped = lock_families()
    listed = set(kept) | set(skipped) | set(WINDOWS_FAMILIES)
    out = {key: entry for key, entry in table.items() if not key.startswith("_") and key in listed}
    out[ALIAS_KEY] = {alias: family for alias, family in table.get(ALIAS_KEY, {}).items() if family in out}
    if FALLBACK_KEY in table:
        out[FALLBACK_KEY] = table[FALLBACK_KEY]
    return out


# ---- font metrics ------------------------------------------------------------------------------------------------


def _metrics_of(font):
    """unitsPerEm, the ascent, descent and line gap of hhea and OS/2 typo, the OS/2 win ascent and descent and
    fsSelection of a fontTools font, as FontInfo holds them (packages/core/src/fonts/sfnt.ts readSfntMetrics)."""
    head, hhea, os2 = font["head"], font["hhea"], font["OS/2"]
    return {"upm": head.unitsPerEm, "hheaAsc": hhea.ascent, "hheaDesc": hhea.descent, "hheaLineGap": hhea.lineGap,
            "winAsc": os2.usWinAscent, "winDesc": os2.usWinDescent, "typoAsc": os2.sTypoAscender,
            "typoDesc": os2.sTypoDescender, "typoLineGap": os2.sTypoLineGap, "fsSelection": os2.fsSelection}


def _windows_name(font, name_id, language=None):
    """The Windows record of `name_id` in `language`; without one, the English (0x409) record, else any Windows record.
    None without one."""
    records = [r for r in font["name"].names if r.nameID == name_id and r.platformID == 3
               and (language is None or r.langID == language)]
    records.sort(key=lambda r: r.langID != 0x409)
    for record in records:
        try:
            return record.toUnicode()
        except UnicodeDecodeError:
            continue
    return None


def _is_bold(style):
    """nameID 2 says Bold (Bold, Bold Italic; not SemiBold or ExtraBold), as FontInfo.bold reads it."""
    return re.search(r"(?:^|[^a-z])bold", style or "", re.I) is not None


@dataclass(frozen=True)
class Face:
    """An installed face of a family: its style (nameID 2), its metrics (`_metrics_of`), the code points its cmap maps
    and its Korean family name (nameID 1 for 0x412, else None)."""

    style: str
    metrics: dict
    cmap: frozenset
    korean: str = None

    @property
    def bold(self):
        return _is_bold(self.style)


def _font_files():
    """Every installed font file: those the font registry names (machine and user) and those in the Windows and the
    per-user font folders."""
    from harness.fonts import fontcheck

    files = set()
    try:
        files.update(fontcheck._registry_font_files())
    except Exception:  # no registry (not Windows): the folders only
        pass
    for folder in (Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts",
                   Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "Windows" / "Fonts"):
        if folder.is_dir():
            files.update(str(p) for p in folder.iterdir() if p.suffix.lower() in fontcheck.FONT_SUFFIXES)
    return sorted(files)


def faces_in(paths, families):
    """{family: [Face, ...]} of the font files `paths` whose nameID 1 (a Windows record) is one of `families` (without
    regard to case, as Windows looks it up). A collection is closed once, after all its faces: its faces share one
    reader, and closing one would lose the others."""
    from fontTools.ttLib import TTCollection, TTFont

    wanted = {family.casefold(): family for family in families}
    found = {}
    for path in paths:
        try:
            owner = TTCollection(path, lazy=True) if path.lower().endswith((".ttc", ".otc")) else TTFont(path, lazy=True)
        except Exception:
            continue
        try:
            for font in owner.fonts if isinstance(owner, TTCollection) else [owner]:
                try:
                    family = wanted.get((_windows_name(font, 1) or "").casefold())
                    if family is None:
                        continue
                    found.setdefault(family, []).append(Face(
                        _windows_name(font, 2) or "", _metrics_of(font), frozenset(font.getBestCmap() or {}),
                        _windows_name(font, 1, KOREAN)))
                except Exception:
                    continue
        finally:
            owner.close()
    return found


def font_faces(families):
    """`faces_in` the installed font files."""
    return faces_in(_font_files(), families)


def metrics_for(faces, bold):
    """The metrics FontInfo would hold for a family's text in a weight: the face whose style is that weight's (Bold,
    Regular), else another face of that weight, else the Regular face (a synthetic bold is drawn with it), else the
    first face."""
    named = "bold" if bold else "regular"
    for pick in ([f for f in faces if f.style.casefold() == named], [f for f in faces if f.bold == bold],
                 [f for f in faces if f.style.casefold() == "regular"], faces):
        if pick:
            return pick[0].metrics
    raise ValueError("no face")


def aliases(faces):
    """{Korean name: family} of `faces` ({family: [Face]}): each family's Korean family name where it has one other than
    the family's; a name two families share is left out."""
    names = {}
    for family, fs in faces.items():
        for korean in {f.korean for f in fs if f.korean and f.korean != family}:
            names.setdefault(korean, set()).add(family)
    return {korean: next(iter(fams)) for korean, fams in sorted(names.items())
            if len(fams) == 1 and korean not in faces}


def pdf_font_metrics(pdf):
    """{(family, bold): metrics} of the font programs embedded in `pdf` (what deckback's Scene reads: FontInfo.metrics,
    its bold from nameID 2)."""
    import io

    import pymupdf
    from fontTools.ttLib import TTFont

    doc = pymupdf.open(str(pdf))
    out = {}
    try:
        xrefs = {font[0] for page in doc for font in page.get_fonts()}
        for xref in sorted(xrefs):
            buffer = doc.extract_font(xref)[3]
            if not buffer or buffer[:4] not in (b"\x00\x01\x00\x00", b"true", b"OTTO"):
                continue
            try:
                font = TTFont(io.BytesIO(buffer), lazy=True)
                family = _windows_name(font, 1)
                if family is not None:
                    out.setdefault((family, _is_bold(_windows_name(font, 2))), _metrics_of(font))
                font.close()
            except Exception:
                continue
    finally:
        doc.close()
    return out


# ---- the run -----------------------------------------------------------------------------------------------------


def _inside(path, root):
    return path == root or root in path.parents


def output_allowed(out):
    """Where a run may write (its deck, PDF and samples, which may embed Microsoft fonts): in this checkout only under
    out/ (git-ignored), elsewhere only under the system temp directory."""
    target = Path(out).resolve()
    if _inside(target, REPO):
        return _inside(target, REPO / "out")
    return _inside(target, Path(tempfile.gettempdir()).resolve())


def lock_families(lock=LOCK):
    """The lock's families whose files are all TrueType (PowerPoint embeds them), and those it skips (OpenType-CFF)."""
    data = json.loads(Path(lock).read_text(encoding="utf-8"))
    kept, skipped = [], []
    for fam in data["families"]:
        (kept if all(f["format"] == "ttf" for f in fam["files"]) else skipped).append(fam["family"])
    return kept, skipped


def _powerpoint_state():
    """How many POWERPNT processes run (read-only: tasklist); None off Windows or when it cannot tell."""
    import subprocess

    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq POWERPNT.EXE", "/FO", "CSV", "/NH"], capture_output=True,
                             text=True, timeout=30).stdout
    except Exception:
        return None
    return sum(1 for line in out.splitlines() if line.upper().startswith('"POWERPNT.EXE"'))


def _fit_points(table, faces):
    """The fallback's points: per family of `table` whose faces are installed, each weight (with that weight's metrics,
    `metrics_for`) where both were measured, else the family."""
    points = {}
    for family, entry in table.items():
        if family.startswith("_") or not faces.get(family):
            continue
        if "regular" in entry:
            for weight in WEIGHTS:
                points[f"{family} {weight}"] = (entry[weight]["k"], metrics_for(faces[family], weight == "bold"))
        else:
            points[family] = (entry["k"], metrics_for(faces[family], False))
    return points


def _write_fit(table, faces, ts):
    """Fits the fallback over `table`'s families whose faces are installed, writes the table to `ts` and prints the
    fit; the fit."""
    missing = [f for f in table if not f.startswith("_") and not faces.get(f)]
    if missing:
        print(f"not installed, left out of the fallback fit: {', '.join(missing)}")
    fit = fit_fallback(_fit_points(table, faces))
    table[FALLBACK_KEY] = {key: fit[key] for key in FALLBACK_FIELDS}
    ts.write_text(render_ts(table), encoding="utf-8", newline="\n")
    print(f"fallback over {len(fit['errors'])} points: k = {fit['scale']} x A / (A + D); worst error "
          f"{fit['worst']:.4f}, rms {fit['rms']:.4f}")
    for label, error in fit["errors"].items():
        print(f"  {label:36} error {error:+.4f}")
    return fit


def main(argv=None):
    parser = argparse.ArgumentParser(description="Calibrate PowerPoint's text-box baseline per font family and weight.")
    parser.add_argument("--fonts", choices=("lock", "windows"))
    parser.add_argument("--out", type=Path, help="where the deck, its PDF and the samples go")
    parser.add_argument("--ts", type=Path, default=DEFAULT_TS, help="the baseline-calib.ts to merge into")
    parser.add_argument("--refit", action="store_true", help="only fit the fallback again over the table's families")
    args = parser.parse_args(argv)

    if args.refit:
        table = pruned(parse_ts(args.ts.read_text(encoding="utf-8")))
        _write_fit(table, font_faces([f for f in table if not f.startswith("_")]), args.ts)
        return 0
    if args.fonts is None or args.out is None:
        parser.error("--fonts and --out, or --refit")
    if not output_allowed(args.out):
        print("--out: a calibration writes only under out/ or the system temp directory", file=sys.stderr)
        return 2
    if args.fonts == "lock":
        from harness.fonts import fontcheck

        problems = fontcheck.missing_ofl()
        if problems:
            print("FONTS NOT READY:\n" + "\n".join(problems), file=sys.stderr)
            return 3
        families, skipped = lock_families()
        for family in skipped:
            print(f"{family}: skipped (OpenType-CFF: PowerPoint draws its text as a bitmap)")
    else:
        families = list(WINDOWS_FAMILIES)

    from harness.atlas import export as atlas_export

    args.out.mkdir(parents=True, exist_ok=True)
    stem = f"baseline-calib-{args.fonts}"
    faces = font_faces(families)
    texts = {family: sample_text([face.cmap for face in faces.get(family, [])]) for family in families}
    for family, text in texts.items():
        if family not in faces:
            print(f"{family}: not installed")
        elif text != SAMPLE_TEXT:
            print(f"{family}: without {', '.join(c for c in SAMPLE_TEXT if c not in text)} (not in the font)")
    run_aliases = aliases(faces)
    boxes = layout(families, texts)
    pptx = build_deck(boxes, args.fonts, args.out / f"{stem}.pptx", {f: k for k, f in run_aliases.items()})
    print(f"deck: {len(boxes) // len(SIZES)} slides, {len(boxes)} boxes; POWERPNT before export: {_powerpoint_state()}")
    try:
        result = atlas_export.export(pptx, args.out, ["std"], False)
    except atlas_export.ExportError as exc:
        print(f"export did not finish: {exc}", file=sys.stderr)
        return 2 if exc.left_running else 3
    finally:
        print(f"POWERPNT after export: {_powerpoint_state()}")
    std = result["variants"].get("std") or {}
    if not std.get("ok"):
        print(f"export failed: exit {std.get('exitCode')} {std.get('reason', '')}", file=sys.stderr)
        return 3
    pdf = args.out / f"{stem}_std.pdf"

    baselines = read_baselines(pdf, boxes)
    fonts = line_fonts(pdf, boxes, baselines)
    ks = [None if y is None or len(f) > 1 else k_of(box, y) for box, y, f in zip(boxes, baselines, fonts)]
    for box, y, f in zip(boxes, baselines, fonts):
        style = f"{box.family} {'Bold' if box.bold else 'Regular'} {box.size} pt"
        if y is None:
            print(f"{style}: no glyph (no sample)")
        elif len(f) > 1:
            print(f"{style}: drawn in {len(f)} fonts (no sample)")
    table = summarise(boxes, ks)
    if not table:
        print("no family could be measured", file=sys.stderr)
        return 3
    samples = [{"family": b.family, "bold": b.bold, "size": b.size, "top": b.top, "text": b.text, "baseline": y,
                "fonts": sorted(f), "k": k} for b, y, f, k in zip(boxes, baselines, fonts, ks)]
    (args.out / f"{stem}.json").write_text(json.dumps({"fonts": args.fonts, "samples": samples}, ensure_ascii=False,
                                                      indent=1), encoding="utf-8")

    old = parse_ts(args.ts.read_text(encoding="utf-8")) if args.ts.is_file() else {}
    merged = pruned(merge(old, table, {alias: family for alias, family in run_aliases.items() if family in table}))
    all_faces = {**font_faces([f for f in merged if not f.startswith("_") and f not in faces]), **faces}
    for (family, bold), metrics in pdf_font_metrics(pdf).items():
        if family in table and family in all_faces and metrics != metrics_for(all_faces[family], bold):
            print(f"{family} {'Bold' if bold else 'Regular'}: the installed file's metrics differ from the embedded "
                  f"program's: {metrics_for(all_faces[family], bold)} / {metrics}")
    print(f"{'family':28} {'k':>7} {'n':>3} {'spread':>7}  {'regular':>7} {'bold':>7}   (this run)")
    for family, entry in table.items():
        weights = (f"  {entry['regular']['k']:7.4f} {entry['bold']['k']:7.4f}" if "regular" in entry else "")
        print(f"{family:28} {entry['k']:7.4f} {entry['n']:3d} {entry['spread']:7.4f}{weights}")
    print(f"aliases: {len(merged[ALIAS_KEY])}")
    _write_fit(merged, all_faces, args.ts)
    return 0


if __name__ == "__main__":
    sys.exit(main())
