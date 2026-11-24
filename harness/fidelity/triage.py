"""Triage of a results file for the tier-B bar (M8): merge re-measured decks, apply the font rule, re-run the structural
checks from the stored outputs, count the bar, and sort every failing slide into one cause.

    harness/.venv/Scripts/python -m harness.fidelity.triage merge   <results> <re-measured results> --out <file>
    harness/.venv/Scripts/python -m harness.fidelity.triage fonts   <results> --out <file>        # fontException + pass
    harness/.venv/Scripts/python -m harness.fidelity.triage recheck <results> --out <file>        # S1-S6 again
    harness/.venv/Scripts/python -m harness.fidelity.triage summary <results>                     # the bar's numbers
    harness/.venv/Scripts/python -m harness.fidelity.triage causes  <results> --out <file>        # the cause table

It works from a results file (the stop rule's number is ``summary.bar`` of a file this tool or run.py wrote) and, for
``fonts``, ``recheck`` and ``causes``, from the tier-B PDFs in ``corpus/public-real`` and the converter's outputs and
renders that the run left under ``out/fidelity`` (nothing is rendered here and PowerPoint is never started). Tier-B decks
are named by id only.

* ``merge`` replaces the real decks of the first file by the same ids of the second (a re-measure with ``--ids``, as
  the font re-measure of r0 was).
* ``fonts`` marks every bar slide's font exception (run.py: M8-R3, ``mupdf-substitution``, from the page's font
  dictionaries; spec 5.5, ``missing-font``, for a page that uses a font of ``COMMERCIAL_MISSING``) and judges it again
  (``run.slide_passes``). Measured values never change, only the rule that reads them.
* ``recheck`` runs S1-S6 again on the stored PDF and PPTX of every bar slide (S7 and the renders are kept): after a
  change of a structural rule it re-scores a run without measuring anything.
* ``causes``: every failing bar slide gets every cause tag that applies (``tags_for``) and one primary cause, the first
  of its tags in ``PRIORITY``. The cutoffs are the constants below; they and the list are the cause table's method
  (0011), so a later round's table compares with the first. Where the V1 / V2 residual lies (text lines, images,
  shadings, patterns, drawings, symbol glyphs) is recomputed from the stored renders (``residuals``).
"""

import argparse
import copy
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from harness.fidelity import run

REPO = Path(__file__).resolve().parents[2]
PX = 2  # px per pt of the renders
TEXT_SHARE = 0.5  # of the residual on text lines: the slide's problem is text drift
SYMBOL_SHARE = 0.25  # of the residual on symbol-font glyphs: the problem is a symbol glyph
IMAGE_SHARE = 0.5  # of the residual on pictures: picture pixels
COMMERCIAL_MISSING = ("MS PGothic",)  # spec 5.5: the commercial fonts the measuring PC cannot have (the cloud ones come by themselves: M8-R2)
NUMERIC = re.compile(r"^[0-9]+$")
SYMBOL_FONT = re.compile(r"wingding|webding|symbol|marlett|mt ?extra", re.I)
STYLE_SUFFIX = re.compile(r"[-,](?:Bold|Italic|BoldItalic|Regular|Light|Semibold|SemiBold|Black|Medium|Thin|Oblique|"
                          r"BoldMT|ItalicMT|BoldItalicMT|Roman|Book|Heavy|Condensed|Narrow|Demi|ExtraBold|ExtraLight|"
                          r"SemiLight|Semilight|Hairline)\w*$")
GATES = ("V1", "V2", "S1", "S2", "S3", "S4", "S5", "S6", "S7")
S_GATES = run.S_KEYS + ("S7",)

PRIORITY = [
    "whole-slide picture",
    "fallback picture (S1)",
    "off-page content dropped",
    "invisible text dropped (S2)",
    "text differs (S2, other)",
    "vector paints dropped (S3)",
    "zero-length strokes (dots) dropped",
    "font: numeric family name (PPTX-embedded font)",
    "font: free font missing",
    "symbol-font glyph (Wingdings bullet)",
    "invisible text not round-tripped (S7)",
    "text: line wrap differs",
    "text drift (line direction)",
    "picture pixels",
    "gradient (pixels)",
    "vector edges (pixels)",
    "reference: non-embedded font (MuPDF)",
    "renderer noise (V1 passes)",
    "renderer noise (px32_shift1 only)",
    "S3 rule: picture over shading / degenerate gradient",
    "S6 n/a: non-embedded font (no family name)",
    "S7 image count (round trip)",
    "S7 baselines / paints",
    "font exception (commercial font missing)",
    "unclassified",
]
EXCEPTION_PASSES = "passes under the font exception"
# the visual tags a missing-font exception leaves out (spec 5.5: S1-S7 only)
VISUAL_TAGS = frozenset({"text drift (line direction)", "picture pixels", "gradient (pixels)", "vector edges (pixels)",
                         "reference: non-embedded font (MuPDF)", "renderer noise (V1 passes)",
                         "renderer noise (px32_shift1 only)", "font exception (commercial font missing)"})


