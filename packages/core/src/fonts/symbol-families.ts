/**
 * The symbol font families (M8 ruling R8): a font is a symbol font, whose glyphs are named by its own codes (U+F000 +
 * code, `a:sym`), only when its family is one of these AND it is flagged symbolic or has a Windows Symbol (3, 0) `cmap`
 * and no Unicode one. The cmap alone is no proof: a Ghostscript-written Microsoft Sans Serif has one too.
 *
 * ONE list: harness/fonts/program.py reads this file (`symbol_families`, one quoted family a line between the markers),
 * so the converter and the harness' S2 agree on what is a symbol font; harness/fonts/test_symbol_families.py checks it.
 * Families the Office applications ship and PDF writers meet as symbol fonts, in their display names.
 */
// SYMBOL-FAMILIES-BEGIN
export const SYMBOL_FAMILIES: readonly string[] = [
  'Wingdings',
  'Wingdings 2',
  'Wingdings 3',
  'Webdings',
  'Symbol',
  'SymbolMT',
  'MT Extra',
  'Marlett',
  'Bookshelf Symbol 7',
  'Bookshelf Symbol Seven',
  'MS Reference Specialty',
  'MS Outlook',
  'Monotype Sorts',
  'ZapfDingbats',
  'ITC Zapf Dingbats',
  'OpenSymbol',
];
// SYMBOL-FAMILIES-END

/** A family key: lower case, letters and digits only (`MT-Extra` and `MT Extra` are one). */
const key = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, '');
const KEYS = new Set(SYMBOL_FAMILIES.map(key));
const SUBSET_TAG = /^[A-Z]{6}\+/;
const STYLE_TAIL = /[,-](?:regular|bold|italic|oblique|bolditalic|boldoblique|roman|normal)$/i;

/**
 * Whether `name` (a family, or a PostScript name such as `ABCDEF+Wingdings-Regular` or `SymbolMT`) is one of the symbol
 * families: its subset tag and style are taken off first. Null and the empty name are not.
 */
export function isSymbolFamily(name: string | null | undefined): boolean {
  if (name === null || name === undefined) return false;
  let bare = name.replace(SUBSET_TAG, '');
  for (let i = 0; i < 3 && STYLE_TAIL.test(bare); i++) bare = bare.replace(STYLE_TAIL, '');
  return KEYS.has(key(bare));
}
