/**
 * Small sfnt fonts for tests, so that no font file is needed: a `name` table, the tables `readSfntMetrics` reads, and
 * the sfnt around them. None has outlines; pdf.js cannot use one and falls back to its own font (keeping the name).
 */

/** One `name` record. Windows (3) and Unicode (0) strings are written UTF-16BE, Macintosh (1) ones one byte a character. */
export type NameRecord = [platformID: number, encodingID: number, languageID: number, nameID: number, value: string];

function utf16be(s: string): Uint8Array {
  const out = new Uint8Array(s.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < s.length; i++) view.setUint16(i * 2, s.charCodeAt(i));
  return out;
}

export function nameTable(records: NameRecord[]): Uint8Array {
  const strings = records.map((r) => (r[0] === 1 ? Uint8Array.from(r[4], (c) => c.charCodeAt(0)) : utf16be(r[4])));
  const headLen = 6 + 12 * records.length;
  const total = headLen + strings.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(0, 0); // format 0
  view.setUint16(2, records.length);
  view.setUint16(4, headLen); // stringOffset
  let strOffset = 0;
  records.forEach(([platformID, encodingID, languageID, nameID], i) => {
    const at = 6 + 12 * i;
    const str = strings[i]!;
    view.setUint16(at, platformID);
    view.setUint16(at + 2, encodingID);
    view.setUint16(at + 4, languageID);
    view.setUint16(at + 6, nameID);
    view.setUint16(at + 8, str.length);
    view.setUint16(at + 10, strOffset);
    out.set(str, headLen + strOffset);
    strOffset += str.length;
  });
  return out;
}

/** A minimal sfnt: header, table directory, and the given tables (tags in ascending order). */
export function sfnt(tables: [tag: string, data: Uint8Array][]): Uint8Array {
  const dirEnd = 12 + 16 * tables.length;
  const padded = tables.map(([, d]) => d.length + ((4 - (d.length % 4)) % 4));
  const out = new Uint8Array(dirEnd + padded.reduce((n, l) => n + l, 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, tables.length);
  let offset = dirEnd;
  tables.forEach(([tag, data], i) => {
    const at = 12 + 16 * i;
    for (let c = 0; c < 4; c++) out[at + c] = tag.charCodeAt(c);
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, data.length);
    out.set(data, offset);
    offset += padded[i]!;
  });
  return out;
}

/** `head`: 54 bytes, with `checkSumAdjustment` at offset 8 and `unitsPerEm` at offset 18. */
export function headTable(upm: number, checkSumAdjustment = 0): Uint8Array {
  const out = new Uint8Array(54);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint32(8, checkSumAdjustment);
  view.setUint32(12, 0x5f0f3cf5); // magicNumber
  view.setUint16(18, upm);
  return out;
}

/** `hhea`: 36 bytes, with `ascender`, `descender` and `lineGap` at offsets 4, 6 and 8. */
export function hheaTable(ascender: number, descender: number, lineGap = 0): Uint8Array {
  const out = new Uint8Array(36);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x00010000);
  view.setInt16(4, ascender);
  view.setInt16(6, descender);
  view.setInt16(8, lineGap);
  return out;
}

export interface Os2Fields {
  fsType?: number;
  fsSelection?: number;
  typoAsc?: number;
  typoDesc?: number;
  typoLineGap?: number;
  winAsc?: number;
  winDesc?: number;
  /** usWeightClass. */
  weight?: number;
  /** The 10 PANOSE bytes. */
  panose?: number[];
  /** ulUnicodeRange1 to 4. */
  unicodeRanges?: [number, number, number, number];
  /** ulCodePageRange1 and 2: given, the table is version 1, 86 bytes. */
  codePages?: [number, number];
}

/**
 * `OS/2` version 0, 78 bytes: usWeightClass at 4, fsType at 8, the PANOSE bytes at 32, ulUnicodeRange1 to 4 at 42,
 * fsSelection at 62, sTypoAscender, sTypoDescender and sTypoLineGap at 68, 70 and 72, usWinAscent and usWinDescent at
 * 74 and 76; with `codePages`, version 1, 86 bytes, ulCodePageRange1 and 2 at 78 and 82.
 */
