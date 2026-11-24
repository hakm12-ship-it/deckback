"""Tests for the PowerPoint export runner (harness/atlas/export.ps1 + export.py).

The test that drives PowerPoint needs `pytest --run-powerpoint`; the argument checks and the font-program reader run
without PowerPoint (the former only on Windows, where export.ps1 can run at all).
"""

import io
import json
import subprocess
import sys
import time
from pathlib import Path

import pymupdf  # PyMuPDF: test oracle only
import pytest
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTFont
from PIL import Image
from pptx import Presentation

from harness.atlas import export
from harness.atlas.deck import ROLES
from harness.fonts import fontcheck
from harness.fonts.program import strip_subset_tag
from harness.ppt.never_stop import run_script
from harness.ppt.pngmode import png_colour_type

ALL_VARIANTS = ["std", "min", "notags", "pdfa", "hidden", "msprint"]
WINDOWS_ONLY = pytest.mark.skipif(sys.platform != "win32", reason="export.ps1 is Windows PowerShell")
LOCK_FILES = {(fam["family"], f["postscriptName"])  # (nameID 1, nameID 6) of every locked font file
              for fam in json.loads(fontcheck.DEFAULT_LOCK.read_text(encoding="utf-8"))["families"]
              for f in fam["files"]}


def embedded_font_problems(fonts):
    """Why embedded font programs may not be in a public PDF (rulings M1-R21, M1-R22, M1-R29): each must be TrueType
    (glyf), not variable (no fvar), and one of the lock's files: its family (nameID 1) and PostScript name together,
    with the PDF BaseFont (subset tag removed) a lock PostScript name too; no Noto or Malgun font at all."""
    ps_names = fontcheck.lock_postscript_names()
    problems = []
    for f in fonts:
        base = strip_subset_tag(f["baseFont"])
        if "glyf" not in f["tables"]:
            problems.append(f"{base}: not TrueType (no glyf)")
        if f["variable"]:
            problems.append(f"{base}: variable (fvar)")
        if (f["family"], f["psName"]) not in LOCK_FILES:
            problems.append(f"{base}: family {f['family']!r} / PostScript name {f['psName']!r} is not a lock file")
        if base not in ps_names:
            problems.append(f"{base}: BaseFont is not a lock PostScript name")
        if any(word in f"{base} {f['family']}".lower() for word in ("noto", "malgun")):
            problems.append(f"{base}: a Noto or Malgun font")
    return problems


def page_label_problems(pdf, manifest):
    """Every page of a PDF without hidden slides must have a text layer holding its slide's label id, except a slide
    the manifest marks knownBitmapText; every font a page uses must be embedded."""
    visible = [entry for entry in manifest["slides"] if not entry["hidden"]]
    problems = []
    with pymupdf.open(pdf) as doc:
        if doc.page_count != len(visible):
            return [f"{doc.page_count} pages for {len(visible)} visible slides"]
        for page, entry in zip(doc, visible, strict=True):
            if any(ext == "n/a" for _, ext, *_ in page.get_fonts(full=True)):
                problems.append(f"{entry['id']}: a font that is not embedded")
            if not entry["knownBitmapText"] and entry["id"] not in page.get_text():
                problems.append(f"{entry['id']}: label not in the text layer of page {page.number + 1}")
    return problems


def pdf_path(out_dir, stem, variant):
    return out_dir / f"{stem}_{variant}.pdf"


def has_struct_tree(pdf):
    with pymupdf.open(pdf) as doc:
        kind, _ = doc.xref_get_key(doc.pdf_catalog(), "StructTreeRoot")
        return kind != "null"


def pdf_pages(pdf):
    with pymupdf.open(pdf) as doc:
        return doc.page_count


def msprint_unavailable(variants):
    """msprint is recorded ok: false, and the export still succeeds, when PowerPoint was already running (M1-R27) or
    the printer is absent."""
    record = variants["msprint"]
    return record["ok"] is False and record.get("reason") in ("printer-missing", export.MSPRINT_SKIPPED)


