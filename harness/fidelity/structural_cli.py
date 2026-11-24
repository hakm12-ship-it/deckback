"""S1-S6 of a converted deck, from the command line (M3 Task 11): every page of a PDF against the slide made from it.

    harness/.venv/Scripts/python -m harness.fidelity.structural_cli --pdf <pdf> --pptx <pptx> [--details]

Page n of the PDF is checked against slide n of the PPTX by structural.check (S1-S6, structural.py), as a fidelity
run checks it (``run.structural``): a page or slide whose facts cannot be read fails all six (M1-R54). The CI ratchet
on the committed corpus runs it (packages/core/test/corpus/pptx-ratchet.corpus.test.ts).

stdout: one JSON line per page of the PDF, in page order,

    {"slide": n, "S1": status, "S2": ..., "S6": status, "counts": {"S1": {...}, ..., "S6": {...}}}

``n`` 1-based, each status ``pass``, ``fail`` or ``n/a``, and each check's counts (``structural.COUNT_NAMES``: fixed
words and whole numbers). Nothing else: no detail, so nothing of the deck (no text, typeface or shape name), and the
command may run on a private deck (ruling M1-R75).

stderr: with ``--details``, a line ``slide <n> <check> <status>: <detail>`` for every check that does not pass. A
detail names the deck's typefaces and shapes, so ``--details`` is for public decks only (the committed corpus, where
the ratchet shows why a check got worse). Nothing here checks that: whoever passes ``--details`` must pass it for a
public deck only, as the corpus ratchet does (ledger L176). Without it, nothing of the deck goes to stderr either. MuPDF's own messages,
which may quote font names, are off meanwhile (``run.quiet_mupdf``).

Exit codes: 0 every page checked, whatever the statuses; 2 bad arguments; 3 the PDF cannot be read (its reason in
fixed words, no path).
"""

import argparse
import json
import sys

from harness.fidelity.errors import FactsError
from harness.fidelity.pdf_facts import pdf_page_count
from harness.fidelity.run import S_KEYS, quiet_mupdf, structural


def rows(pdf, pptx):
    """[(record, {check: detail of a check that does not pass})] for every page of `pdf` against its slide of `pptx`,
    the record as stdout prints it. FactsError when the PDF cannot be read."""
    out = []
    for index in range(pdf_page_count(pdf)):
        checks = structural(pdf, pptx, index)
        record = {"slide": index + 1, **{key: checks[key]["status"] for key in S_KEYS},
                  "counts": {key: checks[key].get("counts", {}) for key in S_KEYS}}
        details = {key: checks[key]["detail"] for key in S_KEYS if checks[key]["status"] != "pass"}
        out.append((record, details))
    return out


def main(argv=None):
    parser = argparse.ArgumentParser(prog="python -m harness.fidelity.structural_cli",
                                     description="S1-S6 of every page of a PDF against its slide of a PPTX: one JSON "
                                                 "line of statuses and counts per slide.")
    parser.add_argument("--pdf", required=True, help="the input PDF")
    parser.add_argument("--pptx", required=True, help="the PPTX converted from it")
    parser.add_argument("--details", action="store_true",
                        help="the details of every check that does not pass, on stderr (public decks only: they name "
                             "the deck's typefaces and shapes)")
    args = parser.parse_args(argv)
    with quiet_mupdf():
        try:
            measured = rows(args.pdf, args.pptx)
        except FactsError as exc:  # its message names no file
            print(f"structural_cli: input PDF: {exc}", file=sys.stderr)
            return 3
    for record, details in measured:
        print(json.dumps(record))
        if args.details:
            for key, detail in details.items():
                print(f"slide {record['slide']} {key} {record[key]}: {detail}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")
    sys.exit(main())
