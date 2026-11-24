import { describe, expect, it } from 'vitest';
import { OPS } from '../../src/engine/pdfjs-adapter';
import { compareInventories, toInventory, type Inventory } from '../../src/extract/inventory';
import type { RawOp } from '../../src/extract/walker';
import { canonicalJson } from '../../src/scene/canonical';
import { inventoryOfSlide } from '../../src/scene/inventory';
import type { Element, SceneSlide, TextLineEl } from '../../src/scene/types';
import { buildDeck, pagesPdf, schemaErrors, validateSlide } from '../helpers/scene';
import { syntheticPdf } from '../helpers/synthetic';

/**
 * Scene v1, text (Task 9): one `TextLineEl` with one `TextRun` per `showText` run, holding every glyph's origin and
 * advance, the run's paint, and the raw evidence M4 decides synthetic bold and italic from. `inventoryOfSlide` rebuilds
 * the walker's glyphs and invisible glyphs from the Scene and its font table.
 */

/** Builds the one slide of a PDF, which must validate and be rounded as built (M2-R13). */
async function slideOf(bytes: Uint8Array) {
  const deck = await buildDeck(bytes);
  const slide = deck.slides[0]!;
  expect(schemaErrors(validateSlide, slide)).toEqual([]);
  expect(JSON.parse(canonicalJson(slide))).toEqual(slide);
  return { ...deck, slide, ops: deck.ops[0]!, fnArray: deck.fnArrays[0]!, size: deck.sizes[0]! };
}

const walk = (content: string) => slideOf(syntheticPdf(content));
const lines = (elements: readonly Element[]): TextLineEl[] => elements.filter((e): e is TextLineEl => e.kind === 'textline');
/** The index of the n-th (from 0) operator `fn` of the page. */
const nth = (fnArray: number[], fn: number, n = 0): number => fnArray.flatMap((f, i) => (f === fn ? [i] : []))[n]!;

/**
 * The walker's RawOps the Scene gives back as inventory: all but the shade or pattern that fills text, which the text's
 * run holds (`TextRun.fill`), and which `inventoryOfSlide` does not rebuild.
 */
const mapped = (ops: RawOp[]): RawOp[] => ops.filter((op) => !((op.kind === 'shade' || op.kind === 'pattern') && op.text === true));

/** `inventoryOfSlide` gives the walker's inventory back: exactly, and so within tolerance. */
function expectSameInventory(slide: SceneSlide, size: [number, number], ops: RawOp[], fonts: Parameters<typeof inventoryOfSlide>[1]) {
  const expected: Inventory = toInventory([{ index: slide.index, size, ops: mapped(ops) }]);
  const actual: Inventory = { pages: [inventoryOfSlide(slide, fonts)] };
  expect(compareInventories(expected, actual).diffs).toEqual([]);
  expect(actual).toEqual(expected);
  return expected.pages[0]!;
}

/** A non-embedded Type0 font (Identity-H) whose CIDs 1 to 4 are 안, 녕, 세 and 계, each 1000 wide. */
const HANGUL_FONT = [
  { num: 10, body: '<< /Type /Font /Subtype /Type0 /BaseFont /DeckbackHangul /Encoding /Identity-H /DescendantFonts [11 0 R] /ToUnicode 12 0 R >>' },
  {
    num: 11,
    body:
      '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DeckbackHangul /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
      '/FontDescriptor 13 0 R /DW 1000 /CIDToGIDMap /Identity >>',
  },
  {
    num: 12,
    data:
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def ' +
      '1 begincodespacerange <0000> <FFFF> endcodespacerange ' +
      '4 beginbfchar <0001> <C548> <0002> <B155> <0003> <C138> <0004> <ACC4> endbfchar ' +
      'endcmap CMapName currentdict /CMap defineresource pop end end',
  },
  {
    num: 13,
    body: '<< /Type /FontDescriptor /FontName /DeckbackHangul /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
  },
];

