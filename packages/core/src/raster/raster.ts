import type { Box, PathSeg } from '../extract/inventory';
import { localFrame, mapPath } from '../passes/frame';
import type { PassedShape } from '../passes/index';
import type { PassedPicture } from '../passes/pictures';
import { encodePng } from '../scene/png';
import type { BlendName, ClipDef, Element, FallbackEl, Fill, LineStyle, MaskDef, PictureEl, SceneSlide, ShapeEl } from '../scene/types';
import { blend, luminosity } from './blend';
import { flattenWithin, polygonsOf, Region, Scan, SS, strokeOutline, type Grid, type PointBudget, type Polygon } from './paint';
import type { AlphaStop } from '../passes/gradients';
import { gradientPaint, imagePaint, MESH_WORK_PX, meshPaint, solidPaint, type Paint, type RasterPixels } from './shading';

/**
 * The raster fallback renderer (M5 Task 2; spec §4.2 "그림 대체 렌더러", §6): one element the passes cannot write as
 * DrawingML, drawn as a picture of its own box. Never a page and never text (text over a fallback stays a text box).
 *
 * Stable for Tasks 3 and 4 (and later):
 * - `rasterize(el, ctx)`: `el` a fallback that stands for one shape or picture (`RasterFallback`, made by
 *   passes/fallbacks.ts `fallbackOf`); `ctx` its slide as the passes leave it, its place there (`index`), and the
 *   decoded pictures (`pixels`). It returns the PNG, the box it is placed exactly on (frame pt) and its size in pixels,
 *   or null when nothing of the element can be drawn (`ctx.notes` then says why, when given).
 * - The reasons a fallback is made for (`FALLBACK_REASONS`), fixed words, never deck text: `blend-mode` (a blend mode
 *   other than Normal, its own or a group's), `soft-mask` (a soft mask Task 3 cannot make stop alpha), `shading-function`
 *   and `shading-mesh` (what DrawingML has no gradient for), `clip-cut` (a clip that cuts a shape's fill and no polygon
 *   can say: Task 4 decides).
 *
 * How it draws (deterministic: the same bytes in Node and in every browser):
 * - At `PX_PER_PT` (2) pixels a pt, on the grid of whole pixels from the frame's origin, the box the element paints in
 *   (its outline's bounds) within its clip box and the page. Past `FALLBACK_MAX_PX` pixels the scale steps down (2, 1.5,
 *   1, 0.75, 0.5, ...), and the result says which it took (`pxPerPt`), which the report repeats.
 * - Coverage: 4 x 4 samples a pixel, each in or out, counted in integers (paint.ts). Fills by their rule; strokes as fill
 *   outlines; clips intersected sample by sample.
 * - Paints at each sample (shading.ts): solid, linear and radial by their formulas, function-based shadings and meshes as
 *   the triangles pdf.js made of them (Gouraud), pictures from pdf.js' decoded pixels.
 * - Alpha: the fill or line alpha, the groups' alphas, and every soft mask in force (alpha or luminosity, its own
 *   elements drawn the same way over its backdrop colour), multiplied; a soft mask the passes made stop alpha
 *   (`PassedShape.alphaStops`, final review I2) at each sample of its gradient, as the mask gives it.
 * - Blend modes (blend.ts, the 16 of PDF): composited against the backdrop, the elements below it drawn the same way
 *   over the white page within its box. The picture's colour is the blended result and its alpha the element's coverage
 *   (times its alphas and masks): over the elements below, which stay their own editable objects, PowerPoint shows what
 *   the PDF shows. A Normal element needs no backdrop: its colour is its own.
 * - Compositing is in doubles row by row (+, -, *, / and square roots only), then rounded to 8 bits once; the PNG is
 *   `encodePng`'s, and no Map or Set order feeds a sum.
 * - What it cannot draw it leaves out and says in `notes` (fixed words): text in a backdrop or soft mask, a picture
 *   whose pixels are not at hand, a tiling pattern, a shading without triangles, an element in a text clip, a mesh past
 *   its work cap, a dash pattern past its piece cap (drawn solid), a backdrop or soft mask past the work budget.
 *
 * Bounded for hostile input (fix round 1), each by a constant:
 * - memory: the output, at most `FALLBACK_MAX_PX` pixels; rows of at most `FALLBACK_MAX_SIDE` pixels (the row buffers,
 *   the accumulators, a mesh's row of samples); a few numbers for each triangle of a mesh; at most `MAX_DASH_PIECES`
 *   pieces of a dashed stroke (paint.ts), past which it is drawn solid;
 * - time: the samples the elements of one raster are drawn over (the target, its backdrop, its soft masks) count against
 *   `RASTER_WORK_SAMPLES`, and those of a slide's rasters against `SLIDE_RASTER_WORK_SAMPLES` (`RasterCtx.work`); past it
 *   a backdrop or soft mask is cut, or the raster not drawn. A mesh reaches at most `MESH_WORK_PX` pixels of triangle
 *   boxes (shading.ts), else it is not drawn.
 * - geometry (final review C1): the points a raster makes (paths flattened, stroke outlines, the polygons of clips and
 *   pictures, for its target, backdrop and soft masks alike) are counted before they are made, at most
 *   `RASTER_MAX_POINTS` a raster and `SLIDE_RASTER_POINTS` a slide (`RasterCtx.points`); and the sample rows its edges
 *   cross count as work (`Scan.edgeRows`), before any row is drawn. Past either a backdrop or soft mask is cut, and a
 *   target is not drawn (`RASTER_GEOMETRY_NOTE`, `RASTER_WORK_NOTE`). Which elements below a raster may reach it is told
 *   from their paths' points (`reachBox`), nothing flattened.
 */

