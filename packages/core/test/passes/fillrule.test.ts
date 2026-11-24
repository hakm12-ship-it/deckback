import { describe, expect, it } from 'vitest';
import type { PathSeg } from '../../src/extract/inventory';
import type { PassedShape } from '../../src/passes';
import { fillRule, pathPolygons, planFill, UNION_TOO_LARGE_NOTE } from '../../src/passes/fillrule';
import { newReport } from '../../src/passes/report';
import type { ShapeEl } from '../../src/scene/types';
import { circle, lineStyle, outlineArea, poly, rectPath, shape, slideOf, snapshot, solid, square } from '../helpers/passes';

/**
 * Review Focus 3. PowerPoint fills each `a:path` even-odd, whatever its direction (0001 M0-5), and fills the union of a
 * shape's `a:path`s. So a nonzero PDF fill is split into `a:path`s whose union is the nonzero area, and where that cannot
 * be proven the report says `nonzero-approx`. `planFill(...).paths` lists the subpaths (0-based, in path order) of each
 * `a:path` that fills.
 */

const nonzero = (geom: PathSeg[]): ShapeEl => shape({ geom, fillRule: 'nonzero' });
const evenodd = (geom: PathSeg[]): ShapeEl => shape({ geom, fillRule: 'evenodd' });

/** The two squares of M0-5 A and D: 100 pt, clockwise, the second 50 pt right and down of the first. */
const overlapping = (dir2: 'cw' | 'ccw' = 'cw'): PathSeg[] => [...square(60, 20, 100), ...square(110, 70, 100, dir2)];
/** M0-5 B and C: a 150 pt square with a 100 pt square inside, centred. */
const nested = (inner: 'cw' | 'ccw'): PathSeg[] => [...square(20, 20, 150), ...square(45, 45, 100, inner)];

