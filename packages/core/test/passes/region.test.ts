import { describe, expect, it, vi } from 'vitest';
import {
  loopsArea,
  loopsPath,
  REGION_GRID,
  REGION_MAX_CROSSINGS,
  REGION_MAX_PIECES,
  REGION_MAX_POINTS,
  REGION_MAX_WORK,
  regionOutline,
  type RegionBudget,
  type RegionOperand,
} from '../../src/passes/region';

/**
 * M5 Task 4: the polygon outlines behind the nonzero union (fill rule) and the clip intersection (clip pass). A region
 * is given by polygons (pt, x0 y0 x1 y1 ...) under a fill rule; the outline is closed loops whose even-odd fill is the
 * region, on a grid of 1/REGION_GRID pt.
 */

const sq = (x: number, y: number, s: number, dir: 'cw' | 'ccw' = 'cw'): number[] =>
  dir === 'cw' ? [x, y, x + s, y, x + s, y + s, x, y + s] : [x, y, x, y + s, x + s, y + s, x + s, y];
const op = (polygons: number[][], rule: 'nonzero' | 'evenodd' = 'nonzero'): RegionOperand => ({ polygons, rule });

/** The area of the even-odd fill of loops, by a fine scan (independent of the loops' own directions). */
function evenOddArea(loops: readonly number[][], box: [number, number, number, number], step = 0.25): number {
  let area = 0;
  for (let y = box[1] + step / 2; y < box[3]; y += step) {
    for (let x = box[0] + step / 2; x < box[2]; x += step) {
      let odd = false;
      for (const p of loops) {
        const n = p.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const [xi, yi, xj, yj] = [p[2 * i]!, p[2 * i + 1]!, p[2 * j]!, p[2 * j + 1]!];
          if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) odd = !odd;
        }
      }
      if (odd) area += step * step;
    }
  }
  return area;
}

function loopsOf(result: ReturnType<typeof regionOutline>): number[][] {
  if (typeof result === 'string') throw new Error(result);
  return result.loops;
}

