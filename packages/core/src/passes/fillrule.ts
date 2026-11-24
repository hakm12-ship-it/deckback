import type { Box, PathSeg } from '../extract/inventory';
import type { SceneSlide, ShapeEl } from '../scene/types';
import type { PassedShape } from './index';
import { loopsPath, REGION_FLATTEN_TOL, REGION_MAX_POINTS, regionOutline, SLIDE_REGION_WORK, type RegionBudget } from './region';
import { approximate, type SlideReport } from './report';

/**
 * The fill rule (0001 M0-5, Review Focus 3). PowerPoint fills each `a:path` of a shape even-odd, whatever the direction
 * of its subpaths, and a shape fills the union of its `a:path`s. A PDF even-odd fill is therefore one `a:path`. A nonzero
 * fill is split into `a:path`s whose union is the nonzero area:
 *
 * 1. Every subpath is flattened, closed as a fill closes it, to a polygon (curves to within `FLATTEN_TOL` pt). One with
 *    no area (all its points on one line) fills nothing either way and is left out of steps 2 to 5; it rides in the
 *    first `a:path`, where even-odd gains nothing from it.
 * 2. The polygons are tested for crossing, each with itself and each pair. Touching counts as crossing: a shared edge
 *    or corner is not proven harmless.
 * 3. If none crosses, every polygon is simple and they nest. A polygon's region (inside it, outside its children) has
 *    the winding of the sum of the directions of the polygons that contain it, itself included; it is filled when that
 *    is not 0. If filled is the same as "inside an odd number of polygons" everywhere, even-odd is nonzero: one
 *    `a:path`. Otherwise there is one `a:path` per connected filled area: its outer polygon (filled, its parent not),
 *    with every polygon of an unfilled region whose parent region belongs to that area. Even-odd fills exactly that
 *    area, as those polygons neither nest nor cross. The filled polygons inside the area are not needed for the fill.
 * 4. If some cross but every polygon is simple and all run the same way, the nonzero area is the union of their insides:
 *    one `a:path` per subpath.
 * 5. Otherwise, or when the path is too large to check (`MAX_POINTS`, `MAX_TESTS`), one `a:path`, approximate.
 *
 * Exact up to the flattening: polygons closer than `FLATTEN_TOL` may be taken to touch, or not.
 *
 * M5 Task 4, the pass (`fillRule`): where that plan is approximate (step 5: a subpath crosses itself, as PowerPoint's
 * own outlined connectors and arrows on atlas lines/06-11 and shapes/20 do, or crossing subpaths run both ways), or where
 * its `a:path`s overlap (step 4) under an alpha below 1 (PowerPoint composites each `a:path` on its own: measured, two at
 * 50 % are darker where they overlap), the fill is the outline of its nonzero area instead (`PassedShape.fillGeom`,
 * region.ts: curves flattened, the outline within `REGION_TOL` of the area), one `a:path` filled even-odd, exact up to
 * that. Opaque overlaps stay as step 4 plans them, already exact. A path too large for the outline keeps the plan,
 * `nonzero-approx` where it is approximate, and the slide a note (`UNION_TOO_LARGE_NOTE`); so do the outlines past the
 * slide's budget, `SLIDE_REGION_WORK` steps (fix round 1). A path's points are counted before it is flattened, in planFill
 * and for the outline (`flattenedCount`): past the cap nothing is made.
 */

/** The flattening tolerance, pt: no point of a curve is further than this from its polygon. */
export const FLATTEN_TOL = 0.05;
/** Past this many polygon points in one path, it is not checked: one `a:path`, nonzero-approx. */
export const MAX_POINTS = 20000;
/** Past this many steps of the checks (segment pairs looked at, polygons and polygon points tested), likewise. */
export const MAX_TESTS = 10_000_000;
/** Two points or a point and a line closer than this (pt) touch. */
const TOUCH = 1e-9;

