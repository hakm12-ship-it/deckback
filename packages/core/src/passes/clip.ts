import type { Box, PathSeg } from '../extract/inventory';
import type { ClipDef, Element, Note, SceneSlide, ShapeEl, TextLineEl } from '../scene/types';
import { isRectPath } from './classify';
import { fallbackOf, rasterPaints } from './fallbacks';
import { flattenedCount, pathPolygons } from './fillrule';
import type { PassedShape } from './index';
import { intersect, offPage } from './invisible';
import { loopsArea, loopsPath, REGION_FLATTEN_TOL, REGION_GRID, REGION_MAX_POINTS, regionOutline, SLIDE_REGION_WORK, type RegionBudget, type RegionOperand } from './region';
import type { Approximation } from './report';

/**
 * The clip pass. DrawingML has no clip, so each clip of a shape is dropped where it cuts nothing, folded into the shape's
 * geometry where that is exact, and else dropped and recorded (`clip-dropped`, `clip-approx`). After it a shape's `clip`
 * holds only the clips it is not written in, and those are recorded. Lowering records the shape's `approximations` with
 * the nodes it writes.
 *
 * It runs after merge (ruling M3-R28): a fill and the stroke of its path are one shape by then, whose clips are decided
 * once, at the stroke's reach. An `sh` drawn in a text clip is a fallback by then (`shadingFallbacks`, ruling M3-R27).
 *
 * A clip is taken to cut nothing where that is certain: a rect (a box clip, or a path clip that is an axis-aligned
 * rectangle) whose box holds what is painted on the page, or (M5 Task 4, region.ts) any box or path clip that leaves
 * nothing out of what shows: a fill's area, or a stroke's painted box, within the page. What lies past the page does not
 * count: nothing past the slide shows (M3-R28). A text clip never is, whose box is only the glyphs' advance boxes
 * (0002 §5).
 *
 * M5 Task 4 (ruling M3-R26's `clip-dropped`, rule 3): a fill that a box or path clip cuts is written as the intersection
 * of its area and its clips' (`clip-approx` where a curve was flattened, within 0.05 pt; polygons are exact), even-odd:
 * as its geometry when it has no line, else as its fill outline (`PassedShape.fillGeom`, fix round 1, I3), its stroke
 * kept along its path. Past the outline's caps it is a `clip-cut` fallback, the raster renderer's (passes/fallbacks.ts),
 * which stands for the shape in its clips and gives it back, `clip-dropped`, should the raster not be drawn; a shape
 * painted with a tiling pattern, which the renderer does not draw, is so given back at once (final review I3). A picture
 * in a clip is the picture pass's (Task 5 writes a path clip as a shape with a picture fill); a stroke is not cut: its
 * geometry is kept, and a clip that cuts it recorded `clip-dropped` (ruling M5-R9): its outline as a fill would be a fill,
 * not a line (S3), and a raster a picture where the PDF has none (S1).
 *
 * Bounded per slide (fix round 1, I1): a rect clip is judged by boxes alone; a path clip's polygons are made once for the
 * slide; and the outlines of a slide spend at most `SLIDE_REGION_WORK` steps (region.ts; this pass's own, the picture
 * pass and the fill rule have theirs, final review Minor 2), past which a shape's clips are
 * dropped and recorded `clip-dropped` as before M5 Task 4, and the slide has the note `CLIP_BUDGET_NOTE`.
 */

/** The note of a slide whose clip outlines went past `SLIDE_REGION_WORK` (fix round 1, I1). */
export const CLIP_BUDGET_NOTE = 'clip outlines past the slide budget';

/**
 * What is left out of a region narrower than this (pt) is not a cut: the snap of two operands' points to the grid can
 * leave a sliver along a side they share (a fill's side along a slanted clip side).
 */
const SLIVER_PT = 2 / REGION_GRID;

/** How far (pt, the Scene's precision) a box may stick out of a clip and still count as within it. */
const EPS = 0.001;

const contains = (outer: Box, inner: Box): boolean =>
  outer[0] <= inner[0] + EPS && outer[1] <= inner[1] + EPS && outer[2] >= inner[2] - EPS && outer[3] >= inner[3] - EPS;

/** Whether `outer` holds the part of `inner` on the page `page`; it does when none of `inner` is on the page. */
export function holds(outer: Box, inner: Box, page: Box): boolean {
  const seen = intersect(inner, page);
  return seen === null || contains(outer, seen);
}

