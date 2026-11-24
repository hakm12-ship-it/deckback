import { describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, OPS, releasePage } from '../../src/engine/pdfjs-adapter';
import { compareInventories, toInventory, type Inventory } from '../../src/extract/inventory';
import { pageFrame, walkPage, type GroupFrame, type RawOp, type SoftMask } from '../../src/extract/walker';
import { buildSlide, type BuildContext } from '../../src/scene/build';
import { FontTable } from '../../src/scene/fonts';
import { inventoryOfSlide } from '../../src/scene/inventory';
import { MediaStore } from '../../src/scene/media';
import type { ShapeEl } from '../../src/scene/types';
import { syntheticPdf } from '../helpers/synthetic';

/**
 * Scene v1, solid shapes: `buildSlide` turns each fill and stroke RawOp into one shape element, and `inventoryOfSlide`
 * rebuilds the contract inventory (docs/decisions/0002-inventory-contract.md) from the Scene alone. Pictures: media.test.ts;
 * text: text.test.ts.
 */

/** The RawOp kinds `buildSlide` maps; shades: fills.test.ts. A run's glyphs are one text line. */
const MAPPED: ReadonlySet<RawOp['kind']> = new Set(['fill', 'stroke', 'image', 'shade', 'pattern', 'glyph', 'invisible']);

/**
 * A context for RawOps made up here: no page behind them (a picture would find no pixels, and there is no structure
 * tree), and an empty media store and font table.
 */
const noPage = (): BuildContext => ({
  media: new MediaStore(null),
  fonts: new FontTable(null),
  page: { ops: { fnArray: [], argsArray: [] }, obj: () => undefined, pageRef: { num: 0, gen: 0 }, structTree: null },
});

/** Walks page 1 of a synthetic PDF and builds its slide, before the page is released (as `buildSlide` requires). */
async function walk(content: string, page?: string, index = 0) {
  const doc = await openDocument(syntheticPdf(content, page));
  try {
    const data = await loadPage(doc, 0);
    try {
      const ops = walkPage(data);
      const size = pageFrame(data).size;
      const fonts = new FontTable(null);
      const slide = await buildSlide({ index, sizePt: size, ops }, { media: new MediaStore(null), fonts, page: data });
      return { ops, size, fnArray: [...data.ops.fnArray], slide, fonts };
    } finally {
      await releasePage(data);
    }
  } finally {
    await closeDocument(doc);
  }
}

const shapes = (elements: readonly unknown[]): ShapeEl[] => elements as ShapeEl[];

/** What the walker gives every stroke: its line style and the CTM it is drawn under. */
const STROKE = {
  line: { w: 1, cap: 0, join: 0, miter: 10, dash: [], phase: 0 },
  lineCtm: [1, 0, 0, -1, 0, 100],
} satisfies Pick<RawOp, 'line' | 'lineCtm'>;

/** A RawOp of the walker's shape, for the cases a synthetic page cannot reach. */
const raw = (over: Partial<RawOp> & Pick<RawOp, 'kind'>): RawOp => ({
  opIndex: 0,
  bbox: [10, 10, 20, 20],
  rgb: [1, 2, 3],
  alpha: 1,
  evenOdd: false,
  path: [['M', 10, 10], ['L', 20, 20]],
  mcid: null,
  clip: [0, 0, 100, 100],
  blend: 'normal',
  masked: false,
  groups: [],
  ...over,
});

