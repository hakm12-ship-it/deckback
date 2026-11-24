import type { Element, TextLineEl, TextRun } from '../../scene/types';
import { direction, rot } from '../lower/units';
import { charSpcs, keptLine, whole, type KeptRun } from './kept';
import { endOf, frameBox, textFrame, type FoundLine, type TextLine } from './lines';
import { GRID_SPACE_PT, joinsHead, KERN_PAIR_PT, KERN_SHARE, lineKerning, runSpacings, SPACING_FLOOR_PT, TEMPLATE_KERN_PT } from './spacing';
import { runStyle } from './style';
import { blank, EPS, glyphsOfChars } from './util';

/**
 * The drift guard (M4b Task 2, spec §4.2 pass 7), text assembly's safety net: where the glyphs of a line, as lowering
 * writes it, would land more than `DRIFT_TOL_PT` from where the PDF has them, the box is split there, and the rest of
 * the line is a box of its own at its PDF origin. A line is never drawn instead (no text as outlines, ever).
 *
 * The prediction (`lineDrift`) is lowering's own line: the runs it keeps (`keptLine`), their spacing (`runSpacings`,
 * `charSpcs`) and their size as written (`runStyle`), at the page's scale. Glyph by glyph, the next glyph's predicted
 * origin is this one's plus its advance from the font at the size written and the `spc` written for it (across a
 * synthetic space, the space's width and `spc` too). A pair's offset is the PDF's advance less that one; a glyph's
 * residual is the sum of the offsets before it that PowerPoint does not reproduce, and it does reproduce:
 * - kerning (M4-R3): in a run written with the template's kern, an offset after a letter of at most `KERN_SHARE` x the
 *   size, and (M8 round 2a, K3) one at a space before a glyph it kerns with (`RunSpacing.kerning`);
 * - its device grid at a letter: an offset under `SPACING_FLOOR_PT` (as `runSpacings` reads TJ under it), and in a run
 *   written `kern="0"` at a size the template kerns, one up to `KERN_PAIR_PT` (M8 round 2a, K1: the grid K1 reads it as);
 * - its device grid at a space (M4-R7, M4b-R1): an offset at a space glyph written with no spacing of its own (a wide
 *   space written does not count: the run's other spaces keep their grid), or across a synthetic space, of a run whose
 *   letters are written with no spacing, of at most `GRID_SPACE_PT` and what a size snapped without Tc gives back (`RunSpacing.giveBack`).
 * Where nothing can be predicted, nothing is counted: a synthetic space whose font's width the slide does not show, and
 * a run whose glyphs have no advance. A vertical line (`wmode` 1) is not measured; a rotated one is, along its direction.
 *
 * The split (`driftCut`, `guardBoxes`): at the first glyph, not a space, whose residual is more than `DRIFT_TOL_PT`, the
 * line ends at the last word boundary before it (a space glyph, or a synthetic space) or, with none, at that glyph; the
 * rest starts a new line at its own PDF origin, where its residual starts again, and is guarded in turn. Each part is a
 * box of its own; in a box of several lines, the lines before and after the one split are boxes of their own. A part that
 * starts within a run is a new element of that op (the next `:n` id, M1-R50). Each part a split starts is recorded
 * `text-drift-split`. A line is cut at most `MAX_DRIFT_CUTS` times. The measurements behind the thresholds are in the
 * M4b ledger.
 */

/** A box is split where a glyph would land more than this far (pt) along its line from the PDF's origin. */
export const DRIFT_TOL_PT = 0.5;

/** In a run written with the template's kern, a pair offset of at most this share of the size is kerning (spacing.ts). */
export { KERN_SHARE };

/**
 * At a space of a run written with no spacing, an offset of at most this (pt) is PowerPoint's own device grid, which it
 * puts there again (measured on the atlas round trip, M4b ledger): spacing.ts's, which writes no wide space under it (G1).
 */
export { GRID_SPACE_PT };

/** A line is cut at most this many times: it bounds the guard's work on a line of many glyphs (a hostile one too). */
export const MAX_DRIFT_CUTS = 64;

