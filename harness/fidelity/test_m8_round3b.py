"""M8 round 3b: ruling M8-R12 (the position-verified pass), the per-line drift S7 stores for it, the pixels outside the
text lines, and the tier-C deck set (decks.py, run.py: private, 12-hex ids, reported only). Synthetic data throughout,
and one stored tier-B slide by id."""

import copy
import json
from pathlib import Path

import numpy as np
import pymupdf
import pytest

from harness.fidelity import decks, metrics, roundtrip, run
from harness.fidelity.schema_check import validate
from harness.fidelity.test_roundtrip import _text_pdf
from harness.fidelity.test_run import BLUE, RED, SCHEMA, make_pdf, tools

REPO = Path(__file__).resolve().parents[2]
R2 = REPO / "fidelity" / "results" / "2026-11-23-deckback-m8-r2.json"
S_ALL = run.S_KEYS + ("S7",)


# ---- the drift S7 stores -------------------------------------------------------------------------------------------


def test_compare_records_the_largest_drift_along_and_across_per_text_line(tmp_path):
    first = ((100, 100), "hello world")
    second = ((100, 200), "second line")
    expected = _text_pdf(tmp_path / "in.pdf", first, second)
    moved = _text_pdf(tmp_path / "rt.pdf", ((100.2, 100.05), "hello world"), ((100.0, 200.08), "second line"))
    drift = {}
    assert roundtrip.compare(expected, moved, drift=drift) == []
    [page] = drift.values()
    assert page["unassigned"] == 0 and len(page["lines"]) == 2
    (along1, across1), (along2, across2) = page["lines"]
    assert along1 == pytest.approx(0.2, abs=0.01) and across1 == pytest.approx(0.05, abs=0.01)
    assert along2 == pytest.approx(0.0, abs=0.01) and across2 == pytest.approx(0.08, abs=0.01)


def test_compare_records_no_drift_for_a_page_whose_text_differs_or_without_being_asked(tmp_path):
    expected = _text_pdf(tmp_path / "in.pdf", ((100, 100), "hello world"))
    other = _text_pdf(tmp_path / "rt.pdf", ((100, 100), "hello worle"))
    drift = {}
    assert roundtrip.compare(expected, other, drift=drift) != [] and drift == {}
    assert roundtrip.compare(expected, expected) == []  # drift=None: nothing recorded, nothing raised


def test_the_drift_holds_numbers_only_and_the_s7_result_carries_it(monkeypatch, tmp_path):
    from harness.fidelity.test_structural import FakeExport
    pdf = _text_pdf(tmp_path / "in.pdf", ((100, 100), "secret words"))
    pptx = tmp_path / "out.pptx"
    pptx.write_bytes(b"")
    monkeypatch.setattr(roundtrip, "export", FakeExport(pdf=pdf))
    monkeypatch.setattr(roundtrip, "on_windows", lambda: True)
    monkeypatch.setattr(roundtrip, "read_split_fills", lambda path: [[]])
    result = roundtrip.s7(pptx, pdf)
    assert result["status"] == "pass" and list(result["drift"]) == [1]
    assert "secret" not in json.dumps(result["drift"]) and result["drift"][1]["lines"] == [[0.0, 0.0]]


def test_a_glyph_in_no_line_is_counted_unassigned_and_a_line_without_glyphs_is_null():
    boxes = [(0, 0, 100, 20), (0, 50, 100, 70), (0, 90, 100, 110)]
    a = [{"u": "x", "x": 10, "y": 15, "size": 10}, {"u": "y", "x": 400, "y": 400, "size": 10},
         {"u": "z", "x": 10, "y": 65, "size": 10}]
    b = [{**g, "x": g["x"] + 0.1} for g in a]
    page = roundtrip.page_drift(boxes, a[:2] + a[2:], b, None)
    assert page["unassigned"] == 1 and page["lines"][0] == [0.1, 0.1] and page["lines"][2] is None


# ---- the pixels outside the text lines ------------------------------------------------------------------------------


def _page():
    return np.full((100, 200, 3), 255, dtype=np.uint8)


def test_v1_and_v2_measure_the_pixels_outside_the_text_line_regions_too():
    regions = metrics.pixel_regions([(10, 10, 60, 30)], 1, (100, 200), pad=0)  # one line at px (10,10)-(60,30)
    gt = _page()
    in_line = _page()
    in_line[12:28, 12:58] = 0  # a difference wholly inside the line
    record = metrics.v1(gt, in_line, regions)
    assert record["pass"] is False and record["outside"] == {"residual3": 0, "px32_shift1": 0.0, "pass": True}
    off_line = _page()
    off_line[60:90, 100:160] = 0  # the same kind of difference outside every line
    record = metrics.v1(gt, off_line, regions)
    assert record["outside"]["pass"] is False and record["outside"]["residual3"] > metrics.V1_MAX_RESIDUAL
    assert "outside" not in metrics.v1(gt, off_line)  # no text lines: it would only repeat the gate
    v2 = metrics.v2(gt, in_line, None, regions)
    assert v2["pass"] is False and v2["outside"] == {"residual5": 0, "px32_shift1": 0.0, "pass": True}
    assert metrics.v2(gt, off_line, None, regions)["outside"]["pass"] is False
    assert "outside" not in metrics.v2(gt, in_line)


