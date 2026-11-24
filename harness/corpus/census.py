"""Facts about the tier-B PDFs, read with PyMuPDF, and the summary table of the census (M8 Task 1).

    harness/.venv/Scripts/python.exe -I -m harness.corpus.census [--root .]

Fills or refreshes producer, creator, pages, tagged, encrypted, imageFilters, origin and lang of every manifest entry
whose PDF is in corpus/public-real/. "PowerPoint (Windows)" is Producer/Creator "Microsoft(R) PowerPoint(R)
2016/2019/2021/2024" or "for Microsoft 365" (spec 5.4), in any language of the Office build: "pour Microsoft 365",
"für", "para", "per", "dla", "voor", ... and "Microsoft 365용" (Task 1 review I1); only that origin counts toward the
bar.

It also checks every PPTX pair, the V1 ground truth (Task 1 review I2, I5). A pair is kept only when the PPTX opens
and its visible slides, in the harness's page order for a tier-B PDF (run.variant_slides, M1-R72: a PDF export
leaves hidden slides out), are as many as the PDF's pages; the entry then records pairPptxSha256, pairPptxBytes and
pairSlides (every slide, hidden ones included). Otherwise pairPptxUrl becomes null, so the deck gets no V1, and
pairDropped keeps the URL and the reason.
"""

import argparse
import re
import sys
from collections import Counter
from pathlib import Path

import pymupdf

from harness.census.producers import _shown, _text
from harness.corpus import fetch_public, manifest

# "for Microsoft 365" in the language of the Office build: one short word before "Microsoft 365" (for, pour, für,
# para, per, dla, voor, för, ...) or none (Korean "Microsoft 365용"). \s also matches the no-break space the French
# build writes before 365.
_WIN_VERSION = re.compile(r"powerpoint\W{0,6}(?:\(r\)\W{0,2})?\s*"
                          r"(20(?:1[6-9]|2[0-9])\b|(?:[^\W0-9_]{2,5}\s+)?(?:microsoft|office)\s*365)")
_MAC_NAME = re.compile(r"\bmac(intosh)?\b|\bmac os\b|\bmacos\b|quartz pdfcontext")
_COMPRESSORS = ("ghostscript", "ilovepdf", "smallpdf", "sejda", "pdfsizeopt", "pdf compressor", "pdf squeezer",
                "pdf24", "qpdf", "compress")
_PRINTERS = ("print to pdf", "quartz pdfcontext", "skia/pdf", "pdfcreator", "dopdf", "bullzip", "cairo", "cups",
             "chrome", "chromium", "mozilla", "pdf995")
HANGUL = re.compile("[가-힣]")


def classify_origin(producer, creator):
    """One of manifest.ORIGINS from Producer and Creator. Rules in order: Keynote, Google Slides, LibreOffice,
    Acrobat PDFMaker, PowerPoint (web, Mac, Windows 2016+; an older Windows PowerPoint is "other"), compressors,
    printers."""
    p, c = (producer or "").lower(), (creator or "").lower()
    both = p + "\n" + c
    if "keynote" in both:
        return "keynote"
    if ("google" in both and "skia/pdf" in p) or "google slides" in both:
        return "google-slides"
    if "libreoffice" in both or "openoffice" in both or "impress" in c:
        return "libreoffice"
    if "pdfmaker" in both:
        return "acrobat-pdfmaker"
    if "powerpoint" in both:
        if re.search(r"for the web|online|web app", both):
            return "powerpoint-web"
        if _MAC_NAME.search(both) or "for mac" in both:
            return "powerpoint-mac"
        return "powerpoint-windows" if _WIN_VERSION.search(both) else "other"
    if any(word in both for word in _COMPRESSORS):
        return "compressed"
    if any(word in both for word in _PRINTERS):
        return "print-to-pdf"
    return "other"


def counts_for_bar(origin):
    return origin == "powerpoint-windows"


_FILTER_NAMES = {"DCTDecode": "DCT", "JPXDecode": "JPX", "JBIG2Decode": "JBIG2", "FlateDecode": "Flate",
                 "CCITTFaxDecode": "CCITT"}