def small_deck(path, slides=4, hidden=(2,)):
    """A 4:3 deck of blank slides with the given (1-based) slides hidden; its slides are 720 x 540 pt."""
    prs = Presentation()
    for _ in range(slides):
        prs.slides.add_slide(prs.slide_layouts[6])
    for n in hidden:
        prs.slides[n - 1]._element.set("show", "0")
    prs.save(path)
    return path


def powerpoint_pids():
    done = subprocess.run(["tasklist", "/FI", "IMAGENAME eq POWERPNT.EXE", "/FO", "CSV", "/NH"],
                          capture_output=True, text=True, errors="replace")
    return sorted(int(line.split(",")[1].strip('"')) for line in done.stdout.splitlines()
                  if line.lower().startswith('"powerpnt.exe"'))


@pytest.mark.powerpoint
def test_export_probe_all_variants(probe_ofl, tmp_path):
    pptx, manifest = probe_ofl
    out_dir = tmp_path / "export"
    result = export.export(pptx, out_dir, ALL_VARIANTS, ground_truth=True)
    variants = result["variants"]
    assert list(variants) == ALL_VARIANTS

    skipped = msprint_unavailable(variants)  # PowerPoint was already running, or no 'Microsoft Print to PDF'
    expected = [v for v in ALL_VARIANTS if not (v == "msprint" and skipped)]
    for name in expected:
        assert variants[name]["ok"] is True, (name, variants[name])
        assert variants[name]["exitCode"] == 0, (name, variants[name])
        assert pdf_path(out_dir, pptx.stem, name).is_file(), name
    if skipped:
        assert not pdf_path(out_dir, pptx.stem, "msprint").exists()
    else:  # m5: the print job did not leave the Windows default printer changed
        assert variants["msprint"]["defaultPrinter"] in ("unchanged", "restored"), variants["msprint"]
    assert result["scriptExitCode"] == 0

    # The probe deck has 3 slides and none hidden, so every variant has 3 pages; the page count the script
    # reports is the one a PDF reader sees, and it is the one the deck file implies.
    for name in expected:
        assert pdf_pages(pdf_path(out_dir, pptx.stem, name)) == 3, name
        assert variants[name]["pages"] == variants[name]["expectedPages"] == 3, name

    assert has_struct_tree(pdf_path(out_dir, pptx.stem, "std"))
    assert not has_struct_tree(pdf_path(out_dir, pptx.stem, "notags"))

    gt_dir = out_dir / "gt" / pptx.stem
    pngs = sorted(gt_dir.glob("slide*.png"))
    assert [p.name for p in pngs] == ["slide1.png", "slide2.png", "slide3.png"]
    for png in pngs:
        assert png_colour_type(png) == 2, png.name
        with Image.open(png) as img:
            assert img.size == (1920, 1080), png.name
    assert not list(gt_dir.glob("*.bmp")) and not list(gt_dir.glob("*.tif")), "intermediate export files left behind"
    assert result["groundTruth"]["ok"] is True
    assert json.loads((gt_dir / "map.json").read_text(encoding="utf-8")) == {
        "slides": 3, "stdPages": 3, "stdPage": {"1": 1, "2": 2, "3": 3}}

    # M1-R21/R22/R29: PowerPoint embeds the probe's fonts (static TrueType OFL families) as TrueType subsets from the
    # lock, never a variable one, so every page of std and notags carries real text.
    fonts = result["fonts"]
    assert set(fonts) == {"std", "msprint"}
    assert fonts["msprint"] is None if skipped else isinstance(fonts["msprint"], list)
    for listed in fonts.values():
        assert all({"family", "psName", "variable"} <= set(f) for f in listed or [])
    assert {f["family"] for f in fonts["std"]} == {ROLES["ofl"]["HEAD"].family, ROLES["ofl"]["BODY"].family}
    for name in ("std", "notags"):
        pdf = pdf_path(out_dir, pptx.stem, name)
        assert embedded_font_problems(export.embedded_fonts(pdf)) == [], name
        assert page_label_problems(pdf, manifest) == [], name

    if skipped:
        pytest.skip("msprint was recorded ok: false (%s)" % variants["msprint"]["reason"])


