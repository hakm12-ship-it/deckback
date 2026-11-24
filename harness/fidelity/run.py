"""`npm run fidelity`: run a converter over the test decks and measure every slide (spec section 5).

    harness/.venv/Scripts/python -m harness.fidelity.run --converter proto|deckback [--decks public,atlas,private,real]
        [--variants std,notags] [--out <json>] [--no-s7] [--limit-slides N] [--ids <id>,...] [--off-bar-structural] [--bar-only]

(``npm run fidelity -- --decks public,atlas,private`` passes options through.) The decks are those of decks.py
(default: ``public`` and ``atlas``; variants ``std,notags``). A private PDF that cannot be read is not a deck: it is
counted in ``summary.privateUnreadable`` and named nowhere (M1-R62). For every deck x variant, strictly one after
another (M1-R18: one PowerPoint job at a time):

0. A public PDF must be the export of the deck and manifest next to it, as its export stamp records
   (``<name>.export.json``, written by harness/atlas/export.py; M1-R77); otherwise it is a failed step
   (``exitCodes.input`` 3, reason ``stale-export``) with no slides: a deck rebuilt without a new export would be
   measured against the wrong ground truth and labels. Then read the input PDF's pages and their sizes: the size of
   every compared image is the size of MuPDF's render of that page at 2 px/pt (render_pdf.pixmap_sizes; M1-R61). An
   input PDF that cannot be read or is encrypted is a failed step (``exitCodes.input`` 3, reason ``unreadable`` /
   ``encrypted``) with no slides (M1-R62).
1. Convert the input PDF in a child process (``<converter argv> <pdf> -o <pptx>``: python -m harness.baseline.proto,
   or node packages/cli/dist/deckback.mjs; a bundle not built is a failed step, reason ``converter-missing``) with a
   300 s limit. A converter that overruns is left running, never stopped (nothing in the harness ends a process; the
   child writes only into a directory of its own), and recorded as exit code 2; any other failure is 3. The run goes
   on. The child's stdout (its counts) is read through a pipe and never written to disk.
2. Render the output with harness/ppt/render.ps1 (truecolour ``slide<N>.png``), asking for exactly the MuPDF size of
   the first page (``-Width``/``-Height``; a PPTX has one slide size, so a page of another size is a size mismatch).
   render.ps1 drives PowerPoint only through DeckbackCom.psm1 and ends itself with [Environment]::Exit when a
   PowerPoint call is stuck (M1-R19). Its exit code 2 (a repair prompt or another dialog: timeout) or 3 is recorded
   for the deck and the run goes on; a render.ps1 that outlives its own limits by far is left running and recorded
   as 2 (``left-running``); its exit code 5 (PowerPoint refused the calls because it was busy, as while a dialog is
   open in it) is recorded as 3 with the reason ``powerpoint-busy``, not as a fault of the deck (M1-R74).
   After the first PowerPoint step of the run that times out (render, ground truth or S7: exit 2), PowerPoint may still
   be held by a dialog, so every later PowerPoint step of the run is not attempted (ruling M1-R74): a render or ground
   truth gets exit code null and the reason ``skipped-after-stuck``, S7 is n/a with that reason; the other measurements
   (S1-S6, MuPDF) still run, a progress line says what happened and points to the manual cleanup, and
   ``summary.powerpoint`` records where it timed out and how many steps were skipped or refused as busy.
3. Ground truth: when the deck has a source PPTX, it is rendered once by the same script at the same size into
   ``out/fidelity/gt/<id>/<width>x<height>/`` (one directory per size, like the cache key: M1-R72), cached across runs
   by the PPTX's sha256, the size and the renderer (render.ps1, its slide action and the PowerPoint version; a cached
   one is used even after a PowerPoint timeout, since it needs no PowerPoint), with
   ``map.json`` from the deck file in the form harness/atlas/export.ps1 writes (``stdPage``: slide number -> page of
   the std PDF, null for a hidden slide). Each variant pairs pages with slides in its own frame (M1-R72,
   ``variant_slides``): the hidden variant's page p is slide p (hidden slides included), every other variant's page p
   is the p-th visible slide (M1-R54); the manifest's labels and known classes follow the same map. A ground truth
   whose slides do not match the PDF's page count that way is not paired at all. A variant whose pages are not the
   source slide's frame (msprint prints onto A4 paper; any page whose MuPDF size differs from the slide's by more
   than a pixel) gets no ground truth: V1 and the noise floor are null, ``reasons.groundTruth`` is
   ``page-frame-differs``.
4. MuPDF renders each input page (render_pdf.render, 2 px/pt).
5. Before any metric every image must have the page's MuPDF size (1920 x 1080 for a 16:9 page; 840 x 1191 for A5,
   where round(2 x 419.53 pt) would say 839); otherwise that gate is an error record (``{"pass": false,
   "error": ...}``) and the slide fails; nothing is resized (M1-R54, M1-R61). Then the noise floor ``noise`` =
   metrics.v2(mupdf, gt), the same metrics and direction as the gate, recorded, never gated itself (M1-R33/R57),
   V2 = metrics.v2(mupdf, out, noise) and V1 = metrics.v1(gt, out, lines) (argument order of M1-R36), `lines` the
   page's text lines from the input PDF (pdf_facts.text_line_boxes at 2 px/pt; none when the PDF's text cannot be
   read): V1's status is judged per line, each line free to move 1 px (ruling M4-R11), and the raw residual stays
   recorded beside it (``residual3``, ``passRaw``). V2's limits are the
   author's (ruling M3-R51): the noise floor's numbers plus 50 px and 0.6 % on a slide with a ground truth, else 400 px
   and 1 %; the record says which (``limits``). The noise record's own ``pass`` is under the latter.
6. S1-S6 = structural.check(page_facts, slide_facts); a FactsError fails all six with "facts: <side>: <reason>"
   (M1-R54). S7 = roundtrip.s7 once per deck x variant (n/a with --no-s7, and n/a when PowerPoint was busy or had
   timed out earlier in the run); every slide carries the deck's S7.
7. For each slide whose V1 or V2 fails, a heatmap of the gate's own pair (metrics.heatmap(gt, out) for V1,
   metrics.heatmap(out, mupdf) for V2: the fixed image first) in ``out/fidelity/<id>/<variant>/v1|v2-slide<N>.png``.

A slide passes only when V2 passes, V1 passes or is null (no source PPTX, or a page frame other than the slide's:
spec 5.1 runs V1 only with the original), and every one of S1-S7 is "pass": a check that is "n/a" (one the converter
or the input cannot support) is never counted as a pass (global constraints), so with --no-s7 no slide passes; a
check satisfied because there is nothing to compare passes (M1-R70). Known-unrecoverable classes (spec 5.2; M1-R56)
are recorded per slide in ``known`` from the deck manifest, and never excuse a failure: ``bitmapText``
(knownBitmapText), ``textAsOutlines`` (``textbox:rot:N`` / ``bodyPr:rot:N`` with N not a multiple of 90,
``txBody:rotated-with-shape``, ``grpSp:rot-text``, ``text:outline-only``, ``text:noFill``, ``text:gradFill``, a
``prstTxWarp:`` other than textNoShape and textPlain: OUTLINED_TEXT, PLAIN_WARPS), ``bitmapEffect`` (soft edges,
bevels, 3-D rotation, camera, extrusion, reflection: ``effect:softEdge|bevel|3dRotation|reflection:*``, ``bevel:*``,
``camera:*``, ``sp3d:*``), ``colourEmoji`` (an ``emoji`` feature); and by slide id, the classes measured slide by
slide (harness/atlas/known.py): ``lossyPictureExport`` (M5-R13: PowerPoint's export re-encodes the pictures lossily).

Three options narrow a run (M8):

* ``--ids <id>,...`` measures only the decks with those ids (of the sets asked for), as a fix round re-measures the
  decks a change touches. Asked-for ids that are not found are an error (exit 3).
* ``--off-bar-structural`` (ruling M8-R1): a ``real`` deck off the bar (its origin is not powerpoint-windows) is
  converted and checked with S1-S6 only. Its output is not rendered by PowerPoint, nor its source PPTX, its pages are
  not rendered by MuPDF and S7 is not run: render and ground truth are exit code null with the reason ``off-bar``,
  V1 and the noise floor are null, V2 is an error record (``OFF_BAR_V2``, counted n/a in ``summary.byGate``) and S7
  is n/a. A crash, a time-out or a failed conversion, whole-slide pictures (S1) and S1-S6 are still recorded.

* ``--bar-only`` (M8 round 1c): the ``real`` decks off the bar are left out of the run altogether (``options.barOnly``),
  where ``--off-bar-structural`` still converts them with S1-S6. The other sets are unchanged. A round whose off-bar
  decks were checked for crash and repair in an earlier one (r0) uses it, so the bar decks are measured in full alone.

Outputs: the results JSON (``--out``, default ``out/fidelity/results.json``; schema results.schema.json, ``$id``
``deckback.fidelity/1``), ``out/fidelity/dashboard.html`` (dashboard.py), the renders, heatmaps and outputs under
``out/fidelity/<id>/<variant>/`` (so the metrics can be recomputed without PowerPoint), and ``out/fidelity/run.log``.
The summary reports the mean raw_px32 and px32_shift1 of V1 and V2 per deck x variant and over the run
(``summary.averages``; spec 5: averages are reported, never gated).

Privacy (global constraints, M1-R55, M1-R58, M1-R62, M1-R75): results, dashboard, stdout and stderr carry public deck
names and private ids (sha256[:12]) only. No raw message, stderr or exception text of the converter, render.ps1,
export.ps1 or Python reaches them for any deck: only exit codes, fixed reason tokens, exception type names and the
FactsError / S1-S7 details, which name no file by contract; every detail is capped at 300 characters. A private
deck's S1-S7 details are a fixed template, its status and the check's counts only (``private_detail``: "fail;
typefaces 2; mismatches 5; details withheld (private deck)"), since the full details name fonts, typefaces and shapes
taken from the private PDF or carried over into the converter's output (M1-R75). MuPDF's own error and warning
messages, which quote font names of a damaged input, are off for the whole run (``quiet_mupdf``, as in the census).
The run log keeps the tools' raw text for public decks only; for a private deck it has the id and exit codes. Nothing
of a private deck's conversion is kept on disk when it fails (its work directory is removed unless the converter is
still running).

Exit code: 0 every deck was read, converted and rendered (and its ground truth), and every private PDF could be read;
1 the run completed but some step failed (the results say which: ``summary.exitCodes``, ``summary.privateUnreadable``,
``summary.powerpoint``: PowerPoint steps skipped after a timeout or refused as busy),
also when every PDF asked for was an unreadable private one (the results, with no decks, are written all the same, so
an earlier run's results never stay in place looking current); 3 bad options, no decks at all, deck directories that
cannot be listed, or results that do not match the schema (still written); argparse errors 2.
"""

