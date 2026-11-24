import { describe, expect, it } from 'vitest';
import type { Box, PathSeg } from '../../src/extract/inventory';
import { classifyPage, classifyShapes, shapeKind } from '../../src/passes/classify';
import { runPasses } from '../../src/passes';
import type { Element } from '../../src/scene/types';
import { circle, deckOf, lineStyle, picture, poly, rectPath, shape, slideOf, snapshot, textline } from '../helpers/passes';

/** The two classifiers of `classify.ts` (ruling M3-R2): the page's class, and each shape's kind. */

const A4: [number, number] = [595.276, 841.89];
const LETTER_LANDSCAPE: [number, number] = [792, 612];

/** A slide of page size `size` whose elements are clipped to that page (the helpers' clip is the 300 x 200 page). */
const paper = (elements: Element[], size: [number, number]) =>
  slideOf(
    elements.map((el) => ({ ...el, clipBox: [0, 0, size[0], size[1]] as Box })),
    { sizePt: size },
  );

describe('classify page', () => {
  it('a page of pictures with no text and no shape over 1 % is image-only', () => {
    const slide = slideOf([
      picture([0, 0, 300, 120]),
      picture([0, 115, 300, 190]),
      shape({ geom: rectPath(5, 5, 20, 20) }), // 400 pt²: 0.67 % of the page
    ]);
    expect(classifyPage(slide)).toBe('image-only');
  });

  it('text, a shape over 1 % or pictures under 90 % make it a vector page', () => {
    const pics = [picture([0, 0, 300, 200])];
    expect(classifyPage(slideOf([...pics, textline()]))).toBe('vector');
    expect(classifyPage(slideOf([...pics, shape({ geom: rectPath(5, 5, 30, 30) })]))).toBe('vector');
    expect(classifyPage(slideOf([picture([0, 0, 300, 170])]))).toBe('vector'); // 85 %
    // two pictures over the same 60 %: they cover 60 %, not 120 %
    expect(classifyPage(slideOf([picture([0, 0, 300, 120]), picture([0, 0, 300, 120])]))).toBe('vector');
    // an invisible shape paints nothing, so it does not count
    expect(classifyPage(slideOf([...pics, shape({ geom: rectPath(5, 5, 100, 100), fill: null })]))).toBe('image-only');
  });

  it('a page of 30,000 picture tiles is measured in time', () => {
    const tiles = [];
    for (let i = 0; i < 30000; i++) tiles.push(picture([(i % 300), Math.floor(i / 300) * 2, (i % 300) + 1, Math.floor(i / 300) * 2 + 2], { op: 1 }));
    const started = performance.now();
    // the 2,000 largest tiles cover 4,000 of 60,000 pt²: less than they all do, and not image-only
    expect(classifyPage(slideOf(tiles))).toBe('vector');
    expect(performance.now() - started).toBeLessThan(5000);
    // one picture over the page among them still makes it image-only
    expect(classifyPage(slideOf([picture([0, 0, 300, 200]), ...tiles]))).toBe('image-only');
  });

  it('an A4 or Letter page with everything in a centred 16:9 or 4:3 box is a print frame', () => {
    // A4 portrait: a 16:9 slide 540 x 303.75 pt, centred
    const x0 = (A4[0] - 540) / 2;
    const y0 = (A4[1] - 303.75) / 2;
    const frame = shape({ geom: rectPath(x0, y0, 540, 303.75), fill: null, line: lineStyle({ w: 0.5 }) });
    const inside = shape({ geom: rectPath(x0 + 20, y0 + 20, 100, 50) });
    expect(classifyPage(paper([frame, inside], A4))).toBe('print-frame');
    // Letter landscape: a 4:3 slide 640 x 480 pt, centred
    const lx = (LETTER_LANDSCAPE[0] - 640) / 2;
    const ly = (LETTER_LANDSCAPE[1] - 480) / 2;
    expect(classifyPage(paper([shape({ geom: rectPath(lx, ly, 640, 480) })], LETTER_LANDSCAPE))).toBe('print-frame');
  });

  it('not a print frame: off centre, another aspect, a paint outside the box, or another page size', () => {
    const x0 = (A4[0] - 540) / 2;
    const y0 = (A4[1] - 303.75) / 2;
    const box = (dx = 0, h = 303.75) => shape({ geom: rectPath(x0 + dx, y0, 540, h) });
    expect(classifyPage(paper([box()], A4))).toBe('print-frame');
    expect(classifyPage(paper([box(10)], A4))).toBe('vector');
    expect(classifyPage(paper([box(0, 360)], A4))).toBe('vector');
    expect(classifyPage(paper([box(), shape({ geom: rectPath(5, 5, 10, 10) })], A4))).toBe('vector');
    // a 16:9 box centred on a page that is not A4 or Letter
    expect(classifyPage(paper([shape({ geom: rectPath(30, 30, 160, 90) })], [220, 150]))).toBe('vector');
  });

  it('runPasses reports the class and the slide, 1-based, with its notes', () => {
    const slide = slideOf([picture([0, 0, 300, 200])], { index: 4, notes: [{ opIndex: 3, op: 'paintXObject', detail: 'fixed words' }] });
    const { report } = runPasses(slide, deckOf([slide]));
    expect(report).toEqual({
      index: 5,
      class: 'image-only',
      scale: null,
      counts: { textBoxes: 0, freeforms: 0, rects: 0, lines: 0, pictures: 0, gradients: 0, hotspots: 0, runLinks: 0, fallbacks: 0 },
      fallbacks: [],
      fallbacksTruncated: 0,
      approximations: [],
      approximationsTruncated: 0,
      notes: [{ opIndex: 3, op: 'paintXObject', detail: 'fixed words' }],
      failed: null,
    });
  });
});

