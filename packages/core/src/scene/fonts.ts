import { fontPrograms, rawPageIndex, type FontProgram, type RawPageKey } from '../engine/fonts';
import type { RawPdf, Ref } from '../engine/rawpdf';
import { numberedFamily } from '../fonts/names';
import { capName, NAME_MAX_TYPEFACE, readSfntMetrics, readSfntNames, readSymbolCmap, type SfntNames } from '../fonts/sfnt';
import type { FontInfo } from './types';

/**
 * A font's program as the PDF carries it (its font descriptor's entry and the decoded bytes): what `convert` embeds in
 * the PPTX with `embedFonts` (fonts/embed.ts). Never part of the Scene.
 */
export interface FontFile {
  fileKind: 'FontFile' | 'FontFile2' | 'FontFile3';
  bytes: Uint8Array;
  /** The program's stream object: fonts that share it share their program (an Office export's Type0 and TrueType pair). */
  ref: Ref | null;
}

/** What pdf.js says of a font besides its name: what the walker's run carries (`RawOp.glyph.type3`, `RunData.missingFile`). */
export interface PdfjsFontFacts {
  /** A Type 3 font (pdf.js `isType3Font`). */
  type3?: boolean;
  /** pdf.js has no program of the font (`missingFile`). */
  missingFile?: boolean;
}

/** Windows language ids of the CJK names `eaName` takes, in this order: Korean, Japanese, Chinese (PRC), Chinese (Taiwan). */
const EA_LANGUAGES = [0x0412, 0x0411, 0x0804, 0x0404];
const ENGLISH_US = 0x0409;
/** The tag a PDF puts before the name of a subset font: six capitals and `+`. */
export const SUBSET_TAG = /^[A-Z]{6}\+/;
/** The style a PostScript name may end with: `,Bold` and the like (cut at the comma), or one of these after a `-`. */
const STYLE_SUFFIX = /-(?:Regular|Roman|Normal|Bold|Italic|Oblique|BoldItalic|BoldOblique)$/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const UTF8_ENCODER = new TextEncoder();

/**
 * The fonts of a deck (Task 9): what `SceneDeck.fonts` holds and `TextRun.fontKey` names. A font is known by the name pdf.js
 * gives it (`font.name`, as `RawOp.glyph.font` carries it) and keyed `f1`, `f2`, ... in the order `resolve` first sees it,
 * one table for the whole deck, so the keys are in first-use order across pages (Global Constraints, Determinism; no
 * pdf.js id is kept).
 *
 * Its names come from the PDF's own font program (spec §7): the program is the first of `fontPrograms` of the page (found
 * in the raw reader by its reference, `rawPageIndex`) whose /BaseFont, subset tag included, pdf.js would give that name
 * and which is a Type 3 font exactly when pdf.js says so (`isProgramOf`; none for the empty name), and from it
 * - `latinName`: nameID 1 for language 0x409, else the first Windows record (by language id, the order of a sorted name
 *   table), else the Macintosh Roman English record; but a number alone (M8 round 1a: a font PowerPoint embedded in a
 *   deck, `1`) is the family its other names give (`numberedFamily`: nameID 16 and 17, 4, 6), where they give one;
 * - `eaName`: nameID 1 for Korean (0x412), else Japanese (0x411), Chinese PRC (0x804) or Taiwan (0x404); null when the
 *   font has none of them;
 * - `bold` and `italic`: nameID 2 (the same record order as `latinName`) says Bold, Italic or Oblique. Only the font's own
 *   style: synthetic bold and italic are raw evidence on the run (`fillMode`, `stroke.wPt`, `skew`) for M4;
 * - `fsType` and `metrics` (`readSfntMetrics`, with `isVariable`).
 *
 * A font with no program (not embedded) is `embedded: false`, and its `latinName` its name without the subset tag and the
 * style (`,Bold`, `-Italic`, ...). A program the raw reader cannot read, or that is no sfnt (a bare CFF or Type 1 font), is
 * `embedded: true` with names and metrics null. A Type 3 font is `type3` and `embedded`, without names: its glyphs are the
 * PDF's own drawings. `type3` is pdf.js' say alone (`PdfjsFontFacts.type3`), as the walker's glyphs carry it and the
 * table is keyed by it. Without a raw reader (`raw` null: an encrypted PDF, ruling M2-R6), or when no program of the page
 * has the name (a font only a tiling pattern's cell or a soft mask uses; a /FontName that is not the /BaseFont, 0002
 * §13), only pdf.js speaks: `embedded` when it read a program (`missingFile` false), and the `latinName` taken from the
 * name, as for a font that is not embedded.
 */