import argparse
import contextlib
import functools
import hashlib
import json
import os
import platform
import posixpath
import re
import shutil
import subprocess
import sys
import time
import zipfile
from dataclasses import dataclass
from datetime import date
from pathlib import Path
from typing import Callable

import numpy as np
from lxml import etree

from harness.atlas.known import measured_classes
from harness.fidelity import decks as deck_list
from harness.fidelity import metrics
from harness.fidelity.errors import FactsError
from harness.fidelity.schema_check import validate
from harness.ppt import limits

REPO = Path(__file__).resolve().parents[2]
SCHEMA_PATH = Path(__file__).with_name("results.schema.json")
SCHEMA_ID = "deckback.fidelity/1"
RENDER_PS1 = REPO / "harness" / "ppt" / "render.ps1"
CLI_BUNDLE = REPO / "packages" / "cli" / "dist" / "deckback.mjs"  # `npm run build:cli`
# --converter name -> its argv prefix; the run appends `<pdf> -o <pptx>`
CONVERTERS = {
    "proto": lambda: [sys.executable, "-m", "harness.baseline.proto"],
    "deckback": lambda: ["node", str(CLI_BUNDLE)],
}
# The file a converter needs to exist before it can run (a converter not built is "converter-missing", not a crash).
CONVERTER_FILES = {"deckback": CLI_BUNDLE}
CONVERTER_MISSING = "converter-missing"
CONVERT_TIMEOUT = 300  # s per deck
PX_PER_PT = 2
DETAIL_MAX = 300
DIGITS = 8  # fractions rounded to 1e-8 (one pixel of 1920 x 1080 is 4.8e-7)
S_KEYS = ("S1", "S2", "S3", "S4", "S5", "S6")
GATES = ("V1", "V2") + S_KEYS + ("S7",)
# The counts a converter's last JSON line may carry: proto's four and the deckback CLI's others (the report's counts).
STATS = ("pages", "shapes", "textBoxes", "pictures", "freeforms", "rects", "lines", "gradients", "hotspots", "fallbacks")
OK, TIMEOUT, ERROR = 0, 2, 3
LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9/._-]{0,80}$")
# A private deck's S1-S7 detail (ruling M1-R75): its status, the check's counts (structural.COUNT_NAMES) and this
# fixed tail, nothing taken from the deck or the converter's output.
PRIVATE_WITHHELD = "details withheld (private deck)"
PRIVATE_DETAIL = re.compile(r"^(pass|fail|n/a)((?:; [a-z][a-z ]{0,40} [0-9]{1,9})*); details withheld \(private deck\)$")
ROTATED_TEXT = re.compile(r"^(?:textbox|bodyPr):rot:(-?[0-9]+(?:\.[0-9]+)?)$")
# Manifest features under which PowerPoint's PDF export draws the text as vector outlines, the characters left out
# of the text layer or kept as invisible text (m2, m9; calibrated against the atlas export's visible text layer):
# text in a rotated shape or a rotated group, outline-only, unfilled and gradient-filled text. A WordArt warp does
# the same unless it is no warp at all (textNoShape, textPlain).
OUTLINED_TEXT = frozenset({"txBody:rotated-with-shape", "grpSp:rot-text", "text:outline-only", "text:noFill",
                           "text:gradFill"})
PLAIN_WARPS = frozenset({"prstTxWarp:textNoShape", "prstTxWarp:textPlain"})
BITMAP_EFFECTS = ("effect:softEdge:", "effect:bevel:", "effect:3dRotation:", "effect:reflection:", "bevel:", "camera:",
                  "sp3d:")
NS_P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
NS_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
# Deck XML is parsed without entity expansion, DTD loading or network access.
XML_PARSER = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False)

# Child processes left running after their limit. They are never stopped; the list keeps them referenced so that
# Python does not warn about them, and tests can wait for them to end on their own.
ABANDONED = []

# Ruling M1-R74: the reason of a PowerPoint step not attempted because an earlier PowerPoint step of the run timed out,
# and of one PowerPoint refused because it was busy (render.ps1 exit code 5; export.ps1's reason).
SKIPPED_AFTER_STUCK = "skipped-after-stuck"
POWERPOINT_BUSY = "powerpoint-busy"
RENDER_BUSY_EXIT = 5
MANUAL_CLEANUP = "harness/README.md, 'After a timed-out run (exit code 2): manual cleanup'"
# Ruling M8-R1 (--off-bar-structural): the reason of the PowerPoint steps not run for a real deck off the bar, and its
# slides' V2 record; summarise counts that record n/a.
OFF_BAR = "off-bar"
MUPDF_SUBSTITUTION = "mupdf-substitution"  # M8-R3: the page uses a font the PDF does not embed; MuPDF draws a substitute
MISSING_FONT = "missing-font"  # spec 5.5: a commercial font the measuring PC cannot have (harness/fidelity/triage.py)
FONT_VERSION = "font-version"  # M8-R9: this PC has a font the PDF embeds in another version (harness/fonts/fontversion.py)
FONT_EXCEPTIONS = (MUPDF_SUBSTITUTION, MISSING_FONT, FONT_VERSION)
OFF_BAR_V2 = {"pass": False, "error": "not measured: off the bar (M8-R1: S1-S6 only for a real deck whose origin is "
                                      "not powerpoint-windows)"}


@dataclass
class StepResult:
    code: int  # OK, TIMEOUT or ERROR
    reason: str  # a fixed token: "ok", "timeout", "error", "no-output", "left-running", ...
    log: str = ""  # the tool's raw text: the run log only, for public decks only
    stats: dict = None  # the converter's counts


@dataclass
class Tools:
    convert: Callable  # (pdf, out_pptx, keep_log=True) -> StepResult
    render: Callable  # (pptx, out_dir, keep_log=True, size=(width, height) px) -> StepResult; slide<N>.png
    render_pdf: Callable  # (pdf, index) -> uint8 H x W x 3 at 2 px/pt
    s7: Callable  # (out_pptx, in_pdf) -> {"status", "detail"}


def cap(text):
    text = str(text)
    return text if len(text) <= DETAIL_MAX else text[: DETAIL_MAX - 3] + "..."


