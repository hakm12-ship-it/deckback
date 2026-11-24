"""Python wrapper for harness/atlas/export.ps1: PowerPoint exports a deck to the PDF variants every test uses.

  harness/.venv/Scripts/python -m harness.atlas.export --pptx out/atlas/probe.pptx --out out/atlas --ground-truth

`export(pptx, out_dir, variants, ground_truth)` runs the script (Windows PowerShell 5.1, desktop PowerPoint through
harness/ppt/DeckbackCom.psm1) and returns its JSON result:

  {"variants": {"<v>": {"ok": bool, "exitCode": int, "pages": int, "seconds": float,
                        "expectedPages": int[, "reason": str]}},
   "groundTruth": {"ok", "exitCode", "slides", "seconds"[, "reason"]},      # only with ground_truth
   "fonts": {"std": [...] | None, "msprint": [...] | None},                 # see embedded_fonts
   "scriptExitCode": int,                                                   # 0 ok, 2 a run timed out, 3 failures
   "stderr": str}

A variant is ok only if its PDF has the page count the deck file implies (slides in ppt/presentation.xml, minus the
hidden ones except for the hidden variant). msprint is recorded ok: false with reason MSPRINT_SKIPPED when a PowerPoint
was already running (M1-R27) and with reason "printer-missing" when the printer is absent; neither makes the script
exit non-zero.

It does not raise for a failed variant (check "ok"); it raises ExportError when the script gave no result at all (bad
arguments, the module did not load) or did not finish within a generous limit derived from the module's own time
limits (the script is then left running and NOT stopped: ending it could leave a PowerPoint it started behind).

The export stamp (ruling M1-R77). After the script, `<out_dir>/<stem>.export.json` records what the PDFs there were
exported from: the sha256 of the deck and of its manifest (`<stem>.manifest.json` next to the deck; null without
one), and per variant exported ok its PDF's file name and sha256 and the PowerPoint version (the registry's, never
through COM). An earlier stamp's other variants are kept only when the deck and the manifest are the same bytes and
their PDFs are unchanged; a variant that failed now is dropped (its PDF may be partial or stale). `stamp_problem`
tells whether a PDF is the export its stamp records of the deck and manifest at hand; the fidelity run refuses a PDF
for which it is not (input step `stale-export`). A stamp that cannot be written is result["stampError"] (the
exception type).

result["stderr"] holds the script's progress lines and the module's error messages, and those quote input paths: treat
it as private. Never copy it into results JSON, a dashboard or a log that leaves the PC (ExportError.stderr likewise).

M1-R21: PowerPoint embeds font programs in the std PDF: TrueType (glyf) fonts as subsets; OpenType-CFF fonts it does
not embed at all (it draws their text as a bitmap), and a family name that a Windows system font also has resolves to
that font (Noto Sans KR to the variable NotoSansKR-VF). So `embedded_fonts` reports for every embedded font program its
family (nameID 1, the name the lock and PowerPoint use), PostScript name, tables and whether it is a variable font
(has an `fvar` table). "fonts" has it for the std and the msprint PDF (None for a variant that was not exported, or
when reading the PDF failed: then result["fontsErrors"] names the exception type).
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pymupdf

from harness.fonts.program import read_program, strip_subset_tag
from harness.ppt import limits

EXPORT_PS1 = Path(__file__).with_name("export.ps1")
VARIANTS = ("std", "min", "notags", "pdfa", "hidden", "msprint")
FONT_VARIANTS = ("std", "msprint")
MSPRINT_SKIPPED = "skipped: PowerPoint already running (msprint changes the shared ActivePrinter)"

STAMP_SCHEMA = "deckback.export-stamp/1"


class ExportError(RuntimeError):
    """The export script gave no result. `left_running` is True when it did not finish within export()'s limit and
    was left running: PowerPoint may be held by a dialog (the fidelity run then skips its later PowerPoint steps)."""

    def __init__(self, message, stderr="", left_running=False):
        super().__init__(message)
        self.stderr = stderr
        self.left_running = left_running


def slide_count(pptx):
    """Slides listed in ppt/presentation.xml, 0 if the file cannot be read."""
    try:
        with zipfile.ZipFile(pptx) as z:
            return len(re.findall(rb"<(?:\w+:)?sldId\s", z.read("ppt/presentation.xml")))
    except (OSError, KeyError, zipfile.BadZipFile):
        return 0


def subprocess_limit(pptx, run_count, timeout_sec=None):
    """Seconds after which export() gives up waiting for the script: every PowerPoint run may wait for the lock of
    another deckback run and then use its own time limit (the module's default 120 s + 4 s per slide,
    harness/ppt/limits.py), plus margins."""
    per_run = timeout_sec or limits.module_time_limit(slide_count(pptx))
    return run_count * (per_run + 30) + 60


def export(pptx, out_dir, variants, ground_truth, timeout_sec=None):
    """Export `pptx` to `<out_dir>/<stem>_<variant>.pdf` for each variant (and `<out_dir>/gt/<stem>/slide<N>.png`
    and map.json with ground_truth). `timeout_sec` is the limit of each PowerPoint run (default: 120 s + 4 s per
    slide)."""
    command = [
        "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(EXPORT_PS1),
        "-Pptx", str(pptx), "-OutDir", str(out_dir), "-Variants", ",".join(variants),
    ]
    if ground_truth:
        command.append("-GroundTruth")
    if timeout_sec:
        command += ["-TimeoutSec", str(int(timeout_sec))]
    limit = subprocess_limit(pptx, len(variants) + (1 if ground_truth else 0), timeout_sec)
    # Popen, not run(): run() would end the script when the limit passes, and a script ended in the middle cannot close
    # the presentation or quit the PowerPoint it started.
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                               text=True, errors="replace")
    try:
        stdout, stderr = process.communicate(timeout=limit)
    except subprocess.TimeoutExpired:
        raise ExportError(f"export.ps1 (process {process.pid}) did not finish within {limit} s; it was left running, "
                          "nothing was stopped", left_running=True) from None
    result = _last_json_line(stdout)
    if result is None or "variants" not in result:
        raise ExportError(f"export.ps1 exited {process.returncode} without a result line", stderr)
    result["scriptExitCode"] = process.returncode
    result["stderr"] = stderr
    try:
        write_stamp(pptx, out_dir, variants, [v for v in variants if (result["variants"].get(v) or {}).get("ok")])
    except Exception as exc:  # the export result stays valid; the fidelity run refuses PDFs without a stamp
        result["stampError"] = type(exc).__name__
    result["fonts"] = {}
    for name in FONT_VARIANTS:
        record = result["variants"].get(name)
        result["fonts"][name] = None
        if record and record.get("ok"):
            try:
                result["fonts"][name] = embedded_fonts(Path(out_dir) / f"{Path(pptx).stem}_{name}.pdf")
            except Exception as exc:  # a PDF or font-reader error must not discard a valid export result
                result.setdefault("fontsErrors", {})[name] = type(exc).__name__
    return result


# ---- the export stamp (ruling M1-R77) --------------------------------------------------------------------------------


def powerpoint_version():
    """The installed PowerPoint's version, from the registry (never through COM, never starting PowerPoint); None
    off Windows or when it cannot be read."""
    from harness.fidelity.run import powerpoint_version as version

    return version()


def _sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stamp_path(directory, stem):
    return Path(directory) / f"{stem}.export.json"


def _file_record(path):
    path = Path(path) if path is not None else None
    return {"file": path.name, "sha256": _sha256(path)} if path is not None and path.is_file() else None


def read_stamp(path):
    """The stamp at `path` as a dict, None if there is none; ValueError if it is not a stamp."""
    path = Path(path)
    if not path.is_file():
        return None
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema") != STAMP_SCHEMA or not isinstance(data.get("variants"), dict):
        raise ValueError("not an export stamp")
    return data


def write_stamp(pptx, out_dir, attempted, exported, powerpoint=None, *, version_known=False):
    """Write `<out_dir>/<stem>.export.json` for the deck `pptx` (see the module docstring): `exported` are the
    variants exported ok now, `attempted` every variant tried now (a failed one loses its entry). `powerpoint` is
    the version to record; without `version_known` it is read from the registry."""
    pptx, out_dir = Path(pptx), Path(out_dir)
    stem = pptx.stem
    deck = _file_record(pptx)
    manifest = _file_record(pptx.with_name(f"{stem}.manifest.json"))
    version = powerpoint if version_known else powerpoint_version()
    path = stamp_path(out_dir, stem)
    try:
        old = read_stamp(path)
    except (OSError, ValueError):
        old = None
    entries = {}
    if old and old.get("pptx") == deck and old.get("manifest") == manifest:
        for variant, entry in old["variants"].items():
            pdf = out_dir / str((entry or {}).get("file", ""))
            if variant not in attempted and pdf.is_file() and _sha256(pdf) == entry.get("sha256"):
                entries[variant] = entry
    for variant in exported:
        pdf = out_dir / f"{stem}_{variant}.pdf"
        if pdf.is_file():
            entries[variant] = {"file": pdf.name, "sha256": _sha256(pdf), "powerpoint": version}
    stamp = {"schema": STAMP_SCHEMA, "pptx": deck, "manifest": manifest,
             "variants": {variant: entries[variant] for variant in sorted(entries)}}
    out_dir.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(stamp, indent=2) + "\n")
    return stamp


def stamp_problem(pdf, variant, pptx, manifest):
    """Why the PDF `pdf` (variant `variant`) is not the export its stamp records of the deck `pptx` and the manifest
    `manifest` (either may be None: not there); None when it is. The text names public file names only."""
    pdf = Path(pdf)
    stem = pdf.stem[: -len(f"_{variant}")] if pdf.stem.endswith(f"_{variant}") else pdf.stem
    try:
        stamp = read_stamp(stamp_path(pdf.parent, stem))
    except (OSError, ValueError):
        return f"the export stamp {stem}.export.json cannot be read"
    if stamp is None:
        return (f"no export stamp ({stem}.export.json) next to the PDF: export the deck again with "
                "harness.atlas.export")
    want_deck = _file_record(pptx)
    if (stamp.get("pptx") or {}).get("sha256") != (want_deck or {}).get("sha256"):
        return f"the deck {stem}.pptx is not the one the PDFs were exported from: export it again"
    want_manifest = _file_record(manifest)
    if (stamp.get("manifest") or {}).get("sha256") != (want_manifest or {}).get("sha256"):
        return f"the manifest {stem}.manifest.json changed since the PDFs were exported: export the deck again"
    entry = stamp["variants"].get(variant)
    if not isinstance(entry, dict):
        return f"the export stamp has no {variant} PDF: export that variant again"
    if not pdf.is_file() or entry.get("sha256") != _sha256(pdf):
        return f"{pdf.name} is not the PDF the export stamp records: export that variant again"
    return None


def _last_json_line(text):
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


def font_program_info(data, base_font=""):
    """What one embedded font program is: {"family", "typographicFamily", "psName", "fullName", "variable", "tables",
    "numGlyphs"}.

    `variable` is True when the program has an `fvar` table. `family` (the Windows family name, nameID 1, as in
    fonts.lock.json: "Pretendard Light" for Pretendard-Light), `typographicFamily` (nameID 16, else 1: "Pretendard")
    and `psName` (nameID 6) come from the font's `name` table; a subsetter may drop the table, then they fall back to
    `base_font` (the PDF's BaseFont, with its ABCDEF+ subset tag removed). `format` is harness.fonts.program's: a raw
    CFF program (no sfnt wrapper) or a damaged one has no tables to read, only the fallback (and a damaged one its
    `error`, the exception type)."""
    fallback = strip_subset_tag(base_font)
    font = read_program(data)
    info = {"family": font.name(1) or fallback, "typographicFamily": font.name(16) or font.name(1) or fallback,
            "psName": font.name(6) or fallback, "fullName": font.name(4) or "", "variable": font.variable,
            "tables": list(font.tables), "numGlyphs": font.num_glyphs, "format": font.format}
    if font.error:
        info["error"] = font.error
    return info


FONT_FILE = re.compile(r"/(FontFile[23]?)\s+(\d+)\s+\d+\s+R")
FONT_NAME = re.compile(r"/FontName\s*/([^\s/\[\]<>()]+)")


def embedded_fonts(pdf):
    """Every embedded font program of a PDF (the FontFile / FontFile2 / FontFile3 of a FontDescriptor, whether the
    descriptor is an object of its own or written inline in the font), as a list of font_program_info dicts plus
    `baseFont` (the PDF's name for it), `fontFile` (the key that held it) and `bytes` (program size), sorted by
    BaseFont. A program used on several pages is listed once."""
    fonts = {}
    with pymupdf.open(pdf) as doc:
        for xref in range(1, doc.xref_length()):
            text = doc.xref_object(xref, compressed=True)
            if "/FontFile" not in text:
                continue
            for match in FONT_FILE.finditer(text):
                stream_xref = int(match.group(2))
                if stream_xref in fonts:
                    continue
                names = FONT_NAME.findall(text[: match.start()])
                base_font = names[-1] if names else ""
                program = doc.xref_stream(stream_xref)
                info = font_program_info(program, base_font)
                info.update({"baseFont": base_font, "fontFile": match.group(1), "bytes": len(program)})
                fonts[stream_xref] = info
    return sorted(fonts.values(), key=lambda f: f["baseFont"])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Export a deck to the PowerPoint PDF variants (Windows, desktop PowerPoint).")
    parser.add_argument("--pptx", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path, help="output directory")
    parser.add_argument("--variants", default=",".join(VARIANTS), help="comma-separated; default: all six")
    parser.add_argument("--ground-truth", action="store_true", help="also write gt/<stem>/slide<N>.png")
    args = parser.parse_args(argv)
    try:
        result = export(args.pptx, args.out, args.variants.split(","), args.ground_truth)
    except ExportError as exc:
        print(f"export failed: {exc}", file=sys.stderr)
        print(exc.stderr, file=sys.stderr)
        return 3
    print(result.pop("stderr"), file=sys.stderr, end="")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return result["scriptExitCode"]


if __name__ == "__main__":
    sys.exit(main())
