import type { OxNode, OxShape } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import type { Box, PathSeg } from '../../src/extract/inventory';
import { lowerSlide, runPasses, type PassedShape } from '../../src/passes';
import { CLIP_BUDGET_NOTE, resolveClips } from '../../src/passes/clip';
import type { SlideReport } from '../../src/passes/report';
import type { ClipDef, Element, FallbackEl, Note, SceneSlide, ShapeEl } from '../../src/scene/types';
import { circle, deckOf, linear, lineStyle, outlineArea, pathBox, picture, poly, rectPath, shape, slideOf, snapshot, solid, textline } from '../helpers/passes';

/**
 * The clip pass: DrawingML has no clip, so each clip is dropped where it cuts nothing, folded into the geometry where
 * that is exact, and else dropped and recorded (`clip-dropped`, `clip-approx`).
 */

const PAGE_CLIP: ClipDef = { kind: 'path', geom: rectPath(0, 0, 300, 200), rule: 'evenodd', bbox: [0, 0, 300, 200] };
const pathClip = (geom: PathSeg[], rule: 'nonzero' | 'evenodd' = 'nonzero'): ClipDef => ({ kind: 'path', geom, rule, bbox: pathBox(geom) });
const boxClip = (bbox: Box): ClipDef => ({ kind: 'box', bbox });
const TRIANGLE = poly([
  [50, 150],
  [250, 150],
  [150, 30],
]);

function pass(elements: Element[], clips: Record<string, ClipDef>): SceneSlide {
  return resolveClips(slideOf(elements, { clips }));
}

function lower(elements: Element[], clips: Record<string, ClipDef>): { nodes: OxNode[]; report: SlideReport } {
  const input = slideOf(elements, { clips });
  const deck = deckOf([input]);
  const { slide, report } = runPasses(input, deck);
  return { nodes: lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report }).nodes, report };
}

const passed = (slide: SceneSlide, i = 0): PassedShape => slide.elements[i] as PassedShape;


