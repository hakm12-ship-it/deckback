import { describe, expect, it } from 'vitest';
import { eotOf, fontRefusal, fontStyle, fontTypefaces, trueTypeRefusal } from '../src/fonts/embed';
import type { FontInfo } from '../src/scene/types';
import { trueTypeFont, type NameRecord, type TrueTypeFont } from './helpers/sfnt';

/**
 * Font embedding (M4 Task 5, spec §7): which programs a PPTX may carry, and the EOT that carries them. PowerPoint 2024
 * was measured (task 5 report): it reads an uncompressed, unencrypted EOT 2.2 as Windows' t2embed writes one.
 */

const NAMES: NameRecord[] = [
  [1, 0, 0, 1, 'Mac Probe'],
  [3, 1, 0x409, 1, 'Probe Sans'],
  [3, 1, 0x409, 2, 'Regular'],
  [3, 1, 0x409, 4, 'Probe Sans Regular'],
  [3, 1, 0x409, 5, 'Version 1.000'],
  [3, 1, 0x412, 1, '프로브 산스'],
];
const font = (over: Partial<TrueTypeFont> = {}) => trueTypeFont({ names: NAMES, ...over });

describe('trueTypeRefusal: what a PPTX may carry', () => {
  it('fsType 0 (installable) and 8 (editable) are embedded; restricted, preview & print and bitmap-only never', () => {
    for (const fsType of [0, 8]) expect(trueTypeRefusal(font({ fsType }), false), `fsType ${fsType}`).toBeNull();
    // bit 1 alone, or with bit 0 or 7 only
    for (const fsType of [2, 3]) expect(trueTypeRefusal(font({ fsType }), false), `fsType ${fsType}`).toBe('fsType-restricted');
    // bit 2 (PowerPoint would open the deck read-only), alone or with bit 1
    for (const fsType of [4, 6]) expect(trueTypeRefusal(font({ fsType }), false), `fsType ${fsType}`).toBe('fsType-preview-print');
    expect(trueTypeRefusal(font({ fsType: 0x0200 }), false)).toBe('fsType-bitmap-only');
    expect(trueTypeRefusal(font({ fsType: 0x0208 }), false)).toBe('fsType-bitmap-only');
  });

  it('with more than one usage bit the least restrictive applies (OpenType): editable beats the others', () => {
    for (const fsType of [0x000a, 0x000c, 0x000e]) expect(trueTypeRefusal(font({ fsType }), false), `fsType ${fsType}`).toBeNull();
    // the other refusals stand
    expect(trueTypeRefusal(font({ fsType: 0x020a }), false)).toBe('fsType-bitmap-only');
    expect(trueTypeRefusal(font({ fsType: 0x010a }), true)).toBe('fsType-no-subsetting');
    expect(trueTypeRefusal(font({ fsType: 0x010a }), false)).toBeNull();
  });

  it('with the characters its runs show, every one must map through the Unicode cmap to a glyph with outlines, else incomplete', () => {
    const abc = [0x41, 0x42, 0x43];
    expect(trueTypeRefusal(font(), false, abc)).toBeNull();
    expect(trueTypeRefusal(font(), false, [])).toBeNull();
    expect(trueTypeRefusal(font(), false)).toBeNull(); // no characters given: not checked
    expect(trueTypeRefusal(font({ emptyGlyphs: [2] }), false, abc)).toBe('incomplete'); // B has no outlines
    expect(trueTypeRefusal(font({ emptyGlyphs: [2] }), false, [0x41, 0x43])).toBeNull(); // not shown
    expect(trueTypeRefusal(font(), false, [0x41, 0x44])).toBe('incomplete'); // D is not mapped
    expect(trueTypeRefusal(font(), false, [0x1f600])).toBe('incomplete'); // beyond the BMP subtable
    expect(trueTypeRefusal(font({ cmap: [[0, 3]] }), false, abc)).toBeNull(); // a Unicode platform subtable
    expect(trueTypeRefusal(font({ cmap: [[3, 10]] }), false, abc)).toBeNull();
    // a program without a Unicode cmap is incomplete with or without characters
    expect(trueTypeRefusal(font({ cmap: [[3, 0]] }), false, abc)).toBe('incomplete');
    // a blank may map to an empty glyph; a letter may not, and a blank must map
    expect(trueTypeRefusal(font({ space: 3, emptyGlyphs: [3] }), false, [0x20, 0x41])).toBeNull();
    expect(trueTypeRefusal(font({ space: 3, emptyGlyphs: [3] }), false, [0x20, 0x43])).toBe('incomplete');
    expect(trueTypeRefusal(font({ space: 0 }), false, [0x20])).toBe('incomplete');
    expect(trueTypeRefusal(font(), false, [0x20])).toBe('incomplete');
    expect(trueTypeRefusal(font({ space: 1 }), false, [0x20, 0x41])).toBeNull(); // a glyph with outlines is fine too
    // the refusal for fsType comes first
    expect(trueTypeRefusal(font({ fsType: 2, emptyGlyphs: [2] }), false, abc)).toBe('fsType-restricted');
  });

  it('fsType 0x100 (no subsetting) refuses only a subset, as the PDF carries one: its program is not the whole font', () => {
    expect(trueTypeRefusal(font({ fsType: 0x0100 }), true)).toBe('fsType-no-subsetting');
    expect(trueTypeRefusal(font({ fsType: 0x0108 }), true)).toBe('fsType-no-subsetting');
    expect(trueTypeRefusal(font({ fsType: 0x0100 }), false)).toBeNull();
    expect(trueTypeRefusal(font({ fsType: 0 }), true)).toBeNull();
  });

  it('a program without TrueType outlines is not-truetype: CFF, a bare CFF or Type 1 program, a collection, nothing', () => {
    expect(trueTypeRefusal(font({ cff: true }), false)).toBe('not-truetype');
    expect(trueTypeRefusal(font({ omit: ['glyf'] }), false)).toBe('not-truetype');
    expect(trueTypeRefusal(Uint8Array.from([1, 0, 4, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), false)).toBe('not-truetype'); // bare CFF
    expect(trueTypeRefusal(new TextEncoder().encode('%!PS-AdobeFont-1.0: Probe'), false)).toBe('not-truetype');
    const collection = font();
    new DataView(collection.buffer).setUint32(0, 0x74746366); // 'ttcf'
    expect(trueTypeRefusal(collection, false)).toBe('not-truetype');
    expect(trueTypeRefusal(new Uint8Array(0), false)).toBe('not-truetype');
  });

  it('a TrueType program short of a table Windows needs, of a Unicode cmap, or of its own bytes is incomplete', () => {
    for (const tag of ['OS/2', 'cmap', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'name', 'post']) {
      expect(trueTypeRefusal(font({ omit: [tag] }), false), tag).toBe('incomplete');
    }
    // a symbol cmap only (3, 0), or a Macintosh one: the text's Unicode would find other glyphs or none
    expect(trueTypeRefusal(font({ cmap: [[3, 0]] }), false)).toBe('incomplete');
    expect(trueTypeRefusal(font({ cmap: [[1, 0]] }), false)).toBe('incomplete');
    for (const cmap of [[[3, 10]], [[0, 3]], [[1, 0], [0, 4]]] as [number, number][][]) {
      expect(trueTypeRefusal(font({ cmap }), false), JSON.stringify(cmap)).toBeNull();
    }
    // the last table cut short
    const whole = font();
    expect(trueTypeRefusal(whole.subarray(0, whole.length - 8), false)).toBe('incomplete');
    // an OS/2 table shorter than the oldest version
    const short = font();
    const view = new DataView(short.buffer);
    for (let i = 0; i < view.getUint16(4); i++) if (view.getUint32(12 + 16 * i) === 0x4f532f32) view.setUint32(12 + 16 * i + 12, 60);
    expect(trueTypeRefusal(short, false)).toBe('incomplete');
  });
});

/** Reads an EOT header as the W3C EOT submission lays it out (little-endian), and the font data after it. */
function readEot(eot: Uint8Array) {
  const view = new DataView(eot.buffer, eot.byteOffset, eot.byteLength);
  let at = 0;
  const u8 = () => view.getUint8(at++);
  const u16 = () => ((at += 2), view.getUint16(at - 2, true));
  const u32 = () => ((at += 4), view.getUint32(at - 4, true));
  const text = () => {
    const padding = u16();
    const size = u16();
    let s = '';
    for (let i = 0; i < size; i += 2) s += String.fromCharCode(view.getUint16(at + i, true));
    at += size;
    return { padding, size, s };
  };
  const header = {
    eotSize: u32(),
    fontDataSize: u32(),
    version: u32(),
    flags: u32(),
    panose: Array.from({ length: 10 }, u8),
    charset: u8(),
    italic: u8(),
    weight: u32(),
    fsType: u16(),
    magic: u16(),
    unicodeRanges: [u32(), u32(), u32(), u32()],
    codePages: [u32(), u32()],
    checkSumAdjustment: u32(),
    reserved: [u32(), u32(), u32(), u32()],
    family: text(),
    style: text(),
    versionName: text(),
    fullName: text(),
    rootString: text(),
    rootStringCheckSum: u32(),
    eudcCodePage: u32(),
    padding6: u16(),
    signatureSize: u16(),
    eudcFlags: u32(),
    eudcFontSize: u32(),
  };
  return { header, data: eot.subarray(at) };
}

describe('eotOf: the font as PowerPoint reads a .fntdata', () => {
  const OS2 = {
    fsType: 8,
    weight: 700,
    fsSelection: 0x21, // ITALIC, BOLD
    panose: [2, 11, 6, 4, 2, 2, 2, 2, 2, 4],
    unicodeRanges: [0xe10002ff, 0x13d7e5ff, 0x04000011, 0x00100000] as [number, number, number, number],
    codePages: [0x2008019f, 0x80000000] as [number, number],
    checkSumAdjustment: 0x52c7368e,
  };

  it('is EOT 2.2, uncompressed and not XOR-ed, its fields from OS/2, head and name, then the program unchanged', () => {
    const program = font(OS2);
    const copy = program.slice();
    const eot = eotOf(program);
    const { header, data } = readEot(eot);
    expect(header).toEqual({
      eotSize: eot.length,
      fontDataSize: program.length,
      version: 0x00020002,
      flags: 0,
      panose: OS2.panose,
      charset: 1, // DEFAULT_CHARSET
      italic: 1,
      weight: 700,
      fsType: 8,
      magic: 0x504c,
      unicodeRanges: OS2.unicodeRanges,
      codePages: OS2.codePages,
      checkSumAdjustment: 0x52c7368e,
      reserved: [0, 0, 0, 0],
      // UTF-16LE, each with its terminating NUL counted, as t2embed writes them; the English Windows records
      family: { padding: 0, size: 22, s: 'Probe Sans\0' },
      style: { padding: 0, size: 16, s: 'Regular\0' },
      versionName: { padding: 0, size: 28, s: 'Version 1.000\0' },
      fullName: { padding: 0, size: 38, s: 'Probe Sans Regular\0' },
      rootString: { padding: 0, size: 0, s: '' },
      // the checksum of an empty root string: 0 XOR 0x50475342, as t2embed writes it (PowerPoint refuses 0)
      rootStringCheckSum: 0x50475342,
      eudcCodePage: 0,
      padding6: 0,
      signatureSize: 0,
      eudcFlags: 0,
      eudcFontSize: 0,
    });
    expect(data).toEqual(copy);
    expect(program, "the caller's bytes are not changed").toEqual(copy);
  });

  it('names: the English Windows record, else the first Windows one, else the Macintosh Roman English; none is a NUL', () => {
    const names = (records: NameRecord[]) => readEot(eotOf(trueTypeFont({ names: records }))).header;
    const korean = names([
      [1, 0, 0, 1, 'Mac Probe'],
      [3, 1, 0x412, 1, '프로브'],
      [3, 1, 0x412, 4, '프로브 보통'],
    ]);
    expect([korean.family.s, korean.style.s, korean.fullName.s]).toEqual(['프로브\0', '\0', '프로브 보통\0']);
    expect(names([[1, 0, 0, 1, 'Mac Probe']]).family.s).toBe('Mac Probe\0');
  });

  it('an OS/2 table of version 0 has no code page ranges: 0, 0; the italic is fsSelection bit 0 alone', () => {
    const { header } = readEot(eotOf(font({ fsSelection: 0x20 })));
    expect(header.codePages).toEqual([0, 0]);
    expect(header.italic).toBe(0);
  });

  it('refuses what trueTypeRefusal calls not TrueType or incomplete', () => {
    expect(() => eotOf(font({ cff: true }))).toThrow(/not-truetype/);
    expect(() => eotOf(font({ omit: ['name'] }))).toThrow(/incomplete/);
  });
});

describe('fontRefusal, fontStyle and fontTypefaces: a font of the deck', () => {
  const info = (over: Partial<FontInfo> = {}): FontInfo => ({
    key: 'f1',
    baseFont: 'ABCDEF+ProbeSans',
    latinName: 'Probe Sans',
    eaName: null,
    bold: false,
    italic: false,
    embedded: true,
    fsType: 0,
    isVariable: false,
    type3: false,
    metrics: null,
    ...over,
  });
  const file = { fileKind: 'FontFile2' as const, bytes: font(), ref: null };

  it('says why a font is not embedded: not in the PDF, Type 3, no program to read, then what its program says', () => {
    expect(fontRefusal(info({ embedded: false }), undefined)).toBe('not-in-pdf');
    expect(fontRefusal(info({ type3: true }), undefined)).toBe('type3');
    expect(fontRefusal(info(), undefined)).toBe('unreadable');
    expect(fontRefusal(info(), file)).toBeNull();
    expect(fontRefusal(info(), { fileKind: 'FontFile3', bytes: font({ cff: true }), ref: null })).toBe('not-truetype');
    // a subset (its tag) of a font that may not be subset; the same program whole is embedded
    const noSubsetting = { fileKind: 'FontFile2' as const, bytes: font({ fsType: 0x100 }), ref: null };
    expect(fontRefusal(info(), noSubsetting)).toBe('fsType-no-subsetting');
    expect(fontRefusal(info({ baseFont: 'ProbeSans' }), noSubsetting)).toBeNull();
  });

  it('its style is its own (nameID 2), and its typefaces those its runs are written with: latin, then its East Asian name', () => {
    expect(fontStyle(info())).toBe('regular');
    expect(fontStyle(info({ bold: true }))).toBe('bold');
    expect(fontStyle(info({ italic: true }))).toBe('italic');
    expect(fontStyle(info({ bold: true, italic: true }))).toBe('boldItalic');
    expect(fontTypefaces(info())).toEqual(['Probe Sans']);
    expect(fontTypefaces(info({ eaName: '프로브 산스' }))).toEqual(['Probe Sans', '프로브 산스']);
    expect(fontTypefaces(info({ eaName: 'Probe Sans' }))).toEqual(['Probe Sans']);
    // a program named by its PostScript name, which the family table knows: the run's typeface is the table's
    expect(fontTypefaces(info({ latinName: 'MalgunGothic' }))).toEqual(['Malgun Gothic']);
    expect(fontTypefaces(info({ latinName: null, baseFont: '' }))).toEqual([]);
  });
});
