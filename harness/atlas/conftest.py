"""Shared fixtures and helpers for the atlas tests.

`atlas_ofl`, `probe_ofl` and `sizes_ofl` build their recipe once per test session with `--fonts ofl`. The OFL font
check is monkeypatched to report nothing missing (ruling M1-R3): authoring with python-pptx needs no installed fonts,
and CI has none. Only `test_build.py::test_missing_ofl_font_fails_fast` exercises the real check path.
"""

import json

import pytest

from harness.atlas import build
from harness.atlas import decks as recipes
from harness.atlas.drawingml import PRST_PATTERN
from harness.atlas.features import drawn_patterns, drawn_presets, drawn_warps, missing_features
from harness.fonts import fontcheck


def run_recipe(out_dir, recipe="atlas", fonts="ofl"):
    """Run the build CLI in-process with the font check passing; return {deck name: (pptx path, manifest dict)}
    for every deck the recipe writes."""
    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(fontcheck, "missing_ofl", lambda *args, **kwargs: [])
        code = build.main(["--deck", recipe, "--fonts", fonts, "--out", str(out_dir)])
    assert code == 0
    built = {}
    for spec in recipes.RECIPES[recipe](fonts):
        manifest = json.loads((out_dir / f"{spec.name}.manifest.json").read_text(encoding="utf-8"))
        built[spec.name] = (out_dir / f"{spec.name}.pptx", manifest)
    return built


def run_build(out_dir, deck="atlas", fonts="ofl"):
    """Build a one-deck recipe; return (pptx path, manifest dict)."""
    return run_recipe(out_dir, deck, fonts)[deck]


def feature_problems(prs, manifest):
    """Every declared feature must be on its slide (harness/atlas/features.py), and the preset families that are
    complete per slide (prstGeom, pattFill, prstTxWarp) must equal exactly what the slide draws."""
    problems = []
    for slide, entry in zip(prs.slides, manifest["slides"], strict=True):
        features = entry["features"]
        problems += [f"{entry['id']}: {f}" for f in missing_features(slide, features)]
        declared_geoms = {f.split(":", 1)[1] for f in features if f.startswith("prstGeom:")}
        if declared_geoms != set(drawn_presets(slide._element)):
            problems.append(f"{entry['id']}: prstGeom features {sorted(declared_geoms)} != drawn")
        declared_patterns = {f.split(":", 1)[1] for f in features if f.startswith("pattFill:")} & set(PRST_PATTERN)
        if declared_patterns != set(drawn_patterns(slide._element)):
            problems.append(f"{entry['id']}: pattFill features {sorted(declared_patterns)} != drawn")
        declared_warps = {f.split(":", 1)[1] for f in features if f.startswith("prstTxWarp:")}
        if declared_warps != set(drawn_warps(slide._element)):
            problems.append(f"{entry['id']}: prstTxWarp features {sorted(declared_warps)} != drawn")
    return problems


@pytest.fixture(scope="session")
def atlas_ofl(tmp_path_factory):
    return run_build(tmp_path_factory.mktemp("atlas-ofl"))


@pytest.fixture(scope="session")
def probe_ofl(tmp_path_factory):
    return run_build(tmp_path_factory.mktemp("probe-ofl"), "probe")


@pytest.fixture(scope="session")
def sizes_ofl(tmp_path_factory):
    return run_recipe(tmp_path_factory.mktemp("sizes-ofl"), "sizes")
