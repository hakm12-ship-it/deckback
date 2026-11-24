import { describe, expect, it } from 'vitest';
import { fontPrograms } from '../src/engine/fonts';
import { openRawPdf } from '../src/engine/rawpdf';
import { buildPdf } from './helpers/minipdf';

describe('fontPrograms: fonts without an embedded program', () => {
  it('returns the font with bytes: null and the BaseFont intact, without throwing', () => {
    const raw = openRawPdf(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> >>' },
        {
          num: 4,
          body: '<< /Type /Font /Subtype /TrueType /BaseFont /TimesNewRomanPS-ItalicMT /FontDescriptor 5 0 R >>',
        },
        {
          num: 5,
          body: '<< /Type /FontDescriptor /FontName /TimesNewRomanPS-ItalicMT /Flags 98 /Ascent 891 /Descent -216 /ItalicAngle -15 /FontWeight 400 >>',
        },
      ]),
    );
    const programs = fontPrograms(raw, 0);
    expect(programs).toHaveLength(1);
    expect(programs).toMatchObject([
      {
        resName: 'F1',
        baseFont: 'TimesNewRomanPS-ItalicMT',
        subtype: 'TrueType',
        fileKind: null,
        bytes: null,
        ref: null,
        descriptor: { flags: 98, ascent: 891, descent: -216, italicAngle: -15, fontWeight: 400 },
      },
    ]);
  });

  it('handles a standard font that has no FontDescriptor at all', () => {
    const raw = openRawPdf(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> >>' },
        { num: 4, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      ]),
    );
    expect(fontPrograms(raw, 0)).toMatchObject([
      { resName: 'F1', baseFont: 'Helvetica', subtype: 'Type1', fileKind: null, bytes: null, ref: null, descriptor: null },
    ]);
  });

  it('a page without /Resources yields no fonts', () => {
    const raw = openRawPdf(
      buildPdf([
        { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
        { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' },
      ]),
    );
    expect(fontPrograms(raw, 0)).toEqual([]);
  });
});
