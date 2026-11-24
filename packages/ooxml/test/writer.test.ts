import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PptxWriter, writePptx, type Emu, type OxSlide } from '../src';

const SIZE: [Emu, Emu] = [12192000, 6858000];
const EMPTY: OxSlide = { nodes: [], background: null };

/** The DOS date of 1980-01-01 (year 0 since 1980, month 1, day 1) and the DOS time of 00:00:00. */
const DOS_DATE_1980_01_01 = (0 << 9) | (1 << 5) | 1;
const DOS_TIME_MIDNIGHT = 0;

/** The parts every package starts with, in their order (Task 2 brief, "Zip"). */
const HEAD = [
  '_rels/.rels',
  'docProps/core.xml',
  'docProps/app.xml',
  'ppt/presentation.xml',
  'ppt/_rels/presentation.xml.rels',
  'ppt/presProps.xml',
  'ppt/theme/theme1.xml',
  'ppt/slideMasters/slideMaster1.xml',
  'ppt/slideMasters/_rels/slideMaster1.xml.rels',
  'ppt/slideLayouts/slideLayout1.xml',
  'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
];

const slideParts = (n: number) => [`ppt/slides/slide${n}.xml`, `ppt/slides/_rels/slide${n}.xml.rels`];

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  /** The DOS time and date fields of the central directory record and of the local header. */
  time: number;
  date: number;
  localTime: number;
  localDate: number;
  localOffset: number;
}

/** The entries of a zip as its central directory lists them, with each one's local header read too. */
function zipEntries(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.length - 22; // no archive comment
  expect(view.getUint32(eocd, true)).toBe(0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(at + 28, true);
    const localOffset = view.getUint32(at + 42, true);
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    entries.push({
      name: strFromU8(zip.subarray(at + 46, at + 46 + nameLength)),
      flags: view.getUint16(at + 8, true),
      method: view.getUint16(at + 10, true),
      time: view.getUint16(at + 12, true),
      date: view.getUint16(at + 14, true),
      localTime: view.getUint16(localOffset + 10, true),
      localDate: view.getUint16(localOffset + 12, true),
      localOffset,
    });
    at += 46 + nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
  }
  return entries;
}

function parts(pptx: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(pptx);
}

function partText(pptx: Uint8Array, name: string): string {
  const part = parts(pptx)[name];
  if (part === undefined) throw new Error(`no part ${name}`);
  return strFromU8(part);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** A media file and its key, the SHA-256 of its bytes in lower-case hex. */
function media(seed: number, length: number): { key: string; bytes: Uint8Array } {
  const bytes = Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 7) & 0xff);
  return { key: createHash('sha256').update(bytes).digest('hex'), bytes };
}

/**
 * Runs `fn` with the process in time zone `zone`. Node resets its zone cache when TZ is assigned but not when it is
 * deleted, so the zone in force before is assigned back first.
 */