export interface DriftOptions {
  /** The slide's space widths by font (`spaceWidths`, a share of the em), as the box carries them. */
  spaceWidths: Readonly<Record<string, number>>;
  /** The page's scale on the slide (`LowerCtx.scale`): lowering rounds sizes and spacing after it. 1 when absent. */
  scale?: number;
  /** M8 round 3a: another line of the line's box shows kerning (`boxKerning`), so it is kerned as well. False when absent. */
  kerned?: boolean;
}

/** A glyph that lowering writes, the first of its characters: where it is in the line, and what is written for it. */
interface Head {
  member: number;
  run: number;
  glyph: number;
  /** Its index among the kept runs (`KeptLine.kept`). */
  kept: number;
  g: TextRun['glyphs'][number];
  blank: boolean;
  /** For a space glyph: whether it is written with no spacing of its own (its `spc` 0, not a wide space), M4b-R1. */
  unwritten: boolean;
  /** For a space glyph: whether PowerPoint kerns it with the glyph after it (`RunSpacing.kerning`, K3). */
  kerning: boolean;
  /** Its advance as written, pt: the font's at the size written, and its characters' `spc`. */
  advance: number;
}

/** A synthetic space as written, before kept run `kept`: its width (null where the slide shows none) and its `spc`, pt. */
interface Space {
  width: number | null;
  spc: number;
}

/** What `predict` finds of a line: its heads in order, each one's residual, and the synthetic space before each. */
interface Prediction {
  heads: Head[];
  residuals: number[];
  /** For each head, the synthetic space between it and the head before it, if any. */
  spaces: (Space | null)[];
}