@pytest.mark.powerpoint
def test_hidden_slides_change_the_page_counts_and_the_slide_page_map(tmp_path):
    deck = small_deck(tmp_path / "hid.pptx", slides=4, hidden=(2,))
    out_dir = tmp_path / "export"
    result = export.export(deck, out_dir, ["std", "hidden", "msprint"], ground_truth=True)
    variants = result["variants"]
    assert (variants["std"]["ok"], variants["std"]["pages"], variants["std"]["expectedPages"]) == (True, 3, 3)
    assert (variants["hidden"]["ok"], variants["hidden"]["pages"], variants["hidden"]["expectedPages"]) == (True, 4, 4)
    assert pdf_pages(pdf_path(out_dir, "hid", "std")) == 3
    assert pdf_pages(pdf_path(out_dir, "hid", "hidden")) == 4
    if not msprint_unavailable(variants):  # msprint mirrors std: hidden slides are not printed (M1-R28)
        assert (variants["msprint"]["ok"], variants["msprint"]["pages"]) == (True, 3)
    gt_dir = out_dir / "gt" / "hid"
    # All four slides get a ground-truth PNG; a 4:3 slide is 1440 x 1080 at 2 px/pt.
    assert [p.name for p in sorted(gt_dir.glob("slide*.png"))] == [f"slide{n}.png" for n in (1, 2, 3, 4)]
    with Image.open(gt_dir / "slide1.png") as img:
        assert img.size == (1440, 1080)
    assert json.loads((gt_dir / "map.json").read_text(encoding="utf-8")) == {
        "slides": 4, "stdPages": 3, "stdPage": {"1": 1, "2": None, "3": 2, "4": 3}}


@pytest.mark.powerpoint
def test_export_atlas_page_counts(atlas_ofl, tmp_path):
    """The hidden variant has every slide, std has the visible ones: 159 and 161 for the 161-slide atlas, 2 hidden.
    std embeds every role font as a TrueType lock font, and every page but the CFF bitmap sample (atlas/fonts/01)
    carries its label as text."""
    pptx, manifest = atlas_ofl
    total = len(manifest["slides"])
    hidden = sum(1 for s in manifest["slides"] if s["hidden"])
    assert (total, hidden) == (161, 2)
    result = export.export(pptx, tmp_path / "export", ["std", "hidden"], ground_truth=False)
    assert result["variants"]["std"]["pages"] == total - hidden
    assert result["variants"]["hidden"]["pages"] == total
    std = pdf_path(tmp_path / "export", pptx.stem, "std")
    assert pdf_pages(std) == total - hidden
    assert pdf_pages(pdf_path(tmp_path / "export", pptx.stem, "hidden")) == total
    assert result["variants"]["hidden"]["pages"] == result["variants"]["std"]["pages"] + hidden
    assert embedded_font_problems(result["fonts"]["std"]) == []
    assert {f["family"] for f in result["fonts"]["std"]} == {font.family for font in ROLES["ofl"].values()}
    assert page_label_problems(std, manifest) == []


@pytest.mark.powerpoint
def test_a_wrong_page_count_is_not_ok(tmp_path):
    # -TestPageCountAdjust makes the expected count one too high, as if PowerPoint had dropped a page.
    deck = small_deck(tmp_path / "x.pptx", slides=2, hidden=())
    out_dir = tmp_path / "out"
    done = run_export_ps1("-Pptx", str(deck), "-OutDir", str(out_dir), "-Variants", "std", "-TestPageCountAdjust", "1")
    assert done.returncode == 3, done.stderr
    record = export._last_json_line(done.stdout)["variants"]["std"]
    assert (record["ok"], record["exitCode"], record["reason"]) == (False, 3, "page-count-mismatch")
    assert (record["pages"], record["expectedPages"]) == (2, 3)
    assert not pdf_path(out_dir, "x", "std").exists(), "a PDF with the wrong page count must not be left"


def run_export_ps1(*args):
    """export.ps1 with a 180 s limit; past it the script is left running (never ended: m6) and the test fails."""
    return run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(export.EXPORT_PS1),
                       *args], 180)


