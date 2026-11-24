from pathlib import Path

import pymupdf
import pytest

from harness.corpus import census, manifest
from harness.fidelity.test_run import make_pptx


@pytest.mark.parametrize("producer,creator,origin", [
    ("Microsoft® PowerPoint® 2016", "Microsoft® PowerPoint® 2016", "powerpoint-windows"),
    ("Microsoft® PowerPoint® 2019", "", "powerpoint-windows"),
    ("Microsoft® PowerPoint® 2021", "Microsoft® PowerPoint® 2021", "powerpoint-windows"),
    ("Microsoft® PowerPoint® 2024", "", "powerpoint-windows"),
    ("Microsoft® PowerPoint® for Microsoft 365", "Microsoft® PowerPoint® for Microsoft 365", "powerpoint-windows"),
    ("Microsoft (R) PowerPoint (R) for Microsoft 365", "", "powerpoint-windows"),
    ("Microsoft PowerPoint 2019", "", "powerpoint-windows"),
    # localised Microsoft 365 builds are Windows PowerPoint too (Task 1 review I1)
    ("Microsoft® PowerPoint® pour Microsoft 365", "Microsoft® PowerPoint® pour Microsoft 365",
     "powerpoint-windows"),
    ("Microsoft® PowerPoint® für Microsoft 365", "Microsoft® PowerPoint® für Microsoft 365", "powerpoint-windows"),
    ("Microsoft® PowerPoint® para Microsoft 365", "", "powerpoint-windows"),
    ("Microsoft® PowerPoint® per Microsoft 365", "", "powerpoint-windows"),
    ("Microsoft® PowerPoint® dla Microsoft 365", "", "powerpoint-windows"),
    ("Microsoft® PowerPoint® voor Microsoft 365", "", "powerpoint-windows"),
    ("Microsoft® PowerPoint® för Microsoft 365", "", "powerpoint-windows"),
    ("Microsoft® PowerPoint® Microsoft 365용", "Microsoft® PowerPoint® Microsoft 365용", "powerpoint-windows"),
    ("Microsoft® Word für Microsoft 365", "Microsoft® Word für Microsoft 365", "other"),
    ("Microsoft® PowerPoint® 2013", "Microsoft® PowerPoint® 2013", "other"),
    ("Microsoft® PowerPoint® 2010", "", "other"),
    ("macOS Version 14.5 (Build 23F79) Quartz PDFContext", "PowerPoint", "powerpoint-mac"),
    ("Mac OS X 10.15 Quartz PDFContext", "Microsoft PowerPoint", "powerpoint-mac"),
    ("Microsoft® PowerPoint® for Mac", "", "powerpoint-mac"),
    ("Microsoft PowerPoint for the web", "", "powerpoint-web"),
    ("macOS Version 14.5 Quartz PDFContext", "Keynote", "keynote"),
    ("Skia/PDF m128 Google Docs Renderer", "", "google-slides"),
    ("LibreOffice 7.6", "Impress", "libreoffice"),
    ("Adobe PDF Library 15.0", "PDFMaker 15.0 for Microsoft PowerPoint", "acrobat-pdfmaker"),
    ("Microsoft: Print To PDF", "", "print-to-pdf"),
    ("macOS Version 14.5 Quartz PDFContext", "", "print-to-pdf"),
    ("Skia/PDF m120", "Chromium", "print-to-pdf"),
    ("GPL Ghostscript 9.5", "", "compressed"),
    ("iLovePDF", "", "compressed"),
    ("pdfTeX-1.40", "LaTeX with Beamer", "other"),
    ("", "", "other"),
])
def test_classify_origin(producer, creator, origin):
    assert census.classify_origin(producer, creator) == origin


def test_only_powerpoint_windows_counts_for_the_bar():
    assert census.counts_for_bar("powerpoint-windows")
    assert not any(census.counts_for_bar(o) for o in manifest.ORIGINS if o != "powerpoint-windows")


def test_filters_from_an_image_object():
    obj = "<</Type/XObject/Subtype/Image/Width 4/Height 4/ColorSpace/DeviceRGB/Filter/DCTDecode>>"
    assert census.filters_from_object(obj) == {"DCT"}
    obj = "<</Subtype/Image/ColorSpace/DeviceCMYK/Filter[/FlateDecode/DCTDecode]>>"
    assert census.filters_from_object(obj) == {"Flate", "DCT", "CMYK"}
    assert census.filters_from_object("<</Subtype/Image/Filter/JPXDecode>>") == {"JPX"}
    assert census.filters_from_object("<</Subtype/Image/Filter/JBIG2Decode/ImageMask true>>") == {"JBIG2"}
    assert census.filters_from_object("<</Subtype/Image/Filter/CCITTFaxDecode>>") == {"CCITT"}
    assert census.filters_from_object("<</Subtype/Image/ColorSpace[/ICCBased 7 0 R]>>") == {"ICC"}
    assert census.filters_from_object("<</Type/Font/Filter/FlateDecode>>") == set()


