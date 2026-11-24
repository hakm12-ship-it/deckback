"""The off-bar structural regression net (ruling M8-R8): after a converter change, every tier-B deck that is off the bar
is converted again and checked structurally (conversion, S1-S6 and the Open XML validator; no PowerPoint, no renders),
and what it finds is compared with a stored baseline. The decks that got worse are listed.

    harness/.venv/Scripts/python -m harness.fidelity.offbar_net run --baseline <file> [--cli <deckback.mjs>]
                                       [--ids <id>,...] [--shard K/N] [--work <dir>] [--out <report.json>] [--no-validator]
    harness/.venv/Scripts/python -m harness.fidelity.offbar_net compare <baseline> <report>
    harness/.venv/Scripts/python -m harness.fidelity.offbar_net combine <report> <report>... --out <report.json>
    harness/.venv/Scripts/python -m harness.fidelity.offbar_net summary <results or report>   # what a baseline keeps

* ``run`` converts the ``real`` decks whose origin is not powerpoint-windows (``corpus/public-real``), checks every page
  with S1-S6 (``run.structural``; S7 is n/a here), validates every output PPTX, writes the report (``--out``, default
  ``out/offbar-net/report.json``) and prints the comparison with ``--baseline``. ``--cli`` is the converter bundle
  (default: the repository's ``packages/cli/dist/deckback.mjs``): build the commit to test somewhere clean and point
  ``--cli`` at it, so that a working tree in the middle of a change is not what is measured.
* A whole run takes hours (the S gates of a large deck are slow): ``--shard K/N`` takes every N-th deck from the K-th
  (K from 0), so N processes can run side by side with their own ``--work`` and ``--out``; ``combine`` joins their
  reports (without ``--baseline`` a shard is compared with the baseline's same decks only).
* A deck with a page whose facts could not be read (all six gates fail with a ``facts:`` detail) is measured again, up
  to twice (``retried`` in the report): this happens under load and reads fine on the next try.
* A baseline is a report of this tool, or a results file of a fidelity run with ``--off-bar-structural`` (r0's, for
  the first one; it has no validator figures, so the validator is not compared). ``summary`` shows what is kept.
* A deck is worse than its baseline when its conversion no longer succeeds, a page that passed a gate S1-S6 now fails
  it, it has fewer slides, or the validator reports errors it did not (or more of them). It is better in the opposite
  cases; both can hold at once (mixed). Exit code 1 when a deck is worse, 4 when the net is incomplete (a baseline deck was not measured, or the validator did
  did not run for a converted deck, or --no-validator: it never prints "0 worse" then), 3 for a usage error, else 0.
* A deck is measured again when a page's facts could not be read (up to twice) or when the converter crashed (exit code
  3, once). Every retry and the first failure are kept in the deck's entry (``retries``), a deck that needed one is
  listed as ``flaky`` (report, ``combine``, comparison) and never counted as "the same".

Tier-B decks appear by id only; a report holds statuses, counts and page numbers, no text and no detail.
"""

import argparse
import json
import sys
import time
from pathlib import Path

from harness.fidelity import decks as deck_list
from harness.fidelity import run

REPO = Path(__file__).resolve().parents[2]
SCHEMA = "deckback.offbar-net/1"
GATES = run.S_KEYS  # S1-S6; S7 is n/a off the bar


# ---- what a baseline keeps --------------------------------------------------------------------------------------


def deck_summary(record, validator_errors=None, retries=None):
    """What the net compares of a results deck record: {"convert": reason, "pages", "slides", "failed": {gate: [page
    index, ...]} (gates with no failure left out), "validatorErrors": int or None (not validated)}."""
    failed = {}
    for slide in record.get("slides") or []:
        for gate in GATES:
            if slide["s"][gate]["status"] == "fail":
                failed.setdefault(gate, []).append(slide["index"])
    out = {"convert": record.get("reasons", {}).get("convert"), "pages": record.get("pages"),
           "slides": len(record.get("slides") or []), "failed": failed, "validatorErrors": validator_errors}
    if retries:  # the deck needed another attempt: kept per deck, with what the first attempt looked like
        out["retries"] = retries
    return out


def baseline_decks(document):
    """{deck id: deck_summary} of a baseline: a report of this tool, or a results file (its real decks off the bar)."""
    if document.get("schema") == SCHEMA:
        return dict(document["decks"])
    return {d["id"]: deck_summary(d) for d in document["decks"]
            if d["set"] == "real" and d.get("origin") != "powerpoint-windows"}


