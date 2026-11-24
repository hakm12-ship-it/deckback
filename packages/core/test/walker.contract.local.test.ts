import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, releasePage } from '../src/engine/pdfjs-adapter';
import { compareInventories, TOLERANCE_PT, type Glyph, type Inventory, type PageInv } from '../src/extract/inventory';
import { walkPage } from '../src/extract/walker';
import { repoRoot } from './helpers/fixtures';
import { oracleInventory, runPython, walkerInventory } from './helpers/oracle';
import { syntheticPdf, writeOut } from './helpers/synthetic';

/**
 * The inventory contract's fields, checked against the PyMuPDF oracle on synthetic pages at 0.05 pt (TOLERANCE_PT).
 * "0002 §n" cites docs/decisions/0002-inventory-contract.md. Pages are written to out/contract/.
 */

/** The page of both engines, compared. Both must have read the page and agree on every field. */
async function contract(name: string, content: string, page?: string): Promise<{ expected: PageInv; actual: PageInv }> {
  const bytes = syntheticPdf(content, page);
  const pdf = writeOut(`contract/${name}.pdf`, bytes);
  const expected: Inventory = oracleInventory(pdf, [1]);
  const { inventory: actual } = await walkerInventory(bytes, [1]);
  const result = compareInventories(expected, actual, TOLERANCE_PT);
  expect(result.diffs).toEqual([]);
  expect(result.ok).toBe(true);
  return { expected: expected.pages[0]!, actual: actual.pages[0]! };
}

/**
 * A comparison only sees a field both sides have: a fill or stroke must really carry its path, a stroke its line, an image
 * its matrix, pixel size and stencil flag, a shade its kind of shading.
 */
function expectDetail(...pages: PageInv[]): void {
  for (const page of pages) {
    for (const paint of page.paints) {
      if (paint.kind === 'fill' || paint.kind === 'stroke') expect(paint.path).toBeInstanceOf(Array);
      if (paint.kind === 'stroke') expect(paint.line).toBeInstanceOf(Object);
      else expect(paint.line).toBeUndefined();
      if (paint.kind === 'image') {
        expect(paint.ctm).toHaveLength(6);
        expect(paint.px).toHaveLength(2);
        expect(typeof paint.stencil).toBe('boolean');
      } else {
        expect([paint.ctm, paint.px, paint.stencil]).toEqual([undefined, undefined, undefined]);
      }
      if (paint.kind === 'shade') expect(['function', 'axial', 'radial', 'mesh']).toContain(paint.shading);
      else expect(paint.shading).toBeUndefined();
    }
  }
}

const kinds = (page: PageInv): string[] => page.paints.map((p) => p.kind);

describe('0002 §14 path geometry', () => {
  it('path geometry: rectangle, lines, c/v/y curves, repeated moveTo, degenerate lineTo, close', async () => {
    const { expected, actual } = await contract(
      'path-geometry',
      [
        '10 20 30 40 re f', // a rectangle
        '100 20 m 130 20 l 130 60 l f',
        '0 0 1 RG 10 100 m 40 180 90 180 120 100 c S', // c
        '150 100 m 180 180 220 100 v S', // v: the first control point is the current point
        '10 200 m 40 280 90 200 y S', // y: the last control point is the end point
        '200 200 m 210 210 m 220 220 l S', // a repeated moveTo collapses
        '150 200 m 180 200 l 180 200 l 180 230 l S', // a lineTo to the current point is dropped
        '240 10 m 240 10 l S', // ... except right after a moveTo: a dot
        '250 40 m 280 40 l 280 70 l h S', // close
        '250 100 m 280 100 l 280 130 l s', // s closes
        '0.5 g 250 150 m 280 150 l 280 180 l b', // b closes before the fill too
        '250 200 m 280 200 l 280 230 l b*',
        '10 150 m 40 150 l 70 170 m S', // a trailing moveTo is dropped
        '100 240 m 130 240 l h 130 260 l S', // a lineTo after a close starts at the subpath's start
      ].join(' '),
    );
    expectDetail(expected, actual);
    expect(expected.paints[0]!.path).toEqual([['M', 10, 280], ['L', 40, 280], ['L', 40, 240], ['L', 10, 240], ['Z']]);
    expect(actual.paints[0]!.path).toEqual(expected.paints[0]!.path);
    expect(kinds(actual).filter((k) => k === 'stroke')).toHaveLength(12);
  }, 60_000);

  it('path geometry: rectangles of no width or height, and what MuPDF simplifies', async () => {
    const { expected, actual } = await contract(
      'path-degenerate',
      [
        '10 10 0 40 re f 30 10 40 0 re f 80 10 0 0 re f -10 -10 m 100 100 -30 -40 re f', // pdf.js writes M L Z for these
        '10 100 m 10 100 10 100 40 130 c S', // a line
        '50 100 m 80 130 80 130 80 130 c S', // a line
        '90 100 m 90 100 120 130 120 130 c S', // a line
        '130 100 m 130 100 130 100 130 100 c S', // a dot
        '140 100 m 170 130 l 170 130 170 130 170 130 c S', // dropped
        '180 100 m 180 100 200 130 210 100 c S', // a curve stays a curve
        '220 100 m 240 130 250 100 250 100 c S', // a curve stays a curve
        '10 200 m 30 230 30 230 v S 50 200 m 50 200 70 230 y S', // v and y: MuPDF simplifies them its own way
        '90 200 m 120 200 l h h S', // a second close adds nothing
        '130 200 m h S', // a closed moveTo is a dot
        '150 200 m 180 200 l 180 230 l 150 200 l h S', // a lineTo back to the start before a close
        '10 250 m 10 250 l 40 250 l S', // a dot that goes on is a line
        '60 250 l 70 260 l 80 250 m 90 260 l S', // no current point: dropped up to the first moveTo
        '100 250 l h S', // nothing but that: no paint at all
        'q 0.8 0.6 -0.6 0.8 0 0 cm 150 100 m h S 150 100 m h f Q', // a closed moveTo under a turning CTM: no paint either
        'q 0.8 0.6 -0.6 0.8 0 0 cm 150 100 m h 200 100 m 220 110 l S Q', // ... and it adds nothing to the box
        'q 2 0 0 2 0 0 cm 60 120 m h 100 120 m 110 130 l S Q', // ... under one that keeps the axes it does (0002 §4)
      ].join(' '),
    );
    expectDetail(expected, actual);
  }, 60_000);

  it('path geometry: in the slide frame of a rotated page with a crop box', async () => {
    for (const rotate of [0, 90, 180, 270]) {
      const { expected, actual } = await contract(
        `path-rotate-${rotate}`,
        '1 0 0 rg 30 40 50 60 re f 0 0 1 RG 3 w [4 2] 1 d 30 50 m 60 120 90 120 120 60 c S ' +
          '/Pattern CS /P1 SCN 40 50 30 30 re S 60 60 m 90 70 l S 1 j 60 60 m 90 70 l S', // and how far a pattern stroke reaches
        `/MediaBox [0 0 300 200] /CropBox [10 20 210 170] /Rotate ${rotate}`,
      );
      expectDetail(expected, actual);
    }
  }, 60_000);
});

describe('0002 §15 line style', () => {
  it('line style: width under a scaled CTM, LC, LJ, ML, dash and phase, set by operators and through gs', async () => {
    const { expected, actual } = await contract(
      'line-style',
      [
        '10 10 m 50 10 l S', // the defaults
        'q 2 0 0 3 0 0 cm 4 w 1 J 2 j 3 M [1 2 3] 5 d 10 10 m 30 10 l S Q', // operators, under a scaled CTM
        '60 10 m 90 10 l S', // Q restored them
        'q /GS3 gs 10 60 m 50 60 l S', // through gs
        '2 0 0 2 0 0 cm 30 30 m 50 30 l S Q',
        'q 0.8 0.6 -0.6 0.8 100 100 cm 2 w [3 1] 0 d 0 0 m 30 0 l S Q', // a rotated CTM keeps its scale
        'q 2 w 1 J 1 j /Fm4 Do 10 140 m 50 140 l S Q', // a form inherits the line state, and its changes end with it
        'q 5 J 7 j 10 160 m 50 160 l S -1 J -1 j 60 160 m 90 160 l S 1.9 J 2.9 j 100 160 m 140 160 l S Q', // cap and join are clamped
        'q 0 M 10 180 m 50 180 l S Q',
        'q [] 3 d 10 200 m 50 200 l S [0 0] 0 d 60 200 m 90 200 l S Q',
      ].join(' '),
    );
    expectDetail(expected, actual);
    const lines = expected.paints.filter((p) => p.kind === 'stroke').map((p) => p.line!);
    expect(lines[0]).toEqual({ w: 1, cap: 0, join: 0, miter: 10, dash: [], phase: 0 });
    // Width, dash and phase are slide-frame points: the PDF value × √|ad − bc| (√6 here).
    expect(lines[1]).toEqual({ w: 9.798, cap: 1, join: 2, miter: 3, dash: [2.449, 4.899, 7.348], phase: 12.247 });
    expect(lines[2]).toEqual(lines[0]);
    expect(lines[3]).toEqual({ w: 3, cap: 1, join: 2, miter: 7, dash: [4, 2], phase: 1 });
    expect(lines[4]).toEqual({ w: 6, cap: 1, join: 2, miter: 7, dash: [8, 4], phase: 2 });
    expect(actual.paints.filter((p) => p.kind === 'stroke').map((p) => p.line!)).toEqual(lines);
  }, 60_000);

  it('a zero-width stroke', async () => {
    const { expected, actual } = await contract('line-zero-width', '0 w 10 10 m 50 50 l S q 3 0 0 3 0 0 cm 20 20 m 40 20 l S Q');
    expectDetail(expected, actual);
    expect(expected.paints.map((p) => p.line!.w)).toEqual([0, 0]);
  }, 60_000);
});