describe('fill rule: M0-5 cases A–D and crossing subpaths', () => {
  it('A: two overlapping clockwise squares are two a:paths, so PowerPoint fills the overlap', () => {
    expect(planFill(nonzero(overlapping()))).toEqual({ paths: [[0], [1]], approx: false, overlap: true });
  });

  it('B: a square in a square of the other direction is one a:path: even-odd leaves the same hole', () => {
    expect(planFill(nonzero(nested('ccw')))).toEqual({ paths: [[0, 1]], approx: false });
  });

  it('C: a square in a square of the same direction is the outer square alone: the inside is filled twice over', () => {
    expect(planFill(nonzero(nested('cw')))).toEqual({ paths: [[0]], approx: false });
  });

  it("D: one a:path per square is A's partition; the same squares filled even-odd stay one a:path", () => {
    expect(planFill(nonzero(overlapping())).paths).toEqual([[0], [1]]);
    expect(planFill(evenodd(overlapping()))).toEqual({ paths: [[0, 1]], approx: false });
    expect(planFill(evenodd(nested('cw')))).toEqual({ paths: [[0, 1]], approx: false });
  });

  it('a ring with alternating directions is one path', () => {
    expect(planFill(nonzero([...circle(100, 100, 60, 'cw'), ...circle(100, 100, 40, 'ccw')]))).toEqual({ paths: [[0, 1]], approx: false });
    // a disc in the hole of a ring, the directions alternating: even-odd is nonzero there too
    const target = [...circle(100, 100, 80, 'cw'), ...circle(100, 100, 60, 'ccw'), ...circle(100, 100, 30, 'cw')];
    expect(planFill(nonzero(target))).toEqual({ paths: [[0, 1, 2]], approx: false });
  });

  it('two crossing same-direction squares are two paths', () => {
    // a plus sign: a wide and a tall bar, crossing with no corner of one inside the other
    const plus = [...rectPath(20, 80, 200, 40), ...rectPath(100, 10, 40, 180)];
    expect(planFill(nonzero(plus))).toEqual({ paths: [[0], [1]], approx: false, overlap: true });
  });

  it('a nonzero pentagram is no partition of its subpaths; the pass writes its star outline instead (M5 Task 4)', () => {
    const star: [number, number][] = [0, 2, 4, 1, 3].map((k) => {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
      return [Math.round((100 + 80 * Math.cos(a)) * 1000) / 1000, Math.round((100 + 80 * Math.sin(a)) * 1000) / 1000];
    });
    const pentagram = nonzero(poly(star));
    expect(planFill(pentagram)).toEqual({ paths: [[0]], approx: true });
    const report = newReport(slideOf([pentagram]));
    const out = fillRule(slideOf([pentagram]), report).elements[0] as PassedShape;
    expect(report.approximations).toEqual([]);
    expect(out.fillGeom!.filter((s) => s[0] === 'L')).toHaveLength(9); // ten points: the star's outline
    // even-odd, it is exact as one a:path
    expect(planFill(evenodd(poly(star)))).toEqual({ paths: [[0]], approx: false });
  });

  it('crossing subpaths of both directions are one a:path and nonzero-approx', () => {
    expect(planFill(nonzero(overlapping('ccw')))).toEqual({ paths: [[0, 1]], approx: true });
  });

  it('a hole nested under a filled inner region keeps its own a:path partner, not only direct children', () => {
    // windings 1, 2, 1, 0 from the outside in: only the innermost square is a hole
    const geom = [...square(10, 10, 180), ...square(30, 30, 140), ...square(50, 50, 100, 'ccw'), ...square(70, 70, 60, 'ccw')];
    expect(planFill(nonzero(geom))).toEqual({ paths: [[0, 3]], approx: false });
  });

  it('disjoint subpaths of one direction are one a:path', () => {
    const cells = [...square(10, 10, 50), ...square(70, 10, 50), ...square(130, 10, 50)];
    expect(planFill(nonzero(cells))).toEqual({ paths: [[0, 1, 2]], approx: false });
  });

  it('squares that share an edge are split when they run the same way and approximated when they do not', () => {
    expect(planFill(nonzero([...square(10, 10, 50), ...square(60, 10, 50)]))).toEqual({ paths: [[0], [1]], approx: false, overlap: true });
    expect(planFill(nonzero([...square(10, 10, 50), ...square(60, 10, 50, 'ccw')]))).toEqual({ paths: [[0, 1]], approx: true });
  });

  it('a subpath with no area fills nothing and rides in the first a:path', () => {
    const geom: PathSeg[] = [...overlapping(), ['M', 5, 5], ['L', 250, 5]];
    expect(planFill(nonzero(geom))).toEqual({ paths: [[0, 2], [1]], approx: false, overlap: true });
  });

  it('a path too large to check is one a:path and nonzero-approx, with a note: too large for a union too', () => {
    const zigzag: [number, number][] = [];
    for (let i = 0; i < 30000; i++) zigzag.push([i * 0.001, i % 2 === 0 ? 0 : 1]);
    zigzag.push([30, 50]);
    const big = nonzero([...poly(zigzag), ...square(100, 100, 10)]);
    expect(planFill(big)).toEqual({ paths: [[0, 1]], approx: true });
    const report = newReport(slideOf([big]));
    const out = fillRule(slideOf([big]), report).elements[0] as PassedShape;
    expect(out.fillGeom).toBeUndefined();
    expect(out.fillPaths).toEqual([[0, 1]]);
    expect(report.approximations).toEqual([{ id: big.id, kind: 'nonzero-approx' }]);
    expect(report.notes).toEqual([{ opIndex: big.provenance.opIndex[0], op: 'fill', detail: UNION_TOO_LARGE_NOTE }]);
  });

  it('the pass annotates filled shapes only, records approximations and leaves its input as it was', () => {
    const a = nonzero(overlapping());
    const stroke = shape({ geom: overlapping(), fill: null, line: lineStyle() });
    const sh = shape({ geom: null });
    const input = slideOf([a, stroke, sh]);
    const before = snapshot(input);
    const report = newReport(input);
    const out = fillRule(input, report);
    expect(input).toEqual(before);
    expect(out.elements[0]).toEqual({ ...a, fillPaths: [[0], [1]] });
    expect(out.elements[1]).toEqual(stroke);
    expect(out.elements[2]).toEqual(sh);
    expect(report.approximations).toEqual([]);
  });
});


describe('the nonzero union (M5 Task 4)', () => {
  it('a self-crossing outline (atlas lines/06–11, shapes/20) is one outline of its nonzero area, filled even-odd', () => {
    // shapes/20 p20:z134: an elbow connector drawn as a filled outline, whose inner corners fold back over its bars
    const elbow: PathSeg[] = [
      ['M', 174, 348],
      ['L', 229, 348],
      ['C', 229.55, 348, 230, 348.45, 230, 349],
      ['L', 230, 399],
      ['L', 229, 398],
      ['L', 279, 398],
      ['L', 279, 400],
      ['L', 229, 400],
      ['C', 228.45, 400, 228, 399.55, 228, 399],
      ['L', 228, 349],
      ['L', 229, 350],
      ['L', 174, 350],
      ['Z'],
      ['M', 278, 396],
      ['L', 284, 399],
      ['L', 278, 402],
      ['Z'],
    ];
    const el = shape({ geom: elbow, fillRule: 'nonzero' });
    expect(planFill(el).approx).toBe(true);
    const report = newReport(slideOf([el]));
    const out = fillRule(slideOf([el]), report).elements[0] as PassedShape;
    expect(report.approximations).toEqual([]);
    expect(out.geom).toEqual(elbow); // the path stays, for a stroke
    // the bars once each, less their two overlaps, the corners rounded off, and the arrowhead's 18 beyond the bar
    expect(outlineArea(out.fillGeom!)).toBeCloseTo(56 * 2 + 2 * 52 + 51 * 2 - 8 - 2 * (1 - Math.PI / 4) + 18 - 1 * 2, 0);
  });

  it('overlapping subpaths of one direction: opaque they stay a:paths of their own; below alpha 1 one outline', () => {
    // PowerPoint composites each a:path of a shape on its own (measured, M5 Task 4: two a:paths at 50 % are darker
    // where they overlap), so a translucent overlap would be painted twice
    const opaque = nonzero(overlapping());
    const half = shape({ geom: overlapping(), fillRule: 'nonzero', fill: solid([0, 0, 255], 0.5) });
    const inGroup = shape({ geom: overlapping(), fillRule: 'nonzero', groups: [{ alpha: 0.5, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null }] });
    const report = newReport(slideOf([opaque, half, inGroup]));
    const out = fillRule(slideOf([opaque, half, inGroup]), report).elements as PassedShape[];
    expect(out[0]).toEqual({ ...opaque, fillPaths: [[0], [1]] });
    for (const el of [out[1]!, out[2]!]) {
      expect(el.fillGeom).toBeDefined();
      expect(outlineArea(el.fillGeom!)).toBe(100 * 100 * 2 - 50 * 50);
    }
    expect(report.approximations).toEqual([]);
  });

  it('crossing subpaths of both directions: the nonzero outline, not an approximation', () => {
    const el = nonzero(overlapping('ccw'));
    const report = newReport(slideOf([el]));
    const out = fillRule(slideOf([el]), report).elements[0] as PassedShape;
    // the two squares run opposite ways: their overlap has winding 0 and is left out
    expect(outlineArea(out.fillGeom!)).toBe(100 * 100 * 2 - 2 * 50 * 50);
    expect(report.approximations).toEqual([]);
  });
});

