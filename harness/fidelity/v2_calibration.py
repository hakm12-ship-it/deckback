"""V2 against the renderer noise floor, and proposed V2 limits (M3 Task 12). It only reports: it changes nothing.

    harness/.venv/Scripts/python -m harness.fidelity.v2_calibration --results <json> [--population atlas]
        [--json <file>]

V2 (metrics.v2) compares MuPDF's render of the input PDF with PowerPoint's render of our PPTX. Its limits were the
spec's, ``residual5 <= 50`` px and ``px32_shift1 <= 0.6 %`` (metrics.V2_MAX_RESIDUAL, V2_MAX_SHIFT1), when this tool was
written; since ruling M3-R51 those numbers are the excess allowed over a slide's noise floor, and a slide without one is
held to 400 px and 1 % (metrics.v2_limits). This tool still reports the spec's absolute numbers and the proposal next to
each other, as Task 12 measured them; the results' own ``pass`` is M3-R51's. The noise floor
of a slide (``noise`` in the results, rulings M1-R33 and M1-R57) is the same metrics between MuPDF's render of the
input PDF and PowerPoint's render of the source deck: what V2 measures when no converter is involved, on every slide
with a ground truth. M1 found it above the spec's limits on many atlas pages, the reason for this measurement.

From a fidelity run's results JSON this prints:

* the noise floor of the population (``--population``, a deck id of the results, default ``atlas``: the feature
  atlas, every variant the results hold): its slides and the median, p95, p99 and max of ``residual5`` (px) and
  ``px32_shift1`` (%), percentiles as numpy's default (linear) computes them;
* the limits: the spec's, and the proposal: for each metric the smallest round value (one significant digit, ``d x
  10^k``) strictly above the population's p99 (``round_above``);
* the table: for every deck x variant, then per set and over the run, the slides whose V2 is computed and how many of
  them pass under the spec's limits and under the proposal, and the slides with a noise floor (a ground truth) and
  how many of those pass under each (a slide passes when both metrics are within the limits);
* the noise floor per deck x variant (median, p95, p99, max), so another population can be read off.

A record that holds an error (``{"pass": false, "error": ...}``: no render, a size mismatch) is left out and counted in
``total.errors``. ``--json`` also writes all of it as JSON. Private decks appear by their id only, as in the results.

Exit codes: 0 printed; 2 bad arguments (argparse); 3 the results cannot be read or no slide of the population has a
noise floor.
"""

import argparse
import json
import sys
from decimal import Decimal
from pathlib import Path

import numpy as np

from harness.fidelity import metrics

DEFAULT_POPULATION = "atlas"
DIGITS = 6
SETS = ("public", "atlas", "private")
STEPS = {"residual5": 1, "px32_shift1": 0.01}  # the smallest limit proposed: 1 px, 0.01 %


class CalibrationError(Exception):
    """The calibration cannot be computed; the message is fixed words and deck ids."""


def round_above(value, step):
    """The smallest value d x 10^k (d = 1..9, k whole) strictly above `value`, at least `step`."""
    if value < step:
        return step
    exact = Decimal(repr(float(value)))
    power = exact.adjusted()  # k of the leading digit
    digit = int(exact.scaleb(-power)) + 1  # the leading digit, truncated, plus one: strictly above
    result = float(Decimal(digit).scaleb(power))
    return int(result) if result >= 1 and result == int(result) else result


def _stats(values):
    values = np.asarray(values, dtype=float)
    return {"median": round(float(np.median(values)), DIGITS), "p95": round(float(np.percentile(values, 95)), DIGITS),
            "p99": round(float(np.percentile(values, 99)), DIGITS), "max": round(float(values.max()), DIGITS)}


def _computed(record):
    return isinstance(record, dict) and "error" not in record and "residual5" in record and "px32_shift1" in record


def _metrics(record):
    """(residual5 px, px32_shift1 %) of a V2-style record."""
    return record["residual5"], 100 * record["px32_shift1"]


def passes(record, limits):
    residual, shift = _metrics(record)
    return residual <= limits["residual5"] and shift <= limits["px32_shift1"] + 1e-9


def _row(slides, limits):
    ours = [s["v2"] for s in slides if _computed(s["v2"])]
    noise = [s["noise"] for s in slides if _computed(s["noise"])]
    return {"slides": len(ours), "ours": {name: sum(passes(r, lim) for r in ours) for name, lim in limits.items()},
            "groundTruth": len(noise),
            "noise": {name: sum(passes(r, lim) for r in noise) for name, lim in limits.items()}}


def _floor(noise):
    return {"slides": len(noise), "residual5": _stats([_metrics(r)[0] for r in noise]),
            "px32_shift1": _stats([_metrics(r)[1] for r in noise])}