# ---- M8-R12: the judgement -----------------------------------------------------------------------------------------

OK_LINES = {"lines": [[0.25, 0.1], None, [0.0, 0.0]], "unassigned": 0}


def slide(v1=None, v2=True, outside1=True, outside2=True, positions=OK_LINES, s=None, exempt=False):
    gates = {key: {"status": "pass", "detail": ""} for key in S_ALL}
    gates.update(s or {})
    record = {"index": 0, "label": None, "noise": None, "known": [], "heatmaps": {}, "s": gates,
              "v2": {"raw_px32": 0.1, "px32_shift1": 0.1, "residual5": 900, "pass": v2,
                     "outside": {"residual5": 0, "px32_shift1": 0.0, "pass": outside2}},
              "v1": None if v1 is None else {"raw_px32": 0.1, "px32_shift1": 0.1, "residual3": 900, "pass": v1,
                                              "outside": {"residual3": 0, "px32_shift1": 0.0, "pass": outside1}}}
    if exempt:
        record["v1"]["noiseExempt"] = True
    if positions is not None:
        record["positions"] = positions
    return record


def test_a_slide_failing_only_v1_or_v2_on_text_passes_when_the_glyphs_and_the_rest_are_right():
    for v1, v2 in ((None, False), (False, True), (False, False)):
        judged = run.judge(slide(v1=v1, v2=v2))
        assert (judged["pass"], judged["passReason"]) == (True, run.POSITIONS), (v1, v2)
    assert run.verdict(slide(v1=False, v2=False)) == (True, "positions")
    assert run.slide_passes(slide(v2=False)) is True


def test_the_raw_v1_and_v2_values_are_kept_and_a_gate_pass_has_no_reason():
    judged = run.judge(slide(v1=False, v2=False))
    assert judged["v2"]["residual5"] == 900 and judged["v2"]["pass"] is False and judged["v1"]["pass"] is False
    plain = run.judge(slide(v1=True, v2=True))
    assert plain["pass"] is True and "passReason" not in plain
    again = run.judge({**judged, "v1": {**judged["v1"], "pass": True}, "v2": {**judged["v2"], "pass": True}})
    assert again["pass"] is True and "passReason" not in again  # a reason does not outlive the verdict it explained


@pytest.mark.parametrize("what", ["s fails", "too far along", "too far across", "unassigned glyph", "no positions",
                                  "no lines", "outside fails v2", "outside fails v1", "outside missing",
                                  "gate error"])
def test_every_part_of_the_rule_is_needed(what):
    s = slide(v1=False, v2=False)
    if what == "s fails":
        s = slide(v1=False, v2=False, s={"S7": {"status": "fail", "detail": ""}})
    elif what == "too far along":
        s["positions"] = {"lines": [[0.26, 0.0]], "unassigned": 0}
    elif what == "too far across":
        s["positions"] = {"lines": [[0.0, 0.11]], "unassigned": 0}
    elif what == "unassigned glyph":
        s["positions"] = {"lines": [[0.0, 0.0]], "unassigned": 1}
    elif what == "no positions":
        del s["positions"]
    elif what == "no lines":
        s["positions"] = {"lines": [None], "unassigned": 0}
    elif what == "outside fails v2":
        s["v2"]["outside"]["pass"] = False
    elif what == "outside fails v1":
        s["v1"]["outside"]["pass"] = False
    elif what == "outside missing":
        del s["v2"]["outside"]
    elif what == "gate error":
        s["v2"] = {"pass": False, "error": "no render"}
    assert run.verdict(s) == (False, None)


def test_a_noise_exempt_v1_is_read_through_v2s_pixels_outside_the_lines():
    assert run.verdict(slide(v1=False, v2=False, exempt=True, outside1=False)) == (True, "positions")
    assert run.verdict(slide(v1=False, v2=False, exempt=True, outside2=False)) == (False, None)


