"""Ruling M4-R8: the committed font tables name only families of public sources.

The sources are spec section 7's list (Malgun Gothic, Gulim, Batang, Dotum, Gungsuh, the HY family, the Nanum family,
Noto Sans KR, Pretendard, Arial, Calibri, Segoe UI, Times New Roman, Cambria, Consolas), harness/fonts/fonts.lock.json
and the Windows fonts of the atlas-win build (harness/atlas/deck.py ROLES['windows'] and the emoji slide's
harness/atlas/sections/text.py EMOJI_FONT). Nothing derived from a private deck, nothing from one PC's installed fonts.
The list below is the ruling's, kept here on its own so that a table, its curated source or a calibration run cannot
widen it unseen.
"""

import json
from pathlib import Path

from harness.fonts import baseline_calib, ps_family

REPO = Path(__file__).resolve().parents[2]
LOCK = REPO / "harness" / "fonts" / "fonts.lock.json"
PS_TABLE = REPO / "packages" / "core" / "src" / "fonts" / "ps-family.ts"
CALIB_TABLE = REPO / "packages" / "core" / "src" / "passes" / "baseline-calib.ts"
CURATED = REPO / "harness" / "fonts" / "ps-family.json"

SPEC_FAMILIES = ("Malgun Gothic", "Gulim", "Batang", "Dotum", "Gungsuh", "Noto Sans KR", "Pretendard", "Arial",
                 "Calibri", "Segoe UI", "Times New Roman", "Cambria", "Consolas")
SPEC_PREFIXES = ("HY", "Nanum")  # the HY family, the Nanum family


def _allowed():
    from harness.atlas.deck import ROLES
    from harness.atlas.sections.text import EMOJI_FONT

    lock = {fam["family"] for fam in json.loads(LOCK.read_text(encoding="utf-8"))["families"]}
    atlas_win = {font.family for font in ROLES["windows"].values()} | {EMOJI_FONT}
    return lock | atlas_win | set(SPEC_FAMILIES)


def _outside(families):
    allowed = _allowed()
    return sorted(f for f in families if f not in allowed and not f.startswith(SPEC_PREFIXES))


def test_the_postscript_name_table_names_only_public_families():
    table = ps_family.parse_ts(PS_TABLE.read_text(encoding="utf-8"))
    assert table
    assert _outside({family for family, _ in table.values()}) == []


def test_the_baseline_calibration_names_only_public_families():
    table = baseline_calib.parse_ts(CALIB_TABLE.read_text(encoding="utf-8"))
    families = [f for f in table if not f.startswith("_")]
    assert families
    assert _outside(families) == []
    # an alias is a calibrated family's Korean name, and only of a family the table holds
    assert set(table["_alias"].values()) <= set(families)


def test_the_curated_source_and_the_calibration_runs_name_only_public_families():
    faces = json.loads(CURATED.read_text(encoding="utf-8"))["faces"]
    assert _outside({family for _, family, _ in faces}) == []
    assert _outside(baseline_calib.WINDOWS_FAMILIES) == []
    assert _outside(baseline_calib.lock_families()[0]) == []


def test_the_rule_itself():
    assert _outside(["Malgun Gothic", "Malgun Gothic Semilight", "HYGothic-Medium", "NanumSquare Neo Bold",
                     "Gothic A1", "Pretendard Black", "Segoe UI", "Segoe UI Emoji"]) == []
    assert _outside(["Calibri Light", "Arial Black", "Bodoni MT", "GulimChe", "Segoe UI Symbol"]) == [
        "Arial Black", "Bodoni MT", "Calibri Light", "GulimChe", "Segoe UI Symbol"]