def calibrate(results, population=DEFAULT_POPULATION):
    """The calibration of a results document (see the module docstring); CalibrationError without a population."""
    records = [r for r in results.get("decks") or [] if isinstance(r, dict)]
    floor = [s["noise"] for r in records if r.get("id") == population for s in r.get("slides") or []
             if _computed(s.get("noise"))]
    if not floor:
        raise CalibrationError(f"no slide of {population} has a noise floor in the results")
    noise_floor = {"deck": population, **_floor(floor)}
    limits = {"spec": {"residual5": metrics.V2_MAX_RESIDUAL,
                       "px32_shift1": round(100 * metrics.V2_MAX_SHIFT1, DIGITS)},
              "proposal": {key: round_above(noise_floor[key]["p99"], step) for key, step in STEPS.items()}}
    table, by_set, noise_by_deck, every = [], {}, [], []
    errors = 0
    for record in records:
        slides = [{"v2": s.get("v2"), "noise": s.get("noise")} for s in record.get("slides") or []]
        errors += sum(1 for s in slides for key in ("v2", "noise") if isinstance(s[key], dict) and "error" in s[key])
        every += slides
        by_set.setdefault(record.get("set"), []).extend(slides)
        table.append({"deck": record.get("id"), "set": record.get("set"), "variant": record.get("variant"),
                      **_row(slides, limits)})
        noise = [s["noise"] for s in slides if _computed(s["noise"])]
        if noise:
            noise_by_deck.append({"deck": record.get("id"), "set": record.get("set"),
                                  "variant": record.get("variant"), **_floor(noise)})
    ordered = [name for name in SETS if name in by_set] + [name for name in by_set if name not in SETS]
    return {"results": {"date": results.get("date"), "converter": results.get("converter")},
            "population": population, "noiseFloor": noise_floor, "limits": limits, "table": table,
            "bySet": [{"set": name, **_row(by_set[name], limits)} for name in ordered],
            "total": {**_row(every, limits), "errors": errors}, "noiseByDeck": noise_by_deck}


# ---- printing -----------------------------------------------------------------------------------------------------


def _g(value):
    return f"{value:g}"


def _limits_text(limits):
    return f"residual5 <= {_g(limits['residual5'])} px, px32_shift1 <= {_g(limits['px32_shift1'])} %"


def _stats_text(stats):
    return "  ".join(f"{key} {_g(stats[key])}" for key in ("median", "p95", "p99", "max"))


def render(report):
    """The report as text lines."""
    floor, limits = report["noiseFloor"], report["limits"]
    lines = [f"V2 calibration: results of {report['results']['date']}, converter {report['results']['converter']}; "
             "nothing is changed",
             f"noise floor (V2's metrics between MuPDF and PowerPoint's render of the source deck) of "
             f"{report['population']}: {floor['slides']} slides",
             f"  residual5 px:   {_stats_text(floor['residual5'])}",
             f"  px32_shift1 %:  {_stats_text(floor['px32_shift1'])}",
             f"limits: spec {_limits_text(limits['spec'])}; proposal {_limits_text(limits['proposal'])}",
             f"  (proposal: the smallest one-digit round values above the p99 of {report['population']}'s noise floor)",
             "",
             f"{'deck x variant':<26}{'set':<9}{'slides':>7}{'ours spec':>11}{'ours prop':>11}{'gt':>6}"
             f"{'noise spec':>12}{'noise prop':>12}"]

    def row(name, set_name, r):
        return (f"{name:<26}{set_name:<9}{r['slides']:>7}{r['ours']['spec']:>11}{r['ours']['proposal']:>11}"
                f"{r['groundTruth']:>6}{r['noise']['spec']:>12}{r['noise']['proposal']:>12}")

    lines += [row(f"{r['deck']} {r['variant']}", r["set"], r) for r in report["table"]]
    lines += [row(f"set {r['set']}", "", r) for r in report["bySet"]]
    lines.append(row("all", "", report["total"]))
    lines.append(f"  (records with an error, left out: {report['total']['errors']})")
    lines += ["", "noise floor per deck x variant:"]
    for r in report["noiseByDeck"]:
        lines.append(f"  {r['deck']} {r['variant']} ({r['slides']} slides): residual5 px "
                     f"{_stats_text(r['residual5'])}; px32_shift1 % {_stats_text(r['px32_shift1'])}")
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m harness.fidelity.v2_calibration",
                                     description="V2 against the renderer noise floor, and proposed V2 limits; "
                                                 "changes nothing.")
    parser.add_argument("--results", required=True, type=Path, help="a fidelity run's results JSON")
    parser.add_argument("--population", default=DEFAULT_POPULATION,
                        help="the deck id whose noise floor gives the proposal (default: atlas)")
    parser.add_argument("--json", type=Path, help="also write the calibration as JSON")
    args = parser.parse_args(argv)
    try:
        results = json.loads(args.results.read_text(encoding="utf-8"))
        report = calibrate(results, args.population)
    except CalibrationError as exc:
        print(f"v2_calibration: {exc}", file=sys.stderr)
        return 3
    except (OSError, ValueError) as exc:
        print(f"v2_calibration: the results cannot be read ({type(exc).__name__})", file=sys.stderr)
        return 3
    print("\n".join(render(report)))
    if args.json is not None:
        args.json.write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