describe('0002 §15 strokes with a pattern', () => {
  const SHADED = '/Pattern CS /P1 SCN';
  const TILED = '/Pattern CS /P2 SCN';

  it('stroke with a shading pattern: miter join and round join', async () => {
    const triangle = '100 100 m 140 100 l 120 130 l h';
    const { expected, actual } = await contract(
      'stroke-shading',
      [
        SHADED,
        `2 w ${triangle} S`, // the default miter join and limit: width × limit
        `2 w 1 j ${triangle} S`, // round join: half the width
        `2 w 2 j ${triangle} S`, // bevel join: half the width
        `2 w 0 j 3 M ${triangle} S`,
        `2 w 0 j 0.25 M ${triangle} S`, // a limit of 0.5 or less adds nothing
        `0 w 0 j 3 M ${triangle} S`, // a zero width counts as 1
        `0 w 1 j ${triangle} S`,
        '4 w 0 j 10 M 100 200 50 30 re S', // a rectangle has no miter to reach: half the width
        '4 w 110 250 m 150 250 l 150 270 l S', // ... nor do lines along the axes
        '4 w 170 250 m 200 280 l S', // ... but one diagonal line takes the limit
        '4 w 220 250 m 220 280 l h S', // ... and a closing line counts
      ].join(' '),
    );
    expect(kinds(expected)).toEqual(Array(11).fill('shade'));
    expect(expected.paints[0]!.bbox).toEqual([80, 150, 160, 220]); // 20 pt on every side (0002 §15)
    expect(actual.paints.every((p) => p.approx === undefined)).toBe(true);
  }, 60_000);

  it('stroke with a shading pattern: under a CTM, a clip, a stroke alpha and with a fill', async () => {
    const { expected, actual } = await contract(
      'stroke-shading-state',
      [
        SHADED,
        'q 2 0 0 3 0 0 cm 2 w 1 j 10 10 m 40 30 l S Q', // the largest of |a|, |b|, |c| and |d|, not the line scale
        'q 2 0 0 3 0 0 cm 2 w 3 M 10 40 m 40 60 l S Q',
        'q 0.8 0.6 -0.6 0.8 100 0 cm 2 w 1 j 50 50 30 30 re S Q',
        'q 0.8 0.6 -0.6 0.8 100 0 cm 2 w 50 50 30 30 re S Q', // a rotated rectangle takes the limit
        'q 0 1 -1 0 200 100 cm 2 w 50 50 30 30 re S Q', // a quarter turn keeps it along the axes
        'q 1 0 0.5 1 0 0 cm 2 w 40 200 m 70 200 l 50 220 m 80 220 l S Q', // a skew keeps horizontal lines horizontal
        'q 1 0 0.5 1 0 0 cm 2 w 40 240 30 30 re S Q', // ... and turns the vertical ones
        'q 60 60 100 100 re W n 8 w 1 j 50 50 100 100 re S Q', // the clip narrows it
        'q 200 200 50 50 re W n 8 w 1 j 10 10 20 20 re S Q', // an empty intersection
        'q /GS1 gs 2 w 1 j 200 20 30 30 re S Q', // the stroke alpha
        'q /GS1 gs 1 0 0 rg 2 w 1 j 200 60 30 30 re B Q', // a solid fill, then the stroke
        'q /GS1 gs /Pattern cs /P1 scn 2 w 1 j 200 100 30 30 re B Q', // both shaded: two alphas
      ].join(' '),
    );
    expect(kinds(expected)).toEqual([...Array(10).fill('shade'), 'fill', 'shade', 'shade', 'shade']);
    expect(expected.paints.slice(9, 14).map((p) => p.alpha)).toEqual([0.25, 0.5, 0.25, 0.5, 0.25]);
    expect(actual.paints.map((p) => p.alpha)).toEqual(expected.paints.map((p) => p.alpha));
  }, 60_000);

  it('stroke with a tiling pattern', async () => {
    const { expected, actual } = await contract(
      'stroke-tiling',
      [
        TILED,
        '2 w 1 j 50 50 100 100 re S', // larger than the step: begin_tile
        '2 w 1 j 200 200 m 203 203 l S', // inside one cell: the cell is drawn directly
        '2 w 0 j 3 M 20 20 m 40 25 l S',
        'q 60 60 100 100 re W n 8 w 1 j 50 50 100 100 re S Q',
        'q /GS1 gs 2 w 1 j 200 20 30 30 re S Q', // MuPDF wraps it in a group of the stroke alpha, as for a fill
        'q /GS1 gs 1 0 0 rg 2 w 1 j 200 60 30 30 re B Q',
        'q /GS1 gs /Pattern cs /P1 scn 2 w 1 j 200 100 30 30 re B Q',
        '/Pattern CS /P3 SCN 2 w 1 j 150 200 100 50 re S', // the cell holding an image: not an image paint
      ].join(' '),
    );
    expect(kinds(expected)).toEqual([...Array(5).fill('pattern'), 'fill', 'pattern', 'shade', 'pattern', 'pattern']);
    expect(expected.paints[0]!.bbox).toEqual([49, 149, 151, 251]);
    expect(actual.paints.every((p) => p.approx === undefined)).toBe(true);
  }, 60_000);

  it('text stroked with a shading pattern', async () => {
    const { expected, actual } = await contract(
      'text-stroke-shading',
      `${SHADED} 1 Tr 2 w 1 j BT /F1 20 Tf 30 250 Td (AB) Tj ET`,
    );
    expect(kinds(expected)).toEqual(['shade']);
    expect(actual.paints.map((p) => p.approx)).toEqual([true]);
    expect(actual.glyphs.map((g) => g.u)).toEqual(['A', 'B']);
  }, 60_000);

  // 0002 §6: a run is one run, whatever its fill and stroke are painted with.
  it.each([
    ['tiling', `${TILED} 1 Tr BT /F1 20 Tf 30 250 Td (AB) Tj ET`, ['pattern']],
    ['fill and stroke, a solid fill', `1 0 0 rg ${SHADED} 2 Tr BT /F1 20 Tf 30 250 Td (AB) Tj ET`, ['shade']],
    ['fill and stroke, a shaded fill', `/Pattern cs /P1 scn ${TILED} 2 Tr BT /F1 20 Tf 30 250 Td (AB) Tj ET`, ['shade', 'pattern']],
    ['stroke and clip', `${SHADED} 5 Tr BT /F1 20 Tf 30 250 Td (AB) Tj ET`, ['shade']],
    ['fill, stroke and clip, a solid fill', `1 0 0 rg ${SHADED} 6 Tr BT /F1 20 Tf 30 250 Td (AB) Tj ET`, ['shade']],
    ['fill, stroke and clip, a shaded fill', `/Pattern cs /P1 scn ${TILED} 6 Tr BT /F1 20 Tf 30 250 Td (AB) Tj ET`, ['shade', 'pattern']],
  ])('text stroked with a pattern: %s', async (name, content, paints) => {
    const { expected, actual } = await contract(`text-stroke-${name.replace(/[ ,]+/g, '-')}`, content);
    expect(kinds(expected)).toEqual(paints);
    expect(actual.paints.every((p) => p.approx === true)).toBe(true);
    expect(actual.glyphs.map((g) => g.u)).toEqual(['A', 'B']);
    expect(expected.glyphs.map((g) => g.u)).toEqual(['A', 'B']);
  }, 60_000);
});

/** Both engines' page, not compared: for a known engine difference (0002 §13). */
async function inventories(name: string, content: string): Promise<{ expected: PageInv; actual: PageInv }> {
  const bytes = syntheticPdf(content);
  const pdf = writeOut(`contract/${name}.pdf`, bytes);
  const { inventory } = await walkerInventory(bytes, [1]);
  return { expected: oracleInventory(pdf, [1]).pages[0]!, actual: inventory.pages[0]! };
}

/** A glyph's state, without its place: what the two engines must agree on (0002 §6 glyphs). */
const state = ({ u, font, size, rgb, alpha, paint, wmode }: Glyph) => ({ u, font, size, rgb, alpha, paint, wmode });
const text = (glyphs: { u: string }[]): string => glyphs.map((g) => g.u).join('');

