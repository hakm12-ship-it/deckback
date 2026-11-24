"""harness/fonts/ps_family.py: the PostScript-name table from its curated source and the lock, its file and what S6
reads back from it (ruling M4-R8: no font file is read, so it is the same on any machine)."""

import json
from pathlib import Path

import pytest

from harness.fonts import ps_family

REPO = Path(__file__).resolve().parents[2]
COMMITTED = REPO / "packages" / "core" / "src" / "fonts" / "ps-family.ts"
LOCK = REPO / "harness" / "fonts" / "fonts.lock.json"


def test_the_committed_table_is_what_the_generator_writes_from_its_sources():
    # reproducible on any machine: the curated list and the lock alone
    assert ps_family.render_ts(ps_family.build()) == COMMITTED.read_text(encoding="utf-8")


def test_the_lock_faces_and_their_styles():
    faces = ps_family.lock_faces()
    lock = json.loads(LOCK.read_text(encoding="utf-8"))
    assert set(faces) == {f["postscriptName"] for fam in lock["families"] for f in fam["files"]}
    assert faces["GothicA1-Bold"] == ["Gothic A1", "Bold"]
    assert faces["Pretendard-Light"] == ["Pretendard Light", "Regular"]
    assert faces["NanumGothicBold"] == ["NanumGothic", "Bold"]
    assert faces["NanumGothicExtraBold"] == ["NanumGothicExtraBold", "Regular"]
    assert faces["SourceSans3-Regular"] == ["Source Sans 3", "Regular"]


def test_build_refuses_a_family_outside_the_sources_and_a_name_given_twice(tmp_path):
    curated = tmp_path / "ps-family.json"
    curated.write_text(json.dumps({"faces": [["SegoeUISymbol", "Segoe UI Symbol", "Regular"]]}), encoding="utf-8")
    with pytest.raises(ValueError, match="Segoe UI Symbol"):
        ps_family.build(curated)
    curated.write_text(json.dumps({"faces": [["Arial", "Arial", "Regular"], ["Arial", "Arial", "Bold"]]}),
                       encoding="utf-8")
    with pytest.raises(ValueError, match="twice"):
        ps_family.build(curated)
    curated.write_text(json.dumps({"faces": [["HYNew-Medium", "HYNew-Medium", "Regular"]]}), encoding="utf-8")
    assert ps_family.build(curated)["HYNew-Medium"] == ["HYNew-Medium", "Regular"]  # the HY family


def test_the_table_renders_and_parses_back_and_refuses_what_is_not_a_name():
    table = {"MalgunGothic": ["Malgun Gothic", "Regular"], "Arial-BoldMT": ["Arial", "Bold"]}
    text = ps_family.render_ts(table)
    assert ps_family.parse_ts(text) == table
    assert text.index('"Arial-BoldMT"') < text.index('"MalgunGothic"')  # name order
    for bad in ({"C:\\fonts\\x": ["X", "Regular"]}, {"X": ["X"]}, {"X": ["", "Regular"]}, {"X": ["X", 1]}):
        with pytest.raises(ValueError):
            ps_family.render_ts(bad)
    with pytest.raises(ValueError):
        ps_family.parse_ts("export const OTHER = {};")


def test_the_committed_table_holds_the_lock_and_the_windows_faces():
    table = ps_family.parse_ts(COMMITTED.read_text(encoding="utf-8"))
    for ps, family in (("MalgunGothic", "Malgun Gothic"), ("MalgunGothicBold", "Malgun Gothic"),
                       ("MalgunGothic-Semilight", "Malgun Gothic Semilight"), ("Dotum", "Dotum"),
                       ("Gungsuh", "Gungsuh"), ("ArialMT", "Arial"), ("TimesNewRomanPSMT", "Times New Roman"),
                       ("SegoeUI-Bold", "Segoe UI"), ("NotoSansKR-Bold", "Noto Sans KR"), ("H2gtrM", "HYGothic-Medium"),
                       ("GothicA1-Regular", "Gothic A1"), ("NanumGothicBold", "NanumGothic")):
        assert table[ps][0] == family, ps
    families = ps_family.known_families(COMMITTED)
    assert {"Malgun Gothic", "Gothic A1", "NanumGothic", "Noto Sans KR", "Calibri", "Consolas"} <= families
