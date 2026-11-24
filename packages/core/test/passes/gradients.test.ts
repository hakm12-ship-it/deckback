import type { OxConnector, OxFill, OxNode, OxShape } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import { lowerSlide, runPasses, type LowerCtx, type PassedFallback } from '../../src/passes';
import { gradFill, paintsNothing, shadingFallbacks, SHADING_NOTE } from '../../src/passes/gradients';
import { newReport, type SlideReport } from '../../src/passes/report';
import type { Element, FallbackEl, Fill } from '../../src/scene/types';
import { deckOf, linear, lineStyle, PROBE_STOPS, radial, rectPath, shape, slideOf, snapshot } from '../helpers/passes';

/**
 * Gradients as DrawingML's (0001 M0-6, `harness/spikes/m0_6_gradient.py`): a linear one is `a:lin` with `scaled="0"` at
 * the angle of the gradient's bands on the slide, its stops at the projection of the node's frame onto that direction
 * (position 0 at the corner with the least `t`, 100000 at the one with the most), cut at the frame with the colour
 * interpolated at the cut. A radial one is `a:path path="circle"` from its centre. The values are worked out by hand.
 */

const PT = 12700;
const RED = 'FF0000';
const BLUE = '0000FF';
const WHITE = 'FFFFFF';
const BLACK = '000000';

/** `a:gs` stops, opaque unless `alpha` is given. */
const stops = (list: [pos: number, rgb: string][], alpha = 100000) => list.map(([pos, rgb]) => ({ pos, rgb, alpha }));
const lin = (ang: number, list: [number, string][], alpha?: number): OxFill => ({
  kind: 'grad',
  stops: stops(list, alpha),
  shade: { kind: 'lin', ang, scaled: false },
  rotWithShape: true,
});
const circle = (fillToRect: [number, number, number, number], list: [number, string][], tileRect?: [number, number, number, number]): OxFill => ({
  kind: 'grad',
  stops: stops(list),
  shade: tileRect === undefined ? { kind: 'circle', fillToRect } : { kind: 'circle', fillToRect, tileRect },
  rotWithShape: true,
});

/** Red at 0, green at 0.5, blue at 1. */
const RGB_STOPS: Fill & { kind: 'linear' } = linear({
  stops: [
    { t: 0, rgb: [255, 0, 0] },
    { t: 0.5, rgb: [0, 255, 0] },
    { t: 1, rgb: [0, 0, 255] },
  ],
});

