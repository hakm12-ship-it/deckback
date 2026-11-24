/**
 * Whether a font family seems to be installed, for the report's fonts (spec §7: the web checks only as far as the
 * browser allows). A hint, and the page labels it as one: the text is measured in the family with a generic family
 * behind it, and in the generic family alone; a family the browser does not have falls back to the generic one, so the
 * widths are the same. Browsers that hide installed fonts (fingerprinting protection, Safari's user-installed fonts)
 * answer "not installed". Nothing is requested: the measuring is in a canvas of the page.
 */

/** The width of `text` drawn in the CSS `font`. */
export type Measure = (font: string, text: string) => number;

/** Latin, Hangul and digits, wide and narrow letters, so that most families differ from the generic ones somewhere. */
const SAMPLE = 'mmmmmmmmmwwwlli 0123 가나다라 한글 ABCabc';
const GENERICS = ['monospace', 'serif', 'sans-serif'] as const;
const SIZE = '72px';

/**
 * `family` as a CSS family name: quoted, its quotes and backslashes escaped, and its control characters (a newline ends a
 * CSS string, so the assignment would be ignored) as hex escapes.
 */
export const cssFamily = (family: string): string =>
  `"${family.replace(/["\\]|[\x00-\x1f\x7f]/g, (c) => (/["\\]/.test(c) ? `\\${c}` : `\\${c.charCodeAt(0).toString(16)} `))}"`;

/** True when `family` measures differently from a generic family it would fall back to: it is (most likely) there. */
export function fontInstalled(family: string, measure: Measure): boolean {
  return GENERICS.some((generic) => measure(`${SIZE} ${cssFamily(family)}, ${generic}`, SAMPLE) !== measure(`${SIZE} ${generic}`, SAMPLE));
}

/** A `Measure` on a canvas of the page; null where there is no 2D canvas. */
export function canvasMeasure(doc: Document = document): Measure | null {
  const context = doc.createElement('canvas').getContext('2d');
  if (context === null) return null;
  return (font, text) => {
    context.font = font;
    return context.measureText(text).width;
  };
}

/**
 * `fontInstalled` for each name asked, measured once each: true, false, or null where nothing can be measured. The
 * answers are kept, as the page asks again for every report.
 */
export function installedChecker(measure: Measure | null): (family: string) => boolean | null {
  const known = new Map<string, boolean>();
  return (family) => {
    if (measure === null) return null;
    let answer = known.get(family);
    if (answer === undefined) {
      answer = fontInstalled(family, measure);
      known.set(family, answer);
    }
    return answer;
  };
}