@WINDOWS_ONLY
def test_bad_arguments_exit_before_powerpoint_is_touched(tmp_path):
    deck = small_deck(tmp_path / "x.pptx", slides=1, hidden=())
    out_dir = tmp_path / "out"
    done = run_export_ps1("-Pptx", str(deck), "-OutDir", str(out_dir), "-Variants", "std,bogus")
    assert done.returncode == 3
    assert "bogus" in done.stderr
    assert not out_dir.exists()
    done = run_export_ps1("-Pptx", str(tmp_path / "missing.pptx"), "-OutDir", str(out_dir))
    assert done.returncode == 3
    assert not out_dir.exists()
    not_a_deck = tmp_path / "junk.pptx"
    not_a_deck.write_bytes(b"not a deck")
    done = run_export_ps1("-Pptx", str(not_a_deck), "-OutDir", str(out_dir))
    assert done.returncode == 3
    assert not out_dir.exists()


@WINDOWS_ONLY
def test_a_busy_powerpoint_is_recorded_as_powerpoint_busy(tmp_path):
    """M1-R74: PowerPoint refusing the calls (busy, as while a dialog is open in it; the -TestBusy hook raises that
    refusal in the module's job before PowerPoint is touched) is recorded per variant and for the ground truth as
    reason powerpoint-busy, not as an error of the deck. m5: the msprint variant records what became of the Windows
    default printer (unchanged here: nothing was printed). No PowerPoint is started."""
    deck = small_deck(tmp_path / "x.pptx", slides=2, hidden=())
    out_dir = tmp_path / "out"
    pids = powerpoint_pids()
    done = run_export_ps1("-Pptx", str(deck), "-OutDir", str(out_dir), "-Variants", "std,msprint", "-GroundTruth",
                          "-TestBusy")
    assert powerpoint_pids() == pids
    assert done.returncode == 3, done.stderr
    result = export._last_json_line(done.stdout)
    std, gt, msprint = result["variants"]["std"], result["groundTruth"], result["variants"]["msprint"]
    assert (std["ok"], std["exitCode"], std["reason"]) == (False, 3, "powerpoint-busy")
    assert (gt["ok"], gt["exitCode"], gt["reason"]) == (False, 3, "powerpoint-busy")
    if msprint.get("reason") == "printer-missing":
        assert "defaultPrinter" not in msprint
    else:
        # with a PowerPoint around, msprint is skipped before its job starts (M1-R27); otherwise the hook refuses it
        assert msprint["reason"] in ("powerpoint-busy", export.MSPRINT_SKIPPED), msprint
        assert msprint["defaultPrinter"] == "unchanged"
    assert not list(out_dir.glob("*.pdf"))


@WINDOWS_ONLY
def test_export_raises_when_the_script_gives_no_result(tmp_path):
    with pytest.raises(export.ExportError) as caught:
        export.export(tmp_path / "missing.pptx", tmp_path / "out", ["std"], ground_truth=False)
    assert "without a result line" in str(caught.value)
    assert "file not found" in caught.value.stderr


@WINDOWS_ONLY
def test_export_gives_up_waiting_but_does_not_stop_the_script(tmp_path, monkeypatch):
    slow = tmp_path / "slow.ps1"
    slow.write_text("Start-Sleep -Seconds 6\r\n", encoding="ascii")
    deck = small_deck(tmp_path / "x.pptx", slides=1, hidden=())
    monkeypatch.setattr(export, "EXPORT_PS1", slow)
    monkeypatch.setattr(export, "subprocess_limit", lambda *args: 2)
    started = time.monotonic()
    with pytest.raises(export.ExportError, match="left running, nothing was stopped"):
        export.export(deck, tmp_path / "out", ["std"], ground_truth=False)
    assert time.monotonic() - started < 5