/** Pixels a pt. */
export const PX_PER_PT = 2;
/** The most pixels one fallback picture has: past it the scale steps down (Review Focus 3). */
export const FALLBACK_MAX_PX = 4_000_000;
/**
 * A slide's budgets, so a hostile page stays bounded in time and memory: at most `SLIDE_RASTER_MAX` fallbacks drawn
 * (past it an effect stays as it was, its blend mode or mask dropped, and a shading unwritten: passes/fallbacks.ts), and
 * at most `SLIDE_RASTER_PX` pixels in all (each raster's cap is what is left, below `FALLBACK_MAX_PX`).
 */
export const SLIDE_RASTER_MAX = 64;
export const SLIDE_RASTER_PX = 4 * FALLBACK_MAX_PX;
/** The most pixels a side of one fallback picture has (the width of its row buffers): past it the scale steps down. */
export const FALLBACK_MAX_SIDE = 8_192;
/**
 * The most samples (pixel rows x width x 16, a layer of an element at a time) one raster's elements are drawn over, its
 * target first, then its soft masks' elements and its backdrop's (taken from just below it down): past it the rest of a
 * backdrop or soft mask is left out (`raster backdrop cut`, `raster soft mask cut`), and a target past it is not drawn
 * (`RASTER_WORK_NOTE`). Eight full-size pictures' worth.
 */
export const RASTER_WORK_SAMPLES = 8 * FALLBACK_MAX_PX * SS * SS;
/** The samples all the rasters of one slide may draw over (`RasterCtx.work`, which passes/fallbacks.ts shares). */
export const SLIDE_RASTER_WORK_SAMPLES = 2 * RASTER_WORK_SAMPLES;
export const RASTER_WORK_NOTE = 'raster past its work budget';
export const RASTER_SIZE_NOTE = 'raster past its pixel budget';
export const MESH_TOO_COMPLEX_NOTE = 'mesh too complex for a raster';
/**
 * The most points of geometry one raster makes (final review C1, module header), each counted before it is made (paint.ts
 * `PointBudget`): about 150 MB of polygons and edges at 1,000,000 points in Node while it is drawn. M6 Task 1 lowered it from 1,000,000 to
 * 500,000: a 100-page deck of slides each drawing 1 M points peaked at 1,063 MB resident in Node (the web budget is 1 GB),
 * at 500,000 points 707 MB (`scripts/m6-peak-rss.mjs`, a child process's maxRSS; docs/decisions/0009). The slide's complex vector art reaches
 * tens of thousands; 24,000 cubics whose handles reach far would be 25 M (1,024 pieces each), which ran Node out of
 * memory. Past it a backdrop or soft mask is cut (`raster backdrop cut`, `raster soft mask cut`) and a target is not
 * drawn (`RASTER_GEOMETRY_NOTE`).
 */
export const RASTER_MAX_POINTS = 500_000;
/** The points all the rasters of one slide may make (`RasterCtx.points`, which passes/fallbacks.ts shares). */
export const SLIDE_RASTER_POINTS = 2 * RASTER_MAX_POINTS;
export const RASTER_GEOMETRY_NOTE = 'raster past its geometry budget';
/**
 * The samples an edge's crossing of one sample row is counted as in a raster's work (a pixel's, final review C1): 100,000
 * edges the height of a page would be 160 M steps of a scan on a 600 x 400 pixel grid, each sorted, past 10 s.
 */
const EDGE_ROW_SAMPLES = SS * SS;
/** What a raster's part is when it would make more geometry than its points allow. */
const TOO_COMPLEX = 'too-complex';
type TooComplex = typeof TOO_COMPLEX;
/**
 * The scale never steps below this, which only bounds the loop: a page far past PowerPoint's 4032 pt (convert shrinks it
 * onto the slide) still fits `FALLBACK_MAX_SIDE` long before it (a 1,000,000 pt side at 1/128 px a pt is 7,813 px).
 */
const MIN_PX_PER_PT = 1 / 1_048_576; // 2^-20
/** The flattening tolerance, in pixels. */
const FLAT_TOL_PX = 0.05;
/** The width (pt) a hairline is taken to have for the box it paints in. */
const BOUNDS_MIN_W = 2;
/** How deep soft masks inside soft masks are followed. */
const MASK_DEPTH = 4;

/** The reasons a fallback is drawn for (module header). */
export const FALLBACK_REASONS = ['blend-mode', 'soft-mask', 'shading-function', 'shading-mesh', 'clip-cut'] as const;
export type FallbackReason = (typeof FALLBACK_REASONS)[number];

/** What a fallback that `rasterize` draws stands for. */
export type RasterSource = ShapeEl | PictureEl;

