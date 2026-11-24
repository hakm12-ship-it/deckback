import type { OxCmd, OxConnector, OxFill, OxLineStyle, OxNode, OxPath, OxShape } from '@deckback/ooxml';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PathSeg } from '../../src/extract/inventory';
import { lowerSlide, runPasses, type LowerCtx, type PassedShape } from '../../src/passes';
import { newReport, type SlideReport } from '../../src/passes/report';
import type { Element, GroupRef, SceneSlide } from '../../src/scene/types';
import { repoRoot } from '../helpers/fixtures';
import { deckOf, fallback, hotspot, linear, lineStyle, poly, rectPath, shape, slideOf, snapshot, solid, square, textline } from '../helpers/passes';

/**
 * Lowering shapes, links and fallbacks into the writer's model: integer EMU (12700 per pt, half away from zero), frames
 * from the box of every point, path points relative to the frame, and names `pdf:p<page>:z<op> <kind>[ <n>]` (ruling
 * M3-R17).
 */

const PT = 12700;
const CTX: LowerCtx = { page: 1, scale: 1, offset: [0, 0] };

/** Runs the passes and lowers the slide, returning the nodes and the report. */
function lower(elements: Element[], ctx: Partial<LowerCtx> = {}): { nodes: OxNode[]; report: SlideReport } {
  const input = slideOf(elements);
  const deck = deckOf([input]);
  const { slide, report } = runPasses(input, deck);
  const { nodes } = lowerSlide(slide, deck, { ...CTX, ...ctx, report });
  return { nodes, report };
}

const frame = (x: number, y: number, w: number, h: number, flips: { flipH?: boolean; flipV?: boolean } = {}) => ({
  x,
  y,
  w,
  h,
  rot: 0,
  flipH: flips.flipH ?? false,
  flipV: flips.flipV ?? false,
});

const group = (alpha: number): GroupRef => ({ alpha, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null });

/** A case of harness/fidelity/split_vectors.json, which the harness's splits.py runs too. */
interface SplitCase {
  name: string;
  path: PathSeg[];
  fill: 'solid' | 'gradient' | null;
  stroke: { w: number; dash: number[]; alpha: number; paint: 'solid' | 'gradient' } | null;
  groupAlpha: number;
  scale: number;
  pieces: number | null;
}