def test_font_exceptions_leave_out_the_gates_they_leave_out():
    only_v2_fails = slide(v1=True, v2=False)
    assert run.verdict(only_v2_fails, run.FONT_VERSION) == (True, "positions")  # V2 still judges and is rescued
    assert run.verdict(slide(v1=False, v2=True), run.FONT_VERSION) == (True, None)  # V1 left out: a plain pass
    assert run.verdict(slide(v1=False, v2=False), run.MUPDF_SUBSTITUTION) == (True, "positions")  # only V1 judged
    only_v1_fails_and_outside_bad = slide(v1=False, v2=True, outside1=False)
    assert run.verdict(only_v1_fails_and_outside_bad, run.MUPDF_SUBSTITUTION) == (False, None)
    assert run.verdict(slide(v1=False, v2=False, positions=None), run.MISSING_FONT) == (True, None)  # S1-S7 alone


def test_the_summary_counts_position_verified_passes_separately_in_the_bar_and_in_tier_c():
    def record(set_, bar, slides):
        return {"set": set_, "bar": bar, "slides": slides, "origin": "acrobat-pdfmaker"}
    by_positions = run.judge(slide(v2=False))
    plain = run.judge(slide(v2=True))
    failing = run.judge(slide(v2=False, positions=None))
    bar = run.bar_summary([record("real", True, [by_positions, plain, failing])])
    assert (bar["pass"], bar["fail"], bar["positions"]) == (2, 1, 1)
    tier_c = run.tier_c_summary([record("tier-c", False, [by_positions, failing]), record("real", True, [plain])])
    assert tier_c == {"decks": 1, "slides": 2, "pass": 1, "fail": 1, "positions": 1,
                      "origins": {"acrobat-pdfmaker": 1}, "reportedOnly": True}
    assert run.tier_c_summary([record("real", True, [plain])]) is None


def test_a_stored_tier_b_slide_passes_by_positions_only_with_the_evidence_and_keeps_its_raw_values():
    """b-088e7f46c8, page 1, from r2: V1 fails over text lines alone (residual 274 of 25 over 9 lines, V2 and S1-S7
    pass). r2 stored neither the export's glyph drift nor the pixels outside the lines, so as stored it cannot be
    verified; with that evidence (synthetic here) it is a position-verified pass, and its V1 stays as measured."""
    data = json.loads(R2.read_text(encoding="utf-8"))
    deck = next(d for d in data["decks"] if d["id"] == "b-088e7f46c8")
    stored = deck["slides"][0]
    assert stored["pass"] is False and stored["v1"]["pass"] is False and stored["v1"]["lines"] == 9
    assert all(stored["s"][key]["status"] == "pass" for key in S_ALL) and stored["v2"]["pass"] is True
    assert run.verdict(stored, stored.get("fontException")) == (False, None)  # no evidence stored in r2
    evidence = copy.deepcopy(stored)
    evidence["positions"] = {"lines": [[0.04, 0.02]] * 9, "unassigned": 0}
    evidence["v1"]["outside"] = {"residual3": 3, "px32_shift1": 0.0004, "pass": True}
    judged = run.judge(evidence, evidence.get("fontException"))
    assert (judged["pass"], judged["passReason"]) == (True, "positions")
    assert judged["v1"]["residual3Lines"] == stored["v1"]["residual3Lines"] and judged["v1"]["pass"] is False
    evidence["positions"]["lines"][4] = [0.31, 0.02]  # one glyph 0.31 pt along: not verified
    assert run.judge(evidence, evidence.get("fontException"))["pass"] is False
    assert "passReason" not in evidence


def test_the_results_schema_takes_positions_outside_pass_reason_and_the_two_summary_blocks():
    document = {"slide": slide(v1=False, v2=False)}
    judged = run.judge(document["slide"])
    sub = {"$ref": "#/$defs/slide", "$defs": SCHEMA["$defs"]}
    problems = validate({**judged, "known": [], "heatmaps": {}}, sub)
    assert problems == [], problems


# ---- the tier-C deck set ---------------------------------------------------------------------------------------------


def _tier_c_tree(root, producer="Adobe PDF Library 15.0", creator="Acrobat PDFMaker 18 for PowerPoint"):
    pdf = make_pdf(root / "corpus" / "private" / "tier-c" / "My Real Deck.pdf", [RED, BLUE])
    with pymupdf.open(pdf) as doc:
        doc.set_metadata({"producer": producer, "creator": creator})
        doc.saveIncr()
    make_pdf(root / "corpus" / "private" / "probe" / "Other Private.pdf", [RED])
    return pdf


