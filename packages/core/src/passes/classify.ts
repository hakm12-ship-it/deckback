import type { Box, PathSeg } from '../extract/inventory';
import type { Element, SceneSlide, ShapeEl } from '../scene/types';
import { splitSubpaths } from './fillrule';
import { intersect, paintBox, paints } from './invisible';
import type { PageClass } from './report';

/**
 * The two classifiers (ruling M3-R2): the page's class (`classifyPage`, reported only in M3) and each shape's kind
 * (`shapeKind`, which lowering writes it as).
 */

// ---- page class ---------------------------------------------------------------------------------------------------

/** Paper a slide may have been printed on, pt, portrait (A4 is 210 x 297 mm). */
const PAPER: readonly [number, number][] = [
  [595.276, 841.89],
  [612, 792],
];
const PAPER_TOL = 1; // pt
const ASPECTS = [16 / 9, 4 / 3];
const ASPECT_TOL = 0.01;
const CENTRE_TOL = 1; // pt
const IMAGE_COVER = 0.9;
const SHAPE_SHARE = 0.01;
/**
 * The most pictures whose union is measured: the measure is quadratic in their number, and a slide may hold 100,000
 * elements (ELEMENT_BUDGET). Past it, the largest are measured, which can only say less than they cover.
 */
const UNION_MAX = 2000;

const area = (b: Box): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/** The area of the union of boxes: across each strip between two x edges, the merged y spans of the boxes there. */
export function unionArea(boxes: readonly Box[]): number {
  const xs = [...new Set(boxes.flatMap((b) => [b[0], b[2]]))].sort((a, b) => a - b);
  let total = 0;
  for (let i = 0; i + 1 < xs.length; i++) {
    const [x0, x1] = [xs[i]!, xs[i + 1]!];
    const spans = boxes.filter((b) => b[0] <= x0 && b[2] >= x1 && b[3] > b[1]).map((b) => [b[1], b[3]] as const);
    spans.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [y0, y1] of spans) {
      if (y1 <= end) continue;
      covered += y1 - Math.max(y0, end);
      end = y1;
    }
    total += covered * (x1 - x0);
  }
  return total;
}

/**
 * Where an element paints on the page: its paint box (a stroke reaching half its width past its path) within its clip box
 * and the page; null where it paints nothing.
 */
function onPage(el: Element, page: Box): Box | null {
  const seen = intersect(paintBox(el, (line) => line.w / 2), el.clipBox);
  return seen === null ? null : intersect(seen, page);
}

/** Whether an element puts paint on the page (a link, invisible text and an invisible shape do not). */
function painting(el: Element): boolean {
  switch (el.kind) {
    case 'shape':
      return paints(el);
    case 'textline':
      return el.runs.some((r) => r.fillMode !== 'noFill' && r.fillMode !== 'clip');
    case 'hotspot':
      return false;
    case 'picture':
    case 'fallback':
      return true;
  }
}

function imageOnly(slide: SceneSlide, page: Box): boolean {
  const pageArea = area(page);
  if (slide.elements.some((el) => el.kind === 'textline')) return false;
  const pictures: Box[] = [];
  for (const el of slide.elements) {
    const box = onPage(el, page);
    if (box === null) continue;
    if (el.kind === 'picture') pictures.push(box);
    else if (el.kind === 'shape' && paints(el) && area(box) > SHAPE_SHARE * pageArea) return false;
  }
  const measured =
    pictures.length <= UNION_MAX
      ? pictures
      : pictures
          .map((box, i) => ({ box, i }))
          .sort((a, b) => area(b.box) - area(a.box) || a.i - b.i)
          .slice(0, UNION_MAX)
          .map((p) => p.box);
  return unionArea(measured) >= IMAGE_COVER * pageArea;
}

function printFrame(slide: SceneSlide, page: Box): boolean {
  const [w, h] = slide.sizePt;
  const paper = PAPER.some(([pw, ph]) => (Math.abs(w - pw) <= PAPER_TOL && Math.abs(h - ph) <= PAPER_TOL) || (Math.abs(w - ph) <= PAPER_TOL && Math.abs(h - pw) <= PAPER_TOL));
  if (!paper) return false;
  let all: Box | null = null;
  for (const el of slide.elements) {
    if (!painting(el)) continue;
    const box = onPage(el, page);
    if (box === null) continue;
    all = all === null ? box : [Math.min(all[0], box[0]), Math.min(all[1], box[1]), Math.max(all[2], box[2]), Math.max(all[3], box[3])];
  }
  if (all === null || all[3] - all[1] <= 0) return false;
  const centred = Math.abs((all[0] + all[2]) / 2 - w / 2) <= CENTRE_TOL && Math.abs((all[1] + all[3]) / 2 - h / 2) <= CENTRE_TOL;
  const aspect = (all[2] - all[0]) / (all[3] - all[1]);
  return centred && ASPECTS.some((a) => Math.abs(aspect / a - 1) <= ASPECT_TOL);
}

/**
 * The page's class:
 * - `image-only`: no text line, the pictures cover at least 90 % of the page (their union, within their clips; of the
 *   largest `UNION_MAX` when there are more), and no painting shape covers more than 1 % of it;
 * - `print-frame`: the page is A4 or Letter (either way up) within 1 pt, and the box of everything painted is centred on
 *   it within 1 pt with an aspect of 16:9 or 4:3 within 1 % (a slide printed to PDF, its frame or background included);
 * - else `vector`.
 */
