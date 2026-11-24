import { describe, expect, it } from 'vitest';
import { readSfntMetrics, readSfntNames, readSymbolCmap } from '../src/fonts/sfnt';
import { cmapOf, hostileCmap, nameTable, os2Table, sfnt, testFont, type NameRecord } from './helpers/sfnt';

describe('readSfntNames', () => {
  it('M8 I2: a 32K-character name is cut to 256 characters and its control characters are stripped', () => {
    const long = 'A'.repeat(32000);
    const names = readSfntNames(sfnt([['name', nameTable([[3, 1, 0x409, 1, `\u0001${long}\u0000`], [3, 1, 0x409, 4, long], [3, 1, 0x409, 6, long], [3, 1, 0x409, 16, long], [3, 1, 0x409, 17, long]])]]));
    for (const record of [names.family, names.full, names.postscript, names.typoFamily, names.typoSubfamily]) expect(record[0x409]).toBe('A'.repeat(256));
  });

  const family: NameRecord[] = [
    [3, 1, 0x409, 1, 'Malgun Gothic'],
    [3, 1, 0x412, 1, '맑은 고딕'],
  ];

  it('reads family names of a name-only sfnt keyed by languageID', () => {
    const names = readSfntNames(sfnt([['name', nameTable(family)]]));
    expect(names.family).toEqual({ 1033: 'Malgun Gothic', 1042: '맑은 고딕' });
    expect(names.subfamily).toEqual({});
    expect(names.fsType).toBeNull();
  });

  it('reads subfamily names and ignores other platforms and other nameIDs', () => {
    const names = readSfntNames(
      sfnt([
        [
          'name',
          nameTable([
            ...family,
            [3, 1, 0x409, 2, 'Regular'],
            [3, 1, 0x409, 4, 'Malgun Gothic Regular'], // full name: not asked for
            [1, 0, 0, 1, 'Mac Family'], // Macintosh platform: not in `family`
            [0, 3, 0, 1, 'Unicode Family'], // Unicode platform: ignored
          ]),
        ],
      ]),
    );
    expect(names.family).toEqual({ 1033: 'Malgun Gothic', 1042: '맑은 고딕' });
    expect(names.subfamily).toEqual({ 1033: 'Regular' });
  });

  it('reads the Macintosh Roman English family and subfamily on their own', () => {
    const names = readSfntNames(
      sfnt([
        [
          'name',
          nameTable([
            [1, 0, 0, 1, 'Mac Family'],
            [1, 0, 0, 2, 'Bold'],
            [1, 0, 11, 1, 'Mac Japanese'], // another language: ignored
            [1, 1, 0, 1, 'Mac Other Script'], // another script: ignored
          ]),
        ],
      ]),
    );
    expect(names).toMatchObject({ family: {}, subfamily: {}, macFamily: 'Mac Family', macSubfamily: 'Bold' });
  });

  it('reads a Macintosh Roman string as Mac Roman, not as Latin-1', () => {
    // 0x8E is é, 0xA5 is • in Mac Roman (in Latin-1 they would be control characters and ¥).
    const names = readSfntNames(sfnt([['name', nameTable([[1, 0, 0, 1, 'Caf\u008e¥']])]]));
    expect(names.macFamily).toBe('Café•');
  });

  it('reads fsType from the OS/2 table', () => {
    const os2 = new Uint8Array(78);
    new DataView(os2.buffer).setUint16(8, 0x0008); // editable embedding
    const names = readSfntNames(sfnt([['OS/2', os2], ['name', nameTable(family)]]));
    expect(names.fsType).toBe(8);
    expect(names.family[1042]).toBe('맑은 고딕');
  });

  it('returns empty maps when there is no name table', () => {
    expect(readSfntNames(sfnt([['head', new Uint8Array(54)]]))).toEqual({
      family: {},
      subfamily: {},
      macFamily: null,
      macSubfamily: null,
      fsType: null,
      full: {},
      postscript: {},
      typoFamily: {},
      typoSubfamily: {},
    });
  });

  it('M8 round 1a: reads the full name (4), PostScript name (6) and typographic family and subfamily (16, 17) of Windows records', () => {
    const names = readSfntNames(
      sfnt([
        [
          'name',
          nameTable([
            [3, 1, 0x409, 1, '11'],
            [3, 1, 0x409, 4, '11'],
            [3, 1, 0x409, 6, 'Catamaran-Light'],
            [3, 1, 0x409, 16, 'Catamaran'],
            [3, 1, 0x409, 17, 'Light'],
            [1, 0, 0, 6, 'MacOnly'],
          ]),
        ],
      ]),
    );
    expect([names.family, names.full, names.postscript, names.typoFamily, names.typoSubfamily]).toEqual([
      { 1033: '11' },
      { 1033: '11' },
      { 1033: 'Catamaran-Light' },
      { 1033: 'Catamaran' },
      { 1033: 'Light' },
    ]);
  });

  it('throws a clear error for bytes that are not an sfnt', () => {
    expect(() => readSfntNames(new TextEncoder().encode('%!PS-AdobeFont-1.0: not sfnt'))).toThrow(/sfnt/);
    expect(() => readSfntNames(new Uint8Array(3))).toThrow(/sfnt/);
  });
});

