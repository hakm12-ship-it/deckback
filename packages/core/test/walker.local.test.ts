import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { compareInventories, TOLERANCE_PT, type Inventory, type PageInv } from '../src/extract/inventory';
import { fixturePath, repoRoot } from './helpers/fixtures';
import { oracleInventory, runPython, walkerInventory } from './helpers/oracle';
import { syntheticPdf, writeOut } from './helpers/synthetic';

/**
 * Spike M0-2: the walker's inventory against the PyMuPDF oracle (`harness/oracle/mupdf_inventory.py`).
 * Each fixture case writes its numbers to `out/m0/walker-<file>-p<pages>.json`; the informational case also
 * writes `out/m0/walker-diffs.json`. helpers/oracle.ts runs the oracle and the walker: the oracle with the harness
 * Python of helpers/fixtures.ts `pythonPath` (`harness/.venv`, override with `DECKBACK_PY`); pages there are
 * 1-based, the inventory's `index` is 0-based (docs/decisions/0002-inventory-contract.md §2 page index).
 */

const outDir = `${repoRoot}out/m0/`;
const original = fixturePath('original.pdf');
const rot90 = `${outDir}rot90.pdf`;

function counts(page: PageInv) {
  const paints = Object.fromEntries(
    (['fill', 'stroke', 'shade', 'image', 'pattern'] as const).map((k) => [k, page.paints.filter((p) => p.kind === k).length]),
  );
  return { index: page.index, paints, glyphs: page.glyphs.length, nonBlankGlyphs: page.glyphs.filter((g) => g.u.trim() !== '').length };
}

