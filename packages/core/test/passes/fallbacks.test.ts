import type { OxPicture } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import type { PathSeg } from '../../src/extract/inventory';
import { effectFallbacks, effectReason, fallbackOf, RASTER_BUDGET_NOTE, rasterFallbacks, stopAlphaCandidate, undrawnEffects, type PassedFallback } from '../../src/passes/fallbacks';
import { lowerSlide, runPasses, type PassedPicture, type PassedShape } from '../../src/passes';
import { RASTER_GEOMETRY_NOTE, rasterize } from '../../src/raster/raster';
import { sha256Sync } from '../../src/scene/canonical';
import type { Element, MaskDef, MediaInfo, SceneSlide, ShadingMesh, TileCell } from '../../src/scene/types';
import { circle, deckOf, linear, pathBox, picture, poly, rectPath, shape, slideOf, snapshot, solid, textline } from '../helpers/passes';
import { decodePng } from '../helpers/png';

/**
 * The raster fallbacks in the passes (M5 Task 2): which elements become one (`effectFallbacks`, the shading fallbacks),
 * how the last pass draws them, and how lowering writes them: a picture on the raster's box, in the element's place.
 */

const BLUE: [number, number, number] = [0, 102, 204];
const YELLOW: [number, number, number] = [255, 204, 51];
const gradientMask = (over: Partial<MaskDef> = {}): MaskDef => ({
  subtype: 'luminosity',
  backdrop: [0, 0, 0],
  elements: [shape({ op: 90, geom: rectPath(10, 20, 100, 50), fill: linear() })],
  clips: {},
  ...over,
});

describe('which elements become a raster fallback', () => {
  it('a blend mode other than Normal, its own or a group\'s: blend-mode', () => {
    const slide = slideOf([]);
    expect(effectReason(shape({ blend: 'multiply' }), slide)).toBe('blend-mode');
    expect(effectReason(shape({ groups: [{ alpha: 1, blend: 'screen', isolated: false, knockout: false, bbox: null, mask: null }] }), slide)).toBe('blend-mode');
    expect(effectReason(picture([0, 0, 10, 10], { blend: 'darken' }), slide)).toBe('blend-mode');
    expect(effectReason(shape(), slide)).toBeNull();
  });

  it('a soft mask: soft-mask, a stop-alpha candidate the stop-alpha pass could not write among them (M5 Task 3)', () => {
    const slide = slideOf([], { masks: { m1: gradientMask(), m2: gradientMask({ subtype: 'alpha' }) } });
    // a candidate: a luminosity mask of one gradient shape over a shape of one fill and no line; stopAlphas writes those it
    // can exactly before this pass (stop-alpha.test.ts), so one still masked here is a fallback (Review Focus 4)
    expect(stopAlphaCandidate(shape({ mask: 'm1', fill: linear() }), slide)).toBe(true);
    expect(effectReason(shape({ mask: 'm1', fill: solid() }), slide)).toBe('soft-mask');
    // the rest: an alpha mask, a masked picture, a masked shape with a line
    expect(effectReason(shape({ mask: 'm2' }), slide)).toBe('soft-mask');
    expect(effectReason(picture([0, 0, 10, 10], { mask: 'm1' }), slide)).toBe('soft-mask');
    expect(effectReason(shape({ mask: 'm1', line: { w: 1, cap: 'butt', join: 'miter', miter: 10, dash: [], phase: 0, anisotropic: false, paint: solid() } }), slide)).toBe('soft-mask');
  });

  it('never text, and nothing in a text clip (its glyph outline is not the raster renderer\'s)', () => {
    const slide = slideOf([], { clips: { c1: { kind: 'text', bbox: [0, 0, 10, 10], approx: true } } });
    expect(effectReason(textline({ blend: 'multiply' }), slide)).toBeNull();
    expect(effectReason(shape({ blend: 'multiply', clip: ['c1'] }), slide)).toBeNull();
    expect(() => fallbackOf(textline() as never, 'blend-mode')).toThrow(TypeError);
  });

  it('effectFallbacks replaces each such element by a fallback that stands for it; the input is not changed', () => {
    const multiply = shape({ op: 2, blend: 'multiply' });
    const input = slideOf([shape({ op: 1 }), multiply, textline({ op: 3, blend: 'multiply' })]);
    const before = snapshot(input);
    const out = effectFallbacks(input);
    expect(input).toEqual(before);
    expect(out.elements.map((el) => el.kind)).toEqual(['shape', 'fallback', 'textline']);
    expect(out.elements[1]).toMatchObject({ id: 'p1:z2', kind: 'fallback', reason: 'blend-mode', coveredOps: [2], raster: null, blend: 'multiply', of: multiply });
  });
});

