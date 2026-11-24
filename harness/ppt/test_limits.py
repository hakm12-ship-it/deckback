"""harness/ppt/limits.py: the Python side's one copy of the PowerPoint module's default time limit (minor m18)."""

import re
from pathlib import Path

from harness.atlas import export
from harness.fidelity import run
from harness.ppt import limits

MODULE = Path(__file__).with_name("DeckbackCom.psm1")


def test_the_python_limit_is_the_modules_own():
    text = MODULE.read_text(encoding="utf-8")
    function = re.search(r"function Get-DeckbackTimeout \{(.*?)\n\}", text, re.S).group(1)
    base = int(re.search(r"\[int\]\$BaseSec = (\d+)", function).group(1))
    per_slide = int(re.search(r"\[int\]\$PerSlideSec = (\d+)", function).group(1))
    assert (limits.BASE_SEC, limits.PER_SLIDE_SEC) == (base, per_slide) == (120, 4)
    assert limits.module_time_limit(0) == 120 and limits.module_time_limit(5) == 140


def test_export_and_the_fidelity_render_take_it_from_there(tmp_path, monkeypatch):
    monkeypatch.setattr(limits, "BASE_SEC", 1000)
    monkeypatch.setattr(limits, "PER_SLIDE_SEC", 100)
    monkeypatch.setattr(export, "slide_count", lambda pptx: 3)
    assert export.subprocess_limit(tmp_path / "deck.pptx", 1) == (1000 + 3 * 100) + 30 + 60

    waited = []

    class FakePopen:
        def __init__(self, command, **kwargs):
            self.returncode, self.pid = 0, 1

        def communicate(self, timeout=None):
            waited.append(timeout)
            return "", ""

    monkeypatch.setattr(run.subprocess, "Popen", FakePopen)
    run.PowerPointRenderer()(tmp_path / "deck.pptx", tmp_path / "render", keep_log=False, size=(256, 144))
    assert waited == [2 * (1000 + 3 * 100) + 90]  # its own limit plus a wait for another run's lock, plus margin
