"""The raster fallback fixtures (M5 Task 2): four small synthetic public PDFs, each one element DrawingML cannot say.

  harness/.venv/Scripts/python -m harness.atlas.fallback_pdfs

writes them into corpus/generated/fallback/ and refreshes corpus/generated/manifest.json; publish.py stages the same bytes
whenever it publishes the corpus, so a publish keeps them. Every byte is fixed: no compression, no dates, no ids, no
fonts embedded (the text names Arial, which MuPDF draws with its Helvetica clone and PowerPoint with Arial, of the same
widths, and whose baseline deckback has measured), so CI checks the committed files against this script
(harness/atlas/test_corpus.py). Content: dedicated to the public domain (CC0-1.0), as the rest of corpus/generated.

  fallback/blend-multiply.pdf     a Multiply ellipse over two coloured blocks and the white page, text over it
  fallback/softmask-image.pdf     an RGB image under a luminosity soft mask (a radial shading, white at the centre)
  fallback/mesh-type4.pdf         a free-form triangle mesh (ShadingType 4), a fan of six colours, in a circular clip
  fallback/function-shading.pdf   a function-based shading (ShadingType 1, a PostScript function) filling an ellipse

Each page is 960 x 540 pt, a 16:9 slide, so a 2 px a pt render is 1920 x 1080 as the harness's.
"""

import math
from pathlib import Path

from harness.atlas import build

DIR = "fallback"
CORPUS_DIR = build.REPO_ROOT / "corpus" / "generated"
PAGE = (960, 540)
KAPPA = 0.5522847498307936
# The unit hexagon's corners at k x 60 degrees: exact, and sqrt(3) / 2 from the correctly rounded IEEE-754 square root,
# so the fixture's bytes never depend on a platform's libm (math.cos / math.sin may differ in their last bit).
HALF_SQRT3 = math.sqrt(3) / 2
HEXAGON = ((1.0, 0.0), (0.5, HALF_SQRT3), (-0.5, HALF_SQRT3), (-1.0, 0.0), (-0.5, -HALF_SQRT3), (0.5, -HALF_SQRT3))


def _num(v):
    """A PDF number: an integer as it is, else at most 4 decimals without trailing zeros."""
    if float(v).is_integer():
        return str(int(v))
    return f"{v:.4f}".rstrip("0").rstrip(".")


def _ellipse(cx, cy, rx, ry):
    """An ellipse as four cubics (a path of the content stream), counter-clockwise from its right point."""
    kx, ky = KAPPA * rx, KAPPA * ry
    n = _num
    return (f"{n(cx + rx)} {n(cy)} m "
            f"{n(cx + rx)} {n(cy + ky)} {n(cx + kx)} {n(cy + ry)} {n(cx)} {n(cy + ry)} c "
            f"{n(cx - kx)} {n(cy + ry)} {n(cx - rx)} {n(cy + ky)} {n(cx - rx)} {n(cy)} c "
            f"{n(cx - rx)} {n(cy - ky)} {n(cx - kx)} {n(cy - ry)} {n(cx)} {n(cy - ry)} c "
            f"{n(cx + kx)} {n(cy - ry)} {n(cx + rx)} {n(cy - ky)} {n(cx + rx)} {n(cy)} c h")


def _stream(dictionary, data):
    data = data.encode("ascii") if isinstance(data, str) else bytes(data)
    return b"<< " + dictionary.encode("ascii") + b" /Length " + str(len(data)).encode("ascii") + b" >>\nstream\n" + data + b"\nendstream"


def _pdf(resources, content, extra):
    """A one-page PDF: catalog 1, pages 2, page 3, content 4, then `extra` (objects 5 on, bytes each)."""
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PAGE[0]} {PAGE[1]}] /Resources << {resources} >> "
         f"/Contents 4 0 R >>").encode("ascii"),
        _stream("", content),
        *extra,
    ]
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += f"{number} 0 obj\n".encode("ascii") + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode("ascii")
    out += b"".join(f"{offset:010d} 00000 n \n".encode("ascii") for offset in offsets)
    out += f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode("ascii")
    return bytes(out)


ARIAL = "<< /Type /Font /Subtype /Type1 /BaseFont /Arial /Encoding /WinAnsiEncoding >>"


def blend_multiply():
    """Two blocks (light blue, light green), an orange ellipse in Multiply over both and the white page, text over it."""
    content = " ".join([
        "0.75 0.88 1 rg 80 60 520 380 re f",
        "0.78 1 0.8 rg 600 60 280 380 re f",
        f"q /Mul gs 1 0.62 0.2 rg {_ellipse(480, 300, 380, 190)} f Q",
        "0.1 0.1 0.35 rg BT /F1 30 Tf 300 290 Td (Multiply under text) Tj ET",
    ])
    return _pdf(f"/ExtGState << /Mul << /Type /ExtGState /BM /Multiply >> >> /Font << /F1 {ARIAL} >>", content, [])