def _pdf(tmp_path, metadata, text="Hello", jpeg=False, encrypt=False):
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), text, fontname="korea" if any(ord(c) > 255 for c in text) else "helv")
    if jpeg:
        pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), False)
        pix.clear_with(128)
        page.insert_image(pymupdf.Rect(100, 100, 200, 200), stream=pix.tobytes("jpeg"))
    doc.set_metadata(metadata)
    path = tmp_path / "x.pdf"
    kwargs = {"encryption": pymupdf.PDF_ENCRYPT_AES_256, "owner_pw": "o", "user_pw": ""} if encrypt else {}
    doc.save(path, **kwargs)
    return path


def test_facts_of_a_synthetic_pdf(tmp_path):
    path = _pdf(tmp_path, {"producer": "Microsoft® PowerPoint® 2019", "creator": "Microsoft® PowerPoint® 2019"},
                jpeg=True)
    facts = census.facts(path)
    assert facts["origin"] == "powerpoint-windows"
    assert facts["producer"] == "Microsoft® PowerPoint® 2019"
    assert facts["pages"] == 1 and facts["tagged"] is False and facts["encrypted"] is False
    assert "DCT" in facts["imageFilters"]
    assert facts["lang"] == "other"


def test_a_korean_deck_is_found_by_its_text(tmp_path):
    assert census.facts(_pdf(tmp_path, {}, text="안녕하세요 발표자료입니다"))["lang"] == "ko"


def test_owner_password_only_pdf_is_read_and_marked_encrypted(tmp_path):
    facts = census.facts(_pdf(tmp_path, {"producer": "Microsoft® PowerPoint® 2016"}, encrypt=True))
    assert facts["encrypted"] is True and facts["pages"] == 1


def test_a_broken_file_gives_none_not_an_error(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"not a pdf")
    assert census.facts(bad) is None


def test_creator_that_looks_like_a_path_is_kept_out_of_the_manifest(tmp_path):
    path = _pdf(tmp_path, {"producer": "Microsoft® PowerPoint® 2019", "creator": "C:\\Users\\someone\\deck.pptx"})
    assert census.facts(path)["creator"] == "<redacted>"


def test_summary_counts():
    entries = [
        {"source": "zenodo", "origin": "powerpoint-windows", "lang": "ko", "pairPptxUrl": "u", "imageFilters": ["DCT"]},
        {"source": "ntrs", "origin": "other", "lang": "other", "pairPptxUrl": None, "imageFilters": ["DCT", "JPX"]},
    ]
    summary = census.summarize(entries)
    assert summary["total"] == 2 and summary["powerpointWindows"] == 1 and summary["korean"] == 1
    assert summary["withPair"] == 1
    assert summary["bySource"] == {"ntrs": 1, "zenodo": 1}
    assert summary["byFilter"] == {"DCT": 2, "JPX": 1}
    assert "powerpoint-windows" in census.format_table(summary)


# ---- PPTX pairs (Task 1 review I2, I5) -------------------------------------------------------------------------------


def _entry_with_pair(root, pages, slides=None, hidden=(), pptx_bytes=None):
    entry = {"id": "b-aaaaaaaaaa", "url": "https://example.org/a.pdf", "pages": pages,
             "pairPptxUrl": "https://example.org/a.pptx"}
    path = manifest.pptx_path(root, entry)
    if pptx_bytes is not None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(pptx_bytes)
    elif slides is not None:
        make_pptx(path, slides, hidden=hidden)
    return entry


def test_a_pair_with_as_many_slides_as_pages_is_kept_with_its_hash_size_and_slide_count(tmp_path):
    entry = _entry_with_pair(tmp_path, pages=3, slides=3)
    assert census.check_pair(tmp_path, entry) is None
    path = manifest.pptx_path(tmp_path, entry)
    assert entry["pairPptxUrl"] == "https://example.org/a.pptx"
    assert entry["pairPptxSha256"] == fetch_sha(path) and entry["pairPptxBytes"] == path.stat().st_size
    assert entry["pairSlides"] == 3 and "pairDropped" not in entry


def test_hidden_slides_are_left_out_as_the_harness_pairs_a_pdf_export(tmp_path):
    entry = _entry_with_pair(tmp_path, pages=2, slides=3, hidden=(2,))  # the PDF export leaves slide 2 out
    assert census.check_pair(tmp_path, entry) is None and entry["pairSlides"] == 3
    entry = _entry_with_pair(tmp_path / "b", pages=3, slides=3, hidden=(2,))  # 2 visible slides for 3 pages
    assert census.check_pair(tmp_path / "b", entry) == "2 visible slides (3 in all) for 3 pages"


def test_an_unrelated_pair_is_dropped_so_the_deck_gets_no_v1(tmp_path):
    entry = _entry_with_pair(tmp_path, pages=100, slides=12)
    reason = census.check_pair(tmp_path, entry)
    assert reason == "12 visible slides (12 in all) for 100 pages"
    assert entry["pairPptxUrl"] is None
    assert entry["pairDropped"] == {"url": "https://example.org/a.pptx", "reason": reason}
    assert not set(census.PAIR_FIELDS) & set(entry)
    assert census.check_pair(tmp_path, entry) is None and entry["pairDropped"]["reason"] == reason  # idempotent


