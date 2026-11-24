import type { PathSeg } from '../extract/inventory';

/**
 * Region outlines (M5 Task 4): the boundary of a region given by polygons under fill rules, as closed loops whose
 * even-odd fill is that region, which DrawingML can say (PowerPoint fills each `a:path` even-odd, 0001 M0-5). Two uses:
 * - the fill rule pass: the nonzero area of a path whose subpaths cross themselves, or overlap under an alpha below 1
 *   (PowerPoint composites each `a:path` on its own, so an overlap would be painted twice), as one outline (`'all'` of
 *   one operand);
 * - the clip pass: a fill cut by a clip as the intersection of its area and its clips' (`'all'`), and whether a clip
 *   cuts it at all (`'minus'`: nothing of the fill outside the clip).
 *
 * How (a sweep over horizontal slabs, robust by construction rather than by exact intersection points):
 * 1. Every polygon's points are snapped to a grid of `1 / REGION_GRID` pt (integers), within `MAX_COORD`, so that every
 *    cross product of two edges is exact in a double (below 2^53). Curves were flattened by the caller at
 *    `REGION_FLATTEN_TOL`; with the snap and the output's own rounding to the grid, no point is more than `REGION_TOL`
 *    (0.05 pt) from where it was.
 * 2. Edges that cross properly (exact orientation tests) give the heights where they cross; with the points' own heights
 *    these cut the plane into slabs in which no two edges cross.
 * 3. In each slab the edges are ordered by their x at its middle (ties by their x at its top and bottom, then their
 *    index: a total order) and each operand's winding counted left to right; where the combination holds (`'all'`: every
 *    operand inside; `'minus'`: the first inside and no other) is an interval between two edges, a trapezoid. Its left
 *    side runs up, its right side down, its top right and its bottom left: the region on the right of every piece.
 * 4. On each slab line, the tops of the slab below and the bottoms of the slab above are summed as signed runs: what
 *    is left is the region's horizontal boundary there. Every point a piece ends at is computed by the same evaluation
 *    of the same edge at the same height, so pieces meet exactly, and every point has as many pieces in as out.
 * 5. The pieces are linked into loops (at a point, the first piece out not yet taken, in the order they were made), then
 *    each loop rounded to the grid, its repeated points and the points along one edge or one line dropped. Loops that
 *    enclose less than a grid cell are dropped.
 *
 * Deterministic: integers on the grid, + − × ÷ in doubles in a fixed order, sorts with total orders, no Map or Set order
 * on the output path but insertion order. Bounded (hostile input, as Task 2's caps): at most `REGION_MAX_POINTS` points,
 * `REGION_MAX_CROSSINGS` crossings, `REGION_MAX_WORK` steps (a step a point, a step an edge per halving of the edges for
 * each sort, a pair of edges tested, an edge met in a slab) and `REGION_MAX_PIECES` boundary pieces; past any, or a
 * point off the exact range, the answer is `'too-large'` (`RegionBudget.refused` says which) and the caller keeps its
 * approximation or makes a fallback. A caller's `RegionBudget` (fix round 1: a slide's, `SLIDE_REGION_WORK`) pays the
 * steps of every call it is given to, and a call it cannot pay for stops there: `'over-budget'`. The callers count a
 * path's points before they flatten it (fillrule.ts `pathPolygons`), so no more than the cap is ever made.
 */

/** Grid units a pt. */
export const REGION_GRID = 1024;
/** The tolerance of an outline (pt): no point of it further than this from the region the curves bound. */
export const REGION_TOL = 0.05;
/** The flattening tolerance (pt) the callers use, `REGION_TOL` less the snap of the input and of the output. */
export const REGION_FLATTEN_TOL = 0.048;
/** The most polygon points, all operands together. */
export const REGION_MAX_POINTS = 20_000;
/** The most crossings between edges. */
export const REGION_MAX_CROSSINGS = 100_000;
/** The most steps: pairs of edges tested for a crossing, and edges met in the slabs. */
export const REGION_MAX_WORK = 4_000_000;
/** The most boundary pieces. */
export const REGION_MAX_PIECES = 400_000;
/**
 * The steps one pass may spend on one slide's outlines (fix round 1, I1): two calls at their cap, about 1.5 s in Node.
 * Past it the pass keeps what it did before M5 Task 4 (`nonzero-approx`, `clip-dropped`) and notes the slide. Each of
 * the three passes that outline has its own (final review Minor 2): the clip pass, the picture pass and the fill rule,
 * and the elements of undrawn fallbacks one more between them (index.ts `revertPasses`), so a slide spends at most four
 * times this, about 6 s.
 */
