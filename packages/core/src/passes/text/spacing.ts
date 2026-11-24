import type { TextRun } from '../../scene/types';
import { whole } from './kept';
import { runStyle } from './style';
import { blank, median } from './util';

/**
 * Character spacing and kerning from the PDF (M4 Tasks 2 and 3, M4b Task 1; spec §4.2 pass 7): a run's `spc` is its Tc
 * and the TJ adjustments its glyphs' positions carry, read from the glyphs themselves (it replaces M3-R57's estimate).
 *
 * A glyph's extra advance is how far the next glyph's origin is past its own along the line, less its advance from the
 * font. The Scene has no width table, but a glyph's `adv` is its advance from the font after Tz with Tc added (and a
 * space's Tw), and the run's `spcPt` is that Tc (after Tz): the font's advance is `adv - spcPt`, at the size the PDF
 * draws the run at. A run whose size is snapped to the size PowerPoint was asked for (ruling M4-R4, `runStyle`) is laid
 * out at that size, so its font's advances are taken at it (`RunStyle.scale` times): the snap is counted once. The next
 * glyph is the run's next one; the last glyph's, the first of the next run on the line when the two touch (nothing is
 * written between them), but only for a run with no extra advance of its own. Left out: a glyph with no advance from its
 * font (`adv` 0: a code point after a glyph's first, at its origin, is one glyph with it).
 *
 * A run's spacing (`runSpacings`, pt along the line) is the median of its letters' extra advances, its Tc and the TJ in
 * it, where that TJ is `SPACING_FLOOR_PT` or more: under it, it is PowerPoint's own rounding of glyph positions to its
 * device grid, which PowerPoint does again when it lays the run out. Tc is written as it is (PowerPoint's export sets it
 * per run of Korean text, small values included). A snapped run's spacing is the median itself, under the floor none:
 * its Tc is what the snap already does. A run with no extra advance of its own (one glyph) has the median of its line's;
 * a line with none, the run's Tc. A run whose glyphs have no advance at all (a font with no widths) has 0.
 *
 * Spaces (ruling M4-R6): a space glyph's extra advance is a word gap, not the letters' spacing. Where the median of a
 * run's spaces' differs from its letters' by more than `SPACE_SPLIT_PT`, its spaces are runs of their own with their own
 * spacing (`RunSpacing.spaceSpc`), but only where the letters carry spacing of their own (`SPACING_FLOOR_PT` or more;
 * M4-R7): PowerPoint keeps a line at the length of the size and spacing it was asked for, puts what its device grid
 * gives back into the spaces, and does so again when it lays the line out, so with no spacing of the letters a space run
 * of its own would count that twice.
 *
 * Wide spaces (M4b Task 1, ruling M4b-R1): a space whose extra advance differs from the spacing its run's letters are
 * written with (`spc`; 0 for a run of no letters) by more than `WIDE_SPACE_PT` is a run of its own, at the median of
 * such spaces of the run (`RunSpacing.wideSpc`): a justified spread, a bullet's indent, a full-size space after a small
 * capital. M4-R6 and M4-R7 hold under it, over the other spaces. Only where the run as a whole (its synthetic space too)
 * lays out more than `WIDE_SPACE_PT` off what its written spacing gives, less the device grid's give-back of a size
 * snapped without Tc: PowerPoint's own grid puts one space of a line up to 0.6 pt off where the
 * line keeps its length, and puts it there again. A synthetic space (assembly's, `LineRun.after`) is a space of the run
 * before it by the same rules, at its measured gap over its font's space width, less what PowerPoint puts after the
 * run's last glyph beyond that glyph's advance in the PDF (`RunSpacing.after`); where the slide shows no space of its
 * font (the width a guess), M4-R6's or the letters' spacing. A space under `SPACING_FLOOR_PT` is not written.
 *
 * One space of a line up to `GRID_SPACE_PT` off (M8 round 2a, G1) is PowerPoint's grid space, never a wide space: where
 * the line has one space more than `WIDE_SPACE_PT` off, a space glyph of a run whose letters are written with no
 * spacing. Two or more such spaces are a spread, and a synthetic space is never the grid space.
 *
 * Kerning (ruling M4-R3, M8 round 2a K1 and K4): a line whose letter pairs show kerning's pattern is kerned
 * (`showsKerning`, over the pairs of its runs of 12 pt and more as written, `TEMPLATE_KERN_PT`, each against its run's
 * median): a pair more than `KERN_PAIR_PT` off, or two more than `KERN_TOL_PT` and `KERN_EM` x the size off in one
 * direction; an offset more than `KERN_SHARE` x the size is a gap, not kerning; a space shorter than `GRID_SPACE_PT`
 * before a glyph it kerns with (`kernsAfterSpace`) is kerning too (K3). A pair across two runs is no evidence:
 * PowerPoint kerns it itself where the runs are of one font and size. Every run of a kerned line keeps the template's
 * kern; any other is written `kern="0"`. One pair 0.10-0.15 pt off is PowerPoint's device grid, not kerning: on tier B
 * such a pair switched PowerPoint's kerning on, which then kerned Te, AT, TA, VA and "r," by -0.2 to -2.5 pt where the
 * PDF has none. A run under 12 pt is judged by its own pairs as M4-R3 was (`oldKerning`): the template's kern kerns
 * nothing there.
 *
 * A kerned run's spacing (K2) is its unkerned pairs' level (`unkernedLevel`), not the median, which is a kerned value
 * where most pairs kern. Where no pair lies at its Tc (spacing of its own) and its size is one the template kerns, it is
 * written `kern="0"` with each pair off that level on its own (`RunSpacing.own`): PowerPoint's kerning on spacing does not
 * lay out what the PDF has. In a run written with the template's kern, a space short of the letters before a glyph it
 * kerns with is that kerning (`RunSpacing.kerning`, K3), not a wide space; written `kern="0"`, it has its own spacing.
 *
 * Vertical writing: the run's Tc, no space runs of its own and the template's kern; an advance there is a glyph's width,
 * not its advance down the column, so no extra advance is measured.
 */