/** The length of (x, y), by the square root, which every engine rounds alike; the built-in hypot may not (Determinism). */
const norm = (x: number, y: number): number => Math.sqrt(x * x + y * y);

/** What the `fillRule` pass adds to a filled shape: the subpaths (0-based, path order) of each `a:path` that fills. */
export interface FillPlan {
  paths: number[][];
  /** True when the union of `paths` filled even-odd is not proven to be the shape's fill. */
  approx: boolean;
  /** Step 4: the `a:path`s may overlap (exact for an opaque fill only: PowerPoint composites each on its own). */
  overlap?: true;
}

/** The note of a slide with a fill whose nonzero area is too large to outline (region.ts caps). */
export const UNION_TOO_LARGE_NOTE = 'path too large for a fill outline';

/** One subpath: its segments, starting with an `M` (one is supplied where the PDF continues after a `Z`). */
export type Subpath = PathSeg[];

/**
 * The subpaths of `geom`: a new one at each `M`, and after a `Z` that a drawing segment follows, from the point the `Z`
 * went back to (where PDF and DrawingML both continue).
 */
export function splitSubpaths(geom: readonly PathSeg[]): Subpath[] {
  const out: Subpath[] = [];
  let current: Subpath | null = null;
  let start: [number, number] = [0, 0];
  let closed = false;
  for (const seg of geom) {
    if (seg[0] === 'M') {
      current = [seg];
      out.push(current);
      start = [seg[1], seg[2]];
      closed = false;
      continue;
    }
    if (current === null || (closed && seg[0] !== 'Z')) {
      current = [['M', start[0], start[1]]];
      out.push(current);
      closed = false;
    }
    current.push(seg);
    if (seg[0] === 'Z') closed = true;
  }
  return out;
}

/** Every point of a subpath, control points included, as [x, y]. */
export function subpathPoints(sub: readonly PathSeg[]): [number, number][] {
  const pts: [number, number][] = [];
  for (const seg of sub) {
    for (let i = 1; i + 1 < seg.length; i += 2) pts.push([seg[i] as number, seg[i + 1] as number]);
  }
  return pts;
}

/**
 * Where a cubic's coordinate (`p0` to `p3`, handles `p1`, `p2`) turns: its values at the roots of its derivative in
 * (0, 1). `Math.sqrt` is correctly rounded in every engine, so this is the same everywhere (Global Constraints).
 */
function cubicTurns(p0: number, p1: number, p2: number, p3: number): number[] {
  // B'(t) / 3 = a t^2 + b t + c
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;
  const roots: number[] = [];
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) roots.push(-c / b);
  } else {
    const d = b * b - 4 * a * c;
    if (d >= 0) {
      const r = Math.sqrt(d);
      roots.push((-b + r) / (2 * a), (-b - r) / (2 * a));
    }
  }
  return roots
    .filter((t) => t > 0 && t < 1)
    .map((t) => {
      // products, not pow: the output path stays clear of engine-dependent functions
      const u = 1 - t;
      return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
    });
}

/**
 * The box of what a path draws: its points on the curve and the furthest each cubic reaches, not its handles; null for a
 * path with no point. PowerPoint lays a shape's fill, a picture or a gradient, over that extent of the paths that fill,
 * not over its frame (Task 13 measured it: a gradient over a rect in the left half of a frame twice as wide runs over
 * the rect, and atlas/fills/14's heart, whose handles reach past its curves, showed its picture shrunk into the curves'
 * extent by the share the handles took of a frame that spanned them).
 */
export function drawnBox(geom: readonly PathSeg[]): Box | null {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number): void => {
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  };
  let [cx, cy] = [NaN, NaN];
  for (const seg of geom) {
    switch (seg[0]) {
      case 'M':
      case 'L':
        [cx, cy] = [seg[1], seg[2]];
        add(cx, cy);
        break;
      case 'C': {
        if (!Number.isNaN(cx)) {
          for (const x of cubicTurns(cx, seg[1], seg[3], seg[5])) add(x, seg[6]);
          for (const y of cubicTurns(cy, seg[2], seg[4], seg[6])) add(seg[5], y);
        }
        [cx, cy] = [seg[5], seg[6]];
        add(cx, cy);
        break;
      }
      case 'Z':
        break;
    }
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}

