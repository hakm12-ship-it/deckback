import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { fontPrograms, jpegStreams } from '../src/engine/fonts';
import { openRawPdf } from '../src/engine/rawpdf';
import { buildPdf, type MiniObject } from './helpers/minipdf';

/** One bad object must cost only that object: the rest of the page still comes back. */

const head: MiniObject[] = [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
];
const program = new Uint8Array(1500).map((_, i) => (i * 5) & 255);
const jpeg = (fill: number): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, fill, fill, 0xff, 0xd9]);

/** Rewrites the first `from` in the PDF to the same-length `to`, e.g. "\n7 0 obj" -> "\n9 0 obj". */
function corrupt(pdf: Uint8Array, from: string, to: string): Uint8Array {
  expect(to.length).toBe(from.length);
  const text = new TextDecoder('latin1').decode(pdf); // single-byte: string index == byte index
  const at = text.indexOf(from);
  expect(at, `"${from.trim()}" not found`).toBeGreaterThan(0);
  const out = pdf.slice();
  out.set(new TextEncoder().encode(to), at);
  return out;
}

function fontObjects(fontFile: MiniObject): MiniObject[] {
  return [
    ...head,
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 7 0 R >> >> >>' },
    { num: 4, body: '<< /Type /Font /Subtype /TrueType /BaseFont /BCDEEE+Broken /FontDescriptor 5 0 R >>' },
    { num: 5, body: '<< /Type /FontDescriptor /FontName /BCDEEE+Broken /Flags 32 /Ascent 900 /Descent -200 /FontFile2 6 0 R >>' },
    fontFile, // object 6
    { num: 7, body: '<< /Type /Font /Subtype /TrueType /BaseFont /BCDFEE+Fine /FontDescriptor 8 0 R >>' },
    { num: 8, body: '<< /Type /FontDescriptor /FontName /BCDFEE+Fine /Flags 32 /Ascent 900 /Descent -200 /FontFile2 9 0 R >>' },
    { num: 9, data: program, flate: true },
  ];
}

describe('fontPrograms: a font whose program cannot be read', () => {
  const unreadable = {
    fileKind: 'FontFile2',
    ref: { num: 6, gen: 0 },
    bytes: null,
    baseFont: 'BCDEEE+Broken',
    descriptor: { flags: 32, ascent: 900, descent: -200 },
  };

  function expectOnlyThatFontIsLost(pdf: Uint8Array): void {
    const programs = fontPrograms(openRawPdf(pdf), 0);
    expect(programs).toHaveLength(2);
    expect(programs[0]).toMatchObject({ resName: 'F1', ...unreadable });
    expect(programs[1]).toMatchObject({ resName: 'F2', baseFont: 'BCDFEE+Fine', fileKind: 'FontFile2' });
    expect([...programs[1]!.bytes!]).toEqual([...program]);
  }

  it('keeps the font, baseFont and ref when the program uses an unsupported filter (LZWDecode)', () => {
    expectOnlyThatFontIsLost(buildPdf(fontObjects({ num: 6, dict: '/Filter /LZWDecode', data: program })));
  });

  it('keeps the font when the Flate data is corrupt', () => {
    const garbage = new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
    expectOnlyThatFontIsLost(buildPdf(fontObjects({ num: 6, dict: '/Filter /FlateDecode', data: garbage })));
  });

  it('keeps the font when the Flate data is truncated', () => {
    const whole = zlibSync(program);
    expectOnlyThatFontIsLost(
      buildPdf(fontObjects({ num: 6, dict: '/Filter /FlateDecode', data: whole.subarray(0, whole.length >> 1) })),
    );
  });

  it('keeps the font when the program object itself is broken (xref points at another object)', () => {
    const pdf = buildPdf(fontObjects({ num: 6, data: program, flate: true }));
    expectOnlyThatFontIsLost(corrupt(pdf, '\n6 0 obj', '\n8 0 obj'));
  });
});

