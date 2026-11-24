"""offbar_net.py (M8-R8): the off-bar structural regression net, on hand-made summaries and one small real run."""

import sys

from harness.fidelity import offbar_net as net
from harness.fidelity import run
from harness.fidelity.test_real_set import tier_b


def summary(convert="ok", failed=None, slides=3, validator=0):
    return {"convert": convert, "pages": slides, "slides": slides, "failed": failed or {}, "validatorErrors": validator}


def test_a_deck_is_worse_when_it_fails_a_gate_it_passed_or_stops_converting():
    base = {"b-a": summary(), "b-b": summary(failed={"S3": [1]}), "b-c": summary(), "b-d": summary(),
            "b-e": summary(), "b-f": summary(convert="error")}
    new = {"b-a": summary(failed={"S2": [0, 2]}), "b-b": summary(failed={"S3": [1]}), "b-c": summary(convert="error"),
           "b-d": summary(slides=2), "b-e": summary(failed={}), "b-f": summary()}
    result = net.compare(base, new)
    assert [d["id"] for d in result["worse"]] == ["b-a", "b-c", "b-d"]
    assert result["worse"][0]["gates"] == {"S2": [0, 2]} and "S2 x2" in result["worse"][0]["reasons"][0]
    assert "conversion no longer succeeds" in result["worse"][1]["reasons"][0]
    assert "fewer slides" in result["worse"][2]["reasons"][0]
    assert [d["id"] for d in result["better"]] == ["b-f"] and result["same"] == 2  # b-b and b-e: no change


def test_better_mixed_missing_and_added_are_told_apart():
    base = {"b-a": summary(failed={"S1": [0], "S3": [1]}), "b-b": summary(failed={"S3": [1]}), "b-gone": summary()}
    new = {"b-a": summary(failed={"S3": [1]}), "b-b": summary(failed={"S2": [0]}), "b-new": summary()}
    result = net.compare(base, new)
    assert [d["id"] for d in result["better"]] == ["b-a"]  # S1 and a fail gone, nothing new
    assert [d["id"] for d in result["mixed"]] == ["b-b"]  # S3 fixed, S2 new
    assert result["missing"] == ["b-gone"] and result["added"] == ["b-new"]
    assert net.compare(base, base)["worse"] == []


def test_validator_errors_count_only_where_both_sides_have_a_figure_or_the_new_one_is_not_zero():
    base = {"b-a": summary(validator=None), "b-b": summary(validator=1), "b-c": summary(validator=None)}
    new = {"b-a": summary(validator=2), "b-b": summary(validator=3), "b-c": summary(validator=0)}
    result = net.compare(base, new)
    assert {d["id"]: d["reasons"] for d in result["worse"]} == {
        "b-a": ["validator errors 2 (the baseline has no validator figure)"], "b-b": ["validator errors 1 -> 3"]}
    assert result["same"] == 1


def test_a_results_file_is_a_baseline_and_only_its_off_bar_decks_count():
    def record(deck_id, origin, statuses):
        return {"id": deck_id, "set": "real", "origin": origin, "pages": len(statuses), "reasons": {"convert": "ok"},
                "slides": [{"index": i, "s": {g: {"status": statuses[i].get(g, "pass")} for g in run.S_KEYS}}
                           for i in range(len(statuses))]}
    document = {"decks": [record("b-a", "other", [{}, {"S3": "fail"}]), record("b-bar", "powerpoint-windows", [{}]),
                          {**record("p-1", "other", [{}]), "set": "public"}]}
    assert net.baseline_decks(document) == {"b-a": {"convert": "ok", "pages": 2, "slides": 2, "failed": {"S3": [1]},
                                                    "validatorErrors": None}}
    report = {"schema": net.SCHEMA, "decks": {"b-z": summary()}}
    assert net.baseline_decks(report) == {"b-z": summary()}


def test_the_report_names_decks_by_id_and_pages_one_based():
    result = net.compare({"b-a": summary()}, {"b-a": summary(failed={"S2": [0, 4]})})
    text = net.format_comparison(result)
    assert "1 worse" in text and "WORSE b-a" in text and "[S2: pages 1, 5]" in text


