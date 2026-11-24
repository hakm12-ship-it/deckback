"""The Office cloud fonts on this PC, by name (ruling M8-R2).

PowerPoint for Microsoft 365 downloads the Office cloud fonts a deck uses by itself, into
``%LOCALAPPDATA%\\Microsoft\\FontCache\\4\\CloudFonts``: one folder per family (the folder's name is the family, e.g.
``Montserrat``), holding the font files under numeric names. Such a font is obtainable: it is never installed a second
time, because a second copy of another version makes PowerPoint's render differ from the PDF (measured in M8:
``b-553619aef1`` 11 -> 2 passing slides). Before each measurement round the names are recorded in the results'
``options.cloudFonts``, so that a round is reproducible to that snapshot.

* ``snapshot()``: ``{"count": n, "names": [family, ...]}``, names only (no file, no path, no hash), None when the folder
  is not there. It lists a directory; it does not start PowerPoint and never writes.
* ``conflicts(lock, names)``: the families of a font lock that are cloud fonts already, one line each. Ruling M8-R4: the
  cloud copy wins, so ``install-fonts.ps1`` skips such a family and warns (it does not refuse; ``-AllowCloudDuplicates``
  installs it anyway).

  harness/.venv/Scripts/python -m harness.fonts.cloudfonts                  # the snapshot as JSON
  harness/.venv/Scripts/python -m harness.fonts.cloudfonts check [--lock <lock.json>]   # warns of the families the installer will skip

The folder is the one of this user, or ``DECKBACK_CLOUDFONTS`` (a test hook and a way to point at another profile).
"""

import argparse
import json
import os
import sys
from pathlib import Path

ENV = "DECKBACK_CLOUDFONTS"
FONT_SUFFIXES = (".ttf", ".otf", ".ttc", ".otc")
DEFAULT_LOCK = Path(__file__).with_name("fonts-tier-b.lock.json")


def default_dir():
    """The cloud font folder of this user (DECKBACK_CLOUDFONTS when set)."""
    if os.environ.get(ENV):
        return Path(os.environ[ENV])
    base = os.environ.get("LOCALAPPDATA")
    return Path(base) / "Microsoft" / "FontCache" / "4" / "CloudFonts" if base else None


def cloud_families(folder=None):
    """The family names of the cloud fonts in `folder`: its subfolders that hold a font file, sorted; None when there
    is no such folder (no Microsoft 365, or not Windows)."""
    folder = Path(folder) if folder is not None else default_dir()
    if folder is None or not folder.is_dir():
        return None
    names = []
    for entry in folder.iterdir():
        if entry.is_dir() and any(f.suffix.lower() in FONT_SUFFIXES for f in entry.iterdir() if f.is_file()):
            names.append(entry.name)
    return sorted(names, key=str.casefold)


def snapshot(folder=None):
    """{"count", "names"} of the cloud font families (names only), None without the folder."""
    names = cloud_families(folder)
    return None if names is None else {"count": len(names), "names": names}


def conflicts(lock, names):
    """The families of a font lock (a parsed fonts*.lock.json) that are cloud fonts already, one string each, in lock
    order; empty when none is. Names compare without regard to case, as Windows does."""
    cloud = {name.casefold() for name in names or ()}
    return [f"{family['family']}: is an Office cloud font already (M8-R4); the cloud copy wins, a second copy of another "
            "version would make PowerPoint's render differ from the PDF"
            for family in lock["families"] if family["family"].casefold() in cloud]


def main(argv=None):
    parser = argparse.ArgumentParser(description="Names of the Office cloud fonts on this PC (ruling M8-R2).")
    parser.add_argument("command", nargs="?", choices=("snapshot", "check"), default="snapshot")
    parser.add_argument("--lock", type=Path, default=DEFAULT_LOCK, help="the font lock to check (default: tier B's)")
    parser.add_argument("--folder", type=Path, help="the cloud font folder (default: this user's)")
    args = parser.parse_args(argv)
    names = cloud_families(args.folder)
    if args.command == "snapshot":
        print(json.dumps(snapshot(args.folder), indent=1))
        return 0
    problems = conflicts(json.loads(args.lock.read_text(encoding="utf-8")), names)
    for problem in problems:
        print(f"  warning: {problem}", file=sys.stderr)
    if problems:
        print(f"CLOUD FONTS: {len(problems)} family(ies) of the lock will be skipped by the installer (M8-R4)")
        return 0
    print(f"CLOUD FONTS OK: none of the lock's families is among the {len(names or ())} cloud families")
    return 0


if __name__ == "__main__":
    sys.exit(main())