describe('0002 §6 glyph state', () => {
  it('glyph font, size, colour and alpha, Tr 0, 1 and 2, gs ca and CA', async () => {
    const { expected, actual } = await contract(
      'glyph-state',
      [
        '1 0 0 rg 0 0 1 RG BT /F1 20 Tf 30 250 Td (A) Tj 1 Tr (B) Tj 2 Tr (C) Tj ET', // the fill, the stroke, both
        'q /GS1 gs BT /F1 20 Tf 30 220 Td 0 Tr (A) Tj 1 Tr (B) Tj 2 Tr (C) Tj ET Q', // ca 0.5, CA 0.25; Tr 2 reports the fill's
        '0 Tr 0.2 0.4 0.6 rg BT /F2 12 Tf 30 190 Td (A) Tj ET', // the subset tag is part of the name
        'BT /F1 10 Tf 2 0 0 3 30 150 Tm (A) Tj ET', // the y axis of the text matrix: 30
        'q 0.5 0 0 0.5 0 0 cm BT /F1 10 Tf 0.8 0.6 -0.6 0.8 100 100 Tm (A) Tj ET Q', // a turned one under a CTM: 5
        'BT /F1 10 Tf 50 Tz 30 100 Td (A) Tj ET 100 Tz', // Tz does not change it
        'BT /F1 -10 Tf 30 80 Td (A) Tj ET', // nor does the sign of the size
        '/Pattern cs /P1 scn BT /F1 10 Tf 30 60 Td (A) Tj ET', // a pattern fill has no colour
        '0 0 0 rg BT /F1 10 Tf 80 60 Td /GS3 gs 1 Tr (A) Tj ET',
      ].join(' '),
    );
    const RED = [255, 0, 0];
    const BLUE = [0, 0, 255];
    const SOFT = [51, 102, 153];
    const F1 = { font: 'DeckbackTest', wmode: 0 };
    expect(expected.glyphs.map(state)).toEqual([
      { u: 'A', ...F1, size: 20, rgb: RED, alpha: 1, paint: 'fill' },
      { u: 'B', ...F1, size: 20, rgb: BLUE, alpha: 1, paint: 'stroke' },
      { u: 'C', ...F1, size: 20, rgb: RED, alpha: 1, paint: 'fillStroke' },
      { u: 'A', ...F1, size: 20, rgb: RED, alpha: 0.5, paint: 'fill' },
      { u: 'B', ...F1, size: 20, rgb: BLUE, alpha: 0.25, paint: 'stroke' },
      { u: 'C', ...F1, size: 20, rgb: RED, alpha: 0.5, paint: 'fillStroke' },
      { u: 'A', font: 'ABCDEF+DeckbackSubset', wmode: 0, size: 12, rgb: SOFT, alpha: 1, paint: 'fill' },
      { u: 'A', ...F1, size: 30, rgb: SOFT, alpha: 1, paint: 'fill' },
      { u: 'A', ...F1, size: 5, rgb: SOFT, alpha: 1, paint: 'fill' },
      { u: 'A', ...F1, size: 10, rgb: SOFT, alpha: 1, paint: 'fill' },
      { u: 'A', ...F1, size: 10, rgb: SOFT, alpha: 1, paint: 'fill' },
      { u: 'A', ...F1, size: 10, rgb: null, alpha: 1, paint: 'fill' },
      { u: 'A', ...F1, size: 10, rgb: BLUE, alpha: 1, paint: 'stroke' },
    ]);
    expect(actual.glyphs.map(state)).toEqual(expected.glyphs.map(state));
  }, 60_000);

  it('Tr 4, 5 and 6 are their paints without the clip', async () => {
    const { expected, actual } = await contract(
      'glyph-state-clip-modes',
      '1 0 0 rg 0 0 1 RG BT /F1 20 Tf 30 250 Td 4 Tr (A) Tj 5 Tr (B) Tj 6 Tr (C) Tj ET',
    );
    expect(expected.glyphs.map((g) => [g.u, g.paint, g.rgb])).toEqual([
      ['A', 'fill', [255, 0, 0]],
      ['B', 'stroke', [0, 0, 255]],
      ['C', 'fillStroke', [255, 0, 0]],
    ]);
    expect(actual.glyphs.map(state)).toEqual(expected.glyphs.map(state));
  }, 60_000);

  it('Tr 3 text is in invisible, not in glyphs', async () => {
    const { expected, actual } = await contract(
      'invisible',
      '1 0 0 rg BT /F1 20 Tf 30 250 Td (A) Tj 3 Tr (BC A) Tj /F2 10 Tf (A) Tj 0 Tr (B) Tj ET 3 Tr BT /F1 10 Tf 30 200 Td (C) Tj ET',
    );
    expect(text(expected.glyphs)).toBe('AB');
    expect(expected.invisible).toEqual([
      { u: 'B', x: 43.34, y: 50, font: 'DeckbackTest' },
      { u: 'C', x: 56.68, y: 50, font: 'DeckbackTest' },
      { u: ' ', x: 70.02, y: 50, font: 'DeckbackTest' },
      { u: 'A', x: 75.58, y: 50, font: 'DeckbackTest' },
      { u: 'A', x: 88.92, y: 50, font: 'ABCDEF+DeckbackSubset' },
      { u: 'C', x: 30, y: 100, font: 'DeckbackTest' },
    ]);
    expect(actual.invisible).toEqual(expected.invisible);
    expect(actual.paints).toEqual([]);
  }, 60_000);

  it('Tr 7 is paint clip', async () => {
    const { expected, actual } = await contract(
      'glyph-clip',
      'q 1 0 0 rg /GS1 gs BT /F1 20 Tf 30 250 Td 7 Tr (AB) Tj ET Q q BT /F1 20 Tf 30 200 Td 7 Tr (C) Tj ET 0 0 10 10 re f Q',
    );
    expect(expected.glyphs.map((g) => [g.u, g.paint, g.rgb, g.alpha])).toEqual([
      ['A', 'clip', null, 1],
      ['B', 'clip', null, 1],
      ['C', 'clip', null, 1],
    ]);
    expect(actual.glyphs.map(state)).toEqual(expected.glyphs.map(state));
  }, 60_000);

  it('Tr 7 followed by a sh and more under the same clip stays clip', async () => {
    // More than the one paint MuPDF wraps pattern-filled text in, so the two can be told apart (0002 §6).
    const { expected } = await contract('glyph-clip-sh', 'q BT /F1 20 Tf 30 250 Td 7 Tr (A) Tj ET /Sh1 sh 0 0 10 10 re f Q');
    expect(expected.glyphs.map((g) => g.paint)).toEqual(['clip']);
  }, 60_000);

  it('text filled and stroked with patterns: the state of the glyphs', async () => {
    const { expected, actual } = await contract(
      'glyph-state-patterns',
      [
        'q /GS1 gs /Pattern cs /P1 scn 0 0 1 RG BT /F1 20 Tf 30 250 Td (A) Tj 2 Tr (B) Tj ET Q', // shaded fill: its alpha
        'q /GS1 gs 1 0 0 rg /Pattern CS /P1 SCN BT /F1 20 Tf 30 220 Td 1 Tr (A) Tj 2 Tr (B) Tj ET Q', // shaded stroke: CA; a solid fill: ca
        '/Pattern cs /P2 scn BT /F1 20 Tf 30 190 Td 0 Tr (A) Tj 4 Tr (B) Tj ET', // tiled, no alpha: 1 on both sides
        '/Pattern cs /P1 scn /Pattern CS /P2 SCN BT /F1 20 Tf 30 160 Td 6 Tr (AB) Tj ET',
      ].join(' '),
    );
    expect(expected.glyphs.map((g) => [g.u, g.paint, g.rgb, g.alpha])).toEqual([
      ['A', 'fill', null, 0.5],
      ['B', 'fillStroke', null, 0.5],
      ['A', 'stroke', null, 0.25],
      ['B', 'fillStroke', [255, 0, 0], 0.5],
      ['A', 'fill', null, 1],
      ['B', 'fill', null, 1],
      ['A', 'fillStroke', null, 1],
      ['B', 'fillStroke', null, 1],
    ]);
    expect(actual.glyphs.map(state)).toEqual(expected.glyphs.map(state));
  }, 60_000);

  it('vertical writing through Identity-V', async () => {
    const pdf = `${repoRoot}out/contract/vertical.pdf`;
    runPython([`${repoRoot}harness/oracle/make_vertical.py`, pdf]);
    const expected = oracleInventory(pdf, [1]);
    const { inventory: actual } = await walkerInventory(new Uint8Array(readFileSync(pdf)), [1]);
    const result = compareInventories(expected, actual, TOLERANCE_PT);
    expect(result.diffs).toEqual([]);
    expect(result.ok).toBe(true);
    const glyphs = expected.pages[0]!.glyphs.filter((g) => g.wmode === 1);
    expect(text(glyphs)).toBe('ABCD');
    // Identity-V's default metrics: the origin half the width (300) left of the point and 880 below it, 1000 per glyph.
    expect(glyphs.map((g) => [g.x, g.y])).toEqual([
      [292.8, 121.12],
      [292.8, 145.12],
      [292.8, 169.12],
      [292.8, 193.12],
    ]);
    expect(actual.pages[0]!.glyphs.filter((g) => g.wmode === 1).map(state)).toEqual(glyphs.map(state));
    expect(glyphs[0]).toMatchObject({ font: 'DeckSans-Regular', size: 24, paint: 'fill' });
    expect(text(expected.pages[0]!.glyphs.filter((g) => g.wmode === 0))).toBe('Flat');
  }, 60_000);

  it('vertical writing: where the origin is and how it advances, against the oracle', async () => {
    const OPEN = 'BT /V1 20 Tf 100 200 Td';
    const ABC = '<000200030004>';
    const cases: [name: string, content: string, ys: number[]][] = [
      ['plain', `${OPEN} ${ABC} Tj <0002> Tj ET`, [117.6, 137.6, 157.6, 177.6]],
      ['Tc', `3 Tc ${OPEN} ${ABC} Tj <0002> Tj ET 0 Tc`, [117.6, 134.6, 151.6, 168.6]], // Tc moves it up
      ['TJ', `${OPEN} [<0002> -500 <0003> 250 <0004>] TJ ET`, [117.6, 127.6, 152.6]],
      ['Tz', `50 Tz 2 Tc ${OPEN} ${ABC} Tj ET 100 Tz 0 Tc`, [117.6, 135.6, 153.6]], // Tz scales x only
      ['Ts', `5 Ts ${OPEN} ${ABC} Tj ET 0 Ts`, [112.6, 132.6, 152.6]],
      ['negative size', `BT /V1 -20 Tf 100 200 Td ${ABC} Tj <0002> Tj ET`, [82.4, 62.4, 42.4, 22.4]], // up, also after the run
      ['negative size and Tc', `3 Tc BT /V1 -20 Tf 100 200 Td ${ABC} Tj ET 0 Tc`, [82.4, 59.4, 36.4]],
      ['negative size and TJ', `BT /V1 -20 Tf 100 200 Td [<0002> -500 <0003>] TJ ET`, [82.4, 72.4]],
      ['a turned Tm', `BT /V1 20 Tf 0.6 0.8 -0.8 0.6 100 200 Tm ${ABC} Tj ET`, [115.36, 127.36, 139.36]],
      ['a scaled Tm', `BT /V1 20 Tf 2 0 0 3 100 200 Tm ${ABC} Tj ET`, [152.8, 212.8, 272.8]],
      ['under a CTM', `q 2 0 0 2 0 0 cm BT /V1 10 Tf 50 100 Td ${ABC} Tj ET Q`, [117.6, 137.6, 157.6]],
      ['DW2, W2 and W', `BT /V2 20 Tf 100 200 Td ${ABC} <0005> Tj ET`.replace(' <0005>', ' Tj <0005>'), [116, 132, 146]],
      ['Td goes from the start of the line', `${OPEN} ${ABC} Tj 10 0 Td <0002> Tj ET`, [117.6, 137.6, 157.6, 117.6]],
    ];
    for (const [name, content, ys] of cases) {
      const { expected } = await contract(`vertical-${name.replace(/\W+/g, '-')}`, content);
      const nonBlank = expected.glyphs.filter((g) => g.u.trim() !== '');
      expect(nonBlank.map((g) => g.y)).toEqual(ys.slice(0, nonBlank.length));
      expect(new Set(expected.glyphs.map((g) => g.wmode))).toEqual(new Set([1]));
    }
  }, 120_000);

  it('vertical writing in every render mode, and invisible', async () => {
    const { expected, actual } = await contract(
      'vertical-modes',
      '1 0 0 rg 0 0 1 RG BT /V1 20 Tf 100 200 Td 0 Tr <0002> Tj 1 Tr <0003> Tj 2 Tr <0004> Tj 3 Tr <0002> Tj 4 Tr <0003> Tj 5 Tr <0004> Tj ET',
    );
    expect(expected.glyphs.map((g) => [g.u, g.paint])).toEqual([
      ['A', 'fill'],
      ['B', 'stroke'],
      ['C', 'fillStroke'],
      ['B', 'fill'],
      ['C', 'stroke'],
    ]);
    expect(actual.glyphs.map(state)).toEqual(expected.glyphs.map(state));
    expect(expected.invisible).toEqual([{ u: 'A', x: 94, y: 177.6, font: 'DeckbackVertical' }]);
    expect(actual.invisible).toEqual(expected.invisible);
  }, 60_000);

  it('fractional vertical metrics: the walker reads the PDF, MuPDF rounds them (0002 §13)', async () => {
    const { expected, actual } = await inventories('vertical-fraction', 'BT /V3 100 Tf 100 200 Td <00020002> Tj ET');
    expect(expected.glyphs.map((g) => g.y)).toEqual([170.1, 250.2]); // 701, -801
    expect(actual.glyphs.map((g) => g.y)).toEqual([170.06, 250.12]); // 700.6, -800.6
  }, 60_000);

  it('a fractional width: the walker reads the PDF, MuPDF rounds it (0002 §13)', async () => {
    // Skia writes such widths and relies on them: its next Td sits where the real widths end, not where MuPDF's do.
    const { expected, actual } = await inventories('fractional-width', 'BT /F3 100 Tf 10 100 Td (AAAA) Tj ET');
    expect(expected.glyphs.map((g) => g.x)).toEqual([10, 65, 120, 175]); // 550
    expect(actual.glyphs.map((g) => g.x)).toEqual([10, 64.98, 119.96, 174.94]); // 549.8
  }, 60_000);

  it('a ToUnicode entry of U+0000 means no Unicode: U+FFFD on both sides', async () => {
    const { actual } = await contract('unicode-none', 'BT /T3 20 Tf 30 250 Td <41424344FB> Tj ET');
    expect(actual.glyphs.map((g) => g.u)).toEqual(['A', 'B', '\u{1F44D}', 'A', 'B', '�']);
  }, 60_000);
});