def test_a_small_real_run_converts_checks_and_compares(tmp_path):
    root = tmp_path / "repo"
    tier_b(root, {"b-aaaaaaaaaa": ("powerpoint-windows", False), "b-bbbbbbbbbb": ("keynote", False),
                  "b-cccccccccc": ("google-slides", False)})
    script = tmp_path / "convert.py"
    script.write_text(
        "import sys, pymupdf\nfrom pptx import Presentation\nfrom pptx.util import Emu\n"
        "pdf, out = sys.argv[1], sys.argv[3]\n"
        "doc = pymupdf.open(pdf)\nprs = Presentation()\nprs.slide_width = Emu(int(doc[0].rect.width * 12700))\n"
        "prs.slide_height = Emu(int(doc[0].rect.height * 12700))\n"
        "for _ in range(len(doc)): prs.slides.add_slide(prs.slide_layouts[6])\nprs.save(out)\n", encoding="utf-8")
    report = net.measure(root, None, tmp_path / "work", validator=False, argv=[sys.executable, str(script)])
    assert report["schema"] == net.SCHEMA
    assert sorted(report["decks"]) == ["b-bbbbbbbbbb", "b-cccccccccc"]  # the bar deck is not part of the net
    deck = report["decks"]["b-bbbbbbbbbb"]
    assert deck["convert"] == "ok" and deck["slides"] == 2 and deck["validatorErrors"] is None
    assert not (tmp_path / "work" / "b-aaaaaaaaaa").exists()  # and nothing of it was converted
    out = tmp_path / "report.json"
    assert net.main(["compare", str(tmp_path / "x.json"), str(tmp_path / "x.json")]) == 3  # unreadable: usage error
    report = {**report, "decks": {k: {**v, "validatorErrors": 0} for k, v in report["decks"].items()}}
    deck = report["decks"]["b-bbbbbbbbbb"]
    net.save(report, out)
    assert net.main(["compare", str(out), str(out)]) == 0
    worse = {**report, "decks": {**report["decks"], "b-bbbbbbbbbb": {**deck, "convert": "error"}}}
    net.save(worse, tmp_path / "worse.json")
    assert net.main(["compare", str(out), str(tmp_path / "worse.json")]) == 1  # a deck that stopped converting


def test_shards_split_the_decks_and_combine_joins_the_reports(tmp_path):
    found = net.deck_list.DeckList([type("D", (), {"id": f"b-{n}"})() for n in "abcdefg"])
    assert [d.id for d in net.shard_of(found, (1, 3))] == ["b-b", "b-e"]
    assert [d.id for d in net.shard_of(found, None)] == [f"b-{n}" for n in "abcdefg"]
    assert net.parse_shard("2/8") == (2, 8)
    for bad in ("8/8", "x", "1/0", "-1/4", "1"):
        try:
            net.parse_shard(bad)
        except ValueError:
            continue
        raise AssertionError(bad)
    first = {"schema": net.SCHEMA, "date": "2026-11-22", "converter": "c", "decks": {"b-a": summary()}}
    second = {**first, "decks": {"b-b": summary(failed={"S2": [0]})}}
    net.save(first, tmp_path / "1.json")
    net.save(second, tmp_path / "2.json")
    out = tmp_path / "all.json"
    assert net.main(["combine", str(tmp_path / "1.json"), str(tmp_path / "2.json"), "--out", str(out)]) == 0
    assert sorted(net.load(out)["decks"]) == ["b-a", "b-b"]
    assert net.main(["combine", str(tmp_path / "1.json"), str(tmp_path / "1.json"), "--out", str(out)]) == 3  # a deck twice