/** A fallback that may stand for one element (`of`), which `rasterize` draws (passes/fallbacks.ts `PassedFallback`). */
export interface RasterFallback extends FallbackEl {
  of?: RasterSource;
}

export interface RasterCtx {
  /** The slide as the passes leave it: its clips and masks, and the elements below the fallback, its backdrop. */
  slide: SceneSlide;
  /** The fallback's place in `slide.elements`. */
  index: number;
  /** The decoded pixels of a picture, by its media hash; undefined when not at hand. */
  pixels?: (hash: string) => RasterPixels | undefined;
  /** The most pixels it may have: `FALLBACK_MAX_PX` when absent; null past it at the least scale. */
  maxPx?: number;
  /** The slide's work left, in samples, shared by its rasters: what this one draws is taken off it. */
  work?: { left: number };
  /** The slide's points left (final review C1), shared by its rasters: what this one makes is taken off it. */
  points?: PointBudget;
  /** Where the notes go, even when nothing is drawn (they are `Raster.notes` too when something is). */
  notes?: string[];
  /** `MESH_WORK_PX` when absent (tests lower it). */
  meshWorkPx?: number;
}

export interface Raster {
  /** RGBA, 8 bits a channel, not premultiplied. */
  png: Uint8Array;
  /** The frame box (pt) the picture is placed exactly on. */
  box: Box;
  px: { w: number; h: number };
  /** The scale it was drawn at: `PX_PER_PT`, or less past `FALLBACK_MAX_PX`. */
  pxPerPt: number;
  /** What it left out, in fixed words, each once. */
  notes: string[];
}

/** The scale `k` steps down from `PX_PER_PT`: 2, 1.5, 1, 0.75, 0.5, 0.375, ... (exact binary fractions, no logarithm). */
function scaleAt(k: number): number {
  let s = PX_PER_PT;
  for (let i = 0; i < k; i++) s = i % 2 === 0 ? s * 0.75 : (s * 2) / 3;
  return s;
}

/**
 * Draws fallback `el` (module header): null when nothing of it can be drawn on the page (outside it; a picture whose
 * pixels are not at hand; a shading without triangles; a tiling pattern), which then stays unwritten and counted. Throws a
 * TypeError for a fallback that stands for no shape or picture.
 */
export function rasterize(el: RasterFallback, ctx: RasterCtx): Raster | null {
  const of = el.of;
  if (of === undefined || (of.kind !== 'shape' && of.kind !== 'picture')) throw new TypeError('rasterize: the fallback stands for no shape or picture');
  const { slide } = ctx;
  const points: PointBudget = { left: Math.min(RASTER_MAX_POINTS, ctx.points?.left ?? Infinity) };
  const pointsAtStart = points.left;
  /** The points it made taken off the slide's, on every way out. */
  const spend = (): void => {
    if (ctx.points !== undefined) ctx.points.left -= pointsAtStart - points.left;
  };
  const bounds = sourceBox(of, points);
  if (bounds === TOO_COMPLEX) {
    ctx.notes?.push(RASTER_GEOMETRY_NOTE);
    spend();
    return null;
  }
  const clipped = bounds === null ? null : meet(bounds, of.clipBox);
  const painted = clipped === null ? null : meet(clipped, [0, 0, slide.sizePt[0], slide.sizePt[1]]);
  if (painted === null) {
    spend();
    return null;
  }
  const maxPx = ctx.maxPx ?? FALLBACK_MAX_PX;
  const fits = (c: { w: number; h: number }): boolean => c.w * c.h <= maxPx && Math.max(c.w, c.h) <= FALLBACK_MAX_SIDE;
  let step = 0;
  let s = PX_PER_PT;
  let cells = gridOf(painted, s);
  while (!fits(cells) && s > MIN_PX_PER_PT) {
    s = scaleAt(++step);
    cells = gridOf(painted, s);
  }
  if (!fits(cells)) {
    ctx.notes?.push(RASTER_SIZE_NOTE);
    spend();
    return null;
  }
  const grid: Grid = { x0: cells.ix / s, y0: cells.iy / s, w: cells.w, h: cells.h, s };
  const env: Env = {
    grid,
    slide,
    pixels: ctx.pixels,
    notes: new Set(),
    tol: FLAT_TOL_PX / s,
    minW: 1 / s,
    masks: new Map(),
    building: new Set(),
    acc: new Accumulator(grid.w),
    left: Math.min(RASTER_WORK_SAMPLES, ctx.work?.left ?? Infinity),
    used: 0,
    meshWorkPx: ctx.meshWorkPx ?? MESH_WORK_PX,
    points,
  };
  /** The notes into `ctx.notes`, and what was drawn and made taken off the slide's work and points, on the way out. */
  const done = <T>(result: T): T => {
    ctx.notes?.push(...env.notes);
    if (ctx.work !== undefined) ctx.work.left -= env.used;
    spend();
    return result;
  };
  const box: Box = [grid.x0, grid.y0, (cells.ix + cells.w) / s, (cells.iy + cells.h) / s];
  const target = drawerOf(of, slide.clips, env, 'target', 0);
  if (target === TOO_COMPLEX) {
    env.notes.add(RASTER_GEOMETRY_NOTE);
    return done(null);
  }
  if (target === null) return done(null);
  if (!charge(env, target)) {
    env.notes.add(RASTER_WORK_NOTE);
    return done(null);
  }
  const mode = target.blend;
  const backdrop: Drawer[] = [];
  if (mode !== 'normal') {
    for (let k = ctx.index - 1; k >= 0; k--) {
      const d = drawerOf(slide.elements[k]!, slide.clips, env, 'backdrop', 0, box);
      if (d === null) continue;
      if (d === TOO_COMPLEX || !charge(env, d)) {
        env.notes.add('raster backdrop cut');
        break;
      }
      backdrop.unshift(d);
    }
  }
  const { w, h } = grid;
  const out = new Uint8Array(w * h * 4);
  const canvas = new Float64Array(w * 4);
  const base = new Float64Array(w * 4);
  const cover = new Float64Array(w);
  for (let j = 0; j < h; j++) {
    canvas.fill(mode === 'normal' ? 0 : 1);
    for (const d of backdrop) drawRow(d, j, canvas, env, null);
    base.set(canvas);
    cover.fill(0);
    drawRow(target, j, canvas, env, cover);
    for (let i = 0; i < w; i++) {
      const p = i * 4;
      const o = (j * w + i) * 4;
      let alpha: number;
      const rgb = [0, 0, 0];
      if (mode === 'normal') {
        alpha = canvas[p + 3]!;
        for (let c = 0; c < 3; c++) rgb[c] = canvas[p + c]!;
      } else {
        alpha = cover[i]!;
        // the colour that, at this alpha over the backdrop, gives what the PDF shows
        if (alpha > 0) for (let c = 0; c < 3; c++) rgb[c] = (canvas[p + c]! - (1 - alpha) * base[p + c]!) / alpha;
      }
      const a8 = to8(alpha);
      if (a8 === 0) continue;
      out[o] = to8(rgb[0]!);
      out[o + 1] = to8(rgb[1]!);
      out[o + 2] = to8(rgb[2]!);
      out[o + 3] = a8;
    }
  }
  return done({ png: encodePng(out, w, h, 4), box, px: { w, h }, pxPerPt: s, notes: [...env.notes] });
}