describe('fontPrograms: other damaged objects', () => {
  it('skips a font whose dict cannot be loaded and returns the others', () => {
    const pdf = buildPdf(fontObjects({ num: 6, data: program, flate: true }));
    const programs = fontPrograms(openRawPdf(corrupt(pdf, '\n4 0 obj', '\n8 0 obj')), 0);
    expect(programs.map((p) => [p.resName, p.baseFont, p.fileKind])).toEqual([['F2', 'BCDFEE+Fine', 'FontFile2']]);
  });

  it('skips a Form XObject that cannot be loaded and still returns the page fonts', () => {
    const pdf = buildPdf([
      ...head,
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 5 0 R >> >> >>' },
      { num: 4, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      { num: 5, dict: '/Subtype /Form /BBox [0 0 1 1]', data: 'q Q' },
    ]);
    const programs = fontPrograms(openRawPdf(corrupt(pdf, '\n5 0 obj', '\n9 0 obj')), 0);
    expect(programs.map((p) => p.baseFont)).toEqual(['Helvetica']);
  });

  it('still throws RangeError for a page index outside the document', () => {
    const raw = openRawPdf(buildPdf(fontObjects({ num: 6, data: program, flate: true })));
    expect(() => fontPrograms(raw, 5)).toThrow(RangeError);
  });
});

describe('jpegStreams: damaged objects', () => {
  const imageDict = '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode';
  const twoImages = buildPdf([
    ...head,
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R /Im2 5 0 R >> >> >>' },
    { num: 4, dict: imageDict, data: jpeg(1) },
    { num: 5, dict: imageDict, data: jpeg(2) },
  ]);

  it('skips an image with a broken xref entry and returns the other JPEG', () => {
    const found = jpegStreams(openRawPdf(corrupt(twoImages, '\n4 0 obj', '\n8 0 obj')), 0);
    expect(found.map((j) => j.ref.num)).toEqual([5]);
    expect([...found[0]!.bytes]).toEqual([...jpeg(2)]);
  });

  it('skips a Form XObject that cannot be loaded', () => {
    const pdf = buildPdf([
      ...head,
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Fm1 6 0 R /Im2 5 0 R >> >> >>' },
      { num: 5, dict: imageDict, data: jpeg(2) },
      { num: 6, dict: '/Subtype /Form /BBox [0 0 1 1]', data: 'q Q' },
    ]);
    const found = jpegStreams(openRawPdf(corrupt(pdf, '\n6 0 obj', '\n9 0 obj')), 0);
    expect(found.map((j) => j.ref.num)).toEqual([5]);
  });
});

describe('returned bytes', () => {
  it('are copies: they do not alias the PDF buffer, so writing to them cannot damage it', () => {
    const pdf = buildPdf([
      ...head,
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Im1 7 0 R >> >> >>' },
      { num: 4, body: '<< /Type /Font /Subtype /TrueType /BaseFont /Plain /FontDescriptor 5 0 R >>' },
      { num: 5, body: '<< /Type /FontDescriptor /FontName /Plain /FontFile2 6 0 R >>' },
      { num: 6, data: program }, // no filter: decode() hands back the stored bytes themselves
      { num: 7, dict: '/Subtype /Image /Width 1 /Height 1 /Filter /DCTDecode', data: jpeg(3) },
    ]);
    const raw = openRawPdf(pdf);
    const font = fontPrograms(raw, 0)[0]!.bytes!;
    const image = jpegStreams(raw, 0)[0]!.bytes;
    for (const bytes of [font, image]) {
      expect(bytes.buffer).not.toBe(pdf.buffer);
      expect(bytes.byteOffset).toBe(0);
      expect(bytes.buffer.byteLength).toBe(bytes.length);
    }
    const first = image[0];
    image[0] = 0;
    font[0] = 0xee;
    expect(jpegStreams(raw, 0)[0]!.bytes[0]).toBe(first);
  });
});