describe('buildSlide: text lines', () => {
  it('a TJ run is one line: text, baseline, size, colour', async () => {
    // DeckbackTest (/F1): A, B and C are 667 wide; the TJ number moves C 10 pt on.
    const { slide, fnArray, fonts } = await walk('BT 1 0 0 rg /F1 20 Tf 50 100 Td [(AB) -500 (C)] TJ ET');
    const n = nth(fnArray, OPS.showText);
    const [line, ...rest] = slide.elements;
    expect(rest).toEqual([]);
    expect(line).toMatchObject({
      kind: 'textline',
      id: `p1:z${n}`,
      provenance: { opIndex: [n], mcid: null, struct: null },
      clip: [],
      clipBox: [0, 0, 300, 300],
      groups: [],
      mask: null,
      blend: 'normal',
      baseline: { x: 50, y: 200 },
      angleDeg: 0,
      wmode: 0,
    });
    const el = line as TextLineEl;
    expect(el.runs).toEqual([
      {
        text: 'ABC',
        fontKey: 'f1',
        sizePt: 20,
        rgb: [255, 0, 0],
        alpha: 1,
        fillMode: 'fill',
        stroke: null,
        fill: { kind: 'solid', rgb: [255, 0, 0], alpha: 1 },
        bold: false,
        italic: false,
        spcPt: 0,
        hScale: 1,
        skew: 0,
        rise: 0,
        glyphs: [
          { u: 'A', x: 50, y: 200, adv: 13.34 },
          { u: 'B', x: 63.34, y: 200, adv: 13.34 },
          { u: 'C', x: 86.68, y: 200, adv: 13.34 },
        ],
      },
    ]);
    // The box of the advance boxes, from the first origin to the last glyph's end.
    expect([el.bboxPt[0], el.bboxPt[2]]).toEqual([50, 100.02]);
    expect(el.bboxPt[1]).toBeLessThanOrEqual(200);
    expect(el.bboxPt[3]).toBeGreaterThanOrEqual(200);
    expect(Object.keys(fonts.infos())).toEqual(['f1']);
  });

  it('Hangul words without space glyphs keep their origins', async () => {
    // Two words set with a TJ gap and no space glyph, as PowerPoint sets Korean text.
    const pdf = pagesPdf(['BT /K1 20 Tf 50 100 Td [<00010002> -500 <00030004>] TJ ET'], '/Font << /K1 10 0 R >>', HANGUL_FONT);
    const { slide } = await slideOf(pdf);
    const [line] = lines(slide.elements);
    const run = line!.runs[0]!;
    expect(run.text).toBe('안녕세계');
    expect(run.glyphs).toEqual([
      { u: '안', x: 50, y: 200, adv: 20 },
      { u: '녕', x: 70, y: 200, adv: 20 },
      { u: '세', x: 100, y: 200, adv: 20 },
      { u: '계', x: 120, y: 200, adv: 20 },
    ]);
    // The gap between the words is there in the origins: 녕 ends at 90, 세 starts at 100.
    expect(run.glyphs[2]!.x - (run.glyphs[1]!.x + run.glyphs[1]!.adv)).toBe(10);
  });

  it('a rotated run has angleDeg', async () => {
    // Turned a quarter anticlockwise on the page, and 30 degrees: on the slide (y down) those are 270 and 330 clockwise.
    const { slide } = await walk('BT /F1 10 Tf 0 1 -1 0 100 100 Tm (AB) Tj ET BT /F1 10 Tf 0.8660254 0.5 -0.5 0.8660254 150 100 Tm (A) Tj ET');
    const [up, turned] = lines(slide.elements);
    expect(up).toMatchObject({ angleDeg: 270, baseline: { x: 100, y: 200 } });
    expect(up!.runs[0]!.glyphs).toEqual([
      { u: 'A', x: 100, y: 200, adv: 6.67 },
      { u: 'B', x: 100, y: 193.33, adv: 6.67 },
    ]);
    expect(turned).toMatchObject({ angleDeg: 330, baseline: { x: 150, y: 200 } });
    expect([up!.runs[0]!.skew, turned!.runs[0]!.skew]).toEqual([0, 0]);
  });

  it('Tr 2 has fillMode fillStroke and stroke.wPt', async () => {
    // Under a CTM of scale 2, at ca 0.5 and CA 0.25 (/GS1), a 1.5 line width is 3 pt on the slide.
    const { slide } = await walk(
      'q 2 0 0 2 0 0 cm /GS1 gs 1.5 w 1 0 0 rg 0 0 1 RG BT /F1 10 Tf 2 Tr 10 120 Td (AB) Tj 1 Tr 0 -10 Td (A) Tj ' +
        '3 Tr 0 -10 Td (B) Tj 0 Tr 0 -10 Td (C) Tj 7 Tr 0 -10 Td (A) Tj ET Q',
    );
    const runs = lines(slide.elements).map((l) => l.runs[0]!);
    const paint = runs.map(({ text, fillMode, rgb, alpha, fill, stroke, sizePt, bold }) => ({ text, fillMode, rgb, alpha, fill, stroke, sizePt, bold }));
    const red = { kind: 'solid', rgb: [255, 0, 0], alpha: 0.5 };
    const blue = { rgb: [0, 0, 255], alpha: 0.25, wPt: 3 };
    expect(paint).toEqual([
      // Synthetic bold (Tr 2 and a line width) is evidence for M4: the font's own nameID 2 says it is not bold.
      { text: 'AB', fillMode: 'fillStroke', rgb: [255, 0, 0], alpha: 0.5, fill: red, stroke: blue, sizePt: 20, bold: false },
      { text: 'A', fillMode: 'stroke', rgb: [0, 0, 255], alpha: 0.25, fill: null, stroke: blue, sizePt: 20, bold: false },
      { text: 'B', fillMode: 'noFill', rgb: null, alpha: 1, fill: null, stroke: null, sizePt: 20, bold: false },
      { text: 'C', fillMode: 'fill', rgb: [255, 0, 0], alpha: 0.5, fill: red, stroke: null, sizePt: 20, bold: false },
      // Tr 7 reaches MuPDF and the walker at ET, after the others (0002 §6).
      { text: 'A', fillMode: 'clip', rgb: null, alpha: 1, fill: null, stroke: null, sizePt: 20, bold: false },
    ]);
  });

  it('a vertical run has wmode 1', async () => {
    // /V1: Identity-V, 600 wide, the default metrics [-1000, 300, 880]: origins 3 pt left of the pen and 8.8 pt below
    // it, one em (10 pt) apart down the column.
    const { slide } = await walk('BT /V1 10 Tf 100 200 Td <00020003> Tj ET');
    const [line] = lines(slide.elements);
    expect(line).toMatchObject({ wmode: 1, angleDeg: 0, baseline: { x: 97, y: 108.8 } });
    expect(line!.runs[0]!.glyphs).toEqual([
      { u: 'A', x: 97, y: 108.8, adv: 6 },
      { u: 'B', x: 97, y: 118.8, adv: 6 },
    ]);
  });

  it('Tc, Tz, Ts and a skewed text matrix are kept as raw evidence (M4 decides synthetic italic)', async () => {
    // Tm 1 0 0.2 1 leans the glyphs 0.2 to the right (on the slide: x axis (1, 0), y axis (0.2, -1)).
    const { slide } = await walk('BT /F1 10 Tf 2 Tc 150 Tz 3 Ts 1 0 0.2 1 20 100 Tm (AB) Tj ET');
    const [line] = lines(slide.elements);
    // The baseline is the first origin without the rise: 3 along the y axis (0.6, -3) back.
    expect(line).toMatchObject({ angleDeg: 0, baseline: { x: 20, y: 200 } });
    const run = line!.runs[0]!;
    // Tc 2 at Tz 150 is 3 pt; Ts 3 is 3 x |(0.2, -1)| = 3.059 pt; the size is 10 x |(0.2, -1)|.
    expect(run).toMatchObject({ spcPt: 3, hScale: 1.5, skew: 0.2, rise: 3.059, sizePt: 10.198, italic: false });
    // A advances (6.67 + 2) x 1.5 = 13.005.
    expect(run.glyphs).toEqual([
      { u: 'A', x: 20.6, y: 197, adv: 13.005 },
      { u: 'B', x: 33.605, y: 197, adv: 13.005 },
    ]);
  });

  it('text stroked with a pattern says it strokes, without a stroke colour', async () => {
    // TextRun.stroke holds a colour; a pattern stroke has none (and tier A has no pattern-stroked text).
    const { slide } = await walk('BT 1 Tr /Pattern CS /P1 SCN /F1 10 Tf 20 100 Td (AB) Tj 2 Tr 0 0 1 rg (C) Tj ET');
    const runs = lines(slide.elements).map((l) => l.runs[0]!);
    expect(runs.map(({ fillMode, rgb, fill, stroke }) => ({ fillMode, rgb, fill, stroke }))).toEqual([
      { fillMode: 'stroke', rgb: null, fill: null, stroke: null },
      { fillMode: 'fillStroke', rgb: [0, 0, 255], fill: { kind: 'solid', rgb: [0, 0, 255], alpha: 1 }, stroke: null },
    ]);
  });

  it('pattern-filled text keeps its pattern in TextRun.fill and paints no element of its own', async () => {
    const { slide, ops } = await walk('BT /Pattern cs /P1 scn /F1 10 Tf 20 100 Td (AB) Tj ET BT /Pattern cs /P2 scn /F1 10 Tf 20 50 Td (C) Tj ET');
    // The walker paints each stretch's pattern too (0002 §5): the Scene puts it in the run.
    expect(ops.filter((op) => op.text === true).map((op) => op.kind)).toEqual(['shade', 'pattern']);
    expect(slide.elements.map((e) => e.kind)).toEqual(['textline', 'textline']);
    const [gradient, tiled] = lines(slide.elements).map((l) => l.runs[0]!);
    expect(gradient).toMatchObject({ rgb: null, fillMode: 'fill', fill: { kind: 'linear', p0: [0, 0], p1: [300, 0], alpha: 1 } });
    expect(tiled).toMatchObject({ rgb: null, fillMode: 'fill', fill: { kind: 'tile', alpha: 1 } });
    const cell = tiled!.fill!.kind === 'tile' ? tiled!.fill!.cell : null;
    expect(cell!.elements.length).toBeGreaterThan(0);
    // The cell's elements are named under the text line they fill.
    expect(cell!.elements[0]!.id.startsWith(`${lines(slide.elements)[1]!.id}/z`)).toBe(true);
  });

  it("inventoryOfSlide equals the walker's glyphs and invisible glyphs, including font, size and paint", async () => {
    // The render mode is graphics state: it lasts past ET, so each block sets its own.
    const { slide, ops, size, fonts } = await walk(
      'BT /F1 12 Tf 1 0 0 rg 20 270 Td (AB C) Tj ET ' +
        'BT 3 Tr /F2 10 Tf 20 255 Td (ABC) Tj ET ' +
        'BT 2 Tr 0 0 1 RG 0 1 0 rg /F3 10 Tf 20 240 Td [(A) 200 (B)] TJ ET ' +
        'BT 0 Tr /T3 10 Tf 20 225 Td (ABCD) Tj ET BT 3 Tr /T4 10 Tf 120 225 Td (AB) Tj ET ' +
        'BT 0 Tr /V2 10 Tf 250 280 Td <000200030004> Tj ET ' +
        'q /GS10 gs /Fm8 Do Q ' +
        'BT /Pattern cs /P1 scn /F1 10 Tf 20 150 Td (AB) Tj ET ' +
        'q /GS1 gs BT 1 Tr 0.5 0 0 RG /F1 10 Tf 2 Ts 150 Tz 1 Tc 20 130 Td (AB) Tj ET Q ' +
        'q BT 7 Tr /F1 10 Tf 20 110 Td (C) Tj ET 1 0 0 rg 0 0 300 300 re f Q',
    );
    const page = expectSameInventory(slide, size, ops, fonts.infos());

    // The page reaches what it is meant to.
    expect(new Set(page.glyphs.map((g) => g.paint))).toEqual(new Set(['fill', 'fillStroke', 'stroke', 'clip']));
    expect(page.glyphs.some((g) => g.u === ' ')).toBe(true); // whitespace stays in the output (0002 §8)
    expect(page.glyphs.some((g) => g.type3 === true) && page.invisible.some((g) => g.type3 === true)).toBe(true);
    expect(page.glyphs.some((g) => g.wmode === 1)).toBe(true);
    expect(page.glyphs.some((g) => g.paint === 'fill' && g.rgb === null)).toBe(true); // pattern-filled
    expect(new Set(page.glyphs.map((g) => g.groupAlpha))).toEqual(new Set([1, 0.8, 0.32]));
    expect(page.invisible.map((g) => g.font)).toContain('ABCDEF+DeckbackSubset');
    // One code point more than glyphs: the 1:N mapping of the Type 3 font's D gives A and B at one origin, the second
    // with no advance of its own.
    const type3 = lines(slide.elements).find((l) => fonts.infos()[l.runs[0]!.fontKey]!.type3)!.runs[0]!;
    expect(type3.text).toBe('AB\u{1F44D}AB');
    expect(type3.glyphs.slice(3).map((g) => [g.u, g.x, g.adv > 0])).toEqual([
      ['A', type3.glyphs[3]!.x, true],
      ['B', type3.glyphs[3]!.x, false],
    ]);
  });
});
