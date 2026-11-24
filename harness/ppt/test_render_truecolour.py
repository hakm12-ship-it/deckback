"""PowerPoint's Slide.Export('PNG') writes an 8-bit palette PNG (colour type 3) for slides with few colours, which
would add noise to every pixel metric. render.ps1 must always write 8-bit RGB (colour type 2).

The test that drives PowerPoint needs `pytest --run-powerpoint`; the PNG-reader tests always run.
"""

from pathlib import Path

import pytest
from PIL import Image

from harness.ppt.never_stop import run_script
from harness.ppt.pngmode import png_colour_type
from harness.spikes.m0_5_fillrule import build

REPO = Path(__file__).resolve().parents[2]
RENDER = REPO / "harness" / "ppt" / "render.ps1"


def run_render(pptx, out_dir, *extra):
    """render.ps1 with a 600 s limit; past it the script is left running (never ended: m6) and the test fails."""
    return run_script(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RENDER),
                       "-Pptx", str(pptx), "-OutDir", str(out_dir), *extra], 600)


@pytest.mark.parametrize("mode, expected", [("RGB", 2), ("RGBA", 6), ("P", 3), ("L", 0), ("LA", 4)])
def test_png_colour_type_reads_ihdr(tmp_path, mode, expected):
    path = tmp_path / "x.png"
    Image.new(mode, (3, 2)).save(path)
    assert png_colour_type(path) == expected


def test_png_colour_type_rejects_files_that_are_not_png(tmp_path):
    path = tmp_path / "x.png"
    path.write_bytes(b"BM" + bytes(40))
    with pytest.raises(ValueError):
        png_colour_type(path)
    path.write_bytes(b"")
    with pytest.raises(ValueError):
        png_colour_type(path)


@pytest.mark.powerpoint
def test_low_colour_slide_renders_truecolour(tmp_path):
    """The M0-5 fill-rule slide has two colours; on M0 PowerPoint exported it as a palette PNG (type 3)."""
    pptx = tmp_path / "fillrule.pptx"
    build(pptx)
    out_dir = tmp_path / "render"
    done = run_render(pptx, out_dir)
    assert done.returncode == 0, done.stderr
    pngs = sorted(out_dir.glob("slide*.png"))
    assert pngs, "render.ps1 wrote no slide PNG"
    for png in pngs:
        assert png_colour_type(png) == 2, png.name
        with Image.open(png) as img:
            assert img.size == (1920, 1080), png.name
    assert not list(out_dir.glob("*.bmp")) and not list(out_dir.glob("*.tif")), "intermediate export files left behind"


@pytest.mark.powerpoint
def test_tif_fallback_also_renders_truecolour_and_matches_the_bmp_route(tmp_path):
    """-TestForceTif sends every slide through the TIF route that render.ps1 uses if a BMP is not 24-bit."""
    pptx = tmp_path / "fillrule.pptx"
    build(pptx)
    via_bmp, via_tif = tmp_path / "bmp", tmp_path / "tif"
    first = run_render(pptx, via_bmp)
    assert first.returncode == 0, first.stderr
    assert "TIF fallback" not in first.stderr
    second = run_render(pptx, via_tif, "-TestForceTif")
    assert second.returncode == 0, second.stderr
    assert "TIF fallback" in second.stderr
    assert png_colour_type(via_tif / "slide1.png") == 2
    assert not list(via_tif.glob("*.bmp")) and not list(via_tif.glob("*.tif"))
    with Image.open(via_bmp / "slide1.png") as a, Image.open(via_tif / "slide1.png") as b:
        assert a.size == b.size == (1920, 1080)
        assert a.tobytes() == b.tobytes()