# ---- reading and writing results ----------------------------------------------------------------------------------


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(results, path):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(results, ensure_ascii=False, indent=1) + "\n")


def bar_decks(results):
    return [d for d in results["decks"] if d["set"] == "real" and d.get("bar")]


def with_summary(results):
    """`results` with its summary made again from its decks (run.summarise), the rest of the summary kept. A slide of a
    real deck that was not rendered (off the bar, M8-R1) is null, not a failure, as run.py writes it now."""
    old = results["summary"]
    new = copy.deepcopy(results)
    for deck in new["decks"]:
        if deck["set"] == "real" and deck["reasons"].get("render") == run.OFF_BAR:
            for slide in deck["slides"]:
                slide["pass"] = None
                slide.pop("passReason", None)
    new["summary"] = run.summarise(new["decks"], old.get("privateUnreadable", 0), old.get("powerpoint"))
    return new


# ---- merge --------------------------------------------------------------------------------------------------------


def merge(base, remeasured):
    """`base` with its real decks replaced by the real decks of the same id in `remeasured` (a ``--ids`` re-measure).
    The summary is made again; ``options.merged`` records which ids came from the second file."""
    new = {d["id"]: d for d in remeasured["decks"] if d["set"] == "real"}
    unknown = sorted(set(new) - {d["id"] for d in base["decks"] if d["set"] == "real"})
    if unknown:
        raise ValueError(f"the re-measure has {len(unknown)} deck(s) the base file does not: {', '.join(unknown[:5])}")
    merged = copy.deepcopy(base)
    merged["decks"] = [copy.deepcopy(new.get(d["id"], d)) if d["set"] == "real" else d for d in merged["decks"]]
    merged["options"] = {**merged["options"], "merged": sorted(new)}
    return with_summary(merged)


# ---- the font rule ------------------------------------------------------------------------------------------------


def basefont_family(basefont):
    """A BaseFont's family: no subset tag, style suffix or ``MT`` / ``PS`` ending (Arial-BoldMT -> Arial)."""
    from harness.fidelity import pdf_facts

    name = STYLE_SUFFIX.sub("", pdf_facts.without_style_suffix(basefont))
    return re.sub(r"MT$|PSMT$|PS$", "", name)


def pdf_page_fonts(pdf):
    """[(families, not embedded, version-differing, version-unverifiable)] per page of the PDF: the family names of the page's fonts (the font
    program's nameID 1, else the BaseFont's family), the BaseFonts with no font program
    (pdf_facts.page_fonts_not_embedded) and the PostScript names of the embedded fonts that this PC has in another
    version (M8-R9, fontversion.differing), then the PostScript names of the embedded fonts whose advances could not be
    compared with the PC's copy (version-unverifiable: not an exception)."""
    import pymupdf

    from harness.fidelity import pdf_facts
    from harness.fonts import fontversion

    pc = fontversion.pc_index()
    pages = []
    with pymupdf.open(pdf) as doc:
        for page in doc:
            fonts, _ = pdf_facts._fonts(doc, page)
            families = {f["family_name1"] or basefont_family(f["basefont"]) for f in fonts}
            missing = sorted({pdf_facts.strip_subset_tag(f["basefont"]) for f in fonts if not f["embedded"]})
            unverifiable = []
            newer = sorted({f.get("ps") or f.get("family") or "" for f in
                            fontversion.differing(pdf_facts.embedded_versions(doc, page, pc), pc,
                                                  unverifiable=unverifiable)})
            unclear = sorted({f.get("ps") or f.get("family") or "" for f in unverifiable})
            pages.append((families, missing, newer, unclear))
    return pages


def font_exception_of(families, not_embedded, commercial=COMMERCIAL_MISSING, mupdf=True, version_differs=(),
                      version=True):
    """The slide's font exception from its page's fonts: MISSING_FONT (spec 5.5) wins over MUPDF_SUBSTITUTION (M8-R3,
    left out with ``mupdf=False``: the rules of r0), which wins over FONT_VERSION (M8-R9: `version_differs` names the
    embedded fonts that this PC has in another version; left out with ``version=False``: the rules of r1)."""
    if {f.lower() for f in families} & {c.lower() for c in commercial}:
        return run.MISSING_FONT
    if mupdf and not_embedded:
        return run.MUPDF_SUBSTITUTION
    return run.FONT_VERSION if version and version_differs else None


