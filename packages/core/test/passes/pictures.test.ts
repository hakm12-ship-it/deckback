import { describe, expect, it } from 'vitest';
import type { Box, PathSeg } from '../../src/extract/inventory';
import type { PassedShape } from '../../src/passes';
import { CLIP_BUDGET_NOTE } from '../../src/passes/clip';
import type { PassedFallback } from '../../src/passes/fallbacks';
import { jpegDensity, resolvePictures, type PassContext, type PassedPicture } from '../../src/passes/pictures';
import { newReport } from '../../src/passes/report';
import { pictureXfrm } from '../../src/scene/build';
import type { ClipDef, Element, Fill, MediaInfo, PictureEl, SceneSlide, ShapeEl, TileCell } from '../../src/scene/types';
import { circle, deckOf, linear, lineStyle, outlineArea, pathBox, picture, poly, rectPath, shape, slideOf, snapshot, solid, square } from '../helpers/passes';

const linearPaint = linear();

/**
 * The picture pass (Task 7): each picture's clips are judged in the picture's own frame (ruling M3-R31) — dropped where
 * they hold it, a crop (`srcRect`) where they are rects of that frame, else the shape of a path clip filled with the
 * picture — and a tiling pattern whose cell is one picture becomes a picture tile (M2-R18), any other `tile-unsupported`.
 */

const PAGE_CLIP: ClipDef = { kind: 'path', geom: rectPath(0, 0, 300, 200), rule: 'evenodd', bbox: [0, 0, 300, 200] };
const boxClip = (bbox: Box): ClipDef => ({ kind: 'box', bbox });
const pathClip = (geom: PathSeg[], rule: 'nonzero' | 'evenodd' = 'nonzero'): ClipDef => ({ kind: 'path', geom, rule, bbox: pathBox(geom) });

const HASH = 'a'.repeat(64);
const png = (w: number, h: number): MediaInfo => ({ hash: HASH, mime: 'image/png', widthPx: w, heightPx: h, byteLength: 100, passthrough: false });

function run(elements: Element[], clips: Record<string, ClipDef> = {}, media: Record<string, MediaInfo> = {}, ctx: PassContext = {}) {
  const input = slideOf(elements, { clips });
  const deck = { ...deckOf([input]), media };
  const report = newReport(input);
  const before = snapshot(input);
  const slide = resolvePictures(input, deck, report, ctx);
  expect(input).toEqual(before); // the input is not changed
  return { slide, report };
}

const only = (slide: SceneSlide): PassedPicture => {
  expect(slide.elements).toHaveLength(1);
  return slide.elements[0] as PassedPicture;
};

