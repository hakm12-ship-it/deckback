import type { OxFill, OxNode, OxShape } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import type { PathSeg } from '../../src/extract/inventory';
import { lowerSlide, runPasses, type PassedFallback } from '../../src/passes';
import { fallbackOf } from '../../src/passes/fallbacks';
import { gradFill, stopAlphas } from '../../src/passes/gradients';
import type { SlideReport } from '../../src/passes/report';
import { rasterize } from '../../src/raster/raster';
import type { Element, GroupRef, MaskDef, SceneSlide, ShapeEl } from '../../src/scene/types';
import { circle, deckOf, linear, poly, radial, rectPath, shape, slideOf, snapshot, solid } from '../helpers/passes';
import { decodePng } from '../helpers/png';

/**
 * Transparent stops (M5 Task 3, fills/06): PowerPoint exports a gradient whose stops have alpha as a gradient shape under
 * a luminosity soft mask that is one gradient shape. Where the mask's gradient is the fill's (or the fill is one colour),
 * the mask is per-stop alpha in `a:gs`, over the union of both stop lists, each value sampled exactly; anything else is a
 * raster fallback with its reason (Review Focus 4), never a mask silently dropped.
 */

const BLUE: [number, number, number] = [0, 112, 192];
const grey = (v: number): [number, number, number] => [v, v, v];
type Grad = Extract<OxFill, { kind: 'grad' }>;

/** The (pos, RRGGBB, alpha) of a written gradient's stops. */
const gs = (fill: OxFill) => (fill as Grad).stops.map((s) => [s.pos, s.rgb, s.alpha]);

/** A luminosity mask of one rect shape at `box` filled with `fill`, in a box clip of its own at the same place. */
function lumMask(fill: ShapeEl['fill'], box: [number, number, number, number] = [10, 20, 110, 70], over: Partial<MaskDef> = {}, el: Partial<ShapeEl> = {}): MaskDef {
  const [x0, y0, x1, y1] = box;
  return {
    subtype: 'luminosity',
    backdrop: [0, 0, 0],
    elements: [shape({ op: 90, geom: rectPath(x0, y0, x1 - x0, y1 - y0), fill, clip: ['c1'], ...el })],
    clips: { c1: { kind: 'box', bbox: box } },
    ...over,
  };
}

/** The gradient's axis along the rect (10, 20)-(110, 70): t 0 at its left side, 1 at its right. */
const AXIS = { p0: [10, 0] as [number, number], p1: [110, 0] as [number, number] };

function lower(elements: Element[], masks: Record<string, MaskDef>): { slide: SceneSlide; nodes: OxNode[]; report: SlideReport } {
  const input = slideOf(elements, { masks });
  const deck = deckOf([input]);
  const { slide, report } = runPasses(input, deck);
  return { slide, nodes: lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report }).nodes, report };
}