export class FontTable {
  /** By pdf.js name, and whether it is Type 3: the same name is the same font on every page. */
  private readonly fonts = new Map<string, FontInfo>();
  /** The programs of the last page asked about (by the raw reader's index): one page's worth at a time. */
  private page: { index: number; programs: FontProgram[] } | null = null;
  /** With `keepFiles`: the programs of the fonts first seen since `takeFiles`, by key. */
  private readonly files = new Map<string, FontFile>();
  /** Each symbol font's own codes (`symbolCodes`), by key. */
  private readonly symbols = new Map<string, SymbolCodes>();

  /**
   * `keepFiles`: keep the program of each font as it is first seen, until `takeFiles` hands it over (`convert`'s
   * `embedFonts`); without it, no program outlives its page.
   */
  constructor(
    private readonly raw: RawPdf | null,
    private readonly keepFiles = false,
  ) {}

  /**
   * The font pdf.js names `pdfjsFontName` on `page`; the first time a name is seen it gets the next key. The page is its
   * index (0-based) and, best, its object reference, by which the raw reader finds it (`rawPageIndex`). `pdfjs` is what
   * pdf.js says of the font besides its name (ruling M2-R6 needs it when the raw reader cannot speak). The result is a copy.
   */
  resolve(pdfjsFontName: string, page: RawPageKey, pdfjs: PdfjsFontFacts = {}): FontInfo {
    const type3 = pdfjs.type3 === true;
    const id = `${type3 ? 3 : 0}:${pdfjsFontName}`;
    let info = this.fonts.get(id);
    if (info === undefined) {
      const program = this.programs(page).find((p) => isProgramOf(p, pdfjsFontName, type3));
      info = describe(`f${this.fonts.size + 1}`, pdfjsFontName, program, pdfjs);
      this.fonts.set(id, info);
      const symbol = type3 || program === undefined ? null : symbolCodes(program);
      if (symbol !== null) this.symbols.set(info.key, symbol);
      if (this.keepFiles && !type3 && program?.fileKind != null && program.bytes !== null) {
        this.files.set(info.key, { fileKind: program.fileKind, bytes: program.bytes, ref: program.ref });
      }
    }
    return copy(info);
  }

  /**
   * The programs of the fonts first seen since the last call (`keepFiles`), by key in first-use order, handed over: the
   * table keeps none of them. A font whose program the raw reader could not find or read has none. Empty without
   * `keepFiles`.
   */
  takeFiles(): Map<string, FontFile> {
    const files = new Map(this.files);
    this.files.clear();
    return files;
  }

  /**
   * The character a glyph of code `code` (`RawOp.glyph.code`) is in the font of key `key`'s own encoding, when that is a
   * symbol font (`symbolCodes`): U+F000 + its code; null for any other font, and for a code the font does not map.
   */
  symbolChar(key: string, code: number): string | null {
    return this.symbols.get(key)?.(code) ?? null;
  }

  /** How many fonts the table holds: a mark to `rewind` to. */
  mark(): number {
    return this.fonts.size;
  }

  /**
   * Forgets the fonts first seen since `mark`, as if what used them had not been built (a fallback, a failed slide): the
   * next font gets the key the first of them had, so the keys stay in the first-use order of what the deck keeps.
   */
  rewind(mark: number): void {
    let n = 0;
    for (const [id, info] of [...this.fonts]) {
      if (n++ < mark) continue;
      this.fonts.delete(id);
      this.files.delete(info.key);
      this.symbols.delete(info.key);
    }
  }

  /** Every font, keyed by its key, in first-use order: `SceneDeck.fonts`. Copies. */
  infos(): Record<string, FontInfo> {
    return Object.fromEntries([...this.fonts.values()].map((info) => [info.key, copy(info)]));
  }

  /**
   * The font programs of a page; none without the raw reader, or when it cannot read the page (one it does not have
   * where pdf.js does): then pdf.js' names are all there is, which is never wrong.
   */
  private programs(page: RawPageKey): FontProgram[] {
    if (this.raw === null) return [];
    const index = rawPageIndex(this.raw, page);
    if (this.page?.index !== index) {
      let programs: FontProgram[];
      try {
        programs = fontPrograms(this.raw, index);
      } catch {
        programs = [];
      }
      this.page = { index, programs };
    }
    return this.page.programs;
  }
}

