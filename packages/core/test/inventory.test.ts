import { describe, expect, it } from 'vitest';
import {
  compareInventories,
  TOLERANCE_PT,
  toInventory,
  type Box,
  type Glyph,
  type Inventory,
  type LineInv,
  type Paint,
  type PathSeg,
} from '../src/extract/inventory';
import type { GroupFrame, RawOp } from '../src/extract/walker';
import type { BlendName } from '../src/scene/types';

/** Everything of a glyph but its character and place. */
const STATE = { font: 'ABCDEF+Deck-Regular', size: 12, alpha: 1, groupAlpha: 1, paint: 'fill', wmode: 0 } as const;
const glyph = (u: string, x: number, y: number, over: Partial<Glyph> = {}): Glyph => ({
  u,
  x,
  y,
  ...STATE,
  rgb: [10, 20, 30],
  ...over,
});

/** What every paint has besides its own values (0002 §17): here, a page with no clip, group or soft mask. */
const SCENE = { clip: [0, 0, 960, 540] as Box, groupAlpha: 1, blend: 'normal', masked: false };

const fill = (bbox: Paint['bbox'], rgb: [number, number, number] = [68, 114, 196]): Paint => ({
  kind: 'fill',
  bbox,
  rgb,
  alpha: 1,
  evenOdd: true,
  ...SCENE,
});

function base(): Inventory {
  return {
    pages: [
      {
        index: 0,
        size: [960, 540],
        paints: [
          fill([0, 0, 960, 540], [255, 255, 255]),
          fill([520, 110, 680, 200]),
          { kind: 'stroke', bbox: [520, 110, 680, 200], rgb: [30, 60, 120], alpha: 1, evenOdd: false, ...SCENE },
          { kind: 'shade', bbox: [40, 90, 300, 210], rgb: null, alpha: 1, evenOdd: false, ...SCENE },
          { kind: 'image', bbox: [580, 90, 760, 210], rgb: null, alpha: 1, evenOdd: false, ...SCENE },
        ],
        glyphs: [glyph('분', 47.208, 63.02), glyph(' ', 83.208, 63.02), glyph('기', 83.208, 63.02)],
        invisible: [],
      },
    ],
  };
}

/** A deep copy of `base()` changed by `edit`. */
function edited(edit: (inv: Inventory) => void): Inventory {
  const inv = structuredClone(base());
  edit(inv);
  return inv;
}

