import type { FontStyle } from '@deckback/ooxml';
import { typefaces, type FontMap } from './typefaces';
import { SUBSET_TAG, type FontFile } from '../scene/fonts';
import { macRoman, utf16be } from './sfnt';
import type { FontInfo } from '../scene/types';

/**
 * Font embedding (M4 Task 5, spec §7; `convert`'s `embedFonts`): which of the PDF's own font programs a PPTX may carry,
 * and the form it carries them in.
 *
 * The form, measured in PowerPoint 2024 (16.0, M4 Task 5 report): `ppt/fonts/font<n>.fntdata` is an EOT (W3C EOT
 * submission, 2008), as PowerPoint's own and Windows' `TTEmbedFont` write it: version 2.2, the header little-endian, its
 * names NUL-terminated UTF-16LE, an empty root string whose checksum is 0x50475342. Uncompressed (no MicroType Express)
 * and not XOR-ed: PowerPoint reads that and draws the text in the font (its PDF export shows the font's own glyphs); it
 * draws a raw TrueType part, or an EOT whose root string checksum is 0, in another font. The program goes in as the PDF
 * has it, its checksums unchecked (PowerPoint reads one whose checksums are wrong).
 *
 * What it may carry: a TrueType program (`glyf` outlines) with every table Windows needs to install it and a Unicode
 * `cmap`, whose OS/2 fsType allows it: 0 (installable) or 8 (editable). Restricted (2) and preview & print (4: PowerPoint
 * would open the deck read-only) never, but where more than one of bits 1 to 3 is set the least restrictive applies, as
 * the OpenType spec has it (0x000A is editable). Bitmap-only (0x200) never, alone or with other bits; no subsetting
 * (0x100) never for a subset, which the PDF's program is when its name has a subset tag.
 *
 * And only when every character its runs show maps, through its Unicode `cmap`, to a glyph with outlines (`codePoints`
 * of `trueTypeRefusal`; a blank character may map to an empty glyph): else a PC without the font would draw a blank or
 * the wrong glyph, and the font is `incomplete`. Font bytes go only from the user's PDF into
 * their PPTX (spec §8): never into a log, the report or the repository.
 *
 * Limits of that guard (M4b Task 3):
 * - The characters are those of the slide where the program first comes with a written slide, decided once per program
 *   (`convert`'s `programResults`). The writer puts each font part into the zip as its slide is added, not at the end of
 *   the package, so a character a later slide shows is not checked: the decision cannot wait for the whole deck without
 *   holding every program in memory (spec §7's streaming). A later slide that shows a character the program lacks draws
 *   it in PowerPoint's fallback font on a PC without the font.
 * - Characters never drawn as glyphs, Unicode categories Cc and Cf, need no outlines (`codePointsOf`).
 * - A blank character (a space) may map to an empty glyph, but one the `cmap` does not map at all refuses the font. Measured
 *   on the private corpus, no font was refused for that alone (0 of 44 TrueType programs refused or embedded were
 *   `incomplete`), so it stays a refusal; allowing it would need the PowerPoint test of a line's spaces (0.25 pt).
 *
 * Only the tag says "subset" (M4 Task 6 measured another sign and left it out): the glyphs with outlines are fewer than
 * `maxp.numGlyphs` in every full font too (Times New Roman: 6 of 4,731 empty, its spaces and controls), so that test
 * would call every font a subset; and no share of empty glyphs separates them, as a small re-numbered subset uses most
 * of its glyphs (a Skia export: 69 of 94 with outlines) while an Office export keeps every glyph id and fills under 6 %.
 * So an untagged subset of a no-subsetting (0x100) font would be embedded; every program of the public PDFs is tagged.
 */

