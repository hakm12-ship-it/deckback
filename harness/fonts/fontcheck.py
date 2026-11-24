"""Check that the free (OFL) fonts listed in fonts.lock.json are installed on this PC.

Public test decks and PDFs may embed only these fonts (never Microsoft fonts such as Malgun Gothic), so a build that
needs them must stop when one is missing instead of letting PowerPoint fall back to a Windows font.

  harness/.venv/Scripts/python -m harness.fonts.fontcheck [--lock <fonts.lock.json>]

prints `FONTS OK <n> families` (exit 0) or `FONTS NOT READY:` and one line per problem on stderr (exit 1).

`missing_ofl` checks every locked file, not only its family (minor m11): an installed font file must have the
file's family name (nameID 1, a Windows record) and PostScript name (nameID 6) and exactly the locked bytes (sha256),
and no other installed font file may have a locked family name (Windows would pick one of the two for the typeface,
and PowerPoint would embed that one). Each problem names the family first. `lock_postscript_names` gives the
PostScript names of the locked files, which an embedded font program in a public PDF must carry (ruling M1-R22).

`winreg` and fontTools are imported inside the functions that need them, so this module (and its unit test) imports
on Linux CI, where `missing_ofl(lock, installed=[InstalledFont, ...])` is given the installed fonts directly.
"""

import argparse
import hashlib
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

DEFAULT_LOCK = Path(__file__).with_name("fonts.lock.json")
FONTS_KEY = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts"
FONT_SUFFIXES = (".ttf", ".otf", ".ttc", ".otc")
NAME_ID_FAMILY = 1
NAME_ID_POSTSCRIPT = 6
PLATFORM_WINDOWS = 3