/** The PDF unit-square matrix of a picture DrawingML would place at (x, y, w, h), turned `rot` degrees and flipped. */
function matrixOf(x: number, y: number, w: number, h: number, rot: number, flipH = false, flipV = false): number[] {
  const t = (rot * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const right = [(flipH ? -w : w) * cos, (flipH ? -w : w) * sin];
  const down = [(flipV ? -h : h) * -sin, (flipV ? -h : h) * cos];
  const [cx, cy] = [x + w / 2, y + h / 2];
  return [right[0]!, right[1]!, -down[0]!, -down[1]!, cx - right[0]! / 2 + down[0]! / 2, cy - right[1]! / 2 + down[1]! / 2];
}

/** A picture as the Scene builds it from that matrix: rounded as M2-R13 says, its frame from `pictureXfrm`. */
function turned(op: number, x: number, y: number, w: number, h: number, rot: number, flips: { flipH?: boolean; flipV?: boolean } = {}, over: Partial<PictureEl> = {}): PictureEl {
  const raw = matrixOf(x, y, w, h, rot, flips.flipH, flips.flipV);
  const matrix = raw.map((v, i) => (i < 4 ? Math.round(v * 1e6) / 1e6 : Math.round(v * 1e3) / 1e3));
  const { xfrm, skewed } = pictureXfrm(raw);
  return { ...picture([0, 0, 1, 1], { op }), matrix, xfrm, skewed, ...over };
}

/** A point of the picture's own frame (unturned, unflipped) on the slide: flipped about its centre, then turned. */
function onSlide(pic: PictureEl, [qx, qy]: [number, number]): [number, number] {
  const { x, y, w, h, rotDeg, flipH, flipV } = pic.xfrm;
  const [cx, cy] = [x + w / 2, y + h / 2];
  const t = (rotDeg * Math.PI) / 180;
  const [vx, vy] = [(flipH ? -1 : 1) * (qx - cx), (flipV ? -1 : 1) * (qy - cy)];
  return [cx + vx * Math.cos(t) - vy * Math.sin(t), cy + vx * Math.sin(t) + vy * Math.cos(t)];
}

/** A rect of the picture's own frame as a clip path on the slide, rounded as the Scene rounds. */
function frameRect(pic: PictureEl, [x0, y0, x1, y1]: Box): ClipDef {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const pts = ([[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as [number, number][]).map((q) => onSlide(pic, q).map(r) as [number, number]);
  return pathClip(poly(pts), 'evenodd');
}

const close = (actual: readonly number[], expected: readonly number[], digits = 2) =>
  expected.forEach((v, i) => expect(actual[i], `[${i}]`).toBeCloseTo(v, digits));

describe('the picture pass: clips', () => {
  it('a picture in no clip is a picture, uncropped', () => {
    const { slide } = run([picture([20, 20, 120, 80], { op: 3 })]);
    expect(only(slide)).toMatchObject({ plan: { kind: 'picture', crop: null }, clip: [] });
    expect(only(slide).approximations).toBeUndefined();
  });

  it('a clip that contains the picture is dropped: a box, a rect path, the page', () => {
    const clips = { c1: PAGE_CLIP, c2: boxClip([10, 10, 200, 150]), c3: pathClip(rectPath(20, 20, 100, 60), 'evenodd') };
    const { slide } = run([picture([20, 20, 120, 80], { op: 3, clip: ['c1', 'c2', 'c3'] })], clips);
    expect(only(slide)).toMatchObject({ plan: { kind: 'picture', crop: null }, clip: [] });
    // what lies past the page does not count (M3-R28): the page clip holds all of the picture that shows
    const off = run([picture([250, 20, 350, 80], { op: 4, clip: ['c1'] })], clips);
    expect(only(off.slide)).toMatchObject({ plan: { kind: 'picture', crop: null }, clip: [] });
  });

  it('M8 round 1a: a picture wholly past the page loses every clip, a path clip and a box of no area too: none of it shows', () => {
    // PowerPoint clips a picture past the slide's edge to a box of 0.0001 pt at the page's corner
    const clips = { c1: boxClip([0, 0, 0.0001, 0.0001]), c2: pathClip(poly([[0, 0], [100, 0], [50, 80]])), c3: { kind: 'text', bbox: [0, 0, 300, 200], approx: true } as ClipDef };
    const { slide } = run([picture([20, 220, 120, 280], { op: 3, clip: ['c1', 'c2', 'c3'] })], clips);
    expect(only(slide)).toMatchObject({ plan: { kind: 'picture', crop: null }, clip: [] });
    expect(only(slide).approximations).toBeUndefined();
  });

  it('a box on an unturned, unflipped picture that cuts it is a crop: the visible part, in its own frame', () => {
    const pic = picture([20, 20, 120, 80], { op: 3, clip: ['c1'] });
    expect(only(run([pic], { c1: boxClip([50, 0, 300, 60]) }).slide)).toMatchObject({ plan: { kind: 'picture', crop: [50, 20, 120, 60] }, clip: [] });
    // a rect path is a box (as the clip pass's rectOf); two of them are their intersection
    const two = run([{ ...pic, clip: ['c1', 'c2'] }], { c1: boxClip([50, 0, 300, 60]), c2: pathClip(rectPath(0, 40, 100, 160)) });
    expect(only(two.slide)).toMatchObject({ plan: { kind: 'picture', crop: [50, 40, 100, 60] }, clip: [] });
  });

  it("the picture's own turned frame, as its clip, contains it; a rect of that frame that cuts it is a crop", () => {
    const pic = turned(3, 100, 50, 100, 60, 30);
    const own = run([{ ...pic, clip: ['c1'] }], { c1: frameRect(pic, [100, 50, 200, 110]) });
    expect(only(own.slide)).toMatchObject({ plan: { kind: 'picture', crop: null }, clip: [] });
    // PowerPoint writes 2 decimals: its outline of a turned picture misses the image's corners by up to ~0.015 pt
    // (atlas-smoke p33:z155 by 0.012), and still holds it; a cut of 0.05 pt is a cut
    const rough = run([{ ...pic, clip: ['c1'] }], { c1: frameRect(pic, [100, 50, 199.985, 110]) });
    expect(only(rough.slide)).toMatchObject({ plan: { kind: 'picture', crop: null }, clip: [] });
    const sliver = only(run([{ ...pic, clip: ['c1'] }], { c1: frameRect(pic, [100, 50, 199.95, 110]) }).slide);
    close((sliver.plan as { crop: Box }).crop, [100, 50, 199.95, 110]);
    const half = only(run([{ ...pic, clip: ['c1'] }], { c1: frameRect(pic, [100, 50, 150, 110]) }).slide);
    expect(half.plan?.kind).toBe('picture');
    close((half.plan as { crop: Box }).crop, [100, 50, 150, 110]);
    // flipped: the crop is in the image's own frame, so cutting the slide's left side cuts the mirrored image's right
    const mirrored = picture([20, 20, 120, 80], { op: 4, clip: ['c1'], matrix: [-100, 0, 0, -60, 120, 80], xfrm: { x: 20, y: 20, w: 100, h: 60, rotDeg: 0, flipH: true, flipV: false } });
    const cut = only(run([mirrored], { c1: boxClip([50, 0, 300, 200]) }).slide);
    close((cut.plan as { crop: Box }).crop, [20, 20, 90, 80]);
  });

  it('a box on a picture turned by a multiple of 90 degrees is a crop of its own frame (ruling M3-R31)', () => {
    // turned 90: its frame (10, 20)-(110, 70) lies on the slide at x 35..85, y -5..95; the box keeps slide y up to 60
    const pic = turned(3, 10, 20, 100, 50, 90, {}, { clip: ['c1'] });
    const out = only(run([pic], { c1: boxClip([0, -100, 300, 60]) }).slide);
    expect(out.plan?.kind).toBe('picture');
    close((out.plan as { crop: Box }).crop, [10, 20, 75, 70]);
  });

  it("a box on a picture turned 30 degrees is a shape: the box in the picture's own frame, filled with it", () => {
    const pic = turned(3, 100, 50, 100, 60, 30, {}, { clip: ['c1'] });
    const out = only(run([pic], { c1: boxClip([0, 0, 300, 90]) }).slide);
    expect(out.plan?.kind).toBe('shape');
    const plan = out.plan as { kind: 'shape'; geom: PathSeg[]; paths: number[][] };
    expect(plan.paths).toEqual([[0]]);
    // its corners, back on the slide, are the box's
    const corners = plan.geom.filter((s): s is ['M' | 'L', number, number] => s[0] === 'M' || s[0] === 'L').map((s) => onSlide(pic, [s[1], s[2]]));
    for (const [c, expected] of corners.map((c, i) => [c, [[0, 0], [300, 0], [300, 90], [0, 90]][i]!] as const)) close(c, expected);
    expect(out.clip).toEqual([]);
  });

  it('a path clip is a shape of its geometry; a nonzero one gets its a:paths from the fill rule', () => {
    const ellipse = circle(70, 50, 30);
    const pic = picture([20, 20, 120, 80], { op: 3, clip: ['c1'] });
    const out = only(run([pic], { c1: pathClip(ellipse, 'evenodd') }).slide);
    expect(out).toMatchObject({ plan: { kind: 'shape', geom: ellipse, paths: [[0]] }, clip: [] });
    expect(out.approximations).toBeUndefined();
    // two squares crossing, the same way round: nonzero is the union of their insides; its a:paths would overlap, and a
    // picture may be translucent (M5 Task 5): the union's outline, one a:path
    const two = [...square(30, 30, 40), ...square(50, 40, 40)];
    const union = only(run([pic], { c1: pathClip(two) }).slide);
    expect(union.plan).toMatchObject({ kind: 'shape', paths: [[0]] });
    expect(union.approximations).toBeUndefined();
    expect(outlineArea((union.plan as { geom: PathSeg[] }).geom)).toBeCloseTo(1600 + 1600 - 20 * 30, 3);
    // a bow tie under nonzero, which the fill rule cannot prove (M5 Task 5): the outline of its nonzero area, exactly
    const bow = poly([
      [20, 20],
      [120, 80],
      [120, 20],
      [20, 80],
    ]);
    const tie = only(run([pic], { c1: pathClip(bow) }).slide);
    expect(tie.approximations).toBeUndefined();
    expect((tie.plan as { paths: number[][] }).paths).toHaveLength(1); // one a:path, even-odd
    expect(outlineArea((tie.plan as { geom: PathSeg[] }).geom)).toBeCloseTo(3000, 1); // two triangles of 100 x 30 / 2
  });

  it('a text clip, or one the slide does not hold, is dropped and recorded clip-dropped', () => {
    const clips: Record<string, ClipDef> = { c1: { kind: 'text', bbox: [0, 0, 100, 100], approx: true } };
    const out = only(run([picture([20, 20, 120, 80], { op: 3, clip: ['c1', 'c9'] })], clips).slide);
    expect(out).toMatchObject({ plan: { kind: 'picture', crop: null }, clip: ['c1', 'c9'], approximations: ['clip-dropped'] });
  });

  it('a path and a box that both cut it (M5 Task 5): the shape is their intersection, every clip written; clip-approx for the flattened curve', () => {
    const ellipse = circle(70, 50, 30);
    const clips = { c1: pathClip(ellipse, 'evenodd'), c2: boxClip([50, 0, 300, 200]) };
    const out = only(run([picture([20, 20, 120, 80], { op: 3, clip: ['c1', 'c2'] })], clips).slide);
    expect(out).toMatchObject({ plan: { kind: 'shape', paths: [[0]] }, clip: [], approximations: ['clip-approx'] });
    // the circle less the cap left of x = 50: 900 pi - (900 acos(2/3) - 20 sqrt(500))
    const area = 900 * Math.PI - (900 * Math.acos(2 / 3) - 20 * Math.sqrt(500));
    expect(Math.abs(outlineArea((out.plan as { geom: PathSeg[] }).geom) - area)).toBeLessThan(10);
  });

  it('two path clips that both cut it: their exact intersection, one a:path filled even-odd; polygons record nothing', () => {
    const left = poly([[20, 20], [100, 20], [60, 80]]);
    const right = poly([[40, 20], [120, 20], [80, 80]]);
    const out = only(run([picture([20, 20, 120, 80], { op: 3, clip: ['c1', 'c2'] })], { c1: pathClip(left), c2: pathClip(right) }).slide);
    expect(out).toMatchObject({ plan: { kind: 'shape', paths: [[0]] }, clip: [] });
    expect(out.approximations).toBeUndefined();
    // the triangle (40, 20) (100, 20) (70, 65): 60 wide, 45 high
    expect(outlineArea((out.plan as { geom: PathSeg[] }).geom)).toBeCloseTo(1350, 3);
  });

  it("one path clip that reaches past the picture keeps its own geometry: the picture fills its own frame of it (fillRect)", () => {
    // PowerPoint's knockout clip of a baked shadow: the page less a rounded rect, even-odd (atlas effects/01)
    const knockout: PathSeg[] = [...rectPath(0, 0, 300, 200), ...circle(70, 50, 20)];
    const out = only(run([picture([20, 20, 120, 80], { op: 3, clip: ['c1'] })], { c1: pathClip(knockout, 'evenodd') }).slide);
    expect(out).toMatchObject({ plan: { kind: 'shape', geom: knockout, paths: [[0, 1]] }, clip: [] });
    expect(out.approximations).toBeUndefined();
  });

  it('a turned picture in two clips: their intersection in its own frame, which lowering turns with it', () => {
    const pic = turned(3, 100, 50, 100, 60, 30, {}, { clip: ['c1', 'c2'] });
    const disc = circle(150, 80, 40);
    const out = only(run([pic], { c1: pathClip(disc, 'evenodd'), c2: boxClip([0, 0, 300, 85]) }).slide);
    expect(out).toMatchObject({ plan: { kind: 'shape' }, clip: [], approximations: ['clip-approx'] });
    for (const seg of (out.plan as { geom: PathSeg[] }).geom) {
      if (seg[0] === 'Z') continue;
      const [x, y] = onSlide(pic, [seg[1], seg[2]]);
      expect(Math.hypot(x - 150, y - 80)).toBeLessThanOrEqual(40 + 0.06);
      expect(y).toBeLessThanOrEqual(85 + 0.06);
    }
  });

  it('clips nothing of which shows leave nothing of the picture', () => {
    const clips = { c1: pathClip(poly([[20, 20], [60, 20], [20, 60]])), c2: pathClip(poly([[120, 80], [80, 80], [120, 40]])) };
    const { slide } = run([picture([20, 20, 120, 80], { op: 3, clip: ['c1', 'c2'] }), shape({ op: 4 })], clips);
    expect(slide.elements.map((e) => e.id)).toEqual(['p1:z4']);
  });

  it('past the outline caps: a clip-cut fallback that stands for the picture in all its clips, its innermost path written should it not be drawn', () => {
    const n = 25_000;
    const ring = poly(Array.from({ length: n }, (_, i): [number, number] => [70 + 25 * Math.cos((2 * Math.PI * i) / n), 50 + 25 * Math.sin((2 * Math.PI * i) / n)]));
    const clips = { c1: boxClip([50, 0, 300, 200]), c2: pathClip(ring, 'evenodd') };
    const pic = picture([20, 20, 120, 80], { op: 3, clip: ['c1', 'c2'] });
    const out = run([pic], clips).slide.elements[0] as PassedFallback;
    expect(out).toMatchObject({ kind: 'fallback', reason: 'clip-cut', clip: ['c1', 'c2'] });
    expect(out.of).toMatchObject({ kind: 'picture', clip: ['c1', 'c2'], clipCut: true, plan: { kind: 'shape', geom: ring }, approximations: ['clip-approx'] });
  });

  it('past the slide budget: the innermost path and clip-approx, as before M5 Task 5, and the slide noted once', () => {
    const n = 15_000;
    const ring = poly(Array.from({ length: n }, (_, i): [number, number] => [150 + 90 * Math.cos((2 * Math.PI * i) / n), 100 + 90 * Math.sin((2 * Math.PI * i) / n)]));
    const clips = { c1: pathClip(ring, 'evenodd'), c2: boxClip([0, 0, 300, 120]) };
    const pics = Array.from({ length: 60 }, (_, i) => picture([60, 20, 240, 180], { op: 10 + i, clip: ['c1', 'c2'] }));
    const { slide, report } = run(pics, clips);
    const outs = slide.elements as PassedPicture[];
    expect(outs[0]).toMatchObject({ plan: { kind: 'shape' }, clip: [] });
    const last = outs[outs.length - 1]!;
    expect(last).toMatchObject({ plan: { kind: 'shape', geom: ring }, clip: ['c2'], approximations: ['clip-approx'] });
    expect(slide.notes.filter((note) => note.detail === CLIP_BUDGET_NOTE)).toHaveLength(1);
    expect(report.notes.filter((note) => note.detail === CLIP_BUDGET_NOTE)).toHaveLength(1);
  });

  it('a crop with no area leaves nothing of the picture', () => {
    const { slide } = run([picture([20, 20, 120, 80], { op: 3, clip: ['c1'] }), shape({ op: 4 })], { c1: boxClip([120, 0, 300, 200]) });
    expect(slide.elements.map((e) => e.id)).toEqual(['p1:z4']);
  });
});

describe('the picture pass: borders (M5 Task 5, atlas pictures/08)', () => {
  // PowerPoint exports a picture's own line (a:ln on p:pic) as a stroke just after it: the rect of its frame grown by half
  // the line's width, from its bottom left corner (it strokes a picture's outline outside the picture)
  const pic = (over: Partial<PictureEl> = {}) => picture([81, 29.5, 271, 148.5], { op: 189, ...over });
  const border = (over: Partial<ShapeEl> & { op?: number } = {}) =>
    shape({ op: 195, geom: poly([[80, 149.5], [272, 149.5], [272, 28.5], [80, 28.5]]), fill: null, line: lineStyle({ w: 2, dash: [8, 6], join: 'round' }), ...over });

  it("a stroke-only rect just after a picture, its frame grown by half the stroke's width, is the picture's own line", () => {
    const { slide } = run([pic(), border(), shape({ op: 200 })]);
    expect(slide.elements.map((e) => e.id)).toEqual(['p1:z189', 'p1:z200']);
    expect((slide.elements[0] as PassedPicture).border).toEqual(lineStyle({ w: 2, dash: [8, 6], join: 'round' }));
  });

  it('a ring back at its start without h is the frame when its caps cover the corner (round or square)', () => {
    const ring: PathSeg[] = [['M', 80, 149.5], ['L', 272, 149.5], ['L', 272, 28.5], ['L', 80, 28.5], ['L', 80, 149.5]];
    for (const cap of ['round', 'square'] as const) {
      const { slide } = run([pic(), border({ geom: ring, line: lineStyle({ w: 2, cap, join: 'round' }) })]);
      expect(slide.elements.map((e) => e.id), cap).toEqual(['p1:z189']);
    }
  });

  it("a cropped picture's border is around the part that shows; a turned picture's around its turned frame", () => {
    const cropped = run([pic({ clip: ['c1'] }), border({ geom: poly([[80, 149.5], [201, 149.5], [201, 28.5], [80, 28.5]]) })], { c1: boxClip([0, 0, 200, 200]) });
    expect(cropped.slide.elements).toHaveLength(1);
    expect((cropped.slide.elements[0] as PassedPicture).border).toBeDefined();
    const t = turned(3, 100, 50, 100, 60, 30);
    const ring = ([[99, 49], [201, 49], [201, 111], [99, 111]] as [number, number][]).map((q) => onSlide(t, q));
    const turnedOut = run([t, border({ op: 4, geom: poly(ring), line: lineStyle({ w: 2 }) })]);
    expect(turnedOut.slide.elements).toHaveLength(1);
    expect((turnedOut.slide.elements[0] as PassedPicture).border).toBeDefined();
  });

  it('anything else stays a stroke of its own: centred on the frame, filled, after another element, in a clip, painted otherwise', () => {
    const kept = (els: Element[], clips: Record<string, ClipDef> = {}) => run(els, clips).slide.elements.map((e) => e.id);
    expect(kept([pic(), border({ geom: rectPath(81, 29.5, 190, 119) })])).toEqual(['p1:z189', 'p1:z195']);
    expect(kept([pic(), border({ fill: solid() })])).toEqual(['p1:z189', 'p1:z195']);
    expect(kept([pic(), shape({ op: 190 }), border()])).toEqual(['p1:z189', 'p1:z190', 'p1:z195']);
    expect(kept([pic(), border({ clip: ['c1'] })], { c1: boxClip([0, 0, 200, 200]) })).toEqual(['p1:z189', 'p1:z195']);
    expect(kept([pic(), border({ line: lineStyle({ w: 2, paint: linearPaint }) })])).toEqual(['p1:z189', 'p1:z195']);
    expect(kept([pic(), border({ groups: [{ alpha: 0.5, mask: null, blend: 'normal', knockout: false, isolated: false, bbox: null }] })])).toEqual(['p1:z189', 'p1:z195']);
    // fix round 1: only a closed path that draws all four sides is the frame (an open "U" draws three)
    const open = (pts: [number, number][]): PathSeg[] => pts.map(([x, y], i): PathSeg => [i === 0 ? 'M' : 'L', x, y]);
    const [a, b, c, d]: [[number, number], [number, number], [number, number], [number, number]] = [[80, 149.5], [272, 149.5], [272, 28.5], [80, 28.5]];
    expect(kept([pic(), border({ geom: open([a, b, c, d]) })])).toEqual(['p1:z189', 'p1:z195']);
    // an open ring with a gap at its start
    expect(kept([pic(), border({ geom: open([a, b, c, d, [80, 140]]) })])).toEqual(['p1:z189', 'p1:z195']);
    // back at its start without h: butt caps leave its start corner notched, which a:ln would join
    expect(kept([pic(), border({ geom: open([a, b, c, d, a]) })])).toEqual(['p1:z189', 'p1:z195']);
    // a dash with a phase: a picture's a:ln takes none (the stroke keeps it, recorded dash-phase as a shape)
    expect(kept([pic(), border({ line: lineStyle({ w: 2, dash: [8, 6], phase: 3, join: 'round' }) })])).toEqual(['p1:z189', 'p1:z195']);
    // a picture written as the shape of its clip keeps its stroke too
    expect(kept([pic({ clip: ['c1'] }), border()], { c1: pathClip(circle(176, 89, 40), 'evenodd') })).toEqual(['p1:z189', 'p1:z195']);
  });
});

/** A tile cell holding one 16 x 16 picture at 0.375 pt a unit, its origin at (72, 72), y up: atlas-smoke p10's. */
function cellOf(over: Partial<TileCell> = {}, pic: Partial<PictureEl> = {}): TileCell {
  const inCell: PictureEl = {
    ...picture([0, 0, 1, 1], { op: 3 }),
    id: 'p1:z5/z3',
    mediaHash: HASH,
    matrix: [16, 0, 0, 16, 0, 0],
    xfrm: { x: 0, y: 0, w: 16, h: 16, rotDeg: 0, flipH: false, flipV: true },
    clipBox: [0, 0, 16, 16],
    px: [16, 16],
    ...pic,
  };
  return { bbox: [0, 0, 16, 16], xStep: 16, yStep: 16, matrix: [0.375, 0, 0, -0.375, 72, 72], paintType: 1, elements: [inCell], clips: {}, ...over };
}
const tileFill = (cell: TileCell, alpha = 1): Fill => ({ kind: 'tile', cell, alpha });

describe('the picture pass: tiles', () => {
  it("a cell of one picture covering it is a picture tile: the first tile's box on the slide and the media's natural size", () => {
    const el = shape({ op: 5, geom: rectPath(73, 72, 130, 80), fill: tileFill(cellOf()) });
    const { slide, report } = run([el], {}, { [HASH]: png(16, 16) });
    const out = slide.elements[0] as PassedShape;
    // 16 cell units of 0.375 pt: a 6 pt tile from (72, 66); a PNG of 16 px is 12 pt at 96 dpi
    expect(out.tile).toEqual({ media: HASH, alpha: 1, image: [72, 66, 78, 72], natural: [12, 12] });
    expect(out.fill).toEqual(el.fill);
    expect(report.approximations).toEqual([]);
  });

  it("the tile's alpha is the pattern's times the picture's and its groups'", () => {
    const group = { alpha: 0.5, blend: 'normal' as const, isolated: false, knockout: false, bbox: null, mask: null };
    const el = shape({ op: 5, fill: tileFill(cellOf({}, { alpha: 0.8, groups: [group] }), 0.5) });
    const out = run([el], {}, { [HASH]: png(16, 16) }).slide.elements[0] as PassedShape;
    expect(out.tile?.alpha).toBeCloseTo(0.2, 12);
  });

  it("a JPEG's natural size is from its EXIF resolution, else its JFIF density, else 96 dpi (as PowerPoint reads it)", () => {
    // Task 12 measured PowerPoint's tile periods: with JFIF 300 dpi and EXIF 150 dpi both there, it takes the EXIF's
    const both = (jfifFirst: boolean) => {
      const [a, b] = [jfif(1, 300, 300), exif(150, 150)];
      const segments = (bytes: Uint8Array) => bytes.subarray(2, bytes.length - 2);
      const [first, second] = jfifFirst ? [segments(a), segments(b)] : [segments(b), segments(a)];
      return Uint8Array.from([0xff, 0xd8, ...first, ...second, 0xff, 0xd9]);
    };
    expect(jpegDensity(both(true))).toEqual([150, 150]);
    expect(jpegDensity(both(false))).toEqual([150, 150]);
    // JFIF giving an aspect ratio only, and EXIF 200 dpi: 200
    const aspect = Uint8Array.from([0xff, 0xd8, ...jfif(0, 1, 1).subarray(2, 20), ...exif(200, 200).subarray(2, -2), 0xff, 0xd9]);
    expect(jpegDensity(aspect)).toEqual([200, 200]);
    // either alone
    expect(jpegDensity(jfif(1, 300, 300))).toEqual([300, 300]);
    expect(jpegDensity(exif(150, 150))).toEqual([150, 150]);
  });

  it("a JPEG's natural size is from its density: dots per inch or per cm, else 96 dpi", () => {
    const jpeg: MediaInfo = { ...png(400, 250), mime: 'image/jpeg', passthrough: true };
    const natural = (bytes: Uint8Array | null) => {
      const el = shape({ op: 5, fill: tileFill(cellOf()) });
      const ctx: PassContext = bytes === null ? {} : { media: new Map([[HASH, bytes]]) };
      return (run([el], {}, { [HASH]: jpeg }, ctx).slide.elements[0] as PassedShape).tile?.natural;
    };
    expect(natural(jfif(1, 300, 150))).toEqual([96, 120]); // dots per inch: 400 px at 300 dpi is 96 pt
    close(natural(jfif(2, 100, 100))!, [(400 * 72) / 254, (250 * 72) / 254], 9); // dots per cm: 100 is 254 dpi
    expect(natural(jfif(0, 1, 1))).toEqual([300, 187.5]); // an aspect ratio only: 96 dpi
    expect(natural(exif(72, 72))).toEqual([400, 250]);
    expect(natural(null)).toEqual([300, 187.5]); // no bytes to read: 96 dpi
    expect(jpegDensity(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeNull();
  });

  it("a JPEG's density from the context (what convert() keeps instead of the bytes) gives the size its bytes give", () => {
    const jpeg: MediaInfo = { ...png(400, 250), mime: 'image/jpeg', passthrough: true };
    const natural = (ctx: PassContext) => {
      const el = shape({ op: 5, fill: tileFill(cellOf()) });
      return (run([el], {}, { [HASH]: jpeg }, ctx).slide.elements[0] as PassedShape).tile?.natural;
    };
    // a scan after the markers: the walk stops at it, and what follows it does not count
    const scan = (head: Uint8Array) => Uint8Array.from([...head.subarray(0, -2), 0xff, 0xda, 0, 2, ...jfif(1, 72, 72), 0xff, 0xd9]);
    const cases = [jfif(1, 300, 150), jfif(2, 100, 100), jfif(0, 1, 1), exif(72, 72), Uint8Array.of(0xff, 0xd8, 0xff, 0xd9), Uint8Array.of(1, 2, 3)];
    for (const bytes of [...cases, ...cases.slice(0, 4).map(scan), Uint8Array.from([...exif(300, 300).subarray(0, -2), ...jfif(1, 72, 72).subarray(2)])]) {
      expect(natural({ jpegDensity: new Map([[HASH, jpegDensity(bytes)]]) })).toEqual(natural({ media: new Map([[HASH, bytes]]) }));
    }
    expect(jpegDensity(scan(exif(300, 300)))).toEqual([300, 300]);
    // the density the context gives is read first; a null one is 96 dpi, even with the bytes there
    expect(natural({ jpegDensity: new Map([[HASH, [300, 150]]]), media: new Map([[HASH, jfif(1, 72, 72)]]) })).toEqual([96, 120]);
    expect(natural({ jpegDensity: new Map([[HASH, null]]), media: new Map([[HASH, jfif(1, 72, 72)]]) })).toEqual([300, 187.5]);
  });

  it('any other cell leaves the shape with no fill and records tile-unsupported', () => {
    const media = { [HASH]: png(16, 16) };
    const cases: [string, TileCell][] = [
      ['two elements', cellOf({ elements: [...cellOf().elements, shape({ op: 9 })] })],
      ['a shape', cellOf({ elements: [shape({ op: 9 })] })],
      ['a picture short of the cell', cellOf({}, { matrix: [8, 0, 0, 16, 0, 0] })],
      ['a step past the cell', cellOf({ xStep: 20 })],
      ['turned on the slide', cellOf({ matrix: [0, 0.375, 0.375, 0, 72, 72] })],
      ['upside down on the slide', cellOf({ matrix: [0.375, 0, 0, 0.375, 72, 72] })],
      ['a clip that cuts it', cellOf({ clips: { c1: boxClip([0, 0, 8, 16]) } }, { clip: ['c1'] })],
      ['a soft mask', cellOf({}, { mask: 'm1' })],
      ['media the deck does not have', cellOf({}, { mediaHash: 'b'.repeat(64) })],
    ];
    for (const [name, cell] of cases) {
      const { slide, report } = run([shape({ op: 5, fill: tileFill(cell), line: lineStyle() })], {}, media);
      const out = slide.elements[0] as PassedShape;
      expect([out.fill, out.tile, out.line], name).toEqual([null, undefined, lineStyle()]);
      expect(report.approximations, name).toEqual([{ id: 'p1:z5', kind: 'tile-unsupported' }]);
    }
    // a line painted with a pattern: DrawingML has no picture line
    const { slide, report } = run([shape({ op: 6, line: lineStyle({ paint: tileFill(cellOf()) }) })], {}, media);
    expect((slide.elements[0] as PassedShape).line).toBeNull();
    expect(report.approximations).toEqual([{ id: 'p1:z6', kind: 'tile-unsupported' }]);
  });
});

/** A JPEG of only SOI, a JFIF APP0 segment (`units` 0 none, 1 dpi, 2 per cm) and EOI. */
function jfif(units: number, x: number, y: number): Uint8Array {
  return Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, units, x >> 8, x & 255, y >> 8, y & 255, 0, 0, 0xff, 0xd9);
}

/** A JPEG of only SOI, an EXIF APP1 segment (big-endian, IFD0: XResolution, YResolution, ResolutionUnit inch) and EOI. */
function exif(x: number, y: number): Uint8Array {
  const u16 = (v: number) => [v >> 8, v & 255];
  const u32 = (v: number) => [0, 0, v >> 8, v & 255];
  const entries = 3;
  const data = 8 + 2 + entries * 12 + 4; // the rationals follow IFD0
  const tiff = [0x4d, 0x4d, ...u16(42), ...u32(8), ...u16(entries)];
  tiff.push(...u16(0x011a), ...u16(5), ...u32(1), ...u32(data));
  tiff.push(...u16(0x011b), ...u16(5), ...u32(1), ...u32(data + 8));
  tiff.push(...u16(0x0128), ...u16(3), ...u32(1), ...u16(2), 0, 0);
  tiff.push(...u32(0), ...u32(x), ...u32(1), ...u32(y), ...u32(1));
  const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, ...u16(body.length + 2), ...body, 0xff, 0xd9]);
}
