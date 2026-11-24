import { describe, expect, it } from 'vitest';
import { assembleText, type AssembledText } from '../../../src/passes/text/assemble';
import { structKey } from '../../../src/passes/text/boxes';
import type { Element, SceneSlide } from '../../../src/scene/types';
import { rectPath, shape, slideOf } from '../../helpers/passes';
import { P_SPAN, word, words } from './words';

/**
 * Text assembly, boxes (M4 Task 1): on a tagged page, lines that share a `Textbox` or `P` structure element are one text
 * box, a paragraph each; untagged, each line is its own box. The Scene names an element's structure by its role path
 * (`provenance.struct`), so lines share one when their paths agree down to it, they follow each other in z-order, and
 * the later stacks under the earlier: the same direction, down the page by a line's pitch, overlapping it along the line.
 */

const SEP = { none: '', space: ' ' } as const;

function boxes(slide: SceneSlide): string[][] {
  return slide.elements
    .filter((el): el is AssembledText => el.kind === 'textline')
    .map((el) => el.lines.map((line) => line.els.map((e, j) => SEP[line.before[j]!] + e.runs.map((r) => r.text).join('')).join('')));
}

const assembled = (elements: Element[]): string[][] => boxes(assembleText(slideOf(elements)));

/** Two lines of a paragraph, left-aligned at x = 20, pitch 14.4 (1.2 x 12 pt), each of two words; tagged with `struct`. */
function paragraph(struct: string[] | null, x2 = 20, pitch = 14.4): Element[] {
  return [...words(['two', 'lines'], 20, 40, 0.25, { struct }), ...words(['of', 'text'], x2, 40 + pitch, 0.25, { struct })];
}

describe('structKey', () => {
  it("a run's structure element: the outermost Textbox, else the innermost P, by its role path; none without either", () => {
    expect(structKey(['Sect', 'Sect', 'P', 'Span'])).toBe('Sect/Sect/P');
    expect(structKey(['Sect', 'Sect', 'P'])).toBe('Sect/Sect/P');
    expect(structKey(['Sect', 'Table', 'TBody', 'TR', 'TD', 'Sect', 'P', 'Span'])).toBe('Sect/Table/TBody/TR/TD/Sect/P');
    expect(structKey(['Document', 'Textbox', 'P', 'Span'])).toBe('Document/Textbox');
    expect(structKey(['Document', 'Textbox', 'Div', 'Textbox', 'P'])).toBe('Document/Textbox');
    expect(structKey(['P', 'Note', 'P', 'Span'])).toBe('P/Note/P');
    expect(structKey(['Sect', 'Sect', 'L', 'LI', 'LBody', 'Span'])).toBeNull();
    expect(structKey([])).toBeNull();
    expect(structKey(null)).toBeNull();
  });
});