describe('shape kind', () => {
  const filled = (geom: PathSeg[]) => shape({ geom });
  const stroked = (geom: PathSeg[]) => shape({ geom, fill: null, line: lineStyle() });

  it('an axis-aligned four-corner closed path is a rect, from any corner, either way round', () => {
    expect(shapeKind(filled(rectPath(10, 20, 100, 50)))).toBe('rect');
    expect(shapeKind(stroked(poly([[110, 70], [10, 70], [10, 20], [110, 20]])))).toBe('rect'); // from the bottom right, clockwise
    expect(shapeKind(filled(poly([[10, 20], [10, 70], [110, 70], [110, 20]])))).toBe('rect'); // counter-clockwise
    // the closing point repeated, and a point along a side (a turn of 0)
    expect(shapeKind(stroked(poly([[10, 20], [60, 20], [110, 20], [110, 70], [10, 70], [10, 20]])))).toBe('rect');
    // a fill closes by itself
    expect(shapeKind(filled([['M', 10, 20], ['L', 110, 20], ['L', 110, 70], ['L', 10, 70]]))).toBe('rect');
    // a sh paints its clip: a rect at its box
    expect(shapeKind(shape({ geom: null }))).toBe('rect');
  });

  it('not a rect: turned, curved, open when stroked, two subpaths, a spike, or no area', () => {
    expect(shapeKind(filled(poly([[10, 20], [110, 21], [110, 70], [10, 70]])))).toBe('custom');
    expect(shapeKind(filled(circle(50, 50, 20)))).toBe('custom');
    expect(shapeKind(stroked([['M', 10, 20], ['L', 110, 20], ['L', 110, 70], ['L', 10, 70], ['L', 10, 20]]))).toBe('custom');
    expect(shapeKind(filled([...rectPath(0, 0, 10, 10), ...rectPath(20, 0, 10, 10)]))).toBe('custom');
    expect(shapeKind(filled(poly([[10, 20], [110, 20], [110, 70], [10, 70], [10, 90], [10, 70]])))).toBe('custom');
    expect(shapeKind(filled(poly([[10, 20], [110, 20], [110, 20], [10, 20]])))).toBe('custom');
    // a dashed stroke starts where its path does: only the preset's own start and direction keep the dashes in place, its
    // bottom left corner going up (measured, M5 Task 4: the rect preset's dashes are those of an open path from there)
    const dashed = (geom: PathSeg[]) => shape({ geom, fill: null, line: lineStyle({ dash: [3, 2] }) });
    expect(shapeKind(dashed(poly([[10, 70], [10, 20], [110, 20], [110, 70]])))).toBe('rect');
    expect(shapeKind(dashed(rectPath(10, 20, 100, 50)))).toBe('custom');
    expect(shapeKind(dashed(poly([[10, 20], [10, 70], [110, 70], [110, 20]])))).toBe('custom');
    expect(shapeKind(dashed(poly([[10, 70], [110, 70], [110, 20], [10, 20]])))).toBe('custom');
  });

  it('a single open stroked segment with no fill is a line', () => {
    expect(shapeKind(stroked([['M', 10, 20], ['L', 200, 120]]))).toBe('line');
    expect(shapeKind(stroked([['M', 10, 20], ['L', 10, 120]]))).toBe('line');
  });

  it('not a line: filled, closed, two segments, a curve, or of no length', () => {
    expect(shapeKind(shape({ geom: [['M', 10, 20], ['L', 200, 120]], line: lineStyle() }))).toBe('custom');
    expect(shapeKind(stroked([['M', 10, 20], ['L', 200, 120], ['Z']]))).toBe('custom');
    expect(shapeKind(stroked([['M', 10, 20], ['L', 200, 120], ['L', 250, 120]]))).toBe('custom');
    expect(shapeKind(stroked([['M', 10, 20], ['L', 200, 120], ['M', 10, 30], ['L', 200, 130]]))).toBe('custom');
    expect(shapeKind(stroked([['M', 10, 20], ['C', 50, 0, 150, 0, 200, 20]]))).toBe('custom');
    expect(shapeKind(stroked([['M', 10, 20], ['L', 10, 20]]))).toBe('custom');
  });

  it('the pass annotates every shape and leaves its input as it was', () => {
    const input = slideOf([filled(rectPath(10, 20, 100, 50)), stroked([['M', 1, 1], ['L', 9, 9]]), textline()]);
    const before = snapshot(input);
    const out = classifyShapes(input);
    expect(input).toEqual(before);
    expect(out.elements.map((e) => (e.kind === 'shape' ? (e as { shapeKind?: string }).shapeKind : e.kind))).toEqual(['rect', 'line', 'textline']);
  });
});
