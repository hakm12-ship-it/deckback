import { describe, expect, it } from 'vitest';
import { compareInventories, type Glyph, type Inventory, type LineInv, type Paint } from '../src/extract/inventory';
import { diffKind, diffKinds, failureKind, ratchetVerdict, type PageOutcome } from './helpers/oracle';

/** The classifier of the corpus ratchet and the atlas sweep, run on real compareInventories lines. */

const paint = (kind: Paint['kind'], over: Partial<Paint> = {}): Paint => ({
  kind,
  bbox: [10, 10, 20, 20],
  rgb: kind === 'fill' || kind === 'stroke' ? [1, 2, 3] : null,
  alpha: 1,
  evenOdd: false,
  clip: [0, 0, 960, 540],
  groupAlpha: 1,
  blend: 'normal',
  masked: false,
  ...over,
});

const inv = (
  paints: Paint[],
  glyphs: Inventory['pages'][0]['glyphs'] = [],
  size: [number, number] = [960, 540],
  invisible: Inventory['pages'][0]['invisible'] = [],
) => ({
  pages: [{ index: 3, size, paints, glyphs, invisible }],
});

const glyph = (u: string, x = 1, y = 2, over: Partial<Glyph> = {}): Glyph => ({
  u,
  x,
  y,
  font: 'F',
  size: 12,
  rgb: [1, 2, 3],
  alpha: 1,
  groupAlpha: 1,
  paint: 'fill',
  wmode: 0,
  ...over,
});

const kindsOf = (expected: Inventory, actual: Inventory): string[] => compareInventories(expected, actual).diffs.map(diffKind);

