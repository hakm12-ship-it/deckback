import { describe, expect, it } from 'vitest';
import { blend, BLEND_MODES, luminosity } from '../../src/raster/blend';

/**
 * The 16 PDF blend modes (ISO 32000-2 11.3.5), on colours 0..1: separable modes channel by channel, the four
 * non-separable ones through Lum, Sat, SetLum and SetSat. The values are the specification's formulas worked by hand.
 */
const at = (mode: (typeof BLEND_MODES)[number], cb: number[], cs: number[]): number[] => {
  const out = [0, 0, 0];
  blend(mode, cb, cs, out);
  return out;
};

describe('blend', () => {
  it('has the 16 modes of the PDF', () => {
    expect(BLEND_MODES).toEqual([
      'normal',
      'multiply',
      'screen',
      'overlay',
      'darken',
      'lighten',
      'colordodge',
      'colorburn',
      'hardlight',
      'softlight',
      'difference',
      'exclusion',
      'hue',
      'saturation',
      'color',
      'luminosity',
    ]);
  });

  it('the separable modes', () => {
    const cb = [0.2, 0.5, 0.8];
    const cs = [0.6, 0.5, 0.1];
    const close = (mode: (typeof BLEND_MODES)[number], want: number[]) => at(mode, cb, cs).forEach((v, i) => expect(v, `${mode} ${i}`).toBeCloseTo(want[i]!, 10));
    close('normal', cs);
    close('multiply', [0.12, 0.25, 0.08]);
    close('screen', [0.68, 0.75, 0.82]);
    // overlay = hardlight with the colours swapped: Cb <= 0.5 multiplies by 2 Cb.
    close('overlay', [2 * 0.2 * 0.6, 2 * 0.5 * 0.5, 0.1 + (2 * 0.8 - 1) - 0.1 * (2 * 0.8 - 1)]);
    close('darken', [0.2, 0.5, 0.1]);
    close('lighten', [0.6, 0.5, 0.8]);
    close('colordodge', [0.2 / 0.4, 1, Math.min(1, 0.8 / 0.9)]);
    close('colorburn', [1 - Math.min(1, 0.8 / 0.6), 1 - Math.min(1, 0.5 / 0.5), 1 - Math.min(1, 0.2 / 0.1)]);
    close('hardlight', [0.2 + (2 * 0.6 - 1) - 0.2 * (2 * 0.6 - 1), 0.5 * 1, 0.8 * 0.2]);
    close('softlight', [0.2 + (2 * 0.6 - 1) * (((16 * 0.2 - 12) * 0.2 + 4) * 0.2 - 0.2), 0.5, 0.8 - (1 - 0.2) * 0.8 * 0.2]);
    close('difference', [0.4, 0, 0.7]);
    close('exclusion', [0.2 + 0.6 - 2 * 0.12, 0.5, 0.8 + 0.1 - 2 * 0.08]);
  });

  it('the dodge and burn ends: 0 and 1 of the backdrop stay', () => {
    expect(at('colordodge', [0, 0.5, 1], [1, 1, 0.5])).toEqual([0, 1, 1]);
    expect(at('colorburn', [1, 0.5, 0], [0, 0, 0.5])).toEqual([1, 0, 0]);
  });

  it('the non-separable modes keep the backdrop luminosity (hue, saturation, color) or take the source one', () => {
    const lum = (c: number[]) => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;
    const cb = [0.8, 0.4, 0.2];
    const cs = [0.1, 0.3, 0.9];
    for (const mode of ['hue', 'saturation', 'color'] as const) expect(lum(at(mode, cb, cs)), mode).toBeCloseTo(lum(cb), 10);
    expect(lum(at('luminosity', cb, cs))).toBeCloseTo(lum(cs), 10);
    // A gray source has no hue or saturation: color and hue give the backdrop's gray.
    const g = lum(cb);
    at('color', cb, [0.5, 0.5, 0.5]).forEach((v) => expect(v).toBeCloseTo(g, 10));
    // SetLum clips into the gamut: white luminosity on a saturated colour is white.
    at('luminosity', [1, 0, 0], [1, 1, 1]).forEach((v) => expect(v).toBeCloseTo(1, 10));
  });

  it("luminosity of 0-255 colours is MuPDF's integer weights", () => {
    expect(luminosity(255, 255, 255)).toBe(255);
    expect(luminosity(0, 0, 0)).toBe(0);
    expect(luminosity(255, 0, 0)).toBe(77);
    expect(luminosity(0, 255, 0)).toBe(150);
    expect(luminosity(0, 0, 255)).toBe(28);
  });
});
