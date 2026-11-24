"""The harness deck set `real` (M8 Task 1): the tier-B PDFs of corpus/manifest.jsonl that are in corpus/public-real/."""

import json
from pathlib import Path

from harness.corpus import manifest
from harness.fidelity import decks, run
from harness.fidelity.schema_check import validate
from harness.fidelity.render_pdf import render as mupdf_render
from harness.fidelity.test_run import BLUE, RED, SCHEMA, FakeRenderer, make_pdf, make_pptx, tools


def tier_b(root, entries):
    """Entries as {id: (origin, with a pptx pair)}; writes the manifest and the downloads like fetch_public does."""
    rows = []
    for deck_id, (origin, pair) in entries.items():
        pdf = make_pdf(Path(root) / manifest.PUBLIC_REAL / f"{deck_id}.pdf", [RED, BLUE])
        if pair:
            make_pptx(Path(root) / manifest.PUBLIC_REAL / f"{deck_id}.pptx", 2, pdf=pdf)
        rows.append({"id": deck_id, "url": f"https://example.org/{deck_id}.pdf", "origin": origin,
                     "pairPptxUrl": "https://example.org/p.pptx" if pair else None})
    manifest.save(Path(root) / manifest.MANIFEST, rows)


def test_real_decks_are_found_by_manifest_id_with_origin_and_pair(tmp_path):
    tier_b(tmp_path, {"b-aaaaaaaaaa": ("powerpoint-windows", True), "b-bbbbbbbbbb": ("keynote", False)})
    manifest.save(tmp_path / manifest.MANIFEST, manifest.load(tmp_path / manifest.MANIFEST)
                  + [{"id": "b-cccccccccc", "url": "https://example.org/missing.pdf", "origin": "other"}])  # not downloaded
    found = decks.discover(tmp_path, ("real",))
    assert [(d.id, d.set, d.variant, d.origin) for d in found] == [
        ("b-aaaaaaaaaa", "real", "pdf", "powerpoint-windows"), ("b-bbbbbbbbbb", "real", "pdf", "keynote")]
    assert found[0].source_pptx.name == "b-aaaaaaaaaa.pptx" and found[1].source_pptx is None
    assert "real" in decks.SETS and "real" not in decks.DEFAULT_SETS


def test_no_manifest_means_no_real_decks(tmp_path):
    assert list(decks.discover(tmp_path, ("real",))) == []


def test_a_real_run_names_decks_by_id_and_only_powerpoint_windows_counts_for_the_bar(tmp_path):
    root = tmp_path / "repo"
    tier_b(root, {"b-aaaaaaaaaa": ("powerpoint-windows", True), "b-bbbbbbbbbb": ("google-slides", False)})
    out_json = tmp_path / "results.json"
    code = run.main(["--converter", "proto", "--decks", "real", "--out", str(out_json)], root=root,
                    out_root=tmp_path / "fid", tools=tools())
    assert code == 0
    results = json.loads(out_json.read_text(encoding="utf-8"))
    by_id = {d["id"]: d for d in results["decks"]}
    assert set(by_id) == {"b-aaaaaaaaaa", "b-bbbbbbbbbb"}
    assert all(d["set"] == "real" and d["variant"] == "pdf" for d in by_id.values())
    assert (by_id["b-aaaaaaaaaa"]["origin"], by_id["b-aaaaaaaaaa"]["bar"]) == ("powerpoint-windows", True)
    assert (by_id["b-bbbbbbbbbb"]["origin"], by_id["b-bbbbbbbbbb"]["bar"]) == ("google-slides", False)
    assert by_id["b-aaaaaaaaaa"]["exitCodes"]["groundTruth"] == 0  # the pair PPTX gave V1
    assert by_id["b-bbbbbbbbbb"]["exitCodes"]["groundTruth"] is None
    assert all(s["v1"] is not None for s in by_id["b-aaaaaaaaaa"]["slides"])
    assert all(s["v1"] is None for s in by_id["b-bbbbbbbbbb"]["slides"])
    assert validate(results, SCHEMA) == []