/**
 * Why a font of the deck is not embedded in the PPTX; fixed words (the report's `fonts[].pptxEmbedding`):
 * - `not-in-pdf`: the PDF does not embed it;
 * - `type3`: a Type 3 font, whose glyphs are the PDF's own drawings;
 * - `unreadable`: the PDF embeds it, and its program could not be read (an encrypted PDF, a damaged or unfound program);
 * - `not-truetype`: its program has no TrueType outlines: CFF (bare or OpenType), Type 1, or no font at all;
 * - `incomplete`: a TrueType program without a table Windows needs (`TRUETYPE_TABLES`), a Unicode `cmap`, its own
 *   bytes, or a family name to list it by; or one whose `cmap` does not map a character its runs show to a glyph with
 *   outlines (a blank character may map to an empty one);
 * - `fsType-restricted`: OS/2 fsType bit 1, restricted license embedding;
 * - `fsType-preview-print`: fsType bit 2, preview & print, which PowerPoint opens read-only;
 * - `fsType-bitmap-only`: fsType bit 9, bitmap embedding only;
 * - `fsType-no-subsetting`: fsType bit 8, no subsetting, and the PDF's program is a subset;
 * - `same-face`: another font of the deck, first used before it, is embedded as one of its typefaces in its style;
 * - `unused`: no slide that was written uses it (its slides could not be written, ruling M3-R62).
 */
export const FONT_SKIPS = [
  'not-in-pdf',
  'type3',
  'unreadable',
  'not-truetype',
  'incomplete',
  'fsType-restricted',
  'fsType-preview-print',
  'fsType-bitmap-only',
  'fsType-no-subsetting',
  'same-face',
  'unused',
] as const;
export type FontSkip = (typeof FONT_SKIPS)[number];

/** What became of a font with `embedFonts`: embedded, or why not. */
export type FontEmbedding = 'embedded' | FontSkip;

/** The tables Windows needs to install a TrueType font, besides the outlines (`glyf`, `loca`). */
const TRUETYPE_TABLES = ['OS/2', 'cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'post'] as const;
/** The shortest `OS/2` (version 0, 78 bytes) and `head` (54 bytes) the EOT header is read from. */
const OS2_MIN = 78;
const HEAD_MIN = 54;
const OS2_V1 = 86;
/** The shortest `maxp` that holds `numGlyphs`. */
const MAXP_MIN = 6;

const FS_RESTRICTED = 0x0002;
const FS_PREVIEW_PRINT = 0x0004;
const FS_EDITABLE = 0x0008;
const FS_NO_SUBSETTING = 0x0100;
const FS_BITMAP_ONLY = 0x0200;

/** A TrueType program's tables, by tag, each within its bytes. */
interface TrueType {
  view: DataView;
  tables: Map<string, { offset: number; length: number }>;
}

/**
 * The tables of a TrueType program (sfnt version 1.0 or `true`), or why it is not one a PPTX may carry: `not-truetype`
 * for anything without TrueType outlines (a collection included), `incomplete` for one short of a table or a Unicode
 * `cmap`, or with a table past its end.
 */
function readTrueType(bytes: Uint8Array): TrueType | 'not-truetype' | 'incomplete' {
  if (bytes.length < 12) return 'not-truetype';
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  if (version !== 0x00010000 && version !== 0x74727565 /* true */) return 'not-truetype';
  const tables = new Map<string, { offset: number; length: number }>();
  const count = view.getUint16(4);
  if (12 + 16 * count > bytes.length) return 'incomplete';
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    const tag = String.fromCharCode(...bytes.subarray(at, at + 4));
    const offset = view.getUint32(at + 8);
    const length = view.getUint32(at + 12);
    tables.set(tag, { offset, length });
  }
  if (!tables.has('glyf') || tables.has('CFF ') || tables.has('CFF2')) return 'not-truetype';
  const needed = ['glyf', 'loca', ...TRUETYPE_TABLES];
  if (needed.some((tag) => tables.get(tag) === undefined)) return 'incomplete';
  for (const tag of needed) {
    const { offset, length } = tables.get(tag)!;
    if (offset + length > bytes.length) return 'incomplete';
  }
  if (tables.get('OS/2')!.length < OS2_MIN || tables.get('head')!.length < HEAD_MIN || tables.get('maxp')!.length < MAXP_MIN) return 'incomplete';
  if (!hasUnicodeCmap(view, tables.get('cmap')!)) return 'incomplete';
  return { view, tables };
}

/**
 * Whether a `cmap` has a Unicode subtable: Windows Unicode BMP (3, 1) or full (3, 10), or any Unicode platform (0)
 * record, its subtable inside the table. A symbol (3, 0) or Macintosh one alone would map the runs' Unicode text to
 * other glyphs or none.
 */