export function os2Table(fields: Os2Fields = {}): Uint8Array {
  const out = new Uint8Array(fields.codePages === undefined ? 78 : 86);
  const view = new DataView(out.buffer);
  if (fields.codePages !== undefined) {
    view.setUint16(0, 1);
    view.setUint32(78, fields.codePages[0]);
    view.setUint32(82, fields.codePages[1]);
  }
  view.setUint16(4, fields.weight ?? 0);
  view.setUint16(8, fields.fsType ?? 0);
  (fields.panose ?? []).forEach((b, i) => view.setUint8(32 + i, b));
  (fields.unicodeRanges ?? []).forEach((r, i) => view.setUint32(42 + 4 * i, r));
  view.setUint16(62, fields.fsSelection ?? 0);
  view.setInt16(68, fields.typoAsc ?? 0);
  view.setInt16(70, fields.typoDesc ?? 0);
  view.setInt16(72, fields.typoLineGap ?? 0);
  view.setUint16(74, fields.winAsc ?? 0);
  view.setUint16(76, fields.winDesc ?? 0);
  return out;
}

export interface TestFont extends Os2Fields {
  /** nameID 1 and 2 records, as `nameTable` writes them. */
  names: NameRecord[];
  upm?: number;
  hheaAsc?: number;
  hheaDesc?: number;
  hheaLineGap?: number;
  /** Adds an (empty) `fvar` table: a variable font. */
  variable?: boolean;
  /** Leaves `OS/2` out. */
  noOs2?: boolean;
}

/** A whole test font: `OS/2`, `fvar` (when variable), `head`, `hhea` and `name`, in tag order. */
export function testFont(font: TestFont): Uint8Array {
  const tables: [string, Uint8Array][] = [];
  if (font.noOs2 !== true) tables.push(['OS/2', os2Table(font)]);
  if (font.variable === true) tables.push(['fvar', new Uint8Array(16)]);
  tables.push(['head', headTable(font.upm ?? 1000)]);
  tables.push(['hhea', hheaTable(font.hheaAsc ?? 0, font.hheaDesc ?? 0, font.hheaLineGap ?? 0)]);
  tables.push(['name', nameTable(font.names)]);
  return sfnt(tables);
}

/**
 * `cmap` with one format 4 subtable mapping A, B and C to glyphs 1 to 3 (and U+0020 to glyph `space`, when given), under
 * each of the encoding records given (platformID, encodingID).
 */
export function cmapTable(records: [platformID: number, encodingID: number][], space?: number): Uint8Array {
  // segments, in ascending order: [start, end, glyph of start]; the last is the 0xFFFF one
  const segs: [number, number, number][] = [...(space === undefined ? [] : [[0x20, 0x20, space] as [number, number, number]]), [0x41, 0x43, 1], [0xffff, 0xffff, 1]];
  return cmapOf(records, segs);
}

/**
 * `cmap` with one format 4 subtable of the segments given (`[start, end, glyph of start]`, ascending; the closing
 * 0xFFFF segment is added), under each of the encoding records given: a symbol font's is `[[3, 0]]` with codes at
 * U+F000 + code.
 */
export function cmapOf(records: [platformID: number, encodingID: number][], ranges: [start: number, end: number, glyph: number][]): Uint8Array {
  const segs: [number, number, number][] = [...ranges, [0xffff, 0xffff, 1]];
  const n = segs.length;
  const sub = new Uint8Array(16 + 8 * n);
  const s = new DataView(sub.buffer);
  s.setUint16(0, 4); // format
  s.setUint16(2, sub.length); // length
  s.setUint16(6, 2 * n); // segCountX2
  segs.forEach(([start, end, glyph], i) => {
    s.setUint16(14 + 2 * i, end); // endCode
    s.setUint16(16 + 2 * n + 2 * i, start); // startCode, after reservedPad
    s.setInt16(16 + 4 * n + 2 * i, glyph - start); // idDelta; idRangeOffset 0
  });
  const headLen = 4 + 8 * records.length;
  const out = new Uint8Array(headLen + sub.length);
  const view = new DataView(out.buffer);
  view.setUint16(2, records.length);
  records.forEach(([platformID, encodingID], i) => {
    view.setUint16(4 + 8 * i, platformID);
    view.setUint16(6 + 8 * i, encodingID);
    view.setUint32(8 + 8 * i, headLen);
  });
  out.set(sub, headLen);
  return out;
}