/**
 * The samples a drawer's layers are drawn over: their rows on the grid times its width, and the pixels of a mesh's
 * triangle boxes it lays out (`Paint.work`), 16 a pixel; and the sample rows their scans' edges cross (`Region.edgeRows`,
 * final review C1), `EDGE_ROW_SAMPLES` each.
 */
function workOf(d: Drawer, grid: Grid): number {
  let px = 0;
  let edgeRows = 0;
  for (const l of d.layers) {
    px += Math.max(0, Math.min(l.region.rows[1], grid.h) - l.region.rows[0]) * grid.w + (l.paint.work ?? 0);
    edgeRows += l.region.edgeRows;
  }
  return px * SS * SS + edgeRows * EDGE_ROW_SAMPLES;
}

/** Takes `n` points off a budget; false (and nothing taken) past what is left. */
function take(budget: PointBudget, n: number): boolean {
  if (!(n <= budget.left)) return false;
  budget.left -= n;
  return true;
}

/** Takes a drawer's work off the raster's budget; false (and nothing taken) when it is past what is left. */
function charge(env: Env, d: Drawer): boolean {
  const work = workOf(d, env.grid);
  if (!(work <= env.left)) return false;
  env.left -= work;
  env.used += work;
  return true;
}

/** 0..1 to 0..255, clamped, rounded half up. */
const to8 = (v: number): number => Math.min(255, Math.max(0, Math.floor(v * 255 + 0.5)));

/** The whole pixels of the grid at `s` that a box reaches. */
function gridOf(b: Box, s: number): { ix: number; iy: number; w: number; h: number } {
  const ix = Math.floor(b[0] * s);
  const iy = Math.floor(b[1] * s);
  return { ix, iy, w: Math.max(1, Math.ceil(b[2] * s) - ix), h: Math.max(1, Math.ceil(b[3] * s) - iy) };
}

/** The common part of two boxes, null when it has no area. */
function meet(a: Box, b: Box): Box | null {
  const box: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

/** The box of polygons' points; null for none. */
function polygonsBox(polys: readonly Polygon[]): Box | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of polys) {
    for (let i = 0; i < p.length; i += 2) {
      x0 = Math.min(x0, p[i]!);
      x1 = Math.max(x1, p[i]!);
      y0 = Math.min(y0, p[i + 1]!);
      y1 = Math.max(y1, p[i + 1]!);
    }
  }
  return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null;
}

const union = (a: Box | null, b: Box | null): Box | null =>
  a === null ? b : b === null ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/** The corners of a picture's unit square under its matrix. */
function unitSquare(m: readonly number[]): Polygon {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  return [e, f, a + e, b + f, a + c + e, b + d + f, c + e, d + f];
}

/** The box of a mesh's vertices in the frame. */
function meshBox(fill: Fill | null): Box | null {
  if (fill?.kind !== 'shading' || fill.mesh === null) return null;
  const { xy, matrix } = fill.mesh;
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;
  const pts: number[] = [];
  for (let i = 0; i < xy.length; i += 2) pts.push(a * xy[i]! + c * xy[i + 1]! + e, b * xy[i]! + d * xy[i + 1]! + f);
  return polygonsBox([pts]);
}

