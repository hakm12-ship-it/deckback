import type { Box } from '../../extract/inventory';
import { familyOfName } from '../../scene/fonts';
import type { Element, FontInfo, TextLineEl } from '../../scene/types';
import { baselineK, DEFAULT_K } from '../baseline';
import { direction, rot } from '../lower/units';
import { intersect, paintBox as invisiblePaintBox } from '../invisible';
import { emSize, runStyle } from './style';
import { blank, EPS, median } from './util';

/**
 * Text assembly, runs into lines (M4 Task 1, spec §4.2 pass 7). The Scene's text lines are one `showText` run each, and
 * PowerPoint's export writes a word per `BT` block, so a line of the PDF arrives as many of them. Consecutive text runs
 * (in z-order, nothing but other paints between them) join one line when all of these hold (`LINE_RULES`):
 * - the same direction within 0.1° (`angleTolDeg`), measured against the line's first run, and the same writing mode;
 * - baselines within 0.15 x size of each other across the line (`baselineTol`; the smaller run's size): a superscript set
 *   on a raised baseline is not joined, a rise (Ts) is (the Scene's baseline is without it, and the run keeps it); runs of
 *   different sizes only on one baseline (`ONE_BASELINE_PT`, M4b Task 1), as PowerPoint lays the line out on one: a 12 pt
 *   run that `fontAlgn="b"` set 1.44 pt below a 24 pt run's baseline (atlas/text/41) came back on it;
 * - each starts no more than 0.3 x size before the previous run's last advance ends (`gapMin`; the previous run's size),
 *   and, ruling M4-R1, no further after it than one space of the previous run's font (`SPACE_RULE`): a run over the last
 *   one is not joined, and a wider gap (a bullet's indent, a column, a table cell, a justified spread) splits the line,
 *   as PowerPoint drew those as other objects, and would lay the joined runs out again at its own spacing;
 * - nothing painted between them in z-order covers the gap or the later run (`covered`): the line is written where its
 *   first run is, so the later run would go under it;
 * - and, as a text box has one clip, group alpha, soft mask and blend mode: the same of each (`sameContext`);
 * - and fonts that put the baseline at the same share of the size (`baselineK`, within `K_TOL`): PowerPoint draws a line
 *   of fonts whose shares differ with its baseline between theirs, by a rule this task did not model (measured: up to
 *   1.7 pt off the larger share's at 20 pt, 0 to 0.42 pt off the smaller's), so such runs stay lines of their own,
 *   placed exactly. A font's Type0 and WinAnsi halves (Review Focus 2) are one family, of one share.
 *
 * The gap (M4-R1, `separator`): where a space glyph already sits (the earlier run ends with whitespace or the later one
 * starts with it), the runs join with nothing between them when the gap after it is under 0.2 x size (`spaceGap`), and
 * split otherwise. Else a gap of one space of the earlier run's font (`spaceAdvance`: its own width, else 0.25, of its
 * em, after its Tz and Tc as the gap is; within 0.1 x size, at least half of it) gets one synthetic space; else a gap under
 * 0.2 x size joins with nothing between (the runs touch); else the line splits.
 *
 * Lengths in this module are slide-frame pt. Comparisons allow `EPS` for the Scene's rounding. A run's size in the rules
 * is the size lowering writes (`runStyle`: a synthetic italic at the size of its em, a size PowerPoint's export drew on
 * its grid at the size it was asked for), as lowering lays the line out at it (M4 Task 3; it was the Scene's size).
 */

export const LINE_RULES = { angleTolDeg: 0.1, baselineTol: 0.15, gapMin: -0.3, spaceGap: 0.2 } as const;

/**
 * Ruling M4-R1: a gap is one space when it is within `tol` x size of the earlier run's space advance, its size x its
 * font's space width (`spaceWidths`), or `fallback` x size where the slide shows no space of the font.
 */
export const SPACE_RULE = { fallback: 0.25, tol: 0.1 } as const;

/** Runs of one line put the baseline at shares of the size (`baselineK`) at most this far apart. */
export const K_TOL = 0.005;