@dataclass(frozen=True)
class InstalledFont:
    """One installed font file: its family names (nameID 1, Windows records, any language) and PostScript names
    (nameID 6) over every font in it. `digest` is its sha256 when already known; `sha256()` reads the file
    otherwise."""

    path: str
    families: frozenset
    postscript_names: frozenset
    digest: str = None

    def sha256(self):
        if self.digest is not None:
            return self.digest
        digest = hashlib.sha256()
        with open(self.path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        return digest.hexdigest()


def _font_names(font_file):
    """(family names, PostScript names) a font file declares, as Windows and PowerPoint see them; None when the file
    cannot be read.

    Family names come from Windows-platform records only (any language): the Mac-platform record of
    NanumGothic-ExtraBold says "NanumGothic", which would make the ExtraBold file look like a second copy of the
    Regular family. PostScript names from any record.
    """
    from fontTools.ttLib import TTCollection, TTFont

    families, ps_names = set(), set()
    try:
        if font_file.lower().endswith((".ttc", ".otc")):
            fonts = TTCollection(font_file, lazy=True).fonts
        else:
            fonts = [TTFont(font_file, lazy=True)]
        for font in fonts:
            for record in font["name"].names:
                if record.nameID == NAME_ID_FAMILY and record.platformID == PLATFORM_WINDOWS:
                    families.add(record.toUnicode())
                elif record.nameID == NAME_ID_POSTSCRIPT:
                    ps_names.add(record.toUnicode())
            font.close()
    except Exception:
        return None
    return families, ps_names


def _family_names(font_file):
    """The nameID 1 (family) names a font file declares (Windows records, any language); nothing for a file that
    cannot be read."""
    names = _font_names(font_file)
    return names[0] if names is not None else set()


def _registry_font_files(machine=True, user=True):
    """Absolute paths of every font file named in the HKLM (machine: the system fonts) and HKCU (user: per-user
    fonts) font registry keys that exists on disk."""
    import winreg  # Windows only; imported here so the module also imports on Linux CI

    windows_fonts = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts")
    hives = [hive for hive, wanted in ((winreg.HKEY_LOCAL_MACHINE, machine), (winreg.HKEY_CURRENT_USER, user))
             if wanted]
    files = []
    for hive in hives:
        try:
            key = winreg.OpenKey(hive, FONTS_KEY)
        except OSError:
            continue
        with key:
            index = 0
            while True:
                try:
                    _name, data, _type = winreg.EnumValue(key, index)
                except OSError:
                    break
                index += 1
                if not isinstance(data, str) or not data.lower().endswith(FONT_SUFFIXES):
                    continue
                path = os.path.expandvars(data)
                if not os.path.isabs(path):  # HKLM lists bare file names, relative to %WINDIR%\Fonts
                    path = os.path.join(windows_fonts, path)
                if os.path.isfile(path):  # a registry entry whose file is gone is stale: it does not count
                    files.append(path)
    return files


def installed_fonts(paths=None):
    """An InstalledFont for every readable font file in `paths` (default: every file the HKLM and HKCU font registry
    keys name; Windows only). A path listed twice is one file."""
    if paths is None:
        paths = _registry_font_files()
    fonts, seen = [], set()
    for path in paths:
        key = os.path.normcase(os.path.abspath(path))
        if key in seen:
            continue
        seen.add(key)
        names = _font_names(path)
        if names is not None:
            fonts.append(InstalledFont(path, frozenset(names[0]), frozenset(names[1])))
    return fonts


def installed_families():
    """The set of family names (nameID 1) of every font installed for this user or for all users."""
    return {name for font in installed_fonts() for name in font.families}


def missing_ofl(lock_path=DEFAULT_LOCK, installed=None):
    """Why the lock's fonts are not ready on this PC, one problem per string, each starting with "<family>: ", in
    lock-file order (empty list: every locked file is installed, and alone):

    - "<family>: <file> is not installed": no installed font file has the file's family name and PostScript name;
    - "<family>: <file> is installed with other bytes (...)": one has, but not the locked bytes (sha256);
    - "<family>: <name>, a font file outside the lock, has this family name too (...)": Windows resolves a typeface
      to one of the files with that family name, so PowerPoint might embed the other one.

    `installed` is a list of InstalledFont; the default reads this PC (Windows only). Family names compare without
    regard to case, as Windows does. The lock's `retired` files are not looked for.
    """
    lock = json.loads(Path(lock_path).read_text(encoding="utf-8"))
    if installed is None:
        installed = installed_fonts()
    problems = []
    for fam in lock["families"]:
        name = fam["family"]
        same_family = [font for font in installed if name.casefold() in {f.casefold() for f in font.families}]
        locked, reported = {f["sha256"] for f in fam["files"]}, set()
        for f in fam["files"]:
            candidates = [font for font in same_family if f["postscriptName"] in font.postscript_names]
            if not candidates:
                problems.append(f"{name}: {f['file']} is not installed")
            elif not any(font.sha256() == f["sha256"] for font in candidates):
                problems.append(f"{name}: {f['file']} is installed with other bytes (sha256 differs from the lock)")
                reported |= {font.path for font in candidates}
        for font in same_family:
            if font.sha256() not in locked and font.path not in reported:
                problems.append(f"{name}: {Path(font.path).name}, a font file outside the lock, has this family name "
                                "too (Windows may use it instead)")
    return problems


def lock_postscript_names(lock_path=DEFAULT_LOCK):
    """The PostScript names (name table nameID 6) of every font file in the lock (ruling M1-R22).

    An embedded font program in a public PDF must carry one of these names once its ABCDEF+ subset tag is removed.
    The lock carries them because CI has no fonts installed to read them from. The `retired` files are not included.
    """
    lock = json.loads(Path(lock_path).read_text(encoding="utf-8"))
    names = set()
    for fam in lock["families"]:
        for f in fam["files"]:
            if not f.get("postscriptName"):
                raise ValueError(f"lock entry without a postscriptName: {f.get('file')}")
            names.add(f["postscriptName"])
    return names


def main(argv=None):
    parser = argparse.ArgumentParser(description="Check that the OFL fonts in fonts.lock.json are installed.")
    parser.add_argument("--lock", default=str(DEFAULT_LOCK), help="path to fonts.lock.json")
    args = parser.parse_args(argv)

    problems = missing_ofl(args.lock)
    if problems:
        print("FONTS NOT READY:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        print("run harness/fonts/install-fonts.ps1 to install the locked files (no admin needed); remove or rename "
              "an installed twin outside the lock", file=sys.stderr)
        return 1
    total = len(json.loads(Path(args.lock).read_text(encoding="utf-8"))["families"])
    print(f"FONTS OK {total} families")
    return 0


if __name__ == "__main__":
    sys.exit(main())
