import type { OxRun } from '@deckback/ooxml';
import type { FontInfo } from '../scene/types';
import { typefaceFamily, type NamedFamily } from './names';

/** The typeface PowerPoint is given for a Type 3 font's text, whose glyphs are the PDF's own drawings. */
const TYPE3_TYPEFACE = 'Arial';

/**
 * `ConvertOptions.fontMap` (M6): a written typeface family to another family name. Unknown keys are ignored, as are a
 * name that is not a family name (`isFamilyName`) and the prototype's own keys.
 */
export type FontMap = Readonly<Record<string, string>>;

/** The longest family name a map may give: past it the value is ignored. */
const FAMILY_MAX = 256;
/** Controls (C0, DEL, C1) and the noncharacters U+FFFE and U+FFFF, which the writer leaves out of a name. */
const UNNAMED = /[\u0000-\u001f\u007f-\u009f\ufffe\uffff]/g;

/** Whether `name` can be a family: not over-long, and something is left of it once controls and blanks are taken out. */
const isFamilyName = (name: string): boolean => name.length <= FAMILY_MAX && name.replace(UNNAMED, '').trim() !== '';

/** The family `face` is written as under `map`: the mapped name, or `face` itself. The one place a map is applied. */
export function mapTypeface(face: string | null, map: FontMap | undefined): string | null {
  if (face === null || map === undefined || !Object.hasOwn(map, face)) return face;
  const to = map[face];
  return typeof to === 'string' && isFamilyName(to) ? to : face;
}

/** A name, or null for none or an empty one. */
const named = (name: string | null): string | null => (name === null || name === '' ? null : name);

/** A run's typefaces, and the style its font's name says (`typefaceFamily`). */
export interface Face extends Pick<OxRun, 'latin' | 'ea' | 'cs'> {
  named: NamedFamily | null;
}

/**
 * A run's typefaces: `latin` its font's family (`typefaceFamily`: its `latinName`, the family PowerPoint knows of a
 * font named only by its PostScript name, `MalgunGothic` as `Malgun Gothic` (M4 Task 3), else the base font without its
 * subset tag and style); `ea` its `eaName`, else `latin`; `cs` `latin`. An empty name is none, and no typeface is ever
 * empty (null instead). A Type 3 font's are all `Arial`. None for a font the deck does not hold. With a `map`
 * (`ConvertOptions.fontMap`) each of the three is then written as the family the map gives it.
 */
export function typefaces(font: FontInfo | undefined, map?: FontMap): Face {
  const face = unmappedTypefaces(font);
  if (map === undefined) return face;
  return { ...face, latin: mapTypeface(face.latin, map), ea: mapTypeface(face.ea, map), cs: mapTypeface(face.cs, map) };
}

function unmappedTypefaces(font: FontInfo | undefined): Face {
  if (font === undefined) return { latin: null, ea: null, cs: null, named: null };
  if (font.type3) return { latin: TYPE3_TYPEFACE, ea: TYPE3_TYPEFACE, cs: TYPE3_TYPEFACE, named: null };
  const family = typefaceFamily(font);
  const latin = named(family?.family ?? null);
  return { latin, ea: named(font.eaName) ?? latin, cs: latin, named: family };
}

