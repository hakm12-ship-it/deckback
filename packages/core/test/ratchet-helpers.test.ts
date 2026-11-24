import { describe, expect, it } from 'vitest';
import { goldenDecision, worseThan, type RatchetGolden } from './helpers/ratchet';

/**
 * The PPTX ratchet's golden decision (packages/core/test/corpus/pptx-ratchet.corpus.test.ts, M3 Task 11): which
 * statuses of S2, S3, S4 and S6 got worse than the committed golden, and whether DECKBACK_UPDATE_GOLDEN=1 may write the
 * new golden. A status may stay or become `pass`; any other change is worse, `fail -> n/a` too (n/a is never a pass).
 */

const slide = (S2: string, S3 = 'pass', S4 = 'pass', S6 = 'pass') => ({ S2, S3, S4, S6 }) as RatchetGolden['slides'][string];
const golden = (...slides: RatchetGolden['slides'][string][]): RatchetGolden => ({
  slides: Object.fromEntries(slides.map((s, i) => [String(i + 1), s])),
});

describe('worseThan', () => {
  it('a status that stays, or becomes pass, is not worse', () => {
    expect(worseThan(golden(slide('pass'), slide('fail'), slide('n/a')), golden(slide('pass'), slide('fail'), slide('n/a')))).toEqual([]);
    expect(worseThan(golden(slide('fail'), slide('n/a')), golden(slide('pass'), slide('pass')))).toEqual([]);
  });

  it('every other change is worse: from pass, fail -> n/a and n/a -> fail', () => {
    expect(worseThan(golden(slide('pass')), golden(slide('fail')))).toEqual(['1 S2 pass -> fail']);
    expect(worseThan(golden(slide('pass')), golden(slide('n/a')))).toEqual(['1 S2 pass -> n/a']);
    expect(worseThan(golden(slide('fail')), golden(slide('n/a')))).toEqual(['1 S2 fail -> n/a']);
    expect(worseThan(golden(slide('n/a')), golden(slide('fail')))).toEqual(['1 S2 n/a -> fail']);
  });

  it('looks at S2, S3, S4 and S6 of every page, and a page that is gone is worse', () => {
    const now = golden(slide('pass', 'fail', 'n/a', 'fail'));
    expect(worseThan(golden(slide('pass'), slide('pass')), now)).toEqual([
      '1 S3 pass -> fail',
      '1 S4 pass -> n/a',
      '1 S6 pass -> fail',
      '2 S2 pass -> none',
      '2 S3 pass -> none',
      '2 S4 pass -> none',
      '2 S6 pass -> none',
    ]);
  });
});

describe('goldenDecision', () => {
  const before = golden(slide('fail'));
  it('writes only when asked', () => {
    expect(goldenDecision(before, golden(slide('pass')), false)).toEqual({ worse: [], write: false });
    expect(goldenDecision(before, golden(slide('pass')), true)).toEqual({ worse: [], write: true });
    expect(goldenDecision(null, golden(slide('fail')), true)).toEqual({ worse: [], write: true }); // the first golden
    expect(goldenDecision(null, golden(slide('fail')), false)).toEqual({ worse: [], write: false });
  });

  it('never writes a golden worse than the committed one, even when asked', () => {
    expect(goldenDecision(before, golden(slide('n/a')), true)).toEqual({ worse: ['1 S2 fail -> n/a'], write: false });
    expect(goldenDecision(golden(slide('pass')), golden(slide('fail')), true)).toEqual({ worse: ['1 S2 pass -> fail'], write: false });
  });
});
