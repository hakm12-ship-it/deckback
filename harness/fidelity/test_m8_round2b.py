"""M8 round 2b: the font-version exception (M8-R9) in run.py and triage.py, and the triage tag read from the measure
that fails (cause O of round2-analysis.md)."""

import numpy as np

from harness.fidelity import metrics, run, triage
from harness.fidelity.test_triage import INFO, deck, results, slide, tags
from harness.fonts import fontversion


# ---- M8-R9 in the judgement ----------------------------------------------------------------------------------------


def test_a_font_version_slide_is_judged_without_v1_but_with_v2_and_s1_to_s7():
    assert "font-version" in run.FONT_EXCEPTIONS
    assert run.slide_passes(slide(v1=False, v2=True), run.FONT_VERSION) is True  # V1 left out
    assert run.slide_passes(slide(v1=True, v2=False), run.FONT_VERSION) is False  # V2 still judges
    assert run.slide_passes(slide(v1=False, v2=True, S3="x"), run.FONT_VERSION) is False  # S gates still judge
    assert run.slide_passes(slide(v1=False, v2=True)) is False  # without the exception V1 fails the slide


def test_the_bar_summary_counts_font_version_slides():
    on = {"pass": True, "fontException": run.FONT_VERSION}
    records = [deck("b-aaaaaaaaaa", [{"pass": False}, on, {"pass": False, "fontException": run.FONT_VERSION},
                                     {"pass": True, "fontException": run.MUPDF_SUBSTITUTION}])]
    assert run.bar_summary(records)["fontException"] == {
        "total": 3, "mupdf-substitution": 1, "missing-font": 0, "font-version": 2, "pass": 2}


def test_triage_applies_the_font_version_rule_after_the_other_two_and_can_leave_it_out():
    assert triage.font_exception_of({"Arial"}, [], version_differs=["Nunito-Bold"]) == run.FONT_VERSION
    assert triage.font_exception_of({"Arial"}, ["ArialMT"], version_differs=["Nunito-Bold"]) == run.MUPDF_SUBSTITUTION
    assert triage.font_exception_of({"ms pgothic"}, [], version_differs=["x"]) == run.MISSING_FONT
    assert triage.font_exception_of({"Arial"}, [], version_differs=["x"], version=False) is None
    base = results(deck("b-aaaaaaaaaa", [slide(0, v1=False, v2=True), slide(1, v1=False, v2=False), slide(2)]))
    pages = [({"Nunito"}, [], ["Nunito-Bold"]), ({"Nunito"}, [], ["Nunito-Bold"]), ({"Arial"}, [])]  # 2- and 3-tuples
    out = triage.apply_font_rule(base, lambda _id: pages)
    slides = out["decks"][0]["slides"]
    assert [s.get("fontException") for s in slides] == [run.FONT_VERSION, run.FONT_VERSION, None]
    assert [s["pass"] for s in slides] == [True, False, True]  # V1 left out; V2 still fails slide 1
    assert out["summary"]["bar"]["fontException"]["font-version"] == 2
    assert triage.apply_font_rule(base, lambda _id: pages, version=False)["decks"][0]["slides"][0]["pass"] is False


def test_failing_gates_leave_v1_out_under_the_font_version_exception():
    s = slide(v1=False, v2=False, S3="x")
    assert triage.failing_gates({**s, "fontException": run.FONT_VERSION}) == ["V2", "S3"]
    # a slide whose V1 fails is not "renderer noise (V1 passes)" when V1 is left out
    fv = {**slide(v1=False, v2=False), "fontException": run.FONT_VERSION}
    assert "renderer noise (V1 passes)" not in tags(fv, residual={"v2Px": 800, "v2Share": {"text": 1.0}})


