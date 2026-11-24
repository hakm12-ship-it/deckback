"""Tests for the PyMuPDF paint/glyph inventory oracle (mupdf_inventory.py).

The oracle is run as a subprocess (the real CLI) and its JSON output is
cross-checked against PyMuPDF's independent high-level APIs.
"""

import functools
import importlib.util
import json
import struct
import subprocess
import sys
from pathlib import Path

import pymupdf
import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
PROBE = REPO / "corpus" / "private" / "probe"
ORACLE = HERE / "mupdf_inventory.py"


def run_oracle(pdf, pages=None):
    """Run the oracle CLI. `pages` are 1-based page numbers (None = all pages)."""
    cmd = [sys.executable, str(ORACLE), str(pdf)]
    if pages is not None:
        cmd += ["--pages", ",".join(str(p) for p in pages)]
    res = subprocess.run(cmd, capture_output=True, check=True)
    return json.loads(res.stdout.decode("utf-8"))


def require_fixture(name):
    path = PROBE / name
    if not path.exists():
        pytest.skip(f"SKIP local fixture missing: {name}")
    return path


def test_page1_matches_pymupdf_highlevel():
    pdf = require_fixture("original.pdf")
    inv = run_oracle(pdf, pages=[1])["pages"][0]
    page = pymupdf.open(pdf)[0]
    d = page.get_drawings()
    assert sum(p["kind"] == "fill" for p in inv["paints"]) == sum(x["type"] in ("f", "fs") for x in d)
    assert sum(p["kind"] == "stroke" for p in inv["paints"]) == sum(x["type"] in ("s", "fs") for x in d)
    chars = "".join(
        c["c"]
        for b in page.get_text("rawdict")["blocks"]
        for l in b.get("lines", [])
        for s in l["spans"]
        for c in s["chars"]
    )
    # Whitespace-only glyphs are dropped on BOTH sides before comparison (the
    # oracle output itself keeps them).
    assert "".join(g["u"] for g in inv["glyphs"] if g["u"].strip()) == "".join(chars.split())
    assert inv["size"] == [960.0, 540.0]


def test_stroke_bbox_not_expanded(tmp_path):
    pdf = tmp_path / "stroke.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=300)
    page.draw_rect(pymupdf.Rect(100, 100, 200, 150), color=(1, 0, 0), width=3)
    doc.save(pdf)
    inv = run_oracle(pdf)["pages"][0]
    strokes = [p for p in inv["paints"] if p["kind"] == "stroke"]
    assert len(strokes) == 1
    assert strokes[0]["bbox"] == [100, 100, 200, 150]


# --------------------------------------------------------------------------
# Self-contained checks (no local fixture needed)
# --------------------------------------------------------------------------


