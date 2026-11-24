import { readFileSync } from 'node:fs';
import Ajv, { type ValidateFunction } from 'ajv';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { codePointsOf, convert } from '../src/convert';
import { eotOf, FONT_SKIPS } from '../src/fonts/embed';
import { REPORT_SCHEMA } from '../src/report/types';
import { canonicalJson } from '../src/scene/canonical';
import { extractScene } from '../src/scene/extract';
import { embeddedTrueType, partsOf, sizedPdf } from './helpers/pptx';
import { trueTypeFont, type NameRecord } from './helpers/sfnt';
import { slideOf, textline } from './helpers/passes';

/**
 * `convert(bytes, { embedFonts: true })` (M4 Task 5, spec §7): the TrueType programs the PDF carries go into the PPTX as
 * `ppt/fonts/font<n>.fntdata` (EOT), listed in `p:embeddedFontLst` under the typefaces the runs are written with, those
 * whose fsType allows it only; the report says what became of every font (Review Focus 4). Off by default. The
 * validator's verdict: convert.local.test.ts; a font first used on a slide that could not be written:
 * convert.faults.test.ts; PowerPoint: harness/ppt/test_font_embedding.py.
 */

const REPORT_JSON_SCHEMA = JSON.parse(readFileSync(new URL('../src/report/report.schema.json', import.meta.url), 'utf8')) as {
  properties: { fonts: { items: { required: string[]; properties: { pptxEmbedding: { enum: string[] } } } } };
};
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(REPORT_JSON_SCHEMA);
const validateReport = ajv.getSchema(REPORT_SCHEMA) as ValidateFunction;

it('the schema lists every embedding outcome, and does not require it (a report without embedFonts has none)', () => {
  const font = REPORT_JSON_SCHEMA.properties.fonts.items;
  expect(font.properties.pptxEmbedding.enum).toEqual(['embedded', ...FONT_SKIPS]);
  expect(font.required).not.toContain('pptxEmbedding');
});

const names = (family: string, style: string, korean?: string): NameRecord[] => [
  [3, 1, 0x409, 1, family],
  [3, 1, 0x409, 2, style],
  [3, 1, 0x409, 4, `${family} ${style}`],
  ...(korean === undefined ? [] : ([[3, 1, 0x412, 1, korean]] as NameRecord[])),
];

const PROGRAMS = {
  regular: trueTypeFont({ names: names('Probe Sans', 'Regular', '프로브 산스'), fsType: 0 }),
  bold: trueTypeFont({ names: names('Probe Sans', 'Bold'), fsType: 8, weight: 700, fsSelection: 0x20 }),
  restricted: trueTypeFont({ names: names('Locked Sans', 'Regular'), fsType: 2 }),
  preview: trueTypeFont({ names: names('Preview Sans', 'Regular'), fsType: 4 }),
  again: trueTypeFont({ names: names('Probe Sans', 'Regular'), fsType: 0, checkSumAdjustment: 7 }),
};

/**
 * One page, a line of `ABC` per font, in this order: Probe Sans Regular (fsType 0, with a Korean family name), Probe
 * Sans Bold (fsType 8), Locked Sans (2), Preview Sans (4), the test font that is not embedded, a second subset of
 * Probe Sans Regular, and a font dict of another name whose descriptor holds the first font's program stream (as an
 * Office export's Type0 and TrueType pair do).
 */
const FONTS = ['F2', 'F3', 'F4', 'F5', 'F1', 'F7', 'F8'];
const PDF = sizedPdf([{ size: [960, 540], content: FONTS.map((f, i) => `BT /${f} 24 Tf 20 ${480 - 60 * i} Td (ABC) Tj ET`).join(' ') }], {
  fonts: '/F2 20 0 R /F3 30 0 R /F4 40 0 R /F5 50 0 R /F7 70 0 R /F8 80 0 R',
  objects: [
    ...embeddedTrueType(20, 'ABCDEF+ProbeSans', PROGRAMS.regular),
    ...embeddedTrueType(30, 'BCDEFG+ProbeSans-Bold', PROGRAMS.bold),
    ...embeddedTrueType(40, 'CDEFGH+LockedSans', PROGRAMS.restricted),
    ...embeddedTrueType(50, 'DEFGHI+PreviewSans', PROGRAMS.preview),
    ...embeddedTrueType(70, 'EFGHIJ+ProbeSans', PROGRAMS.again),
    ...embeddedTrueType(80, 'ABCDEF+ProbeSans,Shared', PROGRAMS.regular).slice(0, 2).map((o) => ('body' in o ? { ...o, body: o.body.replace('/FontFile2 82 0 R', '/FontFile2 22 0 R') } : o)),
  ],
});

