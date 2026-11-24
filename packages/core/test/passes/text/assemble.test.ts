import { readFileSync } from 'node:fs';
import type { OxNode, OxTextBox } from '@deckback/ooxml';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convert } from '../../../src/convert';
import { lowerSlide, runPasses, type LowerCtx } from '../../../src/passes';
import { baselineAt, lineSpacing } from '../../../src/passes/lower/text';
import type { SlideReport } from '../../../src/passes/report';
import { assembleText, type AssembledText } from '../../../src/passes/text/assemble';
import type { Element, FontInfo, SceneDeck, TextLineEl } from '../../../src/scene/types';
import { repoRoot } from '../../helpers/fixtures';
import { deckOf, rectPath, shape, slideOf, snapshot } from '../../helpers/passes';
import { P_SPAN, word, wordWidth, words } from './words';

/**
 * Text assembly as a pass and as it is lowered (M4 Task 1): the box takes its first run's id and place in z-order, a
 * paragraph per line; the runs keep their own properties, and a synthetic space is written after the run before it. A
 * gap wider than one space is no line (M4-R1). Each line starts at its own margin; the line pitch is PowerPoint's own,
 * measured (`baselineAt`, `lineSpacing`).
 */

const PT = 12700;
const CTX: LowerCtx = { page: 1, scale: 1, offset: [0, 0] };
/** An uncalibrated font without metrics: k 0.9, descent 0.25 (baseline.ts). */
const FONT: FontInfo = {
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
};
const FONTS = { f1: FONT, f2: { ...FONT, key: 'f2', latinName: 'Other Sans' } };

function lower(elements: Element[], ctx: Partial<LowerCtx> = {}): { nodes: OxNode[]; report: SlideReport } {
  const input = slideOf(elements);
  const deck: SceneDeck = { ...deckOf([input]), fonts: FONTS };
  const { slide, report } = runPasses(input, deck);
  return { nodes: lowerSlide(slide, deck, { ...CTX, ...ctx, report }).nodes, report };
}

const texts = (b: OxTextBox): string[][] => b.paras.map((p) => p.runs.map((r) => r.text));

/** Two tagged lines of two words each, left-aligned at x = 20, the second 14.4 pt (1.2 x 12) below the first. */
const paragraph = (): TextLineEl[] => [...words(['two', 'lines'], 20, 40, 0.25, { struct: P_SPAN }), ...words(['of', 'text'], 20, 54.4, 0.25, { struct: P_SPAN })];

describe('the pass', () => {
  it("the box takes its first run's id and place in z-order; its members are gone; its input is unchanged", () => {
    const [a, b, c, d] = paragraph();
    const before = shape({ op: 1, geom: rectPath(200, 10, 20, 20) });
    const between = shape({ op: 4, geom: rectPath(200, 100, 20, 20) }); // covers nothing of the text
    const input = slideOf([before, a!, b!, between, c!, d!]);
    const kept = snapshot(input);
    const out = assembleText(input);
    expect(input).toEqual(kept);
    expect(out.elements.map((el) => `${el.kind} ${el.id}`)).toEqual([`shape ${before.id}`, `textline ${a!.id}`, `shape ${between.id}`]);
    const box = out.elements[1] as AssembledText;
    expect(box.lines.map((l) => l.els.map((e) => e.id))).toEqual([[a!.id, b!.id], [c!.id, d!.id]]);
    // the same input gives the same output
    expect(assembleText(slideOf([before, a!, b!, between, c!, d!]))).toEqual(out);
  });
});

