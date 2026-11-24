import { describe, expect, it } from 'vitest';
import type { PathSeg } from '../../src/extract/inventory';
import { coverage, DASH_SOLID_NOTE, flattenedPoints, flattenPath, flattenWithin, MAX_DASH_PIECES, SS, strokeOutline, type Grid } from '../../src/raster/paint';
import { circle, lineStyle, rectPath, square } from '../helpers/passes';

/**
 * The raster renderer's coverage (M5 Task 2): 4 x 4 samples a pixel, each in or out, so a pixel's coverage is a whole
 * number of sixteenths, the same in every engine. Fills by the nonzero and even-odd rules; strokes become fill outlines.
 */

/** A grid of `w` x `h` pt at 2 px a pt from (0, 0). */
const grid = (w: number, h: number, s = 2): Grid => ({ x0: 0, y0: 0, w: w * s, h: h * s, s });

/** The coverage as rows of numbers 0..16, to read in a failing test. */
const rows = (cov: Uint8Array, g: Grid): number[][] => Array.from({ length: g.h }, (_, j) => Array.from(cov.subarray(j * g.w, (j + 1) * g.w)));

const sum = (cov: Uint8Array): number => cov.reduce((n, c) => n + c, 0);

describe('coverage', () => {
  it('counts 4 x 4 samples a pixel: a rect on pixel edges covers whole pixels, 16 each', () => {
    const g = grid(4, 3);
    const cov = coverage(flattenPath(rectPath(1, 0.5, 2, 1), 0.01), 'nonzero', g);
    expect(SS).toBe(4);
    expect(rows(cov, g)).toEqual([
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 16, 16, 16, 16, 0, 0],
      [0, 0, 16, 16, 16, 16, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
  });

  it('a pixel an edge halves has 8 of 16; a quarter-pixel edge 12 or 4 (sample centres, never areas)', () => {
    const g = grid(2, 1);
    // x from 0.25 pt (pixel 0.5) to 1.125 pt (pixel 2.25), full height.
    const cov = coverage(flattenPath(rectPath(0.25, 0, 0.875, 1), 0.01), 'nonzero', g);
    expect(rows(cov, g)[0]).toEqual([8, 16, 4, 0]);
  });

  it('nonzero fills a square nested in one of the same direction; even-odd leaves it a hole', () => {
    const g = grid(10, 10, 1);
    const path = [...square(0, 0, 10, 'cw'), ...square(3, 3, 4, 'cw')];
    expect(sum(coverage(flattenPath(path, 0.01), 'nonzero', g))).toBe(100 * 16);
    expect(sum(coverage(flattenPath(path, 0.01), 'evenodd', g))).toBe((100 - 16) * 16);
    // Opposite directions: a hole by either rule.
    const holed = [...square(0, 0, 10, 'cw'), ...square(3, 3, 4, 'ccw')];
    expect(sum(coverage(flattenPath(holed, 0.01), 'nonzero', g))).toBe((100 - 16) * 16);
  });

  it('flattens curves within the tolerance: a circle of radius 10 pt covers pi r^2 within half a percent', () => {
    const g = grid(24, 24);
    const cov = coverage(flattenPath(circle(12, 12, 10), 0.025), 'nonzero', g);
    const pt2 = sum(cov) / 16 / (g.s * g.s);
    expect(Math.abs(pt2 / (Math.PI * 100) - 1)).toBeLessThan(0.005);
  });

  it('closes an open subpath for a fill, and a path of no area covers nothing', () => {
    const g = grid(4, 4, 1);
    const open: PathSeg[] = [['M', 0, 0], ['L', 4, 0], ['L', 4, 4], ['L', 0, 4]];
    expect(sum(coverage(flattenPath(open, 0.01), 'nonzero', g))).toBe(16 * 16);
    expect(sum(coverage(flattenPath([['M', 0, 0], ['L', 4, 4]], 0.01), 'nonzero', g))).toBe(0);
  });
});

describe('strokeOutline: a stroke as fill outlines, filled nonzero', () => {
  const g = grid(8, 4, 1);
  const line: PathSeg[] = [['M', 2, 2], ['L', 6, 2]];

  it('a butt line of width 2 covers its rectangle exactly', () => {
    const cov = coverage(strokeOutline(line, lineStyle({ w: 2, cap: 'butt' }), 0.01, 0.5), 'nonzero', g);
    expect(rows(cov, g)).toEqual([
      [0, 0, 0, 0, 0, 0, 0, 0],
      [0, 0, 16, 16, 16, 16, 0, 0],
      [0, 0, 16, 16, 16, 16, 0, 0],
      [0, 0, 0, 0, 0, 0, 0, 0],
    ]);
  });

  it('a square cap reaches half the width past each end; a round cap a half disc', () => {
    const square = coverage(strokeOutline(line, lineStyle({ w: 2, cap: 'square' }), 0.01, 0.5), 'nonzero', g);
    expect(rows(square, g)[1]).toEqual([0, 16, 16, 16, 16, 16, 16, 0]);
    // At 8 px a pt, the samples measure the area to within 0.5 %.
    const fine = grid(8, 4, 8);
    const round = coverage(strokeOutline(line, lineStyle({ w: 2, cap: 'round' }), 0.01, 0.5), 'nonzero', fine);
    const area = sum(round) / 16 / 64;
    expect(Math.abs(area / (8 + Math.PI) - 1)).toBeLessThan(0.005);
  });

  it('dashes: [1 1] from phase 0 draws every other pt; a phase shifts them', () => {
    const dashed = coverage(strokeOutline(line, lineStyle({ w: 2, cap: 'butt', dash: [1, 1], phase: 0 }), 0.01, 0.5), 'nonzero', g);
    expect(rows(dashed, g)[1]).toEqual([0, 0, 16, 0, 16, 0, 0, 0]);
    const shifted = coverage(strokeOutline(line, lineStyle({ w: 2, cap: 'butt', dash: [1, 1], phase: 1 }), 0.01, 0.5), 'nonzero', g);
    expect(rows(shifted, g)[1]).toEqual([0, 0, 0, 16, 0, 16, 0, 0]);
  });

  it('a miter join fills the corner; a bevel cuts it; overlaps are not cancelled', () => {
    const corner: PathSeg[] = [['M', 1, 1], ['L', 5, 1], ['L', 5, 3.5]];
    const g2 = grid(8, 4, 4);
    const miter = sum(coverage(strokeOutline(corner, lineStyle({ w: 1, join: 'miter' }), 0.01, 0.1), 'nonzero', g2));
    const bevel = sum(coverage(strokeOutline(corner, lineStyle({ w: 1, join: 'bevel' }), 0.01, 0.1), 'nonzero', g2));
    // The miter adds the 0.5 x 0.5 pt corner square; the bevel only its half.
    expect((miter - bevel) / 16 / 16).toBeCloseTo(0.125, 1);
    // Area: two arms of 4 x 1 and 1 x 2.5 pt sharing a 0.5 x 0.5 square, and the miter's outer 0.5 x 0.5 corner.
    expect(miter / 16 / 16).toBeCloseTo(4 + 2.5 - 0.25 + 0.25, 1);
  });

  it('a zero width is one pixel wide', () => {
    const cov = coverage(strokeOutline(line, lineStyle({ w: 0, cap: 'butt' }), 0.01, 1), 'nonzero', grid(8, 4, 1));
    expect(sum(cov) / 16).toBeCloseTo(4, 5);
  });
});

describe('hostile dashes (fix round 1, I2): the pieces a stroke makes are bounded', () => {
  const long: PathSeg[] = [['M', 0, 2], ['L', 4000, 2]];

  it('a pattern of more pieces than MAX_DASH_PIECES is drawn solid, with a note, in bounded time', () => {
    expect(MAX_DASH_PIECES).toBe(10_000);
    const notes = new Set<string>();
    const started = performance.now();
    // 0.002 pt dashes on 4000 pt: a million pieces, were they made
    const polys = strokeOutline(long, lineStyle({ w: 2, dash: [0.002, 0.002] }), 0.01, 0.5, notes);
    expect(performance.now() - started, 'a hang guard').toBeLessThan(1_000);
    expect(polys).toHaveLength(1); // the undashed line: one quad
    expect([...notes]).toEqual([DASH_SOLID_NOTE]);
  });

  it('the cap counts the pieces the pattern would make: 5,000 are dashes, 20,000 a solid line', () => {
    const notes = new Set<string>();
    expect(strokeOutline(long, lineStyle({ w: 2, dash: [0.4, 0.4] }), 0.01, 0.5, notes)).toHaveLength(5_000);
    expect(notes.size).toBe(0);
    expect(strokeOutline(long, lineStyle({ w: 2, dash: [0.2, 0.2] }), 0.01, 0.5, notes)).toHaveLength(1);
    expect([...notes]).toEqual([DASH_SOLID_NOTE]);
  });
});

describe('geometry counted before it is made (final review C1)', () => {
  /** One cubic whose handles reach about 30,000 pt: 1,024 pieces at any raster tolerance. */
  const hostile = (n: number): PathSeg[] => {
    const geom: PathSeg[] = [['M', 10, 10]];
    for (let i = 0; i < n; i++) geom.push(['C', 30_000, -30_000, -30_000, 30_000, 10 + (i % 100), 10 + (i % 50)]);
    geom.push(['Z']);
    return geom;
  };
  const made = (lines: ReturnType<typeof flattenPath>): number => lines.reduce((n, l) => n + l.pts.length / 2, 0);

  it('flattenedPoints is the number of points flattenPath makes, without making them', () => {
    const afterClose: PathSeg[] = [['M', 0, 0], ['L', 4, 0], ['L', 4, 4], ['Z'], ['L', 8, 8], ['C', 9, 9, 10, 8, 12, 12]];
    for (const [geom, tol] of [
      [rectPath(1, 0.5, 2, 1), 0.01],
      [circle(12, 12, 10), 0.025],
      [circle(12, 12, 10), 0.0001],
      [afterClose, 0.01],
      [[['M', 1, 1]] as PathSeg[], 0.01],
      [hostile(3), 0.025],
    ] as const) {
      expect(flattenedPoints(geom, tol)).toBe(made(flattenPath(geom, tol)));
    }
  });

  it('it stops counting once past its limit: 24,000 hostile cubics are told apart in no time', () => {
    const geom = hostile(24_000);
    const started = performance.now();
    const n = flattenedPoints(geom, 0.025, 1_000_000);
    expect(performance.now() - started, 'a hang guard').toBeLessThan(200);
    expect(n).toBeGreaterThan(1_000_000);
    expect(n).toBeLessThan(1_000_000 + 2_000);
  });

  it('strokeOutline with a budget: the same polygons, their points taken off it; past it null, nothing made or taken', () => {
    const corner: PathSeg[] = [['M', 1, 1], ['L', 5, 1], ['C', 6, 1, 6, 3, 5, 3.5]];
    for (const style of [lineStyle({ w: 1, join: 'round', cap: 'round' }), lineStyle({ w: 1, cap: 'square', dash: [0.5, 0.25], phase: 0 }), lineStyle({ w: 1 })]) {
      const free = strokeOutline(corner, style, 0.01, 0.1);
      const budget = { left: 1_000_000 };
      const counted = strokeOutline(corner, style, 0.01, 0.1, undefined, budget);
      expect(counted).toEqual(free);
      const points = free.reduce((n, p) => n + p.length / 2, 0);
      // what it took holds every point it made: the polylines' and the polygons' (an upper bound, counted first)
      expect(1_000_000 - budget.left).toBeGreaterThanOrEqual(points + made(flattenPath(corner, 0.01)));
      const tight = { left: points };
      expect(strokeOutline(corner, style, 0.01, 0.1, undefined, tight)).toBeNull();
      expect(tight.left).toBe(points);
    }
    const started = performance.now();
    const budget = { left: 1_000_000 };
    expect(strokeOutline(hostile(24_000), lineStyle({ w: 4, join: 'round' }), 0.025, 0.5, undefined, budget)).toBeNull();
    expect(performance.now() - started, 'a hang guard').toBeLessThan(200);
    expect(budget.left).toBe(1_000_000);
  });

  it('flattenWithin: the polylines, their points taken off the budget; past it null and nothing taken', () => {
    const budget = { left: 1_000 };
    const lines = flattenWithin(circle(12, 12, 10), 0.025, budget)!;
    expect(lines).toEqual(flattenPath(circle(12, 12, 10), 0.025));
    expect(budget.left).toBe(1_000 - made(lines));
    const small = { left: 10 };
    expect(flattenWithin(circle(12, 12, 10), 0.025, small)).toBeNull();
    expect(small.left).toBe(10);
  });
});

describe('NaN budgets (M6): a count compared with what is left must not slip past on NaN', () => {
  const square10: PathSeg[] = rectPath(0, 0, 10, 10);
  it('flattenWithin and strokeOutline refuse a NaN budget and take nothing', () => {
    const budget = { left: Number.NaN };
    expect(flattenWithin(square10, 0.01, budget)).toBeNull();
    expect(strokeOutline(square10, lineStyle({ w: 2 }), 0.01, 0.5, undefined, budget)).toBeNull();
  });
  it('flattenedPoints stops counting at a NaN limit as at a spent one', () => {
    expect(flattenedPoints(square10, 0.01, Number.NaN)).toBeGreaterThanOrEqual(1);
    expect(Number.isNaN(flattenedPoints(square10, 0.01, Number.NaN))).toBe(false);
  });
});