def new_failures(old, new):
    """{gate: [page index, ...]} of the pages that fail a gate in `new` and did not in `old` (a page that `old` did not
    have fails nothing there, so a longer deck's extra pages count)."""
    out = {}
    for gate, pages in new["failed"].items():
        fresh = sorted(set(pages) - set(old["failed"].get(gate, ())))
        if fresh:
            out[gate] = fresh
    return out


def compare(baseline, new):
    """The comparison of two {id: deck_summary} maps: {"worse": [...], "better": [...], "mixed": [...], "same": n,
    "flaky": [ids that needed a retry], "missing": [ids the new run lacks], "added": [ids the baseline lacks]}. Each listed deck is {"id", "reasons":
    [fixed words], "gates": {gate: [pages]}} ("worse" and "mixed" also have what got worse; "better" and "mixed" what
    got better in "improved")."""
    worse, better, mixed, same, flaky = [], [], [], 0, []
    for deck_id in sorted(set(baseline) & set(new)):
        old, now = baseline[deck_id], new[deck_id]
        bad, good = [], []
        if old["convert"] == "ok" and now["convert"] != "ok":
            bad.append(f"conversion no longer succeeds ({now['convert']})")
        elif old["convert"] != "ok" and now["convert"] == "ok":
            good.append("conversion now succeeds")
        both = old["convert"] == "ok" and now["convert"] == "ok"
        gates_bad = new_failures(old, now) if both else {}
        gates_good = new_failures(now, old) if both else {}
        if gates_bad:
            bad.append("S gate failures on " + ", ".join(f"{g} x{len(p)}" for g, p in sorted(gates_bad.items())))
        if gates_good:
            good.append("S gate failures gone on " + ", ".join(f"{g} x{len(p)}" for g, p in sorted(gates_good.items())))
        if both and now["slides"] < old["slides"]:
            bad.append(f"fewer slides ({now['slides']} against {old['slides']})")
        old_v, new_v = old.get("validatorErrors"), now.get("validatorErrors")
        if new_v is not None and old_v is not None:
            if new_v > old_v:
                bad.append(f"validator errors {old_v} -> {new_v}")
            elif new_v < old_v:
                good.append(f"validator errors {old_v} -> {new_v}")
        elif new_v:  # the baseline never validated: any error is news
            bad.append(f"validator errors {new_v} (the baseline has no validator figure)")
        entry = {"id": deck_id, "reasons": bad, "gates": gates_bad, "improved": good}
        if now.get("retries"):  # needed a retry: never counted as plain "same" (it may be a crash under load)
            flaky.append({"id": deck_id, "retries": now["retries"]})
        if bad and good:
            mixed.append(entry)
        elif bad:
            worse.append(entry)
        elif good:
            better.append(entry)
        elif not now.get("retries"):
            same += 1
    return {"worse": worse, "better": better, "mixed": mixed, "same": same, "flaky": [f["id"] for f in flaky],
            "flakyRetries": {f["id"]: f["retries"] for f in flaky},
            "missing": sorted(set(baseline) - set(new)), "added": sorted(set(new) - set(baseline))}


def incomplete(baseline, new, expected=None, validator=True):
    """Why a run cannot claim "0 worse": [words], empty when complete. Every deck of `expected` (default: every deck of
    the baseline) must be in `new`, and (with `validator`) every deck that converted must have a validator figure."""
    owed = set(baseline if expected is None else expected)
    problems = []
    absent = owed - set(new)
    if absent:
        problems.append(f"{len(absent)} off-bar deck(s) of the baseline were not measured")
    if validator:
        unvalidated = [i for i, d in new.items() if d["convert"] == "ok" and d.get("validatorErrors") is None]
        if unvalidated:
            problems.append(f"validator did not run for {len(unvalidated)} deck(s)")
    return problems


def format_comparison(result, problems=()):
    if problems:  # no claim of "0 worse" on a net that did not run in full
        lines = [f"offbar-net: INCOMPLETE ({'; '.join(problems)}); of the decks measured worse: {len(result['worse'])}, "
                 f"mixed: {len(result['mixed'])}, better: {len(result['better'])}, flaky: {len(result['flaky'])}"]
    else:
        lines = [f"offbar-net: {len(result['worse'])} worse, {len(result['mixed'])} mixed, {len(result['better'])} better, "
                 f"{result['same']} the same, {len(result['flaky'])} flaky; {len(result['missing'])} in the baseline only, "
                 f"{len(result['added'])} new"]
    for label in ("worse", "mixed"):
        for entry in result[label]:
            lines.append(f"  {label.upper():5s} {entry['id']}: " + "; ".join(entry["reasons"])
                         + "".join(f" [{g}: pages {', '.join(str(p + 1) for p in pages[:8])}"
                                   f"{', ...' if len(pages) > 8 else ''}]" for g, pages in sorted(entry["gates"].items())))
    for deck_id in result["flaky"]:
        lines.append(f"  FLAKY {deck_id}: " + "; ".join(f"attempt {r['attempt']} {r['kind']}: {r['first']}"
                                                         for r in result["flakyRetries"][deck_id]))
    return "\n".join(lines)


