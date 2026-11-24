import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PathSeg } from '../../src/extract/inventory';
import { fallbackOf } from '../../src/passes/fallbacks';
import type { PassedPicture } from '../../src/passes/pictures';
import {
  FALLBACK_MAX_PX,
  FALLBACK_MAX_SIDE,
  MESH_TOO_COMPLEX_NOTE,
  PX_PER_PT,
  RASTER_GEOMETRY_NOTE,
  RASTER_MAX_POINTS,
  RASTER_WORK_NOTE,
  RASTER_WORK_SAMPLES,
  rasterize,
  SLIDE_RASTER_POINTS,
  SLIDE_RASTER_WORK_SAMPLES,
  type FallbackReason,
  type RasterCtx,
} from '../../src/raster/raster';
import { pictureXfrm } from '../../src/scene/build';
import { sha256Sync } from '../../src/scene/canonical';
import type { Element, MaskDef, PictureEl, SceneSlide, ShadingMesh } from '../../src/scene/types';
import { decodePng } from '../helpers/png';
import { linear, lineStyle, picture, rectPath, shape, slideOf, solid, textline } from '../helpers/passes';

/**
 * `rasterize` (M5 Task 2): one element the passes cannot write, as a picture of its own box, deterministic: 2 px a pt,
 * 4 x 4 samples a pixel counted in integers, the pixel count capped by `FALLBACK_MAX_PX`.
 */

/** The RGBA of pixel (i, j) of a PNG. */
function pixel(png: Uint8Array, i: number, j: number): number[] {
  const { width, data, channels } = decodePng(png);
  expect(channels).toBe(4);
  const at = (j * width + i) * 4;
  return Array.from(data.subarray(at, at + 4));
}

/** Rasterizes element `index` of `slide`, made a fallback with `reason`. */
function rasterOf(slide: SceneSlide, index: number, reason: FallbackReason, over: Partial<RasterCtx> = {}) {
  const el = fallbackOf(slide.elements[index] as Extract<Element, { kind: 'shape' | 'picture' }>, reason);
  const elements = slide.elements.slice();
  elements[index] = el;
  return rasterize(el, { slide: { ...slide, elements }, index, ...over });
}

const BLUE: [number, number, number] = [0, 102, 204];
const YELLOW: [number, number, number] = [255, 204, 51];