def test_run_font_exception_reads_the_versions_of_the_pcs_fonts(monkeypatch, tmp_path):
    from harness.fidelity import pdf_facts

    deck_ = type("D", (), {"set": "real", "pdf": tmp_path / "x.pdf"})()
    monkeypatch.setattr(pdf_facts, "page_fonts_not_embedded", lambda pdf, index: [])
    embedded = [{"ps": "Nunito-Bold", "family": "Nunito", "subfamily": "Bold", "version": "Version 3.000",
                 "revision": 3.0, "advances": {"65": 600}}]  # advances: amended M8-R9 needs them to flag
    monkeypatch.setattr(pdf_facts, "page_embedded_versions", lambda pdf, index, pc=None: embedded)
    pc = fontversion.PcFonts([{"ps": "Nunito-Bold", "family": "Nunito", "subfamily": "Bold",
                               "version": "Version 3.601", "revision": 3.601, "advances": {"65": 640}}])
    monkeypatch.setattr(fontversion, "pc_index", lambda: pc)
    assert run.font_exception(deck_, 0) == run.FONT_VERSION
    same = fontversion.PcFonts([{**embedded[0]}])
    monkeypatch.setattr(fontversion, "pc_index", lambda: same)
    assert run.font_exception(deck_, 0) is None
    monkeypatch.setattr(pdf_facts, "page_fonts_not_embedded", lambda pdf, index: ["ArialMT"])
    assert run.font_exception(deck_, 0) == run.MUPDF_SUBSTITUTION  # M8-R3 first


# ---- cause O: the tag comes from the measure that fails ---------------------------------------------------------------


def blank(rows=60, cols=120):
    return np.full((rows, cols, 3), 255, np.uint8)


def test_v1_failing_mask_is_the_residual_v1_judges_and_lies_where_it_lies():
    gt, out = blank(), blank()
    gt[14:18, 12:50] = 0  # a line of "text" ...
    out[14:18, 13:51] = 0  # ... one pixel to the right in our render: the line's own shift explains it
    gt[40:56, 70:110] = 0  # a picture-like block that our render lacks
    lines = [(10, 10, 60, 22)]
    mask = triage.v1_failing_mask(gt, out, lines)
    total, _ = metrics.line_residual(gt, out, lines)
    assert int(mask.sum()) == total > 0  # the same pixels V1 counts
    assert not mask[10:22, 10:60].any()  # nothing left in the line
    assert mask[40:56, 70:110].sum() == total  # all of it in the block, outside any text line
    no_lines = triage.v1_failing_mask(gt, out, [])
    assert int(no_lines.sum()) == metrics.eroded_residual(metrics.diff_mask(gt, out), 3)


def test_a_slide_whose_failing_v1_residual_lies_outside_the_text_is_not_text_drift():
    s = slide(v1=False, v2=True)
    # the failing measure's share (what residuals() now returns for V1) is mostly image: not text drift
    assert tags(s, residual={"v1Px": 207, "v1Share": {"image": 0.8, "text": 0.2}}) == ["picture pixels"]
    assert tags(s, residual={"v1Px": 207, "v1Share": {"text": 0.8, "image": 0.2}}) == ["text drift (line direction)"]


def test_a_v1_judged_by_v2_is_tagged_from_v2s_measure_not_v1s():
    exempt = slide(v1=False, v2=False)
    exempt["v1"].update({"noiseExempt": True, "passMeasured": False})
    residual = {"v1Px": 900, "v1Share": {"text": 1.0}, "v2Px": 900, "v2Share": {"image": 0.9, "text": 0.1}}
    assert tags(exempt, residual=residual) == ["picture pixels"]
    plain = slide(v1=False, v2=False)
    assert tags(plain, residual=residual) == ["text drift (line direction)"]  # V1 fails on its own measure


def test_failing_measure_falls_back_to_v2_without_v1_pixels():
    s = slide(v1=False, v2=False)
    share, pixels = triage.failing_measure(s, ["V1", "V2"], {"v2Px": 5, "v2Share": {"drawing": 1.0}})
    assert (share, pixels) == ({"drawing": 1.0}, 5)
    assert triage.failing_measure(s, ["V1"], None) == ({}, 0)