describe('the outline is bounded before anything is flattened (fix round 1, I2)', () => {
  /** 100,000 cubics, each bent enough that flattening makes it 1,000 points: 100 M points if made. */
  const bent = (): PathSeg[] => {
    const geom: PathSeg[] = [['M', 0, 0]];
    for (let i = 0; i < 100_000; i++) geom.push(['C', 50_000, 0, -50_000, 10, 0, 10]);
    geom.push(['Z']);
    return geom;
  };

  it('pathPolygons counts first and refuses past the points cap, quickly', () => {
    const geom = bent();
    const t0 = performance.now();
    expect(pathPolygons(geom)).toBeNull();
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('planFill and the pass refuse such a path without flattening it: nonzero-approx and the note', () => {
    const el = shape({ op: 30, geom: bent(), fillRule: 'nonzero' });
    const t0 = performance.now();
    expect(planFill(el)).toEqual({ paths: [[0]], approx: true });
    const report = newReport(slideOf([el]));
    const out = fillRule(slideOf([el]), report).elements[0] as PassedShape;
    expect(performance.now() - t0).toBeLessThan(500);
    expect(out.fillGeom).toBeUndefined();
    expect(report.approximations).toEqual([{ id: el.id, kind: 'nonzero-approx' }]);
    expect(report.notes.map((n) => n.detail)).toEqual([UNION_TOO_LARGE_NOTE]);
  });

  it('a slide past its outline budget keeps the plans that follow, approximate, with the note (fix round 1, I1)', () => {
    // 200 figure eights of 4,000 points each (one crossing, an outline each): far past the slide's budget together
    const eight = (k: number): PathSeg[] =>
      poly(Array.from({ length: 4000 }, (_, i): [number, number] => {
        const t = (i * 2 * Math.PI) / 4000;
        return [Math.round((150 + 100 * Math.sin(t)) * 1000) / 1000, Math.round((100 + 50 * Math.sin(2 * t) + k * 0.001) * 1000) / 1000];
      }));
    const els = Array.from({ length: 200 }, (_, i) => shape({ op: 100 + i, geom: eight(i), fillRule: 'nonzero' }));
    const report = newReport(slideOf(els));
    const t0 = performance.now();
    const out = fillRule(slideOf(els), report).elements as PassedShape[];
    expect(performance.now() - t0).toBeLessThan(10_000);
    expect(out[0]!.fillGeom).toBeDefined();
    expect(out[out.length - 1]!.fillGeom).toBeUndefined();
    expect(report.notes.map((n) => n.detail)).toEqual([UNION_TOO_LARGE_NOTE]);
  });
});

describe('a translucent overlap past the outline budget is recorded (final review Minor 6)', () => {
  it('its a:paths overlap and PowerPoint composites the overlap twice: nonzero-approx, with the note', () => {
    const half = shape({ op: 40, geom: overlapping(), fillRule: 'nonzero', fill: solid([0, 0, 255], 0.5) });
    expect(planFill(half)).toMatchObject({ approx: false, overlap: true });
    const report = newReport(slideOf([half]));
    const out = fillRule(slideOf([half]), report, { left: 0 }).elements[0] as PassedShape;
    expect(out.fillPaths).toEqual([[0], [1]]);
    expect(report.approximations).toEqual([{ id: half.id, kind: 'nonzero-approx' }]);
    expect(report.notes.map((n) => n.detail)).toEqual([UNION_TOO_LARGE_NOTE]);
  });
});
