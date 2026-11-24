"""The probe-parity verdict (M3 Task 12): deckback's output for the probe against what the experimental converter of
the design research achieved on the same deck (spec section 1.3).

    harness/.venv/Scripts/python -m harness.fidelity.parity --results <json> --deck <id-or-name> --pptx <pptx>
        [--pdf <pdf>]

``--results`` is a fidelity run's results JSON (run.py), ``--deck`` a deck of it: a private deck's id (12 hex digits),
or a public deck's ``<name>_<variant>`` (``probe_std``; the bare name when the results hold one variant of it).
``--pptx`` is the PPTX the run converted for that deck (``out/fidelity/<id>/<variant>/out.pptx``), ``--pdf`` its input
PDF; without ``--pdf`` the PDF is found as the run finds it (decks.discover: corpus/generated, out/atlas, or the
private PDF whose bytes have that id). stdout is one JSON object:

    {"deck", "meanV1Raw": %, "slides": [{"n", "v1Eroded": px, "v1Raw": %}],
     "counts": {"textbox", "freeform", "rect", "line", "picture"}, "fullPagePictures": n, "gradientShapes": n,
     "pass": bool, "reasons": [fixed words]}

It passes when all of these hold:

* ``meanV1Raw`` <= 0.26: the mean over the slides of V1's raw px32 (``v1.raw_px32`` of the results, the share of
  pixels whose largest channel difference from the PowerPoint render of the source deck is above 32, as the probe's
  compare.py measured the experimental converter's 0.26 %), in percent, rounded to 4 decimals before it is compared;
* every slide's ``v1Eroded`` (V1's ``residual3``) <= 25 px; a slide without V1 fails;
* ``fullPagePictures`` is 0: no picture breaks S1's own rule (ruling M3-R54, structural.oversized_picture): it covers
  50 % of the slide or more and no PDF image paint (pdf_facts ``images``) contains it. The pictures are exactly S1's
  (pptx_facts ``pictures``: a ``p:pic``, a shape filled with a stretched picture, a stretched picture background); a
  tiled picture fill is a pattern there, and here;
* the deck's counts are at least the experimental converter's, ``MIN_COUNTS``: textbox 39, freeform 9, rect 21, line
  35, picture 1. They are counted in the PPTX as the probe's count_shapes.py counted them: every leaf shape of every
  slide (groups opened) is a ``line`` (``p:cxnSp``), a ``picture`` (``p:pic``), a ``textbox`` (a ``p:sp`` with
  ``txBox="1"``), a ``freeform`` (a ``p:sp`` with ``a:custGeom``), a ``rect`` (a ``p:sp`` with the ``rect`` preset)
  or something else (not counted);
* the gradients (ruling M3-R24): every slide has exactly as many shapes filled with a gradFill as its page of the PDF
  has gradients (the oracle's shading paints, pdf_facts ``shadings``), each a rect preset or a custGeom (not slivers,
  not a picture), and each PDF gradient's box lies inside one of them (``COVER_TOL``, 1 pt). ``gradientShapes`` is
  the count over the deck. Shapes, boxes and fills come from pptx_facts.

``reasons`` lists every criterion that fails, in fixed words (slide numbers 1-based, no deck text).

Privacy (M1-R55, M1-R58): nothing of a private deck is printed but its id and these numbers: no path, file name,
text, typeface or shape name, on stdout or stderr; an error is fixed words and an exception's type name.

Exit codes: 0 pass; 1 fail; 2 bad arguments (argparse); 3 the deck is not in the results, or its PDF or PPTX cannot
be found or read.
"""

import argparse
import json
import sys
import zipfile
from pathlib import Path

from lxml import etree

from harness.fidelity import decks as deck_list
from harness.fidelity import structural
from harness.fidelity.errors import FactsError

REPO = Path(__file__).resolve().parents[2]

MAX_MEAN_V1_RAW = 0.26  # %, the experimental converter's mean on the probe (spec section 1.3)
MAX_V1_ERODED = 25  # px left after V1's 3 x 3 erosion (metrics.V1_MAX_RESIDUAL)
MIN_COUNTS = {"textbox": 39, "freeform": 9, "rect": 21, "line": 35, "picture": 1}  # spec section 1.3
COVER_TOL = 1.0  # pt a gradient shape's box may fall short of the PDF gradient's on each side
DECIMALS = 4  # percentages are printed and compared rounded to 4 decimals

P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
NS_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
XML_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False)
LEAVES = ("sp", "cxnSp", "pic", "graphicFrame")


class ParityError(Exception):
    """The verdict cannot be given; the message is fixed words (no path, no deck text)."""


# ---- V1 ---------------------------------------------------------------------------------------------------------


def _percent(fraction):
    return round(100 * fraction, DECIMALS)


