"""Which decks a fidelity run measures (harness/fidelity/run.py).

    discover(root, sets=("public", "atlas"), variants=("std", "notags")) -> [Deck, ...]

Five sets, in this order (``private``, ``tier-c``, then ``real``):

* ``public``: ``corpus/generated/<name>_<variant>.pdf`` (the committed corpus: probe, atlas-smoke).
* ``atlas``: ``out/atlas/<name>_<variant>.pdf`` for the full atlas (``atlas``) and the four page-size decks
  (``sizes-43``, ``sizes-a4l``, ``sizes-a4p``, ``sizes-custom``; minor m20), once harness.atlas.build has built them
  and harness.atlas.export has exported them; not the other decks that happen to lie there (the probe is the public
  set's).
* ``private``: every ``*.pdf`` under ``corpus/private/`` (recursive; git-ignored, the author's own decks), but those
  under ``corpus/private/tier-c/``, which are the next set's.
* ``tier-c`` (M8, tier C): every ``*.pdf`` under ``corpus/private/tier-c/``, the author's own real decks. They are
  private in every way (id ``sha256(file bytes)[:12]``, variant ``pdf``, no name, no path, no text in any result), and
  their ``origin`` is read from the PDF's Producer/Creator (``harness.corpus.census.classify_origin``). They are never
  part of the bar: they are measured fully and reported as a block of their own (``summary.tierC``).
* ``real`` (M8, tier B): the public real PDFs of ``corpus/manifest.jsonl`` that are downloaded into
  ``corpus/public-real/`` (git-ignored; harness/corpus/fetch_public.py). Its ``id`` is the manifest's tier-B id
  (``b-`` + sha256[:10]), its variant is ``"pdf"``, its source PPTX (V1) is ``<id>.pptx`` next to it when the entry
  has a ``pairPptxUrl`` and the file is there, and its ``origin`` is the manifest's: only ``powerpoint-windows``
  counts toward the bar. It is not in the default sets (it is a long run).

A public deck is found by name: its ``id`` is ``<name>``, its variant comes from the file name, its source PPTX (for
V1) is ``<name>.pptx`` and its manifest ``<name>.manifest.json`` next to the PDFs, when they exist. Only the variants
asked for are taken.

A private deck is a PDF as it is: its ``id`` is ``sha256(file bytes)[:12]``, its variant is always ``"pdf"`` (a part
of its file name would be a part of its name), its source PPTX is the file with the same stem in the same directory,
when there is one, and it has no manifest. Two private PDFs with the same bytes are one deck. Private decks are sorted
by id, so not even the order of the results follows their names. The ``pdf`` and ``source_pptx`` paths are for the
run only: results, the dashboard, stdout and stderr carry the ``id`` and counts, never a private name or path.

Finding the private decks never raises and never stops (ruling M1-R62): a private PDF that cannot be read (held open
without sharing by another program, denied, a cloud placeholder that cannot be fetched) or a directory under
``corpus/private`` that cannot be listed is skipped and only counted, in ``private_unreadable`` of the returned list.
It has no id (its bytes could not be read), and nothing names it. A directory whose name ends in ``.pdf`` is walked
into like any other directory.
"""

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path

SETS = ("public", "atlas", "private", "tier-c", "real")
DEFAULT_SETS = ("public", "atlas")
DEFAULT_VARIANTS = ("std", "notags")
PRIVATE_VARIANT = "pdf"
PUBLIC_DIR = Path("corpus") / "generated"
ATLAS_DIR = Path("out") / "atlas"
ATLAS_NAME = "atlas"
# The decks of the atlas set: the recipes `atlas` and `sizes` of harness/atlas/decks.py (test_run.py checks the names).
ATLAS_NAMES = (ATLAS_NAME, "sizes-43", "sizes-a4l", "sizes-a4p", "sizes-custom")
PRIVATE_DIR = Path("corpus") / "private"
TIER_C_NAME = "tier-c"
TIER_C_DIR = PRIVATE_DIR / TIER_C_NAME
PRIVATE_SETS = ("private", TIER_C_NAME)  # sets whose decks are named by their 12-hex id only
REAL_DIR = Path("corpus") / "public-real"
REAL_MANIFEST = Path("corpus") / "manifest.jsonl"
REAL_VARIANT = "pdf"
ID_LENGTH = 12


@dataclass(frozen=True)
class Deck:
    id: str  # public: the deck's name; private: sha256(file bytes)[:12]
    set: str  # "public" | "atlas" | "private" | "tier-c" | "real"
    variant: str  # public: from the file name ("std", "notags", ...); private: "pdf"
    pdf: Path
    source_pptx: Path = None  # the deck the PDF was exported from (V1), when it exists
    manifest: Path = None  # public decks only
    origin: str = None  # real decks: the manifest's origin of the PDF (only "powerpoint-windows" counts for the bar)

    @property
    def public(self):
        return self.set not in PRIVATE_SETS