describe('gradFill with alpha stops', () => {
  // red at 0, green at 0.5, blue at 1, along x from 0 to 100
  const RGB = linear({ stops: [{ t: 0, rgb: [255, 0, 0] }, { t: 0.5, rgb: [0, 255, 0] }, { t: 1, rgb: [0, 0, 255] }] });

  it('merges them with the colour stops over the union of their positions, each value sampled exactly (Review Focus 4)', () => {
    // alpha 1 at 0, 0 at 0.25, 1 at 1: the colour at 0.25 is half red, half green; the alpha at 0.5 is a third
    const alphas = [{ t: 0, alpha: 1 }, { t: 0.25, alpha: 0 }, { t: 1, alpha: 1 }];
    expect(gs(gradFill(RGB, [0, 0, 100, 10], 1, { alphas }).fill)).toEqual([
      [0, 'FF0000', 100000],
      [25000, '808000', 0],
      [50000, '00FF00', 33333],
      [100000, '0000FF', 100000],
    ]);
    // the fill's alpha and the group alphas multiply every stop's
    expect(gs(gradFill({ ...RGB, alpha: 0.5 }, [0, 0, 100, 10], 0.8, { alphas }).fill).map((s) => s[2])).toEqual([40000, 0, 13333, 40000]);
  });

  it('a hard stop in either list is two stops at one position, left then right; one in both pairs them', () => {
    const red2blue = linear({ stops: [{ t: 0, rgb: [255, 0, 0] }, { t: 0.5, rgb: [255, 0, 0] }, { t: 0.5, rgb: [0, 0, 255] }, { t: 1, rgb: [0, 0, 255] }] });
    const alphas = [{ t: 0, alpha: 1 }, { t: 0.5, alpha: 1 }, { t: 0.5, alpha: 0.2 }, { t: 0.75, alpha: 0.6 }, { t: 0.75, alpha: 0.1 }, { t: 1, alpha: 0.1 }];
    expect(gs(gradFill(red2blue, [0, 0, 100, 10], 1, { alphas }).fill)).toEqual([
      [0, 'FF0000', 100000],
      [50000, 'FF0000', 100000],
      [50000, '0000FF', 20000],
      [75000, '0000FF', 60000],
      [75000, '0000FF', 10000],
      [100000, '0000FF', 10000],
    ]);
  });

  it('cut at the frame, colour and alpha alike are sampled at the cut', () => {
    const alphas = [{ t: 0, alpha: 1 }, { t: 0.25, alpha: 0 }, { t: 1, alpha: 1 }];
    // t 0.25 to 0.75 over the frame: the alpha stop at 0.25 is the cut itself
    expect(gs(gradFill(RGB, [25, 0, 75, 10], 1, { alphas }).fill)).toEqual([
      [0, '808000', 0],
      [50000, '00FF00', 33333],
      [100000, '008080', 66667],
    ]);
  });

  it('a radial gradient whose circles shrink: the positions run the other way, and so do the hard stops', () => {
    // r 50 at t 0 down to 0 at t 1: position 0 (the centre) is t 1
    const fill = radial({ r0: 50, r1: 0 });
    const alphas = [{ t: 0, alpha: 0 }, { t: 0.5, alpha: 0 }, { t: 0.5, alpha: 1 }, { t: 1, alpha: 1 }];
    const stops = gs(gradFill(fill, [0, 0, 100, 100], 1, { alphas }).fill);
    expect(stops.slice(0, 3)).toEqual([
      [0, '000000', 100000],
      [35355, '808080', 100000],
      [35355, '808080', 0],
    ]);
  });

  it("without alpha stops it is the gradient it was: the same stops, pdf.js' own", () => {
    expect(gradFill(RGB, [0, 0, 100, 10], 1, { alphas: [] })).toEqual(gradFill(RGB, [0, 0, 100, 10], 1));
  });
});

describe('gradient-alpha-mix: colour and alpha both change within one stop interval (ruling M5-R8)', () => {
  const FRAME: [number, number, number, number] = [0, 0, 100, 10];
  const GREEN = linear({ stops: [{ t: 0, rgb: [255, 0, 0] }, { t: 1, rgb: [0, 255, 0] }] });
  const FLAT = linear({ stops: [{ t: 0, rgb: [255, 0, 0] }, { t: 1, rgb: [255, 0, 0] }] });

  it('red to green while alpha falls 1 to 0: recorded once, the two stops written as they are (not densified)', () => {
    const alphas = [{ t: 0, alpha: 1 }, { t: 1, alpha: 0 }];
    const grad = gradFill(GREEN, FRAME, 1, { alphas });
    expect(grad.approximations).toEqual(['gradient-alpha-mix']);
    expect(gs(grad.fill)).toEqual([[0, 'FF0000', 100000], [100000, '00FF00', 0]]);
  });

  it('one record for each such interval; an interval where only one of the two changes is exact and is not recorded', () => {
    // colour red, green, green, blue; alpha 1, 0, 0, 1: the first and last intervals change both, the middle neither
    const RGGB = linear({ stops: [{ t: 0, rgb: [255, 0, 0] }, { t: 0.25, rgb: [0, 255, 0] }, { t: 0.75, rgb: [0, 255, 0] }, { t: 1, rgb: [0, 0, 255] }] });
    const alphas = [{ t: 0, alpha: 1 }, { t: 0.25, alpha: 0 }, { t: 0.75, alpha: 0 }, { t: 1, alpha: 1 }];
    expect(gradFill(RGGB, FRAME, 1, { alphas }).approximations).toEqual(['gradient-alpha-mix', 'gradient-alpha-mix']);
    // alpha only (one colour), colour only (one alpha), and a hard stop (no width) are exact
    expect(gradFill(FLAT, FRAME, 1, { alphas: [{ t: 0, alpha: 1 }, { t: 1, alpha: 0 }] }).approximations).toEqual([]);
    expect(gradFill(GREEN, FRAME, 1, { alphas: [{ t: 0, alpha: 0.5 }, { t: 1, alpha: 0.5 }] }).approximations).toEqual([]);
    expect(gradFill(GREEN, FRAME, 1).approximations).toEqual([]);
    const hard = linear({ stops: [{ t: 0, rgb: [255, 0, 0] }, { t: 0.5, rgb: [255, 0, 0] }, { t: 0.5, rgb: [0, 255, 0] }, { t: 1, rgb: [0, 255, 0] }] });
    const steps = [{ t: 0, alpha: 1 }, { t: 0.5, alpha: 1 }, { t: 0.5, alpha: 0 }, { t: 1, alpha: 0 }];
    expect(gradFill(hard, FRAME, 1, { alphas: steps }).approximations).toEqual([]);
  });
});