describe('region outlines', () => {
  it('two overlapping squares of one direction: one outline of their union (nonzero)', () => {
    const loops = loopsOf(regionOutline([op([sq(0, 0, 100), sq(50, 50, 100)])], 'all'));
    expect(loops).toHaveLength(1);
    expect(loops[0]!.length / 2).toBe(8); // an L-less union: 8 corners
    expect(Math.abs(loopsArea(loops))).toBe(100 * 100 * 2 - 50 * 50);
    expect(evenOddArea(loops, [0, 0, 150, 150], 1)).toBe(17500);
  });

  it('a self-crossing loop filled nonzero: the folded part counts once (atlas lines/06–11, an outlined elbow)', () => {
    // the elbow of shapes/20 p20:z134 without its curves: the inner corner folds back over the bar (winding 2 there)
    const elbow = [174, 348, 230, 348, 230, 399, 229, 398, 279, 398, 279, 400, 228, 400, 228, 349, 229, 350, 174, 350];
    const loops = loopsOf(regionOutline([op([elbow])], 'all'));
    // nonzero area: the top bar 56 x 2, the vertical bar 2 x 52, the bottom bar 51 x 2, less their two overlaps
    const expected = 56 * 2 + 2 * 52 + 51 * 2 - 2 * 2 - 2 * 2;
    expect(Math.abs(loopsArea(loops))).toBeCloseTo(expected, 6);
    expect(evenOddArea(loops, [170, 345, 285, 405], 0.125)).toBeCloseTo(expected, 3);
    // even-odd of the input itself leaves the folds out: the outline is what the PDF fills
    const raw = evenOddArea([elbow], [170, 345, 285, 405], 0.125);
    expect(raw).toBeLessThan(expected);
  });

  it('a pentagram filled nonzero is its whole star; filled even-odd it keeps the pentagon hole', () => {
    const star: number[] = [0, 2, 4, 1, 3].flatMap((k) => {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
      return [Math.round((100 + 80 * Math.cos(a)) * 1000) / 1000, Math.round((100 + 80 * Math.sin(a)) * 1000) / 1000];
    });
    const nz = loopsOf(regionOutline([op([star], 'nonzero')], 'all'));
    const eo = loopsOf(regionOutline([op([star], 'evenodd')], 'all'));
    expect(nz).toHaveLength(1);
    expect(nz[0]!.length / 2).toBe(10);
    // even-odd leaves the pentagon in the middle empty: its area is the difference
    const box: [number, number, number, number] = [15, 15, 185, 185];
    expect(evenOddArea(nz, box, 0.5) - evenOddArea(eo, box, 0.5)).toBeGreaterThan(1500);
    expect(evenOddArea(eo, box, 0.5)).toBeCloseTo(evenOddArea([star], box, 0.5), 0);
  });

  it('opposite directions cancel under nonzero: a square over the same square backwards is nothing', () => {
    expect(loopsOf(regionOutline([op([sq(0, 0, 10), sq(0, 0, 10, 'ccw')])], 'all'))).toEqual([]);
  });

  it('intersection and difference: a square and a triangle clip', () => {
    const tri = [50, 150, 250, 150, 150, 30];
    const rect = sq(60, 40, 180);
    const both = loopsOf(regionOutline([op([rect]), op([tri])], 'all'));
    expect(both).toHaveLength(1);
    const outside = loopsOf(regionOutline([op([rect]), op([tri])], 'minus'));
    expect(Math.abs(loopsArea(both)) + Math.abs(loopsArea(outside))).toBeCloseTo(180 * 180, 6);
    // a square well inside the triangle: nothing of it outside, so the clip cuts nothing
    expect(loopsOf(regionOutline([op([sq(140, 110, 20)]), op([tri])], 'minus'))).toEqual([]);
  });

  it('shared edges leave no sliver: a square split in two halves is one square', () => {
    const left = [0, 0, 50, 0, 50, 100, 0, 100];
    const right = [50, 0, 100, 0, 100, 100, 50, 100];
    const loops = loopsOf(regionOutline([op([left, right])], 'all'));
    expect(loops).toHaveLength(1);
    expect(loops[0]!.length / 2).toBe(4);
    expect(Math.abs(loopsArea(loops))).toBe(10000);
  });

  it('holes run the other way: a ring is two loops, filled even-odd', () => {
    const loops = loopsOf(regionOutline([op([sq(0, 0, 100), sq(25, 25, 50, 'ccw')])], 'all'));
    expect(loops).toHaveLength(2);
    expect(Math.abs(loopsArea(loops))).toBe(10000 - 2500);
    expect(Math.sign(loopsArea([loops[0]!]))).toBe(-Math.sign(loopsArea([loops[1]!])));
  });

  it('points are snapped to the grid, and the output lies on it', () => {
    const loops = loopsOf(regionOutline([op([[0.0001, 0, 10, 0.0002, 10, 10, 0, 10]])], 'all'));
    for (const v of loops.flat()) expect(Number.isInteger(v * REGION_GRID)).toBe(true);
    expect(loops[0]![0]).toBe(0);
  });

  it('is deterministic: the same input gives the same loops, crossings included', () => {
    const many = Array.from({ length: 30 }, (_, i) => sq(i * 3.3, (i * 7.7) % 40, 20 + (i % 5)));
    const a = regionOutline([op(many)], 'all');
    const b = regionOutline([op(many.map((p) => [...p]))], 'all');
    expect(a).toEqual(b);
    expect(loopsOf(a).length).toBeGreaterThan(0);
  });

  it('bounded: past REGION_MAX_POINTS, REGION_MAX_WORK, or off the exact range, it says too-large', () => {
    const big = Array.from({ length: REGION_MAX_POINTS / 4 + 1 }, (_, i) => sq(i % 100, Math.floor(i / 100), 0.5));
    expect(regionOutline([op(big)], 'all')).toBe('too-large');
    // a comb of thin overlapping strips: every strip crosses every other, quadratic work
    const n = Math.ceil(Math.sqrt(REGION_MAX_WORK)) + 10;
    const strips = Array.from({ length: Math.min(n, 2400) }, (_, i) => [i * 0.01, 0, i * 0.01 + 50, 100, i * 0.01 + 50.001, 100, i * 0.01 + 0.001, 0]);
    const t0 = Date.now();
    expect(regionOutline([op([...strips, ...strips.map((s) => [s[0]! + 60, 0, s[2]! - 60, 100, s[4]! - 60, 100, s[6]! + 60, 0])])], 'all')).toBe('too-large');
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(regionOutline([op([[0, 0, 40000, 0, 40000, 10, 0, 10]])], 'all')).toBe('too-large');
  });

  it('random polygons: the even-odd fill of the outline is the combined region at every sample', () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const winding = (p: readonly number[], x: number, y: number): number => {
      let w = 0;
      const n = p.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi, xj, yj] = [p[2 * i]!, p[2 * i + 1]!, p[2 * j]!, p[2 * j + 1]!];
        if (yj <= y && yi > y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) > 0) w += 1;
        else if (yj > y && yi <= y && (xi - xj) * (y - yj) - (x - xj) * (yi - yj) < 0) w -= 1;
      }
      return w;
    };
    for (let trial = 0; trial < 24; trial++) {
      const operands = [0, 1].map((k) => {
        const polys = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
          Array.from({ length: 2 * (3 + Math.floor(rnd() * 6)) }, () => Math.round(rnd() * 100 * 8) / 8),
        );
        return op(polys, (trial + k) % 2 === 0 ? 'nonzero' : 'evenodd');
      });
      const combine = trial % 3 === 0 ? 'minus' : 'all';
      const loops = loopsOf(regionOutline(trial % 4 === 1 ? [operands[0]!] : operands, combine));
      const used = trial % 4 === 1 ? [operands[0]!] : operands;
      let wrong = 0;
      for (let y = 0.37; y < 100; y += 1.3) {
        for (let x = 0.29; x < 100; x += 1.3) {
          const inOp = used.map((o) => {
            const w = o.polygons.reduce((s, p) => s + winding(p, x, y), 0);
            return o.rule === 'nonzero' ? w !== 0 : w % 2 !== 0;
          });
          const want = combine === 'all' ? inOp.every(Boolean) : inOp[0]! && !inOp.slice(1).some(Boolean);
          let odd = false;
          for (const p of loops) if (winding(p, x, y) % 2 !== 0) odd = !odd;
          if (odd !== want) {
            // a sample within the grid's rounding of an edge may fall either side
            let near = Infinity;
            for (const o of used) for (const p of o.polygons) {
              const n = p.length / 2;
              for (let i = 0, j = n - 1; i < n; j = i++) {
                const [ax, ay, bx, by] = [p[2 * j]!, p[2 * j + 1]!, p[2 * i]!, p[2 * i + 1]!];
                const L = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
                const tt = L === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L));
                near = Math.min(near, Math.hypot(x - ax - tt * (bx - ax), y - ay - tt * (by - ay)));
              }
            }
            if (near > 2 / REGION_GRID) wrong += 1;
          }
        }
      }
      expect(wrong, `trial ${trial}`).toBe(0);
    }
  });

  it('an edge along an edge of another operand, slanted: no sliver, either way (fix round 1)', () => {
    // a triangle clip and a shape whose hypotenuse is the clip's side, at coordinates off the grid's binary fractions
    const clip = [50.3, 150.7, 250.1, 150.7, 150.9, 30.2];
    const shape = [50.3, 150.7, 150.9, 30.2, 150.9, 150.7];
    expect(loopsOf(regionOutline([op([shape]), op([clip])], 'minus'))).toEqual([]);
    const both = loopsOf(regionOutline([op([shape]), op([clip])], 'all'));
    expect(both).toHaveLength(1);
    expect(Math.abs(loopsArea(both))).toBeCloseTo(Math.abs(loopsArea([shape])), 1); // the grid's snap of three corners
  });

  it('each cap says which it was: crossings, pieces (fix round 1)', () => {
    // 200 long slanted strips each way: 160,000 crossings, few points and steps
    const strips: number[][] = [];
    for (let i = 0; i < 200; i++) strips.push([0, i * 0.5, 100, i * 0.5 + 0.2, 100, i * 0.5 + 0.3, 0, i * 0.5 + 0.1]);
    for (let i = 0; i < 200; i++) strips.push([i * 0.5, 0, i * 0.5 + 0.2, 100, i * 0.5 + 0.3, 100, i * 0.5 + 0.1, 0]);
    const crossings: RegionBudget = { left: Infinity };
    expect(regionOutline([op(strips)], 'all', crossings)).toBe('too-large');
    expect(crossings.refused).toBe('crossings');
    expect(REGION_MAX_CROSSINGS).toBeLessThan(160_000);
    // 600 parallel thin strips, each starting a little lower: no crossing, but a piece a strip side a slab
    const parallel: number[][] = [];
    for (let i = 0; i < 600; i++) parallel.push([i, i * 0.25, i + 0.2, i * 0.25, i + 10.2, 100 + i * 0.25, i + 10, 100 + i * 0.25]);
    const pieces: RegionBudget = { left: Infinity };
    expect(regionOutline([op(parallel)], 'all', pieces)).toBe('too-large');
    expect(pieces.refused).toBe('pieces');
    expect(REGION_MAX_PIECES).toBe(400_000);
  });

  it('a budget shared by calls: what each spends is taken from it, and past it the answer is over-budget', () => {
    const budget: RegionBudget = { left: 1_000_000 };
    const loops = loopsOf(regionOutline([op([sq(0, 0, 100), sq(50, 50, 100)])], 'all', budget));
    expect(loops).toHaveLength(1);
    expect(budget.left).toBeLessThan(1_000_000);
    expect(budget.left).toBeGreaterThan(1_000_000 - 1000);
    const tight: RegionBudget = { left: 10 };
    expect(regionOutline([op([sq(0, 0, 100), sq(50, 50, 100)])], 'all', tight)).toBe('over-budget');
    expect(tight.refused).toBe('budget');
  });

  it('loopsPath writes M L ... Z per loop', () => {
    expect(loopsPath([[0, 0, 1, 0, 1, 1]])).toEqual([['M', 0, 0], ['L', 1, 0], ['L', 1, 1], ['Z']]);
  });
});

describe('the work meter is the same in every engine (final review Minor 1)', () => {
  it('a sort is metered without Math.log2, which ECMAScript leaves approximated: the same steps whatever it returns', () => {
    const operands = [op([sq(0, 0, 100), sq(50, 50, 100)]), op([sq(25, 25, 100)])];
    const a: RegionBudget = { left: 1_000_000 };
    const ra = regionOutline(operands, 'all', a);
    const spy = vi.spyOn(Math, 'log2').mockImplementation(() => Number.NaN);
    try {
      const b: RegionBudget = { left: 1_000_000 };
      expect(regionOutline(operands, 'all', b)).toEqual(ra);
      expect(b.left).toBe(a.left);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('NaN budgets (M6)', () => {
  it('a NaN budget is past, not unlimited: over-budget, as a spent one', () => {
    const budget: RegionBudget = { left: Number.NaN };
    expect(regionOutline([op([sq(0, 0, 100), sq(50, 50, 100)])], 'all', budget)).toBe('over-budget');
  });
});