def apply_font_rule(results, page_fonts, commercial=COMMERCIAL_MISSING, mupdf=True, version=True):
    """`results` with every bar slide's ``fontException`` set from its page's fonts (``page_fonts(deck id)`` ->
    [(families, not embedded)] per page) and its ``pass`` judged again (run.slide_passes); the measured values are
    untouched. ``options.commercialMissing`` records the commercial list. A slide whose exception is gone loses the
    key. ``mupdf=False`` applies the spec 5.5 exception alone, the rule of r0 (609 / 1,172 -> 618 / 1,163);
    ``version=False`` leaves out M8-R9 (the rules of r1). A page entry is (families, not embedded[, version-differing])."""
    new = copy.deepcopy(results)
    unverifiable = 0
    for deck in bar_decks(new):
        pages = page_fonts(deck["id"])
        for slide in deck["slides"]:
            families, missing, *rest = pages[slide["index"]] if slide["index"] < len(pages) else (set(), [])
            exception = font_exception_of(families, missing, commercial, mupdf, rest[0] if rest else (), version)
            slide.pop("fontException", None)
            slide.pop("fontVersionUnverifiable", None)
            if exception:
                slide["fontException"] = exception
            if version and len(rest) > 1 and rest[1] and exception != run.FONT_VERSION:
                slide["fontVersionUnverifiable"] = True  # a version string differs, advances not comparable: no exception
                unverifiable += 1
            run.judge(slide, exception)
    new["options"] = {**new["options"], "commercialMissing": sorted(commercial)}
    if version:
        new["options"]["fontVersionUnverifiable"] = {"slides": unverifiable}
    return with_summary(new)


def fonts_from_corpus(root):
    """``page_fonts`` for apply_font_rule from the tier-B PDFs under `root`, one deck read once."""
    cache = {}

    def page_fonts(deck_id):
        if deck_id not in cache:
            cache.clear()  # one deck at a time
            cache[deck_id] = pdf_page_fonts(Path(root) / "corpus" / "public-real" / f"{deck_id}.pdf")
        return cache[deck_id]

    return page_fonts


# ---- S1-S6 again from the stored outputs --------------------------------------------------------------------------


def recheck(results, root, out_root=None, on_deck=None):
    """`results` with S1-S6 of every bar slide computed again on the stored PDF and PPTX (run.structural), S7 and the
    renders kept, and ``pass`` judged again. A deck whose output is gone keeps its record (and is listed in
    ``options.recheck.skipped``)."""
    root = Path(root)
    out_root = Path(out_root) if out_root else root / "out" / "fidelity"
    new = copy.deepcopy(results)
    skipped = []
    for deck in bar_decks(new):
        pdf = root / "corpus" / "public-real" / f"{deck['id']}.pdf"
        pptx = out_root / deck["id"] / deck["variant"] / "out.pptx"
        if not pptx.is_file() or not pdf.is_file():
            skipped.append(deck["id"])
            continue
        for slide in deck["slides"]:
            slide["s"].update(run.structural(pdf, pptx, slide["index"]))
            run.judge(slide, slide.get("fontException"))
        if on_deck:
            on_deck(deck["id"])
    new["options"] = {**new["options"], "recheck": {"structural": "S1-S6", "skipped": sorted(skipped)}}
    return with_summary(new)


# ---- the bar's numbers --------------------------------------------------------------------------------------------


def bar_numbers(results):
    """What the stop rule needs, from the slides of the bar decks as they stand: {"decks", "slides", "pass", "fail",
    "fontException": {...}, "gates": {gate: {"pass", "fail", "na"}}}. A V2 not measured counts n/a."""
    summary = run.bar_summary(results["decks"])
    if summary is None:
        return None
    gates = {g: {"pass": 0, "fail": 0, "na": 0} for g in GATES}
    for deck in bar_decks(results):
        for slide in deck["slides"]:
            for gate in ("V1", "V2"):
                value = slide[gate.lower()]
                gates[gate]["na" if value is None or value == run.OFF_BAR_V2
                            else "pass" if value["pass"] else "fail"] += 1
            for gate in S_GATES:
                gates[gate][{"pass": "pass", "fail": "fail", "n/a": "na"}[slide["s"][gate]["status"]]] += 1
    return {**summary, "gates": gates}


# ---- where the residual lies --------------------------------------------------------------------------------------

