/** The tolerance of text assembly's and lowering's comparisons of lengths (pt), for the Scene's rounding. */
export const EPS = 1e-6;

/** The median of `xs`, the mean of the middle two when there is an even number of them. */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Whether `s` is blank (only white space); false for none. */
export const blank = (s: string | undefined): boolean => s !== undefined && s.trim() === '';

/**
 * For each code point of a run's text, the index of the glyph it is a code point of, or -1 for one no glyph has (the
 * Scene's text is its glyphs' code points in order; a glyph of no code point adds none). Text and glyphs are matched in
 * order, so a character that is not the next glyph's next code point is one of no glyph (Task 1's review, Minor 2).
 */
export function glyphsOfChars(run: { text: string; glyphs: readonly { u: string }[] }): number[] {
  const out: number[] = [];
  let g = 0;
  let k = 0; // the code points of glyph g matched so far
  for (const ch of run.text) {
    while (g < run.glyphs.length && k >= [...run.glyphs[g]!.u].length) [g, k] = [g + 1, 0];
    const cps = g < run.glyphs.length ? [...run.glyphs[g]!.u] : [];
    if (cps[k] === ch) {
      out.push(g);
      k += 1;
    } else out.push(-1);
  }
  return out;
}