describe('linear gradients', () => {
  it('horizontal: angle 0, the stops cut at the frame with the colour interpolated there', () => {
    // along x from 0 to 200 pt; the frame spans x 50 to 150, so t 0.25 to 0.75
    const fill = { ...RGB_STOPS, p1: [200, 0] as [number, number] };
    expect(gradFill(fill, [50, 10, 150, 60], 1)).toEqual({
      fill: lin(0, [
        [0, '808000'], // halfway red to green: 127.5 rounds to 128
        [50000, '00FF00'],
        [100000, '008080'],
      ]),
      approximations: [],
    });
  });

  it("vertical, under the page's flip (the probe's own geometry): angle 90°, down the slide", () => {
    // corpus/generated/probe_std.pdf p2:z54: shading space y up, p0 below the page, p1 at its middle; on the slide the
    // axis runs down from y −30 to 210, and the frame (y 90 to 210) covers t 0.5 to 1
    const fill = linear({
      stops: [
        { t: 0, rgb: [255, 255, 255] },
        { t: 0.5, rgb: [0, 112, 192] },
        { t: 1, rgb: [255, 255, 255] },
      ],
      p0: [170, 570],
      p1: [170, 330],
      matrix: [1, 0, 0, -1, 0, 540],
    });
    expect(gradFill(fill, [40, 90, 300, 210], 1).fill).toEqual(
      lin(5400000, [
        [0, '0070C0'],
        [100000, WHITE],
      ]),
    );
  });

  it('at 30°: the frame projects past the end, which holds its colour', () => {
    // direction (cos 30°, sin 30°), 100 pt long; the frame 0..100 x 0..100 projects to t 0 .. (86.60254 + 50) / 100
    const fill = linear({ p1: [86.60254, 50] });
    expect(gradFill(fill, [0, 0, 100, 100], 1)).toEqual({
      fill: lin(1800000, [
        [0, RED],
        [73205, BLUE], // t 1 at 1 / 1.3660254 of the way
        [100000, BLUE],
      ]),
      approximations: [],
    });
  });

  it('under a skewed matrix: the angle is that of the bands’ normal, not of the mapped axis', () => {
    // x = 2u + v + 10, y = v + 20; the axis runs along u from 0 to 50, so t = u / 50 = (x − y + 10) / 100. The mapped
    // axis (100, 0) points along x, but the bands (t constant) run along x = y: their normal, (1, −1), is at 315°.
    // The frame's corners: (0, 0) t 0.1, (100, 0) 1.1, (0, 100) −0.9, (100, 100) 0.1.
    const fill = linear({ p1: [50, 0], matrix: [2, 0, 1, 1, 10, 20] });
    expect(gradFill(fill, [0, 0, 100, 100], 1)).toEqual({
      fill: lin(18900000, [
        [0, RED],
        [45000, RED], // t 0: 0.9 of the span 2
        [95000, BLUE], // t 1
        [100000, BLUE],
      ]),
      approximations: [],
    });
    // vertical bands from a shear: x = u + v, the axis along v, so t = y / 100 and the angle is 90°, where the mapped
    // axis, (100, 100), would say 45°
    const sheared = linear({ p1: [0, 100], matrix: [1, 0, 1, 1, 0, 0] });
    expect(gradFill(sheared, [0, 0, 200, 100], 1).fill).toEqual(
      lin(5400000, [
        [0, RED],
        [100000, BLUE],
      ]),
    );
  });

  it('extend false on a side the frame reaches past records gradient-extend; within 0.01 pt it does not', () => {
    const at = (extend: [boolean, boolean], frame: [number, number, number, number]) => gradFill(linear({ extend }), frame, 1).approximations;
    expect(at([false, true], [-10, 0, 50, 10])).toEqual(['gradient-extend']);
    expect(at([true, false], [-10, 0, 50, 10])).toEqual([]);
    expect(at([true, false], [50, 0, 110, 10])).toEqual(['gradient-extend']);
    expect(at([false, false], [0, 0, 100, 10])).toEqual([]);
    expect(at([false, false], [-0.005, 0, 100.005, 10])).toEqual([]);
  });

  it('a single stop is its colour all over', () => {
    const fill = linear({ stops: [{ t: 0.3, rgb: [10, 20, 30] }] });
    const grad = gradFill(fill, [0, 0, 100, 10], 1).fill as Extract<OxFill, { kind: 'grad' }>;
    expect(grad.stops.every((s) => s.rgb === '0A141E')).toBe(true);
    expect(grad.stops[0]!.pos).toBe(0);
    expect(grad.stops.at(-1)!.pos).toBe(100000);
  });

  it('alpha, the group alphas multiplied in, goes onto every stop; at 0 nothing is painted', () => {
    const grad = gradFill(RGB_STOPS, [0, 0, 100, 10], 0.8);
    expect(grad.fill).toMatchObject({ kind: 'grad' });
    expect(gradFill({ ...RGB_STOPS, alpha: 0.5 }, [0, 0, 100, 10], 0.8).fill).toEqual(
      lin(
        0,
        [
          [0, RED],
          [50000, '00FF00'],
          [100000, BLUE],
        ],
        40000,
      ),
    );
    expect(gradFill({ ...RGB_STOPS, alpha: 0 }, [0, 0, 100, 10], 1).fill).toEqual({ kind: 'none' });
  });

  it("keeps pdf.js' sampled stops unless the reduction is asked for (writer rule 2)", () => {
    const probe = linear({ stops: PROBE_STOPS, p0: [170, 570], p1: [170, 330], matrix: [1, 0, 0, -1, 0, 540] });
    const kept = gradFill(probe, [40, 90, 300, 210], 1).fill as Extract<OxFill, { kind: 'grad' }>;
    // the 13 samples strictly inside t 0.5..1 and the two cut ends (M0-6: 15 stops in the box)
    expect(kept.stops).toHaveLength(15);
    expect(kept.stops[0]).toEqual({ pos: 0, rgb: '0170C0', alpha: 100000 });
    expect(kept.stops[1]).toEqual({ pos: 238, rgb: '0170C0', alpha: 100000 }); // t 0.50119
    expect(kept.stops.at(-1)).toEqual({ pos: 100000, rgb: WHITE, alpha: 100000 });
    const reduced = gradFill(probe, [40, 90, 300, 210], 1, { reduceStops: true }).fill as Extract<OxFill, { kind: 'grad' }>;
    expect(reduced.stops.length).toBeLessThan(15);
    expect(reduced.stops[0]).toEqual(kept.stops[0]);
    expect(reduced.stops.at(-1)).toEqual(kept.stops.at(-1));
    expect(gradFill(probe, [40, 90, 300, 210], 1, { reduceStops: false })).toEqual(gradFill(probe, [40, 90, 300, 210], 1));
  });

  it('a gradient that paints nothing: an axis of no length, or a matrix that flattens the plane', () => {
    expect(paintsNothing(linear())).toBe(false);
    expect(paintsNothing(linear({ p1: [0, 0] }))).toBe(true);
    expect(paintsNothing(linear({ matrix: [1, 1, 1, 1, 0, 0] }))).toBe(true);
    expect(paintsNothing(radial())).toBe(false);
    expect(paintsNothing(radial({ r1: 0 }))).toBe(true);
    expect(paintsNothing(radial({ r0: 30, r1: 30 }))).toBe(true);
    expect(paintsNothing(radial({ matrix: [0, 0, 0, 0, 0, 0] }))).toBe(true);
  });
});

