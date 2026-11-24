import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { openRawPdf, PdfParseError, UnsupportedFilterError, type PdfObj } from '../src/engine/rawpdf';
import { buildPdf, type MiniObject } from './helpers/minipdf';

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

const catalog: MiniObject = { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' };
const onePage: MiniObject[] = [
  catalog,
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  { num: 3, body: '<< /Type /Page /Parent 2 0 R >>' },
];

function dictOf(o: PdfObj): Map<string, PdfObj> {
  if (o.k !== 'dict') throw new Error(`expected a dict, got ${o.k}`);
  return o.v;
}

describe('openRawPdf: object access', () => {
  const info = '<< /Answer 42 /Title (Hello \\(raw\\)) /Name /A#20B /Nested << /K [1 2.5 -3 true null] >> /Ref 3 0 R >>';

  it('reads a classic xref table', () => {
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, body: info }]));
    const d = dictOf(raw.get({ num: 4, gen: 0 }));
    expect(d.get('Answer')).toEqual({ k: 'num', v: 42 });
    expect(d.get('Name')).toEqual({ k: 'name', v: 'A B' });
    expect(text((d.get('Title') as Extract<PdfObj, { k: 'str' }>).v)).toBe('Hello (raw)');
    expect(d.get('Ref')).toEqual({ k: 'ref', v: { num: 3, gen: 0 } });
    expect(dictOf(d.get('Nested')!).get('K')).toEqual({
      k: 'arr',
      v: [{ k: 'num', v: 1 }, { k: 'num', v: 2.5 }, { k: 'num', v: -3 }, { k: 'bool', v: true }, { k: 'null' }],
    });
  });

  it('resolves a dict inside an object stream (xref stream with PNG predictor)', () => {
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, body: info }], { xref: 'stream', packed: [3, 4] }));
    const d = dictOf(raw.get({ num: 4, gen: 0 }));
    expect(d.get('Answer')).toEqual({ k: 'num', v: 42 });
    expect(raw.resolve(d.get('Ref')!)).toMatchObject({ k: 'dict' });
    expect(raw.pageRefs()).toEqual([{ num: 3, gen: 0 }]);
  });

  it('honours /XRefStm in a hybrid-reference file', () => {
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, body: info }], { xref: 'hybrid', packed: [4] }));
    // object 4 is free in the classic table and only listed in the /XRefStm stream
    expect(dictOf(raw.get({ num: 4, gen: 0 })).get('Answer')).toEqual({ k: 'num', v: 42 });
    expect(raw.pageRefs()).toEqual([{ num: 3, gen: 0 }]);
  });

  it('returns null for an object the xref does not define', () => {
    const raw = openRawPdf(buildPdf(onePage));
    expect(raw.get({ num: 77, gen: 0 })).toEqual({ k: 'null' });
  });

  it('resolve() dereferences refs and returns anything else untouched', () => {
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, body: '5 0 R' }, { num: 5, body: '(end)' }]));
    expect(raw.resolve({ k: 'ref', v: { num: 4, gen: 0 } })).toMatchObject({ k: 'str' });
    const n: PdfObj = { k: 'num', v: 1 };
    expect(raw.resolve(n)).toBe(n);
  });

  it('throws a clear error when the file has no startxref', () => {
    expect(() => openRawPdf(new TextEncoder().encode('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n'))).toThrow(/startxref/);
  });
});

describe('openRawPdf: page tree', () => {
  it('pageRefs returns 2 pages through nested /Kids, in document order', () => {
    const raw = openRawPdf(
      buildPdf([
        catalog,
        { num: 2, body: '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>' },
        { num: 3, body: '<< /Type /Pages /Parent 2 0 R /Kids [6 0 R] /Count 1 >>' },
        { num: 4, body: '<< /Type /Page /Parent 2 0 R >>' },
        { num: 6, body: '<< /Type /Page /Parent 3 0 R >>' },
      ]),
    );
    expect(raw.pageRefs()).toEqual([
      { num: 6, gen: 0 },
      { num: 4, gen: 0 },
    ]);
  });
});