describe('lower shapes', () => {
  it('a rect is a rect shape at its corners, with its fill and its line', () => {
    const { nodes, report } = lower([shape({ op: 3, line: lineStyle() })]);
    expect(nodes).toEqual([
      {
        kind: 'shape',
        name: 'pdf:p1:z3 rect',
        frame: frame(10 * PT, 20 * PT, 100 * PT, 50 * PT),
        link: null,
        geom: { kind: 'rect' },
        fill: { kind: 'solid', rgb: 'FF0000', alpha: 100000 },
        line: { w: 2 * PT, fill: { kind: 'solid', rgb: '000000', alpha: 100000 }, cap: 'flat', join: 'miter', miterLim: 1000000, dash: null },
      } satisfies OxShape,
    ]);
    expect(report.counts).toEqual({ textBoxes: 0, freeforms: 0, rects: 1, lines: 0, pictures: 0, gradients: 0, hotspots: 0, runLinks: 0, fallbacks: 0 });
  });

  it('a shape with a gradient fill counts as a gradient (ruling M3-R43), besides its kind', () => {
    const { report } = lower([shape({ op: 3, geom: rectPath(0, 0, 100, 50), fill: linear() }), shape({ op: 4 })]);
    expect(report.counts).toMatchObject({ rects: 2, gradients: 1 });
  });

  it('a line is a connector from its start, the flips saying which corner that is', () => {
    const line = lineStyle({ cap: 'round', join: 'round', dash: [6, 3] });
    const { nodes, report } = lower([shape({ op: 4, geom: [['M', 10, 120], ['L', 200, 20]], fill: null, line })]);
    expect(nodes).toEqual([
      {
        kind: 'line',
        name: 'pdf:p1:z4 line',
        frame: frame(10 * PT, 20 * PT, 190 * PT, 100 * PT, { flipV: true }),
        link: null,
        line: { w: 2 * PT, fill: { kind: 'solid', rgb: '000000', alpha: 100000 }, cap: 'rnd', join: 'round', miterLim: 1000000, dash: [400000, 50000] },
      } satisfies OxConnector,
    ]);
    expect(report.counts.lines).toBe(1);
    const corner = (geom: PathSeg[]) => (lower([shape({ geom, fill: null, line: lineStyle() })]).nodes[0]!.frame as { flipH: boolean; flipV: boolean });
    expect(corner([['M', 10, 20], ['L', 200, 120]])).toMatchObject({ flipH: false, flipV: false });
    expect(corner([['M', 200, 20], ['L', 10, 120]])).toMatchObject({ flipH: true, flipV: false });
    expect(corner([['M', 200, 120], ['L', 10, 20]])).toMatchObject({ flipH: true, flipV: true });
  });

  it('a cubic freeform is a custGeom of one path in frame-relative EMU, the frame the extent the path draws', () => {
    // the cubic's handles are at y 0, but it reaches y 5 at most (t 0.5): PowerPoint lays a fill over what the path
    // draws, not over its handles (Task 13 measured it), so the frame is that extent and the handles lie outside it
    const geom: PathSeg[] = [['M', 10, 20], ['C', 50, 0, 150, 0, 200, 20], ['L', 200, 80], ['Z']];
    const { nodes, report } = lower([{ ...shape({ op: 7, geom }), id: 'p1:z7:1' }]);
    expect(nodes).toEqual([
      {
        kind: 'shape',
        name: 'pdf:p1:z7 freeform 1',
        frame: frame(10 * PT, 5 * PT, 190 * PT, 75 * PT),
        link: null,
        geom: {
          kind: 'custom',
          paths: [
            {
              w: 190 * PT,
              h: 75 * PT,
              fill: true,
              stroke: false,
              cmds: [['M', 0, 15 * PT], ['C', 40 * PT, -5 * PT, 140 * PT, -5 * PT, 190 * PT, 15 * PT], ['L', 190 * PT, 75 * PT], ['Z']],
            },
          ],
        },
        fill: { kind: 'solid', rgb: 'FF0000', alpha: 100000 },
        line: null,
      } satisfies OxShape,
    ]);
    expect(report.counts.freeforms).toBe(1);
  });

  it('a gradient on a curved freeform is laid over the extent the path draws, not over its handles', () => {
    // a cubic bowl from (0, 100) to (100, 100) through (50, 175): its handles reach y 200
    const geom: PathSeg[] = [['M', 0, 0], ['L', 100, 0], ['L', 100, 100], ['C', 100, 200, 0, 200, 0, 100], ['Z']];
    const down = linear({ p0: [0, 0], p1: [0, 175] });
    const node = lower([shape({ op: 8, geom, fill: down })]).nodes[0] as OxShape;
    expect(node.frame).toEqual(frame(0, 0, 100 * PT, 175 * PT));
    // over 0..175 the gradient's t runs 0..1 exactly: its two stops at the ends, no cut
    expect(node.fill).toMatchObject({ kind: 'grad', shade: { kind: 'lin', ang: 5400000 } });
    expect((node.fill as Extract<OxShape['fill'], { kind: 'grad' }>).stops.map((st) => st.pos)).toEqual([0, 100000]);
  });

  it('rounds each point to EMU half away from zero, after the scale and the offset', () => {
    // each edge is a position rounded on its own (0.005 pt is 63.5 EMU, 9.995 pt 126936.5): the width is their difference
    const { nodes } = lower([shape({ geom: poly([[-0.005, 0.005], [9.995, 0.005], [9.995, 10.005], [-0.005, 10.005]]) })]);
    expect(nodes[0]!.frame).toEqual(frame(-64, 64, 127001, 127000));
    const scaled = lower([shape({ geom: rectPath(10, 20, 100, 50), line: lineStyle({ w: 3 }) })], { scale: 0.5, offset: [6, 8] });
    expect(scaled.nodes[0]!.frame).toEqual(frame(11 * PT, 18 * PT, 50 * PT, 25 * PT));
    expect((scaled.nodes[0] as OxShape).line!.w).toBe(1.5 * PT);
  });

  /** [fill, stroke, number of commands] of each a:path of the one node of a filled and stroked shape of `geom`. */
  const pathsOf = (geom: PathSeg[]) => {
    const { nodes } = lower([shape({ geom, line: lineStyle() })]);
    expect(nodes).toHaveLength(1);
    const paths = ((nodes[0] as OxShape).geom as { paths: { fill: boolean; stroke: boolean; cmds: unknown[] }[] }).paths;
    return paths.map((p) => [p.fill, p.stroke, p.cmds.length]);
  };

  it('a fill in one a:path fills and strokes it', () => {
    expect(pathsOf([...square(20, 20, 150), ...square(45, 45, 100, 'ccw')])).toEqual([[true, true, 10]]);
  });

  it('a split fill only fills its a:paths, and one stroke-only a:path of every subpath comes last', () => {
    // DrawingML paints each a:path's fill and then its stroke: a second fill-and-stroke a:path would cover the first
    // square's outline inside the second square, which the PDF strokes after the whole fill
    expect(pathsOf([...square(60, 20, 100), ...square(110, 70, 100)])).toEqual([
      [true, false, 5],
      [true, false, 5],
      [false, true, 10],
    ]);
    // the outer square alone fills (M0-5 C); the stroke draws both
    expect(pathsOf([...square(20, 20, 150), ...square(45, 45, 100)])).toEqual([
      [true, false, 5],
      [false, true, 10],
    ]);
  });

  it('subpaths that draw nothing are in no a:path and do not widen the frame', () => {
    const far: PathSeg[] = [['M', 290, 190], ['Z'], ['M', 280, 180]];
    // filled only
    const filled = lower([shape({ geom: [...square(20, 20, 150), ...far] })]).nodes[0] as OxShape;
    expect(filled.frame).toEqual(frame(20 * PT, 20 * PT, 150 * PT, 150 * PT));
    expect(filled.geom).toMatchObject({ kind: 'custom', paths: [{ fill: true, stroke: false, cmds: { length: 5 } }] });
    // filled and stroked, the fill split (the outer square alone fills)
    const both = lower([shape({ geom: [...square(20, 20, 150), ...square(45, 45, 100), ...far], line: lineStyle() })]).nodes[0] as OxShape;
    expect(both.frame).toEqual(frame(20 * PT, 20 * PT, 150 * PT, 150 * PT));
    expect(pathsOf([...square(20, 20, 150), ...square(45, 45, 100), ...far])).toEqual([
      [true, false, 5],
      [false, true, 10],
    ]);
  });

  it('a path of more points than a call takes arguments lowers to one node', () => {
    const geom: PathSeg[] = [['M', 0, 0]];
    for (let i = 1; i <= 200000; i++) geom.push(['L', (i % 300) + 0.5, Math.floor(i / 1000) + 0.25]);
    const { nodes } = lower([shape({ geom, fill: null, line: lineStyle() })]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.frame).toEqual(frame(0, 0, 299.5 * PT, 200.25 * PT));
  });

  it('nonzero-approx goes into the report where the fill is too large to outline (M5 Task 4: else it is outlined)', () => {
    const geom = [...square(60, 20, 100), ...square(110, 70, 100, 'ccw')];
    expect(lower([shape({ op: 2, geom })]).report.approximations).toEqual([]);
    const zigzag: [number, number][] = [];
    for (let i = 0; i < 30000; i++) zigzag.push([i * 0.001, i % 2 === 0 ? 0 : 1]);
    zigzag.push([30, 50]);
    const { report } = lower([shape({ op: 3, geom: [...poly(zigzag), ...square(100, 100, 10, 'ccw')] })]);
    expect(report.approximations).toEqual([{ id: 'p1:z3', kind: 'nonzero-approx' }]);
  });

  it('line styles: miter limit in lim units, dashes in 1000ths of % of the width, caps and joins by name', () => {
    const style = (over: Parameters<typeof lineStyle>[0]) => {
      const { nodes } = lower([shape({ geom: [['M', 0, 10], ['L', 100, 10]], fill: null, line: lineStyle(over) })]);
      return (nodes[0] as OxConnector).line;
    };
    expect(style({ miter: 4, join: 'miter' })).toMatchObject({ miterLim: 400000, join: 'miter' });
    expect(style({ w: 0.5, dash: [1, 0.5, 0.25] })).toMatchObject({ dash: [200000, 100000, 50000] });
    expect(style({ cap: 'square', join: 'bevel' })).toMatchObject({ cap: 'sq', join: 'bevel' });
    expect(style({ cap: 'butt', dash: [] })).toMatchObject({ cap: 'flat', dash: null });
    // a hairline (w 0): dashes against one 96 dpi pixel on the slide, 0.75 pt
    expect(style({ w: 0, dash: [3, 1.5] })).toMatchObject({ w: 0, dash: [400000, 200000] });
    // ... which is 1.5 pt of a page drawn at half size: its dashes, 1.5 and 0.75 pt on the slide, are this share
    const half = lower([shape({ geom: [['M', 0, 10], ['L', 100, 10]], fill: null, line: lineStyle({ w: 0, dash: [3, 1.5] }) })], { scale: 0.5 });
    expect((half.nodes[0] as OxConnector).line).toMatchObject({ w: 0, dash: [200000, 100000] });
  });

  it("dashes with round or square caps: DrawingML's dash takes its caps in, the PDF's does not (atlas/lines/03, lines/12)", () => {
    // PowerPoint exports prstDash dash (4:3) at w 12 with round or square caps as [36 48]: each dash a width shorter,
    // each gap a width longer, as the caps reach half a width past both ends. Back in DrawingML, 4:3 again.
    const style = (over: Parameters<typeof lineStyle>[0]) => {
      const { nodes } = lower([shape({ geom: [['M', 0, 10], ['L', 100, 10]], fill: null, line: lineStyle(over) })]);
      return (nodes[0] as OxConnector).line.dash;
    };
    expect(style({ w: 12, cap: 'round', dash: [36, 48] })).toEqual([400000, 300000]);
    expect(style({ w: 12, cap: 'square', dash: [36, 48] })).toEqual([400000, 300000]);
    expect(style({ w: 12, cap: 'butt', dash: [48, 36] })).toEqual([400000, 300000]);
    // custDash 4:1 1:1 with round caps at w 3 is [9 6 0 6]: the dot of length 0 is a dash of one width
    expect(style({ w: 3, cap: 'round', dash: [9, 6, 0, 6] })).toEqual([400000, 100000, 100000, 100000]);
    // an odd array repeats first, as PDF reads it; a gap under a width is none (the caps meet: the writer writes 1)
    expect(style({ w: 2, cap: 'round', dash: [4, 1, 6] })).toEqual([300000, 0, 400000, 100000, 150000, 200000]);
    // a hairline's caps reach nothing past its ends
    expect(style({ w: 0, cap: 'round', dash: [3, 1.5] })).toEqual([400000, 200000]);
  });

  it('a dashed line with a phase records dash-phase (ruling M3-R20), as DrawingML has no phase', () => {
    const approximations = (over: Parameters<typeof lineStyle>[0]) =>
      lower([shape({ op: 5, geom: rectPath(10, 20, 100, 50), fill: null, line: lineStyle(over) })]).report.approximations;
    expect(approximations({ dash: [3, 2], phase: 1 })).toEqual([{ id: 'p1:z5', kind: 'dash-phase' }]);
    expect(approximations({ dash: [3, 2], phase: 0 })).toEqual([]);
    expect(approximations({ dash: [], phase: 1 })).toEqual([]);
    const line = lower([shape({ op: 6, geom: [['M', 0, 10], ['L', 100, 10]], fill: null, line: lineStyle({ dash: [3, 2], phase: 4 }) })]);
    expect(line.report.approximations).toEqual([{ id: 'p1:z6', kind: 'dash-phase' }]);
  });
});

