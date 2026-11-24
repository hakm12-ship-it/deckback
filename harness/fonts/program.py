"""The harness's one reader of embedded font programs (minor m18).

A PDF embeds a font program as the FontFile / FontFile2 / FontFile3 stream of a font descriptor. Three users read it:
harness/atlas/export.py (the export's font report), harness/atlas/corpuscheck.py (the public corpus gate) and
harness/fidelity/pdf_facts.py (S2's styles and S6's family names). They all go through `read_program`, so a subset
tag, a missing name table, a bare CFF program or a damaged one is handled the same way everywhere, and never raises.

    read_program(data) -> FontProgram(format, tables, names, num_glyphs, error)

`format` is
- "sfnt": a TrueType or OpenType program (its tables and names are read);
- "raw-cff-or-type1": a program without an sfnt wrapper, as FontFile3 / FontFile hold a bare CFF or Type 1 font
  (nothing to read: no tables, no names);
- "damaged": an sfnt program fontTools cannot read; `error` is the exception's type name (never its text);
- "empty": no program at all.

Names (`FontProgram.name(name_id)`) come from the Windows English record (3, 1, 0x409), else any Windows record,
else the Mac Roman English record (1, 0, 0), else any record with that id: Windows and PowerPoint go by the Windows
records (the Mac record of NanumGothic-ExtraBold says "NanumGothic"). `FontProgram.families` holds every nameID 1
record, in every language, in that order (ruling M3-R44: S6 accepts a typeface that is any of them).
"""

import io
import re
from pathlib import Path
from dataclasses import dataclass, field

SUBSET_TAG = re.compile(r"^[A-Z]{6}\+")
SFNT_MAGICS = (b"\x00\x01\x00\x00", b"true", b"OTTO", b"ttcf")
NAME_IDS = (1, 2, 4, 6, 16, 17)  # family, subfamily, full name, PostScript name, typographic family and subfamily
WINDOWS, MAC = 3, 1


def strip_subset_tag(name):
    """A PDF font name without its ABCDEF+ subset tag; '' for None."""
    return SUBSET_TAG.sub("", name or "")


@dataclass(frozen=True)
class FontProgram:
    format: str
    tables: tuple = ()
    names: dict = field(default_factory=dict)
    num_glyphs: int = None
    error: str = None
    # every nameID 1 record, in every language and platform, each name once, in `_name`'s order (the Windows English
    # record first): the font's family under all its names ("Malgun Gothic", "맑은 고딕"; ruling M3-R44, S6)
    families: tuple = ()
    # OS/2 fsSelection (bit 0 italic, bit 5 bold), None without an OS/2 table (M8-R13: the style of a font whose names a
    # producer rewrote to the subset tag)
    fs_selection: int = None

    def name(self, name_id):
        return self.names.get(name_id)

    @property
    def family_name(self):
        """The font's family (nameID 1), but for a number alone (PowerPoint's name of a font it embedded in a deck:
        `1`, `2`) the family the converter writes for it (`numbered_family`, M8 round 1c)."""
        own = self.name(1)
        derived = numbered_family(own, self.name(2), self.name(4), self.name(6), self.name(16), self.name(17))
        return own if derived is None else derived

    @property
    def family_names(self):
        """`families` with a number-alone name replaced by `family_name` (first) and numbers dropped."""
        own = self.name(1)
        if own is None or self.family_name == own:
            return self.families
        return (self.family_name,) + tuple(f for f in self.families if not _NUMBER.match(f))

    @property
    def variable(self):
        """A variable font (it has an `fvar` table)."""
        return "fvar" in self.tables


# ---- M8 round 1c: the family of a font whose family name is a number (names.ts numberedFamily) --------------------

_NUMBER = re.compile(r"^\s*[0-9]+\s*$")
_PLAIN_WEIGHT = re.compile(r"^(?:regular|normal|book|roman|plain|bold)?$", re.I)
_STYLE_SUFFIX = re.compile(
    r"^(.+?)[,-]?((?:Thin|Hairline|ExtraLight|UltraLight|SemiLight|DemiLight|Light|Regular|Normal|Book|Roman|Plain|"
    r"Medium|SemiBold|DemiBold|ExtraBold|UltraBold|Bold|Black|Heavy)?(?:Italic|Oblique)?)$", re.I)
_ITALIC_END = re.compile(r"\s*(?:italic|oblique)\s*$", re.I)
_PS_CACHE = {}