/** TJ spacing under this (pt) is PowerPoint's rounding of positions to its device grid, not spacing. */
export const SPACING_FLOOR_PT = 0.1;

/** Ruling M4-R6: a run's spaces are runs of their own when their extra advance differs from its letters' by more (pt). */
export const SPACE_SPLIT_PT = 0.1;

/**
 * M4b Task 1: a space whose extra advance differs from its run's letter spacing by more than this (pt) is a run of its
 * own whatever the letters carry (M4-R7 holds under it): more than PowerPoint's device grid gives back to a space.
 */
export const WIDE_SPACE_PT = 0.5;

/**
 * Ruling M4-R3 (as measured), M8 round 2a (K1): two letter pairs whose extra advances are off the run's by more than this
 * (pt), in one direction, are kerning; one is PowerPoint's device grid.
 */
export const KERN_TOL_PT = SPACING_FLOOR_PT;

/** M8 round 2a (K1): a letter pair whose extra advance is off the run's by more than this (pt) is kerning by itself. */
export const KERN_PAIR_PT = 0.2;

/**
 * M4b-R6, M8 round 2a (G1): PowerPoint's own device grid puts what a line's glyphs give back into one space of the line,
 * up to this far (pt) off, and puts it there again when it lays the line out: such a space is not written as a wide
 * space, and the drift guard counts it as reproduced (measured on the atlas round trip, M4b ledger). A space before a
 * glyph it kerns with that is shorter by more is that pair's kerning (K3).
 */
export const GRID_SPACE_PT = 0.7;

/** The template's kern (`kern="1200"`, ooxml parts.ts): PowerPoint kerns a run whose size, as written, is this (pt) or more. */
export const TEMPLATE_KERN_PT = 12;

/** In a run written with the template's kern, a pair offset of at most this share of the size is kerning (M4b Task 2). */
export const KERN_SHARE = 0.1;

/**
 * M8 round 2a (K1, as measured): two pairs off one way are kerning where each is more than this share of the size (and
 * `KERN_TOL_PT`): the device grid's offsets are about one device unit (0.10-0.15 pt) whatever the size, a font's small
 * kerning grows with it (Aptos at 12 pt: 0.17-0.19 pt; the grid's catch-ups at 24-32 pt: 0.12-0.155 pt, many one way).
 */