describe('lines into boxes', () => {
  it('tagged: two lines of one P are one box, a line each, in order', () => {
    expect(assembled(paragraph(P_SPAN))).toEqual([['two lines', 'of text']]);
  });

  it('A/B: the same lines untagged are a box each', () => {
    expect(assembled(paragraph(null))).toEqual([['two lines'], ['of text']]);
  });

  it('lines of a Textbox are one box though their paragraphs differ', () => {
    const lines = [...words(['first'], 20, 40, 0.25, { struct: ['Textbox', 'P', 'Span'] }), ...words(['second'], 20, 54.4, 0.25, { struct: ['Textbox', 'P'] })];
    expect(assembled(lines)).toEqual([['first', 'second']]);
  });

  it('lines under other structure elements are not one box: a P and a list item, or Ps in other cells', () => {
    const li = ['Sect', 'Sect', 'L', 'LI', 'LBody', 'Span'];
    expect(assembled([...words(['two', 'lines'], 20, 40, 0.25, { struct: P_SPAN }), ...words(['of', 'text'], 20, 54.4, 0.25, { struct: li })])).toEqual([['two lines'], ['of text']]);
    // a list item's lines have no P: a box each
    expect(assembled(paragraph(li))).toEqual([['two lines'], ['of text']]);
    const td = ['Table', 'TR', 'TD', 'P', 'Span'];
    const th = ['Table', 'TR', 'TH', 'P', 'Span'];
    expect(assembled([...words(['two', 'lines'], 20, 40, 0.25, { struct: th }), ...words(['of', 'text'], 20, 54.4, 0.25, { struct: td })])).toEqual([['two lines'], ['of text']]);
  });

  it('a line whose runs come from different structure elements has none: a box of its own', () => {
    const mixed = [word('Lbl', 20, 40, { struct: ['L', 'LI', 'Lbl'] }), word('P', 20 + 18 + 3, 40, { struct: P_SPAN })];
    expect(assembled([...mixed, ...words(['of', 'text'], 20, 54.4, 0.25, { struct: P_SPAN })])).toEqual([['Lbl P'], ['of text']]);
  });

  it('lines that do not stack are not one box: side by side, too far apart, above the last, or overlapping it', () => {
    // the next line starts past the end of the last one: another column
    expect(assembled(paragraph(P_SPAN, 200))).toEqual([['two lines'], ['of text']]);
    // further down than three sizes
    expect(assembled(paragraph(P_SPAN, 20, 36.01))).toEqual([['two lines'], ['of text']]);
    expect(assembled(paragraph(P_SPAN, 20, 36))).toEqual([['two lines', 'of text']]);
    // above the last line, or less than half a size below it
    expect(assembled(paragraph(P_SPAN, 20, -14.4))).toEqual([['two lines'], ['of text']]);
    expect(assembled(paragraph(P_SPAN, 20, 5.99))).toEqual([['two lines'], ['of text']]);
    // centred lines: they overlap along the line
    expect(assembled(paragraph(P_SPAN, 30))).toEqual([['two lines', 'of text']]);
  });

  it('lines of sizes more than 1.25 times apart are not one box: a 9 pt label over 12 pt text', () => {
    const label = word('label', 20, 40, { size: 9, struct: P_SPAN });
    expect(assembled([label, ...words(['of', 'text'], 20, 60, 0.25, { struct: P_SPAN })])).toEqual([['label'], ['of text']]);
    const larger = word('label', 20, 40, { size: 10, struct: P_SPAN });
    expect(assembled([larger, ...words(['of', 'text'], 20, 60, 0.25, { struct: P_SPAN })])).toEqual([['label', 'of text']]);
  });

  it('lines in another direction, or turned, are not one box; turned lines stack along their own normal', () => {
    const turned = (deg: number, dy: number) => {
      const t = (deg * Math.PI) / 180;
      const [c, s] = [Math.cos(t), Math.sin(t)];
      return [word('first', 100, 100, { struct: P_SPAN, angleDeg: deg }), word('next', 100 - dy * s, 100 + dy * c, { struct: P_SPAN, angleDeg: deg })];
    };
    expect(assembled(turned(90, 14.4))).toEqual([['first', 'next']]);
    expect(assembled(turned(30, 14.4))).toEqual([['first', 'next']]);
    expect(assembled([word('first', 20, 40, { struct: P_SPAN }), word('next', 20, 54.4, { struct: P_SPAN, angleDeg: 5 })])).toEqual([['first'], ['next']]);
  });

  it('vertical writing is a box per line', () => {
    const v = paragraph(P_SPAN).map((el) => ({ ...el, wmode: 1 as const }));
    expect(assembled(v).length).toBeGreaterThan(1);
  });

  it('a page of 20,000 runs: 200 tagged lines of 100 words each are one box, in work linear in the runs', () => {
    const lines = Array.from({ length: 200 }, (_, i) => words(Array.from({ length: 100 }, (__, j) => `w${j}`), 20, 40 + 14.4 * i, 0.25, { struct: P_SPAN }));
    const start = performance.now();
    const out = assembled(lines.flat());
    const ms = performance.now() - start;
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveLength(200);
    expect(out[0]![0]!.split(' ')).toHaveLength(100);
    // a quadratic pass would be 4e8 steps here, minutes: the bound is a generous one for a slow runner, not a measurement
    expect(ms).toBeLessThan(30_000);
  });

  it('something painted between two lines in z-order that covers the later one keeps them apart', () => {
    const [a, b, c, d] = paragraph(P_SPAN);
    expect(assembled([a!, b!, shape({ geom: rectPath(18, 45, 40, 12) }), c!, d!])).toEqual([['two lines'], ['of text']]);
    expect(assembled([a!, b!, shape({ geom: rectPath(200, 45, 40, 12) }), c!, d!])).toEqual([['two lines', 'of text']]);
  });
});