_REFERENCE = re.compile(r"([0-9]+)\s+[0-9]+\s+R\b")
_COLOUR_SPACE = re.compile(r"/ColorSpace\s*")
REFERENCE_DEPTH = 4  # colour spaces nest: a reference to an array whose base is a reference to a profile's dictionary


def _value_after(obj, start):
    """The PDF value (an array, a dictionary, a reference or a name) that begins at obj[start:]."""
    if start >= len(obj):
        return ""
    opening = {"[": "]", "<": ">"}.get(obj[start])
    if opening is None:
        end = re.match(r"[0-9]+\s+[0-9]+\s+R\b|/?[^\s/\[\]<>()]+", obj[start:])
        return end.group(0) if end else ""
    depth = 0
    for i in range(start, len(obj)):
        if obj[i] in "[<":
            depth += 1
        elif obj[i] in "]>":
            depth -= 1
            if depth == 0:
                return obj[start:i + 1]
    return obj[start:]


def colour_space_text(obj, resolve=None, depth=REFERENCE_DEPTH):
    """The text of an image dictionary's /ColorSpace with every indirect reference in it replaced by the referenced
    object's own text (Task 1 review I3: the colour space is usually ``/ColorSpace 12 0 R``, and an ICC profile or an
    Indexed base is a reference of its own). `resolve(xref)` gives an object's dictionary text; without it nothing is
    followed. Followed to `depth` levels, each object once (a loop ends)."""
    found = _COLOUR_SPACE.search(obj)
    if found is None:
        return ""
    text, seen = _value_after(obj, found.end()), set()
    for _ in range(depth if resolve else 0):
        references = [m for m in _REFERENCE.finditer(text) if m.group(1) not in seen]
        if not references:
            break
        for m in references:
            seen.add(m.group(1))
            try:
                text += " " + resolve(int(m.group(1)))
            except Exception:  # noqa: BLE001 - a damaged or missing object is skipped, never an error of the census
                continue
    return text


def filters_from_object(obj, resolve=None):
    """Image filters, CMYK and ICC of one PDF object's dictionary text; empty for anything that is not an image.
    `resolve(xref)` follows an indirect /ColorSpace (colour_space_text); without it only what the image's own text
    says counts."""
    if "/Subtype/Image" not in obj.replace(" ", ""):
        return set()
    found = {short for long, short in _FILTER_NAMES.items() if "/" + long in obj}
    space = obj if resolve is None else obj + " " + colour_space_text(obj, resolve)
    if "DeviceCMYK" in space:
        found.add("CMYK")
    if "ICCBased" in space:
        found.add("ICC")
    return found


def image_filters(doc):
    found = set()
    for xref in range(1, doc.xref_length()):
        try:
            obj = doc.xref_object(xref, compressed=False)
        except Exception:  # noqa: BLE001 - one damaged object must not hide the others
            continue
        found |= filters_from_object(obj, lambda ref: doc.xref_object(ref, compressed=False))
    return sorted(found, key=manifest.FILTERS.index)


def _language(doc):
    text = "".join(page.get_text()[:2000] for page in list(doc)[:5])
    letters = sum(ch.isalpha() for ch in text)
    return "ko" if letters and len(HANGUL.findall(text)) / letters > 0.2 else "other"


def facts(path):
    """Census facts of one PDF, None when it cannot be read (corrupt or locked by a user password)."""
    try:
        with pymupdf.open(Path(path)) as doc:
            if doc.needs_pass:
                return None
            meta = doc.metadata or {}
            producer, creator = _text(meta.get("producer")), _text(meta.get("creator"))
            return {
                "producer": _shown(meta.get("producer")),
                "creator": _shown(meta.get("creator")),
                "pages": doc.page_count,
                "tagged": doc.xref_get_key(doc.pdf_catalog(), "MarkInfo/Marked") == ("bool", "true"),
                "encrypted": doc.xref_get_key(-1, "Encrypt")[0] != "null",
                "imageFilters": image_filters(doc),
                "origin": classify_origin(producer, creator),
                "lang": _language(doc),
            }
    except Exception:  # noqa: BLE001
        return None


