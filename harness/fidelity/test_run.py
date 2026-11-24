"""Tests for the fidelity orchestrator (run.py), deck discovery (decks.py), the results schema and the dashboard.

No PowerPoint and no real converter: a fake converter writes python-pptx decks (one blank slide per PDF page, the page
size as the slide size) and a fake renderer writes truecolour PNGs at 2 px/pt. The fake renderer draws each visible
slide as the MuPDF render of the PDF named in the deck's core properties (so V1/V2 can pass), a hidden slide in
magenta, and a deck without such a PDF in white. The pages are small (128 x 72 pt, 256 x 144 px) to keep the pixel
metrics fast; the structural checks S1-S6 run for real on these files.
"""

import contextlib
import hashlib
from collections import Counter
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
import pymupdf
import pytest
from PIL import Image
from pptx import Presentation
from pptx.util import Emu

from harness.fidelity import dashboard, decks, metrics, run
from harness.fidelity.render_pdf import render as mupdf_render
from harness.fidelity.schema_check import validate

REPO = Path(__file__).resolve().parents[2]
SCHEMA = json.loads((Path(run.__file__).with_name("results.schema.json")).read_text(encoding="utf-8"))

W_PT, H_PT = 128, 72  # python-pptx needs a slide of 1 inch or more
EMU = 12700
RED, BLUE, GREEN = (1, 0, 0), (0, 0, 1), (0, 0.6, 0)
MAGENTA = (255, 0, 255)
PRIVATE_LEAK = "C:\\Users\\someone\\AppData\\Local\\Temp\\deckback-XYZ"


# ---- fixtures: decks on disk --------------------------------------------------------------------------------------


def make_pdf(path, colours, size=(W_PT, H_PT)):
    """One page per colour: a filled box in that colour on a white page."""
    doc = pymupdf.open()
    for colour in colours:
        page = doc.new_page(width=size[0], height=size[1])
        page.draw_rect(pymupdf.Rect(10, 10, 50, 40), color=None, fill=colour)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(path))
    doc.close()
    return path


def make_pptx(path, slides, pdf=None, hidden=(), size=(W_PT, H_PT)):
    """`slides` blank slides; slide numbers (1-based) in `hidden` get show="0"; `pdf` is noted for the fake renderer."""
    prs = Presentation()
    prs.slide_width = Emu(round(size[0] * EMU))
    prs.slide_height = Emu(round(size[1] * EMU))
    for number in range(1, slides + 1):
        slide = prs.slides.add_slide(prs.slide_layouts[6])
        if number in hidden:
            slide._element.set("show", "0")
    prs.core_properties.subject = str(pdf) if pdf else ""
    path.parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(path))
    return path


def write_manifest(path, entries):
    path.write_text(json.dumps({"deck": path.name.split(".")[0], "slides": entries}), encoding="utf-8")


# ---- fakes ----------------------------------------------------------------------------------------------------------


class FakeConverter:
    """Writes one blank slide per page at the page size; `fail` maps a path substring to an exit code."""

    def __init__(self, fail=None):
        self.fail = fail or {}
        self.calls = []

    def __call__(self, pdf, out_pptx, keep_log=True):
        self.calls.append(Path(pdf))
        for key, code in self.fail.items():
            if key in Path(pdf).as_posix():
                return run.StepResult(code, "timeout" if code == 2 else "error", log=f"converter failed on {pdf}")
        with pymupdf.open(str(pdf)) as doc:
            count = len(doc)
            size = (doc[0].rect.width, doc[0].rect.height)
        make_pptx(Path(out_pptx), count, pdf=pdf, size=size)
        return run.StepResult(0, "ok", log=f"converted {pdf}", stats={"pages": count, "shapes": 0})


def fit(image, width, height):
    """`image` at exactly width x height px (nearest neighbour), as PowerPoint exports a slide at the size asked for."""
    if image.shape[:2] == (height, width):
        return image
    return np.asarray(Image.fromarray(image, "RGB").resize((width, height), Image.NEAREST))


class FakeRenderer:
    """Writes slide<N>.png like render.ps1: at the `size` (width, height) px it is asked for (M1-R61), or without one
    at round(2 px/pt x slide size) as slide_png_action.ps1 does for 0 x 0. With `ignore_size` it renders at `scale`
    px/pt whatever it is asked for (a renderer that gets the size wrong).

    `codes` maps a path substring to an exit code returned without writing anything; `stderr` is the raw message
    text the renderer reports (it quotes the deck's path, as render.ps1 does). `sizes` records each size asked for."""

    def __init__(self, codes=None, scale=2.0, stderr="render.ps1: opened {pptx} via " + PRIVATE_LEAK,
                 ignore_size=False):
        self.codes = codes or {}
        self.scale = scale
        self.stderr = stderr
        self.ignore_size = ignore_size
        self.calls = []
        self.sizes = []

    def __call__(self, pptx, out_dir, keep_log=True, size=None):
        pptx, out_dir = Path(pptx), Path(out_dir)
        self.calls.append(pptx)
        self.sizes.append(size)
        message = self.stderr.format(pptx=pptx)
        for key, code in self.codes.items():
            if key in pptx.as_posix():
                return run.StepResult(code, "timeout" if code == 2 else "error", log=message)
        out_dir.mkdir(parents=True, exist_ok=True)
        prs = Presentation(str(pptx))
        if size is not None and not self.ignore_size:
            width, height = size
        else:
            width = round(prs.slide_width / EMU * self.scale)
            height = round(prs.slide_height / EMU * self.scale)
        source = prs.core_properties.subject
        pages = []
        if source and Path(source).is_file():
            with pymupdf.open(source) as doc:
                pages = list(range(len(doc)))
        page = 0
        for number, slide in enumerate(prs.slides, start=1):
            if slide._element.get("show") == "0":
                image = np.zeros((height, width, 3), np.uint8) + np.array(MAGENTA, np.uint8)
            elif page < len(pages):
                image = fit(mupdf_render(Path(source), pages[page], scale=self.scale), width, height)
                page += 1
            else:
                image = np.full((height, width, 3), 255, np.uint8)
            Image.fromarray(image, "RGB").save(out_dir / f"slide{number}.png")
        return run.StepResult(0, "ok", log=message)


def fake_s7(out_pptx, in_pdf):
    return {"status": "pass", "detail": "fake round trip"}


def tools(converter=None, renderer=None, s7=fake_s7, render_pdf=mupdf_render):
    return run.Tools(convert=converter or FakeConverter(), render=renderer or FakeRenderer(),
                     render_pdf=render_pdf, s7=s7)


def public_tree(root, names=("deck1", "deck2"), variants=("std",), source=False):
    for index, name in enumerate(names):
        for variant in variants:
            pdf = make_pdf(root / "corpus" / "generated" / f"{name}_{variant}.pdf", [RED, BLUE][: 1 + index % 2])
        if source:
            make_pptx(root / "corpus" / "generated" / f"{name}.pptx", 1 + index % 2, pdf=pdf)
    return root


def stamp_public(root):
    """Stamp every public PDF set under `root` as harness.atlas.export does after an export (ruling M1-R77): the PDFs
    <name>_<variant>.pdf of every deck with a <name>.pptx or <name>.manifest.json next to them."""
    from harness.atlas.export import write_stamp

    for directory in (Path(root) / decks.PUBLIC_DIR, Path(root) / decks.ATLAS_DIR):
        if not directory.is_dir():
            continue
        names = {}
        for pdf in directory.glob("*.pdf"):
            name, _, variant = pdf.stem.rpartition("_")
            names.setdefault(name, []).append(variant)
        for name, variants in names.items():
            if (directory / f"{name}.pptx").is_file() or (directory / f"{name}.manifest.json").is_file():
                write_stamp(directory / f"{name}.pptx", directory, variants, variants, None, version_known=True)


def measure(root, out_root, the_tools, sets=("public",), variants=("std",), s7=True, limit_slides=None, stamp=True):
    if stamp:
        stamp_public(root)
    found = decks.discover(root, sets, variants)
    return run.run_decks(found, the_tools, out_root, converter="proto", s7_enabled=s7, limit_slides=limit_slides,
                         options={"decks": list(sets), "variants": list(variants), "s7": s7,
                                  "limitSlides": limit_slides})


def deck(results, deck_id, variant="std"):
    return next(d for d in results["decks"] if d["id"] == deck_id and d["variant"] == variant)


# ---- Review Focus 2: a deck that hangs is recorded and the run goes on ------------------------------------------


def test_timeout_deck_is_recorded_and_run_continues(tmp_path, capfd):
    """Review Focus 2 with ruling M1-R74: the deck that hangs is recorded with exit code 2 and the run goes on with
    the next deck, which is converted and measured; but PowerPoint may still be held by the first deck's dialog, so
    every later PowerPoint step (render, ground truth, S7) is recorded as skipped-after-stuck, never charged to a deck
    or its converter, and never attempted."""
    root = public_tree(tmp_path / "repo")
    renderer = FakeRenderer(codes={"/deck1/": 2})
    s7_calls = []

    def s7(out_pptx, in_pdf):
        s7_calls.append(Path(out_pptx))
        return fake_s7(out_pptx, in_pdf)

    stamp_public(root)
    code = run.main(["--converter", "proto", "--decks", "public", "--variants", "std", "--out",
                     str(tmp_path / "r.json")], root=root, out_root=tmp_path / "fid",
                    tools=tools(renderer=renderer, s7=s7))
    results = json.loads((tmp_path / "r.json").read_text(encoding="utf-8"))
    assert code == 1

    first, second = deck(results, "deck1"), deck(results, "deck2")
    assert [d["id"] for d in results["decks"]] == ["deck1", "deck2"]
    assert first["exitCodes"]["render"] == 2 and first["reasons"]["render"] == "timeout"
    assert first["slides"] and all(s["pass"] is False for s in first["slides"])
    assert all("error" in s["v2"] and "render exit 2" in s["v2"]["error"] for s in first["slides"])
    # deck 2 is still measured: converted, its S1-S6 computed; its PowerPoint steps are not attempted
    assert [p.parent.parent.name for p in renderer.calls] == ["deck1"] and s7_calls == []
    assert second["exitCodes"] == {"input": 0, "convert": 0, "render": None, "groundTruth": None}
    assert second["reasons"]["render"] == "skipped-after-stuck"
    assert len(second["slides"]) == 2
    for slide in second["slides"]:
        assert "skipped-after-stuck" in slide["v2"]["error"]
        assert not any(slide["s"][key]["detail"].startswith("facts:") for key in ("S1", "S2", "S3", "S4", "S5", "S6"))
        assert slide["s"]["S7"]["status"] == "n/a" and slide["s"]["S7"]["detail"].startswith("skipped-after-stuck")
    for slide in first["slides"]:  # deck 1's own S7 comes after its render: skipped too
        assert slide["s"]["S7"]["status"] == "n/a" and "skipped-after-stuck" in slide["s"]["S7"]["detail"]
    summary = results["summary"]
    assert summary["exitCodes"]["renderFailed"] == 1  # deck 1 only: a skipped step is not a render failure
    assert summary["powerpoint"] == {"stuckAt": {"id": "deck1", "variant": "std", "step": "render"},
                                     "skippedAfterStuck": 3, "busy": 0}
    err = capfd.readouterr().err
    assert re.search(r"deck1 std: .*render 2 \(timeout\)", err), err  # never silent
    assert re.search(r"deck2 std: .*render - \(not run: skipped-after-stuck\)", err), err
    assert "skipped-after-stuck" in err and "harness/README.md" in err  # the loud line with the manual cleanup
    html = (tmp_path / "fid" / "dashboard.html").read_text(encoding="utf-8")
    assert "PowerPoint timed out at deck1 std (render)" in html and "3 later PowerPoint step(s)" in html


def test_after_a_ground_truth_timeout_only_cached_ground_truth_is_used(tmp_path):
    """M1-R74: a ground-truth render that times out stops every later PowerPoint step of the run, its own deck's S7
    included; a ground truth already in the cache needs no PowerPoint and is still used."""
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"), source=True)
    measure(root, tmp_path / "fid", tools())  # fills the ground-truth cache of both decks
    shutil.rmtree(tmp_path / "fid" / "gt" / "deck1")
    renderer = FakeRenderer(codes={"generated/deck1.pptx": 2})  # deck 1's source deck hangs
    results = measure(root, tmp_path / "fid", tools(renderer=renderer))
    first, second = deck(results, "deck1"), deck(results, "deck2")
    assert first["exitCodes"]["render"] == 0
    assert (first["exitCodes"]["groundTruth"], first["reasons"]["groundTruth"]) == (2, "timeout")
    assert (second["exitCodes"]["render"], second["reasons"]["render"]) == (None, "skipped-after-stuck")
    assert (second["exitCodes"]["groundTruth"], second["reasons"]["groundTruth"]) == (0, "cached")
    assert [p.name for p in renderer.calls] == ["out.pptx", "deck1.pptx"]
    for slide in first["slides"] + second["slides"]:
        assert slide["s"]["S7"]["status"] == "n/a" and "skipped-after-stuck" in slide["s"]["S7"]["detail"]
    assert results["summary"]["powerpoint"] == {"stuckAt": {"id": "deck1", "variant": "std", "step": "groundTruth"},
                                                "skippedAfterStuck": 3, "busy": 0}
    assert results["summary"]["exitCodes"]["groundTruthFailed"] == 1