describe('a luminosity gradient mask becomes stop alpha (fills/06)', () => {
  // opaque to clear: the mask white at the left, mid grey in the middle, black at the right
  const MASK_STOPS = [{ t: 0, rgb: grey(255) }, { t: 0.5, rgb: grey(128) }, { t: 1, rgb: grey(0) }];

  it('a gradient fill under a mask of its geometry: per-stop alpha, the mask gone, no mask-dropped and no fallback', () => {
    const fill = linear({ ...AXIS, stops: [{ t: 0, rgb: BLUE }, { t: 1, rgb: BLUE }] });
    const masked = shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill, mask: 'm1' });
    const { slide, nodes, report } = lower([masked], { m1: lumMask(linear({ ...AXIS, stops: MASK_STOPS })) });
    expect(slide.elements).toHaveLength(1);
    expect(slide.elements[0]).toMatchObject({ kind: 'shape', mask: null });
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as OxShape).fill).toEqual({
      kind: 'grad',
      stops: [
        { pos: 0, rgb: '0070C0', alpha: 100000 },
        { pos: 50000, rgb: '0070C0', alpha: 50196 },
        { pos: 100000, rgb: '0070C0', alpha: 0 },
      ],
      shade: { kind: 'lin', ang: 0, scaled: false },
      rotWithShape: true,
    });
    expect(report.approximations).toEqual([]);
    expect(report.fallbacks).toEqual([]);
    expect(report.counts).toMatchObject({ gradients: 1, fallbacks: 0 });
  });

  it("Review Focus 4: mask stops that do not line up with the colour stops are merged over the union of positions", () => {
    const fill = linear({ ...AXIS, stops: [{ t: 0, rgb: [255, 0, 0] }, { t: 0.5, rgb: [0, 255, 0] }, { t: 1, rgb: [0, 0, 255] }] });
    const mask = lumMask(linear({ ...AXIS, stops: [{ t: 0, rgb: grey(255) }, { t: 0.3, rgb: grey(51) }, { t: 1, rgb: grey(255) }] }));
    const { nodes, report } = lower([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill, mask: 'm1' })], { m1: mask });
    // 0.3: 60 % of the way from red to green; 0.5: alpha from 0.2 at 0.3 to 1 at 1, 2/7 of the way
    expect(gs((nodes[0] as OxShape).fill)).toEqual([
      [0, 'FF0000', 100000],
      [30000, '669900', 20000],
      [50000, '00FF00', 42857],
      [100000, '0000FF', 100000],
    ]);
    // colour and alpha both change in each interval: exact at the stops, PowerPoint's mix between (M5-R8); recorded once per element
    expect(report.approximations).toEqual([{ id: 'p1:z5', kind: 'gradient-alpha-mix' }]);
  });

  it('a solid fill under a gradient mask: a gradient of its colour along the mask, with the mask as alpha', () => {
    const { nodes, report } = lower([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: solid(BLUE, 0.5), mask: 'm1' })], {
      m1: lumMask(linear({ ...AXIS, stops: MASK_STOPS })),
    });
    expect(gs((nodes[0] as OxShape).fill)).toEqual([
      [0, '0070C0', 50000],
      [50000, '0070C0', 25098],
      [100000, '0070C0', 0],
    ]);
    expect(report.approximations).toEqual([]);
  });

  it('a radial fill under a radial mask of its geometry (radial clear edge): alpha stops on the circle path', () => {
    // concentric about the box's centre (60, 45), out to its corner at t 1
    const geometry = { p0: [60, 45] as [number, number], p1: [60, 45] as [number, number], r1: Math.sqrt(50 * 50 + 25 * 25) };
    const fill = radial({ ...geometry, stops: [{ t: 0, rgb: [255, 192, 0] }, { t: 1, rgb: [255, 192, 0] }] });
    const mask = lumMask(radial({ ...geometry, stops: [{ t: 0, rgb: grey(255) }, { t: 0.6, rgb: grey(153) }, { t: 1, rgb: grey(0) }] }));
    const { nodes, report } = lower([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill, mask: 'm1' })], { m1: mask });
    expect((nodes[0] as OxShape).fill).toMatchObject({ shade: { kind: 'circle', fillToRect: [50000, 50000, 50000, 50000] } });
    expect(gs((nodes[0] as OxShape).fill)).toEqual([
      [0, 'FFC000', 100000],
      [60000, 'FFC000', 60000],
      [100000, 'FFC000', 0],
    ]);
    expect(report.approximations).toEqual([]);
  });

  it("the mask's own alpha over its backdrop, and a colour's luminosity by the raster renderer's weights (MuPDF's)", () => {
    // half-transparent black over a white backdrop: luminosity half white everywhere
    const veiled = lumMask(linear({ ...AXIS, alpha: 0.5, stops: [{ t: 0, rgb: grey(0) }, { t: 1, rgb: grey(0) }] }), undefined, { backdrop: [255, 255, 255] });
    const a = lower([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: solid(BLUE), mask: 'm1' })], { m1: veiled });
    expect(gs((a.nodes[0] as OxShape).fill).map((s) => s[2])).toEqual([50000, 50000]);
    // pure red is 77 / 256 of white
    const red = lumMask(linear({ ...AXIS, stops: [{ t: 0, rgb: [255, 0, 0] }, { t: 1, rgb: [255, 0, 0] }] }));
    const b = lower([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: solid(BLUE), mask: 'm1' })], { m1: red });
    expect(gs((b.nodes[0] as OxShape).fill).map((s) => s[2])).toEqual([30078, 30078]);
  });

  it('the pass leaves its input as it was, and an element that needs none as it is', () => {
    const input = slideOf([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: solid(BLUE), mask: 'm1' }), shape({ op: 6 })], {
      masks: { m1: lumMask(linear({ ...AXIS, stops: MASK_STOPS })) },
    });
    const before = snapshot(input);
    const out = stopAlphas(input);
    expect(input).toEqual(before);
    expect(out.elements[1]).toBe(input.elements[1]);
    expect(out.elements[0]).toMatchObject({ mask: null, alphaStops: [{ t: 0, alpha: 1 }, { t: 0.5, alpha: 128 / 255 }, { t: 1, alpha: 0 }] });
  });
});