def test_subprocess_limit_follows_the_modules_time_limits(tmp_path):
    deck = small_deck(tmp_path / "x.pptx", slides=5, hidden=())
    assert export.slide_count(deck) == 5
    assert export.slide_count(tmp_path / "missing.pptx") == 0
    # a run's default limit is 120 s + 4 s per slide; each run may also wait that long for the lock; margins on top
    assert export.subprocess_limit(deck, 7) == 7 * (120 + 4 * 5 + 30) + 60
    assert export.subprocess_limit(deck, 2, timeout_sec=10) == 2 * (10 + 30) + 60


class FakeProcess:
    returncode = 0
    pid = 1

    def __init__(self, stdout, stderr="export.ps1: progress\n"):
        self.out, self.err = stdout, stderr

    def communicate(self, timeout=None):
        return self.out, self.err


def test_a_font_reader_error_does_not_discard_the_export_result(tmp_path, monkeypatch):
    summary = {"variants": {"std": {"ok": True, "exitCode": 0, "pages": 1}, "msprint": {"ok": True, "exitCode": 0, "pages": 1},
                            "min": {"ok": True, "exitCode": 0, "pages": 1}}}
    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: FakeProcess(json.dumps(summary) + "\n"))

    def fake_fonts(pdf):
        if pdf.name.endswith("_msprint.pdf"):
            raise RuntimeError("cannot read " + str(pdf))  # the message (a path) must not reach the result
        return [{"family": "F", "psName": "F-Regular", "variable": False}]

    monkeypatch.setattr(export, "embedded_fonts", fake_fonts)
    result = export.export(tmp_path / "deck.pptx", tmp_path, ["std", "min", "msprint"], ground_truth=False)
    assert result["variants"] == summary["variants"]
    assert result["fonts"] == {"std": [{"family": "F", "psName": "F-Regular", "variable": False}], "msprint": None}
    assert result["fontsErrors"] == {"msprint": "RuntimeError"}
    assert result["scriptExitCode"] == 0 and result["stderr"] == "export.ps1: progress\n"


def test_msprint_is_not_fonted_when_it_was_skipped(tmp_path, monkeypatch):
    summary = {"variants": {"std": {"ok": True, "exitCode": 0, "pages": 1},
                            "msprint": {"ok": False, "exitCode": 4, "pages": 0, "reason": export.MSPRINT_SKIPPED}}}
    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: FakeProcess(json.dumps(summary) + "\n"))
    monkeypatch.setattr(export, "embedded_fonts", lambda pdf: [])
    result = export.export(tmp_path / "deck.pptx", tmp_path, ["std", "msprint"], ground_truth=False)
    assert result["fonts"] == {"std": [], "msprint": None} and "fontsErrors" not in result


# ---- the export stamp (ruling M1-R77) --------------------------------------------------------------------------------


def _fake_export(tmp_path, monkeypatch, variants, ok, deck=b"deck v1", manifest=b'{"slides": []}'):
    """export() with a fake script that reports `ok` (variant -> bool) and writes <stem>_<variant>.pdf for each ok
    variant (its bytes name the deck and the variant), next to deck.pptx and deck.manifest.json."""
    (tmp_path / "deck.pptx").write_bytes(deck)
    if manifest is not None:
        (tmp_path / "deck.manifest.json").write_bytes(manifest)
    for variant in variants:
        if ok[variant]:
            (tmp_path / f"deck_{variant}.pdf").write_bytes(b"%PDF-1.7 " + deck + variant.encode())
    summary = {"variants": {v: {"ok": ok[v], "exitCode": 0 if ok[v] else 3, "pages": 1} for v in variants}}
    monkeypatch.setattr(subprocess, "Popen", lambda *args, **kwargs: FakeProcess(json.dumps(summary) + "\n"))
    monkeypatch.setattr(export, "embedded_fonts", lambda pdf: [])
    monkeypatch.setattr(export, "powerpoint_version", lambda: "16.0.1.2")
    return export.export(tmp_path / "deck.pptx", tmp_path, variants, ground_truth=False)


