"""S7 of spec section 5.2: PowerPoint opens the converter's output without a repair, and exporting it to PDF again
gives the composition of the input PDF.

    s7(out_pptx, in_pdf, timeout_sec=None) -> {"status": "pass" | "fail" | "n/a", "detail": str[, "powerpoint": str]
                                               [, "pages": {page number: what differs}]}
    compare(in_pdf, round_trip_pdf, split_fills=None) -> [problem, ...]      # empty: the same composition

"pages" (M5 Task 1: S7 is judged per page) is there when the deck failed on the composition of some pages and of
nothing else: the fidelity run fails those slides only. A deck that failed as a whole (PowerPoint could not open or
export it, a different page count) has none, and every slide fails.

"powerpoint" (ruling M1-R74) is "timeout" when PowerPoint timed out (exitCode 2, or the export script was left
running): S7 fails and the fidelity run skips its later PowerPoint steps (skipped-after-stuck); and "busy" when
PowerPoint refused the calls because it was busy (the export's reason powerpoint-busy): S7 is n/a, since that says
nothing about the deck. run.deck_s7 reads it and leaves it out of the results.

How. The input PDF is read first (pdf_facts.pdf_page_count): an input that is not a readable PDF fails S7 without
starting PowerPoint. Then ``harness.atlas.export.export(out_pptx, <temp dir>, ["std"], ground_truth=False)``:
export.ps1, through harness/ppt/DeckbackCom.psm1, opens a GUID-named temp copy of the deck read-only and windowless,
closes and quits only what the run started, runs every PowerPoint call in a job with a time limit (exitCode 2) and
ends with [Environment]::Exit when a call is stuck (M1-R19). No new PowerPoint code is involved. PowerPoint cannot
open a deck that needs a repair without a dialog, which the time limit turns into exitCode 2; a deck it repairs
silently shows up as a slide count other than the file's (slide-count-mismatch). Both fail S7, as do an open or
export error, a PDF that is missing, and an export that gives no result at all. s7 never raises; off Windows it is
``n/a``.

The PDF is exported into a temp dir that s7 creates and removes: never next to the deck, never under corpus/. When
the export script outlives export()'s own limit, export() leaves it running (stopping it could leave a PowerPoint it
started behind); the temp dir is then removed as far as possible, and the detail says so when it could not be
removed (without its path).

Composition (``compare``), from the oracle inventories (harness/oracle/mupdf_inventory.py) of both PDFs:

* the same number of pages;
* per page, the same number of paints of every kind (paints +-0), a fill or stroke of alpha 0 left out on both sides
  (ruling M3-R53: it paints nothing, and the writer drops it, as S3 has it), a path the writer splits into pieces
  counted one paint per piece, each with its piece's box (ruling M3-R49: a chart's gridlines, one connector each, and
  bars, one rect each; splits.py, from the oracle's paths), on both sides by the same rule (ruling M3-R58): the
  converter's pieces come back as paths of one piece each, which split no further, and a deck that keeps a chart one
  path, as the source deck does (M1-R46), comes back as that one path, split as the input is. So a PDF compared with
  itself has no difference;
* on the round trip's side only, the fills of a shape the writer split into ``a:path``s count as one paint (M3-R55
  (a), M4 Task 4). The writer fills a nonzero path as several ``a:path``s where even-odd would differ (0001 M0-5,
  passes/fillrule.ts), PowerPoint fills and exports each ``a:path`` on its own, and the input has the one PDF paint.
  ``s7`` reads the split from the converter's PPTX (pptx_facts.split_fills: each shape's ``a:path`` boxes and fill
  colour, per page) and ``join_split_fills`` joins, in z-order, the run of consecutive fills of the shape's own colour
  and alpha (within 1 of 255 and 0.01) whose boxes are that shape's ``a:path`` boxes (within 0.5 pt each) into one
  fill with their union box. A piece that is missing, of another colour or more than 0.5 pt off leaves its shape's run
  unjoined, so the counts or the boxes still differ; the input side still
  counts each PDF paint once. ``compare`` without ``split_fills`` joins nothing (a PDF compared with itself);
* content wholly outside the page is left out on both sides (ruling M8-R5: PowerPoint's export drops such objects,
  also of the source deck): a paint whose box does not overlap the page, a glyph whose box (``_glyph_outside``: its origin and size) does not overlap it
  (``on_page``);
* the same text: the glyphs' characters, whitespace removed, in paint order;
* baselines within 0.5 pt: glyphs paired in order (when the text is the same), the offset of the round-trip glyph's
  origin measured perpendicular to the input glyph's writing direction, which comes from the input PDF's text
  itself (M1-R51; pdf_facts.text_directions: the PyMuPDF rawdict line ``dir``, down the column for a vertical-mode
  font), so 90-degree and vertical text is checked as well as horizontal text, and stacked one-glyph lines are
  horizontal text; an offset along the line is not a baseline error. A glyph whose direction is unknown is compared
  by its whole offset;
* path bboxes within 0.5 pt: fill and stroke paints paired in paint order per kind (when the counts agree). This
  stands in for a Hausdorff distance between the outlines in M1: every detail says "bbox proxy for Hausdorff (M1)".

detail never names a file, a path or any text of the deck: export()'s stderr and ExportError messages quote paths,
so they are never used.
"""

