import { describe, expect, it } from 'vitest';
import { EncryptedPdfError, openRawPdf } from '../src/engine/rawpdf';
import { buildPdf } from './helpers/minipdf';

const objs = [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' },
  { num: 9, body: '<< /Filter /Standard /V 4 /R 4 /O (x) /U (y) /P -4 >>' },
];

describe('encrypted PDFs', () => {
  it('openRawPdf throws EncryptedPdfError when the trailer has /Encrypt (classic table)', () => {
    const bytes = buildPdf(objs, { trailer: '/Encrypt 9 0 R' });
    expect(() => openRawPdf(bytes)).toThrow(EncryptedPdfError);
  });

  it('openRawPdf throws EncryptedPdfError when the xref stream dict has /Encrypt', () => {
    const bytes = buildPdf(objs, { xref: 'stream', trailer: '/Encrypt 9 0 R' });
    expect(() => openRawPdf(bytes)).toThrow(EncryptedPdfError);
  });

  it('opens the same file normally when /Encrypt is absent', () => {
    expect(openRawPdf(buildPdf(objs)).pageRefs()).toEqual([{ num: 3, gen: 0 }]);
  });
});
