"""triage.py (M8): merge, the font rule, the bar's numbers and the cause tags, on hand-made results; and the r0
re-score from the committed results files (609 / 1,172 -> 614 / 1,167 -> 618 / 1,163 under the font rule of r0)."""

from pathlib import Path

import pytest

from harness.fidelity import run, triage

REPO = Path(__file__).resolve().parents[2]
R0 = REPO / "fidelity" / "results" / "2026-11-19-deckback-m8-r0.json"
R0_FONTS = REPO / "fidelity" / "results" / "2026-11-19-deckback-m8-r0-fonts.json"


def gate(status="pass", detail=""):
    return {"status": status, "detail": detail}


def slide(index=0, *, v1=None, v2=True, passed=None, **s_bad):
    s = {key: gate() for key in triage.S_GATES}
    s.update({key: gate("fail", detail) for key, detail in s_bad.items()})
    record = {"index": index, "label": None, "v1": None if v1 is None else {"pass": v1, "raw_px32": 0.1, "px32_shift1": 0.0},
              "v2": {"pass": v2, "raw_px32": 0.1, "px32_shift1": 0.0}, "noise": None, "s": s, "known": [],
              "pass": None, "heatmaps": {}}
    record["pass"] = run.slide_passes(record) if passed is None else passed
    return record


def deck(deck_id, slides, *, bar=True, set_="real", render="ok"):
    return {"id": deck_id, "public": True, "set": set_, "variant": "pdf", "pages": len(slides), "bar": bar,
            "origin": "powerpoint-windows" if bar else "other",
            "exitCodes": {"input": 0, "convert": 0, "render": 0, "groundTruth": None},
            "reasons": {"input": "ok", "convert": "ok", "render": render, "groundTruth": None}, "convert": None,
            "slides": slides}


def results(*decks):
    return {"schema": run.SCHEMA_ID, "options": {"decks": ["real"], "variants": [], "s7": True, "limitSlides": None},
            "decks": list(decks), "summary": {"privateUnreadable": 0, "powerpoint": None}}


# ---- merge ---------------------------------------------------------------------------------------------------------


def test_merge_replaces_the_remeasured_real_decks_and_records_them():
    base = results(deck("b-aaaaaaaaaa", [slide(v2=False)]), deck("b-bbbbbbbbbb", [slide(v2=False)]))
    again = results(deck("b-bbbbbbbbbb", [slide(v2=True)]))
    merged = triage.merge(base, again)
    assert [d["slides"][0]["pass"] for d in merged["decks"]] == [False, True]
    assert merged["options"]["merged"] == ["b-bbbbbbbbbb"]
    assert merged["summary"]["bar"]["pass"] == 1 and merged["summary"]["bar"]["fail"] == 1
    assert base["decks"][1]["slides"][0]["pass"] is False  # the inputs are not touched


def test_merge_refuses_a_deck_the_base_does_not_have():
    with pytest.raises(ValueError, match="b-cccccccccc"):
        triage.merge(results(deck("b-aaaaaaaaaa", [slide()])), results(deck("b-cccccccccc", [slide()])))


def test_off_bar_slides_are_not_failures_in_a_rebuilt_summary():
    base = results(deck("b-aaaaaaaaaa", [slide()]),
                   deck("b-bbbbbbbbbb", [slide(passed=False)], bar=False, render=run.OFF_BAR))
    summary = triage.with_summary(base)["summary"]
    assert (summary["slides"], summary["pass"], summary["fail"], summary["notMeasured"]) == (2, 1, 0, 1)
    assert summary["bar"]["slides"] == 1


# ---- the font rule -------------------------------------------------------------------------------------------------


def test_font_exception_of_prefers_the_commercial_font_over_the_substitution():
    assert triage.font_exception_of({"Arial"}, ["ArialMT"]) == run.MUPDF_SUBSTITUTION
    assert triage.font_exception_of({"ms pgothic"}, ["ArialMT"]) == run.MISSING_FONT  # any case
    assert triage.font_exception_of({"Arial"}, []) is None
    assert triage.font_exception_of({"Arial"}, ["ArialMT"], mupdf=False) is None