describe('Review Focus 1: a page where one shape uses a blend mode behind text', () => {
  const page = (): SceneSlide =>
    slideOf([
      shape({ op: 1, geom: rectPath(0, 0, 300, 200), fill: solid(BLUE) }),
      shape({ op: 2, geom: rectPath(20, 10, 40, 30), fill: solid(YELLOW), blend: 'multiply' }),
      textline({ op: 3 }),
    ]);

  it('only that shape becomes a picture; the text stays a text box over it, and z-order is kept', () => {
    const input = page();
    const deck = deckOf([input]);
    const { slide, report, media } = runPasses(input, deck);
    expect(slide.elements.map((el) => el.kind)).toEqual(['shape', 'fallback', 'textline']);
    const fallback = slide.elements[1] as PassedFallback;
    expect(fallback.picture).toMatchObject({ box: [20, 10, 60, 40], px: { w: 80, h: 60 }, pxPerPt: 2 });
    expect([...media.keys()]).toEqual([fallback.picture!.mediaHash]);
    expect(fallback.picture!.mediaHash).toBe(sha256Sync(media.get(fallback.picture!.mediaHash)!));
    const lowered = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
    // the background rect is the slide's background (M3-R52); then the picture, then the text box
    expect(lowered.background).toMatchObject({ kind: 'solid' });
    expect(lowered.nodes.map((n) => [n.kind, n.name])).toEqual([
      ['picture', 'pdf:p1:z2 fallback'],
      ['text', 'pdf:p1:z3 text'],
    ]);
    expect(lowered.nodes[0]).toMatchObject({ kind: 'picture', media: fallback.picture!.mediaHash, srcRect: null, alpha: 100000, frame: { x: 254000, y: 127000, w: 508000, h: 381000, rot: 0, flipH: false, flipV: false } });
    expect(report.counts).toMatchObject({ fallbacks: 1, pictures: 0, textBoxes: 1 });
    expect(report.fallbacks).toEqual([{ id: 'p1:z2', reason: 'blend-mode', raster: { w: 80, h: 60, pxPerPt: 2 } }]);
    // no longer dropped: the raster draws the blend mode
    expect(report.approximations).toEqual([]);
    const png = decodePng(media.get(fallback.picture!.mediaHash)!);
    expect(Array.from(png.data.subarray((30 * 80 + 40) * 4, (30 * 80 + 40) * 4 + 4))).toEqual([0, 82, 41, 255]);
  });

  it('a function or mesh shading is drawn too, from its triangles; one without them stays unwritten, counted', () => {
    const mesh: ShadingMesh = { type: 4, xy: [0, 0, 100, 0, 0, 100], rgb: [0, 0, 0, 255, 0, 0, 0, 0, 255], triangles: [0, 1, 2], matrix: [1, 0, 0, 1, 0, 0], bbox: null, background: null };
    const input = slideOf([
      shape({ op: 4, geom: rectPath(0, 0, 50, 50), fill: { kind: 'shading', shading: 'mesh', alpha: 1, mesh } }),
      shape({ op: 5, geom: rectPath(0, 0, 50, 50), fill: { kind: 'shading', shading: 'function', alpha: 1, mesh: null } }),
    ]);
    const deck = deckOf([input]);
    const { slide, report, media } = runPasses(input, deck);
    expect(media.size).toBe(1);
    const lowered = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
    expect(lowered.nodes.map((n) => n.name)).toEqual(['pdf:p1:z4 fallback']);
    expect(report.fallbacks).toEqual([
      { id: 'p1:z4', reason: 'shading-mesh', raster: { w: 100, h: 100, pxPerPt: 2 } },
      { id: 'p1:z5', reason: 'shading-function' },
    ]);
    expect(report.counts.fallbacks).toBe(2);
  });
});