describe('0002 §6 Type 3 fonts', () => {
  it('a Type 3 font: origins and unicode', async () => {
    const { expected, actual } = await contract(
      'type3',
      '1 0 0 rg BT /T3 20 Tf 30 250 Td (ABC) Tj [(A) -500 (B)] TJ 2 Tc (A) Tj 0 Tc 50 Tz (A) Tj (B) Tj 100 Tz ET ' +
        'q /GS1 gs BT 0.8 0.6 -0.6 0.8 100 100 Tm /T3 10 Tf (A) Tj ET Q BT /T5 20 Tf 30 50 Td (AB) Tj ET',
    );
    // Advances are width × FontMatrix × size; the size does not hold the font matrix.
    expect(expected.glyphs.slice(0, 2).map((g) => [g.u, g.x, g.y, g.size, g.type3])).toEqual([
      ['A', 30, 50, 20, true],
      ['B', 42, 50, 20, true],
    ]);
    expect(expected.glyphs.at(-1)).toMatchObject({ u: 'B', x: 42, y: 250, size: 20, type3: true });
    // MuPDF calls a Type 3 font by its object number, pdf.js by what the font says: not compared (0002 §12).
    expect(expected.glyphs[0]!.font).toMatch(/^Type3 \(\d+ 0 R\)$/);
    expect(actual.glyphs.every((g) => typeof g.font === 'string')).toBe(true);
    expect(actual.glyphs.map((g) => g.type3)).toEqual(expected.glyphs.map(() => true));
    expect(actual.glyphs.map((g) => g.size)).toEqual(expected.glyphs.map((g) => g.size));
  }, 60_000);

  it('a fractional Type 3 width: the walker reads the PDF, MuPDF cuts it down (0002 §13)', async () => {
    const { expected, actual } = await inventories('type3-fraction', 'BT /T6 100 Tf 10 100 Td (AA) Tj ET');
    expect(expected.glyphs.map((g) => g.x)).toEqual([10, 64.9]); // 549
    expect(actual.glyphs.map((g) => g.x)).toEqual([10, 64.98]); // 549.8
  }, 60_000);

  it('a Type 3 glyph is a glyph, however MuPDF draws it: no paint, not invisible', async () => {
    // d0 in the inherited colour: MuPDF draws the glyph straight onto the page and reports the text as ignored.
    const { expected, actual } = await contract('type3-direct', '1 0 0 rg BT /T4 20 Tf 30 250 Td (AB) Tj ET');
    expect(text(expected.glyphs)).toBe('AB');
    expect(expected.invisible).toEqual([]);
    expect(expected.paints).toEqual([]);
    expect(actual.paints).toEqual([]);
  }, 60_000);

  // PDF 9.3.6: the render mode has no effect on Type 3 text. MuPDF, and so the walker: Tr 3 and 7 hide it, the rest fill.
  it.each([[0], [1], [2], [4], [5], [6]])('Type 3 text under Tr %i is filled, and is no clip', async (mode) => {
    const { expected, actual } = await contract(
      `type3-tr${mode}`,
      `/GS1 gs 1 0 0 rg 0 0 1 RG BT /T3 20 Tf 30 250 Td ${mode} Tr (AB) Tj ET /Sh1 sh`,
    );
    const facts = (g: Glyph) => [g.u, g.paint, g.rgb, g.alpha];
    expect(expected.glyphs.map(facts)).toEqual([
      ['A', 'fill', [255, 0, 0], 0.5],
      ['B', 'fill', [255, 0, 0], 0.5],
    ]);
    expect(actual.glyphs.map(facts)).toEqual(expected.glyphs.map(facts));
    expect(expected.paints.map((p) => [p.kind, p.bbox])).toEqual([['shade', [0, 0, 300, 300]]]);
    expect(actual.paints[0]!.approx).toBeUndefined();
  }, 60_000);

  it.each([[3], [7]])('Type 3 text under Tr %i is invisible', async (mode) => {
    const { expected, actual } = await contract(`type3-tr${mode}`, `BT /T3 20 Tf 30 250 Td ${mode} Tr (AB) Tj ET`);
    expect(expected.glyphs).toEqual([]);
    expect(expected.invisible.map((g) => [g.u, g.type3])).toEqual([['A', true], ['B', true]]);
    const place = (g: { u: string; x: number; y: number; type3?: true }) => [g.u, g.x, g.y, g.type3];
    expect(actual.invisible.map(place)).toEqual(expected.invisible.map(place));
  }, 60_000);

  it('Type 3 text filled with a pattern: one paint per glyph unless Tr is 0', async () => {
    const { expected, actual } = await contract(
      'type3-pattern',
      '/Pattern cs /P1 scn BT /T3 20 Tf 30 250 Td (AB) Tj ET /Pattern cs /P2 scn BT /T3 20 Tf 30 200 Td 1 Tr (AB) Tj 2 Tr (AB) Tj ET',
    );
    expect(kinds(expected)).toEqual(['shade', ...Array(4).fill('pattern')]);
    expect(actual.paints.every((p) => p.approx === true)).toBe(true);
  }, 60_000);
});