# ---- the run ----------------------------------------------------------------------------------------------------


def off_bar_decks(root, ids=None):
    """The ``real`` decks of `root` whose origin is not powerpoint-windows, optionally only `ids`."""
    found = [d for d in deck_list.discover(root, ["real"], ["pdf"]) if d.origin != "powerpoint-windows"]
    if ids:
        found = [d for d in found if d.id in ids]
    return deck_list.DeckList(found)


def validate_outputs(paths):
    """{deck id: validator error count} for {id: pptx path}; None for every deck when the validator cannot run."""
    from harness.ooxml import validate as validator

    try:
        validator.ensure_built()
    except Exception:
        return {deck_id: None for deck_id in paths}
    counts = {}
    for deck_id, path in paths.items():
        try:
            rows = validator.validate([Path(path)], private=True)
            counts[deck_id] = int(sum(row.get("errorCount", len(row.get("errors", ()))) for row in rows))
        except Exception:
            counts[deck_id] = None
    return counts


FACTS_RETRIES = 2
CRASH_RETRIES = 1
CONVERT_CRASH = 3  # run.ERROR: the converter step crashed (exit code 3); converter-missing is also 3 and is no crash


def facts_failed(record):
    """Whether a page of the deck record failed because its facts could not be read (run.structural: all six gates fail
    with a detail that starts ``facts:``). That happens now and then under load (an unreadable XML part that reads fine
    a minute later), so the net reads such a deck again before it counts a failure."""
    return any(s["s"]["S1"]["status"] == "fail" and s["s"]["S1"]["detail"].startswith("facts:")
               for s in record.get("slides") or [])


def convert_crashed(record):
    """Whether the converter step of the deck record crashed (exit code 3, not a missing bundle)."""
    return (record.get("exitCodes", {}).get("convert") == CONVERT_CRASH
            and record.get("reasons", {}).get("convert") != run.CONVERTER_MISSING)


def first_failure(record):
    """(kind, short words) of what made the net measure a deck again, or None: ``convert-crash`` (the converter
    crashed) or ``facts`` (a page's facts unreadable). The words are a fixed token or an exception class."""
    if convert_crashed(record):
        return "convert-crash", f"exit {record['exitCodes']['convert']}: {record['reasons'].get('convert')}"
    if facts_failed(record):
        detail = next(s["s"]["S1"]["detail"] for s in record["slides"]
                      if s["s"]["S1"]["status"] == "fail" and s["s"]["S1"]["detail"].startswith("facts:"))
        return "facts", detail[:120]
    return None


def shard_of(found, shard):
    """The decks of `found` (sorted by id) that shard ``K/N`` runs: positions K, K + N, ... (all of them without one)."""
    if not shard:
        return found
    index, count = shard
    return deck_list.DeckList(d for position, d in enumerate(found) if position % count == index)


def parse_shard(text):
    index, _, count = str(text).partition("/")
    if not (index.isdigit() and count.isdigit() and int(count) >= 1 and int(index) < int(count)):
        raise ValueError("--shard needs K/N with 0 <= K < N")
    return int(index), int(count)


def measure(root, cli, work, ids=None, validator=True, argv=None, shard=None):
    """A report of the off-bar decks of `root` converted with the bundle `cli` (or the command `argv`, which gets the PDF
    and ``-o <pptx>``: a test hook), checked (S1-S6, validator) under `work`."""
    found = shard_of(off_bar_decks(root, ids), shard)
    base = run.default_tools("deckback")
    tools = run.Tools(convert=run.SubprocessConverter(argv or ["node", str(cli)], required=None if argv else cli), render=None,
                      render_pdf=base.render_pdf, s7=None)
    started = time.perf_counter()
    options = {"decks": ["real"], "variants": ["pdf"], "s7": False, "limitSlides": None, "offBarStructural": True,
               "offBarNet": True}
    results = run.run_decks(found, tools, work, converter="deckback", s7_enabled=False, off_bar_structural=True,
                            options=options)
    retries = {}  # deck id -> [{"attempt", "kind", "first"}]: kept in the deck's summary and listed as flaky
    for attempt in range(1, FACTS_RETRIES + 1):  # a deck whose facts could not be read or whose converter crashed: again
        again = []
        for d in found:
            record = next(r for r in results["decks"] if r["id"] == d.id)
            failure = first_failure(record)
            if failure is None:
                continue
            tried = [r for r in retries.get(d.id, ()) if r["kind"] == failure[0]]
            if failure[0] == "convert-crash" and len(tried) >= CRASH_RETRIES:
                continue  # a crash is retried once
            retries.setdefault(d.id, []).append({"attempt": attempt, "kind": failure[0], "first": failure[1]})
            again.append(d)
        if not again:
            break
        redo = run.run_decks(deck_list.DeckList(again), tools, work, converter="deckback", s7_enabled=False,
                             off_bar_structural=True, options=options)
        fresh = {r["id"]: r for r in redo["decks"]}
        results["decks"] = [fresh.get(r["id"], r) for r in results["decks"]]
    paths = {r["id"]: Path(work) / r["id"] / r["variant"] / "out.pptx" for r in results["decks"]
             if r["reasons"].get("convert") == "ok"}
    counts = validate_outputs(paths) if validator else {}
    summaries = {r["id"]: deck_summary(r, counts.get(r["id"]), retries.get(r["id"])) for r in results["decks"]}
    return {"schema": SCHEMA, "date": results["date"], "converter": Path(cli).name if cli else "command",
            "runtimeSeconds": round(time.perf_counter() - started, 1), "decks": summaries,
            **({"flaky": sorted(retries)} if retries else {})}


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(document, path):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(document, ensure_ascii=False, indent=1) + "\n")


