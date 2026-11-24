import { describe, expect, it } from 'vitest';
import type { Matrix } from '../src/extract/gstate';
import type { Box, LineInv, PathSeg } from '../src/extract/inventory';
import { axisAligned, boundsOf, canonicalPath, lineScale, segmentsOf, strokeBounds } from '../src/extract/paths';
import { UnsupportedOpError } from '../src/extract/errors';

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const M = (x: number, y: number): PathSeg => ['M', x, y];
const L = (x: number, y: number): PathSeg => ['L', x, y];
const C = (a: number, b: number, c: number, d: number, e: number, f: number): PathSeg => ['C', a, b, c, d, e, f];
const Z: PathSeg = ['Z'];

describe('segmentsOf', () => {
  // pdf.js DrawOPS: moveTo 0, lineTo 1, curveTo 2, closePath 4.
  it('reads the DrawOPS of a constructPath buffer and moves every point to the slide frame', () => {
    const data = new Float32Array([0, 1, 2, 1, 3, 4, 2, 5, 6, 7, 8, 9, 10, 4]);
    expect(segmentsOf(data, IDENTITY)).toEqual([M(1, 2), L(3, 4), C(5, 6, 7, 8, 9, 10), Z]);
    expect(segmentsOf(data, [2, 0, 0, -1, 10, 100])).toEqual([M(12, 98), L(16, 96), C(20, 94, 24, 92, 28, 90), Z]);
  });

  it('refuses a command it does not know', () => {
    expect(() => segmentsOf([3, 1, 2, 3, 4], IDENTITY)).toThrow(UnsupportedOpError);
  });
});

describe('boundsOf', () => {
  it('counts every point, bezier control points included (0002 §4)', () => {
    expect(boundsOf([M(50, 50), C(50, 150, 200, 150, 200, 50)])).toEqual([50, 50, 200, 150]);
  });

  it('counts a moveTo only once a segment or a close follows it', () => {
    expect(boundsOf([M(200, 200), M(10, 10), L(20, 20), M(100, 100)])).toEqual([10, 10, 20, 20]);
    expect(boundsOf([M(50, 50), Z, M(10, 10), L(20, 20)])).toEqual([10, 10, 50, 50]);
  });

  it('counts a closed moveTo only under a CTM that keeps the axes', () => {
    const path = [M(50, 50), Z, M(10, 10), L(20, 20)];
    expect(boundsOf(path, [1, 0, 0, -1, 0, 300])).toEqual([10, 10, 50, 50]);
    expect(boundsOf(path, [0, 1, 1, 0, 0, 0])).toEqual([10, 10, 50, 50]);
    expect(boundsOf(path, [0.8, 0.6, -0.6, 0.8, 0, 0])).toEqual([10, 10, 20, 20]);
    expect(boundsOf([M(50, 50), Z], [0.8, 0.6, -0.6, 0.8, 0, 0])).toBeNull();
    expect(boundsOf([M(50, 50), L(50, 50)], [0.8, 0.6, -0.6, 0.8, 0, 0])).toEqual([50, 50, 50, 50]);
  });

  it('is null for a path with no segment', () => {
    expect(boundsOf([])).toBeNull();
    expect(boundsOf([M(1, 2)])).toBeNull();
    expect(boundsOf([M(1, 2), M(3, 4)])).toBeNull();
  });

  it('ignores what comes before the first moveTo: there is no current point', () => {
    expect(boundsOf([L(1, 2), C(3, 4, 5, 6, 7, 8), Z])).toBeNull();
    expect(boundsOf([L(1, 2), M(10, 10), L(20, 20)])).toEqual([10, 10, 20, 20]);
  });
});