export const KERN_EM = 1 / 80;

/**
 * Whether a run's letter pairs show kerning (M8 round 2a, K1), from each pair's offset from the run's spacing and the size
 * (pt): one more than `KERN_PAIR_PT`, or two more than `KERN_TOL_PT` and `KERN_EM` x the size in one direction. A single
 * offset under `KERN_PAIR_PT` is PowerPoint's device grid, and so are two that undo each other (a glyph the grid put
 * early or late).
 */
export function showsKerning(pairs: readonly { off: number; size: number }[]): boolean {
  let longer = 0;
  let shorter = 0;
  for (const { off, size } of pairs) {
    if (Math.abs(off) > KERN_PAIR_PT + EPS) return true;
    const tol = Math.max(KERN_TOL_PT, KERN_EM * size);
    if (off > tol + EPS) longer += 1;
    else if (off < -tol - EPS) shorter += 1;
  }
  return longer >= 2 || shorter >= 2;
}

/**
 * Ruling M4-R3 as it was, for a run under `TEMPLATE_KERN_PT` (M8 round 2a): the template's kern where a pair is more than
 * `KERN_TOL_PT` off. PowerPoint kerns such a run not at all with the template's kern, so it adds no kerning there, while
 * kern="0" lays it out otherwise (tier B: a 10 pt Calibri Light line, V1 2 -> 104 px).
 */
export function oldKerning(offsets: readonly number[]): boolean {
  return offsets.some((off) => Math.abs(off) > KERN_TOL_PT + EPS);
}

/** A run of a line as lowering writes it, and whether it touches the run before it (nothing written between them). */
export interface LineRun {
  run: TextRun;
  touches: boolean;
  /**
   * The synthetic space lowering writes after the run (assembly's, M4-R1), where it writes one: the gap it stands for,
   * pt along the line from where the run's advances end to where the next run starts, and its font's space width at the
   * size written, null where the slide shows no space of the font (the width a guess).
   */
  after?: { gap: number; width: number | null };
}

/** How a run is spaced (`runSpacings`). */
export interface RunSpacing {
  /** Its spacing, pt along the line: its letters'. */
  spc: number;
  /** Its spaces' spacing where they are runs of their own by M4-R6, else null. */
  spaceSpc: number | null;
  /** Its wide spaces' spacing (M4b, `WIDE_SPACE_PT`): the median of their extra advances; null where it has none. */
  wideSpc: number | null;
  /** For each of its glyphs (`TextRun.glyphs`, by index), whether it is a wide space (Task 1's review, Minor 2). */
  wide: boolean[];
  /**
   * For each of its glyphs (by index), the spacing (pt) of the gap after it where that glyph is spaced on its own (M8
   * round 2a): a kerned pair written as spacing in a run written kern="0" (K2), a kerned pair across to the next run (K4);
   * else null.
   */
  own: (number | null)[];
  /**
   * For each of its glyphs (by index), whether it is a space before a glyph it kerns with, short of the letters' spacing,
   * in a run written with the template's kern (K3): PowerPoint kerns that pair itself.
   */
  kerning: boolean[];
  /** The spacing of the synthetic space after it, where there is one (`LineRun.after`), else null. */
  after: number | null;
  /** 0 where the line's glyphs show no pair kerning (M4-R3) or where the template's would not lay it out (K2), else null: the template's. */
  kern: 0 | null;
  /**
   * What the device grid gives back to its spaces (pt), for a size snapped without Tc and a run with spaces of its own
   * (M4-R7, M4b-R1): its glyphs' advances x (1 - `RunStyle.scale`), which PowerPoint gives back again; else 0.
   */
  giveBack: number;
}

type Glyph = TextRun['glyphs'][number];

/** Whether `g` is a code point after the glyph `last`'s first (advance 0, at the same origin): one glyph with it. */
export function joinsHead(g: Glyph, last: Glyph): boolean {
  return g.adv === 0 && g.x === last.x && g.y === last.y;
}

/** A run's glyphs, each code point after a glyph's first dropped (`joinsHead`): one glyph each. */
function headsOf(run: TextRun): Glyph[] {
  const heads: Glyph[] = [];
  for (const g of run.glyphs) {
    const last = heads[heads.length - 1];
    if (last !== undefined && joinsHead(g, last)) continue;
    heads.push(g);
  }
  return heads;
}