/** The points a cubic from (x, y) is flattened into at `tol`: the chord of a step 1/n is within 3/4 m / n² of it. */
function cubicSteps(x: number, y: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tol: number): number {
  const m = Math.max(norm(x - 2 * x1 + x2, y - 2 * y1 + y2), norm(x1 - 2 * x2 + x3, y1 - 2 * y2 + y3));
  return Math.min(1000, Math.max(1, Math.ceil(Math.sqrt((3 * m) / (4 * tol)))));
}

/**
 * How many points `flatten` makes of a path's subpaths at `tol`, at most (fix round 1, I2): counted from the segments,
 * nothing made, and only until the count is past `limit`, whose excess it then returns.
 */
export function flattenedCount(geom: readonly PathSeg[], tol: number, limit: number): number {
  let count = 0;
  let [x, y, sx, sy] = [0, 0, 0, 0];
  for (const seg of geom) {
    switch (seg[0]) {
      case 'M':
        [x, y, sx, sy] = [seg[1], seg[2], seg[1], seg[2]];
        count += 1;
        break;
      case 'L':
        [x, y] = [seg[1], seg[2]];
        count += 1;
        break;
      case 'C':
        count += cubicSteps(x, y, seg[1], seg[2], seg[3], seg[4], seg[5], seg[6], tol);
        [x, y] = [seg[5], seg[6]];
        break;
      case 'Z':
        [x, y] = [sx, sy];
        count += 1; // where the path goes on from its start (`splitSubpaths`)
        break;
    }
    if (!(count <= limit)) return count;
  }
  return count;
}

/**
 * A subpath flattened and closed: points x0, y0, x1, y1, ... without a repeated point or a repeated closing point; curves
 * within `tol` pt.
 */
export function flatten(sub: Subpath, tol = FLATTEN_TOL): number[] {
  const pts: number[] = [];
  const push = (x: number, y: number) => {
    const n = pts.length;
    if (n >= 2 && pts[n - 2] === x && pts[n - 1] === y) return;
    pts.push(x, y);
  };
  let x = 0;
  let y = 0;
  for (const seg of sub) {
    switch (seg[0]) {
      case 'M':
      case 'L':
        [x, y] = [seg[1], seg[2]];
        push(x, y);
        break;
      case 'C': {
        const [, x1, y1, x2, y2, x3, y3] = seg;
        const n = cubicSteps(x, y, x1, y1, x2, y2, x3, y3, tol);
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          const u = 1 - t;
          const a = u * u * u;
          const b = 3 * u * u * t;
          const c = 3 * u * t * t;
          const d = t * t * t;
          push(a * x + b * x1 + c * x2 + d * x3, a * y + b * y1 + c * y2 + d * y3);
        }
        [x, y] = [x3, y3];
        break;
      }
      case 'Z':
        break;
    }
  }
  const n = pts.length;
  if (n >= 4 && pts[0] === pts[n - 2] && pts[1] === pts[n - 1]) pts.length = n - 2;
  return pts;
}

interface Polygon {
  /** The subpath's index in the path. */
  index: number;
  pts: number[];
  /** Signed area, positive clockwise on the page (y down). */
  area: number;
  box: [number, number, number, number];
}

function signedArea(pts: readonly number[]): number {
  let twice = 0;
  const n = pts.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    twice += pts[2 * i]! * pts[2 * j + 1]! - pts[2 * j]! * pts[2 * i + 1]!;
  }
  return twice / 2;
}