import re
import shutil
import sys
import tempfile
from collections import Counter
from pathlib import Path

import pymupdf

from harness.atlas.export import ExportError, export
from harness.fidelity.errors import FactsError
from harness.fidelity.pdf_facts import page_line_boxes, pdf_page_count, text_directions
from harness.fidelity.pptx_facts import split_fills as read_split_fills
from harness.fidelity.splits import split_paints
from harness.oracle.mupdf_inventory import inventory, mark_tiling_cells

BBOX_TOL = 0.5  # pt, path bbox
BASELINE_TOL = 0.5  # pt, glyph origin across the writing direction
EPS = 1e-6
RGB_TOL = 1  # of 255, a split shape's colour against the PPTX's (PowerPoint's export writes it as fractions; M4 Task 6)
ALPHA_TOL = 0.01  # a split shape's alpha against the PPTX's
EXAMPLES = 5
PROXY = "path bbox within 0.5 pt (bbox proxy for Hausdorff (M1))"
NOT_COMPARED = "composition not compared (its path check: bbox proxy for Hausdorff (M1))"
REASON_TOKEN = re.compile(r"^[a-z][a-z-]{0,40}$")
TEMP_LEFT = "; its temp directory could not be removed (an export script may still be writing to it)"
POWERPOINT_TIMEOUT, POWERPOINT_BUSY = "timeout", "busy"  # the result's "powerpoint" marker (ruling M1-R74)


def on_windows():
    """S7 needs the desktop PowerPoint, i.e. Windows."""
    return sys.platform == "win32"


def _result(status, detail, powerpoint=None, pages=None, drift=None):
    """{"status", "detail"}, plus "powerpoint": "timeout" | "busy" when PowerPoint timed out or refused the calls
    (ruling M1-R74: the fidelity run then skips its later PowerPoint steps, or counts the refusal), plus "pages" (M5
    Task 1): {page number: what differs on it} when the deck's failure is the composition of those pages alone, plus
    "drift" (ruling M8-R12): {page number: page_drift} for the pages whose text is the same as the input's."""
    result = {"status": status, "detail": detail}
    if powerpoint:
        result["powerpoint"] = powerpoint
    if pages:
        result["pages"] = pages
    if drift:
        result["drift"] = drift
    return result


PAGE_PROBLEM = re.compile(r"^page ([0-9]+): (.*)$", re.S)


def page_problems(problems):
    """``compare``'s problems as ({page number: its problems joined by "; "}, [problems of the whole deck]) (M5 Task 1:
    S7 is judged per page). A problem that is not "page N: ..." (the page count) belongs to the whole deck."""
    pages, whole = {}, []
    for problem in problems:
        found = PAGE_PROBLEM.match(problem)
        if found:
            number = int(found.group(1))
            pages[number] = f"{pages[number]}; {found.group(2)}" if number in pages else found.group(2)
        else:
            whole.append(problem)
    return pages, whole


def _visible_glyphs(glyphs):
    return [g for g in glyphs if g["u"].strip()]


