import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openRawPdf } from '../../src/engine/rawpdf';
import { toInventory } from '../../src/extract/inventory';
import { FontTable } from '../../src/scene/fonts';
import { inventoryOfSlide } from '../../src/scene/inventory';
import type { Element, FontInfo, TextLineEl, TextRun } from '../../src/scene/types';
import { repoRoot } from '../helpers/fixtures';
import type { MiniObject } from '../helpers/minipdf';
import { buildDeck, pagesPdf } from '../helpers/scene';
import { cmapOf, hostileCmap, nameTable, sfnt, testFont, type NameRecord } from '../helpers/sfnt';

/**
 * The font table (Task 9): each font a run uses, once for the deck, keyed `f1`, `f2`, ... in the order the deck first
 * uses them. Its names come from the PDF's own font program (spec §7): nameID 1 language 0x409 is `latinName`, the Korean
 * or other CJK record `eaName`, and nameID 2 says bold and italic. Font names here are those of the committed corpus
 * (the OFL fonts of fonts.lock.json) and of fonts made up for the test.
 */

const SMOKE = `${repoRoot}corpus/generated/atlas-smoke_std.pdf`;
const LOCK = JSON.parse(readFileSync(`${repoRoot}harness/fonts/fonts.lock.json`, 'utf8')) as { families: { family: string }[] };

/** Every run of the elements, those of tile cells and soft masks too. */
function runsOf(elements: readonly Element[]): TextRun[] {
  return elements.flatMap((e) => (e.kind === 'textline' ? e.runs : []));
}
const lines = (elements: readonly Element[]): TextLineEl[] => elements.filter((e): e is TextLineEl => e.kind === 'textline');

/** A simple TrueType font, A to C 600 wide, in WinAnsi; with a descriptor (object `descriptor`) when given. */
const trueType = (num: number, baseFont: string, descriptor?: number): MiniObject => ({
  num,
  body:
    `<< /Type /Font /Subtype /TrueType /BaseFont /${baseFont} /FirstChar 65 /LastChar 67 /Widths [600 600 600] ` +
    `/Encoding /WinAnsiEncoding${descriptor === undefined ? '' : ` /FontDescriptor ${descriptor} 0 R`} >>`,
});
/** Its descriptor, with the program `file` as /FontFile2 when given. */
const descriptor = (num: number, fontName: string, file?: number): MiniObject => ({
  num,
  body:
    `<< /Type /FontDescriptor /FontName /${fontName} /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 ` +
    `/Descent -200 /CapHeight 700 /StemV 80${file === undefined ? '' : ` /FontFile2 ${file} 0 R`} >>`,
});
/** A font program's stream, without its object number. */
type Program = Omit<Extract<MiniObject, { data: unknown }>, 'num'>;
/** An embedded TrueType font: the font, its descriptor and its program, at `num`, `num + 1` and `num + 2`. */
const embedded = (num: number, baseFont: string, program: Program): MiniObject[] => [
  trueType(num, baseFont, num + 1),
  descriptor(num + 1, baseFont, num + 2),
  { num: num + 2, ...program },
];

/** A PDF name of these bytes: printable ASCII as it is, any other byte (and `#`) as #xx. */
function pdfName(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => (b > 0x20 && b < 0x7f && b !== 0x23 ? String.fromCharCode(b) : `#${b.toString(16).toUpperCase().padStart(2, '0')}`)).join('');
}

const GOOD: NameRecord[] = [
  [3, 1, 0x409, 1, 'Deckback Good'],
  [3, 1, 0x409, 2, 'Bold'],
];
const goodProgram = testFont({
  names: GOOD,
  upm: 2048,
  hheaAsc: 1900,
  hheaDesc: -500,
  hheaLineGap: 67,
  typoAsc: 1800,
  typoDesc: -420,
  typoLineGap: 300,
  winAsc: 2100,
  winDesc: 600,
  fsType: 8,
  fsSelection: 0xa0,
});

