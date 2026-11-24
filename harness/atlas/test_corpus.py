"""Tests for the committed public test corpus (corpus/generated/, written by harness/atlas/publish.py).

These run on CI (no PowerPoint, no fonts installed): they read the committed files only. The checks themselves live in
harness/atlas/corpuscheck.py, which publish.py runs on the staged files before it installs anything; the tests here run
the same functions on what is committed and assert what the corpus must contain. The embedded-font test is the guard
of review focus 5: PowerPoint may substitute a non-OFL font for a missing glyph during export, and a PDF that embeds
such a font must never be committed. A violation is fixed in the deck content, never in the test.
"""

import getpass
import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

import pymupdf  # PyMuPDF: test oracle only
import pytest
from pptx import Presentation

from harness.atlas import corpuscheck, fallback_pdfs
from harness.atlas.deck import LABEL_NAME
from harness.ppt.pngmode import png_colour_type

CORPUS = Path(__file__).resolve().parents[2] / "corpus" / "generated"
PROBE_GT = [f"probe_gt/slide{n}.png" for n in (1, 2, 3)]
PDFS = ["probe_std.pdf", "probe_notags.pdf", "atlas-smoke_std.pdf", "atlas-smoke_notags.pdf"]
SMOKE_PDFS = ["atlas-smoke_std.pdf", "atlas-smoke_notags.pdf"]
PPTXS = ["probe.pptx", "atlas-smoke.pptx"]
# M5 Task 2: the raster fallback fixtures, synthetic (harness/atlas/fallback_pdfs.py), outside the font and metadata
# checks of PowerPoint's exports.
FALLBACK_PDFS = sorted(fallback_pdfs.pdfs())
# Everything publish.py writes, except manifest.json (which lists the rest) and README.md (written by hand).
GENERATED = sorted([*PPTXS, *PDFS, *PROBE_GT, "probe_gt/map.json", "probe.manifest.json",
                    "atlas-smoke.manifest.json", "probe.export.json", "atlas-smoke.export.json", *FALLBACK_PDFS])
MAX_FILE_BYTES = 3 * 1024 * 1024  # scripts/check-no-binaries.mjs (Task 2)
MAX_TOTAL_BYTES = 12 * 1024 * 1024
ALLOWED_SUFFIXES = {".pdf", ".pptx", ".png", ".md", ".json"}  # M1-R16
MIN_SMOKE_SLIDES = 30
HARNESS = "deckback harness"
POWERPOINT = re.compile(r"^Microsoft® PowerPoint®( \S.*)?$")  # Creator / Producer, e.g. "Microsoft® PowerPoint® 2024"

LOCK = json.loads(corpuscheck.DEFAULT_LOCK.read_text(encoding="utf-8"))
LOCK_TTF_PAIRS = {(family["family"], file["postscriptName"])  # (nameID 1, nameID 6) of every locked TrueType file
                  for family in LOCK["families"] for file in family["files"] if file["format"] == "ttf"}
LOCK_TTF_FAMILIES = sorted({family for family, _ in LOCK_TTF_PAIRS})


def corpus_files():
    """Every file under corpus/generated/ as a posix path relative to it."""
    return sorted(p.relative_to(CORPUS).as_posix() for p in CORPUS.rglob("*") if p.is_file())


def read_json(name):
    return json.loads((CORPUS / name).read_text(encoding="utf-8"))


def committed_pairs():
    """{pdf name: {(family, PostScript name)}} of the committed PDFs, each of which must be there and pass the font
    check."""
    pairs = {}
    for name in PDFS:
        assert (CORPUS / name).is_file(), f"{name} is missing: run python -m harness.atlas.publish"
        problems, found = corpuscheck.pdf_font_problems(CORPUS / name)
        assert problems == [], f"{name}: " + "; ".join(problems)
        pairs[name] = found
    return pairs


def test_committed_pdfs_embed_only_ofl_fonts():
    for name, found in committed_pairs().items():
        assert found, f"{name}: embeds no font at all (a PDF of bitmaps proves nothing)"
        assert found <= LOCK_TTF_PAIRS, name