const EPS = 1e-9;

/**
 * The level of a kerned run's unkerned letter pairs (M8 round 2a, K2), from its letters' extra advances and the run's own
 * spacing reference `ref` (its Tc; 0 for a size snapped without it): where a pair lies within `SPACING_FLOOR_PT` of `ref`,
 * the pairs there (`atRef`), as PowerPoint's export puts a Latin run's spacing in TJ and leaves the font's own advance
 * unkerned; else the largest group of pairs within the floor of one another, the higher of two as large (kerning mostly
 * draws pairs closer). The median of the letters is a kerned value where most pairs kern ("DATA", Calibri-class fonts).
 */
function unkernedLevel(letters: readonly number[], ref: number): { level: number; atRef: boolean } {
  const near = letters.filter((e) => Math.abs(e - ref) < SPACING_FLOOR_PT);
  if (near.length > 0) return { level: median(near), atRef: true };
  // the groups within the floor of each pair, over the sorted pairs (a window about each): the largest, else the higher
  const sorted = [...letters].sort((a, b) => a - b);
  const mid = (lo: number, hi: number): number => (sorted[(lo + hi - 1) >> 1]! + sorted[(lo + hi) >> 1]!) / 2;
  let [lo, hi, best, bestLo, bestHi] = [0, 0, 0, 0, 0];
  for (const e of sorted) {
    while (sorted[lo]! < e - SPACING_FLOOR_PT - EPS) lo += 1;
    while (hi < sorted.length && sorted[hi]! <= e + SPACING_FLOOR_PT + EPS) hi += 1;
    if (hi - lo > best || (hi - lo === best && mid(lo, hi) > mid(bestLo, bestHi))) [best, bestLo, bestHi] = [hi - lo, lo, hi];
  }
  return { level: mid(bestLo, bestHi), atRef: false };
}

/** Whether two touching runs are of one font face and size: a pair across them is one the font can kern. */
function alike(a: TextRun, b: TextRun): boolean {
  return a.fontKey === b.fontKey && a.sizePt === b.sizePt && a.bold === b.bold && a.italic === b.italic && a.skew === b.skew;
}

/** M8 round 2a (K3): a glyph the space before it kerns with in Latin fonts (A, T, V, W, Y, accented too, and quotes). */
export function kernsAfterSpace(u: string): boolean {
  return /^[ATVWY‘’“”]/u.test(u.normalize('NFD'));
}

/**
 * M8 round 3a: whether a pair across two runs, `off` pt off the line's level at `size` pt, can be the font's kerning:
 * closer by at most `KERN_SHARE` x the size, or wider by at most `KERN_PAIR_PT` (the device grid). Kerning draws pairs
 * closer; a wider gap is spacing (a bullet's gap before its item).
 */
export function acrossKerns(off: number, size: number): boolean {
  return off <= KERN_PAIR_PT + EPS && off >= -KERN_SHARE * size - EPS;
}

/**
 * The spacing of each run of a line (pt, along the line's direction `cos`, `sin`): see the module's comment. `scale` is
 * the page's on the slide (`LowerCtx.scale`), by which the size is written: the template's kern applies from
 * `TEMPLATE_KERN_PT` as written.
 */
export function runSpacings(runs: readonly LineRun[], cos: number, sin: number, vertical: boolean, scale = 1, boxKerned = false): RunSpacing[] {
  if (vertical) {
    return runs.map(({ run, after }) => ({ spc: run.spcPt, spaceSpc: null, wideSpc: null, wide: [], own: [], kerning: [], after: after === undefined ? null : run.spcPt, kern: null, giveBack: 0 }));
  }
  const { heads, styles, own, medians, inners, lineInner, lineKerned: ownKerned } = lineFacts(runs, cos, sin, scale);
  // M8 round 3a: a line of a box another line of which shows kerning is kerned (`boxKerned`): PowerPoint kerns a text
  // box's runs alike, and a line's own pairs may show its small kerning no more than the device grid does
  const lineKerned = ownKerned || boxKerned;
  // the line's level for a run whose one pair is the one across, once for each reference (a line of 2,000 runs)
  const levels = new Map<number, { level: number; atRef: boolean }>();
  const lineLevel = (ref: number): { level: number; atRef: boolean } => {
    if (!levels.has(ref)) levels.set(ref, unkernedLevel(lineInner, ref));
    return levels.get(ref)!;
  };
  return spaced(runs, scale, heads, styles, own, medians, inners, lineInner, lineKerned, lineLevel);
}

