import { describe, expect, it } from 'vitest';
import type { PassedShape } from '../../src/passes';
import { mergeFillStroke } from '../../src/passes/merge';
import { lineStyle, rectPath, shape, slideOf, snapshot } from '../helpers/passes';

/** A fill and then a stroke of the same path, drawn the same way, are one shape with a fill and a line. */
describe('merge', () => {
  it('a fill followed at once by a stroke of the same path becomes one shape with both', () => {
    const fill = shape({ op: 3 });
    const stroke = shape({ op: 4, fill: null, line: lineStyle(), provenance: { opIndex: [4], mcid: null, struct: null } });
    const input = slideOf([fill, stroke]);
    const before = snapshot(input);
    const out = mergeFillStroke(input);
    expect(input).toEqual(before);
    expect(out.elements).toEqual([{ ...fill, line: stroke.line, provenance: { ...fill.provenance, opIndex: [3, 4] } }]);
  });

  it("keeps the pending approximations of both: the outline's are not dropped (Task 6 review)", () => {
    // After the clip pass (the second merge, M3-R29) each may carry what it only approximates of its clips.
    const fill: PassedShape = { ...shape({ op: 3, clip: ['c1'] }), approximations: ['clip-approx'] };
    const stroke: PassedShape = { ...shape({ op: 4, fill: null, line: lineStyle(), clip: ['c1'] }), approximations: ['clip-dropped', 'clip-approx'] };
    const input = slideOf([fill, stroke]);
    const before = snapshot(input);
    const [merged] = mergeFillStroke(input).elements as PassedShape[];
    expect(input).toEqual(before);
    expect(merged!.approximations).toEqual(['clip-approx', 'clip-dropped']); // the union, each once, the fill's first
    // the outline alone has some: the merged shape has them
    const bare = mergeFillStroke(slideOf([shape({ op: 5, clip: ['c1'] }), stroke])).elements[0] as PassedShape;
    expect(bare.approximations).toEqual(['clip-dropped', 'clip-approx']);
    // neither has any: none, as before
    expect('approximations' in mergeFillStroke(slideOf([shape({ op: 6 }), shape({ op: 7, fill: null, line: lineStyle() })])).elements[0]!).toBe(false);
  });

  it("one op's fill and stroke (B) merge with the op listed once", () => {
    const fill = shape({ op: 7 });
    const stroke = { ...shape({ op: 7, fill: null, line: lineStyle() }), id: 'p1:z7:1' };
    const out = mergeFillStroke(slideOf([fill, stroke]));
    expect(out.elements).toHaveLength(1);
    expect(out.elements[0]!.id).toBe('p1:z7');
    expect(out.elements[0]!.provenance.opIndex).toEqual([7]);
  });

  it('keeps them apart when the path, clip, groups, mask or blend differ, or the order is stroke then fill', () => {
    const fill = () => shape({ op: 1 });
    const stroke = (over = {}) => shape({ op: 2, fill: null, line: lineStyle(), ...over });
    const group = { alpha: 0.5, blend: 'normal' as const, isolated: false, knockout: false, bbox: null, mask: null };
    for (const second of [
      stroke({ geom: rectPath(10, 20, 100, 51) }),
      stroke({ clip: ['c1'] }),
      stroke({ groups: [group] }),
      stroke({ mask: 'm1' }),
      stroke({ blend: 'multiply' }),
      shape({ op: 2, line: lineStyle() }), // fills too
    ]) {
      expect(mergeFillStroke(slideOf([fill(), second])).elements).toHaveLength(2);
    }
    expect(mergeFillStroke(slideOf([stroke(), fill()])).elements).toHaveLength(2);
    expect(mergeFillStroke(slideOf([fill(), shape({ op: 5, geom: rectPath(0, 0, 1, 1) }), stroke()])).elements).toHaveLength(3);
  });
});
