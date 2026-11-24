import type { OxFrame, OxNode, OxRun, OxTextBox } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import { lowerSlide, runPasses, type LowerCtx } from '../../src/passes';
import { baselineK, CALIB, calibTable, descentOf } from '../../src/passes/baseline';
import { lowerText, type TextCtx } from '../../src/passes/lower/text';
import type { AssembledText } from '../../src/passes/text/assemble';
import { ONE_BASELINE_PT } from '../../src/passes/text/lines';
import { GRID_SPACE_PT, KERN_EM, KERN_PAIR_PT, KERN_TOL_PT, kernsAfterSpace, SPACING_FLOOR_PT, TEMPLATE_KERN_PT, WIDE_SPACE_PT } from '../../src/passes/text/spacing';
import type { SlideReport } from '../../src/passes/report';
import type { ClipDef, Element, FallbackEl, FontInfo, GroupRef, SceneDeck, TextLineEl, TextRun } from '../../src/scene/types';
import { deckOf, linear, shape, slideOf, snapshot, textline } from '../helpers/passes';

/**
 * Lowering text (Task 8): a text line is one `OxTextBox`, named `pdf:p<page>:z<op> text` (ruling M3-R17), whose box is
 * placed so that the first glyph's origin lands on the line's baseline: its top `k` x size above it (`baselineK`), turned
 * about its centre by the line's angle and never flipped (ruling M3-R13 a).
 */

const PT = 12700;
const CTX: LowerCtx = { page: 1, scale: 1, offset: [0, 0] };

const font = (over: Partial<FontInfo> = {}): FontInfo => ({
  key: 'f1',
  baseFont: 'ABCDEF+Unlisted-Regular',
  latinName: 'Unlisted Sans',
  eaName: null,
  bold: false,
  italic: false,
  embedded: true,
  fsType: 0,
  isVariable: false,
  type3: false,
  metrics: null,
  ...over,
});

/** Runs the passes over the elements and lowers the slide, with the deck's fonts. */
function lower(
  elements: Element[],
  fonts: Record<string, FontInfo> = { f1: font() },
  opts: { clips?: Record<string, ClipDef>; ctx?: Partial<LowerCtx> } = {},
): { nodes: OxNode[]; report: SlideReport } {
  const input = slideOf(elements, { clips: opts.clips ?? {} });
  const deck: SceneDeck = { ...deckOf([input]), fonts };
  const { slide, report } = runPasses(input, deck);
  return { nodes: lowerSlide(slide, deck, { ...CTX, ...opts.ctx, report }).nodes, report };
}

/** The one text box lowering wrote. */
function box(elements: Element[], fonts?: Record<string, FontInfo>, opts?: Parameters<typeof lower>[2]): OxTextBox {
  const { nodes } = lower(elements, fonts, opts);
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.kind).toBe('text');
  return nodes[0] as OxTextBox;
}

const run = (over: Partial<TextRun> = {}): TextRun => ({ ...textline().runs[0]!, ...over });

