"""Spike M0-6: gradients. Does PowerPoint open a gradFill with more than 10 stops without a repair
prompt, and does the probe deck's gradient, rebuilt from the pdf.js colour stops, match PowerPoint's own
rendering of the original?

Builds out/m0/gradient.pptx (960 x 540 pt slides):
  1  a 600 x 100 pt rectangle, 12-stop linear gradient, angle 0, #C00000 / #0070C0 alternating at equal
     spacing (stop k at k / 11)
  2  the probe page-2 gradient: a rectangle at the shading's clip bbox, with the pdf.js colour stops
     mapped onto the bbox projection of the p0 -> p1 axis (all of them)
  3  the same, with the stops reduced to at most 10 (only when slide 2 has more than 10)
renders it with harness/ppt/render.ps1 and evaluates:
  - render.ps1 exits 0 (no repair prompt, no modal dialog)
  - slide 1: the colour at each stop position is within 16 (max channel difference) of the stop colour.
    The 12 "bands" are centred on the stops, so a band's centre is its stop position (the two end bands
    are half bands: those two samples are taken 2 px inside the rectangle).
  - slides 2 and 3: diff_ratio against corpus/private/probe/gt_2.png over the shading bbox (x2 px) is
    <= 0.001 at thr 32, ignoring the text lines inside the region (walker glyph ops, dilated by 2 px).
    The record also keeps the max and mean pixel difference outside the text and the ratio at the
    stricter thresholds 24, 20 and 16, so the verdict can be read together with how close it is.
and writes every number to out/m0/gradient.json. The shading comes from out/m0/shadings-p2.json, which
this script regenerates with scripts/dump-shading.mjs on every run.
"""

import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.ns import qn
from pptx.util import Emu

if __package__:  # imported as harness.spikes.m0_6_gradient (its tests)
    from harness.spikes import pptx_xml, regiondiff
else:  # run as a script: its own folder holds the helpers
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import pptx_xml  # noqa: E402
    import regiondiff  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
RENDER = REPO / "harness" / "ppt" / "render.ps1"
DUMP = REPO / "scripts" / "dump-shading.mjs"
OUT = REPO / "out" / "m0"
GT_PNG = REPO / "corpus" / "private" / "probe" / "gt_2.png"
ORIGINAL_PDF = REPO / "corpus" / "private" / "probe" / "original.pdf"

SLIDE_W, SLIDE_H = 960, 540        # pt, 16:9
SLIDE1_RECT = (180, 220, 780, 320)  # 600 x 100 pt, centred
STOP_LIMIT = 10                     # slide 3 (reduced stops) is built only above this many stops
COLOUR_TOLERANCE = 16
DIFF_LIMIT = 0.001
DIFF_THR = 32                       # a pixel differs when its max channel difference exceeds this
SENSITIVITY_THR = (24, 20, 16)      # stricter thresholds, recorded to show how close the verdict is
DILATE_PX = 2
DELTA_E_LIMIT = 1.0
RED, BLUE = "#C00000", "#0070C0"


# --- colour -----------------------------------------------------------------------------------------

def _rgb(colour):
    text = colour.lstrip("#")
    return tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))


def _hex(rgb):
    return "#%02X%02X%02X" % tuple(max(0, min(255, int(round(c)))) for c in rgb)


def _lab(rgb):
    """sRGB 0-255 -> CIE L*a*b* (D65)."""
    def linear(c):
        c /= 255
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = (linear(c) for c in rgb)
    x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047
    y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b
    z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 216 / 24389 else (24389 / 27 * t + 16) / 116

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def delta_e76(a, b):
    """CIE76 colour difference between two '#RRGGBB' colours (or RGB triples)."""
    ra = _rgb(a) if isinstance(a, str) else a
    rb = _rgb(b) if isinstance(b, str) else b
    return math.dist(_lab(ra), _lab(rb))


def _mix(c0, c1, frac):
    return tuple(a + (b - a) * frac for a, b in zip(c0, c1))


# --- stops ------------------------------------------------------------------------------------------

def _colour_at(stops, t, side):
    """Colour of the piecewise-linear ramp `stops` [(t, (r, g, b))] at t, held constant beyond the ends.
    At a hard stop (two stops at one t), side 'right' returns the later colour, 'left' the earlier."""
    for i, (ti, _) in enumerate(stops):
        if ti > t if side == "right" else ti >= t:
            if i == 0:
                return stops[0][1]
            (t0, c0), (t1, c1) = stops[i - 1], stops[i]
            return _mix(c0, c1, (t - t0) / (t1 - t0))
    return stops[-1][1]