def test_tier_c_decks_are_private_by_hex_id_with_origin_from_producer_and_creator(tmp_path):
    pdf = _tier_c_tree(tmp_path)
    found = decks.discover(tmp_path, ("tier-c",))
    assert [(d.set, d.variant, d.public, d.origin) for d in found] == [("tier-c", "pdf", False, "acrobat-pdfmaker")]
    assert found[0].id == decks.private_id(pdf) and len(found[0].id) == 12
    assert "tier-c" in decks.SETS and "tier-c" not in decks.DEFAULT_SETS
    only_private = decks.discover(tmp_path, ("private",))
    assert [d.set for d in only_private] == ["private"] and only_private[0].id != found[0].id  # not twice
    both = decks.discover(tmp_path, ("private", "tier-c"))
    assert sorted(d.set for d in both) == ["private", "tier-c"]


def test_a_tier_c_deck_from_powerpoint_windows_is_still_never_in_the_bar(tmp_path):
    _tier_c_tree(tmp_path, producer="Microsoft® PowerPoint® 2019", creator="Microsoft® PowerPoint® 2019")
    [deck] = decks.discover(tmp_path, ("tier-c",))
    assert deck.origin == "powerpoint-windows"
    results = run.run_decks(decks.DeckList([deck]), tools(), tmp_path / "fid", converter="proto", s7_enabled=True,
                            options={"decks": ["tier-c"], "variants": ["pdf"], "s7": True, "limitSlides": None})
    [record] = results["decks"]
    assert (record["origin"], record["bar"]) == ("powerpoint-windows", False)
    assert "bar" not in results["summary"] and results["summary"]["tierC"]["decks"] == 1


def test_a_tier_c_run_is_measured_fully_named_by_id_only_and_reported_as_its_own_block(tmp_path):
    root = tmp_path / "repo"
    pdf = _tier_c_tree(root)
    out_json = tmp_path / "results.json"
    assert run.main(["--converter", "proto", "--decks", "tier-c", "--out", str(out_json)], root=root,
                    out_root=tmp_path / "fid", tools=tools()) == 0
    text = out_json.read_text(encoding="utf-8")
    results = json.loads(text)
    assert validate(results, SCHEMA) == []
    [record] = results["decks"]
    assert record["id"] == decks.private_id(pdf) and record["set"] == "tier-c" and record["public"] is False
    assert (record["origin"], record["bar"], record["variant"]) == ("acrobat-pdfmaker", False, "pdf")
    assert record["exitCodes"]["render"] == 0 and all(s["v2"]["pass"] in (True, False) and "error" not in s["v2"]
                                                      for s in record["slides"])  # measured, not off-bar
    assert all(s["v1"] is None for s in record["slides"])  # no source PPTX, so no V1
    assert all(s["pass"] is not None and all(g["status"] != "n/a" for g in s["s"].values()) for s in record["slides"])
    summary = results["summary"]
    assert summary["tierC"] == {"decks": 1, "slides": 2, "pass": summary["pass"], "fail": summary["fail"],
                                "positions": 0, "origins": {"acrobat-pdfmaker": 1}, "reportedOnly": True}
    assert "bar" not in summary and summary["notMeasured"] == 0
    for needle in ("My Real Deck", "My-Real-Deck", "Other Private", str(tmp_path), "PDFMaker 18"):
        assert needle not in text
    assert all(path.startswith(record["id"] + "/") for slide in record["slides"] for path in slide["heatmaps"].values())


def test_the_privacy_scan_lets_tier_c_through_by_its_own_hex_id_only(tmp_path):
    from harness.fidelity.test_run import committed_json_problems, private_names
    private = tmp_path / "corpus" / "private"
    pdf = make_pdf(private / "tier-c" / "x.pdf", [RED])
    real_id = decks.private_id(pdf)
    named = pdf.with_name(real_id + ".pdf")
    pdf.rename(named)
    assert private_names(private) == set()  # the id is what results carry; "tier-c" is the set's own name
    other = make_pdf(private / "tier-c" / "Client Plan.pdf", [BLUE])
    assert private_names(private) == {"Client Plan", "Client Plan.pdf"}
    other.unlink()
    lying = make_pdf(private / "tier-c" / "0123456789ab.pdf", [BLUE])  # hex-looking but not its own hash
    assert private_names(private) == {"0123456789ab", "0123456789ab.pdf"}
    lying.unlink()

    def record(deck_id, set_="tier-c", **extra):
        return {"id": deck_id, "public": False, "set": set_, "variant": "pdf", "bar": False, **extra}
    base = {"schema": run.SCHEMA_ID, "options": {"decks": ["tier-c"]}, "decks": [], "summary": {}}

    def check(deck_id, set_="tier-c"):
        text = json.dumps({**base, "decks": [record(deck_id, set_)]})
        return [p for p in committed_json_problems(text, "results", private, (), "someone") if not p.startswith("schema")]
    assert check(real_id) == []
    assert "a private deck without a 12-hex id" in check("my-real-deck")
    assert "a private deck outside the private and tier-c sets" in check(real_id, "real")