describe('lowering an assembled box', () => {
  it('one OxTextBox named for the first run, a paragraph per line; runs keep their properties, a synthetic space ends the run before it', () => {
    const els = paragraph();
    els[1]!.runs[0]!.fontKey = 'f2';
    els[1]!.runs[0]!.bold = true;
    const { nodes, report } = lower(els);
    expect(nodes).toHaveLength(1);
    const b = nodes[0] as OxTextBox;
    expect(b.name).toBe(`pdf:${els[0]!.id} text`);
    expect(texts(b)).toEqual([['two ', 'lines'], ['of ', 'text']]);
    expect(b.paras[0]!.runs.map((r) => [r.latin, r.b])).toEqual([['Unlisted Sans', false], ['Other Sans', true]]);
    expect(b.paras.map((p) => [p.marL, p.lnSpc])).toEqual([[0, null], [0, null]]);
    expect(report.counts.textBoxes).toBe(1);
  });

  it('the box: the first baseline k x size below its top, single spacing at a pitch of 1.2 x size, its lines + 2 pt wide', () => {
    const b = lower(paragraph()).nodes[0] as OxTextBox;
    expect(b.frame.x).toBe(20 * PT);
    expect(b.frame.y).toBe(Math.round((40 - 0.9 * 12) * PT));
    // the second baseline 14.4 below the first, and the last line's descent (0.25 x size) below it
    expect(b.frame.h).toBe(Math.round((0.9 * 12 + 14.4 + 0.25 * 12) * PT));
    // never wider than its lines plus 2 pt: 'two lines' ends at 20 + 18 + 3 + 30
    expect(b.frame.w).toBe((wordWidth('two') + 3 + wordWidth('lines') + 2) * PT);
  });

  it("a line starts at its own margin from the box's left edge", () => {
    const els = [word('first', 20, 40, { struct: P_SPAN }), word('indented', 38, 54.4, { struct: P_SPAN })];
    const b = lower(els).nodes[0] as OxTextBox;
    expect(texts(b)).toEqual([['first'], ['indented']]);
    expect(b.paras.map((p) => p.marL)).toEqual([0, 18 * PT]);
    expect(b.frame.x).toBe(20 * PT);
  });

  it('M4-R1: a bullet set wider than a space from its text is a box of its own', () => {
    const { nodes } = lower(words(['•', 'item'], 20, 40, 1.0));
    expect(nodes.map((n) => texts(n as OxTextBox))).toEqual([[['•']], [['item']]]);
  });

  it('a page at another scale: margins and the box scale with it', () => {
    const els = [word('first', 20, 40, { struct: P_SPAN }), word('indented', 38, 54.4, { struct: P_SPAN })];
    const b = lower(els, { scale: 0.5, offset: [10, 30] }).nodes[0] as OxTextBox;
    expect(b.paras.map((p) => p.marL)).toEqual([0, 9 * PT]);
    expect(b.frame.x).toBe((20 * 0.5 + 10) * PT);
  });

  it('approximations of the member runs are unioned under the box\'s id', () => {
    const els = words(['plain', 'narrow', 'leaning'], 20, 40, 0.25);
    els[1]!.runs[0]!.hScale = 0.9;
    els[2]!.runs[0]!.skew = 0.3;
    const { report } = lower(els);
    expect(report.approximations).toEqual([
      { id: els[0]!.id, kind: 'hscale' },
      { id: els[0]!.id, kind: 'text-skew' },
    ]);
    expect(report.counts.textBoxes).toBe(1);
  });

  it('a turned paragraph: the box turns with its lines, its first baseline where the first line has it', () => {
    const t = (90 * Math.PI) / 180;
    const els = [word('first', 100, 100, { struct: P_SPAN, angleDeg: 90 }), word('next', 100 - 14.4 * Math.sin(t), 100 + 14.4 * Math.cos(t), { struct: P_SPAN, angleDeg: 90 })];
    const b = lower(els).nodes[0] as OxTextBox;
    expect(b.frame.rot).toBe(90 * 60000);
    expect(b.paras).toHaveLength(2);
    // the box's top left corner, turned about its centre, lies k x size before the first baseline across the line
    const [cx, cy] = [(b.frame.x + b.frame.w / 2) / PT, (b.frame.y + b.frame.h / 2) / PT];
    const [w, h] = [b.frame.w / PT, b.frame.h / PT];
    const [ox, oy] = [cx - (-h / 2 + 0.9 * 12), cy + -w / 2]; // R(90°)(x, y) = (-y, x)
    expect(Math.abs(ox - 100)).toBeLessThan(0.01);
    expect(Math.abs(oy - 100)).toBeLessThan(0.01);
  });
});