describe('radial gradients', () => {
  it('r0 0 and concentric: a circle path from the centre, to the farthest corner of the frame', () => {
    // centre (50, 50); the farthest corner is 50√2 away, so t 1 (radius 50) is at 1/√2 of the way
    expect(gradFill(radial(), [0, 0, 100, 100], 1)).toEqual({
      fill: circle(
        [50000, 50000, 50000, 50000],
        [
          [0, WHITE],
          [70711, BLACK],
          [100000, BLACK],
        ],
      ),
      approximations: [],
    });
    // the same through a matrix that scales by 2
    expect(gradFill(radial({ p0: [25, 25], p1: [25, 25], r1: 25, matrix: [2, 0, 0, 2, 0, 0] }), [0, 0, 100, 100], 1).fill).toEqual(
      gradFill(radial(), [0, 0, 100, 100], 1).fill,
    );
  });

  it('concentric with a start circle: t 0 at its radius, inside it the start colour held', () => {
    // radius 20 + 30 t: t 0 at 20 / 50√2 of the way, t 1 at 50 / 50√2
    expect(gradFill(radial({ r0: 20 }), [0, 0, 100, 100], 1)).toEqual({
      fill: circle(
        [50000, 50000, 50000, 50000],
        [
          [0, WHITE],
          [28284, WHITE],
          [70711, BLACK],
          [100000, BLACK],
        ],
      ),
      approximations: [],
    });
    expect(gradFill(radial({ r0: 20, extend: [false, true] }), [0, 0, 100, 100], 1).approximations).toEqual(['gradient-extend']);
  });

  it('a focus off the centre: the same about the smaller circle, with radial-offset', () => {
    // about (40, 50): the farthest corner is √(60² + 50²) = 78.1025 away; t 1 (radius 50) at 0.640184 of the way; the
    // tile rect centred on (40, 50) reaches 20 pt past the left side
    expect(gradFill(radial({ p0: [40, 50] }), [0, 0, 100, 100], 1)).toEqual({
      fill: circle(
        [40000, 50000, 60000, 50000],
        [
          [0, WHITE],
          [64018, BLACK],
          [100000, BLACK],
        ],
        [-20000, 0, 0, 0],
      ),
      approximations: ['radial-offset'],
    });
  });

  it("concentric circles about another point than the box's centre: exact, the tile rect centred on that point (M5 Task 3)", () => {
    // Measured in PowerPoint (M5 Task 3): position 0 at the fillToRect point, a share of the box the gradient is laid over,
    // and 100000 on the circle about the centre of the tile rect (a:tileRect, insets of that box) through its corners. A
    // tile rect centred on the point and just holding the box draws circles about the point, its corner the box's
    // farthest from it: pixel for pixel the render of a box centred there (M3 Task 13's symmetric extent, also measured).
    // About (30, 40): the tile reaches 70 and 60 pt from it, to (-40, -20)-(100, 100); √(70² + 60²) = 92.1954, t 1 at 0.542326
    expect(gradFill(radial({ p0: [30, 40], p1: [30, 40] }), [0, 0, 100, 100], 1)).toEqual({
      fill: circle(
        [30000, 40000, 70000, 60000],
        [
          [0, WHITE],
          [54233, BLACK],
          [100000, BLACK],
        ],
        [-40000, -20000, 0, 0],
      ),
      approximations: [],
    });
    // a centre outside the box (above, to the right): the tile reaches (0, -140)-(300, 100); √(150² + 120²) = 192.094
    expect(gradFill(radial({ p0: [150, -20], p1: [150, -20] }), [0, 0, 100, 100], 1)).toEqual({
      fill: circle(
        [150000, -20000, -50000, 120000],
        [
          [0, WHITE],
          [26029, BLACK],
          [100000, BLACK],
        ],
        [0, -140000, -200000, 0],
      ),
      approximations: [],
    });
    // at the centre: no tile rect, as before
    expect(gradFill(radial(), [0, 0, 100, 100], 1).fill).toMatchObject({ shade: { kind: 'circle', fillToRect: [50000, 50000, 50000, 50000] } });
    expect((gradFill(radial(), [0, 0, 100, 100], 1).fill as Extract<OxFill, { kind: 'grad' }>).shade).not.toHaveProperty('tileRect');
    // a box of no height can centre nothing across it: a centre off its line stays radial-offset, one on it is exact
    expect(gradFill(radial({ p0: [30, 40], p1: [30, 40] }), [0, 50, 100, 50], 1).approximations).toEqual(['radial-offset']);
    expect(gradFill(radial({ p0: [30, 50], p1: [30, 50] }), [0, 50, 100, 50], 1).approximations).toEqual([]);
  });

  it('a centre so far off that its insets would overflow ST_Percentage is radial-offset, never clamped silently', () => {
    // 1e5 box sizes away: the shares are 1e10 (100000ths of the box), past int32
    expect(gradFill(radial({ p0: [1e7, 50], p1: [1e7, 50] }), [0, 0, 100, 100], 1).approximations).toEqual(['radial-offset']);
    // 1e4 sizes away still fits (1e9, and -2e9 for the tile rect's far side): exact
    expect(gradFill(radial({ p0: [1e6, 50], p1: [1e6, 50] }), [0, 0, 100, 100], 1).approximations).toEqual([]);
    // a tiny box, the same overflow from the other side
    expect(gradFill(radial({ p0: [1e3, 50], p1: [1e3, 50] }), [0, 0, 1e-6, 100], 1).approximations).toEqual(['radial-offset']);
  });

  it('a matrix that does not keep angles makes the circles ellipses, which a circle path only approximates: radial-offset', () => {
    // a frame centred on the circles' centre, so that only the matrix is in question
    const at = (matrix: number[]) => {
      const [cx, cy] = [matrix[0]! * 50 + matrix[2]! * 50 + matrix[4]!, matrix[1]! * 50 + matrix[3]! * 50 + matrix[5]!];
      return gradFill(radial({ matrix }), [cx - 100, cy - 100, cx + 100, cy + 100], 1).approximations;
    };
    expect(at([2, 0, 0, 2, 0, 0])).toEqual([]); // one scale
    expect(at([0.6, 0.8, -0.8, 0.6, 50, 0])).toEqual([]); // a turn
    expect(at([1, 0, 0, -1, 0, 100])).toEqual([]); // a mirror
    expect(at([1.2, 0, 0, 0.6, 0, 0])).toEqual(['radial-offset']); // unequal scales: an ellipse
    expect(at([1, 0, 0.5, 1, 0, 0])).toEqual(['radial-offset']); // a skew
  });

  it('circles of one radius moving along an axis: the axis as a linear gradient, with radial-offset', () => {
    const grad = gradFill(radial({ p0: [0, 50], r0: 10, p1: [100, 50], r1: 10 }), [0, 0, 100, 100], 1);
    expect(grad.fill).toEqual(
      lin(0, [
        [0, WHITE],
        [100000, BLACK],
      ]),
    );
    expect(grad.approximations).toEqual(['radial-offset']);
  });

  it('extend false at the end, past which the frame reaches: gradient-extend', () => {
    expect(gradFill(radial({ extend: [true, false] }), [0, 0, 100, 100], 1).approximations).toEqual(['gradient-extend']);
    expect(gradFill(radial({ extend: [true, false] }), [20, 20, 80, 80], 1).approximations).toEqual([]);
  });
});