def remap_stops(color_stops, p0, p1, ctm, bbox):
    """Map pdf.js axial colour stops onto the projection of `bbox` on the shading axis.

    color_stops: [(t, '#rrggbb')], t in 0..1 along p0 -> p1 (the shading's own parameter).
    p0, p1: axis end points in shading space; ctm: (a, b, c, d, e, f) from shading space to the slide frame.
    bbox: (x0, y0, x1, y1) in the slide frame, the rectangle that gets the gradient.

    PowerPoint's linear gradient (scaled=0) runs from the bbox corner with the lowest projection on the
    gradient direction (position 0) to the one with the highest (position 1). So the shading parameter
    range [tmin, tmax] covered by the bbox becomes 0..1: stops inside the range are rescaled, and the
    colours at tmin and tmax (interpolated between the neighbouring stops) become the end stops. Outside
    [first stop, last stop] the end colours are held (as if the shading extended).

    Returns ([(position 0..1, '#RRGGBB')], angle_deg clockwise from +x in the y-down slide frame, (tmin, tmax)).
    """
    a, b, c, d, e, f = ctm

    def to_slide(p):
        return a * p[0] + c * p[1] + e, b * p[0] + d * p[1] + f

    (x0, y0), (x1, y1) = to_slide(p0), to_slide(p1)
    dx, dy = x1 - x0, y1 - y0
    length2 = dx * dx + dy * dy
    if length2 == 0:
        raise ValueError("the shading axis has zero length")
    bx0, by0, bx1, by1 = bbox
    ts = [((cx - x0) * dx + (cy - y0) * dy) / length2 for cx in (bx0, bx1) for cy in (by0, by1)]
    tmin, tmax = min(ts), max(ts)
    ramp = [(t, _rgb(colour)) for t, colour in color_stops]
    span = tmax - tmin
    stops = [(0.0, _hex(_colour_at(ramp, tmin, "right")))]
    stops += [((t - tmin) / span, _hex(rgb)) for t, rgb in ramp if tmin < t < tmax]
    stops.append((1.0, _hex(_colour_at(ramp, tmax, "left"))))
    return stops, math.degrees(math.atan2(dy, dx)), (tmin, tmax)


def _worst_error(original, kept):
    """Largest CIE76 error at the dropped stops of `original` when only the `kept` indices (ascending)
    remain and PowerPoint interpolates linearly (in sRGB) between them."""
    worst = 0.0
    for lo, hi in zip(kept, kept[1:]):
        (p_lo, c_lo), (p_hi, c_hi) = original[lo], original[hi]
        for i in range(lo + 1, hi):
            p, c = original[i]
            frac = (p - p_lo) / (p_hi - p_lo) if p_hi > p_lo else 0.0
            worst = max(worst, delta_e76(_mix(_rgb(c_lo), _rgb(c_hi), frac), _rgb(c)))
    return worst


def reduce_stops(stops, max_stops=STOP_LIMIT, max_delta_e=DELTA_E_LIMIT):
    """Drop stops one at a time, always the one whose removal costs the least, while that cost stays within
    CIE76 `max_delta_e` (measured against all the original stops) or more than `max_stops` remain.
    The end stops are never dropped.

    Returns (reduced stops, the worst CIE76 error left). The error exceeds `max_delta_e` only when the
    stop count had to be forced down to `max_stops`.
    """
    kept = list(range(len(stops)))
    worst = 0.0
    while len(kept) > 2:
        cost, j = min((_worst_error(stops, kept[:j] + kept[j + 1 :]), j) for j in range(1, len(kept) - 1))
        if cost > max_delta_e and len(kept) <= max_stops:
            break
        del kept[j]
        worst = cost
    return [stops[i] for i in kept], worst


# --- deck -------------------------------------------------------------------------------------------

def _add_rect(slide, rect_pt, stops, angle_deg):
    x0, y0, x1, y1 = (int(round(v * pptx_xml.EMU_PER_PT)) for v in rect_pt)
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, Emu(x0), Emu(y0), Emu(x1 - x0), Emu(y1 - y0))
    # python-pptx's autoshape carries a theme style (outline, shadow); drop it so only the gradient is drawn.
    style = shape._element.find(qn("p:style"))
    shape._element.remove(style)
    shape.line.fill.background()
    pptx_xml.add_gradfill(shape, stops, angle_deg)
    return shape