describe("PowerPoint's line pitch (measured, M4 Task 1)", () => {
  // The first baseline of a line of height h below its top, as PowerPoint draws it (measure3 in the task report):
  // [family, size, k, [[h, measured baseline], ...]]
  const MEASURED: [string, number, number, [number, number][]][] = [
    ['Malgun Gothic', 36, 0.9844, [[20, 15.01], [29, 21.73], [32, 24.16], [36, 28.24], [43, 35.2], [44, 33.05], [54, 40.61], [72, 54.11]]],
    ['Batang', 18, 1.0337, [[10, 7.57], [13, 9.97], [18, 15.01], [21, 18.01], [22, 16.61], [30, 22.61], [37, 27.82]]],
    ['Pretendard', 10, 0.9609, [[6, 4.57], [9, 6.73], [10, 7.57], [12, 9.61], [13, 9.73], [20, 15.06]]],
    ['NanumGothic', 36, 1.0657, [[20, 15.01], [24, 19.09], [30, 25.09], [43, 38.08], [44, 33.05], [60, 45.08]]],
  ];

  it('baselineAt: up to the single height (1.2 x size), h less the smaller of h/4 and the single descent; past it, 0.75 h', () => {
    for (const [family, size, k, samples] of MEASURED) {
      const line = { single: 1.2 * size, above: k * size };
      for (const [h, measured] of samples) expect(Math.abs(baselineAt(h, line) - measured), `${family} ${size} pt, h ${h}`).toBeLessThan(0.2);
    }
    expect(baselineAt(14.4, { single: 14.4, above: 10.8 })).toBeCloseTo(10.8, 10);
  });

  it('a uniform pitch of 1.2 x size: single spacing, no a:lnSpc', () => {
    const line = { single: 14.4, above: 10.8, pitch: 14.4 };
    const plan = lineSpacing([line, line, line]);
    expect(plan.map((p) => p.lnSpc)).toEqual([null, null, null]);
    expect(plan.map((p) => p.y)).toEqual([10.8, 25.2, 39.6].map((y) => expect.closeTo(y, 9)));
  });

  it('a uniform pitch of whole points: a:spcPts on every line (PowerPoint lays exact spacing out in whole points)', () => {
    const line = { single: 14.4, above: 10.8, pitch: 24 };
    const plan = lineSpacing([line, line]);
    expect(plan.map((p) => p.lnSpc)).toEqual([{ kind: 'pts', val: 2400 }, { kind: 'pts', val: 2400 }]);
    expect(plan.map((p) => p.y)).toEqual([18, 42].map((y) => expect.closeTo(y, 9)));
  });

  it('a uniform pitch of a whole percent of single (90 %, PowerPoint\'s body text): a:spcPct on every line', () => {
    const line = { single: 14.4, above: 10.8, pitch: 12.96 };
    const plan = lineSpacing([line, line, line]);
    expect(plan.map((p) => p.lnSpc)).toEqual([1, 2, 3].map(() => ({ kind: 'pct', val: 90000 })));
    expect(plan.map((p) => p.y)).toEqual([9.72, 22.68, 35.64].map((y) => expect.closeTo(y, 9)));
  });

  it('any other pitch: each line its own spacing, so that no error adds up from line to line', () => {
    // atlas/text/24: 14.04 pt text (PowerPoint's 14 pt) at a pitch of 16.8, nine lines
    const line = { single: 1.2 * 14.04, above: 0.9 * 14.04, pitch: 16.8 };
    const plan = lineSpacing(Array.from({ length: 9 }, () => line));
    plan.forEach((p, i) => expect(Math.abs(p.y - plan[0]!.y - 16.8 * i), `line ${i + 1}`).toBeLessThan(0.1));
    for (const pitch of [13.3, 15.75, 19.1, 22.2, 31.4]) {
      const lines = lineSpacing(Array.from({ length: 6 }, () => ({ single: 14.4, above: 10.8, pitch })));
      lines.forEach((p, i) => expect(Math.abs(p.y - lines[0]!.y - pitch * i), `pitch ${pitch}, line ${i + 1}`).toBeLessThan(0.15));
    }
  });
});

describe('the committed corpus, tagged and not (A/B)', () => {
  /** The text boxes of the one slide of `pdf`'s page `page`: their names and paragraph counts, in z-order. */
  async function textBoxes(pdf: string, page: number): Promise<{ boxes: [string, number][]; counted: number }> {
    const bytes = new Uint8Array(readFileSync(`${repoRoot}corpus/generated/${pdf}`));
    const { pptx, report } = await convert(bytes, { pages: [page] });
    const slide = strFromU8(unzipSync(pptx)['ppt/slides/slide1.xml']!);
    const boxes = [...slide.matchAll(/<p:sp><p:nvSpPr><p:cNvPr id="\d+" name="([^"]*)"\/><p:cNvSpPr txBox="1"\/>.*?<\/p:sp>/g)].map(
      (m): [string, number] => [m[1]!, (m[0].match(/<a:p>/g) ?? []).length],
    );
    return { boxes, counted: report.slides[0]!.counts.textBoxes };
  }

  it("atlas/text/24 (two columns of wrapped Korean, a paragraph of English): tagged, each column's lines are one box; untagged, a box per line", async () => {
    const std = await textBoxes('atlas-smoke_std.pdf', 21);
    const notags = await textBoxes('atlas-smoke_notags.pdf', 21);
    expect(std.counted).toBe(std.boxes.length);
    expect(notags.counted).toBe(notags.boxes.length);
    expect(Math.max(...notags.boxes.map(([, n]) => n))).toBe(1);
    // the Korean column: nine lines of three paragraphs; the English one: twelve lines
    expect(std.boxes.map(([, n]) => n).filter((n) => n > 1)).toEqual([9, 12]);
    expect(std.boxes.length).toBeLessThan(notags.boxes.length);
  }, 60_000);
});