export const SLIDE_REGION_WORK = 2 * REGION_MAX_WORK;
/** Grid coordinates stay within ±2^25 (32,768 pt), so that each cross product of two differences is below 2^53. */
const MAX_COORD = 2 ** 25;
/** A loop enclosing less than this (grid units squared) is dropped: a sliver of rounding. */
const MIN_LOOP_AREA = 1;

/** One operand: polygons (pt, x0 y0 x1 y1 ..., each closed by itself) and the rule it is filled by. */
export interface RegionOperand {
  polygons: readonly (readonly number[])[];
  rule: 'nonzero' | 'evenodd';
}

/**
 * `'all'`: inside every operand. `'minus'`: inside the first and none of the others. Or any test of which operands a
 * point is inside (one boolean an operand, in order).
 */
export type RegionCombine = 'all' | 'minus' | ((inside: readonly boolean[]) => boolean);

/**
 * The loops (pt, x0 y0 x1 y1 ..., closed by themselves), the region on the right of each (clockwise on the page);
 * `'too-large'` past a cap of one call, `'over-budget'` past the caller's budget.
 */
export type RegionResult = { loops: number[][] } | 'too-large' | 'over-budget';

/** Why a call stopped: its cap of points, of coordinates, of crossings, of steps or of pieces, the budget, or no loop. */
export type RegionRefusal = 'points' | 'range' | 'crossings' | 'work' | 'pieces' | 'budget' | 'link';

/** Steps a caller lets its calls spend in all (`left`, paid as they go), and why the last one stopped. */
export interface RegionBudget {
  left: number;
  refused?: RegionRefusal;
}

/** The steps one call has spent, and what it may: the less of its cap and its budget's. */
interface Meter {
  work: number;
  limit: number;
  /** Whether the limit is the budget's. */
  budget: boolean;
}

/**
 * A sort of `n` items, in steps: n for each halving, ⌈log2(n + 1)⌉ of them, the bits of n (final review Minor 1: not
 * `Math.log2`, which ECMAScript leaves approximated, in a meter that decides `'over-budget'` and so the output).
 */
const sortSteps = (n: number): number => n * Math.max(1, 32 - Math.clz32(n));