def baseline_offset(a, b, index):
    """How far glyph `b` (round trip) lies from glyph `a` (input) across `a`'s writing direction (`index`:
    pdf_facts.text_directions of the input page)."""
    found = index.find(a["x"], a["y"]) if index is not None else None
    direction = found["direction"] if found else None
    dx, dy = b["x"] - a["x"], b["y"] - a["y"]
    if direction is None:
        return max(abs(dx), abs(dy))
    return abs(dy * direction[0] - dx * direction[1])


DRIFT_DIGITS = 3  # pt, how the stored per-line drift is rounded
LINE_SLACK = 1.0  # pt: how far outside a text-line box a glyph origin may lie and still belong to that line


def _line_of(boxes, glyph):
    """The index of the text line (``pdf_facts.page_line_boxes``) the input glyph belongs to, None when no box is near
    its origin: among the boxes within LINE_SLACK of the origin, the one whose vertical centre is nearest to it."""
    x, y = glyph["x"], glyph["y"]
    best, best_gap = None, None
    for i, (x0, y0, x1, y1) in enumerate(boxes):
        if x0 - LINE_SLACK <= x <= x1 + LINE_SLACK and y0 - LINE_SLACK <= y <= y1 + LINE_SLACK:
            gap = abs(y - (y0 + y1) / 2)
            if best_gap is None or gap < best_gap:
                best, best_gap = i, gap
    return best


def glyph_drift(a, b, index, scale=1.0):
    """(along, across): how far the round trip's glyph `b` has its origin from the input glyph `a`'s, along and across
    `a`'s writing direction (``index``: pdf_facts.text_directions), in pt, both absolute. `b` is taken back to the input
    page's size by `scale`. A glyph whose direction is unknown has its whole offset counted both ways."""
    found = index.find(a["x"], a["y"]) if index is not None else None
    direction = found["direction"] if found else None
    dx, dy = b["x"] / scale - a["x"], b["y"] / scale - a["y"]
    if direction is None:
        whole = max(abs(dx), abs(dy))
        return whole, whole
    return abs(dx * direction[0] + dy * direction[1]), abs(dy * direction[0] - dx * direction[1])


def page_drift(boxes, glyphs_in, glyphs_out, index, scale=1.0):
    """Ruling M8-R12's evidence for one page whose text is the same on both sides: {"lines": [[max along, max across]
    or None per text line, in the order of ``boxes``], "unassigned": the glyphs that belong to no line}, in pt rounded
    to 1e-3. Numbers only: nothing of the text."""
    along = [0.0] * len(boxes)
    across = [0.0] * len(boxes)
    seen = [False] * len(boxes)
    unassigned = 0
    for a, b in zip(glyphs_in, glyphs_out):
        d_along, d_across = glyph_drift(a, b, index, scale)
        line = _line_of(boxes, a)
        if line is None:
            unassigned += 1
            continue
        seen[line] = True
        along[line], across[line] = max(along[line], d_along), max(across[line], d_across)
    return {"lines": [[round(along[i], DRIFT_DIGITS), round(across[i], DRIFT_DIGITS)] if seen[i] else None
                      for i in range(len(boxes))], "unassigned": unassigned}


def painting(paints):
    """Ruling M3-R53 (as S3's M3-R45, R47, R48): the paints but each fill or stroke of alpha 0, exactly 0, which paints
    nothing (EPS is float noise). The writer drops such a paint, so PowerPoint's export has none of it; both sides of
    the round trip leave them out."""
    return [p for p in paints if p["kind"] not in ("fill", "stroke") or p["alpha"] > EPS]


def _outside(box, size):
    """Whether `box` (x0, y0, x1, y1, pt) lies wholly outside the page: no overlap with it, not even a touch."""
    (width, height) = size
    return box[2] <= 0 or box[0] >= width or box[3] <= 0 or box[1] >= height


GLYPH_REACH = 1.5  # of a glyph's size: how far its box reaches from its origin, whichever way it is turned


