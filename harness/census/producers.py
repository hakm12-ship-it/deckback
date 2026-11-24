#!/usr/bin/env python
"""Census of the PDFs the author received: which program made them, are they tagged, are some pages scans.

    harness/.venv/Scripts/python harness/census/producers.py <folder> --out <json>

Every ``*.pdf`` under ``<folder>`` (subfolders included) is classified by its Producer / Creator metadata into a
family: ``powerpoint-win``, ``powerpoint-mac``, ``acrobat-pdfmaker``, ``keynote``, ``google-slides``, ``canva`` or
``other``. A file that cannot be read gets the family ``unreadable`` (see below). The JSON is::

    { files: [{ id, producer, creator, family, pages, tagged, encrypted, imageOnlyPages }],
      summary: { byFamily: { family: { files, pages } }, taggedRatio, imageOnlyPageRatio, skipped } }

The PDFs are private files, so **no file or folder name is ever written** (not to the JSON, not to the console, not
in an error message or traceback): ``id`` is the first 12 hex digits of the file's sha256, and the list is ordered
by ``id``. A file whose bytes cannot be read from disk has nothing to hash and gets the placeholder id
``unreadable-1``, ``unreadable-2``, ... (a counter, never derived from the name).

Fields:

* ``producer`` / ``creator``: the document metadata strings (at most 200 characters). Title and Author are never read.
  A value that looks like a path or a file name (a backslash, a drive letter such as ``C:``, a rooted or relative
  path, a word with two ``/`` separators between names such as ``Users/x/deck``, or a document extension such as
  ``.pptx``, ``.key``, ``.pdf``, ``.xlsm``, ``.psd``, ``.indd``, ``.ai``) is written as ``<redacted>`` instead; the
  family is still classified from the real value, and only the family label is written.
* ``tagged``: the catalog has ``/MarkInfo << /Marked true >>``.
* ``encrypted``: the file has an ``/Encrypt`` dictionary. A PDF that opens without a password (owner password
  only) is still read in full, with ``encrypted: true``.
* ``imageOnlyPages``: pages with no extractable text whose images, taken together (union, clipped to the page),
  cover at least 90 % of the page area.
* Unreadable files (corrupt, empty, not a PDF, or locked by a user password) are counted, not skipped, with the
  family ``unreadable``, ``pages: 0``, empty producer/creator, ``tagged: false`` and ``imageOnlyPages: 0``;
  ``encrypted`` tells a password-locked file (true) from a corrupt one (false). So is a ``*.pdf`` entry that the
  operating system refuses to look at or to read (access denied and the like).
* ``summary.skipped`` counts what could not be examined at all: a ``*.pdf`` entry that turned out not to be a file
  (a dangling link, a file that vanished during the run) and a folder that could not be listed.
* ``summary.taggedRatio`` is tagged files / readable files; ``summary.imageOnlyPageRatio`` is image-only pages /
  pages of readable files. Both are rounded to 4 decimals, and ``null`` when there is nothing to divide by.
"""

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path

import pymupdf

FAMILIES = ("powerpoint-win", "powerpoint-mac", "acrobat-pdfmaker", "keynote", "google-slides", "canva", "other")
UNREADABLE = "unreadable"
IMAGE_ONLY_COVER = 0.9
COVER_TOLERANCE = 1e-4  # image bboxes come from a float matrix in the content stream
META_MAX = 200
REDACTED = "<redacted>"

# What a path or a file name looks like in a Producer/Creator string (see looks_like_path). Every alternative does a
# bounded amount of work at each position, so a search takes time linear in the length of the value.
_PATH_LIKE = re.compile(
    r"\\"  # any backslash: C:\Users\..., \\server\share
    r"|(?<![A-Za-z0-9])[A-Za-z]:(?![\s0-9])"  # a drive letter: C:, C:/x, D:deck (not "Microsoft: ..." or "a: b")
    r"|(?:^|[\s\"'(\[<=:,;~])\.{0,2}/(?=[^\s/])"  # a rooted or relative path: /Users/x, ~/x, ./x, ../x
    r"|\.(?:pptx|pptm|ppt|potx|potm|ppsx|ppsm|pps|key|pdf|docx|docm|doc|dotx|dotm|xlsx|xlsm|xls|odp|odg|odt|ods"
    r"|pages|numbers|rtf|txt|md|hwpx|hwp|psd|indd|ai)"
    r"(?![A-Za-z0-9])",  # a document file name: deck.pptx, report.docx, Budget.xlsm, design.psd
    re.IGNORECASE,
)
# The start of one separator inside a word: a name character followed by a / or \. "Skia/PDF" has one, the "//" of
# "https://www.canva.com" is one, and "Users/x/deck" has two. (Two separators used to be the nested pattern
# "name/name/", which backtracks over a long word from every position: seconds on a 60,000-character word.)
_SEPARATOR = re.compile(r"[^/\\][/\\]")