describe('a clip-cut fallback (M5 Task 4)', () => {
  const TRIANGLE = poly([
    [50, 150],
    [250, 150],
    [150, 30],
  ]);
  const clips = { c1: { kind: 'path' as const, geom: TRIANGLE, rule: 'nonzero' as const, bbox: pathBox(TRIANGLE) } };

  it('a fill too large to outline in a clip that cuts it is drawn in that clip as a picture', () => {
    const zigzag: [number, number][] = [];
    for (let i = 0; i < 25000; i++) zigzag.push([60 + i * 0.004, i % 2 === 0 ? 60 : 61]);
    zigzag.push([160, 140], [60, 140]);
    const input = slideOf([shape({ op: 6, geom: poly(zigzag), fill: solid(BLUE), clip: ['c1'] })], { clips });
    const deck = deckOf([input]);
    const { slide, report, media } = runPasses(input, deck);
    expect(slide.elements.map((el) => el.kind)).toEqual(['fallback']);
    expect(media.size).toBe(1);
    const lowered = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
    expect(lowered.nodes.map((n) => n.name)).toEqual(['pdf:p1:z6 fallback']);
    expect(report.fallbacks).toMatchObject([{ id: 'p1:z6', reason: 'clip-cut' }]);
    expect(report.approximations).toEqual([]);
    // left of the triangle's side (x 116.7 at y 70) it is transparent; inside it, blue
    const fb = slide.elements[0] as PassedFallback;
    const png = decodePng(media.get(fb.picture!.mediaHash)!);
    const [bx, by] = [fb.picture!.box[0], fb.picture!.box[1]];
    const at = (x: number, y: number) => Array.from(png.data.subarray(((Math.round((y - by) * 2) * png.width + Math.round((x - bx) * 2)) * 4), ((Math.round((y - by) * 2) * png.width + Math.round((x - bx) * 2)) * 4) + 4));
    expect(at(62, 70)[3]).toBe(0);
    expect(at(150, 120)).toEqual([...BLUE, 255]);
  });

  it('not drawn, it is its shape again, clip-dropped, and strict mode refuses it', () => {
    // nothing of it on the page: the raster draws nothing
    const el: PassedShape = { ...shape({ op: 7, geom: rectPath(400, 20, 50, 50), clip: ['c1'] }), approximations: ['clip-dropped'], clipCut: true };
    const slide = slideOf([fallbackOf(el, 'clip-cut')], { clips });
    const out = rasterFallbacks(slide, null).slide;
    expect(out.elements).toEqual([el]);
    expect(undrawnEffects(out)).toBe(1);
    expect(undrawnEffects(slideOf([shape()]))).toBe(0);
  });

  it('a picture past the outline caps (M5 Task 5), not drawn (its pixels not at hand), is the picture as planned again, and strict mode refuses it', () => {
    const pic: PassedPicture = { ...picture([60, 40, 240, 140], { op: 8, clip: ['c1'] }), plan: { kind: 'shape', geom: TRIANGLE, paths: [[0]] }, approximations: ['clip-approx'], clipCut: true };
    const fb: PassedFallback = { ...fallbackOf(pic, 'clip-cut'), of: pic };
    const slide = slideOf([fb], { clips });
    const out = rasterFallbacks(slide, null).slide;
    expect(out.elements).toEqual([pic]);
    expect(undrawnEffects(out)).toBe(1);
    expect(undrawnEffects(slideOf([picture([0, 0, 10, 10])]))).toBe(0);
  });
});

