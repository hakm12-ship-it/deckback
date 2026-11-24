import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, releasePage } from '../../src/engine/pdfjs-adapter';
import { walkOps, walkPage } from '../../src/extract/walker';
import type { ClipDef, TileCell } from '../../src/scene/types';
import { clipWeight, elementWeight, meshWeight, NESTED_UNIT, ownWeight, PAGE_UNIT, pathWeight, SEGMENT_UNIT, slideWeight, takenClipWeight } from '../../src/scene/weight';
import { fallback, hotspot, lineStyle, picture, rectPath, shape, slideOf, solid, textline } from '../helpers/passes';

/** Ruling M3-R60: each kind weighs what it holds, about 100 B a unit, on the page and in a tile cell or soft mask. */
describe('the weight of an element (scene/weight.ts)', () => {
  const curve = shape({ geom: [['M', 0, 0], ['C', 1, 1, 2, 2, 3, 3], ['L', 4, 4], ['Z']] });

  it('weighs each kind of the page by its unit, and its segments and glyphs', () => {
    expect(pathWeight(curve.geom)).toBe(SEGMENT_UNIT.M + SEGMENT_UNIT.C + SEGMENT_UNIT.L + SEGMENT_UNIT.Z);
    expect([SEGMENT_UNIT.M, SEGMENT_UNIT.L, SEGMENT_UNIT.C, SEGMENT_UNIT.Z]).toEqual([13, 4, 8, 4]);
    expect(ownWeight(curve)).toBe(PAGE_UNIT.shape + 29);
    expect(ownWeight(shape({ geom: rectPath(0, 0, 5, 5) }))).toBe(26 + 13 + 3 * 4 + 4);
    expect(ownWeight(picture([0, 0, 10, 10]))).toBe(22);
    const line = textline();
    const glyphs = line.runs.reduce((n, r) => n + r.glyphs.length, 0);
    expect(glyphs).toBeGreaterThan(0);
    expect(ownWeight(line)).toBe(45 + glyphs);
    expect(ownWeight(hotspot(0, [1, 1, 9, 9], { url: 'https://a.example/', dest: null }))).toBe(24);
    expect(ownWeight(fallback('unsupported-op'))).toBe(7);
  });

  it('weighs an element of a tile cell or soft mask, which nothing writes, NESTED_UNIT and one a segment or glyph', () => {
    expect(ownWeight(curve, true)).toBe(NESTED_UNIT + 4);
    expect(ownWeight(picture([0, 0, 10, 10]), true)).toBe(NESTED_UNIT);
    const line = textline();
    expect(ownWeight(line, true)).toBe(NESTED_UNIT + line.runs.reduce((n, r) => n + r.glyphs.length, 0));
    const cell: TileCell = { bbox: [0, 0, 10, 10], xStep: 10, yStep: 10, matrix: [1, 0, 0, 1, 0, 0], paintType: 1, elements: [curve, curve], clips: {} };
    const tiled = shape({ geom: rectPath(0, 0, 5, 5), fill: { kind: 'tile', cell, alpha: 1 } });
    expect(elementWeight(tiled)).toBe(55 + 2 * (NESTED_UNIT + 4));
  });

  it('weighs the triangles of a mesh shading (M5) by their numbers: 8 B each, in units of 100 B, rounded up', () => {
    // 4 vertices (5 numbers each) and 2 triangles (3 each): 26 numbers, 208 B, 3 units.
    const mesh = { type: 4 as const, xy: [0, 0, 1, 0, 0, 1, 1, 1], rgb: Array.from({ length: 12 }, () => 0), triangles: [0, 1, 2, 1, 2, 3], matrix: [1, 0, 0, 1, 0, 0], bbox: null, background: null };
    expect(meshWeight(mesh)).toBe(3);
    const fill = { kind: 'shading' as const, shading: 'mesh' as const, alpha: 1, mesh };
    expect(elementWeight(shape({ geom: null, fill }))).toBe(PAGE_UNIT.shape + 3);
    expect(elementWeight(shape({ geom: null, fill: { ...fill, mesh: null } }))).toBe(PAGE_UNIT.shape);
    expect(elementWeight(shape({ geom: rectPath(0, 0, 5, 5), fill: solid(), line: lineStyle({ paint: fill }) }))).toBe(55 + 3);
    // pdf.js' largest lattice, 513 x 513 vertices of a function-based shading: about 23 MB, within the slide's budget.
    expect(meshWeight({ ...mesh, xy: new Array(513 * 513 * 2).fill(0), rgb: new Array(513 * 513 * 3).fill(0), triangles: new Array(512 * 512 * 6).fill(0) })).toBe(
      Math.ceil(((513 * 513 * 5 + 512 * 512 * 6) * 8) / 100),
    );
  });

  it("an sh or a picture weighs its largest path clip's segments as its own, which it may take as its geometry", () => {
    const big: ClipDef = { kind: 'path', geom: rectPath(0, 0, 50, 50), rule: 'nonzero', bbox: [0, 0, 50, 50] };
    const box: ClipDef = { kind: 'box', bbox: [0, 0, 100, 100] };
    const clips = { c1: box, c2: big };
    const sh = shape({ geom: null, clip: ['c1', 'c2'] });
    expect(takenClipWeight(sh, clips)).toBe(29);
    expect(ownWeight(sh, false, clips)).toBe(26 + 29);
    expect(ownWeight(sh, true, clips)).toBe(NESTED_UNIT); // nothing of a cell is written
    expect(takenClipWeight(picture([0, 0, 10, 10], { clip: ['c2'] }), clips)).toBe(29);
    expect(takenClipWeight(shape({ geom: rectPath(0, 0, 5, 5), clip: ['c2'] }), clips)).toBe(0); // keeps its own path
    expect(clipWeight(big)).toBe(5); // the clip itself, which the Scene holds once
    const slide = slideOf([sh], { clips });
    expect(slideWeight(slide)).toBe(26 + 29 + 5);
  });
});

/** Final review F2: the Scene reads the page's ops as the walk makes them, which are `walkPage`'s, in its order. */
describe('walkOps', () => {
  it.each(['probe_std.pdf', 'atlas-smoke_std.pdf'])('gives the ops of walkPage, one by one, on every page of %s', async (name) => {
    const doc = await openDocument(new Uint8Array(readFileSync(new URL(`../../../../corpus/generated/${name}`, import.meta.url))));
    try {
      for (let index = 0; index < doc.numPages; index++) {
        const page = await loadPage(doc, index);
        try {
          for (const strict of [false, true]) {
            const ops = walkOps(page, { strict });
            const first = ops.next();
            const rest = [...ops];
            const all = first.done === true ? [] : [first.value, ...rest];
            expect(all, `page ${index + 1}`).toEqual(walkPage(page, { strict }));
          }
        } finally {
          await releasePage(page);
        }
      }
    } finally {
      await closeDocument(doc);
    }
  }, 120_000);
});