def build(pptx_path, probe_stops, probe_angle, probe_bbox, reduced_stops):
    """Write the deck. `reduced_stops` None means no third slide."""
    prs = Presentation()
    prs.slide_width = Emu(SLIDE_W * pptx_xml.EMU_PER_PT)
    prs.slide_height = Emu(SLIDE_H * pptx_xml.EMU_PER_PT)
    blank = prs.slide_layouts[6]

    zigzag = [(k / 11, RED if k % 2 == 0 else BLUE) for k in range(12)]
    _add_rect(prs.slides.add_slide(blank), SLIDE1_RECT, zigzag, 0.0)

    probe_rect = [float(v) for v in probe_bbox]
    for stops in (probe_stops, reduced_stops):
        if stops is None:
            continue
        _add_rect(prs.slides.add_slide(blank), probe_rect, stops, probe_angle)

    Path(pptx_path).parent.mkdir(parents=True, exist_ok=True)
    prs.save(str(pptx_path))


# --- evaluation -------------------------------------------------------------------------------------

def text_boxes_px(glyphs, region_pt, scale, dilate_px):
    """One box per text line (walker glyph ops sharing a baseline) whose glyphs intersect the region,
    in pixels: the union of the line's non-whitespace glyph boxes, scaled, then dilated."""
    rx0, ry0, rx1, ry1 = region_pt
    lines = {}
    for g in glyphs:
        x0, y0, x1, y1 = g["bbox"]
        if not g["u"].strip() or x1 <= rx0 or x0 >= rx1 or y1 <= ry0 or y0 >= ry1:
            continue
        lines.setdefault(round(g["y"], 1), []).append(g["bbox"])
    boxes = []
    for bboxes in lines.values():
        x0, y0, x1, y1 = (f(b[i] for b in bboxes) for f, i in ((min, 0), (min, 1), (max, 2), (max, 3)))
        boxes.append((x0 * scale - dilate_px, y0 * scale - dilate_px, x1 * scale + dilate_px, y1 * scale + dilate_px))
    return boxes


def sample_rgb(pixels, x, y):
    """Median colour of the 5 x 5 pixels around (x, y)."""
    block = pixels[y - 2 : y + 3, x - 2 : x + 3].reshape(-1, 3)
    return [int(v) for v in np.median(block, axis=0)]


def evaluate_slide1(png_path):
    with Image.open(png_path) as img:
        pixels = np.asarray(img.convert("RGB"))
    scale = pixels.shape[1] / SLIDE_W
    x0, y0, x1, y1 = (v * scale for v in SLIDE1_RECT)
    row = int(round((y0 + y1) / 2))
    samples = []
    for k in range(12):
        # stop k is at k / 11 of the rectangle width; the end stops sit on the edge, so move 2 px inside
        x = int(round(min(max(x0 + (x1 - x0) * k / 11, x0 + 2), x1 - 3)))
        expected = RED if k % 2 == 0 else BLUE
        sampled = sample_rgb(pixels, x, row)
        error = max(abs(s - e) for s, e in zip(sampled, _rgb(expected)))
        samples.append({"stop": k, "x_px": x, "expected": expected, "sampled": sampled, "max_channel_error": error})
    worst = max(s["max_channel_error"] for s in samples)
    return {"samples": samples, "worst_error": worst, "tolerance": COLOUR_TOLERANCE, "pass": worst <= COLOUR_TOLERANCE}


def evaluate_probe(png_path, region_pt, glyphs):
    """The verdict is the brief's: diff_ratio at thr 32 <= 0.001. The record also keeps what a bare ratio
    hides: the largest and the mean pixel difference outside the text, and the ratio at stricter thresholds."""
    with Image.open(GT_PNG) as gt:
        gt_width = gt.size[0]
    scale = gt_width / SLIDE_W
    box = tuple(v * scale for v in region_pt)
    excludes = text_boxes_px(glyphs, region_pt, scale, DILATE_PX)
    stats = regiondiff.diff_stats(GT_PNG, png_path, box, excludes, (DIFF_THR, *SENSITIVITY_THR))
    ratio = stats["ratios"][DIFF_THR]
    sensitivity = {str(thr): stats["ratios"][thr] for thr in SENSITIVITY_THR}
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    covered = np.zeros((y1 - y0, x1 - x0), dtype=bool)
    for ex0, ey0, ex1, ey1 in excludes:
        covered[max(0, math.floor(ey0) - y0) : max(0, math.ceil(ey1) - y0),
                max(0, math.floor(ex0) - x0) : max(0, math.ceil(ex1) - x0)] = True
    passed = ratio <= DIFF_LIMIT
    verdict = (
        f"{'passes' if passed else 'fails'} at thr {DIFF_THR}: ratio {ratio:.6f} (limit {DIFF_LIMIT}), "
        f"max diff {stats['max_diff']}, mean diff {stats['mean_diff']:.2f}; stricter: "
        + ", ".join(f"thr {thr} -> {sensitivity[str(thr)]:.6f}" for thr in SENSITIVITY_THR)
    )
    return {
        "thr": DIFF_THR,
        "diff_ratio": ratio,
        "limit": DIFF_LIMIT,
        "max_diff": stats["max_diff"],
        "mean_diff": round(stats["mean_diff"], 3),
        "pixels_compared": stats["pixels"],
        "sensitivity": sensitivity,
        "diff_ratio_without_exclusion": regiondiff.diff_ratio(GT_PNG, png_path, box, thr=DIFF_THR),
        "region_px": [int(v) for v in box],
        "excluded_boxes_px": [[round(v, 1) for v in b] for b in excludes],
        "excluded_fraction": round(float(covered.mean()), 4),
        "pass": passed,
        "verdict": verdict,
    }