describe('lowering a gradient', () => {
  const CTX: LowerCtx = { page: 1, scale: 1, offset: [0, 0] };
  function lower(elements: Element[], ctx: Partial<LowerCtx> = {}): { nodes: OxNode[]; report: SlideReport } {
    const input = slideOf(elements);
    const deck = deckOf([input]);
    const { slide, report } = runPasses(input, deck);
    return { nodes: lowerSlide(slide, deck, { ...CTX, ...ctx, report }).nodes, report };
  }
  const horizontal = lin(0, [
    [0, '808000'],
    [50000, '00FF00'],
    [100000, '008080'],
  ]);

  it('a gradient fill lowers to a gradFill laid over the frame the node is written at', () => {
    const fill = { ...RGB_STOPS, p1: [200, 0] as [number, number] };
    const { nodes, report } = lower([shape({ op: 3, geom: rectPath(50, 10, 100, 50), fill })]);
    expect(nodes).toEqual([
      {
        kind: 'shape',
        name: 'pdf:p1:z3 rect',
        frame: { x: 50 * PT, y: 10 * PT, w: 100 * PT, h: 50 * PT, rot: 0, flipH: false, flipV: false },
        link: null,
        geom: { kind: 'rect' },
        fill: horizontal,
        line: null,
      } satisfies OxShape,
    ]);
    expect(report.counts.rects).toBe(1);
    // the page scaled and moved on the slide: the gradient moves with it
    const placed = lower([shape({ op: 3, geom: rectPath(50, 10, 100, 50), fill })], { scale: 0.5, offset: [30, 7] });
    expect((placed.nodes[0] as OxShape).fill).toEqual(horizontal);
  });

  it('a gradient line lowers to a line whose fill is the gradient over its frame', () => {
    const { nodes } = lower([shape({ op: 4, geom: [['M', 0, 10], ['L', 100, 10]], fill: null, line: lineStyle({ paint: linear() }) })]);
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as OxConnector).line.fill).toEqual(
      lin(0, [
        [0, RED],
        [100000, BLUE],
      ]),
    );
  });

  it('a connector drawn flipped gets its gradient mirrored, so that it comes out as the PDF has it', () => {
    // runs left (flipH): DrawingML flips the node and its line's fill; given at 180°, red at position 0 lands on the left
    const left = lower([shape({ op: 4, geom: [['M', 100, 10], ['L', 0, 10]], fill: null, line: lineStyle({ paint: linear() }) })]);
    expect(left.nodes[0]).toMatchObject({ kind: 'line', frame: { flipH: true, flipV: false } });
    expect((left.nodes[0] as OxConnector).line.fill).toEqual(
      lin(10800000, [
        [0, RED],
        [100000, BLUE],
      ]),
    );
    // runs up and left (flipH and flipV): a gradient at 30° is given at 210°
    const both = lower([shape({ op: 5, geom: [['M', 100, 100], ['L', 0, 0]], fill: null, line: lineStyle({ paint: linear({ p1: [86.60254, 50] }) }) })]);
    expect(both.nodes[0]).toMatchObject({ frame: { flipH: true, flipV: true } });
    expect((both.nodes[0] as OxConnector).line.fill).toMatchObject({ shade: { kind: 'lin', ang: 12600000 } });
    // runs up (flipV): a radial centre at the top left of its frame is given at the bottom left
    const up = lower([shape({ op: 6, geom: [['M', 0, 100], ['L', 100, 0]], fill: null, line: lineStyle({ paint: radial({ p0: [0, 0], p1: [0, 0] }) }) })]);
    // and its tile rect, centred on that corner, mirrored with it
    expect((up.nodes[0] as OxConnector).line.fill).toMatchObject({ shade: { kind: 'circle', fillToRect: [0, 100000, 100000, 0], tileRect: [-100000, 0, 0, -100000] } });
  });

  it('a connector drawn flipH alone: its radial fillToRect and tile rect are mirrored across (task 3 review, test gap)', () => {
    // runs left and down (flipH only): a centre at the top left of the frame is given at the top right
    const left = lower([shape({ op: 7, geom: [['M', 100, 0], ['L', 0, 100]], fill: null, line: lineStyle({ paint: radial({ p0: [0, 0], p1: [0, 0] }) }) })]);
    expect(left.nodes[0]).toMatchObject({ kind: 'line', frame: { flipH: true, flipV: false } });
    expect((left.nodes[0] as OxConnector).line.fill).toMatchObject({ shade: { kind: 'circle', fillToRect: [100000, 0, 0, 100000], tileRect: [0, -100000, -100000, 0] } });
  });

  it("records the gradient's approximations under the element's id", () => {
    const { report } = lower([
      shape({ op: 5, geom: rectPath(-10, 0, 60, 10), fill: linear({ extend: [false, true] }) }),
      shape({ op: 6, geom: rectPath(0, 0, 100, 100), fill: radial({ p0: [40, 50] }) }),
    ]);
    expect(report.approximations).toEqual([
      { id: 'p1:z5', kind: 'gradient-extend' },
      { id: 'p1:z6', kind: 'radial-offset' },
    ]);
  });

  it('a gradient that paints nothing writes nothing', () => {
    expect(lower([shape({ op: 7, fill: linear({ p1: [0, 0] }) })]).nodes).toEqual([]);
  });

  it('an sh lowered without the passes is a rect at its box, its gradient over it', () => {
    const fill = { ...RGB_STOPS, p1: [200, 0] as [number, number] };
    const input = slideOf([shape({ op: 8, geom: null, fill, bbox: [50, 10, 150, 60] })]);
    const { nodes } = lowerSlide(input, deckOf([input]), CTX);
    expect(nodes).toMatchObject([{ name: 'pdf:p1:z8 rect', geom: { kind: 'rect' }, fill: horizontal }]);
  });
});