def test_off_bar_structural_leaves_real_decks_off_the_bar_at_s1_to_s6_with_no_renders(tmp_path):
    """Ruling M8-R1: the bar deck is measured in full; the deck off the bar (with a pair) is converted and checked with
    S1-S6 only: no PowerPoint render, no ground truth, no MuPDF render, no S7."""
    root = tmp_path / "repo"
    tier_b(root, {"b-aaaaaaaaaa": ("powerpoint-windows", True), "b-bbbbbbbbbb": ("acrobat-pdfmaker", True)})
    renderer, rendered_pages, s7_calls = FakeRenderer(), [], []

    def render_pdf(pdf, index, **kwargs):
        rendered_pages.append(Path(pdf).stem)
        return mupdf_render(pdf, index, **kwargs)

    def s7(out_pptx, in_pdf):
        s7_calls.append(Path(in_pdf).stem)
        return {"status": "pass", "detail": "fake round trip"}

    out_json = tmp_path / "results.json"
    code = run.main(["--converter", "proto", "--decks", "real", "--off-bar-structural", "--out", str(out_json)],
                    root=root, out_root=tmp_path / "fid", tools=tools(renderer=renderer, s7=s7, render_pdf=render_pdf))
    assert code == 0
    results = json.loads(out_json.read_text(encoding="utf-8"))
    assert validate(results, SCHEMA) == [] and results["options"]["offBarStructural"] is True
    by_id = {d["id"]: d for d in results["decks"]}
    full, off = by_id["b-aaaaaaaaaa"], by_id["b-bbbbbbbbbb"]
    assert full["exitCodes"]["render"] == 0 and full["exitCodes"]["groundTruth"] == 0 and full["s7"]["status"] == "pass"
    assert all(s["v1"] is not None and "error" not in s["v2"] for s in full["slides"])
    assert off["exitCodes"]["convert"] == 0
    assert (off["exitCodes"]["render"], off["reasons"]["render"]) == (None, run.OFF_BAR)
    assert (off["exitCodes"]["groundTruth"], off["reasons"]["groundTruth"]) == (None, run.OFF_BAR)
    assert off["s7"]["status"] == "n/a" and len(off["slides"]) == 2
    for slide in off["slides"]:
        assert slide["v1"] is None and slide["noise"] is None and slide["v2"] == run.OFF_BAR_V2
        assert slide["pass"] is None and slide["heatmaps"] == {} and slide["s"]["S7"]["status"] == "n/a"
        assert slide["s"]["S5"]["status"] == "pass" and slide["s"]["S1"]["status"] == "pass"  # S1-S6 still run
    assert [p.stem for p in renderer.calls] == ["out", "b-aaaaaaaaaa"]  # the bar deck's output and its source only
    assert set(rendered_pages) == {"b-aaaaaaaaaa"} and s7_calls == ["b-aaaaaaaaaa"]
    assert results["summary"]["byGate"]["V2"] == {"pass": 2, "fail": 0, "na": 2}
    assert results["summary"]["byGate"]["V1"]["na"] == 2


def test_bar_only_leaves_the_real_decks_off_the_bar_out_and_the_other_sets_alone(tmp_path):
    root = tmp_path / "repo"
    tier_b(root, {"b-aaaaaaaaaa": ("powerpoint-windows", False), "b-bbbbbbbbbb": ("acrobat-pdfmaker", False)})
    out_json = tmp_path / "results.json"
    code = run.main(["--converter", "proto", "--decks", "real", "--bar-only", "--out", str(out_json)],
                    root=root, out_root=tmp_path / "fid", tools=tools())
    assert code == 0
    results = json.loads(out_json.read_text(encoding="utf-8"))
    assert validate(results, SCHEMA) == [] and results["options"]["barOnly"] is True
    assert [d["id"] for d in results["decks"]] == ["b-aaaaaaaaaa"]
    assert results["summary"]["bar"]["decks"] == 1 and results["summary"]["notMeasured"] == 0


def test_ids_measure_only_the_decks_asked_for(tmp_path):
    root = tmp_path / "repo"
    tier_b(root, {"b-aaaaaaaaaa": ("powerpoint-windows", False), "b-bbbbbbbbbb": ("powerpoint-windows", False)})
    out_json = tmp_path / "results.json"
    code = run.main(["--converter", "proto", "--decks", "real", "--ids", "b-bbbbbbbbbb", "--out", str(out_json)],
                    root=root, out_root=tmp_path / "fid", tools=tools())
    assert code == 0
    results = json.loads(out_json.read_text(encoding="utf-8"))
    assert [d["id"] for d in results["decks"]] == ["b-bbbbbbbbbb"] and results["options"]["ids"] == 1
    assert validate(results, SCHEMA) == []
    assert run.main(["--converter", "proto", "--decks", "real", "--ids", "b-bbbbbbbbbb,b-cccccccccc", "--out",
                     str(out_json)], root=root, out_root=tmp_path / "fid", tools=tools()) == 3


def test_off_bar_slides_are_not_measured_and_the_summary_counts_the_bar_alone(tmp_path):
    """Task 2 review I1: an off-bar slide is neither a pass nor a failure; summary.bar is the stop rule's count."""
    root = tmp_path / "repo"
    tier_b(root, {"b-aaaaaaaaaa": ("powerpoint-windows", True), "b-bbbbbbbbbb": ("keynote", False)})
    out_json = tmp_path / "results.json"
    code = run.main(["--converter", "proto", "--decks", "real", "--off-bar-structural", "--out", str(out_json)],
                    root=root, out_root=tmp_path / "fid", tools=tools())
    assert code == 0
    summary = json.loads(out_json.read_text(encoding="utf-8"))["summary"]
    assert validate(json.loads(out_json.read_text(encoding="utf-8")), SCHEMA) == []
    assert summary["slides"] == 4 and summary["notMeasured"] == 2
    assert summary["pass"] + summary["fail"] + summary["notMeasured"] == summary["slides"]
    bar = summary["bar"]
    assert (bar["decks"], bar["slides"]) == (1, 2) and bar["pass"] + bar["fail"] == 2
    assert bar["fontException"] == {"total": 0, "mupdf-substitution": 0, "missing-font": 0, "font-version": 0, "pass": 0}


