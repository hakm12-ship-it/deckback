"""Tests for pptx_xml.py: custGeom / gradFill XML helpers written through python-pptx."""

import io

import pytest
from pptx import Presentation
from pptx.util import Emu

from harness.spikes import pptx_xml

EMU_PER_PT = 12700


def blank_slide():
    prs = Presentation()
    prs.slide_width = Emu(960 * EMU_PER_PT)
    prs.slide_height = Emu(540 * EMU_PER_PT)
    return prs, prs.slides.add_slide(prs.slide_layouts[6])


def square(x, y, size=100):
    """Clockwise on screen (y down): top-left, top-right, bottom-right, bottom-left."""
    return [(x, y), (x + size, y), (x + size, y + size), (x, y + size)]


def test_two_subpaths_share_one_path():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(slide, [square(100, 100), square(150, 150)], "1F4E79")
    paths = shape._element.xpath(".//a:path")
    assert len(paths) == 1
    assert len(paths[0].xpath("./a:moveTo")) == 2
    assert len(paths[0].xpath("./a:lnTo")) == 6
    assert len(paths[0].xpath("./a:close")) == 2


def test_separate_paths_gives_one_path_per_subpath():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(
        slide, [square(100, 100), square(150, 150)], "1F4E79", separate_paths=True
    )
    paths = shape._element.xpath(".//a:path")
    assert len(paths) == 2
    for p in paths:
        assert len(p.xpath("./a:moveTo")) == 1
    # Both paths share the shape-wide coordinate space.
    assert paths[0].get("w") == paths[1].get("w")
    assert paths[0].get("h") == paths[1].get("h")


def test_geometry_is_relative_to_the_bounding_box():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(slide, [square(100, 100), square(150, 150)], "1F4E79")
    assert (shape.left, shape.top) == (100 * EMU_PER_PT, 100 * EMU_PER_PT)
    assert (shape.width, shape.height) == (150 * EMU_PER_PT, 150 * EMU_PER_PT)
    path = shape._element.xpath(".//a:path")[0]
    assert (path.get("w"), path.get("h")) == (str(150 * EMU_PER_PT), str(150 * EMU_PER_PT))
    first = path.xpath("./a:moveTo/a:pt")[0]
    second = path.xpath("./a:moveTo/a:pt")[1]
    assert (first.get("x"), first.get("y")) == ("0", "0")
    assert (second.get("x"), second.get("y")) == (str(50 * EMU_PER_PT), str(50 * EMU_PER_PT))


def test_cubic_segment_is_written_as_cubicbezto():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(
        slide, [[(0, 0), (100, 0), (100, 50, 50, 100, 0, 100)]], "1F4E79"
    )
    assert len(shape._element.xpath(".//a:cubicBezTo")) == 1
    assert len(shape._element.xpath(".//a:cubicBezTo/a:pt")) == 3


def test_solid_fill_and_line():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(slide, [square(10, 10)], "#1f4e79")
    assert shape._element.xpath(".//p:spPr/a:solidFill/a:srgbClr/@val") == ["1F4E79"]
    assert shape._element.xpath(".//p:spPr/a:ln/a:noFill")  # no outline by default
    other = pptx_xml.add_custgeom(slide, [square(10, 10)], (255, 0, 0), line=("00FF00", 2))
    assert other._element.xpath(".//p:spPr/a:solidFill/a:srgbClr/@val") == ["FF0000"]
    assert other._element.xpath(".//p:spPr/a:ln/@w") == [str(2 * EMU_PER_PT)]
    assert other._element.xpath(".//p:spPr/a:ln/a:solidFill/a:srgbClr/@val") == ["00FF00"]


def test_empty_subpaths_are_rejected():
    _, slide = blank_slide()
    with pytest.raises(ValueError):
        pptx_xml.add_custgeom(slide, [], "1F4E79")


def test_gradfill_writes_all_twelve_stops():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(slide, [square(0, 0, 200)], "1F4E79")
    stops = [(i / 11, "%02X%02X%02X" % (i * 20, 255 - i * 20, 128)) for i in range(12)]
    pptx_xml.add_gradfill(shape, stops, 45)
    gs = shape._element.xpath(".//a:gradFill/a:gsLst/a:gs")
    assert len(gs) == 12
    positions = [int(g.get("pos")) for g in gs]
    assert positions[0] == 0 and positions[-1] == 100000
    assert positions == sorted(positions)
    assert all(0 <= p <= 100000 for p in positions)
    assert positions[1] == round(100000 / 11)
    assert [g.xpath("./a:srgbClr/@val")[0] for g in gs] == [c for _, c in stops]
    lin = shape._element.xpath(".//a:gradFill/a:lin")[0]
    assert lin.get("ang") == str(45 * 60000)
    assert lin.get("scaled") == "0"


def test_gradfill_scaled_and_angle_normalised():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(slide, [square(0, 0, 200)], "1F4E79")
    pptx_xml.add_gradfill(shape, [(0, "000000"), (1, "FFFFFF")], -90, scaled=True)
    lin = shape._element.xpath(".//a:gradFill/a:lin")[0]
    assert lin.get("ang") == str(270 * 60000)
    assert lin.get("scaled") == "1"


def test_gradfill_replaces_the_solid_fill_and_keeps_schema_order():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(slide, [square(0, 0, 200)], "1F4E79", line=("000000", 1))
    pptx_xml.add_gradfill(shape, [(0, "000000"), (1, "FFFFFF")], 0)
    sp_pr = shape._element.xpath("./p:spPr")[0]
    assert not sp_pr.xpath("./a:solidFill")
    tags = [child.tag.split("}")[1] for child in sp_pr]
    assert tags == ["xfrm", "custGeom", "gradFill", "ln"]


def test_gradfill_needs_two_stops():
    _, slide = blank_slide()
    shape = pptx_xml.add_custgeom(slide, [square(0, 0, 200)], "1F4E79")
    with pytest.raises(ValueError):
        pptx_xml.add_gradfill(shape, [(0, "000000")], 0)


def test_saved_file_reopens_with_geometry_intact():
    prs, slide = blank_slide()
    shape = pptx_xml.add_custgeom(slide, [square(100, 100), square(150, 150)], "1F4E79")
    pptx_xml.add_gradfill(shape, [(0, "000000"), (1, "FFFFFF")], 90)
    buf = io.BytesIO()
    prs.save(buf)
    buf.seek(0)
    reopened = Presentation(buf).slides[0].shapes[0]
    assert len(reopened._element.xpath(".//a:path")) == 1
    assert len(reopened._element.xpath(".//a:gradFill/a:gsLst/a:gs")) == 2
