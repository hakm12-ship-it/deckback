"""Tests for `python -m harness.fidelity.structural_cli` (M3 Task 11): S1-S6 per slide as JSON lines, statuses and
counts only on stdout, the details on stderr only when asked for (public decks).

The decks are test_structural.py's synthetic pairs: a PyMuPDF PDF and a python-pptx deck of the same scene.
"""

import json
import subprocess
import sys
from pathlib import Path

from harness.fidelity import structural, structural_cli
from harness.fidelity.test_structural import base_scene, build_pdf, build_pptx, replaced, text

REPO = Path(__file__).resolve().parents[2]
STATUSES = {"pass", "fail", "n/a"}
KEYS = ["slide", "S1", "S2", "S3", "S4", "S5", "S6", "counts"]
# Words of the decks below that must never reach stdout: their text, typeface, shape names and file names.
SECRET_TEXT = "Quokka Zebra"


def secret_scene():
    return [*base_scene(), text((100, 480), SECRET_TEXT, 20, (10, 20, 30))]


def pair(tmp_path, pages=2, slides=2, slide_scene=None):
    scene = secret_scene()
    pdf = build_pdf(tmp_path / "secret-input.pdf", scene, pages=pages)
    pptx = build_pptx(tmp_path / "secret-output.pptx", slide_scene or scene, slides=slides,
                      pages=list(range(1, slides + 1)))
    return pdf, pptx


def run_main(argv, capsys):
    code = structural_cli.main(argv)
    out, err = capsys.readouterr()
    return code, out, err


def records(out):
    lines = out.splitlines()
    assert all(line.strip() for line in lines)
    return [json.loads(line) for line in lines]


def test_one_line_per_slide_with_every_s_status_and_the_counts(tmp_path, capsys):
    pdf, pptx = pair(tmp_path)
    code, out, err = run_main(["--pdf", str(pdf), "--pptx", str(pptx)], capsys)
    assert code == 0 and err == ""
    rows = records(out)
    assert [row["slide"] for row in rows] == [1, 2]
    for row in rows:
        assert list(row) == KEYS
        assert {row[key] for key in KEYS[1:-1]} <= STATUSES
        assert list(row["counts"]) == KEYS[1:-1]
    # the statuses and counts are structural.check's, page by page
    from harness.fidelity import pdf_facts, pptx_facts
    for index, row in enumerate(rows):
        checks = structural.check(pdf_facts.page_facts(pdf, index), pptx_facts.slide_facts(pptx, index))
        assert {key: row[key] for key in KEYS[1:-1]} == {key: checks[key]["status"] for key in KEYS[1:-1]}
        assert row["counts"] == {key: checks[key].get("counts", {}) for key in KEYS[1:-1]}
    assert rows[0]["S1"] == rows[0]["S2"] == rows[0]["S5"] == "pass"


def _stdout_holds_statuses_and_counts_only(out, *words):
    for row in records(out):
        assert isinstance(row["slide"], int)
        assert {row[key] for key in KEYS[1:-1]} <= STATUSES
        for counts in row["counts"].values():
            assert all(name in structural.COUNT_NAMES and isinstance(value, int) for name, value in counts.items())
    for word in words:
        assert word not in out, word


def test_no_deck_text_on_stdout_even_where_a_check_fails(tmp_path, capsys):
    # the slide's text differs from the page's (S2 fails, with a detail naming the shape and typeface)
    changed = replaced(secret_scene(), len(secret_scene()) - 1, text="Quokka Zebrb")
    pdf, pptx = pair(tmp_path, slide_scene=changed)
    code, out, err = run_main(["--pdf", str(pdf), "--pptx", str(pptx)], capsys)
    assert code == 0
    assert {row["S2"] for row in records(out)} == {"fail"}
    _stdout_holds_statuses_and_counts_only(out, "Quokka", "Zebr", "Deck Sans", "DeckSans", "pdf:p", "secret",
                                           str(tmp_path), "detail")
    assert err == ""  # without --details nothing of the deck goes to stderr either


def test_details_go_to_stderr_when_asked_for(tmp_path, capsys):
    changed = replaced(secret_scene(), len(secret_scene()) - 1, text="Quokka Zebrb")
    pdf, pptx = pair(tmp_path, slide_scene=changed)
    code, out, err = run_main(["--pdf", str(pdf), "--pptx", str(pptx), "--details"], capsys)
    assert code == 0
    _stdout_holds_statuses_and_counts_only(out, "Quokka", "Deck Sans", "pdf:p", "secret")
    lines = err.splitlines()
    assert any(line.startswith("slide 1 S2 fail: text differs") for line in lines), err
    assert any(line.startswith("slide 2 S2 fail: ") for line in lines), err
    assert not any(" pass: " in line for line in lines)  # only the checks that do not pass


def test_a_page_without_its_slide_fails_all_six(tmp_path, capsys):
    pdf, pptx = pair(tmp_path, pages=2, slides=1)
    code, out, _ = run_main(["--pdf", str(pdf), "--pptx", str(pptx)], capsys)
    assert code == 0
    first, second = records(out)
    assert first["S5"] == "fail"  # 1 slide for 2 pages
    assert {second[key] for key in KEYS[1:-1]} == {"fail"}


def test_an_unreadable_pdf_is_exit_3_without_its_path(tmp_path, capsys):
    junk = tmp_path / "secret-junk.pdf"
    junk.write_bytes(b"not a pdf")
    code, out, err = run_main(["--pdf", str(junk), "--pptx", str(tmp_path / "none.pptx")], capsys)
    assert code == 3 and out == ""
    assert "not a PDF" in err and "secret" not in err and str(tmp_path) not in err


def test_runs_as_a_module(tmp_path):
    pdf, pptx = pair(tmp_path, pages=1, slides=1)
    done = subprocess.run([sys.executable, "-m", "harness.fidelity.structural_cli", "--pdf", str(pdf), "--pptx",
                           str(pptx)], cwd=REPO, capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert done.returncode == 0, done.stderr
    assert done.stderr == ""
    assert [row["slide"] for row in records(done.stdout)] == [1]