def test_after_a_ground_truth_timeout_an_uncached_ground_truth_is_skipped(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"), source=True)
    renderer = FakeRenderer(codes={"generated/deck1.pptx": 2})
    results = measure(root, tmp_path / "fid", tools(renderer=renderer))
    second = deck(results, "deck2")
    assert (second["exitCodes"]["groundTruth"], second["reasons"]["groundTruth"]) == (None, "skipped-after-stuck")
    assert all("skipped-after-stuck" in slide["v1"]["error"] for slide in second["slides"])
    assert not (tmp_path / "fid" / "gt" / "deck2").exists()
    assert results["summary"]["powerpoint"]["skippedAfterStuck"] == 4  # deck 1's S7; deck 2's render, GT and S7
    assert results["summary"]["exitCodes"]["groundTruthFailed"] == 1  # deck 1 only
    assert run.failed_steps(results["summary"]) == 1 + 4  # deck 1's ground truth and the four skipped steps


def test_an_s7_timeout_stops_the_later_powerpoint_steps(tmp_path):
    root = public_tree(tmp_path / "repo")
    renderer = FakeRenderer()

    def s7(out_pptx, in_pdf):
        return {"status": "fail", "detail": "PowerPoint timed out", "powerpoint": "timeout"}

    results = measure(root, tmp_path / "fid", tools(renderer=renderer, s7=s7))
    first, second = deck(results, "deck1"), deck(results, "deck2")
    assert first["slides"][0]["s"]["S7"] == {"status": "fail", "detail": "PowerPoint timed out"}
    assert (second["exitCodes"]["render"], second["reasons"]["render"]) == (None, "skipped-after-stuck")
    assert [p.parent.parent.name for p in renderer.calls] == ["deck1"]
    assert results["summary"]["powerpoint"] == {"stuckAt": {"id": "deck1", "variant": "std", "step": "S7"},
                                                "skippedAfterStuck": 2, "busy": 0}
    assert run.failed_steps(results["summary"]) == 2


def test_powerpoint_busy_is_its_own_reason_and_does_not_stop_the_run(tmp_path, capfd):
    """M1-R74: PowerPoint refusing the calls (busy: a dialog open in it) is recorded as powerpoint-busy, for the render
    as a failed step with that reason and for S7 as n/a, never as a fault of the converter; later decks still use
    PowerPoint."""
    root = public_tree(tmp_path / "repo")

    class BusyOnDeck1(FakeRenderer):
        def __call__(self, pptx, out_dir, keep_log=True, size=None):
            if "/deck1/" in Path(pptx).as_posix():
                self.calls.append(Path(pptx))
                return run.StepResult(run.ERROR, "powerpoint-busy", log="PowerPoint is busy")
            return super().__call__(pptx, out_dir, keep_log, size)

    def s7(out_pptx, in_pdf):
        if "/deck1/" in Path(out_pptx).as_posix():
            return {"status": "n/a", "detail": "powerpoint-busy: PowerPoint refused the calls", "powerpoint": "busy"}
        return fake_s7(out_pptx, in_pdf)

    renderer = BusyOnDeck1()
    stamp_public(root)
    code = run.main(["--converter", "proto", "--decks", "public", "--variants", "std", "--out",
                     str(tmp_path / "r.json")], root=root, out_root=tmp_path / "fid",
                    tools=tools(renderer=renderer, s7=s7))
    results = json.loads((tmp_path / "r.json").read_text(encoding="utf-8"))
    first, second = deck(results, "deck1"), deck(results, "deck2")
    assert (first["exitCodes"]["render"], first["reasons"]["render"]) == (3, "powerpoint-busy")
    assert first["slides"][0]["s"]["S7"] == {"status": "n/a",
                                             "detail": "powerpoint-busy: PowerPoint refused the calls"}
    assert second["exitCodes"]["render"] == 0 and second["slides"][0]["s"]["S7"]["status"] == "pass"
    assert len(renderer.calls) == 2
    assert results["summary"]["powerpoint"] == {"stuckAt": None, "skippedAfterStuck": 0, "busy": 2}
    assert code == 1
    err = capfd.readouterr().err
    assert "render 3 (powerpoint-busy)" in err and "PowerPoint timed out" not in err
    assert "skipped-after-stuck 0, powerpoint-busy 2" in err


def test_converter_timeout_is_left_running_and_run_continues(tmp_path):
    root = public_tree(tmp_path / "repo", names=("aslow", "bfast"))
    template = make_pptx(tmp_path / "template.pptx", 1)
    code = ("import shutil, sys, time\n"
            "if 'aslow' in sys.argv[1]: time.sleep(6)\n"
            f"shutil.copy({str(template)!r}, sys.argv[3])\n"
            "print('{\"pages\": 1, \"shapes\": 0, \"textBoxes\": 0, \"pictures\": 0, \"seconds\": 0.0}')\n")
    converter = run.SubprocessConverter([sys.executable, "-c", code], timeout_sec=1)
    started = time.monotonic()
    try:
        results = measure(root, tmp_path / "fid", tools(converter=converter))
        elapsed = time.monotonic() - started
        slow, fast = deck(results, "aslow"), deck(results, "bfast")
        assert slow["exitCodes"]["convert"] == 2 and slow["reasons"]["convert"] == "timeout"
        assert slow["exitCodes"]["render"] is None
        assert all(s["pass"] is False for s in slow["slides"])
        assert all(s["s"]["S1"]["detail"].startswith("facts: ") for s in slow["slides"])
        assert fast["exitCodes"]["convert"] == 0 and fast["convert"]["shapes"] == 0
        assert elapsed < 6, "the run waited for the slow converter instead of moving on"
    finally:
        for process in run.ABANDONED:  # the abandoned child ends by itself; wait so the temp dir can go
            process.wait(timeout=30)


def test_run_exit_code_and_stderr_report_failed_decks(tmp_path, capfd):
    root = public_tree(tmp_path / "repo")
    code = run.main(["--converter", "proto", "--decks", "public", "--variants", "std", "--out",
                     str(tmp_path / "r.json")], root=root, out_root=tmp_path / "fid",
                    tools=tools(renderer=FakeRenderer(codes={"/deck1/": 3})))
    assert code == 1
    assert "render 3 (error)" in capfd.readouterr().err
    for written in (tmp_path / "r.json", tmp_path / "fid" / "dashboard.html"):  # LF, as .gitattributes wants
        assert b"\r\n" not in written.read_bytes()
    code = run.main(["--converter", "proto", "--decks", "public", "--variants", "std", "--out",
                     str(tmp_path / "r.json")], root=root, out_root=tmp_path / "fid", tools=tools())
    assert code == 0


# ---- Review Focus 3 / M1-R55: private decks are hashed everywhere, raw messages never leak ------------------------


def test_private_decks_are_hashed_everywhere(tmp_path, capfd):
    root = tmp_path / "repo"
    secret_dir = root / "corpus" / "private" / "clientSECRETdir"
    pdf = make_pdf(secret_dir / "SECRET-plan.pdf", [RED, BLUE])
    make_pptx(secret_dir / "SECRET-plan.pptx", 2, pdf=pdf)
    public_tree(root, names=("probe",))
    out_json = tmp_path / "results.json"
    out_root = tmp_path / "fid"
    code = run.main(["--converter", "proto", "--decks", "public,private", "--variants", "std", "--out",
                     str(out_json)], root=root, out_root=out_root, tools=tools())
    captured = capfd.readouterr()
    assert code == 0

    expected_id = hashlib.sha256(pdf.read_bytes()).hexdigest()[:12]
    results = json.loads(out_json.read_text(encoding="utf-8"))
    private = [d for d in results["decks"] if not d["public"]]
    assert [d["id"] for d in private] == [expected_id]
    assert private[0]["variant"] == "pdf" and private[0]["set"] == "private"
    assert private[0]["exitCodes"]["groundTruth"] == 0  # the same-stem PPTX gave V1
    assert all(s["v1"] is not None and s["v1"]["pass"] for s in private[0]["slides"])
    assert all(s["label"] is None and s["known"] == [] for s in private[0]["slides"])

    html = (out_root / "dashboard.html").read_text(encoding="utf-8")
    log = (out_root / "run.log").read_text(encoding="utf-8")
    texts = {"results JSON": out_json.read_text(encoding="utf-8"), "dashboard": html, "stdout": captured.out,
             "stderr": captured.err}
    private_names = ["SECRET", "secret", "clientSECRETdir", str(secret_dir), secret_dir.as_posix(),
                     "corpus/private", "corpus\\private"]
    for name, text in texts.items():
        for needle in private_names + [PRIVATE_LEAK, str(tmp_path), tmp_path.as_posix()]:
            assert needle not in text, f"{needle!r} leaked into the {name}"
    # the run log keeps raw tool text for the public deck only (M1-R55), nothing of the private deck's
    for needle in private_names:
        assert needle not in log, f"{needle!r} leaked into the run log"
    assert f"--- {expected_id}" not in log
    assert all(expected_id not in line for line in log.splitlines() if PRIVATE_LEAK in line)
    assert "--- probe std render" in log and PRIVATE_LEAK in log
    assert expected_id in html and expected_id in captured.err
    # every file the run wrote is named by ids only
    for path in out_root.rglob("*"):
        assert "SECRET" not in path.as_posix() and "secret" not in path.relative_to(out_root).as_posix()
        if path.suffix in (".json", ".log", ".html", ".txt"):
            assert "SECRET" not in path.read_text(encoding="utf-8", errors="replace")


PRIVATE_TEMPLATE = re.compile(r"^(pass|fail|n/a)(; [a-z][a-z ]{0,40} \d{1,9})*; details withheld \(private deck\)$")


def _rename_base_font(pdf, old, new):
    """Rename the BaseFont `old` (no subset tag) of the PDF at `pdf` to `new`, in place."""
    doc = pymupdf.open(str(pdf))
    for xref in range(1, doc.xref_length()):
        if doc.xref_get_key(xref, "BaseFont") == ("name", f"/{old}"):
            doc.xref_set_key(xref, "BaseFont", f"/{new}")
    data = doc.tobytes()
    doc.close()
    Path(pdf).write_bytes(data)


def test_private_details_are_name_free_templates(tmp_path, capfd):
    """M1-R75 (F8): a private deck's S1-S7 details are a fixed template with counts only: no font, shape, text or
    typeface name of the private PDF or of the converter's output reaches the results, the dashboard, stdout or
    stderr. A public deck keeps its full details."""
    from harness.fidelity.test_structural import base_scene, build_pdf, build_pptx, text

    def pdf_with_note(path, base_font):
        """base_scene() plus "Note" in a font that is not embedded, whose BaseFont is `base_font`."""
        path.parent.mkdir(parents=True, exist_ok=True)
        pdf = build_pdf(path, base_scene())
        doc = pymupdf.open(str(pdf))
        doc[0].insert_text((600, 500), "Note", fontname="helv", fontsize=10)
        data = doc.tobytes()
        doc.close()
        pdf.write_bytes(data)
        _rename_base_font(pdf, "Helvetica", base_font)
        return pdf

    root = tmp_path / "repo"
    pdf_with_note(root / "corpus" / "private" / "clientSECRETdir" / "SECRET-plan.pdf", "AcmeBankCorporateSans-Bold")
    pdf_with_note(root / "corpus" / "generated" / "pub_std.pdf", "Helvetica")
    # the converter carries the typeface over; a wrong one, so S6 fails and names it in a public detail
    out = build_pptx(tmp_path / "out.pptx", base_scene() + [text((600, 500), "Note", 10, (0, 0, 0))],
                     typeface="AcmeTypefaceCorp")
    the_tools = tools(converter=CopyConverter({"SECRET-plan.pdf": out, "pub_std.pdf": out}))

    code, results, out_json, out_root = run_main(root, tmp_path, "public,private", the_tools)
    captured = capfd.readouterr()
    private = next(d for d in results["decks"] if not d["public"])
    details = {key: value["detail"] for key, value in private["slides"][0]["s"].items()}
    for key, detail in details.items():
        assert PRIVATE_TEMPLATE.match(detail), (key, detail)
    assert private["slides"][0]["s"]["S6"]["status"] == "fail" and "mismatches" in details["S6"]
    texts = {"results JSON": out_json.read_text(encoding="utf-8"), "stdout": captured.out, "stderr": captured.err,
             "dashboard": (out_root / "dashboard.html").read_text(encoding="utf-8")}
    public_s6 = deck(results, "pub")["slides"][0]["s"]["S6"]["detail"]
    assert "AcmeTypefaceCorp" in public_s6  # a public deck keeps its details
    private_text = json.dumps(private)
    for needle in ("Acme", "Deck Sans", "DeckSans", "Helvetica", "shape '", "pdf:p1"):
        assert needle not in private_text, needle
    for name in ("stdout", "stderr"):
        assert "Acme" not in texts[name], name
    html = texts["dashboard"]
    section = html[html.index(f"<h2>{private['id']} "):]  # the private deck's own table
    assert "AcmeBank" not in html and "AcmeTypefaceCorp" not in section
    assert_no_private_trace(tmp_path, out_root, texts, (out_root / "run.log").read_text(encoding="utf-8"))


def _damage_font_programs(pdf):
    """Overwrite every embedded TrueType program of the PDF at `pdf` with junk, in place."""
    doc = pymupdf.open(str(pdf))
    damaged = 0
    for xref in range(1, doc.xref_length()):
        if doc.xref_is_stream(xref) and doc.xref_stream(xref)[:4] == b"\x00\x01\x00\x00":
            doc.update_stream(xref, b"\x00\x01\x00\x00" + b"junk" * 64)
            damaged += 1
    data = doc.tobytes()
    doc.close()
    Path(pdf).write_bytes(data)
    return damaged


def test_mupdf_messages_about_a_private_pdf_never_reach_the_console(tmp_path, capfd, monkeypatch):
    """M1-R75 (m7): MuPDF's own messages on a damaged private PDF quote its font names ("MuPDF error: library error:
    FT_New_Memory_Face(ABCDEF+DeckSans-Regular): unknown file format"); the runner switches them off, as the census
    does, so stdout and stderr carry neither "MuPDF" nor the font's name. PyMuPDF writes its messages to the stdout
    it saw at import, which pytest's own capture hides from capfd: the test reads PyMuPDF's message stream itself."""
    import io

    from harness.fidelity.test_structural import base_scene, build_pdf

    root = tmp_path / "repo"
    secret_dir = root / "corpus" / "private" / "clientSECRETdir"
    secret_dir.mkdir(parents=True)
    pdf = build_pdf(secret_dir / "SECRET-plan.pdf", base_scene())
    assert _damage_font_programs(pdf) >= 2
    messages = io.StringIO()
    monkeypatch.setattr(pymupdf, "_g_out_message", messages)
    # MuPDF's default; set here because the census (an earlier test may have run it) switches them off for good
    saved = (pymupdf.TOOLS.mupdf_display_errors(), pymupdf.TOOLS.mupdf_display_warnings())
    pymupdf.TOOLS.mupdf_display_errors(True)
    pymupdf.TOOLS.mupdf_display_warnings(True)
    try:
        pymupdf.open(str(pdf))[0].get_pixmap()  # the damage is real: outside a run, MuPDF names the font
        assert "FT_New_Memory_Face(ABCDEF+DeckSans" in messages.getvalue()
        messages.seek(0)
        messages.truncate()

        code, results, out_json, out_root = run_main(root, tmp_path, "private", tools())
        captured = capfd.readouterr()
        assert results["decks"][0]["slides"]
        for text in (messages.getvalue(), captured.out, captured.err):
            assert "MuPDF" not in text and "DeckSans" not in text and "FT_New_Memory_Face" not in text
        # the setting is the run's own: it is restored afterwards
        assert (pymupdf.TOOLS.mupdf_display_errors(), pymupdf.TOOLS.mupdf_display_warnings()) == (True, True)
    finally:
        pymupdf.TOOLS.mupdf_display_errors(bool(saved[0]))
        pymupdf.TOOLS.mupdf_display_warnings(bool(saved[1]))


def test_raw_renderer_text_stays_out_of_results_for_public_decks(tmp_path, capfd):
    root = public_tree(tmp_path / "repo")
    out_json = tmp_path / "r.json"
    run.main(["--converter", "proto", "--decks", "public", "--variants", "std", "--out", str(out_json)], root=root,
             out_root=tmp_path / "fid", tools=tools(renderer=FakeRenderer(codes={"/deck1/": 3})))
    captured = capfd.readouterr()
    for text in (out_json.read_text(encoding="utf-8"), captured.out, captured.err,
                 (tmp_path / "fid" / "dashboard.html").read_text(encoding="utf-8")):
        assert PRIVATE_LEAK not in text and "render.ps1: opened" not in text
    # the run log may keep a public deck's raw text (M1-R55)
    assert PRIVATE_LEAK in (tmp_path / "fid" / "run.log").read_text(encoding="utf-8")


# ---- M1-R62: unreadable private files and unreadable or encrypted input PDFs ---------------------------------------

SECRET_NEEDLES = ("SECRET", "secret", "clientSECRETdir", "corpus/private", "corpus\\private")


@contextlib.contextmanager
def unreadable(path):
    """`path` (a file, or a directory: then it cannot be listed) cannot be opened for reading while the block runs: on
    Windows another handle holds it with no sharing (as an export still writing it would); elsewhere its permissions
    are removed."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateFileW.restype = wintypes.HANDLE
        kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                         wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        # GENERIC_READ, share mode 0 (nobody else may open it), OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL; a directory is
        # opened with FILE_FLAG_BACKUP_SEMANTICS, and listing it then fails with a sharing violation
        flags = 0x02000000 if path.is_dir() else 0x80
        handle = kernel32.CreateFileW(str(path), 0x80000000, 0, None, 3, flags, None)
        assert handle not in (None, ctypes.c_void_p(-1).value), ctypes.get_last_error()
        try:
            yield
        finally:
            kernel32.CloseHandle(handle)
    else:
        if os.geteuid() == 0:
            pytest.skip("root can read a file without permissions")
        mode = path.stat().st_mode
        path.chmod(0)
        try:
            yield
        finally:
            path.chmod(mode)


def assert_no_private_trace(tmp_path, out_root, texts, log):
    """No private name or path in the results JSON, dashboard, stdout or stderr (`texts`), the run log or any file
    name or text file the run wrote."""
    for name, text in texts.items():
        for needle in SECRET_NEEDLES + (str(tmp_path), tmp_path.as_posix(), PRIVATE_LEAK):
            assert needle not in text, f"{needle!r} leaked into the {name}"
    for needle in SECRET_NEEDLES:  # the run log may name public decks' temp paths, never a private one
        assert needle not in log, f"{needle!r} leaked into the run log"
    for path in out_root.rglob("*"):
        assert "secret" not in path.relative_to(out_root).as_posix().lower()
        if path.is_file() and path.suffix in (".json", ".log", ".html", ".txt"):
            assert "SECRET" not in path.read_text(encoding="utf-8", errors="replace")


def run_main(root, tmp_path, sets, the_tools):
    stamp_public(root)
    out_json, out_root = tmp_path / "results.json", tmp_path / "fid"
    code = run.main(["--converter", "proto", "--decks", sets, "--variants", "std", "--out", str(out_json)],
                    root=root, out_root=out_root, tools=the_tools)
    return code, json.loads(out_json.read_text(encoding="utf-8")), out_json, out_root


def test_unreadable_private_pdf_is_counted_without_a_trace_and_the_run_goes_on(tmp_path, capfd):
    root = tmp_path / "repo"
    secret_dir = root / "corpus" / "private" / "clientSECRETdir"
    locked = make_pdf(secret_dir / "SECRET-locked.pdf", [RED])
    readable = make_pdf(secret_dir / "SECRET-plan.pdf", [BLUE, GREEN])
    (secret_dir / "SECRET-folder.pdf").mkdir()  # a directory with a PDF's name: walked into, never opened
    public_tree(root, names=("probe",))

    with unreadable(locked):
        with pytest.raises(OSError):
            open(locked, "rb").close()
        code, results, out_json, out_root = run_main(root, tmp_path, "public,private", tools())
    captured = capfd.readouterr()

    assert code == 1  # not every private PDF was measured
    assert results["summary"]["privateUnreadable"] == 1
    assert [d["id"] for d in results["decks"]] == ["probe", decks.private_id(readable)]
    assert all(d["slides"] and d["exitCodes"]["input"] == 0 for d in results["decks"])  # the others are measured
    assert re.search(r"\b1 private PDF", captured.err), captured.err
    html = (out_root / "dashboard.html").read_text(encoding="utf-8")
    assert "could not be read" in html
    assert_no_private_trace(tmp_path, out_root, {"results JSON": out_json.read_text(encoding="utf-8"),
                                                 "dashboard": html, "stdout": captured.out, "stderr": captured.err},
                            (out_root / "run.log").read_text(encoding="utf-8"))


def test_encrypted_or_unreadable_input_pdf_is_a_failed_step(tmp_path, capfd):
    root = tmp_path / "repo"
    secret = root / "corpus" / "private" / "clientSECRETdir" / "SECRET-plan.pdf"
    secret.parent.mkdir(parents=True)
    doc = pymupdf.open()
    doc.new_page(width=W_PT, height=H_PT)
    doc.save(str(secret), encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="user-pw", owner_pw="owner-pw")
    doc.close()
    public_tree(root, names=("probe",))
    (root / "corpus" / "generated" / "broken_std.pdf").write_bytes(b"not a pdf")

    code, results, out_json, out_root = run_main(root, tmp_path, "public,private", tools())
    captured = capfd.readouterr()

    assert code == 1
    encrypted = next(d for d in results["decks"] if not d["public"])
    assert encrypted["id"] == hashlib.sha256(secret.read_bytes()).hexdigest()[:12]
    assert encrypted["exitCodes"]["input"] == 3 and encrypted["reasons"]["input"] == "encrypted"
    assert encrypted["slides"] == [] and "encrypted" in encrypted["error"]
    broken = deck(results, "broken")
    assert broken["exitCodes"]["input"] == 3 and broken["reasons"]["input"] == "unreadable"
    assert deck(results, "probe")["exitCodes"]["input"] == 0 and deck(results, "probe")["slides"]
    assert results["summary"]["exitCodes"]["inputFailed"] == 2
    assert results["summary"]["privateUnreadable"] == 0
    assert validate(results, SCHEMA) == []
    assert_no_private_trace(tmp_path, out_root, {"results JSON": out_json.read_text(encoding="utf-8"),
                                                 "dashboard": (out_root / "dashboard.html").read_text(encoding="utf-8"),
                                                 "stdout": captured.out, "stderr": captured.err},
                            (out_root / "run.log").read_text(encoding="utf-8"))


def test_unlistable_private_folder_is_counted_without_a_trace(tmp_path, capfd):
    """Carried from Task 12 (M1-R62): a folder under corpus/private that cannot be listed (os.walk's onerror) is
    counted in privateUnreadable, named nowhere, and the run goes on with the other decks."""
    root = tmp_path / "repo"
    secret_dir = root / "corpus" / "private" / "clientSECRETdir"
    locked = secret_dir / "SECRET-inner"
    make_pdf(locked / "SECRET-hidden.pdf", [RED])
    readable = make_pdf(secret_dir / "SECRET-plan.pdf", [BLUE])
    public_tree(root, names=("probe",))

    with unreadable(locked):
        with pytest.raises(OSError):
            os.listdir(locked)
        code, results, out_json, out_root = run_main(root, tmp_path, "public,private", tools())
    captured = capfd.readouterr()

    assert code == 1
    assert results["summary"]["privateUnreadable"] == 1
    assert [d["id"] for d in results["decks"]] == ["probe", decks.private_id(readable)]
    assert all(d["slides"] for d in results["decks"])
    assert_no_private_trace(tmp_path, out_root, {"results JSON": out_json.read_text(encoding="utf-8"),
                                                 "dashboard": (out_root / "dashboard.html").read_text(encoding="utf-8"),
                                                 "stdout": captured.out, "stderr": captured.err},
                            (out_root / "run.log").read_text(encoding="utf-8"))


def test_an_internal_error_in_a_deck_is_input_3_and_exit_1(tmp_path, capfd, monkeypatch):
    """Carried from Task 12 (M1-R62): an exception that escapes one deck's measurement is that deck's failed input
    step (3, "internal-error", the exception type only), the other decks are measured, and the run exits 1."""
    root = public_tree(tmp_path / "repo")
    real = run.measure_deck

    def failing(deck, *args, **kwargs):
        if deck.id == "deck1":
            raise RuntimeError(f"a message quoting {tmp_path / 'SECRET-plan.pdf'}")
        return real(deck, *args, **kwargs)

    monkeypatch.setattr(run, "measure_deck", failing)
    code, results, out_json, out_root = run_main(root, tmp_path, "public", tools())
    captured = capfd.readouterr()
    first, second = deck(results, "deck1"), deck(results, "deck2")
    assert code == 1
    assert first["exitCodes"]["input"] == 3 and first["reasons"]["input"] == "internal-error"
    assert first["slides"] == [] and "RuntimeError" in first["error"] and "SECRET" not in first["error"]
    assert second["exitCodes"]["input"] == 0 and len(second["slides"]) == 2
    assert results["summary"]["exitCodes"]["inputFailed"] == 1
    assert validate(results, SCHEMA) == []
    assert "SECRET" not in captured.out + captured.err


def test_a_run_whose_every_deck_is_unreadable_replaces_the_old_results(tmp_path, capfd):
    """Carried from Task 12: when every PDF asked for is an unreadable private one, the run still writes its results
    and dashboard (no decks, the count in privateUnreadable) and exits 1, so the results of an earlier run are not
    left in place looking current."""
    root = public_tree(tmp_path / "repo")
    code, results, out_json, out_root = run_main(root, tmp_path, "public", tools())
    assert code == 0 and results["decks"]
    locked = make_pdf(root / "corpus" / "private" / "clientSECRETdir" / "SECRET-locked.pdf", [RED])
    with unreadable(locked):
        code, results, out_json, out_root = run_main(root, tmp_path, "private", tools())
    captured = capfd.readouterr()
    assert code == 1
    assert results["decks"] == [] and results["summary"]["privateUnreadable"] == 1
    assert results["options"]["decks"] == ["private"] and validate(results, SCHEMA) == []
    html = (out_root / "dashboard.html").read_text(encoding="utf-8")
    assert "deck1" not in html and "could not be read" in html
    assert "SECRET" not in captured.out + captured.err


def test_a_discovery_error_prints_no_path(tmp_path, capfd, monkeypatch):
    def failing(*args, **kwargs):
        raise PermissionError(13, "Permission denied", str(tmp_path / "corpus" / "private" / "clientSECRETdir"))

    monkeypatch.setattr(decks, "discover", failing)
    code = run.main(["--converter", "proto", "--decks", "private"], root=tmp_path, out_root=tmp_path / "fid",
                    tools=tools())
    captured = capfd.readouterr()
    assert code == 3
    assert "PermissionError" in captured.err
    for needle in SECRET_NEEDLES + (str(tmp_path),):
        assert needle not in captured.err and needle not in captured.out


def test_failed_private_conversion_leaves_no_converter_output_on_disk(tmp_path):
    root = tmp_path / "repo"
    make_pdf(root / "corpus" / "private" / "clientSECRETdir" / "SECRET-plan.pdf", [RED])
    code = ("import sys\n"
            "print('converting', sys.argv[1], flush=True)\n"
            "sys.stderr.write('failed on ' + sys.argv[1])\n"
            "sys.exit(5)\n")
    out_root = tmp_path / "fid"
    results = measure(root, out_root, tools(converter=run.SubprocessConverter([sys.executable, "-c", code])),
                      sets=("private",))
    assert results["decks"][0]["exitCodes"]["convert"] == 3
    for path in out_root.rglob("*"):
        assert "secret" not in path.relative_to(out_root).as_posix().lower()
        if path.is_file():
            assert b"SECRET" not in path.read_bytes(), path.relative_to(out_root).as_posix()


# ---- schema --------------------------------------------------------------------------------------------------------


def test_results_validate_against_schema(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2", "deck3"), source=True)
    make_pdf(root / "corpus" / "private" / "x" / "p.pdf", [GREEN])
    stamp_public(root)
    found = decks.discover(root, ("public", "private"), ("std",))
    results = run.run_decks(found, tools(renderer=FakeRenderer(codes={"/deck3/std/": 2}),
                                         converter=FakeConverter(fail={"deck2": 3})),
                            tmp_path / "fid", converter="proto", s7_enabled=True, limit_slides=None,
                            options={"decks": ["public", "private"], "variants": ["std"], "s7": True,
                                     "limitSlides": None})
    assert SCHEMA["$id"] == "deckback.fidelity/1" and results["schema"] == "deckback.fidelity/1"
    assert validate(results, SCHEMA) == []
    assert set(results["env"]) == {"powerpoint", "pymupdf", "python", "node"}
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", results["date"])
    summary = results["summary"]
    assert summary["slides"] == summary["pass"] + summary["fail"] == sum(len(d["slides"]) for d in results["decks"])
    for gate, counts in summary["byGate"].items():
        assert counts["pass"] + counts["fail"] + counts["na"] == summary["slides"], gate
    # the schema itself refuses what must never be committed
    bad = json.loads(json.dumps(results))
    private = next(d for d in bad["decks"] if not d["public"])
    private["id"] = "SECRET-plan"
    assert validate(bad, SCHEMA)
    bad = json.loads(json.dumps(results))
    bad["decks"][0]["slides"][0]["s"]["S1"]["detail"] = "x" * 301
    assert validate(bad, SCHEMA)
    bad = json.loads(json.dumps(results))
    bad["decks"][0]["slides"][0]["heatmaps"] = {"V2": "C:/Users/x/v2-slide1.png"}
    assert validate(bad, SCHEMA)
    # a private deck is a 12-hex id in the noise floor and in its heatmap paths too
    private_id = next(d["id"] for d in results["decks"] if not d["public"])
    floor = {"id": private_id, "set": "private", "variant": "pdf", "slides": 1,
             "px32_shift1": {"median": 0, "p95": 0, "max": 0}, "residual5": {"median": 0, "p95": 0, "max": 0},
             "overV2": 0}
    good = json.loads(json.dumps(results))
    good["summary"]["noiseFloor"].append(floor)
    next(d for d in good["decks"] if not d["public"])["slides"][0]["heatmaps"] = {
        "V2": f"{private_id}/pdf/v2-slide1.png"}
    assert validate(good, SCHEMA) == []
    bad = json.loads(json.dumps(good))
    bad["summary"]["noiseFloor"][-1]["id"] = "SECRET-plan"
    assert validate(bad, SCHEMA)
    bad = json.loads(json.dumps(good))
    next(d for d in bad["decks"] if not d["public"])["slides"][0]["heatmaps"] = {"V2": "SECRET-plan/pdf/v2-slide1.png"}
    assert validate(bad, SCHEMA)
    assert all(f["set"] in ("public", "atlas") for f in results["summary"]["noiseFloor"])


def test_schema_problems_name_pointers_not_values():
    problems = validate({"schema": "SECRET-value"}, SCHEMA)
    assert problems and all("SECRET" not in p for p in problems)


# ---- measurement wiring (M1-R54, R56, R57, R58) -------------------------------------------------------------------


def make_magenta_page_pdf(path, colours, magenta_pages=(), size=(W_PT, H_PT)):
    """make_pdf, except that the pages in `magenta_pages` (1-based) are magenta all over, as the fake renderer draws a
    hidden slide."""
    doc = pymupdf.open()
    for number, colour in enumerate(colours, start=1):
        page = doc.new_page(width=size[0], height=size[1])
        if number in magenta_pages:
            page.draw_rect(page.rect, color=None, fill=(1, 0, 1), width=0)
        else:
            page.draw_rect(pymupdf.Rect(10, 10, 50, 40), color=None, fill=colour)
    path.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(path))
    doc.close()
    return path


def test_hidden_variant_pairs_every_page_with_its_own_slide(tmp_path):
    """M1-R72 (F2/F10): the hidden variant exports every slide, hidden ones included, so its page p is slide p, and
    its labels and known flags follow that map; std pages skip the hidden slide."""
    root = tmp_path / "repo"
    generated = root / "corpus" / "generated"
    std = make_pdf(generated / "deck_std.pdf", [RED, BLUE])
    make_magenta_page_pdf(generated / "deck_hidden.pdf", [RED, None, BLUE], magenta_pages=(2,))
    make_pptx(generated / "deck.pptx", 3, pdf=std, hidden=(2,))
    write_manifest(generated / "deck.manifest.json", [
        {"n": 1, "id": "deck/a/01", "features": [], "hidden": False, "knownBitmapText": False},
        {"n": 2, "id": "deck/a/02", "features": [], "hidden": True, "knownBitmapText": True},
        {"n": 3, "id": "deck/a/03", "features": ["textbox:rot:30"], "hidden": False, "knownBitmapText": False},
    ])
    results = measure(root, tmp_path / "fid", tools(), variants=("std", "hidden"))
    hidden = deck(results, "deck", "hidden")["slides"]
    assert [s["label"] for s in hidden] == ["deck/a/01", "deck/a/02", "deck/a/03"]
    assert [s["known"] for s in hidden] == [[], ["bitmapText"], ["textAsOutlines"]]
    for slide in hidden:  # page 2 is the hidden slide 2 (magenta in both renders): paired, so V1 passes
        assert slide["v1"]["pass"] is True and slide["v1"]["residual3"] == 0, slide["v1"]
        assert slide["noise"]["pass"] is True, slide["noise"]
    std_slides = deck(results, "deck", "std")["slides"]
    assert [s["label"] for s in std_slides] == ["deck/a/01", "deck/a/03"]
    assert all(s["v1"]["pass"] is True for s in std_slides)


def test_msprint_page_frame_gets_no_v1_and_no_noise(tmp_path):
    """M1-R72 (F2/F10): msprint prints the 16:9 slide onto an A4 page, a frame other than the source slide's, so V1
    and the noise floor are null (reason page-frame-differs) and no ground truth is rendered at its size; the other
    variants are still paired with a ground truth of their own size (the cache directory is keyed by size)."""
    root = tmp_path / "repo"
    generated = root / "corpus" / "generated"
    std = make_pdf(generated / "deck_std.pdf", [RED, BLUE])
    make_pdf(generated / "deck_msprint.pdf", [RED, BLUE], size=(W_PT, 90))  # another page frame
    make_pdf(generated / "deck_notags.pdf", [RED, BLUE])
    make_pptx(generated / "deck.pptx", 2, pdf=std)
    renderer = FakeRenderer()
    results = measure(root, tmp_path / "fid", tools(renderer=renderer), variants=("std", "msprint", "notags"))
    progress = (tmp_path / "fid" / "run.log").read_text(encoding="utf-8")
    assert "deck msprint: input 0 (ok), convert 0 (ok), render 0 (ok), ground truth - (not run: page-frame-differs)" \
        in progress
    msprint = deck(results, "deck", "msprint")
    assert msprint["exitCodes"]["groundTruth"] is None and msprint["reasons"]["groundTruth"] == "page-frame-differs"
    assert all(s["v1"] is None and s["noise"] is None for s in msprint["slides"])
    assert all("error" not in s["v2"] for s in msprint["slides"])
    gt_sizes = [size for pptx, size in zip(renderer.calls, renderer.sizes) if pptx.name == "deck.pptx"]
    assert gt_sizes == [(256, 144)]  # once, at the 16:9 size, never at the msprint page's
    for variant in ("std", "notags"):
        for slide in deck(results, "deck", variant)["slides"]:
            assert "error" not in slide["v1"] and slide["v1"]["pass"] is True, (variant, slide["v1"])
    assert validate(results, SCHEMA) == []
    html = dashboard.render_html(results)
    assert html.count("page frame differs from the source slide") == 2 * len(msprint["slides"])  # V1 and noise cells


@pytest.mark.parametrize("variant, size, frame_differs", [
    ("msprint", (W_PT, H_PT), True),  # a paper variant, even where the paper has the slide's size
    ("pdfa", (W_PT, 90), True),  # any variant whose page is not the source slide's frame
    ("pdfa", (W_PT + 0.4, H_PT), False),  # within a pixel at 2 px/pt: the same frame
])
def test_page_frame_differs_by_variant_or_by_page_size(tmp_path, variant, size, frame_differs):
    root = tmp_path / "repo"
    generated = root / "corpus" / "generated"
    pdf = make_pdf(generated / f"deck_{variant}.pdf", [RED], size=size)
    make_pptx(generated / "deck.pptx", 1, pdf=pdf)
    found = decks.discover(root, ("public",), (variant,))
    assert run.page_frame_differs(found[0], run.page_pixels(pdf)[0]) is frame_differs


def test_a_stale_or_unstamped_export_is_refused(tmp_path, capfd):
    """M1-R77 (m3, m21): a public PDF is measured only when its export stamp records the deck and manifest next to it
    as they are now; otherwise its input step fails with stale-export (no slides; the run exits 1) and the other decks
    are measured. A deck without a source deck or manifest has nothing to be stale against; private decks have no
    stamp."""
    root = public_tree(tmp_path / "repo", names=("fresh", "edited", "unstamped"), source=True)
    generated = root / "corpus" / "generated"
    write_manifest(generated / "edited.manifest.json", [{"n": 1, "id": "edited/a/01", "features": []}])
    make_pdf(generated / "loose_std.pdf", [RED])  # no deck, no manifest
    make_pdf(root / "corpus" / "private" / "x" / "p.pdf", [GREEN])
    stamp_public(root)
    write_manifest(generated / "edited.manifest.json", [{"n": 1, "id": "edited/a/02", "features": []}])
    (generated / "unstamped.export.json").unlink()

    code = run.main(["--converter", "proto", "--decks", "public,private", "--variants", "std", "--out",
                     str(tmp_path / "r.json")], root=root, out_root=tmp_path / "fid", tools=tools())
    results = json.loads((tmp_path / "r.json").read_text(encoding="utf-8"))
    assert code == 1
    for name, problem in (("edited", "manifest edited.manifest.json changed"),
                          ("unstamped", "no export stamp (unstamped.export.json)")):
        record = deck(results, name)
        assert record["exitCodes"]["input"] == 3 and record["reasons"]["input"] == "stale-export", record
        assert record["slides"] == [] and problem in record["error"], record["error"]
    for name in ("fresh", "loose"):
        assert deck(results, name)["exitCodes"]["input"] == 0 and deck(results, name)["slides"]
    assert next(d for d in results["decks"] if not d["public"])["slides"]
    assert results["summary"]["exitCodes"]["inputFailed"] == 2
    assert validate(results, SCHEMA) == []
    assert re.search(r"edited std: input 3 \(stale-export\)", capfd.readouterr().err)


def test_ground_truth_cache_directory_is_keyed_by_size(tmp_path):
    """M1-R72: a ground truth rendered at another size goes to a directory of its own, so it never overwrites the
    PNGs a cached ground truth of the first size points to."""
    root = public_tree(tmp_path / "repo", names=("deck",), source=True)
    found = decks.discover(root, ("public",), ("std",))
    log = run.RunLog(tmp_path / "run.log")
    memo = {}
    try:
        renderer = FakeRenderer()
        first = run.ground_truth(found[0], tools(renderer=renderer), tmp_path / "fid", memo, log, size=(256, 144))
        second = run.ground_truth(found[0], tools(renderer=renderer), tmp_path / "fid", memo, log, size=(128, 72))
    finally:
        log.close()
    assert first.directory != second.directory
    for gt, size in ((first, (256, 144)), (second, (128, 72))):
        with Image.open(gt.directory / "slide1.png") as image:
            assert image.size == size
    assert first.directory.name == "256x144" and first.directory.parent.name == "deck"


def test_ground_truth_follows_the_map_and_skips_hidden_slides(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    pdf = make_pdf(root / "corpus" / "generated" / "deck_std.pdf", [RED, BLUE])
    make_pptx(root / "corpus" / "generated" / "deck.pptx", 3, pdf=pdf, hidden=(2,))
    renderer = FakeRenderer()
    results = measure(root, tmp_path / "fid", tools(renderer=renderer))
    record = deck(results, "deck")
    assert record["exitCodes"]["groundTruth"] == 0
    # page 2 is GT slide 3 (slide 2 is hidden, rendered magenta): V1 and the noise floor pass only with the map
    for slide in record["slides"]:
        assert slide["v1"]["pass"] is True and slide["v1"]["residual3"] == 0
        assert slide["noise"]["pass"] is True and slide["noise"]["residual5"] == 0
    gt_map = json.loads((tmp_path / "fid" / "gt" / "deck" / "256x144" / "map.json").read_text(encoding="utf-8"))
    assert gt_map == {"slides": 3, "stdPages": 2, "stdPage": {"1": 1, "2": None, "3": 2}}
    # cached: a second run does not render the source deck again
    calls = len([c for c in renderer.calls if c.name == "deck.pptx"])
    measure(root, tmp_path / "fid", tools(renderer=renderer))
    assert len([c for c in renderer.calls if c.name == "deck.pptx"]) == calls == 1
    # another renderer (render scripts or PowerPoint version) makes the cache stale
    monkeypatch.setattr(run, "renderer_key", lambda: "another-renderer")
    measure(root, tmp_path / "fid", tools(renderer=renderer))
    assert len([c for c in renderer.calls if c.name == "deck.pptx"]) == 2


def test_render_size_is_checked_before_any_metric(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck",), source=True)
    renderer = FakeRenderer(scale=1.0, ignore_size=True)  # asked for 256 x 144, renders 128 x 72
    results = measure(root, tmp_path / "fid", tools(renderer=renderer))
    assert renderer.sizes == [(256, 144), (256, 144)]  # the output and the ground truth
    for slide in deck(results, "deck")["slides"]:
        assert slide["pass"] is False
        for key in ("v1", "v2"):
            assert "error" in slide[key] and "128 x 72 px" in slide[key]["error"] and "256 x 144" in slide[key]["error"]
        assert "error" in slide["noise"]


def test_odd_page_sizes_are_measured_at_the_mupdf_pixmap_size(tmp_path):
    """M1-R61: an A5 page (419.53 x 595.28 pt) renders 840 x 1191 px in MuPDF, where round(2 x pt) gives 839. Both
    PowerPoint renders (output and ground truth) are asked for exactly MuPDF's size, so V1, V2 and the noise floor are
    computed instead of failing on a size mismatch."""
    root = tmp_path / "repo"
    a5 = (419.53, 595.28)
    pdf = make_pdf(root / "corpus" / "generated" / "a5_std.pdf", [RED, BLUE], size=a5)
    make_pptx(root / "corpus" / "generated" / "a5.pptx", 2, pdf=pdf, size=a5)
    renderer = FakeRenderer()
    results = measure(root, tmp_path / "fid", tools(renderer=renderer))
    assert renderer.sizes == [(840, 1191), (840, 1191)]
    for slide in deck(results, "a5")["slides"]:
        for key in ("v1", "v2", "noise"):
            assert "error" not in slide[key], slide[key]
            assert slide[key]["pass"] is True


def test_powerpoint_renderer_asks_for_the_size_it_is_given(tmp_path, monkeypatch):
    from harness.atlas import export

    commands = []

    class FakePopen:
        def __init__(self, command, **kwargs):
            commands.append(command)
            self.returncode, self.pid = 0, 1

        def communicate(self, timeout=None):
            return "", ""

    monkeypatch.setattr(run.subprocess, "Popen", FakePopen)
    monkeypatch.setattr(export, "slide_count", lambda pptx: 2)
    result = run.PowerPointRenderer()(tmp_path / "deck.pptx", tmp_path / "render", keep_log=False, size=(840, 1191))
    assert result.code == 0
    command = commands[0]
    assert command[command.index("-Width") + 1] == "840" and command[command.index("-Height") + 1] == "1191"


class ScriptPopen:
    """A render.ps1 child that exits with `returncode`, or with `overrun` never finishes within the limit. Records
    whether anything tried to end it."""

    instances = []

    def __init__(self, command, returncode=0, overrun=False, **kwargs):
        self.command, self.returncode, self.overrun, self.pid = command, returncode, overrun, 4242
        self.ended = []
        ScriptPopen.instances.append(self)

    def communicate(self, timeout=None):
        if self.overrun:
            raise run.subprocess.TimeoutExpired(self.command, timeout)
        return "", "render.ps1: a message quoting C:\\private\\deck.pptx"

    def __getattr__(self, name):  # any other method (the ones that end a process, wait, poll) is recorded
        return lambda *args, **kwargs: self.ended.append(name)


@pytest.mark.parametrize("returncode, overrun, expected", [
    (0, False, (0, "ok")), (2, False, (2, "timeout")), (3, False, (3, "error")), (5, False, (3, "powerpoint-busy")),
    (0, True, (2, "left-running"))])
def test_powerpoint_renderer_maps_render_ps1_exit_codes_and_never_ends_it(tmp_path, monkeypatch, returncode, overrun,
                                                                        expected):
    """render.ps1's exit codes (0 ok, 2 timeout, 3 error, 5 PowerPoint busy: ruling M1-R74) become the step's code and
    reason; a render.ps1 that outlives the limit is left running, never killed or terminated (m6)."""
    from harness.atlas import export

    ScriptPopen.instances = []
    monkeypatch.setattr(run.subprocess, "Popen",
                        lambda command, **kwargs: ScriptPopen(command, returncode=returncode, overrun=overrun))
    monkeypatch.setattr(export, "slide_count", lambda pptx: 1)
    abandoned = list(run.ABANDONED)
    result = run.PowerPointRenderer()(tmp_path / "deck.pptx", tmp_path / "render", keep_log=True, size=(256, 144))
    assert (result.code, result.reason) == expected
    [child] = ScriptPopen.instances
    assert child.ended == []
    if overrun:
        assert run.ABANDONED[-1] is child and "left running" in result.log
        run.ABANDONED[:] = abandoned


def test_heatmaps_for_failing_visual_gates(tmp_path):
    root = tmp_path / "repo"
    make_pdf(root / "corpus" / "generated" / "deck_std.pdf", [RED])
    out_root = tmp_path / "fid"

    class WhiteRenderer(FakeRenderer):  # renders every slide white: V2 fails against the red box
        def __call__(self, pptx, out_dir, keep_log=True, size=None):
            prs = Presentation(str(pptx))
            prs.core_properties.subject = ""
            prs.save(str(pptx))
            return super().__call__(pptx, out_dir, keep_log, size)

    results = measure(root, out_root, tools(renderer=WhiteRenderer()))
    slide = deck(results, "deck")["slides"][0]
    assert slide["v2"]["pass"] is False and slide["v2"]["residual5"] > 50
    assert slide["heatmaps"] == {"V2": "deck/std/v2-slide1.png"}
    with Image.open(out_root / "deck" / "std" / "v2-slide1.png") as image:
        assert image.mode == "RGB" and image.size == (256, 144)
    html = (dashboard.render_html(results))
    assert 'href="deck/std/v2-slide1.png"' in html


def test_facts_errors_fail_s1_to_s6_and_s7_without_output(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck",))
    results = measure(root, tmp_path / "fid", tools(converter=FakeConverter(fail={"deck": 3})))
    record = deck(results, "deck")
    assert record["exitCodes"] == {"input": 0, "convert": 3, "render": None, "groundTruth": None}
    slide = record["slides"][0]
    for key in ("S1", "S2", "S3", "S4", "S5", "S6"):
        assert slide["s"][key]["status"] == "fail"
        assert slide["s"][key]["detail"].startswith("facts: output PPTX: ")
    assert slide["s"]["S7"]["status"] == "fail" and "convert exit 3" in slide["s"]["S7"]["detail"]
    assert "error" in slide["v2"] and "convert exit 3" in slide["v2"]["error"]


def test_s7_is_deck_level_optional_and_details_are_capped(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck",))
    seen = []

    def long_s7(out_pptx, in_pdf):
        seen.append(out_pptx)
        return {"status": "fail", "detail": "y" * 1000}

    results = measure(root, tmp_path / "fid", tools(s7=long_s7))
    assert len(seen) == 1  # one round trip per deck x variant
    for slide in deck(results, "deck")["slides"]:
        assert slide["s"]["S7"]["status"] == "fail" and len(slide["s"]["S7"]["detail"]) <= 300
    results = measure(root, tmp_path / "fid", tools(s7=long_s7), s7=False)
    assert len(seen) == 1
    s7 = deck(results, "deck")["slides"][0]["s"]["S7"]
    assert s7["status"] == "n/a" and "--no-s7" in s7["detail"]


def test_summary_counts_every_gate(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck",))
    results = measure(root, tmp_path / "fid", tools())
    slides = [s for d in results["decks"] for s in d["slides"]]
    by_gate = results["summary"]["byGate"]
    assert by_gate["V1"] == {"pass": 0, "fail": 0, "na": 1}
    assert by_gate["V2"] == {"pass": 1, "fail": 0, "na": 0}
    for key in ("S1", "S2", "S3", "S4", "S5", "S6", "S7"):
        statuses = [s["s"][key]["status"] for s in slides]
        assert by_gate[key] == {"pass": statuses.count("pass"), "fail": statuses.count("fail"),
                                "na": statuses.count("n/a")}, key
    assert by_gate["S4"]["pass"] == 1 and by_gate["S7"]["pass"] == 1  # a blank slide: no shapes out of order (R70)


@pytest.mark.parametrize("case, passes", [
    ("all-pass", True), ("no-source-pptx", True), ("s4-na", False), ("s3-fail", False), ("s7-na", False),
    ("s7-fail", False), ("v1-fail", False), ("v2-fail", False)])
def test_pass_is_strict(tmp_path, monkeypatch, case, passes):
    """A slide passes only when V2 passed, V1 passed or is null, and every one of S1-S7 is "pass": an n/a check is
    never a pass (global constraints). Every gate but the one under test passes."""
    statuses = {key: "pass" for key in ("S1", "S2", "S3", "S4", "S5", "S6")}
    statuses.update({"s4-na": {"S4": "n/a"}, "s3-fail": {"S3": "fail"}}.get(case, {}))
    monkeypatch.setattr(run, "structural", lambda pdf, pptx, index: {
        key: {"status": status, "detail": "set by the test"} for key, status in statuses.items()})
    s7_status = {"s7-na": "n/a", "s7-fail": "fail"}.get(case, "pass")
    if case == "v1-fail":
        real = metrics.v1
        monkeypatch.setattr(metrics, "v1", lambda a, b, *rest, real=real: {**real(a, b, *rest), "pass": False})
    if case == "v2-fail":
        # through V2's own limit (M3-R51): an excess of -1 px over a noise floor of 0 fails a residual of 0
        monkeypatch.setattr(metrics, "V2_MAX_RESIDUAL", -1)
    root = public_tree(tmp_path / "repo", names=("deck",), source=case != "no-source-pptx")
    results = measure(root, tmp_path / "fid", tools(s7=lambda out, pdf: {"status": s7_status, "detail": "set"}))
    slide = deck(results, "deck")["slides"][0]
    assert (slide["v1"] is None) == (case == "no-source-pptx")
    assert slide["pass"] is passes
    assert results["summary"]["pass"] == int(passes)
    assert "error" not in slide["v2"] and (slide["v1"] is None or "error" not in slide["v1"])
    if case == "v2-fail":
        assert slide["v2"]["pass"] is False and slide["v2"]["limits"]["basis"] == "noise"
        assert slide["v2"]["residual5"] > slide["v2"]["limits"]["residual5"]


def test_v2_is_held_to_the_noise_floor_with_a_ground_truth_and_to_400_px_and_1_percent_without(tmp_path,
                                                                                                    monkeypatch):
    """Ruling M3-R51: a slide with a ground truth passes V2 within its noise floor (v2(mupdf, gt)) plus 50 px and
    0.6 %; a slide without one within 400 px and 1 %. The record keeps both numbers: V2's and its limits."""
    noises = []
    real_v2 = metrics.v2

    def v2(a, b, noise=None, lines=None):
        noises.append(noise)
        return real_v2(a, b, noise, lines)

    monkeypatch.setattr(metrics, "v2", v2)
    with_gt = public_tree(tmp_path / "with", names=("deck",), source=True)
    slide = deck(measure(with_gt, tmp_path / "fid1", tools()), "deck")["slides"][0]
    assert slide["v2"]["limits"] == {"basis": "noise", "residual5": slide["noise"]["residual5"] + 50,
                                     "px32_shift1": round(slide["noise"]["px32_shift1"] + 0.006, 8)}
    assert noises[:2] == [None, slide["noise"]]  # the noise floor first, then V2 with it
    assert slide["noise"]["limits"]["basis"] == "absolute"
    noises.clear()
    without = public_tree(tmp_path / "without", names=("deck",), source=False)
    slide = deck(measure(without, tmp_path / "fid2", tools()), "deck")["slides"][0]
    assert slide["noise"] is None and noises == [None]
    assert slide["v2"]["limits"] == {"basis": "absolute", "residual5": 400, "px32_shift1": 0.01}


def test_metric_arguments_and_heatmap_pairs_follow_m1_r36(tmp_path, monkeypatch):
    """V2 = v2(mupdf, out), V1 = v1(gt, out), noise = v2(mupdf, gt) (M1-R36/R54/R57); heatmaps of the gate's own
    pair with the fixed image first: V1 heatmap(gt, out), V2 heatmap(out, mupdf). Each image carries a tag in its
    first pixel (a difference of 1-2, far below the 32 that counts)."""
    MUPDF, OUT, GT = 1, 2, 3

    def tagged(image, tag):
        image = image.copy()
        image[0, 0] = tag
        return image

    class TaggingRenderer(FakeRenderer):
        def __call__(self, pptx, out_dir, keep_log=True, size=None):
            result = super().__call__(pptx, out_dir, keep_log, size)
            tag = GT if Path(out_dir).parent.parent.name == "gt" else OUT  # gt/<id>/<w>x<h>/
            for png in Path(out_dir).glob("slide*.png"):
                with Image.open(png) as image:
                    pixels = np.asarray(image.convert("RGB"))
                Image.fromarray(tagged(pixels, tag), "RGB").save(png)
            return result

    calls = []
    real = {name: getattr(metrics, name) for name in ("v1", "v2", "heatmap")}

    def spy(name):
        def call(a, b, *rest):
            calls.append((name, int(a[0, 0, 0]), int(b[0, 0, 0])))
            if name == "heatmap":
                return real[name](a, b, *rest)
            return {**real[name](a, b), "pass": False}  # every gate fails, so both heatmaps are drawn
        return call

    for name in real:
        monkeypatch.setattr(metrics, name, spy(name))
    root = public_tree(tmp_path / "repo", names=("deck",), source=True)
    results = measure(root, tmp_path / "fid", tools(renderer=TaggingRenderer(),
                                                    render_pdf=lambda pdf, i: tagged(mupdf_render(pdf, i), MUPDF)))
    assert sorted(calls) == sorted([("v2", MUPDF, OUT), ("v1", GT, OUT), ("v2", MUPDF, GT),
                                    ("heatmap", GT, OUT), ("heatmap", OUT, MUPDF)])
    assert deck(results, "deck")["slides"][0]["heatmaps"] == {"V1": "deck/std/v1-slide1.png",
                                                              "V2": "deck/std/v2-slide1.png"}


def test_summary_reports_averages_per_deck_variant_and_overall():
    """m1 (spec 5: averages are reported only, never gated): the mean raw_px32 and px32_shift1 of V1 and V2 per deck x
    variant and over the run, from the slides whose gate was computed (an error record or a null gate is left out);
    pass and fail do not change."""
    gates = {key: {"status": "pass", "detail": ""} for key in ("S1", "S2", "S3", "S4", "S5", "S6", "S7")}

    def slide(i, v1, v2):
        return {"index": i, "label": None, "v1": v1, "v2": v2, "noise": None, "s": gates, "known": [],
                "pass": False, "heatmaps": {}}

    def v(raw, shift, residual_key):
        return {"raw_px32": raw, "px32_shift1": shift, residual_key: 0, "pass": True}

    first = {"id": "a", "public": True, "set": "public", "variant": "std",
             "exitCodes": {"input": 0, "convert": 0, "render": 0, "groundTruth": 0},
             "slides": [slide(0, v(0.01, 0.002, "residual3"), v(0.02, 0.004, "residual5")),
                        slide(1, v(0.03, 0.004, "residual3"), {"pass": False, "error": "no render"}),
                        slide(2, None, v(0.04, 0.008, "residual5"))]}
    second = {"id": "b", "public": True, "set": "atlas", "variant": "notags",
              "exitCodes": {"input": 0, "convert": 0, "render": 0, "groundTruth": None},
              "slides": [slide(0, None, v(0.09, 0.018, "residual5"))]}
    summary = run.summarise([first, second])
    averages = summary["averages"]
    a, b = averages["decks"]
    assert (a["id"], a["set"], a["variant"]) == ("a", "public", "std")
    assert a["v1"] == {"slides": 2, "raw_px32": 0.02, "px32_shift1": 0.003}
    assert a["v2"] == {"slides": 2, "raw_px32": 0.03, "px32_shift1": 0.006}
    assert b["v1"] is None and b["v2"] == {"slides": 1, "raw_px32": 0.09, "px32_shift1": 0.018}
    assert averages["overall"]["v1"] == {"slides": 2, "raw_px32": 0.02, "px32_shift1": 0.003}
    assert averages["overall"]["v2"] == {"slides": 3, "raw_px32": 0.05, "px32_shift1": 0.01}  # means, not medians
    assert summary["pass"] == 0  # reported, never gated


def test_averages_are_in_the_results_and_on_the_dashboard(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck",), source=True)
    make_pdf(root / "corpus" / "private" / "x" / "p.pdf", [GREEN])
    results = measure(root, tmp_path / "fid", tools(), sets=("public", "private"))
    assert validate(results, SCHEMA) == []
    ids = [entry["id"] for entry in results["summary"]["averages"]["decks"]]
    assert ids == [d["id"] for d in results["decks"]]
    html = dashboard.render_html(results)
    assert "Averages (reported, never gated)" in html
    bad = json.loads(json.dumps(results))
    bad["summary"]["averages"]["decks"][-1]["id"] = "SECRET-plan"
    assert validate(bad, SCHEMA)  # a private deck is a 12-hex id here too


def test_noise_floor_statistics_are_median_p95_max():
    gates = {key: {"status": "pass", "detail": ""} for key in ("S1", "S2", "S3", "S4", "S5", "S6", "S7")}
    slides = [{"index": i, "label": None, "v1": None, "s": gates,
               "v2": {"raw_px32": 0.0, "px32_shift1": 0.0, "residual5": 0, "pass": True}, "known": [], "pass": False,
               "heatmaps": {}, "noise": {"raw_px32": 0.0, "px32_shift1": i / 1000, "residual5": i, "pass": i <= 10}}
              for i in range(20)]
    record = {"id": "deck", "public": True, "set": "public", "variant": "std", "slides": slides,
              "exitCodes": {"input": 0, "convert": 0, "render": 0, "groundTruth": 0}}
    floor = run.summarise([record])["noiseFloor"][0]
    assert floor["residual5"] == {"median": 9.5, "p95": 18.05, "max": 19}  # p95 by linear interpolation
    assert floor["px32_shift1"] == {"median": 0.0095, "p95": 0.01805, "max": 0.019}
    assert floor["overV2"] == 9 and floor["slides"] == 20 and floor["set"] == "public"


def test_known_flags_and_labels_come_from_the_manifest(tmp_path):
    root = tmp_path / "repo"
    generated = root / "corpus" / "generated"
    make_pdf(generated / "deck_std.pdf", [RED, BLUE, GREEN])
    write_manifest(generated / "deck.manifest.json", [
        {"n": 1, "id": "deck/a/01", "features": ["textbox:rot:30", "effect:softEdge:text"], "hidden": False,
         "knownBitmapText": False},
        {"n": 2, "id": "deck/a/02", "features": ["textbox:rot:90"], "hidden": True, "knownBitmapText": True},
        {"n": 3, "id": "deck/a/03", "features": ["textbox:rot:90", "camera:rot"], "hidden": False,
         "knownBitmapText": True},
        {"n": 4, "id": "deck/a/04", "features": ["prstGeom:rect"], "hidden": False, "knownBitmapText": False},
    ])
    results = measure(root, tmp_path / "fid", tools())
    slides = deck(results, "deck")["slides"]
    assert [s["label"] for s in slides] == ["deck/a/01", "deck/a/03", "deck/a/04"]
    assert [s["known"] for s in slides] == [["bitmapEffect", "textAsOutlines"], ["bitmapEffect", "bitmapText"], []]
    assert results["summary"]["known"] == 2
    assert all(s["pass"] is False for s in slides)  # known classes are recorded, never excused


@pytest.mark.parametrize("features, known", [
    (["prstTxWarp:textNoShape", "prstTxWarp:textPlain"], []),  # m2: no warp, the text stays text
    (["prstTxWarp:textNoShape", "prstTxWarp:textArchUp"], ["textAsOutlines"]),  # m2: a warp draws outlines
    (["text:outline-only"], ["textAsOutlines"]),  # m9
    (["text:noFill"], ["textAsOutlines"]),
    (["text:gradFill"], ["textAsOutlines"]),
    (["txBody:rotated-with-shape"], ["textAsOutlines"]),  # m9: a rotated shape that holds text
    (["grpSp:rot-text"], ["textAsOutlines"]),  # m9: text in a rotated group
    (["grpSp:rot", "grpSp:pic", "xfrm:rot", "xfrm:rot+flip"], []),  # rotation alone says nothing about text
    (["textbox:rot:90", "bodyPr:rot:270"], []),
    (["textbox:rot:30"], ["textAsOutlines"]),
])
def test_known_text_as_outlines_follows_the_manifest_features(features, known):
    """m2, m9: the manifest features under which PowerPoint's export draws text as vector outlines (with the text
    left invisible or absent) give the known class textAsOutlines; recorded, never excused."""
    assert run.known_classes({"features": features}) == known


@pytest.mark.parametrize("slide_id, known", [
    ("atlas/pictures/03", ["lossyPictureExport"]),
    ("atlas/pictures/06", ["lossyPictureExport"]),
    ("atlas/pictures/11", ["lossyPictureExport"]),
    ("atlas/pictures/01", []),  # the class is measured slide by slide, never inferred from a feature
    ("atlas/pictures/12", []),
    (None, []),
])
def test_lossy_picture_export_is_known_by_measurement(slide_id, known):
    """M5-R13: lossyPictureExport is given by slide id from harness/atlas/known.py (the swap test's evidence), the
    same in every atlas deck that holds the slide (atlas, atlas-smoke), with the manifest's own classes beside it."""
    entry = {"id": slide_id, "features": ["pic", "pic:srcRect"]}
    assert run.known_classes(entry) == known
    assert run.known_classes({**entry, "knownBitmapText": True}) == sorted(["bitmapText", *known])


def test_the_schema_accepts_the_lossy_picture_export_class():
    schema = json.loads(run.SCHEMA_PATH.read_text(encoding="utf-8"))
    classes = schema["$defs"]["slide"]["properties"]["known"]["items"]["enum"]
    assert "lossyPictureExport" in classes
    assert set(classes) >= {"bitmapText", "textAsOutlines", "bitmapEffect", "colourEmoji"}


ATLAS_OUT = REPO / "out" / "atlas"
SYMBOLS_AS_PICTURES = set("▶™♥")  # ▶ ™ ♥: PowerPoint draws these atlas symbols as pictures


@pytest.mark.skipif(not ((ATLAS_OUT / "atlas_std.pdf").is_file() and (ATLAS_OUT / "atlas.pptx").is_file()),
                    reason="needs the full atlas exported into out/atlas (harness.atlas.build, harness.atlas.export)")
def test_known_text_as_outlines_matches_the_atlas_exports_text_layer(tmp_path):
    """m9: against PowerPoint's export of the full atlas, the content text a slide has but its page's visible text
    layer lacks (alpha 0 counts as lacking) is explained by a known class, and every slide tagged textAsOutlines
    lacks some. The atlas is built afresh (its manifest is the current code's); out/atlas must hold its export."""
    from harness.atlas.conftest import run_build
    from harness.fidelity.pdf_facts import TEXT_CLIP, TEXT_FLAGS
    from harness.fidelity.pptx_facts import slide_facts

    pptx, manifest = run_build(tmp_path)
    if pptx.read_bytes() != (ATLAS_OUT / "atlas.pptx").read_bytes():
        pytest.skip("out/atlas/atlas.pptx is not the current atlas build: build and export the atlas again")
    slides = [(number, entry) for number, entry in enumerate(manifest["slides"]) if not entry["hidden"]]
    unexplained, untagged = [], []
    with pymupdf.open(str(ATLAS_OUT / "atlas_std.pdf")) as doc:
        assert doc.page_count == len(slides)
        for page, (number, entry) in zip(doc, slides):
            deck_text = [c for run_ in slide_facts(pptx, number).runs for c in run_["text"]
                         if not c.isspace() and c not in SYMBOLS_AS_PICTURES]
            visible = [c for block in page.get_text("rawdict", flags=TEXT_FLAGS, clip=TEXT_CLIP)["blocks"]
                       for line in block.get("lines", ()) for span in line["spans"] if span.get("alpha", 255) > 0
                       for c in (ch["c"] for ch in span["chars"]) if not c.isspace()]
            missing = sum((Counter(deck_text) - Counter(visible)).values())
            known = run.known_classes(entry)
            if missing and not set(known) & {"textAsOutlines", "bitmapText", "bitmapEffect"}:
                unexplained.append(f"{entry['id']} ({missing} characters)")
            if "textAsOutlines" in known and not missing:
                untagged.append(entry["id"])
    assert unexplained == [], "text missing from the visible text layer without a known class"
    assert untagged == [], "tagged textAsOutlines with the whole text in the visible text layer"


def test_noise_floor_summary(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck",), source=True)
    make_pdf(root / "corpus" / "generated" / "deck_notags.pdf", [RED])
    results = measure(root, tmp_path / "fid", tools(), variants=("std", "notags"))
    floors = {(f["id"], f["variant"]): f for f in results["summary"]["noiseFloor"]}
    assert set(floors) == {("deck", "std"), ("deck", "notags")}
    for (deck_id, variant), floor in floors.items():
        values = [s["noise"]["px32_shift1"] for s in deck(results, deck_id, variant)["slides"]]
        assert floor["slides"] == len(values)
        assert floor["px32_shift1"]["max"] == pytest.approx(max(values))
        assert floor["px32_shift1"]["median"] == pytest.approx(float(np.median(values)))
        assert floor["residual5"] == {"median": 0, "p95": 0, "max": 0}
        assert floor["overV2"] == 0


# ---- S1-S6 through run.py, on real, faithful pairs (F1, F3) ------------------------------------------------------


class CopyConverter:
    """A converter whose output is a deck prepared by the test (a faithful one, built by test_structural's builders):
    `outputs` maps a PDF file name to the PPTX to copy. The copy names the input PDF in its core properties, so the
    fake renderer draws its slides as MuPDF renders of that PDF (V2 passes)."""

    def __init__(self, outputs):
        self.outputs = outputs

    def __call__(self, pdf, out_pptx, keep_log=True):
        prs = Presentation(str(self.outputs[Path(pdf).name]))
        prs.core_properties.subject = str(pdf)
        Path(out_pptx).parent.mkdir(parents=True, exist_ok=True)
        prs.save(str(out_pptx))
        return run.StepResult(0, "ok", stats={"pages": len(prs.slides)})


def faithful_tools(outputs):
    return tools(converter=CopyConverter(outputs))


def test_a_faithful_conversion_of_a_slide_without_text_passes(tmp_path):
    """M1-R70 (F1): a photo-only or shapes-only slide converted faithfully passes: S2 (no text on either side), S6 (no
    typeface named) and S4 are satisfied, not n/a, so the strict pass can be reached."""
    from harness.fidelity.test_structural import base_scene, build_pdf, build_pptx

    root = tmp_path / "repo"
    generated = root / "corpus" / "generated"
    generated.mkdir(parents=True)
    scene = base_scene()[:3]  # a fill, a stroke and a picture: no text
    build_pdf(generated / "notext_std.pdf", scene)
    faithful = build_pptx(tmp_path / "faithful.pptx", scene)
    results = measure(root, tmp_path / "fid", faithful_tools({"notext_std.pdf": faithful}))
    slide = deck(results, "notext")["slides"][0]
    assert {key: value["status"] for key, value in slide["s"].items()} == {
        "S1": "pass", "S2": "pass", "S3": "pass", "S4": "pass", "S5": "pass", "S6": "pass", "S7": "pass"}
    assert slide["v2"]["pass"] is True and slide["v1"] is None
    assert slide["pass"] is True and results["summary"]["pass"] == 1


def test_s1_to_s6_compare_pdf_page_i_with_output_slide_i(tmp_path):
    """F3: two pages that differ in structure (another box colour and place, another text) and a faithful two-slide
    deck: S1-S6 pass on both pages. With the deck's slides swapped, S2 and S3 fail on both: a check that paired page
    i with slide i + 1 cannot pass the first run."""
    from harness.fidelity.test_structural import build_pdf, build_pptx, fill, text

    root = tmp_path / "repo"
    generated = root / "corpus" / "generated"
    generated.mkdir(parents=True)
    first = [fill((100, 100, 220, 160), (255, 0, 0)), text((100, 300), "Hello World", 24, (51, 102, 153))]
    second = [fill((500, 200, 700, 260), (0, 0, 255)), text((300, 400), "Second Page", 20, (0, 0, 0))]
    build_pdf(generated / "pair_std.pdf", None, scenes=[first, second])
    faithful = build_pptx(tmp_path / "faithful.pptx", None, scenes=[first, second], pages=[1, 2])
    swapped = build_pptx(tmp_path / "swapped.pptx", None, scenes=[second, first], pages=[2, 1])

    results = measure(root, tmp_path / "fid", faithful_tools({"pair_std.pdf": faithful}))
    for slide in deck(results, "pair")["slides"]:
        assert {key: slide["s"][key]["status"] for key in run.S_KEYS} == dict.fromkeys(run.S_KEYS, "pass"), slide
        assert slide["pass"] is True
    results = measure(root, tmp_path / "fid", faithful_tools({"pair_std.pdf": swapped}))
    for slide in deck(results, "pair")["slides"]:
        assert slide["s"]["S2"]["status"] == "fail" and slide["s"]["S3"]["status"] == "fail", slide["s"]


def test_limit_slides(tmp_path):
    root = public_tree(tmp_path / "repo", names=("a", "b"))
    results = measure(root, tmp_path / "fid", tools(), limit_slides=1)
    assert [len(d["slides"]) for d in results["decks"]] == [1, 1]
    assert deck(results, "b")["pages"] == 2


# ---- decks.py -------------------------------------------------------------------------------------------------------


def test_discover_sets_and_variants(tmp_path):
    root = tmp_path / "repo"
    generated, atlas = root / "corpus" / "generated", root / "out" / "atlas"
    for name in ("probe_std", "probe_notags", "probe_pdfa", "atlas-smoke_std", "loose"):
        make_pdf(generated / f"{name}.pdf", [RED])
    make_pptx(generated / "probe.pptx", 1)
    write_manifest(generated / "probe.manifest.json", [])
    for name in ("atlas_std", "atlas_notags", "probe_std", "sizes-43_std", "sizes-custom_notags", "sizes-xx_std"):
        make_pdf(atlas / f"{name}.pdf", [RED])
    make_pptx(atlas / "sizes-43.pptx", 1)
    private = make_pdf(root / "corpus" / "private" / "a" / "b" / "Deep Name.pdf", [BLUE])
    shutil.copy(private, root / "corpus" / "private" / "copy.pdf")  # same bytes: one deck

    found = decks.discover(root)
    # sets in canonical order, then ids, then the variants in the order asked for; out/atlas holds the atlas and the
    # sizes decks (minor m20), not the probe (the public set's) or any other deck that lies there
    assert [(d.set, d.id, d.variant) for d in found] == [
        ("public", "atlas-smoke", "std"), ("public", "probe", "std"), ("public", "probe", "notags"),
        ("atlas", "atlas", "std"), ("atlas", "atlas", "notags"), ("atlas", "sizes-43", "std"),
        ("atlas", "sizes-custom", "notags")]
    assert next(d for d in found if d.id == "sizes-43").source_pptx.name == "sizes-43.pptx"
    probe = next(d for d in found if d.id == "probe")
    assert probe.public and probe.source_pptx.name == "probe.pptx" and probe.manifest.name == "probe.manifest.json"
    assert next(d for d in found if d.id == "atlas-smoke").source_pptx is None

    found = decks.discover(root, ("private",), ("std",))
    digest = hashlib.sha256(private.read_bytes()).hexdigest()[:12]
    assert [(d.set, d.id, d.variant, d.public) for d in found] == [("private", digest, "pdf", False)]
    assert isinstance(found, decks.DeckList) and found.private_unreadable == 0
    assert decks.private_id(private) == digest

    with pytest.raises(ValueError, match="unknown deck set"):
        decks.discover(root, ("public", "nope"))


def test_the_atlas_set_names_the_decks_the_atlas_recipes_build():
    from harness.atlas import decks as recipes

    sizes = {spec.name for spec in recipes.sizes("ofl")}
    assert set(decks.ATLAS_NAMES) == {"atlas"} | sizes
    assert len(sizes) == 4


def test_cli_rejects_unknown_converter(tmp_path, capfd):
    with pytest.raises(SystemExit) as exc:
        run.main(["--converter", "nope"], root=tmp_path, out_root=tmp_path / "fid", tools=tools())
    assert exc.value.code == 2


def test_package_json_runs_the_proto_converter():
    scripts = json.loads((REPO / "package.json").read_text(encoding="utf-8"))["scripts"]
    assert re.fullmatch(r"harness[\\/]\.venv[\\/]Scripts[\\/]python -m harness\.fidelity\.run --converter proto",
                        scripts["fidelity"])


# ---- M1-R58: what the committed results may contain ---------------------------------------------------------------


FIDELITY_SCHEMA_ID = "deckback.fidelity/1"
SWEEP_SCHEMA_ID = "deckback.oracle-sweep/1"  # npm run oracle:sweep (packages/core/test/sweep), ruling M1-R65
SWEEP_SCHEMA_ID_V2 = "deckback.oracle-sweep/2"  # since M2 Task 1: every PDF names its set, summary.bySet
SWEEP_SCHEMA_ID_V3 = "deckback.oracle-sweep/3"  # since M2 Task 12: every page has the Scene's result (ruling M2-R2)
SWEEP_SCHEMA_IDS = (SWEEP_SCHEMA_ID, SWEEP_SCHEMA_ID_V2, SWEEP_SCHEMA_ID_V3)
# ELEMENT_KINDS of packages/core/test/helpers/oracle.ts
SCENE_KINDS = ("shape", "textline", "picture", "fallback", "hotspot")
SCENE_COUNTS = ("sceneOk", "fallbacks", "notes", "failed")  # what /3 adds to the summary and to each set of bySet
SWEEP_SETS = ("atlas", "atlas-win", "producers")  # SWEEP_SETS of packages/core/test/helpers/sweep.ts
COMMITTED_DIRS = ("results", "baselines", "known")


def _committed_results(root=REPO):
    """Every committed JSON under fidelity/: results, baselines and known lists (ruling M1-R65)."""
    return [path for sub in COMMITTED_DIRS for path in sorted((root / "fidelity" / sub).glob("*.json"))]


MIN_NAME = 3  # shorter names identify nothing and would match everywhere


def public_names(root=REPO):
    """Names that are public anyway: every file name and stem in corpus/generated and out/atlas (a private directory
    may share one, e.g. the probe's originals in corpus/private/probe)."""
    names = set()
    for directory in (root / "corpus" / "generated", root / "out" / "atlas"):
        if directory.is_dir():
            for path in directory.iterdir():
                names |= {path.name, path.stem, path.name.split(".")[0]}
    return names


def private_names(private, public=()):
    """Every name under `private` that could identify a private deck: file names, file stems and directory names,
    except names that are public anyway and names shorter than MIN_NAME characters."""
    names = set()
    if private.is_dir():
        tier_c = private / decks.TIER_C_NAME
        for path in private.rglob("*"):
            if path == tier_c:
                continue  # the tier-C set's own (public) name
            if path.parent == tier_c and path.is_file() and path.stem == decks.private_id(path):
                continue  # M8 tier C: a PDF named by its own 12-hex id (its sha256) is named as the results name it
            names.add(path.name)
            if path.is_file():
                names.add(path.stem)
    return {name for name in names if len(name) >= MIN_NAME and name not in set(public)}


def leaked(text, names):
    """The `names` that occur in `text`, case ignored, unless a letter or digit follows (so a short stem does not match
    the start of an ordinary word); a name glued to whatever comes before it still counts."""
    return sorted(name for name in names if re.search(rf"{re.escape(name)}(?![A-Za-z0-9])", text, re.IGNORECASE))


PRIVATE_DETAIL_PROBLEM = "a private deck's detail that is not the fixed template (M1-R75)"


def private_detail_ok(detail):
    """A private deck's S detail is run.private_detail's template: status, counts named by structural.COUNT_NAMES,
    the fixed tail."""
    from harness.fidelity.structural import COUNT_NAMES

    found = run.PRIVATE_DETAIL.match(str(detail))
    return bool(found) and all(name in COUNT_NAMES for name in re.findall(r"; ([a-z][a-z ]*?) \d+", found.group(2)))


def test_private_name_check_catches_stems_and_directory_names(tmp_path):
    private = tmp_path / "corpus" / "private"
    make_pdf(private / "clientDir" / "Quarterly-Plan.pdf", [RED])
    (private / "probe").mkdir()
    (private / "probe" / "x.txt").write_text("x", encoding="utf-8")
    names = private_names(private, public={"probe"})
    assert names == {"clientDir", "Quarterly-Plan", "Quarterly-Plan.pdf", "x.txt"}
    assert leaked('{"detail": "page 2 of quarterly-plan"}', names) == ["Quarterly-Plan"]
    assert leaked('{"detail": "in clientDir/"}', names) == ["clientDir"]
    assert leaked('{"detail": "Quarterly-Plan.pdf"}', names) == ["Quarterly-Plan", "Quarterly-Plan.pdf"]
    assert leaked('{"id": "probe", "detail": "clientDirectory"}', names) == []
    # a name glued to a letter or digit before it is still the name (carried from Task 12)
    assert leaked('{"detail": "slide1Quarterly-Plan"}', names) == ["Quarterly-Plan"]
    assert leaked('{"heatmap": "x/v2Quarterly-Plan.pdf"}', names) == ["Quarterly-Plan", "Quarterly-Plan.pdf"]


def sweep_v2_problems(pdfs, summary):
    """What a deckback.oracle-sweep/2 file needs beyond /1 (M2 Task 1): every PDF names its set, and summary.bySet has a
    boolean `gate` for each set it lists; only the sweep's own sets are known."""
    problems = []
    if any(not isinstance(record, dict) or record.get("set") not in SWEEP_SETS for record in pdfs):
        problems.append("an oracle sweep (/2) entry without a known set")
    by_set = summary.get("bySet")
    if not isinstance(by_set, dict):
        problems.append("an oracle sweep (/2) without summary.bySet")
        return problems
    if set(by_set) - set(SWEEP_SETS):
        problems.append("an oracle sweep (/2) names a set it does not know in summary.bySet")
    if any(not isinstance(counts, dict) or not isinstance(counts.get("gate"), bool) for counts in by_set.values()):
        problems.append("an oracle sweep (/2) set summary without a boolean gate")
    return problems


def _count(value):
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _scene_ok(scene):
    """One page's `scene` of a /3 sweep: ok, the slide's own element counts per kind, its notes as strings, failed."""
    if not isinstance(scene, dict) or set(scene) != {"ok", "elements", "notes", "failed"}:
        return False
    elements = scene["elements"]
    return (isinstance(scene["ok"], bool)
            and isinstance(elements, dict) and set(elements) == set(SCENE_KINDS)
            and all(_count(n) for n in elements.values())
            and isinstance(scene["notes"], list) and all(isinstance(note, str) for note in scene["notes"])
            and (scene["failed"] is None or isinstance(scene["failed"], str)))


def sweep_v3_problems(pdfs, summary):
    """What a deckback.oracle-sweep/3 file needs beyond /2 (M2 Task 12, ruling M2-R2): every page has the Scene's result
    `scene` ({ok, elements, notes, failed}), and the summary and every set of bySet count sceneOk, fallbacks, notes and
    failed; and (M2 Task 13) summary.skipped lists the sets it did not sweep: known sets, each once, none in bySet."""
    problems = sweep_v2_problems(pdfs, summary)
    pages = [page for record in pdfs if isinstance(record, dict) for page in record.get("pages") or []]
    if any(not isinstance(page, dict) or not _scene_ok(page.get("scene")) for page in pages):
        problems.append("an oracle sweep (/3) page without a well-formed scene result")
    by_set = summary.get("bySet") if isinstance(summary.get("bySet"), dict) else {}
    if any(not isinstance(counts, dict) or not all(_count(counts.get(k)) for k in SCENE_COUNTS)
           for counts in [summary, *by_set.values()]):
        problems.append("an oracle sweep (/3) summary without the scene counts")
    skipped = summary.get("skipped")
    if not isinstance(skipped, list) or not all(isinstance(name, str) for name in skipped):
        problems.append("an oracle sweep (/3) without summary.skipped, the sets it did not sweep")
    elif (set(skipped) - set(SWEEP_SETS) or len(set(skipped)) != len(skipped)
          or set(skipped) & set(by_set)):
        problems.append("an oracle sweep (/3) skipped list with a set it does not know, twice, or also in bySet")
    return problems


def committed_json_problems(text, directory, private, public, user):
    """What is wrong with one committed JSON under fidelity/<directory>/ (M1-R58, M1-R65), as messages that never
    quote a private name. Every file gets the privacy scan: no drive path, no user directory, no corpus/private path,
    no private file name, stem or directory name, no user name. A deckback.fidelity/1 file must also follow
    results.schema.json, name public decks or 12-hex ids only, and give a private deck's S1-S7 details as the fixed
    template of M1-R75 (counts only); an oracle sweep (deckback.oracle-sweep/1, /2 or /3) names its PDFs by bare file
    name, a /2 or /3 sweep also names the set of every PDF and has summary.bySet with a boolean gate per known set, and
    a /3 sweep has the Scene's result on every page, its counts in the summary and per set, and the sets it skipped;
    results/ and baselines/ hold nothing else (known/ lists carry no schema)."""
    problems = []
    data = json.loads(text)
    schema = data.get("schema") if isinstance(data, dict) else None
    public = set(public)
    if schema == FIDELITY_SCHEMA_ID:
        problems += [f"schema: {p}" for p in validate(data, SCHEMA)]
        decks = data.get("decks") if isinstance(data.get("decks"), list) else []
        public |= {record["id"] for record in decks if record.get("public")}
        for record in decks:
            if record.get("public"):
                if record.get("set") == "real":  # M8 tier B: named by its tier-B id only, never a file name
                    if not re.fullmatch(r"b-[0-9a-f]{10}", str(record.get("id"))):
                        problems.append("a real deck not named by its tier-B id")
                elif record.get("set") not in ("public", "atlas"):
                    problems.append("a public deck outside the public, atlas and real sets")
            elif not re.fullmatch(r"[0-9a-f]{12}", str(record.get("id"))):
                problems.append("a private deck without a 12-hex id")
            elif record.get("set") not in ("private", "tier-c"):
                problems.append("a private deck outside the private and tier-c sets")
        if any(not private_detail_ok(gate.get("detail")) for record in decks if not record.get("public")
               for slide in record.get("slides") or [] for gate in (slide.get("s") or {}).values()):
            problems.append(PRIVATE_DETAIL_PROBLEM)
    elif schema in SWEEP_SCHEMA_IDS:
        pdfs = data.get("pdfs")
        summary = data.get("summary")
        if not isinstance(pdfs, list) or not isinstance(summary, dict):
            problems.append("an oracle sweep without pdfs or summary")
        for record in pdfs if isinstance(pdfs, list) else []:
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*\.pdf", str(record.get("file"))):
                problems.append("an oracle sweep entry not named by a bare PDF file name")
        if schema == SWEEP_SCHEMA_ID_V2 and isinstance(pdfs, list) and isinstance(summary, dict):
            problems += sweep_v2_problems(pdfs, summary)
        if schema == SWEEP_SCHEMA_ID_V3 and isinstance(pdfs, list) and isinstance(summary, dict):
            problems += sweep_v3_problems(pdfs, summary)
    elif directory != "known":
        problems.append(f"unknown schema {schema!r} in fidelity/{directory}")
    if re.search(r"[A-Za-z]:[\\/]", text):
        problems.append("a drive path")
    if re.search(r"(?i)[\\/](users|home)[\\/]", text):
        problems.append("a user directory")
    if "corpus/private" in text or "corpus\\\\private" in text:
        problems.append("a corpus/private path")
    if leaked(text, private_names(private, public)):
        problems.append("a private file name, stem or directory name (not shown here)")
    if len(user) >= 4 and user.lower() not in {"runner", "root", "user", "admin"} and user in text:
        problems.append("the user name")
    return problems


def test_committed_results_cover_results_baselines_and_known():
    found = {path.parent.name for path in _committed_results()}
    assert found == set(COMMITTED_DIRS)
    assert REPO / "fidelity" / "known" / "oracle-known.json" in _committed_results()


def test_committed_json_checks_by_schema(tmp_path):
    private = tmp_path / "corpus" / "private"
    make_pdf(private / "clientDir" / "Quarterly-Plan.pdf", [RED])
    sweep = {"schema": SWEEP_SCHEMA_ID, "date": "2026-11-05", "tolerancePt": 0.05,
             "pdfs": [{"file": "atlas_std.pdf", "variant": "std", "pages": []}], "summary": {"pages": 0}}

    def check(data, directory="results"):
        return committed_json_problems(json.dumps(data), directory, private, public=(), user="someone")

    # An oracle sweep is not a fidelity results file: no results.schema.json, but the privacy scan.
    assert check(sweep) == []
    assert check({**sweep, "pdfs": [{"file": "out/atlas/atlas_std.pdf"}]}) == [
        "an oracle sweep entry not named by a bare PDF file name"]
    assert check({**sweep, "note": "C:\\x\\atlas_std.pdf"}) == ["a drive path"]
    assert check({**sweep, "note": "from Quarterly-Plan"}) == [
        "a private file name, stem or directory name (not shown here)"]
    assert check({**sweep, "note": "someone"}) == ["the user name"]
    # A known list has no schema; it gets the privacy scan only.
    assert check({"atlas_std.pdf#3": {"reason": "x", "kind": "diff"}}, "known") == []
    assert check({"clientDir#3": {"reason": "x", "kind": "diff"}}, "known") == [
        "a private file name, stem or directory name (not shown here)"]
    # results/ and baselines/ hold fidelity results or sweeps only; a fidelity file is still validated.
    assert check({"schema": "something/9"}) == ["unknown schema 'something/9' in fidelity/results"]
    assert check({"pdfs": []}, "baselines") == ["unknown schema None in fidelity/baselines"]
    assert any(p.startswith("schema: ") for p in check({"schema": FIDELITY_SCHEMA_ID}))


def test_committed_results_name_real_decks_by_tier_b_id_only(tmp_path):
    """M8: a tier-B deck (set real) is public but is named by its manifest id, never by a file name."""
    root = tmp_path / "repo"
    from harness.fidelity.test_real_set import tier_b
    tier_b(root, {"b-aaaaaaaaaa": ("powerpoint-windows", False)})
    out_json = tmp_path / "results.json"
    assert run.main(["--converter", "proto", "--decks", "real", "--out", str(out_json)], root=root,
                    out_root=tmp_path / "fid", tools=tools()) == 0
    text = out_json.read_text(encoding="utf-8")
    private = tmp_path / "corpus" / "private"
    assert committed_json_problems(text, "results", private, public=(), user="someone") == []
    renamed = text.replace("b-aaaaaaaaaa", "Quarterly-Plan")
    assert "a real deck not named by its tier-B id" in committed_json_problems(renamed, "results", private, (), "x")


def _sweep_v2(**changes):
    """An oracle sweep of schema /2 (M2 Task 1): every PDF names its set, and the summary has bySet."""
    totals = {"pages": 0, "ok": 0, "unsupported": 0, "diff": 0, "approxPaints": 0, "unsupportedOps": {},
              "diffKinds": {}}
    sweep = {"schema": "deckback.oracle-sweep/2", "date": "2026-11-09", "tolerancePt": 0.05,
             "pdfs": [{"file": "atlas_std.pdf", "set": "atlas", "variant": "std", "pages": []},
                      {"file": "atlas_std.pdf", "set": "atlas-win", "variant": "std", "pages": []},
                      {"file": "skia-gradients.pdf", "set": "producers", "variant": None, "pages": []}],
             "summary": {**totals, "bySet": {"atlas": {"gate": True, **totals}, "atlas-win": {"gate": True, **totals},
                                             "producers": {"gate": False, **totals}}}}
    return {**sweep, **changes}


_SCENE = {"ok": True, "elements": {"shape": 3, "textline": 2, "picture": 1, "fallback": 0, "hotspot": 0},
          "notes": [], "failed": None}
_SCENE_COUNTS = {"sceneOk": 0, "fallbacks": 0, "notes": 0, "failed": 0}


def _sweep_v3(**changes):
    """An oracle sweep of schema /3 (M2 Task 12): as /2, and every page has the Scene's result, which the summary and
    every set of bySet count."""
    v2 = _sweep_v2()
    page = {"index": 0, "ok": True, "diffCount": 0, "approxPaints": 0, "diffs": [], "unsupported": None,
            "scene": _SCENE}
    pdfs = [{**record, "pages": [page]} for record in v2["pdfs"]]
    summary = {**v2["summary"], **_SCENE_COUNTS,
               "bySet": {name: {**counts, **_SCENE_COUNTS} for name, counts in v2["summary"]["bySet"].items()},
               "skipped": []}
    return {**v2, "schema": "deckback.oracle-sweep/3", "pdfs": pdfs, "summary": summary, **changes}


def test_committed_json_accepts_oracle_sweep_schemas_1_2_and_3_and_scans_all(tmp_path):
    """Task 1: `npm run oracle:sweep` wrote deckback.oracle-sweep/2 (sets and bySet), and since Task 12 writes /3 (the
    Scene's result per page, ruling M2-R2); the committed 2026-11-05 file is /1. All three are accepted, and all get the
    same bare-file-name check and privacy scan."""
    private = tmp_path / "corpus" / "private"
    make_pdf(private / "clientDir" / "Quarterly-Plan.pdf", [RED])
    sweep1 = {"schema": "deckback.oracle-sweep/1", "date": "2026-11-05", "tolerancePt": 0.05,
              "pdfs": [{"file": "atlas_std.pdf", "variant": "std", "pages": []}], "summary": {"pages": 0}}

    def check(data, directory="results"):
        return committed_json_problems(json.dumps(data), directory, private, public=(), user="someone")

    assert SWEEP_SCHEMA_IDS == ("deckback.oracle-sweep/1", "deckback.oracle-sweep/2", "deckback.oracle-sweep/3")
    assert check(sweep1) == []
    assert check(_sweep_v2()) == []
    assert check(_sweep_v3()) == []
    for sweep in (sweep1, _sweep_v2(), _sweep_v3()):
        assert check({**sweep, "pdfs": [{"file": "out/atlas/atlas_std.pdf", "set": "atlas"}]}) == [
            "an oracle sweep entry not named by a bare PDF file name"]
        assert check({**sweep, "note": "C:\\x\\atlas_std.pdf"}) == ["a drive path"]
        assert check({**sweep, "note": "/home/x/atlas_std.pdf"}) == ["a user directory"]
        assert check({**sweep, "note": "from Quarterly-Plan"}) == [
            "a private file name, stem or directory name (not shown here)"]
        assert check({**sweep, "note": "someone"}) == ["the user name"]
    # a sweep of an unknown schema number is not accepted until a task adds it
    assert check(_sweep_v2(schema="deckback.oracle-sweep/9")) == [
        "unknown schema 'deckback.oracle-sweep/9' in fidelity/results"]


def test_a_v2_sweep_names_a_known_set_for_every_pdf_and_has_bySet():
    private = Path("does-not-exist")

    def check(data):
        return committed_json_problems(json.dumps(data), "results", private, public=(), user="someone")

    bad_pdf = {"file": "atlas_std.pdf", "variant": "std", "pages": []}
    assert check(_sweep_v2(pdfs=[bad_pdf])) == ["an oracle sweep (/2) entry without a known set"]
    assert check(_sweep_v2(pdfs=[{**bad_pdf, "set": "private"}])) == [
        "an oracle sweep (/2) entry without a known set"]
    summary = _sweep_v2()["summary"]
    assert check(_sweep_v2(summary={k: v for k, v in summary.items() if k != "bySet"})) == [
        "an oracle sweep (/2) without summary.bySet"]
    assert check(_sweep_v2(summary={**summary, "bySet": {"private": summary["bySet"]["atlas"]}})) == [
        "an oracle sweep (/2) names a set it does not know in summary.bySet"]
    # a set with no gate flag cannot be read as a gate or as no gate
    no_flag = {"atlas": {k: v for k, v in summary["bySet"]["atlas"].items() if k != "gate"}}
    assert check(_sweep_v2(summary={**summary, "bySet": no_flag})) == [
        "an oracle sweep (/2) set summary without a boolean gate"]


def test_a_v3_sweep_has_the_scene_result_on_every_page_and_counts_it():
    """M2 Task 12 (ruling M2-R2): a /3 sweep is checked as /2, and every page has `scene` with ok, the element counts
    of the five kinds, the notes as strings and failed; the summary and each set count sceneOk, fallbacks, notes and
    failed."""
    private = Path("does-not-exist")

    def check(data):
        return committed_json_problems(json.dumps(data), "results", private, public=(), user="someone")

    sweep = _sweep_v3()
    assert check(sweep) == []
    # a page extractScene threw on, and a page with a fallback and its note, are well formed
    threw = {"ok": False, "elements": dict.fromkeys(_SCENE["elements"], 0),
             "notes": ["extractScene threw (TypeError)"], "failed": "threw"}
    noted = {**_SCENE, "ok": False, "elements": {**_SCENE["elements"], "fallback": 1},
             "notes": ["setCharWidth (operator the walker does not model)"]}

    def with_scene(scene):
        page = {**sweep["pdfs"][0]["pages"][0], "scene": scene}
        return _sweep_v3(pdfs=[{**sweep["pdfs"][0], "pages": [page]}, *sweep["pdfs"][1:]])

    assert check(with_scene(threw)) == []
    assert check(with_scene(noted)) == []
    bad_page = ["an oracle sweep (/3) page without a well-formed scene result"]
    page = {k: v for k, v in sweep["pdfs"][0]["pages"][0].items() if k != "scene"}
    assert check(_sweep_v3(pdfs=[{**sweep["pdfs"][0], "pages": [page]}])) == bad_page
    for scene in ({**_SCENE, "ok": "yes"}, {**_SCENE, "elements": {"shape": 1}},
                  {**_SCENE, "elements": {**_SCENE["elements"], "shape": -1}},
                  {**_SCENE, "elements": {**_SCENE["elements"], "shape": True}},
                  {**_SCENE, "notes": "setCharWidth"}, {**_SCENE, "notes": [3]}, {**_SCENE, "failed": 1},
                  {**_SCENE, "extra": 1}, {k: v for k, v in _SCENE.items() if k != "failed"}):
        assert check(with_scene(scene)) == bad_page, scene
    bad_counts = ["an oracle sweep (/3) summary without the scene counts"]
    summary = sweep["summary"]
    assert check(_sweep_v3(summary={k: v for k, v in summary.items() if k != "sceneOk"})) == bad_counts
    producers = summary["bySet"]["producers"]
    no_notes = {**summary["bySet"], "producers": {k: v for k, v in producers.items() if k != "notes"}}
    assert check(_sweep_v3(summary={**summary, "bySet": no_notes})) == bad_counts
    assert check(_sweep_v3(summary={**summary, "fallbacks": 1.5})) == bad_counts
    # what /2 asks still holds
    assert check(_sweep_v3(pdfs=[{**sweep["pdfs"][0], "set": "private"}])) == [
        "an oracle sweep (/2) entry without a known set"]
    # a /2 file is not asked for the scene result
    assert check(_sweep_v2()) == []


def test_a_v3_sweep_lists_the_sets_it_skipped():
    """M2 Task 13: a /3 sweep names the sets it did not sweep (their directory was missing or empty) in summary.skipped,
    so a gate set that was not swept is visible in the record, not only absent from bySet."""
    private = Path("does-not-exist")

    def check(data):
        return committed_json_problems(json.dumps(data), "results", private, public=(), user="someone")

    sweep = _sweep_v3()
    summary = sweep["summary"]
    assert summary["skipped"] == [] and check(sweep) == []
    no_producers = {name: counts for name, counts in summary["bySet"].items() if name != "producers"}
    assert check(_sweep_v3(pdfs=sweep["pdfs"][:2],
                           summary={**summary, "bySet": no_producers, "skipped": ["producers"]})) == []
    missing = ["an oracle sweep (/3) without summary.skipped, the sets it did not sweep"]
    assert check(_sweep_v3(summary={k: v for k, v in summary.items() if k != "skipped"})) == missing
    assert check(_sweep_v3(summary={**summary, "skipped": "producers"})) == missing
    assert check(_sweep_v3(summary={**summary, "skipped": [1]})) == missing
    bad = ["an oracle sweep (/3) skipped list with a set it does not know, twice, or also in bySet"]
    assert check(_sweep_v3(summary={**summary, "skipped": ["private"]})) == bad
    assert check(_sweep_v3(summary={**summary, "bySet": no_producers, "skipped": ["producers", "producers"]})) == bad
    assert check(_sweep_v3(summary={**summary, "skipped": ["atlas-win"]})) == bad
    # a /2 file is not asked for it
    assert check(_sweep_v2()) == []


def test_sweep_sets_and_scene_kinds_match_the_typescript_lists():
    """SWEEP_SETS and SCENE_KINDS here repeat SWEEP_SETS of packages/core/test/helpers/sweep.ts and ELEMENT_KINDS of
    packages/core/test/helpers/oracle.ts: read from the sources, they must be the same lists in the same order."""
    helpers = REPO / "packages" / "core" / "test" / "helpers"
    sweep_ts = (helpers / "sweep.ts").read_text(encoding="utf-8")
    block = re.search(r"export const SWEEP_SETS: readonly SweepSet\[\] = \[(.*?)\];", sweep_ts, re.DOTALL)
    assert block, "SWEEP_SETS not found in sweep.ts"
    entries = re.findall(r"\{ name: '([^']+)', dir: '([^']+)', gate: (true|false) \}", block.group(1))
    assert len(entries) == block.group(1).count("{"), "an entry of SWEEP_SETS this test cannot read"
    assert tuple(name for name, _, _ in entries) == SWEEP_SETS
    oracle_ts = (helpers / "oracle.ts").read_text(encoding="utf-8")
    kinds = re.search(r"export const ELEMENT_KINDS = \[([^\]]*)\] as const;", oracle_ts)
    assert kinds, "ELEMENT_KINDS not found in oracle.ts"
    assert tuple(re.findall(r"'([^']+)'", kinds.group(1))) == SCENE_KINDS


def test_committed_check_requires_private_details_to_be_templates(tmp_path):
    """M1-R75 (F8): in a committed fidelity file a private deck's S1-S7 details are the fixed template (status, the
    checks' own count names and numbers); anything else, a font name for one, is a problem."""
    root = tmp_path / "repo"
    make_pdf(root / "corpus" / "private" / "x" / "p.pdf", [GREEN])
    results = measure(root, tmp_path / "fid", tools(), sets=("private",))
    private = tmp_path / "none"

    def check(data):
        return committed_json_problems(json.dumps(data), "results", private, public=(), user="someone")

    assert check(results) == []
    gates = results["decks"][0]["slides"][0]["s"]
    assert all(run.PRIVATE_DETAIL.match(gate["detail"]) for gate in gates.values())
    for bad in ("fail; typeface is not the family name: AcmeSans", "fail; acme sans 3; details withheld (private deck)",
                "fail; mismatches 3 AcmeSans; details withheld (private deck)"):
        changed = json.loads(json.dumps(results))
        changed["decks"][0]["slides"][0]["s"]["S6"]["detail"] = bad
        assert check(changed) == [PRIVATE_DETAIL_PROBLEM], bad


@pytest.mark.parametrize("path", _committed_results(), ids=lambda p: f"{p.parent.name}/{p.name}")
def test_committed_results_name_public_decks_only(path):
    """Every committed file, the M1 baseline included (regenerated with the M1-R75 template by the final fix wave),
    has no problem at all: no exemption list."""
    import getpass
    problems = committed_json_problems(path.read_text(encoding="utf-8"), path.parent.name,
                                       REPO / "corpus" / "private", public_names(), getpass.getuser())
    assert problems == []


# ---- the deckback converter (M3 task 10) ------------------------------------------------------------------------


def test_deckback_converter_argv():
    """`--converter deckback` runs the CLI bundle with node; `proto` stays the baseline module under Python."""
    assert sorted(run.CONVERTERS) == ["deckback", "proto"]
    assert run.converter_argv("proto") == [sys.executable, "-m", "harness.baseline.proto"]
    assert run.converter_argv("deckback") == ["node", str(REPO / "packages" / "cli" / "dist" / "deckback.mjs")]
    default = run.default_tools("deckback")
    assert default.convert.argv == run.converter_argv("deckback")


def test_missing_bundle_is_a_failed_step(tmp_path):
    """A converter whose bundle is not built is a failed convert step (exit code 3, reason converter-missing), not a
    crash, and the run goes on; no path reaches the log."""
    missing = tmp_path / "nowhere" / "deckback.mjs"
    converter = run.SubprocessConverter(["node", str(missing)], required=missing)
    result = converter(tmp_path / "in.pdf", tmp_path / "out" / "o.pptx")
    assert (result.code, result.reason) == (run.ERROR, "converter-missing")
    assert str(tmp_path) not in result.log
    assert not (tmp_path / "out" / "convert").exists()
    root = public_tree(tmp_path / "repo")
    results = measure(root, tmp_path / "fid", tools(converter=converter))
    for d in results["decks"]:
        assert (d["exitCodes"]["convert"], d["reasons"]["convert"]) == (3, "converter-missing")
        assert d["exitCodes"]["render"] is None and d["convert"] is None
    assert validate(results, SCHEMA) == []


def test_the_counts_the_deckback_cli_prints_reach_the_results(tmp_path):
    """The CLI's stdout line (the baseline's four counts and the report's others) lands in `convert`, and the schema
    allows every key; a key that is no count is dropped."""
    root = public_tree(tmp_path / "repo", names=("deck1",))
    template = make_pptx(tmp_path / "template.pptx", 1)
    code = ("import shutil, sys\n"
            f"shutil.copy({str(template)!r}, sys.argv[3])\n"
            "print('{\"pages\": 1, \"shapes\": 5, \"textBoxes\": 1, \"pictures\": 1, \"freeforms\": 1, \"rects\": 1, "
            "\"lines\": 1, \"gradients\": 1, \"hotspots\": 0, \"fallbacks\": 2, \"other\": 9}')\n")
    results = measure(root, tmp_path / "fid", tools(converter=run.SubprocessConverter([sys.executable, "-c", code])))
    convert = deck(results, "deck1")["convert"]
    assert {k: v for k, v in convert.items() if k != "seconds"} == {
        "pages": 1, "shapes": 5, "textBoxes": 1, "pictures": 1, "freeforms": 1, "rects": 1, "lines": 1, "gradients": 1,
        "hotspots": 0, "fallbacks": 2}
    assert validate(results, SCHEMA) == []


# ---- M5 Task 1: S7 per page, V1's noise floor -----------------------------------------------------------------------


def paged_s7(failed):
    def s7(out_pptx, in_pdf):
        return {"status": "fail", "detail": "the composition differs",
                "pages": {n: f"paints fill 1 vs 2 (page {n})" for n in failed}}
    return s7


def test_one_pages_s7_failure_fails_only_that_slide(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"))
    results = measure(root, tmp_path / "fid", tools(s7=paged_s7([2])))
    first, second = deck(results, "deck2")["slides"]
    assert first["s"]["S7"]["status"] == "pass" and "page 1" in first["s"]["S7"]["detail"]
    assert second["s"]["S7"]["status"] == "fail" and "page 2" in second["s"]["S7"]["detail"] and second["pass"] is False
    assert results["summary"]["byGate"]["S7"]["fail"] == 1
    summary = deck(results, "deck2")["s7"]  # the deck's own verdict stays
    assert summary["status"] == "fail" and summary["failedPages"] == [2]
    assert not validate(results, json.loads(run.SCHEMA_PATH.read_text(encoding="utf-8")))
    # the progress line gives the deck's verdict, not its first slide's (which passes here)
    progress = (tmp_path / "fid" / "run.log").read_text(encoding="utf-8")
    assert "deck2 std: input 0 (ok)" in progress and "S7 fail (pages 2); 2 slides" in progress, progress


def test_s7_pages_are_the_variants_own_pages_with_a_hidden_slide(tmp_path):
    """M5 Task 1 review (Minor 3): the round trip names pages of the variant's PDF, so S7's page N is slide index N - 1
    of that variant (`variant_slides`, M1-R72), never the source slide N. With slide 2 of 3 hidden, std's page 2 is
    source slide 3 and the hidden variant's page 2 is slide 2."""
    root = tmp_path / "repo"
    generated = root / "corpus" / "generated"
    std = make_pdf(generated / "deck_std.pdf", [RED, BLUE])
    make_magenta_page_pdf(generated / "deck_hidden.pdf", [RED, None, BLUE], magenta_pages=(2,))
    make_pptx(generated / "deck.pptx", 3, pdf=std, hidden=(2,))
    write_manifest(generated / "deck.manifest.json", [
        {"n": 1, "id": "deck/a/01", "features": [], "hidden": False, "knownBitmapText": False},
        {"n": 2, "id": "deck/a/02", "features": [], "hidden": True, "knownBitmapText": False},
        {"n": 3, "id": "deck/a/03", "features": [], "hidden": False, "knownBitmapText": False},
    ])
    results = measure(root, tmp_path / "fid", tools(s7=paged_s7([2])), variants=("std", "hidden"))
    std_slides = deck(results, "deck", "std")["slides"]
    assert [(s["label"], s["s"]["S7"]["status"]) for s in std_slides] == [("deck/a/01", "pass"), ("deck/a/03", "fail")]
    assert "page 2" in std_slides[1]["s"]["S7"]["detail"]
    hidden = deck(results, "deck", "hidden")["slides"]
    assert [(s["label"], s["s"]["S7"]["status"]) for s in hidden] == [
        ("deck/a/01", "pass"), ("deck/a/02", "fail"), ("deck/a/03", "pass")]
    assert deck(results, "deck", "std")["s7"]["failedPages"] == deck(results, "deck", "hidden")["s7"]["failedPages"] \
        == [2]


def test_a_deck_whose_round_trip_failed_as_a_whole_fails_every_slide(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"))
    whole = lambda out, pdf: {"status": "fail", "detail": "PowerPoint could not open the deck"}
    results = measure(root, tmp_path / "fid", tools(s7=whole))
    assert [s["s"]["S7"]["status"] for s in deck(results, "deck2")["slides"]] == ["fail", "fail"]
    assert "failedPages" not in deck(results, "deck2")["s7"]


def test_a_passing_deck_passes_every_slide(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"))
    results = measure(root, tmp_path / "fid", tools())
    assert [s["s"]["S7"]["status"] for s in deck(results, "deck2")["slides"]] == ["pass", "pass"]
    assert deck(results, "deck2")["s7"]["status"] == "pass"


def test_v1_records_its_noise_floor_and_the_summary_lists_the_exempt_slides(tmp_path, monkeypatch):
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"), source=True)
    results = measure(root, tmp_path / "fid", tools())
    for slide in deck(results, "deck2")["slides"]:
        assert slide["v1"]["noiseExempt"] is False and slide["v1"]["noiseFloor"] == slide["noise"]["residual5"]
    assert results["summary"]["v1NoiseExempt"] == []
    monkeypatch.setattr(metrics, "V1_NOISE_EXEMPT_RESIDUAL", -1)  # every noise record is now over the limit
    results = measure(root, tmp_path / "fid", tools())
    slides = deck(results, "deck2")["slides"]
    assert all(s["v1"]["noiseExempt"] is True and s["v1"]["pass"] is s["v2"]["pass"] for s in slides)
    assert results["summary"]["v1NoiseExempt"][-1] == {"id": "deck2", "set": "public", "variant": "std",
                                                       "slides": [1, 2]}
    assert not validate(results, json.loads(run.SCHEMA_PATH.read_text(encoding="utf-8")))


def test_the_dashboard_shows_the_decks_s7_and_the_noise_exempt_slides(tmp_path, monkeypatch):
    """M5 Task 1 review (Minor 2): the deck's own S7 verdict with its failed pages, the slides whose V1 is judged by
    V2 (summary.v1NoiseExempt, M5-R1), and a mark on each such V1 cell."""
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"), source=True)
    results = measure(root, tmp_path / "fid", tools(s7=paged_s7([2])))
    html = dashboard.render_html(results)
    assert "S7 (round trip): fail; failed pages 2" in html
    assert "V1 judged by V2 (noise record over 400 px, M5-R1): none" in html
    assert "exempt" not in html.split("<h2>")[-1]  # no V1 cell marked
    monkeypatch.setattr(metrics, "V1_NOISE_EXEMPT_RESIDUAL", -1)
    results = measure(root, tmp_path / "fid", tools())
    html = dashboard.render_html(results)
    assert "S7 (round trip): pass" in html
    assert "deck2 · std (public): slides 1, 2" in html
    v1_cells = re.findall(r'<td class="\w+" title="[^"]*judged by V2[^"]*">([^<]*)</td>', html)
    assert len(v1_cells) == 3 and set(v1_cells) <= {"✓ exempt", "✗ exempt"}, v1_cells


def test_rescore_applies_the_two_rules_to_recorded_renders(tmp_path):
    """M5 Task 1: results re-scored from the renders and a round trip that are on disk, no PowerPoint."""
    from harness.fidelity import rescore
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"), source=True)
    out_root = tmp_path / "fid"
    old = measure(root, out_root, tools(s7=lambda out, pdf: {"status": "fail", "detail": "whole"}))
    assert [s["s"]["S7"]["status"] for s in deck(old, "deck2")["slides"]] == ["fail", "fail"]
    trips = {("deck2", "std"): {"status": "fail", "detail": "page 2 differs", "pages": {2: "text differs"}}}
    new = rescore.rescore(old, found=decks.discover(root, ("public",), ("std",)), s7=trips)
    first, second = deck(new, "deck2")["slides"]
    assert first["s"]["S7"]["status"] == "pass" and second["s"]["S7"]["status"] == "fail"
    assert deck(new, "deck2")["s7"]["failedPages"] == [2]
    assert [s["s"]["S7"]["status"] for s in deck(new, "deck1")["slides"]] == ["fail"]  # not re-run: as recorded
    assert first["v1"]["noiseExempt"] is False
    assert new["summary"]["byGate"]["S7"] == {"pass": 1, "fail": 2, "na": 0}
    assert not validate(new, json.loads(run.SCHEMA_PATH.read_text(encoding="utf-8")))


def test_a_recorded_round_trips_long_detail_is_capped_in_the_deck_record():
    long = {"status": "fail", "detail": "z" * 900, "pages": {1: "y" * 900}}
    assert len(run.deck_s7_record(long)["detail"]) <= 300
    assert len(run.slide_s7(long, 1)["detail"]) <= 300 and len(run.slide_s7(long, 2)["detail"]) <= 300


# ---- M5 Task 1 fix round 2 (ruling M5-R3): rescore provenance and loud failures -------------------------------------


def _rescore_inputs(tmp_path):
    root = public_tree(tmp_path / "repo", names=("deck1", "deck2"), source=True)
    old = measure(root, tmp_path / "fid", tools(s7=lambda out, pdf: {"status": "fail", "detail": "whole"}))
    results = root / "fidelity" / "results" / "old.json"
    results.parent.mkdir(parents=True)
    results.write_text(json.dumps(old), encoding="utf-8")
    side = root / "fidelity" / "results" / "s7.json"
    side.write_text(json.dumps({"date": "2026-11-17", "decks": {"deck2": {"std": {
        "status": "fail", "detail": "page 2 differs", "pages": {"2": "text differs"}}}}}), encoding="utf-8")
    return root, results, side


def test_rescore_main_records_where_its_inputs_came_from(tmp_path):
    from harness.fidelity import rescore
    root, results, side = _rescore_inputs(tmp_path)
    out = root / "fidelity" / "results" / "new.json"
    code = rescore.main([str(results), str(side), "--out", str(out), "--root", str(root), "--date", "2026-11-18"])
    assert code == 0
    new = json.loads(out.read_text(encoding="utf-8"))
    provenance = new["options"]["rescore"]
    assert provenance["source"] == {"path": "fidelity/results/old.json",
                                    "sha256": hashlib.sha256(results.read_bytes()).hexdigest()}
    assert provenance["s7"] == {"path": "fidelity/results/s7.json", "date": "2026-11-17",
                                "sha256": hashlib.sha256(side.read_bytes()).hexdigest()}
    assert provenance["converterCommit"] is None and "does not record" in provenance["note"]
    assert str(tmp_path) not in out.read_text(encoding="utf-8")
    assert new["summary"]["s7DeckWide"] == [{"id": "deck1", "set": "public", "variant": "std"}]
    assert not validate(new, json.loads(run.SCHEMA_PATH.read_text(encoding="utf-8")))


def test_rescore_main_writes_nothing_on_a_schema_problem(tmp_path, monkeypatch, capsys):
    from harness.fidelity import rescore
    root, results, side = _rescore_inputs(tmp_path)
    out = root / "fidelity" / "results" / "new.json"
    real = rescore.rescore

    def broken(*args, **kwargs):
        new = real(*args, **kwargs)
        new["summary"]["slides"] = "many"
        return new
    monkeypatch.setattr(rescore, "rescore", broken)
    code = rescore.main([str(results), str(side), "--out", str(out), "--root", str(root)])
    assert code != 0 and not out.exists()
    assert "slides" in capsys.readouterr().err  # the problems are printed


def test_rescore_rejects_an_s7_key_that_matches_no_deck(tmp_path):
    from harness.fidelity import rescore
    root, results, side = _rescore_inputs(tmp_path)
    side.write_text(json.dumps({"date": "2026-11-17", "decks": {"deck2": {"notags": {"status": "pass", "detail": ""}}}}),
                    encoding="utf-8")
    out = root / "fidelity" / "results" / "new.json"
    code = rescore.main([str(results), str(side), "--out", str(out), "--root", str(root)])
    assert code != 0 and not out.exists()
    old = json.loads(results.read_text(encoding="utf-8"))
    with pytest.raises(ValueError, match="deck2"):
        rescore.rescore(old, found=decks.discover(root, ("public",), ("std",)),
                        s7={("deck2", "notags"): {"status": "pass", "detail": ""}})


def test_judge_v1_is_idempotent():
    raw = {"raw_px32": 0.1, "px32_shift1": 0.02, "residual3": 900, "residual3Lines": 800, "pass": False}
    once = run.judge_v1(raw, {"pass": True}, {"residual5": 512, "pass": True})
    assert run.judge_v1(once, {"pass": True}, {"residual5": 512, "pass": True}) == once
    back = run.judge_v1(once, {"pass": True}, {"residual5": 20, "pass": True})  # no longer exempt: measured status back
    assert back["pass"] is False and back["noiseExempt"] is False and "passMeasured" not in back