describe('final review C1: hostile geometry reaches the raster bounded', () => {
  /** A filled path of `n` cubics whose handles reach about ±30,000 pt: 1,024 pieces each in a raster. */
  const hostile = (n: number): PathSeg[] => {
    const geom: PathSeg[] = [['M', 10, 10]];
    for (let i = 0; i < n; i++) geom.push(['C', 30_000, -30_000, -30_000, 30_000, 10 + (i % 100), 10 + (i % 50)]);
    geom.push(['Z']);
    return geom;
  };
  const ring = circle(150, 100, 60);
  const clips = { c1: { kind: 'path' as const, geom: ring, rule: 'nonzero' as const, bbox: pathBox(ring) } };

  it('in a circle clip (past the outline caps: a clip-cut fallback), it is refused by the raster and written as before M5, quickly', () => {
    const input = slideOf([shape({ op: 6, geom: hostile(24_000), fill: solid(BLUE), clip: ['c1'] })], { clips });
    const started = performance.now();
    const { slide, report, media } = runPasses(input, deckOf([input]));
    expect(performance.now() - started, 'a hang guard').toBeLessThan(3_000);
    expect(media.size).toBe(0);
    expect(slide.elements).toHaveLength(1);
    expect(slide.elements[0]).toMatchObject({ kind: 'shape', clipCut: true, approximations: ['clip-dropped'] });
    expect(report.notes.map((n) => n.detail)).toContain(RASTER_GEOMETRY_NOTE);
    expect(undrawnEffects(slide)).toBe(1);
  });

  it('with a blend mode, alike: the shape again, its blend mode dropped (blend-dropped), refused by strict', () => {
    const input = slideOf([shape({ op: 6, geom: hostile(24_000), fill: solid(BLUE), blend: 'multiply' })]);
    const started = performance.now();
    const { slide, report } = runPasses(input, deckOf([input]));
    expect(performance.now() - started, 'a hang guard').toBeLessThan(3_000);
    expect(slide.elements.map((el) => el.kind)).toEqual(['shape']);
    expect(report.notes.map((n) => n.detail)).toContain(RASTER_GEOMETRY_NOTE);
    expect(undrawnEffects(slide)).toBe(1);
  });
});

describe('final review I1: a picture below a raster is drawn as the picture pass planned it', () => {
  const hash = 'b'.repeat(64);
  /** 2 x 2 black pixels. */
  const black = { width: 2, height: 2, format: 'rgb' as const, data: new Uint8Array(12) };
  const pixels = (h: string) => (h === hash ? black : undefined);
  /** The RGBA of the raster at (x, y) pt. */
  const at = (png: Uint8Array, fb: PassedFallback, x: number, y: number): number[] => {
    const img = decodePng(png);
    const [i, j] = [Math.floor((x - fb.picture!.box[0]) * 2), Math.floor((y - fb.picture!.box[1]) * 2)];
    return Array.from(img.data.subarray((j * img.width + i) * 4, (j * img.width + i) * 4 + 4));
  };
  /** The raster of `slide`'s element `index` drawn against the slide as the Scene has it (the PDF's backdrop). */
  const direct = (slide: SceneSlide, index: number): Uint8Array => {
    const fb = fallbackOf(slide.elements[index] as PassedShape, 'blend-mode');
    const elements = slide.elements.slice();
    elements[index] = fb;
    return rasterize(fb, { slide: { ...slide, elements }, index, pixels })!.png;
  };

  it('cropped to half its width by a box clip: beyond the crop a Multiply rect is over the white page', () => {
    const pic = picture([0, 0, 200, 100], { op: 1, mediaHash: hash, clip: ['c1'] });
    const rect = shape({ op: 2, geom: rectPath(50, 20, 100, 60), fill: solid(BLUE), blend: 'multiply' });
    const input = slideOf([pic, rect], { clips: { c1: { kind: 'box', bbox: [0, 0, 100, 200] } } });
    const { slide, media } = runPasses(input, deckOf([input]), { pixels });
    expect(slide.elements[0]).toMatchObject({ kind: 'picture', clip: [], plan: { kind: 'picture', crop: [0, 0, 100, 100] } });
    const fb = slide.elements[1] as PassedFallback;
    const png = media.get(fb.picture!.mediaHash)!;
    // beyond the crop (x 125 pt): blue, Multiply over the white page; over the picture (x 75 pt): black
    expect(at(png, fb, 125, 50)).toEqual([...BLUE, 255]);
    expect(at(png, fb, 75, 50)).toEqual([0, 0, 0, 255]);
    // the same picture as against the picture in its clip, as the PDF has it
    expect(fb.picture!.mediaHash).toBe(sha256Sync(direct(input, 1)));
  });

  it('written as the shape of its path clip: outside that shape a Multiply rect is over the white page', () => {
    const tri = poly([
      [0, 0],
      [200, 0],
      [0, 100],
    ]);
    const pic = picture([0, 0, 200, 100], { op: 1, mediaHash: hash, clip: ['c1'] });
    const rect = shape({ op: 2, geom: rectPath(50, 20, 100, 60), fill: solid(BLUE), blend: 'multiply' });
    const input = slideOf([pic, rect], { clips: { c1: { kind: 'path', geom: tri, rule: 'nonzero', bbox: pathBox(tri) } } });
    const { slide, media } = runPasses(input, deckOf([input]), { pixels });
    expect(slide.elements[0]).toMatchObject({ kind: 'picture', clip: [], plan: { kind: 'shape' } });
    const fb = slide.elements[1] as PassedFallback;
    const png = media.get(fb.picture!.mediaHash)!;
    // below the triangle's long side (x 125, y 70 pt): blue; above it (x 60, y 30 pt): black
    expect(at(png, fb, 125, 70)).toEqual([...BLUE, 255]);
    expect(at(png, fb, 60, 30)).toEqual([0, 0, 0, 255]);
    expect(fb.picture!.mediaHash).toBe(sha256Sync(direct(input, 1)));
  });
});

