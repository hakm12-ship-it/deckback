import { describe, expect, it } from 'vitest';
import { openRawPdf } from '../src/engine/rawpdf';
import { appendUpdate, buildPdf } from './helpers/minipdf';

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('incremental updates', () => {
  const base = buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' },
    { num: 5, body: '(old)' },
  ]);

  it('the newest definition of an object wins over the base section', () => {
    const updated = appendUpdate(base, [{ num: 5, body: '(new)' }], { size: 6 });
    const obj = openRawPdf(updated).get({ num: 5, gen: 0 });
    expect(obj.k).toBe('str');
    expect(obj.k === 'str' && text(obj.v)).toBe('new');
  });

  it('objects the update does not touch still come from the /Prev section', () => {
    const updated = appendUpdate(base, [{ num: 5, body: '(new)' }], { size: 6 });
    const raw = openRawPdf(updated);
    expect(raw.pageRefs()).toEqual([{ num: 3, gen: 0 }]);
  });

  it('the base alone still reads the old value', () => {
    const obj = openRawPdf(base).get({ num: 5, gen: 0 });
    expect(obj.k === 'str' && text(obj.v)).toBe('old');
  });

  it('follows a chain of several updates and an object added by a later one', () => {
    const one = appendUpdate(base, [{ num: 5, body: '(v2)' }], { size: 6 });
    const two = appendUpdate(one, [{ num: 5, body: '(v3)' }, { num: 6, body: '(added)' }], { size: 7 });
    const raw = openRawPdf(two);
    const five = raw.get({ num: 5, gen: 0 });
    const six = raw.get({ num: 6, gen: 0 });
    expect(five.k === 'str' && text(five.v)).toBe('v3');
    expect(six.k === 'str' && text(six.v)).toBe('added');
  });
});
