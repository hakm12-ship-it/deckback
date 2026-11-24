import { describe, expect, it } from 'vitest';
import { m01Fixture, ORIGINAL_PDF, PROBE_STD_PDF } from '../e2e/global-setup';

/**
 * The PDF spike M0-1 compares (apps/web/e2e): the e2e output and its evidence name it by a label. The private probe's
 * path or file name never appears there, since CI logs and evidence files may be shared.
 */
describe('m01Fixture', () => {
  it('takes the private probe where it exists, labelled without its path', () => {
    const { pdf, label } = m01Fixture(() => true);
    expect(pdf).toBe(ORIGINAL_PDF);
    expect(label).toBe('private probe');
    expect(label).not.toMatch(/corpus|original|\.pdf|[\\/]/);
  });

  it('falls back to the committed public probe, which may be named', () => {
    const { pdf, label } = m01Fixture(() => false);
    expect(pdf).toBe(PROBE_STD_PDF);
    expect(label).toBe('public probe (corpus/generated/probe_std.pdf)');
  });

  it('looks for the private probe at its own path', () => {
    const asked: string[] = [];
    m01Fixture((path) => {
      asked.push(path);
      return false;
    });
    expect(asked).toEqual([ORIGINAL_PDF]);
  });
});