def powerpoint_running():
    done = subprocess.run(["tasklist", "/FI", "IMAGENAME eq POWERPNT.EXE", "/FO", "CSV", "/NH"],
                          capture_output=True, text=True, errors="replace")
    return "POWERPNT.EXE" in done.stdout.upper()


def main():
    missing = [p.name for p in (ORIGINAL_PDF, GT_PNG) if not p.exists()]
    if missing:
        print(f"SKIP local fixture missing: {', '.join(missing)}", file=sys.stderr)
        return 4
    node = shutil.which("node")
    if node is None:
        print("node was not found on PATH", file=sys.stderr)
        return 4
    subprocess.run([node, str(DUMP)], cwd=REPO, check=True)
    dump = json.loads((OUT / "shadings-p2.json").read_text(encoding="utf-8"))
    shadings = [s for s in dump["shadings"] if s["shading"] is not None and s["shading"]["type"] == "axial"]
    if len(shadings) != 1:
        print(f"expected exactly one axial shading on page 2, found {len(shadings)}", file=sys.stderr)
        return 4
    shade = shadings[0]
    sh = shade["shading"]
    bbox = shade["bbox"]
    stops, angle, (tmin, tmax) = remap_stops(sh["colorStops"], sh["p0"], sh["p1"], sh["ctm"], bbox)
    reduced, reduction_error = reduce_stops(stops) if len(stops) > STOP_LIMIT else (None, 0.0)

    pptx = OUT / "gradient.pptx"
    render_dir = OUT / "gradient"
    build(pptx, stops, angle, bbox, reduced)

    running_before = powerpoint_running()
    done = subprocess.run(
        ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RENDER),
         "-Pptx", str(pptx), "-OutDir", str(render_dir)],
        capture_output=True, text=True, errors="replace",
    )
    running_after = powerpoint_running()
    result = {
        "render_exit_code": done.returncode,
        "powerpoint_running_before": running_before,
        "powerpoint_running_after": running_after,
    }
    if done.returncode != 0:
        print(f"render.ps1 failed with exit code {done.returncode}: {done.stderr.strip()}", file=sys.stderr)
        result["pass"] = False
        (OUT / "gradient.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        return done.returncode

    result["shading"] = {
        "bbox_pt": bbox,
        "p0_shading_space": sh["p0"],
        "p1_shading_space": sh["p1"],
        "ctm": sh["ctm"],
        "angle_deg": round(angle, 3),
        "t_range": [round(tmin, 6), round(tmax, 6)],
        "pdfjs_stops": len(sh["colorStops"]),
        "stops_in_bbox": len(stops),
        "stops_reduced": None if reduced is None else len(reduced),
        "reduction_worst_delta_e76": round(reduction_error, 3),
        "reduction_within_delta_e_1": reduction_error <= DELTA_E_LIMIT,
    }
    result["slide1"] = evaluate_slide1(render_dir / "slide1.png")
    result["slide2"] = evaluate_probe(render_dir / "slide2.png", bbox, dump["glyphs"])
    if reduced is not None:
        result["slide3"] = evaluate_probe(render_dir / "slide3.png", bbox, dump["glyphs"])
    result["pass"] = all(result[k]["pass"] for k in ("slide1", "slide2", "slide3") if k in result)
    (OUT / "gradient.json").write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0 if result["pass"] else 1


if __name__ == "__main__":
    sys.exit(main())