function predict(line: TextLine, opts: DriftOptions): Prediction | null {
  const lead = line.els[0];
  if (lead === undefined || lead.wmode === 1) return null;
  const scale = opts.scale ?? 1;
  const frame = textFrame(lead);
  const [cos, sin] = direction(rot(lead.angleDeg) / 60000);
  const found = keptLine(line, frame, opts.spaceWidths);
  if (found === null) return null;
  const { kept } = found;
  const spacing = runSpacings(kept, cos, sin, false, scale, opts.kerned ?? false);
  // where each run is in the line
  const place = new Map<TextRun, [number, number]>();
  line.els.forEach((el, j) => el.runs.forEach((run, r) => place.set(run, [j, r])));
  const heads: Head[] = [];
  const spaces: (Space | null)[] = [];
  const plain: boolean[] = []; // a run whose letters are written with no spacing: its spaces are judged one by one
  const widthless: boolean[] = [];
  const kerned: boolean[] = [];
  const sizes: number[] = [];
  const giveBacks: number[] = [];
  kept.forEach((k: KeptRun, i) => {
    const { run } = k;
    const [member, r] = place.get(run)!;
    const style = runStyle(run);
    const written = whole(style.size * scale * 100) / 100 / scale; // the size written, pt on the page
    const drawn = style.size / style.scale; // the size the PDF draws the run at
    const spcs = charSpcs(run, spacing[i]!, scale);
    const glyphs = glyphsOfChars(run);
    const chars: number[][] = run.glyphs.map(() => []);
    glyphs.forEach((g, c) => {
      if (g >= 0) chars[g]!.push(c);
    });
    const chars0 = [...run.text];
    plain.push(spcs.every((s, c) => s === 0 || /\s/u.test(chars0[c]!)));
    widthless.push(!run.glyphs.some((g) => g.adv > 0));
    kerned.push(spacing[i]!.kern === null);
    sizes.push(written);
    giveBacks.push(spacing[i]!.giveBack);
    let first = true;
    let last: Head | null = null;
    run.glyphs.forEach((g, n) => {
      const own = chars[n]!;
      // a code point after a glyph's first, at its origin, is one glyph with it
      if (last !== null && joinsHead(g, last.g)) {
        last.advance += own.reduce((sum, c) => sum + spcs[c]! / 100 / scale, 0);
        return;
      }
      if (own.length === 0) return; // a glyph of no character is not written: its advance is the next one's offset
      const advance = ((g.adv - run.spcPt) * written) / drawn + own.reduce((sum, c) => sum + spcs[c]! / 100 / scale, 0);
      last = { member, run: r, glyph: n, kept: i, g, blank: blank(g.u), unwritten: spcs[own[0]!] === 0 && spacing[i]!.wide[n] !== true, kerning: spacing[i]!.kerning[n] === true, advance };
      heads.push(last);
      const after = kept[i - 1]?.after;
      spaces.push(first && k.space && after !== undefined ? { width: after.width, spc: whole(spacing[i - 1]!.after! * scale * 100) / 100 / scale } : null);
      first = false;
    });
  });
  // whether PowerPoint reproduces the offset `off` after head `a` (the module's comment), with `space` between
  const reproduced = (a: Head, b: Head, space: Space | null, off: number): boolean => {
    if ((space !== null && space.width === null) || widthless[a.kept]! || widthless[b.kept]!) return true; // no prediction
    // K3: a space PowerPoint kerns with the glyph after it
    if (a.blank && space === null && a.kerning && kerned[a.kept]! && Math.abs(off) <= KERN_SHARE * sizes[a.kept]! + EPS) return true;
    if (a.blank || space !== null) {
      // its grid, and what it gives back of a snapped size: shorter spaces where the PDF draws the size larger
      const back = giveBacks[a.kept]!;
      const grid = off >= -GRID_SPACE_PT - Math.max(back, 0) - EPS && off <= GRID_SPACE_PT + Math.max(-back, 0) + EPS;
      // a space is judged by its own spc: one wide space written leaves the run's other spaces their grid
      return plain[a.kept]! && (space === null ? a.unwritten : space.spc === 0) && grid;
    }
    // K1: in a run written kern="0" at a size the template kerns, an offset up to KERN_PAIR_PT is the device grid K1
    // read it as, which PowerPoint redoes (it was excused as kerning before: a justified atlas/text/18 line split once)
    if (!kerned[a.kept]! && sizes[a.kept]! * scale >= TEMPLATE_KERN_PT - EPS && Math.abs(off) <= KERN_PAIR_PT + EPS) return true;
    return Math.abs(off) < SPACING_FLOOR_PT - EPS || (kerned[a.kept]! && Math.abs(off) <= KERN_SHARE * sizes[a.kept]! + EPS);
  };
  const residuals: number[] = heads.map(() => 0);
  for (let h = 1; h < heads.length; h++) {
    const [a, b] = [heads[h - 1]!, heads[h]!];
    const space = spaces[h]!;
    const off = frame.along(b.g) - frame.along(a.g) - a.advance - (space === null ? 0 : (space.width ?? 0) + space.spc);
    residuals[h] = residuals[h - 1]! + (reproduced(a, b, space, off) ? 0 : off);
  }
  return { heads, residuals, spaces };
}

/**
 * Each glyph's residual along `line` (pt): its PDF origin less the one predicted from what lowering writes (see the
 * module's comment), in the order of the line's members, their runs and the runs' glyphs; NaN where nothing is
 * predicted: a space glyph, a glyph lowering does not write (of a run it leaves out, a code point after a glyph's first,
 * a glyph of no character), and every glyph of a vertical line.
 */
export function lineDrift(line: TextLine, opts: DriftOptions): number[] {
  const base: number[][] = []; // where each run's glyphs start in the line's
  let total = 0;
  for (const el of line.els) {
    base.push(
      el.runs.map((run) => {
        total += run.glyphs.length;
        return total - run.glyphs.length;
      }),
    );
  }
  const out: number[] = new Array<number>(total).fill(Number.NaN);
  const found = predict(line, opts);
  if (found === null) return out;
  found.heads.forEach((head, h) => {
    if (!head.blank) out[base[head.member]![head.run]! + head.glyph] = found.residuals[h]!;
  });
  return out;
}

/** Where a line is cut: the first glyph of what follows, `line.els[member].runs[run].glyphs[glyph]`. */
export interface DriftCut {
  member: number;
  run: number;
  glyph: number;
}