describe('a chart path split into its pieces (ruling M3-R49)', () => {
  const segments: PathSeg[] = [
    ['M', 10, 20],
    ['L', 200, 20],
    ['M', 200, 60],
    ['L', 10, 60],
    ['M', 50, 150],
    ['L', 50, 100],
  ];

  it('a stroke-only path of single straight segments is one connector per segment, named line k, in path order', () => {
    const line = lineStyle({ w: 0.5, dash: [2, 1] });
    const { nodes, report } = lower([shape({ op: 7, geom: segments, fill: null, line })]);
    const style: OxLineStyle = { w: 0.5 * PT, fill: { kind: 'solid', rgb: '000000', alpha: 100000 }, cap: 'flat', join: 'miter', miterLim: 1000000, dash: [400000, 200000] };
    expect(nodes).toEqual([
      { kind: 'line', name: 'pdf:p1:z7 line 1', frame: frame(10 * PT, 20 * PT, 190 * PT, 0), link: null, line: style },
      { kind: 'line', name: 'pdf:p1:z7 line 2', frame: frame(10 * PT, 60 * PT, 190 * PT, 0, { flipH: true }), link: null, line: style },
      { kind: 'line', name: 'pdf:p1:z7 line 3', frame: frame(50 * PT, 100 * PT, 0, 50 * PT, { flipV: true }), link: null, line: style },
    ] satisfies OxConnector[]);
    expect(report.counts).toMatchObject({ lines: 3, freeforms: 0, rects: 0 });
  });

  it('a segment of a further element of the op keeps its n after the kind, then its k', () => {
    const el = { ...shape({ op: 7, geom: segments.slice(0, 4), fill: null, line: lineStyle() }), id: 'p1:z7:1' };
    expect(lower([el]).nodes.map((n) => n.name)).toEqual(['pdf:p1:z7 line 1 1', 'pdf:p1:z7 line 1 2']);
  });

  it('subpaths that draw nothing are left out; a lone segment stays as it was', () => {
    const { nodes } = lower([shape({ op: 7, geom: [...segments.slice(0, 4), ['M', 280, 180]], fill: null, line: lineStyle() })]);
    expect(nodes.map((n) => [n.kind, n.name])).toEqual([
      ['line', 'pdf:p1:z7 line 1'],
      ['line', 'pdf:p1:z7 line 2'],
    ]);
    // one segment beside a lone M: one custGeom, as before
    expect(lower([shape({ op: 7, geom: [...segments.slice(0, 2), ['M', 280, 180]], fill: null, line: lineStyle() })]).nodes.map((n) => n.kind)).toEqual(['shape']);
  });

  it('is not split: a polyline subpath, a closed segment, a fill, a zero-length subpath or a gradient stroke', () => {
    const kinds = (geom: PathSeg[], over: Partial<Parameters<typeof shape>[0]> = {}) =>
      lower([shape({ op: 7, geom, fill: null, line: lineStyle(), ...over })]).nodes.map((n) => n.kind);
    expect(kinds([...segments.slice(0, 2), ['L', 200, 40], ...segments.slice(2, 4)])).toEqual(['shape']);
    expect(kinds([...segments.slice(0, 2), ['Z'], ...segments.slice(2, 4)])).toEqual(['shape']);
    expect(kinds(segments, { fill: solid() })).toEqual(['shape']);
    expect(kinds([...segments, ['M', 90, 90], ['L', 90, 90]])).toEqual(['shape']);
    expect(kinds(segments, { line: lineStyle({ paint: linear() }) })).toEqual(['shape']);
  });

  it('a filled path of disjoint axis-aligned rectangles is one rect per rectangle, named rect k, with the same style', () => {
    const geom = [...rectPath(10, 100, 20, 80), ...rectPath(40, 60, 20, 120), ...rectPath(70, 140, 20, 40)];
    const line = lineStyle({ w: 1 });
    const { nodes, report } = lower([shape({ op: 9, geom, line })]);
    const fill: OxFill = { kind: 'solid', rgb: 'FF0000', alpha: 100000 };
    const ln: OxLineStyle = { w: PT, fill: { kind: 'solid', rgb: '000000', alpha: 100000 }, cap: 'flat', join: 'miter', miterLim: 1000000, dash: null };
    expect(nodes).toEqual([
      { kind: 'shape', name: 'pdf:p1:z9 rect 1', frame: frame(10 * PT, 100 * PT, 20 * PT, 80 * PT), link: null, geom: { kind: 'rect' }, fill, line: ln },
      { kind: 'shape', name: 'pdf:p1:z9 rect 2', frame: frame(40 * PT, 60 * PT, 20 * PT, 120 * PT), link: null, geom: { kind: 'rect' }, fill, line: ln },
      { kind: 'shape', name: 'pdf:p1:z9 rect 3', frame: frame(70 * PT, 140 * PT, 20 * PT, 40 * PT), link: null, geom: { kind: 'rect' }, fill, line: ln },
    ] satisfies OxShape[]);
    expect(report.counts).toMatchObject({ rects: 3, freeforms: 0, lines: 0 });
    // filled only, rectangles that share an edge do not overlap: each is a rect
    const touching = lower([shape({ op: 9, geom: [...rectPath(10, 10, 20, 20), ...rectPath(30, 10, 20, 20)] })]);
    expect(touching.nodes.map((n) => n.name)).toEqual(['pdf:p1:z9 rect 1', 'pdf:p1:z9 rect 2']);
  });

  it('is not split: overlapping, nested or not rectangles, strokes that would meet, a dashed outline that starts elsewhere, a gradient', () => {
    const kinds = (geom: PathSeg[], over: Partial<Parameters<typeof shape>[0]> = {}) => lower([shape({ op: 9, geom, ...over })]).nodes.map((n) => n.kind);
    expect(kinds([...square(60, 20, 100), ...square(110, 70, 100)])).toEqual(['shape']);
    expect(kinds([...square(20, 20, 150), ...square(45, 45, 100, 'ccw')])).toEqual(['shape']);
    expect(kinds([...square(20, 20, 50), ...poly([[100, 20], [150, 20], [125, 60]])])).toEqual(['shape']);
    // 1 pt apart, a 2 pt line reaches 1 pt past each: the strokes would meet
    expect(kinds([...rectPath(10, 10, 20, 20), ...rectPath(31, 10, 20, 20)], { line: lineStyle({ w: 2 }) })).toEqual(['shape']);
    // a dashed outline the preset would start at its bottom left going up: this one starts at the top left going right
    const fromBottom = poly([[10, 30], [10, 10], [30, 10], [30, 30]]);
    expect(kinds([...fromBottom, ...rectPath(60, 10, 20, 20)], { line: lineStyle({ dash: [2, 1] }) })).toEqual(['shape']);
    expect(kinds([...rectPath(10, 10, 20, 20), ...rectPath(60, 10, 20, 20)], { fill: linear() })).toEqual(['shape']);
    // an open outline is not a closed rectangle for its stroke
    const open: PathSeg[] = [['M', 10, 10], ['L', 30, 10], ['L', 30, 30], ['L', 10, 30], ['L', 10, 10]];
    expect(kinds([...open, ...rectPath(60, 10, 20, 20)], { line: lineStyle() })).toEqual(['shape']);
  });
});