def test_apply_font_rule_judges_again_and_leaves_the_measurements():
    base = results(deck("b-aaaaaaaaaa", [slide(0, v2=False), slide(1, v2=False, S7="x"), slide(2, v1=False, v2=False),
                                         slide(3, S7="text differs"), slide(4)]))
    fonts = {0: ({"Arial"}, ["ArialMT"]), 1: ({"MS PGothic"}, []), 2: ({"Arial"}, ["ArialMT"]),
             3: ({"Arial"}, ["ArialMT"])}
    out = triage.apply_font_rule(base, lambda _id: [fonts.get(i, (set(), [])) for i in range(5)])
    slides = out["decks"][0]["slides"]
    assert [s.get("fontException") for s in slides] == [run.MUPDF_SUBSTITUTION, run.MISSING_FONT,
                                                         run.MUPDF_SUBSTITUTION, run.MUPDF_SUBSTITUTION, None]
    # 0: V2 left out; 1: S7 still fails; 2: V1 still judges; 3: S7 still fails; 4: no exception, passes
    assert [s["pass"] for s in slides] == [True, False, False, False, True]
    assert slides[0]["v2"]["pass"] is False  # measured values stay
    assert out["options"]["commercialMissing"] == ["MS PGothic"]
    assert out["summary"]["bar"]["fontException"] == {"total": 4, "mupdf-substitution": 3, "missing-font": 1, "font-version": 0, "pass": 1}
    again = triage.apply_font_rule(out, lambda _id: [(set(), [])] * 5)
    assert again["decks"][0]["slides"][0].get("fontException") is None and again["decks"][0]["slides"][0]["pass"] is False


def test_apply_font_rule_counts_version_unverifiable_slides_without_excepting_them():
    """Amended M8-R9: a font whose advances cannot be compared is not flagged on its version string; the slide keeps no
    exception and is counted as version-unverifiable (a fourth page entry)."""
    base = results(deck("b-aaaaaaaaaa", [slide(0, v2=False), slide(1, v2=False), slide(2)]))
    fonts = {0: (set(), [], ["Probe-Regular"], []), 1: (set(), [], [], ["Probe-Bold"]), 2: (set(), [], [], [])}
    out = triage.apply_font_rule(base, lambda _id: [fonts[i] for i in range(3)])
    slides = out["decks"][0]["slides"]
    assert [s.get("fontException") for s in slides] == [run.FONT_VERSION, None, None]
    assert [s.get("fontVersionUnverifiable", False) for s in slides] == [False, True, False]
    assert out["options"]["fontVersionUnverifiable"] == {"slides": 1}


def test_failing_gates_follow_the_exception():
    s = slide(v1=False, v2=False, S3="x")
    assert triage.failing_gates(s) == ["V1", "V2", "S3"]
    assert triage.failing_gates({**s, "fontException": run.MUPDF_SUBSTITUTION}) == ["V1", "S3"]
    assert triage.failing_gates({**s, "fontException": run.MISSING_FONT}) == ["S3"]


def test_bar_numbers_count_the_bar_only():
    out = triage.with_summary(results(deck("b-aaaaaaaaaa", [slide(v2=False), slide(), slide(S5="x")]),
                                      deck("b-bbbbbbbbbb", [slide()], bar=False, render=run.OFF_BAR),
                                      deck("b-cccccccccc", [slide(v2=False)], set_="atlas", bar=None)))
    numbers = triage.bar_numbers(out)
    assert (numbers["decks"], numbers["slides"], numbers["pass"], numbers["fail"]) == (1, 3, 1, 2)
    assert numbers["gates"]["V2"] == {"pass": 2, "fail": 1, "na": 0} and numbers["gates"]["S5"]["fail"] == 1
    assert triage.bar_numbers(results(deck("b-bbbbbbbbbb", [slide()], bar=False))) is None


# ---- the causes ----------------------------------------------------------------------------------------------------


INFO = {"alpha0": 0, "symbols": 0, "size": [960.0, 540.0], "offPageImages": 0}


def tags(s, detail=None, info=None, residual=None, fonts=(set(), [])):
    return triage.tags_for(s, triage.failing_gates(s), detail or {}, info or INFO, residual, fonts)


def test_s3_kinds_name_what_the_detail_says():
    text = ("; 2 shadings, 1 gradFill; 0 patterns, 0 pattern fills (pattFill or tiled picture); shadings without a "
            "gradFill (0.5 pt): 1 ([0.0, 0.0, 9.0, 9.0]); pictures covering a shading or pattern: picture 1 covers")
    assert triage.s3_kinds(text) == ["picture covers shading", "shading without gradFill"]


def test_tags_name_the_s3_rule_the_off_page_paints_and_the_numeric_font():
    s = slide(S3="x")
    assert tags(s, {"S3": ["picture covers shading"]}) == ["S3 rule: picture over shading / degenerate gradient"]
    off = "unmatched PDF drawings: 2 (fill [-50.0, 10.0, -20.0, 30.0] #000000; fill [1000.0, 0.0, 1010.0, 5.0] #000000)"
    assert tags(s, {"S3": ["unmatched drawings"], "S3text": off}) == ["off-page content dropped"]
    dots = "unmatched PDF drawings: 1 (stroke [5.0, 5.0, 5.0, 5.0] #000000)"
    assert tags(s, {"S3": ["unmatched drawings"], "S3text": dots}) == ["zero-length strokes (dots) dropped"]
    assert "font: numeric family name (PPTX-embedded font)" in tags(slide(v2=False), fonts=({"7"}, []))