/** Where an element paints before its clips, but for a stroke: a picture's square, a mesh's vertices for an `sh`, a fill's box. */
function fillBox(el: RasterSource): Box | null {
  if (el.kind === 'picture') return polygonsBox([unitSquare(el.matrix)]);
  if (el.geom === null) {
    const mesh = meshBox(el.fill);
    return mesh === null ? el.bbox : meet(mesh, el.bbox);
  }
  return el.fill === null ? null : el.bbox;
}

/**
 * Where an element paints before its clips: its outlines' bounds (a stroke's included), a mesh's vertices for an `sh`.
 * The stroke's outline is made within `points` (final review C1): past them, `TOO_COMPLEX`.
 */
function sourceBox(el: RasterSource, points: PointBudget): Box | null | TooComplex {
  const box = fillBox(el);
  if (el.kind === 'picture' || el.geom === null || el.line === null) return box;
  // a hairline is drawn a pixel wide, at most 2 pt at the scales the box can step down to before it is past its limit;
  // the outline undashed, which holds every dash and costs no more than the path (fix round 1, I2)
  const outline = strokeOutline(el.geom, { ...el.line, dash: [] }, 0.025, BOUNDS_MIN_W, undefined, points);
  return outline === null ? TOO_COMPLEX : union(box, polygonsBox(outline));
}

/** The box of a path's points, its curves' control points included (a curve lies within their hull); null for none. */
function pathPointsBox(geom: NonNullable<ShapeEl['geom']>): Box | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const seg of geom) {
    for (let i = 1; i + 1 < seg.length; i += 2) {
      const [x, y] = [seg[i] as number, seg[i + 1] as number];
      [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
    }
  }
  return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null;
}

/**
 * A box that holds all `sourceBox` does, made of nothing (final review C1): a stroke's from its path's points grown by
 * the most its outline reaches past them, half its width (`BOUNDS_MIN_W` at least) times its miter limit for miter joins,
 * or √2 for square caps. Which elements below a raster may reach it is told by this.
 */
function reachBox(el: RasterSource): Box | null {
  const box = fillBox(el);
  const border = el.kind === 'picture' ? (el as PassedPicture).border : undefined;
  if (border !== undefined && box !== null) {
    // its border (final review I1) lies half its width out of what it shows, and reaches its corners' miters past that
    const by = border.w * Math.max(border.join === 'miter' && border.miter > 1 ? border.miter : 1, Math.SQRT2);
    return [box[0] - by, box[1] - by, box[2] + by, box[3] + by];
  }
  if (el.kind === 'picture' || el.geom === null || el.line === null) return box;
  const hull = pathPointsBox(el.geom);
  if (hull === null) return box;
  const { w, join, miter, cap } = el.line;
  const reach = (Math.max(w, BOUNDS_MIN_W) / 2) * Math.max(join === 'miter' && miter > 1 ? miter : 1, cap === 'square' ? Math.SQRT2 : 1);
  return union(box, [hull[0] - reach, hull[1] - reach, hull[2] + reach, hull[3] + reach]);
}

// ---- drawing ---------------------------------------------------------------------------------------------------------

interface Env {
  grid: Grid;
  slide: SceneSlide;
  pixels: ((hash: string) => RasterPixels | undefined) | undefined;
  notes: Set<string>;
  tol: number;
  minW: number;
  /** Each soft mask's rows, by id, once made. */
  masks: Map<string, MaskRows | null>;
  /** The masks being made: one that names itself is not followed. */
  building: Set<string>;
  acc: Accumulator;
  /** The samples this raster may still draw over (`charge`), and those it has. */
  left: number;
  used: number;
  meshWorkPx: number;
  /** The points it may still make (final review C1). */
  points: PointBudget;
}

interface Layer {
  region: Region;
  paint: Paint;
  alpha: number;
}

/** An element as the renderer draws it: its layers (a fill, a line), its group alphas, its blend mode and soft masks. */
interface Drawer {
  rows: [number, number];
  layers: Layer[];
  alpha: number;
  blend: BlendName;
  masks: MaskRows[];
}

type Role = 'target' | 'backdrop' | 'mask';

/** The blend mode an element is drawn with: its own, else its innermost group's that is not Normal. */
export function effectiveBlend(el: Element): BlendName {
  if (el.blend !== 'normal') return el.blend;
  for (let k = el.groups.length - 1; k >= 0; k--) if (el.groups[k]!.blend !== 'normal') return el.groups[k]!.blend;
  return 'normal';
}

/** The soft masks in force on an element, each once: its own (or its innermost group's) and its groups'. */
export function maskIds(el: Element): string[] {
  const ids: string[] = [];
  for (const id of [el.mask, ...el.groups.map((g) => g.mask)]) if (id !== null && !ids.includes(id)) ids.push(id);
  return ids;
}

const rectPolygon = (b: Box): Polygon => [b[0], b[1], b[2], b[1], b[2], b[3], b[0], b[3]];

/** One of a layer's own scans: polygons of the frame and the rule they are filled by. */
interface Own {
  polygons: Polygon[];
  rule: 'nonzero' | 'evenodd';
}