describe('a translucent stroke and the shared split cases (rulings M3-R49, M3-R56)', () => {
  const cross: PathSeg[] = [
    ['M', 10, 50],
    ['L', 200, 50],
    ['M', 100, 10],
    ['L', 100, 150],
  ];

  it('a translucent stroke splits only where no two segments, grown by half the width, meet', () => {
    // the PDF composites a stroke's union once; connectors crossing there would composite it twice
    const kinds = (over: Parameters<typeof lineStyle>[0], groups: GroupRef[] = []) =>
      lower([shape({ op: 7, geom: cross, fill: null, line: lineStyle({ w: 1, ...over }), groups })]).nodes.map((n) => n.kind);
    expect(kinds({})).toEqual(['line', 'line']);
    expect(kinds({ paint: solid([0, 0, 0], 0.5) })).toEqual(['shape']);
    expect(kinds({}, [group(0.5)])).toEqual(['shape']);
    // apart, a translucent one still splits
    const apart: PathSeg[] = [['M', 10, 50], ['L', 200, 50], ['M', 10, 60], ['L', 200, 60]];
    expect(lower([shape({ op: 7, geom: apart, fill: null, line: lineStyle({ paint: solid([0, 0, 0], 0.5) }) })]).nodes.map((n) => n.kind)).toEqual([
      'line',
      'line',
    ]);
  });

  const vectors = (JSON.parse(readFileSync(`${repoRoot}harness/fidelity/split_vectors.json`, 'utf8')) as { cases: SplitCase[] }).cases;
  it.each(vectors.map((c) => [c.name, c] as const))('shared case (harness/fidelity/split_vectors.json): %s', (_, c) => {
    const fill = c.fill === 'solid' ? solid() : c.fill === 'gradient' ? linear() : null;
    const stroke = c.stroke;
    const line =
      stroke === null ? null : lineStyle({ w: stroke.w, dash: stroke.dash, paint: stroke.paint === 'solid' ? solid([0, 0, 0], stroke.alpha) : linear() });
    const groups = c.groupAlpha < 1 ? [group(c.groupAlpha)] : [];
    const { nodes } = lower([shape({ op: 9, geom: c.path, fill, line, groups })], { scale: c.scale });
    if (c.pieces === null) {
      expect(nodes).toHaveLength(1);
    } else {
      expect(nodes.map((n) => n.name)).toEqual(Array.from({ length: c.pieces }, (_, k) => `pdf:p1:z9 ${fill === null ? 'line' : 'rect'} ${k + 1}`));
    }
  });
});