describe('buildSlide: solid shapes', () => {
  it('a filled rectangle is one shape: geom M L L L Z, fill solid, id p1:z<n>, opIndex [n]', async () => {
    const { fnArray, slide } = await walk('1 0 0 rg 10 20 30 40 re f');
    const n = fnArray.indexOf(OPS.constructPath);
    expect(n).toBeGreaterThan(0);
    expect(slide).toMatchObject({ index: 0, sizePt: [300, 300], clips: {}, masks: {}, notes: [], failed: null });
    expect(slide.elements).toEqual([
      {
        kind: 'shape',
        id: `p1:z${n}`,
        provenance: { opIndex: [n], mcid: null, struct: null },
        clip: [],
        clipBox: [0, 0, 300, 300],
        groups: [],
        mask: null,
        blend: 'normal',
        // re 10 20 30 40 in the slide frame (y down from the top of a 300 pt page), corners in the order pdf.js gives them
        geom: [['M', 10, 280], ['L', 40, 280], ['L', 40, 240], ['L', 10, 240], ['Z']],
        fillRule: 'nonzero',
        fill: { kind: 'solid', rgb: [255, 0, 0], alpha: 1 },
        line: null,
        bbox: [10, 240, 40, 280],
      },
    ]);
  });

  it('fill+stroke is two shapes with distinct ids and the same opIndex', async () => {
    const { fnArray, slide } = await walk('1 0 0 rg 0 0 1 RG 4 w 10 20 30 40 re B');
    const n = fnArray.indexOf(OPS.constructPath);
    expect(slide.elements.map((e) => [e.id, e.provenance.opIndex])).toEqual([
      [`p1:z${n}`, [n]],
      [`p1:z${n}:1`, [n]],
    ]);
    const [fill, stroke] = shapes(slide.elements);
    expect([fill!.fill, fill!.line]).toEqual([{ kind: 'solid', rgb: [255, 0, 0], alpha: 1 }, null]);
    expect(stroke!.fill).toBeNull();
    expect(stroke!.line).toEqual({
      w: 4,
      cap: 'butt',
      join: 'miter',
      miter: 10,
      dash: [],
      phase: 0,
      anisotropic: false,
      paint: { kind: 'solid', rgb: [0, 0, 255], alpha: 1 },
    });
    expect(stroke!.geom).toEqual(fill!.geom);
    expect(stroke!.bbox).toEqual(fill!.bbox); // a stroke's box is its path's, not widened by the line (0002 §1)
  });

  it('paint order is kept', async () => {
    const { ops, slide } = await walk(
      '1 0 0 rg 10 10 20 20 re f BT /F1 10 Tf 50 50 Td (A) Tj ET 0 1 0 RG 20 20 m 40 40 l S ' +
        '0 0 1 rg 50 50 10 10 re f* 1 1 0 rg 0 1 1 RG 100 100 m 120 100 l 120 120 l b',
    );
    expect(ops.filter((op) => op.kind === 'glyph')).toHaveLength(1); // one glyph: one text line, in its place
    const painted = ops.filter((op) => MAPPED.has(op.kind));
    expect(slide.elements.map((e) => e.provenance.opIndex[0])).toEqual(painted.map((op) => op.opIndex));
    expect(slide.elements.map((e) => e.kind)).toEqual(['shape', 'textline', 'shape', 'shape', 'shape', 'shape']);
    const colour = (e: ShapeEl) =>
      e.fill?.kind === 'solid' ? ['fill', e.fill.rgb] : ['stroke', e.line?.paint.kind === 'solid' ? e.line.paint.rgb : null];
    const solids = shapes(slide.elements.filter((e) => e.kind === 'shape'));
    expect(solids.map(colour)).toEqual([
      ['fill', [255, 0, 0]],
      ['stroke', [0, 255, 0]],
      ['fill', [0, 0, 255]],
      ['fill', [255, 255, 0]],
      ['stroke', [0, 255, 255]],
    ]);
    expect(solids.map((e) => e.fillRule)).toEqual(['nonzero', 'nonzero', 'evenodd', 'nonzero', 'nonzero']);
    expect(solids[4]!.geom!.at(-1)).toEqual(['Z']); // b closes the path
  });

  /**
   * A page with what a shape can carry: a clip, a curve, a dash and every line state a gs can set, an even-odd fill and
   * stroke under a CTM that stretches one axis, alphas, and transparency groups that nest (Fm8, drawn at ca 0.8 in
   * Screen, has fills at ca 0.4 and in ColorDodge, and draws the isolated knockout Fm9 at ca 0.4, which has a fill at
   * ca 0.5). Fm8 and Fm9 hold text too, whose glyphs the inventory compares as well.
   */
  const RICH =
    'q 1 0 0 rg 10 10 50 30 re f Q ' +
    'q 0 0 1 RG /GS3 gs 20 100 m 60 140 80 100 120 120 c S Q ' +
    'q 2 0 0 1 0 0 cm 0 0.5 0 rg 1 0 0 RG 150 0 m 140 20 l 130 0 l h B* Q ' +
    'q 20 200 100 60 re W n 0 0 1 rg 0 0 300 300 re f Q ' +
    'q /GS1 gs 0 1 1 rg 0.5 0 1 RG 200 200 40 40 re B Q ' +
    'q /GS10 gs /Fm8 Do Q ' +
    'q 0.5 0.70710678 -0.70710678 0.5 150 150 cm 0 0 0 RG 0 0 m 30 0 l S Q';

  it.each([
    ['an upright page', undefined],
    ['a turned and cropped page', '/MediaBox [0 0 300 300] /CropBox [10 20 290 260] /Rotate 90'],
  ])("inventoryOfSlide equals the walker's inventory for the paints: %s", async (_name, page) => {
    const { ops, size, slide, fonts } = await walk(RICH, page);
    const expected: Inventory = toInventory([{ index: 0, size, ops: ops.filter((op) => MAPPED.has(op.kind)) }]);
    const actual: Inventory = { pages: [inventoryOfSlide(slide, fonts.infos())] };
    const result = compareInventories(expected, actual);
    expect(result.diffs).toEqual([]);
    expect(result.ok).toBe(true);
    expect(actual).toEqual(expected); // nothing here is approximate, masked or rounded twice: equal, not only within tolerance

    // The page reaches what it is meant to: none of these is a default value.
    const paints = expected.pages[0]!.paints;
    expect(paints).toHaveLength(13);
    expect(paints.some((p) => p.evenOdd)).toBe(true);
    expect(paints.some((p) => p.line !== undefined && p.line.dash.length > 0 && p.line.cap === 1 && p.line.join === 2)).toBe(true);
    expect(paints.some((p) => p.path?.some((seg) => seg[0] === 'C'))).toBe(true);
    expect(paints.some((p) => p.clip.join() !== [0, 0, ...expected.pages[0]!.size].join())).toBe(true);
    expect(paints.some((p) => p.alpha === 0.25)).toBe(true);
    expect(new Set(paints.map((p) => p.groupAlpha))).toEqual(new Set([1, 0.8, 0.32]));
    expect(new Set(paints.map((p) => p.blend))).toEqual(new Set(['normal', 'screen', 'colordodge']));
    expect(expected.pages[0]!.glyphs.map((g) => [g.u, g.groupAlpha])).toEqual([
      ['A', 0.8],
      ['B', 0.32],
    ]);
  });

  it("a stroke's line is anisotropic when the CTM's axes differ by more than 1 % or skew more than 0.01 degrees (M2-R4)", async () => {
    const CTMS = [
      '1 0 0 1 0 0', // the page's own frame (y flipped)
      '0.8660254 0.5 -0.5 0.8660254 0 0', // turned 30 degrees
      '-1 0 0 1 300 0', // mirrored
      '2 0 0 2 0 0', // larger, the same both ways
      '1 0 0 1.009 0 0', // the axes differ by 0.9 %
      '1 0 0 1.011 0 0', // ... by 1.1 %
      '2 0 0 1 0 0',
      '1 0 0.0001 1 0 0', // skewed atan(0.0001) = 0.0057 degrees
      '1 0 0.0002 1 0 0', // ... 0.0115 degrees
    ];
    const { slide } = await walk(CTMS.map((m) => `q ${m} cm 2 w 10 10 m 50 10 l S Q`).join(' '));
    const lines = shapes(slide.elements).map((e) => e.line!);
    expect(lines.map((l) => l.anisotropic)).toEqual([false, false, false, false, false, true, true, false, true]);
    // w is the PDF width times sqrt|ad - bc|: under a stretched CTM, only an average.
    expect(lines.map((l) => l.w)).toEqual([2, 2, 2, 4, 2.009, 2.011, 2.828, 2, 2]);
  });
});