def test_the_committed_pdfs_embed_every_lock_truetype_font():
    """Ruling M1-R31: across the committed PDFs the embedded (family, PostScript name) pairs are exactly the lock's
    TrueType files, and the smoke deck alone exercises all of them."""
    pairs = committed_pairs()
    assert set().union(*pairs.values()) == LOCK_TTF_PAIRS
    for name in SMOKE_PDFS:
        assert pairs[name] == LOCK_TTF_PAIRS, name


def test_committed_pdf_metadata_names_only_the_harness_and_powerpoint():
    """No Office account or user name: the Author / dc:creator is the deck's, the Creator / Producer is PowerPoint."""
    for name in PDFS:
        with pymupdf.open(CORPUS / name) as doc:
            info = doc.metadata
            xmp = doc.get_xml_metadata()
        assert info["author"] == HARNESS, name
        assert POWERPOINT.match(info["creator"]) and POWERPOINT.match(info["producer"]), name
        assert re.search(r"<dc:creator>\s*<rdf:Seq>\s*<rdf:li>deckback harness</rdf:li>\s*</rdf:Seq>\s*</dc:creator>",
                         xmp), name
        assert corpuscheck.pdf_metadata_problems(CORPUS / name) == [], name


def test_committed_pptx_metadata_names_only_the_harness():
    """The deck's and its embedded chart workbooks' dc:creator and cp:lastModifiedBy are the harness (or empty)."""
    for name in PPTXS:
        with zipfile.ZipFile(CORPUS / name) as zf:
            packages = [("", zf)] + [(part, zipfile.ZipFile(io.BytesIO(zf.read(part))))
                                     for part in zf.namelist() if part.endswith(".xlsx")]
            for part, package in packages:
                core = package.read("docProps/core.xml").decode("utf-8")
                for tag in ("dc:creator", "cp:lastModifiedBy"):
                    values = re.findall(rf"<{tag}>([^<]*)</{tag}>", core)
                    assert all(value in (HARNESS, "") for value in values), f"{name}{part}: {tag} {values}"
        assert corpuscheck.pptx_problems(CORPUS / name) == [], name


def test_committed_pptx_decks_name_only_lock_fonts():
    """Every typeface a deck names (slides, masters, theme, charts) and every font its embedded chart workbooks name
    is a lock family or a theme reference; the OpenType-CFF sample (Source Sans 3) only on the slide atlas/fonts/01."""
    for name in PPTXS:
        assert corpuscheck.pptx_problems(CORPUS / name) == [], name
    with zipfile.ZipFile(CORPUS / "atlas-smoke.pptx") as zf:
        carriers = [part for part in zf.namelist() if part.endswith(".xml") and b"Source Sans 3" in zf.read(part)]
        labelled = [zf.read(part) for part in carriers]
    assert len(carriers) == 1 and carriers[0].startswith("ppt/slides/slide")
    assert b">atlas/fonts/01<" in labelled[0]


def test_corpus_passes_every_check_publish_runs():
    assert corpuscheck.corpus_problems(CORPUS) == []


def test_corpus_has_exactly_the_published_files():
    present = corpus_files()
    assert present == sorted([*GENERATED, "README.md", "manifest.json"])
    for path in present:  # the binary guard's allowlist (M1-R16): no .gitkeep, LICENSE or the like
        assert Path(path).suffix in ALLOWED_SUFFIXES, path


def test_manifest_matches_files():
    manifest = read_json("manifest.json")
    entries = manifest["files"]
    assert [entry["path"] for entry in entries] == GENERATED
    for entry in entries:
        data = (CORPUS / entry["path"]).read_bytes()
        assert set(entry) == {"path", "sha256", "bytes", "pages"}
        assert entry["sha256"] == hashlib.sha256(data).hexdigest(), entry["path"]
        assert entry["bytes"] == len(data), entry["path"]
        if entry["path"].endswith(".pdf"):
            with pymupdf.open(CORPUS / entry["path"]) as doc:
                assert entry["pages"] == doc.page_count, entry["path"]
        else:
            assert entry["pages"] is None, entry["path"]
    assert isinstance(manifest["dropped"], list)