/**
 * M8 round 3a: whether a line's own letter pairs show kerning (`showsKerning` over its runs of `TEMPLATE_KERN_PT` and
 * more as written; K1, K3, K4 of the module's comment). Never for vertical writing.
 */
export function lineKerning(runs: readonly LineRun[], cos: number, sin: number, vertical: boolean, scale = 1): boolean {
  return !vertical && lineFacts(runs, cos, sin, scale).lineKerned;
}

type Pair = { glyph: Glyph; next: Glyph; extra: number };
type Facts = {
  heads: Glyph[][];
  styles: ReturnType<typeof runStyle>[];
  own: { letters: Pair[]; spaces: Pair[]; boundary: Pair | null }[];
  medians: number[];
  inners: number[][];
  lineInner: number[];
  lineKerned: boolean;
};

/** A horizontal line's letter pairs and spaces, each run's median, and whether its own pairs show kerning (`runSpacings`). */
function lineFacts(runs: readonly LineRun[], cos: number, sin: number, scale: number): Facts {
  const heads = runs.map(({ run }) => headsOf(run));
  const styles = runs.map(({ run }) => runStyle(run));
  const extraOf = (run: TextRun, scale: number, a: Glyph, b: Glyph): number =>
    (b.x - a.x) * cos + (b.y - a.y) * sin - (a.adv - run.spcPt) * scale;
  const own = runs.map(({ run }, i) => {
    const hs = heads[i]!;
    const { scale } = styles[i]!;
    const letters: { glyph: Glyph; next: Glyph; extra: number }[] = [];
    const spaces: { glyph: Glyph; extra: number; next: Glyph }[] = [];
    for (let j = 0; j + 1 < hs.length; j++) {
      const a = hs[j]!;
      if (a.adv > 0) {
        const extra = extraOf(run, scale, a, hs[j + 1]!);
        if (blank(a.u)) spaces.push({ glyph: a, extra, next: hs[j + 1]! });
        else letters.push({ glyph: a, next: hs[j + 1]!, extra });
      }
    }
    // the last glyph's gap to the touching next run: the run's spacing only for a run with none of its kind of its own;
    // a letter's is a pair across the runs (K4) all the same
    const next = runs[i + 1];
    const last = hs[hs.length - 1];
    const first = heads[i + 1]?.[0];
    let boundary: { glyph: Glyph; next: Glyph; extra: number } | null = null;
    if (next !== undefined && next.touches && last !== undefined && last.adv > 0 && first !== undefined) {
      const extra = extraOf(run, scale, last, first);
      if (!blank(last.u)) {
        boundary = { glyph: last, next: first, extra };
        if (letters.length === 0) letters.push(boundary);
      } else if (spaces.length === 0) spaces.push({ glyph: last, extra, next: first });
    }
    return { letters, spaces, boundary };
  });
  const all = own.flatMap((o) => o.letters.map((l) => l.extra));
  const medians = own.map(({ letters }, i) => (letters.length > 0 ? median(letters.map((l) => l.extra)) : all.length > 0 ? median(all) : runs[i]!.run.spcPt));
  // K4: the line's kerning, over every letter pair of its runs, each against its run's median: PowerPoint kerns a
  // paragraph or none of it, and kerns a pair across two runs of one font and size itself (tier B: "y," across a
  // coloured run; written as spacing as well, V1 0 -> 1,325 px). A pair across two runs is no evidence (a URL's
  // runs, "3&" 0.25 pt). An offset over `KERN_SHARE` x the size is no font's kerning, but spacing or a gap (the
  // drift guard's)
  // (a run whose one pair is the one across: against the line's other pairs, else its Tc)
  const inners = own.map((o) => o.letters.filter((l) => l !== o.boundary).map((l) => l.extra));
  const lineInner = inners.flat();
  // (K3: a space shorter than PowerPoint's grid space before a glyph it kerns with is that pair's kerning too)
  const lineKerned = showsKerning(
    own.flatMap(({ spaces }, i) => {
      const kernSized = (off: number): boolean => Math.abs(off) <= KERN_SHARE * styles[i]!.size + EPS;
      const level = inners[i]!.length > 0 ? medians[i]! : lineInner.length > 0 ? median(lineInner) : runs[i]!.run.spcPt;
      const inner = inners[i]!.map((e) => e - level);
      const spaced = spaces.filter((sp) => kernsAfterSpace(sp.next.u) && sp.extra - level < -GRID_SPACE_PT - EPS).map((sp) => sp.extra - level);
      // (a run under TEMPLATE_KERN_PT is judged by its own pairs, as M4-R3 was: `oldKerning`)
      if (whole(styles[i]!.size * scale * 100) / 100 < TEMPLATE_KERN_PT - EPS) return [];
      return [...inner, ...spaced].filter(kernSized).map((off) => ({ off, size: styles[i]!.size }));
    }),
  );
  return { heads, styles, own, medians, inners, lineInner, lineKerned };
}