describe('canonicalPath', () => {
  it('keeps a moveTo+lineTo dot and drops the rest', () => {
    expect(canonicalPath([M(5, 5), L(5, 5)])).toEqual([M(5, 5), L(5, 5)]);
    expect(canonicalPath([M(5, 5), L(5, 5), L(5, 5), L(5, 5)])).toEqual([M(5, 5), L(5, 5)]);
    expect(canonicalPath([M(5, 5), L(5, 5), Z])).toEqual([M(5, 5), L(5, 5), Z]);
    expect(canonicalPath([M(5, 5), L(5, 5), M(9, 9), L(9, 9)])).toEqual([M(5, 5), L(5, 5), M(9, 9), L(9, 9)]);
  });

  it('drops a moveTo followed by a moveTo or by the end', () => {
    expect(canonicalPath([M(1, 1), M(2, 2), L(3, 3)])).toEqual([M(2, 2), L(3, 3)]);
    expect(canonicalPath([M(2, 2), L(3, 3), M(4, 4)])).toEqual([M(2, 2), L(3, 3)]);
    expect(canonicalPath([M(1, 1)])).toEqual([]);
  });

  it('drops a lineTo to the current point, also after a close, whose current point is the subpath start', () => {
    expect(canonicalPath([M(1, 1), L(2, 2), L(2, 2), L(3, 3)])).toEqual([M(1, 1), L(2, 2), L(3, 3)]);
    expect(canonicalPath([M(1, 1), L(2, 2), Z, L(1, 1)])).toEqual([M(1, 1), L(2, 2), Z]);
    expect(canonicalPath([M(1, 1), L(2, 2), Z, L(3, 3)])).toEqual([M(1, 1), L(2, 2), Z, L(3, 3)]);
  });

  it('drops a second close and anything before the first moveTo', () => {
    expect(canonicalPath([M(1, 1), L(2, 2), Z, Z])).toEqual([M(1, 1), L(2, 2), Z]);
    expect(canonicalPath([Z, L(1, 1), C(1, 1, 2, 2, 3, 3), M(4, 4), L(5, 5)])).toEqual([M(4, 4), L(5, 5)]);
    expect(canonicalPath([L(1, 1), Z])).toEqual([]);
  });

  it('makes a curve with no control left a line, and keeps every other curve', () => {
    // First control on the start and last control on the end.
    expect(canonicalPath([M(1, 1), C(1, 1, 9, 9, 9, 9)])).toEqual([M(1, 1), L(9, 9)]);
    // Both controls on the start, both on the end.
    expect(canonicalPath([M(1, 1), C(1, 1, 1, 1, 9, 9)])).toEqual([M(1, 1), L(9, 9)]);
    expect(canonicalPath([M(1, 1), C(9, 9, 9, 9, 9, 9)])).toEqual([M(1, 1), L(9, 9)]);
    // Nothing moves: a dot right after a moveTo, else nothing.
    expect(canonicalPath([M(1, 1), C(1, 1, 1, 1, 1, 1)])).toEqual([M(1, 1), L(1, 1)]);
    expect(canonicalPath([M(1, 1), L(2, 2), C(2, 2, 2, 2, 2, 2)])).toEqual([M(1, 1), L(2, 2)]);
    // A control point of its own: still a curve.
    expect(canonicalPath([M(1, 1), C(1, 1, 5, 6, 9, 9)])).toEqual([M(1, 1), C(1, 1, 5, 6, 9, 9)]);
    expect(canonicalPath([M(1, 1), C(5, 6, 9, 9, 9, 9)])).toEqual([M(1, 1), C(5, 6, 9, 9, 9, 9)]);
    expect(canonicalPath([M(1, 1), C(5, 6, 5, 6, 9, 9)])).toEqual([M(1, 1), C(5, 6, 5, 6, 9, 9)]);
  });

  it('gives a rectangle of no width or height one form, as MuPDF and pdf.js write it', () => {
    // 10 20 0 40 re and 10 20 30 0 re: MuPDF walks four corners, pdf.js writes M L Z.
    expect(canonicalPath([M(10, 20), L(10, 20), L(10, 60), L(10, 60), Z])).toEqual(canonicalPath([M(10, 20), L(10, 60), Z]));
    expect(canonicalPath([M(10, 20), L(40, 20), L(40, 20), L(10, 20), Z])).toEqual(canonicalPath([M(10, 20), L(40, 20), Z]));
    expect(canonicalPath([M(10, 20), L(10, 20), L(10, 20), L(10, 20), Z])).toEqual(canonicalPath([M(10, 20), L(10, 20), Z]));
  });

  it('leaves an ordinary path alone and does not change its argument', () => {
    const path = [M(1, 1), L(2, 1), L(2, 2), C(3, 3, 4, 4, 5, 6), Z, M(7, 7), L(8, 7)];
    const copy = structuredClone(path);
    expect(canonicalPath(path)).toEqual(copy);
    expect(path).toEqual(copy);
  });
});

describe('lineScale', () => {
  it('is √|ad − bc|', () => {
    expect(lineScale(IDENTITY)).toBe(1);
    expect(lineScale([1, 0, 0, -1, 0, 300])).toBe(1);
    expect(lineScale([2, 0, 0, 3, 0, 0])).toBeCloseTo(Math.sqrt(6), 12);
    expect(lineScale([0.8, 0.6, -0.6, 0.8, 7, 9])).toBeCloseTo(1, 12);
    expect(lineScale([1, 0, 0, 0, 0, 0])).toBe(0);
  });
});