/** The rect a clip is, when it is one: a box, or a path that is an axis-aligned rectangle; else null. */
export function rectOf(def: ClipDef): Box | null {
  if (def.kind === 'box') return def.bbox;
  if (def.kind === 'path' && isRectPath(def.geom)) return def.bbox;
  return null;
}

/** A box as an operand of a region (region.ts): its polygon (pt, x0 y0 x1 y1 ...), nonzero. */
export const boxOperand = ([x0, y0, x1, y1]: Box): RegionOperand => ({ polygons: [[x0, y0, x1, y0, x1, y1, x0, y1]], rule: 'nonzero' });

/**
 * A box or path clip as an operand of a region (region.ts): its path's polygons under its rule, or its box; null for a path
 * past `REGION_MAX_POINTS` (`pathPolygons`, nothing made). Also the hook for a picture's clips (Task 5): `regionOutline`
 * of its clips' operands, `'all'`, is the shape a picture fill fills.
 */
export function clipOperand(def: Exclude<ClipDef, { kind: 'text' }>): RegionOperand | null {
  if (def.kind === 'box') return boxOperand(def.bbox);
  const polygons = pathPolygons(def.geom);
  return polygons === null ? null : { polygons, rule: def.rule };
}

/** What the clip pass keeps for a slide: its clips and page, each clip's rect and operand once made, its budget. */
interface ClipCtx {
  clips: Record<string, ClipDef>;
  page: Box;
  operands: Map<string, RegionOperand | null>;
  /** Each clip's rect (`rectOf`), found once: telling a path of many points from a rect reads all of them. */
  rects: Map<string, Box | null>;
  budget: RegionBudget;
  /** Whether some shape found the budget spent (the slide's note). */
  spent: boolean;
}

/** A clip's operand, made once for the slide. */
function operandOf(id: string, def: Exclude<ClipDef, { kind: 'text' }>, ctx: ClipCtx): RegionOperand | null {
  const known = ctx.operands.get(id);
  if (known !== undefined) return known;
  const made = clipOperand(def);
  ctx.operands.set(id, made);
  return made;
}

/** Whether a path has a curve, which an outline flattens (`clip-approx`; the picture pass's too). */
export const curved = (geom: readonly PathSeg[]): boolean => geom.some((seg) => seg[0] === 'C');

/**
 * Whether `clip` leaves something of `subject` out on the page: `'too-large'` (or a subject past the cap, null) when that
 * cannot be told, `'over-budget'` past the slide's budget. A sliver narrower than `SLIVER_PT` is nothing. A subject given
 * as a function is made only past those (final review Minor 3: a slide past its budget flattens no more paths).
 */
function leavesOut(subject: RegionOperand | (() => RegionOperand) | null, clip: RegionOperand | null, ctx: ClipCtx): boolean | 'too-large' | 'over-budget' {
  if (subject === null || clip === null) return 'too-large';
  if (!(ctx.budget.left > 0)) return 'over-budget';
  const onPage: RegionOperand = boxOperand(ctx.page);
  const left = regionOutline([typeof subject === 'function' ? subject() : subject, onPage, clip], (b) => b[0]! && b[1]! && !b[2]!, ctx.budget);
  if (typeof left === 'string') return left;
  let perimeter = 0;
  for (const loop of left.loops) {
    const n = loop.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [dx, dy] = [loop[2 * j]! - loop[2 * i]!, loop[2 * j + 1]! - loop[2 * i + 1]!];
      perimeter += Math.sqrt(dx * dx + dy * dy); // products and a square root: alike in every engine
    }
  }
  return Math.abs(loopsArea(left.loops)) > SLIVER_PT * perimeter;
}

/** A rect as a path, clockwise on the page from its top left corner (as `re` gives it, y down). */
export function rectGeom([x0, y0, x1, y1]: Box): PathSeg[] {
  return [['M', x0, y0], ['L', x1, y0], ['L', x1, y1], ['L', x0, y1], ['Z']];
}

/**
 * The values one coordinate of a cubic (ends p0, p3, handles p1, p2) takes where it turns, strictly between its ends.
 * Products only, no powers: what they give decides a clip, and so how many nodes are written, and engines may round a
 * power differently (Global Constraints, Determinism).
 */
function turns(p0: number, p1: number, p2: number, p3: number): number[] {
  // the derivative over 3: a t² + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const ts: number[] = [];
  if (a === 0) {
    if (b !== 0) ts.push(-c / b);
  } else {
    const disc = b * b - 4 * a * c;
    if (disc >= 0) ts.push((-b + Math.sqrt(disc)) / (2 * a), (-b - Math.sqrt(disc)) / (2 * a));
  }
  return ts
    .filter((t) => t > 0 && t < 1)
    .map((t) => {
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    });
}