describe('function-based and mesh shadings (M2 final review F9)', () => {
  it('a function shading becomes a fallback with a fixed note', () => {
    const sh = shape({ op: 7, geom: null, fill: { kind: 'shading', shading: 'function', alpha: 1, mesh: null }, bbox: [10, 20, 110, 70], clip: ['c1'] });
    const input = slideOf([sh], {
      clips: { c1: { kind: 'path', geom: rectPath(10, 20, 100, 50), rule: 'nonzero', bbox: [10, 20, 110, 70] } },
      notes: [{ opIndex: 2, op: 'paintImageXObject', detail: 'image pdf.js gave no pixels' }],
    });
    const before = snapshot(input);
    const deck = deckOf([input]);
    const { slide, report } = runPasses(input, deck);
    expect(input).toEqual(before);
    expect(slide.elements).toEqual([
      {
        id: 'p1:z7',
        provenance: sh.provenance,
        clip: ['c1'], // the raster fallback (M5) is drawn in its clips
        clipBox: sh.clipBox,
        groups: [],
        mask: null,
        blend: 'normal',
        kind: 'fallback',
        reason: 'shading-function',
        coveredOps: [7],
        raster: null,
        bbox: [10, 20, 110, 70],
        of: sh, // M5: what the raster renderer draws (this one has no triangles, so it stays unwritten)
      } satisfies PassedFallback,
    ]);
    const note = { opIndex: 7, op: 'shadingFill', detail: 'shading needs a raster fallback' };
    expect(SHADING_NOTE).toBe('shading needs a raster fallback');
    // fix round 1: why the raster renderer drew nothing of it
    const undrawn = { opIndex: 7, op: 'raster', detail: 'shading without triangles in a raster' };
    expect(slide.notes).toEqual([...input.notes, note, undrawn]);
    expect(report.notes).toEqual([...input.notes, note, undrawn]);
    const { nodes } = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
    expect(nodes).toEqual([]);
    expect(report.counts.fallbacks).toBe(1);
    expect(report.fallbacks).toEqual([{ id: 'p1:z7', reason: 'shading-function' }]);
  });

  it('a mesh: in a pattern fill of a path the note names its paint op, and a stroke is one too', () => {
    const mesh: Fill = { kind: 'shading', shading: 'mesh', alpha: 1, mesh: null };
    const report = newReport(slideOf([]));
    const out = shadingFallbacks(
      slideOf([
        shape({ op: 3, fill: mesh }),
        shape({ op: 4, fill: mesh, fillRule: 'evenodd' }),
        shape({ op: 5, fill: null, line: lineStyle({ w: 4, paint: mesh }) }),
        shape({ op: 6 }),
      ]),
      report,
    );
    expect(out.elements.map((el) => [el.id, el.kind, el.kind === 'fallback' ? el.reason : null])).toEqual([
      ['p1:z3', 'fallback', 'shading-mesh'],
      ['p1:z4', 'fallback', 'shading-mesh'],
      ['p1:z5', 'fallback', 'shading-mesh'],
      ['p1:z6', 'shape', null],
    ]);
    // a stroke's box reaches half its width past its path
    expect((out.elements[2] as FallbackEl).bbox).toEqual([8, 18, 112, 72]);
    expect(out.notes).toEqual([
      { opIndex: 3, op: 'fill', detail: SHADING_NOTE },
      { opIndex: 4, op: 'eoFill', detail: SHADING_NOTE },
      { opIndex: 5, op: 'stroke', detail: SHADING_NOTE },
    ]);
    expect(report.notes).toEqual(out.notes);
  });
});