describe('compareInventories', () => {
  it('accepts identical inventories', () => {
    expect(compareInventories(base(), base())).toEqual(expect.objectContaining({ ok: true, diffs: [] }));
  });

  it('accepts a bbox off by 0.04 pt', () => {
    const actual = edited((inv) => {
      inv.pages[0]!.paints[1]!.bbox[2] = 680.04;
    });
    expect(compareInventories(base(), actual).ok).toBe(true);
  });

  it('rejects a bbox off by 0.06 pt, naming the page, kind, index and field', () => {
    const actual = edited((inv) => {
      inv.pages[0]!.paints[2]!.bbox[1] = 110.06;
    });
    const result = compareInventories(base(), actual);
    expect(result.ok).toBe(false);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatch(/page 0/);
    expect(result.diffs[0]).toMatch(/stroke/);
    expect(result.diffs[0]).toMatch(/paint 2/);
    expect(result.diffs[0]).toMatch(/bbox/);
  });

  it('accepts a glyph origin off by 0.04 pt and rejects one off by 0.06 pt', () => {
    const near = edited((inv) => {
      inv.pages[0]!.glyphs[2]!.x = 83.248;
    });
    expect(compareInventories(base(), near).ok).toBe(true);
    const far = edited((inv) => {
      inv.pages[0]!.glyphs[2]!.y = 63.08;
    });
    const result = compareInventories(base(), far);
    expect(result.ok).toBe(false);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatch(/page 0 glyph 1 .*y/);
  });

  it('honours a custom tolerance', () => {
    const actual = edited((inv) => {
      inv.pages[0]!.paints[1]!.bbox[2] = 680.04;
    });
    expect(compareInventories(base(), actual, 0.01).ok).toBe(false);
  });

  it('accepts an rgb difference of 1 and rejects a difference of 2', () => {
    const off1 = edited((inv) => {
      inv.pages[0]!.paints[1]!.rgb = [69, 113, 196];
    });
    expect(compareInventories(base(), off1).ok).toBe(true);
    const off2 = edited((inv) => {
      inv.pages[0]!.paints[1]!.rgb = [70, 114, 196];
    });
    const result = compareInventories(base(), off2);
    expect(result.ok).toBe(false);
    expect(result.diffs[0]).toMatch(/page 0 .*fill.*rgb/);
  });

  it('rejects rgb null against a colour, a different alpha and a different evenOdd', () => {
    for (const edit of [
      (inv: Inventory) => void (inv.pages[0]!.paints[1]!.rgb = null),
      (inv: Inventory) => void (inv.pages[0]!.paints[1]!.alpha = 0.5),
      (inv: Inventory) => void (inv.pages[0]!.paints[1]!.evenOdd = false),
    ]) {
      expect(compareInventories(base(), edited(edit)).ok).toBe(false);
    }
  });

  it('rejects an extra fill as a count mismatch', () => {
    const actual = edited((inv) => {
      inv.pages[0]!.paints.splice(1, 0, fill([10, 10, 20, 20]));
    });
    const result = compareInventories(base(), actual);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => /page 0 .*count/.test(d) && /fill/.test(d))).toBe(true);
  });

  it('rejects paints of the right counts in a different order', () => {
    const actual = edited((inv) => {
      const paints = inv.pages[0]!.paints;
      [paints[3], paints[4]] = [paints[4]!, paints[3]!];
    });
    const result = compareInventories(base(), actual);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => /order/.test(d))).toBe(true);
  });

  it('ignores whitespace-only glyphs on both sides', () => {
    const actual = edited((inv) => {
      const glyphs = inv.pages[0]!.glyphs;
      glyphs.splice(1, 1); // drop the space
      glyphs.push(glyph('　', 500, 500), glyph('', 1, 1), glyph(' \t', 2, 2));
    });
    expect(compareInventories(base(), actual).ok).toBe(true);
  });

  it('rejects a different glyph character and a missing glyph', () => {
    const changed = edited((inv) => {
      inv.pages[0]!.glyphs[2]!.u = '가';
    });
    expect(compareInventories(base(), changed).ok).toBe(false);
    const missing = edited((inv) => {
      inv.pages[0]!.glyphs.pop();
    });
    const result = compareInventories(base(), missing);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => /page 0 glyphs: count/.test(d))).toBe(true);
  });

  it('rejects a missing page, a different page index and a different page size', () => {
    expect(compareInventories(base(), { pages: [] }).ok).toBe(false);
    expect(compareInventories(base(), edited((inv) => void (inv.pages[0]!.index = 1))).ok).toBe(false);
    expect(compareInventories(base(), edited((inv) => void (inv.pages[0]!.size = [540, 960]))).ok).toBe(false);
  });

  it('rejects a NaN bbox coordinate on either side', () => {
    const actual = edited((inv) => {
      inv.pages[0]!.paints[1]!.bbox[1] = NaN;
    });
    const result = compareInventories(base(), actual);
    expect(result.ok).toBe(false);
    expect(result.diffs).toHaveLength(1);
    expect(result.diffs[0]).toMatch(/page 0 paint 1 \(fill #1\): bbox .*NaN.*not 4 finite numbers/);
    expect(compareInventories(actual, base()).ok).toBe(false);
  });

  it('rejects a bbox with 3 numbers', () => {
    const actual = edited((inv) => {
      inv.pages[0]!.paints[2]!.bbox = [520, 110, 680] as unknown as Box;
    });
    const result = compareInventories(base(), actual);
    expect(result.ok).toBe(false);
    expect(result.diffs[0]).toMatch(/page 0 paint 2 \(stroke #0\): bbox .*not 4 finite numbers/);
  });

  it('rejects a NaN or missing glyph coordinate', () => {
    const nanX = edited((inv) => {
      inv.pages[0]!.glyphs[2]!.x = NaN;
    });
    const result = compareInventories(base(), nanX);
    expect(result.ok).toBe(false);
    expect(result.diffs).toEqual([
      expect.stringMatching(/page 0 glyph 1 .*: x expected 83\.208 got "NaN" \(not a finite number\)/),
    ]);
    expect(result.maxGlyphDelta).toBe(0);
    const renamedY = edited((inv) => {
      delete (inv.pages[0]!.glyphs[0] as Partial<Glyph>).y;
    });
    expect(compareInventories(base(), renamedY).ok).toBe(false);
  });

  it('rejects a NaN alpha, rgb channel or page size', () => {
    for (const edit of [
      (inv: Inventory) => void (inv.pages[0]!.paints[1]!.alpha = NaN),
      (inv: Inventory) => void (inv.pages[0]!.paints[1]!.rgb = [68, NaN, 196]),
      (inv: Inventory) => void (inv.pages[0]!.size = [960, NaN]),
    ]) {
      expect(compareInventories(base(), edited(edit)).ok).toBe(false);
    }
  });

  it('compares approx paints by kind and position only, and counts them', () => {
    const pattern: Paint = { kind: 'pattern', bbox: [40, 90, 300, 210], rgb: null, alpha: 1, evenOdd: false, ...SCENE };
    const expected = edited((inv) => {
      inv.pages[0]!.paints.push(pattern);
    });
    const actual = edited((inv) => {
      const paints = inv.pages[0]!.paints;
      paints[3] = { ...paints[3]!, bbox: [30, 80, 310, 220], alpha: 0.5, approx: true }; // the shade
      paints.push({ ...pattern, bbox: [0, 0, 10, 10], alpha: 0.5, approx: true });
    });
    const result = compareInventories(expected, actual);
    expect(result.diffs).toEqual([]);
    expect(result).toEqual(expect.objectContaining({ ok: true, approxPaints: 2, maxBboxDelta: 0 }));
  });

  it('rejects an approx paint of another kind at the same position', () => {
    const pattern: Paint = { kind: 'pattern', bbox: [40, 90, 300, 210], rgb: null, alpha: 1, evenOdd: false, ...SCENE };
    const expected = edited((inv) => {
      inv.pages[0]!.paints.push(pattern);
    });
    const actual = edited((inv) => {
      inv.pages[0]!.paints.push({ ...pattern, kind: 'shade', approx: true });
    });
    const result = compareInventories(expected, actual);
    expect(result.ok).toBe(false);
    expect(result.diffs.some((d) => /order differs first at paint 5: expected pattern got shade/.test(d))).toBe(true);
    expect(result.diffs.some((d) => /count .*pattern 1.*pattern 0/.test(d))).toBe(true);
  });

  it('reports approxPaints 0 when no paint is approx', () => {
    expect(compareInventories(base(), base()).approxPaints).toBe(0);
  });

  it('still rejects a NaN or missing bbox or alpha on an approx paint', () => {
    const expected = edited((inv) => {
      inv.pages[0]!.paints.push({ kind: 'pattern', bbox: [40, 90, 300, 210], rgb: null, alpha: 1, evenOdd: false, ...SCENE });
    });
    const withApprox = (edit: (p: Paint) => void): Inventory =>
      edited((inv) => {
        const p: Paint = { kind: 'pattern', bbox: [0, 0, 10, 10], rgb: null, alpha: 1, evenOdd: false, approx: true, ...SCENE };
        edit(p);
        inv.pages[0]!.paints.push(p);
      });
    const cases: [edit: (p: Paint) => void, diff: RegExp][] = [
      [(p) => void (p.bbox[2] = NaN), /page 0 paint 5 \(pattern #0\): actual bbox \[0,0,"NaN",10\] \(not 4 finite numbers\)/],
      [(p) => void (p.bbox = [0, 0, 10] as unknown as Box), /actual bbox \[0,0,10\] \(not 4 finite numbers\)/],
      [(p) => void (p.alpha = NaN), /page 0 paint 5 \(pattern #0\): actual alpha "NaN" \(not a finite number\)/],
      [(p) => void delete (p as Partial<Paint>).alpha, /actual alpha undefined \(not a finite number\)/],
      [(p) => void (p.rgb = [1, NaN, 3]), /actual rgb \[1,"NaN",3\] \(neither null nor 3 finite numbers\)/],
    ];
    for (const [edit, diff] of cases) {
      const result = compareInventories(expected, withApprox(edit));
      expect(result.ok).toBe(false);
      expect(result.diffs).toEqual([expect.stringMatching(diff)]);
      expect(result.approxPaints).toBe(1);
    }
    // ... on the expected side too.
    expect(compareInventories(withApprox((p) => void (p.alpha = NaN)), expected).diffs).toEqual([
      expect.stringMatching(/expected alpha "NaN" \(not a finite number\)/),
    ]);
  });

  it('honours approx only on shade and pattern paints', () => {
    const actual = edited((inv) => {
      inv.pages[0]!.paints[1] = { ...inv.pages[0]!.paints[1]!, bbox: [0, 0, 1, 1], approx: true }; // a fill
    });
    const result = compareInventories(base(), actual);
    expect(result.ok).toBe(false);
    expect(result.approxPaints).toBe(0);
    expect(result.diffs).toEqual([
      expect.stringMatching(/page 0 paint 1 \(fill #1\): approx on a fill paint \(only shade and pattern may be approx\)/),
      expect.stringMatching(/page 0 paint 1 \(fill #1\): bbox expected \[520,110,680,200\] got \[0,0,1,1\]/),
    ]);
  });

  it('reports the largest bbox and glyph-origin deviations it accepted', () => {
    const actual = edited((inv) => {
      inv.pages[0]!.paints[1]!.bbox[2] = 680.03;
      inv.pages[0]!.glyphs[0]!.x = 47.188;
    });
    const result = compareInventories(base(), actual);
    expect(result.ok).toBe(true);
    expect(result.maxBboxDelta).toBeCloseTo(0.03, 6);
    expect(result.maxGlyphDelta).toBeCloseTo(0.02, 6);
  });

  it('counts every diff in diffTotal, also those past the 50 lines a section lists', () => {
    expect(compareInventories(base(), base()).diffTotal).toBe(0);
    const many = (n: number, glyphs: number): Inventory => ({
      pages: [
        {
          index: 0,
          size: [960, 540],
          paints: Array.from({ length: n }, (_, i) => fill([i, 0, i + 1, 1])),
          glyphs: Array.from({ length: glyphs }, (_, i) => glyph('a', i, 0)),
          invisible: [],
        },
      ],
    });
    const expected = many(70, 60);
    const actual = structuredClone(expected);
    for (const paint of actual.pages[0]!.paints) paint.rgb = [1, 2, 3]; // 70 rgb diffs
    for (const glyph of actual.pages[0]!.glyphs) glyph.y = 1; // 60 y diffs
    actual.pages[0]!.size = [961, 540]; // 1 page diff
    const result = compareInventories(expected, actual);
    // listed: 1 size + 50 paint lines + "20 more" + 50 glyph lines + "10 more"
    expect(result.diffs).toHaveLength(1 + 50 + 1 + 50 + 1);
    expect(result.diffs).toContain('page 0 paints: 20 more diffs not listed');
    expect(result.diffTotal).toBe(1 + 70 + 60);
    // a missing page counts once
    expect(compareInventories(expected, { pages: [] }).diffTotal).toBe(1);
  });

  it('uses TOLERANCE_PT (0.05 pt, docs/decisions/0002-inventory-contract.md §12) by default', () => {
    expect(TOLERANCE_PT).toBe(0.05);
    const at = (delta: number) =>
      compareInventories(
        base(),
        edited((inv) => {
          inv.pages[0]!.paints[1]!.bbox[0] = 520 + delta;
        }),
      ).ok;
    expect(at(TOLERANCE_PT)).toBe(true);
    expect(at(TOLERANCE_PT + 0.001)).toBe(false);
  });
});

describe('compareInventories: path geometry and line style (0002 §12, §14, §15)', () => {
  const PATH: PathSeg[] = [['M', 10, 10], ['L', 50, 10], ['C', 60, 10, 70, 20, 70, 30], ['Z']];
  const LINE: LineInv = { w: 2, cap: 0, join: 0, miter: 10, dash: [3, 1], phase: 0.5 };
  const page = (paints: Paint[]): Inventory => ({ pages: [{ index: 0, size: [100, 100], paints, glyphs: [], invisible: [] }] });
  const painted = (over: Partial<Paint> = {}, kind: 'fill' | 'stroke' = 'stroke'): Inventory =>
    page([
      {
        kind,
        bbox: [10, 10, 70, 30],
        rgb: [1, 2, 3],
        alpha: 1,
        evenOdd: false,
        ...SCENE,
        path: PATH,
        ...(kind === 'stroke' ? { line: LINE } : {}),
        ...over,
      },
    ]);
  const diffs = (over: Partial<Paint>, kind: 'fill' | 'stroke' = 'stroke'): string[] =>
    compareInventories(painted({}, kind), painted(over, kind)).diffs;

  it('accepts the same path and line', () => {
    expect(compareInventories(painted(), painted())).toEqual(expect.objectContaining({ ok: true, diffs: [] }));
  });

  it('rejects a control point moved by 0.1 pt, and accepts one moved by 0.05 pt', () => {
    const moved = (by: number): PathSeg[] => [['M', 10, 10], ['L', 50, 10], ['C', 60 + by, 10, 70, 20, 70, 30], ['Z']];
    expect(diffs({ path: moved(0.05) })).toEqual([]);
    expect(diffs({ path: moved(0.1) })).toEqual([
      'page 0 paint 0 (stroke #0): path segment 2 expected ["C",60,10,70,20,70,30] got ["C",60.1,10,70,20,70,30] (max |delta| 0.1 > 0.05)',
    ]);
    expect(diffs({ path: moved(0.1) }, 'fill')).toHaveLength(1);
  });

  it('honours a custom tolerance for the path, the width, the dash and the phase', () => {
    const near = painted({ path: [['M', 10.01, 10], ['L', 50, 10], ['C', 60, 10, 70, 20, 70, 30], ['Z']] });
    expect(compareInventories(painted(), near, 0.05).ok).toBe(true);
    expect(compareInventories(painted(), near, 0).ok).toBe(false);
    const wide = painted({ line: { ...LINE, w: 2.01, dash: [3.01, 1], phase: 0.51 } });
    expect(compareInventories(painted(), wide, 0.05).ok).toBe(true);
    expect(compareInventories(painted(), wide, 0).diffs).toHaveLength(3);
  });

  it('gives one line per path, whatever the number of points that differ', () => {
    const shifted = PATH.map((seg) => seg.map((v) => (typeof v === 'number' ? v + 1 : v))) as PathSeg[];
    expect(diffs({ path: shifted })).toEqual([
      'page 0 paint 0 (stroke #0): path segment 0 expected ["M",10,10] got ["M",11,11] (max |delta| 1 > 0.05, 3 segments differ)',
    ]);
  });

  it('gives one line, naming the first difference, for a path of another length or other operators', () => {
    expect(diffs({ path: PATH.slice(0, 2) })).toEqual([
      'page 0 paint 0 (stroke #0): path has 2 segments, expected 4; first difference at segment 2: expected ["C",60,10,70,20,70,30] got none',
    ]);
    expect(diffs({ path: [['M', 10, 10], ['L', 50, 10], ['L', 70, 30], ['Z']] })).toEqual([
      'page 0 paint 0 (stroke #0): path segment 2 expected ["C",60,10,70,20,70,30] got ["L",70,30] (another operator)',
    ]);
    // ... also when a point before it is off: the first difference of any sort is what the line names.
    expect(diffs({ path: [['M', 11, 11], ['L', 50, 10]] })).toEqual([
      'page 0 paint 0 (stroke #0): path has 2 segments, expected 4; first difference at segment 0: expected ["M",10,10] got ["M",11,11]',
    ]);
  });

  it('compares the canonical paths: what MuPDF normalises away is no difference', () => {
    const walker: PathSeg[] = [['M', 1, 1], ['M', 10, 10], ['L', 10, 10], ['L', 50, 10], ['L', 50, 10], ['C', 60, 10, 70, 20, 70, 30], ['Z'], ['Z'], ['M', 9, 9]];
    expect(diffs({ path: walker })).toEqual([]);
  });

  it('rejects a path on one side only, and a malformed one', () => {
    const none = page([{ kind: 'stroke', bbox: [10, 10, 70, 30], rgb: [1, 2, 3], alpha: 1, evenOdd: false, ...SCENE, line: LINE }]);
    expect(compareInventories(painted(), none).diffs).toEqual([expect.stringMatching(/stroke #0\): path expected .* got undefined/)]);
    expect(compareInventories(none, painted()).diffs).toEqual([expect.stringMatching(/stroke #0\): path expected undefined got /)]);
    for (const bad of [
      [['M', 10, Number.NaN]],
      [['M', 10]],
      [['Q', 10, 10]],
      [['Z', 1]],
      'M 10 10',
    ] as unknown as PathSeg[][]) {
      expect(diffs({ path: bad })).toEqual([expect.stringMatching(/stroke #0\): path expected .* \(not a path\)/)]);
    }
  });

  it('rejects a dash entry off by 0.1, and accepts one off by 0.05', () => {
    expect(diffs({ line: { ...LINE, dash: [3.05, 1] } })).toEqual([]);
    expect(diffs({ line: { ...LINE, dash: [3.1, 1] } })).toEqual([
      'page 0 paint 0 (stroke #0): line dash expected [3,1] got [3.1,1]',
    ]);
    expect(diffs({ line: { ...LINE, dash: [3] } })).toEqual(['page 0 paint 0 (stroke #0): line dash expected [3,1] got [3]']);
  });

  it('rejects a different cap or join', () => {
    expect(diffs({ line: { ...LINE, cap: 1 } })).toEqual(['page 0 paint 0 (stroke #0): line cap expected 0 got 1']);
    expect(diffs({ line: { ...LINE, join: 2 } })).toEqual(['page 0 paint 0 (stroke #0): line join expected 0 got 2']);
  });

  it('compares the width and the phase at the position tolerance, the miter limit at 0.01', () => {
    expect(diffs({ line: { ...LINE, w: 2.05, phase: 0.45 } })).toEqual([]);
    expect(diffs({ line: { ...LINE, w: 2.06 } })).toEqual(['page 0 paint 0 (stroke #0): line w expected 2 got 2.06']);
    expect(diffs({ line: { ...LINE, phase: 0.56 } })).toEqual(['page 0 paint 0 (stroke #0): line phase expected 0.5 got 0.56']);
    expect(diffs({ line: { ...LINE, miter: 10.01 } })).toEqual([]);
    expect(diffs({ line: { ...LINE, miter: 10.02 } })).toEqual(['page 0 paint 0 (stroke #0): line miter expected 10 got 10.02']);
  });

  it('rejects a line on one side only, and a NaN in it', () => {
    const none = page([{ kind: 'stroke', bbox: [10, 10, 70, 30], rgb: [1, 2, 3], alpha: 1, evenOdd: false, ...SCENE, path: PATH }]);
    expect(compareInventories(painted(), none).diffs).toEqual([expect.stringMatching(/stroke #0\): line expected .* got undefined/)]);
    expect(diffs({ line: { ...LINE, w: Number.NaN } })).toEqual([expect.stringMatching(/line w expected 2 got "NaN"/)]);
    expect(diffs({ line: { ...LINE, dash: [Number.NaN, 1] } })).toEqual([expect.stringMatching(/line dash expected \[3,1\] got \["NaN",1\]/)]);
  });

  it('leaves paints without a path or a line alone: both fields are optional', () => {
    const plain = page([{ kind: 'fill', bbox: [0, 0, 1, 1], rgb: [1, 2, 3], alpha: 1, evenOdd: false, ...SCENE }]);
    expect(compareInventories(plain, plain).ok).toBe(true);
  });

  it('counts every path and line diff against the section cap', () => {
    const many = (edit: boolean): Inventory =>
      page(
        Array.from({ length: 60 }, (): Paint => ({
          kind: 'stroke',
          bbox: [0, 0, 1, 1],
          rgb: [1, 2, 3],
          alpha: 1,
          evenOdd: false,
          ...SCENE,
          path: PATH,
          line: edit ? { ...LINE, cap: 2 } : LINE,
        })),
      );
    const result = compareInventories(many(false), many(true));
    expect(result.diffs).toHaveLength(51);
    expect(result.diffTotal).toBe(60);
  });
});

describe('compareInventories: images and shadings (0002 §12, §16)', () => {
  const CTM: NonNullable<Paint['ctm']> = [60, 0, 0, -40, 20, 270];
  const page = (paints: Paint[]): Inventory => ({ pages: [{ index: 0, size: [100, 100], paints, glyphs: [], invisible: [] }] });
  const image = (over: Partial<Paint> = {}): Paint => ({
    kind: 'image',
    bbox: [20, 230, 80, 270],
    rgb: null,
    alpha: 1,
    evenOdd: false,
    ...SCENE,
    ctm: CTM,
    px: [2, 3],
    stencil: false,
    ...over,
  });
  const shade = (over: Partial<Paint> = {}): Paint => ({
    kind: 'shade',
    bbox: [0, 0, 100, 100],
    rgb: null,
    alpha: 1,
    evenOdd: false,
    ...SCENE,
    shading: 'axial',
    ...over,
  });
  const diffs = (expected: Paint, actual: Paint, tolPt?: number): string[] =>
    compareInventories(page([expected]), page([actual]), tolPt).diffs;

  it('accepts the same image and the same shading', () => {
    expect(diffs(image(), image())).toEqual([]);
    expect(diffs(shade(), shade())).toEqual([]);
  });

  it('compares each coefficient of the matrix at the position tolerance, one diff for the whole matrix', () => {
    expect(diffs(image(), image({ ctm: [60.05, -0.05, 0, -40.05, 20.05, 270] }))).toEqual([]);
    expect(diffs(image(), image({ ctm: [60.06, 0, 0, -40, 20, 270] }))).toEqual([
      'page 0 paint 0 (image #0): ctm expected [60,0,0,-40,20,270] got [60.06,0,0,-40,20,270] (max |delta| 0.06 > 0.05)',
    ]);
    expect(diffs(image(), image({ ctm: [61, 1, 1, -41, 21, 271] }))).toHaveLength(1);
    expect(diffs(image(), image({ ctm: [60.04, 0, 0, -40, 20, 270] }), 0)).toHaveLength(1);
    expect(diffs(image(), image({ ctm: [60.04, 0, 0, -40, 20, 270] }), 0.1)).toEqual([]);
    // A mirrored image has the same box and another matrix.
    expect(diffs(image(), image({ ctm: [60, 0, 0, 40, 20, 230] }))).toHaveLength(1);
  });

  it('compares the pixel size exactly', () => {
    expect(diffs(image(), image({ px: [3, 2] }))).toEqual(['page 0 paint 0 (image #0): px expected [2,3] got [3,2]']);
    expect(diffs(image(), image({ px: [2, 4] }))).toHaveLength(1);
    expect(diffs(image(), image({ px: [2.5, 3] as [number, number] }))).toHaveLength(1);
  });

  it('compares whether it is a stencil, and the stencil colour like any colour', () => {
    expect(diffs(image(), image({ stencil: true }))).toEqual(['page 0 paint 0 (image #0): stencil expected false got true']);
    const stencil = (rgb: Paint['rgb']): Paint => image({ stencil: true, rgb });
    expect(diffs(stencil([255, 0, 0]), stencil([254, 1, 0]))).toEqual([]);
    expect(diffs(stencil([255, 0, 0]), stencil([253, 0, 0]))).toEqual([
      'page 0 paint 0 (image #0): rgb expected [255,0,0] got [253,0,0]',
    ]);
    expect(diffs(stencil([255, 0, 0]), stencil(null))).toHaveLength(1);
    expect(diffs(image(), image({ rgb: [0, 0, 0] }))).toHaveLength(1);
  });

  it('compares the kind of shading exactly', () => {
    expect(diffs(shade(), shade({ shading: 'radial' }))).toEqual(['page 0 paint 0 (shade #0): shading expected "axial" got "radial"']);
    for (const kind of ['function', 'axial', 'radial', 'mesh'] as const) expect(diffs(shade({ shading: kind }), shade({ shading: kind }))).toEqual([]);
    expect(diffs(shade(), shade({ shading: 'tensor' as 'mesh' }))).toHaveLength(1);
  });

  it('compares the kind of shading of an approx shade too: only its box and values are left alone', () => {
    expect(diffs(shade(), shade({ approx: true, bbox: [1, 1, 50, 50], alpha: 0.5 }))).toEqual([]);
    expect(diffs(shade(), shade({ approx: true, shading: 'mesh' }))).toEqual([
      'page 0 paint 0 (shade #0): shading expected "axial" got "mesh"',
    ]);
    expect(diffs(shade(), shade({ approx: true, shading: undefined }))).toHaveLength(1);
  });

  it('a field on one side only is a diff; on neither it is left alone', () => {
    const { ctm: _ctm, px: _px, stencil: _stencil, ...bare } = image();
    expect(diffs(image(), bare)).toEqual([
      expect.stringMatching(/image #0\): ctm expected \[60,0,0,-40,20,270\] got undefined/),
      expect.stringMatching(/image #0\): px expected \[2,3\] got undefined/),
      expect.stringMatching(/image #0\): stencil expected false got undefined/),
    ]);
    expect(diffs(bare, image())).toHaveLength(3);
    expect(diffs(bare, bare)).toEqual([]);
    const { shading: _shading, ...noKind } = shade();
    expect(diffs(shade(), noKind)).toEqual([expect.stringMatching(/shade #0\): shading expected "axial" got undefined/)]);
    expect(diffs(noKind, shade())).toHaveLength(1);
    expect(diffs(noKind, noKind)).toEqual([]);
  });

  it('a malformed value is a diff, also when both sides have it', () => {
    const nan = [Number.NaN, 0, 0, -40, 20, 270] as NonNullable<Paint['ctm']>;
    expect(diffs(image({ ctm: nan }), image({ ctm: nan }))).toHaveLength(1);
    expect(diffs(image(), image({ ctm: [60, 0, 0, -40, 20] as unknown as Paint['ctm'] }))).toHaveLength(1);
    expect(diffs(image({ px: [0, 0] }), image({ px: [0, 0] }))).toHaveLength(1);
    expect(diffs(image({ px: [2] as unknown as Paint['px'] }), image({ px: [2] as unknown as Paint['px'] }))).toHaveLength(1);
    expect(diffs(image({ stencil: 1 as unknown as boolean }), image({ stencil: 1 as unknown as boolean }))).toHaveLength(1);
    expect(diffs(shade({ shading: 'x' as 'mesh' }), shade({ shading: 'x' as 'mesh' }))).toHaveLength(1);
  });

  it('counts the diffs of an image like those of any paint', () => {
    const many = (px: [number, number]): Inventory => page(Array.from({ length: 60 }, () => image({ px })));
    const result = compareInventories(many([2, 3]), many([3, 3]));
    expect(result.diffs).toHaveLength(51);
    expect(result.diffTotal).toBe(60);
  });
});

describe('compareInventories: glyph state and invisible text (0002 §6, §12)', () => {
  const page = (glyphs: Glyph[], invisible: Inventory['pages'][0]['invisible'] = []): Inventory => ({
    pages: [{ index: 0, size: [100, 100], paints: [], glyphs, invisible }],
  });
  const diffs = (over: Partial<Glyph>): string[] =>
    compareInventories(page([glyph('A', 1, 2)]), page([glyph('A', 1, 2, over)])).diffs;

  it('a wrong font name is a diff', () => {
    expect(diffs({ font: 'ABCDEF+Deck-Bold' })).toEqual([
      'page 0 glyph 0 ("A"): font expected "ABCDEF+Deck-Regular" got "ABCDEF+Deck-Bold"',
    ]);
    expect(diffs({ font: 'Deck-Regular' })).toHaveLength(1); // the subset tag counts
  });

  it('a size off by 0.1 is a diff, one off by 0.05 is not', () => {
    expect(diffs({ size: 12.05 })).toEqual([]);
    expect(diffs({ size: 12.1 })).toEqual(['page 0 glyph 0 ("A"): size expected 12 got 12.1']);
  });

  it('a different paint is a diff', () => {
    expect(diffs({ paint: 'stroke' })).toEqual(['page 0 glyph 0 ("A"): paint expected "fill" got "stroke"']);
    expect(diffs({ paint: 'fillStroke' })).toHaveLength(1);
    expect(diffs({ paint: 'clip' })).toHaveLength(1);
  });

  it('compares the colour by ±1 per channel, null only against null', () => {
    expect(diffs({ rgb: [11, 19, 30] })).toEqual([]);
    expect(diffs({ rgb: [12, 20, 30] })).toEqual(['page 0 glyph 0 ("A"): rgb expected [10,20,30] got [12,20,30]']);
    expect(diffs({ rgb: null })).toEqual(['page 0 glyph 0 ("A"): rgb expected [10,20,30] got null']);
    const none = page([glyph('A', 1, 2, { rgb: null })]);
    expect(compareInventories(none, none).diffs).toEqual([]);
  });

  it('compares the alpha by ±1/255, and the writing mode exactly', () => {
    expect(diffs({ alpha: 1 - 1 / 255 })).toEqual([]);
    expect(diffs({ alpha: 0.99 })).toEqual(['page 0 glyph 0 ("A"): alpha expected 1 got 0.99']);
    expect(diffs({ wmode: 1 })).toEqual(['page 0 glyph 0 ("A"): wmode expected 0 got 1']);
  });

  it('a field missing or not a number on either side is a diff, also on both', () => {
    for (const key of ['font', 'size', 'rgb', 'alpha', 'paint', 'wmode'] as const) {
      const bare = glyph('A', 1, 2);
      delete (bare as Partial<Glyph>)[key];
      expect(compareInventories(page([glyph('A', 1, 2)]), page([bare])).diffs).toHaveLength(1);
      expect(compareInventories(page([bare]), page([glyph('A', 1, 2)])).diffs).toHaveLength(1);
      expect(compareInventories(page([bare]), page([bare])).diffs).toHaveLength(1);
    }
    expect(diffs({ size: Number.NaN })).toHaveLength(1);
    expect(diffs({ alpha: Number.NaN })).toHaveLength(1);
    expect(diffs({ rgb: [10, Number.NaN, 30] })).toHaveLength(1);
  });

  it('a Type 3 font: the names are not compared, the size and the rest are, and both sides must say type3', () => {
    const t3 = { type3: true, font: 'Type3 (9 0 R)' } as const;
    const expected = page([glyph('A', 1, 2, t3)]);
    expect(compareInventories(expected, page([glyph('A', 1, 2, { type3: true })])).diffs).toEqual([]);
    expect(compareInventories(expected, page([glyph('A', 1, 2, { type3: true, size: 13 })])).diffs).toHaveLength(1);
    expect(compareInventories(expected, page([glyph('A', 1, 2)])).diffs).toEqual([
      'page 0 glyph 0 ("A"): type3 expected true got undefined',
    ]);
    expect(compareInventories(page([glyph('A', 1, 2)]), page([glyph('A', 1, 2, { type3: true })])).diffs).toHaveLength(1);
    // ... but the name must still be a string.
    const nameless = glyph('A', 1, 2, { type3: true });
    delete (nameless as Partial<Glyph>).font;
    expect(compareInventories(expected, page([nameless])).diffs).toHaveLength(1);
  });

  it('a font name MuPDF cut at 31 bytes must start the real name; a shorter one must be whole', () => {
    const cut = 'A'.repeat(31);
    const full = (font: string, real: string): string[] =>
      compareInventories(page([glyph('A', 1, 2, { font })]), page([glyph('A', 1, 2, { font: real })])).diffs;
    expect(full(cut, `${cut}BCD`)).toEqual([]);
    expect(full(cut, `B${cut}`)).toHaveLength(1);
    expect(full('A'.repeat(30), 'A'.repeat(33))).toHaveLength(1);
    expect(full(`${cut}B`, `${cut}BCD`)).toHaveLength(1);
    // Bytes, not characters: ten three-byte characters and a letter.
    const korean = `${'가'.repeat(10)}A`;
    expect(full(korean, `${korean}BCD`)).toEqual([]);
    // Only the oracle cuts: the other way round is a diff.
    expect(full(`${cut}BCD`, cut)).toHaveLength(1);
  });

  it('compares invisible text like glyphs: whitespace dropped, in order, u, origin and font', () => {
    const g = (u: string, x = 1, y = 2, font = 'F') => ({ u, x, y, font });
    const expected = page([], [g('A'), g(' ', 50, 50), g('B', 3)]);
    expect(compareInventories(expected, page([], [g('A'), g('B', 3)])).diffs).toEqual([]);
    expect(compareInventories(expected, page([], [g('A')])).diffs).toEqual([
      'page 0 invisible: count expected 2 got 1 (whitespace excluded)',
    ]);
    expect(compareInventories(expected, page([], [g('C'), g('B', 3)])).diffs).toEqual(['page 0 invisible 0 ("A"): u expected "A" got "C"']);
    expect(compareInventories(expected, page([], [g('A'), g('B', 3.06)])).diffs).toEqual([
      'page 0 invisible 1 ("B"): x expected 3 got 3.06 (|delta| 0.06 > 0.05)',
    ]);
    expect(compareInventories(expected, page([], [g('A'), g('B', 3.04)])).diffs).toEqual([]);
    expect(compareInventories(expected, page([], [g('A', 1, 2.06), g('B', 3)])).diffs).toHaveLength(1);
    expect(compareInventories(expected, page([], [g('A', 1, 2, 'G'), g('B', 3)])).diffs).toEqual([
      'page 0 invisible 0 ("A"): font expected "F" got "G"',
    ]);
  });

  it('invisible text in a Type 3 font: the name is not compared, both sides must say type3', () => {
    const t3 = (font: string) => ({ u: 'A', x: 1, y: 2, font, type3: true as const });
    expect(compareInventories(page([], [t3('Type3 (9 0 R)')]), page([], [t3('Other')])).diffs).toEqual([]);
    expect(compareInventories(page([], [t3('F')]), page([], [{ u: 'A', x: 1, y: 2, font: 'F' }])).diffs).toEqual([
      'page 0 invisible 0 ("A"): type3 expected true got undefined',
    ]);
  });

  it('a page without an invisible list is a diff', () => {
    const none = { pages: [{ index: 0, size: [100, 100], paints: [], glyphs: [] }] } as unknown as Inventory;
    expect(compareInventories(page([]), none).diffs).toEqual(['page 0 invisible: expected [] got undefined (not a list)']);
    expect(compareInventories(none, page([])).diffs).toHaveLength(1);
  });

  it('has its own section with its own cap, and reports the largest origin deviation over both lists', () => {
    const many = (x: number) => page([], Array.from({ length: 60 }, () => ({ u: 'A', x, y: 2, font: 'F' })));
    const result = compareInventories(many(1), many(2));
    expect(result.diffs).toHaveLength(51);
    expect(result.diffs.at(-1)).toBe('page 0 invisible: 10 more diffs not listed');
    expect(result.diffTotal).toBe(60);
    const near = compareInventories(page([], [{ u: 'A', x: 1, y: 2, font: 'F' }]), page([], [{ u: 'A', x: 1.03, y: 2, font: 'F' }]));
    expect(near.maxGlyphDelta).toBeCloseTo(0.03, 6);
  });
});

describe('compareInventories: clip, group alpha, blend mode and soft mask (0002 §12, §17)', () => {
  const page = (paints: Paint[], glyphs: Glyph[] = []): Inventory => ({
    pages: [{ index: 0, size: [100, 100], paints, glyphs, invisible: [] }],
  });
  const paint = (kind: Paint['kind'], over: Partial<Paint> = {}): Paint => ({
    kind,
    bbox: [10, 10, 20, 20],
    rgb: kind === 'fill' ? [1, 2, 3] : null,
    alpha: 1,
    evenOdd: false,
    ...SCENE,
    clip: [0, 0, 100, 100],
    ...over,
  });
  const diffs = (expected: Paint, actual: Paint, tolPt?: number): string[] =>
    compareInventories(page([expected]), page([actual]), tolPt).diffs;

  it('compares the clip like a bbox, at the position tolerance, in one line', () => {
    expect(diffs(paint('fill'), paint('fill', { clip: [0.05, 0, 100, 99.95] }))).toEqual([]);
    expect(diffs(paint('fill'), paint('fill', { clip: [0, 0, 100.06, 100] }))).toEqual([
      'page 0 paint 0 (fill #0): clip expected [0,0,100,100] got [0,0,100.06,100] (max |delta| 0.06 > 0.05)',
    ]);
    expect(diffs(paint('fill'), paint('fill', { clip: [1, 1, 99, 99] }))).toHaveLength(1);
    expect(diffs(paint('fill'), paint('fill', { clip: [0, 0, 100.04, 100] }), 0)).toHaveLength(1);
    for (const kind of ['stroke', 'shade', 'image', 'pattern'] as const) {
      expect(diffs(paint(kind), paint(kind, { clip: [0, 0, 50, 50] }))).toEqual([expect.stringMatching(new RegExp(`\\(${kind} #0\\): clip `))]);
    }
  });

  it('does not compare the clip of an approx paint, or of one whose clip came from a text clip, by value', () => {
    expect(diffs(paint('shade'), paint('shade', { approx: true, clip: [1, 1, 50, 50] }))).toEqual([]);
    expect(diffs(paint('fill'), paint('fill', { clipApprox: true, clip: [1, 1, 50, 50] }))).toEqual([]);
    expect(diffs(paint('image', { clipApprox: true }), paint('image', { clip: [1, 1, 50, 50] }))).toEqual([]);
    // ... but the rest of such a fill is compared, and the clip must still be 4 finite numbers.
    expect(diffs(paint('fill'), paint('fill', { clipApprox: true, bbox: [10, 10, 20, 21] }))).toHaveLength(1);
    expect(diffs(paint('fill'), paint('fill', { clipApprox: true, clip: [1, 1, Number.NaN, 50] }))).toEqual([
      'page 0 paint 0 (fill #0): actual clip [1,1,"NaN",50] (not 4 finite numbers)',
    ]);
    expect(diffs(paint('shade', { clip: [1, 1, 50] as unknown as Box }), paint('shade', { approx: true }))).toEqual([
      'page 0 paint 0 (shade #0): expected clip [1,1,50] (not 4 finite numbers)',
    ]);
  });

  it('compares the group alpha by ±1/255, the blend mode and the soft mask exactly, also on an approx paint', () => {
    expect(diffs(paint('fill'), paint('fill', { groupAlpha: 1 - 1 / 255 }))).toEqual([]);
    expect(diffs(paint('fill'), paint('fill', { groupAlpha: 0.99 }))).toEqual(['page 0 paint 0 (fill #0): groupAlpha expected 1 got 0.99']);
    expect(diffs(paint('fill'), paint('fill', { blend: 'multiply' }))).toEqual([
      'page 0 paint 0 (fill #0): blend expected "normal" got "multiply"',
    ]);
    expect(diffs(paint('fill'), paint('fill', { masked: true }))).toEqual(['page 0 paint 0 (fill #0): masked expected false got true']);
    const approx = { approx: true as const, bbox: [0, 0, 1, 1] as Box, alpha: 0.5 };
    expect(diffs(paint('pattern'), paint('pattern', { ...approx, groupAlpha: 0.5 }))).toEqual([
      'page 0 paint 0 (pattern #0): groupAlpha expected 1 got 0.5',
    ]);
    expect(diffs(paint('shade'), paint('shade', { ...approx, blend: 'screen', masked: true }))).toHaveLength(2);
  });

  it('accepts every PDF blend mode and nothing else', () => {
    const modes = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'colordodge', 'colorburn', 'hardlight', 'softlight', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'];
    for (const blend of modes) expect(diffs(paint('fill', { blend }), paint('fill', { blend }))).toEqual([]);
    for (const blend of ['Multiply', 'color-dodge', 'source-over', '']) {
      expect(diffs(paint('fill', { blend }), paint('fill', { blend }))).toHaveLength(1);
    }
  });

  it('a missing or malformed value is a diff, also when both sides have it', () => {
    for (const key of ['clip', 'groupAlpha', 'blend', 'masked'] as const) {
      const bare = paint('fill');
      delete (bare as Partial<Paint>)[key];
      expect(diffs(paint('fill'), bare)).toHaveLength(1);
      expect(diffs(bare, paint('fill'))).toHaveLength(1);
      expect(diffs(bare, bare)).toHaveLength(1);
    }
    expect(diffs(paint('fill', { groupAlpha: Number.NaN }), paint('fill', { groupAlpha: Number.NaN }))).toHaveLength(1);
    const notBool = paint('fill', { masked: 1 as unknown as boolean });
    expect(diffs(notBool, notBool)).toHaveLength(1);
  });

  it("compares a glyph's group alpha by ±1/255", () => {
    const glyphs = (groupAlpha: number): Inventory => page([], [glyph('A', 1, 2, { groupAlpha })]);
    expect(compareInventories(glyphs(1), glyphs(1 - 1 / 255)).diffs).toEqual([]);
    expect(compareInventories(glyphs(1), glyphs(0.5)).diffs).toEqual(['page 0 glyph 0 ("A"): groupAlpha expected 1 got 0.5']);
    const bare = glyph('A', 1, 2);
    delete (bare as Partial<Glyph>).groupAlpha;
    expect(compareInventories(page([], [bare]), page([], [bare])).diffs).toHaveLength(1);
  });
});

describe('toInventory', () => {
  const op = (kind: RawOp['kind'], approx = false): RawOp => ({
    opIndex: 0,
    mcid: null,
    kind,
    bbox: [1.00049, 2, 3, 4.0006],
    rgb: [1, 2, 3],
    alpha: 0.5,
    evenOdd: true,
    clip: [0, 0, 10.0004, 10],
    blend: 'normal',
    masked: false,
    groups: [],
    ...(approx ? { approx: true as const } : {}),
  });
  const PLAIN = { clip: [0, 0, 10, 10], groupAlpha: 1, blend: 'normal', masked: false };

  it('keeps pattern paints with rgb null, and the approx flag only where the walker set it', () => {
    const inv = toInventory([{ index: 0, size: [10, 10], ops: [op('pattern', true), op('fill'), op('shade')] }]);
    expect(inv.pages[0]!.paints).toEqual([
      { kind: 'pattern', bbox: [1, 2, 3, 4.001], rgb: null, alpha: 0.5, evenOdd: false, ...PLAIN, approx: true },
      { kind: 'fill', bbox: [1, 2, 3, 4.001], rgb: [1, 2, 3], alpha: 0.5, evenOdd: true, ...PLAIN },
      { kind: 'shade', bbox: [1, 2, 3, 4.001], rgb: null, alpha: 0.5, evenOdd: false, ...PLAIN },
    ]);
    expect(inv.pages[0]!.paints.map((p) => 'approx' in p)).toEqual([true, false, false]);
  });

  it('rounds the path and the line to 3 decimals, and writes them only where the walker has them', () => {
    const path: PathSeg[] = [['M', 1.00049, -0.0001], ['L', 2.0006, 3], ['C', 1, 2, 3, 4, 5, 6.0004], ['Z']];
    const line: LineInv = { w: 0.99951, cap: 1, join: 2, miter: 10.0004, dash: [1.0006, 2], phase: 0.0004 };
    // A shade or pattern that paints a path or a stroke has them too, for the Scene; the contract gives it neither (0002 §1).
    const patterned = [{ ...op('shade'), path, line }, { ...op('pattern'), path }];
    const inv = toInventory([
      { index: 0, size: [10, 10], ops: [{ ...op('fill'), path }, { ...op('stroke'), path, line }, op('shade'), ...patterned] },
    ]);
    const [fill, stroke, shade, ...others] = inv.pages[0]!.paints;
    const rounded = [['M', 1, 0], ['L', 2.001, 3], ['C', 1, 2, 3, 4, 5, 6], ['Z']];
    expect(fill!.path).toEqual(rounded);
    expect('line' in fill!).toBe(false);
    expect(stroke!.path).toEqual(rounded);
    expect(stroke!.line).toEqual({ w: 1, cap: 1, join: 2, miter: 10, dash: [1.001, 2], phase: 0 });
    for (const paint of [shade!, ...others]) {
      expect('path' in paint).toBe(false);
      expect('line' in paint).toBe(false);
    }
  });

  it('writes an image with its matrix, pixel size and stencil flag, and a shade with its kind of shading', () => {
    const ctm: RawOp['ctm'] = [60.00049, 0, -0.0001, -40, 20.0006, 270];
    const axial: RawOp['shading'] = { type: 'axial', colorStops: [], p0: [0, 0], p1: [1, 1], r0: 0, r1: 0, ctm: [1, 0, 0, 1, 0, 0] };
    const inv = toInventory([
      {
        index: 0,
        size: [10, 10],
        ops: [
          { ...op('image'), rgb: null, evenOdd: false, ctm, px: [2, 3], stencil: false },
          { ...op('image'), rgb: [255, 0, 1], evenOdd: false, ctm, px: [8, 8], stencil: true },
          { ...op('shade'), shading: axial },
          { ...op('shade'), shading: { type: 'function', ctm: [1, 0, 0, 1, 0, 0] } },
          { ...op('shade'), shading: { type: 'mesh', ctm: [1, 0, 0, 1, 0, 0] } },
          { ...op('shade'), shading: { ...axial, type: 'radial' } },
          { ...op('shade') },
          { ...op('image'), ctm, evenOdd: false }, // no size: the paint has none either
        ],
      },
    ]).pages[0]!;
    const placed = [60, 0, 0, -40, 20.001, 270];
    expect(inv.paints.map((p) => [p.kind, p.rgb, p.ctm, p.px, p.stencil, p.shading])).toEqual([
      ['image', null, placed, [2, 3], false, undefined],
      ['image', [255, 0, 1], placed, [8, 8], true, undefined],
      ['shade', null, undefined, undefined, undefined, 'axial'],
      ['shade', null, undefined, undefined, undefined, 'function'],
      ['shade', null, undefined, undefined, undefined, 'mesh'],
      ['shade', null, undefined, undefined, undefined, 'radial'],
      ['shade', null, undefined, undefined, undefined, undefined],
      ['image', null, placed, undefined, undefined, undefined],
    ]);
    // Only where there is something to say.
    expect(inv.paints.map((p) => ['ctm' in p, 'px' in p, 'stencil' in p, 'shading' in p])).toEqual([
      [true, true, true, false],
      [true, true, true, false],
      [false, false, false, true],
      [false, false, false, true],
      [false, false, false, true],
      [false, false, false, true],
      [false, false, false, false],
      [true, false, false, false],
    ]);
  });

  it('gives only a stencil a colour of its own: a fill and a stroke have one, the other kinds have none', () => {
    const kinds: RawOp['kind'][] = ['fill', 'stroke', 'image', 'shade', 'pattern'];
    const none = toInventory([{ index: 0, size: [10, 10], ops: kinds.map((kind) => ({ ...op(kind), evenOdd: false })) }]).pages[0]!;
    expect(none.paints.map((p) => p.rgb)).toEqual([[1, 2, 3], [1, 2, 3], null, null, null]);
    const stencil = toInventory([{ index: 0, size: [10, 10], ops: [{ ...op('image'), stencil: true }] }]).pages[0]!;
    expect(stencil.paints[0]!.rgb).toEqual([1, 2, 3]);
  });

  it('writes a glyph with its state, and invisible text apart', () => {
    // `adv` is the Scene's, not the inventory's (and neither is `run`).
    const facts = { u: 'A', x: 1.00049, y: 2.0006, adv: 7, size: 11.99951, fontId: 'g_d0_f1', font: 'F', paint: 'stroke', wmode: 1 } as const;
    const glyphOp: RawOp = { ...op('glyph'), rgb: [1, 2, 3], alpha: 0.50049, glyph: facts };
    const t3: RawOp = { ...glyphOp, glyph: { ...facts, type3: true } };
    const invisibleOp: RawOp = { ...op('invisible'), glyph: { ...facts, u: 'B' } };
    const inv = toInventory([
      {
        index: 0,
        size: [10, 10],
        ops: [glyphOp, invisibleOp, t3, { ...invisibleOp, glyph: { ...invisibleOp.glyph!, type3: true } }],
      },
    ]).pages[0]!;
    const written = { u: 'A', x: 1, y: 2.001, font: 'F', size: 12, rgb: [1, 2, 3], alpha: 0.5, groupAlpha: 1, paint: 'stroke', wmode: 1 };
    expect(inv.glyphs).toEqual([written, { ...written, type3: true }]);
    expect(inv.glyphs.map((g) => 'type3' in g)).toEqual([false, true]);
    expect(inv.invisible).toEqual([
      { u: 'B', x: 1, y: 2.001, font: 'F' },
      { u: 'B', x: 1, y: 2.001, font: 'F', type3: true },
    ]);
    expect(inv.paints).toEqual([]);
  });

  it('writes the clip, the product of the group alphas, the first blend mode that is not normal and any soft mask', () => {
    const group = (alpha: number, blend: BlendName = 'normal', masked = false): GroupFrame => ({
      alpha,
      blend,
      isolated: false,
      knockout: false,
      bbox: null,
      masked,
      mask: null, // the inventory reads `masked` only; the Scene the mask
    });
    const outer = group(0.5, 'multiply');
    const inner = group(0.30004, 'screen');
    const ops: RawOp[] = [
      { ...op('fill'), groups: [outer, inner] }, // the innermost mode that is not normal
      { ...op('fill'), groups: [outer, group(0.5)] }, // ... from the paint outward
      { ...op('fill'), blend: 'difference', groups: [outer, inner] }, // the paint's own first
      { ...op('stroke'), masked: true, clipApprox: true }, // a soft mask of its own
      { ...op('image'), groups: [group(1, 'normal', true), inner] }, // one a group took
      { ...op('glyph'), groups: [outer, inner], glyph: { u: 'A', x: 1, y: 2, adv: 5, size: 12, fontId: 'f', font: 'F', paint: 'fill', wmode: 0 } },
    ];
    const inv = toInventory([{ index: 0, size: [10, 10], ops }]).pages[0]!;
    expect(inv.paints.map((p) => [p.clip, p.groupAlpha, p.blend, p.masked, p.clipApprox])).toEqual([
      [[0, 0, 10, 10], 0.15, 'screen', false, undefined],
      [[0, 0, 10, 10], 0.25, 'multiply', false, undefined],
      [[0, 0, 10, 10], 0.15, 'difference', false, undefined],
      [[0, 0, 10, 10], 1, 'normal', true, true],
      [[0, 0, 10, 10], 0.3, 'screen', true, undefined],
    ]);
    expect(inv.paints.map((p) => 'clipApprox' in p)).toEqual([false, false, false, true, false]);
    expect(inv.glyphs.map((g) => g.groupAlpha)).toEqual([0.15]);
  });
});
