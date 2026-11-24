import { linkTarget } from '@deckback/ooxml';
import type { Box } from '../extract/inventory';
import type { Element, HotspotEl, Note, SceneSlide, TextLineEl } from '../scene/types';
import { linkedPage } from './lower/slide';

/**
 * Run-level links (M5 Task 5, ruling M3-R1). A link annotation whose rect covers exactly whole runs of one line, within
 * `LINK_TOL`, goes on those runs (`LinkedText.link`), which lowering writes as `a:hlinkClick` on each run it makes of
 * them (in the run's own colour, its forced underline given no fill: ooxml text.ts). The hotspot stays in the slide's
 * elements, marked written on its runs (`PassedHotspot.onRuns`): lowering writes no node for it and counts it a run link,
 * and `convert` still counts it when it goes to a page not converted. Any other link stays a hotspot (an empty rect with
 * the link, as before).
 *
 * "Exactly whole runs of one line", for an upright horizontal line (angle 0, `wmode` 0; any other text keeps its
 * hotspots): the runs whose advance boxes lie within the rect along the line (`LINK_TOL` either side) and meet it
 * across are all on one baseline; the rect's middle, across, lies within their height; no other run of that line cuts
 * into it by more than `LINK_TOL`; and the runs reach both its ends, within `LINK_TOL`. PowerPoint exports a hyperlink
 * so: its rect spans the linked runs' advances, across within their line, or a highlight's height (atlas text/14).
 *
 * Only a link the writer keeps goes on runs: one with a URL it takes (`linkTarget`), or one to a page. A link it would
 * drop, or one with no target (final review F6), stays a hotspot, which is dropped and counted once there (not once a
 * run). A run another link took first keeps that link; the later one stays a hotspot. A new slide; the input is not
 * changed.
 *
 * Bounded (final review I4): the runs are sorted once by their tops, so a link looks only at those that may meet its rect
 * across (a band of the slide's lines), each once, and the runs a slide's links look at in all are at most
 * `RUN_LINK_WORK`; past it a link stays a hotspot, and the slide has the note `RUN_LINK_BUDGET_NOTE` (op `link`).
 */

/** How far (pt) a link's rect may be from the runs it covers, along and across their line. */
export const LINK_TOL = 0.5;
/**
 * The runs the links of one slide may look at in all (final review I4): far past a page of text with a link on every run
 * (2,000 links on 100 lines look at about 40,000); 7,000 links over 7,000 runs on one line, within the slide's weight
 * budget, would look at 49 M.
 */
export const RUN_LINK_WORK = 1_000_000;
export const RUN_LINK_BUDGET_NOTE = 'run links past the slide budget';

/** A text run with the link a rect put on it (`runLinks`); absent for none. */
export interface LinkedText extends TextLineEl {
  link?: HotspotEl['link'];
}

/** A hotspot as the passes leave it: `onRuns` when its link went on runs (`runLinks`) and it is no node of its own. */
export interface PassedHotspot extends HotspotEl {
  onRuns?: true;
}

/** Whether the writer keeps a link: a URL it takes, or a page of the PDF. */
function kept(link: HotspotEl['link']): boolean {
  if (link.url !== null) return typeof linkTarget({ kind: 'url', url: link.url }, 1) !== 'string';
  return linkedPage(link) !== null;
}

/**
 * A slide's upright runs, sorted once by the tops of their boxes (`order`, `tops`; ties in z-order), and the tallest box:
 * the runs a rect may meet across are the band of those whose tops lie within the tallest box's height above it.
 */
export interface RunIndex {
  runs: readonly TextLineEl[];
  order: number[];
  tops: number[];
  tallest: number;
  /** Which runs are inside the rect being looked at (cleared after each). */
  marked: Uint8Array;
}

export function indexRuns(runs: readonly TextLineEl[]): RunIndex {
  const order = runs.map((_, i) => i).sort((a, b) => runs[a]!.bboxPt[1] - runs[b]!.bboxPt[1] || a - b);
  let tallest = 0;
  for (const r of runs) tallest = Math.max(tallest, r.bboxPt[3] - r.bboxPt[1]);
  return { runs, order, tops: order.map((i) => runs[i]!.bboxPt[1]), tallest, marked: new Uint8Array(runs.length) };
}