def v1_slides(record):
    """[{"n", "v1Eroded", "v1Raw"}] of a results record: V1's residual3 and raw px32 in %, None without V1."""
    out = []
    for slide in record.get("slides") or []:
        v1 = slide.get("v1")
        computed = isinstance(v1, dict) and "error" not in v1 and "raw_px32" in v1
        out.append({"n": slide["index"] + 1, "v1Eroded": v1["residual3"] if computed else None,
                    "v1Raw": _percent(v1["raw_px32"]) if computed else None})
    return out


# ---- the PPTX ---------------------------------------------------------------------------------------------------


def _slide_parts(package):
    """The slide parts of the deck in presentation order."""
    presentation = etree.fromstring(package.read("ppt/presentation.xml"), XML_PARSER)
    rels = etree.fromstring(package.read("ppt/_rels/presentation.xml.rels"), XML_PARSER)
    targets = {rel.get("Id"): rel.get("Target") for rel in rels}
    id_list = presentation.find(f"{P}sldIdLst")
    parts = []
    for slide_id in id_list if id_list is not None else []:
        target = targets[slide_id.get(f"{NS_R}id")]
        parts.append(target.lstrip("/") if target.startswith("/") else f"ppt/{target}")
    return parts


def _kind(leaf):
    """The probe's count_shapes.py class of a leaf shape, None for one it does not count."""
    tag = etree.QName(leaf).localname
    if tag == "cxnSp":
        return "line"
    if tag == "pic":
        return "picture"
    if tag != "sp":
        return None
    nv = leaf.find(f"{P}nvSpPr/{P}cNvSpPr")
    if nv is not None and nv.get("txBox") in ("1", "true"):
        return "textbox"
    sp_pr = leaf.find(f"{P}spPr")
    if sp_pr is None:
        return None
    if sp_pr.find(f"{A}custGeom") is not None:
        return "freeform"
    preset = sp_pr.find(f"{A}prstGeom")
    return "rect" if preset is not None and preset.get("prst") == "rect" else None


def shape_counts(pptx):
    """MIN_COUNTS' kinds counted over every leaf shape of every slide of `pptx` (see the module docstring)."""
    counts = dict.fromkeys(MIN_COUNTS, 0)
    with zipfile.ZipFile(pptx) as package:
        for part in _slide_parts(package):
            tree = etree.fromstring(package.read(part), XML_PARSER).find(f"{P}cSld/{P}spTree")
            for leaf in tree.iter(*(f"{P}{tag}" for tag in LEAVES)) if tree is not None else []:
                kind = _kind(leaf)
                if kind is not None:
                    counts[kind] += 1
    return counts


def _area(box):
    return max(0.0, box[2] - box[0]) * max(0.0, box[3] - box[1])


def _contains(outer, inner, tol=COVER_TOL):
    return (outer[0] <= inner[0] + tol and outer[1] <= inner[1] + tol and outer[2] >= inner[2] - tol
            and outer[3] >= inner[3] - tol)


def slide_pictures(facts):
    """The boxes of the pictures of a slide as S1 has them (pptx_facts ``pictures``; a tiled picture fill is a
    pattern, ruling M3-R54)."""
    return [box for box in facts.pictures if box is not None]


def gradient_shapes(facts):
    """[(bbox, is a rect preset or custGeom)] of the shapes of a slide filled with a gradFill. Only the ``rect`` preset
    counts as one (ledger L198): a shape without geometry, a table cell and any other preset do not, though S3 boxes some
    of them by their frame too."""
    return [(shape.get("bbox"), shape.get("geom") in ("rect", "custGeom") and not shape.get("open"))
            for shape in facts.shapes if (shape.get("fill") or {}).get("kind") == "grad"]


# ---- the verdict ------------------------------------------------------------------------------------------------