describe('a zero-length stroked subpath (ruling M3-R13 b, ISO 32000-2 §8.5.3.2)', () => {
  const dot = (cap: 'butt' | 'round' | 'square', extra: PathSeg[] = []) =>
    shape({ op: 6, geom: [...extra, ['M', 50, 50], ['L', 50, 50]], fill: null, line: lineStyle({ w: 4, cap, paint: solid([0, 128, 0], 0.5) }) });

  it('a round cap is a filled circle of diameter w in the stroke colour, with no line', () => {
    const { nodes, report } = lower([dot('round')]);
    // the handles of a quarter circle, κ = 4/3 (√2 − 1) of the radius 2 pt from the centre 50 pt, from the frame's 48 pt:
    const c = 39428; // (50 + 2κ) pt = 649028.03 EMU, less 609600
    const k = 11372; // (50 − 2κ) pt = 620971.97 EMU, less 609600
    expect(nodes).toEqual([
      {
        kind: 'shape',
        name: 'pdf:p1:z6 freeform',
        frame: frame(48 * PT, 48 * PT, 4 * PT, 4 * PT),
        link: null,
        geom: {
          kind: 'custom',
          paths: [
            {
              w: 4 * PT,
              h: 4 * PT,
              fill: true,
              stroke: false,
              cmds: [
                ['M', 4 * PT, 2 * PT],
                ['C', 4 * PT, c, c, 4 * PT, 2 * PT, 4 * PT],
                ['C', k, 4 * PT, 0, c, 0, 2 * PT],
                ['C', 0, k, k, 0, 2 * PT, 0],
                ['C', c, 0, 4 * PT, k, 4 * PT, 2 * PT],
                ['Z'],
              ],
            },
          ],
        },
        fill: { kind: 'solid', rgb: '008000', alpha: 50000 },
        line: null,
      } satisfies OxShape,
    ]);
    expect(report.counts.freeforms).toBe(1);
  });

  it('a square or a butt cap draws nothing, as in the PDF: the direction of such a cap is not defined', () => {
    expect(lower([dot('square')]).nodes).toEqual([]);
    expect(lower([dot('butt')]).nodes).toEqual([]);
    // beside other subpaths, only those are drawn
    const { nodes } = lower([dot('square', [['M', 10, 10], ['L', 90, 10]])]);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]!.frame).toEqual(frame(10 * PT, 10 * PT, 80 * PT, 0));
  });

  it('beside other subpaths, the dots are a node of their own right after the stroke', () => {
    const { nodes, report } = lower([dot('round', [['M', 10, 10], ['L', 90, 10]])]);
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z6 freeform', 'pdf:p1:z6 freeform']);
    const stroke = nodes[0] as OxShape;
    expect(stroke.frame).toEqual(frame(10 * PT, 10 * PT, 80 * PT, 0));
    expect(stroke.geom).toEqual({ kind: 'custom', paths: [{ w: 80 * PT, h: 0, fill: false, stroke: true, cmds: [['M', 0, 0], ['L', 80 * PT, 0]] }] });
    expect((nodes[1] as OxShape).fill).toEqual({ kind: 'solid', rgb: '008000', alpha: 50000 });
    expect(report.counts.freeforms).toBe(2);
  });
});