describe('the clip pass', () => {
  it('a clip whose box contains the painted box is dropped; for a stroke, half the line width counts', () => {
    const clips = { c1: PAGE_CLIP, c2: pathClip(rectPath(10, 20, 100, 50)) };
    const out = pass(
      [
        shape({ op: 1, clip: ['c1', 'c2'] }), // the rect itself: its clip cuts nothing
        shape({ op: 2, fill: null, line: lineStyle({ w: 2 }), clip: ['c1', 'c2'] }), // its outer half is cut
      ],
      clips,
    );
    expect(passed(out, 0)).toMatchObject({ clip: [], geom: rectPath(10, 20, 100, 50) });
    expect(passed(out, 0).approximations).toBeUndefined();
    expect(passed(out, 1)).toMatchObject({ clip: ['c2'], geom: rectPath(10, 20, 100, 50), approximations: ['clip-dropped'] });
  });

  it('an sh takes the geometry and rule of its innermost path clip, the page clip that holds it dropped', () => {
    const sh = shape({ op: 3, geom: null, fill: linear(), clip: ['c1', 'c2'], bbox: pathBox(TRIANGLE) });
    const out = pass([sh], { c1: PAGE_CLIP, c2: pathClip(TRIANGLE, 'evenodd') });
    expect(passed(out)).toMatchObject({ geom: TRIANGLE, fillRule: 'evenodd', bbox: [50, 30, 250, 150], clip: [] });
    expect(passed(out).approximations).toBeUndefined();
  });

  it('an sh in clips that do not contain each other takes the innermost and records clip-approx', () => {
    const other = poly([
      [40, 40],
      [200, 40],
      [200, 160],
    ]);
    const sh = shape({ op: 4, geom: null, fill: linear(), clip: ['c1', 'c2', 'c3'], bbox: [50, 40, 200, 150] });
    const out = pass([sh], { c1: PAGE_CLIP, c2: pathClip(other), c3: pathClip(TRIANGLE) });
    expect(passed(out)).toMatchObject({ geom: TRIANGLE, clip: ['c2'], approximations: ['clip-approx'] });
    // a rect clip that cuts the path is not exact either
    const cut = pass([{ ...sh, clip: ['c2', 'c3'], bbox: [50, 30, 150, 150] }], { c2: boxClip([0, 0, 150, 200]), c3: pathClip(TRIANGLE) });
    expect(passed(cut)).toMatchObject({ geom: TRIANGLE, clip: ['c2'], approximations: ['clip-approx'] });
  });

  it('an sh in box clips only paints their intersection, a rect: exact', () => {
    const sh = shape({ op: 5, geom: null, fill: linear(), clip: ['c1', 'c2'], bbox: [50, 50, 100, 100] });
    const out = pass([sh], { c1: boxClip([0, 0, 100, 100]), c2: boxClip([50, 50, 200, 200]) });
    expect(passed(out)).toMatchObject({ geom: rectPath(50, 50, 50, 50), bbox: [50, 50, 100, 100], clip: [] });
    expect(passed(out).approximations).toBeUndefined();
    // an sh in no clip paints its box, the page
    const bare = pass([shape({ op: 6, geom: null, fill: linear() })], {});
    expect(passed(bare)).toMatchObject({ geom: rectPath(0, 0, 300, 200), clip: [] });
  });

  it('an axis-aligned filled rect in box clips becomes the intersection rect; one they leave nothing of is dropped', () => {
    const out = pass(
      [
        shape({ op: 7, clip: ['c1'] }),
        shape({ op: 8, geom: rectPath(200, 150, 50, 30), clip: ['c2'] }),
        shape({ op: 9, clip: ['c3'] }),
      ],
      { c1: boxClip([50, 0, 300, 200]), c2: pathClip(rectPath(0, 0, 220, 160)), c3: boxClip([200, 0, 300, 10]) },
    );
    expect(out.elements).toHaveLength(2);
    expect(passed(out, 0)).toMatchObject({ id: 'p1:z7', geom: rectPath(50, 20, 60, 50), bbox: [50, 20, 110, 70], clip: [] });
    expect(passed(out, 1)).toMatchObject({ id: 'p1:z8', geom: rectPath(200, 150, 20, 10), bbox: [200, 150, 220, 160], clip: [] });
    expect(out.elements.every((el) => (el as PassedShape).approximations === undefined)).toBe(true);
  });

  it('a stroke in a clip that cuts it keeps its geometry and records clip-dropped; a fill is cut to the intersection (M5 Task 4)', () => {
    const round = circle(100, 100, 50);
    const out = pass(
      [
        shape({ op: 10, geom: round, clip: ['c1'] }), // a circle cut by a box
        shape({ op: 11, line: lineStyle(), clip: ['c1'] }), // a stroked rect: its stroke would run along the cut
        shape({ op: 12, geom: rectPath(100, 60, 100, 50), clip: ['c2'] }), // a rect in a triangle
      ],
      { c1: boxClip([0, 0, 100, 200]), c2: pathClip(TRIANGLE) },
    );
    // the left half of the circle, its curves within 0.05 pt, filled even-odd
    expect(passed(out, 0)).toMatchObject({ fillRule: 'evenodd', clip: [], approximations: ['clip-approx'] });
    expect(outlineArea(passed(out, 0).geom!)).toBeCloseTo((Math.PI * 50 * 50) / 2, -1);
    expect(passed(out, 0).bbox.map((v) => Math.round(v))).toEqual([50, 50, 100, 150]);
    expect(passed(out, 1)).toMatchObject({ geom: rectPath(10, 20, 100, 50), clip: ['c1'], approximations: ['clip-dropped'] });
    // the rect with its top corners cut off by the triangle's sides: polygons only, exact (no curve was flattened)
    expect(passed(out, 2)).toMatchObject({ fillRule: 'evenodd', clip: [], bbox: [100, 60, 200, 110] });
    expect(passed(out, 2).approximations).toBeUndefined();
    expect(outlineArea(passed(out, 2).geom!)).toBeCloseTo(100 * 50 - 2 * ((25 * 30) / 2), 6);
  });

  it('rule 1: a clip that cuts nothing of a fill is dropped with no approximation, whatever its shape (M5 Task 4)', () => {
    const inside = rectPath(140, 110, 20, 20);
    const out = pass([shape({ op: 40, geom: inside, clip: ['c1'] })], { c1: pathClip(TRIANGLE) });
    expect(passed(out)).toMatchObject({ geom: inside, clip: [] });
    expect(passed(out).approximations).toBeUndefined();
    // a stroke: when its painted box lies in the clip
    const stroked = pass([shape({ op: 41, geom: inside, fill: null, line: lineStyle({ w: 2 }), clip: ['c1'] })], { c1: pathClip(TRIANGLE) });
    expect(passed(stroked)).toMatchObject({ clip: [] });
    expect(passed(stroked).approximations).toBeUndefined();
    // a fill whose clip cuts only what lies past the page: nothing that shows
    const off = pass([shape({ op: 42, geom: rectPath(-40, 20, 60, 40), clip: ['c1'] })], { c1: pathClip(poly([[0, 0], [300, 0], [0, 200]])) });
    expect(passed(off)).toMatchObject({ geom: rectPath(-40, 20, 60, 40), clip: [] });
    expect(passed(off).approximations).toBeUndefined();
  });

  it('a fill with a line in a clip that cuts it: the fill cut (fillGeom), the stroke kept, clip-dropped where it crosses (I3, M5-R9)', () => {
    const round = circle(150, 100, 60);
    const out = pass([shape({ op: 44, geom: round, line: lineStyle({ w: 2 }), clip: ['c1'] })], { c1: pathClip(TRIANGLE) });
    const el = passed(out);
    expect(el.geom).toEqual(round); // the stroke's path
    expect(el.fillGeom).toBeDefined();
    expect(outlineArea(el.fillGeom!)).toBeLessThan(Math.PI * 60 * 60 - 1000);
    expect(el).toMatchObject({ clip: ['c1'], approximations: ['clip-dropped', 'clip-approx'] });
    // a fill whose side runs along the clip's slanted side, from a point inside it: the clip cuts nothing of it
    const along = poly([[100.6, 90.45], [150, 150], [150, 90.45]]);
    const alongOut = pass([shape({ op: 47, geom: along, clip: ['c1'] })], { c1: pathClip(poly([[50.3, 150.7], [250.1, 150.7], [150.9, 30.2]])) });
    expect(passed(alongOut)).toMatchObject({ geom: along, clip: [] });
    expect(passed(alongOut).approximations).toBeUndefined();
    // a polygon whose fill the clip cuts, whose stroke it does too: exact fill, the stroke recorded
    const box = pass([shape({ op: 45, geom: rectPath(100, 60, 100, 50), line: lineStyle({ w: 2 }), clip: ['c1'] })], { c1: pathClip(TRIANGLE) });
    expect(passed(box)).toMatchObject({ clip: ['c1'], approximations: ['clip-dropped'] });
    expect(outlineArea(passed(box).fillGeom!)).toBeCloseTo(100 * 50 - 2 * ((25 * 30) / 2), 6);
    // a clip that cuts neither: dropped, nothing recorded
    const inside = pass([shape({ op: 46, geom: rectPath(140, 110, 20, 20), line: lineStyle({ w: 2 }), clip: ['c1'] })], { c1: pathClip(TRIANGLE) });
    expect(passed(inside)).toMatchObject({ clip: [] });
    expect(passed(inside).fillGeom).toBeUndefined();
    expect(passed(inside).approximations).toBeUndefined();
  });

  it('a slide stays bounded: 5,000 shapes under one large clip, the clip read once, then a budget (fix round 1, I1)', () => {
    // a 15,000-point polygon clip (a fine circle) and 5,000 small rects across its edge
    const ring: [number, number][] = Array.from({ length: 15_000 }, (_, i) => {
      const a = (i * 2 * Math.PI) / 15_000;
      return [Math.round((150 + 90 * Math.cos(a)) * 1000) / 1000, Math.round((100 + 90 * Math.sin(a)) * 1000) / 1000];
    });
    const els = Array.from({ length: 5000 }, (_, i) => {
      const a = (i * 2 * Math.PI) / 5000;
      return shape({ op: 1000 + i, geom: rectPath(150 + 90 * Math.cos(a) - 1, 100 + 90 * Math.sin(a) - 1, 2, 2), clip: ['c1'] });
    });
    const input = slideOf(els, { clips: { c1: pathClip(poly(ring)) } });
    const t0 = performance.now();
    const out = resolveClips(input);
    expect(performance.now() - t0).toBeLessThan(10_000);
    // the first are cut; past the budget the rest keep their path and record clip-dropped, the slide noted once
    expect(passed(out, 0).fillRule).toBe('evenodd');
    expect(passed(out, 4999)).toMatchObject({ clip: ['c1'], approximations: ['clip-dropped'] });
    expect(out.notes.filter((n) => n.detail === CLIP_BUDGET_NOTE)).toHaveLength(1);
  });

  it('a fill too large to outline in its clip is a clip-cut fallback, drawn by the raster renderer (M5 Task 4)', () => {
    const zigzag: [number, number][] = [];
    for (let i = 0; i < 25000; i++) zigzag.push([60 + i * 0.004, i % 2 === 0 ? 60 : 61]);
    zigzag.push([160, 140], [60, 140]);
    const el = shape({ op: 43, geom: poly(zigzag), clip: ['c1'] });
    const out = pass([el], { c1: pathClip(TRIANGLE) });
    expect(out.elements[0]).toMatchObject({ kind: 'fallback', reason: 'clip-cut', clip: ['c1'] });
    // what stands for it: the shape in its clips, `clip-dropped` should the raster not be drawn
    expect((out.elements[0] as unknown as { of: PassedShape }).of).toMatchObject({ geom: el.geom, clip: ['c1'], approximations: ['clip-dropped'], clipCut: true });
  });

  it('the painted box is the curve’s own, not that of its control points', () => {
    // atlas-smoke p11:z123 (a 960 x 540 page), a heart: its control points reach x 975.12, but its curves only x 892
    const heart: PathSeg[] = [
      ['M', 822, 91.5],
      ['C', 853.25, 36.67, 975.12, 91.5, 822, 162],
      ['C', 668.87, 91.5, 790.75, 36.67, 822, 91.5],
      ['Z'],
    ];
    const onPage = (clip: ClipDef) =>
      resolveClips(slideOf([shape({ op: 13, geom: heart, fill: null, line: lineStyle({ w: 1 }), clip: ['c1'] })], { clips: { c1: clip }, sizePt: [960, 540] }));
    // a clip at x 900, on the page: past the handles, short of the curve and its half width
    const out = onPage(boxClip([0, 0, 900, 540]));
    expect(passed(out)).toMatchObject({ geom: heart, clip: [] });
    expect(passed(out).approximations).toBeUndefined();
    // a clip that cuts the curve itself still counts
    expect(passed(onPage(boxClip([0, 0, 880, 540])))).toMatchObject({ clip: ['c1'], approximations: ['clip-dropped'] });
  });

  it('a path clip that is no rect is not taken to hold what is in its box', () => {
    // the rect lies in the triangle's box, but not in the triangle: cut to it, exactly (no curve)
    const out = pass([shape({ op: 13, geom: rectPath(60, 40, 180, 100), clip: ['c1'] })], { c1: pathClip(TRIANGLE) });
    expect(passed(out)).toMatchObject({ clip: [], fillRule: 'evenodd' });
    expect(passed(out).approximations).toBeUndefined();
  });

  it('text clips are dropped and recorded the same way, also where their box holds the element', () => {
    const text: ClipDef = { kind: 'text', bbox: [0, 0, 300, 200], approx: true };
    // a path shape in a text clip and a path clip: both dropped, its geometry kept
    const out = pass([shape({ op: 14, clip: ['c1'] }), shape({ op: 15, geom: rectPath(60, 40, 180, 100), clip: ['c1', 'c2'] })], {
      c1: text,
      c2: pathClip(TRIANGLE),
    });
    expect(passed(out, 0)).toMatchObject({ clip: ['c1'], approximations: ['clip-dropped'] });
    // the triangle cuts the fill (M5 Task 4); the text clip is still dropped and recorded
    expect(passed(out, 1)).toMatchObject({ fillRule: 'evenodd', clip: ['c1'], approximations: ['clip-dropped'] });
  });

  it('an sh in a text clip is left as it is: it is a fallback (M3-R27), not the geometry of its path clip', () => {
    const text: ClipDef = { kind: 'text', bbox: [0, 0, 300, 200], approx: true };
    const sh = shape({ op: 15, geom: null, fill: linear(), clip: ['c1', 'c2'], bbox: [50, 30, 250, 150] });
    expect(pass([sh], { c1: text, c2: pathClip(TRIANGLE) }).elements[0]).toEqual(sh);
  });

  it('what lies past the page does not count against a clip: nothing past the slide shows (M3-R28)', () => {
    // a rect from x −5: the page clip holds all of it that is on the page
    const out = pass([shape({ op: 26, geom: rectPath(-5, 20, 100, 50), clip: ['c1'] })], { c1: PAGE_CLIP });
    expect(passed(out)).toMatchObject({ geom: rectPath(-5, 20, 100, 50), clip: [] });
    expect(passed(out).approximations).toBeUndefined();
    // a text line reaching past the left edge loses the page clip too
    const line = textline({ op: 27, clip: ['c1'], bboxPt: [-3, 30, 32, 43] });
    expect(pass([line], { c1: PAGE_CLIP }).elements[0]).toEqual({ ...line, clip: [] });
    // an sh in a path clip that runs off the page: the page clip around it cuts nothing that shows
    const offPage = poly([
      [-20, 150],
      [120, 150],
      [50, 30],
    ]);
    const sh = shape({ op: 28, geom: null, fill: linear(), clip: ['c1', 'c2'], bbox: [0, 30, 120, 150] });
    const out2 = pass([sh], { c1: PAGE_CLIP, c2: pathClip(offPage) });
    expect(passed(out2)).toMatchObject({ geom: offPage, clip: [] });
    expect(passed(out2).approximations).toBeUndefined();
  });

  it('M8 round 1a: a shape or text line wholly past the page loses every clip, a text one too: none of it shows', () => {
    const text: ClipDef = { kind: 'text', bbox: [0, 0, 300, 200], approx: true };
    const clips = { c1: PAGE_CLIP, c2: pathClip(TRIANGLE), c3: text };
    const out = pass([shape({ op: 30, geom: rectPath(20, -80, 60, 40), clip: ['c1', 'c2', 'c3'] })], clips);
    expect(passed(out)).toMatchObject({ geom: rectPath(20, -80, 60, 40), clip: [] });
    expect(passed(out).approximations).toBeUndefined();
    const line = textline({ op: 31, clip: ['c1', 'c2', 'c3'], bboxPt: [20, 230, 32, 243] });
    expect(pass([line], clips).elements[0]).toEqual({ ...line, clip: [] });
  });

  it('pictures are left for Task 7; a text line only loses the clips that hold it', () => {
    const pic = picture([10, 10, 60, 60], { op: 16, clip: ['c2'] });
    const line = textline({ op: 17, clip: ['c1', 'c2'] });
    const out = pass([pic, line], { c1: PAGE_CLIP, c2: boxClip([0, 0, 25, 200]) });
    expect(out.elements[0]).toEqual(pic);
    expect(out.elements[1]).toEqual({ ...line, clip: ['c2'] });
  });

  it('a shape painted with a function or mesh shading keeps its clips, for its fallback', () => {
    const sh = shape({ op: 18, geom: null, fill: { kind: 'shading', shading: 'mesh', alpha: 1, mesh: null }, clip: ['c1'], bbox: [50, 30, 250, 150] });
    expect(pass([sh], { c1: pathClip(TRIANGLE) }).elements[0]).toEqual(sh);
  });

  it('leaves its input as it was', () => {
    const input = slideOf([shape({ op: 19, clip: ['c1'] }), shape({ op: 20, geom: null, fill: linear(), clip: ['c2'] })], {
      clips: { c1: boxClip([50, 0, 300, 200]), c2: pathClip(TRIANGLE) },
    });
    const before = snapshot(input);
    resolveClips(input);
    expect(input).toEqual(before);
  });
});

