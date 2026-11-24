import { describe, expect, it } from 'vitest';
import { fontPrograms, jpegStreams } from '../src/engine/fonts';
import { openRawPdf } from '../src/engine/rawpdf';
import { readSfntNames } from '../src/fonts/sfnt';
import { fixture } from './helpers/fixtures';

// original.pdf: xref streams + object streams (PowerPoint 2024 export).
// orig_pdfa.pdf: classic xref table, no object streams.
describe('embedded Korean font program, straight from the file', () => {
  for (const name of ['original.pdf', 'orig_pdfa.pdf']) {
    const bytes = fixture(name);
    it.skipIf(bytes === null)(`${name}: page 0 has a FontFile2 whose own name table keeps both family names`, () => {
      const programs = fontPrograms(openRawPdf(bytes!), 0);
      const embedded = programs.filter((p) => p.fileKind === 'FontFile2' && p.bytes !== null && p.bytes.length > 1000);
      expect(embedded.length).toBeGreaterThan(0);
      const korean = embedded.filter((p) => {
        const { family } = readSfntNames(p.bytes!);
        return family[1033] === 'Malgun Gothic' && family[1042] === '맑은 고딕';
      });
      expect(korean.length).toBeGreaterThan(0);
    });
  }
});

describe('original JPEG bytes', () => {
  const bytes = fixture('hard_std.pdf');
  it.skipIf(bytes === null)('hard_std.pdf: DCTDecode images come back as complete JPEG files', () => {
    const raw = openRawPdf(bytes!);
    const found = raw.pageRefs().flatMap((_, page) => jpegStreams(raw, page));
    expect(found.length).toBeGreaterThanOrEqual(1);
    for (const { bytes: jpeg } of found) {
      expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
      expect([jpeg[jpeg.length - 2], jpeg[jpeg.length - 1]]).toEqual([0xff, 0xd9]);
    }
  });
});