/** The first place in `sorted` (ascending) whose value is at least `v`. */
function lowerBound(sorted: readonly number[], v: number): number {
  let [lo, hi] = [0, sorted.length];
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The indexes (into the index's runs, a slide's upright text runs, in z-order) of the runs `rect` covers exactly (the
 * module comment), or null; `'over-budget'`, nothing looked at, when the band of runs it would look at is past what is
 * left of `budget`. Only runs that meet the rect across can be inside it or cut into it, and those lie in the band
 * (`RunIndex`, with a point to spare), so the answer is the one a look at every run would give.
 */
export function covered(rect: Box, index: RunIndex, budget: { left: number }): number[] | null | 'over-budget' {
  const [rx0, ry0, rx1, ry1] = rect;
  const { runs, order, tops, marked } = index;
  const meets = (b: Box): boolean => b[1] < ry1 && b[3] > ry0;
  const [from, to] = [lowerBound(tops, ry0 - index.tallest - 1), lowerBound(tops, ry1)];
  const band = Math.max(0, to - from);
  if (!(band <= budget.left)) return 'over-budget';
  budget.left -= band;
  const inside: number[] = [];
  for (let k = from; k < to; k++) {
    const i = order[k]!;
    const b = runs[i]!.bboxPt;
    if (b[0] >= rx0 - LINK_TOL && b[2] <= rx1 + LINK_TOL && meets(b)) inside.push(i);
  }
  if (inside.length === 0) return null;
  inside.sort((a, b) => a - b);
  const base = runs[inside[0]!]!.baseline.y;
  if (inside.some((i) => Math.abs(runs[i]!.baseline.y - base) > LINK_TOL)) return null;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const i of inside) {
    const b = runs[i]!.bboxPt;
    [x0, y0, x1, y1] = [Math.min(x0, b[0]), Math.min(y0, b[1]), Math.max(x1, b[2]), Math.max(y1, b[3])];
  }
  const middle = (ry0 + ry1) / 2;
  if (middle < y0 || middle > y1) return null;
  if (Math.abs(x0 - rx0) > LINK_TOL || Math.abs(x1 - rx1) > LINK_TOL) return null;
  for (const i of inside) marked[i] = 1;
  let cut = false;
  for (let k = from; k < to && !cut; k++) {
    const i = order[k]!;
    const r = runs[i]!;
    cut = marked[i] === 0 && Math.abs(r.baseline.y - base) <= LINK_TOL && meets(r.bboxPt) && r.bboxPt[0] < rx1 - LINK_TOL && r.bboxPt[2] > rx0 + LINK_TOL;
  }
  for (const i of inside) marked[i] = 0;
  return cut ? null : inside;
}

/**
 * The pass (the module comment), over the slide's elements: before text assembly, whose runs then carry their links.
 * Its note, past `RUN_LINK_WORK`, goes into `notes` too.
 */
export function runLinks(slide: SceneSlide, notes: Note[] | null = null): SceneSlide {
  const at: number[] = [];
  const runs: TextLineEl[] = [];
  slide.elements.forEach((el, i) => {
    if (el.kind === 'textline' && el.angleDeg === 0 && el.wmode === 0) {
      at.push(i);
      runs.push(el);
    }
  });
  const taken = new Map<number, HotspotEl['link']>();
  const written = new Set<number>();
  let index: RunIndex | null = null;
  const budget = { left: RUN_LINK_WORK };
  let spent = false;
  slide.elements.forEach((el, i) => {
    if (el.kind !== 'hotspot' || !kept(el.link) || runs.length === 0) return;
    index ??= indexRuns(runs);
    const found = covered(el.rect, index, budget);
    if (found === 'over-budget') {
      spent = true;
      return;
    }
    if (found === null || found.some((k) => taken.has(at[k]!))) return;
    for (const k of found) taken.set(at[k]!, el.link);
    written.add(i);
  });
  const added: Note[] = spent ? [{ opIndex: 0, op: 'link', detail: RUN_LINK_BUDGET_NOTE }] : [];
  if (notes !== null) notes.push(...added.map((n) => ({ ...n })));
  if (written.size === 0) return added.length === 0 ? slide : { ...slide, notes: [...slide.notes, ...added] };
  const elements = slide.elements.map((el, i): Element => {
    const link = taken.get(i);
    if (link !== undefined) return { ...(el as TextLineEl), link } as LinkedText;
    return written.has(i) ? ({ ...(el as HotspotEl), onRuns: true } as PassedHotspot) : el;
  });
  return { ...slide, elements, notes: [...slide.notes, ...added] };
}
