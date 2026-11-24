"""results JSON -> out/fidelity/dashboard.html: one static page, no script, no network.

    harness/.venv/Scripts/python -m harness.fidelity.dashboard out/fidelity/results.json [--out <html>]

run.py writes it after every run. The page has the run's summary (slides, gates, the noise floor of M1-R57), then
one table per deck x variant: a row per slide with ✓ / ✗ / n-a for V1, V2 and S1-S7 (the detail or the metric values
in the cell's tooltip), the known-unrecoverable classes (M1-R56), the slide's verdict, the noise record and links to
the slide's heatmaps. Over each table, the deck's own S7 verdict and its failed pages (M5 Task 1); a V1 judged by V2
(M5-R1) is marked "exempt", and the summary lists those slides (summary.v1NoiseExempt). Heatmap links are relative to the results' out/fidelity directory, so the page works where it
lies. A private deck shows its 12-hex id only: the results JSON never holds more, and every value is HTML-escaped.
"""

import argparse
import html
import json
import os
from pathlib import Path

from harness.fidelity import metrics

S_GATES = ("S1", "S2", "S3", "S4", "S5", "S6", "S7")
MARKS = {"pass": ("✓", "ok"), "fail": ("✗", "bad"), "n/a": ("n-a", "na")}
STYLE = """
body { font: 13px/1.4 system-ui, sans-serif; margin: 1.5em; color: #222; }
h1 { font-size: 1.4em; } h2 { font-size: 1.15em; margin-top: 2em; }
table { border-collapse: collapse; margin: .5em 0; }
th, td { border: 1px solid #ccc; padding: 2px 6px; text-align: center; }
th { background: #f2f2f2; } td.l { text-align: left; }
.ok { background: #e3f4e1; color: #1b6e1b; } .bad { background: #fbe3e1; color: #a11; }
.na { background: #f1f1f1; color: #777; } .meta { color: #555; }
"""


def _e(value):
    return html.escape(str(value), quote=True)


def _mark(status, title, note=""):
    text, css = MARKS.get(status, ("?", "na"))
    return f'<td class="{css}" title="{_e(title)}">{text}{_e(note)}</td>'


def _percent(fraction):
    return f"{fraction * 100:.3f} %"


def _visual(record, residual_key, missing):
    if record is None:
        return _mark("n/a", missing)
    if "error" in record:
        return _mark("fail", record["error"])
    lines = f", per line {record['residual3Lines']} px (M4-R11)" if "residual3Lines" in record else ""
    title = (f"px32_shift1 {_percent(record['px32_shift1'])}, {residual_key} {record[residual_key]} px{lines}, "
             f"raw px32 {_percent(record['raw_px32'])}")
    if record.get("noiseExempt"):  # M5-R1: judged by V2, the measured status stays beside it
        title += (f"; noise record {record.get('noiseFloor')} px (residual5) is over {metrics.V1_NOISE_EXEMPT_RESIDUAL} px: judged by V2 "
                  f"(measured: {'pass' if record.get('passMeasured') else 'fail'})")
        return _mark("pass" if record["pass"] else "fail", title, " exempt")
    return _mark("pass" if record["pass"] else "fail", title)


FRAME_DIFFERS = ("page frame differs from the source slide (msprint and other paper pages): no V1 and no noise floor "
                 "(ruling M1-R72)")


def _noise(record, missing="no ground truth"):
    if record is None:
        return f'<td class="na" title="{_e(missing)}">–</td>'
    if "error" in record:
        return f'<td class="na" title="{_e(record["error"])}">err</td>'
    css = "ok" if record["pass"] else "bad"
    title = f"MuPDF vs ground truth (never gated): residual5 {record['residual5']} px"
    return f'<td class="{css}" title="{_e(title)}">{_percent(record["px32_shift1"])}</td>'