describe('0002 §5 pattern-filled text: one paint per stretch', () => {
  const FILL = '/Pattern cs /P1 scn';
  const TILE = '/Pattern cs /P2 scn';
  const OPEN = 'BT /F1 20 Tf 30 250 Td';

  it('several pattern-filled runs in one BT..ET are one shade', async () => {
    const { expected, actual } = await contract(
      'stretch-shade',
      `${FILL} ${OPEN} (A) Tj (B) Tj 0 -30 Td (C) Tj [(A) -100 (B)] TJ 1 0 0 1 30 100 Tm (A) Tj /F2 10 Tf (B) Tj 2 Tc (C) Tj ET`,
    );
    expect(kinds(expected)).toEqual(['shade']);
    expect(actual.paints.map((p) => p.approx)).toEqual([true]);
    expect(text(actual.glyphs)).toBe('ABCABABC');
  }, 60_000);

  it('several tiled runs in one BT..ET are one pattern', async () => {
    const { expected } = await contract('stretch-pattern', `${TILE} ${OPEN} (A) Tj (B) Tj 0 -30 Td (C) Tj ET`);
    expect(kinds(expected)).toEqual(['pattern']);
  }, 60_000);

  it('several pattern-stroked runs in one BT..ET are one paint, and so is each half of Tr 2', async () => {
    const { expected } = await contract(
      'stretch-stroke',
      `/Pattern CS /P1 SCN 1 Tr ${OPEN} (A) Tj (B) Tj ET ${TILE} 2 Tr ${OPEN} 0 -30 Td (A) Tj (B) Tj ET`,
    );
    expect(kinds(expected)).toEqual(['shade', 'pattern', 'shade']);
  }, 60_000);

  // What ends a stretch. Each case has an A then a B in one BT..ET, with this between them.
  it.each([
    // Nothing that only moves or sets text state: the fz_text MuPDF is filling takes it all.
    ['Td', '10 10 Td', 1],
    ['Tm', '1 0 0 1 50 50 Tm', 1],
    ['T*', '10 TL T*', 1],
    ['Tf', '/F2 10 Tf', 1],
    ['Tc, Tw, Tz, Ts', '2 Tc 2 Tw 50 Tz 2 Ts', 1],
    ['flatness', '1 i', 1],
    ['a Tr of the same mode', '0 Tr', 1],
    ['an empty run in another mode', '1 Tr () Tj 0 Tr', 1],
    ['a path that is not painted', '10 10 5 5 re n', 1],
    ['a q', 'q', 1],
    ['a gs of keys pdf.js drops', '/GS4 gs', 1],
    ['a gs of FL, TR and Font', '/GS5 gs', 1],
    // A colour, however it is said and whichever it is.
    ['the same pattern', '/P1 scn', 2],
    ['a stroke colour', '1 0 0 RG', 2],
    ['a stroke pattern', '/Pattern CS /P2 SCN', 2],
    // The line state, whatever it does.
    ['w', '2 w', 2],
    ['J', '1 J', 2],
    ['j', '1 j', 2],
    ['M', '5 M', 2],
    ['d', '[1 2] 0 d', 2],
    ['ri', '/Perceptual ri', 2],
    ['gs', '/GS3 gs', 2],
    ['a gs of CA, whatever it does', '/GS7 gs', 2],
    // Marked content, a CTM, a clip.
    ['BMC', '/Span BMC', 2],
    ['BDC', '/Span << /MCID 1 >> BDC', 2],
    ['cm', '1 0 0 1 0 0 cm', 2],
    ['W', '10 10 200 200 re W n', 2],
  ])('stretch: %s between two runs gives %i', async (name, between, shades) => {
    const { expected, actual } = await contract(
      `stretch-${name.replace(/\W+/g, '-')}`,
      `${FILL} ${OPEN} (A) Tj ${between} (B) Tj ET`,
    );
    expect(kinds(expected).filter((k) => k === 'shade')).toHaveLength(shades);
    expect(text(actual.glyphs)).toBe('AB');
  }, 60_000);

  // 0002 §13: these end a stretch in MuPDF, and pdf.js does not pass them on, so the walker cannot know.
  it.each([
    ['MP', '/X MP'],
    ['DP', '/X << >> DP'],
    ['CS', '/DeviceGray CS'],
    ['gs with OP, op and OPM', '/GS6 gs'],
  ])('stretch: %s ends one in MuPDF, and the walker cannot see it', async (name, between) => {
    const { expected, actual } = await inventories(`stretch-unseen-${name.replace(/\W+/g, '-')}`, `${FILL} ${OPEN} (A) Tj ${between} (B) Tj ET`);
    expect(kinds(expected)).toEqual(['shade', 'shade']);
    expect(kinds(actual)).toEqual(['shade']);
  }, 60_000);

  it('cs and CS set the colour to black in MuPDF, and pdf.js does not pass them on (0002 §13)', async () => {
    const { expected, actual } = await inventories('colour-space-alone', '1 0 0 rg /DeviceGray cs BT /F1 20 Tf 30 250 Td (A) Tj ET');
    expect(expected.glyphs[0]!.rgb).toEqual([0, 0, 0]);
    expect(actual.glyphs[0]!.rgb).toEqual([255, 0, 0]);
  }, 60_000);

  it('stretch: EMC ends one too', async () => {
    const { expected } = await contract('stretch-emc', `${FILL} /Span BMC ${OPEN} (A) Tj EMC (B) Tj ET`);
    expect(kinds(expected)).toEqual(['shade', 'shade']);
  }, 60_000);

  it('stretch: Q ends one, under the state the text had', async () => {
    const { expected } = await contract('stretch-q', `q ${FILL} ${OPEN} (A) Tj q /Pattern cs /P2 scn (B) Tj Q (A) Tj ET Q 0 0 10 10 re f`);
    expect(kinds(expected)).toEqual(['shade', 'pattern', 'shade', 'fill']);
  }, 60_000);

  it('stretch: a change of render mode ends one when the next glyph comes, not before', async () => {
    const { expected } = await contract(
      'stretch-mode',
      `${FILL} /Pattern CS /P2 SCN ${OPEN} (A) Tj 1 Tr (B) Tj 2 Tr (A) Tj 3 Tr (B) Tj 0 Tr (A) Tj ET`,
    );
    expect(kinds(expected)).toEqual(['shade', 'pattern', 'shade', 'pattern', 'shade']);
  }, 60_000);

  it('stretch: its paint comes when it ends, after paints made in between', async () => {
    const first = await contract(
      'stretch-order',
      `${FILL} ${OPEN} (A) Tj 1 0 0 RG 0 0 1 rg 10 10 5 5 re f (B) Tj /Sh1 sh (A) Tj ET`,
    );
    expect(kinds(first.expected)).toEqual(['shade', 'fill', 'shade']);
    const second = await contract(
      'stretch-order-2',
      `${FILL} ${OPEN} (A) Tj 10 10 5 5 re f (B) Tj /Sh1 sh (A) Tj ET 0 0 1 rg 0 0 5 5 re f`,
    );
    // The path and the sh come first: nothing ended the stretch before them. Then the stretch, then the blue fill.
    expect(kinds(second.expected)).toEqual(['shade', 'shade', 'shade', 'fill']);
    expect(second.actual.paints.map((p) => p.approx)).toEqual([undefined, undefined, true, undefined]);
  }, 60_000);

  it('stretch: a text clip at ET comes after its paint', async () => {
    const { expected, actual } = await contract('stretch-clip', `q ${FILL} 4 Tr ${OPEN} (A) Tj (B) Tj ET /Sh1 sh Q`);
    expect(kinds(expected)).toEqual(['shade', 'shade']);
    expect(actual.paints.map((p) => p.approx)).toEqual([true, true]);
  }, 60_000);

  it('a block with no ET still paints', async () => {
    const { expected } = await contract('stretch-no-et', `${FILL} ${OPEN} (A) Tj (B) Tj`);
    expect(kinds(expected)).toEqual(['shade']);
  }, 60_000);

  it('a soft mask set between two runs ends the stretch before the mask', async () => {
    const { expected } = await contract('stretch-mask', `${FILL} ${OPEN} (A) Tj /GS2 gs (B) Tj ET`);
    expect(kinds(expected)).toEqual(['shade', 'shade']);
  }, 60_000);
});

describe('0002 §12 comparison of the glyph state on real values', () => {
  it('a real diff in each field shows', async () => {
    const bytes = syntheticPdf('1 0 0 rg BT /F1 20 Tf 30 250 Td (A) Tj ET 3 Tr BT /F1 20 Tf 30 200 Td (B) Tj ET');
    const pdf = writeOut('contract/glyph-diff.pdf', bytes);
    const expected = oracleInventory(pdf, [1]);
    const { inventory: actual } = await walkerInventory(bytes, [1]);
    const glyph = actual.pages[0]!.glyphs[0]!;
    const invisible = actual.pages[0]!.invisible[0]!;
    const edits: [() => void, () => void][] = [
      [() => void (glyph.font = 'Other'), () => void (glyph.font = 'DeckbackTest')],
      [() => void (glyph.size = 20.1), () => void (glyph.size = 20)],
      [() => void (glyph.paint = 'stroke'), () => void (glyph.paint = 'fill')],
      [() => void (glyph.alpha = 0.5), () => void (glyph.alpha = 1)],
      [() => void (glyph.rgb = [0, 0, 0]), () => void (glyph.rgb = [255, 0, 0])],
      [() => void (glyph.wmode = 1), () => void (glyph.wmode = 0)],
      [() => void (invisible.font = 'Other'), () => void (invisible.font = 'DeckbackTest')],
      [() => void (invisible.x = 31), () => void (invisible.x = 30)],
    ];
    for (const [edit, undo] of edits) {
      edit();
      expect(compareInventories(expected, actual).diffs).toHaveLength(1);
      undo();
    }
    expect(compareInventories(expected, actual).diffs).toEqual([]);
  }, 60_000);
});