describe('openRawPdf: decode', () => {
  const streamOf = (raw: ReturnType<typeof openRawPdf>, num: number) => {
    const s = raw.get({ num, gen: 0 });
    if (s.k !== 'stream') throw new Error('expected a stream');
    return s;
  };

  it('inflates a FlateDecode stream to the original text', () => {
    const payload = 'BT /F1 12 Tf (Hello, flate!) Tj ET '.repeat(20);
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, data: payload, flate: true }]));
    const s = streamOf(raw, 4);
    expect(s.raw.length).toBeLessThan(payload.length); // really stored compressed
    expect(text(raw.decode(s))).toBe(payload);
  });

  it('follows an indirect /Length', () => {
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, length: '5 0 R', data: 'abcdef' }, { num: 5, body: '6' }]));
    expect(text(streamOf(raw, 4).raw)).toBe('abcdef');
  });

  it('falls back to the endstream marker when /Length is wrong', () => {
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, length: '2', data: 'abcdef' }]));
    expect(text(streamOf(raw, 4).raw)).toBe('abcdef');
  });

  it('keeps stream data untouched when no filter is set', () => {
    const data = new Uint8Array([0xff, 0xd8, 0x00, 0x0a, 0x0d, 0xff, 0xd9]);
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, data }]));
    expect([...raw.decode(streamOf(raw, 4))]).toEqual([...data]);
  });

  it('undoes PNG predictors (Sub, Up, Average, Paeth) after inflating', () => {
    const predicted = new Uint8Array([
      1, 10, 5, 5, // Sub    -> 10 15 20
      2, 1, 1, 1, // Up      -> 11 16 21
      3, 0, 0, 0, // Average -> 5 10 15
      4, 1, 1, 1, // Paeth   -> 6 11 16
    ]);
    const raw = openRawPdf(
      buildPdf([
        ...onePage,
        { num: 4, dict: '/DecodeParms << /Predictor 15 /Columns 3 >>', data: predicted, flate: true },
      ]),
    );
    expect([...raw.decode(streamOf(raw, 4))]).toEqual([10, 15, 20, 11, 16, 21, 5, 10, 15, 6, 11, 16]);
  });

  it('round-trips PNG predictor rows of every type with several bytes per pixel', () => {
    const colors = 3;
    const columns = 5;
    const rowBytes = colors * columns;
    const rows = 10;
    const original = new Uint8Array(rows * rowBytes).map((_, i) => (i * 37 + ((i * i) >> 3)) & 255);
    const paeth = (a: number, b: number, c: number): number => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    const encoded = new Uint8Array(rows * (rowBytes + 1));
    for (let r = 0; r < rows; r++) {
      const type = r % 5; // None, Sub, Up, Average, Paeth
      encoded[r * (rowBytes + 1)] = type;
      for (let i = 0; i < rowBytes; i++) {
        const x = original[r * rowBytes + i]!;
        const a = i >= colors ? original[r * rowBytes + i - colors]! : 0;
        const b = r > 0 ? original[(r - 1) * rowBytes + i]! : 0;
        const c = r > 0 && i >= colors ? original[(r - 1) * rowBytes + i - colors]! : 0;
        const guess = [0, a, b, (a + b) >> 1, paeth(a, b, c)][type]!;
        encoded[r * (rowBytes + 1) + 1 + i] = (x - guess) & 255;
      }
    }
    const raw = openRawPdf(
      buildPdf([
        ...onePage,
        { num: 4, dict: `/DecodeParms << /Predictor 15 /Colors ${colors} /Columns ${columns} >>`, data: encoded, flate: true },
      ]),
    );
    expect([...raw.decode(streamOf(raw, 4))]).toEqual([...original]);
  });

  it.each(['/Columns 0', '/Columns -3', '/Columns 2.5', '/Columns 4 /Colors 0'])(
    'rejects nonsense PNG predictor parameters (%s) instead of returning garbage',
    (params) => {
      const raw = openRawPdf(
        buildPdf([...onePage, { num: 4, dict: `/DecodeParms << /Predictor 15 ${params} >>`, data: new Uint8Array(12), flate: true }]),
      );
      expect(() => raw.decode(streamOf(raw, 4))).toThrow(PdfParseError);
    },
  );

  it('applies filters in array order', () => {
    const inner = zlibSync(new TextEncoder().encode('twice'));
    const raw = openRawPdf(
      buildPdf([...onePage, { num: 4, dict: '/Filter [/FlateDecode /FlateDecode]', data: zlibSync(inner) }]),
    );
    expect(text(raw.decode(streamOf(raw, 4)))).toBe('twice');
  });

  it('throws UnsupportedFilterError for filters other than Flate', () => {
    const raw = openRawPdf(buildPdf([...onePage, { num: 4, dict: '/Filter /DCTDecode', data: new Uint8Array([0xff, 0xd8]) }]));
    expect(() => raw.decode(streamOf(raw, 4))).toThrow(UnsupportedFilterError);
  });
});