describe('Review Focus 4: a mask that is not exactly stop alpha is a fallback with its reason, never silently lost', () => {
  const MASK = (over: Partial<Parameters<typeof linear>[0]> = {}) => linear({ ...AXIS, stops: [{ t: 0, rgb: grey(255) }, { t: 1, rgb: grey(0) }], ...over });
  const FILL = linear({ ...AXIS, stops: [{ t: 0, rgb: BLUE }, { t: 1, rgb: BLUE }] });
  const groupWith = (mask: string | null): GroupRef => ({ alpha: 1, blend: 'normal', isolated: false, knockout: false, bbox: null, mask });

  /** The one element left in the place of the masked one, and what the report says. */
  function outcome(elements: Element[], mask: MaskDef, at = 0) {
    const { slide, report } = lower(elements, { m1: mask });
    return { el: slide.elements[at] as PassedFallback, report };
  }

  const cases: [string, Element[], MaskDef][] = [
    ["the mask's gradient on another axis", [shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: FILL, mask: 'm1' })], lumMask(MASK({ p1: [60, 0] }))],
    ['a mask shape that does not cover the shape', [shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: FILL, mask: 'm1' })], lumMask(MASK(), [10, 20, 60, 70])],
    ['a mask clip that cuts the shape', [shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: FILL, mask: 'm1' })], { ...lumMask(MASK()), clips: { c1: { kind: 'box', bbox: [10, 20, 60, 70] } } }],
    ['a mask shape of another outline', [shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: FILL, mask: 'm1' })], lumMask(MASK(), undefined, {}, { geom: circle(60, 45, 80) })],
    [
      "a mask gradient that does not extend where the shape reaches past it",
      [shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: solid(BLUE), mask: 'm1' })],
      lumMask(MASK({ p1: [90, 0], extend: [true, false] })),
    ],
    [
      "a group's mask over a group that holds another shape",
      [shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: FILL, mask: 'm1', groups: [groupWith('m1')] }), shape({ op: 6, mask: 'm1', groups: [groupWith('m1')] })],
      lumMask(MASK()),
    ],
  ];

  it.each(cases)('%s: soft-mask, drawn as a raster and listed', (_name, elements, mask) => {
    const { el, report } = outcome(elements, mask);
    expect(el).toMatchObject({ kind: 'fallback', reason: 'soft-mask', id: 'p1:z5' });
    expect(el.picture).toBeDefined();
    expect(report.fallbacks[0]).toMatchObject({ id: 'p1:z5', reason: 'soft-mask' });
    expect(report.approximations.filter((a) => a.kind === 'mask-dropped')).toEqual([]);
  });

  it('the same shapes with a mask that lines up are stop alpha (the control)', () => {
    const { el } = outcome([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: FILL, mask: 'm1' })], lumMask(MASK()));
    expect(el.kind).toBe('shape');
    // the group's mask over a group of this shape alone
    const alone = outcome([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: FILL, mask: 'm1', groups: [groupWith('m1')] }), shape({ op: 6 })], lumMask(MASK()));
    expect(alone.el).toMatchObject({ kind: 'shape', mask: null, groups: [{ mask: null }] });
  });
});