def _sha(path):
    import hashlib

    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def test_export_stamps_the_deck_its_manifest_and_every_pdf_it_made(tmp_path, monkeypatch):
    """M1-R77: <stem>.export.json next to the PDFs records the sha256 of the deck and its manifest, and per variant
    exported ok the PDF's sha256 and the PowerPoint version; a variant that failed is not in it."""
    result = _fake_export(tmp_path, monkeypatch, ["std", "notags", "min"], {"std": True, "notags": True, "min": False})
    stamp = json.loads((tmp_path / "deck.export.json").read_text(encoding="utf-8"))
    assert stamp["schema"] == export.STAMP_SCHEMA and "stampError" not in result
    assert stamp["pptx"] == {"file": "deck.pptx", "sha256": _sha(tmp_path / "deck.pptx")}
    assert stamp["manifest"] == {"file": "deck.manifest.json", "sha256": _sha(tmp_path / "deck.manifest.json")}
    assert stamp["variants"] == {
        "notags": {"file": "deck_notags.pdf", "sha256": _sha(tmp_path / "deck_notags.pdf"), "powerpoint": "16.0.1.2"},
        "std": {"file": "deck_std.pdf", "sha256": _sha(tmp_path / "deck_std.pdf"), "powerpoint": "16.0.1.2"}}
    for variant in ("std", "notags"):
        assert export.stamp_problem(tmp_path / f"deck_{variant}.pdf", variant, tmp_path / "deck.pptx",
                                    tmp_path / "deck.manifest.json") is None
    assert "no min PDF" in export.stamp_problem(tmp_path / "deck_min.pdf", "min", tmp_path / "deck.pptx",
                                                tmp_path / "deck.manifest.json")


def test_a_later_export_keeps_the_other_variants_only_for_the_same_deck(tmp_path, monkeypatch):
    _fake_export(tmp_path, monkeypatch, ["std", "notags"], {"std": True, "notags": True})
    _fake_export(tmp_path, monkeypatch, ["min"], {"min": True})
    stamp = json.loads((tmp_path / "deck.export.json").read_text(encoding="utf-8"))
    assert sorted(stamp["variants"]) == ["min", "notags", "std"]
    _fake_export(tmp_path, monkeypatch, ["std"], {"std": False})  # a failed re-export drops what it overwrote
    assert sorted(json.loads((tmp_path / "deck.export.json").read_text(encoding="utf-8"))["variants"]) == [
        "min", "notags"]
    _fake_export(tmp_path, monkeypatch, ["std"], {"std": True}, deck=b"deck v2")  # another deck: a stamp of its own
    stamp = json.loads((tmp_path / "deck.export.json").read_text(encoding="utf-8"))
    assert sorted(stamp["variants"]) == ["std"] and stamp["pptx"]["sha256"] == _sha(tmp_path / "deck.pptx")
    _fake_export(tmp_path, monkeypatch, ["min"], {"min": True}, deck=b"deck v2", manifest=b'{"slides": [1]}')
    assert sorted(json.loads((tmp_path / "deck.export.json").read_text(encoding="utf-8"))["variants"]) == ["min"]


def test_stamp_problem_names_what_changed_since_the_export(tmp_path, monkeypatch):
    _fake_export(tmp_path, monkeypatch, ["std"], {"std": True})
    pdf, pptx, manifest = tmp_path / "deck_std.pdf", tmp_path / "deck.pptx", tmp_path / "deck.manifest.json"
    assert export.stamp_problem(pdf, "std", pptx, manifest) is None
    manifest.write_bytes(b'{"slides": ["changed"]}')
    assert "manifest" in export.stamp_problem(pdf, "std", pptx, manifest)
    _fake_export(tmp_path, monkeypatch, ["std"], {"std": True})
    pptx.write_bytes(b"deck v3")
    assert "deck" in export.stamp_problem(pdf, "std", pptx, manifest)
    _fake_export(tmp_path, monkeypatch, ["std"], {"std": True})
    pdf.write_bytes(b"%PDF-1.7 another export")
    assert "not the PDF" in export.stamp_problem(pdf, "std", pptx, manifest)
    (tmp_path / "deck.export.json").unlink()
    assert "no export stamp" in export.stamp_problem(pdf, "std", pptx, manifest)
    (tmp_path / "deck.export.json").write_text("{not json", encoding="utf-8")
    assert "cannot be read" in export.stamp_problem(pdf, "std", pptx, manifest)
    for problem in (export.stamp_problem(pdf, "std", pptx, manifest),):
        assert str(tmp_path) not in problem