def _weight_of(style):
    """A weight of a style (nameID 2 or 17) without its slope; None for the regular weight and bold."""
    weight = _ITALIC_END.sub("", style or "").strip()
    return None if _PLAIN_WEIGHT.match(weight) else weight


def _usable(name):
    return None if name is None or name.strip() == "" or _NUMBER.match(name) else name.strip()


def _ps_tables():
    if not _PS_CACHE:
        from harness.fonts import ps_family
        table = ps_family.parse_ts(ps_family.DEFAULT_TS.read_text(encoding="utf-8"))
        families = {family for family, _ in table.values()}
        spaceless = {}
        for family in sorted(families):
            bare = family.replace(" ", "")
            if bare != family and bare not in families and bare not in spaceless:
                spaceless[bare] = family
        _PS_CACHE.update(table=table, families=families, spaceless=spaceless)
    return _PS_CACHE


def _family_of_postscript(name):
    """The family of the PostScript-name table (names.ts familyOfPostScript, family only); None when unknown."""
    tables = _ps_tables()
    table, families, spaceless = tables["table"], tables["families"], tables["spaceless"]

    def look_up(n):
        if n in table:
            return table[n][0]
        hyphened = n.replace("-", " ")
        if n in families:
            return n
        return spaceless.get(n) or (hyphened if hyphened in families else None)

    bare = SUBSET_TAG.sub("", name)
    if bare == "":
        return None
    whole = look_up(bare)
    if whole is not None:
        return whole
    m = _STYLE_SUFFIX.match(bare)
    if m is None or m.group(2) == "":
        return None
    base = look_up(m.group(1))
    if base is None:
        return None
    weight = re.sub(r"(?:italic|oblique)$", "", m.group(2), flags=re.I)
    if not _PLAIN_WEIGHT.match(weight):
        folded = {}
        for f in sorted(families):
            folded.setdefault(f.lower(), f)
        return folded.get(f"{base} {weight}".lower(), base)
    return base


def numbered_family(family, subfamily, full, postscript, typo_family, typo_subfamily):
    """names.ts `numberedFamily` (M8 round 1a), ported: the family of a font whose family name (nameID 1) is a number
    alone (PowerPoint's name for a font it embedded in a deck), from its other names, in this order: nameID 16 (+ the
    weight of nameID 17 unless regular or bold), nameID 4 without the number before and nameID 2 after it, nameID 6
    (through the PostScript-name table, else without its style suffix, a non-plain weight kept). None for a family
    that is no number, or where no name that is not a number is found."""
    if family is None or not _NUMBER.match(family):
        return None
    typo = _usable(typo_family)
    if typo is not None:
        weight = _weight_of(typo_subfamily)
        return typo if weight is None else f"{typo} {weight}"
    number = family.strip()
    text = (full or "").strip()
    if text.startswith(number):
        text = text[len(number):].strip()
    style = (subfamily or "").strip()
    if style != "" and text.lower().endswith(style.lower()):
        text = text[:len(text) - len(style)].strip()
    from_full = _usable(text)
    if from_full is not None:
        return from_full
    ps = _usable(postscript)
    if ps is None:
        return None
    known = _family_of_postscript(ps)
    if known is not None:
        return known
    m = _STYLE_SUFFIX.match(ps)
    if m is None or m.group(2) == "":
        return ps
    weight = _weight_of(m.group(2))
    base = m.group(1)
    return _usable(base if weight is None else f"{base} {weight}")


def _every_name(table, name_id):
    """Every readable record of `name_id`, each text once: the Windows English record first, then the other Windows
    records, then the Mac Roman English record, then the rest (in the name table's order within each rank)."""
    records = [record for record in table.names if record.nameID == name_id]
    ranked = sorted(records, key=lambda r: (
        not (r.platformID == WINDOWS and r.platEncID == 1 and r.langID == 0x409),
        r.platformID != WINDOWS,
        not (r.platformID == MAC and r.platEncID == 0 and r.langID == 0),
    ))
    out = []
    for record in ranked:
        try:
            text = record.toUnicode()
        except UnicodeDecodeError:
            continue
        if text not in out:
            out.append(text)
    return out


def _name(table, name_id):
    found = _every_name(table, name_id)
    return found[0] if found else None