describe('rasterize', () => {
  it('Review Focus 1: a Multiply shape is drawn over its backdrop, opaque where it covers and clear elsewhere', () => {
    const slide = slideOf([
      shape({ op: 1, geom: rectPath(0, 0, 300, 200), fill: solid(BLUE) }),
      shape({ op: 2, geom: rectPath(20.25, 10, 40, 30), fill: solid(YELLOW), blend: 'multiply' }),
      textline({ op: 3 }),
    ]);
    const raster = rasterOf(slide, 1, 'blend-mode')!;
    // The box: the shape's, out to whole pixels at 2 px a pt.
    expect(raster.box).toEqual([20, 10, 60.5, 40]);
    expect(raster.px).toEqual({ w: 81, h: 60 });
    expect(raster.pxPerPt).toBe(PX_PER_PT);
    expect(decodePng(raster.png)).toMatchObject({ width: 81, height: 60, channels: 4 });
    // Multiply: (0, 102, 204) x (255, 204, 51) / 255.
    const multiplied = [0, Math.round((102 * 204) / 255), Math.round((204 * 51) / 255), 255];
    expect(pixel(raster.png, 40, 30)).toEqual(multiplied);
    // The left column is half covered (x 20 to 20.5 pt, the shape from 20.25): alpha 8 / 16 of 255, the same colour.
    expect(pixel(raster.png, 0, 30)).toEqual([...multiplied.slice(0, 3), 128]);
    expect(raster.notes).toEqual([]);
  });

  it('a normal blend needs no backdrop: the colour is its own and the alpha its coverage times its alphas', () => {
    const slide = slideOf([
      shape({ op: 1, geom: rectPath(0, 0, 300, 200), fill: solid(BLUE) }),
      shape({ op: 2, geom: rectPath(10, 10, 20, 20), fill: solid(YELLOW, 0.5), groups: [{ alpha: 0.5, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null }] }),
    ]);
    const raster = rasterOf(slide, 1, 'soft-mask')!;
    expect(pixel(raster.png, 10, 10)).toEqual([...YELLOW, 64]);
  });

  it('a luminosity soft mask: alpha follows the mask, here a black to white gradient left to right', () => {
    const mask: MaskDef = {
      subtype: 'luminosity',
      backdrop: [0, 0, 0],
      elements: [shape({ op: 7, geom: rectPath(10, 10, 100, 20), fill: linear({ stops: [{ t: 0, rgb: [0, 0, 0] }, { t: 1, rgb: [255, 255, 255] }], p0: [10, 0], p1: [110, 0], matrix: [1, 0, 0, 1, 0, 0] }) })],
      clips: {},
    };
    const slide = slideOf([shape({ op: 2, geom: rectPath(10, 10, 100, 20), fill: solid([200, 0, 0]), mask: 'm1' })], { masks: { m1: mask } });
    const raster = rasterOf(slide, 0, 'soft-mask')!;
    expect(raster.px).toEqual({ w: 200, h: 40 });
    const alphas = [0, 50, 100, 150, 199].map((i) => pixel(raster.png, i, 20)[3]!);
    expect(alphas[0]).toBeLessThan(3);
    for (let k = 1; k < alphas.length; k++) expect(alphas[k]).toBeGreaterThan(alphas[k - 1]!);
    expect(Math.abs(alphas[2]! - 128)).toBeLessThanOrEqual(2);
    expect(pixel(raster.png, 100, 20).slice(0, 3)).toEqual([200, 0, 0]);
  });

  it('a picture is drawn from its decoded pixels, through its matrix (y up in the unit square)', () => {
    // 2 x 2 RGB: red, green on top; blue, white below; on (10, 10)-(20, 20).
    const pic = picture([10, 10, 20, 20], { op: 4, mediaHash: 'a'.repeat(64), mask: 'm1' });
    const mask: MaskDef = { subtype: 'alpha', backdrop: null, elements: [shape({ op: 8, geom: rectPath(0, 0, 300, 200), fill: solid([0, 0, 0], 1) })], clips: {} };
    const slide = slideOf([pic], { masks: { m1: mask } });
    const pixels = { width: 2, height: 2, format: 'rgb' as const, data: Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255]) };
    const raster = rasterOf(slide, 0, 'soft-mask', { pixels: (hash) => (hash === 'a'.repeat(64) ? pixels : undefined) })!;
    expect(raster.px).toEqual({ w: 20, h: 20 });
    expect(pixel(raster.png, 2, 2)).toEqual([255, 0, 0, 255]);
    expect(pixel(raster.png, 17, 2)).toEqual([0, 255, 0, 255]);
    expect(pixel(raster.png, 2, 17)).toEqual([0, 0, 255, 255]);
    // Without its pixels nothing of it can be drawn: no raster. Below another, it is left out of the backdrop, saying so.
    expect(rasterOf(slide, 0, 'soft-mask')).toBeNull();
    const over = slideOf([{ ...pic, mask: null }, shape({ op: 5, geom: rectPath(10, 10, 10, 10), fill: solid(YELLOW), blend: 'multiply' })]);
    const raster2 = rasterOf(over, 1, 'blend-mode')!;
    expect(raster2.notes).toEqual(['picture without pixels in a raster']);
    expect(pixel(raster2.png, 2, 2)).toEqual([...YELLOW, 255]);
  });

  it('text is never rasterized: it is not made a fallback, and a backdrop leaves it out, saying so', () => {
    expect(() => fallbackOf(textline() as never, 'blend-mode')).toThrow(TypeError);
    const slide = slideOf([textline({ op: 1, bboxPt: [10, 10, 60, 30] }), shape({ op: 2, geom: rectPath(10, 10, 40, 20), fill: solid(YELLOW), blend: 'screen' })]);
    const raster = rasterOf(slide, 1, 'blend-mode')!;
    expect(raster.notes).toEqual(['text in a raster backdrop']);
    // Screen over the white page: white.
    expect(pixel(raster.png, 10, 10)).toEqual([255, 255, 255, 255]);
  });

  it('is null for an element that paints nothing on the page', () => {
    const slide = slideOf([shape({ op: 2, geom: rectPath(400, 10, 40, 20), fill: solid(YELLOW), blend: 'multiply' })]);
    expect(rasterOf(slide, 0, 'blend-mode')).toBeNull();
  });

  it('a mesh paints its triangles where its clip lets it, Gouraud-shaded', () => {
    const mesh: ShadingMesh = { type: 4, xy: [0, 0, 100, 0, 0, 100], rgb: [255, 0, 0, 255, 0, 0, 255, 0, 0], triangles: [0, 1, 2], matrix: [1, 0, 0, 1, 0, 0], bbox: null, background: null };
    const sh = shape({ op: 2, geom: null, fill: { kind: 'shading', shading: 'mesh', alpha: 1, mesh }, clip: ['c1'], bbox: [0, 0, 50, 50], clipBox: [0, 0, 50, 50] });
    const slide = slideOf([sh], { clips: { c1: { kind: 'path', geom: rectPath(0, 0, 50, 50), rule: 'nonzero', bbox: [0, 0, 50, 50] } } });
    const raster = rasterOf(slide, 0, 'shading-mesh')!;
    expect(raster.box).toEqual([0, 0, 50, 50]);
    expect(pixel(raster.png, 10, 10)).toEqual([255, 0, 0, 255]);
    // The far corner, (49.75, 49.75) pt, is still within the triangle (x + y < 100 pt).
    expect(pixel(raster.png, 99, 99)).toEqual([255, 0, 0, 255]);
  });

  it('Review Focus 3: a full-slide mesh on the largest page is one picture, its pixels capped, the scale it took reported', () => {
    expect(FALLBACK_MAX_PX).toBe(4_000_000);
    const side = 4032;
    const mesh: ShadingMesh = {
      type: 4,
      xy: [0, 0, side, 0, 0, side, side, side],
      rgb: [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255],
      triangles: [0, 1, 2, 1, 3, 2],
      matrix: [1, 0, 0, 1, 0, 0],
      bbox: null,
      background: null,
    };
    const sh = shape({ op: 2, geom: null, fill: { kind: 'shading', shading: 'mesh', alpha: 1, mesh }, bbox: [0, 0, side, side], clipBox: [0, 0, side, side], blend: 'multiply' });
    const slide = slideOf([sh], { sizePt: [side, side] });
    const raster = rasterOf(slide, 0, 'shading-mesh')!;
    expect(raster.pxPerPt).toBe(0.375);
    expect(raster.px).toEqual({ w: 1512, h: 1512 });
    expect(raster.px.w * raster.px.h).toBeLessThanOrEqual(FALLBACK_MAX_PX);
    expect(raster.box).toEqual([0, 0, side, side]);
    // Lowered limits step the scale down the same ladder: 2, 1.5, 1, 0.75, 0.5, 0.375, ...
    const small = slideOf([{ ...sh, bbox: [0, 0, 100, 100], clipBox: [0, 0, 100, 100] }], { sizePt: [100, 100] });
    expect([40_000, 22_500, 10_000, 5_625, 2_500].map((maxPx) => rasterOf(small, 0, 'shading-mesh', { maxPx })!.pxPerPt)).toEqual([2, 1.5, 1, 0.75, 0.5]);
  });

  it('Review Focus 2: the same element gives the same PNG bytes, run after run', () => {
    const slide = slideOf([
      shape({ op: 1, geom: rectPath(0, 0, 300, 200), fill: linear({ p0: [0, 0], p1: [300, 0], matrix: [1, 0, 0, 1, 0, 0] }) }),
      shape({ op: 2, geom: rectPath(20.3, 10.7, 40.1, 30.9), fill: solid(YELLOW, 0.7), blend: 'hardlight' }),
    ]);
    const a = rasterOf(slide, 1, 'blend-mode')!;
    const b = rasterOf(structuredClone(slide), 1, 'blend-mode')!;
    expect(sha256Sync(a.png)).toBe(sha256Sync(b.png));
    expect(sha256Sync(a.png)).toBe(createHash('sha256').update(a.png).digest('hex'));
  });
});