function hasUnicodeCmap(view: DataView, { offset, length }: { offset: number; length: number }): boolean {
  if (length < 4) return false;
  const count = view.getUint16(offset + 2);
  for (let i = 0; i < count && 4 + 8 * (i + 1) <= length; i++) {
    const at = offset + 4 + 8 * i;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (unicode && view.getUint32(at + 4) + 4 <= length) return true;
  }
  return false;
}

/**
 * Why the TrueType program `bytes` may not go into a PPTX, or null when it may (the module's rules): `subset` says the
 * PDF's program is a subset (its name has a subset tag); `codePoints`, when given, are the characters its runs show (the
 * `cmap` guard).
 */
export function trueTypeRefusal(bytes: Uint8Array, subset: boolean, codePoints?: Iterable<number>): FontSkip | null {
  const font = readTrueType(bytes);
  if (typeof font === 'string') return font;
  const fsType = font.view.getUint16(font.tables.get('OS/2')!.offset + 8);
  // more than one usage bit: the least restrictive applies (editable, then preview & print, then restricted)
  if ((fsType & FS_EDITABLE) === 0) {
    if ((fsType & FS_PREVIEW_PRINT) !== 0) return 'fsType-preview-print';
    if ((fsType & FS_RESTRICTED) !== 0) return 'fsType-restricted';
  }
  if ((fsType & FS_BITMAP_ONLY) !== 0) return 'fsType-bitmap-only';
  if ((fsType & FS_NO_SUBSETTING) !== 0 && subset) return 'fsType-no-subsetting';
  if (codePoints !== undefined) {
    try {
      if (!drawsAll(font, codePoints)) return 'incomplete';
    } catch {
      return 'incomplete'; // a table the reads above did not bound: damaged, never a throw
    }
  }
  return null;
}

/**
 * The glyph a Unicode `cmap` gives code point `cp`, or 0 for none (and for a subtable of a format not read here). Takes
 * the Windows full (3, 10), Windows BMP (3, 1), then any Unicode platform subtable, in formats 4, 12 and 6.
 */
function glyphOf(font: TrueType, cp: number): number {
  const { view } = font;
  const { offset, length } = font.tables.get('cmap')!;
  const end = offset + length;
  const count = view.getUint16(offset + 2);
  let best: { rank: number; at: number } | null = null;
  for (let i = 0; i < count && 4 + 8 * (i + 1) <= length; i++) {
    const at = offset + 4 + 8 * i;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const rank = platform === 3 && encoding === 10 ? 0 : platform === 3 && encoding === 1 ? 1 : platform === 0 ? 2 : -1;
    const sub = offset + view.getUint32(at + 4);
    if (rank < 0 || sub + 4 > end || (best !== null && best.rank <= rank)) continue;
    best = { rank, at: sub };
  }
  if (best === null) return 0;
  const sub = best.at;
  const format = view.getUint16(sub);
  if (format === 4) {
    if (sub + 14 > end) return 0;
    const segs = view.getUint16(sub + 6) >> 1;
    const ends = sub + 14;
    const starts = ends + 2 * segs + 2;
    const deltas = starts + 2 * segs;
    const ranges = deltas + 2 * segs;
    if (cp > 0xffff || ranges + 2 * segs > end) return 0;
    for (let s = 0; s < segs; s++) {
      if (view.getUint16(ends + 2 * s) < cp) continue;
      if (view.getUint16(starts + 2 * s) > cp) return 0;
      const range = view.getUint16(ranges + 2 * s);
      if (range === 0) return (cp + view.getUint16(deltas + 2 * s)) & 0xffff;
      const at = ranges + 2 * s + range + 2 * (cp - view.getUint16(starts + 2 * s));
      if (at + 2 > end) return 0;
      const glyph = view.getUint16(at);
      return glyph === 0 ? 0 : (glyph + view.getUint16(deltas + 2 * s)) & 0xffff;
    }
    return 0;
  }
  if (format === 12) {
    if (sub + 16 > end) return 0;
    const groups = view.getUint32(sub + 12);
    for (let g = 0; g < groups && sub + 16 + 12 * (g + 1) <= end; g++) {
      const at = sub + 16 + 12 * g;
      const first = view.getUint32(at);
      if (cp >= first && cp <= view.getUint32(at + 4)) return view.getUint32(at + 8) + (cp - first);
    }
    return 0;
  }
  if (format === 6) {
    if (sub + 10 > end) return 0;
    const first = view.getUint16(sub + 6);
    const n = view.getUint16(sub + 8);
    if (cp < first || cp >= first + n || sub + 10 + 2 * (cp - first) + 2 > end) return 0;
    return view.getUint16(sub + 10 + 2 * (cp - first));
  }
  return 0;
}

