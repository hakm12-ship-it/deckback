import { emojiUnit } from '@deckback/ooxml';
import type { Element, FontInfo, SceneSlide, TextLineEl, TextRun } from '../scene/types';
import { ONE_BASELINE_PT, SPACE_RULE, spaceWidths } from './text/lines';
import { emSize } from './text/style';
import { EPS } from './text/util';

/**
 * List labels (M5 Task 5 fix round 1, ruling M5-R15). PowerPoint's PDF export draws a run's character of Unicode's Emoji
 * property as a picture (`emojiUnit`, measured), and a paragraph's bullet as text; so the writer writes such a character,
 * first in its paragraph, as the bullet (`a:buChar`) when the paragraph is a list's item and the character its label.
 * This pass says which: a text run (upright: angle 0, `wmode` 0) whose first character is one unit drawn as a picture
 * (`emojiUnit`), and is
 * - on a tagged page (the run has a structure path): inside a `Lbl` structure element;
 * - untagged (no structure path): followed, before the first text glyph after it on its line (its own run's next glyph,
 *   else the nearest run on its baseline, within `ONE_BASELINE_PT`), by a gap wider than one space of that glyph's run
 *   (the slide's space width of its font, `spaceWidths`, else `SPACE_RULE.fallback` of the em) and by no space
 *   character: a bullet's indent, as PowerPoint exports one (atlas text/25 notags: 6.0 pt against a 5.04 pt space).
 *
 * It is `LabelledText.label`; lowering marks the paragraph that starts with it (`OxParagraph.label`). Any other such
 * character stays text, which PowerPoint's own export would draw as a picture: lowering notes the slide once
 * (`EMOJI_PICTURE_NOTE`). A new slide; the input is not changed.
 */

/** The note of a slide whose text holds a character PowerPoint's PDF export draws as a picture (ruling M5-R15). */
export const EMOJI_PICTURE_NOTE = 'text PowerPoint exports as a picture';

/** A text run that starts with a list label (`listLabels`); absent for none. */
export interface LabelledText extends TextLineEl {
  label?: true;
}

const upright = (el: Element): el is TextLineEl => el.kind === 'textline' && el.angleDeg === 0 && el.wmode === 0;
const blank = (u: string): boolean => /^\s*$/u.test(u);

/** A run's space advance (pt): its font's space width as the slide shows it, else the fallback share, at its em. */
function spaceOf(run: TextRun, widths: ReadonlyMap<string, number>): number {
  return emSize(run) * (widths.get(run.fontKey) ?? SPACE_RULE.fallback) * run.hScale + run.spcPt;
}

/** Whether `el`, an untagged run that starts with such a character, is followed by a bullet's indent (the module comment). */
function indented(el: TextLineEl, line: readonly TextLineEl[], widths: ReadonlyMap<string, number>): boolean {
  const head = el.runs[0]!;
  const mark = head.glyphs[0]!;
  const end = mark.x + mark.adv;
  // the first glyph after the mark: in its own runs, else the nearest run on its baseline that starts after it
  let next: { u: string; x: number; run: TextRun } | null = null;
  for (const [r, run] of el.runs.entries()) {
    const g = run.glyphs[r === 0 ? 1 : 0];
    if (g !== undefined) {
      next = { u: g.u, x: g.x, run };
      break;
    }
  }
  if (next === null) {
    for (const other of line) {
      if (other === el || Math.abs(other.baseline.y - el.baseline.y) > ONE_BASELINE_PT + EPS) continue;
      const run = other.runs.find((r) => r.glyphs.length > 0);
      const g = run?.glyphs[0];
      if (run === undefined || g === undefined || g.x < end - EPS) continue;
      if (next === null || g.x < next.x) next = { u: g.u, x: g.x, run };
    }
  }
  if (next === null || blank(next.u)) return false;
  return next.x - end > spaceOf(next.run, widths) + EPS;
}

/** The pass (the module comment), with the deck's `fonts` (for the slide's space widths). */
export function listLabels(slide: SceneSlide, fonts: Readonly<Record<string, FontInfo>> = {}): SceneSlide {
  const line = slide.elements.filter(upright);
  let widths: ReadonlyMap<string, number> | null = null;
  const marked = new Set<TextLineEl>();
  for (const el of line) {
    const head = el.runs[0];
    if (head === undefined || head.glyphs.length === 0 || emojiUnit(head.text) === null) continue;
    const struct = el.provenance.struct;
    if (struct !== null) {
      if (struct.includes('Lbl')) marked.add(el);
      continue;
    }
    widths ??= spaceWidths(slide.elements, fonts);
    if (indented(el, line, widths)) marked.add(el);
  }
  if (marked.size === 0) return slide;
  return { ...slide, elements: slide.elements.map((el) => (marked.has(el as TextLineEl) ? ({ ...(el as TextLineEl), label: true } as LabelledText) : el)) };
}
