"""Tests for the baseline converter (harness/baseline/proto.py).

The M0 prototype is converted once on the committed probe PDF and the resulting .pptx is inspected with
python-pptx; its zip parts are compared byte for byte with the output of the frozen port, and one atlas-smoke page
with soft-masked images is converted (ruling M1-R59). Nothing generated is committed: every output goes to pytest's
tmp dir.
"""

import hashlib
import io
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest
from pptx import Presentation
from pptx.enum.shapes import MSO_SHAPE_TYPE

REPO = Path(__file__).resolve().parents[2]
PROBE = REPO / "corpus" / "generated" / "probe_std.pdf"
ATLAS_SMOKE = REPO / "corpus" / "generated" / "atlas-smoke_std.pdf"
SMASK_PAGE = 11  # 0-based: atlas-smoke page 12, soft masks with /Matte (PyMuPDF 2.1 gives the image an opaque alpha)
MASK_SIZE_PAGE = 37  # 0-based: atlas-smoke page 38, 2 x 2 px colour images with glyph-sized soft masks
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _walk(shapes):
    for s in shapes:
        if s.shape_type == MSO_SHAPE_TYPE.GROUP:
            yield from _walk(s.shapes)
        else:
            yield s


def _is_freeform(shape):
    return shape._element.find(".//{%s}custGeom" % A_NS) is not None


@pytest.fixture(scope="module")
def converted(tmp_path_factory):
    from harness.baseline.proto import convert

    out = tmp_path_factory.mktemp("baseline") / "probe_std.pptx"
    result = convert(PROBE, out)
    return result, out


def test_proto_on_committed_probe(converted):
    """The M0 probe gave 39 text boxes / 9 freeforms / 21 rects / 35 lines / 1 picture with Malgun Gothic."""
    result, out = converted
    assert out.is_file()
    prs = Presentation(str(out))
    assert len(prs.slides) == 3
    slide_area = prs.slide_width * prs.slide_height

    text_boxes = pictures = freeforms = big_pictures = 0
    for slide in prs.slides:
        for s in _walk(slide.shapes):
            if s.shape_type == MSO_SHAPE_TYPE.PICTURE:
                pictures += 1
                if s.width * s.height >= 0.5 * slide_area:
                    big_pictures += 1
            elif s.shape_type == MSO_SHAPE_TYPE.TEXT_BOX:
                text_boxes += 1
            elif _is_freeform(s):
                freeforms += 1

    assert big_pictures == 0, "a picture covers half a slide: the page was rasterised"
    assert text_boxes >= 30
    assert pictures >= 1
    assert freeforms >= 9

    # the returned counts agree with what is in the file
    assert result["pages"] == 3
    assert result["textBoxes"] == text_boxes
    assert result["pictures"] == pictures
    assert result["shapes"] >= text_boxes + pictures + freeforms
    assert isinstance(result["seconds"], float) and result["seconds"] >= 0


def test_convert_returns_the_documented_keys(converted):
    result, _ = converted
    assert set(result) == {"pages", "shapes", "textBoxes", "pictures", "seconds"}