describe('diffKind', () => {
  it('names the paint kind and the field of a value diff', () => {
    const exp = inv([paint('fill'), paint('stroke'), paint('image'), paint('fill', { evenOdd: true })]);
    const act = inv([
      paint('fill', { bbox: [10, 10, 21, 20] }),
      paint('stroke', { rgb: [9, 2, 3] }),
      paint('image', { alpha: 0.5 }),
      paint('fill', { evenOdd: false }),
    ]);
    expect(kindsOf(exp, act)).toEqual(['fill:bbox', 'fill:evenOdd', 'stroke:rgb', 'image:alpha']);
  });

  it('names path and line diffs: a different point, a different length or operator, every line field', () => {
    const PATH: Paint['path'] = [['M', 1, 1], ['L', 2, 2]];
    const LINE: Paint['line'] = { w: 1, cap: 0, join: 0, miter: 10, dash: [1, 2], phase: 0 };
    const exp = inv([paint('fill', { path: PATH }), paint('stroke', { path: PATH, line: LINE })]);
    const kinds = (fill: Partial<Paint>, stroke: Partial<Paint>): string[] =>
      kindsOf(exp, inv([paint('fill', { path: PATH, ...fill }), paint('stroke', { path: PATH, line: LINE, ...stroke })]));
    expect(kinds({ path: [['M', 1, 1], ['L', 2, 3]] }, {})).toEqual(['fill:path']);
    expect(kinds({ path: [['M', 1, 1]] }, {})).toEqual(['fill:path']); // a moveTo alone is no path: another length
    expect(kinds({}, { path: [['M', 1, 1], ['C', 1, 2, 3, 4, 5, 6]] })).toEqual(['stroke:path']);
    for (const line of [{ w: 2 }, { cap: 1 }, { join: 1 }, { miter: 4 }, { dash: [1] }, { phase: 1 }] as Partial<LineInv>[]) {
      expect(kinds({}, { line: { ...LINE!, ...line } })).toEqual(['stroke:line']);
    }
    const { line: _line, ...noLine } = paint('stroke', { path: PATH, line: LINE });
    expect(kindsOf(exp, inv([paint('fill', { path: PATH }), noLine]))).toEqual(['stroke:line']);
    expect(kindsOf(exp, inv([paint('fill'), paint('stroke', { path: PATH, line: LINE })]))).toEqual(['fill:path']);
    expect(kinds({ path: 'M' as unknown as Paint['path'] }, {})).toEqual(['fill:path']);
  });

  it('names the diffs of an image and of a shading: matrix, pixel size, stencil, colour, kind of shading', () => {
    const CTM: NonNullable<Paint['ctm']> = [60, 0, 0, -40, 20, 270];
    const image = (over: Partial<Paint> = {}): Paint => ({ ...paint('image'), ctm: CTM, px: [2, 3], stencil: true, rgb: [1, 2, 3], ...over });
    const shade = (over: Partial<Paint> = {}): Paint => ({ ...paint('shade'), shading: 'axial', ...over });
    const exp = inv([image(), image(), image(), image(), image(), shade(), shade()]);
    const act = inv([
      image({ ctm: [60, 1, 0, -40, 20, 270] }),
      image({ px: [3, 3] }),
      image({ stencil: false }),
      image({ rgb: [9, 2, 3] }),
      { ...image(), ctm: undefined },
      shade({ shading: 'mesh' }),
      { ...shade(), shading: undefined },
    ]);
    // The comparison goes kind by kind (shades before images), and paint by paint in each.
    expect(kindsOf(exp, act)).toEqual(['shade:shading', 'shade:shading', 'image:ctm', 'image:px', 'image:stencil', 'image:rgb', 'image:ctm']);
    // The lines it writes, as they are: the matrix in full, then what the other side had.
    expect(compareInventories(exp, act).diffs.slice(2, 4)).toEqual([
      'page 3 paint 0 (image #0): ctm expected [60,0,0,-40,20,270] got [60,1,0,-40,20,270] (max |delta| 1 > 0.05)',
      'page 3 paint 1 (image #1): px expected [2,3] got [3,3]',
    ]);
    expect(diffKinds(compareInventories(exp, act).diffs)).toEqual(['image:ctm', 'image:px', 'image:rgb', 'image:stencil', 'shade:shading']);
  });

  it('names the diffs of the clip, the group alpha, the blend mode and the soft mask (0002 §17)', () => {
    const exp = inv([paint('fill'), paint('stroke'), paint('image'), paint('pattern'), paint('shade')]);
    const act = inv([
      paint('fill', { clip: [0, 0, 960, 500] }),
      paint('stroke', { groupAlpha: 0.5 }),
      paint('image', { blend: 'multiply' }),
      paint('pattern', { masked: true }),
      paint('shade', { approx: true, clip: [0, 0, Number.NaN, 1] }), // an approx clip must still be well formed
    ]);
    expect(kindsOf(exp, act)).toEqual(['fill:clip', 'stroke:groupAlpha', 'shade:clip', 'image:blend', 'pattern:masked']);
    expect(kindsOf(inv([], [glyph(')')]), inv([], [glyph(')', 1, 2, { groupAlpha: 0.5 })]))).toEqual(['glyph:groupAlpha']);
  });

  it('names count and order diffs, and pairs shifted by an extra paint (expected/actual index)', () => {
    const exp = inv([paint('fill'), paint('stroke')]);
    const act = inv([paint('stroke'), paint('fill', { rgb: [200, 2, 3] }), paint('stroke')]);
    expect(kindsOf(exp, act)).toEqual(['paints:count', 'paints:order', 'fill:rgb']);
    expect(compareInventories(exp, act).diffs[2]).toMatch(/expected\/actual index/);
  });

  it('names approx diffs: approx on a kind that may not carry it, and malformed approx values', () => {
    const exp = inv([paint('fill'), paint('shade')]);
    const act = inv([paint('fill', { approx: true }), paint('shade', { approx: true, alpha: Number.NaN })]);
    expect(kindsOf(exp, act)).toEqual(['fill:approx', 'shade:alpha']);
  });

  it('names glyph diffs, also for a glyph whose character is a parenthesis or a quote', () => {
    const exp = inv([], [glyph(')'), glyph('"'), glyph('가')]);
    const act = inv([], [glyph(')', 1.5), glyph('"', 1, 2.5), glyph('나')]);
    expect(kindsOf(exp, act)).toEqual(['glyph:x', 'glyph:y', 'glyph:u']);
    expect(kindsOf(exp, inv([], [glyph(')')]))).toEqual(['glyphs:count']);
  });

  it('names the diffs of the state of a glyph', () => {
    const exp = inv([], [glyph(')')]);
    const kinds = (over: Partial<Glyph>): string[] => kindsOf(exp, inv([], [glyph(')', 1, 2, over)]));
    expect(kinds({ font: 'G' })).toEqual(['glyph:font']);
    expect(kinds({ size: 13 })).toEqual(['glyph:size']);
    expect(kinds({ rgb: [9, 2, 3] })).toEqual(['glyph:rgb']);
    expect(kinds({ alpha: 0.5 })).toEqual(['glyph:alpha']);
    expect(kinds({ paint: 'clip' })).toEqual(['glyph:paint']);
    expect(kinds({ wmode: 1 })).toEqual(['glyph:wmode']);
    expect(kinds({ type3: true })).toEqual(['glyph:type3']);
  });

  it('names the diffs of invisible text, also for a character that is a parenthesis or a quote', () => {
    const none = (x = 1, y = 2, u = ')', font = 'F') => ({ u, x, y, font });
    const exp = inv([], [], [960, 540], [none()]);
    const kinds = (invisible: Inventory['pages'][0]['invisible']): string[] => kindsOf(exp, inv([], [], [960, 540], invisible));
    expect(kinds([])).toEqual(['invisible:count']);
    expect(kinds([none(1, 2, '"')])).toEqual(['invisible:u']);
    expect(kinds([none(2)])).toEqual(['invisible:x']);
    expect(kinds([none(1, 3)])).toEqual(['invisible:y']);
    expect(kinds([none(1, 2, ')', 'G')])).toEqual(['invisible:font']);
    expect(kinds([{ ...none(), type3: true }])).toEqual(['invisible:type3']);
    expect(diffKind('page 1 invisible: 7 more diffs not listed')).toBe('invisible:more');
    expect(diffKind('page 1 invisible: expected [] got undefined (not a list)')).toBe('invisible:count');
  });

  it('names page diffs and the cap line of a section', () => {
    expect(kindsOf(inv([]), inv([], [], [720, 540]))).toEqual(['page:size']);
    expect(kindsOf(inv([]), { pages: [] })).toEqual(['pages:count']);
    const many = Array.from({ length: 60 }, () => paint('fill'));
    const kinds = kindsOf(inv(many), inv(many.map((p) => ({ ...p, rgb: [99, 99, 99] as [number, number, number] }))));
    expect(kinds.at(-1)).toBe('paints:more');
    expect(kinds.filter((k) => k === 'fill:rgb')).toHaveLength(50);
    expect(diffKind('page 1 glyphs: 7 more diffs not listed')).toBe('glyphs:more');
    expect(diffKind('page 2: index expected 2 got 3')).toBe('page:index');
    expect(diffKind('something new')).toBe('other');
  });

  it('diffKinds lists the distinct kinds of a page, sorted', () => {
    const exp = inv([paint('fill'), paint('fill')]);
    const act = inv([paint('fill', { rgb: [99, 2, 3] }), paint('fill', { rgb: [99, 2, 3] })]);
    expect(diffKinds(compareInventories(exp, act).diffs)).toEqual(['fill:rgb']);
    expect(diffKinds(['page 0 paints: count expected 1 (fill 1) got 0', 'something new'])).toEqual(['other', 'paints:count']);
  });
});