function inZone<T>(zone: string, fn: () => T): T {
  const before = process.env.TZ;
  const zoneBefore = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    process.env.TZ = before ?? zoneBefore;
    if (before === undefined) delete process.env.TZ;
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe('PptxWriter', () => {
  it('two writes of the same input are byte-identical', () => {
    const a = media(1, 3000);
    const b = media(2, 500);
    const input = new Map([
      [a.key, { bytes: a.bytes, mime: 'image/png' as const }],
      [b.key, { bytes: b.bytes, mime: 'image/jpeg' as const }],
    ]);
    const slides = [EMPTY, EMPTY, EMPTY];

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2001-02-03T04:05:06Z'));
    const first = writePptx(SIZE, slides, input);
    vi.setSystemTime(new Date('2033-05-18T03:33:20Z'));
    const second = writePptx(SIZE, slides, input);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);

    // writePptx is the writer fed the media first, in map order, then the slides
    const writer = new PptxWriter(SIZE, slides.length);
    writer.addMedia(a.key, a.bytes, 'image/png');
    writer.addMedia(b.key, b.bytes, 'image/jpeg');
    for (const slide of slides) writer.addSlide(slide);
    expect(Buffer.from(writer.finish()).equals(Buffer.from(first))).toBe(true);
  });

  it('entries are in the fixed order and all carry the 1980-01-01 DOS time', () => {
    const a = media(1, 2000);
    const b = media(2, 700);
    const build = () => {
      const writer = new PptxWriter(SIZE, 3);
      writer.addMedia(a.key, a.bytes, 'image/png');
      writer.addSlide(EMPTY);
      writer.addMedia(b.key, b.bytes, 'image/jpeg');
      writer.addMedia(a.key, a.bytes, 'image/png'); // already there: no second entry
      writer.addSlide(EMPTY);
      writer.addSlide(EMPTY);
      return writer.finish();
    };
    // UTC+14 and UTC−11: a mtime built from UTC fields would read as 14:00 in the first and as 1979 in the second
    const decks = ['Pacific/Kiritimati', 'Pacific/Pago_Pago'].map((zone) => inZone(zone, build));
    expect(Buffer.from(decks[1]!).equals(Buffer.from(decks[0]!))).toBe(true);

    const entries = zipEntries(decks[0]!);
    expect(entries.map((e) => e.name)).toEqual([
      ...HEAD,
      `ppt/media/${a.key}.png`,
      ...slideParts(1),
      `ppt/media/${b.key}.jpeg`,
      ...slideParts(2),
      ...slideParts(3),
      '[Content_Types].xml',
    ]);
    const offsets = entries.map((e) => e.localOffset);
    expect(offsets).toEqual([...offsets].sort((x, y) => x - y)); // the local headers lie in the same order
    for (const entry of entries) {
      expect([entry.time, entry.date, entry.localTime, entry.localDate], entry.name).toEqual([
        DOS_TIME_MIDNIGHT,
        DOS_DATE_1980_01_01,
        DOS_TIME_MIDNIGHT,
        DOS_DATE_1980_01_01,
      ]);
      expect(entry.method, entry.name).toBe(8); // deflate
      expect(entry.flags & 0b110, entry.name).toBe(0); // fflate's "normal" deflate option, its flag for level 6
    }

    // the presentation lists the slides in addSlide order, through sequential r:ids
    const presentation = partText(decks[0]!, 'ppt/presentation.xml');
    const ids = [...presentation.matchAll(/<p:sldId id="(\d+)" r:id="(rId\d+)"\/>/g)].map((m) => [m[1], m[2]]);
    expect(ids).toEqual([
      ['256', 'rId4'],
      ['257', 'rId5'],
      ['258', 'rId6'],
    ]);
    const rels = partText(decks[0]!, 'ppt/_rels/presentation.xml.rels');
    for (const [n, rid] of [[1, 'rId4'], [2, 'rId5'], [3, 'rId6']] as const) {
      expect(rels).toContain(`Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${n}.xml"/>`);
    }
  });

  it('slide size is written as given and refused outside 914400..51206400', () => {
    for (const size of [[914400, 51206400], [51206400, 914400], SIZE] as [Emu, Emu][]) {
      const presentation = partText(writePptx(size, [EMPTY], new Map()), 'ppt/presentation.xml');
      expect(presentation).toContain(`<p:sldSz cx="${size[0]}" cy="${size[1]}"/>`);
    }
    const refused: [Emu, Emu][] = [
      [914399, 6858000],
      [6858000, 914399],
      [51206401, 6858000],
      [6858000, 51206401],
      [0, 0],
      [-9144000, 6858000],
      [9144000.5, 6858000],
      [Number.NaN, 6858000],
      [Number.POSITIVE_INFINITY, 6858000],
    ];
    for (const size of refused) {
      expect(() => new PptxWriter(size, 1), String(size)).toThrow(RangeError);
      expect(() => writePptx(size, [EMPTY], new Map()), String(size)).toThrow(RangeError);
    }
  });

  it('takes the slide count up front: a whole number from 0, refused otherwise', () => {
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new PptxWriter(SIZE, count), String(count)).toThrow(RangeError);
    }
    const none = partText(new PptxWriter(SIZE, 0).finish(), 'ppt/presentation.xml'); // a deck of no slides
    expect(none).not.toContain('sldIdLst');
  });

  it('a wrong number of slides throws: one too many at addSlide, too few at finish (the writer stays open)', () => {
    const writer = new PptxWriter(SIZE, 2);
    writer.addSlide(EMPTY);
    expect(() => writer.finish()).toThrow(/2 slides/);
    writer.addSlide(EMPTY);
    expect(() => writer.addSlide(EMPTY)).toThrow(/2 slides/);
    expect(partText(writer.finish(), 'ppt/presentation.xml').match(/<p:sldId /g)).toHaveLength(2);
  });

  it('media are named by key and listed once in [Content_Types]', () => {
    const png1 = media(1, 4000);
    const jpeg = media(2, 900);
    const png2 = media(3, 100);
    const original = png1.bytes.slice();
    const writer = new PptxWriter(SIZE, 1);
    writer.addMedia(png1.key, png1.bytes, 'image/png');
    writer.addMedia(jpeg.key, jpeg.bytes, 'image/jpeg');
    writer.addMedia(png2.key, png2.bytes, 'image/png');
    writer.addMedia(png1.key, png1.bytes, 'image/png'); // idempotent per key
    writer.addMedia(png1.key, jpeg.bytes, 'image/png'); // the key decides; these bytes are not written
    png1.bytes.fill(0); // the bytes went into the zip when added: the writer keeps no reference to them
    writer.addSlide(EMPTY);
    const pptx = writer.finish();

    const files = parts(pptx);
    expect(Object.keys(files).filter((name) => name.startsWith('ppt/media/'))).toEqual([
      `ppt/media/${png1.key}.png`,
      `ppt/media/${jpeg.key}.jpeg`,
      `ppt/media/${png2.key}.png`,
    ]);
    expect(files[`ppt/media/${png1.key}.png`]).toEqual(original);
    expect(files[`ppt/media/${jpeg.key}.jpeg`]).toEqual(jpeg.bytes);
    expect(files[`ppt/media/${png2.key}.png`]).toEqual(png2.bytes);

    const types = strFromU8(files['[Content_Types].xml']!);
    expect(occurrences(types, '<Default Extension="png" ContentType="image/png"/>')).toBe(1);
    expect(occurrences(types, '<Default Extension="jpeg" ContentType="image/jpeg"/>')).toBe(1);
    expect(occurrences(types, 'image/')).toBe(2);
    // a deck without media lists no picture type
    expect(partText(writePptx(SIZE, [EMPTY], new Map()), '[Content_Types].xml')).not.toContain('image/');
  });

  it('refuses a key that is not a part-name segment, a key added again with another type, and use after finish', () => {
    const writer = new PptxWriter(SIZE, 0);
    const png = media(1, 10);
    for (const key of ['', 'a/b', 'a.png', 'ABC', 'a b', '..', 'é']) {
      expect(() => writer.addMedia(key, png.bytes, 'image/png'), key).toThrow(/media key/);
    }
    writer.addMedia(png.key, png.bytes, 'image/png');
    expect(() => writer.addMedia(png.key, png.bytes, 'image/jpeg')).toThrow(/media key/);
    writer.finish();
    expect(() => writer.addSlide(EMPTY)).toThrow(/finished/);
    expect(() => writer.addMedia(media(2, 10).key, png.bytes, 'image/png')).toThrow(/finished/);
    expect(() => writer.finish()).toThrow(/finished/);
  });

  it('a slide background (ruling M3-R52) is p:bg/p:bgPr in p:cSld before the shape tree: its fill, then a:effectLst', () => {
    const slideXml = (slide: OxSlide) => strFromU8(parts(writePptx(SIZE, [slide], new Map()))['ppt/slides/slide1.xml']!);
    expect(slideXml({ nodes: [], background: { kind: 'solid', rgb: 'f2f2f2', alpha: 100000 } })).toContain(
      '<p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F2F2F2"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>' +
        '<p:spTree><p:nvGrpSpPr>',
    );
    // none: no p:bg, the master's shows
    expect(slideXml(EMPTY)).toContain('<p:cSld><p:spTree>');
    expect(slideXml(EMPTY)).not.toContain('<p:bg>');
    // a picture background takes its relationship from the slide, after the layout's
    const media = new Map([['abc', { bytes: Uint8Array.from([1, 2, 3]), mime: 'image/png' as const }]]);
    const pic = parts(
      writePptx(SIZE, [{ nodes: [], background: { kind: 'blip', media: 'abc', alpha: 100000, mode: { kind: 'stretch', fillRect: [0, 0, 0, 0] } } }], media),
    );
    expect(strFromU8(pic['ppt/slides/slide1.xml']!)).toContain('<p:bg><p:bgPr><a:blipFill rotWithShape="1"><a:blip r:embed="rId2"/>');
    expect(strFromU8(pic['ppt/slides/_rels/slide1.xml.rels']!)).toContain('Id="rId2"');
  });

  it("the master's background is noFill (M4 Task 4): a slide without p:bg exports no full-page fill and renders white", () => {
    const pptx = writePptx(SIZE, [EMPTY], new Map());
    const master = partText(pptx, 'ppt/slideMasters/slideMaster1.xml');
    expect(master).toContain('<p:cSld><p:bg><p:bgPr><a:noFill/><a:effectLst/></p:bgPr></p:bg><p:spTree>');
    expect(master).not.toContain('bgRef');
    // the theme keeps its three background fill styles (CT_BackgroundFillStyleList needs them)
    expect(partText(pptx, 'ppt/theme/theme1.xml')).toContain('<a:bgFillStyleLst>');
  });

  it('every part starts with the XML declaration and docProps/core.xml has the title deckback and no date', () => {
    const files = parts(writePptx(SIZE, [EMPTY], new Map()));
    for (const [name, bytes] of Object.entries(files)) {
      expect(strFromU8(bytes).startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'), name).toBe(true);
    }
    const core = strFromU8(files['docProps/core.xml']!);
    expect(core).toContain('<dc:title>deckback</dc:title>');
    expect(core).not.toMatch(/dcterms:(created|modified)|\d{4}-\d\d-\d\d/);
  });
});

