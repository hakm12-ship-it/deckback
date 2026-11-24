import type { PathSeg } from '../extract/inventory';
import type { LineStyle } from '../scene/types';

/**
 * Geometry and coverage of the raster renderer (raster.ts): paths flattened into polygons, strokes turned into fill
 * outlines, and the samples each covers. A pixel has `SS` x `SS` samples at the centres of its sub-squares; a sample is in
 * or out, so a pixel's coverage is a whole count, 0 to 16. Vertices are snapped to 1/256 of a sample first, and every
 * step is +, -, *, / or a square root, which IEEE 754 rounds the same in every engine; no trigonometry, no `Math.pow`.
 */

/** Samples a pixel along each axis. */
export const SS = 4;
/** What a vertex is snapped to: 1/256 of a sample. */
const SNAP = 256;
/** Most line segments one cubic is flattened into. */
const MAX_PIECES = 1024;
/** The circle as four cubics: the length of a handle over the radius. */
const KAPPA = 0.5522847498307936;

/**
 * The pixel grid of a raster: `x0`, `y0` the frame point (pt) of its top left corner, `w` x `h` pixels, `s` pixels a pt.
 * Pixel (i, j) covers [x0 + i / s, x0 + (i + 1) / s) and the same down; its samples are at (i + (a + 0.5) / SS) / s.
 */
export interface Grid {
  x0: number;
  y0: number;
  w: number;
  h: number;
  s: number;
}

/** A polygon: x, y, x, y, ... of the frame (pt), closed from its last point back to its first. */
export type Polygon = number[];

/** A flattened subpath: its points, and whether it was closed (`Z`). */
export interface Polyline {
  pts: number[];
  closed: boolean;
}

// ---- flattening -----------------------------------------------------------------------------------------------------

/**
 * The equal steps of t a cubic from (x0, y0) is cut into: as few as keep it within `tol` of its chords (the distance is
 * at most 3/4 of the larger second difference of its control points over n², de Casteljau), at most `MAX_PIECES`.
 */
function cubicSteps(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tol: number): number {
  const ax = x0 - 2 * x1 + x2;
  const ay = y0 - 2 * y1 + y2;
  const bx = x1 - 2 * x2 + x3;
  const by = y1 - 2 * y2 + y3;
  const dd = Math.max(Math.sqrt(ax * ax + ay * ay), Math.sqrt(bx * bx + by * by));
  return Math.min(MAX_PIECES, Math.max(1, Math.ceil(Math.sqrt((0.75 * dd) / tol))));
}

/** The points of a cubic from (x0, y0), without that first point, in `cubicSteps` equal steps of t. */
function cubicPoints(out: number[], x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tol: number): void {
  const n = cubicSteps(x0, y0, x1, y1, x2, y2, x3, y3, tol);
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const [b0, b1, b2, b3] = [u * u * u, 3 * t * u * u, 3 * t * t * u, t * t * t];
    out.push(b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3, b0 * y0 + b1 * y1 + b2 * y2 + b3 * y3);
  }
}

/**
 * A path as polylines, its cubics flattened to within `tol` (pt). A segment after `Z` without an `M` starts a new subpath
 * at the closed one's start, as in PDF. Repeated points are kept (a stroke drops them).
 */