def build_pdf(path, content, resources="", media_box="0 0 300 300", extra_objects=(), catalog=""):
    """Write a one-page PDF. `extra_objects` are bodies of objects 5, 6, ... (bytes); `catalog` adds catalog entries."""
    objects = [
        f"<< /Type /Catalog /Pages 2 0 R {catalog} >>".encode(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        f"<< /Type /Page /Parent 2 0 R /MediaBox [{media_box}] /Contents 4 0 R /Resources << {resources} >> >>".encode(),
        f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream",
        *extra_objects,
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n".encode() + b"0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    Path(path).write_bytes(bytes(out))


def stream_object(entries, data):
    """Body of a stream object: dictionary `entries` (bytes) plus raw `data`."""
    return b"<< " + entries + b" /Length " + str(len(data)).encode() + b" >>\nstream\n" + data + b"\nendstream"


# What every paint has with detail (§17), and its values on a page with no group, blend mode or soft mask.
SCENE_KEYS = ("clip", "groupAlpha", "blend", "masked")
PLAIN = {"groupAlpha": 1.0, "blend": "normal", "masked": False}

AXIAL_SHADING = (
    b"<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 300 0] /Extend [true true] "
    b"/Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >>"
)


def test_fill_then_stroke_with_colours(tmp_path):
    pdf = tmp_path / "fs.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=300)
    page.draw_rect(pymupdf.Rect(10, 20, 110, 70), color=(0, 0, 1), fill=(1, 0.5, 0), width=2, fill_opacity=0.5)
    doc.save(pdf)
    paints = run_oracle(pdf)["pages"][0]["paints"]
    assert [p["kind"] for p in paints] == ["fill", "stroke"]
    fill, stroke = paints
    assert fill["rgb"] == [255, 128, 0] and fill["alpha"] == 0.5 and fill["evenOdd"] is False
    assert stroke["rgb"] == [0, 0, 255] and stroke["alpha"] == 1.0 and stroke["evenOdd"] is False
    assert fill["bbox"] == stroke["bbox"] == [10, 20, 110, 70]


def test_pages_argument_is_one_based_and_index_is_zero_based(tmp_path):
    pdf = tmp_path / "three.pdf"
    doc = pymupdf.open()
    for width in (100, 200, 300):
        doc.new_page(width=width, height=50)
    doc.save(pdf)
    assert [(p["index"], p["size"]) for p in run_oracle(pdf)["pages"]] == [
        (0, [100.0, 50.0]),
        (1, [200.0, 50.0]),
        (2, [300.0, 50.0]),
    ]
    assert [(p["index"], p["size"]) for p in run_oracle(pdf, pages=[3, 2])["pages"]] == [
        (2, [300.0, 50.0]),
        (1, [200.0, 50.0]),
    ]
    res = subprocess.run([sys.executable, str(ORACLE), str(pdf), "--pages", "4"], capture_output=True)
    assert res.returncode != 0 and b"out of range" in res.stderr


def test_rotated_page_uses_slide_frame(tmp_path):
    pdf = tmp_path / "rot.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)
    page.draw_rect(pymupdf.Rect(10, 20, 110, 70), fill=(1, 0, 0))
    page.set_rotation(90)
    doc.save(pdf)
    inv = run_oracle(pdf)["pages"][0]
    assert inv["size"] == [200.0, 300.0]
    # Unrotated (10,20)-(110,70) turned 90 degrees clockwise on a 300x200 page.
    assert inv["paints"][0]["bbox"] == [130, 10, 180, 110]


def test_shade_bbox_is_current_clip(tmp_path):
    pdf = tmp_path / "shade.pdf"
    # PDF y-up: the clip (100,100)-(200,150) is (100,150)-(200,200) in the slide frame.
    build_pdf(
        pdf,
        b"q 100 100 100 50 re W n /Sh1 sh Q",
        resources="/Shading << /Sh1 5 0 R >>",
        extra_objects=[AXIAL_SHADING],
    )
    paints = run_oracle(pdf)["pages"][0]["paints"]
    assert paints == [
        {"kind": "shade", "bbox": [100, 150, 200, 200], "rgb": None, "alpha": 1.0, "evenOdd": False, "shading": "axial",
         "clip": [100, 150, 200, 200], **PLAIN}
    ]


def test_shade_bbox_intersects_nested_clips_and_page(tmp_path):
    pdf = tmp_path / "nested.pdf"
    build_pdf(
        pdf,
        b"q -50 -50 200 200 re W n q 100 100 400 400 re W n /Sh1 sh Q /Sh1 sh Q /Sh1 sh",
        resources="/Shading << /Sh1 5 0 R >>",
        extra_objects=[AXIAL_SHADING],
    )
    boxes = [p["bbox"] for p in run_oracle(pdf)["pages"][0]["paints"]]
    # Inner: both clips and the page. After the inner Q: only the outer clip, cut by
    # the page (PDF y-up -50..150 -> slide y 150..350, cut to 300). After the outer Q: the page.
    assert boxes == [[100, 150, 150, 200], [0, 150, 150, 300], [0, 0, 300, 300]]


def test_soft_mask_definition_content_is_not_a_paint(tmp_path):
    pdf = tmp_path / "smask.pdf"
    build_pdf(
        pdf,
        b"q /GS1 gs 1 0 0 rg 50 50 100 100 re f /Sh1 sh Q",
        resources="/ExtGState << /GS1 6 0 R >> /Shading << /Sh1 5 0 R >>",
        extra_objects=[
            AXIAL_SHADING,
            b"<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 7 0 R >> >>",
            stream_object(
                b"/Type /XObject /Subtype /Form /BBox [20 30 220 130] "
                b"/Group << /S /Transparency /CS /DeviceGray >> /Resources << /Shading << /Sh1 5 0 R >> >>",
                b"/Sh1 sh",
            ),
        ],
    )
    paints = run_oracle(pdf)["pages"][0]["paints"]
    # The mask form draws one shade per use (two uses). Those are mask data, not
    # page content: only the masked fill and the masked page shade are reported.
    assert [p["kind"] for p in paints] == ["fill", "shade"]
    assert paints[0]["rgb"] == [255, 0, 0] and paints[0]["bbox"] == [50, 150, 150, 250]
    assert paints[1]["bbox"] == [0, 0, 300, 300]


def tiling_pattern(cell=b"1 0 0 rg 0 0 5 5 re f", step=10, resources=b"<< >>"):
    """Body of a coloured tiling pattern (PatternType 1) whose cell is `step` x `step` pt.

    PyMuPDF cannot author patterns, so the pattern is written by hand.
    """
    return stream_object(
        b"/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 %d %d] "
        b"/XStep %d /YStep %d /Resources %s" % (step, step, step, step, resources),
        cell,
    )


GREY_IMAGE = stream_object(
    b"/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", b"\x80"
)


# Contract §9: MuPDF calls begin_tile only when the filled area is wider than XStep
# or taller than YStep (here: step 10). Otherwise (here: step 1000, as PowerPoint
# writes picture fills) it draws the cell straight onto the page, with no begin_tile.
@pytest.mark.parametrize("step", [10, 1000], ids=["tile", "direct"])
def test_tiling_fill_yields_one_pattern_paint(tmp_path, step):
    pdf = tmp_path / "pattern.pdf"
    # PDF y-up: the rect (50,50)-(150,150) is (50,150)-(150,250) in the slide frame and
    # the clip (60,60)-(260,260) is (60,40)-(260,240).
    build_pdf(
        pdf,
        b"q 60 60 200 200 re W n /Pattern cs /P1 scn 50 50 100 100 re f Q",
        resources="/Pattern << /P1 5 0 R >>",
        extra_objects=[tiling_pattern(step=step)],
    )
    paints = run_oracle(pdf)["pages"][0]["paints"]
    # Its clip is its box: MuPDF clips to the filled shape before it draws the cell (§17).
    assert paints == [
        {"kind": "pattern", "bbox": [60, 150, 150, 240], "rgb": None, "alpha": 1.0, "evenOdd": False,
         "clip": [60, 150, 150, 240], **PLAIN}
    ]


@pytest.mark.parametrize("step", [10, 1000], ids=["tile", "direct"])
def test_tiling_fill_alpha_is_the_fill_alpha(tmp_path, step):
    pdf = tmp_path / "pattern_alpha.pdf"
    build_pdf(
        pdf,
        b"/GS1 gs /Pattern cs /P1 scn 0 0 1 RG 50 50 100 100 re B",
        resources="/Pattern << /P1 5 0 R >> /ExtGState << /GS1 6 0 R >>",
        extra_objects=[tiling_pattern(step=step), b"<< /Type /ExtGState /ca 0.5 /CA 0.25 >>"],
    )
    paints = run_oracle(pdf)["pages"][0]["paints"]
    assert [(p["kind"], p["bbox"], p["alpha"]) for p in paints] == [
        ("pattern", [50, 150, 150, 250], 0.5),
        ("stroke", [50, 150, 150, 250], 0.25),
    ]


def test_tiling_cell_contents_are_not_paints(tmp_path):
    pdf = tmp_path / "cells.pdf"
    # Each cell paints two squares, an image and a glyph: pattern data, not page content.
    # The first fill is wider than the step (begin_tile..end_tile); the second lies inside
    # one cell, so MuPDF draws that cell's content directly onto the page.
    cell = b"1 0 0 rg 0 0 5 5 re f 0 0 1 rg 5 5 5 5 re f q 4 0 0 4 5 0 cm /Im1 Do Q BT /F1 4 Tf 1 6 Td (X) Tj ET"
    build_pdf(
        pdf,
        b"/Pattern cs /P1 scn 50 50 100 100 re f 202 202 5 5 re f 0 1 0 rg 200 200 50 50 re f",
        resources="/Pattern << /P1 5 0 R >>",
        extra_objects=[
            tiling_pattern(cell, resources=b"<< /Font << /F1 6 0 R >> /XObject << /Im1 7 0 R >> >>"),
            HELVETICA,
            GREY_IMAGE,
        ],
    )
    inv = run_oracle(pdf)["pages"][0]
    assert [(p["kind"], p["rgb"], p["bbox"]) for p in inv["paints"]] == [
        ("pattern", None, [50, 150, 150, 250]),
        ("pattern", None, [202, 93, 207, 98]),
        ("fill", [0, 255, 0], [200, 50, 250, 100]),
    ]
    assert inv["glyphs"] == []


def test_tiling_filled_text_and_image_mask_yield_one_pattern_paint_each(tmp_path):
    pdf = tmp_path / "pattern_text_mask.pdf"
    build_text_pdf(
        pdf,
        fill_colour_ops("tiling")
        + b" BT /F1 24 Tf 50 100 Td (AB) Tj ET q 30 0 0 20 200 200 cm BI /IM true /W 2 /H 2 /BPC 1 ID \x40\x20 EI Q",
        "tiling",
    )
    inv = run_oracle(pdf)["pages"][0]
    assert "".join(g["u"] for g in inv["glyphs"]) == "AB"  # the glyphs still count (§6)
    assert [p["kind"] for p in inv["paints"]] == ["pattern", "pattern"]
    text, mask = inv["paints"]
    x0, y0, x1, y1 = text["bbox"]  # the text's own bounds (MuPDF's text clip), not the page
    assert 45 <= x0 < x1 <= 90 and 175 <= y0 < y1 <= 205
    assert mask["bbox"] == [200, 80, 230, 100]  # the unit square under the CTM
    assert all(p["rgb"] is None and p["alpha"] == 1.0 and p["evenOdd"] is False for p in inv["paints"])
    assert all("approx" not in p for p in inv["paints"])  # only the walker marks approximate bboxes


@functools.lru_cache(maxsize=None)
def oracle_module():
    """The oracle module itself, loaded from its file (the tests otherwise run it as a CLI)."""
    spec = importlib.util.spec_from_file_location("mupdf_inventory_under_test", ORACLE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def tile_draws(pdf):
    """(begin_tile calls, cells drawn straight onto the page) MuPDF makes on page 1.

    The page runs through the oracle's own device (MuPDF draws differently for a
    device without clip methods) with the cells marked as the oracle marks them,
    so a cell drawn onto the page shows up as one TILE_MARKER outside a tile.
    """
    oracle = oracle_module()

    class Counter(oracle.InventoryDevice):
        def __init__(self, page_box):
            super().__init__(page_box)
            self.tiles = self.direct = 0

        def begin_tile(self, ctx, *args):
            self.tiles += self._recording
            return super().begin_tile(ctx, *args)

        def begin_metatext(self, ctx, meta, text):
            self.direct += text == oracle.TILE_MARKER and self._recording
            super().begin_metatext(ctx, meta, text)

    doc = pymupdf.open(pdf)
    oracle.mark_tiling_cells(doc)
    page = doc[0]
    dev = Counter((0.0, 0.0, page.rect.width, page.rect.height))
    oracle.m.fz_run_page_contents(page.this, dev, oracle.m.FzMatrix(), oracle.m.FzCookie())
    return dev.tiles, dev.direct


# Contract §9: a fill no wider than XStep and no taller than YStep gets no begin_tile;
# MuPDF draws every cell its area overlaps straight onto the page (here 2 or 4 cells).
# It is still one pattern paint. Step 10 at the page origin for paths, step 50 for the
# image mask and the text.
@pytest.mark.parametrize(
    "step, content, cells, bbox",
    [
        (10, b"5 1 10 8 re f", 2, [5, 291, 15, 299]),
        (10, b"5 5 10 10 re f", 4, [5, 285, 15, 295]),
        (50, b"q 30 0 0 20 40 40 cm BI /IM true /W 2 /H 2 /BPC 1 ID \x40\x20 EI Q", 4, [40, 240, 70, 260]),
    ],
    ids=["path-2-cells", "path-4-cells", "image-mask-4-cells"],
)
def test_direct_tiling_fill_over_several_cells_yields_one_pattern_paint(tmp_path, step, content, cells, bbox):
    pdf = tmp_path / "direct_cells.pdf"
    build_pdf(
        pdf,
        b"/Pattern cs /P1 scn " + content,
        resources="/Pattern << /P1 5 0 R >>",
        extra_objects=[tiling_pattern(step=step)],
    )
    assert tile_draws(pdf) == (0, cells)
    paints = run_oracle(pdf)["pages"][0]["paints"]
    assert paints == [{"kind": "pattern", "bbox": bbox, "rgb": None, "alpha": 1.0, "evenOdd": False, "clip": bbox, **PLAIN}]


def test_direct_tiling_filled_text_over_several_cells_yields_one_pattern_paint(tmp_path):
    pdf = tmp_path / "direct_text.pdf"
    # "AB" at 24 pt from (40, 90) spans about x 39-72, y 89-109: across x 50 and y 100.
    build_pdf(
        pdf,
        b"/Pattern cs /P1 scn BT /F1 24 Tf 40 90 Td (AB) Tj ET",
        resources="/Pattern << /P1 5 0 R >> /Font << /F1 6 0 R >>",
        extra_objects=[tiling_pattern(step=50), HELVETICA],
    )
    assert tile_draws(pdf) == (0, 4)
    inv = run_oracle(pdf)["pages"][0]
    assert "".join(g["u"] for g in inv["glyphs"]) == "AB"
    assert [p["kind"] for p in inv["paints"]] == ["pattern"]
    x0, y0, x1, y1 = inv["paints"][0]["bbox"]  # the text's own bounds
    assert 35 <= x0 < 50 < x1 <= 80 and 185 <= y0 < 200 < y1 <= 215


def test_mupdf_diagnostics_do_not_pollute_stdout(tmp_path):
    pdf = tmp_path / "noisy.pdf"
    build_pdf(pdf, b"1 0 0 rg 0 0 10 10 re f /Missing Do foo bar")
    res = subprocess.run([sys.executable, str(ORACLE), str(pdf)], capture_output=True, check=True)
    inv = json.loads(res.stdout.decode("utf-8"))  # raises if MuPDF messages leaked into stdout
    assert [p["kind"] for p in inv["pages"][0]["paints"]] == ["fill"]
    assert b"MuPDF" in res.stderr


def test_image_bbox_is_unit_square_under_ctm(tmp_path):
    pdf = tmp_path / "img.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=300)
    pix = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, 8, 8), False)
    pix.clear_with(200)
    page.insert_image(pymupdf.Rect(30, 40, 130, 90), pixmap=pix, keep_proportion=False)
    doc.save(pdf)
    paints = run_oracle(pdf)["pages"][0]["paints"]
    assert [p["kind"] for p in paints] == ["image"]
    assert paints[0]["bbox"] == [30, 40, 130, 90]
    assert paints[0]["rgb"] is None and paints[0]["evenOdd"] is False


# --------------------------------------------------------------------------
# Images and shadings, docs/decisions/0002-inventory-contract.md §16
# --------------------------------------------------------------------------


def image_object(width, height, data, entries=b"/ColorSpace /DeviceGray /BitsPerComponent 8"):
    return stream_object(
        b"/Type /XObject /Subtype /Image /Width %d /Height %d " % (width, height) + entries, data
    )


GRAY_IMAGE = image_object(3, 2, bytes(range(6)))  # 3 x 2
STENCIL = image_object(8, 8, bytes(8), b"/ImageMask true /BitsPerComponent 1")  # 8 x 8
ONE_PIXEL = image_object(1, 1, b"\x00", b"/ImageMask true /BitsPerComponent 1")
IMAGE_RESOURCES = "/XObject << /Im1 5 0 R /Im2 6 0 R /Im3 7 0 R >>"


def image_paints(tmp_path, content, resources=IMAGE_RESOURCES):
    pdf = tmp_path / "image.pdf"
    build_pdf(pdf, content, resources=resources, extra_objects=[GRAY_IMAGE, STENCIL, ONE_PIXEL])
    return run_oracle(pdf)["pages"][0]["paints"]


def test_an_image_carries_its_matrix_in_the_pdfs_orientation_and_its_pixel_size(tmp_path):
    paints = image_paints(
        tmp_path,
        b"q 60 0 0 40 20 30 cm /Im1 Do Q q 0 50 -30 0 200 100 cm /Im1 Do Q q -60 0 0 -40 100 280 cm /Im1 Do Q",
    )
    # The slide frame has y down: the PDF's unit square starts at the image's bottom left corner, its y axis up.
    assert [p["ctm"] for p in paints] == [
        [60, 0, 0, -40, 20, 270],
        [0, -50, -30, 0, 200, 200],
        [-60, 0, 0, 40, 100, 20],
    ]
    assert all(p["px"] == [3, 2] and p["stencil"] is False and p["rgb"] is None for p in paints)
    assert [p["bbox"] for p in paints] == [[20, 230, 80, 270], [170, 150, 200, 200], [40, 20, 100, 60]]


def test_mupdf_hands_an_image_over_with_its_y_axis_flipped(tmp_path):
    """The reason the oracle undoes a flip: the device's matrix puts the image's top left corner at the origin."""
    pdf = tmp_path / "flip.pdf"
    build_pdf(
        pdf, b"q 60 0 0 40 20 30 cm /Im1 Do Q 0 0 1 rg q 60 0 0 40 20 30 cm /Im2 Do Q",
        resources=IMAGE_RESOURCES, extra_objects=[GRAY_IMAGE, STENCIL],
    )
    import pymupdf.mupdf as mupdf

    class Recorder(mupdf.FzDevice2):
        def __init__(self):
            super().__init__()
            self.use_virtual_fill_image()
            self.use_virtual_fill_image_mask()
            self.matrices = []

        def fill_image(self, ctx, image, ctm, alpha, color_params):
            self.matrices.append((ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f))

        def fill_image_mask(self, ctx, image, ctm, colorspace, color, alpha, color_params):
            self.matrices.append((ctm.a, ctm.b, ctm.c, ctm.d, ctm.e, ctm.f))

    device = Recorder()
    mupdf.fz_run_page_contents(pymupdf.open(pdf)[0].this, device, mupdf.FzMatrix(), mupdf.FzCookie())
    assert device.matrices == [(60, 0, 0, 40, 20, 230)] * 2  # the PDF's (60, 0, 0, -40, 20, 270), flipped back


def test_an_image_in_the_slide_frame_of_a_rotated_page(tmp_path):
    pdf = tmp_path / "rot.pdf"
    build_pdf(
        pdf, b"q 60 0 0 40 20 30 cm /Im1 Do Q", resources=IMAGE_RESOURCES, extra_objects=[GRAY_IMAGE],
        media_box="0 0 300 200",
    )
    upright = run_oracle(pdf)["pages"][0]["paints"][0]
    doc = pymupdf.open(pdf)
    doc[0].set_rotation(90)
    doc.save(tmp_path / "rot90.pdf")
    turned = run_oracle(tmp_path / "rot90.pdf")["pages"][0]["paints"][0]
    assert upright["ctm"] == [60, 0, 0, -40, 20, 170]
    # A quarter turn clockwise: (x, y) -> (200 - y, x) for the points of the unrotated slide frame.
    assert turned["ctm"] == [0, 60, 40, 0, 30, 20]
    assert turned["px"] == [3, 2]


def test_an_inline_image_has_its_pixel_size_and_an_inline_stencil_its_colour(tmp_path):
    paints = image_paints(
        tmp_path,
        b"q 40 0 0 40 10 10 cm BI /W 2 /H 2 /CS /G /BPC 8 ID abcd EI Q "
        b"0 0 1 rg q 30 0 0 30 10 100 cm BI /W 8 /H 8 /IM true /BPC 1 ID UUUUUUUU EI Q",
    )
    assert [(p["px"], p["stencil"], p["rgb"]) for p in paints] == [([2, 2], False, None), ([8, 8], True, [0, 0, 255])]


def test_a_stencil_has_the_fill_colour_and_alpha_and_other_images_have_no_colour(tmp_path):
    paints = image_paints(
        tmp_path,
        b"1 0 0 rg q 60 0 0 40 20 30 cm /Im2 Do Q 0 0.5 1 rg q /GS1 gs 30 0 0 30 120 30 cm /Im2 Do Q "
        b"0.2 0.4 0.6 rg q 40 0 0 40 150 200 cm /Im2 Do Q 0 0 0 rg q 40 0 0 40 20 100 cm /Im1 Do Q "
        b"0 1 0 rg q 20 0 0 20 200 200 cm /Im3 Do Q",
        resources=IMAGE_RESOURCES + " /ExtGState << /GS1 << /ca 0.5 >> >>",
    )
    assert [(p["rgb"], p["alpha"], p["stencil"], p["px"]) for p in paints] == [
        ([255, 0, 0], 1, True, [8, 8]),
        ([0, 128, 255], 0.5, True, [8, 8]),
        ([51, 102, 153], 1, True, [8, 8]),
        (None, 1, False, [3, 2]),
        ([0, 255, 0], 1, True, [1, 1]),
    ]


def test_an_image_has_its_own_pixel_size_not_that_of_its_soft_mask(tmp_path):
    pdf = tmp_path / "smask.pdf"
    build_pdf(
        pdf,
        b"q 20 0 0 20 100 100 cm /Im1 Do Q",
        resources="/XObject << /Im1 5 0 R >>",
        extra_objects=[
            image_object(2, 2, b"\x10\x20\x30\x40", b"/ColorSpace /DeviceGray /BitsPerComponent 8 /SMask 6 0 R"),
            image_object(4, 4, bytes(range(16))),
        ],
    )
    paints = run_oracle(pdf)["pages"][0]["paints"]
    assert [(p["kind"], p["px"]) for p in paints] == [("image", [2, 2])]


def test_a_pattern_coloured_stencil_is_not_an_image(tmp_path):
    pdf = tmp_path / "pattern-stencil.pdf"
    build_pdf(
        pdf,
        b"/Pattern cs /P1 scn q 40 0 0 40 20 100 cm /Im1 Do Q",
        resources="/XObject << /Im1 5 0 R >> /Pattern << /P1 7 0 R >>",
        extra_objects=[STENCIL, AXIAL_SHADING, SHADING_PATTERN],
    )
    paints = run_oracle(pdf)["pages"][0]["paints"]
    assert [(p["kind"], p.get("stencil"), p.get("shading")) for p in paints] == [("shade", None, "axial")]


def test_detail_false_leaves_the_image_and_shading_fields_out_and_keeps_a_stencils_rgb_null(tmp_path):
    """The fidelity harness reads only the kind and the bbox of an image or a shade: what it gets did not change."""
    pdf = tmp_path / "bare.pdf"
    build_pdf(
        pdf,
        b"1 0 0 rg q 60 0 0 40 20 30 cm /Im1 Do Q q 60 0 0 40 20 130 cm /Im2 Do Q /Sh1 sh",
        resources="/XObject << /Im1 5 0 R /Im2 6 0 R >> /Shading << /Sh1 7 0 R >>",
        extra_objects=[STENCIL, GRAY_IMAGE, AXIAL_SHADING],
    )
    oracle = oracle_module()
    full = oracle.inventory(str(pdf))["pages"][0]["paints"]
    bare = oracle.inventory(str(pdf), detail=False)["pages"][0]["paints"]
    assert [sorted(p) for p in bare] == [["alpha", "bbox", "evenOdd", "kind", "rgb"]] * 3
    assert [p["rgb"] for p in bare] == [None, None, None]
    assert [sorted(set(p) - set(SCENE_KEYS)) for p in full] == [
        ["alpha", "bbox", "ctm", "evenOdd", "kind", "px", "rgb", "stencil"],
        ["alpha", "bbox", "ctm", "evenOdd", "kind", "px", "rgb", "stencil"],
        ["alpha", "bbox", "evenOdd", "kind", "rgb", "shading"],
    ]
    assert full[0]["rgb"] == [255, 0, 0]
    dropped = [{k: v for k, v in p.items() if k not in ("ctm", "px", "stencil", "shading", *SCENE_KEYS)} for p in full]
    assert [{**p, "rgb": None} for p in dropped] == bare


def mesh_shading(kind):
    """The data of a shading of type 4 to 7, which decodes to x 40..140, y 50..110; the patch types reach out to those edges."""
    def be16(*values):
        return b"".join(struct.pack(">H", v) for v in values)

    top = 65535
    patch = [10000, 20000, 0, 30000, 0, 40000, 10000, 50000, 20000, top, 40000, top, 50000, 50000,
             top, 40000, top, 30000, 50000, 20000, 40000, 0, 20000, 0]
    data = {
        4: b"\x00" + be16(0, 0) + b"\x00" + b"\x00" + be16(top, 0) + b"\x80" + b"\x00" + be16(0, top) + b"\xff",
        5: be16(0, 0) + b"\x00" + be16(top, 0) + b"\x5a" + be16(0, top) + b"\xb4" + be16(top, top) + b"\xff",
        6: b"\x00" + be16(*patch) + b"\x00\x50\xa0\xff",
        7: b"\x00" + be16(*patch, 20000, 20000, 20000, 40000, 40000, 40000, 40000, 20000) + b"\x00\x50\xa0\xff",
    }[kind]
    extra = b"/BitsPerFlag 8 " if kind != 5 else b"/VerticesPerRow 2 "
    return stream_object(
        b"/ShadingType %d %s/ColorSpace /DeviceGray /BitsPerCoordinate 16 /BitsPerComponent 8 "
        b"/Decode [40 140 50 110 0 1]" % (kind, extra),
        data,
    )


SHADING_OBJECTS = {
    "function": [
        b"<< /ShadingType 1 /ColorSpace /DeviceGray /Domain [0 1 0 1] /Matrix [100 0 0 50 20 30] /Function 6 0 R >>",
        stream_object(b"/FunctionType 4 /Domain [0 1 0 1] /Range [0 1]", b"{ add 2 div }"),
    ],
    "axial": [AXIAL_SHADING],
    "radial": [
        b"<< /ShadingType 3 /ColorSpace /DeviceGray /Coords [100 100 0 100 100 50] "
        b"/Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >>"
    ],
    **{f"mesh{n}": [mesh_shading(n)] for n in (4, 5, 6, 7)},
}


@pytest.mark.parametrize("kind", list(SHADING_OBJECTS))
def test_a_shade_says_what_kind_of_shading_it_is(tmp_path, kind):
    pdf = tmp_path / "kind.pdf"
    build_pdf(pdf, b"/Sh1 sh", resources="/Shading << /Sh1 5 0 R >>", extra_objects=SHADING_OBJECTS[kind])
    shade = run_oracle(pdf)["pages"][0]["paints"][0]
    assert shade["kind"] == "shade"
    assert shade["shading"] == kind.rstrip("456789") and "ctm" not in shade


def test_a_shading_pattern_says_it_too(tmp_path):
    pdf = tmp_path / "pattern-kind.pdf"
    build_pdf(
        pdf,
        b"/Pattern cs /P1 scn 10 10 100 100 re f /Pattern CS /P1 SCN 4 w 10 150 100 100 re S "
        b"BT /F1 30 Tf 30 250 Td (AB) Tj ET",
        resources="/Pattern << /P1 7 0 R >> /Font << /F1 5 0 R >>",
        extra_objects=[HELVETICA, SHADING_OBJECTS["radial"][0], b"<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>"],
    )
    assert [(p["kind"], p["shading"]) for p in run_oracle(pdf)["pages"][0]["paints"]] == [("shade", "radial")] * 3


SOFT_MASK_OBJECTS = [
    mesh_shading(4),  # 5: /Sh1, bounded by its vertices: x 40..140, y 50..110
    b"<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 7 0 R >> >>",  # 6: /GS1
    stream_object(
        b"/Type /XObject /Subtype /Form /BBox [20 30 220 130] /Group << /S /Transparency /CS /DeviceGray >> "
        b"/Resources << >>",
        b"0.5 g 0 0 300 300 re f",
    ),  # 7: what the mask is made of
    b"<< /Type /ExtGState /SMask /None >>",  # 8: /GS2
    b"<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 300 0] /BBox [100 60 160 120] /Extend [true true] "
    b"/Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >>",  # 9: /Sh2, bounded by its /BBox
    stream_object(
        b"/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency >> "
        b"/Resources << /Shading << /Sh1 5 0 R >> >>",
        b"/Sh1 sh",
    ),  # 10: /Fm1, a transparency group
    stream_object(
        b"/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Shading << /Sh1 5 0 R >> >>",
        b"/Sh1 sh",
    ),  # 11: /Fm2
]
SOFT_MASK_RESOURCES = (
    "/Shading << /Sh1 5 0 R /Sh2 9 0 R >> /ExtGState << /GS1 6 0 R /GS2 8 0 R >> "
    "/XObject << /Fm1 10 0 R /Fm2 11 0 R >>"
)


def test_a_bounded_sh_under_a_soft_mask_is_bounded_by_the_shading(tmp_path):
    """MuPDF clips what a soft mask touches to that object's bounds (§10): only a shading with bounds of its own narrows it."""
    pdf = tmp_path / "bounded.pdf"
    contents = [
        b"/Sh1 sh",  # no mask: the page
        b"/GS1 gs /Sh1 sh",  # a mesh: its vertices, and not the mask's /BBox (20 30 220 130)
        b"/GS1 gs /Sh2 sh",  # a /BBox
        b"/GS1 gs /GS2 gs /Sh1 sh",  # /SMask /None
        b"q /GS1 gs Q /Sh1 sh",  # Q
        b"/GS1 gs /Fm1 Do",  # a transparency group form takes the mask for itself: nothing inside is masked
        b"/GS1 gs /Fm2 Do",  # a form that is none passes it to what is inside
        b"q 60 60 50 50 re W n /GS1 gs /Sh1 sh Q",  # and the clip
        b"q 0.8 0.6 -0.6 0.8 50 20 cm /GS1 gs /Sh1 sh Q",  # a turned CTM: the box of the box
    ]
    boxes = []
    for number, content in enumerate(contents):
        build_pdf(pdf, content, resources=SOFT_MASK_RESOURCES, extra_objects=SOFT_MASK_OBJECTS)
        paints = run_oracle(pdf)["pages"][0]["paints"]
        assert [p["kind"] for p in paints] == ["shade"], number
        boxes.append(paints[0]["bbox"])
    assert boxes == [
        [0, 0, 300, 300],
        [40, 190, 140, 250],
        [100, 180, 160, 240],
        [0, 0, 300, 300],
        [0, 0, 300, 300],
        [0, 0, 300, 300],
        [40, 190, 140, 250],
        [60, 190, 110, 240],
        [16, 108, 132, 216],
    ]


def test_text_glyphs_once_each_and_utf8(tmp_path):
    pdf = tmp_path / "text.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=200)
    page.insert_text((50, 100), "AB", fontsize=20, render_mode=2, color=(1, 0, 0), fill=(0, 0, 1))  # fill+stroke
    page.insert_text((50, 150), "한국어 AB", fontsize=20, fontname="korea")
    page.insert_text((50, 180), "hidden", fontsize=20, render_mode=3)  # invisible text is not a glyph
    doc.save(pdf)
    glyphs = run_oracle(pdf)["pages"][0]["glyphs"]
    assert "".join(g["u"] for g in glyphs[:2]) == "AB"
    assert [g["y"] for g in glyphs[:2]] == [100, 100]
    assert [g["x"] for g in glyphs[:1]] == [50]
    assert "".join(g["u"] for g in glyphs[2:]) == "한국어 AB"  # whitespace glyph is kept in the output
    assert all(g["y"] == 150 for g in glyphs[2:])


# --------------------------------------------------------------------------
# Inventory contract, docs/decisions/0002-inventory-contract.md: §3 page
# contents only, §4 path bbox (control points), §7 no clip culling, §6 glyphs
# (every visible text run), §5 shade bbox (clip stack)
# --------------------------------------------------------------------------

HELVETICA = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
SHADING_PATTERN = b"<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>"
TILING_PATTERN = stream_object(
    b"/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] "
    b"/XStep 10 /YStep 10 /Resources << >>",
    b"1 0 0 rg 0 0 5 5 re f",
)


def build_text_pdf(path, content, fill="solid"):
    """One page with Helvetica as /F1; fill 'shading'/'tiling' defines /P1 as that pattern."""
    objects = {
        "solid": ([HELVETICA], ""),
        "shading": ([HELVETICA, AXIAL_SHADING, SHADING_PATTERN], "/Pattern << /P1 7 0 R >>"),
        "tiling": ([HELVETICA, TILING_PATTERN], "/Pattern << /P1 6 0 R >>"),
    }[fill]
    build_pdf(path, content, resources="/Font << /F1 5 0 R >> " + objects[1], extra_objects=objects[0])


def fill_colour_ops(fill):
    return b"1 0 0 rg" if fill == "solid" else b"/Pattern cs /P1 scn"


def test_annotations_are_not_part_of_the_inventory(tmp_path):
    pdf = tmp_path / "annots.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=300, height=300)
    page.draw_rect(pymupdf.Rect(10, 10, 50, 50), color=None, fill=(0, 1, 0))
    page.insert_text((50, 250), "hello", fontsize=14)
    rect_annot = page.add_rect_annot(pymupdf.Rect(100, 100, 200, 150))
    rect_annot.set_colors(stroke=(1, 0, 0), fill=(0, 0, 1))
    rect_annot.update()
    highlight = page.add_highlight_annot(page.search_for("hello")[0])
    highlight.update()
    for annot in (rect_annot, highlight):  # both really carry an appearance stream
        assert doc.xref_get_key(annot.xref, "AP/N")[0] == "xref"
    doc.save(pdf)
    inv = run_oracle(pdf)["pages"][0]
    # Only the page content: the green square. No red/blue rectangle, no yellow highlight.
    assert [(p["kind"], p["rgb"], p["bbox"]) for p in inv["paints"]] == [("fill", [0, 255, 0], [10, 10, 50, 50])]
    assert "".join(g["u"] for g in inv["glyphs"]) == "hello"


def test_bezier_fill_bbox_includes_control_points(tmp_path):
    pdf = tmp_path / "bezier.pdf"
    # The curve peaks at y=125 (PDF), but its control points reach y=150.
    build_pdf(pdf, b"0 0 1 rg 50 50 m 50 150 200 150 200 50 c f")
    paint = run_oracle(pdf)["pages"][0]["paints"][0]
    assert paint["bbox"] == [50, 150, 200, 250]  # slide frame: y = 300 - 150 .. 300 - 50


def test_glyph_outside_the_current_clip_is_still_reported(tmp_path):
    pdf = tmp_path / "clipped.pdf"
    build_text_pdf(pdf, b"q 0 0 10 10 re W n BT /F1 24 Tf 100 100 Td (A) Tj ET Q")
    inv = run_oracle(pdf)["pages"][0]
    assert [(g["u"], g["x"], g["y"]) for g in inv["glyphs"]] == [("A", 100, 200)]
    assert inv["paints"] == []


def test_empty_clip_intersection_is_all_zero_box(tmp_path):
    pdf = tmp_path / "disjoint.pdf"
    build_pdf(
        pdf,
        b"q 0 0 10 10 re W n 100 100 10 10 re W n /Sh1 sh Q",
        resources="/Shading << /Sh1 5 0 R >>",
        extra_objects=[AXIAL_SHADING],
    )
    assert [p["bbox"] for p in run_oracle(pdf)["pages"][0]["paints"]] == [[0, 0, 0, 0]]


@pytest.mark.parametrize("fill", ["solid", "shading", "tiling"])
@pytest.mark.parametrize("mode", [0, 1, 2, 4, 5, 6, 7])
def test_every_visible_text_run_yields_its_glyphs_exactly_once(tmp_path, mode, fill):
    pdf = tmp_path / "text.pdf"
    content = fill_colour_ops(fill) + b" 0 0 1 RG %d Tr BT /F1 24 Tf 50 100 Td (AB) Tj ET" % mode
    build_text_pdf(pdf, content, fill)
    glyphs = run_oracle(pdf)["pages"][0]["glyphs"]
    assert [g["u"] for g in glyphs] == ["A", "B"]
    assert [g["x"] for g in glyphs] == [50, 66.008]
    assert [g["y"] for g in glyphs] == [200, 200]


def test_invisible_text_is_not_a_glyph(tmp_path):
    pdf = tmp_path / "invisible.pdf"
    build_text_pdf(pdf, b"3 Tr BT /F1 24 Tf 50 100 Td (AB) Tj ET")
    page = run_oracle(pdf)["pages"][0]
    assert page["glyphs"] == []
    assert page["invisible"] == [
        {"u": "A", "x": 50, "y": 200, "font": "Helvetica"},
        {"u": "B", "x": 66.008, "y": 200, "font": "Helvetica"},
    ]


def test_shading_filled_text_keeps_glyphs_and_shade_paint(tmp_path):
    pdf = tmp_path / "shaded_text.pdf"
    build_text_pdf(pdf, fill_colour_ops("shading") + b" BT /F1 24 Tf 50 100 Td (AB) Tj ET", "shading")
    inv = run_oracle(pdf)["pages"][0]
    assert "".join(g["u"] for g in inv["glyphs"]) == "AB"
    assert [p["kind"] for p in inv["paints"]] == ["shade"]
    x0, y0, x1, y1 = inv["paints"][0]["bbox"]  # the text's own bounds, not the page
    assert 45 <= x0 < x1 <= 90 and 175 <= y0 < y1 <= 205


def test_adjacent_runs_with_different_render_modes_are_both_reported(tmp_path):
    pdf = tmp_path / "adjacent.pdf"
    build_text_pdf(pdf, b"1 0 0 rg 0 0 1 RG BT /F1 24 Tf 50 100 Td 0 Tr (A) Tj 1 Tr (B) Tj 7 Tr (C) Tj ET")
    assert "".join(g["u"] for g in run_oracle(pdf)["pages"][0]["glyphs"]) == "ABC"


def test_text_drawn_twice_at_the_same_place_is_reported_twice(tmp_path):
    pdf = tmp_path / "twice.pdf"
    build_text_pdf(pdf, b"1 0 0 rg BT /F1 24 Tf 50 100 Td (A) Tj ET BT /F1 24 Tf 50 100 Td (A) Tj ET")
    assert "".join(g["u"] for g in run_oracle(pdf)["pages"][0]["glyphs"]) == "AA"


# --------------------------------------------------------------------------
# Inventory contract, docs/decisions/0002-inventory-contract.md: §14 path
# geometry, §15 line style (and strokes with a pattern)
# --------------------------------------------------------------------------


def first_paints(tmp_path, content, resources="", extra_objects=(), media_box="0 0 300 300"):
    pdf = tmp_path / "page.pdf"
    build_pdf(pdf, content, resources=resources, media_box=media_box, extra_objects=extra_objects)
    return run_oracle(pdf)["pages"][0]["paints"]


def test_fill_and_stroke_carry_their_path_in_the_slide_frame(tmp_path):
    paints = first_paints(tmp_path, b"10 20 30 40 re f 10 20 m 30 40 50 60 70 80 c S")
    assert paints[0]["path"] == [["M", 10, 280], ["L", 40, 280], ["L", 40, 240], ["L", 10, 240], ["Z"]]
    assert paints[1]["path"] == [["M", 10, 280], ["C", 30, 260, 50, 240, 70, 220]]


def test_path_follows_the_ctm_and_expands_v_and_y(tmp_path):
    paints = first_paints(tmp_path, b"2 0 0 2 0 0 cm 10 20 m 30 40 50 60 v 70 80 90 100 y S")
    assert paints[0]["path"] == [
        ["M", 20, 260],
        ["C", 20, 260, 60, 220, 100, 180],
        ["C", 140, 140, 180, 100, 180, 100],
    ]


def test_mupdf_normalises_the_path_as_the_contract_says(tmp_path):
    """§14: what fz_moveto, fz_lineto, fz_curveto and fz_closepath do to a path, as the oracle sees it."""

    def path(content):
        return first_paints(tmp_path, content)[0]["path"]

    assert path(b"10 10 m 20 20 m 30 30 l S") == [["M", 20, 280], ["L", 30, 270]]
    assert path(b"10 10 m 20 20 l 20 20 l S") == [["M", 10, 290], ["L", 20, 280]]
    assert path(b"10 10 m 10 10 l S") == [["M", 10, 290], ["L", 10, 290]]
    assert path(b"10 10 m 20 20 l h h S") == [["M", 10, 290], ["L", 20, 280], ["Z"]]
    assert path(b"10 10 m 20 20 l h 10 10 l S") == [["M", 10, 290], ["L", 20, 280], ["Z"]]
    assert path(b"10 10 m 20 20 l h 30 30 l S") == [["M", 10, 290], ["L", 20, 280], ["Z"], ["L", 30, 270]]
    assert path(b"10 10 m 30 30 30 30 30 30 c S") == [["M", 10, 290], ["L", 30, 270]]
    assert path(b"10 10 m 10 10 30 30 30 30 c S") == [["M", 10, 290], ["L", 30, 270]]
    assert path(b"10 10 m 10 10 20 20 30 30 c S") == [["M", 10, 290], ["C", 10, 290, 20, 280, 30, 270]]
    assert path(b"20 20 l 40 40 m 50 50 l S") == [["M", 40, 260], ["L", 50, 250]]
    # A trailing moveTo stays in fz_path: the comparison's canonicalPath drops it on both sides.
    assert path(b"10 10 m 20 20 l 30 30 m S") == [["M", 10, 290], ["L", 20, 280], ["M", 30, 270]]
    # An empty rectangle is four corners here; pdf.js writes moveTo, lineTo, close (canonicalPath, §14).
    assert path(b"10 20 0 40 re f") == [["M", 10, 280], ["L", 10, 280], ["L", 10, 240], ["L", 10, 240], ["Z"]]
    # fz_curvetov leaves a stray curve behind the line; canonicalPath drops it.
    assert path(b"10 10 m 30 30 30 30 v S") == [["M", 10, 290], ["L", 30, 270], ["C", 30, 270, 30, 270, 30, 270]]
    # Nothing before the first moveTo.
    assert first_paints(tmp_path, b"20 20 l 30 30 l S") == []


def test_closed_moveto_counts_only_under_a_ctm_that_keeps_the_axes(tmp_path):
    # §4: the moveTo of "m h" is in the box under a scale, not under a turn; alone under a turn, it is no paint at all.
    assert first_paints(tmp_path, b"50 50 m h 10 10 m 20 20 l S")[0]["bbox"] == [10, 250, 50, 290]
    turned = first_paints(tmp_path, b"0.8 0.6 -0.6 0.8 100 0 cm 50 50 m h 10 10 m 20 20 l S")
    assert turned[0]["bbox"] == [102, 272, 104, 286]
    assert turned[0]["path"] == [["M", 110, 230], ["Z"], ["M", 102, 286], ["L", 104, 272]]
    assert first_paints(tmp_path, b"0.8 0.6 -0.6 0.8 100 0 cm 50 50 m h S") == []


def test_stroke_carries_its_line_style_in_slide_frame_points(tmp_path):
    paints = first_paints(tmp_path, b"10 10 m 20 20 l S 2 0 0 8 0 0 cm 3 w 1 J 2 j 4 M [1 2] 0.5 d 1 1 m 2 2 l S")
    assert paints[0]["line"] == {"w": 1, "cap": 0, "join": 0, "miter": 10, "dash": [], "phase": 0}
    assert paints[1]["line"] == {"w": 12, "cap": 1, "join": 2, "miter": 4, "dash": [4, 8], "phase": 2}


def test_line_style_from_a_graphics_state_dictionary(tmp_path):
    paints = first_paints(
        tmp_path,
        b"/G gs 10 10 m 20 20 l S",
        resources="/ExtGState << /G << /LW 3 /LC 1 /LJ 2 /ML 7 /D [[4 2] 1] >> >>",
    )
    assert paints[0]["line"] == {"w": 3, "cap": 1, "join": 2, "miter": 7, "dash": [4, 2], "phase": 1}


def test_a_fill_has_no_line(tmp_path):
    assert "line" not in first_paints(tmp_path, b"10 10 20 20 re f")[0]


def test_detail_false_leaves_out_path_and_line_and_keeps_everything_else(tmp_path):
    pdf = tmp_path / "detail.pdf"
    build_text_pdf(pdf, b"1 0 0 rg 10 10 20 20 re B BT /F1 24 Tf 50 100 Td (AB) Tj ET")
    oracle = oracle_module()
    full = oracle.inventory(str(pdf))["pages"][0]
    bare = oracle.inventory(str(pdf), detail=False)["pages"][0]
    assert [sorted(p) for p in bare["paints"]] == [["alpha", "bbox", "evenOdd", "kind", "rgb"]] * 2
    assert sorted(full["paints"][0]) == sorted(["alpha", "bbox", "evenOdd", "kind", "path", "rgb", *SCENE_KEYS])
    assert sorted(full["paints"][1]) == sorted(["alpha", "bbox", "evenOdd", "kind", "line", "path", "rgb", *SCENE_KEYS])
    dropped = [{k: v for k, v in p.items() if k not in ("path", "line", *SCENE_KEYS)} for p in full["paints"]]
    assert dropped == bare["paints"]
    assert bare["glyphs"] == [
        {"u": "A", "x": 50, "y": 200},
        {"u": "B", "x": 66.008, "y": 200},
    ]
    assert [{k: g[k] for k in ("u", "x", "y")} for g in full["glyphs"]] == bare["glyphs"]
    assert "invisible" not in bare and full["invisible"] == []
    assert sorted(bare) == sorted(k for k in full if k != "invisible")


def test_detail_false_has_exactly_what_it_had_for_every_render_mode_and_a_type3_font(tmp_path):
    """The fidelity harness reads these: what it gets did not change with the glyph state (§6)."""
    pdf = tmp_path / "bare.pdf"
    build_pdf(
        pdf,
        b"BT /F1 20 Tf 30 250 Td 0 Tr (A) Tj 1 Tr (B) Tj 2 Tr (A) Tj 3 Tr (B) Tj 4 Tr (A) Tj 7 Tr (B) Tj ET",
        resources="/Font << /F1 5 0 R >>",
        extra_objects=[HELVETICA],
    )
    bare = oracle_module().inventory(str(pdf), detail=False)["pages"][0]
    assert all(sorted(g) == ["u", "x", "y"] for g in bare["glyphs"])
    assert "".join(g["u"] for g in bare["glyphs"]) == "ABAAB"
    assert sorted(bare) == ["glyphs", "index", "paints", "size"]
    # A Type 3 glyph MuPDF draws directly stays as it was: its paint and no glyph.
    build_type3_pdf(pdf, b"1 0 0 rg BT /F1 20 Tf 30 250 Td (AB) Tj ET", DIRECT_GLYPH)
    bare = oracle_module().inventory(str(pdf), detail=False)["pages"][0]
    assert [p["kind"] for p in bare["paints"]] == ["fill", "fill"]
    assert bare["glyphs"] == []


def test_fidelity_reads_the_oracle_without_detail():
    """The fidelity run does not pay for segments it never reads."""
    for name in ("pdf_facts.py", "roundtrip.py"):
        source = (REPO / "harness" / "fidelity" / name).read_text(encoding="utf-8")
        calls = [line for line in source.splitlines() if "inventory(str(" in line]
        assert calls and all("detail=False" in line for line in calls)


def pattern_resources(fill):
    """`resources` and `extra_objects` of a page whose /P1 is a shading or a tiling pattern."""
    if fill == "shading":
        return "/Pattern << /P1 6 0 R >>", [AXIAL_SHADING, b"<< /Type /Pattern /PatternType 2 /Shading 5 0 R >>"]
    return "/Pattern << /P1 5 0 R >>", [TILING_PATTERN]


@pytest.mark.parametrize("fill, kind", [("shading", "shade"), ("tiling", "pattern")])
def test_stroke_with_a_pattern_is_one_paint_bounded_by_the_stroked_path(tmp_path, fill, kind):
    resources, extra = pattern_resources(fill)
    # Round join: half the width on every side; the clip (60,60)-(260,260) is (60,40)-(260,240) in the slide frame.
    paints = first_paints(
        tmp_path,
        b"/Pattern CS /P1 SCN 4 w 1 j 50 50 100 100 re S q 60 60 200 200 re W n 50 50 100 100 re S Q",
        resources=resources,
        extra_objects=extra,
    )
    shading = {"shading": "axial"} if kind == "shade" else {}
    assert paints == [
        {"kind": kind, "bbox": [48, 148, 152, 252], "rgb": None, "alpha": 1.0, "evenOdd": False, **shading,
         "clip": [48, 148, 152, 252], **PLAIN},
        {"kind": kind, "bbox": [60, 148, 152, 240], "rgb": None, "alpha": 1.0, "evenOdd": False, **shading,
         "clip": [60, 148, 152, 240], **PLAIN},
    ]


@pytest.mark.parametrize("fill, kind", [("shading", "shade"), ("tiling", "pattern")])
def test_stroke_with_a_pattern_has_the_stroke_alpha(tmp_path, fill, kind):
    resources, extra = pattern_resources(fill)
    paints = first_paints(
        tmp_path,
        b"/G gs /Pattern CS /P1 SCN 2 w 1 j 50 50 100 100 re S",
        resources=resources + " /ExtGState << /G << /ca 0.5 /CA 0.25 >> >>",
        extra_objects=extra,
    )
    assert [(p["kind"], p["alpha"]) for p in paints] == [(kind, 0.25)]


@pytest.mark.parametrize("mode", [1, 2, 5, 6])
@pytest.mark.parametrize("fill", ["solid", "shading", "tiling"])
@pytest.mark.parametrize("stroke", ["shading", "tiling"])
def test_text_stroked_with_a_pattern_yields_its_glyphs_once_and_one_paint(tmp_path, mode, fill, stroke):
    """§6: clip_stroke_text is the stroke half of its run, not a new run, also with the clip of Tr 6 at ET."""
    objects = [HELVETICA, AXIAL_SHADING, b"<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>", TILING_PATTERN]
    colours = {"shading": b"/Sh", "tiling": b"/Ti"}
    fill_ops = b"1 0 0 rg" if fill == "solid" else b"/Pattern cs " + colours[fill] + b" scn"
    pdf = tmp_path / "text.pdf"
    build_pdf(
        pdf,
        fill_ops + b" /Pattern CS " + colours[stroke] + b" SCN %d Tr BT /F1 24 Tf 50 100 Td (AB) Tj ET" % mode,
        resources="/Font << /F1 5 0 R >> /Pattern << /Sh 7 0 R /Ti 8 0 R >>",
        extra_objects=objects,
    )
    inv = run_oracle(pdf)["pages"][0]
    assert "".join(g["u"] for g in inv["glyphs"]) == "AB"
    filled = {"solid": [], "shading": ["shade"], "tiling": ["pattern"]}[fill] if mode in (2, 6) else []
    assert [p["kind"] for p in inv["paints"]] == filled + [{"shading": "shade", "tiling": "pattern"}[stroke]]


def bound_grow(tmp_path, content):
    """How far fz_bound_path(path, stroke, ctm) lies outside fz_bound_path(path, NULL, ctm); the same on all four sides."""
    oracle = oracle_module()
    grown = []

    class Probe(oracle.InventoryDevice):
        def stroke_path(self, ctx, path, stroke, ctm, colorspace, color, alpha, color_params):
            bare = oracle.m.ll_fz_bound_path(path, None, ctm)
            full = oracle.m.ll_fz_bound_path(path, stroke, ctm)
            grown.append((bare.x0 - full.x0, bare.y0 - full.y0, full.x1 - bare.x1, full.y1 - bare.y1))

    pdf = tmp_path / "bound.pdf"
    build_pdf(pdf, content)
    page = pymupdf.open(pdf)[0]
    oracle.m.fz_run_page_contents(page.this, Probe((0.0, 0.0, 300.0, 300.0)), oracle.m.FzMatrix(), oracle.m.FzCookie())
    assert len(grown) == 1
    assert all(abs(side - grown[0][0]) < 1e-3 for side in grown[0])
    return grown[0][0]


DIAGONAL = b" 50 50 m 100 70 l S"
AXES = b" 50 50 m 100 50 l 100 70 l S"


# §15: the formula of strokeBounds (packages/core/src/extract/paths.ts). If a MuPDF upgrade moves it, this table says so.
@pytest.mark.parametrize(
    "content, grow",
    [
        (b"2 w" + DIAGONAL, 20),  # the default miter join, limit 10: width x limit
        (b"2 w 1 M" + DIAGONAL, 2),
        (b"2 w 0.51 M" + DIAGONAL, 1.02),
        (b"2 w 0.5 M" + DIAGONAL, 1),  # a limit of 0.5 or less adds nothing
        (b"2 w 0 M" + DIAGONAL, 1),
        (b"2 w 1 j" + DIAGONAL, 1),  # round join: half the width
        (b"2 w 2 j" + DIAGONAL, 1),  # bevel join: half the width
        (b"2 w 1 j 2 J" + DIAGONAL, 1),  # the cap does not count
        (b"2 w [3 1] 0 d" + DIAGONAL, 20),  # nor does a dash
        (b"0 w 1 j" + DIAGONAL, 0.5),  # a zero width counts as 1
        (b"0 w 4 M" + DIAGONAL, 4),
        (b"2 0 0 3 0 0 cm 2 w 1 j" + DIAGONAL, 3),  # the largest of |a|, |b|, |c| and |d|
        (b"3 0 0 0.5 0 0 cm 2 w 1 j" + DIAGONAL, 3),
        (b"0.8 0.6 -0.6 0.8 0 0 cm 2 w 1 j" + DIAGONAL, 0.8),
        (b"0.8 0.6 -0.6 0.8 0 0 cm 2 w 3 M" + DIAGONAL, 4.8),
        (b"1 1 0 1 0 0 cm 2 w 1 j" + DIAGONAL, 1),
        (b"2 0 0 3 0 0 cm 2 w 4 M" + DIAGONAL, 24),
        (b"2 w" + AXES, 1),  # lines along the axes reach no miter
        (b"2 w 50 50 100 100 re S", 1),
        (b"2 w 50 50 100 100 re 170 170 20 20 re S", 1),
        (b"2 w 50 50 m 100 50 l 100 70 l h S", 20),  # the close is a diagonal
        (b"2 w 50 50 m 100 50 l 100 70 l 100 50 l 50 50 l h S", 1),  # ... this one is not
        (b"2 w 50 50 m 60 50 70 50 80 50 c 80 70 l S", 20),  # a curve counts as a diagonal
        (b"2 w 50 50 m 50 50 80 50 80 50 c 80 70 l S", 1),  # ... unless MuPDF made it a line
        (b"2 w 50 50 m 80 50 l h 100 70 m 100 90 l S", 1),
        (b"2 w 50 50 m 80 50 l 100 70 m S", 1),  # a trailing moveTo is no line
        (b"0 1 -1 0 200 0 cm 2 w 50 50 100 100 re S", 1),  # a quarter turn keeps the axes
        (b"-1 0 0 1 200 0 cm 2 w 50 50 100 100 re S", 1),
        (b"0.8 0.6 -0.6 0.8 0 0 cm 2 w 50 50 100 100 re S", 16),  # any other turn does not
        (b"1 0 0.5 1 0 0 cm 2 w 50 50 m 100 50 l 60 70 m 110 70 l S", 1),  # a skew keeps the horizontal lines
        (b"1 0 0.5 1 0 0 cm 2 w 50 50 100 100 re S", 20),  # ... and turns the vertical ones
        (b"2 w 50 50 m 50 50 l S", 1),  # a box with no size has no miter
        (b"2 w 50 50 m 100 50 l S", 1),
        (b"0.8 0.6 -0.6 0.8 0 0 cm 2 w 50 50 m 50 50 l S", 0.8),
        # 0.001 pt in the slide frame is the limit under a CTM that does not keep the axes; under one that does, 0.
        (b"1 0.000005 0 1 0 0 cm 2 w" + AXES, 1),
        (b"1 0.0001 0 1 0 0 cm 2 w" + AXES, 20),
        (b"2 w 50 50 m 100 50.0001 l 100 70 l S", 20),
    ],
)
def test_stroke_bound_formula(tmp_path, content, grow):
    assert bound_grow(tmp_path, content) == pytest.approx(grow, abs=1e-3)


# --------------------------------------------------------------------------
# Inventory contract, docs/decisions/0002-inventory-contract.md: §6 glyphs (the
# state of a glyph, invisible text, Type 3 fonts), §13 what MuPDF does to widths
# and font names
# --------------------------------------------------------------------------

CACHED_GLYPH = b"1000 0 0 0 1000 1000 d1 0 0 500 500 re f"
DIRECT_GLYPH = b"1000 0 d0 0 0 500 500 re f"  # d0 in the inherited colour: MuPDF cannot cache it
PAINTED_GLYPH = b"1000 0 d0 1 0 0 rg 0 0 500 500 re f"  # d0 with its own colour: MuPDF caches it


def type3_font(widths=b"600 700", matrix=b"0.001 0 0 0.001 0 0"):
    return (
        b"<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [" + matrix + b"] /FirstChar 65 "
        b"/LastChar 66 /Widths [" + widths + b"] /Encoding << /Differences [65 /A /B] >> /CharProcs << /A 6 0 R /B 6 0 R >> >>"
    )


def build_type3_pdf(path, content, glyph=CACHED_GLYPH, widths=b"600 700", matrix=b"0.001 0 0 0.001 0 0"):
    build_pdf(
        path,
        content,
        resources="/Font << /F1 5 0 R >>",
        extra_objects=[type3_font(widths, matrix), stream_object(b"", glyph)],
    )


def state(glyph, *keys):
    return tuple(glyph[k] for k in keys)


def test_glyph_state_of_each_render_mode(tmp_path):
    pdf = tmp_path / "state.pdf"
    build_pdf(
        pdf,
        b"1 0 0 rg 0 0 1 RG /G gs BT /F1 20 Tf 30 250 Td 0 Tr (A) Tj 1 Tr (B) Tj 2 Tr (C) Tj 4 Tr (D) Tj 5 Tr (E) Tj "
        b"6 Tr (F) Tj 7 Tr (G) Tj ET",
        resources="/Font << /F1 5 0 R >> /ExtGState << /G << /ca 0.5 /CA 0.25 >> >>",
        extra_objects=[HELVETICA],
    )
    glyphs = run_oracle(pdf)["pages"][0]["glyphs"]
    red, blue = [255, 0, 0], [0, 0, 255]
    assert [state(g, "u", "paint", "rgb", "alpha") for g in glyphs] == [
        ("A", "fill", red, 0.5),
        ("B", "stroke", blue, 0.25),
        ("C", "fillStroke", red, 0.5),
        ("D", "fill", red, 0.5),
        ("E", "stroke", blue, 0.25),
        ("F", "fillStroke", red, 0.5),
        ("G", "clip", None, 1),  # reported at ET, as ever
    ]
    assert {state(g, "font", "size", "wmode") for g in glyphs} == {("Helvetica", 20, 0)}
    assert all("type3" not in g for g in glyphs)


@pytest.mark.parametrize(
    "matrix, size",
    [
        (b"1 0 0 1 10 10 Tm", 20),
        (b"2 0 0 3 10 10 Tm", 60),
        (b"0.6 0.8 -0.8 0.6 10 10 Tm", 20),
        (b"1 0 0.5 1 10 10 Tm", 22.361),  # the y axis, skew and all
        (b"-1 0 0 -1 10 10 Tm", 20),
    ],
)
def test_glyph_size_is_the_y_axis_of_the_text_matrix_in_the_slide_frame(tmp_path, matrix, size):
    pdf = tmp_path / "size.pdf"
    build_text_pdf(pdf, b"BT /F1 20 Tf " + matrix + b" (A) Tj ET")
    assert run_oracle(pdf)["pages"][0]["glyphs"][0]["size"] == size


def test_glyph_size_holds_the_ctm_but_not_tz_or_the_sign(tmp_path):
    pdf = tmp_path / "size.pdf"
    build_text_pdf(pdf, b"q 2 0 0 3 0 0 cm BT /F1 10 Tf (A) Tj ET Q BT /F1 -10 Tf 50 Tz (A) Tj ET")
    assert [g["size"] for g in run_oracle(pdf)["pages"][0]["glyphs"]] == [30, 10]


@pytest.mark.parametrize(
    "colour, paint, rgb, alpha",
    [
        (b"/Pattern cs /P1 scn 0 Tr", "fill", None, 0.5),  # the alpha fill_shade is given
        (b"/Pattern cs /P1 scn 0 0 1 RG 2 Tr", "fillStroke", None, 0.5),
        (b"1 0 0 rg /Pattern CS /P1 SCN 2 Tr", "fillStroke", [255, 0, 0], 0.5),
        (b"/Pattern CS /P1 SCN 1 Tr", "stroke", None, 0.25),
        (b"/Pattern cs /P1 scn /Pattern CS /P1 SCN 6 Tr", "fillStroke", None, 0.5),
    ],
)
def test_glyph_state_of_text_painted_with_a_shading(tmp_path, colour, paint, rgb, alpha):
    pdf = tmp_path / "shaded.pdf"
    build_pdf(
        pdf,
        b"/G gs " + colour + b" BT /F1 20 Tf 30 250 Td (AB) Tj ET",
        resources="/Font << /F1 5 0 R >> /Pattern << /P1 7 0 R >> /ExtGState << /G << /ca 0.5 /CA 0.25 >> >>",
        extra_objects=[HELVETICA, AXIAL_SHADING, b"<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>"],
    )
    glyphs = run_oracle(pdf)["pages"][0]["glyphs"]
    assert [state(g, "u", "paint", "rgb", "alpha") for g in glyphs] == [("A", paint, rgb, alpha), ("B", paint, rgb, alpha)]


def test_text_filled_with_a_tiling_pattern_is_fill_and_has_no_alpha_of_its_own(tmp_path):
    """§11: MuPDF draws it opaque."""
    pdf = tmp_path / "tiled.pdf"
    build_pdf(
        pdf,
        b"/G gs /Pattern cs /P1 scn BT /F1 20 Tf 30 250 Td (AB) Tj ET",
        resources="/Font << /F1 5 0 R >> /Pattern << /P1 6 0 R >> /ExtGState << /G << /ca 0.5 >> >>",
        extra_objects=[HELVETICA, TILING_PATTERN],
    )
    assert [state(g, "paint", "rgb", "alpha") for g in run_oracle(pdf)["pages"][0]["glyphs"]] == [("fill", None, 1)] * 2


def test_tr7_followed_by_nothing_but_one_sh_looks_like_a_pattern_fill(tmp_path):
    """§13, an oracle limit: the device calls of these two are the same, so the first is reported as a fill."""
    pdf = tmp_path / "clip.pdf"
    resources = "/Font << /F1 5 0 R >> /Shading << /Sh 6 0 R >> /Pattern << /P1 7 0 R >>"
    objects = [HELVETICA, AXIAL_SHADING, b"<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>"]
    calls = []
    for content in (
        b"q 7 Tr BT /F1 20 Tf 30 250 Td (A) Tj ET /Sh sh Q",
        b"/Pattern cs /P1 scn BT /F1 20 Tf 30 250 Td (A) Tj ET",
    ):
        build_pdf(pdf, content, resources=resources, extra_objects=objects)
        page = run_oracle(pdf)["pages"][0]
        calls.append(([p["kind"] for p in page["paints"]], [state(g, "paint", "rgb", "alpha") for g in page["glyphs"]]))
    assert calls[0] == calls[1] == (["shade"], [("fill", None, 1)])
    # With anything more under the clip they differ.
    build_pdf(pdf, b"q 7 Tr BT /F1 20 Tf 30 250 Td (A) Tj ET /Sh sh 0 0 5 5 re f Q", resources=resources, extra_objects=objects)
    assert [g["paint"] for g in run_oracle(pdf)["pages"][0]["glyphs"]] == ["clip"]


def test_invisible_text_keeps_its_order_and_is_not_cancelled_by_a_glyph_at_the_same_place(tmp_path):
    pdf = tmp_path / "invisible.pdf"
    build_text_pdf(pdf, b"BT /F1 20 Tf 30 250 Td 3 Tr (A) Tj ET BT /F1 20 Tf 30 250 Td 0 Tr (A) Tj 3 Tr (B ) Tj ET")
    page = run_oracle(pdf)["pages"][0]
    assert [g["u"] for g in page["glyphs"]] == ["A"]
    assert [g["u"] for g in page["invisible"]] == ["A", "B", " "]  # whitespace is kept in the output, as for glyphs


def test_invisible_text_in_a_soft_mask_is_not_reported(tmp_path):
    pdf = tmp_path / "masked.pdf"
    form = stream_object(
        b"/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency /CS /DeviceGray >> "
        b"/Resources << /Font << /F1 5 0 R >> >>",
        b"3 Tr BT /F1 20 Tf 30 250 Td (A) Tj ET",
    )
    build_pdf(
        pdf,
        b"/G gs 0 0 10 10 re f",
        resources="/Font << /F1 5 0 R >> /ExtGState << /G << /SMask << /Type /Mask /S /Luminosity /G 6 0 R >> >> >>",
        extra_objects=[HELVETICA, form],
    )
    assert run_oracle(pdf)["pages"][0]["invisible"] == []


def test_make_vertical_writes_an_identity_v_font(tmp_path):
    pdf = tmp_path / "sub" / "vertical.pdf"
    subprocess.run([sys.executable, str(HERE / "make_vertical.py"), str(pdf)], check=True)
    glyphs = run_oracle(pdf)["pages"][0]["glyphs"]
    vertical = [g for g in glyphs if g["wmode"] == 1]
    assert "".join(g["u"] for g in vertical) == "ABCD"
    assert [(g["x"], g["y"]) for g in vertical] == [(292.8, 121.12), (292.8, 145.12), (292.8, 169.12), (292.8, 193.12)]
    assert {state(g, "font", "size") for g in vertical} == {("DeckSans-Regular", 24)}
    assert "".join(g["u"] for g in glyphs if g["wmode"] == 0) == "Flat"


@pytest.mark.parametrize(
    "glyph", [CACHED_GLYPH, DIRECT_GLYPH, PAINTED_GLYPH, b"1000 0 d0"], ids=["d1", "d0-direct", "d0-colour", "d0-empty"]
)
def test_a_type3_glyph_is_one_glyph_and_its_content_is_no_paint(tmp_path, glyph):
    pdf = tmp_path / "t3.pdf"
    build_type3_pdf(pdf, b"1 0 0 rg BT /F1 20 Tf 30 250 Td (AB) Tj ET", glyph)
    page = run_oracle(pdf)["pages"][0]
    assert page["paints"] == [] and page["invisible"] == []
    assert [state(g, "u", "x", "y", "paint", "rgb", "alpha", "size", "type3") for g in page["glyphs"]] == [
        ("A", 30, 50, "fill", [255, 0, 0], 1, 20, True),
        ("B", 42, 50, "fill", [255, 0, 0], 1, 20, True),
    ]
    assert page["glyphs"][0]["font"] == "Type3 (5 0 R)"


@pytest.mark.parametrize("mode", [1, 2, 4, 5, 6])
def test_a_type3_font_ignores_the_render_mode_and_fills(tmp_path, mode):
    """PDF 9.3.6. Each glyph is painted on its own: MuPDF compares the mode with 0 at every glyph."""
    pdf = tmp_path / "t3.pdf"
    build_type3_pdf(pdf, b"1 0 0 rg 0 0 1 RG %d Tr BT /F1 20 Tf 30 250 Td (AB) Tj ET" % mode)
    glyphs = run_oracle(pdf)["pages"][0]["glyphs"]
    assert [state(g, "u", "paint", "rgb") for g in glyphs] == [("A", "fill", [255, 0, 0]), ("B", "fill", [255, 0, 0])]


@pytest.mark.parametrize("mode", [3, 7])
def test_a_type3_font_under_tr_3_and_7_is_invisible(tmp_path, mode):
    pdf = tmp_path / "t3.pdf"
    build_type3_pdf(pdf, b"%d Tr BT /F1 20 Tf 30 250 Td (AB) Tj ET" % mode)
    page = run_oracle(pdf)["pages"][0]
    assert page["glyphs"] == []
    assert page["invisible"] == [
        {"u": "A", "x": 30, "y": 50, "font": "Type3 (5 0 R)", "type3": True},
        {"u": "B", "x": 42, "y": 50, "font": "Type3 (5 0 R)", "type3": True},
    ]


def test_marking_the_type3_glyphs_reaches_an_indirect_char_procs_dictionary(tmp_path):
    pdf = tmp_path / "t3.pdf"
    font = type3_font().replace(b"/CharProcs << /A 6 0 R /B 6 0 R >>", b"/CharProcs 7 0 R")
    build_pdf(
        pdf,
        b"BT /F1 20 Tf 30 250 Td (AB) Tj ET",
        resources="/Font << /F1 5 0 R >>",
        extra_objects=[font, stream_object(b"", DIRECT_GLYPH), b"<< /A 6 0 R /B 6 0 R >>"],
    )
    page = run_oracle(pdf)["pages"][0]
    assert page["paints"] == [] and "".join(g["u"] for g in page["glyphs"]) == "AB"


@pytest.mark.parametrize(
    "code, name, u",
    [(251, b"g4F7", "\ufffd"), (65, b"A", "A"), (65, b"foo", "A"), (68, b"g65", "\u00c9")],
    ids=["what Skia writes", "a name of the glyph list", "a name of no meaning", "gNN"],
)
def test_a_tounicode_of_zero_means_none(tmp_path, code, name, u):
    """§1: MuPDF then falls back on the encoding (§13), and to U+FFFD when that says nothing. Skia writes such entries."""
    pdf = tmp_path / "zero.pdf"
    cmap = (
        b"/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def "
        b"1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <%02X> <0000> endbfchar "
        b"endcmap CMapName currentdict /CMap defineresource pop end end" % code
    )
    font = (
        b"<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /FirstChar %d /LastChar %d "
        b"/Widths [600] /Encoding << /Differences [%d /%s] >> /ToUnicode 7 0 R /CharProcs << /%s 6 0 R >> >>" % (code, code, code, name, name)
    )
    build_pdf(
        pdf,
        b"BT /F1 20 Tf 30 250 Td <%02X> Tj ET" % code,
        resources="/Font << /F1 5 0 R >>",
        extra_objects=[font, stream_object(b"", CACHED_GLYPH), stream_object(b"", cmap)],
    )
    assert [g["u"] for g in run_oracle(pdf)["pages"][0]["glyphs"]] == [u]


def width_font_objects(entry, value):
    """A one-glyph-wide CID font, its /W or /DW given here, in the shape `build_pdf` takes (objects 5 to 8)."""
    program = make_vertical_module().make_font("Deck Sans", "Regular", "DeckSans-Regular")
    cid = f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /W /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> {entry} {value} /CIDToGIDMap /Identity /FontDescriptor 7 0 R >>"
    return [
        b"<< /Type /Font /Subtype /Type0 /BaseFont /W /Encoding /Identity-H /DescendantFonts [6 0 R] >>",
        cid.encode(),
        b"<< /Type /FontDescriptor /FontName /W /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 "
        b"/CapHeight 700 /StemV 80 /FontFile2 8 0 R >>",
        stream_object(b"", program),
    ]


@functools.lru_cache(maxsize=None)
def make_vertical_module():
    spec = importlib.util.spec_from_file_location("make_vertical_under_test", HERE / "make_vertical.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize(
    "width, advance",
    [("549.8", 55), ("549.5", 55), ("549.4", 54.9), ("550", 55)],
)
def test_mupdf_rounds_simple_and_cid_widths_to_an_integer_per_mille(tmp_path, width, advance):
    """§13, an oracle limit: pdf.js and the PDF read the number as it is. This pins MuPDF's side."""
    simple = (
        f"<< /Type /Font /Subtype /TrueType /BaseFont /W /FirstChar 65 /LastChar 65 /Widths [{width}] /Encoding /WinAnsiEncoding >>"
    ).encode()
    pdf = tmp_path / "w.pdf"
    build_pdf(pdf, b"BT /F1 100 Tf 0 100 Td (AA) Tj ET", resources="/Font << /F1 5 0 R >>", extra_objects=[simple])
    assert run_oracle(pdf)["pages"][0]["glyphs"][1]["x"] == advance
    for entry, value in (("/W", f"[2 [{width}]]"), ("/W", f"[2 2 {width}]"), ("/DW", width)):
        build_pdf(
            pdf,
            b"BT /F1 100 Tf 0 100 Td <00020002> Tj ET",
            resources="/Font << /F1 5 0 R >>",
            extra_objects=width_font_objects(entry, value),
        )
        assert run_oracle(pdf)["pages"][0]["glyphs"][1]["x"] == advance


@pytest.mark.parametrize(
    "width, matrix, advance",
    [
        (b"549.8", b"0.001 0 0 0.001 0 0", 54.9),
        (b"549.2", b"0.001 0 0 0.001 0 0", 54.9),
        (b"550", b"0.001 0 0 0.001 0 0", 55),
        (b"0.5498", b"1 0 0 1 0 0", 54.9),
        (b"1322", b".00048828127 0 0 -.00048828127 0 0", 64.5),
    ],
)
def test_mupdf_cuts_type3_widths_down_to_an_integer_per_mille(tmp_path, width, matrix, advance):
    """§13, an oracle limit: not rounded, cut."""
    pdf = tmp_path / "t3.pdf"
    build_type3_pdf(pdf, b"BT /F1 100 Tf 0 100 Td (AA) Tj ET", widths=width + b" " + width, matrix=matrix)
    assert run_oracle(pdf)["pages"][0]["glyphs"][1]["x"] == advance


@pytest.mark.parametrize(
    "name, reported",
    [
        ("ABCDEF+Deck-Regular", "ABCDEF+Deck-Regular"),
        ("A" * 31, "A" * 31),
        ("A" * 32, "A" * 31),
        ("ABCDEF+VeryLongFontNameThatGoesBeyondThirtyTwoCharacters-Bold", "ABCDEF+VeryLongFontNameThatGoes"),
    ],
)
def test_mupdf_keeps_31_bytes_of_a_font_name(tmp_path, name, reported):
    """§12, §13: fz_font.name is a char[32]."""
    pdf = tmp_path / "name.pdf"
    font = f"<< /Type /Font /Subtype /TrueType /BaseFont /{name} /FirstChar 65 /LastChar 65 /Widths [500] /Encoding /WinAnsiEncoding >>"
    build_pdf(pdf, b"BT /F1 10 Tf 0 100 Td (A) Tj ET", resources="/Font << /F1 5 0 R >>", extra_objects=[font.encode()])
    assert run_oracle(pdf)["pages"][0]["glyphs"][0]["font"] == reported


@pytest.mark.parametrize(
    "name, reported",
    [
        ("ABCDEF+#EA#B0#80#EA#B0#81", "ABCDEF+\uac00\uac01"),  # UTF-8, as MuPDF reads it (pdf.js does not: §13)
        ("ABCDE+" + "#EA#B0#80" * 12, "ABCDE+" + "\uac00" * 8 + "\ufffd"),  # byte 31 falls inside a character
        ("ABCDEF+#C0#C1", "ABCDEF+\ufffd\ufffd"),  # no UTF-8 at all
    ],
)
def test_a_font_name_that_is_not_ascii_does_not_stop_the_oracle(tmp_path, name, reported):
    pdf = tmp_path / "name.pdf"
    font = f"<< /Type /Font /Subtype /TrueType /BaseFont /{name} /FirstChar 65 /LastChar 65 /Widths [500] /Encoding /WinAnsiEncoding >>"
    build_pdf(pdf, b"BT /F1 10 Tf 0 100 Td (A) Tj ET", resources="/Font << /F1 5 0 R >>", extra_objects=[font.encode()])
    glyph = run_oracle(pdf)["pages"][0]["glyphs"][0]
    assert glyph["u"] == "A" and glyph["font"] == reported


# --------------------------------------------------------------------------
# Inventory contract, docs/decisions/0002-inventory-contract.md: §17 clip,
# groups, blend modes and soft masks; §18 optional content
# --------------------------------------------------------------------------


def form_object(content, bbox=b"0 0 300 300", entries=b"", resources=b"<< >>"):
    return stream_object(b"/Type /XObject /Subtype /Form /BBox [" + bbox + b"] " + entries + b" /Resources " + resources, content)


GROUP = b"/Group << /S /Transparency >>"
SCENE_OBJECTS = [
    b"<< /Type /ExtGState /ca 0.5 /CA 0.25 >>",  # 5: /GA
    b"<< /Type /ExtGState /BM /Multiply >>",  # 6: /GB
    b"<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 8 0 R >> >>",  # 7: /GM
    form_object(b"0.5 g 0 0 300 300 re f", b"20 30 220 130", b"/Group << /S /Transparency /CS /DeviceGray >>"),  # 8: the mask
    b"<< /Type /ExtGState /SMask /None >>",  # 9: /GN
    # 10: /Fm1, a group with text, a fill, a fill at ca 0.5 multiplied, and /Fm2 drawn so
    form_object(
        b"BT /F1 10 Tf 30 180 Td (A) Tj ET 0 1 0 rg 30 30 40 40 re f /GA gs /GB gs 80 30 40 40 re f /Fm2 Do",
        b"20 20 280 200",
        GROUP,
        b"<< /Font << /F1 13 0 R >> /ExtGState << /GA 5 0 R /GB 6 0 R >> /XObject << /Fm2 11 0 R >> >>",
    ),
    # 11: /Fm2, a group with a fill, and one after /SMask /None
    form_object(b"1 0 0 rg 100 110 30 30 re f /GN gs 150 110 30 30 re f", b"100 100 220 180", GROUP, b"<< /ExtGState << /GN 9 0 R >> >>"),
    image_object(2, 2, bytes(4), b"/ColorSpace /DeviceGray /BitsPerComponent 8 /SMask 14 0 R"),  # 12: /Im1, with a soft mask
    HELVETICA,  # 13
    image_object(2, 2, bytes(4)),  # 14: its mask
    TILING_PATTERN,  # 15: /P1
    b"<< /Type /ExtGState /BM [/NoSuchMode /Screen] >>",  # 16: /GS
    form_object(b"0 1 0 rg 20 20 50 50 re f", entries=b"/Group << /S /NoSuchGroup >>"),  # 17: /Fm3, no transparency group
]
SCENE_RESOURCES = (
    "/ExtGState << /GA 5 0 R /GB 6 0 R /GM 7 0 R /GN 9 0 R /GS 16 0 R >> /XObject << /Fm1 10 0 R /Fm2 11 0 R /Im1 12 0 R "
    "/Fm3 17 0 R >> /Font << /F1 13 0 R >> /Pattern << /P1 15 0 R >>"
)


def scene_page(tmp_path, content):
    pdf = tmp_path / "scene.pdf"
    build_pdf(pdf, content, resources=SCENE_RESOURCES, extra_objects=SCENE_OBJECTS)
    return run_oracle(pdf)["pages"][0]


def test_a_paint_carries_the_clip_in_force_and_not_its_own_soft_mask_area_or_image_mask(tmp_path):
    page = scene_page(
        tmp_path,
        b"q 20 30 100 80 re W n 1 0 0 rg 0 0 300 300 re f Q q /GM gs 10 10 50 50 re f Q "
        b"q 0 0 150 150 re W n /Pattern cs /P1 scn 100 100 100 100 re f Q q 20 0 0 20 200 200 cm /Im1 Do Q",
    )
    assert [(p["kind"], p["clip"], p["masked"]) for p in page["paints"]] == [
        ("fill", [20, 190, 120, 270], False),
        ("fill", [0, 0, 300, 300], True),  # MuPDF clips a masked paint to its own bounds: not part of its clip
        ("pattern", [100, 150, 150, 200], False),  # MuPDF clips to the shape before the cell: that is part of it
        ("image", [0, 0, 300, 300], False),  # nor is the image's own soft mask, which replaces the one in the gs
    ]


def test_group_alpha_is_the_product_of_the_enclosing_groups_and_the_blend_mode_the_first_that_is_not_normal(tmp_path):
    page = scene_page(tmp_path, b"/GA gs /Fm1 Do 0 0 1 rg 10 250 20 20 re f")
    assert [(p["alpha"], p["groupAlpha"], p["blend"]) for p in page["paints"]] == [
        (1.0, 0.5, "normal"),
        (0.5, 0.5, "multiply"),
        (1.0, 0.25, "multiply"),  # /Fm2 is drawn multiplied at ca 0.5, inside /Fm1 at ca 0.5
        (1.0, 0.25, "multiply"),
        (0.5, 1.0, "normal"),
    ]
    assert [(g["u"], g["alpha"], g["groupAlpha"]) for g in page["glyphs"]] == [("A", 1.0, 0.5)]


def test_the_group_mupdf_opens_for_a_tiling_alpha_is_the_paints_alpha_and_one_for_a_blend_mode_has_alpha_1(tmp_path):
    page = scene_page(tmp_path, b"/GA gs /GB gs /Pattern cs /P1 scn 1 0 0 RG 2 w 20 20 50 50 re B")
    assert [(p["kind"], p["alpha"], p["groupAlpha"], p["blend"]) for p in page["paints"]] == [
        ("pattern", 0.5, 1.0, "multiply"),
        ("stroke", 0.25, 1.0, "multiply"),
    ]


def test_masked_is_any_soft_mask_over_the_paint_also_the_one_a_group_took(tmp_path):
    page = scene_page(
        tmp_path,
        b"q /GM gs 10 10 20 20 re f /GN gs 40 10 20 20 re f Q q /GM gs /Fm2 Do Q q /GM gs 20 0 0 20 200 200 cm /Im1 Do Q",
    )
    assert [(p["kind"], p["masked"]) for p in page["paints"]] == [
        ("fill", True),
        ("fill", False),
        ("fill", True),
        ("fill", True),  # /SMask /None inside the group ends no mask of the group's
        ("image", False),  # its own soft mask replaces the one in the graphics state
    ]


def test_detail_false_has_no_clip_group_alpha_blend_or_mask(tmp_path):
    pdf = tmp_path / "bare.pdf"
    build_pdf(pdf, b"q /GM gs /GA gs /GB gs /Fm1 Do Q", resources=SCENE_RESOURCES, extra_objects=SCENE_OBJECTS)
    oracle = oracle_module()
    full = oracle.inventory(str(pdf))["pages"][0]
    bare = oracle.inventory(str(pdf), detail=False)["pages"][0]
    assert [sorted(p) for p in bare["paints"]] == [["alpha", "bbox", "evenOdd", "kind", "rgb"]] * 4
    assert [sorted(g) for g in bare["glyphs"]] == [["u", "x", "y"]]
    assert all(set(SCENE_KEYS) <= set(p) for p in full["paints"]) and "groupAlpha" in full["glyphs"][0]
    assert [{k: v for k, v in p.items() if k not in ("path", *SCENE_KEYS)} for p in full["paints"]] == bare["paints"]


def test_mupdf_takes_the_first_name_of_a_blend_mode_array_and_a_group_needs_s_transparency(tmp_path):
    """§13: pdf.js takes the first name it knows (Screen here), and makes a group of any /Group."""
    page = scene_page(tmp_path, b"q /GS gs 10 10 20 20 re f Q q /GA gs /Fm3 Do Q")
    assert [(p["alpha"], p["groupAlpha"], p["blend"]) for p in page["paints"]] == [(1.0, 1.0, "normal"), (0.5, 1.0, "normal")]


OC_CATALOG = "/OCProperties << /OCGs [5 0 R 6 0 R] /D << /OFF [6 0 R] >> >>"
OC_OBJECTS = [
    b"<< /Type /OCG /Name (Shown) >>",  # 5
    b"<< /Type /OCG /Name (Hidden) >>",  # 6
    b"<< /Type /OCMD /OCGs [5 0 R 6 0 R] /P /AllOn >>",  # 7: hidden, as the PDF says
    b"<< /Type /OCMD /OCGs [5 0 R 6 0 R] /P /AnyOff >>",  # 8: shown
    b"<< /Type /OCMD /OCGs [5 0 R] /VE [/Not 5 0 R] >>",  # 9: hidden
    b"<< /Type /OCMD /OCGs [5 0 R 6 0 R] /P /AnyOn >>",  # 10: shown
    b"<< /Type /OCMD /OCGs [6 0 R] /P /AllOff >>",  # 11: shown
    HELVETICA,  # 12
    form_object(
        b"3 Tr BT /F1 20 Tf 30 250 Td (A) Tj ET 7 Tr BT /F1 20 Tf 30 200 Td (B) Tj ET",
        entries=b"/OC 6 0 R",
        resources=b"<< /Font << /F1 12 0 R >> >>",
    ),  # 13: /Fm1, a hidden form
]
OC_RESOURCES = (
    "/Properties << /On 5 0 R /Off 6 0 R /AllOn 7 0 R /AnyOff 8 0 R /VE 9 0 R /AnyOn 10 0 R /AllOff 11 0 R >> "
    "/Font << /F1 12 0 R >> /XObject << /Fm1 13 0 R >>"
)


def oc_page(tmp_path, content):
    pdf = tmp_path / "oc.pdf"
    build_pdf(pdf, content, resources=OC_RESOURCES, extra_objects=OC_OBJECTS, catalog=OC_CATALOG)
    return run_oracle(pdf)["pages"][0]


def test_mupdf_shows_what_its_membership_rules_show(tmp_path):
    """§13: MuPDF 1.28 never hides /P /AllOn, always hides /P /AnyOff and ignores /VE; pdf.js does as the PDF says."""
    page = oc_page(
        tmp_path,
        b"/OC /On BDC 10 10 5 5 re f EMC /OC /Off BDC 20 10 5 5 re f EMC /OC /AllOn BDC 30 10 5 5 re f EMC "
        b"/OC /AnyOff BDC 40 10 5 5 re f EMC /OC /VE BDC 50 10 5 5 re f EMC /OC /AnyOn BDC 60 10 5 5 re f EMC "
        b"/OC /AllOff BDC 70 10 5 5 re f EMC",
    )
    assert [p["bbox"][0] for p in page["paints"]] == [10, 30, 50, 60, 70]


def test_hidden_marked_content_keeps_its_state_its_clips_its_invisible_text_and_its_clip_glyphs(tmp_path):
    """§18: what is hidden paints nothing; MuPDF still clips, and still reports Tr 3 and the clip modes."""
    page = oc_page(
        tmp_path,
        b"q /OC /Off BDC 1 0 0 rg 10 10 20 20 re f 0 0 150 150 re W n "
        b"BT /F1 20 Tf 30 250 Td (AB) Tj 3 Tr (C) Tj 4 Tr (D) Tj 7 Tr (E) Tj ET EMC 0 0 300 300 re f Q",
    )
    assert [(p["kind"], p["rgb"], p["bbox"]) for p in page["paints"]] == [("fill", [255, 0, 0], [0, 0, 300, 300])]
    assert [(g["u"], g["paint"]) for g in page["glyphs"]] == [("D", "clip"), ("E", "clip")]
    assert [g["u"] for g in page["invisible"]] == ["C"]


def test_a_hidden_form_is_skipped_altogether(tmp_path):
    """§13: a form whose own /OC hides it reports nothing; the same content in hidden marked content would."""
    assert oc_page(tmp_path, b"/Fm1 Do")["invisible"] == []
    page = oc_page(tmp_path, b"/OC /Off BDC 3 Tr BT /F1 20 Tf 30 250 Td (A) Tj ET 7 Tr BT /F1 20 Tf 30 200 Td (B) Tj ET EMC")
    assert [g["u"] for g in page["invisible"]] == ["A"] and [g["u"] for g in page["glyphs"]] == ["B"]