/** A `cmap` with a (3, 0) format 4 subtable of 32,767 segments, each 0..0xFFFE with an idRangeOffset into one block of zero glyph ids. */
export function hostileCmap(): Uint8Array {
  const segs = 32767;
  const glyphIds = 0xffff; // one shared block of zeros every segment points into
  const sub = new Uint8Array(16 + 8 * segs + 2 * glyphIds);
  const s = new DataView(sub.buffer);
  s.setUint16(0, 4);
  s.setUint16(2, Math.min(sub.length, 0xffff));
  s.setUint16(6, 2 * segs);
  for (let i = 0; i < segs; i++) {
    s.setUint16(14 + 2 * i, 0xfffe); // endCode
    s.setUint16(16 + 2 * segs + 2 * i, 0); // startCode
    s.setUint16(16 + 6 * segs + 2 * i, 2 * (segs - i)); // idRangeOffset: into the block of zeros after the arrays
  }
  const out = new Uint8Array(12 + sub.length);
  const view = new DataView(out.buffer);
  view.setUint16(2, 1);
  view.setUint16(4, 3);
  view.setUint16(6, 0);
  view.setUint32(8, 12);
  out.set(sub, 12);
  return out;
}

/** A short-format `loca`: glyph 0 empty, the others 4 bytes of `glyf` each except those in `empty`. */
function locaTable(glyphs: number, empty: number[]): Uint8Array {
  const out = new Uint8Array(2 * (glyphs + 1));
  const view = new DataView(out.buffer);
  let at = 0;
  for (let g = 0; g < glyphs; g++) {
    view.setUint16(2 * g, at / 2);
    if (g > 0 && !empty.includes(g)) at += 4;
  }
  view.setUint16(2 * glyphs, at / 2);
  return out;
}

export interface TrueTypeFont extends TestFont {
  /** `head` checkSumAdjustment. */
  checkSumAdjustment?: number;
  /** The `cmap` encoding records (`cmapTable`); Windows Unicode BMP (3, 1) when not given. */
  cmap?: [number, number][];
  /** Tables left out. */
  omit?: string[];
  /** The glyph U+0020 maps to (one of 1 to 3, or 0 for .notdef); unmapped when not given. */
  space?: number;
  /** Glyph ids (1 to 3: A, B, C) left without outlines; the others have a 4-byte `glyf` entry. */
  emptyGlyphs?: number[];
  /** An OpenType font with CFF outlines (`OTTO`, a `CFF ` table) instead of TrueType ones (`glyf`, `loca`). */
  cff?: boolean;
}

/**
 * A TrueType program with every table Windows needs to install a font (`OS/2`, `cmap`, `glyf`, `head`, `hhea`, `hmtx`,
 * `loca`, `maxp`, `name`, `post`): four glyphs (.notdef, empty; A, B, C, each with a 4-byte `glyf` entry unless `emptyGlyphs` has it), each 600 units wide. Not a font to draw with;
 * pdf.js falls back to its own and keeps the name.
 */
export function trueTypeFont(font: TrueTypeFont): Uint8Array {
  const glyphs = 4;
  const maxp = new Uint8Array(32);
  new DataView(maxp.buffer).setUint32(0, 0x00010000);
  new DataView(maxp.buffer).setUint16(4, glyphs);
  const hhea = hheaTable(font.hheaAsc ?? 800, font.hheaDesc ?? -200, font.hheaLineGap ?? 0);
  new DataView(hhea.buffer).setUint16(34, glyphs); // numberOfHMetrics
  const hmtx = new Uint8Array(4 * glyphs);
  for (let g = 0; g < glyphs; g++) new DataView(hmtx.buffer).setUint16(4 * g, 600);
  const post = new Uint8Array(32);
  new DataView(post.buffer).setUint32(0, 0x00030000);
  const outlines: [string, Uint8Array][] =
    font.cff === true ? [['CFF ', new Uint8Array(8)]] : [['glyf', new Uint8Array(12)], ['loca', locaTable(glyphs, font.emptyGlyphs ?? [])]];
  const tables: [string, Uint8Array][] = [
    ['OS/2', os2Table(font)],
    ['cmap', cmapTable(font.cmap ?? [[3, 1]], font.space)],
    ['head', headTable(font.upm ?? 1000, font.checkSumAdjustment ?? 0)],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['maxp', maxp],
    ['name', nameTable(font.names)],
    ['post', post],
    ...outlines,
  ];
  const kept = tables.filter(([tag]) => !(font.omit ?? []).includes(tag)).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bytes = sfnt(kept);
  if (font.cff === true) new DataView(bytes.buffer).setUint32(0, 0x4f54544f); // OTTO
  return bytes;
}