describe('failureKind', () => {
  const base = { index: 0, diffs: [], diffTotal: 0, approxPaints: 0, unsupported: null, unsupportedOp: null };
  it('is null for a page that matches, diff for a page that differs, unsupported-op for a page the walker refused', () => {
    expect(failureKind({ ...base, ok: true })).toBeNull();
    expect(failureKind({ ...base, ok: false, diffs: ['x'] })).toBe('diff');
    expect(
      failureKind({
        ...base,
        ok: false,
        unsupported: 'walker: unsupported operator setGState (key BM)',
        unsupportedOp: 'setGState',
      }),
    ).toBe('unsupported-op');
  });
});

describe('ratchetVerdict', () => {
  const KEY = 'probe_std.pdf#2';
  const ok: PageOutcome = { index: 1, ok: true, diffs: [], diffTotal: 0, approxPaints: 0, unsupported: null, unsupportedOp: null };
  const BBOX = 'page 1 paint 3 (fill #2): bbox expected [0,0,1,1] got [0,0,2,1] (max |delta| 1 > 0.05)';
  const differs: PageOutcome = { ...ok, ok: false, diffs: [BBOX], diffTotal: 1 };
  const refused: PageOutcome = {
    ...ok,
    ok: false,
    unsupported: 'walker: unsupported operator setGState (key TR)',
    unsupportedOp: 'setGState',
  };
  const listedDiff = { reason: 'a reason of ten characters or more', kind: 'diff' as const };
  const listedRefusal = { reason: 'a reason of ten characters or more', kind: 'unsupported-op' as const };

  it('passes an unlisted page that matches the oracle', () => {
    expect(ratchetVerdict(KEY, undefined, ok)).toBeNull();
  });

  it('fails an unlisted page that differs or is refused, naming the page, the diff kinds and the first lines', () => {
    expect(ratchetVerdict(KEY, undefined, differs)).toBe(`${KEY}: 1 diffs (fill:bbox): ${BBOX}`);
    expect(ratchetVerdict(KEY, undefined, refused)).toBe(`${KEY}: walker: unsupported operator setGState (key TR)`);
  });

  it('fails a listed page that matches now: the list only shrinks', () => {
    expect(ratchetVerdict(KEY, listedDiff, ok)).toBe(`${KEY} matches the oracle now: remove from oracle-known.json`);
  });

  it('passes a listed page that still fails with the listed kind, and fails one whose kind changed', () => {
    expect(ratchetVerdict(KEY, listedDiff, differs)).toBeNull();
    expect(ratchetVerdict(KEY, listedRefusal, refused)).toBeNull();
    expect(ratchetVerdict(KEY, listedDiff, refused)).toBe(
      `${KEY} is listed in oracle-known.json as diff; now ${KEY}: walker: unsupported operator setGState (key TR)`,
    );
    expect(ratchetVerdict(KEY, listedRefusal, differs)).toBe(
      `${KEY} is listed in oracle-known.json as unsupported-op; now ${KEY}: 1 diffs (fill:bbox): ${BBOX}`,
    );
  });

  it('counts the diffs past the listed ones', () => {
    expect(ratchetVerdict(KEY, undefined, { ...differs, diffTotal: 80 })).toBe(`${KEY}: 80 diffs (fill:bbox): ${BBOX}`);
  });

  it('fails any page with an approx paint: every committed page is compared by value', () => {
    const approx = { ...ok, approxPaints: 2 };
    const message = `${KEY}: 2 paints compared approx (kind and position only); the committed corpus has none`;
    expect(ratchetVerdict(KEY, undefined, approx)).toBe(message);
    expect(ratchetVerdict(KEY, listedDiff, { ...differs, approxPaints: 2 })).toBe(message);
  });
});
