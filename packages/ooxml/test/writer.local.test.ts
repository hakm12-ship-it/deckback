import { describe, expect, it } from 'vitest';
import { PptxWriter } from '../src';
import { validatePptx } from './helpers/validate';

// The validator runs .NET (it builds itself once into out/ooxml-validator/ on a cold machine): a long timeout.
const VALIDATOR_TIMEOUT_MS = 300_000;

describe('the package against the Open XML validator', () => {
  it(
    'an empty 3-slide deck has 0 validator errors',
    async () => {
      const writer = new PptxWriter([12192000, 6858000], 3);
      for (let i = 0; i < 3; i++) writer.addSlide({ nodes: [], background: null });
      expect(await validatePptx(writer.finish(), 'empty-3-slides')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );

  it(
    'slide backgrounds (ruling M3-R52), solid, translucent and a gradient, have 0 validator errors',
    async () => {
      const writer = new PptxWriter([12192000, 6858000], 3);
      writer.addSlide({ nodes: [], background: { kind: 'solid', rgb: 'F2F2F2', alpha: 100000 } });
      writer.addSlide({ nodes: [], background: { kind: 'solid', rgb: '102030', alpha: 50000 } });
      const stops = [{ pos: 0, rgb: 'FF0000', alpha: 100000 }, { pos: 100000, rgb: '0000FF', alpha: 100000 }];
      writer.addSlide({ nodes: [], background: { kind: 'grad', stops, shade: { kind: 'lin', ang: 0, scaled: false }, rotWithShape: true } });
      expect(await validatePptx(writer.finish(), 'slide-backgrounds')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );

  it(
    'embedded fonts (M4 Task 5): every style, a font under two typefaces and an escaped name have 0 validator errors',
    async () => {
      const writer = new PptxWriter([12192000, 6858000], 2);
      const font = (seed: number) => Uint8Array.from({ length: 64 }, (_, i) => (i + seed) & 0xff);
      writer.addSlide({ nodes: [], background: null });
      writer.addFont(font(1), ['Probe Sans', '프로브 산스'], 'regular');
      writer.addFont(font(2), ['Probe Sans'], 'bold');
      writer.addFont(font(3), ['Probe Sans'], 'italic');
      writer.addFont(font(4), ['Probe Sans'], 'boldItalic');
      writer.addFont(font(5), ['Other "&" Co'], 'regular');
      writer.addSlide({ nodes: [], background: null });
      expect(await validatePptx(writer.finish(), 'embedded-fonts')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );
});