/** `runSpacings` from a line's facts (`lineFacts`) and its kerning. */
function spaced(
  runs: readonly LineRun[],
  scale: number,
  heads: Facts['heads'],
  styles: Facts['styles'],
  own: Facts['own'],
  medians: number[],
  inners: number[][],
  lineInner: number[],
  lineKerned: boolean,
  lineLevel: (ref: number) => { level: number; atRef: boolean },
): RunSpacing[] {
  const pre = runs.map(({ run, after }, i) => {
    const hasAdvance = heads[i]!.some((g) => g.adv > 0);
    const snapped = styles[i]!.scale !== 1;
    // a snapped run: the median itself, under the floor none; else Tc and the TJ in the median, from the floor
    const spacing = (extra: number): number => {
      if (snapped) return Math.abs(extra) < SPACING_FLOOR_PT ? 0 : extra;
      return Math.abs(extra - run.spcPt) < SPACING_FLOOR_PT ? run.spcPt : extra;
    };
    const { letters: pairs, spaces, boundary } = own[i]!;
    const written = whole(styles[i]!.size * scale * 100) / 100;
    // K2: a kerned run's spacing is its unkerned pairs' level. The template's kern then lays it out where its unkerned
    // pairs are at the run's Tc; else (a run with spacing of its own, of a size the template kerns) it is written
    // kern="0", each kerned pair off that level (`kernPair`) with its own spacing (`RunSpacing.own`), as PowerPoint's
    // kerning on spacing of the letters does not lay out what the PDF has. A run under `TEMPLATE_KERN_PT` keeps the
    // template's kern as before (PowerPoint kerns it not at all): written on its own, its pairs were the author's grid
    // (tier B, 4.7 pt table text: 233 runs became 931)
    // (a run whose one pair is the one across to the next run has the line's level: that pair is kerning, K4)
    const inner = inners[i]!;
    const small = written < TEMPLATE_KERN_PT - EPS;
    // (M8 round 3a: a run whose one pair is the one across, where that pair opens a gap more than KERN_PAIR_PT past the
    // line's level, or closes it more than KERN_SHARE x the size, is not kerned: kerning draws a pair closer, by a share
    // of the size. Its gap is its spacing, as in a line with no kerning: a bullet's gap before its item, tier B 2.94 pt)
    const gapAcross =
      inner.length === 0 && boundary !== null && !acrossKerns(boundary.extra - (lineInner.length > 0 ? lineLevel(snapped ? 0 : run.spcPt).level : run.spcPt), styles[i]!.size);
    const runKerned = small ? hasAdvance && oldKerning(inners[i]!.map((e) => e - medians[i]!)) : lineKerned && !gapAcross;
    const unkerned = !runKerned ? null : small && inner.length === 0 ? { level: medians[i]!, atRef: true } : inner.length > 0 ? unkernedLevel(inner, snapped ? 0 : run.spcPt) : lineInner.length > 0 ? lineLevel(snapped ? 0 : run.spcPt) : { level: snapped ? 0 : run.spcPt, atRef: true };
    const template = unkerned !== null && (unkerned.atRef || written < TEMPLATE_KERN_PT - EPS);
    const exact = runKerned && !template;
    const extra = unkerned !== null ? unkerned.level : medians[i]!;
    const spc = hasAdvance ? spacing(extra) : 0;
    // a pair written on its own: off the level by the floor or more, and by at most KERN_SHARE x the size (more is a gap,
    // the drift guard's)
    const kernPair = (off: number): boolean => Math.abs(off) >= SPACING_FLOOR_PT - EPS && Math.abs(off) <= KERN_SHARE * styles[i]!.size + EPS;
    const ownSpc: (number | null)[] = run.glyphs.map(() => null);
    const at = new Map(run.glyphs.map((g, n) => [g, n]));
    // a glyph's own spacing goes on the last of the glyphs it is one glyph with (`joinsHead`): the gap after them follows it
    const lastOf = (g: Glyph): number => {
      let n = at.get(g)!;
      while (n + 1 < run.glyphs.length && joinsHead(run.glyphs[n + 1]!, g)) n += 1;
      return n;
    };
    if (exact && hasAdvance) for (const l of pairs) if (l !== boundary && kernPair(l.extra - extra)) ownSpc[lastOf(l.glyph)] = l.extra;
    // K4: in a run written kern="0" for its kerning (K2), a kerned pair across to the next run of its font and size
    // (`kernPair`, `alike`): its first glyph spaced on its own, as PowerPoint does not kern it
    const across = runs[i + 1];
    if (exact && hasAdvance && boundary !== null && across !== undefined && kernPair(boundary.extra - extra) && alike(run, across.run)) {
      ownSpc[lastOf(boundary.glyph)] = boundary.extra;
    }
    // K3: in a run written with the template's kern, a space short of the letters' spacing before a glyph it kerns with,
    // by at most `KERN_SHARE` x the size, is that pair's kerning, which PowerPoint lays out itself: not a wide space
    const letterSpc0 = run.glyphs.some((g) => !blank(g.u)) ? spc : 0;
    const kerningSpace = (s: { extra: number; next: Glyph }): boolean =>
      runKerned && !small && kernsAfterSpace(s.next.u) && s.extra - letterSpc0 < -SPACING_FLOOR_PT + EPS && s.extra - letterSpc0 >= -KERN_SHARE * styles[i]!.size - EPS;
    const kerning: boolean[] = run.glyphs.map(() => false);
    for (const s of spaces) {
      if (!kerningSpace(s)) continue;
      if (template) kerning[at.get(s.glyph)!] = true;
      else if (kernPair(s.extra - letterSpc0)) ownSpc[lastOf(s.glyph)] = s.extra; // written kern="0": its own spacing, as a letter's
    }
    // the synthetic space's extra advance: its gap less its width and less what PowerPoint puts after the run's last
    // glyph beyond its advance in the PDF (the spacing written, less the Tc in that advance; the snap's scale)
    let last: Glyph | undefined;
    for (const g of heads[i]!) if (g.adv > 0) last = g;
    const lastExtra = last === undefined ? 0 : (last.adv - run.spcPt) * styles[i]!.scale + spc - last.adv;
    const synthetic = after === undefined || after.width === null ? null : after.gap - after.width - lastExtra;
    // its spaces: its space glyphs' and the synthetic space's after it, where measured; not a space spaced on its own
    // nor one PowerPoint kerns (K3)
    const free = (g: Glyph): boolean => ownSpc[lastOf(g)] === null && !kerning[at.get(g)!];
    const plainSpaces = spaces.filter((s) => free(s.glyph));
    const measured = [...plainSpaces.map((s) => s.extra), ...(synthetic === null ? [] : [synthetic])];
    // M4b: a space more than WIDE_SPACE_PT off the letters' spacing (0 for a run of no letters) is its own, at their median,
    // where the run (its synthetic space too) lays out more than WIDE_SPACE_PT off what that spacing gives, less the
    // device grid's give-back of a size snapped without Tc to the run's own spaces, which PowerPoint gives back again
    // (M4-R7): else its spaces are where PowerPoint's grid puts them, and it puts them there again. The letters' offsets
    // PowerPoint lays out again do not count (K2): a kerned run's kerning, a pair spaced on its own
    const letterSpc = letterSpc0;
    const { scale: snap } = styles[i]!;
    const laidOut = template ? [] : pairs.filter((l) => free(l.glyph)).map((l) => l.extra);
    const off = laidOut.reduce((s, e) => s + e - spc, 0) + measured.reduce((s, e) => s + e - letterSpc, 0);
    const givesBack = snap !== 1 && run.spcPt === 0 && spaces.length > 0;
    const giveBack = givesBack ? heads[i]!.reduce((s, g) => s + g.adv * (1 - snap), 0) : 0;
    const spread = Math.abs(off + giveBack) > WIDE_SPACE_PT + EPS;
    // G1: the spaces more than WIDE_SPACE_PT off (each one's glyph; null for the synthetic space), and whether the run's
    // letters are written with no spacing (plain), where one such space up to GRID_SPACE_PT off is PowerPoint's grid
    const beyond = [...plainSpaces.map((sp) => ({ glyph: sp.glyph as Glyph | null, extra: sp.extra })), ...(synthetic === null ? [] : [{ glyph: null, extra: synthetic }])].filter(
      (sp) => Math.abs(sp.extra - letterSpc) > WIDE_SPACE_PT + EPS,
    );
    const plain = whole(spc * scale * 100) === 0 && ownSpc.every((v, n) => v === null || blank(run.glyphs[n]!.u));
    const finish = (grid: ReadonlySet<Glyph>): RunSpacing => {
      const isWide = (e: number, g: Glyph | null = null): boolean => spread && Math.abs(e - letterSpc) > WIDE_SPACE_PT + EPS && (g === null || !grid.has(g));
      const wideExtras = [...plainSpaces.filter((sp) => isWide(sp.extra, sp.glyph)).map((sp) => sp.extra), ...(synthetic !== null && isWide(synthetic) ? [synthetic] : [])];
      const wideSpc = wideExtras.length > 0 ? spacing(median(wideExtras)) : null;
      // M4-R6 and M4-R7, as they were, over the rest
      const rest = [...plainSpaces.filter((sp) => !isWide(sp.extra, sp.glyph)).map((sp) => sp.extra), ...(synthetic !== null && !isWide(synthetic) ? [synthetic] : [])];
      const restExtra = rest.length > 0 ? median(rest) : null;
      const ownSpaces = restExtra !== null && Math.abs(spc) >= SPACING_FLOOR_PT && Math.abs(restExtra - extra) > SPACE_SPLIT_PT + EPS;
      const spaceSpc = ownSpaces ? spacing(restExtra) : null;
      const wideGlyphs = new Set(plainSpaces.filter((sp) => isWide(sp.extra, sp.glyph)).map((sp) => sp.glyph));
      const afterSpc = synthetic !== null && isWide(synthetic) ? wideSpc : null;
      return {
        spc,
        spaceSpc,
        wideSpc,
        wide: run.glyphs.map((g) => wideGlyphs.has(g)),
        own: ownSpc.map((v) => (v === null ? null : spacing(v))),
        kerning,
        after: after === undefined ? null : (afterSpc ?? spaceSpc ?? spc),
        kern: template ? null : 0,
        giveBack,
      };
    };
    return { beyond, plain, letterSpc, finish };
  });
  // G1 (M8 round 2a): PowerPoint's own grid puts what a line's glyphs give back into one space of it, up to GRID_SPACE_PT
  // off, and puts it there again: where a line has one space more than WIDE_SPACE_PT off, a space glyph of a run whose
  // letters are written with no spacing, and it is at most GRID_SPACE_PT off, it is that grid space, never a wide space
  const beyond = pre.flatMap((p) => p.beyond.map((sp) => ({ ...sp, p })));
  const one = beyond.length === 1 ? beyond[0]! : null;
  const grid = new Set<Glyph>();
  if (one !== null && one.glyph !== null && one.p.plain && Math.abs(one.extra - one.p.letterSpc) <= GRID_SPACE_PT + EPS) grid.add(one.glyph);
  return pre.map((p) => p.finish(grid));
}
