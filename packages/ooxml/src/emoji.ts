import { EMOJI_RUNS } from './emoji-runs';

/**
 * The characters PowerPoint's PDF export draws as pictures when they are in a text run (M5 Task 5: `EMOJI_RUNS`,
 * measured by harness/atlas/emoji_runs.py), and the emoji sequences that hold them.
 */

/** Whether PowerPoint's PDF export draws code point `c` as a picture when it is in a run (`EMOJI_RUNS`, measured). */
export function drawnAsPicture(c: number): boolean {
  let [lo, hi] = [0, EMOJI_RUNS.length - 1];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [first, last] = EMOJI_RUNS[mid]!;
    if (c < first) hi = mid - 1;
    else if (c > last) lo = mid + 1;
    else return true;
  }
  return false;
}

/** What goes on with a character in an emoji sequence: a variation selector, ZWJ, a keycap, a skin tone or a tag. */
const SEQUENCE = /^(?:[︎️‍⃣]|\uD83C[\uDFFB-\uDFFF]|\uDB40[\uDC20-\uDC7F])/;
/** A regional indicator (U+1F1E6 to U+1F1FF): two of them are a flag. */
const REGIONAL = /^\uD83C[\uDDE6-\uDDFF]/;

/**
 * The character `text` starts with when PowerPoint's PDF export draws it as a picture in a run and it is one unit: not
 * the start of an emoji sequence (a flag of two regional indicators, ZWJ, a skin tone, VS15 or VS16, a keycap, a tag
 * sequence), which stays whole. Null otherwise.
 */
export function emojiUnit(text: string): string | null {
  const code = text.codePointAt(0);
  if (code === undefined || !drawnAsPicture(code)) return null;
  const char = String.fromCodePoint(code);
  const rest = text.slice(char.length);
  if (SEQUENCE.test(rest) || (REGIONAL.test(char) && REGIONAL.test(rest))) return null;
  return char;
}

/** Whether `text` holds a character PowerPoint's PDF export draws as a picture in a run (`drawnAsPicture`). */
export function hasPictureChar(text: string): boolean {
  for (const ch of text) if (drawnAsPicture(ch.codePointAt(0)!)) return true;
  return false;
}
