import { describe, expect, it } from 'vitest';
import { assembleText, type AssembledText } from '../../../src/passes/text/assemble';
import { baselineK } from '../../../src/passes/baseline';
import { K_TOL, LINE_RULES, MAX_PAINTS_BETWEEN, ONE_BASELINE_PT, SPACE_RULE, spaceAdvance, spaceWidths, textLines } from '../../../src/passes/text/lines';
import type { Element, FontInfo, GroupRef, SceneSlide, TextRun } from '../../../src/scene/types';
import { hotspot, lineStyle, rectPath, shape, slideOf, snapshot } from '../../helpers/passes';
import { word, wordWidth, words } from './words';

/**
 * Text assembly, lines (M4 Task 1, spec §4.2 pass 7): consecutive text runs join one line when they share a direction
 * (0.1°) and a writing mode, their baselines are within 0.15 x size across the line, each starts no more than 0.3 x size
 * before the previous one's last advance ends, and nothing painted between them in z-order covers the gap. M4-R1: the gap
 * is at most one space of the font, which gets one synthetic space, unless a space glyph is there already; a wider gap
 * splits the line.
 */

const SEP = { none: '', space: ' ' } as const;

/** Each text box of the assembled slide as its lines, each line its runs' text with the separators written in. */
function boxes(slide: SceneSlide): string[][] {
  return slide.elements
    .filter((el): el is AssembledText => el.kind === 'textline')
    .map((el) => el.lines.map((line) => line.els.map((e, j) => SEP[line.before[j]!] + e.runs.map((r) => r.text).join('')).join('')));
}

const assembled = (elements: Element[]): string[][] => boxes(assembleText(slideOf(elements)));

/** Each line of the elements (`textLines`, before the drift guard splits a box: drift.test.ts), as `boxes` gives a box of one line. */
const joined = (elements: Element[]): string[][] =>
  textLines(elements).map((line) => [line.els.map((e, j) => SEP[line.before[j]!] + e.runs.map((r) => r.text).join('')).join('')]);

/** A filled rectangle at (x, y), w x h. */
const rect = (x: number, y: number, w: number, h: number): Element => shape({ geom: rectPath(x, y, w, h) });

const group = (alpha: number): GroupRef => ({ alpha, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null });

describe('the rule values', () => {
  it("are those of the brief, the gap's upper bound one space of the font (M4-R1)", () => {
    expect(LINE_RULES).toEqual({ angleTolDeg: 0.1, baselineTol: 0.15, gapMin: -0.3, spaceGap: 0.2 });
    expect(SPACE_RULE).toEqual({ fallback: 0.25, tol: 0.1 });
  });
});