interface Edge {
  id: number;
  op: number;
  /** +1 where the polygon runs down the page (y growing) along it, −1 where it runs up. */
  dir: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** x of an edge at height y (its own end points exactly at their heights). */
function xAt(e: Edge, y: number): number {
  if (y === e.y0) return e.x0;
  if (y === e.y1) return e.x1;
  return e.x0 + ((e.x1 - e.x0) * (y - e.y0)) / (e.y1 - e.y0);
}

/** The cross product of (b − a) and (c − a): exact for grid points. */
const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

const insideOf = (rule: 'nonzero' | 'evenodd', w: number): boolean => (rule === 'nonzero' ? w !== 0 : w % 2 !== 0);

/** The boundary pieces, kept in flat arrays: start, end and source (an edge's id, or −1 − a slab line's index). */
class Pieces {
  x0: number[] = [];
  y0: number[] = [];
  x1: number[] = [];
  y1: number[] = [];
  src: number[] = [];
  add(x0: number, y0: number, x1: number, y1: number, src: number): boolean {
    if (x0 === x1 && y0 === y1) return true;
    this.x0.push(x0);
    this.y0.push(y0);
    this.x1.push(x1);
    this.y1.push(y1);
    this.src.push(src);
    return this.src.length <= REGION_MAX_PIECES;
  }
}

/**
 * The outline of the region `combine` makes of `operands` (module comment): loops in pt whose even-odd fill is it, none
 * for an empty region; `'too-large'` past a cap, `'over-budget'` past `budget`, which pays the steps spent either way.
 */
export function regionOutline(operands: readonly RegionOperand[], combine: RegionCombine, budget?: RegionBudget): RegionResult {
  const left = budget === undefined ? Infinity : budget.left;
  const meter: Meter = { work: 0, limit: Math.min(REGION_MAX_WORK, left), budget: !(left >= REGION_MAX_WORK) };
  const result = sweep(operands, combine, meter);
  if (budget !== undefined) {
    budget.left -= meter.work;
    if (typeof result === 'string') budget.refused = result;
    else delete budget.refused;
  }
  if (typeof result !== 'string') return result;
  return result === 'budget' ? 'over-budget' : 'too-large';
}

/** `regionOutline`'s work, which says why it stopped. */
function sweep(operands: readonly RegionOperand[], combine: RegionCombine, meter: Meter): { loops: number[][] } | RegionRefusal {
  /** Spends `n` steps; the refusal when that is past the limit. */
  const spend = (n: number): RegionRefusal | null => {
    meter.work += n;
    return !(meter.work <= meter.limit) ? (meter.budget ? 'budget' : 'work') : null;
  };
  // 1. edges on the grid
  let points = 0;
  for (const operand of operands) for (const poly of operand.polygons) points += Math.floor(poly.length / 2);
  if (!(points <= REGION_MAX_POINTS)) return 'points';
  const paid = spend(points);
  if (paid !== null) return paid;
  const edges: Edge[] = [];
  for (const [op, operand] of operands.entries()) {
    for (const poly of operand.polygons) {
      const n = Math.floor(poly.length / 2);
      if (n < 2) continue;
      const gx: number[] = [];
      const gy: number[] = [];
      for (let i = 0; i < n; i++) {
        const x = Math.round(poly[2 * i]! * REGION_GRID);
        const y = Math.round(poly[2 * i + 1]! * REGION_GRID);
        if (!(Math.abs(x) <= MAX_COORD && Math.abs(y) <= MAX_COORD)) return 'range';
        gx.push(x);
        gy.push(y);
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const [ax, ay, bx, by] = [gx[i]!, gy[i]!, gx[j]!, gy[j]!];
        if (ay === by) continue; // horizontal: no winding across it; the slab lines give the region's horizontal sides
        edges.push(ay < by ? { id: edges.length, op, dir: 1, x0: ax, y0: ay, x1: bx, y1: by } : { id: edges.length, op, dir: -1, x0: bx, y0: by, x1: ax, y1: ay });
      }
    }
  }
  const within = operands.map(() => false);
  const test =
    combine === 'all'
      ? (b: readonly boolean[]) => b.every(Boolean)
      : combine === 'minus'
        ? (b: readonly boolean[]) => b[0]! && b.every((v, i) => i === 0 || !v)
        : combine;
  const inside = (w: readonly number[]): boolean => {
    for (let i = 0; i < operands.length; i++) within[i] = insideOf(operands[i]!.rule, w[i]!);
    return test(within);
  };

  // 2. the heights of the slabs: the points' and the crossings'
  const sorted = spend(3 * sortSteps(edges.length)); // by x, by y, and the heights
  if (sorted !== null) return sorted;
  const heights: number[] = [];
  for (const e of edges) heights.push(e.y0, e.y1);
  const byX = edges.slice().sort((a, b) => Math.min(a.x0, a.x1) - Math.min(b.x0, b.x1) || a.id - b.id);
  let crossings = 0;
  for (let i = 0; i < byX.length; i++) {
    const e = byX[i]!;
    const right = Math.max(e.x0, e.x1);
    for (let j = i + 1; j < byX.length; j++) {
      const f = byX[j]!;
      if (Math.min(f.x0, f.x1) > right) break;
      const tested = spend(1);
      if (tested !== null) return tested;
      const lo = Math.max(e.y0, f.y0);
      const hi = Math.min(e.y1, f.y1);
      if (lo >= hi) continue;
      const d1 = orient(e.x0, e.y0, e.x1, e.y1, f.x0, f.y0);
      const d2 = orient(e.x0, e.y0, e.x1, e.y1, f.x1, f.y1);
      if (!((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0))) continue;
      const d3 = orient(f.x0, f.y0, f.x1, f.y1, e.x0, e.y0);
      const d4 = orient(f.x0, f.y0, f.x1, f.y1, e.x1, e.y1);
      if (!((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) continue;
      const y = e.y0 + (e.y1 - e.y0) * (d3 / (d3 - d4));
      if (y > lo && y < hi) heights.push(y);
      if (++crossings > REGION_MAX_CROSSINGS) return 'crossings';
    }
  }
  heights.sort((a, b) => a - b);
  const ys: number[] = [];
  for (const y of heights) if (ys.length === 0 || ys[ys.length - 1] !== y) ys.push(y);

  // 3, 4. the slabs, their trapezoids, and the horizontal runs on each slab line
  const pieces = new Pieces();
  const byY = edges.slice().sort((a, b) => a.y0 - b.y0 || a.id - b.id);
  let active: Edge[] = [];
  let next = 0;
  /** Directed horizontal runs on the line being finished: from x0 to x1. */
  let runs: number[] = [];
  const windings = operands.map(() => 0);
  const flushLine = (line: number): boolean => {
    const deltas = new Map<number, number>();
    for (let r = 0; r < runs.length; r += 2) {
      const [a, b] = [runs[r]!, runs[r + 1]!];
      if (a === b) continue;
      const [lo, hi, s] = a < b ? [a, b, 1] : [b, a, -1];
      deltas.set(lo, (deltas.get(lo) ?? 0) + s);
      deltas.set(hi, (deltas.get(hi) ?? 0) - s);
    }
    runs = [];
    const xs = [...deltas.keys()].sort((a, b) => a - b);
    const y = ys[line]!;
    let net = 0;
    for (let k = 0; k + 1 < xs.length; k++) {
      net += deltas.get(xs[k]!)!;
      for (let m = 0; m < Math.abs(net); m++) {
        const ok = net > 0 ? pieces.add(xs[k]!, y, xs[k + 1]!, y, -1 - line) : pieces.add(xs[k + 1]!, y, xs[k]!, y, -1 - line);
        if (!ok) return false;
      }
    }
    return true;
  };
  for (let k = 0; k + 1 < ys.length; k++) {
    const [ya, yb] = [ys[k]!, ys[k + 1]!];
    active = active.filter((e) => e.y1 > ya);
    while (next < byY.length && byY[next]!.y0 <= ya) {
      const e = byY[next++]!;
      if (e.y1 > ya) active.push(e);
    }
    const met = spend(active.length);
    if (met !== null) return met;
    const ym = (ya + yb) / 2;
    const keyed = active.map((e) => ({ e, m: xAt(e, ym), a: xAt(e, ya), b: xAt(e, yb) }));
    keyed.sort((p, q) => p.m - q.m || p.a - q.a || p.b - q.b || p.e.id - q.e.id);
    windings.fill(0);
    const spans: { l: (typeof keyed)[number]; r: (typeof keyed)[number] }[] = [];
    let open: (typeof keyed)[number] | null = null;
    for (const s of keyed) {
      windings[s.e.op]! += s.e.dir;
      const now = inside(windings);
      if (now && open === null) open = s;
      else if (!now && open !== null) {
        const last = spans[spans.length - 1];
        // a gap of no width (two edges along each other) joins its neighbours into one span
        if (last !== undefined && last.r.a === open.a && last.r.b === open.b) last.r = s;
        else spans.push({ l: open, r: s });
        open = null;
      }
    }
    for (const { l, r } of spans) {
      if (l.a === r.a && l.b === r.b) continue;
      if (!pieces.add(l.b, yb, l.a, ya, l.e.id) || !pieces.add(r.a, ya, r.b, yb, r.e.id)) return 'pieces';
      runs.push(l.a, r.a);
    }
    if (!flushLine(k)) return 'pieces';
    for (const { l, r } of spans) if (!(l.a === r.a && l.b === r.b)) runs.push(r.b, l.b);
  }
  if (ys.length > 0 && !flushLine(ys.length - 1)) return 'pieces';

  // 5. loops
  const loops = linkLoops(pieces);
  return loops === null ? 'link' : { loops };
}

/** The pieces linked into loops, rounded to the grid and simplified, in pt; null when some piece cannot be closed. */
function linkLoops(pieces: Pieces): number[][] | null {
  const n = pieces.src.length;
  const key = (x: number, y: number): string => `${x},${y}`;
  const out = new Map<string, { list: number[]; at: number }>();
  for (let p = 0; p < n; p++) {
    const k = key(pieces.x0[p]!, pieces.y0[p]!);
    const entry = out.get(k);
    if (entry === undefined) out.set(k, { list: [p], at: 0 });
    else entry.list.push(p);
  }
  const used = new Uint8Array(n);
  const loops: number[][] = [];
  for (let first = 0; first < n; first++) {
    if (used[first]) continue;
    const xs: number[] = [];
    const ys: number[] = [];
    const src: number[] = [];
    let p = first;
    for (;;) {
      used[p] = 1;
      xs.push(pieces.x0[p]!);
      ys.push(pieces.y0[p]!);
      src.push(pieces.src[p]!);
      const entry = out.get(key(pieces.x1[p]!, pieces.y1[p]!));
      if (entry === undefined) return null;
      while (entry.at < entry.list.length && used[entry.list[entry.at]!]) entry.at++;
      if (entry.at === entry.list.length) break;
      p = entry.list[entry.at]!;
    }
    if (pieces.x1[p] !== pieces.x0[first] || pieces.y1[p] !== pieces.y0[first]) return null;
    const loop = simplify(xs, ys, src);
    if (loop !== null) loops.push(loop);
  }
  return loops;
}

/**
 * A loop (point i starts piece i, from source `src[i]`) rounded to the grid, in pt: a point between two pieces of one
 * source dropped (one edge across slabs, one slab line), then repeated points and points on the line through their
 * neighbours (going on, or turning back: a spike of no area), whose even-odd fill is the same without them; in one pass
 * with a stack, then across the loop's start. Null when less than a grid cell is left.
 */
function simplify(xs: readonly number[], ys: readonly number[], src: readonly number[]): number[] | null {
  const n = xs.length;
  const px: number[] = [];
  const py: number[] = [];
  const push = (x: number, y: number): void => {
    const k = px.length;
    if (k > 0 && px[k - 1] === x && py[k - 1] === y) return;
    while (px.length >= 2 && orient(px[px.length - 2]!, py[py.length - 2]!, px[px.length - 1]!, py[py.length - 1]!, x, y) === 0) {
      px.pop();
      py.pop();
    }
    if (px.length > 0 && px[px.length - 1] === x && py[py.length - 1] === y) return;
    px.push(x);
    py.push(y);
  };
  for (let i = 0; i < n; i++) if (src[(i + n - 1) % n] !== src[i]) push(Math.round(xs[i]!), Math.round(ys[i]!));
  // across the start: the last points against the first, and the first against the last
  let from = 0;
  for (let changed = true; changed && px.length - from >= 3; ) {
    changed = false;
    const last = px.length - 1;
    if (px[last] === px[from] && py[last] === py[from]) {
      px.pop();
      py.pop();
      changed = true;
    } else if (orient(px[last - 1]!, py[last - 1]!, px[last]!, py[last]!, px[from]!, py[from]!) === 0) {
      px.pop();
      py.pop();
      changed = true;
    } else if (orient(px[last]!, py[last]!, px[from]!, py[from]!, px[from + 1]!, py[from + 1]!) === 0) {
      from += 1;
      changed = true;
    }
  }
  const m = px.length - from;
  if (m < 3) return null;
  // the area about the loop's first point: each product of two differences is exact (each below 2^26), the sum near it
  let twice = 0;
  const [ox, oy] = [px[from]!, py[from]!];
  for (let i = 1; i + 1 < m; i++) {
    const a = from + i;
    const b = from + i + 1;
    twice += (px[a]! - ox) * (py[b]! - oy) - (px[b]! - ox) * (py[a]! - oy);
  }
  if (Math.abs(twice) / 2 < MIN_LOOP_AREA) return null;
  const out: number[] = [];
  for (let i = from; i < px.length; i++) out.push(px[i]! / REGION_GRID, py[i]! / REGION_GRID);
  return out;
}

/** The signed area (pt²) of loops, positive clockwise on the page (y down). */
export function loopsArea(loops: readonly (readonly number[])[]): number {
  let twice = 0;
  for (const p of loops) {
    const n = p.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      twice += p[2 * i]! * p[2 * j + 1]! - p[2 * j]! * p[2 * i + 1]!;
    }
  }
  return twice / 2;
}

/** Loops as a path: `M`, `L` to each further point, `Z`, loop after loop. */
export function loopsPath(loops: readonly (readonly number[])[]): PathSeg[] {
  const out: PathSeg[] = [];
  for (const p of loops) {
    out.push(['M', p[0]!, p[1]!]);
    for (let i = 2; i < p.length; i += 2) out.push(['L', p[i]!, p[i + 1]!]);
    out.push(['Z']);
  }
  return out;
}