/** Whether glyph `gid` has outlines: a non-empty `glyf` entry (its `loca` entries differ, within `maxp.numGlyphs`). */
function hasOutlines(font: TrueType, gid: number): boolean {
  const { view } = font;
  const maxp = font.tables.get('maxp')!;
  const loca = font.tables.get('loca')!;
  const long = view.getInt16(font.tables.get('head')!.offset + 50) !== 0;
  if (maxp.length < 6 || gid <= 0 || gid >= view.getUint16(maxp.offset + 4)) return false;
  const size = long ? 4 : 2;
  if ((gid + 2) * size > loca.length) return false;
  const at = loca.offset + gid * size;
  return long ? view.getUint32(at + 4) > view.getUint32(at) : view.getUint16(at + 2) > view.getUint16(at);
}

/** Whether every code point of `codePoints` maps to a glyph with outlines; a blank one may map to an empty glyph. */
function drawsAll(font: TrueType, codePoints: Iterable<number>): boolean {
  const { view } = font;
  const glyphs = view.getUint16(font.tables.get('maxp')!.offset + 4);
  for (const cp of codePoints) {
    const gid = glyphOf(font, cp);
    if (gid === 0 || gid >= glyphs) return false;
    if (!hasOutlines(font, gid) && String.fromCodePoint(cp).trim() !== '') return false;
  }
  return true;
}

/**
 * Why the font `info` of the deck, whose program the PDF carries as `file` (none when it has none, or it could not be
 * read), is not embedded; null when it may be.
 */
export function fontRefusal(info: FontInfo, file: FontFile | undefined, codePoints?: Iterable<number>): FontSkip | null {
  if (info.type3) return 'type3';
  if (!info.embedded) return 'not-in-pdf';
  if (file === undefined) return 'unreadable';
  return trueTypeRefusal(file.bytes, SUBSET_TAG.test(info.baseFont), codePoints);
}

/** The style a font is embedded as: its own (nameID 2, `FontInfo.bold` and `italic`), as its runs are written `b` and `i`. */
export function fontStyle(info: FontInfo): FontStyle {
  if (info.bold) return info.italic ? 'boldItalic' : 'bold';
  return info.italic ? 'italic' : 'regular';
}

/**
 * The typefaces a font's runs are written with (`typefaces`, lowering): `a:latin`, then `a:ea` where it differs
 * (`a:cs` is the latin one). PowerPoint finds an embedded font by the typeface of `p:font`, not by the program's own
 * names (it loads the program under a name of its own), so the font is listed under each; measured, M4 Task 5.
 */
export function fontTypefaces(info: FontInfo, map?: FontMap): string[] {
  const { latin, ea, cs } = typefaces(info, map);
  return [...new Set([latin, ea, cs].filter((face): face is string => face !== null))];
}

/** A name record of the EOT header: UTF-16LE with its terminating NUL, as t2embed writes it. */
function eotName(name: string): Uint8Array {
  const text = `${name.slice(0, 0x7ffe)}\0`;
  const out = new Uint8Array(2 * text.length);
  const view = new DataView(out.buffer);
  for (let i = 0; i < text.length; i++) view.setUint16(2 * i, text.charCodeAt(i), true);
  return out;
}

const NAME_IDS = { family: 1, style: 2, full: 4, version: 5 } as const;
const EOT_NAME_IDS: ReadonlySet<number> = new Set(Object.values(NAME_IDS));

/**
 * The name records the EOT header carries: nameID 1, 2, 5 and 4 of the English Windows record (3, 1, 0x409), else of the
 * first Windows Unicode record (by language id), else of the Macintosh Roman English one, else empty.
 */