def _read_text(path):
    try:
        return Path(path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def _last_json(text):
    for line in reversed(text.splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if isinstance(value, dict):
                return value
    return None


def file_sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---- tools ----------------------------------------------------------------------------------------------------------


class SubprocessConverter:
    """Runs ``argv + [pdf, "-o", pptx]`` in the repo root with a time limit (default 300 s).

    The child writes into ``<deck dir>/convert/`` (its output and, for public decks, its stderr); only a finished
    conversion's output is moved to ``out_pptx``, so a child left running after its limit can never change what was
    measured. Its stdout is read through a pipe, never written to disk (it may quote the input's path); its last JSON
    line gives the counts (``STATS``: ``pages``, ``shapes``, ``textBoxes``, ``pictures`` and the deckback CLI's
    others). For a private deck (``keep_log`` false) stderr goes nowhere, and a failed conversion's work directory is
    removed, unless the child is still running and may write into it."""

    def __init__(self, argv, timeout_sec=CONVERT_TIMEOUT, required=None):
        self.argv = [str(a) for a in argv]
        self.timeout_sec = timeout_sec
        self.required = Path(required) if required is not None else None  # a file the converter cannot run without

    def __call__(self, pdf, out_pptx, keep_log=True):
        if self.required is not None and not self.required.is_file():
            return StepResult(ERROR, CONVERTER_MISSING, log="the converter is not built (npm run build:cli)")
        out_pptx = Path(out_pptx)
        work = out_pptx.parent / "convert"
        shutil.rmtree(work, ignore_errors=True)
        work.mkdir(parents=True, exist_ok=True)
        target = work / out_pptx.name
        stderr_path = work / "stderr.txt"
        with open(stderr_path if keep_log else os.devnull, "wb") as stderr:
            process = subprocess.Popen([*self.argv, str(pdf), "-o", str(target)], cwd=REPO,
                                       stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=stderr)
        try:
            stdout, _ = process.communicate(timeout=self.timeout_sec)
        except subprocess.TimeoutExpired:
            ABANDONED.append(process)
            return StepResult(TIMEOUT, "timeout", log=f"the converter (process {process.pid}) did not finish within "
                                                      f"{self.timeout_sec} s; it was left running")
        code = process.returncode
        log = _read_text(stderr_path) if keep_log else ""
        if code != 0 or not target.is_file():
            if not keep_log:
                shutil.rmtree(work, ignore_errors=True)
            if code != 0:
                return StepResult(ERROR, "error", log=f"{log}\n(converter exit code {code})")
            return StepResult(ERROR, "no-output", log=log)
        os.replace(target, out_pptx)
        counts = _last_json((stdout or b"").decode("utf-8", errors="replace")) or {}
        stats = {key: counts[key] for key in STATS
                 if isinstance(counts.get(key), int) and not isinstance(counts.get(key), bool) and counts[key] >= 0}
        shutil.rmtree(work, ignore_errors=True)
        return StepResult(OK, "ok", log=log, stats=stats)


class PowerPointRenderer:
    """harness/ppt/render.ps1 in a child process: ``slide<N>.png`` (8-bit RGB) of every slide at ``size`` = (width,
    height) px, the MuPDF size of the input's page (M1-R61); without a size, 2 px/pt of the slide size as
    slide_png_action.ps1 rounds it (``-Width 0 -Height 0``).

    Popen, not run(): run() would end the script when the limit passes, and a script ended in the middle cannot close
    the presentation or quit the PowerPoint it started (as harness/atlas/export.py). The limit is generous: the
    script may wait for another deckback run's lock and then use its own limit (120 s + 4 s per slide), each in full."""

    def __call__(self, pptx, out_dir, keep_log=True, size=None):
        from harness.atlas.export import slide_count

        width, height = size if size is not None else (0, 0)
        per_run = limits.module_time_limit(slide_count(pptx))  # render.ps1's own default limit
        limit = 2 * per_run + 90
        command = ["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(RENDER_PS1),
                   "-Pptx", str(pptx), "-OutDir", str(out_dir), "-Width", str(int(width)), "-Height", str(int(height))]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                                   text=True, errors="replace")
        try:
            _, stderr = process.communicate(timeout=limit)
        except subprocess.TimeoutExpired:
            ABANDONED.append(process)
            return StepResult(TIMEOUT, "left-running", log=f"render.ps1 (process {process.pid}) did not finish "
                                                           f"within {limit} s; it was left running")
        log = (stderr or "") if keep_log else ""
        if process.returncode == 0:
            return StepResult(OK, "ok", log=log)
        if process.returncode == 2:
            return StepResult(TIMEOUT, "timeout", log=log)
        if process.returncode == RENDER_BUSY_EXIT:  # PowerPoint refused the calls (busy): not the deck's fault
            return StepResult(ERROR, POWERPOINT_BUSY, log=log)
        return StepResult(ERROR, "error", log=f"{log}\n(render.ps1 exit code {process.returncode})")


class PowerPointState:
    """The run's PowerPoint (ruling M1-R74). After the first PowerPoint step that times out (exit 2: a repair prompt or
    another dialog may still hold PowerPoint), every later PowerPoint step of the run (render, ground truth, S7) is not
    attempted: it is recorded as skipped-after-stuck, counted here, and the run's exit code is 1. Steps PowerPoint
    refused as busy are counted too. ``summary()`` is ``summary.powerpoint`` of the results."""

    def __init__(self, log=None):
        self.log = log
        self.stuck_at = None  # {"id", "variant", "step"} of the step that timed out first
        self.skipped = 0
        self.busy = 0

    def skip(self):
        """True (and counted) when a PowerPoint step must not be attempted now."""
        if self.stuck_at is None:
            return False
        self.skipped += 1
        return True

    def because(self):
        at = self.stuck_at
        return f"PowerPoint timed out earlier in this run ({at['id']} {at['variant']}, {at['step']}); not attempted"

    def after(self, deck, step, code, reason):
        """Record the outcome of a PowerPoint step of `deck` (step: render, groundTruth or S7)."""
        if reason == POWERPOINT_BUSY:
            self.busy += 1
        if code == TIMEOUT and self.stuck_at is None:
            self.stuck_at = {"id": deck.id, "variant": deck.variant, "step": step}
            if self.log is not None:
                self.log.progress(f"PowerPoint timed out ({deck.id} {deck.variant}, {step}). A dialog may still hold it, "
                                  f"so every later PowerPoint step of this run (render, ground truth, S7) is skipped and "
                                  f"recorded as {SKIPPED_AFTER_STUCK}; the other measurements go on. Nothing was "
                                  f"stopped or killed: see {MANUAL_CLEANUP}, then run again.")

    def summary(self):
        return {"stuckAt": dict(self.stuck_at) if self.stuck_at else None, "skippedAfterStuck": self.skipped,
                "busy": self.busy}


def converter_argv(converter):
    return CONVERTERS[converter]()


def default_tools(converter):
    from harness.fidelity import render_pdf, roundtrip

    return Tools(convert=SubprocessConverter(converter_argv(converter), required=CONVERTER_FILES.get(converter)),
                 render=PowerPointRenderer(), render_pdf=render_pdf.render, s7=roundtrip.s7)


def _safe(tool, *args, **kwargs):
    """A tool call that never raises: an exception is an ERROR with its type name only."""
    try:
        return tool(*args, **kwargs)
    except Exception as exc:
        return StepResult(ERROR, "internal-error", log=f"{type(exc).__name__}")


# ---- run log and progress -----------------------------------------------------------------------------------------


class RunLog:
    """Progress lines go to stderr and the run log; a tool's raw text goes to the run log for public decks only."""

    def __init__(self, path):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(path, "w", encoding="utf-8")

    def write(self, text):
        self.handle.write(text.rstrip() + "\n")
        self.handle.flush()

    def progress(self, text):
        print(f"fidelity: {text}", file=sys.stderr, flush=True)
        self.write(text)

    def tool(self, deck, step, result):
        if deck.public and result.log and result.log.strip():
            self.write(f"--- {deck.id} {deck.variant} {step} (exit {result.code}, {result.reason}):\n{result.log}")

    def close(self):
        self.handle.close()


# ---- ground truth ---------------------------------------------------------------------------------------------------


@dataclass
class GroundTruth:
    code: int
    reason: str
    directory: Path
    slides: int = 0
    hidden: list = None  # one bool per slide of the source deck, True for a hidden one


# Export variants whose PDF has a page for every slide, hidden ones included (export.ps1's hidden variant); every
# other variant has the visible slides only (M1-R72).
SHOWS_HIDDEN = frozenset({"hidden"})
# Variants printed onto a paper page rather than exported in the slide's own frame (Microsoft Print to PDF, A4):
# their pages are not the source slide's frame, so V1 and the noise floor are not computed (M1-R72).
PAPER_VARIANTS = frozenset({"msprint"})
PAGE_FRAME_DIFFERS = "page-frame-differs"


def variant_slides(variant, hidden):
    """The 1-based slide numbers of the source deck in the page order of the variant's PDF (M1-R72): every slide for
    the hidden variant, the visible ones for every other variant (std, min, notags, pdfa, msprint)."""
    return [number for number, is_hidden in enumerate(hidden, start=1) if variant in SHOWS_HIDDEN or not is_hidden]


def slide_size_pt(pptx):
    """(width, height) in pt of the deck's p:sldSz, None if the deck has none."""
    with zipfile.ZipFile(pptx) as package:
        presentation = etree.fromstring(package.read("ppt/presentation.xml"), XML_PARSER)
    size = presentation.find(f"{NS_P}sldSz")
    if size is None:
        return None
    return int(size.get("cx")) / 12700, int(size.get("cy")) / 12700


def page_frame_differs(deck, size_px):
    """True when the variant's pages are not the source slide's frame (M1-R72): a paper variant (msprint), or a first
    page whose MuPDF size at 2 px/pt differs by more than a pixel from the source slide's size."""
    if deck.variant in PAPER_VARIANTS:
        return True
    try:
        slide = slide_size_pt(deck.source_pptx)
    except Exception:  # an unreadable source deck: the ground-truth step reports it
        return False
    return slide is not None and any(abs(PX_PER_PT * pt - px) > 1 for pt, px in zip(slide, size_px))


def slide_hidden_flags(pptx):
    """One bool per slide of the deck file in presentation order, True for a hidden slide (show="0"/"false" on
    p:sld): harness/atlas/export.ps1's Get-PptxSlideHidden, read from the zip."""
    with zipfile.ZipFile(pptx) as package:
        presentation = etree.fromstring(package.read("ppt/presentation.xml"), XML_PARSER)
        rels = etree.fromstring(package.read("ppt/_rels/presentation.xml.rels"), XML_PARSER)
        targets = {rel.get("Id"): rel.get("Target") for rel in rels}
        flags = []
        id_list = presentation.find(f"{NS_P}sldIdLst")
        for slide_id in (id_list if id_list is not None else []):
            target = targets[slide_id.get(f"{NS_R}id")]
            part = target.lstrip("/") if target.startswith("/") else posixpath.normpath(f"ppt/{target}")
            flags.append(etree.fromstring(package.read(part), XML_PARSER).get("show") in ("0", "false"))
    return flags


def slide_map(flags):
    """export.ps1's gt map.json: {"slides", "stdPages", "stdPage": {"<slide>": page or None}}."""
    page, std = 0, {}
    for number, hidden in enumerate(flags, start=1):
        if hidden:
            std[str(number)] = None
        else:
            page += 1
            std[str(number)] = page
    return {"slides": len(flags), "stdPages": page, "stdPage": std}


@functools.lru_cache(maxsize=1)
def renderer_key():
    """What a ground-truth render depends on besides the deck: the render scripts' bytes and PowerPoint's version."""
    digest = hashlib.sha256()
    for script in (RENDER_PS1, RENDER_PS1.with_name("slide_png_action.ps1")):
        try:
            digest.update(script.read_bytes())
        except OSError:
            digest.update(b"missing")
    digest.update(str(powerpoint_version()).encode())
    return digest.hexdigest()[:16]


def _cached(directory, digest, mapping, size):
    try:
        stamp = json.loads((directory / "source.json").read_text(encoding="utf-8"))
        same_map = json.loads((directory / "map.json").read_text(encoding="utf-8")) == mapping
    except (OSError, ValueError):
        return False
    return (stamp.get("sha256") == digest and stamp.get("renderer") == renderer_key() and same_map
            and stamp.get("size") == (list(size) if size is not None else None)
            and all((directory / f"slide{n}.png").is_file() for n in range(1, mapping["slides"] + 1)))


def ground_truth(deck, tools, out_root, memo, log, size=None, ppt=None):
    """The PowerPoint render of the deck's source PPTX at `size` (width, height) px (None without a source PPTX);
    rendered once per run and size, and cached across runs. With `ppt` (PowerPointState) a render is not attempted
    once PowerPoint has timed out in the run (code None, reason skipped-after-stuck; a cached one is still used)."""
    if deck.source_pptx is None:
        return None
    key = (deck.id, size)
    if key in memo:
        return memo[key]
    # one directory per deck and size, like the memo's key (M1-R72): a render at another size never replaces it
    directory = Path(out_root) / "gt" / deck.id / (f"{size[0]}x{size[1]}" if size is not None else "default")
    try:
        digest = file_sha256(deck.source_pptx)
        mapping = slide_map(slide_hidden_flags(deck.source_pptx))
    except Exception as exc:
        log.tool(deck, "ground truth", StepResult(ERROR, "unreadable-source", log=type(exc).__name__))
        memo[key] = GroundTruth(ERROR, "unreadable-source", directory)
        return memo[key]
    hidden = [mapping["stdPage"][str(number)] is None for number in range(1, mapping["slides"] + 1)]
    if _cached(directory, digest, mapping, size):
        step = StepResult(OK, "cached")  # no PowerPoint needed
    elif ppt is not None and ppt.skip():  # not remembered: a later deck x variant is counted as skipped as well
        return GroundTruth(None, SKIPPED_AFTER_STUCK, directory, mapping["slides"], hidden)
    else:
        shutil.rmtree(directory, ignore_errors=True)
        directory.mkdir(parents=True, exist_ok=True)
        step = _safe(tools.render, deck.source_pptx, directory, keep_log=deck.public, size=size)
        log.tool(deck, "ground truth", step)
        if ppt is not None:
            ppt.after(deck, "groundTruth", step.code, step.reason)
        if step.code == OK:
            if all((directory / f"slide{n}.png").is_file() for n in range(1, mapping["slides"] + 1)):
                (directory / "map.json").write_text(json.dumps(mapping, separators=(",", ":")) + "\n",
                                                     encoding="utf-8")
                stamp = {"sha256": digest, "renderer": renderer_key(), "slides": mapping["slides"],
                         "size": list(size) if size is not None else None}
                (directory / "source.json").write_text(json.dumps(stamp) + "\n", encoding="utf-8")
                step = StepResult(OK, "rendered")
            else:
                step = StepResult(ERROR, "no-output")
    memo[key] = GroundTruth(step.code, step.reason, directory, mapping["slides"], hidden)
    return memo[key]


# ---- one slide ------------------------------------------------------------------------------------------------------


def _png(path, what):
    """(image, None) or (None, error) for a render PNG; the error names no path."""
    if not path.is_file():
        return None, f"no {what} PNG"
    try:
        return metrics.load_png(path), None
    except Exception as exc:  # load_png's message quotes the path
        return None, f"the {what} PNG is not an 8-bit truecolour PNG ({type(exc).__name__})"


def visual(gate, first, second, expected):
    """A V1/V2 record from two (image, error, description) triples; size-checked first against `expected` = (rows,
    columns), the MuPDF size of the page (M1-R54, M1-R61)."""
    for image, error, what in (first, second):
        if image is None:
            return {"pass": False, "error": cap(error)}
        if image.shape[:2] != expected:
            return {"pass": False, "error": cap(
                f"size mismatch: the {what} is {image.shape[1]} x {image.shape[0]} px; the page needs "
                f"{expected[1]} x {expected[0]} px (its MuPDF render at 2 px/pt); images are never resized")}
    try:
        values = gate(first[0], second[0])
    except Exception as exc:
        return {"pass": False, "error": f"the metric could not be computed ({type(exc).__name__})"}
    return {key: _rounded(value) for key, value in values.items()}


def _rounded(value):
    """A record's value as the results keep it: a float rounded to DIGITS, also inside ``outside`` (ruling M8-R12)."""
    if isinstance(value, float):
        return round(value, DIGITS)
    if isinstance(value, dict):
        return {key: _rounded(inner) for key, inner in value.items()}
    return value


def _all_fail(detail):
    return {key: {"status": "fail", "detail": cap(detail)} for key in S_KEYS}


def private_detail(status, counts=None):
    """The detail of a private deck's S check (M1-R75): its status and counts only, e.g. "fail; typefaces 2;
    mismatches 5; details withheld (private deck)". No font, shape, text or typeface name of the private PDF or of the
    converter's output, which may carry them over."""
    return "; ".join([status, *(f"{name} {int(value)}" for name, value in (counts or {}).items())] + [PRIVATE_WITHHELD])


def gates_for(deck, checks):
    """S1-S7 records for the results: {"status", "detail"}; a private deck's detail is private_detail (M1-R75)."""
    if deck.public:
        return {key: {"status": value["status"], "detail": cap(value["detail"])} for key, value in checks.items()}
    return {key: {"status": value["status"], "detail": private_detail(value["status"], value.get("counts"))}
            for key, value in checks.items()}


def structural(pdf, pptx, index):
    """S1-S6 of page `index`; a facts error fails all six (M1-R54)."""
    from harness.fidelity.pdf_facts import page_facts
    from harness.fidelity.pptx_facts import slide_facts
    from harness.fidelity.structural import check

    try:
        slide = slide_facts(pptx, index)
    except FactsError as exc:  # its message names no file
        return _all_fail(f"facts: output PPTX: {exc}")
    except Exception as exc:
        return _all_fail(f"facts: output PPTX: internal error ({type(exc).__name__})")
    try:
        page = page_facts(pdf, index)
    except FactsError as exc:
        return _all_fail(f"facts: input PDF: {exc}")
    except Exception as exc:
        return _all_fail(f"facts: input PDF: internal error ({type(exc).__name__})")
    results = check(page, slide)
    return {key: {"status": results[key]["status"], "detail": cap(results[key]["detail"]),
                  **({"counts": results[key]["counts"]} if "counts" in results[key] else {})} for key in S_KEYS}


POSITIONS = "positions"  # passReason of ruling M8-R12
ALONG_TOL_PT = 0.25  # M8-R12: every glyph of every line within this along the line of the input PDF's glyph origin ...
ACROSS_TOL_PT = 0.1  # ... and within this across it, in PowerPoint's round-trip export of our PPTX (S7's export)
TOL_EPS = 1e-9


def _outside_passes(record, key):
    """Whether the V1/V2 record's measures over the pixels outside the text lines (``outside``) are within the gate's
    limits; false without them (a record from before M8-R12, or a page without text lines) or for an error record."""
    outside = None if record is None else record.get("outside")
    return bool(outside) and outside.get("pass") is True and key in outside


def positions_verified(slide, exception=None):
    """Ruling M8-R12 (the author's direction, 2026-11-23): a slide whose only failing gates are V1 and/or V2 (as its
    font exception reads them) passes as position-verified when

    * every one of S1-S7 passes;
    * in PowerPoint's round-trip export of our PPTX (S7's, stored per slide as ``positions``) every glyph of every text
      line is within ALONG_TOL_PT along the line and ACROSS_TOL_PT across it of the input PDF's glyph origin, and no
      glyph is outside every line;
    * the failing gate's own measures, restricted to the pixels outside the text-line boxes (``outside``), pass its
      limits. A V1 judged by V2 (noise-exempt) is read through V2's.

    A slide that passes on its gates is not position-verified (it needs no rule)."""
    if not all(slide["s"][key]["status"] == "pass" for key in S_KEYS + ("S7",)):
        return False
    v1, v2 = slide.get("v1"), slide["v2"]
    if "error" in v2 or (v1 is not None and "error" in v1):
        return False  # a gate that could not be computed is not a text matter
    v1_fails = exception not in (FONT_VERSION, MISSING_FONT) and v1 is not None and not v1["pass"]
    v2_fails = exception not in (MUPDF_SUBSTITUTION, MISSING_FONT) and not v2["pass"]
    if not (v1_fails or v2_fails):
        return False
    v1_by_v2 = v1_fails and bool(v1.get("noiseExempt"))  # V1 is V2's verdict there
    if (v2_fails or v1_by_v2) and not _outside_passes(v2, "residual5"):
        return False
    if v1_fails and not v1_by_v2 and not _outside_passes(v1, "residual3"):
        return False
    positions = slide.get("positions")
    if not positions or positions.get("unassigned") or not any(positions.get("lines") or []):
        return False
    return all(line is None or (line[0] <= ALONG_TOL_PT + TOL_EPS and line[1] <= ACROSS_TOL_PT + TOL_EPS)
               for line in positions["lines"])


def verdict(slide, exception=None):
    """(passed, passReason): True with None when the slide passes on its gates (``slide_passes``' reading before M8-R12),
    True with POSITIONS when it passes as position-verified (``positions_verified``), else False with None."""
    if _gates_pass(slide, exception):
        return True, None
    if positions_verified(slide, exception):
        return True, POSITIONS
    return False, None


def judge(slide, exception=None):
    """Sets the slide's ``pass`` and ``passReason`` (absent unless POSITIONS) from ``verdict``; returns the slide."""
    slide["pass"], reason = verdict(slide, exception)
    if reason:
        slide["passReason"] = reason
    else:
        slide.pop("passReason", None)
    return slide


def slide_passes(slide, exception=None):
    """Whether a slide passes: ``verdict``'s first value (the gates, or M8-R12's position-verified rule)."""
    return verdict(slide, exception)[0]


def _gates_pass(slide, exception=None):
    """Whether a slide passes (a bool; spec 5.1, 5.2, 5.5): V2 passes, V1 passes or is null, and every one of S1-S7 is
    "pass". A slide with a font exception (``fontException``) is judged without what the font spoils: M8-R3
    (MUPDF_SUBSTITUTION: MuPDF's reference render of the PDF has a substitute font) leaves out V2, so V1 (where a pair
    exists) and S1-S7 judge it; spec 5.5 (MISSING_FONT: the PowerPoint render lacks the font) leaves out V1 and V2, so
    S1-S7 alone judge it. M8-R9 (FONT_VERSION: the PC's copy of an embedded font is another version, so the source deck
    re-laid on this PC is not the PDF's layout) leaves out V1 the same way, so V2 and S1-S7 judge it."""
    s_ok = all(slide["s"][key]["status"] == "pass" for key in S_KEYS + ("S7",))
    if exception == MISSING_FONT:
        return s_ok
    v1_ok = exception == FONT_VERSION or slide["v1"] is None or bool(slide["v1"]["pass"])
    v2_ok = exception == MUPDF_SUBSTITUTION or bool(slide["v2"]["pass"])
    return bool(v2_ok and v1_ok and s_ok)


def font_exception(deck, index):
    """The slide's ``fontException`` (None for most) for a page of a real (tier-B) PDF: MUPDF_SUBSTITUTION when the page
    has a font with no font program (ruling M8-R3; read from the PDF's font dictionaries, so the measuring PC does not
    matter), else FONT_VERSION when this PC has a font the page embeds in another version (ruling M8-R9; read from the
    PC's installed and cloud fonts). Other sets are measured as before. A PDF whose fonts cannot be read has none."""
    if deck.set not in ("real", "tier-c"):
        return None
    from harness.fidelity.pdf_facts import FactsError, page_embedded_versions, page_fonts_not_embedded
    from harness.fonts import fontversion

    try:
        if page_fonts_not_embedded(deck.pdf, index):
            return MUPDF_SUBSTITUTION
        pc = fontversion.pc_index()
        return FONT_VERSION if fontversion.differing(page_embedded_versions(deck.pdf, index, pc), pc) else None
    except FactsError:
        return None


def known_classes(entry):
    """The known-unrecoverable classes a manifest slide entry names (M1-R56; see the module docstring)."""
    found = set()
    if entry.get("knownBitmapText"):
        found.add("bitmapText")
    for feature in entry.get("features") or []:
        feature = str(feature)
        rotated = ROTATED_TEXT.match(feature)
        if ((rotated and float(rotated.group(1)) % 90) or feature in OUTLINED_TEXT
                or (feature.startswith("prstTxWarp:") and feature not in PLAIN_WARPS)):
            found.add("textAsOutlines")
        if feature.startswith(BITMAP_EFFECTS):
            found.add("bitmapEffect")
        if "emoji" in feature.lower():
            found.add("colourEmoji")
    found.update(measured_classes(entry.get("id")))  # M5-R13: by measurement, per slide id
    return sorted(found)


def manifest_pages(deck):
    """Per input page, (label, known) from the deck manifest's slides in the variant's page order (M1-R72: every
    slide for the hidden variant, the visible ones otherwise); [] without a manifest."""
    if not deck.public or deck.manifest is None:
        return []
    try:
        data = json.loads(Path(deck.manifest).read_text(encoding="utf-8"))
        pages = []
        for entry in data.get("slides") or []:
            if entry.get("hidden") and deck.variant not in SHOWS_HIDDEN:
                continue
            label = entry.get("id")
            pages.append((label if isinstance(label, str) and LABEL.match(label) else None, known_classes(entry)))
        return pages
    except Exception:
        return []


def line_boxes(pdf, index):
    """The text-line boxes of input page `index` for V1 (pdf_facts.text_line_boxes, ruling M4-R11), none when the
    PDF's text cannot be read: V1 is then judged raw."""
    from harness.fidelity.pdf_facts import FactsError, text_line_boxes
    try:
        return text_line_boxes(pdf, index)
    except FactsError:
        return []


def judge_v1(v1, v2, noise):
    """V1's record with the noise-floor rule (ruling M5-R1, writing down M4-R13). `noise` is the slide's own noise
    record (v2 of the MuPDF render against the PowerPoint render of the source deck: ``noise``), None without a ground
    truth. ``noiseFloor`` is its residual5; when that is over metrics.V1_NOISE_EXEMPT_RESIDUAL (400 px) the slide is
    ``noiseExempt``: V1's status is the slide's V2 status and the measured one stays in ``passMeasured`` beside the raw
    numbers. px32_shift1 plays no part. A missing V1, noise or an error record leaves V1 as it is."""
    if v1 is None or noise is None or "error" in noise or "error" in v1:
        return v1
    exempt = noise["residual5"] > metrics.V1_NOISE_EXEMPT_RESIDUAL
    measured = v1.get("passMeasured", v1["pass"])  # a record judged before keeps its measured status
    record = {k: v for k, v in v1.items() if k != "passMeasured"}
    record.update({"noiseExempt": exempt, "noiseFloor": int(noise["residual5"]), "pass": measured})
    if exempt:
        record["passMeasured"] = measured
        record["pass"] = bool(v2.get("pass")) and "error" not in v2
    return record


def slide_s7(s7, number):
    """S7 of page `number` (M5 Task 1): the deck's round trip names the pages whose composition differs (``pages``);
    a page it does not name passes, a named one fails with its own differences. A deck result without ``pages`` (the
    round trip passed, failed as a whole, was n/a or skipped) applies to every slide as it is."""
    pages = s7.get("pages") if s7.get("status") == "fail" else None
    if not pages:
        return {"status": s7["status"], "detail": cap(s7["detail"])}
    if number in pages:
        return {"status": "fail", "detail": cap(f"page {number}: {pages[number]}")}
    return {"status": "pass", "detail": f"page {number}: same composition as the input PDF (the deck's S7 failed on "
                                        f"{len(pages)} other page(s))"}


def slide_positions(s7, number):
    """Ruling M8-R12: page `number`'s per-line drift of PowerPoint's round-trip export against the input PDF
    (roundtrip.page_drift: {"lines": [[along, across] | None, ...], "unassigned": n}, pt), None when the round trip
    has none for the page (not run, failed as a whole, or another text than the input's)."""
    found = (s7.get("drift") or {}).get(number)
    return None if not found else {"lines": [None if line is None else [float(line[0]), float(line[1])]
                                              for line in found["lines"]], "unassigned": int(found["unassigned"])}


def deck_s7_record(s7):
    """The deck's S7 verdict as the deck record keeps it: status, detail and, when the deck failed on some pages only,
    ``failedPages``."""
    record = {"status": s7["status"], "detail": cap(s7["detail"])}
    if s7.get("status") == "fail" and s7.get("pages"):
        record["failedPages"] = sorted(s7["pages"])
    return record


def measure_slide(deck, index, size_px, pages, tools, out_pptx, out_image_error, gt, s7, page_info, out_root, log,
                  off_bar=False):
    number = index + 1
    if off_bar:  # M8-R1: S1-S6 (and the deck's n/a S7) only; nothing is rendered
        label, known = page_info if page_info else (None, [])
        s = gates_for(deck, {**structural(deck.pdf, out_pptx, index), "S7": slide_s7(s7, number)})
        return {"index": index, "label": label, "v1": None, "v2": dict(OFF_BAR_V2), "noise": None, "s": s,
                "known": known, "pass": None, "heatmaps": {}}  # pass null: not measured (M8-R1), not a failure
    expected = (size_px[1], size_px[0])  # rows, columns: MuPDF's own pixmap size of this page (M1-R61)
    try:
        pdf_img, pdf_error = tools.render_pdf(deck.pdf, index), None
    except Exception as exc:
        pdf_img, pdf_error = None, f"MuPDF could not render the input page ({type(exc).__name__})"
    if out_image_error:
        out_img, out_error = None, out_image_error
    else:
        out_img, out_error = _png(Path(out_pptx).parent / "render" / f"slide{number}.png",
                                  f"PowerPoint render of output slide {number}")
    gt_img = gt_error = None
    if gt is not None:
        paired = variant_slides(deck.variant, gt.hidden or [])
        if gt.code is None:  # not attempted (skipped-after-stuck)
            gt_error = f"no ground truth ({gt.reason})"
        elif gt.code != OK:
            gt_error = f"no ground truth (render exit {gt.code}, {gt.reason})"
        elif len(paired) != pages:
            gt_error = (f"the ground truth has {len(paired)} slides for the {pages} pages of the {deck.variant} "
                        "export; pages and slides are not paired")
        else:
            slide = paired[index]
            gt_img, gt_error = _png(gt.directory / f"slide{slide}.png", f"ground-truth render of slide {slide}")
    pdf_side = (pdf_img, pdf_error, "MuPDF render of the input page")
    out_side = (out_img, out_error, "PowerPoint render of the output slide")
    gt_side = (gt_img, gt_error, "ground-truth render")
    regions = metrics.pixel_regions(line_boxes(deck.pdf, index), PX_PER_PT, expected)
    noise = None if gt is None else visual(metrics.v2, pdf_side, gt_side, expected)
    # M3-R51: V2 is held to the noise floor plus the spec's numbers where there is one, else to 400 px and 1 %
    v2 = visual(lambda pdf_image, out_image: metrics.v2(pdf_image, out_image, noise, regions), pdf_side, out_side,
                expected)
    v1 = None if gt is None else visual(lambda gt_image, out_image: metrics.v1(gt_image, out_image, regions),
                                        gt_side, out_side, expected)
    v1 = judge_v1(v1, v2, noise)
    s = gates_for(deck, {**structural(deck.pdf, out_pptx, index), "S7": slide_s7(s7, number)})
    heatmaps = {}
    for key, record, fixed, shifted in (("V1", v1, gt_img, out_img), ("V2", v2, out_img, pdf_img)):
        if record is None or "error" in record or record["pass"]:
            continue
        relative = f"{deck.id}/{deck.variant}/{key.lower()}-slide{number}.png"
        try:
            metrics.heatmap(fixed, shifted, Path(out_root) / relative)
            heatmaps[key] = relative
        except Exception as exc:
            log.write(f"{deck.id} {deck.variant} slide {number}: no {key} heatmap ({type(exc).__name__})")
    label, known = page_info if page_info else (None, [])
    exception = font_exception(deck, index)
    record = {"index": index, "label": label, "v1": v1, "v2": v2, "noise": noise, "s": s, "known": known,
              "pass": None, "heatmaps": heatmaps}
    positions = slide_positions(s7, number)
    if positions is not None:
        record["positions"] = positions
    if exception:
        record["fontException"] = exception
    return judge(record, exception)


# ---- one deck -------------------------------------------------------------------------------------------------------


def page_pixels(pdf):
    """(width, height) in px of MuPDF's render of every page at 2 px/pt (render_pdf.pixmap_sizes: the page box
    rotated by /Rotate, rounded outwards as MuPDF does; M1-R61); FactsError (no path in it) if the PDF is unreadable or
    encrypted."""
    from harness.fidelity.pdf_facts import pdf_page_count
    from harness.fidelity.render_pdf import pixmap_sizes

    pdf_page_count(pdf)  # FactsError (no path in it) for anything that is not a readable PDF
    try:
        return pixmap_sizes(pdf, PX_PER_PT)
    except Exception as exc:
        raise FactsError(f"unreadable PDF ({type(exc).__name__})") from None


def _input_reason(error):
    """The fixed token for a FactsError of the input PDF."""
    return "encrypted" if str(error).startswith("encrypted") else "unreadable"


def deck_s7(deck, tools, out_pptx, convert_step, enabled, ppt=None):
    """S7 of the deck x variant. A result may carry "powerpoint": "timeout" (PowerPoint timed out: the later
    PowerPoint steps are skipped) or "busy" (PowerPoint refused the calls); it is noted in `ppt` and dropped. With
    PowerPoint timed out earlier in the run, S7 is not attempted: n/a, skipped-after-stuck (M1-R74)."""
    if not enabled:
        return {"status": "n/a", "detail": "not run (--no-s7)"}
    if convert_step.code != OK:
        return {"status": "fail", "detail": f"no converter output to open (convert exit {convert_step.code}, "
                                            f"{convert_step.reason})"}
    if ppt is not None and ppt.skip():
        return {"status": "n/a", "detail": cap(f"{SKIPPED_AFTER_STUCK}: {ppt.because()}")}
    marker, pages, drift = None, None, None
    try:
        result = tools.s7(out_pptx, deck.pdf)
        status = result.get("status")
        detail = result.get("detail", "")
        marker = result.get("powerpoint")
        pages = result.get("pages")
        drift = result.get("drift")
    except Exception as exc:
        status, detail = "fail", f"S7 could not run ({type(exc).__name__})"
    if status not in ("pass", "fail", "n/a"):
        status, detail = "fail", "S7 gave no status"
    if ppt is not None and marker in ("timeout", "busy"):
        ppt.after(deck, "S7", TIMEOUT if marker == "timeout" else ERROR,
                  POWERPOINT_BUSY if marker == "busy" else "timeout")
    result = {"status": status, "detail": cap(detail)}
    if status == "fail" and pages:
        result["pages"] = {int(n): cap(text) for n, text in pages.items()}
    if drift and status in ("pass", "fail") and not (status == "fail" and not pages):
        result["drift"] = {int(n): value for n, value in drift.items()}  # M8-R12; a deck-wide failure keeps none
    return result


def _code_text(code, reason):
    return f"- (not run{': ' + reason if reason else ''})" if code is None else f"{code} ({reason})"


def _empty_record(deck):
    record = {"id": deck.id, "public": deck.public, "set": deck.set, "variant": deck.variant, "pages": 0,
              "exitCodes": {"input": None, "convert": None, "render": None, "groundTruth": None},
              "reasons": {"input": None, "convert": None, "render": None, "groundTruth": None}, "convert": None,
              "slides": []}
    if deck.set == "real":  # M8: the PDF's origin decides whether its slides count toward the bar
        record["origin"], record["bar"] = deck.origin or "other", deck.origin == "powerpoint-windows"
    elif deck.set == "tier-c":  # M8 tier C: the origin is reported; the deck is never in the bar
        record["origin"], record["bar"] = deck.origin or "other", False
    return record


def stale_export(deck):
    """Why a public PDF is not the export of the deck and manifest next to it (ruling M1-R77: its export stamp,
    harness/atlas/export.py), None when it is or when there is nothing it could be stale against (no source deck and
    no manifest; private decks have neither a stamp nor a manifest)."""
    if not deck.public or deck.set == "real" or (deck.source_pptx is None and deck.manifest is None):
        return None  # a tier-B PDF is someone else's export: it has no stamp of ours
    from harness.atlas.export import stamp_problem

    return stamp_problem(deck.pdf, deck.variant, deck.source_pptx, deck.manifest)


def off_bar(deck, structural_only):
    """True when ruling M8-R1 leaves the deck at S1-S6: --off-bar-structural and a real deck off the bar."""
    return bool(structural_only) and deck.set == "real" and deck.origin != "powerpoint-windows"


def measure_deck(deck, tools, out_root, *, s7_enabled, limit_slides, gt_memo, log, ppt=None, off_bar_structural=False):
    ppt = ppt if ppt is not None else PowerPointState(log)
    skip_renders = off_bar(deck, off_bar_structural)
    deck_dir = Path(out_root) / deck.id / deck.variant
    shutil.rmtree(deck_dir, ignore_errors=True)
    deck_dir.mkdir(parents=True, exist_ok=True)
    record = _empty_record(deck)
    stale = stale_export(deck)
    if stale:  # a PDF that is not the export of this deck and manifest is not measured against them (M1-R77)
        record["exitCodes"]["input"], record["reasons"]["input"] = ERROR, "stale-export"
        record["error"] = cap(f"input PDF: stale export: {stale}")
        return record
    try:
        sizes = page_pixels(deck.pdf)
    except FactsError as exc:  # unreadable or encrypted: a failed step (M1-R62); the message names no file
        record["exitCodes"]["input"], record["reasons"]["input"] = ERROR, _input_reason(exc)
        record["error"] = cap(f"input PDF: {exc}")
        return record
    record["exitCodes"]["input"], record["reasons"]["input"] = OK, "ok"
    record["pages"] = len(sizes)
    request = sizes[0]  # one slide size per PPTX: PowerPoint renders every slide at the first page's MuPDF size

    out_pptx = deck_dir / "out.pptx"
    started = time.perf_counter()
    convert = _safe(tools.convert, deck.pdf, out_pptx, keep_log=deck.public)
    seconds = time.perf_counter() - started
    log.tool(deck, "convert", convert)
    record["exitCodes"]["convert"], record["reasons"]["convert"] = convert.code, convert.reason
    out_image_error = None
    if convert.code == OK:
        record["convert"] = {"seconds": round(seconds, 3), **(convert.stats or {})}
        if skip_renders:  # M8-R1: not rendered, exit code null
            record["reasons"]["render"] = OFF_BAR
            out_image_error = "not rendered (off-bar, M8-R1)"
        elif ppt.skip():  # PowerPoint timed out earlier in the run: not attempted, exit code null (M1-R74)
            record["reasons"]["render"] = SKIPPED_AFTER_STUCK
            out_image_error = f"no render of the output ({SKIPPED_AFTER_STUCK}: {ppt.because()})"
        else:
            render = _safe(tools.render, out_pptx, deck_dir / "render", keep_log=deck.public, size=request)
            log.tool(deck, "render", render)
            record["exitCodes"]["render"], record["reasons"]["render"] = render.code, render.reason
            ppt.after(deck, "render", render.code, render.reason)
            if render.code != OK:
                out_image_error = f"no render of the output (render exit {render.code}, {render.reason})"
    else:
        out_image_error = f"no converter output (convert exit {convert.code}, {convert.reason})"

    if skip_renders:
        gt = None  # M8-R1: no V1 and no noise floor
        if deck.source_pptx is not None:
            record["reasons"]["groundTruth"] = OFF_BAR
    elif deck.source_pptx is not None and page_frame_differs(deck, request):
        gt = None  # V1 and the noise floor need the source slide's frame (M1-R72): not rendered at all
        record["reasons"]["groundTruth"] = PAGE_FRAME_DIFFERS
    else:
        gt = ground_truth(deck, tools, out_root, gt_memo, log, size=request, ppt=ppt)
    if gt is not None:
        record["exitCodes"]["groundTruth"], record["reasons"]["groundTruth"] = gt.code, gt.reason
    s7 = ({"status": "n/a", "detail": "not run (off-bar, M8-R1)"} if skip_renders
          else deck_s7(deck, tools, out_pptx, convert, s7_enabled, ppt))
    deck_verdict = deck_s7_record(s7)
    if not deck.public:  # a private deck's details are the fixed template (M1-R75)
        deck_verdict["detail"] = private_detail(s7["status"])
    record["s7"] = deck_verdict
    pages_info = manifest_pages(deck)
    count = len(sizes) if limit_slides is None else min(len(sizes), limit_slides)
    for index in range(count):
        page_info = pages_info[index] if index < len(pages_info) else None
        try:
            slide = measure_slide(deck, index, sizes[index], len(sizes), tools, out_pptx, out_image_error, gt, s7,
                                  page_info, out_root, log, off_bar=skip_renders)
        except Exception as exc:  # one odd slide must not end a long run
            error = {"pass": False, "error": f"internal error ({type(exc).__name__})"}
            slide = {"index": index, "label": None, "v1": None if gt is None else dict(error), "v2": dict(error),
                     "noise": None,
                     "s": gates_for(deck, {**_all_fail(f"internal error ({type(exc).__name__})"), "S7": slide_s7(s7, index + 1)}),
                     "known": [], "pass": False, "heatmaps": {}}
        record["slides"].append(slide)
    return record


# ---- summary, environment -------------------------------------------------------------------------------------------


def _stat(values):
    values = np.asarray(values, dtype=float)
    return {"median": round(float(np.median(values)), DIGITS), "p95": round(float(np.percentile(values, 95)), DIGITS),
            "max": round(float(values.max()), DIGITS)}


def _mean(records):
    """{"slides", "raw_px32", "px32_shift1"}: the means over computed V1 or V2 records (null and error records left
    out), None without any."""
    computed = [r for r in records if r is not None and "error" not in r]
    if not computed:
        return None
    return {"slides": len(computed),
            "raw_px32": round(float(np.mean([r["raw_px32"] for r in computed])), DIGITS),
            "px32_shift1": round(float(np.mean([r["px32_shift1"] for r in computed])), DIGITS)}


def averages(records):
    """The mean raw_px32 and px32_shift1 of V1 and V2 per deck x variant and over the run (spec 5: averages are
    reported, never gated)."""
    every = {"V1": [], "V2": []}
    decks = []
    for record in records:
        v1 = [slide["v1"] for slide in record["slides"]]
        v2 = [slide["v2"] for slide in record["slides"]]
        every["V1"] += v1
        every["V2"] += v2
        decks.append({"id": record["id"], "set": record["set"], "variant": record["variant"], "v1": _mean(v1),
                      "v2": _mean(v2)})
    return {"overall": {"v1": _mean(every["V1"]), "v2": _mean(every["V2"])}, "decks": decks}


def summarise(records, private_unreadable=0, powerpoint=None):
    """The results' summary; `powerpoint` is PowerPointState.summary() (M1-R74), none timed out or busy if None."""
    by_gate = {gate: {"pass": 0, "fail": 0, "na": 0} for gate in GATES}
    slides = passed = known = unmeasured = 0
    noise_floor = []
    exempt = []
    for record in records:
        noises = []
        exempt_slides = [number for number, slide in enumerate(record["slides"], start=1)
                         if slide["v1"] is not None and slide["v1"].get("noiseExempt")]
        if exempt_slides:
            exempt.append({"id": record["id"], "set": record["set"], "variant": record["variant"],
                           "slides": exempt_slides})
        for slide in record["slides"]:
            slides += 1
            unmeasured += slide["pass"] is None  # M8-R1: an off-bar slide is neither a pass nor a failure
            passed += slide["pass"] is True
            known += bool(slide["known"])
            for gate, value in (("V1", slide["v1"]), ("V2", slide["v2"])):
                not_measured = value is None or value == OFF_BAR_V2  # M8-R1: never measured, so n/a
                by_gate[gate]["na" if not_measured else ("pass" if value["pass"] else "fail")] += 1
            for key in S_KEYS + ("S7",):
                by_gate[key][{"pass": "pass", "fail": "fail", "n/a": "na"}[slide["s"][key]["status"]]] += 1
            if slide["noise"] is not None and "error" not in slide["noise"]:
                noises.append(slide["noise"])
        if noises:
            noise_floor.append({"id": record["id"], "set": record["set"], "variant": record["variant"],
                                "slides": len(noises), "px32_shift1": _stat([n["px32_shift1"] for n in noises]),
                                "residual5": _stat([n["residual5"] for n in noises]),
                                # over 400 px / 1 %: the V2 limits of a slide without a ground truth (M3-R51)
                                "overV2": sum(1 for n in noises if not n["pass"])})

    def failed(step):
        return sum(1 for r in records if r["exitCodes"].get(step) not in (OK, None))

    summary = {"decks": len(records), "slides": slides, "pass": passed, "fail": slides - passed - unmeasured,
               "notMeasured": unmeasured, "byGate": by_gate, "known": known,
               "exitCodes": {"inputFailed": failed("input"), "convertFailed": failed("convert"),
                             "renderFailed": failed("render"), "groundTruthFailed": failed("groundTruth")},
               "privateUnreadable": private_unreadable, "noiseFloor": noise_floor, "v1NoiseExempt": exempt,
               "averages": averages(records), "powerpoint": powerpoint or PowerPointState().summary()}
    bar = bar_summary(records)
    if bar is not None:
        summary["bar"] = bar
    tier_c = tier_c_summary(records)
    if tier_c is not None:
        summary["tierC"] = tier_c
    return summary


def tier_c_summary(records):
    """The tier-C block (M8: the author's own deck(s), private, named by 12-hex id only): measured fully and reported,
    never part of the bar (spec 5.4 for a PDFMaker origin; ``reportedOnly`` says so). ``pass``/``fail`` are the slides'
    verdicts as everywhere (``positions``: of the passes, those by ruling M8-R12); ``origins`` counts the decks per
    origin. None when the run had no tier-C deck."""
    decks = [r for r in records if r["set"] == "tier-c"]
    if not decks:
        return None
    slides = [s for r in decks for s in r["slides"]]
    origins = {}
    for record in decks:
        origins[record.get("origin") or "other"] = origins.get(record.get("origin") or "other", 0) + 1
    return {"decks": len(decks), "slides": len(slides), "pass": sum(s["pass"] is True for s in slides),
            "fail": sum(s["pass"] is False for s in slides),
            "positions": sum(s.get("passReason") == POSITIONS for s in slides),
            "origins": dict(sorted(origins.items())), "reportedOnly": True}


def bar_summary(records):
    """The bar-only summary (M8, Task 2 review I1): over the real decks on the bar (origin powerpoint-windows) alone,
    the slides the stop rule counts. ``pass`` and ``fail`` are the slides' own verdicts, the font exceptions applied
    (``slide_passes``); ``fontException`` counts the slides judged with one: ``total``, per kind, and how many of
    them pass. None when the run had no bar deck."""
    decks = [r for r in records if r["set"] == "real" and r.get("bar")]
    if not decks:
        return None
    slides = [s for r in decks for s in r["slides"]]
    excepted = [s for s in slides if s.get("fontException")]
    return {"decks": len(decks), "slides": len(slides), "pass": sum(s["pass"] is True for s in slides),
            "fail": sum(s["pass"] is False for s in slides),
            "positions": sum(s.get("passReason") == POSITIONS for s in slides),  # M8-R12: of ``pass``, by the rule
            "fontException": {"total": len(excepted),
                              **{kind: sum(s["fontException"] == kind for s in excepted) for kind in FONT_EXCEPTIONS},
                              "pass": sum(s["pass"] is True for s in excepted)}}


def failed_steps(summary):
    """How many steps failed in the run: deck x variant steps, private PDFs that could not be read, and PowerPoint
    steps skipped after a timeout or refused as busy (M1-R74; a busy render also counts as a failed render)."""
    powerpoint = summary.get("powerpoint") or {}
    return (sum(summary["exitCodes"].values()) + summary["privateUnreadable"]
            + powerpoint.get("skippedAfterStuck", 0) + powerpoint.get("busy", 0))


def _file_version(path):
    """The file version of a Windows executable (read-only, version.dll), e.g. "16.0.17932.20976"."""
    import ctypes
    from ctypes import wintypes

    version = ctypes.WinDLL("version")
    size = version.GetFileVersionInfoSizeW(str(path), None)
    if not size:
        return None
    buffer = ctypes.create_string_buffer(size)
    if not version.GetFileVersionInfoW(str(path), 0, size, buffer):
        return None
    pointer, length = ctypes.c_void_p(), wintypes.UINT()
    if not version.VerQueryValueW(buffer, "\\", ctypes.byref(pointer), ctypes.byref(length)):
        return None
    words = ctypes.cast(pointer, ctypes.POINTER(wintypes.DWORD * 13)).contents
    ms, ls = words[2], words[3]  # VS_FIXEDFILEINFO dwFileVersionMS / LS
    return f"{ms >> 16}.{ms & 0xFFFF}.{ls >> 16}.{ls & 0xFFFF}"


def powerpoint_version():
    """The installed PowerPoint's version from the registry (never through COM, never starting PowerPoint)."""
    if sys.platform != "win32":
        return None
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Office\ClickToRun\Configuration") as key:
            value = str(winreg.QueryValueEx(key, "VersionToReport")[0])
            if re.fullmatch(r"[0-9][0-9.]{0,40}", value):
                return value
    except OSError:
        pass
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                            r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\POWERPNT.EXE") as key:
            return _file_version(winreg.QueryValueEx(key, "")[0])
    except (OSError, AttributeError):
        return None


def environment():
    try:
        import pymupdf

        mupdf = f"{pymupdf.VersionBind} (MuPDF {pymupdf.VersionFitz})"
    except Exception:
        mupdf = None
    try:
        node = subprocess.run(["node", "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
        node = node if re.fullmatch(r"v?[0-9][0-9.]{0,30}", node) else None
    except Exception:
        node = None
    return {"powerpoint": powerpoint_version(), "pymupdf": mupdf, "python": platform.python_version(), "node": node}


# ---- the run --------------------------------------------------------------------------------------------------------


@contextlib.contextmanager
def quiet_mupdf():
    """MuPDF's own error and warning messages are off while the run reads the decks (ruling M1-R75), as in the census:
    on a damaged file they quote the input's font names and objects, and PyMuPDF prints them to stdout. The previous
    setting comes back afterwards."""
    try:
        import pymupdf
    except ImportError:  # pragma: no cover - the harness always has it
        yield
        return
    errors, warnings = pymupdf.TOOLS.mupdf_display_errors(), pymupdf.TOOLS.mupdf_display_warnings()
    pymupdf.TOOLS.mupdf_display_errors(False)
    pymupdf.TOOLS.mupdf_display_warnings(False)
    try:
        yield
    finally:
        pymupdf.TOOLS.mupdf_display_errors(bool(errors))
        pymupdf.TOOLS.mupdf_display_warnings(bool(warnings))


def run_decks(found, tools, out_root, *, converter, s7_enabled=True, limit_slides=None, options=None,
              off_bar_structural=False):
    """Measure every deck of `found` (decks.Deck; a decks.DeckList also carries how many private PDFs could not be
    read) one after another; returns the results document. MuPDF's own messages are off meanwhile (quiet_mupdf).
    With `off_bar_structural`, real decks off the bar get S1-S6 only (ruling M8-R1)."""
    with quiet_mupdf():
        return _run_decks(found, tools, out_root, converter=converter, s7_enabled=s7_enabled,
                          limit_slides=limit_slides, options=options, off_bar_structural=off_bar_structural)


def _run_decks(found, tools, out_root, *, converter, s7_enabled, limit_slides, options, off_bar_structural=False):
    out_root = Path(out_root)
    out_root.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    today = date.today().isoformat()
    private_unreadable = int(getattr(found, "private_unreadable", 0))
    log = RunLog(out_root / "run.log")
    records, gt_memo = [], {}
    ppt = PowerPointState(log)  # one for the whole run: a timeout stops the later decks' PowerPoint steps (M1-R74)
    try:
        log.progress(f"{len(found)} deck x variant(s); converter {converter}; S7 {'on' if s7_enabled else 'off'}")
        if private_unreadable:
            log.progress(f"{private_unreadable} private PDF(s) or folder(s) could not be read: not measured, counted "
                         "in summary.privateUnreadable (no name is shown)")
        for number, deck in enumerate(found, start=1):
            deck_started = time.perf_counter()
            try:
                record = measure_deck(deck, tools, out_root, s7_enabled=s7_enabled, limit_slides=limit_slides,
                                      gt_memo=gt_memo, log=log, ppt=ppt, off_bar_structural=off_bar_structural)
            except Exception as exc:  # recorded as a failed step, so one deck cannot end the run (M1-R62)
                record = _empty_record(deck)
                record["exitCodes"]["input"], record["reasons"]["input"] = ERROR, "internal-error"
                record["error"] = f"internal error ({type(exc).__name__}): the deck was not measured"
            records.append(record)
            codes, reasons = record["exitCodes"], record["reasons"]
            slides = record["slides"]
            passed = sum(1 for s in slides if s["pass"])
            verdict = record.get("s7")  # the deck's own round trip (M5 Task 1), not its first slide's page
            s7 = "-" if not verdict else verdict["status"] + (
                f" (pages {', '.join(map(str, verdict['failedPages']))})" if verdict.get("failedPages") else "")
            ground = ("no ground truth" if codes["groundTruth"] is None and deck.source_pptx is None
                      else f"ground truth {_code_text(codes['groundTruth'], reasons['groundTruth'])}")
            extra = f"; not measured (input {codes['input']}, {reasons['input']})" if "error" in record else ""
            log.progress(f"[{number}/{len(found)}] {deck.id} {deck.variant}: input "
                         f"{_code_text(codes['input'], reasons['input'])}, convert "
                         f"{_code_text(codes['convert'], reasons['convert'])}, render "
                         f"{_code_text(codes['render'], reasons['render'])}, {ground}, S7 {s7}; {len(slides)} "
                         f"slides: {passed} pass, {len(slides) - passed} fail{extra} "
                         f"({time.perf_counter() - deck_started:.1f} s)")
        summary = summarise(records, private_unreadable, ppt.summary())
        runtime = round(time.perf_counter() - started, 1)
        codes = summary["exitCodes"]
        log.progress(f"done in {runtime:.0f} s: {summary['slides']} slides, {summary['pass']} pass, "
                     f"{summary['fail']} fail; failed steps: input {codes['inputFailed']}, convert "
                     f"{codes['convertFailed']}, render {codes['renderFailed']}, ground truth "
                     f"{codes['groundTruthFailed']}, unreadable private PDFs {private_unreadable}; PowerPoint steps "
                     f"{SKIPPED_AFTER_STUCK} {ppt.skipped}, {POWERPOINT_BUSY} {ppt.busy}")
        if ppt.stuck_at is not None:
            log.progress(f"PowerPoint timed out at {ppt.stuck_at['id']} {ppt.stuck_at['variant']} "
                         f"({ppt.stuck_at['step']}); {ppt.skipped} later PowerPoint step(s) were skipped. A dialog may "
                         f"still be open in PowerPoint: see {MANUAL_CLEANUP}.")
    finally:
        log.close()
    return {"schema": SCHEMA_ID, "converter": converter, "date": today, "runtimeSeconds": runtime,
            "options": options or {"decks": sorted({d.set for d in found}), "variants": [], "s7": s7_enabled,
                                   "limitSlides": limit_slides},
            "env": environment(), "decks": records, "summary": summary}


def _shown(path, root):
    """A path for stdout: relative to the repo when inside it, else its file name only."""
    try:
        return Path(path).resolve().relative_to(Path(root).resolve()).as_posix()
    except ValueError:
        return f"{Path(path).name} (outside the repo)"


def _split(text):
    return [part.strip() for part in str(text).split(",") if part.strip()]


def _positive(text):
    value = int(text)
    if value < 1:
        raise argparse.ArgumentTypeError("must be 1 or more")
    return value


def main(argv=None, *, root=REPO, out_root=None, tools=None):
    parser = argparse.ArgumentParser(prog="python -m harness.fidelity.run",
                                     description="Convert the test decks and measure every slide (spec section 5).")
    parser.add_argument("--converter", required=True, choices=sorted(CONVERTERS))
    parser.add_argument("--decks", default=",".join(deck_list.DEFAULT_SETS),
                        help="comma-separated sets: public, atlas, private, real (default: public,atlas)")
    parser.add_argument("--variants", default=",".join(deck_list.DEFAULT_VARIANTS),
                        help="PDF variants of the public decks (default: std,notags)")
    parser.add_argument("--out", type=Path, help="results JSON (default: out/fidelity/results.json)")
    parser.add_argument("--no-s7", action="store_true", help="skip S7, the PowerPoint round trip (n/a)")
    parser.add_argument("--limit-slides", type=_positive, help="measure only the first N pages of each deck")
    parser.add_argument("--ids", help="comma-separated deck ids: measure only these decks of the sets asked for")
    parser.add_argument("--off-bar-structural", action="store_true",
                        help="ruling M8-R1: real decks off the bar get S1-S6 only, with no renders")
    parser.add_argument("--bar-only", action="store_true",
                        help="M8 round 1c: leave the real decks off the bar out of the run altogether (their crash and "
                             "repair checks were r0's); the other sets are not touched")
    args = parser.parse_args(argv)
    root = Path(root)
    out_root = Path(out_root) if out_root else root / "out" / "fidelity"
    sets, variants = _split(args.decks), _split(args.variants)
    bad = [v for v in variants if not re.fullmatch(r"[a-z0-9]{1,20}", v)]
    if not sets or not variants or bad:
        print("fidelity: --decks and --variants need comma-separated names (variants: a-z, 0-9)", file=sys.stderr)
        return 3
    try:
        found = deck_list.discover(root, sets, variants)
    except ValueError as exc:  # set names and public deck names only
        print(f"fidelity: {exc}", file=sys.stderr)
        return 3
    except OSError as exc:  # its text may name a private directory: the type only (M1-R62)
        print(f"fidelity: the deck directories could not be listed ({type(exc).__name__})", file=sys.stderr)
        return 3
    if args.ids is not None:  # M8: a fix round re-measures the decks it touches
        wanted = list(dict.fromkeys(_split(args.ids)))
        missing = [deck_id for deck_id in wanted if not any(d.id == deck_id for d in found)]
        if not wanted or missing:
            # the count only: an id may be a private deck's
            print(f"fidelity: --ids: {len(missing) if wanted else 'no'} id(s) not found in --decks {','.join(sets)}",
                  file=sys.stderr)
            return 3
        found = deck_list.DeckList(d for d in found if d.id in wanted)  # unreadable private PDFs are not asked for
    if not found and not getattr(found, "private_unreadable", 0):
        print(f"fidelity: no decks found for --decks {','.join(sets)} --variants {','.join(variants)}",
              file=sys.stderr)
        return 3
    if args.bar_only:  # M8 round 1c: the real decks off the bar are not part of this run
        unreadable = getattr(found, "private_unreadable", 0)
        found = deck_list.DeckList(d for d in found if d.set != "real" or d.origin == "powerpoint-windows")
        found.private_unreadable = unreadable
    # Only unreadable private PDFs: the run still writes its (empty) results and dashboard, so the results of an
    # earlier run are not left in place looking current, and exits 1 (a failed step).
    tools = tools or default_tools(args.converter)
    options = {"decks": list(dict.fromkeys(sets)), "variants": list(dict.fromkeys(variants)),
               "s7": not args.no_s7, "limitSlides": args.limit_slides}
    if args.ids is not None:
        options["ids"] = len(found)  # how many decks were picked; the deck records name them
    if args.off_bar_structural:
        options["offBarStructural"] = True
    if args.bar_only:
        options["barOnly"] = True
    # M8-R2: the Office cloud fonts at the start of the round, by name (a directory listing only), for every set: the
    # public decks' PowerPoint renders use them too (round 1 review M8)
    from harness.fonts import cloudfonts

    cloud = cloudfonts.snapshot()
    if cloud is not None:
        options["cloudFonts"] = cloud
    results = run_decks(found, tools, out_root, converter=args.converter, s7_enabled=not args.no_s7,
                        limit_slides=args.limit_slides, options=options, off_bar_structural=args.off_bar_structural)

    from harness.fidelity import dashboard

    out_json = args.out or out_root / "results.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, "w", encoding="utf-8", newline="\n") as handle:  # LF on Windows too (eol=lf)
        handle.write(json.dumps(results, ensure_ascii=False, indent=1) + "\n")
    board = out_root / "dashboard.html"
    dashboard.write(results, board, heatmap_root=out_root)
    problems = validate(results, json.loads(SCHEMA_PATH.read_text(encoding="utf-8")))
    summary = results["summary"]
    print(f"fidelity: {summary['slides']} slides, {summary['pass']} pass, {summary['fail']} fail; results "
          f"{_shown(out_json, root)}; dashboard {_shown(board, root)}")
    if problems:
        print(f"fidelity: the results do not match results.schema.json ({len(problems)} problem(s)), e.g. "
              f"{'; '.join(problems[:5])}", file=sys.stderr)
        return 3
    return 1 if failed_steps(summary) else 0


if __name__ == "__main__":
    sys.exit(main())