/** Whether every point lies on the line through the first point and the one furthest from it: no area either way. */
function flat(pts: readonly number[]): boolean {
  const n = pts.length / 2;
  if (n < 3) return true;
  const x0 = pts[0]!;
  const y0 = pts[1]!;
  let far = 0;
  let fx = 0;
  let fy = 0;
  for (let i = 1; i < n; i++) {
    const d = norm(pts[2 * i]! - x0, pts[2 * i + 1]! - y0);
    if (d > far) [far, fx, fy] = [d, pts[2 * i]! - x0, pts[2 * i + 1]! - y0];
  }
  if (far <= TOUCH) return true;
  for (let i = 1; i < n; i++) {
    if (Math.abs(fx * (pts[2 * i + 1]! - y0) - fy * (pts[2 * i]! - x0)) / far > TOUCH) return false;
  }
  return true;
}

function boxOf(pts: readonly number[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]!);
    x1 = Math.max(x1, pts[i]!);
    y0 = Math.min(y0, pts[i + 1]!);
    y1 = Math.max(y1, pts[i + 1]!);
  }
  return [x0, y0, x1, y1];
}

/** The side of c from the line a→b, 0 within TOUCH of it. */
function side(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const len = norm(bx - ax, by - ay);
  return Math.abs(cross) <= TOUCH * Math.max(len, 1) ? 0 : Math.sign(cross);
}

const within = (a: number, b: number, v: number) => v >= Math.min(a, b) - TOUCH && v <= Math.max(a, b) + TOUCH;

/** Whether segments p1p2 and q1q2 have a point in common, a touch included. */
function meet(p: readonly number[], q: readonly number[]): boolean {
  const [p1x, p1y, p2x, p2y] = p as [number, number, number, number];
  const [q1x, q1y, q2x, q2y] = q as [number, number, number, number];
  const d1 = side(q1x, q1y, q2x, q2y, p1x, p1y);
  const d2 = side(q1x, q1y, q2x, q2y, p2x, p2y);
  const d3 = side(p1x, p1y, p2x, p2y, q1x, q1y);
  const d4 = side(p1x, p1y, p2x, p2y, q2x, q2y);
  if (d1 * d2 < 0 && d3 * d4 < 0) return true;
  if (d1 === 0 && within(q1x, q2x, p1x) && within(q1y, q2y, p1y)) return true;
  if (d2 === 0 && within(q1x, q2x, p2x) && within(q1y, q2y, p2y)) return true;
  if (d3 === 0 && within(p1x, p2x, q1x) && within(p1y, p2y, q1y)) return true;
  if (d4 === 0 && within(p1x, p2x, q2x) && within(p1y, p2y, q2y)) return true;
  return false;
}

interface Edge {
  poly: number;
  /** Its place in its polygon: edge i runs from point i to point i + 1 (the last back to point 0). */
  at: number;
  /** Of its polygon. */
  count: number;
  seg: [number, number, number, number];
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

type Crossings = { self: boolean; cross: boolean } | 'too-large';

/** Self-crossings and crossings between the polygons, by a sweep along x; 'too-large' past `MAX_TESTS`. */
function crossings(polys: readonly Polygon[], budget: { tests: number }): Crossings {
  const edges: Edge[] = [];
  polys.forEach((poly, p) => {
    const n = poly.pts.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const seg: [number, number, number, number] = [poly.pts[2 * i]!, poly.pts[2 * i + 1]!, poly.pts[2 * j]!, poly.pts[2 * j + 1]!];
      edges.push({
        poly: p,
        at: i,
        count: n,
        seg,
        x0: Math.min(seg[0], seg[2]),
        x1: Math.max(seg[0], seg[2]),
        y0: Math.min(seg[1], seg[3]),
        y1: Math.max(seg[1], seg[3]),
      });
    }
  });
  edges.sort((a, b) => a.x0 - b.x0 || a.poly - b.poly || a.at - b.at);
  let cross = false;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i]!;
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j]!;
      if (f.x0 > e.x1 + TOUCH) break;
      if (++budget.tests > MAX_TESTS) return 'too-large';
      if (f.y0 > e.y1 + TOUCH || f.y1 < e.y0 - TOUCH) continue;
      if (e.poly === f.poly) {
        const gap = Math.abs(e.at - f.at);
        if (gap === 1 || gap === e.count - 1) continue; // neighbours share a point
      } else if (cross) {
        continue; // one crossing between polygons is all step 4 needs to know
      }
      if (!meet(e.seg, f.seg)) continue;
      if (e.poly === f.poly) return { self: true, cross };
      cross = true;
    }
  }
  return { self: false, cross };
}

