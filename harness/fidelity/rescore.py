"""Re-score a results file with the two M5 Task 1 rules, from a round trip recorded earlier (as M4 Task 7 did),
without PowerPoint and without rendering anything.

    harness/.venv/Scripts/python -m harness.fidelity.rescore <old results> <s7 json> --out <new results> [--date D]
        [--root <repo root of the checkout that produced the results>]

Run it from the repository root of the commit that produced the results: the decks are discovered on that checkout.

* S7 per page: ``s7`` maps (deck id, variant) to the round trip's result (roundtrip.s7, with its ``pages``); each slide
  of that deck x variant gets its own page's S7 (run.slide_s7). The side input is a JSON file
  ``{"date": D, "decks": {deck id: {variant: result}}}`` kept in the repository.
* V1's noise exemption (ruling M5-R1): from each slide's recorded ``noise`` record (run.judge_v1); every deck,
  private ones included, since it reads numbers only.

Ruling M5-R3, no quiet mixing of runs:
* the output's ``options.rescore`` records the source results file and the S7 side input (repo-relative path, sha256,
  the side input's date) and the converter commit of the renders (null with a note: the results do not record it);
* anything that does not fit exits non-zero and writes nothing: a schema problem, an S7 entry that matches no deck x
  variant of the results (or of this checkout's decks), an input outside the repository;
* the deck x variants without an S7 entry keep their deck-wide S7, which fails every slide; they are listed in
  ``summary.s7DeckWide`` and printed.

The slide's ``pass`` and the summary are computed again; everything else is copied.
"""

import argparse
import copy
import hashlib
import json
import sys
from datetime import date
from pathlib import Path

from harness.fidelity import decks as deck_list
from harness.fidelity import run
from harness.fidelity.schema_check import validate

NOTE = ("the source results file does not record the converter commit of its renders; they are the renders of the "
        "run it came from")


def _recorded_s7(record):
    """The deck's S7 as the recorded slides carry it (the deck-level verdict of a results file from before M5)."""
    if record.get("s7") or not record["slides"]:
        return record.get("s7")
    first = record["slides"][0]["s"]["S7"]
    return {"status": first["status"], "detail": first["detail"]}


def rescore(old, *, found, s7, provenance=None):
    """A new results dict from `old`: `found` the decks (decks.discover) of its records, `s7` {(id, variant): round
    trip result}, `provenance` the ``options.rescore`` record. An s7 key that matches no deck of `old`, or a deck that
    `found` does not have, is a ValueError (nothing is applied quietly). The decks and variants without an s7 entry keep
    their deck-wide S7 and are listed in ``summary.s7DeckWide``."""
    results = copy.deepcopy(old)
    by_key = {(d.id, d.variant): d for d in found if d.public}
    recorded = {(r["id"], r["variant"]) for r in results["decks"]}
    unmatched = sorted(f"{deck_id}/{variant}" for deck_id, variant in s7
                       if (deck_id, variant) not in recorded or (deck_id, variant) not in by_key)
    if unmatched:
        raise ValueError("the S7 side input has entries that match no public deck x variant of the results (or of "
                         f"this checkout's decks): {', '.join(unmatched)}")
    deck_wide = []
    for record in results["decks"]:
        key = (record["id"], record["variant"])
        deck = by_key.get(key)
        record["s7"] = _recorded_s7(record) if record.get("slides") else record.get("s7")
        if record["s7"] is None:
            del record["s7"]
        trip = s7.get(key)
        if trip is not None:
            record["s7"] = run.deck_s7_record(trip)
        elif record["slides"]:
            deck_wide.append({"id": record["id"], "set": record["set"], "variant": record["variant"]})
        for slide in record["slides"]:
            if trip is not None:
                slide["s"]["S7"] = run.gates_for(deck, {"S7": run.slide_s7(trip, slide["index"] + 1)})["S7"]
                positions = run.slide_positions(trip, slide["index"] + 1)  # M8-R12
                if positions is not None:
                    slide["positions"] = positions
                else:
                    slide.pop("positions", None)
            slide["v1"] = run.judge_v1(slide["v1"], slide["v2"], slide["noise"])
            if record["reasons"].get("render") == run.OFF_BAR:  # M8-R1: not measured, neither pass nor fail
                slide["pass"] = None
            else:
                run.judge(slide, slide.get("fontException"))
    summary = run.summarise(results["decks"], old["summary"].get("privateUnreadable", 0),
                            old["summary"].get("powerpoint"))
    summary["s7DeckWide"] = deck_wide
    results["summary"] = summary
    if provenance is not None:
        results["options"] = {**results["options"], "rescore": provenance}
    return results


def _relative(path, root):
    """`path` as a forward-slash path relative to `root`; a path outside the repo is an error (no absolute path is
    ever recorded)."""
    try:
        return Path(path).resolve().relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        raise ValueError("the inputs of a re-score must lie inside the repository") from None


def _sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m harness.fidelity.rescore")
    parser.add_argument("old", type=Path)
    parser.add_argument("s7", type=Path, help='JSON {"date": D, "decks": {deck id: {variant: roundtrip.s7 result}}}')
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--date", default=date.today().isoformat())
    parser.add_argument("--root", type=Path, default=Path.cwd(),
                        help="the repository root of the checkout that produced the results (default: the cwd)")
    args = parser.parse_args(argv)
    try:
        old = json.loads(args.old.read_text(encoding="utf-8"))
        side = json.loads(args.s7.read_text(encoding="utf-8"))
        provenance = {"source": {"path": _relative(args.old, args.root), "sha256": _sha256(args.old)},
                      "s7": {"path": _relative(args.s7, args.root), "sha256": _sha256(args.s7),
                             "date": side["date"]},
                      "converterCommit": None, "note": NOTE}
        trips = {}
        for deck_id, variants in side["decks"].items():
            for variant, trip in variants.items():
                if trip.get("pages"):
                    trip["pages"] = {int(n): text for n, text in trip["pages"].items()}
                trips[(deck_id, variant)] = trip
        sets = [s for s in old["options"]["decks"] if s not in ("private", "tier-c")]
        found = deck_list.discover(args.root, sets, old["options"]["variants"])
        new = rescore(old, found=found, s7=trips, provenance=provenance)
    except (ValueError, KeyError, OSError) as exc:
        print(f"rescore: {exc if isinstance(exc, ValueError) else type(exc).__name__ + ': ' + str(exc)}",
              file=sys.stderr)
        return 1
    new["date"] = args.date
    problems = validate(new, json.loads(run.SCHEMA_PATH.read_text(encoding="utf-8")))
    if problems:
        print(f"rescore: the result does not match results.schema.json ({len(problems)} problem(s)); nothing "
              f"written: {'; '.join(problems[:5])}", file=sys.stderr)
        return 1
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(new, ensure_ascii=False, indent=1) + "\n")
    print(f"rescore: {new['summary']['slides']} slides, {new['summary']['pass']} pass; 0 schema problem(s)")
    wide = new["summary"]["s7DeckWide"]
    if wide:
        print("rescore: not re-run, deck-wide S7 kept for: " + ", ".join(f"{d['id']}/{d['variant']}" for d in wide))
    return 0


if __name__ == "__main__":
    sys.exit(main())