def verdict(record, pptx, pdf):
    """The parity verdict of a results record, given the PPTX the run converted and its input PDF (module docstring).
    FactsError (no path in it) when either cannot be read."""
    from harness.fidelity.pdf_facts import page_facts, pdf_page_count
    from harness.fidelity.pptx_facts import slide_facts

    reasons = []
    slides = v1_slides(record)
    missing = [s["n"] for s in slides if s["v1Raw"] is None]
    mean = None if missing or not slides else round(sum(s["v1Raw"] for s in slides) / len(slides), DECIMALS)
    if mean is not None and mean > MAX_MEAN_V1_RAW:
        reasons.append(f"mean V1 raw px32 above {MAX_MEAN_V1_RAW} %")
    for slide in slides:
        if slide["v1Raw"] is None:
            reasons.append(f"slide {slide['n']}: no V1")
        elif slide["v1Eroded"] > MAX_V1_ERODED:
            reasons.append(f"slide {slide['n']}: V1 eroded above {MAX_V1_ERODED} px")

    try:
        counts = shape_counts(pptx)
    except Exception as exc:
        raise FactsError(f"the PPTX cannot be read ({type(exc).__name__})") from None
    pages = pdf_page_count(pdf)
    full_page = gradients = 0
    gradient_reasons = []
    first = slide_facts(pptx, 0)
    if first.slide_count != pages:
        raise FactsError(f"the PPTX has {first.slide_count} slides for {pages} PDF pages")
    for index in range(pages):
        facts = first if index == 0 else slide_facts(pptx, index)
        page = page_facts(pdf, index)
        width, height = facts.size_pt or page.size_pt
        full_page += sum(1 for box in slide_pictures(facts)
                         if structural.oversized_picture(box, page.images, width, height) is not None)
        shadings = page.shadings
        shapes = gradient_shapes(facts)
        gradients += len(shapes)
        number = index + 1
        if len(shapes) != len(shadings):
            gradient_reasons.append(f"slide {number}: {len(shapes)} shapes with gradFill for {len(shadings)} PDF "
                                    "gradient")
            continue
        if not all(editable for _, editable in shapes):
            gradient_reasons.append(f"slide {number}: gradFill shape is not a rect or custGeom")
        if not all(any(box is not None and _contains(box, shading) for box, _ in shapes) for shading in shadings):
            gradient_reasons.append(f"slide {number}: gradFill shape does not cover the PDF gradient")
    if full_page:
        reasons.append("full-page pictures")
    reasons += [f"{kind} count below {minimum}" for kind, minimum in MIN_COUNTS.items() if counts[kind] < minimum]
    reasons += gradient_reasons
    return {"meanV1Raw": mean, "slides": slides, "counts": counts, "fullPagePictures": full_page,
            "gradientShapes": gradients, "pass": not reasons, "reasons": reasons}


# ---- the command ------------------------------------------------------------------------------------------------


def find_record(results, deck):
    """The record of `deck` (a private id, ``<name>_<variant>``, or a name the results hold once); ParityError."""
    records = [r for r in results.get("decks") or [] if isinstance(r, dict)]
    exact = [r for r in records if f"{r.get('id')}_{r.get('variant')}" == deck]
    if exact:
        return exact[0]
    named = [r for r in records if r.get("id") == deck]
    if len(named) == 1:
        return named[0]
    if named:
        raise ParityError(f"{deck} has {len(named)} variants in the results: name one as {deck}_<variant>")
    raise ParityError("the deck is not in the results")


def shown(record):
    """How the deck is printed: a private deck by its id only, a public one as <name>_<variant>."""
    return record["id"] if not record.get("public") else f"{record['id']}_{record['variant']}"


def find_pdf(record, root):
    """The input PDF of a results record, found as the run finds it (decks.discover); ParityError when it is not."""
    sets = ("private",) if not record.get("public") else (record.get("set"),)
    variants = (record.get("variant"),) if record.get("public") else deck_list.DEFAULT_VARIANTS
    try:
        found = deck_list.discover(root, sets, variants)
    except (ValueError, OSError) as exc:
        raise ParityError(f"the decks could not be listed ({type(exc).__name__})") from None
    for deck in found:
        if deck.id == record.get("id") and deck.variant == record.get("variant"):
            return deck.pdf
    raise ParityError("the deck's input PDF was not found")


def main(argv=None, *, root=REPO):
    parser = argparse.ArgumentParser(prog="python -m harness.fidelity.parity",
                                     description="The probe-parity verdict of a converted deck (M3 Task 12).")
    parser.add_argument("--results", required=True, type=Path, help="a fidelity run's results JSON")
    parser.add_argument("--deck", required=True, help="a private deck's id, or a public deck's <name>_<variant>")
    parser.add_argument("--pptx", required=True, type=Path, help="the PPTX the run converted for that deck")
    parser.add_argument("--pdf", type=Path, help="its input PDF (default: found as the run finds it)")
    args = parser.parse_args(argv)
    from harness.fidelity.run import quiet_mupdf

    try:
        results = json.loads(args.results.read_text(encoding="utf-8"))
        record = find_record(results, args.deck)
        pdf = args.pdf if args.pdf is not None else find_pdf(record, Path(root))
        with quiet_mupdf():
            result = verdict(record, args.pptx, pdf)
    except (ParityError, FactsError) as exc:  # fixed words, no path
        print(f"parity: {exc}", file=sys.stderr)
        return 3
    except Exception as exc:
        print(f"parity: the verdict could not be given ({type(exc).__name__})", file=sys.stderr)
        return 3
    print(json.dumps({"deck": shown(record), **result}, ensure_ascii=False))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.exit(main())