def test_a_deck_whose_page_facts_could_not_be_read_is_measured_again(monkeypatch, tmp_path):
    def record(deck_id, detail):
        status = "fail" if detail else "pass"
        return {"id": deck_id, "variant": "pdf", "pages": 1, "reasons": {"convert": "ok"},
                "slides": [{"index": 0, "s": {g: {"status": status, "detail": detail or "ok"} for g in run.S_KEYS}}]}

    assert net.facts_failed(record("b-a", "facts: output PPTX: unreadable PPTX (XMLSyntaxError)"))
    assert not net.facts_failed(record("b-a", None))
    calls = []

    def fake_run_decks(found, tools, work, **kwargs):
        calls.append([d.id for d in found])
        broken = len(calls) == 1  # the first read of b-bbbbbbbbbb fails, the second works
        return {"date": "2026-11-22", "decks": [record(d.id, "facts: input PDF: internal error (MemoryError)"
                                                       if broken and d.id == "b-bbbbbbbbbb" else None)
                                                for d in found]}

    ids = ["b-aaaaaaaaaa", "b-bbbbbbbbbb"]
    monkeypatch.setattr(net.run, "run_decks", fake_run_decks)
    monkeypatch.setattr(net, "off_bar_decks", lambda root, wanted=None: net.deck_list.DeckList(
        [type("D", (), {"id": i})() for i in ids]))
    monkeypatch.setattr(net.run, "default_tools", lambda name: type("T", (), {"render_pdf": None})())
    monkeypatch.setattr(net.run, "Tools", lambda **kwargs: kwargs)
    monkeypatch.setattr(net.run, "SubprocessConverter", lambda *a, **k: None)
    report = net.measure(tmp_path, tmp_path / "cli.mjs", tmp_path / "work", validator=False)
    assert calls == [ids, ["b-bbbbbbbbbb"]]  # only the deck that failed to read is measured again
    assert report["decks"]["b-bbbbbbbbbb"]["retries"] == [
        {"attempt": 1, "kind": "facts", "first": "facts: input PDF: internal error (MemoryError)"}]
    assert "retries" not in report["decks"]["b-aaaaaaaaaa"]
    assert report["flaky"] == ["b-bbbbbbbbbb"]
    assert report["decks"]["b-bbbbbbbbbb"]["failed"] == {}  # the second read counts


def _stub_measure(monkeypatch, ids, crashes):
    """measure() with fake run_decks records: `crashes` maps a deck id to the number of convert crashes (exit 3) it has
    before it works; a negative number is a deck that always crashes."""
    calls = []

    def record(deck_id, crash):
        rec = {"id": deck_id, "variant": "pdf", "pages": 1, "reasons": {"convert": "error" if crash else "ok"},
               "exitCodes": {"convert": 3 if crash else 0},
               "slides": [] if crash else [{"index": 0, "s": {g: {"status": "pass", "detail": "ok"} for g in run.S_KEYS}}]}
        return rec

    def fake_run_decks(found, tools, work, **kwargs):
        calls.append([d.id for d in found])
        out = []
        for d in found:
            seen = sum(1 for c in calls if d.id in c)
            left = crashes.get(d.id, 0)
            out.append(record(d.id, left < 0 or seen <= left))
        return {"date": "2026-11-23", "decks": out}

    monkeypatch.setattr(net.run, "run_decks", fake_run_decks)
    monkeypatch.setattr(net, "off_bar_decks", lambda root, wanted=None: net.deck_list.DeckList(
        [type("D", (), {"id": i})() for i in ids]))
    monkeypatch.setattr(net.run, "default_tools", lambda name: type("T", (), {"render_pdf": None})())
    monkeypatch.setattr(net.run, "Tools", lambda **kwargs: kwargs)
    monkeypatch.setattr(net.run, "SubprocessConverter", lambda *a, **k: None)
    return calls


def test_a_convert_crash_is_retried_once_and_recorded(monkeypatch, tmp_path):
    calls = _stub_measure(monkeypatch, ["b-aaaaaaaaaa", "b-bbbbbbbbbb", "b-cccccccccc"],
                          {"b-bbbbbbbbbb": 1, "b-cccccccccc": -1})
    report = net.measure(tmp_path, tmp_path / "cli.mjs", tmp_path / "work", validator=False)
    assert calls == [["b-aaaaaaaaaa", "b-bbbbbbbbbb", "b-cccccccccc"], ["b-bbbbbbbbbb", "b-cccccccccc"]]  # once, not twice
    recovered, stuck = report["decks"]["b-bbbbbbbbbb"], report["decks"]["b-cccccccccc"]
    assert recovered["convert"] == "ok" and recovered["retries"][0]["kind"] == "convert-crash"
    assert recovered["retries"][0]["first"] == "exit 3: error"
    assert stuck["convert"] == "error" and len(stuck["retries"]) == 1  # still failing after the retry
    assert report["flaky"] == ["b-bbbbbbbbbb", "b-cccccccccc"]


