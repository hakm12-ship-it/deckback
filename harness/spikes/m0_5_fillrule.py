"""Spike M0-5: how does PowerPoint fill a custom-geometry shape whose path has overlapping or nested
subpaths?

Builds out/m0/fillrule.pptx with four shapes (fill #1F4E79 on a white slide):
  A  two 100 pt squares, both clockwise, overlapping by 50 pt, in ONE a:path   (sample: overlap centre)
  B  150 pt outer square clockwise + 100 pt inner square counter-clockwise, ONE a:path (sample: inner centre)
  C  150 pt outer square clockwise + 100 pt inner square clockwise, ONE a:path         (sample: inner centre)
  D  as A, but every square in its own a:path                                          (sample: overlap centre)
renders it with harness/ppt/render.ps1 and samples the pixels.

Winding number at the sampled point: A 2, B 0, C 2, D (per path) 1 + 1.
  nonzero rule -> A filled, B empty, C filled.   even-odd rule -> A empty, B empty, C empty.

"All empty" alone would also be the result of nothing being drawn, or of later subpaths being subtracted
from the first. So every shape also gets positive samples at points covered by exactly one subpath (A and D:
the part of each square outside the other; B and C: the ring between outer and inner square). Every fill
rule must fill those. If any of them is not filled the experiment is invalid: the rule is 'mixed' and the
spike exits with code 5.

Writes out/m0/fillrule.json: {A, B, C, D: 'filled'|'empty', rule: 'nonzero'|'evenodd'|'mixed',
positives: {name: 'filled'|'empty'}, samples: {name: [r, g, b]}}.
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from pptx import Presentation
from pptx.util import Emu

if __package__:  # imported as harness.spikes.m0_5_fillrule (its tests)
    from harness.spikes import pptx_xml
else:  # run as a script: its own folder holds the helper
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import pptx_xml  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
RENDER = REPO / "harness" / "ppt" / "render.ps1"

FILL = (0x1F, 0x4E, 0x79)
WHITE = (255, 255, 255)
TOLERANCE = 24
SLIDE_W, SLIDE_H = 960, 540  # pt, 16:9
TOP = 195                    # shapes are 150 pt tall: vertically centred


def square_cw(x, y, size):
    """Clockwise on screen (y down)."""
    return [(x, y), (x + size, y), (x + size, y + size), (x, y + size)]


def square_ccw(x, y, size):
    return [(x, y), (x, y + size), (x + size, y + size), (x + size, y)]


def build(pptx_path):
    """Write the four-shape deck. Returns (centres, positives), both {name: (x_pt, y_pt)}:
    centres: the point that decides the rule, per shape A-D.
    positives: points covered by exactly one subpath, which every fill rule must fill."""
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W * pptx_xml.EMU_PER_PT)
    prs.slide_height = Emu(SLIDE_H * pptx_xml.EMU_PER_PT)
    slide = prs.slides.add_slide(prs.slide_layouts[6])  # blank, white background

    def overlapping(x):
        return [square_cw(x, TOP, 100), square_cw(x + 50, TOP + 50, 100)]

    def nested(x, inner):
        return [square_cw(x, TOP, 150), inner(x + 25, TOP + 25, 100)]

    pptx_xml.add_custgeom(slide, overlapping(60), FILL)                                # A
    pptx_xml.add_custgeom(slide, nested(300, square_ccw), FILL)                        # B
    pptx_xml.add_custgeom(slide, nested(540, square_cw), FILL)                         # C
    pptx_xml.add_custgeom(slide, overlapping(780), FILL, separate_paths=True)          # D
    Path(pptx_path).parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(pptx_path))

    xs = dict(zip("ABCD", (60, 300, 540, 780)))
    # Every shape is 150 pt square and the overlap / inner square is centred in it.
    centres = {name: (x + 75, TOP + 75) for name, x in xs.items()}
    positives = {}
    for name in "AD":  # first square only (top-left lobe), second square only (bottom-right lobe)
        positives[f"{name}_first"] = (xs[name] + 25, TOP + 25)
        positives[f"{name}_second"] = (xs[name] + 125, TOP + 125)
    for name in "BC":  # the 25 pt ring between outer and inner square: left side and bottom side
        positives[f"{name}_ring_left"] = (xs[name] + 12.5, TOP + 75)
        positives[f"{name}_ring_bottom"] = (xs[name] + 75, TOP + 137.5)
    return centres, positives


def classify(rgb):
    """'filled' if within 24 (max channel difference) of #1F4E79, 'empty' if within 24 of white."""
    if max(abs(c - f) for c, f in zip(rgb, FILL)) <= TOLERANCE:
        return "filled"
    if max(abs(c - w) for c, w in zip(rgb, WHITE)) <= TOLERANCE:
        return "empty"
    raise ValueError(f"pixel {tuple(rgb)} is neither the fill colour nor white")


def infer_rule(a, b, c, positives):
    """Winding number 2 at A and C, 0 at B. `positives` are the classifications of the points every
    rule must fill. Unless all of them are filled the experiment proves nothing: 'mixed'.
    Otherwise only the two textbook patterns are named; anything else is 'mixed'."""
    positives = list(positives)
    if not positives or any(p != "filled" for p in positives):
        return "mixed"
    if (a, b, c) == ("filled", "empty", "filled"):
        return "nonzero"
    if (a, b, c) == ("empty", "empty", "empty"):
        return "evenodd"
    return "mixed"


def sample(png_path, point_pt):
    """Median colour of the 5x5 pixels around a slide point given in pt."""
    with Image.open(png_path) as img:
        pixels = np.asarray(img.convert("RGB"))
    scale = pixels.shape[1] / SLIDE_W
    cx, cy = round(point_pt[0] * scale), round(point_pt[1] * scale)
    block = pixels[cy - 2 : cy + 3, cx - 2 : cx + 3].reshape(-1, 3)
    return tuple(int(v) for v in np.median(block, axis=0))


def main():
    out = REPO / "out" / "m0"
    pptx = out / "fillrule.pptx"
    render_dir = out / "fillrule"
    centres, positives = build(pptx)

    done = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RENDER),
         "-Pptx", str(pptx), "-OutDir", str(render_dir)],
        capture_output=True, text=True, errors="replace",
    )
    if done.returncode != 0:
        print(f"render.ps1 failed with exit code {done.returncode}: {done.stderr.strip()}", file=sys.stderr)
        return done.returncode

    png = render_dir / "slide1.png"
    colours = {name: sample(png, pt) for name, pt in {**centres, **positives}.items()}
    try:
        classes = {name: classify(rgb) for name, rgb in colours.items()}
    except ValueError as err:
        print(f"undetermined: {err}; sampled {colours}", file=sys.stderr)
        return 4
    result = {name: classes[name] for name in centres}
    result["positives"] = {name: classes[name] for name in positives}
    result["rule"] = infer_rule(classes["A"], classes["B"], classes["C"], result["positives"].values())
    result["samples"] = {name: list(rgb) for name, rgb in colours.items()}
    (out / "fillrule.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    if any(v != "filled" for v in result["positives"].values()):
        print("positive samples were not filled: the experiment is invalid (rule 'mixed')", file=sys.stderr)
        return 5
    return 0


if __name__ == "__main__":
    sys.exit(main())