describe('0002 §16 images', () => {
  const ids = (page: PageInv) => page.paints.map((p) => [p.kind, p.px, p.stencil]);

  it('image matrix and pixel size: scaled, rotated, flipped', async () => {
    const { expected, actual } = await contract(
      'image-matrix',
      [
        'q 60 0 0 40 20 30 cm /Im1 Do Q', // scaled
        'q 0 50 -30 0 200 100 cm /Im1 Do Q', // a quarter turn
        'q 0.8 0.6 -0.6 0.8 150 20 cm 40 0 0 30 0 0 cm /Im2 Do Q', // turned, and an image of another size
        'q -60 0 0 -40 100 280 cm /Im1 Do Q', // mirrored both ways
        'q 60 0 0 -40 20 120 cm /Im2 Do Q', // upside down
        'q 20 0 0 20 100 100 cm /Im5 Do Q', // the soft mask is larger than the image: the image's own size
        'q /GS1 gs 30 0 0 30 250 250 cm /Im1 Do Q', // the fill alpha
      ].join(' '),
    );
    expectDetail(expected, actual);
    expect(expected.paints.map((p) => p.px)).toEqual([[2, 2], [2, 2], [3, 5], [2, 2], [3, 5], [2, 2], [2, 2]]);
    expect(expected.paints.map((p) => [p.rgb, p.stencil])).toEqual(Array(7).fill([null, false]));
    // The PDF's own matrix in the slide frame (y down): the image's bottom left corner at its origin, 0002 §16.
    expect(expected.paints.slice(0, 2).map((p) => p.ctm)).toEqual([
      [60, 0, 0, -40, 20, 270],
      [0, -50, -30, 0, 200, 200],
    ]);
    expect(expected.paints[3]!.ctm).toEqual([-60, 0, 0, 40, 100, 20]);
    expect(expected.paints[4]!.ctm).toEqual([60, 0, 0, 40, 20, 180]);
    expect(actual.paints.map((p) => p.ctm)).toEqual(expected.paints.map((p) => p.ctm));
    expect(expected.paints[6]!.alpha).toBe(0.5);
  }, 60_000);

  it('image matrix in the slide frame of a rotated page with a crop box', async () => {
    for (const rotate of [0, 90, 180, 270]) {
      const { expected, actual } = await contract(
        `image-rotate-${rotate}`,
        'q 60 0 0 40 20 30 cm /Im1 Do Q q 0.8 0.6 -0.6 0.8 150 20 cm 40 0 0 30 0 0 cm /Im2 Do Q 1 0 0 rg q 0 50 -30 0 200 100 cm /Im3 Do Q',
        `/MediaBox [0 0 300 200] /CropBox [10 20 210 170] /Rotate ${rotate}`,
      );
      expectDetail(expected, actual);
      expect(ids(expected)).toEqual([['image', [2, 2], false], ['image', [3, 5], false], ['image', [8, 8], true]]);
    }
  }, 60_000);

  it('inline image', async () => {
    const { expected, actual } = await contract(
      'image-inline',
      [
        'q 40 0 0 40 10 10 cm BI /W 2 /H 2 /CS /G /BPC 8 ID abcd EI Q', // small: pdf.js keeps it in the operator
        `q 60 0 0 20 100 10 cm BI /W 1 /H 200 /CS /G /BPC 8 ID ${'a'.repeat(200)} EI Q`, // big: pdf.js makes an object of it
        'q 0 0 1 rg 30 0 0 30 10 100 cm BI /W 8 /H 8 /IM true /BPC 1 ID UUUUUUUU EI Q', // a stencil
        'q 0.8 0.6 -0.6 0.8 150 20 cm 30 0 0 30 0 0 cm BI /W 3 /H 2 /CS /RGB /BPC 8 ID abcdefghijklmnopqr EI Q',
      ].join(' '),
    );
    expectDetail(expected, actual);
    expect(ids(expected)).toEqual([['image', [2, 2], false], ['image', [1, 200], false], ['image', [8, 8], true], ['image', [3, 2], false]]);
    expect(expected.paints[2]!.rgb).toEqual([0, 0, 255]);
  }, 60_000);

  it('stencil mask with its colour', async () => {
    const { expected, actual } = await contract(
      'image-stencil',
      [
        '1 0 0 rg q 60 0 0 40 20 30 cm /Im3 Do Q',
        '0 0.5 1 rg q /GS1 gs 30 0 0 30 120 30 cm /Im3 Do Q', // the fill alpha
        'q 0 1 0 rg 0.8 0.6 -0.6 0.8 200 100 cm 30 0 0 30 0 0 cm /Im3 Do Q', // turned
        '0.2 0.4 0.6 rg q 0 -40 40 0 100 200 cm /Im3 Do Q',
        '1 1 0 rg q 40 0 0 40 150 200 cm /Im3 Do Q',
        '/Pattern cs /P1 scn q 40 0 0 40 20 100 cm /Im3 Do Q', // a shading pattern for colour: a shade, not an image
        '/Pattern cs /P2 scn q 40 0 0 40 70 100 cm /Im3 Do Q', // a tiling pattern: a pattern
        '0 0 0 rg q 40 0 0 40 220 20 cm /Im1 Do Q', // an image that is no stencil has no colour of its own
      ].join(' '),
    );
    expectDetail(expected, actual);
    expect(expected.paints.map((p) => [p.kind, p.rgb, p.alpha, p.stencil, p.px])).toEqual([
      ['image', [255, 0, 0], 1, true, [8, 8]],
      ['image', [0, 128, 255], 0.5, true, [8, 8]],
      ['image', [0, 255, 0], 1, true, [8, 8]],
      ['image', [51, 102, 153], 1, true, [8, 8]],
      ['image', [255, 255, 0], 1, true, [8, 8]],
      ['shade', null, 1, undefined, undefined],
      ['pattern', null, 1, undefined, undefined],
      ['image', null, 1, false, [2, 2]],
    ]);
    expect(actual.paints.map((p) => p.rgb)).toEqual(expected.paints.map((p) => p.rgb));
  }, 60_000);

  it('1×1 solid image mask', async () => {
    // pdf.js turns an opaque 1 x 1 mask into paintSolidColorImageMask; a transparent one stays an ordinary mask.
    const { expected, actual } = await contract(
      'image-solid-mask',
      [
        '0 0.5 0 rg q 50 0 0 50 100 100 cm /Im4 Do Q',
        '1 0 1 rg q 0.8 0.6 -0.6 0.8 20 20 cm 30 0 0 30 0 0 cm /Im6 Do Q',
        'q /GS1 gs 0 0 1 rg 20 0 0 20 200 200 cm /Im4 Do Q',
      ].join(' '),
    );
    expectDetail(expected, actual);
    expect(expected.paints.map((p) => [p.rgb, p.alpha, p.stencil, p.px])).toEqual([
      [[0, 128, 0], 1, true, [1, 1]],
      [[255, 0, 255], 1, true, [1, 1]],
      [[0, 0, 255], 0.5, true, [1, 1]],
    ]);
    expect(actual.paints.map((p) => p.px)).toEqual([[1, 1], [1, 1], [1, 1]]);
  }, 60_000);
});

describe('0002 §16 shadings', () => {
  const types = (page: PageInv) => page.paints.map((p) => p.shading);

  it('sh axial and radial type', async () => {
    const { expected, actual } = await contract(
      'shading-axial-radial',
      [
        '/Sh1 sh /Sh2 sh /Sh3 sh', // axial without and with a /BBox, radial
        '/Pattern cs /P1 scn 10 10 100 100 re f /P5 scn 120 10 100 100 re f', // as shading patterns
        '/Pattern CS /P5 SCN 4 w 10 150 100 100 re S', // a stroke
        'BT /F1 30 Tf 30 250 Td (AB) Tj ET', // the fill is still /P5: text (approximate box, but its kind of shading is exact)
        'q /GS1 gs 150 150 50 50 re W n /Sh2 sh Q',
      ].join(' '),
    );
    expectDetail(expected, actual);
    expect(types(expected)).toEqual(['axial', 'radial', 'axial', 'axial', 'radial', 'radial', 'radial', 'radial']);
    expect(types(actual)).toEqual(types(expected));
  }, 60_000);

  it('a mesh shading type', async () => {
    const { expected, actual } = await contract(
      'shading-mesh',
      '/Sh5 sh /Sh6 sh /Sh7 sh /Sh8 sh /Sh9 sh /Pattern cs /P6 scn 10 10 100 100 re f', // types 4, 5, 6, 7, one with a /BBox, a pattern
    );
    expectDetail(expected, actual);
    expect(types(expected)).toEqual(Array(6).fill('mesh'));
    expect(types(actual)).toEqual(types(expected));
  }, 60_000);

  it('a function-based shading type', async () => {
    const { expected, actual } = await contract(
      'shading-function',
      '/Sh4 sh /Sh10 sh q 0.8 0.6 -0.6 0.8 50 20 cm /Sh10 sh Q q 2 0 0 2 0 0 cm /Sh4 sh Q',
    );
    expectDetail(expected, actual);
    expect(types(expected)).toEqual(Array(4).fill('function'));
    expect(types(actual)).toEqual(types(expected));
    // Unbounded in the page: the shading's own bounds do not narrow a shade that no soft mask touches (0002 §5).
    expect(expected.paints.map((p) => p.bbox)).toEqual(Array(4).fill([0, 0, 300, 300]));
  }, 60_000);

  // 0002 §10: MuPDF clips what a soft mask touches to that object's bounds. A shading that has bounds of its own (a mesh,
  // function-based, or with a /BBox) narrows the clip, the others do not.
  it('a bounded sh under a soft mask has the narrowed box', async () => {
    const { expected, actual } = await contract(
      'shading-soft-mask',
      [
        '/Sh5 sh', // 0: no mask: the page
        'q /GS2 gs /Sh5 sh Q', // 1: a mesh: its vertices
        'q /GS2 gs /Sh9 sh Q', // 2: a mesh with a /BBox inside the vertices
        'q /GS2 gs /Sh3 sh Q', // 3: an axial shading with a /BBox
        'q /GS2 gs /Sh1 sh Q', // 4: an axial shading with none
        'q /GS2 gs /Sh4 sh Q', // 5: function-based: its domain through its matrix
        'q /GS2 gs /Sh10 sh Q', // 6: ... turned, and cut by a /BBox
        'q 100 100 80 80 re W n /GS2 gs /Sh5 sh Q', // 7: and the clip
        'q /GS2 gs /GS8 gs /Sh5 sh Q', // 8: /SMask /None ends it
        'q /GS2 gs /Fm5 Do Q', // 9: a transparency group takes the mask for itself
        'q /GS2 gs /Fm6 Do Q', // 10: a form that is none passes it on
        'q 0.8 0.6 -0.6 0.8 100 0 cm /GS2 gs /Sh5 sh Q', // 11: under a turned CTM: the box of the box
        'q /GS2 gs /Pattern cs /P1 scn 20 20 60 60 re f Q', // 12: a shading pattern fills a path: no narrowing
        'q /GS2 gs /Pattern cs /P6 scn 0 0 300 300 re f Q', // 13: even of a mesh
        'q /GS2 gs Q /Sh5 sh', // 14: Q ends it
        'q /GS2 gs /Sh2 sh Q', // 15: radial without a /BBox
        'q /GS2 gs /Sh11 sh Q', // 16: a /BBox that does not meet the vertices: nothing is left
        'q /GS2 gs /Fm7 Do Q', // 17: a transparency group that sets a mask of its own: that one narrows what is inside it
      ].join(' '),
    );
    expectDetail(expected, actual);
    const PAGE = [0, 0, 300, 300];
    const boxes = expected.paints.map((p) => p.bbox);
    expect(boxes[0]).toEqual(PAGE);
    expect(boxes[1]).toEqual([60, 120, 220, 230]);
    expect(boxes[2]).toEqual([100, 150, 180, 200]);
    expect(boxes[3]).toEqual([60, 140, 200, 220]);
    expect(boxes[4]).toEqual(PAGE);
    expect(boxes[5]).toEqual([40, 150, 160, 240]);
    expect(boxes[6]).not.toEqual(PAGE);
    expect(boxes[7]).toEqual([100, 120, 180, 200]);
    expect(boxes[8]).toEqual(PAGE);
    expect(boxes[9]).toEqual(PAGE);
    expect(boxes[10]).toEqual([60, 120, 220, 230]);
    expect(boxes[11]).not.toEqual(PAGE);
    expect(boxes[12]).toEqual([20, 220, 80, 280]);
    expect(boxes[13]).toEqual(PAGE);
    expect(boxes[14]).toEqual(PAGE);
    expect(boxes[15]).toEqual(PAGE);
    expect(boxes[16]).toEqual([0, 0, 0, 0]);
    expect(boxes[17]).toEqual([60, 120, 220, 230]);
    expect(actual.paints.map((p) => p.bbox)).toEqual(boxes);
  }, 60_000);

  it('a bounded sh under a soft mask, in the slide frame of a rotated page', async () => {
    for (const rotate of [90, 270]) {
      const { expected } = await contract(
        `shading-soft-mask-rotate-${rotate}`,
        'q /GS2 gs /Sh5 sh Q q /GS2 gs /Sh4 sh Q q /GS2 gs /Sh3 sh Q',
        `/MediaBox [0 0 300 200] /CropBox [10 20 210 170] /Rotate ${rotate}`,
      );
      expect(expected.paints).toHaveLength(3);
    }
  }, 60_000);
});