def main(argv=None, root=REPO):
    parser = argparse.ArgumentParser(prog="python -m harness.fidelity.offbar_net", description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("run")
    p.add_argument("--baseline", type=Path, required=True)
    p.add_argument("--cli", type=Path, default=run.CLI_BUNDLE)
    p.add_argument("--ids")
    p.add_argument("--shard", help="K/N: every N-th deck from the K-th (K from 0)")
    p.add_argument("--work", type=Path)
    p.add_argument("--out", type=Path)
    p.add_argument("--no-validator", action="store_true")
    p = sub.add_parser("compare")
    p.add_argument("baseline", type=Path)
    p.add_argument("report", type=Path)
    p = sub.add_parser("combine")
    p.add_argument("reports", type=Path, nargs="+")
    p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("summary")
    p.add_argument("document", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "summary":
            decks = baseline_decks(load(args.document))
            bad = sum(1 for s in decks.values() if s["failed"])
            print(f"offbar-net: {len(decks)} decks, {bad} with an S1-S6 failure, "
                  f"{sum(1 for s in decks.values() if s['convert'] != 'ok')} not converted")
            return 0
        if args.command == "combine":
            decks = {}
            for path in args.reports:
                part = load(path)
                if part.get("schema") != SCHEMA or set(part["decks"]) & set(decks):
                    raise ValueError("combine needs reports of this tool that share no deck")
                decks.update(part["decks"])
            flaky = sorted(i for i, d in decks.items() if d.get("retries"))
            save({"schema": SCHEMA, "date": load(args.reports[0])["date"], "converter": load(args.reports[0])["converter"],
                  "decks": dict(sorted(decks.items())), **({"flaky": flaky} if flaky else {})}, args.out)
            print(f"offbar-net: {len(decks)} decks combined, {len(flaky)} flaky")
            return 0
        problems = []
        if args.command == "compare":
            old, new = baseline_decks(load(args.baseline)), baseline_decks(load(args.report))
            result = compare(old, new)
            problems = incomplete(old, new)
        else:
            work = args.work or Path(root) / "out" / "offbar-net"
            baseline = baseline_decks(load(args.baseline))
            wanted = [i for i in (args.ids or "").split(",") if i]
            if wanted:  # a partial run is compared with the same decks of the baseline
                baseline = {k: v for k, v in baseline.items() if k in wanted}
            shard = parse_shard(args.shard) if args.shard else None
            with run.quiet_mupdf():
                report = measure(root, args.cli, work, wanted or None, not args.no_validator, shard=shard)
            save(report, args.out or Path(root) / "out" / "offbar-net" / "report.json")
            owed = None
            if shard:  # a shard is compared with its own decks of the baseline, and owes exactly those
                owed = [d for position, d in enumerate(sorted(baseline)) if position % shard[1] == shard[0]]
                baseline = {k: v for k, v in baseline.items() if k in owed}
            new = baseline_decks(report)
            result = compare(baseline, new)
            problems = incomplete(baseline, new, owed)
            if args.no_validator:
                problems.append("validator skipped (--no-validator)")
    except (OSError, ValueError, KeyError) as exc:
        print(f"offbar-net: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 3
    print(format_comparison(result, problems))
    if result["worse"] or result["mixed"]:
        return 1
    return 4 if problems else 0  # 4: the net did not run in full (decks missing, validator not run): not a pass


if __name__ == "__main__":
    sys.exit(main())