describe('clips through the passes and lowering', () => {
  it('an sh in a path clip, then the stroke of that path: one custGeom node with its gradFill and its line (M3-R29)', () => {
    // The first merge (M3-R28) runs while the sh has no path; the second, after the clip pass gave it its clip's path,
    // merges it with the outline: one gradient shape with an outline, as PowerPoint exports one.
    const fill = linear({ p0: [0, 30], p1: [0, 150] });
    const { nodes, report } = lower(
      [
        shape({ op: 21, geom: null, fill, clip: ['c1', 'c2'], bbox: [50, 30, 250, 150] }),
        shape({ op: 22, geom: TRIANGLE, fill: null, line: lineStyle(), clip: ['c1'] }),
      ],
      { c1: PAGE_CLIP, c2: pathClip(TRIANGLE) },
    );
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z21 freeform']);
    const node = nodes[0] as OxShape;
    expect(node).toMatchObject({ kind: 'shape', geom: { kind: 'custom' }, fill: { kind: 'grad' }, line: { w: 2 * 12700 } });
    expect(node.fill).toMatchObject({ shade: { kind: 'lin', ang: 5400000, scaled: false } });
    expect(report.counts).toMatchObject({ freeforms: 1, rects: 0 });
    expect(report.approximations).toEqual([]);
  });

  it('a gradient-filled path in a clip of its own, then its outline outside it: one node (atlas-smoke p9, M3-R29)', () => {
    // atlas-smoke p9:z289 and p9:z294: PowerPoint fills the shape with a shading pattern inside `q <its path> W n ... Q`
    // and strokes its outline after the Q. The clip chains differ, so the first merge leaves them; the clip pass drops
    // the clip that holds the fill, and the second merge makes them one.
    const fill = linear({ p0: [0, 30], p1: [0, 150] });
    const { nodes, report } = lower(
      [
        shape({ op: 32, geom: TRIANGLE, fill, clip: ['c1', 'c2'] }),
        shape({ op: 33, geom: TRIANGLE, fill: null, line: lineStyle(), clip: ['c1'] }),
      ],
      { c1: PAGE_CLIP, c2: pathClip(rectPath(50, 30, 200, 120)) },
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: 'pdf:p1:z32 freeform', geom: { kind: 'custom' }, fill: { kind: 'grad' }, line: { w: 2 * 12700 } });
    expect(report.approximations).toEqual([]);
  });

  it('an sh in the page clip and a text clip is a text-clip-shading fallback with a fixed note, and no rect (M3-R27)', () => {
    const text: ClipDef = { kind: 'text', bbox: [40, 60, 200, 90], approx: true };
    const sh = shape({ op: 29, geom: null, fill: linear(), clip: ['c1', 'c2'], bbox: [40, 60, 200, 90] });
    const input = slideOf([sh], { clips: { c1: PAGE_CLIP, c2: text } });
    const deck = deckOf([input]);
    const { slide, report } = runPasses(input, deck);
    expect(slide.elements).toEqual([
      {
        id: 'p1:z29',
        provenance: sh.provenance,
        clip: ['c1', 'c2'],
        clipBox: sh.clipBox,
        groups: [],
        mask: null,
        blend: 'normal',
        kind: 'fallback',
        reason: 'text-clip-shading',
        coveredOps: [29],
        raster: null,
        bbox: [40, 60, 200, 90],
      } satisfies FallbackEl,
    ]);
    const note = { opIndex: 29, op: 'shadingFill', detail: 'shading clipped by text needs a raster fallback' };
    expect(slide.notes).toEqual([note]);
    expect(report.notes).toEqual([note]);
    const { nodes } = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
    expect(nodes).toEqual([]);
    expect(report.fallbacks).toEqual([{ id: 'p1:z29', reason: 'text-clip-shading' }]);
    expect(report.counts).toMatchObject({ rects: 0, fallbacks: 1 });
  });

  it('a filled and stroked rect at the page edge in the page clip is one node with its fill and line (M3-R28)', () => {
    // x 0, w 2: the stroke's outer half lies past the page, where nothing shows
    const geom = rectPath(0, 20, 100, 50);
    const { nodes, report } = lower(
      [shape({ op: 30, geom, clip: ['c1'] }), shape({ op: 31, geom, fill: null, line: lineStyle({ w: 2 }), clip: ['c1'] })],
      { c1: PAGE_CLIP },
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: 'pdf:p1:z30 rect', fill: { kind: 'solid' }, line: { w: 2 * 12700 } });
    expect(report.approximations).toEqual([]);
  });

  it("the clip pass's approximations are recorded when the shape is written, under the id it is written with", () => {
    const { nodes, report } = lower([shape({ op: 23, geom: circle(100, 100, 50), clip: ['c1'] })], { c1: boxClip([0, 0, 120, 200]) });
    expect(nodes.map((n) => n.name)).toEqual(['pdf:p1:z23 freeform']);
    expect(report.approximations).toEqual([{ id: 'p1:z23', kind: 'clip-approx' }]);
    // its custGeom is the cut circle: one a:path, its box the circle's left 70 pt
    expect((nodes[0] as OxShape).frame).toMatchObject({ x: 50 * 12700, w: 70 * 12700 });
    expect(((nodes[0] as OxShape).geom as { paths: unknown[] }).paths).toHaveLength(1);
    // a stroked circle in that clip keeps its path and records clip-dropped
    const stroked = lower([shape({ op: 24, geom: circle(100, 100, 50), fill: null, line: lineStyle(), clip: ['c1'] })], { c1: boxClip([0, 0, 120, 200]) });
    expect(stroked.report.approximations).toEqual([{ id: 'p1:z24', kind: 'clip-dropped' }]);
  });

  it('a fill and its stroke in the page clip still merge into one shape', () => {
    const geom: PathSeg[] = circle(100, 100, 40);
    const fillEl: ShapeEl = shape({ op: 24, geom, clip: ['c1'] });
    const strokeEl: ShapeEl = shape({ op: 25, geom, fill: null, line: lineStyle(), clip: ['c1'] });
    const { nodes } = lower([fillEl, strokeEl], { c1: PAGE_CLIP });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ name: 'pdf:p1:z24 freeform', fill: { kind: 'solid' }, line: { w: 2 * 12700 } });
  });
});

