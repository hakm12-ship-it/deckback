import { describe, expect, it } from 'vitest';
import { UnsupportedOpError } from '../src/extract/errors';
import type { TextParams } from '../src/extract/gstate';
import { layoutRun, newTextObject } from '../src/extract/text';

const params: TextParams = {
  charSpacing: 1,
  wordSpacing: 5,
  hScale: 1,
  leading: 0,
  fontId: 'f1',
  fontSize: 10,
  fontDirection: 1,
  renderMode: 0,
  rise: 2,
};
const FONT_MATRIX = [0.001, 0, 0, 0.001, 0, 0];
const glyph = (unicode: string, width: number, isSpace = false) => ({ unicode, width, isSpace });

describe('layoutRun', () => {
  it('advances by width x size x fontMatrix[0] + Tc (+ Tw for a space), and moves by TJ numbers', () => {
    const items = [glyph('A', 600), glyph(' ', 250, true), -500, glyph('B', 600)];
    const run = layoutRun(newTextObject(), items, params, FONT_MATRIX);
    // A: 6 + 1 = 7; space: 2.5 + 1 + 5 = 8.5; TJ -500: +5; B starts at 20.5.
    expect(run.glyphs.map((g) => [g.unicode, g.x, g.y])).toEqual([
      ['A', 0, 2],
      [' ', 7, 2],
      ['B', 20.5, 2],
    ]);
    expect(run.advance).toBeCloseTo(27.5, 9);
    expect(run.advanceY).toBe(0);
  });

  it("keeps each glyph's code in the shown string, null where pdf.js gave no whole number (M8 round 1a)", () => {
    const items = [{ ...glyph('➢', 600), originalCharCode: 0xbe }, glyph('B', 600), { ...glyph('C', 600), originalCharCode: 1.5 }];
    expect(layoutRun(newTextObject(), items, params, FONT_MATRIX).glyphs.map((g) => g.code)).toEqual([0xbe, null, null]);
  });

  it('throws UnsupportedOpError for a run item that is neither a glyph nor a TJ number', () => {
    for (const item of [null, 'A', { width: 600 }, { unicode: 65, width: 600, isSpace: false }]) {
      expect(() => layoutRun(newTextObject(), [glyph('A', 600), item], params, FONT_MATRIX)).toThrow(UnsupportedOpError);
    }
  });

  it('throws UnsupportedOpError for a glyph without a finite width, or a non-finite TJ number', () => {
    for (const item of [glyph('A', NaN), glyph('A', Infinity), { unicode: 'A', isSpace: false }, NaN]) {
      expect(() => layoutRun(newTextObject(), [item, glyph('B', 600)], params, FONT_MATRIX)).toThrow(UnsupportedOpError);
    }
  });

  describe('vertical writing (pdf.js showText, 0002 §6 glyphs)', () => {
    const vertical = (unicode: string, width: number, vmetric?: number[], isSpace = false) => ({ unicode, width, vmetric, isSpace });
    const plain: TextParams = { ...params, charSpacing: 0, rise: 0 };
    const VM = [-1000, 300, 880];
    const at = { defaultVMetrics: null };

    it('places each glyph at the metrics from the current point and moves down by -w1y', () => {
      const run = layoutRun(newTextObject(), [vertical('A', 600, VM), vertical('B', 600, [-500, 200, 400])], plain, FONT_MATRIX, at);
      expect(run.glyphs.map((g) => [g.unicode, g.x, g.y])).toEqual([
        ['A', -3, -8.8],
        ['B', -2, -14],
      ]);
      expect(run.advance).toBe(0);
      expect(run.advanceY).toBeCloseTo(-15, 9);
    });

    it('moves up for Tc and down for a positive TJ number, and adds the rise', () => {
      const withRise: TextParams = { ...plain, charSpacing: 1, rise: 2 };
      const run = layoutRun(newTextObject(), [vertical('A', 600, VM), 500, vertical('B', 600, VM)], withRise, FONT_MATRIX, at);
      // A: moves 10 - 1 = 9; TJ 500: +5; B sits 14 lower.
      expect(run.glyphs[0]!.y).toBeCloseTo(-6.8, 9);
      expect(run.glyphs[1]!.y).toBeCloseTo(-20.8, 9);
      expect(run.advanceY).toBeCloseTo(-23, 9);
    });

    it('Tz scales only the sideways offset', () => {
      const run = layoutRun(newTextObject(), [vertical('A', 600, VM)], { ...plain, hScale: 0.5 }, FONT_MATRIX, at);
      expect(run.glyphs[0]!.x).toBeCloseTo(-1.5, 9);
      expect(run.glyphs[0]!.y).toBeCloseTo(-8.8, 9);
      expect(run.advanceY).toBeCloseTo(-10, 9);
    });

    it('a negative font size runs up the page, also past the end of the run', () => {
      const run = layoutRun(newTextObject(), [vertical('A', 600, VM), vertical('B', 600, VM)], { ...plain, fontDirection: -1 }, FONT_MATRIX, at);
      expect(run.glyphs.map((g) => [g.x, g.y])).toEqual([
        [3, 8.8],
        [3, 18.8],
      ]);
      expect(run.advanceY).toBeCloseTo(20, 9);
    });

    it('starts from the current point of the text object', () => {
      const t = newTextObject();
      t.x = 100;
      t.y = 200;
      const run = layoutRun(t, [vertical('A', 600, VM)], plain, FONT_MATRIX, at);
      expect(run.glyphs[0]).toMatchObject({ x: 97, y: 191.2 });
    });

    it('a glyph without its own metrics takes the default ones, at half its width', () => {
      const run = layoutRun(newTextObject(), [vertical('A', 500)], plain, FONT_MATRIX, { defaultVMetrics: [-800, 300, 700] });
      expect(run.glyphs[0]).toMatchObject({ x: -2.5, y: -7 });
      expect(run.advanceY).toBeCloseTo(-8, 9);
    });

    it('throws UnsupportedOpError for a glyph with no metrics at all, or with broken ones', () => {
      for (const item of [vertical('A', 600), vertical('A', 600, [-1000, 300]), vertical('A', 600, [-1000, Number.NaN, 880])]) {
        expect(() => layoutRun(newTextObject(), [item], plain, FONT_MATRIX, at)).toThrow(UnsupportedOpError);
      }
    });

    it('still throws for an item that is neither a glyph nor a TJ number', () => {
      expect(() => layoutRun(newTextObject(), [null], plain, FONT_MATRIX, at)).toThrow(UnsupportedOpError);
    });
  });
});