describe('readSfntMetrics', () => {
  const names: NameRecord[] = [[3, 1, 0x409, 1, 'Deckback Test']];

  it('reads unitsPerEm, the hhea, win and typo ascent and descent, the line gaps and fsSelection, as the tables hold them', () => {
    const font = testFont({
      names,
      upm: 2048,
      hheaAsc: 1900,
      hheaDesc: -500,
      hheaLineGap: 67,
      typoAsc: 1800,
      typoDesc: -420,
      typoLineGap: 300,
      winAsc: 2100,
      winDesc: 600,
      fsSelection: 0xc0,
    });
    expect(readSfntMetrics(font)).toEqual({
      upm: 2048,
      hheaAsc: 1900,
      hheaDesc: -500,
      hheaLineGap: 67,
      winAsc: 2100,
      winDesc: 600,
      typoAsc: 1800,
      typoDesc: -420,
      typoLineGap: 300,
      fsSelection: 0xc0,
      isVariable: false,
    });
  });

  it('reads a negative line gap as the signed value the tables hold', () => {
    const m = readSfntMetrics(testFont({ names, hheaLineGap: -10, typoLineGap: -20 }));
    expect([m.hheaLineGap, m.typoLineGap, m.fsSelection]).toEqual([-10, -20, 0]);
  });

  it('says a font with an fvar table is variable', () => {
    expect(readSfntMetrics(testFont({ names, variable: true })).isVariable).toBe(true);
  });

  it('throws for a font without a table it reads, a truncated one, and bytes that are not an sfnt', () => {
    expect(() => readSfntMetrics(testFont({ names, noOs2: true }))).toThrow(/OS\/2/);
    expect(() => readSfntMetrics(sfnt([['OS/2', os2Table()], ['name', nameTable(names)]]))).toThrow(/head/);
    expect(() => readSfntMetrics(sfnt([['OS/2', os2Table().subarray(0, 68)], ['head', new Uint8Array(54)], ['hhea', new Uint8Array(36)]]))).toThrow(
      /OS\/2/,
    );
    expect(() => readSfntMetrics(new TextEncoder().encode('%!PS-AdobeFont-1.0: not sfnt'))).toThrow(/sfnt/);
  });
});