_MAC_NAME = re.compile(r"\bmac(intosh)?\b")
_MS_POWERPOINT = re.compile(r"microsoft.{0,8}powerpoint")  # "Microsoft(R) PowerPoint": the (R) sign may be garbled


def classify_family(producer, creator):
    """Producer family from the two metadata strings. The order of the rules matters:

    * Keynote, Google Slides, Canva and Acrobat PDFMaker come first. Keynote PDFs carry the same macOS Producer as
      a Mac PowerPoint PDF, and a PDFMaker Creator ("... for Microsoft PowerPoint") contains "PowerPoint".
    * ``powerpoint-mac`` comes before ``powerpoint-win``: a Mac PowerPoint PDF has Creator "Microsoft PowerPoint"
      (no "Mac" in it), which the Windows rule alone would claim.
    """
    p, c = producer.lower(), creator.lower()
    both = p + "\n" + c
    if "keynote" in both:
        return "keynote"
    if "skia/pdf" in p and "google" in both:
        return "google-slides"
    if "canva" in both:
        return "canva"
    if "pdfmaker" in both:
        return "acrobat-pdfmaker"
    if "powerpoint" in c and ("quartz pdfcontext" in p or "macos" in p or _MAC_NAME.search(c)):
        return "powerpoint-mac"
    if _MS_POWERPOINT.search(p) or "powerpoint" in c:
        return "powerpoint-win"
    return "other"


def union_area(rects):
    """Area of the union of axis-aligned rectangles ``(x0, y0, x1, y1)``: sweep over the x strips."""
    xs = sorted({x for r in rects for x in (r[0], r[2])})
    total = 0.0
    for left, right in zip(xs, xs[1:]):
        spans = sorted((r[1], r[3]) for r in rects if r[0] <= left and r[2] >= right)
        covered, lo, hi = 0.0, None, None
        for a, b in spans:
            if hi is None or a > hi:
                if hi is not None:
                    covered += hi - lo
                lo, hi = a, b
            else:
                hi = max(hi, b)
        if hi is not None:
            covered += hi - lo
        total += covered * (right - left)
    return total


def _is_image_only(page):
    if page.get_text("text").strip():
        return False
    # Image boxes are in the unrotated page frame (page.rect is the rotated one), origin at the CropBox corner.
    frame = page.rect * page.derotation_matrix
    area = abs(frame.width * frame.height)
    if area <= 0:
        return False
    rects = []
    for info in page.get_image_info():
        x0, y0, x1, y1 = info["bbox"]
        x0, y0 = max(x0, frame.x0), max(y0, frame.y0)
        x1, y1 = min(x1, frame.x1), min(y1, frame.y1)
        if x1 > x0 and y1 > y0:
            rects.append((x0, y0, x1, y1))
    return union_area(rects) / area >= IMAGE_ONLY_COVER - COVER_TOLERANCE


def _text(value):
    return (value or "").strip()[:META_MAX]


def looks_like_path(value):
    """True when a metadata string looks like a path or a file name, which could name the author's own files: a
    backslash, a drive letter, a rooted or relative path, a document extension, or a word (split on whitespace) with
    two or more ``/`` or ``\\`` separators after names. Linear in the length of the value."""
    if _PATH_LIKE.search(value) is not None:
        return True
    return any(len(_SEPARATOR.findall(word)) >= 2 for word in value.split())


def _shown(value):
    """A Producer/Creator as written to the JSON: ``REDACTED`` when it looks like a path or a file name, else
    ``_text(value)``. The check runs on the whole value, so the length cut cannot hide an extension."""
    return REDACTED if looks_like_path((value or "").strip()) else _text(value)


def _unreadable(file_id, encrypted):
    return {"id": file_id, "producer": "", "creator": "", "family": UNREADABLE, "pages": 0, "tagged": False,
            "encrypted": encrypted, "imageOnlyPages": 0}