/**
 * What the picture pass planned of a picture (final review I1), as scans of the slide that its picture is drawn within:
 * its crop, or the shape of its clips, both in its own frame (passes/frame.ts), the shape filled even-odd as its
 * `a:path`s are (which do not overlap, but past the slide's outline budget, where the shape written is itself recorded
 * as approximate). The pass took those clips out of `clip`. None for a picture not planned or planned uncropped, nor for
 * one that stands for a `clip-cut` fallback: all its clips are kept, its plan only what is written should its raster not
 * be drawn.
 */
function plannedScans(pic: PictureEl, env: Env): Own[] | TooComplex {
  const { plan, clipCut } = pic as PassedPicture;
  if (plan === undefined || clipCut === true || (plan.kind === 'picture' && plan.crop === null)) return [];
  const frame = localFrame(pic);
  if (plan.kind === 'picture') {
    if (!take(env.points, 4)) return TOO_COMPLEX;
    const [x0, y0, x1, y1] = plan.crop!;
    const corners = [frame.fromLocal(x0, y0), frame.fromLocal(x1, y0), frame.fromLocal(x1, y1), frame.fromLocal(x0, y1)];
    return [{ polygons: [corners.flat()], rule: 'nonzero' }];
  }
  const lines = flattenWithin(mapPath(plan.geom, frame.fromLocal), env.tol, env.points);
  return lines === null ? TOO_COMPLEX : [{ polygons: polygonsOf(lines), rule: 'evenodd' }];
}

/**
 * The path of a picture's border (M5 Task 5, `PassedPicture.border`): the rect of what it shows in its own frame (its
 * crop, else its frame) grown by half the line's width, as the stroke the pass took in was (within 0.02 pt), from its top
 * left corner, clockwise on the page.
 */
function borderPath(pic: PassedPicture, border: LineStyle): PathSeg[] {
  const frame = localFrame(pic);
  const [x0, y0, x1, y1] = (pic.plan?.kind === 'picture' ? pic.plan.crop : null) ?? frame.box;
  const h = border.w / 2;
  const at = (x: number, y: number): [number, number] => frame.fromLocal(x, y);
  return [['M', ...at(x0 - h, y0 - h)], ['L', ...at(x1 + h, y0 - h)], ['L', ...at(x1 + h, y1 + h)], ['L', ...at(x0 - h, y1 + h)], ['Z']];
}

/**
 * The scans of an element's clip chain, new for each layer (a scan follows the rows once); null for a text clip (told
 * before anything is made); `TOO_COMPLEX` past the raster's points.
 */
function clipScans(ids: readonly string[], clips: Readonly<Record<string, ClipDef>>, env: Env): Scan[] | null | TooComplex {
  if (ids.some((id) => clips[id]?.kind === 'text')) return null;
  const scans: Scan[] = [];
  for (const id of ids) {
    const def = clips[id];
    if (def === undefined || def.kind === 'text') continue;
    if (def.kind === 'box') {
      if (!take(env.points, 4)) return TOO_COMPLEX;
      scans.push(new Scan([rectPolygon(def.bbox)], 'nonzero', env.grid));
    } else {
      const lines = flattenWithin(def.geom, env.tol, env.points);
      if (lines === null) return TOO_COMPLEX;
      scans.push(new Scan(polygonsOf(lines), def.rule, env.grid));
    }
  }
  return scans;
}

/**
 * A fill as a paint; null (with a note) for what the renderer does not draw. `alphas`: a gradient fill's soft mask made
 * stop alpha (`PassedShape.alphaStops`, final review I2), which its samples take, as the mask would give them.
 */
function paintOf(fill: Fill, env: Env, patternFill: boolean, alphas?: readonly AlphaStop[]): Paint | null {
  switch (fill.kind) {
    case 'solid':
      return solidPaint(fill.rgb);
    case 'linear':
    case 'radial':
      return gradientPaint(fill, alphas);
    case 'shading': {
      if (fill.mesh === null) {
        env.notes.add('shading without triangles in a raster');
        return null;
      }
      const paint = meshPaint(fill.mesh, env.grid, patternFill, env.meshWorkPx);
      if (paint === null) env.notes.add(MESH_TOO_COMPLEX_NOTE);
      return paint;
    }
    case 'tile':
      env.notes.add('tile fill in a raster');
      return null;
  }
}

/**
 * How an element is drawn, or null when nothing of it is (a hotspot; text, said in `notes`; outside `within`, a box of
 * the frame); `TOO_COMPLEX` when its geometry would go past the raster's points (final review C1). `clips` is the scope
 * its clip ids are in: the slide's, or a soft mask's.
 */