describe('0002 §17 clip, groups, blend and masks', () => {
  const PAGE = [0, 0, 300, 300];

  it('clip box at each paint: W path, W* path, form BBox, group BBox, restored by Q', async () => {
    const { expected, actual } = await contract(
      'clip-box',
      [
        'q 20 30 100 80 re W n 0 0 300 300 re f 2 w 10 10 m 290 290 l S Q', // W
        'q 150 50 m 250 50 l 200 150 l h W* n 1 0 0 rg 0 0 300 300 re f Q', // W*
        '0 0 1 rg 10 10 5 5 re f', // Q restored it
        'q /Fm1 Do Q', // a form's /BBox under its /Matrix: its sh and its fill
        'q /Fm11 Do Q', // a transparency group's /BBox
        'q 60 60 200 200 re W n /Fm11 Do Q', // both
        'q 100 100 50 50 re W n 30 0 0 30 120 120 cm /Im1 Do Q', // an image
        'q 0 0 150 150 re W n /Pattern cs /P1 scn 100 100 100 100 re f Q', // a shading pattern: MuPDF clips to the shape first
        'q 20 0 0 20 200 200 cm /Im5 Do Q', // an image's own soft mask is not part of its clip
        '10 10 5 5 re f',
      ].join(' '),
    );
    expect(expected.paints.map((p) => [p.kind, p.clip])).toEqual([
      ['fill', [20, 190, 120, 270]],
      ['stroke', [20, 190, 120, 270]],
      ['fill', [150, 150, 250, 250]],
      ['fill', PAGE],
      ['shade', [10, 190, 110, 290]],
      ['fill', [10, 190, 110, 290]],
      ['fill', [40, 180, 140, 260]],
      ['fill', [60, 180, 140, 240]],
      ['image', [100, 150, 150, 200]],
      ['shade', [100, 150, 150, 200]],
      ['image', PAGE],
      ['fill', PAGE],
    ]);
    expect(actual.paints.map((p) => p.clip)).toEqual(expected.paints.map((p) => p.clip));
    expect(actual.paints.every((p) => p.clipApprox === undefined)).toBe(true);
  }, 60_000);

  it('the clip of a paint under a text clip is approximate: compared by kind and position only', async () => {
    const { expected, actual } = await contract(
      'clip-text',
      'q BT /F1 20 Tf 30 250 Td 7 Tr (AB) Tj ET 0 0 1 rg 0 0 300 300 re f 30 0 0 30 20 20 cm /Im1 Do Q 10 10 5 5 re f',
    );
    expect(actual.paints.map((p) => [p.kind, p.clipApprox])).toEqual([['fill', true], ['image', true], ['fill', undefined]]);
    expect(expected.paints.every((p) => p.clipApprox === undefined)).toBe(true);
    expect(actual.paints[2]!.clip).toEqual(PAGE);
  }, 60_000);

  it('group alpha: nested form groups with ca', async () => {
    // /Fm8 is drawn at ca 0.5; inside it, at ca 0.4, /Fm9.
    const { expected, actual } = await contract('group-alpha', 'q /GS1 gs /Fm8 Do Q 0 0 1 rg 10 250 20 20 re f');
    expect(expected.paints.map((p) => [p.alpha, p.groupAlpha])).toEqual([
      [1, 0.5],
      [0.4, 0.5],
      [0.4, 0.5],
      [1, 0.2],
      [0.5, 0.2],
      [1, 1],
    ]);
    expect(expected.glyphs.map((g) => [g.u, g.alpha, g.groupAlpha])).toEqual([
      ['A', 1, 0.5],
      ['B', 1, 0.2],
    ]);
    // Each group clips to its /BBox: /Fm9's is moved by its /Matrix.
    expect(expected.paints.slice(3, 5).map((p) => p.clip)).toEqual([
      [110, 115, 230, 195],
      [110, 115, 230, 195],
    ]);
    expect(actual.paints.map((p) => [p.alpha, p.groupAlpha])).toEqual(expected.paints.map((p) => [p.alpha, p.groupAlpha]));
    expect(actual.glyphs.map((g) => g.groupAlpha)).toEqual([0.5, 0.2]);
  }, 60_000);

  it('group alpha: a tiling pattern under an alpha has it as its own alpha, not as a group alpha', async () => {
    // MuPDF wraps such a fill in a group of the fill alpha (0002 §9): that group is the paint's alpha.
    const { expected, actual } = await contract(
      'group-alpha-tiling',
      'q /GS1 gs /Pattern cs /P2 scn 1 0 0 RG 2 w 20 20 50 50 re B Q q /GS1 gs /Fm3 Do Q',
    );
    expect(expected.paints.map((p) => [p.kind, p.alpha, p.groupAlpha])).toEqual([
      ['pattern', 0.5, 1],
      ['stroke', 0.25, 1],
      ['pattern', 1, 0.5],
    ]);
    expect(actual.paints.map((p) => p.groupAlpha)).toEqual([1, 1, 0.5]);
  }, 60_000);

  it('blend mode on a path and on a form group', async () => {
    const { expected, actual } = await contract(
      'blend',
      [
        '0 0 1 rg 10 10 20 20 re f', // normal
        'q /GS9 gs 40 10 20 20 re f /Sh1 sh 2 w 10 40 m 50 40 l S Q', // multiply: a path, a sh, a stroke
        'q /GS10 gs 70 10 20 20 re f Q', // screen
        // A group drawn multiplied: what it holds takes that, unless it has a mode of its own; so does a group nested in it.
        'q /GS9 gs /Fm8 Do Q',
        'q /GS9 gs 30 0 0 30 200 200 cm /Im1 Do Q', // an image
        'q /GS13 gs BT /F1 10 Tf 30 50 Td (A) Tj ET 220 10 20 20 re f Q', // text, and a mode pdf.js spells with a hyphen
      ].join(' '),
    );
    expect(expected.paints.map((p) => p.blend)).toEqual([
      'normal',
      'multiply',
      'multiply',
      'multiply',
      'screen',
      'multiply',
      'multiply',
      'colordodge',
      'multiply',
      'multiply',
      'multiply',
      'colordodge',
    ]);
    expect(actual.paints.map((p) => p.blend)).toEqual(expected.paints.map((p) => p.blend));
    expect(expected.paints[4]!.alpha).toBe(0.8);
  }, 60_000);

  // The inventory names only the first mode that is not normal and whether any mask is over a paint (0002 §17): it cannot
  // tell a paint's own mode and mask from its groups'. The Scene does, so the walker keeps them apart.
  it('a RawOp keeps its own blend mode and soft mask apart from those of its groups', async () => {
    const doc = await openDocument(syntheticPdf('q /GS2 gs /GS9 gs /Fm8 Do Q'));
    try {
      const page = await loadPage(doc, 0);
      const fills = walkPage(page).filter((op) => op.kind === 'fill');
      await releasePage(page);
      const outer = [1, 'multiply', true, false, false]; // /Fm8, drawn multiplied under the mask: it takes both
      const inner = [0.4, 'normal', false, true, true]; // /Fm9, isolated and knockout, drawn at ca 0.4 inside /Fm8
      const facts = fills.map((op) => [op.blend, op.masked, op.groups.map((g) => [g.alpha, g.blend, g.masked, g.isolated, g.knockout])]);
      expect(facts).toEqual([
        ['normal', false, [outer]], // inside a group the mode starts over at normal
        ['normal', false, [outer]],
        ['colordodge', false, [outer]],
        ['normal', false, [outer, inner]],
        ['normal', false, [outer, inner]],
      ]);
      expect(fills[3]!.groups.map((g) => g.bbox)).toEqual([
        [20, 100, 280, 280],
        [110, 115, 230, 195],
      ]);
    } finally {
      await closeDocument(doc);
    }
  }, 60_000);

  it('masked: a soft mask set with gs and cleared with /None', async () => {
    const { expected, actual } = await contract(
      'masked',
      [
        'q /GS2 gs 10 10 50 50 re f /GS8 gs 70 10 50 50 re f Q', // masked, then /None ends it
        '130 10 50 50 re f', // Q ended it
        'q /GS2 gs /Fm5 Do Q', // a transparency group takes the mask: what it holds is under it
        'q /GS2 gs /Fm10 Do Q', // ... also after a /None inside it
        'q /GS2 gs /Fm6 Do Q', // a form that is no group passes it on
        'q /GS2 gs 20 0 0 20 200 200 cm /Im5 Do Q', // an image with a soft mask of its own: that one replaces it
        'q /GS2 gs /Pattern cs /P2 scn 200 20 40 40 re f Q', // a tiling pattern
        'q /GS2 gs /Fm7 Do Q', // a group that sets a mask of its own
      ].join(' '),
    );
    expect(expected.paints.map((p) => [p.kind, p.masked])).toEqual([
      ['fill', true],
      ['fill', false],
      ['fill', false],
      ['shade', true],
      ['fill', true],
      ['shade', true],
      ['image', false],
      ['pattern', true],
      ['shade', true],
    ]);
    // The area MuPDF clips a masked paint to is its own: it is not part of the clip (0002 §10). The tiling pattern's clip is
    // its shape, which MuPDF clips to before it paints the pattern.
    expect(expected.paints.map((p) => p.clip)).toEqual([...Array(7).fill(PAGE), [200, 240, 240, 280], PAGE]);
    expect(actual.paints.map((p) => p.masked)).toEqual(expected.paints.map((p) => p.masked));
  }, 60_000);
});