describe('lower links and fallbacks', () => {
  it('a hotspot is an empty rect with its link: a URL as it is, a page as a slide', () => {
    const { nodes, report } = lower([
      hotspot(0, [10, 20, 60, 40], { url: 'https://example.com/a b', dest: null }),
      hotspot(1, [0, 0, 5, 5], { url: null, dest: 'page:3' }),
      hotspot(2, [0, 0, 5, 5], { url: null, dest: null }),
    ]);
    expect(nodes).toEqual([
      {
        kind: 'shape',
        name: 'pdf:p1:a0 link',
        frame: frame(10 * PT, 20 * PT, 50 * PT, 20 * PT),
        link: { kind: 'url', url: 'https://example.com/a b' },
        geom: { kind: 'rect' },
        fill: { kind: 'none' },
        line: null,
      },
      {
        kind: 'shape',
        name: 'pdf:p1:a1 link',
        frame: frame(0, 0, 5 * PT, 5 * PT),
        link: { kind: 'slide', slide: 3 },
        geom: { kind: 'rect' },
        fill: { kind: 'none' },
        line: null,
      },
    ]);
    expect(report.counts.hotspots).toBe(2);
  });

  it('a fallback writes nothing and is counted and listed with its reason', () => {
    const { nodes, report } = lower([fallback('unsupported-op', { op: 9 }), shape({ op: 10 })]);
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z10 rect']);
    expect(report.counts.fallbacks).toBe(1);
    expect(report.fallbacks).toEqual([{ id: 'p1:z9', reason: 'unsupported-op' }]);
  });

  it('nodes keep the Scene order, which is the z-order', () => {
    const { nodes } = lower([
      shape({ op: 1 }),
      shape({ op: 2, geom: [['M', 0, 0], ['L', 9, 9]], fill: null, line: lineStyle() }),
      hotspot(0, [0, 0, 5, 5], { url: 'https://a.example/', dest: null }),
    ]);
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z1 rect', 'pdf:p1:z2 line', 'pdf:p1:a0 link']);
  });
});

