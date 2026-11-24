"""Font versions: the PDF's embedded font against the copy of the same font on the measuring PC (ruling M8-R9).

A tier-B PDF embeds the font the author's PowerPoint used. When this PC has the same font (installed, or an Office cloud
font) in another version, PowerPoint lays the text out with the PC's version while the PDF was laid out with the
embedded one, so the reference (V1: the source deck re-laid on this PC) is off the PDF however well the converter
copies the PDF. Such a slide is the spec 5.5 "measuring PC differs" case: it is judged by V2 and counted
(``fontException: "font-version"``).

* ``program_version(data)``: ``{"ps", "family", "subfamily", "version", "revision"}`` of a font program (nameID 6, 16 or
  1, 17 or 2, 5, and the ``head`` table's ``fontRevision``), None when the program cannot be read. Names and versions
  only: no glyph, no table bytes.
* ``pc_index(...)``: the same for every font file on this PC (the font registry's files and the cloud font folder),
  keyed by PostScript name and by family; ``PcFonts.versions_of(embedded)`` lists the versions of the PC's copies of an
  embedded font (the PostScript name first, else its family).
* ``differing(embedded_fonts, pc)``: the embedded fonts that this PC has in another version: the string in nameID 5 or
  the revision differs from every one of the PC's copies, **and** the advance widths differ (see below). A font the PC
  does not have is not in the list (that is the commercial/missing case, not this one).
* Advance widths: Office ships patch-level bumps of Arial (7.05 -> 7.06) and Calibri (6.26 -> 6.27) whose glyph advances
  are the same, so PowerPoint lays the text out the same way and the PDF's layout is the source deck's. A version
  difference counts only when the advance of a glyph the PDF uses (its codepoint, in units per 1000 em) differs by more
  than ``ADVANCE_TOLERANCE`` in the PC's copy; when the widths cannot be compared (no cmap, no glyph in common) the font
  is NOT flagged (amended M8-R9) but counted as ``version-unverifiable`` (``differing(..., unverifiable=[])``).
  ``differing(..., widths=False)`` is the literal rule (version only).

  harness/.venv/Scripts/python -m harness.fonts.fontversion page <pdf> <page index>   # versions of the page's fonts

``page`` prints names and versions only (JSON), so it may run on a tier-B deck; it never writes.
"""

import io
import json
import os
import sys
from functools import lru_cache
from pathlib import Path

from harness.fonts import cloudfonts

REVISION_DIGITS = 3
ADVANCE_TOLERANCE = 1.0  # units per 1000 em: advances that differ by more make the text lay out differently
MAX_ADVANCES = 4000  # codepoints kept per font
MAX_NAME = 128  # a name longer than this is not a font name


def _text(table, name_id):
    """The Windows English record of `name_id`, else any Windows record, else the Mac record, else any."""
    for platform, encoding, language in ((3, 1, 0x409), (1, 0, 0)):
        record = table.getName(name_id, platform, encoding, language)
        if record is not None:
            return _clean(record.toUnicode())
    for platform in (3, 1):
        for record in table.names:
            if record.nameID == name_id and record.platformID == platform:
                return _clean(record.toUnicode())
    for record in table.names:
        if record.nameID == name_id:
            return _clean(record.toUnicode())
    return None


def _clean(text):
    text = (text or "").strip()
    return text[:MAX_NAME] if text else None


def _advances(font):
    """{codepoint: advance in units per 1000 em} of the glyphs of `font` that draw something (or are a space), through
    its best Unicode cmap; {} when it has none or cannot be read."""
    try:
        cmap = font.getBestCmap() or {}
        upm = float(font["head"].unitsPerEm) or 1000.0
        metrics = font["hmtx"].metrics
        glyf = font["glyf"] if "glyf" in font else None
        out = {}
        for code, name in sorted(cmap.items()):
            if name not in metrics or len(out) >= MAX_ADVANCES:
                continue
            if glyf is not None and name in glyf.keys() and glyf[name].numberOfContours == 0 and code not in (0x20, 0xA0):
                continue  # an emptied glyph of a subset: its advance is no fact
            out[code] = round(metrics[name][0] * 1000.0 / upm, 1)
        return out
    except Exception:
        return {}


def _facts(font):
    table = font["name"]
    revision = None
    if "head" in font:
        revision = round(float(font["head"].fontRevision), REVISION_DIGITS)
    return {"ps": _text(table, 6), "family": _text(table, 16) or _text(table, 1),
            "subfamily": _text(table, 17) or _text(table, 2), "version": _text(table, 5), "revision": revision}


def program_version(data, advances=False):
    """The version facts of an embedded font program (bytes), or None (no sfnt, damaged, no name table); with
    `advances` also ``advances`` (``_advances``: what the program's glyphs advance, to compare with the PC's copy)."""
    from harness.fonts.program import SFNT_MAGICS

    if not data or bytes(data[:4]) not in SFNT_MAGICS:
        return None
    try:
        from fontTools.ttLib import TTFont

        font = TTFont(io.BytesIO(data), lazy=True, fontNumber=0)
        try:
            facts = _facts(font)
            if advances:
                facts["advances"] = {str(k): v for k, v in _advances(font).items()}
            return facts
        finally:
            font.close()
    except Exception:
        return None


