"""Tests for harness/atlas/publish.py without PowerPoint: a fake exporter writes PDFs (blank pages, padded to a size
that follows the slide count) and, for the probe, a gt/ folder, as export.export() would."""

import hashlib
import json
import os
from pathlib import Path

import pymupdf
import pytest
from PIL import Image

from harness.atlas import decks, export, fallback_pdfs, publish

PER_SLIDE_BYTES = 60_000
NO_CHECK = lambda root: []  # noqa: E731  (the fake PDFs have no fonts, so the real checks would reject them)
PUBLISHED = sorted(["probe.pptx", "probe_std.pdf", "probe_notags.pdf", "probe.manifest.json", "probe_gt/map.json",
                    "probe_gt/slide1.png", "probe_gt/slide2.png", "probe_gt/slide3.png", "atlas-smoke.pptx",
                    "atlas-smoke_std.pdf", "atlas-smoke_notags.pdf", "atlas-smoke.manifest.json",
                    "probe.export.json", "atlas-smoke.export.json", *fallback_pdfs.pdfs()])


def smoke_ids():
    deck = decks.build_deck(decks.RECIPES["atlas-smoke"]("ofl")[0], "ofl")
    return [entry["id"] for entry in deck.manifest()["slides"]]


class FakeExport:
    """An export() stand-in that counts its calls. <stem>_<variant>.pdf has one blank page per slide plus `pad` bytes of
    junk per slide behind its %%EOF (so a size test can make it big), and with ground_truth a gt/<stem>/ folder; the
    export stamp <stem>.export.json is written as export() writes it (ruling M1-R77)."""

    def __init__(self, fail=None, pad=PER_SLIDE_BYTES):
        self.fail, self.pad, self.calls = fail, pad, []

    def __call__(self, pptx, out_dir, variants, ground_truth):
        stem = Path(pptx).stem
        self.calls.append(stem)
        slides = export.slide_count(pptx)
        record = {}
        for variant in variants:
            doc = pymupdf.open()
            for _ in range(slides):
                doc.new_page()
            pdf = Path(out_dir) / f"{stem}_{variant}.pdf"
            doc.save(pdf)
            doc.close()
            with open(pdf, "ab") as handle:
                handle.write(b"\n%" + b"x" * self.pad * slides)
            record[variant] = {"ok": variant != self.fail, "exitCode": 0, "pages": slides, "reason": "fake failure"}
        export.write_stamp(pptx, out_dir, variants, [v for v in variants if record[v]["ok"]], None,
                           version_known=True)
        result = {"variants": record, "scriptExitCode": 0, "stderr": ""}
        if ground_truth:
            gt = Path(out_dir) / "gt" / stem
            gt.mkdir(parents=True)
            for n in range(1, slides + 1):
                Image.new("RGB", (8, 8)).save(gt / f"slide{n}.png")
            (gt / "map.json").write_text(json.dumps({"slides": slides}), encoding="utf-8")
            result["groundTruth"] = {"ok": True, "slides": slides}
        return result


def listing(root):
    return sorted(p.relative_to(root).as_posix() for p in Path(root).rglob("*") if p.is_file())


def snapshot(root):
    """{path: (bytes, mtime_ns)} of every file under root."""
    return {rel: ((Path(root) / rel).read_bytes(), (Path(root) / rel).stat().st_mtime_ns) for rel in listing(root)}


# --- fit_smoke --------------------------------------------------------------------------------------------------------


def test_fit_smoke_keeps_every_smoke_slide_when_the_files_fit(tmp_path):
    manifest, dropped = publish.fit_smoke(tmp_path, FakeExport(), fixed_bytes=0)
    assert dropped == [] and [e["id"] for e in manifest["slides"]] == smoke_ids()