describe('runs into lines', () => {
  it('per-word runs on one baseline are one line, in order; a word gap gets one synthetic space', () => {
    expect(assembled(words(['Q3', 'Business', 'Review'], 20, 40, 0.25))).toEqual([['Q3 Business Review']]);
  });

  it('Review Focus 2: per-word BT blocks in alternating Type0 / WinAnsi fonts are one line, spaces from the gaps, none twice, none missing', () => {
    // PowerPoint's export: a Korean word in its Type0 font, a Latin word in a WinAnsi font, each its own BT block; a run
    // that ends with its own space glyph needs none, nor does one that starts with one
    const ws = [
      word('분기', 20, 40, { fontKey: 'f1' }),
      word('실적', 20 + wordWidth('분기') + 3, 40, { fontKey: 'f1' }),
      word('Q3 ', 20 + wordWidth('분기실적') + 6, 40, { fontKey: 'f2' }),
      word('Business', 20 + wordWidth('분기실적Q3 ') + 6 - 0.12, 40, { fontKey: 'f2' }),
      word(' 12%', 20 + wordWidth('분기실적Q3 Business') + 6, 40, { fontKey: 'f1' }),
      word('달성', 20 + wordWidth('분기실적Q3 Business 12%') + 9, 40, { fontKey: 'f1' }),
    ];
    const out = assembleText(slideOf(ws));
    expect(boxes(out)).toEqual([['분기 실적 Q3 Business 12% 달성']]);
    // the runs keep their own fonts
    const line = (out.elements[0] as AssembledText).lines[0]!;
    expect(line.els.map((e) => e.runs[0]!.fontKey)).toEqual(['f1', 'f1', 'f2', 'f2', 'f1', 'f1']);
  });

  it('M4-R1: a gap wider than one space splits the line into boxes (a bullet\'s indent, a column, a justified spread)', () => {
    // no space glyph of the font on the slide: a space is 0.25 x size, within 0.1 x size
    expect(assembled(words(['ab', 'cd'], 20, 40, 0.36))).toEqual([['ab'], ['cd']]);
    expect(assembled(words(['ab', 'cd'], 20, 40, 0.5))).toEqual([['ab'], ['cd']]);
    expect(assembled(words(['•', 'item'], 20, 40, 1.3))).toEqual([['•'], ['item']]);
    expect(assembled(words(['a', 'b', 'c', 'd'], 20, 40, 0.8))).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('M4-R1: a gap of one space joins, with one synthetic space: the font\'s own space width from its space glyphs, else 0.25 x size, within 0.1 x size', () => {
    expect(assembled(words(['ab', 'cd'], 20, 40, 0.25))).toEqual([['ab cd']]);
    expect(assembled(words(['ab', 'cd'], 20, 40, 0.15))).toEqual([['ab cd']]);
    expect(assembled(words(['ab', 'cd'], 20, 40, 0.35))).toEqual([['ab cd']]);
    // a gap well under a space: the runs touch, no space (the drift guard then splits the box: written touching, 'cd'
    // would land 1.2 pt short of the PDF)
    expect(joined(words(['ab', 'cd'], 20, 40, 0.1))).toEqual([['abcd']]);
    expect(assembled(words(['ab', 'cd'], 20, 40, 0.1))).toEqual([['ab'], ['cd']]);
    expect(assembled(words(['ab', 'cd'], 20, 40, 0))).toEqual([['abcd']]);
    // a font whose space glyph (elsewhere on the slide) is 0.5 x size wide: a gap of 0.5 x size is one space of it,
    // and 0.25 x size is not
    const wide = (gap: number) => {
      const [a, b] = words(['ab', 'cd'], 20, 40, gap, { fontKey: 'f9' });
      const sample = word('x y', 20, 150, { fontKey: 'f9' });
      sample.runs[0]!.glyphs[1]!.adv = 6;
      return assembled([a!, b!, sample]);
    };
    expect(wide(0.5)).toEqual([['ab cd'], ['x y']]);
    expect(wide(0.25)).toEqual([['ab'], ['cd'], ['x y']]);
  });

  it("the space a gap is measured against is as the gap is: after the run's Tz and Tc, at the size of its em (M4 Task 2)", () => {
    // the gap is measured from where the earlier run's advances end, and an advance holds Tz and Tc (Tc x Tz as spcPt):
    // one space of a run at Tz 50 % is half as wide, and its Tc is in it
    const scaled = (gap: number, run: Partial<TextRun>) => assembled(words(['ab', 'cd'], 20, 40, gap, { size: 20, run }));
    expect(scaled(0.125, { hScale: 0.5 })).toEqual([['ab cd']]);
    expect(scaled(0.25, { hScale: 0.5 })).toEqual([['ab'], ['cd']]);
    expect(scaled(0.25 + 3 / 20, { spcPt: 3 })).toEqual([['ab cd']]);
    // the width of a space glyph is taken back to the font's the same way, before Tz and Tc and over the em: here Tz
    // 50 %, Tc 2 (spcPt 1) and a synthetic italic, whose Scene size is the em x √(1 + 1/9)
    const em = 20;
    const italic = word('x y', 20, 150, { fontKey: 'f9', size: em, run: { sizePt: em * Math.sqrt(1 + 1 / 9), skew: 1 / 3, hScale: 0.5, spcPt: 1 } });
    italic.runs[0]!.glyphs[1]!.adv = 0.25 * em * 0.5 + 1;
    const widths = spaceWidths([italic], {});
    expect(widths.get('f9')).toBeCloseTo(0.25, 9);
    expect(spaceAdvance(italic, widths)).toBeCloseTo(0.25 * em * 0.5 + 1, 9);
    expect(spaceAdvance(italic, new Map())).toBeCloseTo(SPACE_RULE.fallback * em * 0.5 + 1, 9);
  });

  it('M4-R1: where a space glyph already sits, the runs join with no synthetic space; a further gap after it splits', () => {
    const at = (a: string, gap: number) => 20 + wordWidth(a) + gap * 12;
    const out = assembleText(slideOf([word('ab ', 20, 40), word('cd', at('ab ', 0), 40)]));
    expect(boxes(out)).toEqual([['ab cd']]);
    expect((out.elements[0] as AssembledText).lines[0]!.before).toEqual(['none', 'none']);
    expect(joined([word('ab', 20, 40), word(' cd', at('ab', 0.05), 40)])).toEqual([['ab cd']]);
    expect(assembled([word('ab ', 20, 40), word('cd', at('ab ', 0.3), 40)])).toEqual([['ab '], ['cd']]);
  });

  it('a run that starts up to 0.3 x size before the last advance ends joins with no space; further back (overlap) it does not', () => {
    expect(joined(words(['ab', 'cd'], 20, 40, -0.3))).toEqual([['abcd']]);
    expect(assembled(words(['ab', 'cd'], 20, 40, -0.31))).toEqual([['ab'], ['cd']]);
    // a run behind the previous one's origin is not after it
    expect(assembled([word('ab', 100, 40), word('cd', 40, 40)])).toEqual([['ab'], ['cd']]);
  });

  it('the size of the rules is the earlier run\'s for the gap, the smaller one\'s for the baseline', () => {
    // 0.3 x 24 after a 24 pt run is one space of it; after a 12 pt run 7.2 pt would be wider than a space
    expect(assembled([word('AB', 20, 40, { size: 24 }), word('cd', 20 + wordWidth('AB', 24) + 7.2, 40, { size: 12 })])).toEqual([['AB cd']]);
    // baselines 2 pt apart: within 0.15 x 24 but not within 0.15 x 12
    expect(assembled([word('AB', 20, 40, { size: 24 }), word('cd', 20 + wordWidth('AB', 24), 42, { size: 12 })])).toEqual([['AB'], ['cd']]);
  });

  it('M4b: runs of different sizes join only on one baseline (ONE_BASELINE_PT): PowerPoint lays a line out on one (atlas/text/41)', () => {
    expect(ONE_BASELINE_PT).toBe(0.05);
    const at = 20 + wordWidth('small', 12) + 3;
    expect(assembled([word('small', 20, 40, { size: 12 }), word('LARGE', at, 40.05, { size: 24 })])).toEqual([['small LARGE']]);
    // fontAlgn=b: a 12 pt run 1.44 pt below the 24 pt run's baseline, within 0.15 x 12 but not one baseline
    expect(assembled([word('small', 20, 40, { size: 12 }), word('LARGE', at, 38.56, { size: 24 })])).toEqual([['small'], ['LARGE']]);
    expect(assembled([word('small', 20, 40, { size: 12 }), word('LARGE', at, 40.06, { size: 24 })])).toEqual([['small'], ['LARGE']]);
    // one size: the baseline tolerance of M4-R1 as it was
    expect(assembled([word('small', 20, 40, { size: 12 }), word('more', at, 41.44, { size: 12 })])).toEqual([['small more']]);
  });

  it('the size of the rules is the size lowering writes: a synthetic italic at the size of its em (M4 Task 3)', () => {
    // 25.298 with PowerPoint's 1/3 shear is written at 24: its baseline tolerance is 0.15 x 24 = 3.6, not 3.79
    const italic = { sizePt: 25.298, skew: 1 / 3 };
    const ab = word('AB', 20, 40, { size: 25.298, run: italic });
    const end = 20 + wordWidth('AB', 25.298);
    expect(assembled([ab, word('cd', end, 43.5, { size: 25.298, run: italic })])).toEqual([['ABcd']]);
    expect(assembled([ab, word('cd', end, 43.7, { size: 25.298, run: italic })])).toEqual([['AB'], ['cd']]);
  });

  it('Review Focus 1: a rotated label next to horizontal text is not joined; a direction within 0.1° is', () => {
    const at = 20 + wordWidth('ab') + 3;
    expect(assembled([word('ab', 20, 40), word('cd', at, 40, { angleDeg: 90 })])).toEqual([['ab'], ['cd']]);
    expect(assembled([word('ab', 20, 40), word('cd', at, 40, { angleDeg: 0.11 })])).toEqual([['ab'], ['cd']]);
    expect(assembled([word('ab', 20, 40), word('cd', at, 40, { angleDeg: 0.09 })])).toEqual([['ab cd']]);
    // 359.95° and 0.04° are 0.09° apart
    expect(assembled([word('ab', 20, 40, { angleDeg: 359.95 }), word('cd', at, 40, { angleDeg: 0.04 })])).toEqual([['ab cd']]);
  });

  it('Review Focus 1: a superscript set on a raised baseline is not joined; a rise (Ts) on the same baseline is, and keeps its rise', () => {
    const at = 20 + wordWidth('E=mc');
    expect(assembled([word('E=mc', 20, 40), word('2', at, 40 - 4, { size: 7 })])).toEqual([['E=mc'], ['2']]);
    const out = assembleText(slideOf([word('E=mc', 20, 40), word('2', at, 40, { size: 7, run: { rise: 4 } })]));
    expect(boxes(out)).toEqual([['E=mc2']]);
    expect((out.elements[0] as AssembledText).lines[0]!.els[1]!.runs[0]!.rise).toBe(4);
    // baselines 0.15 x size apart (the smaller size) still join; further do not
    expect(assembled([word('ab', 20, 40), word('cd', 20 + wordWidth('ab'), 41.8)])).toEqual([['abcd']]);
    expect(assembled([word('ab', 20, 40), word('cd', 20 + wordWidth('ab'), 41.81)])).toEqual([['ab'], ['cd']]);
  });

  it('runs of another writing mode are not joined; vertical runs down one column are', () => {
    const v = (text: string, y: number, wmode: 0 | 1) => word(text, 100, y, { angleDeg: 0, el: { wmode } });
    expect(assembled([v('ab', 40, 1), word('cd', 100 + wordWidth('ab') + 3, 40)])).toEqual([['ab'], ['cd']]);
    // vertical writing: the glyphs run down the column, a size each, from the origin at the top of the first
    const column = (text: string, y: number) => {
      const el = word(text, 100, y, { el: { wmode: 1 } });
      el.runs[0]!.glyphs = [...text].map((u, i) => ({ u, x: 100, y: y + i * 12, adv: 12 }));
      return el;
    };
    expect(assembled([column('세로', 40), column('쓰기', 40 + 24 + 3)])).toEqual([['세로 쓰기']]);
  });

  it('something painted between two runs in z-order that covers the gap or the later run keeps them apart', () => {
    const [a, b] = words(['ab', 'cd'], 20, 40, 0.25);
    // a highlight painted over the second word (after the first): the second word would go under it
    expect(assembled([a!, rect(40, 28, 20, 16), b!])).toEqual([['ab'], ['cd']]);
    // one over the gap only
    expect(assembled([a!, rect(32.5, 30, 2, 10), b!])).toEqual([['ab'], ['cd']]);
    // an underline of the first word, painted after it: it covers neither the gap nor the second word
    expect(assembled([a!, rect(20, 41, 12, 1), b!])).toEqual([['ab cd']]);
    // a hotspot paints nothing
    expect(assembled([a!, hotspot(0, [0, 0, 300, 200], { url: 'https://example.com/', dest: null }), b!])).toEqual([['ab cd']]);
  });

  it('final review Minor 1: a mitred or square-capped stroke is painted as far as its spike reaches, which covers the later run', () => {
    const [a, b] = words(['ab', 'cd'], 20, 40, 0.25);
    // a hairline 2 pt wide above the second word: half its width (1 pt) falls short of the word, a miter of 10 (5 x w) does not
    const bar = (over: Parameters<typeof lineStyle>[0]) => shape({ geom: rectPath(28, 10, 0, 16), line: lineStyle({ w: 2, ...over }), fill: null });
    expect(assembled([a!, bar({ join: 'round', cap: 'butt' }), b!])).toEqual([['ab cd']]);
    expect(assembled([a!, bar({ join: 'miter', miter: 10, cap: 'butt' }), b!])).toEqual([['ab'], ['cd']]);
    expect(assembled([a!, bar({ join: 'round', cap: 'square' }), b!])).toEqual([['ab cd']]); // sqrt 2 x 1 pt: 27.4 to 29.4, still short
    expect(assembled([a!, bar({ join: 'miter', miter: 2, cap: 'square' }), b!])).toEqual([['ab cd']]); // 2 pt: 8 to 28 across, short
  });

  it('final review Minor 1: a paint outside its own clip box covers nothing', () => {
    const [a, b] = words(['ab', 'cd'], 20, 40, 0.25);
    const over = { ...rect(32.5, 30, 2, 10), clipBox: [0, 0, 10, 10] as [number, number, number, number] };
    expect(assembled([a!, over, b!])).toEqual([['ab cd']]);
  });

  it('final review Minor 2: in vertical writing the gap spans 0.5 x size either side of the column, so a paint on its right half covers it', () => {
    const column = (text: string, y: number) => {
      const el = word(text, 100, y, { el: { wmode: 1 } });
      el.runs[0]!.glyphs = [...text].map((u, i) => ({ u, x: 100, y: y + i * 12, adv: 12 }));
      el.bboxPt = [94, y, 106, y + 24];
      return el;
    };
    const [a, b] = [column('세로', 40), column('쓰기', 67)];
    expect(assembled([a, rect(104, 64.5, 1.5, 2), b])).toEqual([['세로'], ['쓰기']]);
    expect(assembled([a, rect(107, 64.5, 1.5, 2), b])).toEqual([['세로 쓰기']]);
  });

  it('a line takes no further run once more than MAX_PAINTS_BETWEEN paints lie between its runs, though none covers it', () => {
    const [a, b] = words(['ab', 'cd'], 20, 40, 0.25);
    const far = (n: number) => Array.from({ length: n }, (_, i) => rect(200 + (i % 10) * 5, 100 + Math.floor(i / 10) * 5, 2, 2));
    expect(assembled([a!, ...far(MAX_PAINTS_BETWEEN), b!])).toEqual([['ab cd']]);
    expect(assembled([a!, ...far(MAX_PAINTS_BETWEEN + 1), b!])).toEqual([['ab'], ['cd']]);
  });

  it('only consecutive text runs join: another text run between them in z-order keeps them apart', () => {
    const [a, b] = words(['ab', 'cd'], 20, 40, 0.25);
    expect(assembled([a!, word('elsewhere', 20, 150), b!])).toEqual([['ab'], ['elsewhere'], ['cd']]);
  });

  it("runs whose fonts put the baseline at other shares of the size are not joined (a bullet in another family); one family's Type0 and WinAnsi halves are", () => {
    const font = (key: string, latinName: string): FontInfo => ({
      key,
      baseFont: `ABCDEF+${latinName}`,
      latinName,
      eaName: null,
      bold: false,
      italic: false,
      embedded: true,
      fsType: 0,
      isVariable: false,
      type3: false,
      metrics: null,
    });
    // two calibrated families of different k, and the Type0 and WinAnsi fonts of one of them
    const fonts = { f1: font('f1', 'Gothic A1'), f2: font('f2', 'Pretendard'), f3: font('f3', 'Pretendard') };
    expect(Math.abs(baselineK(fonts.f1).k - baselineK(fonts.f2).k)).toBeGreaterThan(K_TOL);
    const ws = (keys: string[]) => words(['•', 'one', 'two'], 20, 40, 0.25).map((el, i) => ({ ...el, runs: [{ ...el.runs[0]!, fontKey: keys[i]! }] }));
    expect(boxes(assembleText(slideOf(ws(['f1', 'f2', 'f3'])), fonts))).toEqual([['•'], ['one two']]);
    expect(boxes(assembleText(slideOf(ws(['f2', 'f3', 'f2'])), fonts))).toEqual([['• one two']]);
  });

  it('runs in another clip, group, soft mask or blend mode are not joined', () => {
    const pair = (over: Partial<Element>) => {
      const [a, b] = words(['ab', 'cd'], 20, 40, 0.25);
      return assembled([a!, { ...b!, ...over } as Element]);
    };
    expect(pair({ clip: ['c1'] })).toEqual([['ab'], ['cd']]);
    expect(pair({ groups: [group(0.5)] })).toEqual([['ab'], ['cd']]);
    expect(pair({ mask: 'm1' })).toEqual([['ab'], ['cd']]);
    expect(pair({ blend: 'multiply' })).toEqual([['ab'], ['cd']]);
    expect(pair({})).toEqual([['ab cd']]);
  });

  it('leaves its input as it was', () => {
    const input = slideOf(words(['Q3', 'Business', 'Review'], 20, 40, 0.25));
    const before = snapshot(input);
    assembleText(input);
    expect(input).toEqual(before);
  });
});