def _glyph_outside(glyph, size):
    """Whether a glyph lies wholly outside the page (ruling M8-R5; review M1; M8-R13): its own box (the oracle's ``box``,
    MuPDF's bound of the glyph) has no overlap with the page. A glyph with no box (a space; or a record that carries none)
    is the square of GLYPH_REACH sizes around its origin (its writing direction may be turned); one with no size is its
    origin alone: outside when the origin is past an edge."""
    if glyph.get("box"):
        return _outside(glyph["box"], size)
    reach = GLYPH_REACH * glyph["size"] if glyph.get("size") else 0.0
    x, y = glyph["x"], glyph["y"]
    if reach == 0.0:
        return x < 0 or x > size[0] or y < 0 or y > size[1]
    return _outside((x - reach, y - reach, x + reach, y + reach), size)


def on_page(page):
    """Ruling M8-R5: the page's paints and glyphs but those wholly outside the page (a paint's box with no overlap with
    the page, a glyph's box likewise: ``_glyph_outside``). PowerPoint's own export drops such objects, also when it exports the
    source deck (measured: b-d0f44e176e), so the round trip cannot be compared for them; both sides leave them out
    (the input page's size for the input, the round trip's for the round trip). A new page; the input is not changed."""
    size = page["size"]
    return {**page,
            "paints": [p for p in page["paints"] if not _outside(p["bbox"], size)],
            "glyphs": [g for g in page["glyphs"] if not _glyph_outside(g, size)]}


def split_input(paints, scale=1.0):
    """Rulings M3-R49, M3-R56: the paints as the writer writes them, a path it splits (splits.py, at the page's
    `scale` on its slide) one paint per piece, with the piece's box, in path order. Ruling M3-R58: ``compare`` applies
    it to both sides, the input at its page's scale and the round trip, a slide already, at 1."""
    out = []
    for paint in split_paints(paints, scale):
        pieces = paint.pop("pieces")
        out += [{**paint, "bbox": list(box)} for box in pieces] if pieces else [paint]
    return out


def _boxes_match(a, b):
    return max(abs(x - y) for x, y in zip(a, b)) <= BBOX_TOL + EPS


def _shape_colour(paint, shape):
    """Whether `paint` has the colour and alpha the PPTX gives the split `shape`: each channel within RGB_TOL, the alpha
    (times the alpha of its groups) within ALPHA_TOL; never for a shape or paint without a colour."""
    rgb, alpha = shape.get("rgb"), shape.get("alpha")
    if rgb is None or alpha is None or paint.get("rgb") is None or paint.get("alpha") is None:
        return False
    drawn = paint["alpha"] * paint.get("groupAlpha", 1.0)
    return (all(abs(a - b) <= RGB_TOL for a, b in zip(paint["rgb"], rgb)) and abs(drawn - alpha) <= ALPHA_TOL)


def join_split_fills(paints, shapes):
    """M3-R55 (a): the round trip's paints with the fills of each shape the writer split counted as one paint.

    ``shapes``: the page's split fills in z-order (pptx_facts.split_fills), each the boxes of its ``a:path``s that
    fill and its fill's colour and alpha. For each, from where the last one was found on, the first run of as many
    consecutive paints, all fills of one colour and alpha that is the shape's own (``_shape_colour``; M4 Task 6), whose
    boxes are those boxes in order (each within 0.5 pt) becomes one fill with the union of their boxes, in the place of
    the first. A shape whose run is not there (a piece missing, moved or of another colour) joins nothing. A new list;
    the paints are not changed."""
    out, start = list(paints), 0
    for shape in shapes:
        boxes = shape["boxes"]
        count = len(boxes)
        for i in range(start, len(out) - count + 1):
            run = out[i:i + count]
            first = run[0]
            if all(p["kind"] == "fill" and p.get("rgb") == first.get("rgb") and p.get("alpha") == first.get("alpha")
                   and _shape_colour(p, shape) and _boxes_match(p["bbox"], box) for p, box in zip(run, boxes)):
                union = [min(p["bbox"][0] for p in run), min(p["bbox"][1] for p in run),
                         max(p["bbox"][2] for p in run), max(p["bbox"][3] for p in run)]
                out[i:i + count] = [{**first, "bbox": union}]
                start = i + 1
                break
    return out