describe('a slide past its outline budget flattens no more paths (final review Minor 3)', () => {
  it('2,000 filled paths of 18,900 points each in a circle clip, the budget spent: each clip-dropped, nothing flattened', () => {
    // 170 cubics bent enough for 111 points each at the outline tolerance: within the points cap, so flattened were it asked
    const geom: PathSeg[] = [['M', 10, 100]];
    const dx = 270 / 170;
    for (let i = 0; i < 170; i++) geom.push(['C', 10 + (i + 1 / 3) * dx, 360, 10 + (i + 2 / 3) * dx, -160, 10 + (i + 1) * dx, 100]);
    geom.push(['L', 280, 190], ['L', 10, 190], ['Z']);
    const ring = circle(150, 100, 80);
    const els = Array.from({ length: 2_000 }, (_, i) => shape({ op: 100 + i, geom, fill: solid(), clip: ['c1'] }));
    const slide = slideOf(els, { clips: { c1: { kind: 'path', geom: ring, rule: 'nonzero', bbox: pathBox(ring) } } });
    const notes: Note[] = [];
    const started = performance.now();
    const out = resolveClips(slide, notes, { left: 0 });
    expect(performance.now() - started, 'a hang guard').toBeLessThan(400);
    expect(out.elements.every((el) => (el as PassedShape).approximations?.[0] === 'clip-dropped')).toBe(true);
    expect(notes.map((n) => n.detail)).toEqual([CLIP_BUDGET_NOTE]);
  });
});