def file_versions(path):
    """The version facts of every font in the file at `path` ([] for a file that cannot be read)."""
    try:
        from fontTools.ttLib import TTCollection, TTFont

        if str(path).lower().endswith((".ttc", ".otc")):
            fonts = TTCollection(str(path), lazy=True).fonts
        else:
            fonts = [TTFont(str(path), lazy=True)]
        found = []
        for number, font in enumerate(fonts):
            try:
                found.append({**_facts(font), "path": str(path), "number": number})
            finally:
                font.close()
        return found
    except Exception:
        return []


def same_version(embedded, pc):
    """Whether two version facts are one version: every field both have (the nameID 5 string, the head revision) is
    equal, and they have at least one in common."""
    compared = False
    for key in ("version", "revision"):
        a, b = embedded.get(key), pc.get(key)
        if a is None or b is None:
            continue
        compared = True
        if a != b:
            return False
    return compared


def _key(text):
    return (text or "").casefold()


class PcFonts:
    """The fonts of a PC by PostScript name and by family, each with its version facts."""

    def __init__(self, facts=()):
        self.by_ps, self.by_family = {}, {}
        for item in facts:
            if item.get("ps"):
                self.by_ps.setdefault(_key(item["ps"]), []).append(item)
            if item.get("family"):
                self.by_family.setdefault(_key(item["family"]), []).append(item)

    def versions_of(self, embedded):
        """The PC's copies of an embedded font: those with its PostScript name, else those of its family; [] when the
        PC has neither."""
        found = self.by_ps.get(_key(embedded.get("ps"))) if embedded.get("ps") else None
        return list(found or self.by_family.get(_key(embedded.get("family")), []))


@lru_cache(maxsize=64)
def _file_advances(path, number):
    from fontTools.ttLib import TTCollection, TTFont

    try:
        if str(path).lower().endswith((".ttc", ".otc")):
            font = TTCollection(str(path), lazy=True).fonts[number]
        else:
            font = TTFont(str(path), lazy=True)
        try:
            return _advances(font)
        finally:
            font.close()
    except Exception:
        return {}


def copy_advances(copy):
    """{codepoint (int): advance} of a PC copy: its own ``advances`` (a fixture, keys may be strings), else read from
    its file."""
    if copy.get("advances") is not None:
        return {int(k): v for k, v in copy["advances"].items()}
    if copy.get("path"):
        return _file_advances(copy["path"], copy.get("number", 0))
    return {}


def layout_differs(embedded, copy):
    """Whether the PC's `copy` advances a glyph that the embedded font uses by more than ADVANCE_TOLERANCE; None when
    the two have no codepoint in common to compare (the font is then version-unverifiable: ``differing``)."""
    mine = {int(k): v for k, v in (embedded.get("advances") or {}).items()}
    theirs = copy_advances(copy)
    common = [code for code in mine if code in theirs]
    if not common:
        return None
    return any(abs(mine[code] - theirs[code]) > ADVANCE_TOLERANCE for code in common)


def differing(embedded_fonts, pc, widths=True, unverifiable=None):
    """The embedded fonts (version facts, None entries skipped) that the PC has only in another version (and, with
    `widths`, whose advances differ there: module docstring). Amended M8-R9: a font whose advances cannot be compared
    (none read, or no glyph in common with any copy) is not flagged on its version string alone; it is appended to the
    list `unverifiable` (when given) and counted as ``version-unverifiable`` by the callers. ``widths=False`` is the
    literal version-only rule."""
    out = []
    for embedded in embedded_fonts:
        if not embedded:
            continue
        copies = pc.versions_of(embedded)
        if not copies or any(same_version(embedded, copy) for copy in copies):
            continue
        if widths:
            verdicts = [layout_differs(embedded, copy) for copy in copies] if embedded.get("advances") else [None]
            if all(v is None for v in verdicts):  # nothing to compare: not an exception, counted on its own
                if unverifiable is not None:
                    unverifiable.append(embedded)
                continue
            if not any(v is True for v in verdicts):  # every comparable copy lays the used glyphs out the same
                continue
        out.append(embedded)
    return out


def needs_advances(embedded, pc):
    """Whether the version facts of `embedded` should carry advances: the PC has it only in another version."""
    copies = pc.versions_of(embedded)
    return bool(copies) and not any(same_version(embedded, copy) for copy in copies)


def pc_font_files(cloud_folder=None):
    """Every font file of this PC: the font registry's files (HKLM and HKCU) and the files of the cloud font folder."""
    files = []
    try:
        from harness.fonts.fontcheck import _registry_font_files

        files += _registry_font_files()
    except Exception:  # not Windows
        pass
    folder = Path(cloud_folder) if cloud_folder is not None else cloudfonts.default_dir()
    if folder is not None and folder.is_dir():
        for entry in folder.rglob("*"):
            if entry.is_file() and entry.suffix.lower() in cloudfonts.FONT_SUFFIXES:
                files.append(str(entry))
    return files


@lru_cache(maxsize=1)
def pc_index():
    """The fonts of this PC (``pc_font_files``), read once per process."""
    seen, facts = set(), []
    for path in pc_font_files():
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            facts += file_versions(path)
    return PcFonts(facts)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 3 or argv[0] != "page" or not argv[2].isdigit():
        print("usage: python -m harness.fonts.fontversion page <pdf> <page index>", file=sys.stderr)
        return 2
    from harness.fidelity import pdf_facts

    embedded = pdf_facts.page_embedded_versions(argv[1], int(argv[2]))
    pc = pc_index()
    report = [{"embedded": e, "pc": [{k: c.get(k) for k in ("ps", "version", "revision")} for c in pc.versions_of(e)]}
              for e in embedded]
    print(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