def _image(width, height):
    """A smooth RGB image (so a renderer's resampling hardly shows): red along x, green up y, blue against x."""
    data = bytearray()
    for y in range(height):
        for x in range(width):
            data += bytes([40 + (200 * x) // (width - 1), 60 + (160 * y) // (height - 1), 200 - (140 * x) // (width - 1)])
    return bytes(data)


def softmask_image():
    """A 96 x 64 image on 640 x 400 pt under a luminosity soft mask: a radial shading, white at its centre, black out."""
    content = "0.96 0.92 0.84 rg 0 0 960 540 re f q /SM gs 640 0 0 400 160 70 cm /Im Do Q"
    group = _stream("/Type /XObject /Subtype /Form /BBox [0 0 960 540] /Group << /S /Transparency /CS /DeviceRGB >> "
                    "/Resources << /Shading << /Sh 7 0 R >> >>", "/Sh sh")
    shading = (b"<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [480 270 0 480 270 330] /Extend [true true] "
               b"/Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0 0 0] /N 1 >> >>")
    image = _stream("/Type /XObject /Subtype /Image /Width 96 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8",
                    _image(96, 64))
    resources = ("/ExtGState << /SM << /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 6 0 R >> >> >> "
                 "/XObject << /Im 5 0 R >>")
    return _pdf(resources, content, [image, group, shading])


def _be16(*values):
    return b"".join(v.to_bytes(2, "big") for v in values)


def mesh_type4():
    """A fan of six triangles about the page's centre, white there, a colour at each outer corner, in a circular clip."""
    cx, cy, r = 480, 270, 250
    colours = [(230, 40, 40), (240, 200, 30), (40, 190, 70), (30, 200, 210), (40, 70, 220), (210, 50, 200)]
    corners = [(cx + r * c, cy + r * s) for c, s in HEXAGON]

    def vertex(flag, x, y, rgb):
        return bytes([flag]) + _be16(round(x / PAGE[0] * 65535), round(y / PAGE[1] * 65535)) + bytes(rgb)

    data = b"".join(vertex(0, cx, cy, (255, 255, 255)) + vertex(0, *corners[k], colours[k])
                    + vertex(0, *corners[(k + 1) % 6], colours[(k + 1) % 6]) for k in range(6))
    mesh = _stream("/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 16 /BitsPerComponent 8 /BitsPerFlag 8 "
                   f"/Decode [0 {PAGE[0]} 0 {PAGE[1]} 0 1 0 1 0 1]", data)
    content = f"0.93 0.95 0.97 rg 0 0 960 540 re f q {_ellipse(cx, cy, 235, 235)} W n /Sh sh Q"
    return _pdf("/Shading << /Sh 5 0 R >>", content, [mesh])


def function_shading():
    """A function-based shading over 640 x 360 pt, (x, y) to (x, y, 1 - x y), filling an ellipse through a pattern."""
    function = _stream("/FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1]", "{ 2 copy mul 1 exch sub }")
    shading = b"<< /ShadingType 1 /ColorSpace /DeviceRGB /Domain [0 1 0 1] /Matrix [640 0 0 360 160 90] /Function 7 0 R >>"
    pattern = b"<< /Type /Pattern /PatternType 2 /Shading 6 0 R >>"
    content = f"/Pattern cs /P1 scn {_ellipse(480, 270, 300, 170)} f"
    return _pdf("/Pattern << /P1 5 0 R >>", content, [pattern, shading, function])


FIXTURES = {
    "blend-multiply.pdf": blend_multiply,
    "softmask-image.pdf": softmask_image,
    "mesh-type4.pdf": mesh_type4,
    "function-shading.pdf": function_shading,
}


def pdfs():
    """{path relative to corpus/generated: bytes} of every fixture."""
    return {f"{DIR}/{name}": make() for name, make in FIXTURES.items()}


def write(root):
    """Write the fixtures under `root` (corpus/generated, or publish's stage) and return their relative paths."""
    root = Path(root)
    written = []
    for relative, data in pdfs().items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.is_file() or target.read_bytes() != data:
            target.write_bytes(data)
        written.append(relative)
    return written


def main():
    from harness.atlas import publish

    written = write(CORPUS_DIR)
    build.write_manifest(CORPUS_DIR / publish.MANIFEST, publish.corpus_manifest(CORPUS_DIR, publish.committed_dropped(CORPUS_DIR)))
    for relative in written:
        print(f"{relative}  {(CORPUS_DIR / relative).stat().st_size} bytes")


if __name__ == "__main__":
    main()