def read_program(data):
    """What the font program `data` (bytes, or None) is: see the module docstring. Never raises for any bytes."""
    if not data:
        return FontProgram("empty")
    if bytes(data[:4]) not in SFNT_MAGICS:
        return FontProgram("raw-cff-or-type1")
    from fontTools.ttLib import TTFont

    font = None
    try:
        # fontTools reads lazily: a damaged table fails only when it is read, so all reading is inside the guard.
        font = TTFont(io.BytesIO(bytes(data)), lazy=True, fontNumber=0)
        tables = tuple(sorted(font.keys()))
        names, families = {}, ()
        if "name" in font:
            table = font["name"]
            names = {name_id: value for name_id in NAME_IDS if (value := _name(table, name_id)) is not None}
            families = tuple(_every_name(table, 1))
        num_glyphs = int(font["maxp"].numGlyphs) if "maxp" in font else None
        fs_selection = int(font["OS/2"].fsSelection) if "OS/2" in font else None
        return FontProgram("sfnt", tables, names, num_glyphs, families=families, fs_selection=fs_selection)
    except Exception as exc:  # any damage: reported, never raised (the callers report it as a problem or a None)
        return FontProgram("damaged", error=type(exc).__name__)
    finally:
        if font is not None:
            font.close()


# ---- M8 ruling R8: which fonts are symbol fonts (one list with the converter: symbol-families.ts) ---------------------

SYMBOL_FAMILIES_TS = Path(__file__).resolve().parents[2] / "packages" / "core" / "src" / "fonts" / "symbol-families.ts"
_SYMBOL_STYLE_TAIL = re.compile(r"[,-](?:regular|bold|italic|oblique|bolditalic|boldoblique|roman|normal)$", re.I)
_SYMBOL_KEYS = []


def symbol_families():
    """The symbol font families of the converter's list (packages/core/src/fonts/symbol-families.ts, the quoted names
    between its SYMBOL-FAMILIES markers): the ONE list; converter and S2 both read it."""
    text = SYMBOL_FAMILIES_TS.read_text(encoding="utf-8")
    block = text.split("// SYMBOL-FAMILIES-BEGIN", 1)[1].split("// SYMBOL-FAMILIES-END", 1)[0]
    return re.findall(r"^\s*'([^']+)',\s*$", block, re.M)


def _symbol_key(name):
    return re.sub(r"[^a-z0-9]", "", name.lower())


def is_symbol_family(name):
    """symbol-families.ts `isSymbolFamily`: whether a family or PostScript name (subset tag and style taken off) is one
    of the symbol families."""
    if not name:
        return False
    if not _SYMBOL_KEYS:
        _SYMBOL_KEYS.append({_symbol_key(f) for f in symbol_families()})
    bare = SUBSET_TAG.sub("", name)
    for _ in range(3):
        if not _SYMBOL_STYLE_TAIL.search(bare):
            break
        bare = _SYMBOL_STYLE_TAIL.sub("", bare)
    return _symbol_key(bare) in _SYMBOL_KEYS[0]


def symbol_cmap(data, basefont="", flagged=False):
    """{code: glyph id} of the Windows Symbol (3,0) cmap subtable of an sfnt program (a symbol font: Wingdings,
    Symbol, ...; its codes are U+F000 + the font's code). Ruling M8-R8, as the converter's readSymbolCmap: only when the
    family (the PDF's `basefont`, or the program's nameID 1 or 16) is a known symbol family AND the font is `flagged`
    symbolic or has no Unicode subtable ((0,*), (3,1), (3,10)). None for any other program and for a damaged one; never
    raises."""
    if not data or bytes(data[:4]) not in SFNT_MAGICS:
        return None
    from fontTools.ttLib import TTFont

    font = None
    try:
        font = TTFont(io.BytesIO(bytes(data)), lazy=True, fontNumber=0)
        subtables = {(t.platformID, t.platEncID): t for t in font["cmap"].tables}
        unicode_keys = ((0, 0), (0, 1), (0, 2), (0, 3), (0, 4), (0, 6), (3, 1), (3, 10))
        if (3, 0) not in subtables or (not flagged and any(key in subtables for key in unicode_keys)):
            return None
        names = [basefont]
        try:
            records = font["name"].names
        except Exception:  # no name table: the PDF's BaseFont alone says
            records = []
        for record in records:
            if record.nameID in (1, 16):
                try:
                    names.append(record.toUnicode())
                except Exception:
                    pass
        if not any(is_symbol_family(n) for n in names):
            return None
        return {code: font.getGlyphID(name) for code, name in subtables[(3, 0)].cmap.items()}
    except Exception:
        return None
    finally:
        if font is not None:
            font.close()