PAIR_FIELDS = ("pairPptxSha256", "pairPptxBytes", "pairSlides")


def pair_facts(pptx, pages):
    """(fields, None) for a PPTX pair that opens and has as many visible slides as the PDF has pages, in the
    harness's page order for a tier-B PDF (decks.REAL_VARIANT through run.variant_slides, M1-R72); (None, reason)
    otherwise. The reason names no file."""
    from harness.fidelity.decks import REAL_VARIANT
    from harness.fidelity.run import slide_hidden_flags, variant_slides

    pptx = Path(pptx)
    if not pptx.is_file():
        return None, "pptx missing"
    try:
        flags = slide_hidden_flags(pptx)
    except Exception as exc:  # noqa: BLE001 - not a zip, no presentation part, a broken relationship, ...
        return None, f"pptx does not open ({type(exc).__name__})"
    visible = len(variant_slides(REAL_VARIANT, flags))
    if visible != pages:
        return None, f"{visible} visible slides ({len(flags)} in all) for {pages} pages"
    return {"pairPptxSha256": fetch_public._sha256(pptx), "pairPptxBytes": pptx.stat().st_size,
            "pairSlides": len(flags)}, None


def check_pair(root, entry):
    """Keep or drop the entry's PPTX pair (module docstring). Returns the reason it was dropped, else None."""
    if not entry.get("pairPptxUrl"):
        for key in PAIR_FIELDS:
            entry.pop(key, None)
        return None
    found, reason = pair_facts(manifest.pptx_path(root, entry), entry.get("pages"))
    if found is not None:
        entry.update(found)
        return None
    entry["pairDropped"] = {"url": entry["pairPptxUrl"], "reason": reason}
    entry["pairPptxUrl"] = None
    for key in PAIR_FIELDS:
        entry.pop(key, None)
    return reason


def refresh(root):
    """Fill the census fields of every entry whose PDF is downloaded, and keep or drop its PPTX pair. Returns
    (entries, unreadable ids)."""
    root = Path(root)
    entries, bad = manifest.load(root / manifest.MANIFEST), []
    for entry in entries:
        if "id" not in entry:
            continue
        path = manifest.pdf_path(root, entry)
        if not path.is_file():
            continue
        found = facts(path)
        if found is None:
            bad.append(entry["id"])
        else:
            entry.update(found)
            check_pair(root, entry)
    manifest.save(root / manifest.MANIFEST, entries)
    return entries, bad


def summarize(entries):
    def count(key):
        return dict(sorted(Counter(e[key] for e in entries if e.get(key)).items()))

    filters = Counter(f for e in entries for f in e.get("imageFilters") or [])
    return {
        "total": len(entries),
        "powerpointWindows": sum(counts_for_bar(e.get("origin")) for e in entries),
        "korean": sum(e.get("lang") == "ko" for e in entries),
        "withPair": sum(bool(e.get("pairPptxUrl")) for e in entries),
        "pairsDropped": sum(bool(e.get("pairDropped")) for e in entries),
        "bySource": count("source"),
        "byOrigin": count("origin"),
        "byFilter": dict(sorted(filters.items())),
    }


def format_table(summary):
    lines = [f"total {summary['total']}; PowerPoint (Windows) {summary['powerpointWindows']}; "
             f"Korean {summary['korean']}; with a PPTX pair {summary['withPair']} "
             f"(pairs dropped: {summary.get('pairsDropped', 0)})", ""]
    for title, key in (("source", "bySource"), ("origin", "byOrigin"), ("image filter", "byFilter")):
        lines += [f"| {title} | decks |", "|---|---|"] + [f"| {k} | {v} |" for k, v in summary[key].items()] + [""]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--root", default=".")
    args = parser.parse_args(argv)
    entries, bad = refresh(args.root)
    print(format_table(summarize(entries)))
    if bad:
        print(f"unreadable: {', '.join(bad)}", file=sys.stderr)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