describe('PptxWriter: embedded fonts (M4 Task 5, spec §7)', () => {
  const FONT_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/font';
  const SLIDE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
  const fntdata = (seed: number) => Uint8Array.from({ length: 300 + seed }, (_, i) => (i * 13 + seed) & 0xff);

  it('a deck without fonts lists none: no embeddedFontLst, no embedding switch, no fntdata type', () => {
    const pptx = writePptx(SIZE, [EMPTY], new Map());
    expect(partText(pptx, 'ppt/presentation.xml')).not.toMatch(/embeddedFont|embedTrueTypeFonts|saveSubsetFonts/);
    expect(partText(pptx, '[Content_Types].xml')).not.toContain('fntdata');
    expect(partText(pptx, 'ppt/_rels/presentation.xml.rels')).not.toContain(FONT_REL);
  });

  it('writes each font as ppt/fonts/font<n>.fntdata when added, listed by typeface with its styles in schema order', () => {
    const [a, b, c] = [fntdata(1), fntdata(2), fntdata(3)];
    const original = a.slice();
    const writer = new PptxWriter(SIZE, 2);
    writer.addSlide(EMPTY);
    expect(writer.addFont(b, ['Probe Sans'], 'bold')).toBe(true);
    expect(writer.addFont(a, ['Probe Sans', '프로브 산스'], 'regular')).toBe(true);
    a.fill(0); // the bytes went into the zip when added: the writer keeps no reference to them
    expect(writer.addFont(c, ['Other & Co'], 'italic')).toBe(true);
    writer.addSlide(EMPTY);
    const pptx = writer.finish();
    const files = parts(pptx);

    // the zip: each font where it was added, between the slides
    const names = zipEntries(pptx).map((e) => e.name);
    expect(names.slice(HEAD.length)).toEqual([
      ...slideParts(1),
      'ppt/fonts/font1.fntdata',
      'ppt/fonts/font2.fntdata',
      'ppt/fonts/font3.fntdata',
      ...slideParts(2),
      '[Content_Types].xml',
    ]);
    expect(files['ppt/fonts/font1.fntdata']).toEqual(b);
    expect(files['ppt/fonts/font2.fntdata']).toEqual(original);
    expect(files['ppt/fonts/font3.fntdata']).toEqual(c);

    // the presentation's relationships: the fonts after the slides, in part order
    expect(partText(pptx, 'ppt/_rels/presentation.xml.rels')).toContain(
      `<Relationship Id="rId5" Type="${SLIDE_REL}" Target="slides/slide2.xml"/>` +
        `<Relationship Id="rId6" Type="${FONT_REL}" Target="fonts/font1.fntdata"/>` +
        `<Relationship Id="rId7" Type="${FONT_REL}" Target="fonts/font2.fntdata"/>` +
        `<Relationship Id="rId8" Type="${FONT_REL}" Target="fonts/font3.fntdata"/></Relationships>`,
    );

    // the presentation: the switch PowerPoint keeps them by when it saves, and the list after p:notesSz, one
    // p:embeddedFont per typeface in the order first added, its styles regular, bold, italic, boldItalic; a font of two
    // typefaces (its latin and its East Asian name) is under both, by one r:id
    const presentation = partText(pptx, 'ppt/presentation.xml');
    expect(presentation).toMatch(/^<\?xml[^>]*>\n<p:presentation [^>]* embedTrueTypeFonts="1" saveSubsetFonts="1">/);
    expect(presentation).toContain(
      '<p:notesSz cx="6858000" cy="9144000"/><p:embeddedFontLst>' +
        '<p:embeddedFont><p:font typeface="Probe Sans"/><p:regular r:id="rId7"/><p:bold r:id="rId6"/></p:embeddedFont>' +
        '<p:embeddedFont><p:font typeface="프로브 산스"/><p:regular r:id="rId7"/></p:embeddedFont>' +
        '<p:embeddedFont><p:font typeface="Other &amp; Co"/><p:italic r:id="rId8"/></p:embeddedFont>' +
        '</p:embeddedFontLst><p:defaultTextStyle>',
    );

    const types = partText(pptx, '[Content_Types].xml');
    expect(occurrences(types, '<Default Extension="fntdata" ContentType="application/x-fontdata"/>')).toBe(1);
  });

  it('a style a typeface has already is not added again: false, and nothing is written', () => {
    const writer = new PptxWriter(SIZE, 1);
    expect(writer.addFont(fntdata(1), ['Probe Sans'], 'regular')).toBe(true);
    expect(writer.addFont(fntdata(2), ['Probe Sans'], 'regular')).toBe(false);
    // one of its typefaces taken is enough
    expect(writer.addFont(fntdata(3), ['Probe Mono', 'Probe Sans'], 'regular')).toBe(false);
    expect(writer.addFont(fntdata(4), ['Probe Sans'], 'boldItalic')).toBe(true);
    writer.addSlide(EMPTY);
    const files = parts(writer.finish());
    expect(Object.keys(files).filter((name) => name.startsWith('ppt/fonts/'))).toEqual(['ppt/fonts/font1.fntdata', 'ppt/fonts/font2.fntdata']);
    expect(files['ppt/fonts/font2.fntdata']).toEqual(fntdata(4));
    expect(strFromU8(files['ppt/presentation.xml']!)).toContain(
      '<p:embeddedFontLst><p:embeddedFont><p:font typeface="Probe Sans"/><p:regular r:id="rId5"/><p:boldItalic r:id="rId6"/>' +
        '</p:embeddedFont></p:embeddedFontLst>',
    );
  });

  it('typefaces are as a run writes them: what XML refuses dropped, each once; none left is an error, as is use after finish', () => {
    const writer = new PptxWriter(SIZE, 1);
    expect(writer.addFont(fntdata(1), ['A\u0001b', 'Ab', 'Ab'], 'regular')).toBe(true);
    expect(writer.addFont(fntdata(2), ['Ab'], 'regular')).toBe(false);
    // fixed words: the message names no typeface (a font's names are the deck's; privacy, spec §8)
    for (const faces of [[], [''], ['\u0002'], ['\uD800\u0003']]) {
      expect(() => writer.addFont(fntdata(3), faces, 'bold'), JSON.stringify(faces)).toThrow(/^no typeface to embed a font as$/);
    }
    writer.addSlide(EMPTY);
    const presentation = strFromU8(parts(writer.finish())['ppt/presentation.xml']!);
    expect(presentation).toContain('<p:embeddedFontLst><p:embeddedFont><p:font typeface="Ab"/><p:regular r:id="rId5"/></p:embeddedFont></p:embeddedFontLst>');
    expect(() => writer.addFont(fntdata(4), ['Late'], 'regular')).toThrow(/finished/);
  });

  it('the same calls give the same bytes', () => {
    const build = () => {
      const writer = new PptxWriter(SIZE, 1);
      writer.addFont(fntdata(1), ['Probe Sans'], 'regular');
      writer.addFont(fntdata(2), ['Probe Sans'], 'bold');
      writer.addSlide(EMPTY);
      return writer.finish();
    };
    expect(Buffer.from(build()).equals(Buffer.from(build()))).toBe(true);
  });
});