export function classifyPage(slide: SceneSlide): PageClass {
  const page: Box = [0, 0, slide.sizePt[0], slide.sizePt[1]];
  if (area(page) === 0) return 'vector';
  if (imageOnly(slide, page)) return 'image-only';
  if (printFrame(slide, page)) return 'print-frame';
  return 'vector';
}

// ---- shape kind ---------------------------------------------------------------------------------------------------

/** How lowering writes a shape: the rect preset, a connector (`p:cxnSp` line) or a custGeom with its curves. */
export type ShapeKind = 'rect' | 'line' | 'custom';

type Dir = 'E' | 'S' | 'W' | 'N';
const TURN_CW: Record<Dir, Dir> = { E: 'S', S: 'W', W: 'N', N: 'E' };
const TURN_CCW: Record<Dir, Dir> = { E: 'N', N: 'W', W: 'S', S: 'E' };

/** The direction of an axis-aligned step on the page (y down), null when it is not one. */
function direction(x0: number, y0: number, x1: number, y1: number): Dir | null {
  if (y0 === y1 && x1 !== x0) return x1 > x0 ? 'E' : 'W';
  if (x0 === x1 && y1 !== y0) return y1 > y0 ? 'S' : 'N';
  return null;
}

/**
 * Whether a shape is an axis-aligned rectangle: one subpath of straight lines, closed (a fill closes by itself, a stroke
 * needs its `Z`), whose sides, a repeated point dropped and sides of the same direction joined (a turn of 0), are four,
 * each turning the same way by 90 degrees. A dashed stroke must also start at the bottom left corner and go up first, as
 * the preset's dashes do, since its dashes start where its path does (measured, M5 Task 4: PowerPoint draws the rect
 * preset's dashes exactly as those of an open path from its bottom left corner, up, right, down and left; not from the
 * top left corner of its path, `moveTo l t`, which M3 took).
 */
export function isRect(shape: Pick<ShapeEl, 'geom' | 'line'>): boolean {
  const subs = splitSubpaths(shape.geom ?? []);
  if (subs.length !== 1) return false;
  const sub = subs[0]!;
  if (sub.some((seg) => seg[0] === 'C')) return false;
  const closed = sub[sub.length - 1]![0] === 'Z';
  if (shape.line !== null && !closed) return false;
  const pts: [number, number][] = [];
  for (const seg of sub) {
    if (seg[0] === 'Z') continue;
    const last = pts[pts.length - 1];
    if (last === undefined || last[0] !== seg[1] || last[1] !== seg[2]) pts.push([seg[1], seg[2]]);
  }
  if (pts.length > 1 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop();
  if (pts.length < 4) return false;
  const dirs: Dir[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [a, b] = [pts[i]!, pts[(i + 1) % pts.length]!];
    const d = direction(a[0], a[1], b[0], b[1]);
    if (d === null) return false;
    if (dirs[dirs.length - 1] !== d) dirs.push(d);
  }
  if (dirs.length > 1 && dirs[0] === dirs[dirs.length - 1]) dirs.pop();
  if (dirs.length !== 4) return false;
  const turn = TURN_CW[dirs[0]!] === dirs[1] ? TURN_CW : TURN_CCW;
  if (!dirs.every((d, i) => turn[d] === dirs[(i + 1) % 4])) return false;
  if (shape.line !== null && shape.line.dash.length > 0) {
    const [x, y] = pts[0]!;
    const left = pts.reduce((m, p) => Math.min(m, p[0]), Infinity);
    const bottom = pts.reduce((m, p) => Math.max(m, p[1]), -Infinity);
    if (x !== left || y !== bottom || dirs[0] !== 'N' || turn !== TURN_CW) return false;
  }
  return true;
}

/** Whether a path, filled (so closed by itself), is an axis-aligned rectangle (`isRect`): a clip path that is a box. */
export const isRectPath = (geom: PathSeg[]): boolean => isRect({ geom, line: null });

/** Whether a shape is one open straight segment of some length, stroked and not filled. */
function isLine(shape: ShapeEl): boolean {
  const geom = shape.geom;
  if (geom === null || shape.fill !== null || shape.line === null || geom.length !== 2) return false;
  const [m, l] = geom as [PathSeg, PathSeg];
  return m[0] === 'M' && l[0] === 'L' && (m[1] !== l[1] || m[2] !== l[2]);
}

/**
 * A shape's kind: a closed axis-aligned four-corner path is `rect` (`isRect`), and so is a shape with no path (`sh`,
 * which paints its clip: its box); a single open stroked segment with no fill is `line`; anything else is `custom`, its
 * curves kept.
 */
export function shapeKind(shape: ShapeEl): ShapeKind {
  if (shape.geom === null) return 'rect';
  if (isLine(shape)) return 'line';
  if (isRect(shape)) return 'rect';
  return 'custom';
}

/** The pass: every shape gets its `shapeKind`. A new slide; the input is not changed. */
export function classifyShapes(slide: SceneSlide): SceneSlide {
  const elements = slide.elements.map((el) => (el.kind === 'shape' ? { ...el, shapeKind: shapeKind(el) } : el));
  return { ...slide, elements };
}