describe('final review I3: an effect not drawn is written as the later passes write it, only its effect dropped and recorded', () => {
  const HASH = 'a'.repeat(64);
  const MEDIA: Record<string, MediaInfo> = { [HASH]: { hash: HASH, mime: 'image/png', widthPx: 16, heightPx: 16, byteLength: 100, passthrough: false } };
  /** A tiling pattern of one picture, 6 pt tiles (lower-picture.test.ts). */
  const cell: TileCell = {
    bbox: [0, 0, 16, 16],
    xStep: 16,
    yStep: 16,
    matrix: [0.375, 0, 0, -0.375, 72, 72],
    paintType: 1,
    elements: [{ ...picture([0, 0, 1, 1], { op: 3 }), id: 'p1:z5/z3', mediaHash: HASH, matrix: [16, 0, 0, 16, 0, 0], xfrm: { x: 0, y: 0, w: 16, h: 16, rotDeg: 0, flipH: false, flipV: true } }],
    clips: {},
  };
  const TRIANGLE = poly([
    [50, 150],
    [250, 150],
    [150, 30],
  ]);
  const triangle = { kind: 'path' as const, geom: TRIANGLE, rule: 'nonzero' as const, bbox: pathBox(TRIANGLE) };
  /** A fill of 25,002 points, past the outline caps, inside the triangle's box (the clip-cut test above). */
  const zigzag = (dx = 0): PathSeg[] => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 25000; i++) pts.push([60 + dx + i * 0.004, i % 2 === 0 ? 60 : 61]);
    pts.push([160 + dx, 140], [60 + dx, 140]);
    return poly(pts);
  };
  const lowered = (input: SceneSlide, deck = deckOf([input])) => {
    const { slide, report } = runPasses(input, deck);
    return { slide, report, nodes: lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report }).nodes };
  };

  it('a tile-filled shape with a blend mode is no raster target (the renderer draws no tile): its tile is written, its blend mode dropped', () => {
    const input = slideOf([shape({ op: 5, geom: rectPath(73, 72, 130, 80), fill: { kind: 'tile', cell, alpha: 1 }, blend: 'multiply' })]);
    const { slide, report, nodes } = lowered(input, { ...deckOf([input]), media: MEDIA });
    expect(slide.elements.map((el) => el.kind)).toEqual(['shape']);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'shape', fill: { kind: 'blip', media: HASH, mode: { kind: 'tile' } } });
    expect(report.counts.fallbacks).toBe(0);
    expect(report.approximations).toEqual([{ id: 'p1:z5', kind: 'blend-dropped' }]);
    expect(undrawnEffects(slide)).toBe(1);
  });

  it('a tile-filled shape past the outline caps of its clip alike: its tile written, clip-dropped, refused by strict', () => {
    const input = slideOf([shape({ op: 6, geom: zigzag(), fill: { kind: 'tile', cell, alpha: 1 }, clip: ['c1'] })], { clips: { c1: triangle } });
    const { slide, report, nodes } = lowered(input, { ...deckOf([input]), media: MEDIA });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ kind: 'shape', fill: { kind: 'blip', media: HASH, mode: { kind: 'tile' } } });
    expect(report.counts.fallbacks).toBe(0);
    expect(report.approximations.map((a) => a.kind)).toContain('clip-dropped');
    expect(undrawnEffects(slide)).toBe(1);
  });

  it('past the slide\'s raster budget a cropped picture is written cropped and a clipped shape clipped, each recorded', () => {
    const hash = 'b'.repeat(64);
    const elements: Element[] = [
      // two fills past the outline caps in the triangle: clip-cut fallbacks, drawn first (64 rasters a slide)
      shape({ op: 1, geom: zigzag(), fill: solid(BLUE), clip: ['c1'] }),
      shape({ op: 2, geom: zigzag(0.002), fill: solid(BLUE), clip: ['c1'] }),
    ];
    // 62 small Multiply rects, apart from the rest: rasters 3 to 64
    for (let i = 0; i < 62; i++) elements.push(shape({ op: 10 + i, geom: rectPath(2 + 4 * i, 185, 1, 1), fill: solid(YELLOW), blend: 'multiply' }));
    // past the budget: a Multiply picture cropped by a box clip, and a Multiply rect cut by a circle clip
    elements.push(picture([10, 10, 50, 50], { op: 80, mediaHash: hash, blend: 'multiply', clip: ['c2'] }));
    elements.push(shape({ op: 81, geom: rectPath(200, 20, 60, 60), fill: solid(BLUE), blend: 'multiply', clip: ['c3'] }));
    const ring = circle(230, 50, 30);
    const input = slideOf(elements, { clips: { c1: triangle, c2: { kind: 'box', bbox: [10, 10, 30, 50] }, c3: { kind: 'path', geom: ring, rule: 'nonzero', bbox: pathBox(ring) } } });
    const deck = { ...deckOf([input]), media: { [hash]: { hash, mime: 'image/png' as const, widthPx: 2, heightPx: 2, byteLength: 10, passthrough: false } } };
    const { slide, report, nodes } = lowered(input, deck);
    expect(report.notes.map((n) => n.detail)).toContain(RASTER_BUDGET_NOTE);
    expect(report.counts.fallbacks).toBe(64);
    // the picture: cropped to its clip, as a picture with srcRect; its blend mode dropped and recorded
    const pic = slide.elements.find((el) => el.id === 'p1:z80') as PassedPicture;
    expect(pic).toMatchObject({ kind: 'picture', clip: [], plan: { kind: 'picture', crop: [10, 10, 30, 50] } });
    const picNode = nodes.find((n) => n.name === 'pdf:p1:z80 picture') as OxPicture;
    expect(picNode.srcRect).not.toBeNull();
    expect(picNode.frame.w).toBe(20 * 12700);
    // the shape: cut by its circle (an outline in the circle's box), not its whole rect
    const cut = slide.elements.find((el) => el.id === 'p1:z81') as PassedShape;
    expect(cut).toMatchObject({ kind: 'shape', clip: [], fillRule: 'evenodd' });
    expect(pathBox(cut.geom!)[0]).toBeGreaterThan(199.9);
    const kinds = (id: string) => report.approximations.filter((a) => a.id === id).map((a) => a.kind);
    expect(kinds('p1:z80')).toEqual(['blend-dropped']);
    expect(kinds('p1:z81').sort()).toEqual(['blend-dropped', 'clip-approx']);
    expect(undrawnEffects(slide)).toBe(2);
  });
});