describe('final review I2: stop alpha drawn by the raster renderer (its alpha follows the mask, never opaque)', () => {
  /** White at the rect's left side to black at its right: alpha 1 to 0 along it. */
  const fade = () => lumMask(linear({ ...AXIS, stops: [{ t: 0, rgb: grey(255) }, { t: 1, rgb: grey(0) }] }));
  /** The alpha of the raster's pixels along the row at y (pt) from x0 to x1 (pt), one a pixel. */
  const alphas = (png: Uint8Array, box: [number, number, number, number], y: number, x0: number, x1: number): number[] => {
    const img = decodePng(png);
    const j = Math.floor((y - box[1]) * 2);
    const out: number[] = [];
    for (let i = Math.floor((x0 - box[0]) * 2); i < Math.floor((x1 - box[0]) * 2); i++) out.push(img.data[(j * img.width + i) * 4 + 3]!);
    return out;
  };
  /** The raster of `el` drawn as the Scene has it: its soft mask itself, as the PDF draws it. */
  const withMask = (elements: Element[], index: number, masks: Record<string, MaskDef>, clips: SceneSlide['clips'] = {}): Uint8Array => {
    const fb = fallbackOf(elements[index] as ShapeEl, 'blend-mode');
    const all = elements.slice();
    all[index] = fb;
    return rasterize(fb, { slide: slideOf(all, { masks, clips }), index })!.png;
  };

  it('a shape that also blends: the fallback stands for it with its stop alpha, which the raster follows as the mask would', () => {
    const el = shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: solid(BLUE), mask: 'm1', blend: 'multiply' });
    const input = slideOf([el], { masks: { m1: fade() } });
    const { slide, media } = runPasses(input, deckOf([input]));
    const fb = slide.elements[0] as PassedFallback;
    expect(fb).toMatchObject({ kind: 'fallback', reason: 'blend-mode', of: { mask: null, alphaStops: [{ t: 0, alpha: 1 }, { t: 1, alpha: 0 }] } });
    const got = alphas(media.get(fb.picture!.mediaHash)!, fb.picture!.box, 45, 10, 110);
    expect(got[0]).toBeGreaterThan(252);
    expect(got[got.length - 1]).toBeLessThan(3);
    expect(Math.abs(got[100]! - 128)).toBeLessThanOrEqual(2);
    // within one level of the raster of the shape under its soft mask itself
    const ref = alphas(withMask([el], 0, { m1: fade() }), fb.picture!.box, 45, 10, 110);
    got.forEach((a, i) => expect(Math.abs(a - ref[i]!), `pixel ${i}`).toBeLessThanOrEqual(1));
  });

  it('a stop-alpha shape below a raster: its backdrop has the alpha too (past the alpha 0 end the page shows)', () => {
    const el = shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: solid(BLUE), mask: 'm1' });
    const over = shape({ op: 6, geom: rectPath(10, 20, 100, 50), fill: solid([255, 204, 51]), blend: 'multiply' });
    const input = slideOf([el, over], { masks: { m1: fade() } });
    const { slide, media } = runPasses(input, deckOf([input]));
    expect(slide.elements[0]).toMatchObject({ kind: 'shape', mask: null, alphaStops: [{ t: 0, alpha: 1 }, { t: 1, alpha: 0 }] });
    const fb = slide.elements[1] as PassedFallback;
    const png = decodePng(media.get(fb.picture!.mediaHash)!);
    // at the right end the stop-alpha shape is all but clear: Multiply over the white page, the source colour
    const p = ((45 - 20) * 2 * png.width + 199) * 4;
    expect(Array.from(png.data.subarray(p, p + 3)).map((v, c) => Math.abs(v - [255, 204, 51][c]!) <= 2)).toEqual([true, true, true]);
    // and as against the shape under its soft mask, as the PDF has it, within a level or two a channel
    const ref = decodePng(withMask([el, over], 1, { m1: fade() }));
    for (const i of [0, 50, 100, 150, 199]) {
      const q = ((45 - 20) * 2 * png.width + i) * 4;
      for (let c = 0; c < 4; c++) expect(Math.abs(png.data[q + c]! - ref.data[q + c]!), `pixel ${i} channel ${c}`).toBeLessThanOrEqual(2);
    }
  });

  it('a stop-alpha shape too large to cut by its clip (a clip-cut fallback): its raster has the alpha too', () => {
    const zigzag: [number, number][] = [];
    for (let i = 0; i < 25000; i++) zigzag.push([10 + i * 0.004, i % 2 === 0 ? 20 : 21]);
    zigzag.push([110, 70], [10, 70]);
    const tri: PathSeg[] = [['M', 10, 70], ['L', 110, 70], ['L', 60, 20], ['Z']];
    const clips = { c2: { kind: 'path' as const, geom: tri, rule: 'nonzero' as const, bbox: [10, 20, 110, 70] as [number, number, number, number] } };
    const el = shape({ op: 5, geom: poly(zigzag), fill: solid(BLUE), mask: 'm1', clip: ['c2'] });
    const input = slideOf([el], { masks: { m1: fade() }, clips });
    const { slide, media } = runPasses(input, deckOf([input]));
    const fb = slide.elements[0] as PassedFallback;
    expect(fb).toMatchObject({ kind: 'fallback', reason: 'clip-cut', of: { mask: null, alphaStops: [{ t: 0, alpha: 1 }, { t: 1, alpha: 0 }] } });
    // along y 65 pt, inside the triangle from x 15 to 105: clear towards the right as the mask is
    const got = alphas(media.get(fb.picture!.mediaHash)!, fb.picture!.box, 65, 16, 104);
    // alpha 1 - t: about 239 at x 16.25 pt, 16 at x 103.75 pt
    expect(got[0]).toBeGreaterThan(230);
    expect(got[got.length - 1]).toBeLessThan(25);
    for (let i = 1; i < got.length; i++) expect(got[i]).toBeLessThanOrEqual(got[i - 1]!);
  });
});