def test_manifest_fonts_are_the_embedded_families():
    manifest = read_json("manifest.json")
    families = {family for found in committed_pairs().values() for family, _ in found}
    assert manifest["fonts"] == sorted(families) == LOCK_TTF_FAMILIES
    readme = (CORPUS / "README.md").read_text(encoding="utf-8")
    for family in manifest["fonts"]:
        assert f"**{family}**" in readme, f"README.md does not list the embedded font family {family!r}"
    assert "CC0-1.0" in readme and "OFL-1.1" in readme
    assert "Source Sans 3" in readme and "bitmap" in readme


def test_the_fallback_fixtures_are_their_generators_bytes():
    """M5 Task 2: each raster fallback fixture is what harness/atlas/fallback_pdfs.py writes, byte for byte, one page of
    960 x 540 pt that embeds no font, names no author and carries no date."""
    assert FALLBACK_PDFS == ["fallback/blend-multiply.pdf", "fallback/function-shading.pdf", "fallback/mesh-type4.pdf",
                             "fallback/softmask-image.pdf"]
    for relative, data in fallback_pdfs.pdfs().items():
        assert (CORPUS / relative).read_bytes() == data, f"{relative}: run python -m harness.atlas.fallback_pdfs"
        with pymupdf.open(CORPUS / relative) as doc:
            assert doc.page_count == 1 and tuple(doc[0].rect) == (0, 0, 960, 540), relative
            assert all(not value for value in doc.metadata.values() if value != "PDF 1.7"), relative
        assert corpuscheck.pdf_font_problems(CORPUS / relative)[1] == set(), relative
        assert len(data) < 32 * 1024, relative


def test_the_fallback_fixtures_need_no_platform_math(monkeypatch):
    """M5 Task 2 review (Minor 6): the committed bytes must not depend on the platform's libm, whose last bit may
    differ between systems; only exact arithmetic and the IEEE-754 operations (+ - x / sqrt) make them."""
    import math

    def libm(*args):
        raise AssertionError("a fixture generator calls a libm function")

    for name in ("sin", "cos", "tan", "atan", "atan2", "exp", "log", "pow", "hypot"):
        monkeypatch.setattr(math, name, libm)
    for relative, data in fallback_pdfs.pdfs().items():
        assert (CORPUS / relative).read_bytes() == data, relative


def test_size_limits():
    total = 0
    for path in corpus_files():
        size = (CORPUS / path).stat().st_size
        assert size <= MAX_FILE_BYTES, f"{path}: {size} bytes is over 3 MiB"
        total += size
    assert 0 < total <= MAX_TOTAL_BYTES, f"{total} bytes is over 12 MiB in total"


def test_pdf_page_counts_follow_the_decks():
    for stem in ("probe", "atlas-smoke"):
        slides = Presentation(str(CORPUS / f"{stem}.pptx")).slides
        visible = sum(slide._element.get("show") != "0" for slide in slides)
        for variant in ("std", "notags"):
            with pymupdf.open(CORPUS / f"{stem}_{variant}.pdf") as doc:
                assert doc.page_count == visible, f"{stem}_{variant}.pdf"


def test_every_pdf_page_holds_its_slides_label_id():
    """The label id (bottom-left of every slide) is the reliable text of a page; the rest of a slide's text may be
    outlines or bitmaps (rotated text, effects, the CFF sample of atlas/fonts/01)."""
    for stem in ("probe", "atlas-smoke"):
        manifest = read_json(f"{stem}.manifest.json")
        ids = [entry["id"] for entry in manifest["slides"] if not entry["hidden"]]
        for variant in ("std", "notags"):
            with pymupdf.open(CORPUS / f"{stem}_{variant}.pdf") as doc:
                for page, slide_id in zip(doc, ids, strict=True):
                    assert slide_id in page.get_text(), f"{stem}_{variant}.pdf page {page.number + 1}: {slide_id}"


def test_tagged_and_untagged_variants():
    def has_struct_tree(pdf):
        with pymupdf.open(pdf) as doc:
            return doc.xref_get_key(doc.pdf_catalog(), "StructTreeRoot")[0] != "null"

    for stem in ("probe", "atlas-smoke"):
        assert has_struct_tree(CORPUS / f"{stem}_std.pdf")
        assert not has_struct_tree(CORPUS / f"{stem}_notags.pdf")