describe('FontTable on the committed corpus', () => {
  /** The whole of atlas-smoke, built once for the tests that read it. */
  let smoke: ReturnType<typeof buildDeck> | undefined;
  const smokeDeck = () => (smoke ??= buildDeck(new Uint8Array(readFileSync(SMOKE))));

  it('every run in atlas-smoke_std.pdf resolves to an embedded font whose latinName is a fonts.lock.json family', async () => {
    const deck = await smokeDeck();
    const fonts = deck.fonts.infos();
    const families = new Set(LOCK.families.map((f) => f.family));
    const runs = deck.slides.flatMap((s) => runsOf(s.elements));
    expect(runs.length).toBeGreaterThan(100);
    const used = new Set(runs.map((r) => r.fontKey));
    expect([...used].sort()).toEqual(Object.keys(fonts).sort()); // the table holds the fonts the runs use, no more
    for (const key of used) {
      const font = fonts[key]!;
      expect(font, key).toMatchObject({ key, embedded: true, type3: false, isVariable: false, fsType: 0 });
      expect(families.has(font.latinName!), `${key} ${font.latinName}`).toBe(true);
      expect(font.metrics?.upm, key).toBeGreaterThan(0);
    }
    // The deck uses most of the lock: the families it holds come back.
    expect(new Set(Object.values(fonts).map((f) => f.latinName))).toEqual(
      new Set(['Gothic A1', 'Pretendard', 'Pretendard Light', 'Pretendard Black', 'Gowun Batang', 'NanumGothic', 'NanumGothicExtraBold']),
    );
  }, 60_000);

  it('Gothic A1 has its Korean name in eaName', async () => {
    const fonts = Object.values((await smokeDeck()).fonts.infos());
    const ea = (family: string) => new Set(fonts.filter((f) => f.latinName === family).map((f) => f.eaName));
    expect(ea('Gothic A1')).toEqual(new Set(['고딕 A1']));
    expect(ea('NanumGothic')).toEqual(new Set(['나눔고딕']));
    expect(ea('Pretendard')).toEqual(new Set([null])); // no Korean record
  }, 60_000);

  it('Pretendard Bold is bold from nameID 2', async () => {
    const fonts = Object.values((await smokeDeck()).fonts.infos());
    const style = (postscript: string) =>
      new Set(fonts.filter((f) => f.baseFont.endsWith(`+${postscript}`)).map((f) => `${f.latinName} bold ${f.bold} italic ${f.italic}`));
    expect(style('Pretendard-Bold')).toEqual(new Set(['Pretendard bold true italic false']));
    expect(style('Pretendard-Regular')).toEqual(new Set(['Pretendard bold false italic false']));
    expect(style('GothicA1-Bold')).toEqual(new Set(['Gothic A1 bold true italic false']));
    // The English record says Regular, the Korean one Bold: the English one decides.
    expect(style('NanumGothicExtraBold')).toEqual(new Set(['NanumGothicExtraBold bold false italic false']));
  }, 60_000);

  it('without the raw reader, the names are those pdf.js gives (M2-R6)', async () => {
    const deck = await buildDeck(new Uint8Array(readFileSync(SMOKE)), { raw: false, pages: [0, 1, 2, 3] });
    const fonts = Object.values(deck.fonts.infos());
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      // pdf.js read the program: it is embedded, but its names and metrics are not known.
      expect(font).toMatchObject({ embedded: true, eaName: null, bold: false, italic: false, fsType: null, metrics: null });
      expect(font.latinName).toBe(font.baseFont.replace(/^[A-Z]{6}\+/, '').replace(/-(Regular|Bold)$/, ''));
    }
  }, 60_000);
});