describe('0002 §18 optional content', () => {
  it('optional content: hidden OCG, visible OCG, OCMD, form with /OC', async () => {
    const { expected, actual } = await contract(
      'optional-content',
      [
        '/OC /OCon BDC 1 0 0 rg 10 10 20 20 re f EMC', // shown
        '/OC /OCoff BDC q 0 1 0 rg 40 10 20 20 re f /Sh1 sh 30 0 0 30 70 10 cm /Im1 Do Q 0 0 1 rg EMC', // hidden ...
        '100 10 20 20 re f', // ... and what it set stays
        '/OC /MDany BDC 130 10 20 20 re f EMC /OC /MDoff BDC 160 10 20 20 re f EMC /OC /MDallOff BDC 190 10 20 20 re f EMC',
        '/OC /OCon BDC /OC /OCoff BDC 220 10 10 10 re f EMC 240 10 10 10 re f EMC', // nested
        '/Fm12 Do /Fm13 Do /Fm14 Do', // forms with /OC: hidden, shown, and a hidden transparency group
        'q /OC /OCoff BDC 200 200 50 50 re W n EMC /Sh1 sh Q', // a hidden clip still clips
        'q /OC /OCoff BDC BT /F1 20 Tf 30 250 Td (AB) Tj 3 Tr (CA) Tj 7 Tr (BC) Tj ET EMC Q', // hidden text
        'BT /F1 20 Tf 30 200 Td (A) Tj ET',
      ].join(' '),
    );
    expect(expected.paints.map((p) => [p.kind, p.bbox])).toEqual([
      ['fill', [10, 270, 30, 290]],
      ['fill', [100, 270, 120, 290]],
      ['fill', [130, 270, 150, 290]],
      ['fill', [190, 270, 210, 290]],
      ['fill', [240, 280, 250, 290]],
      ['fill', [90, 220, 110, 240]],
      ['shade', [200, 50, 250, 100]],
    ]);
    expect(expected.paints[1]!.rgb).toEqual([0, 0, 255]);
    // Hidden text paints nothing: Tr 0 to 2 are gone, Tr 3 stays invisible, a clip mode still clips and is a clip.
    expect(expected.glyphs.map((g) => [g.u, g.paint])).toEqual([
      ['B', 'clip'],
      ['C', 'clip'],
      ['A', 'fill'],
    ]);
    expect(text(expected.invisible)).toBe('CA');
    expect(actual.paints.map((p) => p.bbox)).toEqual(expected.paints.map((p) => p.bbox));
  }, 60_000);

  it('optional content: hidden Type 3 text is invisible under Tr 3 and 7, and gone under the rest', async () => {
    const { expected } = await contract(
      'optional-content-type3',
      'q /OC /OCoff BDC BT /T3 20 Tf 30 150 Td (A) Tj 3 Tr (B) Tj 7 Tr (C) Tj 4 Tr (A) Tj ET EMC Q',
    );
    expect(expected.glyphs).toEqual([]);
    expect(text(expected.invisible)).toBe('B\u{1F44D}'); // /T3 maps C to U+1F44D
  }, 60_000);

  it('optional content MuPDF 1.28 evaluates otherwise than the PDF says: /P /AllOn, /P /AnyOff, /VE (0002 §13)', async () => {
    const { expected, actual } = await inventories(
      'optional-content-mupdf',
      '/OC /MDallOn BDC 10 10 20 20 re f EMC /OC /MDanyOff BDC 40 10 20 20 re f EMC /OC /MDve BDC 70 10 20 20 re f EMC',
    );
    expect(expected.paints.map((p) => p.bbox[0])).toEqual([10, 70]);
    expect(actual.paints.map((p) => p.bbox[0])).toEqual([40]);
  }, 60_000);
});

describe('0002 §13 blend and group differences', () => {
  it('a blend mode array: MuPDF takes its first name, pdf.js the first it knows', async () => {
    const { expected, actual } = await inventories('blend-array', 'q /GS14 gs 10 10 20 20 re f Q');
    expect(expected.paints.map((p) => p.blend)).toEqual(['normal']);
    expect(actual.paints.map((p) => p.blend)).toEqual(['screen']);
  }, 60_000);

  it('a /Group that is no transparency group: a group for pdf.js, none for MuPDF', async () => {
    const { expected, actual } = await inventories('group-not-transparency', 'q /GS1 gs /Fm15 Do Q');
    expect(expected.paints.map((p) => [p.alpha, p.groupAlpha])).toEqual([[0.5, 1]]);
    expect(actual.paints.map((p) => [p.alpha, p.groupAlpha])).toEqual([[1, 0.5]]);
  }, 60_000);
});

describe('0002 §12 comparison of the clip, group and mask fields on real values', () => {
  it('a real diff in each field shows', async () => {
    const bytes = syntheticPdf('q /GS2 gs /GS9 gs 20 30 100 80 re W n /Fm8 Do Q');
    const pdf = writeOut('contract/scene-diff.pdf', bytes);
    const expected = oracleInventory(pdf, [1]);
    const { inventory: actual } = await walkerInventory(bytes, [1]);
    const fill = actual.pages[0]!.paints[0]!;
    const glyph = actual.pages[0]!.glyphs[0]!;
    expect([fill.clip, fill.groupAlpha, fill.blend, fill.masked, glyph.groupAlpha]).toEqual([
      [20, 190, 120, 270],
      1,
      'multiply',
      true,
      1,
    ]);
    const edits: [() => void, () => void][] = [
      [() => void (fill.clip = [20, 190, 120, 270.1]), () => void (fill.clip = [20, 190, 120, 270])],
      [() => void (fill.groupAlpha = 0.5), () => void (fill.groupAlpha = 1)],
      [() => void (fill.blend = 'normal'), () => void (fill.blend = 'multiply')],
      [() => void (fill.masked = false), () => void (fill.masked = true)],
      [() => void (glyph.groupAlpha = 0.5), () => void (glyph.groupAlpha = 1)],
    ];
    for (const [edit, undo] of edits) {
      edit();
      expect(compareInventories(expected, actual).diffs).toHaveLength(1);
      undo();
    }
    expect(compareInventories(expected, actual).diffs).toEqual([]);
  }, 60_000);
});

describe('0002 §12 comparison of the image and shading fields on real values', () => {
  it('a real diff in each field shows', async () => {
    const bytes = syntheticPdf('0 0 1 rg q 60 0 0 40 20 30 cm /Im3 Do Q q 40 0 0 40 120 30 cm /Im1 Do Q /Sh1 sh');
    const pdf = writeOut('contract/image-diff.pdf', bytes);
    const expected = oracleInventory(pdf, [1]);
    const { inventory: actual } = await walkerInventory(bytes, [1]);
    const [stencil, image, shade] = actual.pages[0]!.paints;
    const ctm = stencil!.ctm!;
    const edits: [() => void, () => void][] = [
      [() => void (stencil!.ctm = [ctm[0] + 0.1, ctm[1], ctm[2], ctm[3], ctm[4], ctm[5]]), () => void (stencil!.ctm = ctm)],
      [() => void (stencil!.px = [8, 7]), () => void (stencil!.px = [8, 8])],
      [() => void (stencil!.stencil = false), () => void (stencil!.stencil = true)],
      [() => void (stencil!.rgb = [0, 0, 0]), () => void (stencil!.rgb = [0, 0, 255])],
      [() => void (image!.stencil = true), () => void (image!.stencil = false)],
      [() => void (shade!.shading = 'radial'), () => void (shade!.shading = 'axial')],
      [() => void delete shade!.shading, () => void (shade!.shading = 'axial')],
    ];
    for (const [edit, undo] of edits) {
      edit();
      expect(compareInventories(expected, actual).diffs).toHaveLength(1);
      undo();
    }
    expect(compareInventories(expected, actual).diffs).toEqual([]);
  }, 60_000);
});
