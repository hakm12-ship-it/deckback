"""The Open XML validator: a python-pptx deck is clean, a broken part is reported, --private prints no names."""

import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from pptx import Presentation

from harness.ooxml import validate as v

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture(scope="module")
def clean_deck(tmp_path_factory):
    path = tmp_path_factory.mktemp("ooxml") / "clean-deck.pptx"
    prs = Presentation()
    prs.slides.add_slide(prs.slide_layouts[6])
    prs.save(path)
    return path


@pytest.fixture(scope="module")
def broken_deck(clean_deck):
    path = clean_deck.with_name("broken-deck.pptx")
    with zipfile.ZipFile(clean_deck) as src, zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as dst:
        for item in src.infolist():
            data = src.read(item.filename)
            if item.filename == "ppt/presentation.xml":
                text = data.decode("utf-8")
                assert "<p:sldIdLst>" in text
                text = text.replace("<p:sldIdLst>", '<p:sldIdLst bogus="1">', 1)
                data = text.encode("utf-8")
            dst.writestr(item, data)
    return path


def _linked_deck(path, url):
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    shape = slide.shapes.add_textbox(0, 0, 914400, 914400)
    shape.click_action.hyperlink.address = url
    prs.save(path)
    return path


@pytest.fixture(scope="module")
def long_url_deck(tmp_path_factory):
    """A deck whose hyperlink target (70,000 characters) is longer than System.Uri reads (final review F3)."""
    return _linked_deck(tmp_path_factory.mktemp("ooxml-long-url") / "long-url.pptx",
                        "https://example.com/" + "a" * 70_000)


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run_cli(*args):
    return subprocess.run(
        [sys.executable, "-m", "harness.ooxml.validate", *map(str, args)],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8",
    )


def test_a_minimal_python_pptx_deck_has_no_errors(clean_deck):
    [result] = v.validate([clean_deck])
    assert result["file"] == "clean-deck.pptx"
    assert result["errors"] == []


def test_a_broken_part_is_reported(broken_deck):
    [result] = v.validate([broken_deck])
    assert len(result["errors"]) >= 1
    for error in result["errors"]:
        assert error["part"]
        assert error["id"]


def test_private_mode_prints_no_names_or_descriptions(broken_deck):
    proc = run_cli(broken_deck, "--private")
    assert proc.returncode == 1
    assert "broken-deck" not in proc.stdout
    assert "description" not in proc.stdout
    [line] = proc.stdout.strip().splitlines()
    out = json.loads(line)
    assert out["file"] is None
    assert out["errorCount"] >= 1
    assert out["ids"]
    assert set(out) == {"file", "errorCount", "ids"}


def test_a_long_url_deck_is_not_changed_and_does_not_pass(long_url_deck, tmp_path):
    """Ruling M3-R61: the validator opens a package read-only, so the file is the same after it (the SDK rewrote and saved
    such a target in place, and passed it); the target it cannot read is an error with a fixed id, naming no URL."""
    before = _sha256(long_url_deck)
    [result] = v.validate([long_url_deck])
    assert _sha256(long_url_deck) == before
    assert [(e["id"], e["part"]) for e in result["errors"]] == [("Deckback.MalformedRelationship", "/ppt/slides/slide1.xml")]
    assert "example.com" not in json.dumps(result)
    assert run_cli(long_url_deck).returncode == 1
    assert _sha256(long_url_deck) == before
    # private mode prints the fixed id only
    proc = run_cli(long_url_deck, "--private")
    assert proc.returncode == 1
    assert json.loads(proc.stdout) == {"file": None, "errorCount": 1, "ids": ["Deckback.MalformedRelationship"]}
    # a target of 2,000 characters is read, and passes
    short = _linked_deck(tmp_path / "url-2000.pptx", "https://example.com/" + "a" * 1_980)
    before = _sha256(short)
    assert v.validate([short])[0]["errors"] == []
    assert _sha256(short) == before


def test_exit_codes(clean_deck, broken_deck):
    assert run_cli(clean_deck).returncode == 0
    assert run_cli(broken_deck).returncode == 1
    assert v.main([str(clean_deck)]) == 0


def test_exit_code_3_when_the_validator_binary_is_missing(clean_deck, monkeypatch, capsys):
    def missing(*_args, **_kwargs):
        raise v.ValidatorUnavailable("no build")

    monkeypatch.setattr(v, "ensure_built", missing)
    assert v.main([str(clean_deck)]) == 3


# --- fix round 1: failures are exit 3, never 1; private output leaks nothing; concurrent builds are serialised ---