def _deck_table(deck, prefix):
    title = f"{deck['id']} · {deck['variant']}" + (" (private)" if not deck["public"] else f" ({deck['set']})")
    codes, reasons = deck["exitCodes"], deck["reasons"]
    steps = []
    for step in ("input", "convert", "render", "groundTruth"):
        code = codes[step]
        steps.append(f"{step} {'-' if code is None else code}" + (f" ({reasons[step]})" if reasons[step] else ""))
    meta = f"pages {deck['pages']}; exit codes: " + ", ".join(steps)
    if deck.get("convert"):
        meta += "; converter: " + ", ".join(f"{k} {v}" for k, v in deck["convert"].items())
    parts = [f"<h2>{_e(title)}</h2>", f'<p class="meta">{_e(meta)}</p>']
    s7 = deck.get("s7")
    if s7:  # the deck's own round-trip verdict (M5 Task 1); each slide's S7 cell is its page's
        pages = s7.get("failedPages")
        line = f"S7 (round trip): {s7['status']}" + (f"; failed pages {', '.join(map(str, pages))}" if pages else "")
        parts.append(f'<p class="meta" title="{_e(s7["detail"])}">{_e(line)}</p>')
    if deck.get("error"):
        parts.append(f'<p class="bad">{_e(deck["error"])}</p>')
    passed = sum(1 for s in deck["slides"] if s["pass"] is True)
    failed = sum(1 for s in deck["slides"] if s["pass"] is False)
    off = len(deck["slides"]) - passed - failed
    parts.append(f'<p class="meta">slides measured: {len(deck["slides"]) - off}; {passed} pass, {failed} fail'
                 + (f"; {off} not measured (off the bar, S1-S6 only)" if off else "") + "</p>")
    head = "".join(f"<th>{g}</th>" for g in ("Page", "Label", "V1", "V2") + S_GATES +
                   ("Known", "Pass", "Noise (px32_shift1)", "Heatmaps"))
    rows = []
    frame = deck["reasons"].get("groundTruth") == "page-frame-differs"
    no_v1 = FRAME_DIFFERS if frame else "no source PPTX: V1 needs the deck the PDF was exported from"
    for slide in deck["slides"]:
        cells = [f"<td>{slide['index'] + 1}</td>", f'<td class="l">{_e(slide["label"] or "")}</td>',
                 _visual(slide["v1"], "residual3", no_v1), _visual(slide["v2"], "residual5", "")]
        cells += [_mark(slide["s"][g]["status"], slide["s"][g]["detail"]) for g in S_GATES]
        cells.append(f'<td class="l">{_e(", ".join(slide["known"]))}</td>')
        if slide["pass"] is None:
            cells.append(_mark("n/a", "not measured: off the bar (M8-R1)"))
        else:
            note = f" ({slide['fontException']} font exception)" if slide.get("fontException") else ""
            cells.append(_mark("pass" if slide["pass"] else "fail", ("every gate passed" if slide["pass"]
                                                                     else "a gate failed or is n/a") + note))
        cells.append(_noise(slide["noise"], FRAME_DIFFERS if frame else "no ground truth"))
        links = " ".join(f'<a href="{_e(prefix + path)}">{_e(key)}</a>'
                         for key, path in sorted(slide["heatmaps"].items()))
        cells.append(f"<td>{links}</td>")
        rows.append("<tr>" + "".join(cells) + "</tr>")
    parts.append(f"<table><tr>{head}</tr>{''.join(rows)}</table>")
    return "\n".join(parts)


def _mean_cells(mean):
    if mean is None:
        return '<td class="na">–</td><td class="na">–</td><td class="na">–</td>'
    return f"<td>{mean['slides']}</td><td>{_percent(mean['raw_px32'])}</td><td>{_percent(mean['px32_shift1'])}</td>"


def _averages(averages):
    """The mean raw_px32 and px32_shift1 of V1 and V2, over the run and per deck x variant (never gated)."""
    head = ("<tr><th>Deck</th><th>Set</th><th>Variant</th><th>V1 slides</th><th>V1 raw px32</th>"
            "<th>V1 px32_shift1</th><th>V2 slides</th><th>V2 raw px32</th><th>V2 px32_shift1</th></tr>")
    rows = [f'<tr><td class="l"><b>all</b></td><td></td><td></td>{_mean_cells(averages["overall"]["v1"])}'
            f'{_mean_cells(averages["overall"]["v2"])}</tr>']
    for entry in averages["decks"]:
        rows.append(f"<tr><td>{_e(entry['id'])}</td><td>{_e(entry['set'])}</td><td>{_e(entry['variant'])}</td>"
                    f"{_mean_cells(entry['v1'])}{_mean_cells(entry['v2'])}</tr>")
    return ("<h2>Averages (reported, never gated)</h2>"
            f"<table>{head}{''.join(rows)}</table>")