def test_a_deck_without_a_manifest_is_stamped_with_none(tmp_path, monkeypatch):
    _fake_export(tmp_path, monkeypatch, ["std"], {"std": True}, manifest=None)
    stamp = json.loads((tmp_path / "deck.export.json").read_text(encoding="utf-8"))
    assert stamp["manifest"] is None
    assert export.stamp_problem(tmp_path / "deck_std.pdf", "std", tmp_path / "deck.pptx", None) is None
    (tmp_path / "deck.manifest.json").write_text("{}", encoding="utf-8")
    assert "manifest" in export.stamp_problem(tmp_path / "deck_std.pdf", "std", tmp_path / "deck.pptx",
                                              tmp_path / "deck.manifest.json")


def static_ttf(with_fvar, names=None):
    """A tiny TrueType font, with or without a variable-font `fvar` table."""
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder([".notdef", "A"])
    fb.setupCharacterMap({65: "A"})
    pen = TTGlyphPen(None)
    pen.moveTo((0, 0))
    pen.lineTo((0, 500))
    pen.lineTo((500, 500))
    pen.closePath()
    glyph = pen.glyph()
    fb.setupGlyf({".notdef": glyph, "A": glyph})
    fb.setupHorizontalMetrics({".notdef": (500, 0), "A": (500, 0)})
    fb.setupHorizontalHeader(ascent=800, descent=-200)
    fb.setupNameTable(names or {"familyName": "Test Sans", "styleName": "Regular", "psName": "TestSans-Regular"})
    fb.setupOS2()
    fb.setupPost()
    if with_fvar:
        fb.setupFvar([("wght", 100, 400, 900, "Weight")], [])
    buf = io.BytesIO()
    fb.save(buf)
    return buf.getvalue()


def test_font_program_info_tells_variable_from_static():
    static = export.font_program_info(static_ttf(with_fvar=False))
    variable = export.font_program_info(static_ttf(with_fvar=True))
    assert static["variable"] is False and variable["variable"] is True
    assert static["family"] == "Test Sans" and static["psName"] == "TestSans-Regular"
    assert "fvar" in variable["tables"] and "fvar" not in static["tables"]
    assert TTFont(io.BytesIO(static_ttf(with_fvar=True)))["fvar"].axes[0].axisTag == "wght"  # the fixture is sound


def test_embedded_font_problems_bites():
    good = {"baseFont": "ABCDEF+Pretendard-Light", "family": "Pretendard Light", "psName": "Pretendard-Light",
            "tables": ["glyf", "name"], "variable": False}
    assert embedded_font_problems([good]) == []
    bad = [
        dict(good, tables=["CFF ", "name"]),  # OpenType-CFF
        dict(good, variable=True),  # fvar
        dict(good, family="Pretendard"),  # nameID 16, not the lock family
        dict(good, baseFont="ABCDEF+Pretendard-Light,Italic"),  # BaseFont not a lock PostScript name
        {"baseFont": "ABCDEF+NotoSansKR-Thin", "family": "Noto Sans KR", "psName": "NotoSansKR-Thin",
         "tables": ["glyf"], "variable": True},
    ]
    problems = embedded_font_problems(bad)
    for expected in ("no glyf", "variable", "family 'Pretendard'", "Pretendard-Light,Italic", "Noto or Malgun"):
        assert any(expected in p for p in problems), expected


def test_page_label_problems_bites(tmp_path):
    pdf = tmp_path / "labels.pdf"
    with pymupdf.open() as doc:
        for text in ("atlas/x/01", "something else", "no label either"):
            doc.new_page().insert_text((72, 72), text)  # base-14 Helvetica: referenced, not embedded
        doc.save(pdf)
    manifest = {"slides": [
        {"id": "atlas/x/01", "hidden": False, "knownBitmapText": False},
        {"id": "atlas/x/02", "hidden": True, "knownBitmapText": False},
        {"id": "atlas/x/03", "hidden": False, "knownBitmapText": False},
        {"id": "atlas/y/01", "hidden": False, "knownBitmapText": True},
    ]}
    problems = page_label_problems(pdf, manifest)
    assert "atlas/x/03: label not in the text layer of page 2" in problems
    assert not any("atlas/y/01: label" in p for p in problems)  # knownBitmapText: no text expected
    assert any("not embedded" in p for p in problems)
    assert page_label_problems(pdf, {"slides": manifest["slides"][:1]}) == ["3 pages for 1 visible slides"]