def test_deck_manifests_describe_the_committed_decks():
    for stem in ("probe", "atlas-smoke"):
        manifest = read_json(f"{stem}.manifest.json")
        assert manifest["deck"] == stem and manifest["fonts"] == "ofl"
        prs = Presentation(str(CORPUS / f"{stem}.pptx"))
        labels = [next(s for s in slide.shapes if s.name == LABEL_NAME).text_frame.text for slide in prs.slides]
        assert labels == [entry["id"] for entry in manifest["slides"]]
        assert [entry["n"] for entry in manifest["slides"]] == list(range(1, len(labels) + 1))


def test_atlas_smoke_is_the_atlas_smoke_subset(atlas_ofl):
    """Smoke slide ids equal their atlas ids (M1-R24); what size forced out is listed in manifest.json."""
    _, atlas = atlas_ofl
    smoke_ids = [entry["id"] for entry in atlas["slides"] if entry["smoke"]]
    manifest = read_json("atlas-smoke.manifest.json")
    kept = [entry["id"] for entry in manifest["slides"]]
    dropped = read_json("manifest.json")["dropped"]
    assert len(kept) >= MIN_SMOKE_SLIDES
    assert not set(kept) & set(dropped)
    assert [i for i in smoke_ids if i not in dropped] == kept  # same slides, same order
    assert not any(entry["hidden"] for entry in manifest["slides"])  # so page n is slide n
    by_id = {entry["id"]: entry for entry in atlas["slides"]}
    for entry in manifest["slides"]:  # the same slide: everything but its position
        assert {k: v for k, v in entry.items() if k != "n"} == {k: v for k, v in by_id[entry["id"]].items()
                                                                if k != "n"}


def test_probe_ground_truth_is_truecolour_full_hd():
    for path in PROBE_GT:
        assert png_colour_type(CORPUS / path) == 2, f"{path}: not 8-bit RGB (a palette PNG is an error)"
        assert corpuscheck.png_problems(CORPUS / path) == [], path
    assert read_json("probe_gt/map.json") == {"slides": 3, "stdPages": 3, "stdPage": {"1": 1, "2": 2, "3": 3}}


def zip_text(data):
    """The XML parts of a zip package (embedded workbooks too) as one bytes object; pictures and other binary parts
    are left out, as raw compressed bytes would only give accidental matches."""
    parts = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for name in zf.namelist():
            if name.endswith((".xml", ".rels")):
                parts.append(zf.read(name))
            elif name.endswith(".xlsx"):
                parts.append(zip_text(zf.read(name)))
    return b"\n".join(parts)


def pdf_text(data):
    """A PDF's metadata, XMP packet and every object dictionary (not the compressed streams)."""
    with pymupdf.open(stream=data, filetype="pdf") as doc:
        parts = [str(doc.metadata), doc.get_xml_metadata()]
        parts += [doc.xref_object(xref, compressed=True) for xref in range(1, doc.xref_length())]
    return "\n".join(parts).encode("utf-8", "replace")


# Absolute local paths, and the name of the account that runs the test (read at run time, never written down here).
def local_patterns():
    patterns = {"drive-path": rb"[A-Za-z]:\\", "users": rb"/Users/", "home": rb"/home/", "appdata": rb"AppData",
                "temp-copy": rb"deckback-com"}
    try:
        user = getpass.getuser()
    except (OSError, KeyError, ImportError):
        user = ""
    if len(user) >= 4:
        patterns["user-name"] = re.escape(user.encode("utf-8"))
    return [pytest.param(pattern, id=name) for name, pattern in patterns.items()]


@pytest.mark.parametrize("pattern", local_patterns())
def test_committed_files_hold_no_local_paths_or_user_names(pattern):
    """No absolute local path or user name in any committed file (global constraint), PDF metadata included. (The
    positive checks of who the author is are test_committed_pdf_metadata_* above: this one cannot know an Office
    account name, only the name of the account that runs it.)"""
    from PIL import Image

    assert corpus_files(), "no corpus files"
    for path in corpus_files():
        data = (CORPUS / path).read_bytes()
        if path.endswith(".pptx"):
            data = zip_text(data)
        elif path.endswith(".pdf"):
            data = pdf_text(data)
        elif path.endswith(".png"):
            with Image.open(CORPUS / path) as image:  # the text chunks; the pixel data is compressed binary
                data = repr(image.info).encode("utf-8", "replace")
        assert not re.search(pattern, data), f"{path} matches {pattern!r}"