def compare(in_pdf, round_trip_pdf, split_fills=None, drift=None):
    """Differences in composition between the input PDF and the round-trip PDF (see the module docstring).
    ``split_fills``: per round-trip page, the shapes the writer split into ``a:path``s (pptx_facts.split_fills of the
    converter's PPTX), whose fills count as one paint; None joins nothing. ``drift``: a dict that gets, for each page
    whose text is the same on both sides, ``{page number: page_drift(...)}`` (ruling M8-R12); None records nothing."""
    expected = inventory(str(in_pdf), detail=False, paths=True, glyph_sizes=True)["pages"]
    actual = inventory(str(round_trip_pdf), detail=False, paths=True, glyph_sizes=True)["pages"]
    if len(expected) != len(actual):
        return [f"{len(actual)} pages exported for {len(expected)} pages in the input"]
    problems = []
    with pymupdf.open(str(in_pdf)) as doc:
        mark_tiling_cells(doc)  # in memory: glyphs of pattern cells are not page glyphs (as for the oracle)
        for position, (page_in, page_out) in enumerate(zip(expected, actual)):
            number = page_in["index"] + 1
            (iw, ih), (ow, oh) = page_in["size"], page_out["size"]
            scale = min(ow / iw, oh / ih) if iw > 0 and ih > 0 and ow > 0 and oh > 0 else 1.0
            split = split_fills[position] if split_fills is not None and position < len(split_fills) else []
            page_in, page_out = on_page(page_in), on_page(page_out)  # M8-R5
            page_in = {**page_in, "paints": split_input(painting(page_in["paints"]), scale)}
            page_out = {**page_out, "paints": join_split_fills(split_input(painting(page_out["paints"]), 1.0), split)}
            kinds_in = Counter(p["kind"] for p in page_in["paints"])
            kinds_out = Counter(p["kind"] for p in page_out["paints"])
            if kinds_in != kinds_out:
                counts = ", ".join(f"{kind} {kinds_in[kind]} vs {kinds_out[kind]}"
                                   for kind in sorted(set(kinds_in) | set(kinds_out))
                                   if kinds_in[kind] != kinds_out[kind])
                problems.append(f"page {number}: paints {counts}")
            else:
                off = []
                for kind in ("fill", "stroke"):
                    paints_in = [p for p in page_in["paints"] if p["kind"] == kind]
                    paints_out = [p for p in page_out["paints"] if p["kind"] == kind]
                    for a, b in zip(paints_in, paints_out):
                        delta = max(abs(x - y) for x, y in zip(a["bbox"], b["bbox"]))
                        if delta > BBOX_TOL + EPS:
                            off.append(delta)
                if off:
                    problems.append(f"page {number}: {len(off)} path bbox(es) off by more than 0.5 pt "
                                    f"(worst {max(off):.2f} pt)")
            glyphs_in = _visible_glyphs(page_in["glyphs"])
            glyphs_out = _visible_glyphs(page_out["glyphs"])
            text_in = "".join(g["u"] for g in glyphs_in)
            text_out = "".join(g["u"] for g in glyphs_out)
            if text_in != text_out:
                problems.append(f"page {number}: text differs ({len(text_in)} vs {len(text_out)} characters, "
                                "whitespace removed)")
            elif glyphs_in:
                index = text_directions(doc[page_in["index"]])
                if drift is not None:
                    drift[number] = page_drift(page_line_boxes(doc[page_in["index"]]), glyphs_in, glyphs_out, index,
                                               scale)
                deltas = [baseline_offset(a, b, index) for a, b in zip(glyphs_in, glyphs_out)]
                off = [delta for delta in deltas if delta > BASELINE_TOL + EPS]
                if off:
                    problems.append(f"page {number}: {len(off)} glyph baseline(s) off by more than 0.5 pt "
                                    f"(worst {max(off):.2f} pt)")
    return problems


def _timed_out(record):
    return record.get("exitCode") == 2 or record.get("reason") in ("timeout", "skipped-after-stuck")


def _export_failure(record):
    code = record.get("exitCode")
    reason = record.get("reason") or ""
    reason = reason if REASON_TOKEN.match(reason) else "unknown"
    if _timed_out(record):
        return ("PowerPoint timed out opening or exporting the deck (exitCode 2: a repair prompt or another dialog?); "
                "nothing was stopped or killed")
    if reason == "slide-count-mismatch":
        return "PowerPoint saw a different slide count than the deck file has (a repaired deck?)"
    if reason == "page-count-mismatch":
        return "the exported PDF has a page count other than the deck's visible slides"
    if reason == "no-output":
        return "PowerPoint wrote no readable PDF"
    return f"PowerPoint could not open or export the deck (exitCode {code}, {reason or 'error'})"