NAMES = {0: "elsewhere", 1: "drawing", 2: "pattern", 3: "shading", 4: "image", 5: "text", 6: "symbol"}


def failing_gates(slide):
    """The gates of a slide that fail, as its font exception reads them (run.slide_passes): V2 is left out under
    MISSING_FONT and MUPDF_SUBSTITUTION, V1 under MISSING_FONT and FONT_VERSION (M8-R9); an S gate fails when its
    status is not pass."""
    exception = slide.get("fontException")
    bad = []
    for gate in ("V1", "V2"):
        record = slide[gate.lower()]
        skipped = (exception == run.MISSING_FONT or (exception == run.MUPDF_SUBSTITUTION and gate == "V2")
                   or (exception == run.FONT_VERSION and gate == "V1"))
        if record is not None and not skipped and not record.get("pass"):
            bad.append(gate)
    return bad + [g for g in S_GATES if slide["s"][g]["status"] != "pass"]


def _boxes_px(boxes, shape):
    import numpy as np

    height, width = shape
    out = []
    for b in boxes:
        x0, y0 = max(0, int(np.floor(b[0] * PX)) - 2), max(0, int(np.floor(b[1] * PX)) - 2)
        x1, y1 = min(width, int(np.ceil(b[2] * PX)) + 2), min(height, int(np.ceil(b[3] * PX)) + 2)
        if x1 > x0 and y1 > y0:
            out.append((x0, y0, x1, y1))
    return out


def symbol_boxes(pdf, index):
    """Boxes (pt) of the glyphs a symbol font draws on the page."""
    import pymupdf

    from harness.fidelity import pdf_facts

    boxes = []
    with pymupdf.open(pdf) as doc:
        page = doc[index]
        for block in page.get_text("rawdict", flags=pdf_facts.TEXT_FLAGS, clip=pdf_facts.TEXT_CLIP)["blocks"]:
            for line in block.get("lines", ()):
                for span in line["spans"]:
                    if SYMBOL_FONT.search(span.get("font", "")):
                        for ch in span.get("chars") or ():
                            r = pymupdf.Rect(ch["bbox"]) * page.rotation_matrix
                            boxes.append((r.x0, r.y0, r.x1, r.y1))
    return boxes


def region_map(pdf, index, shape):
    """0 elsewhere, 1 drawing, 2 pattern, 3 shading, 4 image, 5 text line, 6 symbol glyph (later ones win)."""
    import numpy as np

    from harness.fidelity import pdf_facts

    facts = pdf_facts.page_facts(pdf, index)
    lines = pdf_facts.text_line_boxes(pdf, index)
    regions = np.zeros(shape, np.uint8)
    for code, boxes in ((1, [d["bbox"] for d in facts.drawings if d.get("bbox")]), (2, facts.patterns),
                        (3, facts.shadings), (4, facts.images), (5, lines), (6, symbol_boxes(pdf, index))):
        for x0, y0, x1, y1 in _boxes_px(boxes, shape):
            regions[y0:y1, x0:x1] = code
    return regions, facts


def shares(mask, regions):
    import numpy as np

    total = int(mask.sum())
    if not total:
        return {}, 0
    counts = np.bincount(regions[mask], minlength=7)
    return {NAMES[i]: round(int(c) / total, 3) for i, c in enumerate(counts) if c}, total


def _ground_truth(out_root, deck_id, index, shape):
    from harness.fidelity import metrics

    folder = Path(out_root) / "gt" / deck_id / f"{shape[1]}x{shape[0]}"
    try:
        mapping = json.loads((folder / "map.json").read_text(encoding="utf-8"))
    except OSError:
        return None
    hidden = [mapping["stdPage"][str(n)] is None for n in range(1, mapping["slides"] + 1)]
    paired = run.variant_slides("pdf", hidden)
    if index >= len(paired):
        return None
    path = folder / f"slide{paired[index]}.png"
    return metrics.load_png(path) if path.is_file() else None


def v1_failing_mask(gt, out, line_regions):
    """The pixels that V1's own residual counts (M4-R11): the 3 x 3 eroded differences of `gt` against `out`, each text
    line's pixels taken under the best shift of that line (metrics.line_residual), the pixels of no line unshifted. Its
    count is the slide's ``residual3Lines``."""
    from scipy import ndimage
    import numpy as np

    from harness.fidelity import metrics

    if not line_regions:
        return ndimage.binary_erosion(metrics.diff_mask(gt, out), structure=np.ones((3, 3), bool))
    owner = metrics.line_owners(gt.shape, line_regions)
    eroded = {shift: ndimage.binary_erosion(metrics.diff_mask(gt, metrics.shifted(out, *shift)),
                                            structure=np.ones((3, 3), bool)) for shift in metrics.LINE_SHIFTS}
    final = eroded[(0, 0)] & (owner < 0)
    for i in range(len(line_regions)):
        best = min(metrics.LINE_SHIFTS, key=lambda s: (int(np.count_nonzero(eroded[s] & (owner == i))),
                                                       metrics.LINE_SHIFTS.index(s)))
        final |= eroded[best] & (owner == i)
    return final