def analyze_pdf(path):
    """One ``files[]`` record. Never raises for a bad PDF: the file is reported as ``unreadable``.

    If the bytes cannot be read from disk there is nothing to hash, and the record's ``id`` is ``None``;
    ``run_census`` then gives it a counter id.
    """
    path = Path(path)
    try:
        data = path.read_bytes()
    except OSError:
        return _unreadable(None, False)
    file_id = hashlib.sha256(data).hexdigest()[:12]
    encrypted = False
    try:
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            encrypted = bool(doc.needs_pass) or doc.xref_get_key(-1, "Encrypt")[0] != "null"
            if doc.needs_pass:
                return _unreadable(file_id, True)
            meta = doc.metadata or {}
            producer, creator = _text(meta.get("producer")), _text(meta.get("creator"))
            return {
                "id": file_id,
                "producer": _shown(meta.get("producer")),  # the family below still uses the real strings
                "creator": _shown(meta.get("creator")),
                "family": classify_family(producer, creator),
                "pages": doc.page_count,
                "tagged": doc.xref_get_key(doc.pdf_catalog(), "MarkInfo/Marked") == ("bool", "true"),
                "encrypted": encrypted,
                "imageOnlyPages": sum(_is_image_only(page) for page in doc),
            }
    except Exception:  # noqa: BLE001 - PyMuPDF raises several types for broken files; the message may hold a path
        return _unreadable(file_id, encrypted)


def summarize(files, skipped=0):
    present = {f["family"] for f in files}
    by_family = {}
    for family in (*FAMILIES, UNREADABLE):
        if family in present:
            group = [f for f in files if f["family"] == family]
            by_family[family] = {"files": len(group), "pages": sum(f["pages"] for f in group)}
    readable = [f for f in files if f["family"] != UNREADABLE]
    pages = sum(f["pages"] for f in readable)
    return {
        "byFamily": by_family,
        "taggedRatio": round(sum(f["tagged"] for f in readable) / len(readable), 4) if readable else None,
        "imageOnlyPageRatio": round(sum(f["imageOnlyPages"] for f in readable) / pages, 4) if pages else None,
        "skipped": skipped,
    }


def find_pdfs(folder):
    """Walk `folder`. Returns ``(pdfs, blocked, skipped)``: the paths of the ``*.pdf`` files, how many ``*.pdf``
    entries the operating system would not let us check (counted as unreadable files), and how many things could
    not be examined (counted in ``summary.skipped``). No OS error escapes: its text carries the file path.
    """
    pdfs, blocked, skipped = [], 0, 0

    def unlistable(_error):
        nonlocal skipped
        skipped += 1

    for dirpath, _dirs, names in os.walk(folder, onerror=unlistable):
        for name in names:
            if Path(name).suffix.lower() != ".pdf":
                continue
            path = Path(dirpath) / name
            try:
                if path.is_file():
                    pdfs.append(path)
                else:
                    skipped += 1  # a dangling link, or the file vanished since it was listed
            except OSError:
                blocked += 1
    return pdfs, blocked, skipped


def run_census(folder):
    pdfs, blocked, skipped = find_pdfs(folder)
    files = [analyze_pdf(p) for p in sorted(pdfs)] + [_unreadable(None, False) for _ in range(blocked)]
    count = 0
    for record in files:
        if record["id"] is None:
            count += 1
            record["id"] = f"unreadable-{count}"
    files.sort(key=lambda f: f["id"])
    return {"files": files, "summary": summarize(files, skipped)}


def main(argv=None):
    ap = argparse.ArgumentParser(description="Census of received PDFs by producer family (no file names are written).")
    ap.add_argument("folder", help="folder holding the PDFs (subfolders are searched too)")
    ap.add_argument("--out", required=True, help="JSON file to write (its folder is created if missing)")
    args = ap.parse_args(argv)
    try:
        return _census_to_file(args)
    except Exception:  # noqa: BLE001 - the text of an OS or PyMuPDF error can hold a file path, so it is never shown
        print("error: the census failed unexpectedly; the details are not shown because they can contain file "
              "names", file=sys.stderr)
        return 1


def _census_to_file(args):
    if not Path(args.folder).is_dir():
        print("error: the folder does not exist or is not a folder", file=sys.stderr)
        return 2
    pymupdf.TOOLS.mupdf_display_errors(False)  # MuPDF messages on broken files could carry a path
    pymupdf.TOOLS.mupdf_display_warnings(False)

    result = run_census(args.folder)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
    out.write_bytes(text.encode("utf-8", errors="replace"))

    summary = result["summary"]
    print(f"census: {len(result['files'])} files, {sum(g['pages'] for g in summary['byFamily'].values())} pages")
    for family, group in summary["byFamily"].items():
        print(f"  {family}: {group['files']} files, {group['pages']} pages")
    print(f"  taggedRatio={summary['taggedRatio']} imageOnlyPageRatio={summary['imageOnlyPageRatio']} "
          f"skipped={summary['skipped']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