def fake_run(returncode=0, stdout="", raises=None):
    real = v.subprocess.run

    def run(cmd, *args, **kwargs):
        if len(cmd) > 1 and str(cmd[1]).endswith("Validator.dll"):
            if raises:
                raise raises
            return subprocess.CompletedProcess(cmd, returncode, stdout, "")
        return real(cmd, *args, **kwargs)

    return run


@pytest.mark.parametrize(
    "fake",
    [
        dict(returncode=5),
        dict(stdout="not json\n"),
        dict(stdout='{"file": "x"}\n'),
        dict(stdout='{"file": "x", "errors": [{"nope": 1}]}\n'),
        dict(raises=OSError("cannot start")),
    ],
)
@pytest.mark.parametrize("private", [False, True])
def test_a_crashing_validator_is_exit_3_never_zero_errors(clean_deck, monkeypatch, capsys, fake, private):
    v.ensure_built()
    monkeypatch.setattr(v.subprocess, "run", fake_run(**fake))
    code = v.main([str(clean_deck), *(["--private"] if private else [])])
    captured = capsys.readouterr()
    assert code == 3
    assert captured.out == ""
    if private:
        assert "clean-deck" not in captured.err


def test_private_mode_prints_no_file_name_on_stdout_or_stderr(broken_deck):
    proc = run_cli(broken_deck, "--private")
    assert proc.returncode == 1
    assert "broken-deck" not in proc.stdout + proc.stderr


def test_private_run_without_a_validator_prints_no_path(clean_deck, monkeypatch, capsys):
    def missing(*_args, **_kwargs):
        raise v.ValidatorUnavailable(f"build failed for {clean_deck}")

    monkeypatch.setattr(v, "ensure_built", missing)
    assert v.main([str(clean_deck), "--private"]) == 3
    captured = capsys.readouterr()
    assert str(clean_deck) not in captured.out + captured.err
    assert "clean-deck" not in captured.out + captured.err


def test_an_oserror_while_building_is_unavailable_not_a_crash(monkeypatch):
    monkeypatch.setattr(v, "_source_hash", lambda: (_ for _ in ()).throw(PermissionError("x")))
    with pytest.raises(v.ValidatorUnavailable):
        v.ensure_built()


def test_a_lock_is_stale_only_after_longer_than_any_wait(tmp_path, monkeypatch):
    """Ledger L49: a build's lock is not taken away while someone may still wait on it (the wait is 600 s; the lock was
    stale after 300 s). A lock 700 s old is a live build's: the waiter times out, the lock stays. One past
    LOCK_STALE_SECONDS was left by a crash: it is taken."""
    import os
    import time

    assert v.LOCK_STALE_SECONDS >= 900 > v.LOCK_WAIT_SECONDS
    lock = tmp_path / "ooxml-validator.lock"
    monkeypatch.setattr(v, "LOCK", lock)
    monkeypatch.setattr(v, "LOCK_WAIT_SECONDS", 0.3)
    lock.write_text("")
    os.utime(lock, (time.time() - 700, time.time() - 700))
    with pytest.raises(v.ValidatorUnavailable):
        v._acquire_lock()
    assert lock.exists()
    os.utime(lock, (time.time() - v.LOCK_STALE_SECONDS - 60, time.time() - v.LOCK_STALE_SECONDS - 60))
    v._acquire_lock()
    assert time.time() - lock.stat().st_mtime < 60  # a new lock, this caller's
    lock.unlink()


def test_no_paths_does_not_build(monkeypatch):
    monkeypatch.setattr(v, "ensure_built", lambda: pytest.fail("built for nothing"))
    assert v.validate([]) == []


def test_two_concurrent_validations_on_a_stale_build_build_once(clean_deck, monkeypatch):
    import shutil
    import threading

    shutil.rmtree(v.BUILD_ROOT / v._source_hash()[:16], ignore_errors=True)  # force a stale (missing) build
    builds = []
    real = v.subprocess.run

    def counting(cmd, *args, **kwargs):
        if len(cmd) > 1 and cmd[1] == "build":
            builds.append(cmd)
        return real(cmd, *args, **kwargs)

    monkeypatch.setattr(v.subprocess, "run", counting)
    outcomes = []

    def work():
        try:
            outcomes.append(v.validate([clean_deck]))
        except Exception as error:  # noqa: BLE001
            outcomes.append(error)

    threads = [threading.Thread(target=work) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(builds) == 1
    assert [o[0]["errors"] if isinstance(o, list) else o for o in outcomes] == [[], []]