def residuals(deck_id, pdf, index, slide, out_root):
    """Where the failing measure of the slide lies, recomputed from the stored renders: {"v1Share", "v1Px",
    "v1Measure", "v2Share", "v2Px", "v2Measure", ...}; None without the output's render. Only a failing gate has one.

    The failing measure is the one that fails (M8 round 2, cause O): V1's per-line residual (``residual3Lines``, the
    differences left after each line's best 1 px shift) when it is over its limit, V2's ``residual5`` when it is over
    its limit; a gate that passes its residual and fails only ``px32_shift1`` is placed by the pixels that no 1 px shift
    explains. A V1 judged by V2 (noise-exempt, M5-R1) has no measure of its own: V2's counts."""
    import numpy as np
    from scipy import ndimage

    from harness.fidelity import metrics
    from harness.fidelity.render_pdf import render as mupdf_render

    out_path = Path(out_root) / deck_id / "pdf" / "render" / f"slide{index + 1}.png"
    if not out_path.is_file():
        return None
    out = metrics.load_png(out_path)
    regions, facts = region_map(pdf, index, out.shape[:2])
    found = {"images": len(facts.images), "shadings": len(facts.shadings), "patterns": len(facts.patterns),
             "drawings": len(facts.drawings)}
    exception = slide.get("fontException")
    v2 = slide["v2"]
    if exception in (None, run.FONT_VERSION) and v2 is not None and "error" not in v2 and not v2["pass"]:
        pdf_img = mupdf_render(pdf, index)
        if pdf_img.shape == out.shape:
            limits = v2.get("limits") or {}
            if v2.get("residual5", 0) > limits.get("residual5", metrics.V2_ALONE_RESIDUAL):
                mask = ndimage.binary_erosion(metrics.diff_mask(pdf_img, out), structure=np.ones((5, 5), bool))
                found["v2Measure"] = "residual5"
            else:
                mask = metrics.shift_min_diff(out, pdf_img) > metrics.THRESHOLD
                found["v2Measure"] = "px32_shift1"
            found["v2Share"], found["v2Px"] = shares(mask, regions)
    v1 = slide["v1"]
    if (exception not in (run.MISSING_FONT, run.FONT_VERSION) and v1 is not None and "error" not in v1
            and not v1["pass"] and not v1.get("noiseExempt")):
        gt = _ground_truth(out_root, deck_id, index, out.shape[:2])
        if gt is not None and gt.shape == out.shape:
            if v1["residual3Lines"] > metrics.V1_MAX_RESIDUAL:
                line_regions = metrics.pixel_regions(run.line_boxes(pdf, index), PX, out.shape[:2])
                mask = v1_failing_mask(gt, out, line_regions)
                found["v1Measure"] = "residual3Lines"
            else:
                mask = metrics.shift_min_diff(gt, out) > metrics.THRESHOLD
                found["v1Measure"] = "px32_shift1"
            found["v1Share"], found["v1Px"] = shares(mask, regions)
    return found


def failing_measure(slide, failing, residual):
    """(share, pixels) of the failing measure of a slide: V1's when V1 fails on its own measure, else V2's (a V1 judged
    by V2 fails V2's measure; so does a slide under the font-version exception, which leaves V1 out)."""
    res = residual or {}
    v1 = slide["v1"]
    if "V1" in failing and v1 is not None and not v1.get("noiseExempt") and res.get("v1Px"):
        return res.get("v1Share") or {}, res["v1Px"]
    return res.get("v2Share") or {}, res.get("v2Px") or 0


# ---- the S details a tag needs, uncapped --------------------------------------------------------------------------


def s3_kinds(detail):
    """The kinds of S3 problem a (full) S3 detail names."""
    i = detail.find("pattern fills")
    tail = detail[i:] if i >= 0 else detail
    kinds = []
    if "pictures covering a shading or pattern" in tail:
        kinds.append("picture covers shading")
    if "unmatched PDF drawings" in tail:
        kinds.append("unmatched drawings")
    if "shadings without a gradFill" in tail:
        kinds.append("shading without gradFill")
    if "gradFills without a shading" in tail:
        kinds.append("gradFill without shading")
    if "pattern" in tail and ("without a pattFill" in tail or "pattern fills without" in tail):
        kinds.append("pattern")
    if "attribute" in tail or "mismatch" in tail:
        kinds.append("attribute mismatch")
    if "count" in tail and "unmatched" not in tail:
        kinds.append("count")
    if "outside the M1 geometry" in tail:
        kinds.append("preset (n/a)")
    return kinds or ["other: " + tail[:120]]


