"""Tests for the pure parts of the M0-5 fill-rule spike (layout, classification, inference).

The PowerPoint rendering itself is exercised by running m0_5_fillrule.py.
"""

import pytest
from pptx import Presentation

from harness.spikes import m0_5_fillrule as spike

EMU_PER_PT = 12700


def signed_area(points):
    """Shoelace sum in a y-down frame: > 0 means clockwise on screen."""
    total = 0
    for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1]):
        total += x0 * y1 - x1 * y0
    return total


def path_subpaths(shape):
    """Return, per a:path, the list of its subpaths as [(x, y), ...] in path coordinates."""
    result = []
    for path in shape._element.xpath(".//a:path"):
        subpaths = []
        for node in path:
            tag = node.tag.split("}")[1]
            if tag == "moveTo":
                subpaths.append([])
            if tag in ("moveTo", "lnTo"):
                pt = node.xpath("./a:pt")[0]
                subpaths[-1].append((int(pt.get("x")), int(pt.get("y"))))
        result.append(subpaths)
    return result


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    pptx = tmp_path_factory.mktemp("fillrule") / "fillrule.pptx"
    centres, positives = spike.build(pptx)
    return Presentation(str(pptx)), centres, positives


def test_four_shapes_with_the_specified_path_structure(built):
    prs, _, _ = built
    shapes = list(prs.slides[0].shapes)
    assert len(shapes) == 4
    structure = [[len(p) for p in path_subpaths(s)] for s in shapes]
    assert structure == [[2], [2], [2], [1, 1]]  # A, B, C in one a:path; D as two a:path


def test_winding_directions_match_the_labels(built):
    prs, _, _ = built
    a, b, c, d = (path_subpaths(s) for s in prs.slides[0].shapes)
    clockwise = lambda pts: signed_area(pts) > 0  # noqa: E731
    assert [clockwise(p) for p in a[0]] == [True, True]       # A: both clockwise
    assert [clockwise(p) for p in b[0]] == [True, False]      # B: outer cw, inner ccw
    assert [clockwise(p) for p in c[0]] == [True, True]       # C: outer cw, inner cw
    assert [clockwise(p[0]) for p in d] == [True, True]       # D: as A


def subpaths_containing(shape, point_pt):
    """The subpaths of `shape` (all squares, axis-aligned) whose interior holds the slide point."""
    px = point_pt[0] * EMU_PER_PT - shape.left
    py = point_pt[1] * EMU_PER_PT - shape.top
    hits = []
    for sp in (sp for path in path_subpaths(shape) for sp in path):
        xs, ys = [p[0] for p in sp], [p[1] for p in sp]
        if min(xs) < px < max(xs) and min(ys) < py < max(ys):
            hits.append(sp)
    return hits


def test_sample_points_lie_where_the_experiment_needs_them(built):
    prs, centres, _ = built
    assert set(centres) == {"A", "B", "C", "D"}
    for name, shape in zip("ABCD", prs.slides[0].shapes):
        # A, B, C, D: the decisive point lies inside both subpaths (A, C, D: winding 2 / B: 0, but inside both).
        assert len(subpaths_containing(shape, centres[name])) == 2, name


def test_positive_points_are_inside_exactly_one_subpath(built):
    """Such a point is filled by every fill rule (winding +-1, odd parity), so it must render filled."""
    prs, _, positives = built
    shapes = dict(zip("ABCD", prs.slides[0].shapes))
    assert set(positives) == {
        "A_first", "A_second", "D_first", "D_second",
        "B_ring_left", "B_ring_bottom", "C_ring_left", "C_ring_bottom",
    }
    for label, point in positives.items():
        assert len(subpaths_containing(shapes[label[0]], point)) == 1, label


def test_classify_uses_a_tolerance_of_24():
    assert spike.classify((0x1F, 0x4E, 0x79)) == "filled"
    assert spike.classify((0x1F + 24, 0x4E - 24, 0x79)) == "filled"
    assert spike.classify((255, 255, 255)) == "empty"
    assert spike.classify((255 - 24, 255, 255)) == "empty"
    with pytest.raises(ValueError):
        spike.classify((0x1F + 25, 0x4E, 0x79))
    with pytest.raises(ValueError):
        spike.classify((140, 160, 190))  # neither fill nor background


ALL_FILLED = ["filled"] * 8


@pytest.mark.parametrize(
    "a, b, c, rule",
    [
        ("filled", "empty", "filled", "nonzero"),
        ("empty", "empty", "empty", "evenodd"),
        ("filled", "filled", "filled", "mixed"),  # holes ignored altogether
        ("filled", "empty", "empty", "mixed"),
        ("empty", "empty", "filled", "mixed"),
    ],
)
def test_infer_rule(a, b, c, rule):
    assert spike.infer_rule(a, b, c, ALL_FILLED) == rule


@pytest.mark.parametrize("a, b, c", [("filled", "empty", "filled"), ("empty", "empty", "empty")])
def test_infer_rule_is_mixed_unless_every_positive_sample_is_filled(a, b, c):
    """All-empty also happens when nothing was drawn or later subpaths were subtracted."""
    for broken in (0, 3, 7):
        positives = ["filled"] * 8
        positives[broken] = "empty"
        assert spike.infer_rule(a, b, c, positives) == "mixed"
    assert spike.infer_rule(a, b, c, ["empty"] * 8) == "mixed"
    assert spike.infer_rule(a, b, c, []) == "mixed"