def test_fit_smoke_drops_slides_from_the_end_until_every_file_fits(tmp_path):
    limit = 25 * PER_SLIDE_BYTES + 10_000  # room for 25 slides of PDF (the .pptx is smaller)
    manifest, dropped = publish.fit_smoke(tmp_path, FakeExport(), fixed_bytes=0, max_file=limit, min_slides=10)
    kept = [entry["id"] for entry in manifest["slides"]]
    full = smoke_ids()
    assert kept == full[:len(kept)] and dropped == full[len(kept):]  # the tail went, in manifest order
    assert len(kept) == 25  # as many as fit: 26 slides would be over the limit
    assert max(p.stat().st_size for p in tmp_path.glob("atlas-smoke*")) <= limit


def test_fit_smoke_counts_the_total(tmp_path):
    # two PDFs plus the .pptx plus 1 MB already published are over 4 MB long before one PDF reaches 3 MiB
    manifest, dropped = publish.fit_smoke(tmp_path, FakeExport(), fixed_bytes=1_000_000, max_total=4_000_000,
                                          min_slides=10, reserve_bytes=0)
    total = 1_000_000 + sum(p.stat().st_size for p in tmp_path.glob("atlas-smoke*") if p.suffix != ".json")
    assert total <= 4_000_000 and dropped


def test_fit_smoke_refuses_to_go_below_the_minimum(tmp_path):
    with pytest.raises(publish.PublishError, match="at least 30"):
        publish.fit_smoke(tmp_path, FakeExport(), fixed_bytes=0, max_file=500_000)


def test_a_failed_export_stops_the_publish(tmp_path):
    with pytest.raises(publish.PublishError, match="notags.*fake failure"):
        publish.fit_smoke(tmp_path, FakeExport(fail="notags"), fixed_bytes=0)


# --- publish: replacing the corpus ------------------------------------------------------------------------------------


def test_publish_replaces_the_corpus_but_keeps_the_readme(tmp_path):
    corpus = tmp_path / "generated"
    (corpus / "old_gt").mkdir(parents=True)
    (corpus / "old_gt" / "slide9.png").write_bytes(b"stale")
    (corpus / "stale.pdf").write_bytes(b"stale")
    (corpus / "README.md").write_text("kept as it is\n", encoding="utf-8")

    manifest = publish.publish(corpus, tmp_path / "work", FakeExport(pad=0), check=NO_CHECK)
    assert (corpus / "README.md").read_text(encoding="utf-8") == "kept as it is\n"
    assert listing(corpus) == sorted([*PUBLISHED, "README.md", "manifest.json"])
    assert json.loads((corpus / "manifest.json").read_text(encoding="utf-8")) == manifest
    assert [entry["path"] for entry in manifest["files"]] == PUBLISHED
    assert manifest["fonts"] == [] and manifest["dropped"] == []  # blank pages embed no font
    by_path = {entry["path"]: entry for entry in manifest["files"]}
    assert by_path["probe_std.pdf"]["pages"] == 3 and by_path["atlas-smoke_notags.pdf"]["pages"] == len(smoke_ids())
    assert by_path["probe.pptx"]["pages"] is None
    for entry in manifest["files"]:
        data = (corpus / entry["path"]).read_bytes()
        assert entry["sha256"] == hashlib.sha256(data).hexdigest() and entry["bytes"] == len(data)


def test_publish_stops_before_touching_the_corpus_when_an_export_fails(tmp_path):
    corpus = tmp_path / "generated"
    corpus.mkdir()
    (corpus / "probe_std.pdf").write_bytes(b"the committed one")
    with pytest.raises(publish.PublishError):
        publish.publish(corpus, tmp_path / "work", FakeExport(fail="std", pad=0), check=NO_CHECK)
    assert (corpus / "probe_std.pdf").read_bytes() == b"the committed one"


def test_publish_only_clears_a_directory_called_generated(tmp_path):
    other = tmp_path / "documents"
    other.mkdir()
    (other / "precious.txt").write_text("keep", encoding="utf-8")
    with pytest.raises(publish.PublishError, match="generated"):
        publish.publish(other, tmp_path / "work", FakeExport(pad=0), check=NO_CHECK)
    assert (other / "precious.txt").read_text(encoding="utf-8") == "keep"


# --- the gate: nothing is installed that fails the checks -------------------------------------------------------------