def s_details(pdf, pptx, index, failing):
    """The uncapped S1-S6 problem texts of a failing slide that tags need: S3's kinds and text, where S2's missing PDF
    characters lie (off the page, alpha 0, other), S6's and S1's text. {} when no S gate of S1, S2, S3, S6 fails."""
    from harness.fidelity import pdf_facts, pptx_facts, structural

    if not any(g in failing for g in ("S1", "S2", "S3", "S6")):
        return {}
    page, slide = pdf_facts.page_facts(pdf, index), pptx_facts.slide_facts(pptx, index)
    res = structural.check(page, slide)
    info = {}
    if res["S3"]["status"] != "pass":
        info["S3"] = s3_kinds(res["S3"]["detail"])
        info["S3text"] = res["S3"]["detail"][res["S3"]["detail"].find("pattern fills"):][:400]
    if res["S2"]["status"] != "pass":
        stext = "".join(r["text"] for r in slide.runs).replace(" ", "")
        width, height = page.size_pt
        kinds = {"off-page": 0, "alpha-0": 0, "other": 0}
        for span in page.spans:
            text = span["text"].replace(" ", "")
            if not text or text in stext:
                continue
            x, y = span["origin"]
            if x < -0.5 or y < -0.5 or x > width + 0.5 or y > height + 0.5:
                kinds["off-page"] += len(text)
            elif span["alpha"] == 0:
                kinds["alpha-0"] += len(text)
            else:
                kinds["other"] += len(text)
        info["S2missing"] = kinds
    if res["S6"]["status"] != "pass":
        info["S6text"] = res["S6"]["detail"][:300]
    return info


def page_info(pdf, index):
    """alpha-0 characters, symbol-font characters, the size and the off-page pictures of the PDF page."""
    from harness.fidelity import pdf_facts

    page = pdf_facts.page_facts(pdf, index)
    count = lambda spans: sum(len(s["text"].replace(" ", "")) for s in spans)  # noqa: E731
    width, height = page.size_pt
    return {"alpha0": count(s for s in page.spans if s["alpha"] == 0),
            "symbols": count(s for s in page.spans if SYMBOL_FONT.search(s["font"] or "")),
            "size": [width, height],
            "offPageImages": sum(1 for b in page.images if b[2] <= 0 or b[3] <= 0 or b[0] >= width or b[1] >= height)}


# ---- tags and the primary cause -----------------------------------------------------------------------------------


def s7_counts(detail):
    m = re.search(r"text differs \(([0-9]+) vs ([0-9]+) characters", detail)
    return (int(m.group(1)), int(m.group(2))) if m else None


def s7_worst(detail):
    m = re.search(r"baseline\(s\) off by more than 0.5 pt \(worst ([0-9.]+) pt\)", detail)
    return float(m.group(1)) if m else None