/**
 * M4b Task 1: runs of different sizes are on one baseline when theirs are at most this far apart across the line (pt).
 * PowerPoint lays a line out on one baseline, so only such runs join a line (`joinLine`), and lowering writes their
 * paragraph `fontAlgn="base"`; runs of one size keep `LINE_RULES.baselineTol`.
 */
export const ONE_BASELINE_PT = 0.05;

/**
 * A line, or a box, takes no further run once more than this many paints lie between its runs in z-order: each is
 * checked against every later run (`covered`), which this bounds on a page of many paints (a hostile one included).
 */
export const MAX_PAINTS_BETWEEN = 64;

/** What is written before a run of a line: nothing, or a synthetic space. */
export type Separator = 'none' | 'space';

/** A line: its runs (the Scene's text lines) in order, and what goes before each (`none` before the first). */
export interface TextLine {
  els: TextLineEl[];
  before: Separator[];
}

/** A line as assembly finds it: also where its first and last run are in the slide's elements. */
export interface FoundLine extends TextLine {
  first: number;
  last: number;
}

/**
 * The frame of a line or box, from its first run: `along` its writing direction and `across` it (down the glyphs; in
 * vertical writing, across the column), from that run's baseline origin. The direction is the one lowering writes
 * (`rot`, `direction`: exact at the quarter turns).
 */
export interface TextFrame {
  along(p: { x: number; y: number }): number;
  across(p: { x: number; y: number }): number;
  /** A point of the frame on the slide. */
  at(along: number, across: number): [number, number];
}

export function textFrame(el: TextLineEl): TextFrame {
  const [cos, sin] = direction(rot(el.angleDeg) / 60000);
  const { x: ox, y: oy } = el.baseline;
  // horizontal: along (cos, sin), across (-sin, cos); vertical writing: along the column (-sin, cos), across (cos, sin)
  const [ax, ay, nx, ny] = el.wmode === 1 ? [-sin, cos, cos, sin] : [cos, sin, -sin, cos];
  return {
    along: (p) => (p.x - ox) * ax + (p.y - oy) * ay,
    across: (p) => (p.x - ox) * nx + (p.y - oy) * ny,
    at: (u, v) => [ox + u * ax + v * nx, oy + u * ay + v * ny],
  };
}