/**
 * Whether `program` can be the font pdf.js names `name` (final review F2): pdf.js would give its /BaseFont that name,
 * and both say alike whether it is a Type 3 font, so a Type 3 font that borrows a real font's /BaseFont is not taken
 * for it. Never for the empty name, which pdf.js gives a font it could not load, and the raw reader a font without
 * /BaseFont.
 */
function isProgramOf(program: FontProgram, name: string, type3: boolean): boolean {
  if (name === '' || (program.subtype === 'Type3') !== type3) return false;
  return pdfjsNamesOf(program.baseFont).includes(name) || (program.cidBaseFont !== null && pdfjsNamesOf(program.cidBaseFont).includes(name));
}

/** A symbol font's own character for a code of its text (`FontTable.symbolChar`), null for a code it does not map. */
type SymbolCodes = (code: number) => string | null;

/** The first and the last character of a symbol font's own encoding: U+F000 + a one-byte code (OpenType `cmap`, Windows Symbol). */
const SYMBOL_FIRST = 0xf000;
const SYMBOL_LAST = 0xf0ff;
/** FontDescriptor /Flags bit 3 (value 4): the font is symbolic. */
const FLAG_SYMBOLIC = 4;

/**
 * A symbol font's own codes (M8 round 1a), from the PDF alone. A font whose program's `cmap` is Windows Symbol (3, 0)
 * only (`readSymbolCmap`: Wingdings, Symbol, Webdings and the like) names a glyph by the font's code, which PowerPoint
 * writes as U+F000 + code (`a:sym`, as its own decks hold a Wingdings character) and draws in that font; the PDF's
 * ToUnicode names the same glyph by another character (Wingdings' arrowhead as U+27A2), which PowerPoint draws from
 * another font. So a glyph's own character is:
 * - in a composite font (Type0) whose CMap is Identity-H or Identity-V: the code is the CID, its glyph the CIDToGIDMap's
 *   (`FontProgram.cidToGid`), and its character the lowest code the symbol subtable maps to that glyph: one of U+F000 to
 *   U+F0FF as it is, a code up to 0xFF as U+F000 + code; none for another code;
 * - in a simple font, U+F000 + the code (up to 0xFF) when the subtable maps the code, U+F000 + it, U+F100 + it or
 *   U+F200 + it (where PDF 9.6.5.4 looks).
 * Null for any other font: no program, one that is not an sfnt or has a Unicode `cmap`, another CMap or another CID font.
 */
export function symbolCodes(program: FontProgram): SymbolCodes | null {
  if (program.bytes === null) return null;
  let cmap: Map<number, number> | null;
  try {
    cmap = readSymbolCmap(program.bytes, { baseFont: program.baseFont, flagged: ((program.descriptor?.flags ?? 0) & FLAG_SYMBOLIC) !== 0 });
  } catch {
    return null; // not an sfnt, a damaged or hostile one (too costly to read): no symbol codes, its text is kept as it is
  }
  if (cmap === null || cmap.size === 0) return null;
  const symbols = cmap;
  if (!program.composite) {
    const maps = (code: number): boolean => [code, 0xf000 + code, 0xf100 + code, 0xf200 + code].some((c) => symbols.has(c));
    return (code) => (code <= 0xff && maps(code) ? String.fromCharCode(SYMBOL_FIRST + code) : null);
  }
  const map = program.cidToGid;
  if ((program.encoding !== 'Identity-H' && program.encoding !== 'Identity-V') || map === null) return null;
  const byGlyph = new Map<number, number>();
  for (const [code, glyph] of [...symbols].sort((a, b) => a[0] - b[0])) if (!byGlyph.has(glyph)) byGlyph.set(glyph, code);
  const own = (code: number): string | null =>
    code >= SYMBOL_FIRST && code <= SYMBOL_LAST ? String.fromCharCode(code) : code <= 0xff ? String.fromCharCode(SYMBOL_FIRST + code) : null;
  return (cid) => {
    const glyph = map === 'identity' ? cid : 2 * cid + 1 < map.length ? (map[2 * cid]! << 8) | map[2 * cid + 1]! : 0;
    const code = byGlyph.get(glyph);
    return code === undefined ? null : own(code);
  };
}

