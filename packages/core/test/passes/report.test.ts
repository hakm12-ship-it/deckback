import { describe, expect, it } from 'vitest';
import { approximate, approximationCounts, listFallback, newReport, REPORT_LIST_MAX } from '../../src/passes/report';
import { slideOf } from '../helpers/passes';

/** A slide's report lists at most `REPORT_LIST_MAX` approximations and fallbacks, and counts the rest (ruling M3-R59). */
describe('the slide report', () => {
  it('records each (id, kind) once, lists the first REPORT_LIST_MAX and counts the rest, by kind too', () => {
    const report = newReport(slideOf([]));
    expect(report).toMatchObject({ approximations: [], approximationsTruncated: 0, fallbacks: [], fallbacksTruncated: 0 });
    for (let i = 0; i < REPORT_LIST_MAX + 500; i++) {
      approximate(report, `p1:z${i}`, 'blend-dropped');
      approximate(report, `p1:z${i}`, 'blend-dropped'); // once per id and kind
    }
    approximate(report, 'p1:z0', 'mask-dropped'); // another kind of a listed id: past the list, counted
    expect(report.approximations).toHaveLength(REPORT_LIST_MAX);
    expect(report.approximations[0]).toEqual({ id: 'p1:z0', kind: 'blend-dropped' });
    expect(report.approximations.at(-1)).toEqual({ id: `p1:z${REPORT_LIST_MAX - 1}`, kind: 'blend-dropped' });
    expect(report.approximationsTruncated).toBe(501);
    expect([...approximationCounts(report)]).toEqual([
      ['blend-dropped', REPORT_LIST_MAX + 500],
      ['mask-dropped', 1],
    ]);
  });

  it('records 100,000 approximations in linear time', () => {
    const report = newReport(slideOf([]));
    const started = performance.now();
    for (let i = 0; i < 100_000; i++) approximate(report, `p1:z${i}`, 'blend-dropped');
    for (let i = 0; i < 100_000; i++) approximate(report, `p1:z${i}`, 'blend-dropped');
    // a scan of the list per call took about a minute for 100,000 in convert() (final review F1)
    expect(performance.now() - started, 'a hang guard, not a speed requirement').toBeLessThan(5_000);
    expect(report.approximationsTruncated).toBe(100_000 - REPORT_LIST_MAX);
    expect(approximationCounts(report).get('blend-dropped')).toBe(100_000);
  });

  it('lists the first REPORT_LIST_MAX fallbacks and counts the rest', () => {
    const report = newReport(slideOf([]));
    for (let i = 0; i < REPORT_LIST_MAX + 2; i++) listFallback(report, `p1:z${i}`, 'shading-function');
    expect(report.fallbacks).toHaveLength(REPORT_LIST_MAX);
    expect(report.fallbacks.at(-1)).toEqual({ id: `p1:z${REPORT_LIST_MAX - 1}`, reason: 'shading-function' });
    expect(report.fallbacksTruncated).toBe(2);
  });
});