/** The angle between two directions, either way round (0 to 180). */
export function angleApart(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** A run's size for the rules: its largest, as lowering writes it (`runStyle`). */
export const sizeOf = (el: TextLineEl): number => el.runs.reduce((m, r) => Math.max(m, runStyle(r).size), 0);

/**
 * The space width of each font of the slide's runs, a share of the em (ruling M4-R1), from the font's own widths as the
 * PDF gives them: the median over the slide's space glyphs (U+0020) of the font of the glyph's advance less its character
 * spacing (`spcPt`, Tc after Tz) and before the run's horizontal scale, over the size of its em (`emSize`: a synthetic
 * italic's Scene size is longer). A word spacing Tw, which the Scene does not keep apart, would be in it; PowerPoint's
 * export uses none. A font with no space glyph on the slide takes its family's (another font of the same family, weight
 * and slant: a font's Type0 and WinAnsi halves), else none (`spaceAdvance` falls back to `SPACE_RULE.fallback`).
 */
export function spaceWidths(elements: readonly Element[], fonts: Readonly<Record<string, FontInfo>>): Map<string, number> {
  const seen = new Map<string, number[]>();
  for (const el of elements) {
    if (el.kind !== 'textline') continue;
    for (const run of el.runs) {
      const em = emSize(run);
      if (!(em > 0) || !(run.hScale > 0)) continue;
      for (const g of run.glyphs) {
        if (g.u !== ' ' || !(g.adv > 0)) continue;
        const width = (g.adv - run.spcPt) / (em * run.hScale);
        if (width > 0) {
          const list = seen.get(run.fontKey);
          if (list === undefined) seen.set(run.fontKey, [width]);
          else list.push(width);
        }
      }
    }
  }
  const family = (key: string): string | null => {
    const f = fonts[key];
    if (f === undefined) return null;
    const name = f.latinName ?? familyOfName(f.baseFont);
    return name === null || name === '' ? null : JSON.stringify([name, f.bold, f.italic]);
  };
  const out = new Map<string, number>();
  const byFamily = new Map<string, number[]>();
  for (const [key, widths] of seen) {
    out.set(key, median(widths));
    const fam = family(key);
    if (fam !== null) byFamily.set(fam, [...(byFamily.get(fam) ?? []), ...widths]);
  }
  for (const key of Object.keys(fonts)) {
    const fam = family(key);
    const widths = fam === null ? undefined : byFamily.get(fam);
    if (!out.has(key) && widths !== undefined) out.set(key, median(widths));
  }
  return out;
}

/**
 * The advance of one space after run `el` (pt), as the gap after it is measured (from where its last advance ends, an
 * advance holding Tz and Tc): its last run's em x its font's space width (else the fallback's) x its horizontal scale,
 * and its character spacing (`spcPt`, Tc after Tz).
 */
export function spaceAdvance(el: TextLineEl, widths: ReadonlyMap<string, number>): number {
  const run = el.runs.at(-1);
  return run === undefined ? 0 : emSize(run) * (widths.get(run.fontKey) ?? SPACE_RULE.fallback) * run.hScale + run.spcPt;
}

/** The share of the size below its top where PowerPoint puts a run's baseline (`baselineK`): its largest run's font's. */
export function shareOf(el: TextLineEl, fonts: Readonly<Record<string, FontInfo>>): number {
  let [share, top] = [DEFAULT_K, -1];
  for (const run of el.runs) {
    const font = fonts[run.fontKey];
    const k = font === undefined ? DEFAULT_K : baselineK(font).k;
    const size = runStyle(run).size;
    if (k * size > top) [share, top] = [k, k * size];
  }
  return share;
}

/** Where a run's advances end along `frame`: in vertical writing a glyph advances a size (as written) down the column. */
export function endOf(el: TextLineEl, frame: TextFrame): number {
  let end = -Infinity;
  for (const run of el.runs) {
    const down = el.wmode === 1 ? runStyle(run).size : 0;
    for (const g of run.glyphs) end = Math.max(end, frame.along(g) + (el.wmode === 1 ? down : g.adv));
  }
  return end === -Infinity ? frame.along(el.baseline) : end;
}

/** Whether two elements are drawn in the same clips, groups, soft mask and blend mode: one text box has one of each. */
export function sameContext(a: Element, b: Element): boolean {
  return (
    a.mask === b.mask &&
    a.blend === b.blend &&
    a.clip.length === b.clip.length &&
    a.clip.every((c, i) => c === b.clip[i]) &&
    JSON.stringify(a.groups) === JSON.stringify(b.groups)
  );
}

/** Two boxes overlap with some area (touching is not overlapping). */
export function overlaps(a: Box, b: Box): boolean {
  return a[0] < b[2] - EPS && b[0] < a[2] - EPS && a[1] < b[3] - EPS && b[1] < a[3] - EPS;
}

/**
 * The box `el` paints in, as far as assembly needs it: its paint box (`invisible.paintBox`, a stroke's miter and cap
 * reach included) within its clip's; null for what paints nothing, and for a hotspot.
 *
 * Two consequences, both kept (M4b Task 3's review): a straight stroked bar has a miter reach of 5 x its width, so words
 * within that of it can split (a safe over-split, never wrong output); and a paint that only shares an edge with its clip
 * gives a degenerate box, not null, that still counts toward `MAX_PAINTS_BETWEEN` (it never overlaps a run).
 */
export function paintBox(el: Element): Box | null {
  return el.kind === 'hotspot' ? null : intersect(invisiblePaintBox(el), el.clipBox);
}

/** The slide box of a stretch of a frame: along from `u0` to `u1`, across from `v0` to `v1`. */
export function frameBox(frame: TextFrame, u0: number, u1: number, v0: number, v1: number): Box {
  const pts = [frame.at(u0, v0), frame.at(u1, v0), frame.at(u0, v1), frame.at(u1, v1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * What goes between run `prev` and run `next` of a line framed by `frame`, or null when `next` does not join the line
 * (all but the covering rule, which needs the paints between them: `textLines`). `widths`: the slide's `spaceWidths`.
 */
export function joinLine(
  first: TextLineEl,
  prev: TextLineEl,
  next: TextLineEl,
  frame: TextFrame,
  fonts: Readonly<Record<string, FontInfo>> = {},
  widths: ReadonlyMap<string, number> = new Map(),
): Separator | null {
  const R = LINE_RULES;
  if (next.wmode !== first.wmode || angleApart(first.angleDeg, next.angleDeg) > R.angleTolDeg + EPS) return null;
  if (!sameContext(first, next) || Math.abs(shareOf(first, fonts) - shareOf(next, fonts)) > K_TOL + EPS) return null;
  const size = sizeOf(prev);
  const apart = Math.abs(frame.across(next.baseline) - frame.across(prev.baseline));
  if (apart > R.baselineTol * Math.min(size, sizeOf(next)) + EPS) return null;
  if (Math.abs(size - sizeOf(next)) > EPS && apart > ONE_BASELINE_PT + EPS) return null;
  const gap = frame.along(next.baseline) - endOf(prev, frame);
  if (gap < R.gapMin * size - EPS) return null;
  return separator(gap, size, spaceAdvance(prev, widths), blank(prev.runs.at(-1)?.text.at(-1)) || blank(next.runs[0]?.text[0]));
}

/**
 * Ruling M4-R1: what a gap of `gap` pt after a run of `size` whose font's space is `space` pt wide is: nothing (the runs
 * touch, or a space glyph is there already), one synthetic space, or wider than one space (null: the line splits).
 */
export function separator(gap: number, size: number, space: number, spaceThere: boolean): Separator | null {
  const touching = gap < LINE_RULES.spaceGap * size - EPS;
  if (spaceThere) return touching ? 'none' : null;
  if (Math.abs(gap - space) <= SPACE_RULE.tol * size + EPS && gap >= space / 2 - EPS) return 'space';
  return touching ? 'none' : null;
}

/**
 * The slide's text lines, in z-order: each a stretch of consecutive text runs (`joinLine`, with the deck's `fonts` and the
 * slide's space `widths`) where no paint between two of its runs in z-order covers a later run of the line or a gap it
 * joins across (the gap from 1 x size above the baseline to 0.25 x size below it; in vertical writing 0.5 x size either
 * side of the column).
 */
export function textLines(
  elements: readonly Element[],
  fonts: Readonly<Record<string, FontInfo>> = {},
  widths: ReadonlyMap<string, number> = spaceWidths(elements, fonts),
): FoundLine[] {
  const lines: FoundLine[] = [];
  let line: FoundLine | null = null;
  let frame: TextFrame | null = null;
  let between: Box[] = []; // the paints since the line's first run
  elements.forEach((el, i) => {
    if (el.kind !== 'textline') {
      const box = paintBox(el);
      if (box !== null && line !== null) between.push(box);
      return;
    }
    if (line !== null && frame !== null) {
      const prev = line.els.at(-1)!;
      const sep = joinLine(line.els[0]!, prev, el, frame, fonts, widths);
      if (sep !== null && between.length <= MAX_PAINTS_BETWEEN && !covered(between, el, prev, frame)) {
        line.els.push(el);
        line.before.push(sep);
        line.last = i;
        return;
      }
    }
    line = { els: [el], before: ['none'], first: i, last: i };
    frame = textFrame(el);
    between = [];
    lines.push(line);
  });
  return lines;
}

/** Whether a paint of `between` covers run `next` or its gap after `prev`. */
function covered(between: readonly Box[], next: TextLineEl, prev: TextLineEl, frame: TextFrame): boolean {
  if (between.length === 0) return false;
  const size = Math.max(sizeOf(prev), sizeOf(next));
  const [u0, u1] = [endOf(prev, frame), frame.along(next.baseline)];
  const v = frame.across(next.baseline);
  const [above, below] = next.wmode === 1 ? [0.5, 0.5] : [1, 0.25]; // a vertical column is centred on its origin
  const gap = u1 > u0 ? frameBox(frame, u0, u1, v - above * size, v + below * size) : null;
  return between.some((b) => overlaps(b, next.bboxPt) || (gap !== null && overlaps(b, gap)));
}