def test_a_deck_that_needed_a_retry_is_flaky_not_the_same():
    old = {"b-a": summary(), "b-b": summary()}
    flaky = {**summary(), "retries": [{"attempt": 1, "kind": "convert-crash", "first": "exit 3: error"}]}
    result = net.compare(old, {"b-a": summary(), "b-b": flaky})
    assert result["same"] == 1 and result["flaky"] == ["b-b"] and not result["worse"]
    text = net.format_comparison(result)
    assert "1 flaky" in text and "FLAKY b-b" in text and "convert-crash" in text


def test_combine_keeps_the_retries_and_lists_the_flaky_decks(tmp_path):
    flaky = {**summary(), "retries": [{"attempt": 1, "kind": "facts", "first": "facts: x"}]}
    net.save({"schema": net.SCHEMA, "date": "d", "converter": "c", "decks": {"b-a": flaky}, "flaky": ["b-a"]},
             tmp_path / "1.json")
    net.save({"schema": net.SCHEMA, "date": "d", "converter": "c", "decks": {"b-b": summary()}}, tmp_path / "2.json")
    out = tmp_path / "all.json"
    assert net.main(["combine", str(tmp_path / "1.json"), str(tmp_path / "2.json"), "--out", str(out)]) == 0
    combined = net.load(out)
    assert combined["decks"]["b-a"]["retries"][0]["kind"] == "facts" and combined["flaky"] == ["b-a"]


def test_the_validator_missing_is_not_a_pass(monkeypatch, tmp_path):
    from harness.ooxml import validate as validator

    def broken():
        raise RuntimeError("dotnet missing")

    monkeypatch.setattr(validator, "ensure_built", broken)
    assert net.validate_outputs({"b-a": tmp_path / "x.pptx"}) == {"b-a": None}
    base = {"b-a": summary(), "b-b": summary()}
    report = {"b-a": summary(validator=None), "b-b": summary(validator=3)}
    problems = net.incomplete(base, report)
    assert problems == ["validator did not run for 1 deck(s)"]
    text = net.format_comparison(net.compare(base, report), problems)
    assert "INCOMPLETE" in text and "0 worse" not in text
    assert net.incomplete(base, {"b-a": summary(), "b-b": summary()}) == []


def test_a_missing_deck_is_not_a_pass():
    base = {"b-a": summary(), "b-b": summary()}
    problems = net.incomplete(base, {"b-a": summary()})
    assert problems == ["1 off-bar deck(s) of the baseline were not measured"]
    assert net.incomplete(base, {"b-a": summary()}, expected=["b-a"]) == []  # a shard only owes its own decks


def test_the_run_exits_nonzero_when_incomplete_and_prints_zero_worse_only_when_complete(monkeypatch, tmp_path, capsys):
    base = {"schema": net.SCHEMA, "date": "d", "converter": "c", "decks": {"b-a": summary(), "b-b": summary()}}
    net.save(base, tmp_path / "base.json")
    reports = iter([
        {**base, "decks": {"b-a": summary(), "b-b": summary(validator=None)}},
        {**base, "decks": {"b-a": summary()}},
        base,
        base,
    ])
    monkeypatch.setattr(net, "measure", lambda *a, **k: next(reports))
    args = ["run", "--baseline", str(tmp_path / "base.json"), "--out", str(tmp_path / "r.json")]
    assert net.main(args, root=tmp_path) == 4  # validator figure missing
    assert "0 worse" not in capsys.readouterr().out
    assert net.main(args, root=tmp_path) == 4  # a deck missing
    assert "0 worse" not in capsys.readouterr().out
    assert net.main(args, root=tmp_path) == 0
    assert "0 worse" in capsys.readouterr().out
    assert net.main(args + ["--no-validator"], root=tmp_path) == 4  # a net without the validator is not complete
