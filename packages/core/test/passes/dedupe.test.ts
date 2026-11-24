import { describe, expect, it } from 'vitest';
import { dedupe } from '../../src/passes/dedupe';
import { hotspot, lineStyle, picture, rectPath, shape, slideOf, snapshot, solid, textline } from '../helpers/passes';

/** PDF/A files often paint the same thing twice in a row: `dedupe` keeps the first of such a pair. */
describe('dedupe', () => {
  it('two consecutive equal shapes become the first, with the second op appended to its provenance', () => {
    const a = shape({ op: 4 });
    const b = shape({ op: 5, provenance: { opIndex: [5], mcid: 3, struct: ['P'] } });
    const input = slideOf([a, b, shape({ op: 6, geom: rectPath(0, 0, 5, 5) })]);
    const before = snapshot(input);
    const out = dedupe(input);
    expect(input).toEqual(before);
    expect(out.elements.map((e) => e.id)).toEqual(['p1:z4', 'p1:z6']);
    expect(out.elements[0]).toEqual({ ...a, provenance: { ...a.provenance, opIndex: [4, 5] } });
  });

  it('a run of three equal text lines becomes one', () => {
    const out = dedupe(slideOf([textline({ op: 1 }), textline({ op: 2 }), textline({ op: 3 })]));
    expect(out.elements.map((e) => e.id)).toEqual(['p1:z1']);
    expect(out.elements[0]!.provenance.opIndex).toEqual([1, 2, 3]);
  });

  it('keeps elements that differ, that are not consecutive, or that are of another kind', () => {
    const a = shape({ op: 1 });
    const recoloured = shape({ op: 2, fill: solid([0, 0, 255]) });
    const again = shape({ op: 3 });
    expect(dedupe(slideOf([a, recoloured, again])).elements).toHaveLength(3);
    expect(dedupe(slideOf([shape({ op: 1 }), shape({ op: 2, clip: ['c1'] })])).elements).toHaveLength(2);
    expect(dedupe(slideOf([hotspot(0, [1, 1, 9, 9], { url: 'https://a.example/', dest: null }), shape({ op: 2 })])).elements).toHaveLength(2);
  });

  it('keeps a translucent pair: two paints of alpha 0.5 show at 0.75, not 0.5', () => {
    const group = { alpha: 0.5, blend: 'normal' as const, isolated: false, knockout: false, bbox: null, mask: null };
    const pairs = [
      [shape({ op: 1, fill: solid([1, 2, 3], 0.5) }), shape({ op: 2, fill: solid([1, 2, 3], 0.5) })],
      [shape({ op: 1, line: lineStyle({ paint: solid([0, 0, 0], 0.4) }) }), shape({ op: 2, line: lineStyle({ paint: solid([0, 0, 0], 0.4) }) })],
      [shape({ op: 1, groups: [group] }), shape({ op: 2, groups: [group] })],
      [shape({ op: 1, blend: 'multiply' }), shape({ op: 2, blend: 'multiply' })],
      [shape({ op: 1, mask: 'm1' }), shape({ op: 2, mask: 'm1' })],
      [picture([0, 0, 10, 10], { op: 1, alpha: 0.5 }), picture([0, 0, 10, 10], { op: 2, alpha: 0.5 })],
    ];
    for (const pair of pairs) expect(dedupe(slideOf(pair)).elements).toHaveLength(2);
    const faint = (op: number) => {
      const line = textline({ op });
      line.runs[0]!.alpha = 0.5;
      line.runs[0]!.fill = solid([0, 0, 0], 0.5);
      return line;
    };
    expect(dedupe(slideOf([faint(1), faint(2)])).elements).toHaveLength(2);
    // opaque, the same pictures fold
    expect(dedupe(slideOf([picture([0, 0, 10, 10], { op: 1 }), picture([0, 0, 10, 10], { op: 2 })])).elements).toHaveLength(1);
  });

  it('two equal links are one hotspot', () => {
    const link = { url: 'https://a.example/', dest: null };
    const out = dedupe(slideOf([hotspot(0, [1, 1, 9, 9], link), hotspot(1, [1, 1, 9, 9], link)]));
    expect(out.elements.map((e) => e.id)).toEqual(['p1:a0']);
  });

  it("folds runs in one pass: each run's ops once, in order, its head copied once, the input unchanged (final review F1)", () => {
    const withOps = (op: number, ops: number[]) => shape({ op, provenance: { opIndex: ops, mcid: null, struct: null } });
    const square = (op: number) => shape({ op, geom: rectPath(0, 0, 5, 5) });
    const input = slideOf([withOps(1, [1, 2]), withOps(3, [2, 3]), withOps(4, [4, 1]), square(20), square(21), shape({ op: 30 })]);
    const before = snapshot(input);
    const out = dedupe(input);
    expect(input).toEqual(before);
    expect(out.elements.map((e) => [e.id, e.provenance.opIndex])).toEqual([
      ['p1:z1', [1, 2, 3, 4]],
      ['p1:z20', [20, 21]],
      ['p1:z30', [30]],
    ]);
    // the head of a run is a new element; an element that heads no run is the input's own
    expect(out.elements[0]).not.toBe(input.elements[0]);
    expect(out.elements[2]).toBe(input.elements[5]);
  });

  it('a run of 50,000 equal paints is one, in linear time', () => {
    const run = Array.from({ length: 50_000 }, (_, i) => picture([0, 0, 10, 10], { op: i }));
    const started = performance.now();
    const out = dedupe(slideOf(run));
    const ms = performance.now() - started;
    expect(out.elements).toHaveLength(1);
    expect(out.elements[0]!.provenance.opIndex).toEqual(Array.from({ length: 50_000 }, (_, i) => i));
    // a copy and a scan of the run's ops at each fold is k² = 2.5e9 steps here
    expect(ms, 'a hang guard, not a speed requirement').toBeLessThan(5_000);
  });
});