def _slide(v1=None, v2=True, s=None):
    gates = {key: {"status": "pass", "detail": ""} for key in run.S_KEYS + ("S7",)}
    gates.update(s or {})
    return {"v1": None if v1 is None else {"pass": v1}, "v2": {"pass": v2}, "s": gates}


def test_a_font_exception_leaves_out_what_the_font_spoils():
    failing_s = {"S7": {"status": "fail", "detail": ""}}
    assert run.slide_passes(_slide(v2=False)) is False
    assert run.slide_passes(_slide(v2=False), run.MUPDF_SUBSTITUTION) is True  # M8-R3: V2 left out
    assert run.slide_passes(_slide(v1=False, v2=False), run.MUPDF_SUBSTITUTION) is False  # V1 still judges
    assert run.slide_passes(_slide(v1=True, v2=False), run.MUPDF_SUBSTITUTION) is True
    assert run.slide_passes(_slide(v2=False, s=failing_s), run.MUPDF_SUBSTITUTION) is False  # S1-S7 still judge
    assert run.slide_passes(_slide(v1=False, v2=False), run.MISSING_FONT) is True  # 5.5: S1-S7 only
    assert run.slide_passes(_slide(s=failing_s), run.MISSING_FONT) is False


def test_bar_summary_counts_the_bar_decks_with_their_font_exceptions():
    def deck(set_, bar, slides):
        return {"set": set_, "bar": bar, "slides": slides}
    on = {"pass": True, "fontException": run.MUPDF_SUBSTITUTION}
    records = [deck("real", True, [{"pass": True}, {"pass": False}, on, {"pass": False, "fontException": run.MISSING_FONT}]),
               deck("real", False, [{"pass": None}]), deck("atlas", None, [{"pass": False}])]
    assert run.bar_summary(records) == {"decks": 1, "slides": 4, "pass": 2, "fail": 2, "positions": 0, "fontException": {
        "total": 2, "mupdf-substitution": 1, "missing-font": 1, "font-version": 0, "pass": 1}}
    assert run.bar_summary(records[1:]) is None


def test_mupdf_substitution_is_read_from_the_page_font_dictionaries(tmp_path):
    import pymupdf
    from harness.fidelity import pdf_facts
    from harness.oracle.make_vertical import make_font

    pdf = tmp_path / "fonts.pdf"
    with pymupdf.open() as doc:
        doc.new_page().insert_text((50, 50), "no embedded font", fontname="helv")  # base-14, no font program
        embedded = doc.new_page()
        embedded.insert_font(fontname="FR", fontbuffer=make_font("Deck Sans", "Regular", "DeckSans-Regular"))
        embedded.insert_text((50, 50), "ab", fontname="FR")
        doc.new_page()
        doc.save(pdf)
    assert pdf_facts.page_fonts_not_embedded(pdf, 0) == ["Helvetica"]
    assert pdf_facts.page_fonts_not_embedded(pdf, 1) == []
    assert pdf_facts.page_fonts_not_embedded(pdf, 2) == []
    deck = type("D", (), {"set": "real", "pdf": pdf})
    assert [run.font_exception(deck, i) for i in range(3)] == [run.MUPDF_SUBSTITUTION, None, None]
    assert run.font_exception(type("D", (), {"set": "atlas", "pdf": pdf}), 0) is None  # other sets are as before


def test_a_real_run_records_the_cloud_font_names_in_its_options(tmp_path, monkeypatch):
    """Ruling M8-R2: the names (and no file) of the Office cloud fonts at the start of the round, in options."""
    cloud = tmp_path / "cloud"
    (cloud / "Montserrat").mkdir(parents=True)
    (cloud / "Montserrat" / "123.ttf").write_bytes(b"x")
    monkeypatch.setenv("DECKBACK_CLOUDFONTS", str(cloud))
    root = tmp_path / "repo"
    tier_b(root, {"b-aaaaaaaaaa": ("powerpoint-windows", False)})
    out_json = tmp_path / "results.json"
    assert run.main(["--converter", "proto", "--decks", "real", "--out", str(out_json)], root=root,
                    out_root=tmp_path / "fid", tools=tools()) == 0
    results = json.loads(out_json.read_text(encoding="utf-8"))
    assert results["options"]["cloudFonts"] == {"count": 1, "names": ["Montserrat"]}
    assert validate(results, SCHEMA) == []
    monkeypatch.setenv("DECKBACK_CLOUDFONTS", str(tmp_path / "no-cloud"))  # no Office: the key is left out
    assert run.main(["--converter", "proto", "--decks", "real", "--out", str(out_json)], root=root,
                    out_root=tmp_path / "fid", tools=tools()) == 0
    assert "cloudFonts" not in json.loads(out_json.read_text(encoding="utf-8"))["options"]
