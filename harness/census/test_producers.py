"""Tests for the received-PDF census (producers.py).

Every PDF is generated in pytest's tmp dir with PyMuPDF (PDFs are never committed). The census CLI is run as a
subprocess, exactly as the author runs it, and its JSON is checked field by field.
"""

import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import pymupdf
import pytest

from harness.census import producers

HERE = Path(__file__).resolve().parent
CENSUS = HERE / "producers.py"

WIN_PRODUCER = "Microsoft® PowerPoint® 2024"
MAC_PRODUCER = "macOS Version 15.0 (Build 24A335) Quartz PDFContext"


# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------


def _image():
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 40, 40), False)
    pix.set_rect(pix.irect, (200, 10, 10))
    return pix


def make_pdf(path, producer="", creator="", pages=1, text=None, images=(), rotation=0, cropbox=None,
             tagged=False, size=(400, 200)):
    """Write a PDF. `images` are rects (x0, y0, x1, y1) in the unrotated page frame, each drawn stretched."""
    doc = pymupdf.open()
    pix = _image()
    for _ in range(pages):
        page = doc.new_page(width=size[0], height=size[1])
        if text:
            page.insert_text((50, 100), text)
        for rect in images:
            page.insert_image(pymupdf.Rect(*rect), pixmap=pix, keep_proportion=False)
        if cropbox:
            page.set_cropbox(pymupdf.Rect(*cropbox))
        page.set_rotation(rotation)
    doc.set_metadata({"producer": producer, "creator": creator})
    if tagged:
        doc.xref_set_key(doc.pdf_catalog(), "MarkInfo", "<</Marked true>>")
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(path)
    doc.close()
    return path


def run_census(folder, out):
    res = subprocess.run([sys.executable, str(CENSUS), str(folder), "--out", str(out)], capture_output=True)
    return res


def census(folder, tmp_path):
    out = tmp_path / "census.json"
    res = run_census(folder, out)
    assert res.returncode == 0, res.stderr.decode("utf-8", "replace")
    return json.loads(out.read_text(encoding="utf-8"))


def by_id(result):
    return {f["id"]: f for f in result["files"]}


def shown(res):
    """Everything a finished CLI run put on the console."""
    return res.stdout.decode("utf-8", "replace") + res.stderr.decode("utf-8", "replace")


def assert_hidden(text, tmp_path, *names):
    """No file or folder name, no ".pdf", and no part of the temp path in `text`."""
    for secret in (*names, ".pdf", str(tmp_path)):
        assert secret not in text, f"leaked {secret!r}"