/** The FontInfo of a font pdf.js names `name`, from its program when one was found. */
function describe(key: string, name: string, program: FontProgram | undefined, pdfjs: PdfjsFontFacts): FontInfo {
  const info: FontInfo = {
    key,
    baseFont: decodeFontName(name),
    latinName: null,
    eaName: null,
    bold: false,
    italic: false,
    embedded: false,
    fsType: null,
    isVariable: false,
    type3: pdfjs.type3 === true, // pdf.js' say alone, as the walker's glyphs and the table's key
    metrics: null,
  };
  if (info.type3) return { ...info, embedded: true };
  const embedded = program === undefined ? pdfjs.missingFile === false : program.fileKind !== null;
  if (!embedded || program === undefined) return { ...info, embedded, latinName: familyOfName(info.baseFont) };
  info.embedded = true;
  if (program.bytes === null) return info; // embedded, and the raw reader cannot read it
  let names: SfntNames;
  try {
    names = readSfntNames(program.bytes);
  } catch {
    return info; // no sfnt: a bare CFF or Type 1 program, or a damaged one
  }
  const style = names.subfamily[ENGLISH_US] ?? first(names.subfamily) ?? names.macSubfamily ?? '';
  const family = names.family[ENGLISH_US] ?? first(names.family) ?? names.macFamily;
  const own = (records: Record<number, string>): string | null => records[ENGLISH_US] ?? first(records) ?? null;
  // M8 round 1a: a family that is a number alone (a font PowerPoint embedded in a deck) is its program's other names'
  // M8 I2: a name from a program is a typeface on every run: at most NAME_MAX_TYPEFACE characters, no control characters
  const typeface = (name: string | null | undefined): string | null => (name === null || name === undefined ? null : capName(name, NAME_MAX_TYPEFACE));
  // M8 round 3a: a family that is a subset-tagged name is no family: Adobe PDF Library (Acrobat's PDFMaker) rewrites a
  // subset's names to its tagged PostScript name, and nameID 2 to Regular whatever the face. The family is then the
  // descriptor's /FontFamily, else the name without its tag and style, but not a number alone (a font PowerPoint
  // embedded, `numberedFamily`: no PC has it, so the name stays as it was); the style the program's OS/2 fsSelection
  // (`taggedStyle`)
  const tagged = family !== undefined && family !== null && SUBSET_TAG.test(family);
  const untagged = tagged ? familyOfName(family) : null;
  const fromTag = tagged ? program.descriptor?.fontFamily || (untagged !== null && !NUMBER_ALONE.test(untagged) ? untagged : null) : null;
  info.latinName = typeface(
    fromTag ??
      numberedFamily({ family, subfamily: style, full: own(names.full), postscript: own(names.postscript), typoFamily: own(names.typoFamily), typoSubfamily: own(names.typoSubfamily) }) ??
      family,
  );
  info.eaName = typeface(EA_LANGUAGES.map((language) => names.family[language]).find((n) => n !== undefined));
  info.bold = /(?:^|[^a-z])bold/i.test(style); // Bold, Bold Italic; not SemiBold or ExtraBold
  info.italic = /italic|oblique/i.test(style);
  info.fsType = names.fsType;
  try {
    const { isVariable, ...metrics } = readSfntMetrics(program.bytes);
    info.metrics = metrics;
    info.isVariable = isVariable;
  } catch {
    // a table is missing: no metrics rather than made-up ones
  }
  if (tagged) Object.assign(info, taggedStyle(info.metrics?.fsSelection ?? null, program.descriptor, info.baseFont));
  return info;
}

/** A name that is a number alone (`numberedFamily`'s). */
const NUMBER_ALONE = /^\s*\d+\s*$/;

/** fsSelection bit 0 (ITALIC) and bit 5 (BOLD) of OS/2; the descriptor's Flags bit 7 (Italic) and bit 19 (ForceBold). */
const FS_ITALIC = 1;
const FS_BOLD = 1 << 5;
const FLAG_ITALIC = 1 << 6;
const FLAG_FORCE_BOLD = 1 << 18;
/** The style a BaseFont ends with: `-Bold`, `,BoldItalic`, `-Oblique`, ... */
const NAME_BOLD = /[-,](?:Bold|BoldItalic|BoldOblique)$/i;
const NAME_ITALIC = /[-,](?:Italic|Oblique|BoldItalic|BoldOblique)$/i;

/**
 * M8 round 3a, 3c: the style of a font whose names a subset tag rewrote (`describe`): its program's OS/2 fsSelection, which
 * the rewrite keeps; without an OS/2 table, the descriptor's Italic and ForceBold flags and a FontWeight of 700 or more.
 * Without a /FontFamily too (the family is then taken from the BaseFont, its style cut off), the BaseFont's own style
 * suffix counts as well, so no style is lost.
 */