def _round_trip(out_pptx, in_pdf, temp, timeout_sec):
    try:
        result = export(out_pptx, temp, ["std"], False, timeout_sec=timeout_sec)
    except ExportError as exc:
        if exc.left_running:  # PowerPoint may be held by a dialog: the run skips its later PowerPoint steps
            return _result("fail", "the PowerPoint export did not finish within its limit and was left running "
                                   f"(nothing was stopped); {NOT_COMPARED}", POWERPOINT_TIMEOUT)
        return _result("fail", f"the PowerPoint export gave no result (the script failed before exporting); "
                               f"{NOT_COMPARED}")
    except Exception as exc:
        return _result("fail", f"the PowerPoint export could not run ({type(exc).__name__}); {NOT_COMPARED}")
    record = (result.get("variants") or {}).get("std") or {}
    if record.get("reason") == "powerpoint-busy":
        # PowerPoint refused the calls (busy: a dialog open in it). That says nothing about the deck (M1-R74).
        return _result("n/a", "powerpoint-busy: PowerPoint was busy and refused the calls (a dialog open in "
                              f"PowerPoint?); not a fault of the deck; {NOT_COMPARED}", POWERPOINT_BUSY)
    if not record.get("ok"):
        return _result("fail", f"{_export_failure(record)}; {NOT_COMPARED}",
                       POWERPOINT_TIMEOUT if _timed_out(record) else None)
    pdf = temp / f"{Path(out_pptx).stem}_std.pdf"
    if not pdf.is_file():
        return _result("fail", f"PowerPoint reported the export as done, but the exported PDF is missing; "
                               f"{NOT_COMPARED}")
    try:
        split = read_split_fills(out_pptx)
    except FactsError as exc:  # its message names no file and no path
        return _result("fail", f"the converter's PPTX could not be read for its split fills ({exc}); {NOT_COMPARED}")
    drift = {}
    problems = compare(in_pdf, pdf, split, drift)
    checked = (f"checked: paint counts per kind, text (whitespace removed), baselines 0.5 pt across the writing "
               f"direction, {PROXY}")
    if problems:
        shown = "; ".join(problems[:EXAMPLES])
        more = f"; ... ({len(problems) - EXAMPLES} more)" if len(problems) > EXAMPLES else ""
        pages, whole = page_problems(problems)
        return _result("fail", f"PowerPoint opened and exported the deck, but the composition differs: "
                               f"{shown}{more}; {checked}", pages=None if whole else pages,
                       drift=None if whole else drift)
    return _result("pass", f"PowerPoint opened and exported the deck without a repair; same composition as the "
                           f"input PDF; {checked}", drift=drift)


def s7(out_pptx, in_pdf, timeout_sec=None):
    """Round trip of the converter's output through PowerPoint, compared with the input PDF. Never raises."""
    if not on_windows():
        return _result("n/a", f"S7 needs Windows with the desktop PowerPoint; {NOT_COMPARED}")
    try:
        pdf_page_count(in_pdf)
    except FactsError as exc:  # its message names no file and no path
        return _result("fail", f"the input PDF could not be read ({exc}); PowerPoint was not started; "
                               f"{NOT_COMPARED}")
    except Exception as exc:
        return _result("fail", f"the input PDF could not be read ({type(exc).__name__}); PowerPoint was not "
                               f"started; {NOT_COMPARED}")
    temp = None
    try:
        temp = Path(tempfile.mkdtemp(prefix="deckback-s7-"))
        result = _round_trip(out_pptx, in_pdf, temp, timeout_sec)
    except Exception as exc:
        result = _result("fail", f"S7 could not complete ({type(exc).__name__}); {NOT_COMPARED}")
    if temp is not None:
        try:
            shutil.rmtree(temp, ignore_errors=True)
            left = temp.exists()
        except Exception:
            left = True
        if left:
            result = _result(result["status"], result["detail"] + TEMP_LEFT, result.get("powerpoint"))
    return result
