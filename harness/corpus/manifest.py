"""corpus/manifest.jsonl: one JSON object per line, one line per tier-B PDF (M8). Never holds a PDF or a PPTX.

Fields: id ("b-" + first 10 hex digits of sha256), url, licence, licenceUrl, source, sha256, bytes, producer, creator,
pages, tagged, encrypted, imageFilters, origin, pairPptxUrl, lang ("ko" or "other"; added to know the Korean count),
and for a PPTX pair census.py has checked (Task 1 review I2, I5): pairPptxSha256, pairPptxBytes, pairSlides (kept), or
pairDropped {url, reason} with pairPptxUrl null (dropped: the PPTX does not open, or its visible slides are not as many
as the PDF's pages).
A candidate (before it is downloaded) has the first five fields and pairPptxUrl only; fetch_public.py adds sha256,
bytes and id, census.py adds the rest.
"""

import json
import re
from pathlib import Path

MANIFEST = Path("corpus") / "manifest.jsonl"
PUBLIC_REAL = Path("corpus") / "public-real"
SOURCES = ("zenodo", "ntrs", "kogl", "other")
ORIGINS = ("powerpoint-windows", "powerpoint-mac", "powerpoint-web", "keynote", "google-slides", "libreoffice",
           "acrobat-pdfmaker", "print-to-pdf", "compressed", "other")
FILTERS = ("DCT", "JPX", "JBIG2", "Flate", "CCITT", "CMYK", "ICC")
FIELDS = ("id", "url", "licence", "licenceUrl", "source", "sha256", "bytes", "producer", "creator", "pages", "tagged",
          "encrypted", "imageFilters", "origin", "pairPptxUrl", "lang", "pairPptxSha256", "pairPptxBytes", "pairSlides",
          "pairDropped")
# Licences accepted without a note; anything else needs its own explicit licence page (source "other").
LICENCES = ("cc-by-4.0", "cc0-1.0", "nasa-public-use", "kogl-type1")


ID_PATTERN = re.compile(r"b-[0-9a-f]{10}")


def tier_b_id(sha256):
    return "b-" + sha256[:10]


def _checked_id(entry):
    """The entry's id, which must be exactly b-<10 hex digits>: a hand-edited manifest cannot make a path leave
    corpus/public-real (Task 1 review M7)."""
    if not ID_PATTERN.fullmatch(str(entry.get("id"))):
        raise ValueError("a manifest entry has no valid tier-B id (b- and 10 hex digits)")
    return entry["id"]


def pdf_path(root, entry):
    return Path(root) / PUBLIC_REAL / f"{_checked_id(entry)}.pdf"


def pptx_path(root, entry):
    return Path(root) / PUBLIC_REAL / f"{_checked_id(entry)}.pptx"


def load(path):
    path = Path(path)
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def save(path, entries):
    """Sorted by id, then url (candidates have no id yet), keys in FIELDS order, LF line ends."""
    ordered = sorted(entries, key=lambda e: (e.get("id", ""), e["url"]))
    lines = [json.dumps({k: e[k] for k in FIELDS if k in e}, ensure_ascii=False, separators=(",", ":"))
             for e in ordered]
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_bytes(("\n".join(lines) + ("\n" if lines else "")).encode("utf-8"))


def problems(entry):
    """What is wrong with a complete entry (a list of short texts, empty when fine)."""
    found = []
    for key in ("url", "licence", "licenceUrl", "source", "sha256", "bytes"):
        if entry.get(key) in (None, ""):
            found.append(f"missing {key}")
    if entry.get("source") not in SOURCES:
        found.append("bad source")
    if entry.get("sha256") and entry.get("id") != tier_b_id(entry["sha256"]):
        found.append("id is not b- + sha256[:10]")
    if "origin" in entry and entry["origin"] not in ORIGINS:
        found.append("bad origin")
    if entry.get("source") != "other" and entry.get("licence") not in LICENCES:
        found.append("licence not on the list")
    return found