def test_a_pair_that_does_not_open_or_is_missing_is_dropped(tmp_path):
    entry = _entry_with_pair(tmp_path, pages=1, pptx_bytes=b"PK not really a zip")
    assert census.check_pair(tmp_path, entry) == "pptx does not open (BadZipFile)"
    entry = _entry_with_pair(tmp_path / "none", pages=1)
    assert census.check_pair(tmp_path / "none", entry) == "pptx missing"
    assert entry["pairPptxUrl"] is None


def test_refresh_drops_a_wrong_pair_and_the_manifest_keeps_the_new_fields(tmp_path):
    good = _pdf(tmp_path, {"producer": "Microsoft® PowerPoint® für Microsoft 365"})
    entries = []
    for deck_id, slides in (("b-aaaaaaaaaa", 1), ("b-bbbbbbbbbb", 5)):
        entry = {"id": deck_id, "url": f"https://example.org/{deck_id}.pdf", "licence": "cc-by-4.0",
                 "licenceUrl": "https://creativecommons.org/licenses/by/4.0/", "source": "zenodo",
                 "pairPptxUrl": f"https://example.org/{deck_id}.pptx"}
        manifest.pdf_path(tmp_path, entry).parent.mkdir(parents=True, exist_ok=True)
        manifest.pdf_path(tmp_path, entry).write_bytes(good.read_bytes())
        make_pptx(manifest.pptx_path(tmp_path, entry), slides)
        entries.append(entry)
    manifest.save(tmp_path / manifest.MANIFEST, entries)
    found, bad = census.refresh(tmp_path)
    assert bad == []
    saved = {e["id"]: e for e in manifest.load(tmp_path / manifest.MANIFEST)}
    assert saved["b-aaaaaaaaaa"]["origin"] == "powerpoint-windows" and saved["b-aaaaaaaaaa"]["pairSlides"] == 1
    assert saved["b-bbbbbbbbbb"]["pairPptxUrl"] is None
    assert saved["b-bbbbbbbbbb"]["pairDropped"]["reason"] == "5 visible slides (5 in all) for 1 pages"
    summary = census.summarize(list(saved.values()))
    assert summary["withPair"] == 1 and summary["pairsDropped"] == 1 and summary["powerpointWindows"] == 2


def fetch_sha(path):
    import hashlib
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


# ---- Task 1 review I3: the colour space of an image is usually an indirect reference -----------------------------

OBJECTS = {
    7: "[/ICCBased 8 0 R]",
    8: "<</N 3/Alternate/DeviceRGB/Length 10>>",
    9: "[/Indexed 10 0 R 255 11 0 R]",
    10: "[/ICCBased 12 0 R]",
    12: "<</N 4/Alternate/DeviceCMYK/Length 10>>",
    13: "[/Separation/Spot/DeviceCMYK<</FunctionType 2>>]",
    14: "14 0 R",  # a loop
}
IMAGE = "<</Type/XObject/Subtype/Image/Width 2/Height 2/ColorSpace {}/BitsPerComponent 8>>"


def _resolve(xref):
    return OBJECTS[xref]


def test_an_indirect_colour_space_is_followed_to_icc_and_cmyk():
    assert census.filters_from_object(IMAGE.format("7 0 R")) == set()  # without a resolver: only the image's own text
    assert census.filters_from_object(IMAGE.format("7 0 R"), _resolve) == {"ICC"}
    assert census.filters_from_object(IMAGE.format("[/ICCBased 8 0 R]"), _resolve) == {"ICC"}
    # an Indexed image whose base is a reference to an ICC profile that is a CMYK one (the profile's Alternate)
    assert census.filters_from_object(IMAGE.format("9 0 R"), _resolve) == {"ICC", "CMYK"}
    assert census.filters_from_object(IMAGE.format("13 0 R"), lambda x: OBJECTS[x]) == {"CMYK"}
    assert census.filters_from_object(IMAGE.format("14 0 R"), _resolve) == set()  # a loop ends
    assert census.filters_from_object(IMAGE.format("99 0 R"), lambda x: 1 / 0) == set()  # a missing object is skipped
    assert census.filters_from_object(IMAGE.format("/DeviceRGB"), _resolve) == set()


def test_image_filters_reads_a_real_pdf_with_an_indirect_icc_colour_space(tmp_path):
    doc = pymupdf.open()
    page = doc.new_page()
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), False)
    pix.clear_with(100)
    image = page.insert_image(pymupdf.Rect(10, 10, 50, 50), pixmap=pix)
    profile, space = doc.get_new_xref(), doc.get_new_xref()
    doc.update_object(profile, "<</N 3/Alternate/DeviceRGB>>")
    doc.update_stream(profile, b"profile bytes")
    doc.update_object(space, f"[/ICCBased {profile} 0 R]")
    doc.xref_set_key(image, "ColorSpace", f"{space} 0 R")
    assert "ICCBased" not in doc.xref_object(image, compressed=False)  # indirect: the old census could not see it
    assert "ICC" in census.image_filters(doc)