const FONT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font';
const fontParts = (pptx: Uint8Array) => Object.keys(partsOf(pptx)).filter((name) => name.startsWith('ppt/fonts/'));

describe('convert(): fonts embedded on request (M4 Task 5)', () => {
  it('is off by default: no font part, no embedding field in the report, the same bytes as embedFonts false', async () => {
    const plain = await convert(PDF);
    const off = await convert(PDF, { embedFonts: false });
    expect(Buffer.from(off.pptx).equals(Buffer.from(plain.pptx))).toBe(true);
    expect(canonicalJson(off.report)).toBe(canonicalJson(plain.report));
    expect(fontParts(plain.pptx)).toEqual([]);
    const parts = partsOf(plain.pptx);
    expect(parts['ppt/presentation.xml']).not.toMatch(/embeddedFont|embedTrueTypeFonts/);
    expect(parts['[Content_Types].xml']).not.toContain('fntdata');
    for (const font of plain.report.fonts) expect(Object.keys(font)).toEqual(['key', 'latin', 'ea', 'embedded', 'type3', 'written']);
  });

  it('embeds the TrueType programs fsType allows, as EOT, under the typefaces their runs are written with', async () => {
    const { pptx, report } = await convert(PDF, { embedFonts: true });
    const parts = partsOf(pptx);
    expect(fontParts(pptx)).toEqual(['ppt/fonts/font1.fntdata', 'ppt/fonts/font2.fntdata']);
    const raw = unzipSync(pptx);
    expect(raw['ppt/fonts/font1.fntdata']).toEqual(eotOf(PROGRAMS.regular));
    expect(raw['ppt/fonts/font2.fntdata']).toEqual(eotOf(PROGRAMS.bold));

    // the report: every font, in key order, with what became of it
    expect(report.fonts.map((f) => [f.latin, f.ea, f.pptxEmbedding])).toEqual([
      ['Probe Sans', '프로브 산스', 'embedded'],
      ['Probe Sans', null, 'embedded'],
      ['Locked Sans', null, 'fsType-restricted'],
      ['Preview Sans', null, 'fsType-preview-print'],
      ['DeckbackTest', null, 'not-in-pdf'],
      ['Probe Sans', null, 'same-face'],
      ['Probe Sans', '프로브 산스', 'embedded'], // the first font's program: no part of its own
    ]);
    expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(true);

    // one slide (rId4), then the fonts in the order first used (rId5, rId6); the regular one under both its names
    expect(parts['ppt/_rels/presentation.xml.rels']).toContain(
      `<Relationship Id="rId5" Type="${FONT_REL}" Target="fonts/font1.fntdata"/><Relationship Id="rId6" Type="${FONT_REL}" Target="fonts/font2.fntdata"/>`,
    );
    expect(parts['ppt/presentation.xml']).toContain(
      '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Probe Sans"/><p:regular r:id="rId5"/><p:bold r:id="rId6"/></p:embeddedFont>' +
        '<p:embeddedFont><p:font typeface="프로브 산스"/><p:regular r:id="rId5"/></p:embeddedFont></p:embeddedFontLst>',
    );
    expect(parts['[Content_Types].xml']).toContain('<Default Extension="fntdata" ContentType="application/x-fontdata"/>');

    // the runs name the typefaces the list has: the regular font's latin and East Asian names, the bold one bold
    const slide = parts['ppt/slides/slide1.xml']!;
    expect(slide).toContain('<a:latin typeface="Probe Sans"/><a:ea typeface="프로브 산스"/><a:cs typeface="Probe Sans"/>');
    expect(slide).toMatch(/b="1"[^>]*>(?:<[^>]*>)*<a:latin typeface="Probe Sans"\/><a:ea typeface="Probe Sans"\/>/);
  });

  it('the same PDF and options give the same bytes; the Scene is the one extractScene makes', async () => {
    const first = await convert(PDF, { embedFonts: true, scene: true });
    const second = await convert(PDF, { embedFonts: true });
    expect(Buffer.from(second.pptx).equals(Buffer.from(first.pptx))).toBe(true);
    expect(canonicalJson(second.report)).toBe(canonicalJson(first.report));
    const { scene } = await extractScene(PDF);
    expect(canonicalJson(first.scene)).toBe(canonicalJson(scene));
  });

  it('a page subset embeds only the fonts of the pages converted', async () => {
    const two = sizedPdf(
      [
        { size: [960, 540], content: 'BT /F2 24 Tf 20 480 Td (ABC) Tj ET' },
        { size: [960, 540], content: 'BT /F3 24 Tf 20 480 Td (ABC) Tj ET' },
      ],
      { fonts: '/F2 20 0 R /F3 30 0 R', objects: [...embeddedTrueType(20, 'ABCDEF+ProbeSans', PROGRAMS.regular), ...embeddedTrueType(30, 'BCDEFG+ProbeSans-Bold', PROGRAMS.bold)] },
    );
    const { pptx, report } = await convert(two, { embedFonts: true, pages: [1] });
    expect(fontParts(pptx)).toEqual(['ppt/fonts/font1.fntdata']);
    expect(unzipSync(pptx)['ppt/fonts/font1.fntdata']).toEqual(eotOf(PROGRAMS.bold));
    expect(report.fonts.map((f) => [f.latin, f.pptxEmbedding])).toEqual([['Probe Sans', 'embedded']]);
    expect(partsOf(pptx)['ppt/presentation.xml']).toContain('<p:embeddedFont><p:font typeface="Probe Sans"/><p:bold r:id="rId5"/></p:embeddedFont>');
  });

  it('a font whose names leave the writer no typeface to list it by is `incomplete`; its slide and the other fonts are written', async () => {
    // a family name made only of characters XML refuses (lone surrogates; control characters are stripped when the name is read, M8 I2): the writer's addFont has no typeface left and throws
    const control = trueTypeFont({ names: names('\ud800\udbff', 'Regular'), fsType: 0 });
    const pdf = sizedPdf([{ size: [960, 540], content: 'BT /F2 24 Tf 20 480 Td (ABC) Tj ET BT /F3 24 Tf 20 420 Td (ABC) Tj ET' }], {
      fonts: '/F2 20 0 R /F3 30 0 R',
      objects: [...embeddedTrueType(20, 'ABCDEF+Control', control), ...embeddedTrueType(30, 'BCDEFG+ProbeSans-Bold', PROGRAMS.bold)],
    });
    for (const strict of [false, true]) {
      const { pptx, report } = await convert(pdf, { embedFonts: true, strict });
      expect(report.fonts.map((f) => f.pptxEmbedding), String(strict)).toEqual(['incomplete', 'embedded']);
      expect(fontParts(pptx)).toEqual(['ppt/fonts/font1.fntdata']);
      expect(unzipSync(pptx)['ppt/fonts/font1.fntdata']).toEqual(eotOf(PROGRAMS.bold));
      expect(report.slides[0]!.failed).toBeNull();
      expect(validateReport(report), JSON.stringify(validateReport.errors)).toBe(true);
    }
  });

  it('a font whose cmap leaves a shown character without outlines is `incomplete`; one that shows only characters it draws is embedded', async () => {
    // B has no outlines in the program: the run shows ABC, the other font's run shows AC
    const hollow = trueTypeFont({ names: names('Hollow Sans', 'Regular'), fsType: 0, emptyGlyphs: [2] });
    const pdf = sizedPdf([{ size: [960, 540], content: 'BT /F2 24 Tf 20 480 Td (ABC) Tj ET BT /F3 24 Tf 20 420 Td (AC) Tj ET' }], {
      fonts: '/F2 20 0 R /F3 30 0 R',
      objects: [...embeddedTrueType(20, 'ABCDEF+HollowSans', hollow), ...embeddedTrueType(30, 'BCDEFG+ProbeSans-Bold', PROGRAMS.bold)],
    });
    const { pptx, report } = await convert(pdf, { embedFonts: true });
    expect(report.fonts.map((f) => f.pptxEmbedding)).toEqual(['incomplete', 'embedded']);
    expect(fontParts(pptx)).toEqual(['ppt/fonts/font1.fntdata']);
    const hollowOnly = sizedPdf([{ size: [960, 540], content: 'BT /F2 24 Tf 20 480 Td (AC) Tj ET' }], {
      fonts: '/F2 20 0 R',
      objects: embeddedTrueType(20, 'ABCDEF+HollowSans', hollow),
    });
    expect((await convert(hollowOnly, { embedFonts: true })).report.fonts.map((f) => f.pptxEmbedding)).toEqual(['embedded']);
  });

  it('M4b Task 3 (b): characters never drawn (Unicode categories Cc and Cf) need no outlines', () => {
    const el = textline({ runs: [{ ...textline().runs[0]!, text: 'A\u200bB\u00ad\u0007C\u202e', fontKey: 'f1' }] });
    const other = textline({ runs: [{ ...textline().runs[0]!, text: '\u200b?', fontKey: 'f2' }] });
    const slide = slideOf([el, other]);
    expect([...codePointsOf(slide, 'f1')]).toEqual(['A', 'B', 'C'].map((c) => c.codePointAt(0)));
    expect([...codePointsOf(slide, 'f2')]).toEqual([0x3f]);
  });

  it('final review Minor 3: the skipped Cf code points are a fixed list: one of each listed range, none beside it', () => {
    const listed = [0x7f, 0x9f, 0xad, 0x600, 0x605, 0x61c, 0x6dd, 0x70f, 0x180e, 0x200b, 0x200f, 0x202a, 0x2060, 0x2064, 0x2066, 0x206f, 0xfeff, 0xfff9, 0xfffb];
    const beside = [0x20, 0xa0, 0xae, 0x606, 0x61b, 0x6de, 0x710, 0x180d, 0x2010, 0x2029, 0x2065, 0x2070, 0xfefe, 0xfff8, 0xfffc];
    const el = textline({ runs: [{ ...textline().runs[0]!, text: String.fromCodePoint(...listed, ...beside), fontKey: 'f1' }] });
    expect([...codePointsOf(slideOf([el]), 'f1')]).toEqual(beside);
  });

  it('M4b: a program refused-or-embedded is cached per program, the outcome same-face is not: a later dict of that program is judged on its own', async () => {
    // f1 (F2) is Probe Sans Regular and is embedded; f2 (F7) is another program under the same names, so on page 1 it is
    // same-face; f3 (F9) shares f2's program and shows B, which that program does not draw: on page 2 it is its own decision
    const hollow = trueTypeFont({ names: names('Probe Sans', 'Regular'), fsType: 0, emptyGlyphs: [2] });
    const pdf = sizedPdf(
      [
        { size: [960, 540], content: 'BT /F2 24 Tf 20 480 Td (ABC) Tj ET BT /F7 24 Tf 20 420 Td (AC) Tj ET' },
        { size: [960, 540], content: 'BT /F9 24 Tf 20 480 Td (ABC) Tj ET' },
      ],
      {
        fonts: '/F2 20 0 R /F7 80 0 R /F9 90 0 R',
        objects: [
          ...embeddedTrueType(20, 'ABCDEF+ProbeSans', PROGRAMS.regular),
          ...embeddedTrueType(80, 'EFGHIJ+ProbeSans', hollow),
          ...embeddedTrueType(90, 'FGHIJK+ProbeSans,Shared', hollow).slice(0, 2).map((o) => ('body' in o ? { ...o, body: o.body.replace('/FontFile2 92 0 R', '/FontFile2 82 0 R') } : o)),
        ],
      },
    );
    const { report } = await convert(pdf, { embedFonts: true });
    expect(Object.fromEntries(report.fonts.map((f) => [f.key, f.pptxEmbedding]))).toEqual({ f1: 'embedded', f2: 'same-face', f3: 'incomplete' });
  });

  describe('two font dicts that share one program are decided once, over the characters of both', () => {
    // B has no outlines in the program; F3's dict has its own name and the program stream of F2's (object 22)
    const hollow = trueTypeFont({ names: names('Hollow Sans', 'Regular'), fsType: 0, emptyGlyphs: [2] });
    const shared = (first: string, second: string) =>
      sizedPdf([{ size: [960, 540], content: `BT /F2 24 Tf 20 480 Td (${first}) Tj ET BT /F3 24 Tf 20 420 Td (${second}) Tj ET` }], {
        fonts: '/F2 20 0 R /F3 80 0 R',
        objects: [
          ...embeddedTrueType(20, 'ABCDEF+HollowSans', hollow),
          ...embeddedTrueType(80, 'ABCDEF+HollowSans,Shared', hollow).slice(0, 2).map((o) => ('body' in o ? { ...o, body: o.body.replace('/FontFile2 82 0 R', '/FontFile2 22 0 R') } : o)),
        ],
      });

    it('one dict shows a character the program does not draw: neither is embedded, in either order', async () => {
      for (const [a, b] of [['ABC', 'AC'], ['AC', 'ABC']] as const) {
        const { pptx, report } = await convert(shared(a, b), { embedFonts: true });
        expect(report.fonts.map((f) => f.pptxEmbedding), `${a} ${b}`).toEqual(['incomplete', 'incomplete']);
        expect(fontParts(pptx)).toEqual([]);
      }
    });

    it('both dicts show only characters it draws: the program is embedded once', async () => {
      const { pptx, report } = await convert(shared('AC', 'A'), { embedFonts: true });
      expect(report.fonts.map((f) => f.pptxEmbedding)).toEqual(['embedded', 'embedded']);
      expect(fontParts(pptx)).toEqual(['ppt/fonts/font1.fntdata']);
    });
  });

  it('a damaged program is incomplete and the conversion goes on, in either mode', async () => {
    const good = trueTypeFont({ names: names('Damaged Sans', 'Regular'), fsType: 0 });
    const dir = (bytes: Uint8Array, tag: string): number => {
      for (let at = 12; at < 12 + 16 * new DataView(bytes.buffer).getUint16(4); at += 16) if (String.fromCharCode(...bytes.subarray(at, at + 4)) === tag) return at;
      throw new Error(tag);
    };
    const damaged = {
      shortMaxp: (b: Uint8Array) => { const v = new DataView(b.buffer); v.setUint32(dir(b, 'maxp') + 8, b.length - 2); v.setUint32(dir(b, 'maxp') + 12, 2); },
      cmapPastEnd: (b: Uint8Array) => { const v = new DataView(b.buffer); const at = new DataView(b.buffer).getUint32(dir(b, 'cmap') + 8) + 8; v.setUint32(at, 0xffff0000); },
      shortLoca: (b: Uint8Array) => new DataView(b.buffer).setUint32(dir(b, 'loca') + 12, 4),
    };
    for (const [name, damage] of Object.entries(damaged)) {
      const program = Uint8Array.from(good);
      damage(program);
      const pdf = sizedPdf([{ size: [960, 540], content: 'BT /F2 24 Tf 20 480 Td (ABC) Tj ET' }], { fonts: '/F2 20 0 R', objects: embeddedTrueType(20, 'ABCDEF+DamagedSans', program) });
      for (const strict of [false, true]) {
        const { pptx, report } = await convert(pdf, { embedFonts: true, strict });
        expect(report.fonts.map((f) => f.pptxEmbedding), `${name} ${strict}`).toEqual(['incomplete']);
        expect(fontParts(pptx)).toEqual([]);
        expect(report.slides[0]!.failed).toBeNull();
      }
    }
  });
});
