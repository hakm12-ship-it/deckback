"""The edge decks open in PowerPoint without a repair prompt (Review Focus 1; ruling M3-R6; M3 Task 12).

`npm run test:local` writes `out/ooxml/edge-shapes.pptx` and `out/ooxml/edge-text.pptx` (packages/ooxml/test/
edge.local.test.ts: odd but legal writer input, 0 validator errors). Here each is rendered by harness/ppt/render.ps1,
which drives PowerPoint only through DeckbackCom.psm1 (a GUID-named temp copy, nothing it did not start is closed,
quit or stopped). A repair prompt or any other dialog holds PowerPoint until render.ps1's own time limit: exit code 2.
So exit 0 with one truecolour PNG per slide means PowerPoint opened the deck as it is.

Needs `pytest --run-powerpoint` (marker `powerpoint`); CI never runs it.
"""

from pathlib import Path

import pytest

from harness.atlas.export import slide_count
from harness.ppt import limits
from harness.ppt.never_stop import run_script
from harness.ppt.pngmode import RGB, png_colour_type

REPO = Path(__file__).resolve().parents[2]
RENDER = REPO / "harness" / "ppt" / "render.ps1"
EDGE_DECKS = ("edge-shapes", "edge-text")


@pytest.mark.powerpoint
@pytest.mark.parametrize("name", EDGE_DECKS)
def test_edge_decks_open_without_repair(tmp_path, name):
    pptx = REPO / "out" / "ooxml" / f"{name}.pptx"
    assert pptx.is_file(), f"out/ooxml/{name}.pptx is missing: run `npm run test:local` first"
    slides = slide_count(pptx)
    # render.ps1 ends itself past its own limit (exit 2); past twice that and more it is left running, never ended
    limit = 2 * limits.module_time_limit(slides) + 90
    out_dir = tmp_path / "render"
    done = run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RENDER),
                       "-Pptx", str(pptx), "-OutDir", str(out_dir)], limit)
    assert done.returncode == 0, (f"render.ps1 exit code {done.returncode} (2: a repair prompt or another dialog, "
                                  f"5: PowerPoint busy): {done.stderr.strip()[-500:]}")
    pngs = sorted(out_dir.glob("slide*.png"))
    assert len(pngs) == slides, f"{len(pngs)} PNGs for {slides} slides"
    assert all(png_colour_type(png) == RGB for png in pngs)