/**
 * Where the guard cuts `line`, or null where it does not: at the last word boundary before the first glyph, not a space,
 * whose residual is more than `DRIFT_TOL_PT` (the first glyph, not a space, after a space glyph or a synthetic space,
 * with a glyph not a space before it), else at that glyph. A line whose only glyphs before it are spaces is not cut. A cut
 * before a member's first written glyph is at the member (`run` 0, `glyph` 0), whatever dropped runs it starts with.
 */
export function driftCut(line: TextLine, opts: DriftOptions): DriftCut | null {
  const found = predict(line, opts);
  if (found === null) return null;
  const { heads, residuals, spaces } = found;
  const over = heads.findIndex((head, h) => !head.blank && Math.abs(residuals[h]!) > DRIFT_TOL_PT + EPS);
  if (over < 0) return null;
  let seen = false; // a glyph not a space before
  let at: number | null = null;
  for (let h = 0; h < over; h++) {
    if (!heads[h]!.blank) seen = true;
    const next = heads[h + 1]!;
    if (seen && !next.blank && (heads[h]!.blank || spaces[h + 1] !== null)) at = h + 1;
  }
  if (!seen) return null;
  const head = heads[at ?? over]!;
  // no glyph the member writes before the cut: the runs before it are dropped (empty, size 0), so the cut is at the member
  // (it keeps its id) and not within it
  if (heads.find((x) => x.member === head.member) === head) return { member: head.member, run: 0, glyph: 0 };
  return { member: head.member, run: head.run, glyph: head.glyph };
}

/** The part of `run` from glyph `from` to glyph `to` (not included), its text the characters of those glyphs. */
function partOf(run: TextRun, from: number, to: number): TextRun {
  const glyphs = glyphsOfChars(run);
  let side = from === 0; // a character of no glyph goes with the glyph before it (the first part for one before any)
  let text = '';
  [...run.text].forEach((ch, c) => {
    const g = glyphs[c]!;
    if (g >= 0) side = g >= from && g < to;
    if (side) text += ch;
  });
  return { ...run, text, glyphs: run.glyphs.slice(from, to) };
}

/** `el` with only `runs`, its box (`bboxPt`) the part of its own along them, across as it was, and its baseline from `along`. */
function pieceOf(el: TextLineEl, runs: TextRun[], id: string, along: number | null): TextLineEl {
  const frame = textFrame(el);
  const [x0, y0, x1, y1] = el.bboxPt;
  const corners = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ].map(([x, y]) => ({ x: x!, y: y! }));
  const across = corners.map((p) => frame.across(p));
  const piece: TextLineEl = { ...el, id, runs };
  const u0 = along ?? Math.min(...corners.map((p) => frame.along(p)));
  const [bx, by] = frame.at(u0, 0);
  if (along !== null) piece.baseline = { x: bx, y: by };
  piece.bboxPt = frameBox(frame, u0, endOf(piece, frame), Math.min(...across), Math.max(...across));
  return piece;
}

/**
 * `line` cut at `cut` (`driftCut`): the line before it and the line from it, which starts with no separator. A member cut
 * within its runs is two: the first keeps its id; the second, from the cut, is `id` (a new element of its op), its
 * baseline the member's own at its first glyph.
 */
export function cutLine(line: TextLine, cut: DriftCut, id: string): [TextLine, TextLine] {
  const { member: j, run: r, glyph: g } = cut;
  if (r === 0 && g === 0) {
    return [
      { els: line.els.slice(0, j), before: line.before.slice(0, j) },
      { els: line.els.slice(j), before: ['none', ...line.before.slice(j + 1)] },
    ];
  }
  const el = line.els[j]!;
  const run = el.runs[r]!;
  const headRuns = [...el.runs.slice(0, r), ...(g > 0 ? [partOf(run, 0, g)] : [])];
  const tailRuns = [partOf(run, g, run.glyphs.length), ...el.runs.slice(r + 1)];
  const frame = textFrame(el);
  const head = pieceOf(el, headRuns, el.id, null);
  const tail = pieceOf(el, tailRuns, id, frame.along(run.glyphs[g]!));
  return [
    { els: [...line.els.slice(0, j), head], before: line.before.slice(0, j + 1) },
    { els: [tail, ...line.els.slice(j + 1)], before: ['none', ...line.before.slice(j + 1)] },
  ];
}