describe.skipIf(original === null)('walker inventory vs the PyMuPDF oracle', () => {
  beforeAll(() => {
    // Page 1 of original.pdf with /Rotate 90: the slide frame applies /Rotate (0002 §1 types).
    runPython([`${repoRoot}harness/oracle/make_rotated.py`, original!, rot90]);
  }, 60_000);

  it.each([
    ['original.pdf', [1], 'gate'], // GATE (spec M0-2)
    ['original.pdf', [2, 3], 'informational'], // spec M0-2 gates page 1 only: diffs go to out/m0/walker-diffs.json
    ['rot90.pdf', [1], 'gate'], // the gate page again, rotated: 0 diffs in the rotated slide frame
  ] as const)('%s pages %j match the oracle within 0.05 pt (%s)', async (name, pages, mode) => {
    const pdf = name === 'rot90.pdf' ? rot90 : original!;
    const informational = mode === 'informational';
    const expected = oracleInventory(pdf, [...pages]);
    const { inventory: actual, errors } = await walkerInventory(new Uint8Array(readFileSync(pdf)), [...pages], informational);
    // Compare only the pages the walker could walk (all of them, unless informational).
    const walkedIndexes = new Set(actual.pages.map((p) => p.index));
    const comparable: Inventory = { pages: expected.pages.filter((p) => walkedIndexes.has(p.index)) };
    const result = compareInventories(comparable, actual);
    const summary = {
      file: name,
      pages,
      ok: result.ok && errors.length === 0,
      tolerancePt: TOLERANCE_PT,
      maxBboxDelta: Math.round(result.maxBboxDelta * 1e6) / 1e6,
      maxGlyphDelta: Math.round(result.maxGlyphDelta * 1e6) / 1e6,
      approxPaints: result.approxPaints,
      oracle: expected.pages.map(counts),
      walker: actual.pages.map(counts),
      unsupported: errors,
      diffCount: result.diffs.length,
      diffs: result.diffs,
    };
    const json = `${JSON.stringify(summary, null, 2)}\n`;
    writeOut(`m0/walker-${name.replace(/\.pdf$/, '')}-p${pages.join('-')}.json`, json);

    if (informational) {
      const file = writeOut('m0/walker-diffs.json', json);
      expect(readFileSync(file, 'utf8')).toContain('"diffs"');
      return;
    }
    expect(result.diffs).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.approxPaints).toBe(0); // every gate paint is compared by value, none only by kind
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------
// Synthetic pages: walker paths the fixtures do not reach, each checked against the oracle (no fixture needed).
// ---------------------------------------------------------------------------------------------------------------

// "0002 §n" below cites a section of the inventory contract, docs/decisions/0002-inventory-contract.md.
const PATHS = [
  '1 0 0 rg 50 50 m 50 150 200 150 200 50 c f', // 0002 §4 path bbox: the control points reach y 150, the curve 125
  '0 0 1 RG 200 200 m 10 10 m 20 20 l 100 100 m S', // a repeated or trailing moveTo adds no point
  '0 g 50 50 m h 10 10 m 20 20 l f', // ... but a closed one does
  '10 10 m 50 80 90 10 v f 110 10 m 150 80 190 10 y f', // v and y curves
  '0.5 g 0 0 1 RG 20 220 60 40 re B 100 220 60 40 re b*', // fill then stroke, nonzero / even-odd
  'q 2 0 0 0.5 30 30 cm 0 0 50 50 re f Q 10 10 0 20 re f', // cm; a zero-width rectangle
].join(' ');
const TEXT = [
  'BT /F1 20 Tf 1 0 0 1 30 250 Tm (AB A) Tj 2 Tc (AB) Tj 0 Tc 5 Tw (A B) Tj 0 Tw 150 Tz (AB) Tj 100 Tz',
  '4 Ts (A) Tj 0 Ts [(A) -500 (B) 250 (A)] TJ 0 -40 Td (B) Tj 25 TL T* (A) Tj 10 -30 TD (B) Tj T* (A) Tj ET',
  'BT /F1 12 Tf 0.866 0.5 -0.5 0.866 100 100 Tm (ABA) Tj ET', // rotated text matrix
  'q 0.5 0 0 2 0 0 cm BT /F1 10 Tf 40 40 Td (AB) Tj ET Q', // text under a scaled CTM
].join(' ');
const ROTATED_PAGE = '/MediaBox [0 0 300 200] /CropBox [10 20 210 170] /Rotate';

const syntheticCases: [name: string, content: string, page?: string][] = [
  ['paths', PATHS],
  [
    'clips-and-patterns',
    'q 100 100 100 50 re W n /Sh1 sh Q /Sh1 sh q 50 50 m W n /Sh1 sh Q q 20 20 m 150 150 l 10 10 m W* n /Sh1 sh Q ' +
      'q 10 10 200 200 re W n /Pattern cs /P1 scn 40 40 100 60 re f /P2 scn 40 140 100 60 re f Q', // 0002 §5, §9
  ],
  ['text', TEXT],
  // 0002 §6 glyphs: Tr 3 is no glyph; a Tr 7 run reaches MuPDF at ET, after the later Tr 4 run. Each block ends in
  // a clip mode: MuPDF drops the accumulated text clip (and Tr 7 glyphs) when the mode at ET is 0-3 (0002 §11).
  [
    'render-modes',
    'BT /F1 20 Tf 30 250 Td 0 Tr (A) Tj 1 Tr (B) Tj 2 Tr (A) Tj 3 Tr (B) Tj 4 Tr (A) Tj 5 Tr (B) Tj 6 Tr (A) Tj 7 Tr (B) Tj ET ' +
      'BT /F1 20 Tf 30 200 Td 7 Tr (C) Tj 4 Tr (A) Tj ET',
  ],
  ['rotate-90', `${PATHS} ${TEXT}`, `${ROTATED_PAGE} 90`],
  ['rotate-180', `${PATHS} ${TEXT}`, `${ROTATED_PAGE} 180`],
  ['rotate-270', `${PATHS} ${TEXT}`, `${ROTATED_PAGE} 270`],
  [
    'images',
    'q 80 0 0 40 20 120 cm /Im1 Do Q q 100 0 0 50 20 30 cm BI /W 2 /H 2 /CS /G /BPC 8 ID \x10\x20\x30\x40 EI Q ' +
      'q 50 0 0 50 150 30 cm BI /IM true /W 1 /H 1 /BPC 1 ID \x00 EI Q ' + // 1x1 mask: pdf.js paintSolidColorImageMask
      'q 0.2 0.4 0.6 rg 30 0 0 20 200 200 cm BI /IM true /W 2 /H 2 /BPC 1 ID \x40\x20 EI Q',
  ],
  ['forms-and-groups', '/Fm1 Do /GS1 gs /Fm2 Do 0 0 1 rg 100 100 20 20 re B'], // BBox clip, form matrix, group alpha
  ['soft-mask', 'q /GS2 gs 1 0 0 rg 50 50 100 100 re f /Sh1 sh Q 0 0 1 rg 10 10 5 5 re f'], // 0002 §9
];

describe('walker vs the PyMuPDF oracle on synthetic pages', () => {
  it.each(syntheticCases)('%s', async (name, content, page) => {
    const bytes = syntheticPdf(content, page);
    const pdf = writeOut(`m0/synthetic/${name}.pdf`, bytes);
    const expected = oracleInventory(pdf, [1]);
    const { inventory: actual } = await walkerInventory(bytes, [1]);
    expect(actual.pages[0]!.paints.length + actual.pages[0]!.glyphs.length).toBeGreaterThan(0);
    expect(compareInventories(expected, actual).diffs).toEqual([]);
  }, 60_000);
});

// 0002 §9 tiling patterns and §5 approx: each case gives this many `pattern` paints and walker paints marked approx.
// MuPDF uses begin_tile for a fill wider or taller than the pattern step; a smaller one gets each cell it overlaps
// drawn directly onto the page. Either way it is one pattern paint.
const patternCases: [name: string, content: string, patterns: number, approx: number][] = [
  [
    'tiling-path',
    'q 10 10 200 200 re W n /Pattern cs /P2 scn 40 40 100 60 re f Q ' + // larger than the step: begin_tile
      'q 10 10 200 200 re W n /Pattern cs /P2 scn 150 150 100 100 re f Q ' + // only partly inside the clip
      '/Pattern cs /P2 scn 152 152 5 5 re f ' + // inside one cell: MuPDF draws the cell directly
      '/Pattern cs /P3 scn 150 200 100 50 re f ' + // exactly the big cell holding an image: not an image paint
      'q /GS1 gs /Pattern cs /P2 scn 0 0 1 RG 20 220 60 40 re B Q ' + // fill alpha 0.5, then a solid stroke
      'q /GS1 gs /Fm3 Do Q', // inside a group drawn at alpha 0.5: the fill alpha is 1 (0002 §1)
    6,
    0,
  ],
  [
    'tiling-direct-cells', // no larger than one cell but across cell boundaries: MuPDF draws 2 or 4 cells directly
    '/Pattern cs /P2 scn 105 101 10 8 re f 105 105 10 10 re f ' + // 2 and 4 cells of 10 pt
      '/P3 scn 200 200 100 50 re f ' + // half of one picture cell and half of the next
      '/P4 scn BT /F1 20 Tf 40 95 Td (AB) Tj ET ' + // text across x 50 and y 100 (approx)
      'q 30 0 0 20 40 40 cm BI /IM true /W 2 /H 2 /BPC 1 ID \x40\x20 EI Q', // image mask across x 50 and y 50
    5,
    1,
  ],
  [
    'tiling-image-mask',
    'q 0 0 120 300 re W n /Pattern cs /P2 scn q 30 0 0 20 100 200 cm BI /IM true /W 2 /H 2 /BPC 1 ID \x40\x20 EI Q ' +
      'q 50 0 0 50 150 30 cm BI /IM true /W 1 /H 1 /BPC 1 ID \x00 EI Q Q', // 1x1: pdf.js paintSolidColorImageMask
    2,
    0,
  ],
  [
    'tiling-text', // glyphs as usual (0002 §6) plus one approx pattern paint per stretch of text (0002 §5)
    '/Pattern cs /P2 scn BT /F1 20 Tf 30 250 Td (AB) Tj ET 0 0 1 RG 2 Tr BT /F1 20 Tf 30 200 Td (BA) Tj ET',
    2,
    2,
  ],
  [
    'text-clip', // under a text clip, shade and pattern bboxes come from the approximate clip; after Q they do not
    'q BT 7 Tr /F1 20 Tf 30 250 Td (AB) Tj ET /Sh1 sh 20 240 40 40 re W n /Pattern cs /P2 scn 0 0 300 300 re f Q ' +
      '/Sh1 sh /Pattern cs /P2 scn 0 0 300 300 re f',
    2,
    2,
  ],
];

describe('walker pattern and approx paints vs the PyMuPDF oracle', () => {
  it.each(patternCases)('%s', async (name, content, patterns, approx) => {
    const bytes = syntheticPdf(content);
    const pdf = writeOut(`m0/synthetic/${name}.pdf`, bytes);
    const expected = oracleInventory(pdf, [1]);
    const { inventory: actual } = await walkerInventory(bytes, [1]);
    const paints = actual.pages[0]!.paints;
    expect(expected.pages[0]!.paints.filter((p) => p.kind === 'pattern')).toHaveLength(patterns);
    expect(paints.filter((p) => p.kind === 'pattern')).toHaveLength(patterns);
    expect(paints.filter((p) => p.approx === true)).toHaveLength(approx);
    const result = compareInventories(expected, actual);
    expect(result.diffs).toEqual([]);
    expect(result.approxPaints).toBe(approx);
  }, 60_000);
});
