import { isSymbolFamily } from './symbol-families';

export interface SfntNames {
  /** nameID 1 of Windows (platformID 3) records, keyed by languageID (0x409 = 1033, 0x412 = 1042, ...). */
  family: Record<number, string>;
  /** nameID 2 of Windows records, keyed by languageID. */
  subfamily: Record<number, string>;
  /** nameID 1 of the Macintosh (platformID 1) Roman English record, or null when there is none. */
  macFamily: string | null;
  /** nameID 2 of the Macintosh Roman English record, or null when there is none. */
  macSubfamily: string | null;
  /** OS/2 fsType (embedding permissions), or null when the font has no OS/2 table. */
  fsType: number | null;
  /**
   * M8 round 1a: nameID 4 (full name), 6 (PostScript name), 16 (typographic family) and 17 (typographic subfamily) of
   * Windows records, keyed by languageID: where a font's own family is, when its nameID 1 is not (`numberedFamily`).
   */
  full: Record<number, string>;
  postscript: Record<number, string>;
  typoFamily: Record<number, string>;
  typoSubfamily: Record<number, string>;
}

/** What `readSfntMetrics` reads, in font units as the tables hold them (a descent in `hhea` and `typo` is negative). */
export interface SfntMetrics {
  /** `head` unitsPerEm. */
  upm: number;
  /** `hhea` ascender, descender and lineGap. */
  hheaAsc: number;
  hheaDesc: number;
  hheaLineGap: number;
  /** `OS/2` usWinAscent and usWinDescent (both unsigned: the descent is below the baseline). */
  winAsc: number;
  winDesc: number;
  /** `OS/2` sTypoAscender, sTypoDescender and sTypoLineGap. */
  typoAsc: number;
  typoDesc: number;
  typoLineGap: number;
  /** `OS/2` fsSelection: its bit 7, USE_TYPO_METRICS, says the typo metrics are the font's line metrics. */
  fsSelection: number;
  /** The font has an `fvar` table: it is a variable font. */
  isVariable: boolean;
}

const TTC_TAG = 0x74746366; // 'ttcf'
const NAME_ID_FAMILY = 1;
const NAME_ID_SUBFAMILY = 2;
const PLATFORM_MAC = 1;
const PLATFORM_WINDOWS = 3;
/** Macintosh encoding 0 (Roman) and language 0 (English). */
const MAC_ROMAN = 0;
const MAC_ENGLISH = 0;
/** Mac Roman bytes 0x80 to 0xFF; 0x00 to 0x7F are ASCII. A table, so that no engine's decoder is needed. */
const MAC_ROMAN_HIGH =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø' +
  '¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';

/** The tables of an sfnt (the first font of a collection), by tag. */
interface Sfnt {
  view: DataView;
  tables: Map<string, { offset: number; length: number }>;
}

function tagOf(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}

/** The longest name read from a font program (M8 I2: a 32 K-character name is hostile), and the longest used as a typeface. */
export const NAME_MAX_REPORT = 256;
export const NAME_MAX_TYPEFACE = 64;

/**
 * A name from untrusted bytes made safe: control characters (C0, DEL, C1) and U+FFFE/U+FFFF stripped, trimmed, and cut to
 * `max` characters (code points, so no surrogate pair is split). Null when nothing is left.
 */
export function capName(name: string, max: number): string | null {
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f￾￿]/g, '').trim();
  const cut = clean.length <= max ? clean : Array.from(clean).slice(0, max).join('').trim();
  return cut === '' ? null : cut;
}

/** A UTF-16BE string of `byteLength` bytes at `start` (a Windows or Unicode name record). */
export function utf16be(view: DataView, start: number, byteLength: number): string {
  let s = '';
  for (let i = 0; i + 1 < byteLength; i += 2) s += String.fromCharCode(view.getUint16(start + i));
  return s;
}

/** A Mac Roman string of `byteLength` bytes at `start` (a Macintosh name record). */
export function macRoman(view: DataView, start: number, byteLength: number): string {
  let s = '';
  for (let i = 0; i < byteLength; i++) {
    const b = view.getUint8(start + i);
    s += b < 0x80 ? String.fromCharCode(b) : MAC_ROMAN_HIGH[b - 0x80]!;
  }
  return s;
}