describe('sha256Sync', () => {
  it("is Node's SHA-256", () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 1000]) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 31 + 7) & 255);
      expect(sha256Sync(bytes), String(n)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });
});

describe('rasterize: hostile input stays bounded (fix round 1)', () => {
  it('a mesh past MESH_WORK_PX is not drawn: null, and the note says why', () => {
    const n = 5_000;
    const xy: number[] = [];
    const triangles: number[] = [];
    for (let t = 0; t < n; t++) {
      xy.push((t % 2000) / 10, 0, (t % 2000) / 10 + 0.05, 0, (t % 2000) / 10, 200);
      triangles.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    const mesh: ShadingMesh = { type: 4, xy, rgb: new Array(n * 9).fill(90), triangles, matrix: [1, 0, 0, 1, 0, 0], bbox: null, background: null };
    // 5,000 triangles 400 px high, one or two wide: about 2.2 M px of boxes, under MESH_WORK_PX; over a cap of 1 M
    const sh = shape({ op: 2, geom: null, fill: { kind: 'shading', shading: 'mesh', alpha: 1, mesh }, bbox: [0, 0, 300, 200] });
    const notes: string[] = [];
    expect(rasterOf(slideOf([sh]), 0, 'shading-mesh', { notes, meshWorkPx: 1_000_000 })).toBeNull();
    expect(notes).toEqual([MESH_TOO_COMPLEX_NOTE]);
    expect(rasterOf(slideOf([sh]), 0, 'shading-mesh')).not.toBeNull();
  });

  it('an element of extreme aspect is drawn at most FALLBACK_MAX_SIDE pixels a side, so its row buffers are bounded', () => {
    expect(FALLBACK_MAX_SIDE).toBe(8_192);
    const wide = shape({ op: 2, geom: rectPath(0, 0, 1_000_000, 1), fill: solid(YELLOW), blend: 'multiply', clipBox: [0, 0, 1_000_000, 10] });
    const raster = rasterOf(slideOf([wide], { sizePt: [1_000_000, 10] }), 0, 'blend-mode')!;
    expect(raster.px.w).toBeLessThanOrEqual(FALLBACK_MAX_SIDE);
    expect(raster.px.w * raster.px.h).toBeLessThanOrEqual(FALLBACK_MAX_PX);
  });

  it('the work of a slide is shared: past it a backdrop is cut, then a raster is not drawn, each with a note', () => {
    expect(RASTER_WORK_SAMPLES).toBe(8 * FALLBACK_MAX_PX * 16);
    expect(SLIDE_RASTER_WORK_SAMPLES).toBe(2 * RASTER_WORK_SAMPLES);
    const slide = slideOf([
      shape({ op: 1, geom: rectPath(0, 0, 300, 200), fill: solid(BLUE) }),
      shape({ op: 2, geom: rectPath(0, 0, 100, 100), fill: solid(YELLOW), blend: 'multiply' }),
    ]);
    // the target alone: 200 x 200 px x 16 samples, and its two sides crossing 800 sample rows each, 16 a row (final
    // review C1); the backdrop as much again
    const target = 200 * 200 * 16 + 2 * 800 * 16;
    const ample = { left: 10 * target };
    expect(rasterOf(slide, 1, 'blend-mode', { work: ample })!.notes).toEqual([]);
    expect(ample.left).toBe(10 * target - 2 * target);
    const tight = { left: target + 1 };
    const notes: string[] = [];
    const cut = rasterOf(slide, 1, 'blend-mode', { work: tight, notes })!;
    expect(cut.notes).toEqual(['raster backdrop cut']);
    expect(notes).toEqual(['raster backdrop cut']);
    // Multiply over the white page, the backdrop cut: the source colour
    expect(pixel(cut.png, 10, 10)).toEqual([...YELLOW, 255]);
    const none: string[] = [];
    expect(rasterOf(slide, 1, 'blend-mode', { work: { left: target - 1 }, notes: none })).toBeNull();
    expect(none).toEqual([RASTER_WORK_NOTE]);
  });
});

describe('rasterize: the geometry it makes is bounded (final review C1)', () => {
  /** A filled path of `n` cubics whose handles reach about ±30,000 pt: 1,024 pieces each, were they flattened. */
  const hostile = (n: number): PathSeg[] => {
    const geom: PathSeg[] = [['M', 10, 10]];
    for (let i = 0; i < n; i++) geom.push(['C', 30_000, -30_000, -30_000, 30_000, 10 + (i % 100), 10 + (i % 50)]);
    geom.push(['Z']);
    return geom;
  };
  const quick = (run: () => void, ms: number): void => {
    const heap = process.memoryUsage().heapUsed;
    const started = performance.now();
    run();
    expect(performance.now() - started, 'a hang guard').toBeLessThan(ms);
    expect(process.memoryUsage().heapUsed - heap, 'no flattened geometry kept').toBeLessThan(200_000_000);
  };

  it('the caps: RASTER_MAX_POINTS a raster, SLIDE_RASTER_POINTS a slide', () => {
    expect(RASTER_MAX_POINTS).toBe(500_000); // M6 Task 1: lowered from 1,000,000 on the web memory budget
    expect(SLIDE_RASTER_POINTS).toBe(2 * RASTER_MAX_POINTS);
  });

  it('a target of 24,000 hostile cubics (a Scene weight within budget) is not drawn: null and the note, quickly', () => {
    const slide = slideOf([shape({ op: 1, geom: hostile(24_000), fill: solid(YELLOW), blend: 'multiply' })]);
    const notes: string[] = [];
    quick(() => expect(rasterOf(slide, 0, 'blend-mode', { notes })).toBeNull(), 1_500);
    expect(notes).toEqual([RASTER_GEOMETRY_NOTE]);
    // its stroke alike, whose outline would give the box it paints in
    const stroked = slideOf([shape({ op: 1, geom: hostile(24_000), fill: null, line: lineStyle({ w: 3, join: 'round' }), blend: 'multiply' })]);
    const said: string[] = [];
    quick(() => expect(rasterOf(stroked, 0, 'blend-mode', { notes: said })).toBeNull(), 1_500);
    expect(said).toEqual([RASTER_GEOMETRY_NOTE]);
  });

  it('below a raster, filled or stroked, it is left out of the backdrop, which says so', () => {
    for (const below of [
      shape({ op: 1, geom: hostile(24_000), fill: solid(BLUE) }),
      shape({ op: 1, geom: hostile(24_000), fill: null, line: lineStyle({ w: 3 }) }),
    ]) {
      const slide = slideOf([below, shape({ op: 2, geom: rectPath(20, 10, 40, 30), fill: solid(YELLOW), blend: 'multiply' })]);
      let raster: ReturnType<typeof rasterOf> = null;
      quick(() => (raster = rasterOf(slide, 1, 'blend-mode')), 1_500);
      expect(raster!.notes).toEqual(['raster backdrop cut']);
      // Multiply over the white page, the backdrop left out: the source colour
      expect(pixel(raster!.png, 10, 10)).toEqual([...YELLOW, 255]);
    }
  });

  it('what a raster makes is taken off the slide\'s points; past what is left it is not drawn', () => {
    const slide = slideOf([shape({ op: 2, geom: rectPath(20, 10, 40, 30), fill: solid(YELLOW), blend: 'multiply' })]);
    const ample = { left: 1_000 };
    expect(rasterOf(slide, 0, 'blend-mode', { points: ample })).not.toBeNull();
    const used = 1_000 - ample.left;
    // the rect's four points, made once for its fill
    expect(used).toBe(4);
    const notes: string[] = [];
    expect(rasterOf(slide, 0, 'blend-mode', { points: { left: used - 1 }, notes })).toBeNull();
    expect(notes).toEqual([RASTER_GEOMETRY_NOTE]);
  });

  it('the rows its edges cross count as work: 100,000 edges the height of the page are not drawn, quickly', () => {
    const zigzag: PathSeg[] = [['M', 0, 0]];
    for (let i = 0; i < 100_000; i++) zigzag.push(['L', (i * 300) / 100_000, i % 2 === 0 ? 200 : 0]);
    zigzag.push(['Z']);
    const slide = slideOf([shape({ op: 1, geom: zigzag, fill: solid(YELLOW), blend: 'multiply' })]);
    const notes: string[] = [];
    quick(() => expect(rasterOf(slide, 0, 'blend-mode', { notes })).toBeNull(), 1_500);
    expect(notes).toEqual([RASTER_WORK_NOTE]);
  });
});

describe('rasterize: a picture below it as the picture pass planned it (final review I1)', () => {
  const hash = 'c'.repeat(64);
  const black = { width: 2, height: 2, format: 'rgb' as const, data: new Uint8Array(12) };
  const pixels = (h: string) => (h === hash ? black : undefined);

  it('a picture turned 90 degrees, cropped in its own frame, is drawn as the same picture in that crop as a clip', () => {
    // 100 x 60 pt in its own frame at (100, 50), turned 90 degrees about its centre (150, 80): exactly, no trigonometry
    const matrix = [0, 100, 60, 0, 120, 30];
    const { xfrm, skewed } = pictureXfrm(matrix);
    expect(xfrm.rotDeg).toBe(90);
    const base = picture([0, 0, 1, 1], { op: 1, mediaHash: hash });
    // the left half of its own frame, (100, 50)-(150, 110), lies on the slide at x 120-180, y 30-80
    const planned: PassedPicture = { ...base, matrix, xfrm, skewed, plan: { kind: 'picture', crop: [100, 50, 150, 110] } };
    const clip = { kind: 'box' as const, bbox: [120, 30, 180, 80] as [number, number, number, number] };
    const inClip: PictureEl = { ...base, matrix, xfrm, skewed, clip: ['c1'] };
    const rect = shape({ op: 2, geom: rectPath(110, 20, 80, 120), fill: solid(BLUE), blend: 'multiply' });
    const a = rasterOf(slideOf([planned, rect]), 1, 'blend-mode', { pixels })!;
    const b = rasterOf(slideOf([inClip, rect], { clips: { c1: clip } }), 1, 'blend-mode', { pixels })!;
    expect(sha256Sync(a.png)).toBe(sha256Sync(b.png));
    // within the crop (150, 50): black; past it (150, 100): blue over the white page
    expect(pixel(a.png, (150 - 110) * 2, (50 - 20) * 2)).toEqual([0, 0, 0, 255]);
    expect(pixel(a.png, (150 - 110) * 2, (100 - 20) * 2)).toEqual([...BLUE, 255]);
  });

  it('a clip-cut picture keeps all its clips for the raster: its plan is only what is written should it not be drawn', () => {
    const tri = [['M', 0, 0], ['L', 200, 0], ['L', 0, 100], ['Z']] as PathSeg[];
    // its plan (here narrower than its clips, to tell them apart) is not what the raster draws
    const pic: PassedPicture = { ...picture([0, 0, 200, 100], { op: 1, mediaHash: hash, clip: ['c1'] }), plan: { kind: 'picture', crop: [0, 0, 50, 100] }, clipCut: true };
    const rect = shape({ op: 2, geom: rectPath(50, 20, 100, 60), fill: solid(BLUE), blend: 'multiply' });
    const clips = { c1: { kind: 'path' as const, geom: tri, rule: 'nonzero' as const, bbox: [0, 0, 200, 100] as [number, number, number, number] } };
    const r = rasterOf(slideOf([pic, rect], { clips }), 1, 'blend-mode', { pixels })!;
    // below the triangle's long side (x 125, y 70 pt): blue over the white page; above it (x 60, y 30 pt): black
    expect(pixel(r.png, (125 - 50) * 2, (70 - 20) * 2)).toEqual([...BLUE, 255]);
    expect(pixel(r.png, (60 - 50) * 2, (30 - 20) * 2)).toEqual([0, 0, 0, 255]);
  });

  it('its border (M5 Task 5), which the picture pass took in, is drawn too', () => {
    const white = { width: 2, height: 2, format: 'rgb' as const, data: new Uint8Array(12).fill(255) };
    const pic: PassedPicture = { ...picture([40, 40, 140, 100], { op: 1, mediaHash: hash }), plan: { kind: 'picture', crop: null }, border: lineStyle({ w: 4, paint: solid([255, 0, 0]) }) };
    const rect = shape({ op: 2, geom: rectPath(20, 20, 140, 100), fill: solid(BLUE), blend: 'multiply' });
    const r = rasterOf(slideOf([pic, rect]), 1, 'blend-mode', { pixels: (h) => (h === hash ? white : undefined) })!;
    // on the border's left side (x 39, y 70 pt): red under blue, black; on the picture: blue over white; outside: blue
    expect(pixel(r.png, (39 - 20) * 2, (70 - 20) * 2)).toEqual([0, 0, 0, 255]);
    expect(pixel(r.png, (90 - 20) * 2, (70 - 20) * 2)).toEqual([...BLUE, 255]);
    expect(pixel(r.png, (30 - 20) * 2, (70 - 20) * 2)).toEqual([...BLUE, 255]);
  });
});

describe('rasterize: NaN budgets (M6) are past, not unlimited', () => {
  const slide = slideOf([shape({ op: 2, geom: rectPath(20, 10, 40, 30), fill: solid(YELLOW), blend: 'multiply' })]);
  it('a NaN point budget draws nothing and says the geometry budget', () => {
    const notes: string[] = [];
    expect(rasterOf(slide, 0, 'blend-mode', { points: { left: Number.NaN }, notes })).toBeNull();
    expect(notes).toEqual([RASTER_GEOMETRY_NOTE]);
  });
  it('a NaN work budget draws nothing and says the work budget', () => {
    const notes: string[] = [];
    expect(rasterOf(slide, 0, 'blend-mode', { work: { left: Number.NaN }, notes })).toBeNull();
    expect(notes).toEqual([RASTER_WORK_NOTE]);
  });
});