def sha12(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()[:12]


# --------------------------------------------------------------------------
# end-to-end: the three generated PDFs of the task brief
# --------------------------------------------------------------------------


def test_families_image_only_and_no_file_names(tmp_path):
    folder = tmp_path / "received-secret-dir"
    win = make_pdf(folder / "private-budget-win.pdf", producer=WIN_PRODUCER, creator=WIN_PRODUCER, pages=3, text="hello")
    mac = make_pdf(folder / "private-budget-mac.pdf", producer=MAC_PRODUCER, creator="Microsoft PowerPoint", pages=2,
                   text="hello")
    scan = make_pdf(folder / "private-scan.pdf", producer="SomeScanner 1.0", images=[(0, 0, 400, 200)])

    out = tmp_path / "out" / "census.json"  # parent folder does not exist yet
    res = run_census(folder, out)
    assert res.returncode == 0, res.stderr.decode("utf-8", "replace")
    raw = out.read_text(encoding="utf-8")
    files = by_id(json.loads(raw))

    assert set(files) == {sha12(win), sha12(mac), sha12(scan)}
    assert files[sha12(win)]["family"] == "powerpoint-win"
    assert files[sha12(win)]["pages"] == 3
    assert files[sha12(win)]["producer"] == WIN_PRODUCER
    assert files[sha12(mac)]["family"] == "powerpoint-mac"
    assert files[sha12(mac)]["creator"] == "Microsoft PowerPoint"
    assert files[sha12(scan)]["family"] == "other"
    assert files[sha12(scan)]["imageOnlyPages"] == 1
    assert files[sha12(win)]["imageOnlyPages"] == 0

    # No file or folder name anywhere: not in the JSON, not on the console.
    shown = raw + res.stdout.decode("utf-8", "replace") + res.stderr.decode("utf-8", "replace")
    for secret in ("private-budget", "private-scan", "received-secret-dir", ".pdf", str(tmp_path)):
        assert secret not in shown
    assert set(json.loads(raw)) == {"files", "summary"}
    assert set(files[sha12(win)]) == {"id", "producer", "creator", "family", "pages", "tagged", "encrypted",
                                      "imageOnlyPages"}


def test_mac_powerpoint_is_not_counted_as_windows(tmp_path):
    """Creator "Microsoft PowerPoint" has no "Mac", so the mac rule must run before the win rule."""
    folder = tmp_path / "in"
    mac = make_pdf(folder / "a.pdf", producer=MAC_PRODUCER, creator="Microsoft PowerPoint")
    mac2 = make_pdf(folder / "b.pdf", producer="macOS Version 14.5 (Build 23F79)", creator="Microsoft PowerPoint",
                    text="different bytes")
    files = by_id(census(folder, tmp_path))
    assert files[sha12(mac)]["family"] == "powerpoint-mac"
    assert files[sha12(mac2)]["family"] == "powerpoint-mac"
    # The same Creator with a Windows Producer stays a Windows PowerPoint.
    win = make_pdf(folder / "c.pdf", producer="Microsoft: Print To PDF", creator="Microsoft PowerPoint")
    assert by_id(census(folder, tmp_path))[sha12(win)]["family"] == "powerpoint-win"


# --------------------------------------------------------------------------
# Producer/Creator values that look like a path or a file name are not written
# --------------------------------------------------------------------------

WIN_PATH_CREATOR = "C:\\Users\\x\\deck.pptx"
MAC_PATH_CREATOR = "/Users/x/deck.key"


def test_path_looking_creators_are_redacted(tmp_path):
    folder = tmp_path / "in"
    win = make_pdf(folder / "a.pdf", producer=WIN_PRODUCER, creator=WIN_PATH_CREATOR)
    mac = make_pdf(folder / "b.pdf", producer=MAC_PRODUCER, creator=MAC_PATH_CREATOR)
    plain = make_pdf(folder / "c.pdf", producer=WIN_PRODUCER, creator=WIN_PRODUCER, text="different bytes")
    # A file name past the 200-character cut is still caught: the check runs on the whole value.
    long_name = make_pdf(folder / "d.pdf", producer="x" * 195 + " deck.pptx", creator="", text="more bytes")
    out = tmp_path / "census.json"
    res = run_census(folder, out)
    assert res.returncode == 0, res.stderr.decode("utf-8", "replace")
    raw = out.read_text(encoding="utf-8")
    files = by_id(json.loads(raw))

    assert files[sha12(win)]["creator"] == producers.REDACTED == "<redacted>"
    assert files[sha12(mac)]["creator"] == "<redacted>"
    assert files[sha12(long_name)]["producer"] == "<redacted>"
    # Normal values are kept as they are.
    assert files[sha12(win)]["producer"] == WIN_PRODUCER
    assert files[sha12(mac)]["producer"] == MAC_PRODUCER
    assert files[sha12(plain)]["producer"] == WIN_PRODUCER
    assert files[sha12(plain)]["creator"] == WIN_PRODUCER
    # The family is still classified from the real values.
    assert files[sha12(win)]["family"] == "powerpoint-win"
    # Nothing of the paths reaches the JSON or the console.
    for secret in ("Users", "deck", ".pptx", ".key", "C:\\\\", "C:\\"):
        assert secret not in raw + shown(res), f"leaked {secret!r}"


@pytest.mark.parametrize(
    "value",
    [
        WIN_PATH_CREATOR,
        MAC_PATH_CREATOR,
        "deck.pptx",
        "Quarterly Budget.PPTX",
        "Microsoft Word - report.docx",
        "Keynote export of plan.key (edited)",
        "\\\\server\\share\\slides",
        "D:/slides/a",
        "D:",
        "~/Documents/talk",
        "./talk",
        "Users/x/deck",
        "file:///C:/Users/x/a",
        "보고서.hwp",
        # An Office macro file, design files, and a file name below one folder.
        "Budget.xlsm",
        "design.psd",
        "Documents/deck.indd",
        "report.ai",
        # Two separators after names, however they are written.
        "Users/x/",
        "Users//x//deck",
        "Skia/PDF/m120",
    ],
)
def test_looks_like_path(value):
    assert producers.looks_like_path(value)


@pytest.mark.parametrize(
    "ext", ["xlsm", "xlsx", "dotx", "dotm", "ppsm", "potm", "psd", "indd", "ai", "md", "odg", "odp", "hwp", "hwpx"]
)
def test_every_listed_document_extension_is_redacted(ext):
    assert producers.looks_like_path(f"name.{ext}")
    assert producers.looks_like_path(f"Exported from NAME.{ext.upper()}")


@pytest.mark.parametrize(
    "value",
    [
        "",
        WIN_PRODUCER,
        "Microsoft® PowerPoint® for Microsoft 365",
        MAC_PRODUCER,
        "macOS Version 14.5 (Build 23F79)",
        "Skia/PDF m120 Google Docs Renderer",
        "Acrobat PDFMaker 23 for PowerPoint",
        "Microsoft: Print To PDF",
        "Adobe PDF Library 17.11.238; modified using iText 5.5.13",
        "Aspose.Slides for .NET 23.1",
        "www.pdf24.org",
        "https://www.canva.com",
        "PDF/A-1b",
        "OpenOffice / LibreOffice 7.5",
        "Hancom PDF 1.3.0.538",
        "Canva",
        "macOS Version 15 Quartz PDFContext",
        "Skia/PDF",
    ],
)
def test_normal_producers_do_not_look_like_paths(value):
    assert not producers.looks_like_path(value)


@pytest.mark.parametrize(
    "token",
    [
        "x" * 60_000,  # no separator at all
        "a/" + "b" * 59_998,  # one separator, then a long name
        ".x" * 30_000,  # a dot at every other place: an extension is tried and fails each time
    ],
    ids=["letters", "one-separator", "dots"],
)
def test_a_long_token_is_checked_in_linear_time(token):
    """A 60,000-character value with no spaces is checked in well under a tenth of a second (a nested pattern
    such as "name/name/" backtracks over the whole token from every position and takes seconds)."""
    assert len(token) == 60_000 and not any(c.isspace() for c in token)
    start = time.perf_counter()
    found = producers.looks_like_path(token)
    elapsed = time.perf_counter() - start
    assert not found
    assert elapsed < 0.1, f"{elapsed:.3f} s"


@pytest.mark.parametrize(
    "producer, creator, family",
    [
        (WIN_PRODUCER, WIN_PRODUCER, "powerpoint-win"),
        ("Microsoft(R) PowerPoint(R) 2019", "", "powerpoint-win"),  # the (R) signs lost or garbled
        ("Microsoft�� PowerPoint�� 2024", "", "powerpoint-win"),
        ("Microsoft: Print To PDF", "PowerPoint", "powerpoint-win"),
        (MAC_PRODUCER, "Microsoft PowerPoint", "powerpoint-mac"),
        (MAC_PRODUCER, "PowerPoint", "powerpoint-mac"),
        ("Quartz PDFContext", "PowerPoint", "powerpoint-mac"),
        ("macOS Version 15.0", "PowerPoint for Mac", "powerpoint-mac"),
        ("Adobe PDF Library 15.0", "PDFMaker 15 for Microsoft PowerPoint", "acrobat-pdfmaker"),
        ("Adobe PDF Library 23.1", "Acrobat PDFMaker 23 for PowerPoint", "acrobat-pdfmaker"),
        (MAC_PRODUCER, "Keynote", "keynote"),
        ("Skia/PDF m118", "Google", "google-slides"),
        ("Skia/PDF m118 Google Docs Renderer", "", "google-slides"),
        ("Skia/PDF m118", "Chromium", "other"),  # a browser print is not Google Slides
        ("Canva", "Canva", "canva"),
        ("", "", "other"),
        ("Adobe Acrobat Pro 24", "Acrobat Distiller", "other"),
        (MAC_PRODUCER, "", "other"),  # macOS PDF with no PowerPoint creator: Preview, Pages, ...
        (MAC_PRODUCER, "Pages", "other"),
    ],
)
def test_classify_family(producer, creator, family):
    assert producers.classify_family(producer, creator) == family


# --------------------------------------------------------------------------
# image-only pages
# --------------------------------------------------------------------------


def analyze(tmp_path, **kwargs):
    return producers.analyze_pdf(make_pdf(tmp_path / "x.pdf", **kwargs))


def test_image_only_page_needs_no_text_and_image_cover(tmp_path):
    full = (0, 0, 400, 200)
    assert analyze(tmp_path, images=[full])["imageOnlyPages"] == 1
    assert analyze(tmp_path, images=[full], pages=4)["imageOnlyPages"] == 4
    assert analyze(tmp_path, images=[full], text="a caption")["imageOnlyPages"] == 0  # has text
    assert analyze(tmp_path, images=[(0, 0, 100, 100)])["imageOnlyPages"] == 0  # small image
    assert analyze(tmp_path, text="only text")["imageOnlyPages"] == 0
    assert analyze(tmp_path)["imageOnlyPages"] == 0  # blank page


def test_image_only_threshold_is_ninety_percent(tmp_path):
    assert analyze(tmp_path, images=[(0, 0, 360, 200)])["imageOnlyPages"] == 1  # exactly 90 %
    assert analyze(tmp_path, images=[(0, 0, 359, 200)])["imageOnlyPages"] == 0  # 89.75 %


def test_image_cover_is_a_union_not_a_sum(tmp_path):
    # Two tiles that together cover the page count; two copies of the same 60 % area must not add up to 120 %.
    assert analyze(tmp_path, images=[(0, 0, 200, 200), (200, 0, 400, 200)])["imageOnlyPages"] == 1
    assert analyze(tmp_path, images=[(0, 0, 240, 200), (0, 0, 240, 200)])["imageOnlyPages"] == 0
    assert analyze(tmp_path, images=[(0, 0, 240, 200), (100, 0, 300, 200)])["imageOnlyPages"] == 0  # 75 %


def test_image_cover_ignores_the_part_outside_the_page(tmp_path):
    # A huge image that hangs far over the page edges covers the page; one that mostly hangs off does not.
    assert analyze(tmp_path, images=[(-500, -500, 900, 700)])["imageOnlyPages"] == 1
    assert analyze(tmp_path, images=[(300, 0, 1300, 200)])["imageOnlyPages"] == 0


@pytest.mark.parametrize("rotation", [0, 90, 180, 270])
def test_image_only_with_rotation_and_cropbox(tmp_path, rotation):
    assert analyze(tmp_path, images=[(0, 0, 400, 200)], rotation=rotation)["imageOnlyPages"] == 1
    # CropBox smaller than the MediaBox; the image covers the whole MediaBox.
    got = analyze(tmp_path, images=[(0, 0, 400, 200)], rotation=rotation, cropbox=(50, 20, 350, 180))
    assert got["imageOnlyPages"] == 1
    # An image covering only the left half of the CropBox must not be reported (rotation must not swap axes).
    got = analyze(tmp_path, images=[(50, 20, 150, 180)], rotation=rotation, cropbox=(50, 20, 350, 180))
    assert got["imageOnlyPages"] == 0


# --------------------------------------------------------------------------
# tagged, encrypted, unreadable
# --------------------------------------------------------------------------


def test_tagged_comes_from_markinfo(tmp_path):
    assert analyze(tmp_path, tagged=True)["tagged"] is True
    assert analyze(tmp_path, tagged=False)["tagged"] is False
    # /MarkInfo << /Marked false >> is not tagged.
    path = make_pdf(tmp_path / "f.pdf")
    doc = pymupdf.open(path)
    doc.xref_set_key(doc.pdf_catalog(), "MarkInfo", "<</Marked false>>")
    doc.save(tmp_path / "f2.pdf")
    assert producers.analyze_pdf(tmp_path / "f2.pdf")["tagged"] is False
    # /MarkInfo as an indirect object is still read.
    doc = pymupdf.open(path)
    ref = doc.get_new_xref()
    doc.update_object(ref, "<</Marked true>>")
    doc.xref_set_key(doc.pdf_catalog(), "MarkInfo", f"{ref} 0 R")
    doc.save(tmp_path / "f3.pdf")
    assert producers.analyze_pdf(tmp_path / "f3.pdf")["tagged"] is True


def test_owner_password_pdf_is_read_and_marked_encrypted(tmp_path):
    src = make_pdf(tmp_path / "plain.pdf", producer=WIN_PRODUCER, creator=WIN_PRODUCER, pages=2, text="x")
    doc = pymupdf.open(src)
    enc = tmp_path / "enc.pdf"
    doc.save(enc, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="", permissions=4)
    got = producers.analyze_pdf(enc)
    assert got["encrypted"] is True
    assert got["family"] == "powerpoint-win"
    assert got["producer"] == WIN_PRODUCER
    assert got["pages"] == 2
    assert producers.analyze_pdf(src)["encrypted"] is False


def test_password_protected_pdf_is_unreadable_not_a_crash(tmp_path):
    src = make_pdf(tmp_path / "plain.pdf", producer=WIN_PRODUCER, pages=3, text="x")
    pymupdf.open(src).save(tmp_path / "locked.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner",
                           user_pw="user")
    got = producers.analyze_pdf(tmp_path / "locked.pdf")
    assert got["encrypted"] is True
    assert got["family"] == "unreadable"
    assert got["pages"] == 0
    assert got["producer"] == "" and got["creator"] == ""


def test_corrupt_files_are_counted_as_unreadable(tmp_path):
    folder = tmp_path / "SECRET-dir"
    good = make_pdf(folder / "SECRET-good.pdf", producer=WIN_PRODUCER, pages=2, text="x")
    folder.joinpath("SECRET-junk.pdf").write_bytes(b"this is not a pdf")
    folder.joinpath("SECRET-empty.pdf").write_bytes(b"")
    folder.joinpath("SECRET-cut.pdf").write_bytes(good.read_bytes()[:200])
    out = tmp_path / "census.json"
    res = run_census(folder, out)
    assert res.returncode == 0
    assert_hidden(shown(res) + out.read_text(encoding="utf-8"), tmp_path, "SECRET")
    result = json.loads(out.read_text(encoding="utf-8"))
    assert len(result["files"]) == 4
    unreadable = [f for f in result["files"] if f["family"] == "unreadable"]
    assert len(unreadable) == 3
    assert all(f["pages"] == 0 and f["encrypted"] is False and f["imageOnlyPages"] == 0 for f in unreadable)
    assert result["summary"]["byFamily"]["unreadable"] == {"files": 3, "pages": 0}
    assert result["summary"]["byFamily"]["powerpoint-win"] == {"files": 1, "pages": 2}


# --------------------------------------------------------------------------
# summary, folder walking, CLI
# --------------------------------------------------------------------------


def test_summary_ratios(tmp_path):
    folder = tmp_path / "in"
    make_pdf(folder / "a.pdf", producer=WIN_PRODUCER, pages=3, text="a", tagged=True)
    make_pdf(folder / "b.pdf", producer=WIN_PRODUCER, pages=1, text="b", tagged=False)
    make_pdf(folder / "c.pdf", producer="Canva", creator="Canva", pages=4, images=[(0, 0, 400, 200)], tagged=False)
    folder.joinpath("d.pdf").write_bytes(b"broken")  # not in any ratio
    s = census(folder, tmp_path)["summary"]
    assert s["byFamily"] == {
        "powerpoint-win": {"files": 2, "pages": 4},
        "canva": {"files": 1, "pages": 4},
        "unreadable": {"files": 1, "pages": 0},
    }
    assert s["taggedRatio"] == pytest.approx(1 / 3, abs=1e-4)  # 1 of the 3 readable files
    assert s["imageOnlyPageRatio"] == pytest.approx(4 / 8, abs=1e-4)  # 4 of the 8 pages of readable files
    assert s["skipped"] == 0


def test_empty_folder_gives_empty_census(tmp_path):
    (tmp_path / "in").mkdir()
    result = census(tmp_path / "in", tmp_path)
    assert result == {"files": [], "summary": {"byFamily": {}, "taggedRatio": None, "imageOnlyPageRatio": None,
                                               "skipped": 0}}


def test_walks_subfolders_ignores_other_files_and_is_ordered_by_id(tmp_path):
    folder = tmp_path / "in"
    for i, name in enumerate(["z.pdf", "sub/a.PDF", "sub/deep/m.pdf", "b.pdf"]):
        make_pdf(folder / name, producer="P", text=f"file {i}")
    (folder / "notes.txt").write_text("not a pdf", encoding="utf-8")
    (folder / "slides.pptx").write_bytes(b"PK")
    result = census(folder, tmp_path)
    ids = [f["id"] for f in result["files"]]
    assert len(ids) == 4
    assert ids == sorted(ids)
    assert all(len(i) == 12 and set(i) <= set("0123456789abcdef") for i in ids)


def test_same_folder_gives_identical_json(tmp_path):
    folder = tmp_path / "in"
    make_pdf(folder / "a.pdf", producer=WIN_PRODUCER, text="a")
    make_pdf(folder / "b.pdf", producer="Canva", creator="Canva", text="b")
    run_census(folder, tmp_path / "1.json")
    run_census(folder, tmp_path / "2.json")
    assert (tmp_path / "1.json").read_bytes() == (tmp_path / "2.json").read_bytes()


def test_cli_rejects_a_missing_folder(tmp_path):
    out = tmp_path / "o.json"
    res = run_census(tmp_path / "SECRET-missing-dir", out)
    assert res.returncode != 0
    assert not out.exists()
    assert_hidden(shown(res), tmp_path, "SECRET")


# --------------------------------------------------------------------------
# OS errors: no traceback, no path, nothing silently dropped
# --------------------------------------------------------------------------


def deny(self, *args, **kwargs):
    raise PermissionError(13, "Access is denied", str(self))


def test_os_error_while_checking_a_file_is_an_unreadable_file_and_shows_no_path(tmp_path, monkeypatch, capsys):
    folder = tmp_path / "SECRET-dir"
    make_pdf(folder / "SECRET-good-1.pdf", producer=WIN_PRODUCER, text="a")
    make_pdf(folder / "SECRET-good-2.pdf", producer="Canva", creator="Canva", text="b")
    real_is_file = producers.Path.is_file

    def is_file(self):
        if self.name == "SECRET-good-1.pdf":
            deny(self)
        return real_is_file(self)

    monkeypatch.setattr(producers.Path, "is_file", is_file)
    out = tmp_path / "o.json"
    code = producers.main([str(folder), "--out", str(out)])
    seen = capsys.readouterr()

    assert code == 0
    raw = out.read_text(encoding="utf-8")
    assert_hidden(seen.out + seen.err + raw, tmp_path, "SECRET", "denied")
    result = json.loads(raw)
    assert [f["id"] for f in result["files"] if f["family"] == "unreadable"] == ["unreadable-1"]
    assert result["summary"]["byFamily"]["unreadable"] == {"files": 1, "pages": 0}
    assert result["summary"]["byFamily"]["canva"] == {"files": 1, "pages": 1}
    assert result["summary"]["skipped"] == 0


def test_unexpected_error_prints_a_fixed_message_and_returns_nonzero(tmp_path, monkeypatch, capsys):
    folder = tmp_path / "SECRET-dir"
    folder.mkdir()

    def boom(_folder):
        raise PermissionError(13, "Access is denied", str(folder / "SECRET-x.pdf"))

    monkeypatch.setattr(producers, "run_census", boom)
    out = tmp_path / "o.json"
    code = producers.main([str(folder), "--out", str(out)])
    seen = capsys.readouterr()
    assert code == 1
    assert seen.err.startswith("error:")
    assert_hidden(seen.out + seen.err, tmp_path, "SECRET", "denied", "Traceback")
    assert not out.exists()


def test_cli_failure_has_no_traceback_and_no_path(tmp_path):
    # --out below an existing file: the folder cannot be created, the OS error text holds the whole path.
    blocker = tmp_path / "SECRET-blocker"
    blocker.write_text("a file, not a folder", encoding="utf-8")
    folder = tmp_path / "in"
    make_pdf(folder / "a.pdf", producer=WIN_PRODUCER, text="a")
    res = run_census(folder, blocker / "SECRET-sub" / "o.json")
    assert res.returncode == 1
    assert res.stderr.decode("utf-8", "replace").startswith("error:")
    assert_hidden(shown(res), tmp_path, "SECRET", "Traceback")


def test_entries_that_could_not_be_examined_are_counted_as_skipped(tmp_path, monkeypatch):
    folder = tmp_path / "in"
    make_pdf(folder / "ok.pdf", producer=WIN_PRODUCER, text="a")
    make_pdf(folder / "gone.pdf", producer=WIN_PRODUCER, text="b")
    real_is_file, real_walk = producers.Path.is_file, producers.os.walk

    def is_file(self):  # a dangling link, or a file that vanished after it was listed
        return False if self.name == "gone.pdf" else real_is_file(self)

    def walk(top, onerror=None, **kwargs):  # one folder that cannot be listed
        yield from real_walk(top, onerror=onerror, **kwargs)
        onerror(PermissionError(13, "Access is denied", str(Path(top) / "locked")))

    monkeypatch.setattr(producers.Path, "is_file", is_file)
    monkeypatch.setattr(producers.os, "walk", walk)
    result = producers.run_census(folder)
    assert len(result["files"]) == 1
    assert result["summary"]["skipped"] == 2


def test_files_unreadable_from_disk_get_counter_ids_not_name_hashes(tmp_path, monkeypatch):
    folder = tmp_path / "in"
    for sub in ("a", "b"):  # the same file name in two folders must not collide
        make_pdf(folder / sub / "same-name.pdf", producer=WIN_PRODUCER, text="x")
    monkeypatch.setattr(producers.Path, "read_bytes", deny)
    result = producers.run_census(folder)
    assert [(f["id"], f["family"]) for f in result["files"]] == [("unreadable-1", "unreadable"),
                                                                 ("unreadable-2", "unreadable")]
    assert result["summary"]["byFamily"] == {"unreadable": {"files": 2, "pages": 0}}