/** Whether (x, y) is inside the polygon (even-odd; the point is on no edge of it). */
function inside(poly: Polygon, x: number, y: number): boolean {
  const pts = poly.pts;
  const n = pts.length / 2;
  let odd = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i]!;
    const yi = pts[2 * i + 1]!;
    const xj = pts[2 * j]!;
    const yj = pts[2 * j + 1]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

const all = (count: number): number[] => Array.from({ length: count }, (_, i) => i);

/** The `a:path`s of a filled shape (see the module comment). A shape with no geometry has none. */
export function planFill(shape: ShapeEl): FillPlan {
  if (shape.geom === null) return { paths: [], approx: false };
  const subpaths = splitSubpaths(shape.geom);
  const one = { paths: [all(subpaths.length)], approx: false };
  if (shape.fillRule === 'evenodd' || subpaths.length === 0) return one;
  const approx = { paths: [all(subpaths.length)], approx: true };

  // step 1, its points counted before any is made
  if (!(flattenedCount(shape.geom, FLATTEN_TOL, MAX_POINTS) <= MAX_POINTS)) return approx;
  const polys: Polygon[] = [];
  const inert: number[] = [];
  let points = 0;
  for (const [index, sub] of subpaths.entries()) {
    const pts = flatten(sub);
    points += pts.length / 2;
    if (!(points <= MAX_POINTS)) return approx;
    if (flat(pts)) inert.push(index);
    else polys.push({ index, pts, area: signedArea(pts), box: boxOf(pts) });
  }
  if (polys.length === 0) return one;

  // step 2
  const budget = { tests: 0 };
  const found = crossings(polys, budget);
  if (found === 'too-large' || found.self) return approx;
  if (polys.length === 1) return one;
  const plan = (groups: number[][]): FillPlan => {
    groups.sort((a, b) => a[0]! - b[0]!);
    groups[0] = [...groups[0]!, ...inert].sort((a, b) => a - b);
    return { paths: groups, approx: false };
  };

  // step 4, 5
  if (found.cross) {
    const sign = Math.sign(polys[0]!.area);
    if (polys.some((p) => Math.sign(p.area) !== sign)) return approx;
    return { ...plan(polys.map((p) => [p.index])), overlap: true };
  }

  // step 3: containers, largest first; a polygon's container is larger than it
  const order = polys.map((_, i) => i).sort((a, b) => Math.abs(polys[b]!.area) - Math.abs(polys[a]!.area) || a - b);
  const parent: (number | null)[] = polys.map(() => null);
  const winding: number[] = polys.map((p) => Math.sign(p.area));
  const depth: number[] = polys.map(() => 1);
  for (const [k, s] of order.entries()) {
    const poly = polys[s]!;
    const [x, y] = [poly.pts[0]!, poly.pts[1]!];
    for (const t of order.slice(0, k)) {
      const other = polys[t]!;
      if (++budget.tests > MAX_TESTS) return approx;
      if (x < other.box[0] || x > other.box[2] || y < other.box[1] || y > other.box[3]) continue;
      budget.tests += other.pts.length / 2;
      if (budget.tests > MAX_TESTS) return approx;
      if (!inside(other, x, y)) continue;
      winding[s]! += Math.sign(other.area);
      depth[s]! += 1;
      parent[s] = t; // the last container met is the smallest
    }
  }
  const filled = winding.map((w) => w !== 0);
  if (filled.every((f, s) => f === (depth[s]! % 2 === 1))) return one;

  const root = (s: number): number => {
    let r = s;
    while (parent[r] !== null && filled[parent[r]!]) r = parent[r]!;
    return r;
  };
  const groups = new Map<number, number[]>();
  polys.forEach((poly, s) => {
    if (filled[s] && (parent[s] === null || !filled[parent[s]!])) groups.set(s, [poly.index]);
  });
  polys.forEach((poly, s) => {
    // an unfilled region always has a filled parent: the windings on either side of a polygon differ by 1
    if (!filled[s]) groups.get(root(parent[s]!))!.push(poly.index);
  });
  return plan([...groups.values()].map((g) => g.sort((a, b) => a - b)));
}