def test_tags_read_where_the_residual_lies_with_the_cutoffs():
    s = slide(v1=False, v2=False)
    assert tags(s, residual={"v1Px": 900, "v1Share": {"text": 0.5}}) == ["text drift (line direction)"]
    assert tags(s, residual={"v1Px": 900, "v1Share": {"text": 0.49, "image": 0.5}}) == ["picture pixels"]
    assert tags(s, residual={"v1Px": 900, "v1Share": {"text": 0.2, "drawing": 0.8}}) == ["vector edges (pixels)"]
    assert tags(slide(v1=True, v2=False), residual={"v2Px": 900, "v2Share": {"text": 1.0}}) == [
        "renderer noise (V1 passes)"]
    assert tags(s, residual={"v1Px": 0}) == ["renderer noise (px32_shift1 only)"]


def test_primary_cause_is_the_first_tag_in_priority_and_a_missing_font_slide_judges_by_s_gates():
    both = ["text drift (line direction)", "symbol-font glyph (Wingdings bullet)", "off-page content dropped"]
    assert triage.primary_cause(both, ["V1", "S2"]) == "off-page content dropped"
    assert triage.primary_cause(["text drift (line direction)"], ["V1"], run.MISSING_FONT) == triage.EXCEPTION_PASSES
    assert triage.primary_cause(["text drift (line direction)", "off-page content dropped"], ["V1", "S2"],
                                run.MISSING_FONT) == "off-page content dropped"
    assert all(cause in triage.PRIORITY for cause in both)


def test_cause_table_counts_primary_any_and_decks():
    records = [{"id": "b-aaaaaaaaaa", "primary": "picture pixels",
                "tags": ["picture pixels", "text drift (line direction)"]},
               {"id": "b-aaaaaaaaaa", "primary": "picture pixels", "tags": ["picture pixels"]},
               {"id": "b-bbbbbbbbbb", "primary": "text drift (line direction)", "tags": ["text drift (line direction)"]}]
    rows = {row["cause"]: row for row in triage.cause_table(records)}
    assert rows["picture pixels"] == {"cause": "picture pixels", "primary": 2, "any": 2, "decks": 1,
                                      "top": [("b-aaaaaaaaaa", 2)]}
    assert (rows["text drift (line direction)"]["primary"], rows["text drift (line direction)"]["any"]) == (1, 2)


# ---- r0, re-scored from the committed files -----------------------------------------------------------------------

# the nine slides (0-based pages) of the one deck that used the commercial font MS PGothic missing on the measuring PC
PGOTHIC_DECK = "b-8cc9a6b767"
PGOTHIC_PAGES = {47, 48, 49, 50, 53, 54, 55, 82, 87}


@pytest.mark.skipif(not (R0.is_file() and R0_FONTS.is_file()), reason="the committed r0 results are not here")
def test_r0_rescored_with_the_old_rules_keeps_its_totals_and_the_new_rule_is_the_only_change():
    r0, again = triage.load(R0), triage.load(R0_FONTS)
    assert (triage.bar_numbers(r0)["pass"], triage.bar_numbers(r0)["fail"]) == (609, 1172)
    merged = triage.merge(r0, again)
    strict = triage.bar_numbers(merged)
    assert (strict["slides"], strict["pass"], strict["fail"]) == (1781, 614, 1167)  # the font re-measure of 18 decks

    def page_fonts(deck_id):
        if deck_id == PGOTHIC_DECK:
            return [({"MS PGothic"}, []) if i in PGOTHIC_PAGES else (set(), []) for i in range(200)]
        return [(set(), [])] * 200

    old = triage.apply_font_rule(merged, page_fonts, mupdf=False)  # spec 5.5 only: the rules r0 was judged by
    numbers = triage.bar_numbers(old)
    assert (numbers["slides"], numbers["pass"], numbers["fail"]) == (1781, 618, 1163)
    assert numbers["fontException"] == {"total": 9, "mupdf-substitution": 0, "missing-font": 9, "font-version": 0, "pass": 5}
    # off the bar, 5,959 slides were never measured and are in neither count
    assert old["summary"]["notMeasured"] == 5959 and old["summary"]["slides"] == 8201
    assert old["summary"]["pass"] + old["summary"]["fail"] == 8201 - 5959