def test_cli_writes_where_out_says(tmp_path):
    out = tmp_path / "nested-ok" / "cli.pptx"
    out.parent.mkdir()
    proc = subprocess.run(
        [sys.executable, "-m", "harness.baseline.proto", str(PROBE), "-o", str(out)],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    assert proc.returncode == 0, proc.stderr
    assert out.is_file()
    assert len(Presentation(str(out)).slides) == 3
    assert "pages" in proc.stdout  # one-line summary of the returned dict


# sha256 of every zip part of `python -m harness.baseline.proto corpus/generated/probe_std.pdf` at commit 24a855b,
# the frozen port before its only change (M1-R59). The probe has no soft-masked image, so that change must leave
# every part byte-identical. python-pptx and PyMuPDF as in harness/requirements.lock.txt.
PROBE_STD_PARTS_24A855B = {
    "[Content_Types].xml": "8458c4a5b48f633b9583e4cda39ba0f3ad80a57b9f78c6a4a748e3aae6ff7d5b",
    "_rels/.rels": "694cc89ebda975bfb74644f943f86114504d64d5a6b2e420304f58ba494f0e11",
    "docProps/app.xml": "77fbd43c41b96be9a40d41a267cd83108a274ee5860675dfb543828472d76867",
    "docProps/core.xml": "b25bcc59255004fe78e28f81cba03ebf00eea5f5f95e9f98e71a3c20468d7d3b",
    "docProps/thumbnail.jpeg": "116f9aa8ea038e39ef47ee99a23592ab569cf77feafecd0a30e222369e931d25",
    "ppt/_rels/presentation.xml.rels": "b21396466d4cd5be2dd80b26f6fc5a5fea25e8765115d00d48cf9b4924e1347b",
    "ppt/media/image1.png": "9e778580bbaa1f71c31d3f0a0ccc0927bab37857e0a6c4581a3648eb9728d28c",
    "ppt/presProps.xml": "b42af61236cda9ea4d781f60908296da476489b2828df32fc9625d996808087b",
    "ppt/presentation.xml": "25e46926610ddbc0e5a128d93acabd78f71d2bb94f9d8bd7f73dd2e68ac61e0e",
    "ppt/printerSettings/printerSettings1.bin": "d7768f87e07d29634782e448ece1cddd05a52b9499254222b1190bc8f6dc579e",
    **{f"ppt/slideLayouts/_rels/slideLayout{n}.xml.rels":
       "7c1f290acd6ca3ce664fe95aaf0b129bbb3cbf2b75c8d09905a2821641981027" for n in range(1, 12)},
    "ppt/slideLayouts/slideLayout1.xml": "25c93a2f186df69897585729d52fc610349e29dcf0b5b6080160df6490698709",
    "ppt/slideLayouts/slideLayout10.xml": "1f8304c9d6c08ff9bd41b639d0c7e866b6515f61e6081c9ccc89ed8d0f8b4194",
    "ppt/slideLayouts/slideLayout11.xml": "355ac266c2671b83b662759afb0ee0ecfb7cdd6ec936019ecef60dbc95c14dac",
    "ppt/slideLayouts/slideLayout2.xml": "5f800acd9e43b9b438c987bd71cf0966b27ad02ce8df14df80708510cbd700be",
    "ppt/slideLayouts/slideLayout3.xml": "e83a85b737e1447051ac7fd9bbaaba4ac1b4210cfc630cdcfcdbc191fdb141d1",
    "ppt/slideLayouts/slideLayout4.xml": "1ebe316051a0caaac0e972989a7591e66d1fbb4a0764fe984c31a4ab5b6554bf",
    "ppt/slideLayouts/slideLayout5.xml": "3df8e6f498622ef440f5568a2c967c97f47c74b46b47a976304c7b7c9ab54c74",
    "ppt/slideLayouts/slideLayout6.xml": "18e5b26c6f7c30dabe0b294faf38b2d2ef60ae778fbba9c3fe71f6560143a402",
    "ppt/slideLayouts/slideLayout7.xml": "e4d86b009a8ca6ca9ecfadc97c68b7123b60544df09a7ea42864a4f5f74ce09c",
    "ppt/slideLayouts/slideLayout8.xml": "950b9d16468d58fe59a8c0aeb17a03b7d18a9f5bbeac438e38a2248462a72cbe",
    "ppt/slideLayouts/slideLayout9.xml": "4e9439878755a7faea188d684939b2fb7d26b7e09086e792789f9137ca353e15",
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": "52e5efa51d86e5426d78ad9b143b863e71d00c269f6494e759cf0b3adc900116",
    "ppt/slideMasters/slideMaster1.xml": "44cc65956f47c1cf689803dcc7a1d9225c93d3fd90754a9f85e2bdcea27565bc",
    "ppt/slides/_rels/slide1.xml.rels": "c56574a33fad9499b4afedfd47a59b0bc3bc892a903840b64a04b7c59b25b005",
    "ppt/slides/_rels/slide2.xml.rels": "1b6bab14a97dbc4e6fc52c3e80f6e7ce7460222c53f4540928d2aa6faea8e6d7",
    "ppt/slides/_rels/slide3.xml.rels": "c56574a33fad9499b4afedfd47a59b0bc3bc892a903840b64a04b7c59b25b005",
    "ppt/slides/slide1.xml": "15d49c6128dc51e4f5ec9977e5c05327e6b3a4d01982156299afdd8f641c3c59",
    "ppt/slides/slide2.xml": "37efb4020cb7b1698340dfa34ae762cd8be1563a357fcbd6b252dc8cb525b111",
    "ppt/slides/slide3.xml": "ebe381636225ffc1f433d0c39b9546a3d4fc0e74cf6b0b77820f600084973447",
    "ppt/tableStyles.xml": "0e7ac03251337ecbaf6c8ca13619db1caeda5c90c4e3210d45d6c3f5df4de103",
    "ppt/theme/theme1.xml": "4c3412087e8fa20cf5642f42e69f1e733881c28611a2bdd4622654ee313d214e",
    "ppt/viewProps.xml": "f2e3578e8a2a2607ca7f850d99f2cbe5f22806084c8e519bb754388ed7ebdb69",
}


def _part_hashes(pptx):
    with zipfile.ZipFile(pptx) as package:
        return {name: hashlib.sha256(package.read(name)).hexdigest() for name in package.namelist()}


def test_probe_output_is_byte_identical_to_the_frozen_port(converted):
    """M1-R59: the soft-mask compatibility fix changes nothing on a deck without soft-masked images."""
    _, out = converted
    assert _part_hashes(out) == PROBE_STD_PARTS_24A855B


@pytest.mark.parametrize("page_index, case", [(SMASK_PAGE, "opaque-alpha"), (MASK_SIZE_PAGE, "mask-size")])
def test_soft_masked_image_page_converts(tmp_path, page_index, case):
    """M1-R59: two kinds of soft-masked images made the frozen line raise, and with it the whole deck.

    * opaque-alpha (atlas-smoke page 12): PowerPoint's images whose /SMask has /Matte. PyMuPDF 2.1 loads them with an
      alpha channel of their own, all opaque, and combining that with the mask raised "color pixmap must not have an
      alpha channel". An opaque alpha used as it is would paint each one as a solid box.
    * mask-size (atlas-smoke page 38, atlas/fonts/01, bitmap text): a 2 x 2 px colour image whose mask is the glyphs
      at full size; MuPDF combines only same-size pixmaps ("color and mask pixmaps must be the same size").

    Both pages now convert, and every picture's alpha is exactly its soft mask."""
    import numpy as np
    import pymupdf
    from PIL import Image

    from harness.baseline.proto import convert

    with pymupdf.open(str(ATLAS_SMOKE)) as source:
        masks = []
        for info in source[page_index].get_images(full=True):
            if info[1]:
                base, mask = pymupdf.Pixmap(source, info[0]), pymupdf.Pixmap(source, info[1])
                if case == "opaque-alpha":  # the case that crashed
                    assert base.alpha and (base.width, base.height) == (mask.width, mask.height)
                else:
                    assert not base.alpha and base.width * base.height < mask.width * mask.height
                masks.append(np.frombuffer(mask.samples, np.uint8).reshape(mask.height, mask.width))
        assert masks and all(m.min() < 255 for m in masks), "the test page lost its soft-masked images"
        page = pymupdf.open()
        page.insert_pdf(source, from_page=page_index, to_page=page_index)
    pdf = tmp_path / "smask-page.pdf"
    page.save(str(pdf))
    page.close()

    result = convert(pdf, tmp_path / "smask-page.pptx")
    assert result["pages"] == 1 and result["pictures"] == len(masks)
    with zipfile.ZipFile(tmp_path / "smask-page.pptx") as package:
        # one picture per image; identical pictures share one media part (on page 38 PyMuPDF attributes all eleven
        # identical 2 x 2 images to one xref, and the frozen logic places that one with its mask eleven times)
        media = [name for name in package.namelist() if name.startswith("ppt/media/")]
        assert media and len(media) <= len(masks)
        for name in media:
            with Image.open(io.BytesIO(package.read(name))) as image:
                assert image.mode == "RGBA"
                alpha = np.asarray(image.getchannel("A"))
            assert any(np.array_equal(alpha, mask) for mask in masks), f"{name}: its alpha is not its soft mask"


def test_source_has_no_absolute_local_paths():
    import re

    src = (Path(__file__).parent / "proto.py").read_text(encoding="utf-8")
    assert not re.search(r"(?<![A-Za-z])[A-Za-z]:[\\/]", src), "drive-letter path in proto.py"
    assert "/Users/" not in src and "/home/" not in src