function taggedStyle(fsSelection: number | null, descriptor: FontProgram['descriptor'], baseFont: string): { bold: boolean; italic: boolean } {
  let bold: boolean;
  let italic: boolean;
  if (fsSelection !== null) {
    bold = (fsSelection & FS_BOLD) !== 0;
    italic = (fsSelection & FS_ITALIC) !== 0;
  } else {
    bold = (descriptor?.fontWeight ?? 0) >= 700 || ((descriptor?.flags ?? 0) & FLAG_FORCE_BOLD) !== 0;
    italic = ((descriptor?.flags ?? 0) & FLAG_ITALIC) !== 0;
  }
  if (!descriptor?.fontFamily) {
    const name = baseFont.replace(SUBSET_TAG, '');
    bold = bold || NAME_BOLD.test(name);
    italic = italic || NAME_ITALIC.test(name);
  }
  return { bold, italic };
}

/** The record of the lowest language id: the first of a name table, which is sorted. */
function first(records: Record<number, string>): string | undefined {
  return Object.values(records)[0]; // integer keys iterate in ascending order
}

/**
 * A name without its subset tag and style, for a font with no program to read the family from (and in lowering, a font
 * whose program gave no names); null when nothing is left.
 */
export function familyOfName(name: string): string | null {
  const family = name.replace(SUBSET_TAG, '').split(',', 1)[0]!.replace(STYLE_SUFFIX, '');
  return family === '' ? null : capName(family, NAME_MAX_TYPEFACE); // M8 I2
}

function copy(info: FontInfo): FontInfo {
  return { ...info, metrics: info.metrics === null ? null : { ...info.metrics } };
}

/**
 * The name of a font as `FontInfo.baseFont` holds it, from the name pdf.js gives it. pdf.js reads a PDF name one character a
 * byte, so a name written in UTF-8 (a Korean font's, as real Korean decks have) comes out as one character per byte. Its
 * bytes are read as UTF-8 when they are UTF-8 and that gives a character above U+00FF; any other name stays as pdf.js gives
 * it. The rule can be undone (`pdfjsFontName`): what it decodes has a character above U+00FF, and what it keeps has none.
 */
export function decodeFontName(pdfjsName: string): string {
  if (!/[\x80-\xff]/.test(pdfjsName) || /[^\x00-\xff]/.test(pdfjsName)) return pdfjsName;
  let decoded: string;
  try {
    decoded = UTF8.decode(Uint8Array.from(pdfjsName, (c) => c.charCodeAt(0)));
  } catch {
    return pdfjsName; // not UTF-8 (a CP949 name, say): as pdf.js reads it
  }
  return /[^\x00-\xff]/.test(decoded) ? decoded : pdfjsName;
}

/** The name pdf.js gives a font whose `FontInfo.baseFont` is `baseFont`: `decodeFontName` undone. */
export function pdfjsFontName(baseFont: string): string {
  return /[^\x00-\xff]/.test(baseFont) ? bytewise(UTF8_ENCODER.encode(baseFont)) : baseFont;
}

/** A string of one character per byte, as pdf.js reads a name. */
function bytewise(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

/**
 * The names pdf.js may give a font whose /BaseFont the raw reader read as `baseFont`, so that the match is on the bytes of
 * the name. The raw reader reads a name's bytes as UTF-8 when they are UTF-8 and not all ASCII, else one character a byte;
 * pdf.js always one character a byte. So a name with a character above U+00FF had the bytes of its UTF-8; one with only
 * characters up to U+00FF had those bytes, or the UTF-8 of them. pdf.js gives a simple font without a descriptor its
 * /BaseFont with `,` and `_` as `-` and no white space (`normalizeFontName`, 0002 §13): those forms too.
 */
function pdfjsNamesOf(baseFont: string): string[] {
  const forms = /^[\x00-\x7f]*$/.test(baseFont) ? [baseFont] : [bytewise(UTF8_ENCODER.encode(baseFont))];
  if (!/^[\x00-\x7f]*$/.test(baseFont) && /^[\x00-\xff]*$/.test(baseFont)) forms.push(baseFont);
  return forms.flatMap((form) => [form, form.replaceAll(/[,_]/g, '-').replaceAll(/\s/g, '')]);
}
