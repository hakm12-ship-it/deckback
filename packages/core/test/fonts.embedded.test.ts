import { describe, expect, it } from 'vitest';
import { fontPrograms, jpegStreams } from '../src/engine/fonts';
import { openRawPdf } from '../src/engine/rawpdf';
import { buildPdf, type MiniObject } from './helpers/minipdf';

const head: MiniObject[] = [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
];

// fake font program: sfnt-looking header bytes followed by filler
const program = new Uint8Array(2000).map((_, i) => (i * 7) & 255);
const jpeg = (fill: number): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, fill, fill, 0x0a, 0x0d, 0xff, 0xd9]);

describe('fontPrograms: embedded programs', () => {
  it('reads a Type0 font whose FontFile2 hangs off the descendant CIDFont (inside an object stream)', () => {
    const bytes = buildPdf(
      [
        ...head,
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> >>' },
        {
          num: 4,
          body: '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+MalgunGothic /Encoding /Identity-H /DescendantFonts [5 0 R] >>',
        },
        {
          num: 5,
          body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+MalgunGothic /FontDescriptor 6 0 R >>',
        },
        {
          num: 6,
          body: '<< /Type /FontDescriptor /FontName /AAAAAA+MalgunGothic /Flags 32 /Ascent 1000 /Descent -200 /ItalicAngle 0 /FontFile2 7 0 R >>',
        },
        { num: 7, dict: `/Length1 ${program.length}`, data: program, flate: true },
      ],
      { xref: 'stream', packed: [3, 4, 5, 6] },
    );
    const [font, ...rest] = fontPrograms(openRawPdf(bytes), 0);
    expect(rest).toEqual([]);
    expect(font).toMatchObject({
      resName: 'F1',
      baseFont: 'AAAAAA+MalgunGothic',
      subtype: 'CIDFontType2',
      fileKind: 'FontFile2',
      ref: { num: 7, gen: 0 },
      descriptor: { flags: 32, ascent: 1000, descent: -200, italicAngle: 0, fontWeight: null },
      // M8 round 1a: what maps a code to a glyph of the program (a symbol font's codes, scene/fonts.ts)
      composite: true,
      encoding: 'Identity-H',
      cidToGid: 'identity',
    });
    expect([...font!.bytes!]).toEqual([...program]);
  });

  it("reads a CIDFontType2's CIDToGIDMap stream, and a simple font's encoding name (M8 round 1a)", () => {
    const map = new Uint8Array([0, 0, 0, 5, 0, 9]); // CID 0 -> 0, 1 -> 5, 2 -> 9
    const bytes = buildPdf([
      ...head,
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R /F2 9 0 R >> >> >>' },
      { num: 4, body: '<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Wingdings-Regular /Encoding /Identity-H /DescendantFonts [5 0 R] >>' },
      { num: 5, body: '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Wingdings-Regular /FontDescriptor 6 0 R /CIDToGIDMap 8 0 R >>' },
      { num: 6, body: '<< /Type /FontDescriptor /FontName /AAAAAA+Wingdings-Regular /Flags 4 /FontFile2 7 0 R >>' },
      { num: 7, data: program },
      { num: 8, data: map, flate: true },
      { num: 9, body: '<< /Type /Font /Subtype /TrueType /BaseFont /Symbol /Encoding /WinAnsiEncoding /FontDescriptor 10 0 R >>' },
      { num: 10, body: '<< /Type /FontDescriptor /FontName /Symbol /Flags 4 >>' },
    ]);
    const [cid, simple] = fontPrograms(openRawPdf(bytes), 0);
    expect(cid).toMatchObject({ composite: true, encoding: 'Identity-H' });
    expect([...(cid!.cidToGid as Uint8Array)]).toEqual([...map]);
    expect(simple).toMatchObject({ composite: false, encoding: 'WinAnsiEncoding', cidToGid: null });
  });

  it('descends into Form XObjects and dedupes a font used twice by its dict ref', () => {
    const bytes = buildPdf([
      ...head,
      {
        num: 3,
        body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> /XObject << /Fm1 8 0 R >> >> >>',
      },
      { num: 4, body: '<< /Type /Font /Subtype /TrueType /BaseFont /Alpha /FontDescriptor 5 0 R >>' },
      { num: 5, body: '<< /Type /FontDescriptor /FontName /Alpha /Flags 32 /FontFile2 6 0 R >>' },
      { num: 6, data: program },
      { num: 7, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
      // the form reuses font 4 under another name and adds font 7; it also refers back to itself
      {
        num: 8,
        dict: '/Subtype /Form /BBox [0 0 10 10] /Resources << /Font << /Other 4 0 R /F9 7 0 R >> /XObject << /Self 8 0 R >> >>',
        data: 'q Q',
      },
    ]);
    const programs = fontPrograms(openRawPdf(bytes), 0);
    expect(programs.map((p) => [p.resName, p.baseFont])).toEqual([
      ['F1', 'Alpha'],
      ['F9', 'Helvetica'],
    ]);
    expect(programs[0]!.fileKind).toBe('FontFile2');
    expect([...programs[0]!.bytes!]).toEqual([...program]);
  });

  it('uses /Resources inherited from the /Pages node', () => {
    const bytes = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 4 0 R >> >> >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' },
      { num: 4, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>' },
    ]);
    expect(fontPrograms(openRawPdf(bytes), 0).map((p) => p.baseFont)).toEqual(['Courier']);
  });

  it('rejects a page index outside the document', () => {
    const raw = openRawPdf(buildPdf([...head, { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' }]));
    expect(() => fontPrograms(raw, 1)).toThrow(RangeError);
    expect(() => jpegStreams(raw, -1)).toThrow(RangeError);
  });
});

describe('jpegStreams', () => {
  it('returns raw DCTDecode image bytes untouched, including images inside forms, and skips other images', () => {
    const a = jpeg(1);
    const b = jpeg(2);
    const bytes = buildPdf([
      ...head,
      {
        num: 3,
        body: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R /Im2 5 0 R /Fm1 6 0 R /Again 4 0 R >> >> >>',
      },
      { num: 4, dict: '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: a },
      { num: 5, dict: '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', data: new Uint8Array([0x7f]), flate: true },
      { num: 6, dict: '/Subtype /Form /BBox [0 0 1 1] /Resources << /XObject << /Im3 7 0 R >> >>', data: 'q Q' },
      { num: 7, dict: '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter [/DCTDecode]', data: b },
    ]);
    const found = jpegStreams(openRawPdf(bytes), 0);
    expect(found.map((j) => j.ref.num)).toEqual([4, 7]);
    expect([...found[0]!.bytes]).toEqual([...a]);
    expect([...found[1]!.bytes]).toEqual([...b]);
  });

  it('marks plain what may pass through: DeviceRGB, DeviceGray, ICCBased of 3 or 1 components; no /Decode, /SMask, /Mask', () => {
    const cases: [string, boolean][] = [
      ['/ColorSpace /DeviceRGB', true],
      ['/ColorSpace /DeviceGray', true],
      ['/ColorSpace [/ICCBased 30 0 R]', true], // N 3
      ['/ColorSpace [/ICCBased 31 0 R]', true], // N 1
      ['/ColorSpace 33 0 R', true], // an indirect [/ICCBased 30 0 R]
      ['/ColorSpace /DeviceRGB /SMask null', true], // null is no value: the key is as good as absent
      ['/ColorSpace /DeviceRGB /Mask 35 0 R', true], // ... and so is a reference to no object
      ['/ColorSpace [/ICCBased 32 0 R]', false], // N 4
      ['/ColorSpace /DeviceCMYK', false],
      ['/ColorSpace [/Indexed /DeviceRGB 0 <102030>]', false],
      ['/ColorSpace [/CalRGB << /WhitePoint [0.95 1 1.09] >>]', false],
      ['/ColorSpace /DeviceRGB /Decode [1 0 1 0 1 0]', false],
      ['/ColorSpace /DeviceGray /SMask 34 0 R', false],
      ['/ColorSpace /DeviceRGB /Mask [0 10 0 10 0 10]', false],
      ['', false], // no colour space
    ];
    const names = cases.map((_, i) => `/I${i} ${40 + i} 0 R`).join(' ');
    const bytes = buildPdf([
      ...head,
      { num: 3, body: `<< /Type /Page /Parent 2 0 R /Resources << /XObject << ${names} >> >> >>` },
      { num: 30, dict: '/N 3', data: program },
      { num: 31, dict: '/N 1', data: program },
      { num: 32, dict: '/N 4', data: program },
      { num: 33, body: '[/ICCBased 30 0 R]' },
      { num: 34, dict: '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8', data: new Uint8Array([0x7f]) },
      ...cases.map(
        ([extra], i): MiniObject => ({
          num: 40 + i,
          dict: `/Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /Filter /DCTDecode ${extra}`,
          // a frame header of as many components as the colour space has (gray: the DeviceGray and the N 1 profile)
          data: jpegHeader({ components: /DeviceGray|31 0 R/.test(extra) ? 1 : 3 }),
        }),
      ),
    ]);
    const found = jpegStreams(openRawPdf(bytes), 0);
    expect(found.map((j) => [j.ref.num, j.plain])).toEqual(cases.map(([, plain], i) => [40 + i, plain]));
  });

  it('returns an empty list for a page without images', () => {
    const raw = openRawPdf(buildPdf([...head, { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' }]));
    expect(jpegStreams(raw, 0)).toEqual([]);
  });

  it('finds the JPEGs of tiling-pattern cells too, of the page, of its forms and of other cells (M2-R18)', () => {
    const tiling = (resources: string) =>
      `/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Resources << ${resources} >>`;
    const image = (n: number): MiniObject => ({
      num: n,
      dict: '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode',
      data: jpegHeader({}),
    });
    const bytes = buildPdf([
      ...head,
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /Pattern << /P1 4 0 R /S 9 0 R >> /XObject << /Fm 6 0 R >> >> >>' },
      { num: 4, dict: tiling('/XObject << /Im 5 0 R >> /Pattern << /P2 7 0 R >>'), data: '/Im Do' }, // a picture fill
      image(5),
      { num: 6, dict: '/Subtype /Form /BBox [0 0 1 1] /Resources << /Pattern << /P3 10 0 R >> >>', data: 'q Q' },
      { num: 7, dict: tiling('/XObject << /Im 8 0 R /Again 5 0 R >>'), data: '/Im Do' }, // a cell's own pattern
      image(8),
      { num: 9, body: '<< /Type /Pattern /PatternType 2 /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 1 0] >> >>' },
      { num: 10, dict: tiling('/XObject << /Im 11 0 R >> /Pattern << /Back 4 0 R >>'), data: '/Im Do' }, // in a form; and a cycle
      image(11),
    ]);
    const found = jpegStreams(openRawPdf(bytes), 0);
    expect(found.map((j) => [j.ref.num, j.plain]).sort(([a], [b]) => Number(a) - Number(b))).toEqual([
      [5, true],
      [8, true],
      [11, true],
    ]);
  });

  /** A JPEG's markers up to its frame header: no picture data, which `jpegStreams` does not read. */
  function jpegHeader(opts: { components?: number; ids?: number[]; adobe?: number; exif?: { orientation: number; order: 'II' | 'MM' } }): Uint8Array {
    const out = [0xff, 0xd8];
    if (opts.exif !== undefined) {
      const le = opts.exif.order === 'II';
      const u16 = (v: number) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
      const u32 = (v: number) => (le ? [v & 255, (v >> 8) & 255, 0, 0] : [0, 0, (v >> 8) & 255, v & 255]);
      // A JFIF segment first, as cameras write: the scan goes on past it.
      out.push(0xff, 0xe0, 0, 16, ...[0x4a, 0x46, 0x49, 0x46, 0], 1, 1, 0, 0, 1, 0, 1, 0, 0);
      const tiff = [...[...opts.exif.order].map((c) => c.charCodeAt(0)), ...u16(42), ...u32(8), ...u16(2)];
      tiff.push(...u16(0x010f), ...u16(2), ...u32(1), 0, 0, 0, 0); // Make, an empty string
      tiff.push(...u16(0x0112), ...u16(3), ...u32(1), ...u16(opts.exif.orientation), 0, 0, ...u32(0));
      const body = [...[0x45, 0x78, 0x69, 0x66, 0, 0], ...tiff];
      out.push(0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255, ...body);
    }
    if (opts.adobe !== undefined) out.push(0xff, 0xee, 0, 14, ...[0x41, 0x64, 0x6f, 0x62, 0x65], 0, 100, 0, 0, 0, 0, opts.adobe);
    const n = opts.components ?? 3;
    const ids = opts.ids ?? Array.from({ length: n }, (_, i) => i + 1);
    out.push(0xff, 0xc0, 0, 8 + 3 * n, 8, 0, 1, 0, 1, n, ...ids.flatMap((id) => [id, 0x11, 0]));
    out.push(0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0xff, 0xd9);
    return Uint8Array.from(out);
  }

  /** `plain` of one JPEG image with `dict` extra entries and the bytes `data`. */
  function plainOf(dict: string, data: Uint8Array): boolean {
    const bytes = buildPdf([
      ...head,
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im 4 0 R >> >> >>' },
      { num: 4, dict: `/Subtype /Image /Width 1 /Height 1 /BitsPerComponent 8 /Filter /DCTDecode ${dict}`, data },
    ]);
    const [found] = jpegStreams(openRawPdf(bytes), 0);
    return found!.plain;
  }

  it('declines a JPEG whose EXIF Orientation is not 1: a viewer may turn it, a PDF reader does not', () => {
    for (const order of ['II', 'MM'] as const) {
      expect(plainOf('/ColorSpace /DeviceRGB', jpegHeader({ exif: { orientation: 1, order } })), order).toBe(true);
      expect(plainOf('/ColorSpace /DeviceRGB', jpegHeader({ exif: { orientation: 6, order } })), order).toBe(false);
      expect(plainOf('/ColorSpace /DeviceRGB', jpegHeader({ exif: { orientation: 3, order } })), order).toBe(false);
    }
  });

  it("declines a JPEG whose /ColorTransform is not the one its own markers say", () => {
    const rgb = '/ColorSpace /DeviceRGB';
    const cases: [string, Uint8Array, boolean][] = [
      [rgb, jpegHeader({}), true], // no /ColorTransform: the JPEG's own (YCbCr) holds
      [`${rgb} /DecodeParms << /ColorTransform 1 >>`, jpegHeader({}), true],
      [`${rgb} /DecodeParms << /ColorTransform 0 >>`, jpegHeader({}), false], // a PDF reader shows YCbCr as RGB
      [`${rgb} /DecodeParms << /ColorTransform 0 >>`, jpegHeader({ ids: [0x52, 0x47, 0x42] }), true], // R, G, B: no transform
      [`${rgb} /DecodeParms << /ColorTransform 0 >>`, jpegHeader({ adobe: 0 }), true],
      [`${rgb} /DecodeParms << /ColorTransform 1 >>`, jpegHeader({ adobe: 0 }), false], // the Adobe marker and the PDF disagree
      [`${rgb} /DecodeParms [<< /ColorTransform 1 >>]`, jpegHeader({ adobe: 1 }), true],
      [`${rgb} /DecodeParms [<< /ColorTransform 0 >>]`, jpegHeader({ adobe: 1 }), false],
      ['/ColorSpace /DeviceGray /DecodeParms << /ColorTransform 0 >>', jpegHeader({ components: 1 }), true],
    ];
    expect(cases.map(([dict, data]) => plainOf(dict, data))).toEqual(cases.map(([, , plain]) => plain));
  });

  it('declines a JPEG whose components are not those of its colour space', () => {
    expect(plainOf('/ColorSpace /DeviceGray', jpegHeader({ components: 1 }))).toBe(true);
    expect(plainOf('/ColorSpace /DeviceGray', jpegHeader({ components: 3 }))).toBe(false);
    expect(plainOf('/ColorSpace /DeviceRGB', jpegHeader({ components: 1 }))).toBe(false);
    expect(plainOf('/ColorSpace /DeviceRGB', jpegHeader({ components: 3 }))).toBe(true);
    // A JPEG whose frame header cannot be read is not plain (M2 final review F10, ruling M3-R31): its precision and
    // process are unknown, and a PNG of pdf.js' pixels is never wrong.
    expect(plainOf('/ColorSpace /DeviceRGB', jpeg(9))).toBe(false);
  });
});