/** A one-run line whose glyphs (`H` advancing 8 pt, then `i` 4 pt) run from `(x, y)` along `angleDeg`. */
function turnedLine(x: number, y: number, angleDeg: number, over: Partial<TextRun> = {}, el: Partial<TextLineEl> = {}): TextLineEl {
  const t = (angleDeg * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  const glyphs = [
    { u: 'H', x, y, adv: 8 },
    { u: 'i', x: x + 8 * c, y: y + 8 * s, adv: 4 },
  ];
  return textline({ op: 5, runs: [run({ glyphs, ...over })], baseline: { x, y }, angleDeg, ...el });
}

/**
 * A one-run line of `text` whose glyphs each advance 10 pt (`adv`, which holds Tc), each next glyph `gaps[i]` pt past the
 * last one's advance, along `deg` from (`x`, 40).
 */
function spaced(text: string, gaps: number[], o: { spcPt?: number; deg?: number; sizePt?: number; op?: number; x?: number; wmode?: 0 | 1 } = {}): TextLineEl {
  const t = ((o.deg ?? 0) * Math.PI) / 180;
  const x0 = o.x ?? 20;
  let along = 0;
  const glyphs = [...text].map((u, i) => {
    const g = { u, x: x0 + along * Math.cos(t), y: 40 + along * Math.sin(t), adv: 10 };
    along += 10 + (gaps[i] ?? 0);
    return g;
  });
  const over: Partial<TextRun> = { text, glyphs, spcPt: o.spcPt ?? 0, sizePt: o.sizePt ?? 12 };
  return textline({ op: o.op ?? 3, runs: [run(over)], baseline: { x: x0, y: 40 }, angleDeg: o.deg ?? 0, wmode: o.wmode ?? 0, bboxPt: [x0, 30, x0 + along, 43] });
}

/** Every box of the lowered elements, each as its runs' text and `spc` (the drift guard may split a line). */
const parts = (...els: TextLineEl[]): (string | number)[][][] => lower(els).nodes.map((n) => (n as OxTextBox).paras.flatMap((p) => p.runs.map((r) => [r.text, r.spc])));

/** A point of a node's own space (EMU from its frame's corner, before its turn) on the slide, in pt. */
function nodePoint(f: OxFrame, [px, py]: [number, number]): [number, number] {
  expect(f.flipH || f.flipV).toBe(false);
  const [cx, cy] = [f.x + f.w / 2, f.y + f.h / 2];
  const [vx, vy] = [f.x + px - cx, f.y + py - cy];
  const t = (f.rot / 60000) * (Math.PI / 180);
  return [(cx + vx * Math.cos(t) - vy * Math.sin(t)) / PT, (cy + vx * Math.sin(t) + vy * Math.cos(t)) / PT];
}

/** Where the first glyph's origin lies on the slide: `k` x size below the box's top left corner, in its own space. */
const origin = (b: OxTextBox, k: number, sizePt: number, scale = 1): [number, number] => nodePoint(b.frame, [0, k * sizePt * scale * PT]);

const group = (alpha: number): GroupRef => ({ alpha, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null });

const families = [...CALIB.families.keys()];

/** The committed table's k for a family in a weight: the weight's where both were measured, else the family's. */
function calibK(name: string, bold = false): number {
  const entry = CALIB.families.get(name)!;
  return (bold ? entry.bold : entry.regular)?.k ?? entry.k;
}

const metricsOf = (winAsc: number, upm = 1000, over: Partial<NonNullable<FontInfo['metrics']>> = {}) => ({
  upm,
  hheaAsc: 900,
  hheaDesc: -250,
  hheaLineGap: 0,
  winAsc,
  winDesc: 300,
  typoAsc: 800,
  typoDesc: -200,
  typoLineGap: 0,
  fsSelection: 0,
  ...over,
});

/** A made-up table of the generated shape: one family measured in both weights, one in one, an alias, a fallback scale. */
const T = calibTable({
  'Both Sans': { k: 1, n: 6, spread: 0.08, regular: { k: 1.04, n: 3, spread: 0.002 }, bold: { k: 0.96, n: 3, spread: 0.001 } },
  'One Sans': { k: 0.95, n: 3, spread: 0.001 },
  _fallback: { scale: 1.2 },
  _alias: { '양쪽 산스': 'Both Sans' },
});

describe('baselineK', () => {
  it('the committed table: families with k, n and spread, both weights or neither, aliases of its families, a fallback fit', () => {
    expect(families.length).toBeGreaterThan(0);
    const ks: number[] = [];
    for (const name of families) {
      const entry = CALIB.families.get(name)!;
      for (const e of [entry, entry.regular, entry.bold]) {
        if (e === undefined) continue;
        expect(e.k, name).toBeGreaterThan(0.5);
        expect(e.k, name).toBeLessThan(1.5);
        expect(e.n, name).toBeGreaterThan(0);
        expect(e.spread, name).toBeGreaterThanOrEqual(0);
        ks.push(e.k);
      }
      expect(entry.regular === undefined, name).toBe(entry.bold === undefined);
      if (entry.regular !== undefined) expect(entry.regular.n + entry.bold!.n, name).toBe(entry.n);
    }
    for (const target of CALIB.aliases.values()) expect(families).toContain(target);
    // ruling M3-R35, M4 Task 3: k = scale x A / (A + D), PowerPoint's single line (1.2 x size) shared by the font's line metrics
    expect(CALIB.fallback.scale).toBeGreaterThan(1.15);
    expect(CALIB.fallback.scale).toBeLessThan(1.25);
    expect(Math.min(...ks)).toBeGreaterThan(0.5);
  });

  it('NanumGothic is keyed by weight: its Regular and Bold files put the baseline apart (ruling M3-R36)', () => {
    const entry = CALIB.families.get('NanumGothic')!;
    expect(entry.regular!.k - entry.bold!.k).toBeGreaterThan(0.05);
    expect(baselineK(font({ latinName: 'NanumGothic', bold: false }))).toEqual({ k: entry.regular!.k, source: 'calib' });
    expect(baselineK(font({ latinName: 'NanumGothic', bold: true }))).toEqual({ k: entry.bold!.k, source: 'calib' });
  });

  it("a calibrated family, by its latin or its East Asian name or an alias: the table's k", () => {
    const name = families[0]!;
    expect(baselineK(font({ latinName: name }))).toEqual({ k: calibK(name), source: 'calib' });
    expect(baselineK(font({ latinName: 'Unlisted Sans', eaName: name, bold: true }))).toEqual({ k: calibK(name, true), source: 'calib' });
    const [alias, target] = [...CALIB.aliases.entries()][0]!;
    expect(baselineK(font({ latinName: null, eaName: alias }))).toEqual({ k: calibK(target), source: 'calib' });
  });

  it("both weights measured: the font's weight's k; one weight measured: the family's", () => {
    expect(baselineK(font({ latinName: 'Both Sans', bold: false }), T)).toEqual({ k: 1.04, source: 'calib' });
    expect(baselineK(font({ latinName: 'Both Sans', bold: true }), T)).toEqual({ k: 0.96, source: 'calib' });
    expect(baselineK(font({ latinName: 'One Sans', bold: true }), T)).toEqual({ k: 0.95, source: 'calib' });
    expect(baselineK(font({ latinName: 'One Sans', bold: false }), T)).toEqual({ k: 0.95, source: 'calib' });
  });

  it("an alias (a family's Korean name) finds the family; an empty name is no name", () => {
    expect(baselineK(font({ latinName: 'Unlisted Sans', eaName: '양쪽 산스', bold: true }), T)).toEqual({ k: 0.96, source: 'calib' });
    expect(baselineK(font({ latinName: '양쪽 산스' }), T)).toEqual({ k: 1.04, source: 'calib' });
    expect(baselineK(font({ latinName: '', eaName: '' }), T)).toEqual({ k: 0.9, source: 'metrics' });
  });

  it('another font with metrics: scale x A / (A + D), the win ascent and descent (ruling M3-R35)', () => {
    // A 900, D 300: 1.2 x 0.75
    expect(baselineK(font({ metrics: metricsOf(900) }), T).k).toBeCloseTo(0.9, 10);
    expect(baselineK(font({ metrics: metricsOf(900) }), T).source).toBe('metrics');
    expect(baselineK(font({ metrics: metricsOf(1700) }), T).k).toBeCloseTo(1.02, 10); // 1.2 x 1700 / 2000: no clamp
    expect(baselineK(font({ metrics: metricsOf(2700, 1000) }), T).k).toBeCloseTo(1.08, 10); // 2.7 em: still plausible
    const metrics = metricsOf(1000);
    expect(baselineK(font({ metrics })).k).toBeCloseTo(CALIB.fallback.scale * (1000 / 1300), 10);
  });

  it('USE_TYPO_METRICS (fsSelection bit 7): the typo ascent and line gap over them and the typo descent', () => {
    // typo 800 + 400 over 1200 + 300 = 0.8; win 900 / 1200 = 0.75 is not read
    const typo = metricsOf(900, 1000, { typoAsc: 800, typoLineGap: 400, typoDesc: -300, fsSelection: 0x80 });
    expect(baselineK(font({ metrics: typo }), T).k).toBeCloseTo(0.96, 10);
    const notTypo = metricsOf(900, 1000, { typoAsc: 800, typoLineGap: 400, typoDesc: -300, fsSelection: 0x40 });
    expect(baselineK(font({ metrics: notTypo }), T).k).toBeCloseTo(0.9, 10);
    // the hhea line gap is never read
    expect(baselineK(font({ metrics: metricsOf(900, 1000, { hheaLineGap: 500 }) }), T).k).toBeCloseTo(0.9, 10);
  });

  it('a font with neither, or with implausible metrics (A/upm at most 0 or over 3, a negative descent, upm 0): 0.9', () => {
    expect(baselineK(font())).toEqual({ k: 0.9, source: 'metrics' });
    expect(baselineK(font({ latinName: null, eaName: null }))).toEqual({ k: 0.9, source: 'metrics' });
    const implausible = [
      metricsOf(0),
      metricsOf(-5),
      metricsOf(3001),
      metricsOf(1000, 0),
      metricsOf(1000, 1000, { winDesc: -1 }),
      metricsOf(900, 1000, { typoAsc: 0, typoLineGap: 0, fsSelection: 0x80 }),
      metricsOf(900, 1000, { typoAsc: 800, typoDesc: 100, fsSelection: 0x80 }),
    ];
    for (const metrics of implausible) {
      expect(baselineK(font({ metrics }), T), JSON.stringify(metrics)).toEqual({ k: 0.9, source: 'metrics' });
    }
  });

  it('a font named only by its PostScript name finds its calibrated family through the table (MalgunGothic)', () => {
    const malgun = calibK('Malgun Gothic');
    expect(baselineK(font({ baseFont: 'MalgunGothic', latinName: 'MalgunGothic', embedded: false }))).toEqual({ k: malgun, source: 'calib' });
    expect(baselineK(font({ baseFont: 'ABCDEF+MalgunGothicBold', latinName: null }))).toEqual({ k: calibK('Malgun Gothic', true), source: 'calib' });
  });

  it('the descent: the hhea descent over upm, else 0.25', () => {
    expect(descentOf(font({ metrics: metricsOf(1000) }))).toBeCloseTo(0.25, 10);
    expect(descentOf(font({ metrics: metricsOf(1000, 2000) }))).toBeCloseTo(0.125, 10);
    expect(descentOf(font({ metrics: metricsOf(1000, 0) }))).toBe(0.25);
    expect(descentOf(font())).toBe(0.25);
    expect(descentOf(undefined)).toBe(0.25);
  });
});

describe('lower text', () => {
  it('a text line is one OxTextBox named for its op, its run as an OxRun; counted', () => {
    const el = turnedLine(20, 40, 0);
    const input = snapshot(el);
    const { nodes, report } = lower([el]);
    expect(el).toEqual(input);
    expect(nodes).toHaveLength(1);
    const b = nodes[0] as OxTextBox;
    expect(b).toMatchObject({ kind: 'text', name: 'pdf:p1:z5 text', link: null, vert: 'horz' });
    expect(b.paras[0]!.runs).toEqual<OxRun[]>([
      {
        text: 'Hi',
        sz: 1200,
        b: false,
        i: false,
        kern: 0, // M4-R3: "H" then "i" at their advance, no pair kerning
        spc: 0,
        baseline: 0,
        fill: { kind: 'solid', rgb: '000000', alpha: 100000 },
        line: null,
        latin: 'Unlisted Sans',
        ea: 'Unlisted Sans',
        cs: 'Unlisted Sans',
      },
    ]);
    expect(report.counts.textBoxes).toBe(1);
    expect(report.approximations).toEqual([]);
  });

  it('a horizontal run: the first glyph origin lands on the baseline; the box is the advances + 2 pt wide, (k + desc) x size high', () => {
    const b = box([turnedLine(20, 40, 0)]);
    const { k } = baselineK(font());
    expect(b.frame.rot).toBe(0);
    const [x, y] = origin(b, k, 12);
    expect(Math.abs(x - 20)).toBeLessThan(0.01);
    expect(Math.abs(y - 40)).toBeLessThan(0.01);
    expect(b.frame.x).toBe(20 * PT);
    expect(b.frame.y).toBe(Math.round((40 - k * 12) * PT));
    expect(b.frame.w).toBe(14 * PT); // H 8 + i 4 + 2
    expect(b.frame.h).toBe(Math.round((k + 0.25) * 12 * PT));
  });

  it('a 90° run and a 30° run: turned about the centre (never flipped), the first glyph origin on the baseline', () => {
    for (const angle of [90, 30, 270, 180, 315.5]) {
      const b = box([turnedLine(150, 100, angle)]);
      const { k } = baselineK(font());
      expect(b.frame.rot).toBe(Math.round(angle * 60000));
      expect(b.frame.flipH || b.frame.flipV).toBe(false);
      const [x, y] = origin(b, k, 12);
      expect(Math.abs(x - 150), `${angle}° x`).toBeLessThan(0.01);
      expect(Math.abs(y - 100), `${angle}° y`).toBeLessThan(0.01);
      expect(b.frame.w).toBe(14 * PT);
    }
  });

  it('a Scene angle a hair off a quarter turn (atan2) is placed as the quarter turn it is written as', () => {
    for (const [angle, quarter] of [
      [90.000003, 90],
      [269.999997, 270],
      [359.9999999, 0],
    ] as const) {
      const b = box([turnedLine(150, 100, angle)]);
      expect(b.frame, `${angle}`).toEqual(box([turnedLine(150, 100, quarter)]).frame);
    }
  });

  it("with a calibrated family the box's top is the table's k above the baseline", () => {
    const name = families[0]!;
    const k = calibK(name, true);
    const b = box([turnedLine(20, 40, 30)], { f1: font({ latinName: name, bold: true }) });
    const [x, y] = origin(b, k, 12);
    expect(Math.abs(x - 20)).toBeLessThan(0.01);
    expect(Math.abs(y - 40)).toBeLessThan(0.01);
  });

  it('a page drawn at another scale and offset: the origin lands on the placed baseline, sizes scale', () => {
    const b = box([turnedLine(20, 40, 90, { spcPt: 1 })], undefined, { ctx: { scale: 0.5, offset: [10, 30] } });
    const { k } = baselineK(font());
    const [x, y] = origin(b, k, 12, 0.5);
    expect(Math.abs(x - (20 * 0.5 + 10))).toBeLessThan(0.01);
    expect(Math.abs(y - (40 * 0.5 + 30))).toBeLessThan(0.01);
    expect(b.paras[0]!.runs[0]).toMatchObject({ sz: 600, spc: 50 });
  });

  it('size, spacing and rise: sz and spc in 100ths of a point, the rise as 1000ths of a percent of the size', () => {
    const r = box([turnedLine(20, 40, 0, { sizePt: 12.345, spcPt: -0.255, rise: 3, bold: true, italic: true })]).paras[0]!.runs[0]!;
    expect(r).toMatchObject({ sz: 1235, spc: -26, baseline: 24301, b: true, i: true });
  });

  it("spc is Tc and the TJ the glyphs' positions carry: the median of the run's extra advances, TJ under 0.1 pt left out (M4 Task 2)", () => {
    // a glyph's extra advance: how far the next glyph's origin is past its own, less its advance from the font (the
    // Scene's `adv` holds Tz and Tc, Tc x Tz as spcPt: the font's advance is adv - spcPt)
    // PowerPoint's export writes a Latin run's spacing as TJ adjustments, its Korean run's as Tc (atlas/text/11)
    expect(box([spaced('AVATAR', [2.957, 2.918, 2.957, 2.997, 2.958])]).paras[0]!.runs[0]!.spc).toBe(296);
    expect(box([spaced('AVATAR', [-1, -1.04, -0.999, -0.959, -1])]).paras[0]!.runs[0]!.spc).toBe(-100);
    // Tc and TJ together; along the line's direction
    expect(box([spaced('ABCD', [1, 1, 1], { spcPt: 0.5 })]).paras[0]!.runs[0]!.spc).toBe(150);
    expect(box([spaced('ABCD', [2, 2, 2], { deg: 90 })]).paras[0]!.runs[0]!.spc).toBe(200);
    // Tc alone, the positions agreeing with it
    expect(box([spaced('가나다', [0, 0], { spcPt: -0.936 })]).paras[0]!.runs[0]!.spc).toBe(-94);
    // a kerned run (a few pairs moved): the median is 0
    expect(box([spaced('WAVE Tower', [0, 0, 0.064, -0.353, 0, 0, 0, 0, 0])]).paras[0]!.runs[0]!.spc).toBe(0);
    // M3-R57 is gone: one pair is the run's spacing, and so is the median of gaps half of which are wider
    expect(box([spaced('AV', [-0.5])]).paras[0]!.runs[0]!.spc).toBe(-50);
    // (the drift guard then splits the line where the gaps of 0 leave a glyph 3 pt from its place: every part keeps the median)
    expect(parts(spaced('abcdef', [3, 0, 3, 0, 3]))).toEqual([[['ab', 300]], [['cd', 300]], [['ef', 300]]]);
    // TJ spacing under SPACING_FLOOR_PT is PowerPoint's rounding of positions to its device grid, which it redoes: none
    // (its 9 pt labels come about 0.04 pt closer than their advances, atlas/effects/01, text/04); from 0.1 pt it is spacing
    expect(SPACING_FLOOR_PT).toBe(0.1);
    expect(box([spaced('atlas/text/04', [0, -0.072, -0.045, 0, -0.036, 0, -0.063, -0.054, -0.045, -0.04, -0.05, -0.03], { sizePt: 9 })]).paras[0]!.runs[0]!.spc).toBe(0);
    expect(box([spaced('abcd', [-0.099, -0.099, -0.099])]).paras[0]!.runs[0]!.spc).toBe(0);
    expect(box([spaced('abcd', [-0.1, -0.1, -0.1])]).paras[0]!.runs[0]!.spc).toBe(-10);
    // Tc is written as the PDF sets it, small values too (PowerPoint's export sets them per Korean run), the TJ over it
    // under the floor left out
    expect(box([spaced('ABCD', [0.004, 0.003, 0.004], { spcPt: 0.25 })]).paras[0]!.runs[0]!.spc).toBe(25);
    expect(box([spaced('가나다', [0, 0], { spcPt: 0.024 })]).paras[0]!.runs[0]!.spc).toBe(2);
    expect(box([spaced('가나다', [0.05, 0.05], { spcPt: -0.064 })]).paras[0]!.runs[0]!.spc).toBe(-6);
    // a space glyph's own extra advance is a word gap (TJ in place of Tw), not character spacing: it is left out
    expect(box([spaced('a b c', [0, 3, 0, 3])]).paras[0]!.runs[0]!.spc).toBe(0);
    expect(box([spaced('ab cd ef', [0, 0, 4, 0, 0, 4, 0])]).paras[0]!.runs[0]!.spc).toBe(0);
    // atlas/text/10's "1 pt  " at -1 pt and "+3 pt  "
    expect(box([spaced('1 pt  ', [-0.912, -1.224, -0.936, -0.96, -1.224])]).paras[0]!.runs[0]!.spc).toBe(-94);
    expect(box([spaced('+3 pt  ', [2.931, 2.931, 3.099, 3.003, 3.003, 2.859])]).paras[0]!.runs[0]!.spc).toBe(297);
    // a glyph of several code points (adv 0 on the others) is one glyph with its first
    const ligature = spaced('ABCD', [3, 3, 3]);
    ligature.runs[0]!.glyphs.splice(1, 0, { ...ligature.runs[0]!.glyphs[0]!, u: 'x', adv: 0 });
    expect(box([ligature]).paras[0]!.runs[0]!.spc).toBe(300);
    // a size off PowerPoint's map (M4-R4: snapSize) is the Scene's size in 100ths of a point, never rounded to the half point
    expect(box([spaced('AB', [0], { sizePt: 20.05 })]).paras[0]!.runs[0]!.sz).toBe(2005);
    expect(box([spaced('AB', [0], { sizePt: 11.3 })]).paras[0]!.runs[0]!.sz).toBe(1130);
  });

  it('M4-R4: a size on PowerPoint\'s map is written as the size PowerPoint was asked for, and its spacing counted once', () => {
    // 20.064 and 20.04 are PowerPoint's export of 20 pt, 15.96 of 16 pt: written 2000 and 1600
    expect(box([spaced('AB', [0], { sizePt: 20.064 })]).paras[0]!.runs[0]!.sz).toBe(2000);
    expect(box([spaced('AB', [0], { sizePt: 20.04 })]).paras[0]!.runs[0]!.sz).toBe(2000);
    expect(box([spaced('AB', [0], { sizePt: 15.96 })]).paras[0]!.runs[0]!.sz).toBe(1600);
    // the Korean Tc that brings 20.064 back to 20 (atlas/text/11: Tc -0.064 on 1-em Hangul) is the snap: written 0, not
    // -6 with sz 2000 (twice)
    const hangul = (sizePt: number, spcPt: number, gaps: number[]): TextLineEl => {
      const el = spaced('가나다', gaps, { sizePt, spcPt });
      for (const g of el.runs[0]!.glyphs) g.adv = sizePt + spcPt; // 1 em wide, Tc in the advance
      let x = 20;
      el.runs[0]!.glyphs.forEach((g, i) => {
        g.x = x;
        x += g.adv + (gaps[i] ?? 0);
      });
      return el;
    };
    expect(box([hangul(20.064, -0.064, [0, 0])]).paras[0]!.runs[0]).toMatchObject({ sz: 2000, spc: 0 });
    // spacing at the snapped size: the glyphs' extra advance against the font's advance at 20, not at 20.064
    expect(box([hangul(20.064, 0, [-1, -1])]).paras[0]!.runs[0]).toMatchObject({ sz: 2000, spc: -94 });
    expect(box([hangul(20.04, 3, [0, 0])]).paras[0]!.runs[0]).toMatchObject({ sz: 2000, spc: 304 });
    // a size the map does not move (12 is on it, as itself) keeps the Tc as the PDF sets it (Task 2)
    expect(box([hangul(12, -0.064, [0.05, 0.05])]).paras[0]!.runs[0]).toMatchObject({ sz: 1200, spc: -6 });
  });

  it('M4-R3: kern="0" where the positions show no pair kerning (every gap the unkerned advance within 0.1 pt), else the template\'s', () => {
    // atlas/text/11's "WAVE Tower AV" with no kerning: every letter at its advance, within PowerPoint's grid
    expect(box([spaced('WAVE', [0, -0.001, 0.064])]).paras[0]!.runs[0]!.kern).toBe(0);
    // letter spacing is not kerning: every gap the advance and the run's spacing
    expect(box([spaced('AVATAR', [-1, -1.04, -0.999, -0.959, -1])]).paras[0]!.runs[0]).toMatchObject({ spc: -100, kern: 0 });
    // M8 round 2a (K1): a run is kerned only where its pairs show kerning's pattern: a pair more than KERN_PAIR_PT off,
    // or two pairs more than KERN_TOL_PT (PowerPoint's grid, the floor) off in one direction. One grid offset of
    // 0.10-0.15 pt is not kerning (tier B: it switched PowerPoint's kerning on, -0.2 to -2.5 pt at Te, AT, VA)
    expect(KERN_TOL_PT).toBe(SPACING_FLOOR_PT);
    expect(KERN_PAIR_PT).toBe(0.2);
    expect(box([spaced('AVATAR', [-0.11, 0, 0, 0, 0])]).paras[0]!.runs[0]!.kern).toBe(0);
    expect(box([spaced('AVATAR', [-0.15, 0, 0, 0, 0])]).paras[0]!.runs[0]!.kern).toBe(0);
    expect(box([spaced('AVATAR', [-0.2, 0, 0, 0, 0])]).paras[0]!.runs[0]!.kern).toBe(0);
    expect(box([spaced('AVATAR', [-0.21, 0, 0, 0, 0])]).paras[0]!.runs[0]!.kern).toBeNull();
    expect(box([spaced('AVATAR', [0, 0, 0.21, 0, 0])]).paras[0]!.runs[0]!.kern).toBeNull();
    // two pairs off one way, each more than KERN_TOL_PT and KERN_EM x the size (0.15 pt at 12 pt): kerned (tier B,
    // Aptos at 12 pt, re -0.19, ve -0.17); two off opposite ways (a glyph the grid put late) are grid
    expect(KERN_EM).toBe(1 / 80);
    expect(box([spaced('AVATAR', [-0.16, 0, -0.17, 0, 0])]).paras[0]!.runs[0]!.kern).toBeNull();
    expect(box([spaced('AVATAR', [0.16, 0, 0.17, 0, 0])]).paras[0]!.runs[0]!.kern).toBeNull();
    expect(box([spaced('AVATAR', [-0.16, 0.17, 0, 0, 0])]).paras[0]!.runs[0]!.kern).toBe(0);
    expect(box([spaced('AVATAR', [-0.11, 0, -0.12, 0, 0])]).paras[0]!.runs[0]!.kern).toBe(0);
    // the grid's catch-ups do not grow with the size: at 30 pt, many pairs 0.12-0.155 pt short are grid (tier B, Calibri;
    // kerned, PowerPoint drew the line 2.2 pt short)
    expect(box([spaced('AVATAR', [-0.155, -0.126, 0, -0.126, -0.12], { sizePt: 30 })]).paras[0]!.runs[0]!.kern).toBe(0);
    // under the size the template kerns (12 pt), M4-R3 as it was: one pair more than 0.1 pt off keeps the template's kern,
    // which kerns nothing there (kern="0" laid a 10 pt line out otherwise, tier B)
    expect(box([spaced('AVATAR', [-0.11, 0, 0, 0, 0], { sizePt: 10 })]).paras[0]!.runs[0]!.kern).toBeNull();
    expect(box([spaced('AVATAR', [-0.1, 0, 0, 0, 0], { sizePt: 10 })]).paras[0]!.runs[0]!.kern).toBe(0);
    // the atlas's kerned line (text/11, kern 12 pt in the source): one pair 0.13-0.16 pt off and its spaces' grid, as on
    // its unkerned line: its font has no kerning PowerPoint applies, so kern="0" lays it out alike (M8 round 2a)
    expect(box([spaced('WAVE Tower', [0, 0, 0.129, 0, -0.32, 0, 0, 0, 0], { sizePt: 32.04 })]).paras[0]!.runs[0]!.kern).toBe(0);
    // the tolerance does not grow with the size (measured: 0.02 x size, 0.64 pt at 32 pt, wrote kern="0" on the private
    // probe's kerned 32 pt runs and moved its glyphs, V1 eroded 0 -> 87 px)
    expect(box([spaced('AVATAR', [-0.3, 0, 0, 0, 0], { sizePt: 32.04 })]).paras[0]!.runs[0]!.kern).toBeNull();
    // a space's own gap is a word gap, not a pair; one glyph shows no kerning
    expect(box([spaced('A V', [0, -2])]).paras[0]!.runs.every((r) => r.kern === 0)).toBe(true);
    expect(box([spaced('A', [])]).paras[0]!.runs[0]!.kern).toBe(0);
    // vertical writing: the template's
    expect(box([spaced('ABCD', [0, 0, 0], { wmode: 1 })]).paras[0]!.runs[0]!.kern).toBeNull();
  });

  it('M4-R6: spaces whose extra advance differs from the letters\' by more than 0.1 pt are runs of their own, with their own spc', () => {
    const runs = (el: TextLineEl) => box([el]).paras[0]!.runs.map((r) => [r.text, r.spc]);
    // atlas/text/10 at -1 pt: letters -0.94, spaces -1.224
    expect(runs(spaced('1 pt  ', [-0.912, -1.224, -0.936, -0.96, -1.224]))).toEqual([['1', -94], [' ', -122], ['pt', -94], ['  ', -122]]);
    expect(runs(spaced('a b c', [3, 2, 3, 2]))).toEqual([['a', 300], [' ', 200], ['b', 300], [' ', 200], ['c', 300]]);
    // spaces within 0.1 pt of the letters stay in the run
    expect(runs(spaced('ab cd', [-1, -1, -1.05, -1]))).toEqual([['ab cd', -100]]);
    // the other run properties are the run's
    const split = box([spaced('a b', [1, 2], { spcPt: 0 })]).paras[0]!.runs;
    expect(split.map((r) => ({ ...r, text: '', spc: 0 }))).toEqual(split.map(() => ({ ...split[0]!, text: '', spc: 0 })));
  });

  it('M4-R6 as measured: letters with no spacing of their own keep their spaces (PowerPoint puts what the size gives back in them)', () => {
    // a 20.064 pt title ("WAVE Tower AV", atlas/text/11): the letters at their advance, the spaces 0.35 pt short, as
    // PowerPoint's export keeps the line at the length of 20 pt; written at 20 pt it does that again: a space run of its
    // own counted it twice (the titles' drift 0 -> 1.78 pt, atlas round trip)
    const runs = (el: TextLineEl) => box([el]).paras[0]!.runs.map((r) => [r.text, r.spc]);
    expect(runs(spaced('WAVE Tower', [0, 0, 0.064, -0.353, 0, 0, 0, 0, 0]))).toEqual([['WAVE Tower', 0]]);
    expect(runs(spaced('a b c', [0, 0.4, 0, 0.4]))).toEqual([['a b c', 0]]);
    // (over WIDE_SPACE_PT a space is a run of its own whatever the letters carry: M4b Task 1, below)
    // the letters' Tc alone under the floor is no spacing of theirs either
    // (its spaces, 0.5 pt wider than written, leave '다' 1 pt from its place: the drift guard splits the box there)
    expect(parts(spaced('가 나 다', [0, 0.5, 0, 0.5], { spcPt: -0.064 }))).toEqual([[['가 나 ', -6]], [['다', -6]]]);
  });

  it("a run's last glyph takes the touching next run's gap only when the run has none of its own (Task 2's review)", () => {
    // 'AB' at -1 pt, the next run 2 pt past its end: the run's own -1, not the median of -1 and 2
    const ab = spaced('AB', [-1], { op: 3, x: 20 });
    const next = spaced('cd', [-1], { op: 4, x: 20 + 10 - 1 + 10 + 0.5 });
    // (written touching, 'cd' would land 1.5 pt short of the PDF: the drift guard makes it a box of its own)
    expect(lower([ab, next]).nodes.flatMap((n) => (n as OxTextBox).paras[0]!.runs.map((r) => [r.text, r.spc]))).toEqual([['AB', -100], ['cd', -100]]);
  });

  it("a run with no extra advance of its own takes its line's; a line with none, its Tc; glyphs with no advance, 0", () => {
    // runs that touch on a line: the gap between them is the earlier run's last extra advance ("-" of atlas/text/10)
    const dash = spaced('-', [], { op: 3, x: 20 });
    const one = spaced('1pt', [-0.94, -0.94], { op: 4, x: 20 + 10 - 0.94 });
    expect(box([dash, one]).paras[0]!.runs.map((r) => [r.text, r.spc])).toEqual([['-', -94], ['1pt', -94]]);
    // a synthetic space between them: that gap is not one glyph's, and a run of one glyph takes the line's spacing
    // ("헌" between spaces in atlas/text/10, at -1 pt)
    const left = spaced('다람쥐', [-0.94, -0.94], { op: 3, x: 20 });
    const lone = spaced('헌', [], { op: 4, x: 20 + 30 - 0.94 + 3 - 0.94 });
    expect(box([left, lone]).paras[0]!.runs.map((r) => [r.text, r.spc])).toEqual([['다람쥐 ', -94], ['헌', -94]]);
    // a line of one glyph: its Tc
    expect(box([spaced('A', [], { spcPt: 0.7 })]).paras[0]!.runs[0]!.spc).toBe(70);
    // a font with no widths (every advance 0): 0, whatever the Tc
    const blank = spaced('ABC', [10, 10], { spcPt: 0.5 });
    for (const g of blank.runs[0]!.glyphs) g.adv = 0;
    expect(box([blank]).paras[0]!.runs[0]!.spc).toBe(0);
    // vertical writing: its Tc (an advance there is a glyph's width, not along the column)
    expect(box([spaced('ABCD', [2, 2, 2], { spcPt: 0.5, wmode: 1 })]).paras[0]!.runs[0]!.spc).toBe(50);
  });

  it('a synthetic italic is i at the size of its em: no text-skew; its line laid out at that size (atlas/text/06)', () => {
    const el = turnedLine(20, 40, 0, { sizePt: 25.298, skew: 0.3333 });
    const { nodes, report } = lower([el]);
    const b = nodes[0] as OxTextBox;
    expect(b.paras[0]!.runs[0]).toMatchObject({ sz: 2400, i: true, b: false });
    expect(report.approximations).toEqual([]);
    // the box: k x 24 above the baseline, (k + descent) x 24 high
    const { k } = baselineK(font());
    expect(b.frame.y).toBe(Math.round((40 - k * 24) * PT));
    expect(b.frame.h).toBe(Math.round((k + 0.25) * 24 * PT));
    // its rise is a share of that size
    expect(box([turnedLine(20, 40, 0, { sizePt: 25.298, skew: 0.3333, rise: 2.4 })]).paras[0]!.runs[0]!.baseline).toBe(10000);
    // another skew stays text-skew at the Scene size
    const other = lower([turnedLine(20, 40, 0, { sizePt: 25.298, skew: 0.2 })]);
    expect((other.nodes[0] as OxTextBox).paras[0]!.runs[0]).toMatchObject({ sz: 2530, i: false });
    expect(other.report.approximations).toEqual([{ id: 'p1:z5', kind: 'text-skew' }]);
  });

  it('final review Minor 5: a font whose name says Italic is a real italic face: i, the Scene size, text-skew; a regular name stays synthetic', () => {
    const named = { f1: font({ baseFont: 'Arial-ItalicMT', latinName: null, embedded: false }) };
    const real = lower([turnedLine(20, 40, 0, { sizePt: 25.298, skew: 0.3333 })], named);
    expect((real.nodes[0] as OxTextBox).paras[0]!.runs[0]).toMatchObject({ sz: 2530, i: true });
    expect(real.report.approximations).toEqual([{ id: 'p1:z5', kind: 'text-skew' }]);
    const regular = lower([turnedLine(20, 40, 0, { sizePt: 25.298, skew: 0.3333 })], { f1: font({ baseFont: 'ArialMT', latinName: null, embedded: false }) });
    expect((regular.nodes[0] as OxTextBox).paras[0]!.runs[0]).toMatchObject({ sz: 2400, i: true });
    expect(regular.report.approximations).toEqual([]);
  });

  it('a synthetic bold is b with no a:ln (atlas/charts/03); an outline in another colour stays an a:ln', () => {
    const black = { rgb: [0, 0, 0] as [number, number, number], alpha: 1 };
    const bold = turnedLine(20, 40, 0, { sizePt: 15.96, fillMode: 'fillStroke', stroke: { ...black, wPt: 0.456 } });
    expect(box([bold]).paras[0]!.runs[0]).toMatchObject({ b: true, line: null, fill: { kind: 'solid', rgb: '000000', alpha: 100000 } });
    const outline = turnedLine(20, 40, 0, { sizePt: 15.96, fillMode: 'fillStroke', stroke: { rgb: [255, 0, 0], alpha: 1, wPt: 0.456 } });
    expect(box([outline]).paras[0]!.runs[0]).toMatchObject({ b: false, line: { w: Math.round(0.456 * PT) } });
  });

  it('Review Focus 3: a real Italic or Bold face that looks synthetic: i / b once, the size not corrected', () => {
    // a real Italic face, sheared 1/3: i from the face, the Scene size, the shear recorded
    const italic = lower([turnedLine(20, 40, 0, { sizePt: 25.298, skew: 0.3333, italic: true })]);
    expect((italic.nodes[0] as OxTextBox).paras[0]!.runs[0]).toMatchObject({ sz: 2530, i: true });
    expect(italic.report.approximations).toEqual([{ id: 'p1:z5', kind: 'text-skew' }]);
    // a real Bold face filled and stroked: b from the face, its stroke an outline
    const bold = turnedLine(20, 40, 0, { sizePt: 15.96, bold: true, fillMode: 'fillStroke', stroke: { rgb: [0, 0, 0], alpha: 1, wPt: 0.456 } });
    // (15.96 is PowerPoint's export of 16 pt: written 16, M4-R4)
    expect(box([bold]).paras[0]!.runs[0]).toMatchObject({ sz: 1600, b: true, line: { w: Math.round(0.456 * PT) } });
  });

  it('a run of size 0 draws nothing in the PDF and is not written; a line of nothing else writes nothing', () => {
    expect(lower([turnedLine(20, 40, 0, { sizePt: 0, rise: 1 })]).nodes).toEqual([]);
    const el = turnedLine(20, 40, 0);
    const line = { ...el, runs: [{ ...el.runs[0]!, text: 'gone', sizePt: 0 }, el.runs[0]!] };
    expect(box([line]).paras[0]!.runs.map((r) => r.text)).toEqual(['Hi']);
  });

  it('fillMode fill: the solid colour with its alpha, the group alphas folded in', () => {
    const el = turnedLine(20, 40, 0, { rgb: [255, 0, 0], alpha: 0.5, fill: { kind: 'solid', rgb: [255, 0, 0], alpha: 0.5 } }, { groups: [group(0.5)] });
    const r = box([el]).paras[0]!.runs[0]!;
    expect(r.fill).toEqual({ kind: 'solid', rgb: 'FF0000', alpha: 25000 });
    expect(r.line).toBeNull();
  });

  it('fillMode stroke: no fill and an a:ln of the stroke', () => {
    const stroke = { rgb: [0, 0, 255] as [number, number, number], alpha: 1, wPt: 0.5 };
    const el = turnedLine(20, 40, 0, { fillMode: 'stroke', rgb: [0, 0, 255], fill: null, stroke });
    const r = box([el]).paras[0]!.runs[0]!;
    expect(r.fill).toEqual({ kind: 'none' });
    expect(r.line).toEqual({ w: 0.5 * PT, fill: { kind: 'solid', rgb: '0000FF', alpha: 100000 }, cap: 'flat', join: 'miter', miterLim: 1000000, dash: null });
  });

  it('fillMode fillStroke: both', () => {
    const stroke = { rgb: [0, 0, 255] as [number, number, number], alpha: 0.5, wPt: 1 };
    const el = turnedLine(20, 40, 0, { fillMode: 'fillStroke', rgb: [255, 0, 0], fill: { kind: 'solid', rgb: [255, 0, 0], alpha: 1 }, stroke });
    const r = box([el]).paras[0]!.runs[0]!;
    expect(r.fill).toEqual({ kind: 'solid', rgb: 'FF0000', alpha: 100000 });
    expect(r.line).toMatchObject({ w: PT, fill: { kind: 'solid', rgb: '0000FF', alpha: 50000 } });
  });

  it('M8 round 1a: text that paints nothing (noFill, clip, alpha 0) is solid at alpha 0 in a plain WordArt box, which PowerPoint exports', () => {
    // measured: PowerPoint's PDF export leaves out a run written a:noFill, and one solid at alpha 0, 0.001 % or 1 %
    // (that one as outlines); in a box of prstTxWarp textPlain it writes its own invisible text layer (ca 0), as it does
    // for WordArt, at the glyph positions of the box without it (b-acb674096b: 4,321 characters, baselines 0.15 pt
    // from the PDF's)
    for (const fillMode of ['noFill', 'clip'] as const) {
      const out = box([turnedLine(20, 40, 0, { fillMode, rgb: null, fill: null })]);
      expect(out.paras[0]!.runs[0]!.fill, fillMode).toEqual({ kind: 'solid', rgb: '000000', alpha: 0 });
      expect(out.paras[0]!.runs[0]!.line, fillMode).toBeNull();
      expect(out.warp, fillMode).toBe('textPlain');
    }
    const clear = box([turnedLine(20, 40, 0, { rgb: [255, 0, 0], alpha: 0, fill: { kind: 'solid', rgb: [255, 0, 0], alpha: 0 } })]);
    expect([clear.paras[0]!.runs[0]!.fill, clear.warp]).toEqual([{ kind: 'solid', rgb: 'FF0000', alpha: 0 }, 'textPlain']);
    // in a group of alpha 0, and a stroke at alpha 0
    expect(box([turnedLine(20, 40, 0, {}, { groups: [group(0)] })]).warp).toBe('textPlain');
    const clearStroke = turnedLine(20, 40, 0, { fillMode: 'stroke', rgb: null, fill: null, stroke: { rgb: [0, 0, 255], alpha: 0, wPt: 1 } });
    expect([box([clearStroke]).paras[0]!.runs[0]!.fill, box([clearStroke]).warp]).toEqual([{ kind: 'solid', rgb: '0000FF', alpha: 0 }, 'textPlain']);
    // text that shows has no warp; a box of a run that shows and one that does not: the latter alpha 0, no warp
    expect(box([turnedLine(20, 40, 0)]).warp ?? null).toBeNull();
    const el = turnedLine(20, 40, 0);
    const after = el.runs[0]!.glyphs.map((g) => ({ ...g, x: g.x + 12 }));
    const mixed = { ...el, runs: [el.runs[0]!, { ...el.runs[0]!, fillMode: 'noFill' as const, fill: null, glyphs: after }], bboxPt: [20, 30, 44, 43] as [number, number, number, number] };
    const both = box([mixed]);
    expect([both.paras[0]!.runs.map((r) => r.fill), both.warp ?? null]).toEqual([
      [{ kind: 'solid', rgb: '000000', alpha: 100000 }, { kind: 'solid', rgb: '000000', alpha: 0 }],
      null,
    ]);
  });

  it("a run filled with a gradient: the run's gradFill, laid over its line's band (M5 Task 3, measured in PowerPoint)", () => {
    // PowerPoint lays a run's gradient over its line: across, from the line's start to the end of its advances (a box
    // wider than its text, two runs sharing a line, two lines of other lengths: each line its own); down, its single
    // height, 1.2 x size, from the line's top. Here x 20 to 32 (H 8 pt, i 4 pt): red to blue along x 0..100 is t 0.2..0.32
    const el = turnedLine(20, 40, 0, { rgb: null, fill: linear({ alpha: 0.5 }) });
    const { nodes, report } = lower([el]);
    expect((nodes[0] as OxTextBox).paras[0]!.runs[0]!.fill).toEqual({
      kind: 'grad',
      stops: [
        { pos: 0, rgb: 'CC0033', alpha: 50000 },
        { pos: 100000, rgb: 'AD0052', alpha: 50000 },
      ],
      shade: { kind: 'lin', ang: 0, scaled: false },
      rotWithShape: true,
    });
    expect(report.approximations).toEqual([]);
    // down the line: black at its top to white at its bottom, 1.2 x 12 pt below; the band starts at the box's top
    const down = lower([turnedLine(20, 40, 0, { rgb: null, fill: linear({ p0: [0, 0], p1: [0, 100], stops: [{ t: 0, rgb: [0, 0, 0] }, { t: 1, rgb: [255, 255, 255] }] }) })]);
    const b = down.nodes[0] as OxTextBox;
    const top = b.frame.y / PT;
    const grad = b.paras[0]!.runs[0]!.fill as Extract<OxRun['fill'], { kind: 'grad' }>;
    expect(grad.shade).toEqual({ kind: 'lin', ang: 5400000, scaled: false });
    expect(grad.stops.map((s) => s.rgb)).toEqual([top, top + 14.4].map((y) => Math.round((y / 100) * 255).toString(16).toUpperCase().padStart(2, '0').repeat(3)));
  });

  it('a gradient on a turned line, or a pattern that is no gradient: its first stop (black without one), text-pattern-fill', () => {
    const turned = lower([turnedLine(20, 40, 30, { rgb: null, fill: linear({ alpha: 0.5 }) })]);
    expect((turned.nodes[0] as OxTextBox).paras[0]!.runs[0]!.fill).toEqual({ kind: 'solid', rgb: 'FF0000', alpha: 50000 });
    expect(turned.report.approximations).toEqual([{ id: 'p1:z5', kind: 'text-pattern-fill' }]);
    const shaded = lower([turnedLine(20, 40, 0, { rgb: null, fill: { kind: 'shading', shading: 'function', alpha: 1, mesh: null } })]);
    expect((shaded.nodes[0] as OxTextBox).paras[0]!.runs[0]!.fill).toEqual({ kind: 'solid', rgb: '000000', alpha: 100000 });
    expect(shaded.report.approximations).toEqual([{ id: 'p1:z5', kind: 'text-pattern-fill' }]);
  });

  it('an sh in the text clip of the clip-mode text just before it is that text filled with its gradient (M3-R27, M5 Task 3)', () => {
    // BT 7 Tr (Hi) Tj ET /Sh sh: the text clips (fillMode clip, no fill), then the sh paints its glyphs, its only paint
    const clipText = turnedLine(20, 40, 0, { fillMode: 'clip', rgb: null, fill: null });
    const textClip: ClipDef = { kind: 'text', bbox: [19, 29, 33, 44], approx: true };
    const sh = shape({ op: 6, geom: null, fill: linear({ alpha: 0.5 }), bbox: [19, 29, 33, 44], clip: ['c1'] });
    const input = slideOf([clipText, sh], { clips: { c1: textClip } });
    const deck: SceneDeck = { ...deckOf([input]), fonts: { f1: font() } };
    const { slide, report } = runPasses(input, deck);
    // the text stays text, now filled with the gradient; the sh is drawn by it, so neither a fallback nor a note is left
    expect(slide.elements.map((e) => e.kind)).toEqual(['textline']);
    expect(slide.notes).toEqual([]);
    const { nodes } = lowerSlide(slide, deck, { ...CTX, report });
    expect(nodes).toHaveLength(1);
    expect((nodes[0] as OxTextBox).paras[0]!.runs[0]!.fill).toMatchObject({ kind: 'grad', stops: [{ pos: 0, rgb: 'CC0033', alpha: 50000 }, { pos: 100000, rgb: 'AD0052', alpha: 50000 }] });
    expect(report.fallbacks).toEqual([]);
    expect(report.counts.fallbacks).toBe(0);
    expect(report.approximations).toEqual([]);
  });

  it('an sh in a text clip it does not paint alone, or with no clip-mode text before it, stays the text-clip-shading fallback', () => {
    const textClip: ClipDef = { kind: 'text', bbox: [19, 29, 33, 44], approx: true };
    // (two sh of one paint would be one: dedupe)
    const sh = (op: number): Element => shape({ op, geom: null, fill: linear({ alpha: op / 10 }), bbox: [19, 29, 33, 44], clip: ['c1'] });
    const clipText = turnedLine(20, 40, 0, { fillMode: 'clip', rgb: null, fill: null });
    for (const elements of [[clipText, sh(6), sh(7)], [sh(6)], [turnedLine(20, 40, 0), sh(6)]]) {
      const input = slideOf(elements, { clips: { c1: textClip } });
      const { slide } = runPasses(input, { ...deckOf([input]), fonts: { f1: font() } });
      expect(slide.elements.filter((e) => e.kind === 'fallback').map((e) => (e as FallbackEl).reason)).toEqual(elements.length === 3 ? ['text-clip-shading', 'text-clip-shading'] : ['text-clip-shading']);
    }
  });

  it('typefaces: latinName, eaName, else the base font without its subset tag and style; cs is latin', () => {
    const named = box([turnedLine(20, 40, 0)], { f1: font({ latinName: 'Gothic A1', eaName: '고딕 A1' }) }).paras[0]!.runs[0]!;
    expect([named.latin, named.ea, named.cs]).toEqual(['Gothic A1', '고딕 A1', 'Gothic A1']);
    const latinOnly = box([turnedLine(20, 40, 0)], { f1: font({ latinName: 'Pretendard', eaName: null }) }).paras[0]!.runs[0]!;
    expect([latinOnly.latin, latinOnly.ea, latinOnly.cs]).toEqual(['Pretendard', 'Pretendard', 'Pretendard']);
    const emptyNames = box([turnedLine(20, 40, 0)], { f1: font({ baseFont: 'BCDEEE+Foo-Bold', latinName: '', eaName: '' }) }).paras[0]!.runs[0]!;
    expect([emptyNames.latin, emptyNames.ea, emptyNames.cs]).toEqual(['Foo', 'Foo', 'Foo']); // '' counts as missing
    const nothing = box([turnedLine(20, 40, 0)], { f1: font({ baseFont: '', latinName: '', eaName: '' }) }).paras[0]!.runs[0]!;
    expect([nothing.latin, nothing.ea, nothing.cs]).toEqual([null, null, null]); // never an empty typeface
    for (const baseFont of ['BCDEEE+Foo-Bold', 'Foo,Bold', 'ABCDEF+Foo']) {
      const r = box([turnedLine(20, 40, 0)], { f1: font({ baseFont, latinName: null, eaName: null }) }).paras[0]!.runs[0]!;
      expect([r.latin, r.ea, r.cs], baseFont).toEqual(['Foo', 'Foo', 'Foo']);
    }
  });

  it('typefaces: a font the PDF names only by its PostScript name is its family from the table, its style too (M4 Task 3)', () => {
    const face = (f: Partial<FontInfo>) => box([turnedLine(20, 40, 0)], { f1: font(f) }).paras[0]!.runs[0]!;
    // not embedded: the Scene's latinName is the name without its style (MalgunGothic); the table gives the family, b
    const notEmbedded = face({ baseFont: 'MalgunGothic,Bold', latinName: 'MalgunGothic', eaName: null, embedded: false });
    expect([notEmbedded.latin, notEmbedded.ea, notEmbedded.cs, notEmbedded.b]).toEqual(['Malgun Gothic', 'Malgun Gothic', 'Malgun Gothic', true]);
    // embedded without names (a bare CFF program): its PostScript name
    const bare = face({ baseFont: 'ABCDEF+Arial-BoldItalicMT', latinName: null, eaName: null });
    expect([bare.latin, bare.b, bare.i]).toEqual(['Arial', true, true]);
    // embedded, its family name a known family without its spaces: the spaces, the style the font's own
    const spaceless = face({ baseFont: 'ABCDEF+MalgunGothicBold', latinName: 'MalgunGothic', eaName: null });
    expect([spaceless.latin, spaceless.b]).toEqual(['Malgun Gothic', false]);
    // a family the table does not know stays as it is
    expect(face({ baseFont: 'ABCDEF+DeckbackSans', latinName: 'DeckbackSans' }).latin).toBe('DeckbackSans');
  });

  it("M8 round 1a: a symbol font's glyphs are written as its own characters (U+F000 + code), the run's font also its a:sym", () => {
    // as b-700904ace4 has it: Wingdings' arrowhead, code 0xD8, which the PDF's ToUnicode calls U+27A2, then a space
    const wingdings = font({ baseFont: 'BCDIEE+Wingdings-Regular', latinName: 'Wingdings' });
    const glyphs = [
      { u: '\u27a2', x: 20, y: 40, adv: 10, sym: '\uf0d8' },
      { u: ' ', x: 30, y: 40, adv: 3, sym: '\uf020' },
    ];
    const r = box([textline({ op: 5, runs: [run({ text: '\u27a2 ', glyphs })] })], { f1: wingdings }).paras[0]!.runs[0]!;
    expect([r.text, r.latin, r.ea, r.cs, r.sym]).toEqual(['\uf0d8\uf020', 'Wingdings', 'Wingdings', 'Wingdings', 'Wingdings']);
    // a glyph without `sym` keeps its character; a run with none has no a:sym
    const mixed = [{ ...glyphs[0]! }, { u: 'x', x: 30, y: 40, adv: 3 }];
    expect(box([textline({ op: 5, runs: [run({ text: '\u27a2x', glyphs: mixed })] })], { f1: wingdings }).paras[0]!.runs[0]!.text).toBe('\uf0d8x');
    const plain = box([turnedLine(20, 40, 0)]).paras[0]!.runs[0]!;
    expect(plain.sym ?? null).toBeNull();
    // the font map maps a:sym as it maps the other typefaces
    const mapped = lower([textline({ op: 5, runs: [run({ text: '\u27a2 ', glyphs })] })], { f1: wingdings }, { ctx: { fontMap: { Wingdings: 'Wingdings 3' } } });
    expect((mapped.nodes[0] as OxTextBox).paras[0]!.runs[0]!.sym).toBe('Wingdings 3');
  });

  it('a Type 3 font: typeface Arial, recorded type3-text', () => {
    const { nodes, report } = lower([turnedLine(20, 40, 0)], { f1: font({ type3: true, latinName: null, baseFont: 'T3Font' }) });
    const r = (nodes[0] as OxTextBox).paras[0]!.runs[0]!;
    expect([r.latin, r.ea, r.cs]).toEqual(['Arial', 'Arial', 'Arial']);
    expect(report.approximations).toEqual([{ id: 'p1:z5', kind: 'type3-text' }]);
  });

  it('a horizontal scale other than 1 records hscale; a skew over 0.01 records text-skew', () => {
    expect(lower([turnedLine(20, 40, 0, { hScale: 0.8 })]).report.approximations).toEqual([{ id: 'p1:z5', kind: 'hscale' }]);
    expect(lower([turnedLine(20, 40, 0, { skew: 0.2 })]).report.approximations).toEqual([{ id: 'p1:z5', kind: 'text-skew' }]);
    expect(lower([turnedLine(20, 40, 0, { skew: -0.02 })]).report.approximations).toEqual([{ id: 'p1:z5', kind: 'text-skew' }]);
    expect(lower([turnedLine(20, 40, 0, { skew: 0.01 })]).report.approximations).toEqual([]);
  });

  it('vertical writing: vert eaVert, recorded vertical-text', () => {
    const el = turnedLine(100, 50, 0, {}, { wmode: 1 });
    const { nodes, report } = lower([el]);
    expect((nodes[0] as OxTextBox).vert).toBe('eaVert');
    expect(report.approximations).toEqual([{ id: 'p1:z5', kind: 'vertical-text' }]);
  });

  it('a clip the text is still in is dropped and recorded, unless the text paints nothing', () => {
    const clips: Record<string, ClipDef> = { c1: { kind: 'path', geom: [['M', 0, 0], ['L', 50, 0], ['L', 0, 50], ['Z']], rule: 'nonzero', bbox: [0, 0, 50, 50] } };
    const painted = lower([turnedLine(20, 40, 0, {}, { clip: ['c1'] })], undefined, { clips });
    expect(painted.report.approximations).toEqual([{ id: 'p1:z5', kind: 'clip-dropped' }]);
    const invisible = lower([turnedLine(20, 40, 0, { fillMode: 'noFill', rgb: null, fill: null }, { clip: ['c1'] })], undefined, { clips });
    expect(invisible.report.approximations).toEqual([]);
    // text filled at alpha 0 paints nothing either (PowerPoint's own export over text drawn as outlines: text/40,
    // wordart/05), and so does a stroke at alpha 0; its fill is written solid at alpha 0 (M8 round 1a)
    const clear = lower([turnedLine(20, 40, 0, { alpha: 0, fill: { kind: 'solid', rgb: [0, 0, 0], alpha: 0 } }, { clip: ['c1'] })], undefined, { clips });
    expect((clear.nodes[0] as OxTextBox).paras[0]!.runs[0]!.fill).toEqual({ kind: 'solid', rgb: '000000', alpha: 0 });
    expect(clear.report.approximations).toEqual([]);
    const clearStroke = turnedLine(20, 40, 0, { fillMode: 'stroke', rgb: null, fill: null, stroke: { rgb: [0, 0, 0], alpha: 0, wPt: 1 } }, { clip: ['c1'] });
    expect(lower([clearStroke], undefined, { clips }).report.approximations).toEqual([]);
  });

  it('a line with no text writes nothing', () => {
    const { nodes, report } = lower([turnedLine(20, 40, 0, { text: '' })]);
    expect(nodes).toEqual([]);
    expect(report.counts.textBoxes).toBe(0);
  });

  it("a run whose text the writer keeps nothing of is left out, as the writer leaves it out: what is counted is written (final review F5)", () => {
    // characters XML refuses: a C0 control, U+FFFE, U+FFFF, a lone surrogate (a ToUnicode CMap can map glyphs to them)
    const empty = turnedLine(20, 40, 0, { text: '\u0001\uFFFE\uFFFF\uD800' });
    const { nodes, report } = lower([empty]);
    expect(nodes).toEqual([]);
    expect(report.counts.textBoxes).toBe(0);
    // beside a run with text: only that run, and the box sized for it
    const el = turnedLine(20, 40, 0);
    const mixed = { ...el, runs: [{ ...el.runs[0]!, text: '\u0001\uFFFE' }, el.runs[0]!] };
    expect(box([mixed]).paras[0]!.runs.map((r) => r.text)).toEqual(['Hi']);
    expect(box([mixed]).frame).toEqual(box([el]).frame);
    // LF and CR are kept, as spaces
    expect(box([turnedLine(20, 40, 0, { text: '\n' })]).paras[0]!.runs.map((r) => r.text)).toEqual(['\n']);
  });
});

describe('M4b Task 1: spaces with spacing of their own, a lost separator, fontAlgn', () => {
  const runs = (els: TextLineEl[], fonts?: Record<string, FontInfo>) => box(els, fonts).paras[0]!.runs.map((r) => [r.text, r.spc]);

  /** `el` moved `dy` pt down the page, its glyphs and box with it. */
  const shifted = (el: TextLineEl, dy: number): TextLineEl => ({
    ...el,
    baseline: { x: el.baseline.x, y: el.baseline.y + dy },
    bboxPt: [el.bboxPt[0], el.bboxPt[1] + dy, el.bboxPt[2], el.bboxPt[3] + dy],
    runs: el.runs.map((r) => ({ ...r, glyphs: r.glyphs.map((g) => ({ ...g, y: g.y + dy })) })),
  });

  /** A run of `text` (`spaced`: glyphs 10 pt each, each next `gaps[i]` past the last's advance) from `x`, op `op`. */
  const at = (text: string, x: number, op: number, gaps: number[] = [], o: Parameters<typeof spaced>[2] = {}) => spaced(text, gaps, { ...o, op, x });

  it("a space more than 0.5 pt off its run's letter spc is a run of its own, at the median of such spaces in the run; M4-R7 is lifted above it", () => {
    expect(WIDE_SPACE_PT).toBe(0.5);
    // a justified line (atlas/text/18): letters with no spacing of their own, its spaces spread 1.2, 1.4 and 1.6 pt
    expect(runs([spaced('ab cd ef gh', [0, 0, 1.2, 0, 0, 1.4, 0, 0, 1.6, 0])])).toEqual([['ab', 0], [' ', 140], ['cd', 0], [' ', 140], ['ef', 0], [' ', 140], ['gh', 0]]);
    // against the letters' own spacing
    expect(runs([spaced('ab cd', [-1, -1, 0.6, -1])])).toEqual([['ab', -100], [' ', 60], ['cd', -100]]);
    // 0.5 pt off is under the rule (and M4-R7 keeps the space with letters of no spacing); more is over it, where the line
    // has two such spaces, or the one is more than GRID_SPACE_PT off (M8 round 2a, G1: below)
    expect(runs([spaced('ab cd', [0, 0, 0.5, 0])])).toEqual([['ab cd', 0]]);
    expect(runs([spaced('ab cd ef', [0, 0, 0.51, 0, 0, 0.51, 0])])).toEqual([['ab', 0], [' ', 51], ['cd', 0], [' ', 51], ['ef', 0]]);
    expect(runs([spaced('ab cd', [0, 0, 0.71, 0])])).toEqual([['ab', 0], [' ', 71], ['cd', 0]]);
    // the wide spaces are their own; a space under the rule stays with the letters, as M4-R7 has it
    expect(runs([spaced('a b c d', [0, 1.5, 0, 1.7, 0, 0.05])])).toEqual([['a', 0], [' ', 160], ['b', 0], [' ', 160], ['c d', 0]]);
    // under 0.5 pt, M4-R6 as it was: the other spaces at their own median where the letters carry spacing
    expect(runs([spaced('a b c', [-1, 0, -1, -1.3])])).toEqual([['a', -100], [' ', 0], ['b', -100], [' ', -130], ['c', -100]]);
  });

  it("M8 round 2a (G1): a line's one space up to GRID_SPACE_PT off, in a run of letters with no spacing, is PowerPoint's grid", () => {
    expect(GRID_SPACE_PT).toBe(0.7);
    // tier B (b-7f80a8883b, 16 pt): the letters a hair tight, one space 0.57 pt wide, the run 0.6 pt off in all; written
    // as a wide space, PowerPoint put its own grid space in the line as well (+0.44 to +0.72 pt)
    const gaps = [-0.02, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02, 0.57, -0.02, -0.02, -0.02, -0.02, -0.02, -0.02];
    expect(runs([spaced('Everything changed', gaps, { sizePt: 16 })])).toEqual([['Everything changed', 0]]);
    // two such spaces in the line are a spread (justified): written, as M4b-R1 has it
    expect(runs([spaced('ab cd ef', [0, 0, 0.6, 0, 0, 0.62, 0])])).toEqual([['ab', 0], [' ', 61], ['cd', 0], [' ', 61], ['ef', 0]]);
    // a synthetic space is no grid space (a bullet's indent, atlas/text/26: below), nor is a space of letters with spacing
    expect(runs([spaced('ab cd', [-1, -1, 0.6, -1])])).toEqual([['ab', -100], [' ', 60], ['cd', -100]]);
  });

  it('Review Focus 1: a title whose spaces the device grid shortens by up to 0.35 pt is one run, with no space run', () => {
    // 20 pt drawn at 20.064 (M4-R4), each space 0.35 pt short, as PowerPoint keeps the line at the length of 20 pt
    // (the glyphs are 10 pt at 20.064, so at 20 each gap is 0.032 pt more than given: the spaces 0.318 short)
    const title = spaced('WAVE Tower AV', [0, 0, 0, 0, -0.35, 0, 0, 0, 0, 0, -0.35, 0], { sizePt: 20.064 });
    expect(box([title]).paras[0]!.runs.map((r) => [r.text, r.spc, r.sz])).toEqual([['WAVE Tower AV', 0, 2000]]);
    // the same title as PowerPoint exports it, a word per BT block: the synthetic spaces 0.35 short are not runs either
    const words = [spaced('WAVE', [0, 0, 0], { sizePt: 20.064, x: 20, op: 3 }), spaced('Tower', [0, 0, 0, 0], { sizePt: 20.064, x: 20 + 40 + 10 - 0.35, op: 4 })];
    words.push(spaced('a b', [0, 0], { sizePt: 20.064, x: 200, op: 5 })); // the slide shows the font's space: 10 pt
    expect(lower(words).nodes.map((n) => (n as OxTextBox).paras[0]!.runs.map((r) => [r.text, r.spc]))).toEqual([[['WAVE ', 0], ['Tower', 0]], [['a b', 0]]]);
  });

  it('a wide space PowerPoint makes itself is not written: only where the run lays out more than 0.5 pt off its written spacing', () => {
    expect(WIDE_SPACE_PT).toBe(0.5);
    // 9 pt (atlas/effects/01 "ellipse, centred halo"): the space after the comma 0.61 pt wide, the letters a little tight,
    // the run 0.15 pt off in all: PowerPoint's device grid puts it there again (written 0.61, it came back 0.62 too far)
    expect(runs([spaced('ab, cd ef', [-0.06, -0.06, -0.06, 0.61, -0.06, -0.06, -0.1, -0.06], { sizePt: 9 })])).toEqual([['ab, cd ef', 0]]);
    // the device grid's give-back (M4-R7) counts: 41 glyphs of 10 pt drawn at 20.064 for 20 give 1.31 pt back to the
    // one space; drawn at 15.96 for 16 they take 1.03 pt from it (atlas/text/02, 34); both lay out at their length
    const word = 'Internationalization supercalifragilistic';
    const at20 = (20 / 20.064) * 10 - 10; // a letter at its advance at 20 pt
    const give20 = 41 * 10 * (1 - 20 / 20.064);
    const title = spaced(word, [...word.slice(0, -1)].map((u) => (u === ' ' ? at20 - give20 : at20)), { sizePt: 20.064 });
    expect(box([title]).paras[0]!.runs.map((r) => [r.text, r.spc, r.sz])).toEqual([[word, 0, 2000]]);
    const at16 = (16 / 15.96) * 10 - 10;
    const give16 = 41 * 10 * (1 - 16 / 15.96);
    const body = spaced(word, [...word.slice(0, -1)].map((u) => (u === ' ' ? at16 - give16 : at16)), { sizePt: 15.96 });
    expect(box([body]).paras[0]!.runs.map((r) => [r.text, r.spc, r.sz])).toEqual([[word, 0, 1600]]);
    // a run with no space of its own gives nothing back (atlas/text/26: a bullet 16 pt wide drawn at 15.96, its indent
    // 0.52 pt over one space at 16, written; with its one glyph's give-back of 0.04 taken off it fell under the gate)
    const bullet = spaced('■', [], { sizePt: 15.96, x: 20, op: 3 });
    bullet.runs[0]!.glyphs[0]!.adv = 16; // ends at 36; at 16 pt it lays out 0.04 longer
    const item = spaced('item one', [0, 0, 0, 0, 0, 0, 0], { sizePt: 15.96, x: 36 + 0.0401 + 10.0251 + 0.52, op: 4 });
    expect(runs([bullet, item])).toEqual([['■', 0], [' ', 52], ['item one', 0]]);
  });

  it("Review Focus 3: a justified paragraph's last line, a single stretched space, CJK distributed text", () => {
    // the last line of a justified paragraph is not spread: its spaces at their width, within the device grid
    expect(runs([spaced('the end of it', [0, 0, 0, 0.04, 0, 0, 0, -0.03, 0, 0, 0.02, 0])])).toEqual([['the end of it', 0]]);
    // a line with a single space, stretched: that space has its own spc
    expect(runs([spaced('one two', [0, 0, 0, 2.5, 0, 0])])).toEqual([['one', 0], [' ', 250], ['two', 0]]);
    // distributed CJK: every letter, and the space, spread alike: letter spc, no split
    expect(runs([spaced('가나 다라', [2, 2, 2, 2])])).toEqual([['가나 다라', 200]]);
  });

  it("final review Minor 3: a synthetic space takes the measured gap over its font's space width, by the same rules", () => {
    // the slide shows the font's space ('a b': 10 pt at 12 pt), so a gap of 11 pt after 'a b' is that space and 1 pt
    expect(runs([at('a b', 20, 3), at('cd', 50 + 11, 4)])).toEqual([['a b', 0], [' ', 100], ['cd', 0]]);
    // under 0.5 pt off the letters' spacing (none), M4-R7: the space ends the run before it, at its spacing
    expect(runs([at('a b', 20, 3), at('cd', 50 + 10.4, 4)])).toEqual([['a b ', 0], ['cd', 0]]);
    // where M4-R6 gives the run's spaces a spacing of their own, the synthetic space is one of them; the gap holds the
    // spacing PowerPoint puts after the run's last letter (-1, TJ, not in its advance), which is not the space's
    const big = { sizePt: 24 }; // the font's space is 10 pt, a gap within 2.4 pt of it is one space
    const abc = at('ab c', 20, 3, [-1, -1, -1.15], big); // ends at 56.85
    expect(runs([abc, at('de', 56.85 - 1 + 10 - 1.15, 4, [-1], big)])).toEqual([['ab', -100], [' ', -115], ['c', -100], [' ', -115], ['de', -100]]);
    // atlas/text/10 at -1 pt: a run of one glyph has the line's spacing, which PowerPoint puts after it too (its export
    // writes no Tc for it); its space is the line's other spaces' -1.2, not -2.2
    const left = at('다 람', 20, 3, [-1, -1.2], big); // ends at 47.8
    const lone = at('헌', 47.8 - 1 + 10 - 1.2, 4, [], big); // ends at 65.6
    expect(runs([left, lone, at('쳇', 65.6 - 1 + 10 - 1.2, 5, [], big)])).toEqual([['다', -100], [' ', -120], ['람', -100], [' ', -120], ['헌', -100], [' ', -120], ['쳇', -100]]);
    // a bullet's indent about one space wide (atlas/text/25, 26): the bullet is a run of its own, its space at the gap
    const item = at('item one', 41.8, 4, [], { sizePt: 20 });
    expect(runs([at('•', 20, 3, [], { sizePt: 20 }), item])).toEqual([['•', 0], [' ', 180], ['item one', 0]]);
    // with no space of the font on the slide its width is a guess (0.25 x size): the space keeps the letters' spacing
    expect(runs([at('ab', 20, 3), at('cd', 40 + 3 + 1, 4)])).toEqual([['ab ', 0], ['cd', 0]]);
  });

  /** Lowers one assembled box of one line made by hand: its members and their separators, the slide's space widths. */
  function lowerLine(els: TextLineEl[], before: ('none' | 'space')[], spaceWidths: Record<string, number>): OxTextBox {
    const head: AssembledText = { ...els[0]!, lines: [{ els, before }], spaceWidths };
    const ctx: TextCtx = { place: { scale: 1, offset: [0, 0] }, alpha: 1, name: () => 'text', approximate: () => {} };
    return lowerText(head, { f1: font() }, ctx)!;
  }

  it("M8 round 1a: the synthetic space after a symbol font's run is a run of its own, in the next run's font, at the gap over its space", () => {
    // b-700904ace4: a Wingdings bullet (0xA7) at 28 pt, its indent 5.2 pt, one space of the text's font (0.25 em) within
    // 0.1 em: PowerPoint would draw the space in Wingdings, a whole em wide
    const bullet = textline({
      op: 3,
      runs: [run({ text: '\u25aa', fontKey: 'f2', sizePt: 28, glyphs: [{ u: '\u25aa', x: 20, y: 40, adv: 12.8, sym: '\uf0a7' }] })],
      baseline: { x: 20, y: 40 },
      bboxPt: [20, 14, 32.8, 46],
    });
    const item = spaced('item', [0, 0, 0], { sizePt: 28, x: 32.8 + 5.2, op: 4 });
    const head: AssembledText = { ...bullet, lines: [{ els: [bullet, item], before: ['none', 'space'] }], spaceWidths: { f1: 0.25 } };
    const ctx: TextCtx = { place: { scale: 1, offset: [0, 0] }, alpha: 1, name: () => 'text', approximate: () => {} };
    const fonts = { f1: font(), f2: font({ key: 'f2', baseFont: 'BCDIEE+Wingdings-Regular', latinName: 'Wingdings' }) };
    const written = lowerText(head, fonts, ctx)!.paras[0]!.runs;
    expect(written.map((r) => [r.text, r.spc, r.latin, r.sym ?? null])).toEqual([
      ['\uf0a7', 0, 'Wingdings', 'Wingdings'],
      [' ', -180, 'Unlisted Sans', null],
      ['item', 0, 'Unlisted Sans', null],
    ]);
    // without a space of the next font on the slide: its width a guess, 0.25 x its size
    const guessed = lowerText({ ...head, spaceWidths: {} }, fonts, ctx)!.paras[0]!.runs;
    expect(guessed.map((r) => [r.text, r.spc])).toEqual([['\uf0a7', 0], [' ', -180], ['item', 0]]);
  });

  it('final review Minor 4: a member whose runs are all dropped keeps its separator, measured from the run before to the run after', () => {
    const texts = (b: OxTextBox) => b.paras[0]!.runs.map((r) => [r.text, r.spc]);
    // a run of size 0 one space after 'ab', 'cd' touching it: the space between 'ab' and 'cd' is written
    const x = at('x', 43, 4);
    const zero = { ...x, runs: [{ ...x.runs[0]!, sizePt: 0, glyphs: [{ u: 'x', x: 43, y: 40, adv: 0 }] }] };
    expect(texts(lowerLine([at('ab', 20, 3, [0]), zero, at('cd', 43, 5, [0])], ['none', 'space', 'none'], { f1: 0.25 }))).toEqual([['ab ', 0], ['cd', 0]]);
    // a run the writer keeps nothing of, 10 pt wide in the PDF: the space covers it, so 'cd' stands where the PDF has it
    const control = at('\u0001', 43, 4);
    expect(texts(lowerLine([at('ab', 20, 3, [0]), control, at('cd', 53, 5, [0])], ['none', 'space', 'none'], { f1: 0.25 }))).toEqual([['ab', 0], [' ', 1000], ['cd', 0]]);
  });

  it('fontAlgn: a line of runs of different sizes on one baseline (within 0.05 pt) is written fontAlgn="base"', () => {
    expect(ONE_BASELINE_PT).toBe(0.05);
    const small = at('ab', 20, 3, [0], { sizePt: 12 }); // ends at 40; a space at 12 pt is 3 (no space glyph: 0.25 x size)
    const large = at('CD', 43, 4, [0], { sizePt: 24 });
    const one = box([small, large]);
    expect(one.paras).toHaveLength(1);
    expect(one.paras[0]!.runs.map((r) => r.sz)).toEqual([1200, 2400]);
    expect(one.paras[0]!.fontAlgn).toBe('base');
    expect(box([small, shifted(large, 0.05)]).paras[0]!.fontAlgn).toBe('base');
    // one size: nothing to align
    expect(box([small, at('cd', 43, 4, [0], { sizePt: 12 })]).paras[0]!.fontAlgn ?? null).toBeNull();
    // runs of different sizes on baselines further apart are not one line (atlas/text/41, fontAlgn=b: 1.44 pt): two boxes
    const { nodes } = lower([small, shifted(large, -1.44)]);
    expect(nodes.map((n) => (n as OxTextBox).paras.map((p) => p.fontAlgn ?? null))).toEqual([[null], [null]]);
  });

  it('Task 3 review Minor 4: a line of two gradient runs, and a space run of its own, pairs each written run with its own paint', () => {
    const paint = (rgb: [number, number, number]) => linear({ p0: [0, 0], p1: [1000, 0], stops: [{ t: 0, rgb }, { t: 1, rgb }] });
    const gradRun = (el: TextLineEl, rgb: [number, number, number]): TextLineEl => ({ ...el, runs: [{ ...el.runs[0]!, rgb: null, fill: paint(rgb) }] });
    // 'ab' red, a wide space (its own run), 'cd' blue, a plain solid run 'ef' after it
    const ab = gradRun(at('ab', 20, 3, [0]), [255, 0, 0]);
    const cd = gradRun(at('cd', 45, 4, [0]), [0, 0, 255]);
    const ef = at('ef', 70, 5, [0]);
    const b = lowerLine([ab, cd, ef], ['none', 'space', 'space'], { f1: 0.25 });
    const colours = b.paras[0]!.runs.map((r) => [r.text, r.fill.kind === 'grad' ? r.fill.stops[0]!.rgb : r.fill.kind === 'solid' ? `solid ${r.fill.rgb}` : r.fill.kind]);
    expect(colours.filter(([t]) => t!.includes('ab'))).toEqual([['ab', 'FF0000']]);
    expect(colours.filter(([t]) => t!.includes('cd'))).toEqual([['cd', '0000FF']]);
    expect(colours.filter(([t]) => t!.includes('ef')).map((c) => c[1]!.startsWith('solid'))).toEqual([true]);
  });

  it("Task 1 review Minor 1: fontAlgn compares each run's baseline with the previous run's, as joining a line does", () => {
    // 12 pt at 0, 12 pt 0.04 pt lower, 24 pt 0.08 pt lower: each run within 0.05 pt of the one before, so one line
    const chain = [at('ab', 20, 3, [0], { sizePt: 12 }), shifted(at('cd', 40, 4, [0], { sizePt: 12 }), 0.04), shifted(at('EF', 60, 5, [0], { sizePt: 24 }), 0.08)];
    const one = box(chain);
    expect(one.paras).toHaveLength(1);
    expect(one.paras[0]!.runs.map((r) => r.sz)).toEqual([1200, 1200, 2400]);
    expect(one.paras[0]!.fontAlgn).toBe('base');
  });

  it("Task 1 review Minor 2: a wide space's spacing goes with its own glyph, whatever characters without one come before it", () => {
    const wide = spaced('ab cd', [0, 0, 1.5, 0]);
    expect(runs([wide])).toEqual([['ab', 0], [' ', 150], ['cd', 0]]);
    // a whitespace character of the text with no glyph of its own (a tab here) before the wide space
    const tab = { ...wide, runs: [{ ...wide.runs[0]!, text: 'a\tb cd' }] };
    expect(runs([tab])).toEqual([['a\tb', 0], [' ', 150], ['cd', 0]]);
    // a glyph of no code point before it (it adds nothing to the text)
    const [a, b, ...rest] = wide.runs[0]!.glyphs;
    const mute = { ...wide, runs: [{ ...wide.runs[0]!, glyphs: [a!, { u: '', x: a!.x, y: a!.y, adv: 0 }, b!, ...rest] }] };
    expect(runs([mute])).toEqual([['ab', 0], [' ', 150], ['cd', 0]]);
  });

  it("Task 1 review Minor 3: a justified paragraph's last line gets no space spc, under a line whose spaces are spread", () => {
    const P = ['Sect', 'P', 'Span'];
    const tagged = (el: TextLineEl): TextLineEl => ({ ...el, provenance: { ...el.provenance, struct: P } });
    // the paragraph's justified line: each space 1.4 pt wider than the font's (atlas/text/18), written
    const justified = tagged(spaced('ab cd ef', [0, 0, 1.4, 0, 0, 1.4, 0], { op: 3 }));
    // its last line, set at the font's spacing: its spaces where PowerPoint's device grid puts them, up to 0.35 pt off
    const last = tagged(shifted(spaced('gh ij kl', [0, 0, -0.3, 0, 0, -0.35, 0], { op: 4 }), 14.4));
    const b = box([justified, last]);
    expect(b.paras.map((p) => p.runs.map((r) => [r.text, r.spc]))).toEqual([
      [['ab', 0], [' ', 140], ['cd', 0], [' ', 140], ['ef', 0]],
      [['gh ij kl', 0]],
    ]);
  });
});

describe('M8 round 2a: spacing in kerned runs (K2, K3, K4)', () => {
  const written = (els: TextLineEl[]) => lower(els).nodes.flatMap((n) => (n as OxTextBox).paras.flatMap((p) => p.runs.map((r) => [r.text, r.spc, r.kern ?? null])));

  it("K2: a kerned run's spc is its unkerned pairs' level (the pairs at its Tc), not the median of kerned pairs", () => {
    expect(TEMPLATE_KERN_PT).toBe(12);
    // tier B's "DATA" at 24 pt: D-A at its advance, A-T and T-A kerned; the median (-1.835) written as spc had
    // PowerPoint kern A-T and T-A on top of it (-5.4 pt by the line's end)
    expect(written([spaced('DATA', [0.017, -1.906, -1.835], { sizePt: 24 })])).toEqual([['DATA', 0, null]]);
    // a word at 28 pt: half its pairs kerned (tier B, Open Sans)
    expect(written([spaced('standard', [-0.019, -0.487, -0.552, -0.022, -0.516, -0.022, -0.02], { sizePt: 28 })])).toEqual([['standard', 0, null]]);
  });

  it('K2: a kerned run with spacing of its own (no pair at its Tc) is written kern="0", each pair off its level on its own', () => {
    // a Calibri-class title at 28 pt with spc -1: every pair kerned or spaced, none at the font's advance; PowerPoint's
    // kerning on spacing does not lay out what the PDF has, so the PDF's pair offsets are written as they are: the level
    // is the largest group of pairs within the floor of one another (-1.05, -1.1, -1.11), the others on their own
    const title = spaced('Summary', [-1.05, -0.85, -1.48, -1.52, -1.1, -1.11], { sizePt: 28 });
    expect(written([title])).toEqual([['S', -110, 0], ['u', -85, 0], ['m', -148, 0], ['m', -152, 0], ['ary', -110, 0]]);
    // the drift guard predicts it exactly: one box
    expect(lower([title]).nodes).toHaveLength(1);
  });

  it("K2: a kerned run under the size the template kerns (12 pt) keeps the template's kern: PowerPoint kerns it not at all", () => {
    // its pairs written on their own were the author's device grid on tier B (a 4.7 pt table: 233 runs became 931)
    expect(written([spaced('AVATAR', [-0.5, -0.45, -0.5, 0, 0], { sizePt: 10 })])).toEqual([['AVATAR', 0, null]]);
    expect(written([spaced('AVATAR', [-0.5, -0.45, -0.5, 0, 0], { sizePt: 12 })])).toEqual([['AVATAR', 0, null]]);
  });

  it('K3: a space short of the letters before a glyph it kerns with, in a kerned run, is kerning: no wide space, no split', () => {
    expect(kernsAfterSpace('A')).toBe(true);
    expect(kernsAfterSpace('Á')).toBe(true);
    expect(kernsAfterSpace('a')).toBe(false);
    // tier B, a capitals title at 20 pt, A-T kerned, the space before A 0.76 pt short; written as a wide space,
    // PowerPoint kerned " A" again
    const line = spaced('GE ARTE', [0, 0, -0.76, 0, -1.3, 0], { sizePt: 20 });
    expect(written([line])).toEqual([['GE ARTE', 0, null]]);
    // a line whose only kerning is at a space (tier B, a capitals title at 20 pt, the space before A 0.75 pt short,
    // past PowerPoint's grid space, GRID_SPACE_PT): kerned, and that space PowerPoint's kerning
    expect(written([spaced('OLD AVENUE', [0, 0, 0, -0.75, 0, 0, 0, 0, 0], { sizePt: 20 })])).toEqual([['OLD AVENUE', 0, null]]);
    // up to the grid space it is the grid (atlas/text/11's unkerned title: the space before T 0.33 pt short)
    expect(written([spaced('OLD AVENUE', [0, 0, 0, -0.33, 0, 0, 0, 0, 0], { sizePt: 20 })])).toEqual([['OLD AVENUE', 0, 0]]);
    // the same space before a glyph that does not kern with it stays a wide space
    expect(written([spaced('GE BRTE', [0, 0, -0.76, 0, -1.3, 0], { sizePt: 20 })])).toEqual([['GE', 0, null], [' ', -76, null], ['BRTE', 0, null]]);
    // in a run written kern="0" (spacing of its own), PowerPoint does not kern it: the space has its own spacing, as a letter
    expect(written([spaced('GE ARTE', [-1, -1, -1.8, -1, -2, -1], { sizePt: 20 })])).toEqual([['GE', -100, 0], [' ', -180, 0], ['A', -100, 0], ['R', -200, 0], ['TE', -100, 0]]);
  });

  it('K4: kerning is decided over the line; PowerPoint kerns a pair across two touching runs of one font itself', () => {
    // a word in a link colour, then ", A..." in plain text: "r," kerned -1.64 pt across the two runs, the second showing no
    // kerning of its own: both are written with the template's kern, the pair across them PowerPoint's (tier B: written
    // as spacing as well, a coloured "y," came 1.38 pt too close, V1 0 -> 1,325 px)
    const a = spaced('reporter', [0, -0.42, 0, 0, 0, 0, 0], { sizePt: 22, op: 3, x: 20 }); // ends at 99.58
    const b = spaced(', Ar', [0, 0, 0], { sizePt: 22, op: 4, x: 99.58 - 1.64 });
    b.runs[0] = { ...b.runs[0]!, rgb: [0, 0, 255] };
    expect(written([a, b])).toEqual([['reporter', 0, null], [', Ar', 0, null]]);
    // a pair across two runs is no evidence of kerning by itself: a URL's runs ("3&" 0.25 pt), "T" then "ext" (the one
    // glyph's run takes that gap as its spacing, as before)
    const t = spaced('T', [], { sizePt: 32, op: 3, x: 20 });
    const ext = spaced('ext', [0, 0], { sizePt: 32, op: 4, x: 30 - 2.2 });
    expect(written([t, ext])).toEqual([['T', -220, 0], ['ext', 0, 0]]);
  });

  it("M8 round 3a: a one-glyph run's gap across to the next run that no kerning makes is its spacing, in a kerned line too", () => {
    // tier B (b-b6afd69f3e, page 3): a bullet at 36 pt, 2.94 pt past its advance before the item's text, whose line shows
    // kerning elsewhere ("ve" -0.252 pt). Taken as kerning across the runs (the line's level, 0), the gap was lost and the
    // item's text came 2.94 pt early (V1 0 -> 11,148 px). Kerning draws a pair closer; a gap this wide that opens it is not
    // a font's kerning, so the bullet keeps it as its spacing, as before round 2 (and as in a line with no kerning)
    const bullet = spaced('•', [], { sizePt: 36, op: 3, x: 20 });
    const item = spaced('driven', [0, 0, 0, -0.252, 0], { sizePt: 36, op: 4, x: 30 + 2.94 });
    expect(written([bullet, item])).toEqual([['•', 294, 0], ['driven', 0, null]]);
    // the drift guard sees it: one box
    expect(lower([bullet, item]).nodes).toHaveLength(1);
    // a pair across the runs that draws them closer is still kerning in a kerned line (K4): the line's level
    const v = spaced('V', [], { sizePt: 36, op: 3, x: 20 });
    const rest = spaced('alve', [0, 0, -0.252], { sizePt: 36, op: 4, x: 30 - 1.5 });
    expect(written([v, rest])).toEqual([['V', 0, null], ['alve', 0, null]]);
  });

  it('M8 round 3a: a box one line of which shows kerning is kerned in every line (PowerPoint kerns a box alike)', () => {
    const P = ['Sect', 'P', 'Span'];
    const tagged = (el: TextLineEl): TextLineEl => ({ ...el, provenance: { ...el.provenance, struct: P } });
    const down = (el: TextLineEl, dy: number): TextLineEl => ({
      ...el,
      baseline: { x: el.baseline.x, y: el.baseline.y + dy },
      bboxPt: [el.bboxPt[0], el.bboxPt[1] + dy, el.bboxPt[2], el.bboxPt[3] + dy],
      runs: el.runs.map((r) => ({ ...r, glyphs: r.glyphs.map((g) => ({ ...g, y: g.y + dy })) })),
    });
    // tier B (b-8da31c6fac, page 30): a 17 pt paragraph kerned in the source (kern 12 pt). Its first line shows kerning
    // ("ra" -0.31 pt); the next shows only small pairs ("ff" -0.141, "te" -0.174 pt), under K1's two-pair size (17/80 pt),
    // which alone is the device grid's: written kern="0", PowerPoint kerned none of the box's lines but the first, and
    // the slide lost V1 0 -> 224 px. A text box's runs are kerned alike
    const first = tagged(spaced('ragionate', [-0.31, 0, 0, 0, 0, 0, 0, 0], { sizePt: 17, op: 3 }));
    const second = tagged(down(spaced('ufficiale', [0, -0.141, 0, 0, 0, -0.174, 0, 0], { sizePt: 17, op: 4 }), 20.4));
    expect(written([second])).toEqual([['ufficiale', 0, 0]]);
    const b = box([first, second]);
    expect(b.paras.map((p) => p.runs.map((r) => [r.text, r.spc, r.kern ?? null]))).toEqual([[['ragionate', 0, null]], [['ufficiale', 0, null]]]);
    // a box of lines none of which shows kerning stays kern="0" (K1)
    const plainFirst = tagged(spaced('ragionate', [-0.12, 0, 0, 0, 0, 0, 0, 0], { sizePt: 17, op: 3 }));
    const plain = box([plainFirst, second]);
    expect(plain.paras.map((p) => p.runs.map((r) => r.kern ?? null))).toEqual([[0], [0]]);
  });
});