describe('buildSlide: ids, fields and rounding', () => {
  it('numbers pages from 1 and gives further elements of one op :1, :2 (M1-R50)', async () => {
    const ops = [
      raw({ kind: 'fill', opIndex: 5 }),
      raw({ kind: 'stroke', opIndex: 5, ...STROKE }),
      raw({ kind: 'fill', opIndex: 5 }),
      raw({ kind: 'fill', opIndex: 9 }),
    ];
    const slide = await buildSlide({ index: 2, sizePt: [100, 100], ops }, noPage());
    expect(slide.index).toBe(2);
    expect(slide.elements.map((e) => e.id)).toEqual(['p3:z5', 'p3:z5:1', 'p3:z5:2', 'p3:z9']);
  });

  it('gives the shade or pattern that fills text no element: the run holds it', async () => {
    const shading = { type: 'mesh' as const, ctm: [1, 0, 0, 1, 0, 0] };
    const ops = [
      raw({ kind: 'shade', rgb: null, path: undefined, shading, text: true, approx: true }),
      raw({ kind: 'pattern', rgb: null, path: undefined, text: true, approx: true }),
      raw({ kind: 'fill', opIndex: 3 }),
      raw({ kind: 'shade', opIndex: 4, rgb: null, path: undefined, shading }),
    ];
    const slide = await buildSlide({ index: 0, sizePt: [100, 100], ops }, noPage());
    expect(slide.elements.map((e) => e.id)).toEqual(['p1:z3', 'p1:z4']);
  });

  it('refuses a glyph without the run the walker always gives it', async () => {
    const glyph = { u: 'A', x: 1, y: 2, adv: 5, size: 10, fontId: 'f', font: 'F', paint: 'fill' as const, wmode: 0 as const };
    await expect(buildSlide({ index: 0, sizePt: [100, 100], ops: [raw({ kind: 'glyph', opIndex: 2, glyph })] }, noPage())).rejects.toThrow(
      new Error('RawOp glyph at op 2 has no run'),
    );
  });

  it('carries the clip box, the blend mode, the marked-content id and the groups, outermost first', async () => {
    const taken: SoftMask = { subtype: 'alpha', backdrop: null, ops: [], opList: { fnArray: [], argsArray: [] } };
    const outer: GroupFrame = { alpha: 0.8, blend: 'screen', isolated: false, knockout: false, bbox: null, masked: false, mask: null };
    const inner: GroupFrame = { alpha: 0.5, blend: 'normal', isolated: true, knockout: true, bbox: [10, 5, 130, 85], masked: true, mask: taken };
    const op = raw({ kind: 'fill', clip: [5, 6, 70, 80], blend: 'multiply', mcid: 7, groups: [outer, inner] });
    const slide = await buildSlide({ index: 0, sizePt: [100, 100], ops: [op] }, noPage());
    const [el] = slide.elements;
    // The mask the innermost group took is the element's too (ruling M2-R14).
    expect(el).toMatchObject({ clipBox: [5, 6, 70, 80], blend: 'multiply', provenance: { mcid: 7 }, clip: [], mask: 'm1' });
    // A GroupRef is a GroupFrame with the id of the mask it took, if any, for `masked`.
    expect(el!.groups).toEqual([
      { alpha: 0.8, blend: 'screen', isolated: false, knockout: false, bbox: null, mask: null },
      { alpha: 0.5, blend: 'normal', isolated: true, knockout: true, bbox: [10, 5, 130, 85], mask: 'm1' },
    ]);
    expect(slide.masks).toEqual({ m1: { subtype: 'alpha', backdrop: null, elements: [], clips: {} } });
  });

  it('refuses a mask the walker says is there and did not give', async () => {
    const group: GroupFrame = { alpha: 1, blend: 'normal', isolated: false, knockout: false, bbox: null, masked: true, mask: null };
    for (const op of [raw({ kind: 'fill', masked: true }), raw({ kind: 'fill', groups: [group] })]) {
      await expect(buildSlide({ index: 0, sizePt: [100, 100], ops: [op] }, noPage())).rejects.toThrow(
        new Error('RawOp fill at op 0 has no softMask'),
      );
    }
  });

  it('rounds as M2-R13 says: slide-frame lengths to 3 decimals, unitless values to 6, -0 to 0', async () => {
    const op = raw({
      kind: 'stroke',
      opIndex: 4,
      bbox: [1.23449, -0.0001, 3.00049, 4],
      alpha: 0.12345678,
      path: [['M', 1.23449, -0.0001], ['C', 1, 2, 3, 4, 5.55555, 6], ['L', 3.00049, 4]],
      line: { w: 0.33333333, cap: 1, join: 2, miter: 1.41421356, dash: [1.00049, 2], phase: -0.0004 },
      lineCtm: [0.33333333, 0, 0, -0.33333333, 0, 100],
      clip: [0, 0, 299.99951, 300],
      groups: [{ alpha: 0.4444444444, blend: 'normal', isolated: false, knockout: false, bbox: [10.00049, 0, 20, 30], masked: false, mask: null }],
    });
    const slide = await buildSlide({ index: 0, sizePt: [299.99951, 300.0004], ops: [op] }, noPage());
    const el = shapes(slide.elements)[0]!;
    expect(slide.sizePt).toEqual([300, 300]);
    expect(el.bbox).toEqual([1.234, 0, 3, 4]);
    expect(Object.is(el.bbox[1], 0)).toBe(true);
    expect(el.geom).toEqual([['M', 1.234, 0], ['C', 1, 2, 3, 4, 5.556, 6], ['L', 3, 4]]);
    expect(Object.is(el.geom![0]![2], 0)).toBe(true);
    expect(el.clipBox).toEqual([0, 0, 300, 300]);
    expect(el.line).toEqual({
      w: 0.333,
      cap: 'round',
      join: 'bevel',
      miter: 1.414214,
      dash: [1, 2],
      phase: 0,
      anisotropic: false,
      paint: { kind: 'solid', rgb: [1, 2, 3], alpha: 0.123457 },
    });
    expect(Object.is(el.line!.phase, 0)).toBe(true);
    expect(el.groups).toEqual([{ alpha: 0.444444, blend: 'normal', isolated: false, knockout: false, bbox: [10, 0, 20, 30], mask: null }]);
  });

  it("inventoryOfSlide equals the walker's inventory where groups nest with blend modes of their own", async () => {
    // No synthetic page has a blend mode on both a group and the group inside it: which one wins is the paint's first
    // non-normal one from the paint outward (0002 §17).
    const outer: GroupFrame = { alpha: 0.8, blend: 'screen', isolated: false, knockout: false, bbox: null, masked: false, mask: null };
    const inner: GroupFrame = { alpha: 0.5, blend: 'multiply', isolated: true, knockout: false, bbox: [0, 0, 50, 50], masked: false, mask: null };
    const plain: GroupFrame = { ...inner, blend: 'normal' };
    const ops = [
      raw({ kind: 'fill', opIndex: 1, groups: [outer, inner] }),
      raw({ kind: 'stroke', opIndex: 2, groups: [outer, inner], blend: 'darken', ...STROKE }),
      raw({ kind: 'fill', opIndex: 3, groups: [outer, plain], evenOdd: true }),
      raw({ kind: 'fill', opIndex: 4, groups: [plain, plain] }),
    ];
    const slide = await buildSlide({ index: 0, sizePt: [100, 100], ops }, noPage());
    const actual = inventoryOfSlide(slide);
    expect(actual).toEqual(toInventory([{ index: 0, size: [100, 100], ops }]).pages[0]);
    expect(actual.paints.map((p) => [p.blend, p.groupAlpha])).toEqual([
      ['multiply', 0.4],
      ['darken', 0.4],
      ['screen', 0.4],
      ['normal', 0.25],
    ]);
  });

  it('inventoryOfSlide reads masked from the mask and clipApprox from a text clip', async () => {
    const slide = await buildSlide({ index: 0, sizePt: [100, 100], ops: [raw({ kind: 'fill' })] }, noPage());
    const el = slide.elements[0]!;
    slide.elements.push({ ...el, mask: 'm0' }, { ...el, clip: ['c0', 'c1'] }, { ...el, clip: ['c0'] });
    slide.clips = { c0: { kind: 'box', bbox: [0, 0, 50, 50] }, c1: { kind: 'text', bbox: [0, 0, 40, 40], approx: true } };
    expect(inventoryOfSlide(slide).paints.map((p) => [p.masked, p.clipApprox])).toEqual([
      [false, undefined],
      [true, undefined],
      [false, true],
      [false, undefined],
    ]);
  });

  it('refuses a stroke without the line style or the CTM the walker always gives it', async () => {
    const { line, lineCtm } = STROKE;
    const cases: [RawOp, string][] = [
      [raw({ kind: 'stroke', lineCtm }), 'line'],
      [raw({ kind: 'stroke', line }), 'lineCtm'],
      [raw({ kind: 'stroke', line, lineCtm, path: undefined }), 'path'],
      [raw({ kind: 'stroke', line, lineCtm, rgb: null }), 'rgb'],
      [raw({ kind: 'fill', opIndex: 6, path: undefined }), 'path'],
    ];
    for (const [op, field] of cases) {
      await expect(buildSlide({ index: 0, sizePt: [100, 100], ops: [op] }, noPage())).rejects.toThrow(
        new Error(`RawOp ${op.kind} at op ${op.opIndex} has no ${field}`),
      );
    }
  });
});