/** A box after the guard: its lines, the index in the slide's elements of its first run, and whether a split starts it. */
export interface GuardedBox {
  lines: TextLine[];
  first: number;
  split: boolean;
  /** A line of the box (before the guard split it) shows kerning (`boxKerning`): each of its lines is kerned. */
  kerned: boolean;
}

/**
 * M8 round 3a: whether a line of a box shows kerning by its own pairs (`lineKerning`), as lowering keeps it: then every
 * line of the box is kerned (`runSpacings`' `boxKerned`).
 */
export function boxKerning(lines: readonly TextLine[], opts: DriftOptions): boolean {
  return lines.some((line) => {
    const lead = line.els[0];
    if (lead === undefined || lead.wmode === 1) return false;
    const found = keptLine(line, textFrame(lead), opts.spaceWidths);
    if (found === null) return false;
    const [cos, sin] = direction(rot(lead.angleDeg) / 60000);
    return lineKerning(found.kept, cos, sin, false, opts.scale ?? 1);
  });
}

/**
 * The slide's boxes (`textBoxes`) after the guard (see the module's comment), in order: each box that drifts nowhere as
 * it was, else its parts. `elements` are the slide's, which the boxes' lines index, and give each new element its id.
 */
export function guardBoxes(elements: readonly Element[], boxes: readonly FoundLine[][], opts: DriftOptions): GuardedBox[] {
  const index = new Map<Element, number>();
  const taken = new Map<string, number>(); // each op's last `:n`
  const opOf = (id: string): [string, number] => {
    const found = /^(.*):(\d+)$/.exec(id);
    return found === null ? [id, 0] : [found[1]!, Number(found[2])];
  };
  elements.forEach((el, i) => {
    index.set(el, i);
    const [op, n] = opOf(el.id);
    taken.set(op, Math.max(taken.get(op) ?? 0, n));
  });
  const newId = (id: string): string => {
    const [op] = opOf(id);
    const n = (taken.get(op) ?? 0) + 1;
    taken.set(op, n);
    return `${op}:${n}`;
  };
  // the parts of a line, each with whether a split starts it and where its first run is in z-order; each part is
  // guarded again (a part's spacing as lowering writes it is its own), within the line's `MAX_DRIFT_CUTS`
  const parts = (line: TextLine, split: boolean, at: number, budget: { left: number }, kerned: boolean): { line: TextLine; split: boolean; first: number }[] => {
    const cut = budget.left > 0 ? driftCut(line, { ...opts, kerned }) : null;
    if (cut === null) return [{ line, split, first: at }];
    budget.left -= 1;
    const el = line.els[cut.member]!;
    const within = cut.run > 0 || cut.glyph > 0;
    const [before, after] = cutLine(line, cut, within ? newId(el.id) : el.id);
    const from = index.get(el) ?? at;
    if (within) for (const piece of [before.els.at(-1)!, after.els[0]!]) index.set(piece, from);
    return [...parts(before, split, at, budget, kerned), ...parts(after, true, from, budget, kerned)];
  };
  const out: GuardedBox[] = [];
  for (const box of boxes) {
    let open: TextLine[] = [];
    let first = box[0]!.first;
    const kerned = boxKerning(box.map((found) => ({ els: found.els, before: found.before })), opts);
    for (const found of box) {
      const line: TextLine = { els: found.els, before: found.before };
      const pieces = parts(line, false, found.first, { left: MAX_DRIFT_CUTS }, kerned);
      if (pieces.length === 1) {
        if (open.length === 0) first = found.first;
        open.push(line);
        continue;
      }
      if (open.length > 0) out.push({ lines: open, first, split: false, kerned });
      open = [];
      for (const piece of pieces) out.push({ lines: [piece.line], first: piece.first, split: piece.split, kerned });
    }
    if (open.length > 0) out.push({ lines: open, first, split: false, kerned });
  }
  return out;
}
