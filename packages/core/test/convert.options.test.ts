import { readFileSync } from 'node:fs';
import Ajv, { type ValidateFunction } from 'ajv';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/convert';
import { REPORT_SCHEMA } from '../src/report/types';
import { canonicalJson } from '../src/scene/canonical';
import { embeddedTrueType, partsOf, sizedPdf } from './helpers/pptx';
import { trueTypeFont } from './helpers/sfnt';

/** M6 Task 1: `onProgress` and `fontMap`, which change nothing when unused. */

const text = (n: number) => `BT /F1 24 Tf 20 100 Td (AB${'C'.repeat(n)}) Tj ET`;
const PDF3 = sizedPdf([1, 2, 3].map((n) => ({ size: [300, 200] as [number, number], content: text(n) })));

const REPORT_JSON_SCHEMA = JSON.parse(readFileSync(new URL('../src/report/report.schema.json', import.meta.url), 'utf8')) as object;
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(REPORT_JSON_SCHEMA);
const validateReport = ajv.getSchema(REPORT_SCHEMA) as ValidateFunction;

describe('convert(): onProgress', () => {
  it('is called with (0, total) before the first slide and (n, total) after each slide is written', async () => {
    const calls: [number, number][] = [];
    await convert(PDF3, { onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it('counts the pages chosen, not the document', async () => {
    const calls: [number, number][] = [];
    await convert(PDF3, { pages: [2, 0], onProgress: (done, total) => calls.push([done, total]) });
    expect(calls).toEqual([[0, 2], [1, 2], [2, 2]]);
  });

  it('is not required: the same bytes and report with or without it', async () => {
    const plain = await convert(PDF3);
    const watched = await convert(PDF3, { onProgress: () => undefined });
    expect(Buffer.from(watched.pptx).equals(Buffer.from(plain.pptx))).toBe(true);
    expect(canonicalJson(watched.report)).toBe(canonicalJson(plain.report));
  });

  it('a throw from it stops the conversion with that error, and nothing is returned, in lenient and strict mode', async () => {
    for (const strict of [false, true]) {
      const abort = new Error('cancelled');
      const calls: number[] = [];
      await expect(
        convert(PDF3, {
          strict,
          onProgress: (done) => {
            calls.push(done);
            if (done === 1) throw abort;
          },
        }),
      ).rejects.toBe(abort);
      expect(calls).toEqual([0, 1]);
    }
  });

  it('a throw before the first slide stops it before any slide is written', async () => {
    const abort = new Error('cancelled');
    const calls: number[] = [];
    await expect(convert(PDF3, { onProgress: (done) => { calls.push(done); throw abort; } })).rejects.toBe(abort);
    expect(calls).toEqual([0]);
  });
});

describe('convert(): fontMap', () => {
  const written = (pptx: Uint8Array): string => partsOf(pptx)['ppt/slides/slide1.xml']!;

  it('writes the mapped family at a:latin, a:ea and a:cs, and the report says so', async () => {
    const plain = await convert(PDF3);
    expect(written(plain.pptx)).toContain('<a:latin typeface="DeckbackTest"/>');
    const mapped = await convert(PDF3, { fontMap: { DeckbackTest: 'Noto Sans KR' } });
    const slide = written(mapped.pptx);
    expect(slide).toContain('<a:latin typeface="Noto Sans KR"/><a:ea typeface="Noto Sans KR"/><a:cs typeface="Noto Sans KR"/>');
    expect(slide).not.toContain('DeckbackTest');
    expect(mapped.report.fonts.map((f) => [f.latin, f.mappedTo])).toEqual([['DeckbackTest', 'Noto Sans KR']]);
    expect(validateReport(mapped.report), JSON.stringify(validateReport.errors)).toBe(true);
    // nothing else changes: the same layout, so the same text boxes
    expect(slide.replaceAll('Noto Sans KR', 'DeckbackTest')).toBe(written(plain.pptx));
  });

  it('an empty map, unknown keys and a map that names the family itself change nothing; no mappedTo is reported', async () => {
    const plain = await convert(PDF3);
    for (const fontMap of <Record<string, string>[]>[{}, { Unknown: 'X' }, { DeckbackTest: 'DeckbackTest' }, { constructor: 'X', toString: 'Y' }]) {
      const out = await convert(PDF3, { fontMap });
      expect(Buffer.from(out.pptx).equals(Buffer.from(plain.pptx))).toBe(true);
      expect(canonicalJson(out.report)).toBe(canonicalJson(plain.report));
    }
  });

  it('a family mapped to an empty or non-string name is ignored', async () => {
    const plain = await convert(PDF3);
    const out = await convert(PDF3, { fontMap: { DeckbackTest: '' } });
    expect(Buffer.from(out.pptx).equals(Buffer.from(plain.pptx))).toBe(true);
  });

  it('embedded fonts are listed under the mapped typefaces, as the runs are written', async () => {
    const program = trueTypeFont({ names: [[3, 1, 0x409, 1, 'Probe Sans'], [3, 1, 0x409, 2, 'Regular'], [3, 1, 0x409, 4, 'Probe Sans']], fsType: 0 });
    const pdf = sizedPdf([{ size: [300, 200], content: 'BT /F2 24 Tf 20 100 Td (ABC) Tj ET' }], {
      fonts: '/F2 20 0 R',
      objects: embeddedTrueType(20, 'ABCDEF+ProbeSans', program),
    });
    const { pptx, report } = await convert(pdf, { embedFonts: true, fontMap: { 'Probe Sans': 'Mapped Sans' } });
    const parts = partsOf(pptx);
    expect(parts['ppt/presentation.xml']).toContain('<p:font typeface="Mapped Sans"/>');
    expect(parts['ppt/presentation.xml']).not.toContain('Probe Sans');
    expect(parts['ppt/slides/slide1.xml']).toContain('<a:latin typeface="Mapped Sans"/>');
    expect(report.fonts.map((f) => [f.latin, f.mappedTo, f.pptxEmbedding])).toEqual([['Probe Sans', 'Mapped Sans', 'embedded']]);
  });
});

describe('convert(): fontMap values that are not a family name (M6 Task 1 review)', () => {
  it('a whitespace-only, control-character-only or over-long value is ignored', async () => {
    const plain = await convert(PDF3);
    for (const to of [' ', '\t\n', '\u0001', '\u0001 \u007f', '￿', 'x'.repeat(300)]) {
      const out = await convert(PDF3, { fontMap: { DeckbackTest: to } });
      expect(Buffer.from(out.pptx).equals(Buffer.from(plain.pptx)), JSON.stringify(to)).toBe(true);
      expect(canonicalJson(out.report)).toBe(canonicalJson(plain.report));
    }
  });

  it('a hostile value is written escaped: no markup comes out of a family name', async () => {
    const to = '"/><a:x/>&amp;\'';
    const { pptx, report } = await convert(PDF3, { fontMap: { DeckbackTest: to } });
    const slide = partsOf(pptx)['ppt/slides/slide1.xml']!;
    expect(slide).not.toContain('<a:x/>');
    expect(slide).toContain('<a:latin typeface="&quot;/&gt;&lt;a:x/&gt;&amp;amp;');
    expect(report.fonts[0]!.mappedTo).toBe(to);
  });
});

describe('convert(): the report names the family each font is written with (M6 Task 3)', () => {
  const written = (pptx: Uint8Array): string => partsOf(pptx)['ppt/slides/slide1.xml']!;
  /** A font that is not embedded and is named only by a PostScript name: its latinName is MalgunGothic, its written family Malgun Gothic. */
  const PS_PDF = sizedPdf([{ size: [300, 200], content: 'BT /F2 24 Tf 20 100 Td (ABC) Tj ET' }], {
    fonts: '/F2 20 0 R',
    objects: [{ num: 20, body: '<< /Type /Font /Subtype /TrueType /BaseFont /MalgunGothic /Encoding /WinAnsiEncoding >>' }],
  });

  it('written is the typeface(s) the runs carry, validated by the schema', async () => {
    const { report } = await convert(PDF3);
    expect(report.fonts.map((f) => f.written)).toEqual([{ latin: 'DeckbackTest', ea: 'DeckbackTest' }]);
    expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(true);
  });

  it('differs from latin for a PostScript-named font, and that is the key a fontMap needs', async () => {
    const plain = await convert(PS_PDF);
    const font = plain.report.fonts.find((f) => f.latin === 'MalgunGothic');
    expect(font?.written?.latin).toBe('Malgun Gothic');
    expect(written(plain.pptx)).toContain('<a:latin typeface="Malgun Gothic"/>');
    // keyed by latin, the map does nothing; keyed by written it does
    const byLatin = await convert(PS_PDF, { fontMap: { MalgunGothic: 'Arial' } });
    expect(Buffer.from(byLatin.pptx).equals(Buffer.from(plain.pptx))).toBe(true);
    const byWritten = await convert(PS_PDF, { fontMap: { [font!.written!.latin!]: 'Arial' } });
    expect(written(byWritten.pptx)).toContain('<a:latin typeface="Arial"/>');
    expect(byWritten.report.fonts.find((f) => f.latin === 'MalgunGothic')?.mappedTo).toBe('Arial');
  });
});