describe('readSymbolCmap (M8 round 1a: a symbol font names its glyphs by its own code)', () => {
  const names: NameRecord[] = [[3, 0, 0x409, 1, 'Wingdings']];
  const withCmap = (cmap: Uint8Array): Uint8Array => sfnt([['cmap', cmap], ['name', nameTable(names)]]);

  it("reads a Windows Symbol (3, 0) subtable as code to glyph: Wingdings' codes at U+F000 + code", () => {
    // as a PowerPoint export's Wingdings subset: 0xD8 (an arrowhead) is glyph 190, 0xA7 (a square) glyph 131
    const map = readSymbolCmap(withCmap(cmapOf([[3, 0]], [[0xf0a7, 0xf0a7, 131], [0xf0d7, 0xf0d8, 189]])));
    expect(map).toEqual(new Map([[0xf0a7, 131], [0xf0d7, 189], [0xf0d8, 190]]));
  });

  it('is null for a font with a Unicode subtable, even beside a symbol one, and for one without a cmap', () => {
    const ranges: [number, number, number][] = [[0xf041, 0xf043, 1]];
    expect(readSymbolCmap(withCmap(cmapOf([[3, 1]], ranges)))).toBeNull();
    expect(readSymbolCmap(withCmap(cmapOf([[1, 0], [3, 0], [3, 1]], ranges)))).toBeNull();
    expect(readSymbolCmap(withCmap(cmapOf([[0, 3], [3, 0]], ranges)))).toBeNull();
    expect(readSymbolCmap(sfnt([['name', nameTable(names)]]))).toBeNull();
  });

  it('reads the symbol subtable beside a Macintosh one, and leaves glyph 0 out', () => {
    const map = readSymbolCmap(withCmap(cmapOf([[1, 0], [3, 0]], [[0xf020, 0xf021, 0], [0xf041, 0xf041, 7]])));
    expect(map).toEqual(new Map([[0xf021, 1], [0xf041, 7]]));
  });

  it('throws for bytes that are not an sfnt', () => {
    expect(() => readSymbolCmap(new Uint8Array(3))).toThrow(/sfnt/);
  });

  it('M8 R8: needs a symbol family (the BaseFont, or nameID 1 or 16), and the symbolic flag or no Unicode subtable', () => {
    const ranges: [number, number, number][] = [[0xf041, 0xf041, 7]];
    const text = (cmap: Uint8Array): Uint8Array => sfnt([['cmap', cmap], ['name', nameTable([[3, 1, 0x409, 1, 'Microsoft Sans Serif']])]]);
    expect(readSymbolCmap(text(cmapOf([[1, 0], [3, 0]], ranges)))).toBeNull(); // a (3, 0) cmap alone is no proof
    expect(readSymbolCmap(text(cmapOf([[1, 0], [3, 0]], ranges)), { flagged: true })).toBeNull(); // nor is the flag
    expect(readSymbolCmap(text(cmapOf([[1, 0], [3, 0]], ranges)), { baseFont: 'ABCDEF+SymbolMT' })).toEqual(new Map([[0xf041, 7]])); // the BaseFont
    const typo = sfnt([['cmap', cmapOf([[3, 0]], ranges)], ['name', nameTable([[3, 1, 0x409, 1, '1'], [3, 1, 0x409, 16, 'Webdings']])]]);
    expect(readSymbolCmap(typo)).toEqual(new Map([[0xf041, 7]])); // nameID 16
    const both = sfnt([['cmap', cmapOf([[3, 0], [3, 1]], ranges)], ['name', nameTable([[3, 0, 0x409, 1, 'Wingdings 2']])]]);
    expect(readSymbolCmap(both)).toBeNull(); // a Unicode subtable, no flag
    expect(readSymbolCmap(both, { flagged: true })).toEqual(new Map([[0xf041, 7]]));
  });

  it('M8 I1: a hostile format 4 table (32,767 segments of 0..0xFFFE over zero glyph ids) is refused at once', () => {
    const font = sfnt([['cmap', hostileCmap()], ['name', nameTable(names)]]);
    const started = Date.now();
    expect(() => readSymbolCmap(font)).toThrow(/too costly/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