class DeckList(list):
    """discover()'s result: the decks, in order, and how many private PDFs (or directories under corpus/private)
    could not be read. Those are counted, never named."""

    private_unreadable = 0


def private_id(path):
    """sha256 of the file's bytes, first 12 hex digits."""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()[:ID_LENGTH]


def _existing(path):
    try:
        return path if path.is_file() else None
    except OSError:
        return None


def _public(directory, set_name, variants, names=None):
    found = []
    if not directory.is_dir():
        return found
    for pdf in directory.glob("*.pdf"):
        name, sep, variant = pdf.stem.rpartition("_")
        if not sep or not name or variant not in variants or (names is not None and name not in names):
            continue
        found.append(Deck(name, set_name, variant, pdf, _existing(directory / f"{name}.pptx"),
                          _existing(directory / f"{name}.manifest.json")))
    return sorted(found, key=lambda d: (d.id, variants.index(d.variant)))


def _real(root):
    """The tier-B decks (set ``real``): manifest entries whose PDF is in corpus/public-real/, sorted by id."""
    path = root / REAL_MANIFEST
    if not path.is_file():
        return []
    found = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        entry = json.loads(line)
        pdf = _existing(root / REAL_DIR / f"{entry['id']}.pdf")
        if pdf is None:
            continue
        pptx = _existing(root / REAL_DIR / f"{entry['id']}.pptx") if entry.get("pairPptxUrl") else None
        found[entry["id"]] = Deck(entry["id"], "real", REAL_VARIANT, pdf, pptx, None, entry.get("origin"))
    return [found[key] for key in sorted(found)]


def _origin(pdf):
    """The origin of a tier-C PDF from its Producer/Creator (``census.classify_origin``); "other" when it cannot be read."""
    import pymupdf

    from harness.corpus.census import classify_origin

    try:
        with pymupdf.open(pdf) as doc:
            meta = doc.metadata or {}
            return classify_origin(meta.get("producer") or "", meta.get("creator") or "")
    except Exception:  # noqa: BLE001 - the type would not help: the origin is only a label
        return "other"


def _private(directory, set_name="private"):
    """(decks sorted by id, how many PDFs or directories could not be read); never raises an OSError (M1-R62). The
    ``private`` set leaves ``tier-c/`` directly under `directory` out; the ``tier-c`` set reads that directory itself."""
    found, unreadable = {}, 0

    def not_listed(_error):  # os.walk's report of a directory it could not list; its text names the directory
        nonlocal unreadable
        unreadable += 1

    try:
        if not directory.is_dir():
            return [], 0
    except OSError:
        return [], 1
    for folder, subfolders, files in os.walk(directory, onerror=not_listed):
        subfolders.sort()
        if set_name == "private" and Path(folder) == directory:
            subfolders[:] = [name for name in subfolders if name != TIER_C_NAME]
        for name in sorted(files):
            if not name.lower().endswith(".pdf"):
                continue
            pdf = Path(folder) / name
            try:
                deck_id = private_id(pdf)
            except OSError:
                unreadable += 1
                continue
            if deck_id not in found:
                found[deck_id] = Deck(deck_id, set_name, PRIVATE_VARIANT, pdf, _existing(pdf.with_suffix(".pptx")),
                                      None, _origin(pdf) if set_name == TIER_C_NAME else None)
    return [found[key] for key in sorted(found)], unreadable


def discover(root, sets=DEFAULT_SETS, variants=DEFAULT_VARIANTS):
    """The decks of `sets` under the repo `root` as a DeckList; see the module docstring. ValueError for an unknown
    set name or a public deck found twice (never raised with a private name: private decks are deduplicated by id).
    A private PDF that cannot be read is counted in the result's ``private_unreadable``, never raised."""
    root = Path(root)
    sets, variants = tuple(sets), tuple(variants)
    unknown = [name for name in sets if name not in SETS]
    if unknown:
        raise ValueError(f"unknown deck set(s): {', '.join(unknown)} (known: {', '.join(SETS)})")
    found = DeckList()
    for name in SETS:
        if name not in sets:
            continue
        if name == "public":
            found += _public(root / PUBLIC_DIR, "public", variants)
        elif name == "atlas":
            found += _public(root / ATLAS_DIR, "atlas", variants, names=set(ATLAS_NAMES))
        elif name == "real":
            found += _real(root)
        elif name == TIER_C_NAME:
            tier_c, unreadable = _private(root / TIER_C_DIR, TIER_C_NAME)
            found.private_unreadable += unreadable
            found += tier_c
        else:
            private, unreadable = _private(root / PRIVATE_DIR)
            found.private_unreadable += unreadable
            found += private
    seen = set()
    for deck in found:
        if (deck.id, deck.variant) in seen:
            raise ValueError(f"deck {deck.id} ({deck.variant}) was found in two places")
        seen.add((deck.id, deck.variant))
    return found