def test_font_program_info_family_is_the_windows_family_name_id_1():
    # Pretendard-Light.ttf: nameID 1 "Pretendard Light" (the lock family PowerPoint looks up), nameID 16 "Pretendard"
    light = export.font_program_info(static_ttf(with_fvar=False, names={
        "familyName": "Test Sans Light", "styleName": "Regular", "typographicFamily": "Test Sans",
        "typographicSubfamily": "Light", "psName": "TestSans-Light"}))
    assert (light["family"], light["typographicFamily"], light["psName"]) == ("Test Sans Light", "Test Sans",
                                                                              "TestSans-Light")


def test_embedded_fonts_reads_the_font_programs_of_a_pdf(tmp_path):
    pdf = tmp_path / "f.pdf"
    font_file = tmp_path / "t.ttf"
    font_file.write_bytes(static_ttf(with_fvar=True))
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_font(fontname="tst", fontfile=str(font_file))
        page.insert_text((72, 72), "A", fontname="tst")
        doc.save(pdf)
    fonts = export.embedded_fonts(pdf)
    assert [(f["family"], f["variable"]) for f in fonts] == [("Test Sans", True)]


@WINDOWS_ONLY
def test_timeouts_are_recorded_and_the_export_goes_on(tmp_path):
    # -TestHangSec: each run waits before touching PowerPoint, and stopping its job interrupts the wait (exit code 2,
    # not stuck). Every variant is still tried, each is recorded, and the JSON line is written.
    deck = small_deck(tmp_path / "x.pptx", slides=1, hidden=())
    out_dir = tmp_path / "out"
    done = run_export_ps1("-Pptx", str(deck), "-OutDir", str(out_dir), "-Variants", "std,min",
                          "-TimeoutSec", "3", "-TestHangSec", "30")
    assert done.returncode == 2, done.stderr
    result = export._last_json_line(done.stdout)
    assert list(result["variants"]) == ["std", "min"]
    for record in result["variants"].values():
        assert (record["ok"], record["exitCode"], record["reason"]) == (False, 2, "timeout")
    assert not list(out_dir.glob("*.pdf"))


@WINDOWS_ONLY
def test_a_stuck_run_skips_the_rest_and_still_reports(tmp_path):
    # -TestBlockSec: the wait cannot be interrupted (like a PowerPoint call blocked by a dialog), so the run comes back
    # stuck. M1-R19: no further PowerPoint run is started, the rest is recorded, the JSON line is written and the
    # script ends by itself (Environment.Exit) although its job is still blocked.
    deck = small_deck(tmp_path / "x.pptx", slides=1, hidden=())
    out_dir = tmp_path / "out"
    pids_before = powerpoint_pids()
    done = run_export_ps1("-Pptx", str(deck), "-OutDir", str(out_dir), "-Variants", "std,min,msprint",
                          "-GroundTruth", "-TimeoutSec", "1", "-TestBlockSec", "9")
    assert done.returncode == 2, done.stderr
    result = export._last_json_line(done.stdout)
    assert result["variants"]["std"]["reason"] == "timeout"
    for name in ("min", "msprint"):
        assert (result["variants"][name]["ok"], result["variants"][name]["reason"]) == (False, "skipped-after-stuck")
    assert (result["groundTruth"]["ok"], result["groundTruth"]["reason"]) == (False, "skipped-after-stuck")
    # The orphaned job host wakes up after its 9 s block; a stop was requested, so it must never reach PowerPoint.
    time.sleep(12)
    assert powerpoint_pids() == pids_before, "the orphaned job host started or attached to a PowerPoint"