def tags_for(slide, failing, detail, info, residual, page_fonts):
    """Every cause tag of a failing slide. `failing` its failing gates (failing_gates), `detail` the uncapped S details
    (s_details), `info` page_info, `residual` the residuals record or None, `page_fonts` (families, not embedded) of
    its page."""
    tags = []
    bad = set(failing)
    s = slide["s"]
    families = page_fonts[0]
    numeric = any(NUMERIC.match(f) for f in families)
    share, pixels = failing_measure(slide, failing, residual)
    s7 = s["S7"]["detail"] if s["S7"]["status"] != "pass" else ""
    if s["S1"]["status"] != "pass":
        tags.append("whole-slide picture" if "(50 % or more)" in s["S1"]["detail"] else "fallback picture (S1)")
    if "S2" in bad and detail.get("S2missing"):
        m = detail["S2missing"]
        if m["off-page"]:
            tags.append("off-page content dropped")
        if m["alpha-0"]:
            tags.append("invisible text dropped (S2)")
        if m["other"] or not sum(m.values()):
            tags.append("text differs (S2, other)")
    if "S3" in bad:
        kinds = detail.get("S3", [])
        if "unmatched drawings" in kinds:
            text = detail.get("S3text", "")
            text = text[text.find("unmatched PDF drawings"):]
            text = text[:text.find(")") + 1] if ")" in text else text
            boxes = [tuple(map(float, b)) for b in
                     re.findall(r"\[(-?[0-9.]+), (-?[0-9.]+), (-?[0-9.]+), (-?[0-9.]+)\]", text)]
            width, height = info["size"]
            off = [b for b in boxes if b[2] < 0 or b[3] < 0 or b[0] > width or b[1] > height]
            dots = [b for b in boxes if b[2] - b[0] < 0.5 and b[3] - b[1] < 0.5]
            if boxes and len(off) * 2 >= len(boxes):
                tags.append("off-page content dropped")
            elif boxes and len(dots) * 2 >= len(boxes):
                tags.append("zero-length strokes (dots) dropped")
            else:
                tags.append("vector paints dropped (S3)")
        if {"picture covers shading", "shading without gradFill", "gradFill without shading"} & set(kinds):
            tags.append("S3 rule: picture over shading / degenerate gradient")
        if "attribute mismatch" in kinds:
            tags.append("vector paints dropped (S3)")
    if numeric:
        tags.append("font: numeric family name (PPTX-embedded font)")
    if slide.get("fontException") == run.MISSING_FONT:
        tags.append("font exception (commercial font missing)")
    counts = s7_counts(s7)
    if info["symbols"] and (share.get("symbol", 0) >= 0.1 or (counts and counts[0] == counts[1])):
        tags.append("symbol-font glyph (Wingdings bullet)")
    if counts and counts[0] > counts[1] and info["alpha0"] and counts[0] - counts[1] <= info["alpha0"]:
        tags.append("invisible text not round-tripped (S7)")
    worst = s7_worst(s7)
    if worst is not None and worst >= 5:
        tags.append("text: line wrap differs")
    if "V1" in bad or "V2" in bad:
        if "V1" not in bad and slide["v1"] is not None and slide.get("fontException") != run.FONT_VERSION:
            tags.append("renderer noise (V1 passes)")
        elif not pixels:
            tags.append("renderer noise (px32_shift1 only)")
        elif share:
            if share.get("text", 0) >= TEXT_SHARE:
                tags.append("text drift (line direction)")
            elif share.get("image", 0) >= IMAGE_SHARE:
                tags.append("picture pixels")
            elif share.get("shading", 0) + share.get("pattern", 0) >= IMAGE_SHARE:
                tags.append("gradient (pixels)")
            elif share.get("symbol", 0) >= SYMBOL_SHARE:
                pass  # tagged above
            else:
                tags.append("vector edges (pixels)")
    if s["S6"]["status"] != "pass" and "no family name" in s["S6"]["detail"]:
        tags.append("S6 n/a: non-embedded font (no family name)")
    image_diff = re.search(r"paints image ([0-9]+) vs ([0-9]+)", s7)
    if image_diff and info["offPageImages"] and int(image_diff.group(1)) > int(image_diff.group(2)):
        tags.append("off-page content dropped")
    if s7 and not any(t in tags for t in ("symbol-font glyph (Wingdings bullet)", "invisible text not round-tripped (S7)",
                                         "text: line wrap differs", "off-page content dropped")):
        if image_diff and worst is None and "path bbox" not in s7 and not re.search(r"paints (fill|stroke|shade)", s7):
            tags.append("S7 image count (round trip)")
        elif worst is not None or "paints" in s7 or "path bbox" in s7:
            tags.append("S7 baselines / paints")
    return list(dict.fromkeys(tags)) or ["unclassified"]


def primary_cause(tags, failing, font_exception=None):
    """The first of `tags` in PRIORITY. Under the spec 5.5 exception the visual tags are left out, and a slide with no S
    gate failing passes (EXCEPTION_PASSES)."""
    if font_exception == run.MISSING_FONT:
        s_tags = [t for t in tags if t not in VISUAL_TAGS]
        if not [g for g in failing if g.startswith("S")]:
            return EXCEPTION_PASSES
        return next((t for t in PRIORITY if t in s_tags), "font exception (commercial font missing)")
    return next(t for t in PRIORITY if t in tags)