/**
 * The box a path covers: its points and the curves' own extent, not their handles' (the Scene's `bbox` holds the
 * handles, which may reach far past the curve: a heart near the edge of the page would seem cut by the page's clip).
 */
function pathBounds(geom: readonly PathSeg[]): Box {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number): void => {
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  };
  let [cx, cy] = [0, 0];
  for (const seg of geom) {
    if (seg[0] === 'M' || seg[0] === 'L') {
      [cx, cy] = [seg[1], seg[2]];
      add(cx, cy);
    } else if (seg[0] === 'C') {
      const [, ax, ay, bx, by, ex, ey] = seg;
      for (const x of turns(cx, ax, bx, ex)) add(x, cy);
      for (const y of turns(cy, ay, by, ey)) add(cx, y);
      [cx, cy] = [ex, ey];
      add(cx, cy);
    }
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** The shape with its clips now `clip` (in the order of its chain) and `approximations` recorded, if any. */
function withClips(el: ShapeEl, clip: readonly string[], approximations: Approximation[], over: Partial<PassedShape> = {}): PassedShape {
  const kept = el.clip.filter((id) => clip.includes(id));
  return { ...el, ...over, clip: kept, ...(approximations.length > 0 ? { approximations } : {}) };
}

/**
 * A shape with a path, in its clips (each a clip of `ctx.clips`), on the page:
 * - a rect clip whose box holds what is painted on the page (`pathBounds`, a stroke's half width added) cuts nothing and
 *   is dropped; so is any box or path clip that leaves nothing out of what shows on the page (M5 Task 4): of the fill's
 *   area and of a stroke's painted box. A rect clip is judged by these boxes alone, the fill's being its area's;
 * - a filled axis-aligned rect with no line, whose other clips are rects, becomes their intersection (none: it is dropped,
 *   null). A stroke is not folded, nor a fill merged with its stroke: the outline would be drawn along the cut;
 * - any other fill becomes the intersection of its area and the clips that cut it, its geometry with no line (none:
 *   dropped, null), else its fill outline (`fillGeom`); `clip-approx` where a curve was flattened; past the outline's caps
 *   a `clip-cut` fallback (the module comment);
 * - a stroke keeps its path; the clips that cut it stay, recorded `clip-dropped` (ruling M5-R9). So does a text clip,
 *   always, and every clip of a shape met past the slide's budget.
 */
function pathClips(el: ShapeEl, geom: PathSeg[], ctx: ClipCtx): Element | null {
  const { clips, page } = ctx;
  const bounds = pathBounds(geom);
  const reach = el.line === null ? 0 : el.line.w / 2;
  const painted: Box = [bounds[0] - reach, bounds[1] - reach, bounds[2] + reach, bounds[3] + reach];
  const text: string[] = [];
  const real: { id: string; def: Exclude<ClipDef, { kind: 'text' }>; rect: Box | null }[] = [];
  for (const id of el.clip) {
    const def = clips[id];
    if (def === undefined || def.kind === 'text') {
      text.push(id);
      continue;
    }
    let rect = ctx.rects.get(id);
    if (rect === undefined) ctx.rects.set(id, (rect = rectOf(def)));
    if (rect !== null && holds(rect, painted, page)) continue;
    real.push({ id, def, rect });
  }
  const recorded: Approximation[] = text.length > 0 ? ['clip-dropped'] : [];
  if (real.length === 0) return withClips(el, text, recorded);
  const dropped = (): PassedShape => withClips(el, [...text, ...real.map((c) => c.id)], recorded.length > 0 ? recorded : ['clip-dropped']);
  const overBudget = (): PassedShape => {
    ctx.spent = true;
    return dropped();
  };

  // rule 1: which clips cut the fill's area, and which the painted box, on the page
  const fill = el.fill !== null;
  const line = el.line !== null;
  // the fill's polygons (`pathPolygons`): whether they are past the points cap counted first, nothing made, and they made
  // only once an outline asks for them (final review Minor 3)
  const fits = fill && flattenedCount(geom, REGION_FLATTEN_TOL, REGION_MAX_POINTS) <= REGION_MAX_POINTS;
  let made: RegionOperand | undefined;
  const fillOperand = (): RegionOperand => (made ??= { polygons: pathPolygons(geom)!, rule: el.fillRule });
  const fillOp = fits ? fillOperand : null;
  const boxOp: RegionOperand = boxOperand(painted);
  const cutFill: typeof real = [];
  const cutLine: typeof real = [];
  let tooLarge = false;
  for (const c of real) {
    if (c.rect !== null) {
      if (fill && !holds(c.rect, bounds, page)) cutFill.push(c);
      if (line) cutLine.push(c);
      continue;
    }
    const op = operandOf(c.id, c.def, ctx);
    for (const [want, subject, list] of [
      [fill, fillOp, cutFill],
      [line, boxOp, cutLine],
    ] as const) {
      if (!want) continue;
      const out = leavesOut(subject, op, ctx);
      if (out === 'over-budget') return overBudget();
      if (out === 'too-large') tooLarge = true;
      if (out !== false) list.push(c);
    }
  }
  if (cutFill.length === 0 && cutLine.length === 0) return withClips(el, text, recorded);
  const strokeCut: Approximation[] = cutLine.length > 0 && !recorded.includes('clip-dropped') ? ['clip-dropped'] : [];
  const kept = [...text, ...cutLine.map((c) => c.id)];
  if (cutFill.length === 0) return withClips(el, kept, [...recorded, ...strokeCut]);

  if (!line && isRectPath(geom) && cutFill.every((c) => c.rect !== null)) {
    let box: Box | null = el.bbox;
    for (const c of cutFill) box = box === null ? null : intersect(box, c.rect!);
    if (box === null || box[2] - box[0] <= 0 || box[3] - box[1] <= 0) return null;
    return withClips(el, text, recorded, { geom: rectGeom(box), bbox: box });
  }
  const ops = cutFill.map((c) => operandOf(c.id, c.def, ctx));
  if (!(ctx.budget.left > 0)) return overBudget();
  const cut =
    tooLarge || fillOp === null || ops.some((op) => op === null)
      ? 'too-large'
      : regionOutline([fillOperand(), ...(ops as RegionOperand[])], 'all', ctx.budget);
  if (cut === 'over-budget') return overBudget();
  if (cut === 'too-large') {
    const of: PassedShape = { ...el, approximations: recorded.includes('clip-dropped') ? recorded : [...recorded, 'clip-dropped'], clipCut: true };
    // a shape painted with a tiling pattern, which the renderer does not draw, is that shape (final review I3)
    return rasterPaints(el) ? fallbackOf(of, 'clip-cut') : of;
  }
  const flattened: Approximation[] = curved(geom) || cutFill.some((c) => c.def.kind === 'path' && curved(c.def.geom)) ? ['clip-approx'] : [];
  const outline = loopsPath(cut.loops);
  if (!line) {
    if (cut.loops.length === 0) return null;
    return withClips(el, text, [...recorded, ...flattened], { geom: outline, fillRule: 'evenodd', bbox: pathBounds(outline) });
  }
  return withClips(el, kept, [...recorded, ...strokeCut, ...flattened], { fillGeom: outline });
}

/**
 * An `sh` (no path: it paints its whole clip) takes its geometry from its clips, on the page `page`. It has no text clip:
 * an `sh` in one is a fallback (`shadingFallbacks`, ruling M3-R27).
 * - A rect clip that holds another of its clips on the page (that clip's `pathBounds`) cuts nothing more and is dropped
 *   (the outermost first, so of two equal rects the inner stays).
 * - When only rects are left (or nothing), it paints their intersection: its `bbox`, which the walker makes the box of
 *   its clip. That rect, exactly.
 * - Else it takes the geometry and rule of the innermost clip left. When another is left too, that is only near what the
 *   PDF paints: `clip-approx`, the others kept in `clip`. So it is when its `bbox` does not hold that clip on the page:
 *   under a soft mask of its own the walker narrows `bbox` to the shading's own bounds (0002 §10).
 * - A gap, not recorded: a shading's own /BBox (or, unextended, the reach of its gradient) bounds what it paints, and the
 *   walker looks at it only under a soft mask. Elsewhere an axial or radial shading whose /BBox is smaller than its clip
 *   is written over the whole clip.
 * - A clip the slide does not hold (not expected) is dropped and recorded `clip-dropped`.
 */
function shClips(el: ShapeEl, clips: Record<string, ClipDef>, page: Box): PassedShape {
  const unknown: string[] = [];
  const region: { id: string; def: Exclude<ClipDef, { kind: 'text' }>; rect: Box | null; bounds: Box }[] = [];
  for (const id of el.clip) {
    const def = clips[id];
    if (def === undefined || def.kind === 'text') unknown.push(id);
    else region.push({ id, def, rect: rectOf(def), bounds: def.kind === 'path' ? pathBounds(def.geom) : def.bbox });
  }
  const live = region.map(() => true);
  region.forEach((c, i) => {
    if (c.rect !== null && region.some((o, j) => j !== i && live[j] && holds(c.rect!, o.bounds, page))) live[i] = false;
  });
  const left = region.filter((_, i) => live[i]);
  const recorded: Approximation[] = unknown.length > 0 ? ['clip-dropped'] : [];
  if (left.every((c) => c.rect !== null)) {
    return withClips(el, unknown, recorded, { geom: rectGeom(el.bbox), fillRule: 'nonzero' });
  }
  const inner = left[left.length - 1]!;
  const others = left.slice(0, -1).map((c) => c.id);
  const bbox = inner.def.bbox;
  if (others.length > 0 || !holds(el.bbox, inner.bounds, page)) recorded.push('clip-approx');
  const geom = inner.def.kind === 'path' ? inner.def.geom : rectGeom(bbox);
  const fillRule = inner.def.kind === 'path' ? inner.def.rule : 'nonzero';
  return withClips(el, [...unknown, ...others], recorded, { geom, fillRule, bbox });
}

/** A text line loses the rect clips that hold its box on the page; the rest is Task 8's, which writes text. */
function textClips(el: TextLineEl, clips: Record<string, ClipDef>, page: Box): TextLineEl {
  if (el.clip.length > 0 && intersect(el.bboxPt, page) === null) return { ...el, clip: [] }; // M8: none of it shows
  const kept = el.clip.filter((id) => {
    const def = clips[id];
    const rect = def === undefined ? null : rectOf(def);
    return rect === null || !holds(rect, el.bboxPt, page);
  });
  return kept.length === el.clip.length ? el : { ...el, clip: kept };
}

/**
 * The pass, over the slide's elements (`slide.clips` holds their clips; the page is `[0, 0, ...slide.sizePt]`): shapes as
 * `pathClips` and `shClips` say, text lines as `textClips`; a shape with a path or a text line wholly past the page
 * (M8 round 1a, kept by `dropInvisible`) loses every clip, none recorded: none of it shows. Left as they are: a shape painted with a function-based
 * shading or a mesh, and an `sh` in a text clip, which are fallbacks in `runPasses` (`shadingFallbacks`, which keep their
 * clips for the raster); pictures, the picture pass's (Task 7); links and fallbacks. `budget`: the steps its outlines may
 * spend, the slide's `SLIDE_REGION_WORK` when absent (the elements of undrawn fallbacks share one of their own,
 * index.ts `revertPasses`). Its note, once a slide. A new slide; the input is not changed.
 */
export function resolveClips(slide: SceneSlide, notes: Note[] | null = null, budget: RegionBudget = { left: SLIDE_REGION_WORK }): SceneSlide {
  const page: Box = [0, 0, slide.sizePt[0], slide.sizePt[1]];
  const ctx: ClipCtx = { clips: slide.clips, page, operands: new Map(), rects: new Map(), budget, spent: false };
  const elements: Element[] = [];
  for (const el of slide.elements) {
    if (el.kind === 'textline') {
      elements.push(textClips(el, slide.clips, page));
      continue;
    }
    if (el.kind !== 'shape' || el.fill?.kind === 'shading' || el.line?.paint.kind === 'shading') {
      elements.push(el);
      continue;
    }
    if (el.clip.length > 0 && offPage(el, slide.sizePt)) {
      elements.push(withClips(el, [], [])); // M8 round 1a: wholly past the page, none of it shows: no clip cuts it
      continue;
    }
    if (el.geom === null) {
      const inText = el.clip.some((id) => slide.clips[id]?.kind === 'text');
      elements.push(inText ? el : shClips(el, slide.clips, page));
      continue;
    }
    if (el.clip.length === 0) {
      elements.push(el);
      continue;
    }
    const out = pathClips(el, el.geom, ctx);
    if (out !== null) elements.push(out);
  }
  if (!ctx.spent || slide.notes.some((n) => n.op === 'clip' && n.detail === CLIP_BUDGET_NOTE)) return { ...slide, elements };
  const note: Note = { opIndex: 0, op: 'clip', detail: CLIP_BUDGET_NOTE };
  if (notes !== null) notes.push({ ...note });
  return { ...slide, elements, notes: [...slide.notes, note] };
}