describe('axisAligned', () => {
  const FLIP: Matrix = [1, 0, 0, -1, 0, 300];
  const QUARTER: Matrix = [0, 1, 1, 0, 0, 0];

  it('holds for lines along the axes, closes included, and for dots', () => {
    expect(axisAligned([M(1, 1), L(5, 1), L(5, 5), L(1, 5), Z], FLIP)).toBe(true);
    expect(axisAligned([M(1, 1), L(5, 1), M(9, 9), L(9, 12)], QUARTER)).toBe(true);
    expect(axisAligned([M(1, 1), L(1, 1)], FLIP)).toBe(true);
    expect(axisAligned([M(1, 1), Z], FLIP)).toBe(true);
    expect(axisAligned([M(1, 1), L(5, 1), M(9, 9)], FLIP)).toBe(true);
  });

  it('fails on a diagonal, on a close that makes one, and on any curve', () => {
    expect(axisAligned([M(1, 1), L(5, 2)], FLIP)).toBe(false);
    expect(axisAligned([M(1, 1), L(5, 1), L(5, 5), Z], FLIP)).toBe(false);
    expect(axisAligned([M(1, 1), C(2, 1, 3, 1, 4, 1)], FLIP)).toBe(false);
    expect(axisAligned([M(1, 1), C(1, 1, 4, 1, 4, 1)], FLIP)).toBe(true); // ... that is not a line in disguise
  });

  it('is exact under a CTM that keeps the axes, and allows 0.001 pt under any other', () => {
    expect(axisAligned([M(50, 50), L(150, 50.000004)], FLIP)).toBe(false);
    const tiny: Matrix = [1, -5e-6, 0, -1, 0, 300]; // 100 pt across: 0.0005 pt off the axis
    expect(axisAligned([M(50, 250), L(50 + 100, 250 - 5e-4)], tiny)).toBe(true);
    expect(axisAligned([M(50, 250), L(50 + 100, 250 - 2e-3)], tiny)).toBe(false);
  });
});

describe('strokeBounds', () => {
  // Measured against fz_bound_path(path, stroke, ctm), MuPDF 1.28: 0002 §15. harness/oracle/test_mupdf_inventory.py
  // checks the same table against the library, walker.contract.local.test.ts against the oracle.
  const BOX: Box = [50, 230, 100, 250];
  const line = (over: Partial<LineInv>): LineInv => ({ w: 2, cap: 0, join: 0, miter: 10, dash: [], phase: 0, ...over });
  const grown = (by: number, box: Box = BOX): Box => [box[0] - by, box[1] - by, box[2] + by, box[3] + by];

  it('grows by width × limit with a miter join and a limit over 0.5, else by half the width', () => {
    const m: Matrix = [1, 0, 0, -1, 0, 300];
    expect(strokeBounds(BOX, line({}), m)).toEqual(grown(20));
    expect(strokeBounds(BOX, line({ miter: 1 }), m)).toEqual(grown(2));
    expect(strokeBounds(BOX, line({ miter: 0.51 }), m)[0]).toBeCloseTo(50 - 1.02, 6);
    expect(strokeBounds(BOX, line({ miter: 0.5 }), m)).toEqual(grown(1));
    expect(strokeBounds(BOX, line({ miter: 0 }), m)).toEqual(grown(1));
    expect(strokeBounds(BOX, line({ join: 1 }), m)).toEqual(grown(1));
    expect(strokeBounds(BOX, line({ join: 2 }), m)).toEqual(grown(1));
  });

  it('takes a zero width as 1', () => {
    const m: Matrix = [1, 0, 0, -1, 0, 300];
    expect(strokeBounds(BOX, line({ w: 0, join: 1 }), m)).toEqual(grown(0.5));
    expect(strokeBounds(BOX, line({ w: 0, miter: 4 }), m)).toEqual(grown(4));
  });

  it('scales by the largest of |a|, |b|, |c| and |d|: `w` is in the slide frame, the PDF width × lineScale', () => {
    const scaled = (m: Matrix, over: Partial<LineInv>): LineInv => line({ ...over, w: 2 * lineScale(m) });
    const at = (m: Matrix, over: Partial<LineInv>, by: number): void => {
      const box = strokeBounds(BOX, scaled(m, over), m);
      for (const [i, sign] of [[0, -1], [1, -1], [2, 1], [3, 1]] as const) expect(box[i]).toBeCloseTo(BOX[i] + sign * by, 6);
    };
    at([2, 0, 0, -3, 0, 0], { join: 1 }, 3);
    at([2, 0, 0, -3, 0, 0], { miter: 4 }, 24);
    at([3, 0, 0, -0.5, 0, 0], { join: 1 }, 3);
    at([0.8, -0.6, -0.6, -0.8, 0, 0], { join: 1 }, 0.8);
    at([0.8, -0.6, -0.6, -0.8, 0, 0], { miter: 3 }, 4.8);
    at([1, -1, 0, -1, 0, 0], { join: 1 }, 1);
    at([1, -0.5, 0.25, -2, 0, 0], { join: 1 }, 2);
  });

  it('has no miter to add for a path along the axes, or for a box with no width or height', () => {
    const m: Matrix = [1, 0, 0, -1, 0, 300];
    expect(strokeBounds(BOX, line({}), m, true)).toEqual(grown(1));
    expect(strokeBounds(BOX, line({ miter: 4 }), m, false)).toEqual(grown(8));
    const flat: Box = [50, 250, 100, 250];
    expect(strokeBounds(flat, line({}), m)).toEqual(grown(1, flat));
    const point: Box = [50, 250, 50, 250];
    expect(strokeBounds(point, line({}), m)).toEqual(grown(1, point));
  });
});