def test_publish_runs_the_real_checks_on_the_staged_files_before_installing(tmp_path):
    corpus = tmp_path / "generated"
    corpus.mkdir()
    (corpus / "probe_std.pdf").write_bytes(b"the committed one")
    with pytest.raises(publish.PublishError) as raised:  # the fake PDFs embed no font and have PowerPoint's metadata
        publish.publish(corpus, tmp_path / "work", FakeExport(pad=0))
    message = str(raised.value)
    assert "probe_std.pdf" in message and "embeds no font" in message and "nothing was installed" in message
    assert listing(corpus) == ["probe_std.pdf"]  # nothing installed, nothing deleted
    assert (corpus / "probe_std.pdf").read_bytes() == b"the committed one"


def test_the_check_sees_the_staged_corpus_in_its_final_layout(tmp_path):
    seen = {}

    def check(root):
        seen["files"] = listing(root)
        return []

    publish.publish(tmp_path / "generated", tmp_path / "work", FakeExport(pad=0), check=check)
    assert seen["files"] == sorted([*PUBLISHED, "manifest.json"])


# --- M1-R30: committed PDFs and PNGs are not rewritten when the deck did not change -----------------------------------


def published(tmp_path, **kwargs):
    corpus = tmp_path / "generated"
    fake = FakeExport(pad=0)
    publish.publish(corpus, tmp_path / "work1", fake, check=NO_CHECK, **kwargs)
    return corpus, fake


def test_an_unchanged_deck_is_not_exported_or_rewritten(tmp_path):
    corpus, first = published(tmp_path)
    assert first.calls == ["probe", "atlas-smoke"]
    before = snapshot(corpus)

    second = FakeExport(pad=0)
    publish.publish(corpus, tmp_path / "work2", second, check=NO_CHECK)
    assert second.calls == []  # PowerPoint was not touched
    assert snapshot(corpus) == before  # same bytes and not even rewritten (mtimes)


def test_force_exports_again(tmp_path):
    corpus, _ = published(tmp_path)
    forced = FakeExport(pad=0)
    publish.publish(corpus, tmp_path / "work2", forced, check=NO_CHECK, force=True)
    assert forced.calls == ["probe", "atlas-smoke"]


def test_only_the_changed_deck_is_exported(tmp_path):
    corpus, _ = published(tmp_path)
    before = snapshot(corpus)
    (corpus / "probe.pptx").write_bytes(b"an older version of the deck")

    second = FakeExport(pad=0)
    publish.publish(corpus, tmp_path / "work2", second, check=NO_CHECK)
    assert second.calls == ["probe"]
    after = snapshot(corpus)
    for path in before:
        if path.startswith("atlas-smoke"):
            assert after[path] == before[path], path  # the smoke deck's files were left alone
    assert after["probe.pptx"][0] == before["probe.pptx"][0]  # the deck is rebuilt


def test_a_deck_with_a_missing_companion_is_exported_again(tmp_path):
    corpus, _ = published(tmp_path)
    (corpus / "probe_gt" / "slide2.png").unlink()
    second = FakeExport(pad=0)
    publish.publish(corpus, tmp_path / "work2", second, check=NO_CHECK)
    assert second.calls == ["probe"] and (corpus / "probe_gt" / "slide2.png").is_file()


def test_a_changed_manifest_is_exported_again(tmp_path):
    """M1-R77: the committed PDFs are reused only with the manifest they were exported with; a manifest that changes
    while the deck does not (a feature declared) means a new export and a new stamp."""
    corpus, _ = published(tmp_path)
    # the committed corpus is consistent (its stamp records this manifest), but the code now builds another one
    (corpus / "atlas-smoke.manifest.json").write_text('{"slides": []}', encoding="utf-8")
    export.write_stamp(corpus / "atlas-smoke.pptx", corpus, [], [], None, version_known=True)
    assert export.stamp_problem(corpus / "atlas-smoke_std.pdf", "std", corpus / "atlas-smoke.pptx",
                                corpus / "atlas-smoke.manifest.json") is not None
    for variant in publish.VARIANTS:
        export.write_stamp(corpus / "atlas-smoke.pptx", corpus, [variant], [variant], None, version_known=True)
    second = FakeExport(pad=0)
    publish.publish(corpus, tmp_path / "work2", second, check=NO_CHECK)
    assert second.calls == ["atlas-smoke"]
    for variant in publish.VARIANTS:
        assert export.stamp_problem(corpus / f"atlas-smoke_{variant}.pdf", variant, corpus / "atlas-smoke.pptx",
                                    corpus / "atlas-smoke.manifest.json") is None