function drawerOf(el: Element, clips: Readonly<Record<string, ClipDef>>, env: Env, role: Role, depth: number, within?: Box): Drawer | null | TooComplex {
  if (el.kind === 'hotspot') return null;
  if (el.kind === 'fallback') {
    const of = (el as RasterFallback).of;
    if (of !== undefined) return drawerOf(of, clips, env, role, depth, within);
    if (within === undefined || meet(el.bbox ?? el.clipBox, within) !== null) env.notes.add(`unknown paint in a raster ${role === 'mask' ? 'soft mask' : 'backdrop'}`);
    return null;
  }
  if (el.kind === 'textline') {
    if (within === undefined || meet(el.bboxPt, within) !== null) env.notes.add(role === 'mask' ? 'text in a soft mask' : 'text in a raster backdrop');
    return null;
  }
  if (within !== undefined) {
    const b = reachBox(el);
    const clipped = b === null ? null : meet(b, el.clipBox);
    if (clipped === null || meet(clipped, within) === null) return null;
  }
  const layers: Layer[] = [];
  /** A layer's region: its clips' scans, then its own (`own`, made only after those), within the points. */
  const region = (own: () => Own[] | TooComplex): Region | null | TooComplex => {
    const scans = clipScans(el.clip, clips, env);
    if (scans === null || scans === TOO_COMPLEX) return scans;
    const made = own();
    if (made === TOO_COMPLEX) return TOO_COMPLEX;
    for (const o of made) scans.push(new Scan(o.polygons, o.rule, env.grid));
    return new Region(scans, env.grid);
  };
  /** A stroke's outline as a layer's own scan. */
  const stroked = (geom: readonly PathSeg[], line: LineStyle) => (): Own[] | TooComplex => {
    const outline = strokeOutline(geom, line, env.tol, env.minW, env.notes, env.points);
    return outline === null ? TOO_COMPLEX : [{ polygons: outline, rule: 'nonzero' }];
  };
  if (el.kind === 'picture') {
    const pixels = env.pixels?.(el.mediaHash);
    if (pixels === undefined) {
      env.notes.add('picture without pixels in a raster');
      return null;
    }
    const r = region(() => {
      if (!take(env.points, 4)) return TOO_COMPLEX;
      const plan = plannedScans(el, env);
      return plan === TOO_COMPLEX ? TOO_COMPLEX : [{ polygons: [unitSquare(el.matrix)], rule: 'nonzero' }, ...plan];
    });
    if (r === TOO_COMPLEX) return TOO_COMPLEX;
    if (r === null) {
      env.notes.add('text clip in a raster');
      return null;
    }
    layers.push({ region: r, paint: imagePaint(pixels, el.matrix, el.stencil), alpha: el.alpha });
    // its own line (M5 Task 5, `PassedPicture.border`): the stroke just around it the picture pass took in
    const border = (el as PassedPicture).border;
    if (border !== undefined) {
      const paint = paintOf(border.paint, env, true);
      const b = region(stroked(borderPath(el as PassedPicture, border), border));
      if (b === TOO_COMPLEX) return TOO_COMPLEX;
      if (b !== null && paint !== null) layers.push({ region: b, paint, alpha: border.paint.alpha });
    }
  } else {
    const geom = el.geom;
    if (el.fill !== null) {
      const paint = paintOf(el.fill, env, geom !== null, (el as PassedShape).alphaStops);
      const r = region(() => {
        if (geom === null) return [];
        const lines = flattenWithin(geom, env.tol, env.points);
        return lines === null ? TOO_COMPLEX : [{ polygons: polygonsOf(lines), rule: el.fillRule }];
      });
      if (r === TOO_COMPLEX) return TOO_COMPLEX;
      if (r === null) env.notes.add('text clip in a raster');
      else if (paint !== null) layers.push({ region: r, paint, alpha: el.fill.alpha });
    }
    if (el.line !== null && geom !== null) {
      const line = el.line;
      const paint = paintOf(line.paint, env, true);
      const r = region(stroked(geom, line));
      if (r === TOO_COMPLEX) return TOO_COMPLEX;
      if (r === null) env.notes.add('text clip in a raster');
      else if (paint !== null) layers.push({ region: r, paint, alpha: line.paint.alpha });
    }
  }
  if (layers.length === 0) return null;
  const masks: MaskRows[] = [];
  for (const id of maskIds(el)) {
    const m = maskRows(id, env, depth + 1);
    if (m !== null) masks.push(m);
  }
  let [top, end] = [env.grid.h, 0];
  for (const l of layers) {
    top = Math.min(top, l.region.rows[0]);
    end = Math.max(end, l.region.rows[1]);
  }
  return { rows: [top, Math.min(end, env.grid.h)], layers, alpha: el.groups.reduce((a, g) => a * g.alpha, 1), blend: effectiveBlend(el), masks };
}

/** Per pixel of a row: the sum of the samples' alphas and of their colours times their alphas (integers). */
class Accumulator {
  readonly a: Float64Array;
  readonly r: Float64Array;
  readonly g: Float64Array;
  readonly b: Float64Array;
  lo = Infinity;
  hi = -Infinity;
  readonly sample = [0, 0, 0, 0];

  constructor(w: number) {
    [this.a, this.r, this.g, this.b] = [new Float64Array(w), new Float64Array(w), new Float64Array(w), new Float64Array(w)];
  }

  clear(): void {
    if (this.hi >= this.lo) {
      for (const arr of [this.a, this.r, this.g, this.b]) arr.fill(0, this.lo, this.hi + 1);
    }
    this.lo = Infinity;
    this.hi = -Infinity;
  }
}