def render_html(results, heatmap_prefix=""):
    """The dashboard page for a results document; heatmap links get `heatmap_prefix` (a relative URL prefix)."""
    summary = results["summary"]
    env = results["env"]
    out = ["<!DOCTYPE html>", '<html lang="en"><head><meta charset="utf-8">',
           f"<title>deckback fidelity: {_e(results['converter'])} {_e(results['date'])}</title>",
           f"<style>{STYLE}</style></head><body>",
           f"<h1>deckback fidelity: converter {_e(results['converter'])}, {_e(results['date'])}</h1>",
           f'<p class="meta">{_e(results["schema"])}; runtime {results["runtimeSeconds"]:.0f} s; PowerPoint '
           f'{_e(env["powerpoint"])}, PyMuPDF {_e(env["pymupdf"])}, Python {_e(env["python"])}, node '
           f'{_e(env["node"])}; options {_e(json.dumps(results["options"]))}</p>',
           f"<p>{summary['decks']} deck x variants, {summary['slides']} slides: <b>{summary['pass']} pass</b>, "
           f"{summary['fail']} fail; {summary['known']} slides with a known-unrecoverable class. A slide passes only "
           "when every gate passed (n/a is not a pass; V1 is n/a without a source PPTX and does not count).</p>"]
    out.append("<table><tr><th>Gate</th><th>pass</th><th>fail</th><th>n/a</th></tr>")
    for gate, counts in summary["byGate"].items():
        out.append(f"<tr><td>{gate}</td><td>{counts['pass']}</td><td>{counts['fail']}</td>"
                   f"<td>{counts['na']}</td></tr>")
    out.append("</table>")
    codes = summary["exitCodes"]
    out.append(f'<p class="meta">failed steps (deck x variants): input PDF {codes["inputFailed"]}, convert '
               f'{codes["convertFailed"]}, render {codes["renderFailed"]}, ground truth '
               f'{codes["groundTruthFailed"]}</p>')
    if summary["privateUnreadable"]:
        out.append(f'<p class="bad">{summary["privateUnreadable"]} private PDF(s) or folder(s) could not be read: '
                   "they were not measured, and nothing names them</p>")
    powerpoint = summary.get("powerpoint") or {}
    if powerpoint.get("stuckAt"):  # M1-R74: the later decks' PowerPoint steps were not their fault
        at = powerpoint["stuckAt"]
        out.append(f'<p class="bad">PowerPoint timed out at {_e(at["id"])} {_e(at["variant"])} ({_e(at["step"])}); '
                   f'{powerpoint["skippedAfterStuck"]} later PowerPoint step(s) were not attempted '
                   "(skipped-after-stuck: render, ground truth or S7 of the decks after it; not counted against "
                   "them). A dialog may still be open in PowerPoint: see harness/README.md for the manual cleanup.</p>")
    if powerpoint.get("busy"):
        out.append(f'<p class="bad">{powerpoint["busy"]} PowerPoint step(s) refused because PowerPoint was busy '
                   "(powerpoint-busy: a dialog open in PowerPoint?), not counted against the decks</p>")
    if summary["noiseFloor"]:
        out.append("<h2>Noise floor (MuPDF vs PowerPoint render of the source deck; never gated)</h2>")
        out.append("<table><tr><th>Deck</th><th>Set</th><th>Variant</th><th>Slides</th>"
                   "<th>px32_shift1 median / p95 / max</th><th>residual5 median / p95 / max</th>"
                   "<th>over 400 px / 1 % (V2 without a ground truth)</th></tr>")
        for floor in summary["noiseFloor"]:
            px, res = floor["px32_shift1"], floor["residual5"]
            out.append(f"<tr><td>{_e(floor['id'])}</td><td>{_e(floor['set'])}</td><td>{_e(floor['variant'])}</td>"
                       f"<td>{floor['slides']}</td>"
                       f"<td>{_percent(px['median'])} / {_percent(px['p95'])} / {_percent(px['max'])}</td>"
                       f"<td>{res['median']:g} / {res['p95']:g} / {res['max']:g}</td><td>{floor['overV2']}</td></tr>")
        out.append("</table>")
    if "v1NoiseExempt" in summary:  # M5-R1
        heading = f"V1 judged by V2 (noise record over {metrics.V1_NOISE_EXEMPT_RESIDUAL} px, M5-R1)"
        exempt = [f"{entry['id']} · {entry['variant']} ({entry['set']}): slides "
                  + ", ".join(map(str, entry["slides"])) for entry in summary["v1NoiseExempt"]]
        if exempt:
            out.append(f"<h2>{_e(heading)}</h2><ul>" + "".join(f"<li>{_e(line)}</li>" for line in exempt) + "</ul>")
        else:
            out.append(f"<p>{_e(heading)}: none</p>")
    if summary.get("averages"):
        out.append(_averages(summary["averages"]))
    for deck in results["decks"]:
        out.append(_deck_table(deck, heatmap_prefix))
    out.append("</body></html>")
    return "\n".join(out) + "\n"


def write(results, path, heatmap_root=None):
    """Write the dashboard to `path`; heatmap links are made relative from there to `heatmap_root` (default: the
    page's own directory, i.e. out/fidelity)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    prefix = ""
    if heatmap_root is not None:
        relative = os.path.relpath(Path(heatmap_root).resolve(), path.parent.resolve()).replace(os.sep, "/")
        prefix = "" if relative == "." else relative.rstrip("/") + "/"
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(render_html(results, prefix))


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m harness.fidelity.dashboard",
                                     description="Write the static fidelity dashboard for a results JSON.")
    parser.add_argument("results", type=Path)
    parser.add_argument("--out", type=Path, default=Path("out") / "fidelity" / "dashboard.html")
    parser.add_argument("--heatmaps", type=Path, default=Path("out") / "fidelity",
                        help="the directory the results' heatmap paths are relative to (default: out/fidelity)")
    args = parser.parse_args(argv)
    write(json.loads(args.results.read_text(encoding="utf-8")), args.out, heatmap_root=args.heatmaps)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
