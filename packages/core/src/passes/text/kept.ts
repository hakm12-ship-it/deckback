import { keptText } from '@deckback/ooxml';
import type { HotspotEl, TextRun } from '../../scene/types';
import type { LabelledText } from '../labels';
import type { LinkedText } from '../links';
import { endOf, ONE_BASELINE_PT, type TextFrame, type TextLine } from './lines';
import type { LineRun, RunSpacing } from './spacing';
import { emSize, runStyle } from './style';
import { EPS, glyphsOfChars } from './util';

/**
 * What lowering and the drift guard both read of a line: the runs it writes (`keptLine`) and the numbers it rounds
 * (`whole`, `charSpcs`). Here, and not in `lower/`, so that assembly does not import `lower/text` (it still imports `lower/units` for `direction` and `rot`).
 */

/**
 * `v` as a whole number, rounded half away from zero (as the writer rounds) after snapping to 1e-6, so that a decimal the
 * Scene holds rounds as written (12.345 pt is 1234.5 hundredths, which a double computes as 1234.4999999999998).
 */
export function whole(v: number): number {
  const snapped = Math.round(v * 1e6) / 1e6;
  return Math.sign(snapped) * Math.round(Math.abs(snapped)) + 0;
}

/**
 * The `spc` written for each code point of a run's text (100ths of a point after the page's `scale`, `runSpacings`): a
 * letter its run's, a space its own where it has one (ruling M4-R6, `spaceSpc`), a wide space its wide spacing (M4b,
 * `wideSpc`). Whether a space is wide is its own glyph's (`RunSpacing.wide`, by glyph: `glyphsOfChars`), so that a
 * character of no glyph, or a glyph of no character, does not move it to another space (Task 1's review, Minor 2). A
 * glyph spaced on its own (M8 round 2a: `RunSpacing.own`) has that spacing on its last character, which the gap after
 * the glyph follows.
 */
export function charSpcs(run: TextRun, spacing: RunSpacing, scale: number): number[] {
  const spc = whole(spacing.spc * scale * 100);
  const spaceSpc = spacing.spaceSpc === null ? spc : whole(spacing.spaceSpc * scale * 100);
  const wideSpc = spacing.wideSpc === null ? spaceSpc : whole(spacing.wideSpc * scale * 100);
  const glyphs = glyphsOfChars(run);
  return [...run.text].map((ch, c) => {
    const own = spacing.own[glyphs[c]!];
    if (own !== null && own !== undefined && glyphs[c + 1] !== glyphs[c]) return whole(own * scale * 100);
    return !/\s/u.test(ch) ? spc : spacing.wide[glyphs[c]!] === true ? wideSpc : spaceSpc;
  });
}

/**
 * The width of a space of `run`'s font at the size written (M4b Task 1): its share of the em (`spaceWidths`) x the em x
 * its horizontal scale x `RunStyle.scale`, as `runSpacings` measures a space glyph's advance; null where the slide shows
 * no space of the font.
 */
export function spaceWidth(run: TextRun, spaceWidths: Readonly<Record<string, number>>): number | null {
  const share = spaceWidths[run.fontKey];
  return share === undefined ? null : share * emSize(run) * run.hScale * runStyle(run).scale;
}

/**
 * A run of a line as lowering keeps it (`keptLine`): its `LineRun`, whether a synthetic space is written before it, the
 * link its text run carries (`LinkedText.link`, M5 Task 5), absent for none, and `label` when it is the first run of a
 * text run that starts with a list label (`LabelledText.label`, ruling M5-R15).
 */
export interface KeptRun extends LineRun {
  space: boolean;
  link?: HotspotEl['link'];
  label?: true;
}

/**
 * A line as lowering keeps it (`keptLine`): its kept runs in order; along its frame, unscaled, where its first kept run
 * starts (`start`) and where its advances end (`end`); across it, its first kept run's baseline (`across`); and whether
 * its runs are on one baseline (`ONE_BASELINE_PT`).
 */
export interface KeptLine {
  kept: KeptRun[];
  start: number;
  end: number;
  across: number;
  oneBaseline: boolean;
}

/**
 * The runs of a line that lowering writes (`frame` the box's; `widths` its `spaceWidths`): each run kept (`keptText`, size
 * over 0) with the separators the line puts after it, a kept run touching the one before it when nothing is written
 * between them (the next run of its own text line or of the next one assembly joined with nothing). A member whose runs
 * are all left out keeps its separator: a space after it or before it is written between the kept runs around it (final
 * review Minor 4). A synthetic space ends the run before it (`LineRun.after`): it stands for the gap from where that
 * run's advances end to where the next kept run starts, with its font's `spaceWidth`. Its runs are on one baseline when
 * each kept member's is within `ONE_BASELINE_PT` of the kept member's before it, as joining a line compares them
 * (`joinLine`; Task 1's review, Minor 1). Null for a line with nothing kept. Text assembly's drift guard (`lineDrift`)
 * predicts the line from the same runs.
 */
export function keptLine(line: TextLine, frame: TextFrame, widths: Readonly<Record<string, number>>): KeptLine | null {
  const kept: KeptRun[] = [];
  let start: number | null = null;
  let across = 0;
  let previous = 0; // the last kept member's baseline, across the frame
  let end = -Infinity;
  let lastMember = -1;
  let lastEnd = -Infinity; // where the last kept member's advances end
  let pending = false; // a space separates the next kept member from the last (its own or a left-out member's)
  let oneBaseline = true;
  for (const [j, member] of line.els.entries()) {
    if (j > 0 && line.before[j] === 'space') pending = true;
    const runs = member.runs.filter((run) => keptText(run.text) !== '' && run.sizePt > 0);
    if (runs.length === 0) continue;
    const here = frame.across(member.baseline);
    if (start === null) [start, across] = [frame.along(member.baseline), here];
    else if (Math.abs(here - previous) > ONE_BASELINE_PT + EPS) oneBaseline = false;
    previous = here;
    const sep = kept.length > 0 && pending;
    if (sep) kept.at(-1)!.after = { gap: frame.along(member.baseline) - lastEnd, width: spaceWidth(kept.at(-1)!.run, widths) };
    pending = false;
    const link = (member as LinkedText).link;
    const label = (member as LabelledText).label === true && runs[0] === member.runs[0];
    runs.forEach((run, r) => {
      const space = r === 0 && sep;
      kept.push({
        run,
        touches: kept.length > 0 && !space && (r > 0 || lastMember === j - 1),
        space,
        ...(link === undefined ? {} : { link }),
        ...(label && r === 0 ? { label: true as const } : {}),
      });
    });
    lastMember = j;
    lastEnd = endOf({ ...member, runs }, frame);
    end = Math.max(end, lastEnd);
  }
  return start === null ? null : { kept, start, end, across, oneBaseline };
}