describe('what lowering folds or drops', () => {
  it('group alpha is multiplied in, and recorded when the group holds more than one element', () => {
    const one = lower([shape({ op: 1, fill: solid([0, 0, 0], 0.8), groups: [group(0.5)] })]);
    expect((one.nodes[0] as OxShape).fill).toEqual({ kind: 'solid', rgb: '000000', alpha: 40000 });
    expect(one.report.approximations).toEqual([]);
    const two = lower([
      shape({ op: 1, groups: [group(0.5)] }),
      shape({ op: 2, geom: rectPath(0, 0, 5, 5), groups: [group(0.5)] }),
      shape({ op: 3, geom: rectPath(0, 0, 6, 6) }),
    ]);
    expect(two.report.approximations).toEqual([
      { id: 'p1:z1', kind: 'group-alpha-folded' },
      { id: 'p1:z2', kind: 'group-alpha-folded' },
    ]);
  });

  it('a mask and a blend mode are drawn by the raster fallback (M5); on text they are recorded, and an anisotropic line', () => {
    const { nodes, report } = lower([
      shape({ op: 1, mask: 'm1' }),
      shape({ op: 2, geom: rectPath(0, 0, 5, 5), blend: 'multiply' }),
      shape({ op: 3, geom: rectPath(0, 0, 6, 6), line: lineStyle({ anisotropic: true }) }),
      textline({ op: 4, mask: 'm1' }),
      textline({ op: 5, blend: 'multiply' }),
    ]);
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z1 fallback', 'pdf:p1:z2 fallback', 'pdf:p1:z3 rect', 'pdf:p1:z4 text', 'pdf:p1:z5 text']);
    expect(report.fallbacks.map((f) => [f.id, f.reason])).toEqual([
      ['p1:z1', 'soft-mask'],
      ['p1:z2', 'blend-mode'],
    ]);
    expect(report.approximations).toEqual([
      { id: 'p1:z3', kind: 'anisotropic-line' },
      { id: 'p1:z4', kind: 'mask-dropped' },
      { id: 'p1:z5', kind: 'blend-dropped' },
    ]);
  });

  it('lowering leaves the slide as it was, and without a report it only lowers', () => {
    const input: SceneSlide = slideOf([shape({ op: 1, mask: 'm1' })]);
    const before = snapshot(input);
    const { nodes } = lowerSlide(input, deckOf([input]), CTX);
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z1 rect']);
    expect(input).toEqual(before);
    const report = newReport(input);
    lowerSlide(input, deckOf([input]), { ...CTX, report });
    expect(report.approximations).toEqual([{ id: 'p1:z1', kind: 'mask-dropped' }]);
  });
});

describe('the slide background (ruling M3-R52)', () => {
  /** The lowered slide of `elements` (the passes run), with its report. */
  const lowered = (elements: Element[], ctx: Partial<LowerCtx> = {}) => {
    const input = slideOf(elements);
    const deck = deckOf([input]);
    const { slide, report } = runPasses(input, deck);
    return { ...lowerSlide(slide, deck, { ...CTX, ...ctx, report }), report };
  };
  const page = (over: Partial<Parameters<typeof shape>[0]> = {}) => shape({ op: 2, geom: rectPath(0, 0, 300, 200), fill: solid([242, 242, 242]), ...over });

  it('the first element, an unclipped and unstroked opaque solid rect covering the page, is the background, not a node', () => {
    const { nodes, background, report } = lowered([page(), shape({ op: 3 })]);
    expect(background).toEqual({ kind: 'solid', rgb: 'F2F2F2', alpha: 100000 });
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z3 rect']);
    expect(report.counts).toMatchObject({ rects: 1, freeforms: 0 });
    // past the page's edges too (a bleed)
    expect(lowered([page({ geom: rectPath(-10, -10, 320, 220) })]).background).toEqual({ kind: 'solid', rgb: 'F2F2F2', alpha: 100000 });
    // a slide without one has none
    expect(lowered([shape({ op: 3 })]).background).toBeNull();
    expect(lowered([]).background).toBeNull();
  });

  it('stays a shape: stroked, not first, not covering, translucent, in a group of alpha, a gradient; masked or blended, a raster', () => {
    const stays = (elements: Element[], name = 'pdf:p1:z2 rect') => {
      const { nodes, background } = lowered(elements);
      return background === null && nodes.some((n) => n.name === name);
    };
    expect(stays([page({ line: lineStyle() })])).toBe(true);
    expect(stays([shape({ op: 1 }), page()])).toBe(true);
    expect(stays([page({ geom: rectPath(0, 0, 300, 199) })])).toBe(true);
    expect(stays([page({ fill: solid([242, 242, 242], 0.5) })])).toBe(true);
    expect(stays([page({ groups: [group(0.5)] })])).toBe(true);
    // M5: a soft mask or a blend mode is the raster fallback's to draw
    expect(stays([page({ mask: 'm1' })], 'pdf:p1:z2 fallback')).toBe(true);
    expect(stays([page({ blend: 'multiply' })], 'pdf:p1:z2 fallback')).toBe(true);
    const { nodes, background } = lowered([page({ fill: linear() })]);
    expect(background).toBeNull();
    expect((nodes[0] as OxShape).fill.kind).toBe('grad');
  });

  it('a page drawn smaller than its slide (centred, margins left) keeps its rect: it does not cover the slide', () => {
    const slideEmu: [number, number] = [400 * PT, 200 * PT];
    const { nodes, background } = lowered([page()], { offset: [50, 0], slideEmu });
    expect(background).toBeNull();
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z2 rect']);
    // one that fills its slide
    expect(lowered([page()], { slideEmu: [300 * PT, 200 * PT] }).background).not.toBeNull();
  });
});