/**
 * The module specifiers a source file names: every `import ... from`, bare `import '...'`, `export ... from` and
 * `import(...)`, and every `require(` (whatever it is given).
 */
function specifiers(text: string): string[] {
  const found: string[] = [];
  const pattern = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]?([^'")]*)/g;
  for (const [, imported, required] of text.matchAll(pattern)) found.push(required !== undefined ? `require(${required})` : imported!);
  return found;
}

/** What `file` (a path under src/) may not import: anything but fflate and the package's own src files. */
function forbiddenImports(file: string, text: string): string[] {
  return specifiers(text).filter((spec) => {
    if (spec === 'fflate') return false;
    if (!spec.startsWith('./') && !spec.startsWith('../')) return true;
    return posix.normalize(posix.join(posix.dirname(file), spec)).startsWith('../');
  });
}

describe('the writer runs everywhere', () => {
  const srcDir = new URL('../src/', import.meta.url);

  it('the scan finds every import that is not fflate or a file of src', () => {
    const caught: [string, string, string[]][] = [
      ['writer.ts', "import { readFileSync } from 'node:fs';", ['node:fs']],
      ['writer.ts', "import 'fs';", ['fs']],
      ['writer.ts', "export { createHash } from 'crypto';", ['crypto']],
      ['writer.ts', "const m = await import('node:module');", ['node:module']],
      ['writer.ts', "const fs = require('fs');", ['require(fs)']],
      ['writer.ts', "import { extractScene } from '@deckback/core';", ['@deckback/core']],
      ['writer.ts', "import type * as Pdfjs from 'pdfjs-dist';", ['pdfjs-dist']],
      ['writer.ts', "import { gunzipSync } from 'fflate/node';", ['fflate/node']],
      ['writer.ts', "import { x } from '../../core/src/index';", ['../../core/src/index']],
      ['shapes/fill.ts', "import { x } from '../../test/helpers/validate';", ['../../test/helpers/validate']],
    ];
    for (const [file, text, expected] of caught) expect(forbiddenImports(file, text), text).toEqual(expected);
    const fine: [string, string][] = [
      ['writer.ts', "import { Zip, ZipDeflate } from 'fflate';"],
      ['writer.ts', "import type { OxSlide } from './model';"],
      ['shapes/fill.ts', "import { esc } from '../xml';"],
      ['writer.ts', '// the path of a file'],
    ];
    for (const [file, text] of fine) expect(forbiddenImports(file, text), text).toEqual([]);
  });

  it('nothing in src imports anything but fflate and its own files', () => {
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => file.replaceAll('\\', '/'));
    expect(files).toEqual(expect.arrayContaining(['index.ts', 'model.ts', 'parts.ts', 'writer.ts', 'xml.ts', 'zip.ts']));
    for (const file of files) expect(forbiddenImports(file, readFileSync(new URL(file, srcDir), 'utf8')), file).toEqual([]);
  });

  it('the package depends on fflate 0.8.3 alone', () => {
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
    expect(manifest.dependencies).toEqual({ fflate: '0.8.3' });
    for (const field of ['devDependencies', 'peerDependencies', 'optionalDependencies']) expect(manifest[field], field).toBeUndefined();
  });
});