/** Gathers layer `layer`'s samples of pixel row `j` into the accumulator. */
function gather(layer: Layer, j: number, env: Env): void {
  const { grid, acc } = env;
  const s = acc.sample;
  layer.paint.row?.(j);
  const step = 1 / (SS * grid.s);
  for (let k = 0; k < SS; k++) {
    const sy = j * SS + k;
    const spans = layer.region.row(sy);
    if (spans.length === 0) continue;
    const y = grid.y0 + (sy + 0.5) * step;
    for (let n = 0; n < spans.length; n += 2) {
      const [from, to] = [spans[n]!, spans[n + 1]!];
      for (let cx = from; cx < to; cx++) {
        if (!layer.paint.at(cx, sy, grid.x0 + (cx + 0.5) * step, y, s)) continue;
        const i = cx >> 2;
        const alpha = s[3]!;
        acc.a[i]! += alpha;
        acc.r[i]! += s[0]! * alpha;
        acc.g[i]! += s[1]! * alpha;
        acc.b[i]! += s[2]! * alpha;
        if (i < acc.lo) acc.lo = i;
        if (i > acc.hi) acc.hi = i;
      }
    }
  }
}

/** The PDF's compositing (ISO 32000-2 11.3.6) of a source of colour `cs` (0..1) and alpha `as` onto pixel `p` of a row. */
function composite(row: Float64Array, p: number, cs: number[], as: number, mode: BlendName, mixed: number[]): void {
  const ab = row[p + 3]!;
  const ar = ab + as - ab * as;
  if (!(ar > 0)) return;
  const cb = [row[p]!, row[p + 1]!, row[p + 2]!];
  if (mode === 'normal') for (let c = 0; c < 3; c++) mixed[c] = cs[c]!;
  else blend(mode, cb, cs, mixed);
  const k = as / ar;
  for (let c = 0; c < 3; c++) row[p + c] = (1 - k) * cb[c]! + k * ((1 - ab) * cs[c]! + ab * mixed[c]!);
  row[p + 3] = ar;
}

/** Draws pixel row `j` of an element onto `row` (RGBA, 0..1); `cover` (when given) gathers the union of its alphas. */
function drawRow(d: Drawer, j: number, row: Float64Array, env: Env, cover: Float64Array | null): void {
  if (j < d.rows[0] || j >= d.rows[1]) return;
  const maskValues = d.masks.map((m) => m.value(j));
  const acc = env.acc;
  const cs = [0, 0, 0];
  const mixed = [0, 0, 0];
  for (const layer of d.layers) {
    if (j < layer.region.rows[0] || j >= layer.region.rows[1]) continue;
    gather(layer, j, env);
    for (let i = acc.lo; i <= acc.hi; i++) {
      const sum = acc.a[i]!;
      if (sum === 0) continue;
      cs[0] = acc.r[i]! / sum / 255;
      cs[1] = acc.g[i]! / sum / 255;
      cs[2] = acc.b[i]! / sum / 255;
      let as = (sum / (SS * SS * 255)) * layer.alpha * d.alpha;
      for (const m of maskValues) as *= m[i]!;
      if (!(as > 0)) continue;
      composite(row, i * 4, cs, as, d.blend, mixed);
      if (cover !== null) cover[i] = cover[i]! + as * (1 - cover[i]!);
    }
    acc.clear();
  }
}

/** A soft mask's value (0..1) at each pixel, a row at a time, the last row kept for the elements that share it. */
interface MaskRows {
  value(j: number): Float64Array;
}

/** The rows of soft mask `id` (made once a raster), or null when the slide has none of that id or it names itself. */
function maskRows(id: string, env: Env, depth: number): MaskRows | null {
  if (env.masks.has(id)) return env.masks.get(id)!;
  const def: MaskDef | undefined = env.slide.masks[id];
  if (def === undefined || depth > MASK_DEPTH || env.building.has(id)) return null;
  env.building.add(id);
  const drawers: Drawer[] = [];
  for (const e of def.elements) {
    const d = drawerOf(e, def.clips, env, 'mask', depth);
    if (d === null) continue;
    if (d === TOO_COMPLEX || !charge(env, d)) {
      env.notes.add('raster soft mask cut');
      break;
    }
    drawers.push(d);
  }
  env.building.delete(id);
  const w = env.grid.w;
  const row = new Float64Array(w * 4);
  const values = new Float64Array(w);
  const [br, bg, bb] = (def.backdrop ?? [0, 0, 0]).map((c) => c / 255) as [number, number, number];
  let at = -1;
  const rows: MaskRows = {
    value(j) {
      if (j === at) return values;
      at = j;
      for (let i = 0; i < w; i++) {
        if (def.subtype === 'luminosity') row.set([br, bg, bb, 1], i * 4);
        else row.fill(0, i * 4, i * 4 + 4);
      }
      for (const d of drawers) drawRow(d, j, row, env, null);
      for (let i = 0; i < w; i++) {
        const p = i * 4;
        values[i] = def.subtype === 'luminosity' ? luminosity(to8(row[p]!), to8(row[p + 1]!), to8(row[p + 2]!)) / 255 : row[p + 3]!;
      }
      return values;
    },
  };
  env.masks.set(id, rows);
  return rows;
}