describe('dash start and fill outlines (M5 Task 4)', () => {
  const paths = (node: OxNode): OxPath[] => ((node as OxShape).geom as { kind: 'custom'; paths: OxPath[] }).paths;

  it('a dashed closed subpath is written open from its start, a line back to it in place of the close (atlas lines/12)', () => {
    // PowerPoint starts a closed path's dashes elsewhere and an open path's at its start, as PDF does (measured: lines/12's
    // rects and rounded rects 95-904 px off the PDF's render as closed paths, 0 as open ones)
    const re = poly([[10, 70], [110, 70], [110, 20], [10, 20]]); // `re`: the bottom left corner, right, then up
    const { nodes } = lower([shape({ op: 5, geom: re, fill: solid(), line: lineStyle({ dash: [3, 2] }) })]);
    expect(nodes).toHaveLength(1);
    expect(paths(nodes[0]!)).toEqual([
      {
        w: 100 * PT,
        h: 50 * PT,
        fill: true,
        stroke: true,
        cmds: [['M', 0, 50 * PT], ['L', 100 * PT, 50 * PT], ['L', 100 * PT, 0], ['L', 0, 0], ['L', 0, 50 * PT]] satisfies OxCmd[],
      },
    ]);
    // already back at its start (an ellipse's last curve, a rounded rect's): only the close goes
    const back: PathSeg[] = [['M', 10, 20], ['C', 40, 0, 80, 0, 110, 20], ['C', 80, 40, 40, 40, 10, 20], ['Z']];
    const cmds = paths(lower([shape({ op: 6, geom: back, fill: null, line: lineStyle({ dash: [3, 2] }) })]).nodes[0]!)[0]!.cmds;
    expect(cmds.map((c) => c[0])).toEqual(['M', 'C', 'C']);
    // a solid outline stays closed (a triangle: a closed rect with a solid line is the preset)
    const triangle = poly([[10, 70], [110, 70], [60, 20]]);
    const solidCmds = paths(lower([shape({ op: 7, geom: triangle, fill: null, line: lineStyle() })]).nodes[0]!)[0]!.cmds;
    expect(solidCmds[solidCmds.length - 1]).toEqual(['Z']);
  });

  it("a fill outline (fillGeom) is the fill's one a:path; a stroke keeps the PDF's path in an a:path of its own", () => {
    // a pentagram, nonzero: its star outline fills, the PDF's crossing path strokes
    const star: [number, number][] = [0, 2, 4, 1, 3].map((k) => {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
      return [Math.round((100 + 80 * Math.cos(a)) * 1000) / 1000, Math.round((100 + 80 * Math.sin(a)) * 1000) / 1000];
    });
    const geom = poly(star);
    const { nodes, report } = lower([shape({ op: 8, geom, fillRule: 'nonzero', line: lineStyle({ dash: [3, 2] }) })]);
    expect(report.approximations).toEqual([]);
    expect(nodes).toHaveLength(1);
    const [fill, stroke] = paths(nodes[0]!);
    expect(fill).toMatchObject({ fill: true, stroke: false });
    expect(fill!.cmds.filter((c) => c[0] === 'L')).toHaveLength(9);
    expect(fill!.cmds[fill!.cmds.length - 1]).toEqual(['Z']);
    expect(stroke).toMatchObject({ fill: false, stroke: true });
    expect(stroke!.cmds.map((c) => c[0])).toEqual(['M', 'L', 'L', 'L', 'L', 'L']); // dashed: open, back to its start
    // filled only: one a:path, a custGeom even where the outline is a rect
    const passed: PassedShape = { ...shape({ op: 9, geom: rectPath(0, 0, 10, 10) }), fillGeom: rectPath(0, 0, 10, 10), shapeKind: 'rect' };
    const input = slideOf([passed]);
    const deck = deckOf([input]);
    const lowered = lowerSlide(input, deck, { ...CTX, report: newReport(input) }).nodes;
    expect(paths(lowered[0]!)).toHaveLength(1);
  });
});