export function flattenPath(geom: readonly PathSeg[], tol: number): Polyline[] {
  const out: Polyline[] = [];
  let cur: Polyline | null = null;
  let start: [number, number] = [0, 0];
  let at: [number, number] = [0, 0];
  const open = (): Polyline => {
    if (cur === null) {
      cur = { pts: [at[0], at[1]], closed: false };
      start = [at[0], at[1]];
    }
    return cur;
  };
  for (const seg of geom) {
    switch (seg[0]) {
      case 'M':
        if (cur !== null) out.push(cur);
        cur = null;
        at = [seg[1], seg[2]];
        open();
        break;
      case 'L':
        open().pts.push(seg[1], seg[2]);
        at = [seg[1], seg[2]];
        break;
      case 'C':
        cubicPoints(open().pts, at[0], at[1], seg[1], seg[2], seg[3], seg[4], seg[5], seg[6], tol);
        at = [seg[5], seg[6]];
        break;
      case 'Z':
        if (cur !== null) {
          (cur as Polyline).closed = true;
          out.push(cur);
          cur = null;
        }
        at = [start[0], start[1]];
        break;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * Points a raster may still make (final review C1): its paths flattened, its strokes' outlines, the polygons of its clips
 * and pictures, which its scans then hold as edges. Each is counted before it is made (`flattenedPoints`) and taken off
 * `left`; what would go past it is not made and nothing is taken.
 */
export interface PointBudget {
  left: number;
}

/**
 * How many points `flattenPath` makes of a path at `tol`, counted from its segments, nothing made; it stops once past
 * `limit` and returns the count so far (past it).
 */
export function flattenedPoints(geom: readonly PathSeg[], tol: number, limit = Infinity): number {
  let count = 0;
  let open = false;
  let start: [number, number] = [0, 0];
  let at: [number, number] = [0, 0];
  for (const seg of geom) {
    switch (seg[0]) {
      case 'M':
        count += 1;
        open = true;
        at = [seg[1], seg[2]];
        start = at;
        break;
      case 'L':
        count += open ? 1 : 2;
        if (!open) start = at;
        open = true;
        at = [seg[1], seg[2]];
        break;
      case 'C':
        count += (open ? 0 : 1) + cubicSteps(at[0], at[1], seg[1], seg[2], seg[3], seg[4], seg[5], seg[6], tol);
        if (!open) start = at;
        open = true;
        at = [seg[5], seg[6]];
        break;
      case 'Z':
        open = false;
        at = start;
        break;
    }
    if (!(count <= limit)) return count;
  }
  return count;
}

/** `flattenPath` within a budget: its points taken off `budget`, or null (nothing made or taken) past what is left. */
export function flattenWithin(geom: readonly PathSeg[], tol: number, budget: PointBudget): Polyline[] | null {
  const n = flattenedPoints(geom, tol, budget.left);
  if (!(n <= budget.left)) return null;
  budget.left -= n;
  return flattenPath(geom, tol);
}

/** The polygons of polylines, for a fill (every subpath is closed). */
export const polygonsOf = (lines: readonly Polyline[]): Polygon[] => lines.map((l) => l.pts);

/** A circle of radius `r` about (cx, cy), flattened, counter-clockwise in the frame's numbers (positive area). */
export function circlePolygon(cx: number, cy: number, r: number, tol: number): Polygon {
  const k = KAPPA * r;
  const pts = [cx + r, cy];
  cubicPoints(pts, cx + r, cy, cx + r, cy + k, cx + k, cy + r, cx, cy + r, tol);
  cubicPoints(pts, cx, cy + r, cx - k, cy + r, cx - r, cy + k, cx - r, cy, tol);
  cubicPoints(pts, cx - r, cy, cx - r, cy - k, cx - k, cy - r, cx, cy - r, tol);
  cubicPoints(pts, cx, cy - r, cx + k, cy - r, cx + r, cy - k, cx + r, cy, tol);
  pts.length -= 2; // the last point is the first
  return pts;
}

/** The points `circlePolygon` makes of a circle of radius `r` at `tol`, at most (a step more a quarter: its centre's rounding). */
function circlePoints(r: number, tol: number): number {
  const k = KAPPA * r;
  return 4 * (cubicSteps(r, 0, r, k, k, r, 0, r, tol) + 1);
}

// ---- strokes as outlines -------------------------------------------------------------------------------------------

/** Twice the signed area of a polygon. */
function area2(p: Polygon): number {
  let a = 0;
  for (let i = 0, n = p.length; i < n; i += 2) {
    const j = (i + 2) % n;
    a += p[i]! * p[j + 1]! - p[j]! * p[i + 1]!;
  }
  return a;
}

/** The polygon turned to positive area, so that outlines filled nonzero add up; null when it has none. */
function positive(p: Polygon): Polygon | null {
  const a = area2(p);
  if (!(Math.abs(a) > 0)) return null;
  if (a > 0) return p;
  const out: number[] = [];
  for (let i = p.length - 2; i >= 0; i -= 2) out.push(p[i]!, p[i + 1]!);
  return out;
}

/** The points of a polyline without repeats (consecutive equal points), and without a closing repeat of the first. */
function distinct(pl: Polyline): number[] {
  const out: number[] = [];
  for (let i = 0; i < pl.pts.length; i += 2) {
    const [x, y] = [pl.pts[i]!, pl.pts[i + 1]!];
    if (out.length === 0 || out[out.length - 2] !== x || out[out.length - 1] !== y) out.push(x, y);
  }
  if (pl.closed && out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}

/**
 * A polyline cut by a dash pattern (`dash` and `phase` in pt, as the Scene has them): the pieces that are on, each open.
 * A pattern of no length is no pattern. A piece of no length keeps the direction it was met in (for its caps).
 */
function dashed(pl: Polyline, dash: readonly number[], phase: number): { pts: number[]; dir: [number, number] | null }[] {
  const pattern = dash.length % 2 === 1 ? [...dash, ...dash] : [...dash];
  const period = pattern.reduce((a, b) => a + b, 0);
  const pts = distinct(pl);
  if (pl.closed && pts.length >= 4) pts.push(pts[0]!, pts[1]!);
  const pieces: { pts: number[]; dir: [number, number] | null }[] = [];
  // Where the phase puts the start: which dash, and how much of it is left.
  let k = 0;
  let left = pattern[0]!;
  let skip = ((phase % period) + period) % period;
  while (skip > 0) {
    if (skip >= left) {
      skip -= left;
      k = (k + 1) % pattern.length;
      left = pattern[k]!;
    } else {
      left -= skip;
      skip = 0;
    }
  }
  let on = k % 2 === 0;
  let piece: number[] | null = on ? [pts[0]!, pts[1]!] : null;
  let dir: [number, number] | null = null;
  for (let i = 2; i < pts.length; i += 2) {
    let [ax, ay] = [pts[i - 2]!, pts[i - 1]!];
    const [bx, by] = [pts[i]!, pts[i + 1]!];
    let len = Math.sqrt((bx - ax) * (bx - ax) + (by - ay) * (by - ay));
    if (!(len > 0)) continue;
    const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
    dir = [ux, uy];
    while (len >= left) {
      // the dash (or gap) ends inside this segment
      const [cx, cy] = [ax + ux * left, ay + uy * left];
      if (on) {
        piece!.push(cx, cy);
        pieces.push({ pts: piece!, dir });
        piece = null;
      } else {
        piece = [cx, cy];
      }
      on = !on;
      len -= left;
      [ax, ay] = [cx, cy];
      k = (k + 1) % pattern.length;
      left = pattern[k]!;
      if (left === 0 && len === 0) break;
    }
    left -= len;
    if (on) piece!.push(bx, by);
  }
  if (on && piece !== null && piece.length >= 2) pieces.push({ pts: piece, dir });
  return pieces;
}

/**
 * The most dash pieces one stroke may be cut into (fix round 1, I2): a hostile pattern (0.002 pt dashes on a 4,000 pt
 * path would be a million polygons, for every element of a backdrop too) is drawn solid instead, with `DASH_SOLID_NOTE`.
 * 10,000 pieces on the longest path a slide holds (a 4,032 pt diagonal of a 4,032 pt square, 5,702 pt) are dashes of
 * 0.57 pt a period, a pixel and a bit at 2 px a pt: a pattern finer than that is a texture at the raster's scale, and the
 * solid line is its envelope. Counted before any piece is made, from the path's length and the pattern, so the cut is
 * deterministic and the work bounded.
 */
export const MAX_DASH_PIECES = 10_000;
export const DASH_SOLID_NOTE = 'dash pattern drawn solid in a raster';

/** The length of a flattened polyline, its closing segment included when closed. */
function polylineLength(pl: Polyline): number {
  const pts = distinct(pl);
  if (pl.closed && pts.length >= 4) pts.push(pts[0]!, pts[1]!);
  let length = 0;
  for (let i = 2; i < pts.length; i += 2) {
    const [dx, dy] = [pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!];
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

/**
 * How many pieces a dash pattern cuts polylines into, at most: per polyline, a piece per dash of each period it spans,
 * and one more for the period it starts in.
 */
function dashPieces(lines: readonly Polyline[], dash: readonly number[]): number {
  const pattern = dash.length % 2 === 1 ? [...dash, ...dash] : dash;
  const period = pattern.reduce((a, b) => a + b, 0);
  const dashes = pattern.length / 2;
  let pieces = 0;
  for (const pl of lines) pieces += (Math.floor(polylineLength(pl) / period) + 1) * dashes;
  return pieces;
}

/**
 * The points of a stroke's outline polygons at most, before any is made: of `points` flattened points in `lines`
 * polylines, cut into `pieces` dashes (0 undashed). A quad a segment and a join a point (a disc when round, else at most
 * four), along the polylines' points with a closing point each and two cut points a dash; a cap at each end of a polyline
 * and of a dash (a disc when round, four when square).
 */
function outlinePoints(points: number, lines: number, pieces: number, hw: number, line: LineStyle, tol: number): number {
  const disc = line.join === 'round' || line.cap === 'round' ? circlePoints(hw, tol) : 0;
  const join = line.join === 'round' ? disc : 4;
  const cap = line.cap === 'round' ? disc : line.cap === 'square' ? 4 : 0;
  return (4 + join) * (points + lines + 2 * pieces) + 2 * cap * (lines + pieces);
}

/**
 * A stroke as polygons of positive area, to fill nonzero: a quad along each segment, a join at each corner (miter
 * within the limit, else bevel; round as a disc) and a cap at each open end (square, round; butt none), dashes first.
 * `w` below `minW` (a hairline, `w` 0) is `minW`: one pixel, which the caller gives. `tol`: the flattening tolerance.
 * A pattern of more than `MAX_DASH_PIECES` pieces is drawn solid, and `notes` (when given) gets `DASH_SOLID_NOTE`.
 * With a `budget` (final review C1) the polylines' points are counted before they are made, then the polygons' at most
 * (`outlinePoints`) before any is made, and both taken off it; past what is left it is null, nothing made or taken.
 */
export function strokeOutline(geom: readonly PathSeg[], line: LineStyle, tol: number, minW: number, notes?: Set<string>): Polygon[];
export function strokeOutline(geom: readonly PathSeg[], line: LineStyle, tol: number, minW: number, notes: Set<string> | undefined, budget: PointBudget): Polygon[] | null;
export function strokeOutline(geom: readonly PathSeg[], line: LineStyle, tol: number, minW: number, notes?: Set<string>, budget?: PointBudget): Polygon[] | null {
  const hw = Math.max(line.w, minW) / 2;
  const out: Polygon[] = [];
  const add = (p: Polygon): void => {
    const q = positive(p);
    if (q !== null) out.push(q);
  };
  const made = budget === undefined ? 0 : flattenedPoints(geom, tol, budget.left);
  if (budget !== undefined && !(made <= budget.left)) return null;
  const lines = flattenPath(geom, tol);
  let isDashed = line.dash.length > 0 && line.dash.some((d) => d > 0) && line.dash.every((d) => d >= 0);
  const pieces = isDashed ? dashPieces(lines, line.dash) : 0;
  const solid = isDashed && !(pieces <= MAX_DASH_PIECES);
  if (budget !== undefined) {
    const cost = made + outlinePoints(made, lines.length, isDashed && !solid ? pieces : 0, hw, line, tol);
    if (!(cost <= budget.left)) return null;
    budget.left -= cost;
  }
  if (solid) {
    isDashed = false;
    notes?.add(DASH_SOLID_NOTE);
  }
  for (const pl of lines) {
    if (isDashed) {
      for (const piece of dashed(pl, line.dash, line.phase)) strokePiece(add, piece.pts, false, hw, line, tol, piece.dir);
    } else {
      strokePiece(add, distinct(pl), pl.closed, hw, line, tol, null);
    }
  }
  return out;
}

/** One open or closed run of points, stroked at half width `hw`. */
function strokePiece(add: (p: Polygon) => void, raw: number[], closed: boolean, hw: number, line: LineStyle, tol: number, dir: [number, number] | null): void {
  const pts: number[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    if (pts.length === 0 || pts[pts.length - 2] !== raw[i] || pts[pts.length - 1] !== raw[i + 1]) pts.push(raw[i]!, raw[i + 1]!);
  }
  const n = pts.length / 2;
  if (n === 1) {
    // a point: a dot for a round cap, a square for a square cap (along the direction it was met in, else the axes)
    const [x, y] = [pts[0]!, pts[1]!];
    if (line.cap === 'round') add(circlePolygon(x, y, hw, tol));
    else if (line.cap === 'square') {
      const [ux, uy] = dir ?? [1, 0];
      const [nx, ny] = [-uy * hw, ux * hw];
      add([x - ux * hw + nx, y - uy * hw + ny, x + ux * hw + nx, y + uy * hw + ny, x + ux * hw - nx, y + uy * hw - ny, x - ux * hw - nx, y - uy * hw - ny]);
    }
    return;
  }
  const segs = closed && n >= 3 ? n : n - 1;
  const unit = (i: number): [number, number] => {
    const j = (i + 1) % n;
    const [dx, dy] = [pts[j * 2]! - pts[i * 2]!, pts[j * 2 + 1]! - pts[i * 2 + 1]!];
    const len = Math.sqrt(dx * dx + dy * dy);
    return [dx / len, dy / len];
  };
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    const [ux, uy] = unit(i);
    const [nx, ny] = [-uy * hw, ux * hw];
    const [ax, ay, bx, by] = [pts[i * 2]!, pts[i * 2 + 1]!, pts[j * 2]!, pts[j * 2 + 1]!];
    add([ax + nx, ay + ny, bx + nx, by + ny, bx - nx, by - ny, ax - nx, ay - ny]);
  }
  // joins: at every inner point, and for a closed run at every point
  const first = closed && n >= 3 ? 0 : 1;
  const last = closed && n >= 3 ? n - 1 : n - 2;
  for (let i = first; i <= last; i++) {
    const before = (i - 1 + n) % n;
    join(add, pts[i * 2]!, pts[i * 2 + 1]!, unit(before), unit(i), hw, line, tol);
  }
  if (closed && n >= 3) return;
  const [sx, sy] = unit(0);
  cap(add, pts[0]!, pts[1]!, [-sx, -sy], hw, line.cap, tol);
  const [ex, ey] = unit(n - 2);
  cap(add, pts[(n - 1) * 2]!, pts[(n - 1) * 2 + 1]!, [ex, ey], hw, line.cap, tol);
}

/** The join at (x, y) between the segment in direction `d0` and the next in `d1`. */
function join(add: (p: Polygon) => void, x: number, y: number, [ax, ay]: [number, number], [bx, by]: [number, number], hw: number, line: LineStyle, tol: number): void {
  const cross = ax * by - ay * bx;
  const dot = ax * bx + ay * by;
  if (cross === 0 && dot > 0) return; // straight on
  if (line.join === 'round') {
    add(circlePolygon(x, y, hw, tol));
    return;
  }
  if (cross === 0) return; // a turn back: its two quads meet, and nothing more is drawn
  // the outer side: away from the turn
  const side = cross > 0 ? -1 : 1;
  const [o0x, o0y] = [-ay * hw * side, ax * hw * side];
  const [o1x, o1y] = [-by * hw * side, bx * hw * side];
  if (line.join === 'miter') {
    // the miter's length over the line width: 1 / sin of half the angle between the segments
    const ratio = 1 / Math.sqrt((1 + dot) / 2);
    if (ratio <= line.miter) {
      const [mx, my] = [o0x + o1x, o0y + o1y];
      const m = Math.sqrt(mx * mx + my * my);
      const [tx, ty] = [x + (mx / m) * hw * ratio, y + (my / m) * hw * ratio];
      add([x, y, x + o0x, y + o0y, tx, ty, x + o1x, y + o1y]);
      return;
    }
  }
  add([x, y, x + o0x, y + o0y, x + o1x, y + o1y]);
}

/** The cap at (x, y) of a line leaving it in direction `d` (outwards). */
function cap(add: (p: Polygon) => void, x: number, y: number, [ux, uy]: [number, number], hw: number, kind: LineStyle['cap'], tol: number): void {
  if (kind === 'round') add(circlePolygon(x, y, hw, tol));
  else if (kind === 'square') {
    const [nx, ny] = [-uy * hw, ux * hw];
    add([x + nx, y + ny, x + nx + ux * hw, y + ny + uy * hw, x - nx + ux * hw, y - ny + uy * hw, x - nx, y - ny]);
  }
}

// ---- coverage -------------------------------------------------------------------------------------------------------

/** One edge in sample space, top to bottom: x at its top, its slope dx/dy, its top and bottom y, its winding. */
interface Edge {
  x: number;
  slope: number;
  top: number;
  bottom: number;
  dir: number;
}

/** A frame coordinate in samples of the grid, snapped to `SNAP`. */
const sampleX = (g: Grid, x: number): number => Math.round((x - g.x0) * g.s * SS * SNAP) / SNAP;
const sampleY = (g: Grid, y: number): number => Math.round((y - g.y0) * g.s * SS * SNAP) / SNAP;

/**
 * Which samples of each row of the grid a set of polygons covers, by a fill rule. Rows are asked in order, top down
 * (`row`), as an active edge list follows them; each answer is the intervals of sample columns covered, [a, b) pairs,
 * within the grid. A sample is covered when its centre is: an edge exactly through a centre counts it on its right.
 */
export class Scan {
  private readonly edges: Edge[] = [];
  private next = 0;
  private active: Edge[] = [];
  private last = -1;
  /** The first and last sample rows any edge reaches (empty when top > bottom). */
  readonly top: number;
  readonly bottom: number;
  /**
   * The sample rows of the grid its edges cross, summed over the edges (final review C1): each such row of each edge is a
   * step of `row`, which a raster's work budget counts before any row is asked.
   */
  readonly edgeRows: number;

  constructor(
    polygons: readonly Polygon[],
    private readonly rule: 'nonzero' | 'evenodd',
    private readonly grid: Grid,
  ) {
    for (const p of polygons) {
      const n = p.length / 2;
      if (n < 3) continue;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [x0, y0, x1, y1] = [sampleX(grid, p[i * 2]!), sampleY(grid, p[i * 2 + 1]!), sampleX(grid, p[j * 2]!), sampleY(grid, p[j * 2 + 1]!)];
        if (y0 === y1) continue;
        const [xt, yt, xb, yb, dir] = y0 < y1 ? [x0, y0, x1, y1, 1] : [x1, y1, x0, y0, -1];
        this.edges.push({ x: xt, slope: (xb - xt) / (yb - yt), top: yt, bottom: yb, dir });
      }
    }
    // a stable sort on the top, so the order is the input's for equal tops
    this.edges.sort((a, b) => a.top - b.top);
    let [top, bottom] = [Infinity, -Infinity];
    let crossed = 0;
    const rows = grid.h * SS;
    for (const e of this.edges) {
      top = Math.min(top, e.top);
      bottom = Math.max(bottom, e.bottom);
      crossed += Math.max(0, Math.min(e.bottom, rows) - Math.max(e.top, 0));
    }
    this.top = top;
    this.bottom = bottom;
    this.edgeRows = crossed;
  }

  /** The covered intervals of sample row `sy` (rows asked in increasing order). */
  row(sy: number): number[] {
    if (sy <= this.last) throw new Error(`Scan.row: row ${sy} after ${this.last}`);
    this.last = sy;
    const y = sy + 0.5;
    while (this.next < this.edges.length && this.edges[this.next]!.top <= y) this.active.push(this.edges[this.next++]!);
    this.active = this.active.filter((e) => e.bottom > y);
    const xs: { x: number; dir: number }[] = [];
    for (const e of this.active) if (e.top <= y) xs.push({ x: e.x + (y - e.top) * e.slope, dir: e.dir });
    xs.sort((a, b) => a.x - b.x || a.dir - b.dir);
    const out: number[] = [];
    const limit = this.grid.w * SS;
    let wind = 0;
    let from = 0;
    for (const { x, dir } of xs) {
      const was = this.rule === 'nonzero' ? wind !== 0 : (wind & 1) === 1;
      wind += dir;
      const is = this.rule === 'nonzero' ? wind !== 0 : (wind & 1) === 1;
      if (!was && is) from = x;
      else if (was && !is) {
        const a = Math.max(0, Math.ceil(from - 0.5));
        const b = Math.min(limit, Math.ceil(x - 0.5));
        if (b > a) {
          if (out.length > 0 && out[out.length - 1] === a) out[out.length - 1] = b;
          else out.push(a, b);
        }
      }
    }
    return out;
  }
}

/** The common part of two lists of intervals. */
export function intersectSpans(a: readonly number[], b: readonly number[]): number[] {
  const out: number[] = [];
  let [i, j] = [0, 0];
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i]!, b[j]!);
    const hi = Math.min(a[i + 1]!, b[j + 1]!);
    if (hi > lo) out.push(lo, hi);
    if (a[i + 1]! < b[j + 1]!) i += 2;
    else j += 2;
  }
  return out;
}

/**
 * Where an element may paint: the intersection of scans (its own outline, each clip of its chain). No scan at all is the
 * whole grid. `rows` is the range of pixel rows it can reach, [first, end).
 */
export class Region {
  readonly rows: [number, number];
  /** Its scans' `edgeRows`, summed. */
  readonly edgeRows: number;

  constructor(
    private readonly scans: readonly Scan[],
    private readonly grid: Grid,
  ) {
    let [top, bottom] = [0, grid.h * SS];
    let edgeRows = 0;
    for (const s of scans) {
      top = Math.max(top, Math.floor(s.top));
      bottom = Math.min(bottom, Math.ceil(s.bottom));
      edgeRows += s.edgeRows;
    }
    this.edgeRows = edgeRows;
    this.rows = bottom > top ? [Math.floor(top / SS), Math.ceil(bottom / SS)] : [0, 0];
  }

  row(sy: number): number[] {
    let spans: number[] = [0, this.grid.w * SS];
    for (const s of this.scans) {
      spans = intersectSpans(spans, s.row(sy));
      if (spans.length === 0) break;
    }
    return spans;
  }
}

/** The coverage (0..16) of each pixel of the grid by polygons filled by `rule`, row by row: for tests and measures. */
export function coverage(polygons: readonly Polygon[] | readonly Polyline[], rule: 'nonzero' | 'evenodd', grid: Grid): Uint8Array {
  const polys = (polygons as readonly (Polygon | Polyline)[]).map((p) => (Array.isArray(p) ? p : (p as Polyline).pts));
  const scan = new Scan(polys, rule, grid);
  const out = new Uint8Array(grid.w * grid.h);
  for (let sy = 0; sy < grid.h * SS; sy++) {
    const spans = scan.row(sy);
    const j = sy >> 2;
    for (let k = 0; k < spans.length; k += 2) for (let cx = spans[k]!; cx < spans[k + 1]!; cx++) out[j * grid.w + (cx >> 2)]! += 1;
  }
  return out;
}
