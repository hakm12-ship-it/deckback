"""Tests for the first four atlas sections: shapes, lines, fills, effects (Task 6a).

The deck is re-opened with python-pptx; section membership comes from the manifest, which
`test_build.py::test_every_slide_has_label_matching_manifest` ties to the on-slide labels.
"""

from collections import Counter

import pytest
from pptx import Presentation

from harness.atlas.drawingml import (
    BEVEL_PRESETS,
    COMPOUND_LINES,
    LINE_CAPS,
    LINE_END_SIZES,
    LINE_END_TYPES,
    LINE_JOINS,
    PRST_DASH,
    PRST_PATTERN,
    ST_SHAPE_TYPE,
)

MINIMA = {"shapes": 20, "lines": 10, "fills": 14, "effects": 10}
TEXT_EFFECT_PATH = ".//p:txBody//a:rPr/a:effectLst/a:{}"
SHAPE_EFFECT_PATH = ".//p:spPr/a:effectLst/a:{}"


@pytest.fixture(scope="module")
def sections(atlas_ofl):
    """{section: [slide element, ...]} in deck order."""
    pptx_path, manifest = atlas_ofl
    prs = Presentation(str(pptx_path))
    out = {}
    for slide, entry in zip(prs.slides, manifest["slides"], strict=True):
        out.setdefault(entry["section"], []).append(slide._element)
    return out


def values(elements, xpath):
    found = []
    for element in elements:
        found.extend(element.xpath(xpath))
    return found


def test_sections_a_counts_and_presets(atlas_ofl, sections):
    _, manifest = atlas_ofl
    counts = Counter(entry["section"] for entry in manifest["slides"])
    for section, minimum in MINIMA.items():
        assert counts[section] >= minimum, f"{section}: {counts[section]} slides < {minimum}"

    # every ST_ShapeType preset is drawn in the shapes section, 12 per slide
    shape_prsts = values(sections["shapes"], ".//a:prstGeom/@prst")
    assert set(shape_prsts) == set(ST_SHAPE_TYPE)
    first_slides = sections["shapes"][: -(-len(ST_SHAPE_TYPE) // 12)]
    for slide in first_slides:
        assert len(slide.xpath(".//p:sp[not(p:nvSpPr/p:cNvSpPr/@txBox)]/p:spPr/a:prstGeom")) <= 12
    # nothing outside the enumeration anywhere in the deck (PowerPoint would refuse it)
    all_slides = [s for group in sections.values() for s in group]
    assert set(values(all_slides, ".//a:prstGeom/@prst")) <= set(ST_SHAPE_TYPE)

    # every prstPattern occurs
    assert set(PRST_PATTERN) <= set(values(sections["fills"], ".//a:pattFill/@prst"))
    assert set(values(all_slides, ".//a:pattFill/@prst")) <= set(PRST_PATTERN)


def test_shapes_section_rotates_flips_and_groups(sections):
    shapes = sections["shapes"]
    assert any(int(r) % 21600000 for r in values(shapes, ".//p:sp/p:spPr/a:xfrm/@rot"))
    assert values(shapes, ".//p:sp/p:spPr/a:xfrm[@flipH='1']")
    assert values(shapes, ".//p:sp/p:spPr/a:xfrm[@flipV='1']")
    assert values(shapes, ".//p:grpSp")
    assert values(shapes, ".//p:grpSp//p:grpSp"), "a nested group"
    assert values(shapes, ".//p:grpSp/p:grpSpPr/a:xfrm[@rot]"), "a rotated group"
    assert values(shapes, ".//p:grpSp/p:grpSpPr/a:xfrm[@flipH='1']"), "a flipped group"
    assert values(shapes, ".//a:prstGeom/a:avLst/a:gd"), "adjusted presets"


def test_lines_section_covers_dashes_caps_joins_compounds_ends_connectors(sections):
    lines = sections["lines"]
    assert set(values(lines, ".//a:ln/a:prstDash/@val")) >= set(PRST_DASH)
    assert set(values(lines, ".//a:ln/@cap")) >= set(LINE_CAPS)
    joins = {el.tag.split("}")[1] for el in values(lines, ".//a:ln/a:round | .//a:ln/a:bevel | .//a:ln/a:miter")}
    assert joins >= set(LINE_JOINS)
    assert set(values(lines, ".//a:ln/@cmpd")) >= set(COMPOUND_LINES)
    ends = {
        (end.get("type"), end.get("w"), end.get("len"))
        for end in values(lines, ".//a:ln/a:headEnd | .//a:ln/a:tailEnd")
    }
    for end_type in LINE_END_TYPES:
        for size in LINE_END_SIZES:
            assert (end_type, size, size) in ends, f"arrowhead {end_type} {size}"
    connectors = set(values(lines, ".//p:cxnSp/p:spPr/a:prstGeom/@prst"))
    assert {"straightConnector1", "bentConnector3", "curvedConnector3"} <= connectors
    glued = values(lines, ".//p:cxnSp[p:nvCxnSpPr/p:cNvCxnSpPr/a:stCxn and p:nvCxnSpPr/p:cNvCxnSpPr/a:endCxn]")
    glued_prsts = {c.xpath("./p:spPr/a:prstGeom/@prst")[0] for c in glued}
    assert {"straightConnector1", "bentConnector3", "curvedConnector3"} <= glued_prsts


def test_fills_section_covers_solid_alpha_gradients_patterns_pictures(sections):
    fills = sections["fills"]
    alphas = {int(v) for v in values(fills, ".//p:spPr/a:solidFill/*/a:alpha/@val")}
    assert {10000, 25000, 50000, 75000, 90000} <= alphas
    angles = {int(v) for v in values(fills, ".//p:spPr/a:gradFill/a:lin/@ang")}
    assert {0, 45 * 60000, 90 * 60000, 135 * 60000} <= angles
    assert {"circle", "rect", "shape"} <= set(values(fills, ".//p:spPr/a:gradFill/a:path/@path"))
    multi = [g for g in values(fills, ".//p:spPr/a:gradFill") if len(g.xpath("./a:gsLst/a:gs")) >= 3]
    assert any(g.xpath("./a:gsLst/a:gs/*/a:alpha") for g in multi), "a multi-stop gradient with transparent stops"
    blips = values(fills, ".//p:spPr/a:blipFill")
    assert any(b.xpath("./a:tile") for b in blips), "texture tile"
    assert any(b.xpath("./a:stretch") and not b.xpath("./a:blip/a:alphaModFix") for b in blips), "picture fill"
    assert any(b.xpath("./a:blip/a:alphaModFix") for b in blips), "transparent picture fill"


def test_effects_section_applies_every_effect_to_a_shape_and_to_text(sections):
    effects = sections["effects"]
    for effect in ("outerShdw", "innerShdw", "glow", "softEdge", "reflection"):
        assert values(effects, SHAPE_EFFECT_PATH.format(effect)), f"{effect} on a shape"
        assert values(effects, TEXT_EFFECT_PATH.format(effect)), f"{effect} on text"
    # bevel: shape 3-D format (spPr) and text 3-D format (bodyPr)
    assert set(values(effects, ".//p:spPr/a:sp3d/a:bevelT/@prst")) >= set(BEVEL_PRESETS)
    assert values(effects, ".//p:txBody/a:bodyPr/a:sp3d/a:bevelT")
    # 3-D rotation: a non-front camera or an explicit camera rotation, on a shape and on text
    rotated = ".//{}/a:scene3d/a:camera[a:rot or not(@prst='orthographicFront')]"
    assert values(effects, rotated.format("p:spPr"))
    assert values(effects, rotated.format("p:txBody/a:bodyPr"))