/**
 * A path's subpaths, flattened (curves within `tol` pt) and closed, as polygons (pt, x0 y0 x1 y1 ...); null, and nothing
 * made, when that is more than `REGION_MAX_POINTS` points (`flattenedCount`).
 */
export function pathPolygons(geom: readonly PathSeg[], tol = REGION_FLATTEN_TOL): number[][] | null {
  if (!(flattenedCount(geom, tol, REGION_MAX_POINTS) <= REGION_MAX_POINTS)) return null;
  return splitSubpaths(geom).map((sub) => flatten(sub, tol));
}

/**
 * Whether a fill may be translucent where its `a:path`s overlap: its alpha with its groups' below 1 as written, alpha
 * stops (M5 Task 3), or a picture tile (whose pixels may be).
 */
function translucent(el: PassedShape): boolean {
  const fill = el.fill;
  if (fill === null) return false;
  if (fill.kind === 'tile' || fill.kind === 'shading') return true;
  if (el.alphaStops !== undefined && el.alphaStops.some((s) => s.alpha < 1)) return true;
  const groups = el.groups.reduce((a, g) => a * g.alpha, 1);
  return Math.round(fill.alpha * groups * 100000) < 100000;
}

/**
 * The pass: each filled shape with a path gets its `fillPaths` (`planFill`), or, where that plan is approximate or its
 * overlapping `a:path`s translucent, its `fillGeom` (the module comment); a plan not proven exact, or translucent
 * overlapping `a:path`s (which PowerPoint composites twice where they overlap: final review Minor 6), too large to
 * outline is reported as `nonzero-approx`, the slide noted once. `budget`: the steps its outlines may spend, the slide's
 * `SLIDE_REGION_WORK` when absent (as `resolveClips`'). A new slide; the input is not changed.
 */
export function fillRule(slide: SceneSlide, report: SlideReport, budget: RegionBudget = { left: SLIDE_REGION_WORK }): SceneSlide {
  let noted = report.notes.some((n) => n.op === 'fill' && n.detail === UNION_TOO_LARGE_NOTE);
  const elements = slide.elements.map((el) => {
    if (el.kind !== 'shape' || el.geom === null || el.fill === null) return el;
    // the clip pass's outline of a fill cut by its clips (fix round 1, I3) is its fill already
    if ((el as PassedShape).fillGeom !== undefined) return el;
    const plan = planFill(el);
    if (!plan.approx && !(plan.overlap === true && translucent(el))) return { ...el, fillPaths: plan.paths };
    const polygons = budget.left > 0 ? pathPolygons(el.geom) : null;
    const outline = polygons === null ? 'too-large' : regionOutline([{ polygons, rule: el.fillRule }], 'all', budget);
    if (outline === 'too-large' || outline === 'over-budget') {
      approximate(report, el.id, 'nonzero-approx');
      if (!noted) report.notes.push({ opIndex: el.provenance.opIndex[0] ?? 0, op: 'fill', detail: UNION_TOO_LARGE_NOTE });
      noted = true;
      return { ...el, fillPaths: plan.paths };
    }
    const passed: PassedShape = { ...el, fillGeom: loopsPath(outline.loops) };
    return passed;
  });
  return { ...slide, elements };
}
