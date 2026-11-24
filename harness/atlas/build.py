"""Build the feature-atlas test decks with python-pptx.

  harness/.venv/Scripts/python -m harness.atlas.build --deck <recipe> --fonts ofl|windows --out <dir>

writes `<dir>/<deck>.pptx` and `<dir>/<deck>.manifest.json` for the recipe's decks (atlas, atlas-smoke, probe, or the
four sizes decks; harness/atlas/decks.py). PowerPoint later exports the decks to PDF (harness/atlas/export.py), so
every test PDF is a genuine PowerPoint export.

--fonts ofl uses only the OFL families of harness/fonts/fonts.lock.json. It first checks that every locked file is
installed, with its bytes and without a twin outside the lock (fontcheck.missing_ofl), and exits 3, naming the
families, before writing anything: PowerPoint would otherwise substitute a Windows font and put Microsoft font subsets
into public PDFs. --fonts windows (Malgun Gothic, Batang, Gulim) skips the check and
may write only into out/, corpus/private/ or the system temp directory (tests); every other location, above all
corpus/generated/, is refused.

Exit codes: 0 built, 2 usage error, 3 OFL fonts not ready or not checkable (nothing written).
"""

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

from harness.atlas import decks
from harness.fonts import fontcheck

REPO_ROOT = Path(__file__).resolve().parents[2]
PUBLIC_CORPUS = REPO_ROOT / "corpus" / "generated"
WINDOWS_FONT_ROOTS = (REPO_ROOT / "out", REPO_ROOT / "corpus" / "private")  # plus tempfile.gettempdir()
EXIT_USAGE = 2
EXIT_FONTS = 3


def _inside(path, root):
    path_s = os.path.normcase(str(Path(path).resolve()))
    root_s = os.path.normcase(str(Path(root).resolve()))
    return path_s == root_s or path_s.startswith(root_s + os.sep)


def windows_output_allowed(out):
    """True when a --fonts windows deck may be written to `out`: inside out/, corpus/private/ or the system temp
    directory, and never inside corpus/generated/ (checked first, in case the checkout itself lives in temp)."""
    if _inside(out, PUBLIC_CORPUS):
        return False
    return any(_inside(out, root) for root in (*WINDOWS_FONT_ROOTS, Path(tempfile.gettempdir())))


def check_ofl_fonts():
    """None when every lock-file font is installed (each locked file, with no twin outside the lock: fontcheck's
    missing_ofl, minor m11), else the message to print. Each problem names its family."""
    try:
        problems = fontcheck.missing_ofl(fontcheck.DEFAULT_LOCK)
    except (ImportError, OSError) as exc:
        return (f"cannot check the installed fonts on this PC ({type(exc).__name__}); an --fonts ofl build needs "
                "Windows with the OFL fonts installed. Nothing was written.")
    if problems:
        return ("OFL FONTS NOT READY: " + "; ".join(problems) + ". Nothing was written; install the locked files "
                "with harness/fonts/install-fonts.ps1 (no admin needed) and remove any twin outside the lock.")
    return None


def write_manifest(path, manifest):
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    Path(path).write_bytes(text.encode("utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Build the feature-atlas decks (python-pptx authoring only).")
    parser.add_argument("--deck", required=True, choices=sorted(decks.RECIPES), help="deck recipe")
    parser.add_argument("--fonts", required=True, choices=("ofl", "windows"), help="font set")
    parser.add_argument("--out", required=True, help="output directory")
    args = parser.parse_args(argv)
    out = Path(args.out)

    if args.fonts == "ofl":
        problem = check_ofl_fonts()
        if problem:
            print(problem, file=sys.stderr)
            return EXIT_FONTS
    elif not windows_output_allowed(out):
        print("--fonts windows decks contain Microsoft fonts: write them only into out/ or corpus/private/ "
              "(or the system temp directory), never into corpus/generated/. Nothing was written.", file=sys.stderr)
        return EXIT_USAGE

    specs = decks.RECIPES[args.deck](args.fonts)
    out.mkdir(parents=True, exist_ok=True)
    for spec in specs:
        deck = decks.build_deck(spec, args.fonts)
        deck.save(out / f"{spec.name}.pptx")
        manifest = deck.manifest()
        write_manifest(out / f"{spec.name}.manifest.json", manifest)
        print(f"{spec.name}: {len(manifest['slides'])} slides ({args.fonts} fonts)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