function eotNames(font: TrueType): Record<keyof typeof NAME_IDS, string> {
  const { view } = font;
  const { offset, length } = font.tables.get('name')!;
  const found: Record<number, { rank: number; text: string }> = {};
  if (length >= 6) {
    const count = view.getUint16(offset + 2);
    const strings = offset + view.getUint16(offset + 4);
    for (let i = 0; i < count && 6 + 12 * (i + 1) <= length; i++) {
      const at = offset + 6 + 12 * i;
      const [platform, encoding, language, id, size, start] = [0, 2, 4, 6, 8, 10].map((d) => view.getUint16(at + d)) as [number, number, number, number, number, number];
      if (!EOT_NAME_IDS.has(id) || strings + start + size > offset + length) continue;
      let rank: number;
      let text: string;
      if (platform === 3 && (encoding === 1 || encoding === 10)) {
        rank = language === 0x409 ? 0 : 1 + language;
        text = utf16be(view, strings + start, size);
      } else if (platform === 1 && encoding === 0 && language === 0) {
        rank = 0x20000;
        text = macRoman(view, strings + start, size);
      } else continue;
      if (found[id] === undefined || rank < found[id].rank) found[id] = { rank, text };
    }
  }
  const name = (id: number) => found[id]?.text ?? '';
  return { family: name(NAME_IDS.family), style: name(NAME_IDS.style), full: name(NAME_IDS.full), version: name(NAME_IDS.version) };
}

/**
 * The TrueType program `bytes` as an EOT (`fntdata`, the module's form): version 0x00020002, flags 0; the PANOSE,
 * weight, fsType, Unicode and code page ranges of its `OS/2` (no code page ranges in a version 0 table: 0), italic
 * from fsSelection bit 0, DEFAULT_CHARSET, `head`'s checkSumAdjustment, its names (`eotNames`), then the program as it
 * is. Throws for a program `trueTypeRefusal` calls `not-truetype` or `incomplete`. The caller's bytes are not changed.
 */
export function eotOf(bytes: Uint8Array): Uint8Array {
  const font = readTrueType(bytes);
  if (typeof font === 'string') throw new Error(`eotOf: the program is ${font}`);
  const { view } = font;
  const os2 = font.tables.get('OS/2')!;
  const head = font.tables.get('head')!.offset;
  const names = eotNames(font);
  const strings = [names.family, names.style, names.version, names.full].map(eotName);
  const headerLength = 80 + strings.reduce((n, s) => n + 4 + s.length, 0) + 4 + 20;
  const out = new Uint8Array(headerLength + bytes.length);
  const eot = new DataView(out.buffer);
  let at = 0;
  const u8 = (v: number) => eot.setUint8(at++, v);
  const u16 = (v: number) => ((at += 2), eot.setUint16(at - 2, v, true));
  const u32 = (v: number) => ((at += 4), eot.setUint32(at - 4, v, true));
  u32(out.length); // EOTSize
  u32(bytes.length); // FontDataSize
  u32(0x00020002); // Version
  u32(0); // Flags: not compressed, not XOR-ed
  for (let i = 0; i < 10; i++) u8(view.getUint8(os2.offset + 32 + i)); // FontPANOSE
  u8(1); // Charset: DEFAULT_CHARSET
  u8(view.getUint16(os2.offset + 62) & 1); // Italic: fsSelection ITALIC
  u32(view.getUint16(os2.offset + 4)); // Weight: usWeightClass
  u16(view.getUint16(os2.offset + 8)); // fsType
  u16(0x504c); // MagicNumber
  for (let i = 0; i < 4; i++) u32(view.getUint32(os2.offset + 42 + 4 * i)); // UnicodeRange1-4
  const v1 = view.getUint16(os2.offset) >= 1 && os2.length >= OS2_V1;
  for (let i = 0; i < 2; i++) u32(v1 ? view.getUint32(os2.offset + 78 + 4 * i) : 0); // CodePageRange1-2
  u32(view.getUint32(head + 8)); // CheckSumAdjustment
  for (let i = 0; i < 4; i++) u32(0); // Reserved1-4
  for (const s of strings) {
    u16(0); // Padding
    u16(s.length);
    out.set(s, at);
    at += s.length;
  }
  u16(0); // Padding5
  u16(0); // RootStringSize
  u32(0x50475342); // RootStringCheckSum: of the empty root string
  u32(0); // EUDCCodePage
  u16(0); // Padding6
  u16(0); // SignatureSize
  u32(0); // EUDCFlags
  u32(0); // EUDCFontSize
  out.set(bytes, at);
  return out;
}