def triage(results, root, out_root=None, page_fonts=None, on_deck=None):
    """One record per failing bar slide: {"id", "index", "failing", "tags", "primary", "fontException", "info",
    "residual"}, from `results` and the stored PDFs, outputs and renders (see the module docstring)."""
    root = Path(root)
    out_root = Path(out_root) if out_root else root / "out" / "fidelity"
    page_fonts = page_fonts or fonts_from_corpus(root)
    records = []
    for deck in bar_decks(results):
        pdf = root / "corpus" / "public-real" / f"{deck['id']}.pdf"
        pptx = out_root / deck["id"] / deck["variant"] / "out.pptx"
        pages = page_fonts(deck["id"])
        for slide in deck["slides"]:
            if slide["pass"] is not False:
                continue
            failing = failing_gates(slide)
            info = page_info(pdf, slide["index"])
            detail = s_details(pdf, pptx, slide["index"], failing)
            residual = residuals(deck["id"], pdf, slide["index"], slide, out_root)
            tags = tags_for(slide, failing, detail, info, residual, pages[slide["index"]])
            exception = slide.get("fontException")
            records.append({"id": deck["id"], "index": slide["index"], "failing": failing, "tags": tags,
                            "primary": primary_cause(tags, failing, exception), "fontException": exception,
                            "info": info, "residual": residual})
        if on_deck:
            on_deck(deck["id"])
    return records


def cause_table(records):
    """[{"cause", "primary", "any", "decks", "top": [(id, slides)]}] in PRIORITY order then by size: the slides whose
    primary cause it is, the slides that have it among their tags, the decks of the primary ones and the three decks
    with most."""
    primary = Counter(r["primary"] for r in records)
    anywhere = Counter(t for r in records for t in r["tags"])
    per_deck = defaultdict(Counter)
    for r in records:
        per_deck[r["primary"]][r["id"]] += 1
    rows = [{"cause": cause, "primary": n, "any": anywhere[cause], "decks": len(per_deck[cause]),
             "top": per_deck[cause].most_common(3)} for cause, n in primary.most_common()]
    rows += [{"cause": t, "primary": 0, "any": n, "decks": 0, "top": []} for t, n in anywhere.items() if t not in primary]
    return rows


# ---- command line -------------------------------------------------------------------------------------------------


def _print_numbers(numbers, unverifiable=None):
    if numbers is None:
        print("no bar deck in the results")
        return
    fe = numbers["fontException"]
    print(f"bar: {numbers['decks']} decks, {numbers['slides']} slides, {numbers['pass']} pass, {numbers['fail']} fail; "
          f"font exceptions {fe['total']} (mupdf-substitution {fe['mupdf-substitution']}, missing-font "
          f"{fe['missing-font']}, font-version {fe.get('font-version', 0)}; {fe['pass']} of them pass)")
    fvu = (unverifiable or {}).get("slides")
    if fvu is not None:
        print(f"font-version unverifiable (advances not comparable; not excepted): {fvu} slides")
    print("gates: " + ", ".join(f"{g} {c['fail']} fail/{c['na']} n/a" for g, c in numbers["gates"].items()))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m harness.fidelity.triage")
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("merge", "fonts", "recheck", "summary", "causes"):
        p = sub.add_parser(name)
        p.add_argument("results", type=Path)
        if name == "merge":
            p.add_argument("remeasured", type=Path)
        if name != "summary":
            p.add_argument("--out", type=Path, required=True)
        if name == "fonts":
            p.add_argument("--no-mupdf-substitution", action="store_true",
                           help="spec 5.5 alone: the rule r0 was judged by (no M8-R3)")
            p.add_argument("--no-font-version", action="store_true", help="without M8-R9: the rule r1 was judged by")
        p.add_argument("--root", type=Path, default=REPO, help="the repository root (corpus/public-real, out/fidelity)")
    args = parser.parse_args(argv)
    results = load(args.results)
    try:
        if args.command == "merge":
            save(merge(results, load(args.remeasured)), args.out)
        elif args.command == "fonts":
            save(apply_font_rule(results, fonts_from_corpus(args.root), mupdf=not args.no_mupdf_substitution,
                                 version=not args.no_font_version), args.out)
        elif args.command == "recheck":
            save(recheck(results, args.root, on_deck=lambda i: print(f"recheck {i}", file=sys.stderr)), args.out)
        elif args.command == "causes":
            records = triage(results, args.root, on_deck=lambda i: print(f"triage {i}", file=sys.stderr))
            table = cause_table(records)
            save({"bar": bar_numbers(results), "causes": table, "slides": records}, args.out)
            for row in table:
                print(f"{row['primary']:5d}  any {row['any']:5d}  decks {row['decks']:3d}  {row['cause']}")
        if args.command in ("merge", "fonts", "recheck"):
            done = load(args.out)
            _print_numbers(bar_numbers(done), done.get("options", {}).get("fontVersionUnverifiable"))
        elif args.command in ("summary", "causes"):
            _print_numbers(bar_numbers(results))
    except (ValueError, KeyError, OSError) as exc:
        print(f"triage: {exc if isinstance(exc, ValueError) else type(exc).__name__ + ': ' + str(exc)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