describe('FontTable on synthetic PDFs', () => {
  it('font keys are f1, f2, ... in first-use order, across pages', async () => {
    const pdf = pagesPdf(
      ['BT /F2 10 Tf 10 10 Td (A) Tj /F1 10 Tf (B) Tj ET', 'BT /F1 10 Tf 10 10 Td (C) Tj /F3 10 Tf (A) Tj 3 Tr /F2 10 Tf (B) Tj ET'],
      '/Font << /F1 10 0 R /F2 11 0 R /F3 12 0 R >>',
      [trueType(10, 'DeckbackOne'), trueType(11, 'DeckbackTwo'), trueType(12, 'DeckbackThree')],
    );
    const deck = await buildDeck(pdf);
    expect(deck.slides.map((s) => runsOf(s.elements).map((r) => r.fontKey))).toEqual([
      ['f1', 'f2'],
      ['f2', 'f3', 'f1'],
    ]);
    const fonts = deck.fonts.infos();
    expect(Object.entries(fonts).map(([key, f]) => [key, f.key, f.baseFont])).toEqual([
      ['f1', 'f1', 'DeckbackTwo'],
      ['f2', 'f2', 'DeckbackOne'],
      ['f3', 'f3', 'DeckbackThree'],
    ]);
    // No pdf.js id reaches the Scene (Global Constraints, Determinism).
    expect(JSON.stringify([deck.slides, fonts])).not.toMatch(/g_d\d+_f\d+/);
  });

  it('not embedded', async () => {
    const pdf = pagesPdf(
      ['BT /N1 10 Tf 10 10 Td (A) Tj /N2 10 Tf (B) Tj /N3 10 Tf (C) Tj ET'],
      '/Font << /N1 10 0 R /N2 11 0 R /N3 12 0 R >>',
      [trueType(10, 'DeckbackPlain'), trueType(11, 'ABCDEF+Deckback,BoldItalic'), trueType(12, 'DeckbackSans-Bold', 13), descriptor(13, 'DeckbackSans-Bold')],
    );
    const fonts = (await buildDeck(pdf)).fonts.infos();
    const none = { eaName: null, bold: false, italic: false, embedded: false, fsType: null, isVariable: false, type3: false, metrics: null };
    expect(fonts).toEqual({
      f1: { key: 'f1', baseFont: 'DeckbackPlain', latinName: 'DeckbackPlain', ...none },
      // pdf.js names a font without a descriptor with `-` for `,` (0002 §13); the tag and the style go, and the style is
      // not read as bold or italic (nameID 2 only).
      f2: { key: 'f2', baseFont: 'ABCDEF+Deckback-BoldItalic', latinName: 'Deckback', ...none },
      f3: { key: 'f3', baseFont: 'DeckbackSans-Bold', latinName: 'DeckbackSans', ...none },
    });
  });

  it('a damaged font program keeps the run and loses only the names', async () => {
    const hex = Array.from(goodProgram, (b) => b.toString(16).padStart(2, '0')).join('') + '>';
    const pdf = pagesPdf(
      ['BT /D1 10 Tf 10 10 Td (AB) Tj /G1 10 Tf (BC) Tj /D2 10 Tf (CA) Tj ET'],
      '/Font << /D1 10 0 R /D2 20 0 R /G1 30 0 R >>',
      [
        // A filter pdf.js reads and the raw reader does not: the program cannot be read.
        ...embedded(10, 'ABCDEF+DeckbackHex', { dict: '/Filter /ASCIIHexDecode', data: hex }),
        // Bytes that are no font.
        ...embedded(20, 'ABCDEF+DeckbackJunk', { data: new Uint8Array(400).map((_, i) => (i * 37) & 255), flate: true }),
        ...embedded(30, 'ABCDEF+DeckbackGood', { data: goodProgram, flate: true }),
      ],
    );
    const deck = await buildDeck(pdf);
    const fonts = deck.fonts.infos();
    const runs = runsOf(deck.slides[0]!.elements);
    // Every run is there, with its glyphs.
    expect(runs.map((r) => [r.text, fonts[r.fontKey]!.baseFont])).toEqual([
      ['AB', 'ABCDEF+DeckbackHex'],
      ['BC', 'ABCDEF+DeckbackGood'],
      ['CA', 'ABCDEF+DeckbackJunk'],
    ]);
    expect(runs.map((r) => r.glyphs.length)).toEqual([2, 2, 2]);
    const lost = { latinName: null, eaName: null, bold: false, italic: false, embedded: true, fsType: null, isVariable: false, type3: false, metrics: null };
    expect(fonts.f1).toEqual({ key: 'f1', baseFont: 'ABCDEF+DeckbackHex', ...lost });
    expect(fonts.f3).toEqual({ key: 'f3', baseFont: 'ABCDEF+DeckbackJunk', ...lost });
    // ... and the font that is fine keeps everything.
    expect(fonts.f2).toEqual({
      key: 'f2',
      baseFont: 'ABCDEF+DeckbackGood',
      latinName: 'Deckback Good',
      eaName: null,
      bold: true,
      italic: false,
      embedded: true,
      fsType: 8,
      isVariable: false,
      type3: false,
      metrics: { upm: 2048, hheaAsc: 1900, hheaDesc: -500, hheaLineGap: 67, winAsc: 2100, winDesc: 600, typoAsc: 1800, typoDesc: -420, typoLineGap: 300, fsSelection: 0xa0 },
    });
    expect(runs.map((r) => r.bold)).toEqual([false, true, false]);
  });

  it('a Korean BaseFont resolves to its program, and the inventory gets the name pdf.js gives back', async () => {
    const korean = testFont({
      names: [
        [3, 1, 0x404, 1, '德貝克'], // Chinese (Taiwan): a lower language id than 0x409, which still wins for latinName
        [3, 1, 0x409, 1, 'Deckback Sans'],
        [3, 1, 0x409, 2, 'Bold Italic'],
        [3, 1, 0x411, 1, 'デックバック'], // Japanese: Korean comes first
        [3, 1, 0x412, 1, '덱백 산스'],
      ],
      upm: 1000,
      variable: true,
    });
    const utf8 = pdfName(new TextEncoder().encode('ABCDEF+덱백산스'));
    const latin = pdfName(new TextEncoder().encode('ABCDEF+Café')); // UTF-8 too, but only Latin-1 characters
    const cp949 = pdfName(Uint8Array.of(0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x2b, 0xb5, 0xa6, 0xb9, 0xe9)); // not UTF-8
    const pdf = pagesPdf(
      ['BT /K1 10 Tf 10 10 Td (AB) Tj /K2 10 Tf (C) Tj /K3 10 Tf (A) Tj ET'],
      '/Font << /K1 10 0 R /K2 20 0 R /K3 30 0 R >>',
      [
        ...embedded(10, utf8, { data: korean, flate: true }),
        ...embedded(20, latin, { data: goodProgram, flate: true }),
        ...embedded(30, cp949, { data: goodProgram, flate: true }),
      ],
    );
    const deck = await buildDeck(pdf);
    const fonts = deck.fonts.infos();
    expect(fonts.f1).toMatchObject({
      baseFont: 'ABCDEF+덱백산스',
      latinName: 'Deckback Sans',
      eaName: '덱백 산스',
      bold: true,
      italic: true,
      embedded: true,
      isVariable: true,
    });
    // A name whose bytes give no character above U+00FF is kept one character a byte, as pdf.js reads it.
    expect(fonts.f2).toMatchObject({ baseFont: 'ABCDEF+CafÃ©', latinName: 'Deckback Good', embedded: true });
    expect(fonts.f3).toMatchObject({ baseFont: 'ABCDEF+µ¦¹é', latinName: 'Deckback Good', embedded: true });
    // The walker's glyphs name the fonts as pdf.js does, one character a byte; the inventory from the Scene does too.
    const [ops, size, slide] = [deck.ops[0]!, deck.sizes[0]!, deck.slides[0]!];
    expect(inventoryOfSlide(slide, fonts)).toEqual(toInventory([{ index: 0, size, ops }]).pages[0]);
    expect(new Set(ops.map((op) => op.glyph?.font))).toEqual(
      new Set(['ABCDEF+ë\u008d±ë°±ì\u0082°ì\u008a¤', 'ABCDEF+CafÃ©', 'ABCDEF+µ¦¹é']),
    );
  });

  it('latinName falls back to the first Windows record, then the Macintosh one; nameID 2 says Bold, not SemiBold', async () => {
    const font = (names: NameRecord[]) => ({ data: testFont({ names }), flate: true });
    const pdf = pagesPdf(
      ['BT /A1 10 Tf 10 10 Td (A) Tj /A2 10 Tf (B) Tj /A3 10 Tf (C) Tj ET'],
      '/Font << /A1 10 0 R /A2 20 0 R /A3 30 0 R >>',
      [
        ...embedded(10, 'ABCDEF+DeckbackKo', font([[3, 1, 0x412, 1, '덱백'], [3, 1, 0x412, 2, 'Bold'], [1, 0, 0, 1, 'Deckback Mac']])),
        ...embedded(20, 'ABCDEF+DeckbackMac', font([[1, 0, 0, 1, 'Deckback Mac'], [1, 0, 0, 2, 'Italic']])),
        ...embedded(30, 'ABCDEF+DeckbackSemi', font([[3, 1, 0x409, 1, 'Deckback Semi'], [3, 1, 0x409, 2, 'SemiBold']])),
      ],
    );
    const fonts = (await buildDeck(pdf)).fonts.infos();
    expect(Object.values(fonts).map(({ latinName, eaName, bold, italic }) => ({ latinName, eaName, bold, italic }))).toEqual([
      { latinName: '덱백', eaName: '덱백', bold: true, italic: false },
      { latinName: 'Deckback Mac', eaName: null, bold: false, italic: true },
      { latinName: 'Deckback Semi', eaName: null, bold: false, italic: false },
    ]);
  });

  it("M8 round 1a: a family that is a number alone (a font PowerPoint embedded) is the family the program's other names give", async () => {
    const font = (names: NameRecord[]) => ({ data: testFont({ names }), flate: true });
    const pdf = pagesPdf(
      ['BT /A1 10 Tf 10 10 Td (A) Tj /A2 10 Tf (B) Tj /A3 10 Tf (C) Tj ET'],
      '/Font << /A1 10 0 R /A2 20 0 R /A3 30 0 R >>',
      [
        // b-d629f67e73's Catamaran Light and Bold, b-14cbf3aedb's Ledger (public fonts)
        ...embedded(10, 'BCDHEE+11', font([[3, 1, 0x409, 1, '11'], [3, 1, 0x409, 2, 'Regular'], [3, 1, 0x409, 4, '11'], [3, 1, 0x409, 6, 'Catamaran-Light'], [3, 1, 0x409, 16, 'Catamaran'], [3, 1, 0x409, 17, 'Light']])),
        ...embedded(20, 'BCDGEE+2,Bold', font([[3, 1, 0x409, 1, '2'], [3, 1, 0x409, 2, 'Bold'], [3, 1, 0x409, 4, '2 Bold'], [3, 1, 0x409, 6, 'Catamaran-Bold']])),
        ...embedded(30, 'BCDEEE+1', font([[3, 1, 0x409, 1, '1'], [3, 1, 0x409, 2, 'Regular'], [3, 1, 0x409, 4, '1'], [3, 1, 0x409, 6, 'Ledger-Regular']])),
      ],
    );
    const fonts = (await buildDeck(pdf)).fonts.infos();
    expect(Object.values(fonts).map(({ latinName, bold }) => [latinName, bold])).toEqual([
      ['Catamaran Light', false],
      ['Catamaran', true],
      ['Ledger', false],
    ]);
  });

  it("M8 round 3a: a program whose names are its subset-tagged PostScript name (Adobe PDF Library) takes the descriptor's /FontFamily and its own style bits", async () => {
    // Acrobat's PDFMaker rewrites a subset's name table: nameID 1, 4 and 6 are the tagged PostScript name and nameID 2 is
    // Regular, bold and italic faces too. Written as it was, the typeface was `ABCDEF+Deckback-BookItalic` (no PC has
    // it) and the face's bold or italic was lost (tier C: S2 italic differs on 5 pages). The descriptor's /FontFamily is
    // the family, and the program's OS/2 fsSelection (bit 0 italic, bit 5 bold) the style
    const rewritten = (tagged: string, fsSelection: number) => ({
      data: testFont({ names: [[3, 1, 0x409, 1, tagged], [3, 1, 0x409, 2, 'Regular'], [3, 1, 0x409, 4, tagged], [3, 1, 0x409, 6, tagged]], fsSelection }),
      flate: true,
    });
    const font = (num: number, tagged: string, fsSelection: number, family: string | null, flags: number): MiniObject[] => [
      trueType(num, tagged, num + 1),
      {
        num: num + 1,
        body:
          `<< /Type /FontDescriptor /FontName /${tagged}${family === null ? '' : ` /FontFamily (${family})`} /Flags ${flags} /FontBBox [0 -200 1000 800] ` +
          `/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${num + 2} 0 R >>`,
      },
      { num: num + 2, ...rewritten(tagged, fsSelection) },
    ];
    const pdf = pagesPdf(
      ['BT /A1 10 Tf 10 10 Td (A) Tj /A2 10 Tf (B) Tj /A3 10 Tf (C) Tj /A4 10 Tf (A) Tj /A5 10 Tf (B) Tj ET'],
      '/Font << /A1 10 0 R /A2 20 0 R /A3 30 0 R /A4 40 0 R /A5 50 0 R >>',
      [
        ...font(10, 'ABCDEF+DeckbackGothic-BookItalic', 0x01, 'Deckback Gothic Book', 96),
        ...font(20, 'ABCDEG+DeckbackSans-Bold', 0x20, 'Deckback Sans', 32),
        ...font(30, 'ABCDEH+DeckbackSans', 0x40, 'Deckback Sans', 32),
        // no /FontFamily: the name without its tag and style
        ...font(40, 'ABCDEI+DeckbackMono-Italic', 0x01, null, 96),
        // a number alone (a font PowerPoint embedded, rewritten by Distiller) is no family: the name stays as it was
        ...font(50, 'ABCDEJ+3,Bold', 0x20, null, 32),
      ],
    );
    const fonts = (await buildDeck(pdf)).fonts.infos();
    expect(Object.values(fonts).map(({ latinName, bold, italic }) => [latinName, bold, italic])).toEqual([
      ['Deckback Gothic Book', false, true],
      ['Deckback Sans', true, false],
      ['Deckback Sans', false, false],
      ['DeckbackMono', false, true],
      ['ABCDEJ+3,Bold', true, false],
    ]);
  });

  it('M8 round 3c: a tagged font with no /FontFamily keeps the BaseFont style suffix; with no OS/2 the descriptor flags (ForceBold, Italic, weight) say the style', async () => {
    // iLovePDF and Distiller rewrite the names and may leave no OS/2 table: the style is then the descriptor's. Without
    // a /FontFamily the family comes from the BaseFont, and the BaseFont's style suffix still counts, so no style is lost
    const rewritten = (tagged: string, fsSelection: number, noOs2: boolean) => ({
      data: testFont({ names: [[3, 1, 0x409, 1, tagged], [3, 1, 0x409, 2, 'Regular'], [3, 1, 0x409, 4, tagged], [3, 1, 0x409, 6, tagged]], fsSelection, noOs2 }),
      flate: true,
    });
    const font = (num: number, tagged: string, o: { fsSelection?: number; noOs2?: boolean; family?: string; flags: number; weight?: number }): MiniObject[] => [
      trueType(num, tagged, num + 1),
      {
        num: num + 1,
        body:
          `<< /Type /FontDescriptor /FontName /${tagged}${o.family === undefined ? '' : ` /FontFamily (${o.family})`} /Flags ${o.flags} /FontBBox [0 -200 1000 800] ` +
          `/ItalicAngle 0${o.weight === undefined ? '' : ` /FontWeight ${o.weight}`} /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${num + 2} 0 R >>`,
      },
      { num: num + 2, ...rewritten(tagged, o.fsSelection ?? 0x40, o.noOs2 === true) },
    ];
    const pdf = pagesPdf(
      ['BT /A1 10 Tf 10 10 Td (A) Tj /A2 10 Tf (B) Tj /A3 10 Tf (C) Tj /A4 10 Tf (A) Tj /A5 10 Tf (B) Tj ET'],
      '/Font << /A1 10 0 R /A2 20 0 R /A3 30 0 R /A4 40 0 R /A5 50 0 R >>',
      [
        // OS/2 says Regular, no /FontFamily: the suffix still says bold italic
        ...font(10, 'ABCDEK+DeckbackSans-BoldItalic', { flags: 32 }),
        // no OS/2: ForceBold (flag bit 19) is bold
        ...font(20, 'ABCDEL+DeckbackSerif', { noOs2: true, family: 'Deckback Serif', flags: 32 | (1 << 18) }),
        // no OS/2: Italic flag and a FontWeight of 700
        ...font(30, 'ABCDEM+DeckbackSerif', { noOs2: true, family: 'Deckback Serif', flags: 32 | (1 << 6), weight: 700 }),
        // no OS/2, no /FontFamily, a plain descriptor: the suffix is all there is
        ...font(40, 'ABCDEN+DeckbackMono-Bold', { noOs2: true, flags: 32 }),
        // a /FontFamily and a Regular OS/2: nothing is added by the BaseFont's suffix
        ...font(50, 'ABCDEO+DeckbackSans-Bold', { family: 'Deckback Sans', flags: 32 }),
      ],
    );
    const fonts = (await buildDeck(pdf)).fonts.infos();
    expect(Object.values(fonts).map(({ latinName, bold, italic }) => [latinName, bold, italic])).toEqual([
      ['DeckbackSans', true, true],
      ['Deckback Serif', true, false],
      ['Deckback Serif', true, true],
      ['DeckbackMono', true, false],
      ['Deckback Sans', false, false],
    ]);
  });

  it("M8 round 3c: a Type0 font whose descendant has another subset tag than the Type0 font is found by the descendant's /BaseFont (pdf.js' name for it)", async () => {
    // PDFMaker writes /BaseFont /AAAAAA+X on the Type0 font and /BaseFont /BBBBBB+X on its CIDFont, and the program's names
    // are the CIDFont's. pdf.js names the font so; without the program, the /FontFamily and OS/2 style were never read
    // (tier B: 15 PDFMaker decks)
    const program = testFont({ names: [[3, 1, 0x409, 1, 'BBBBBB+DeckbackGothic-Bold'], [3, 1, 0x409, 2, 'Regular']], fsSelection: 0x20 });
    const pdf = pagesPdf(['BT /K1 10 Tf 10 10 Td <0001> Tj ET'], '/Font << /K1 10 0 R >>', [
      { num: 10, body: '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+DeckbackGothic-Bold /Encoding /Identity-H /DescendantFonts [11 0 R] >>' },
      { num: 11, body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /BBBBBB+DeckbackGothic-Bold /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /FontDescriptor 12 0 R >>' },
      { num: 12, body: '<< /Type /FontDescriptor /FontName /BBBBBB+DeckbackGothic-Bold /FontFamily (Deckback Gothic) /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 13 0 R >>' },
      { num: 13, data: program, flate: true },
    ]);
    const fonts = Object.values((await buildDeck(pdf)).fonts.infos());
    expect(fonts.map(({ latinName, bold, italic, embedded }) => [latinName, bold, italic, embedded])).toEqual([['Deckback Gothic', true, false, true]]);
  });

  it('the raw reader, not pdf.js, says whether a font is embedded', () => {
    // A font without a descriptor, whose name pdf.js writes with `-` for `,`: even if pdf.js had a program for it (one it
    // found itself), the PDF holds none.
    const pdf = pagesPdf(['BT /N1 10 Tf (A) Tj ET'], '/Font << /N1 10 0 R >>', [trueType(10, 'ABCDEF+Deckback,Bold')]);
    const table = new FontTable(openRawPdf(pdf));
    expect(table.resolve('ABCDEF+Deckback-Bold', 0, { missingFile: false })).toMatchObject({ embedded: false, latinName: 'Deckback' });
    // ... and a name no program of the page has is what pdf.js says it is.
    expect(table.resolve('ABCDEF+Elsewhere', 0, { missingFile: false })).toMatchObject({ embedded: true, latinName: 'Elsewhere' });
  });

  it('a Type 3 font is type3 and embedded, without names', async () => {
    // A Type 3 font that pdf.js names after its descriptor, as another font is named: two fonts all the same.
    const pdf = pagesPdf(
      ['BT /T1 10 Tf 10 10 Td (AB) Tj /F1 10 Tf (C) Tj ET'],
      '/Font << /T1 10 0 R /F1 13 0 R >>',
      [
        {
          num: 10,
          body:
            '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] /FirstChar 65 /LastChar 66 ' +
            '/Widths [600 600] /Encoding << /Differences [65 /A /B] >> /CharProcs << /A 11 0 R /B 11 0 R >> /FontDescriptor 12 0 R >>',
        },
        { num: 11, data: '1000 0 0 0 1000 1000 d1 0 0 500 500 re f' },
        { num: 12, body: '<< /Type /FontDescriptor /FontName /DeckbackSame /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 >>' },
        trueType(13, 'DeckbackSame'),
      ],
    );
    const deck = await buildDeck(pdf);
    expect(Object.values(deck.fonts.infos()).map(({ key, baseFont, type3, embedded, latinName, metrics }) => ({ key, baseFont, type3, embedded, latinName, metrics }))).toEqual([
      { key: 'f1', baseFont: 'DeckbackSame', type3: true, embedded: true, latinName: null, metrics: null },
      { key: 'f2', baseFont: 'DeckbackSame', type3: false, embedded: false, latinName: 'DeckbackSame', metrics: null },
    ]);
    expect(lines(deck.slides[0]!.elements).map((l) => [l.runs[0]!.text, l.runs[0]!.fontKey])).toEqual([
      ['AB', 'f1'],
      ['C', 'f2'],
    ]);
  });

  it("a Type 3 font listed before a real font with its /BaseFont is not that font's program (final review F2)", async () => {
    /** A Type 3 font of glyphs A and B, without a descriptor, whose /BaseFont is `baseFont`. */
    const type3 = (num: number, baseFont: string): MiniObject => ({
      num,
      body:
        `<< /Type /Font /Subtype /Type3 /BaseFont /${baseFont} /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] ` +
        '/FirstChar 65 /LastChar 66 /Widths [600 600] /Encoding << /Differences [65 /A /B] >> /CharProcs << /A 11 0 R /B 11 0 R >> >>',
    });
    // Each Type 3 font is listed before the real font whose /BaseFont it has: Helvetica, not embedded, and an embedded
    // TrueType font. pdf.js names both Type 3 fonts `Type3` (no descriptor), whatever their /BaseFont.
    const pdf = pagesPdf(
      ['BT /T1 10 Tf 10 10 Td (AB) Tj /F1 10 Tf (C) Tj /T2 10 Tf (A) Tj /G1 10 Tf (B) Tj ET'],
      '/Font << /T1 10 0 R /F1 12 0 R /T2 20 0 R /G1 30 0 R >>',
      [
        type3(10, 'Helvetica'),
        { num: 11, data: '1000 0 0 0 1000 1000 d1 0 0 500 500 re f' },
        { num: 12, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
        type3(20, 'ABCDEF+DeckbackGood'),
        ...embedded(30, 'ABCDEF+DeckbackGood', { data: goodProgram, flate: true }),
      ],
    );
    const deck = await buildDeck(pdf);
    const fonts = deck.fonts.infos();
    // The inventory the Scene gives back has the walker's glyphs, `type3` included.
    const [ops, size, slide] = [deck.ops[0]!, deck.sizes[0]!, deck.slides[0]!];
    const walker = toInventory([{ index: 0, size, ops }]).pages[0]!;
    expect(walker.glyphs.map((g) => [g.u, g.font, g.type3 ?? false])).toEqual([
      ['A', 'Type3', true],
      ['B', 'Type3', true],
      ['C', 'Helvetica', false],
      ['A', 'Type3', true],
      ['B', 'ABCDEF+DeckbackGood', false],
    ]);
    expect(inventoryOfSlide(slide, fonts).glyphs).toEqual(walker.glyphs);
    expect(inventoryOfSlide(slide, fonts)).toEqual(walker);
    const none = { eaName: null, bold: false, italic: false, fsType: null, isVariable: false, metrics: null };
    expect(fonts).toEqual({
      f1: { key: 'f1', baseFont: 'Type3', latinName: null, embedded: true, type3: true, ...none },
      // The real Helvetica keeps its names, is not embedded and is no Type 3 font.
      f2: { key: 'f2', baseFont: 'Helvetica', latinName: 'Helvetica', embedded: false, type3: false, ...none },
      // The embedded font keeps its program: its names and metrics.
      f3: {
        key: 'f3',
        baseFont: 'ABCDEF+DeckbackGood',
        latinName: 'Deckback Good',
        eaName: null,
        bold: true,
        italic: false,
        embedded: true,
        fsType: 8,
        isVariable: false,
        type3: false,
        metrics: { upm: 2048, hheaAsc: 1900, hheaDesc: -500, hheaLineGap: 67, winAsc: 2100, winDesc: 600, typoAsc: 1800, typoDesc: -420, typoLineGap: 300, fsSelection: 0xa0 },
      },
    });
  });

  it('the empty name, which pdf.js gives a font it could not load, matches no program (final review F2)', () => {
    // An embedded TrueType font without /BaseFont: the raw reader names its program ''.
    const pdf = pagesPdf(['BT /E1 10 Tf (A) Tj ET'], '/Font << /E1 10 0 R >>', [
      {
        num: 10,
        body:
          '<< /Type /Font /Subtype /TrueType /FirstChar 65 /LastChar 67 /Widths [600 600 600] /Encoding /WinAnsiEncoding ' +
          '/FontDescriptor 11 0 R >>',
      },
      descriptor(11, 'DeckbackGood', 12),
      { num: 12, data: goodProgram, flate: true },
    ]);
    expect(openRawPdf(pdf).pageRefs()).toHaveLength(1);
    // Only pdf.js speaks: it had no program, so the font is not embedded, and the empty name gives no family. Taken for
    // the program without /BaseFont, it would be embedded, with that program's names and metrics.
    const font = new FontTable(openRawPdf(pdf)).resolve('', 0, { missingFile: true });
    expect(font).toMatchObject({ baseFont: '', latinName: null, embedded: false, bold: false, metrics: null });
  });

  it("M8 round 1a: a symbol font's glyph has its own character (U+F000 + code) as `sym`, from its code and its program's (3, 0) cmap", async () => {
    // as a PowerPoint export writes Wingdings: Type0, Identity-H, its CIDs glyph ids, its ToUnicode another character
    const symbol = (name: string) => sfnt([['cmap', cmapOf([[3, 0]], [[0xf0a7, 0xf0a7, 2], [0xf0d8, 0xf0d8, 3]])], ['name', nameTable([[3, 0, 0x409, 1, name]])]]);
    const unicode = sfnt([['cmap', cmapOf([[3, 1]], [[0x41, 0x43, 1]])], ['name', nameTable([[3, 1, 0x409, 1, 'Deckback Uni']])]]);
    const toUnicode = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0002> <25AA> <0003> <27A2> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end';
    const type0 = (num: number, baseFont: string, program: Uint8Array, map?: string): MiniObject[] => [
      { num, body: `<< /Type /Font /Subtype /Type0 /BaseFont /${baseFont} /Encoding /Identity-H /DescendantFonts [${num + 1} 0 R] /ToUnicode ${num + 4} 0 R >>` },
      { num: num + 1, body: `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${baseFont} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /FontDescriptor ${num + 2} 0 R${map === undefined ? '' : ` /CIDToGIDMap ${map}`} >>` },
      { num: num + 2, body: `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${num + 3} 0 R >>` },
      { num: num + 3, data: program, flate: true },
      { num: num + 4, data: toUnicode },
    ];
    const pdf = pagesPdf(
      ['BT /W1 10 Tf 10 10 Td <00030002> Tj /W2 10 Tf <0002> Tj /S1 10 Tf (AB) Tj /U1 10 Tf <0003> Tj ET'],
      '/Font << /W1 10 0 R /W2 20 0 R /S1 30 0 R /U1 40 0 R >>',
      [
        ...type0(10, 'BCDIEE+Wingdings-Regular', symbol('Wingdings')),
        // CIDToGIDMap as a stream: CID 2 is glyph 3
        ...type0(20, 'BCDJEE+Wingdings-Regular', symbol('Wingdings'), '50 0 R'),
        { num: 50, data: new Uint8Array([0, 0, 0, 0, 0, 3]) },
        // a simple TrueType font under a real symbol family: the code itself, where the cmap has U+F000 + it
        ...embedded(30, 'ABCDEF+Wingdings-Regular', { data: sfnt([['cmap', cmapOf([[3, 0]], [[0xf041, 0xf041, 1]])], ['name', nameTable([[3, 0, 0x409, 1, 'Wingdings']])]]), flate: true }),
        // a Unicode font: no sym
        ...type0(40, 'ABCDEF+DeckbackUni', unicode),
      ],
    );
    const runs = runsOf((await buildDeck(pdf)).slides[0]!.elements);
    expect(runs.map((r) => r.glyphs.map((g) => [g.u, g.sym ?? null]))).toEqual([
      [['\u27a2', '\uf0d8'], ['\u25aa', '\uf0a7']],
      [['\u25aa', '\uf0d8']],
      [['A', '\uf041'], ['B', null]],
      [['\u27a2', null]],
    ]);
  });

  it('M8 R8: a text font with a (1, 0) + (3, 0) cmap and Flags 6 stays normal text (Ghostscript-written Microsoft Sans Serif)', async () => {
    const program = sfnt([['cmap', cmapOf([[1, 0], [3, 0]], [[0x41, 0x43, 1]])], ['name', nameTable([[3, 1, 0x409, 1, 'Microsoft Sans Serif']])]]);
    const pdf = pagesPdf(['BT /E1 10 Tf 10 10 Td (ABC) Tj ET'], '/Font << /E1 10 0 R >>', [
      trueType(10, 'ABCDEF+MicrosoftSansSerif', 11),
      { num: 11, body: '<< /Type /FontDescriptor /FontName /ABCDEF+MicrosoftSansSerif /Flags 6 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 12 0 R >>' },
      { num: 12, data: program, flate: true },
    ]);
    const runs = runsOf((await buildDeck(pdf)).slides[0]!.elements);
    expect(runs.flatMap((r) => r.glyphs.map((g) => [g.u, g.sym ?? null]))).toEqual([['A', null], ['B', null], ['C', null]]);
  });

  it('M8 R8: a symbol family needs the symbolic flag or a cmap with no Unicode subtable; a symbol-named font with both a Unicode cmap and no flag is text', async () => {
    const mixed = sfnt([['cmap', cmapOf([[3, 0], [3, 1]], [[0xf041, 0xf041, 1], [0x41, 0x41, 1]])], ['name', nameTable([[3, 0, 0x409, 1, 'Wingdings']])]]);
    const pdf = pagesPdf(['BT /E1 10 Tf 10 10 Td (A) Tj ET'], '/Font << /E1 10 0 R >>', embedded(10, 'ABCDEF+Wingdings-Regular', { data: mixed, flate: true }));
    const runs = runsOf((await buildDeck(pdf)).slides[0]!.elements);
    expect(runs.flatMap((r) => r.glyphs.map((g) => g.sym ?? null))).toEqual([null]);
  });

  it('M8 I1: a hostile symbol font (a format 4 cmap of 32,767 segments over zero glyph ids) is refused: its text is kept as it is', async () => {
    const pdf = pagesPdf(['BT /E1 10 Tf 10 10 Td (A) Tj ET'], '/Font << /E1 10 0 R >>', embedded(10, 'ABCDEF+Wingdings-Regular', { data: sfnt([['cmap', hostileCmap()], ['name', nameTable([[3, 0, 0x409, 1, 'Wingdings']])]]), flate: true }));
    const started = Date.now();
    const runs = runsOf((await buildDeck(pdf)).slides[0]!.elements);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(runs.flatMap((r) => r.glyphs.map((g) => [g.u, g.sym ?? null]))).toEqual([['A', null]]);
  });

  it('M8 I2: a 32K-character name is cut (64 characters as a typeface), its control characters stripped', () => {
    const long = 'Deckback' + 'X'.repeat(32000);
    const program = sfnt([['name', nameTable([[3, 1, 0x409, 1, `\u0001${long}\u0007`], [3, 1, 0x409, 4, long], [3, 1, 0x409, 16, long], [3, 1, 0x409, 17, 'Light']])]]);
    const pdf = pagesPdf(['BT /E1 10 Tf (A) Tj ET'], '/Font << /E1 10 0 R >>', embedded(10, 'ABCDEF+DeckbackLong', { data: program, flate: true }));
    const font = new FontTable(openRawPdf(pdf)).resolve('ABCDEF+DeckbackLong', 0, { missingFile: false });
    expect(font.latinName).toBe(long.slice(0, 64));
    expect(font.latinName).not.toMatch(/[\u0000-\u001f]/);
  });

  it('a FontTable without the raw reader names a font by what pdf.js says (M2-R6)', () => {
    const table = new FontTable(null);
    const plain = table.resolve('ABCDEF+DeckbackSans-BoldItalic', 0, { missingFile: false });
    const missing = table.resolve('DeckbackOther', 3, { missingFile: true });
    expect([plain, missing].map(({ key, baseFont, latinName, embedded }) => ({ key, baseFont, latinName, embedded }))).toEqual([
      { key: 'f1', baseFont: 'ABCDEF+DeckbackSans-BoldItalic', latinName: 'DeckbackSans', embedded: true },
      { key: 'f2', baseFont: 'DeckbackOther', latinName: 'DeckbackOther', embedded: false },
    ]);
    // The same name is the same font, on any page.
    expect(table.resolve('ABCDEF+DeckbackSans-BoldItalic', 7, { missingFile: false }).key).toBe('f1');
    expect(Object.keys(table.infos())).toEqual(['f1', 'f2']);
    const copy: FontInfo = table.infos().f1!;
    copy.latinName = 'changed';
    expect(table.infos().f1!.latinName).toBe('DeckbackSans'); // the table's own entries do not change
  });
});