/** Reads the table directory. Throws a plain Error when the bytes are not an sfnt (e.g. bare CFF or Type 1). */
function readSfnt(bytes: Uint8Array): Sfnt {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12) throw new Error('not an sfnt font: fewer than 12 bytes');

  let base = 0;
  if (view.getUint32(0) === TTC_TAG) {
    if (bytes.length < 16) throw new Error('not an sfnt font: truncated TrueType collection');
    base = view.getUint32(12); // first font of the collection
  }
  if (base + 12 > bytes.length) throw new Error('not an sfnt font: bad collection offset');
  const version = view.getUint32(base);
  const isSfnt = version === 0x00010000 || version === 0x4f54544f /* OTTO */ || version === 0x74727565 /* true */;
  if (!isSfnt) throw new Error(`not an sfnt font: unknown version 0x${version.toString(16)}`);

  const tables = new Map<string, { offset: number; length: number }>();
  const numTables = view.getUint16(base + 4);
  for (let i = 0; i < numTables; i++) {
    const at = base + 12 + 16 * i;
    if (at + 16 > bytes.length) break;
    tables.set(tagOf(view, at), { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return { view, tables };
}

/**
 * Reads the Windows family/subfamily names (and, M8, full, PostScript and typographic names), the Macintosh Roman
 * English family and subfamily, and fsType straight from the font program's own `name` and `OS/2` tables. Throws a plain Error when the bytes are not an sfnt (e.g. bare CFF or Type 1).
 */
export function readSfntNames(bytes: Uint8Array): SfntNames {
  const { view, tables } = readSfnt(bytes);
  const result: SfntNames = { family: {}, subfamily: {}, macFamily: null, macSubfamily: null, fsType: null, full: {}, postscript: {}, typoFamily: {}, typoSubfamily: {} };
  const windows: Record<number, Record<number, string>> = {
    [NAME_ID_FAMILY]: result.family,
    [NAME_ID_SUBFAMILY]: result.subfamily,
    4: result.full,
    6: result.postscript,
    16: result.typoFamily,
    17: result.typoSubfamily,
  };

  const os2 = tables.get('OS/2');
  if (os2 && os2.length >= 10 && os2.offset + 10 <= bytes.length) result.fsType = view.getUint16(os2.offset + 8);

  const name = tables.get('name');
  if (name && name.length >= 6 && name.offset + 6 <= bytes.length) {
    const count = view.getUint16(name.offset + 2);
    const stringBase = name.offset + view.getUint16(name.offset + 4);
    for (let i = 0; i < count; i++) {
      const at = name.offset + 6 + 12 * i;
      if (at + 12 > bytes.length) break;
      const platformID = view.getUint16(at);
      const encodingID = view.getUint16(at + 2);
      const languageID = view.getUint16(at + 4);
      const nameID = view.getUint16(at + 6);
      const length = view.getUint16(at + 8);
      const start = stringBase + view.getUint16(at + 10);
      const records = windows[nameID];
      if (start + length > bytes.length || records === undefined) continue;
      if (platformID === PLATFORM_WINDOWS) {
        const text = capName(utf16be(view, start, Math.min(length, 4 * NAME_MAX_REPORT)), NAME_MAX_REPORT); // M8 I2
        if (text !== null) records[languageID] = text;
      } else if (nameID <= NAME_ID_SUBFAMILY && platformID === PLATFORM_MAC && encodingID === MAC_ROMAN && languageID === MAC_ENGLISH) {
        const text = capName(macRoman(view, start, Math.min(length, 2 * NAME_MAX_REPORT)), NAME_MAX_REPORT);
        if (nameID === NAME_ID_FAMILY) result.macFamily = text;
        else result.macSubfamily = text;
      }
    }
  }
  return result;
}

/** Whether a `cmap` encoding record is a Unicode one: any of the Unicode platform (0), Windows BMP (3, 1) and full (3, 10). */
const isUnicodeEncoding = (platformID: number, encodingID: number): boolean =>
  platformID === 0 || (platformID === PLATFORM_WINDOWS && (encodingID === 1 || encodingID === 10));
/** Windows Symbol: the encoding of a symbol font's `cmap` subtable (3, 0). */
const ENCODING_SYMBOL = 0;
/** The most codes a symbol `cmap` is read for: a symbol font has a few hundred. */
const SYMBOL_CODES_MAX = 0x10000;
/**
 * The most loop iterations a symbol `cmap` subtable is read in (M8 I1): iterations, not entries, since a hostile format 4
 * table (32,767 segments of 0..0xFFFE over a block of zero glyph ids) adds nothing in 2e9 iterations. A real symbol font
 * needs a few hundred; one past this is refused (`readSymbolCmap` throws), and its text is kept as it is.
 */
export const SYMBOL_WORK_MAX = 0x40000;

/** What `readSymbolCmap` needs besides the program's bytes: the PDF's BaseFont and whether its descriptor's Flags say symbolic (bit 3). */
export interface SymbolEvidence {
  baseFont?: string;
  flagged?: boolean;
}

/**
 * A symbol font's own codes (M8 round 1a, gated by ruling R8): the Windows Symbol (3, 0) `cmap` subtable of a font program,
 * as code to glyph id; glyph 0 (`.notdef`) left out. Wingdings, Symbol and the like name a glyph by the font's own code, which
 * such a subtable holds at U+F000 + code. A font is symbolic only when BOTH hold: its family (the PDF's BaseFont without
 * its subset tag, or the program's nameID 1 or 16: `isSymbolFamily`) is a known symbol family, and it is flagged symbolic
 * (`evidence.flagged`) or has no Unicode subtable (platform 0, (3, 1), (3, 10)). The cmap alone is no proof: a text font
 * (Microsoft Sans Serif written by Ghostscript) can hold a (3, 0) subtable. Formats 0, 4, 6 and 12. Null for any other
 * font. Throws a plain Error when the bytes are not an sfnt, when the subtable runs past them, or when reading it takes
 * more than `SYMBOL_WORK_MAX` iterations (a hostile font).
 */
export function readSymbolCmap(bytes: Uint8Array, evidence: SymbolEvidence = {}): Map<number, number> | null {
  const { view, tables } = readSfnt(bytes);
  const cmap = tables.get('cmap');
  if (cmap === undefined || cmap.length < 4 || cmap.offset + 4 > bytes.length) return null;
  const count = view.getUint16(cmap.offset + 2);
  let symbol: number | null = null;
  let unicode = false;
  for (let i = 0; i < count; i++) {
    const at = cmap.offset + 4 + 8 * i;
    if (at + 8 > bytes.length) break;
    const [platformID, encodingID] = [view.getUint16(at), view.getUint16(at + 2)];
    if (isUnicodeEncoding(platformID, encodingID)) unicode = true;
    if (platformID === PLATFORM_WINDOWS && encodingID === ENCODING_SYMBOL && symbol === null) symbol = cmap.offset + view.getUint32(at + 4);
  }
  if (symbol === null || (unicode && evidence.flagged !== true)) return null;
  if (!isSymbolFamily(evidence.baseFont) && !hasSymbolName(bytes)) return null;
  return cmapSubtable(view, symbol);
}

/** Whether the program's own nameID 1 or 16 (any Windows language, or the Macintosh English family) is a symbol family. */
function hasSymbolName(bytes: Uint8Array): boolean {
  const names = readSfntNames(bytes);
  return [...Object.values(names.family), ...Object.values(names.typoFamily), names.macFamily].some(isSymbolFamily);
}

/**
 * A `cmap` subtable at `at` as code to glyph id (formats 0, 4, 6 and 12; glyph 0 left out; at most `SYMBOL_CODES_MAX`
 * codes), null for another format. DataView throws a RangeError for a subtable past the bytes, as a plain Error; so does
 * more than `SYMBOL_WORK_MAX` loop iterations in all.
 */
function cmapSubtable(view: DataView, at: number): Map<number, number> | null {
  const out = new Map<number, number>();
  let work = 0;
  const tick = (): void => {
    if (++work > SYMBOL_WORK_MAX) throw new RangeError('work limit');
  };
  const add = (code: number, glyph: number): void => {
    if (glyph !== 0 && out.size < SYMBOL_CODES_MAX) out.set(code, glyph);
  };
  try {
    const format = view.getUint16(at);
    if (format === 0) {
      for (let c = 0; c < 256; c++) add(c, view.getUint8(at + 6 + c));
    } else if (format === 6) {
      const [first, n] = [view.getUint16(at + 6), view.getUint16(at + 8)];
      for (let i = 0; i < n; i++) {
        tick();
        add(first + i, view.getUint16(at + 10 + 2 * i));
      }
    } else if (format === 12) {
      const groups = view.getUint32(at + 12);
      for (let i = 0; i < groups && out.size < SYMBOL_CODES_MAX; i++) {
        tick();
        const g = at + 16 + 12 * i;
        const [start, end, glyph] = [view.getUint32(g), view.getUint32(g + 4), view.getUint32(g + 8)];
        for (let c = start; c <= end && out.size < SYMBOL_CODES_MAX; c++) {
          tick();
          add(c, glyph + (c - start));
        }
      }
    } else if (format === 4) {
      const segs = view.getUint16(at + 6) / 2;
      const [ends, starts] = [at + 14, at + 16 + 2 * segs];
      const [deltas, offsets] = [starts + 2 * segs, starts + 4 * segs];
      for (let s = 0; s < segs; s++) {
        tick();
        const [end, start] = [view.getUint16(ends + 2 * s), view.getUint16(starts + 2 * s)];
        const [delta, range] = [view.getInt16(deltas + 2 * s), view.getUint16(offsets + 2 * s)];
        for (let c = start; c <= end && c !== 0xffff; c++) {
          tick();
          // idRangeOffset 0: the code plus idDelta; else the glyph array entry it points at, plus idDelta unless 0
          const glyph = range === 0 ? c : view.getUint16(offsets + 2 * s + range + 2 * (c - start));
          add(c, range !== 0 && glyph === 0 ? 0 : (glyph + delta) & 0xffff);
        }
      }
    } else return null;
  } catch (error) {
    throw new Error(`sfnt font's cmap subtable is truncated or too costly (${error instanceof Error ? error.name : 'error'})`);
  }
  return out;
}

/**
 * Reads the vertical metrics of a font program (spec §7: where a text box's top goes) from its `head`, `hhea` and `OS/2`
 * tables (ascents, descents and line gaps, and fsSelection, whose USE_TYPO_METRICS bit says which of them the font's
 * lines follow), and whether it is a variable font (an `fvar` table). Throws a plain Error when the bytes are not an sfnt, or
 * when one of the three tables is missing or too short (an `OS/2` table of 68 bytes, the oldest version, has no typo or
 * win metrics): a font without all of them has no metrics rather than made-up ones.
 */
export function readSfntMetrics(bytes: Uint8Array): SfntMetrics {
  const { view, tables } = readSfnt(bytes);
  const table = (tag: string, length: number): number => {
    const found = tables.get(tag);
    if (found === undefined) throw new Error(`sfnt font has no ${tag} table`);
    if (found.length < length || found.offset + length > bytes.length) throw new Error(`sfnt font's ${tag} table is truncated`);
    return found.offset;
  };
  const head = table('head', 54);
  const hhea = table('hhea', 36);
  const os2 = table('OS/2', 78);
  return {
    upm: view.getUint16(head + 18),
    hheaAsc: view.getInt16(hhea + 4),
    hheaDesc: view.getInt16(hhea + 6),
    hheaLineGap: view.getInt16(hhea + 8),
    winAsc: view.getUint16(os2 + 74),
    winDesc: view.getUint16(os2 + 76),
    typoAsc: view.getInt16(os2 + 68),
    typoDesc: view.getInt16(os2 + 70),
    typoLineGap: view.getInt16(os2 + 72),
    fsSelection: view.getUint16(os2 + 62),
    isVariable: tables.has('fvar'),
  };
}