def test_a_pdf_its_stamp_does_not_record_is_exported_again(tmp_path):
    corpus, _ = published(tmp_path)
    (corpus / "probe_notags.pdf").write_bytes((corpus / "probe_notags.pdf").read_bytes() + b"\n% another export")
    second = FakeExport(pad=0)
    publish.publish(corpus, tmp_path / "work2", second, check=NO_CHECK)
    assert second.calls == ["probe"]
    assert export.stamp_problem(corpus / "probe_notags.pdf", "notags", corpus / "probe.pptx",
                                corpus / "probe.manifest.json") is None


def test_unchanged_is_decided_with_the_slides_dropped_last_time(tmp_path):
    limits = {"max_file": 25 * PER_SLIDE_BYTES + 10_000, "min_slides": 10}
    corpus = tmp_path / "generated"
    first = FakeExport()
    manifest = publish.publish(corpus, tmp_path / "work1", first, check=NO_CHECK, **limits)
    assert manifest["dropped"] and first.calls.count("atlas-smoke") > 1  # the fit loop exported more than once

    second = FakeExport()
    again = publish.publish(corpus, tmp_path / "work2", second, check=NO_CHECK, **limits)
    assert second.calls == [] and again["dropped"] == manifest["dropped"]


# --- install is not destructive when it fails -------------------------------------------------------------------------


def test_a_failing_install_never_leaves_a_half_empty_corpus(tmp_path, monkeypatch):
    corpus, _ = published(tmp_path)
    (corpus / "stale.pdf").write_bytes(b"stale")
    before = snapshot(corpus)

    real_copy, calls = publish.shutil.copyfile, []

    def flaky_copy(source, target, **kwargs):
        if str(target).endswith(".part"):  # install() copies each changed file beside its place first
            calls.append(target)
            if len(calls) == 3:
                raise OSError("disk full")
        return real_copy(source, target, **kwargs)

    monkeypatch.setattr(publish.shutil, "copyfile", flaky_copy)
    with pytest.raises(OSError, match="disk full"):  # pad=1: the new PDFs differ from the installed ones
        publish.publish(corpus, tmp_path / "work2", FakeExport(pad=1), check=NO_CHECK, force=True)
    monkeypatch.undo()

    assert len(calls) == 3  # two new files were installed before it failed
    after = snapshot(corpus)
    assert sorted(after) == sorted(before)  # nothing deleted (the stale file goes only at the very end), no .part left
    assert after["manifest.json"] == before["manifest.json"]  # manifest.json is written last
    assert all(after[path][0] for path in after)  # no empty or half-written file
    assert sum(after[path][0] != before[path][0] for path in after) == 2


def test_install_replaces_files_whole_and_removes_stale_ones_last(tmp_path):
    stage, corpus = tmp_path / "stage", tmp_path / "generated"
    (stage / "sub").mkdir(parents=True)
    (stage / "a.json").write_text("new", encoding="utf-8")
    (stage / "sub" / "b.png").write_bytes(b"new b")
    (stage / "manifest.json").write_text("{}", encoding="utf-8")
    (corpus / "gone").mkdir(parents=True)
    (corpus / "gone" / "old.png").write_bytes(b"old")
    (corpus / "a.json").write_text("old", encoding="utf-8")
    (corpus / "README.md").write_text("readme", encoding="utf-8")

    publish.install(stage, corpus)
    assert listing(corpus) == ["README.md", "a.json", "manifest.json", "sub/b.png"]
    assert (corpus / "a.json").read_text(encoding="utf-8") == "new" and not (corpus / "gone").exists()
    assert os.listdir(corpus / "sub") == ["b.png"]
