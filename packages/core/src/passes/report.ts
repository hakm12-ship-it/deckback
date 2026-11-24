import type { Note, SceneSlide } from '../scene/types';

/**
 * What the passes and lowering did to one slide, in fixed words (Global Constraints, Privacy): op names, element ids and
 * the words below, never deck text, font names or paths. `runPasses` makes it; `lowerSlide` completes it with what it
 * wrote (`counts`, `fallbacks`) and the approximations it made.
 */
export interface SlideReport {
  /** 1-based: the slide's page in the PDF (`SceneSlide.index` + 1). */
  index: number;
  class: PageClass;
  /** The uniform scale the page was drawn at to fit the slide (Task 9), to 6 decimals; null when that is 1. */
  scale: number | null;
  /** The nodes written, by kind. */
  counts: Counts;
  /**
   * The fallback elements with their reasons (fixed words): the first `REPORT_LIST_MAX` (`listFallback`);
   * `counts.fallbacks` counts them all. `raster` (M5 Task 2), for one the raster renderer drew as a picture: its size in
   * pixels and the scale it was drawn at, `pxPerPt`, 2 unless its box was past `FALLBACK_MAX_PX` (raster/raster.ts);
   * absent for one written as nothing.
   */
  fallbacks: { id: string; reason: string; raster?: { w: number; h: number; pxPerPt: number } }[];
  /** The fallbacks past the first `REPORT_LIST_MAX`, which `fallbacks` does not list (ruling M3-R59). */
  fallbacksTruncated: number;
  /**
   * Where the slide only approximates the PDF: an element id and one of `APPROXIMATIONS`, each pair once, the first
   * `REPORT_LIST_MAX` of them (`approximate`).
   */
  approximations: { id: string; kind: Approximation }[];
  /** The approximations past the first `REPORT_LIST_MAX`, which `approximations` does not list (ruling M3-R59). */
  approximationsTruncated: number;
  /** The Scene's notes of the slide, as they are, then those the passes add (a shading's fallback: `shadingFallbacks`). */
  notes: Note[];
  /** The Scene's `failed`, as it is. */
  failed: string | null;
}

/**
 * `image-only`: the page is pictures (no text, pictures over 90 % of it, no shape over 1 % of it painted); `print-frame`:
 * an A4 or Letter page with everything in a centred 16:9 or 4:3 box (a slide printed to PDF); else `vector`. Reported
 * only: nothing else changes with it in M3.
 */
export type PageClass = 'vector' | 'image-only' | 'print-frame';

export interface Counts {
  /** Text boxes: one per box of text assembly (M4 Task 1), a line, or the lines of one tagged `Textbox` or `P`. */
  textBoxes: number;
  freeforms: number;
  rects: number;
  lines: number;
  pictures: number;
  /** Shapes whose fill is a gradient (ruling M3-R43); also counted as a rect or a freeform. */
  gradients: number;
  hotspots: number;
  /** M5 Task 5: links written on runs (`runLinks`), each link once however many runs it is on. */
  runLinks: number;
  fallbacks: number;
}

/** The approximation kinds, fixed words: each pass and each part of lowering records only these (`dash-phase`: M3-R20). */
export const APPROXIMATIONS = [
  'nonzero-approx',
  'clip-dropped',
  'clip-approx',
  'group-alpha-folded',
  'mask-dropped',
  'blend-dropped',
  'tile-unsupported',
  'gradient-extend',
  'radial-offset',
  'gradient-alpha-mix',
  'skewed-picture',
  'anisotropic-line',
  'dash-phase',
  'hscale',
  'vertical-text',
  'text-skew',
  'text-pattern-fill',
  'type3-text',
  'text-drift-split',
] as const;

export type Approximation = (typeof APPROXIMATIONS)[number];

/** A report for `slide` before any pass: class `vector`, no scale, nothing counted. */
export function newReport(slide: SceneSlide): SlideReport {
  return {
    index: slide.index + 1,
    class: 'vector',
    scale: null,
    counts: { textBoxes: 0, freeforms: 0, rects: 0, lines: 0, pictures: 0, gradients: 0, hotspots: 0, runLinks: 0, fallbacks: 0 },
    fallbacks: [],
    fallbacksTruncated: 0,
    approximations: [],
    approximationsTruncated: 0,
    notes: slide.notes.map((note) => ({ ...note })),
    failed: slide.failed,
  };
}

/**
 * The most entries a slide's report lists in `approximations` and in `fallbacks` (ruling M3-R59): the rest are counted
 * (`approximationsTruncated`, `fallbacksTruncated`), so a few KB of PDF cannot make the report large, as `coveredOps`
 * (M3-R40) cannot make a fallback large. The deck's totals still count every one (`approximationCounts`, `counts`).
 */
export const REPORT_LIST_MAX = 1_000;

/** What `approximate` has recorded of a report: every (id, kind) pair, and how many of each kind, listed or not. */
interface Recorded {
  pairs: Set<string>;
  kinds: Map<Approximation, number>;
}

/** Kept beside each report `approximate` was given, so that each call is O(1) however long the slide's list is. */
const recorded = new WeakMap<SlideReport, Recorded>();

const pairKey = (id: string, kind: Approximation): string => `${id}\u0000${kind}`;

function recordOf(report: SlideReport): Recorded {
  let found = recorded.get(report);
  if (found === undefined) {
    found = { pairs: new Set(), kinds: new Map() };
    for (const { id, kind } of report.approximations) {
      found.pairs.add(pairKey(id, kind));
      found.kinds.set(kind, (found.kinds.get(kind) ?? 0) + 1);
    }
    recorded.set(report, found);
  }
  return found;
}

/**
 * Records that element `id` is approximated as `kind`, once per id and kind, in O(1): listed in `approximations` while
 * it holds fewer than `REPORT_LIST_MAX`, else counted in `approximationsTruncated` (ruling M3-R59).
 */
export function approximate(report: SlideReport, id: string, kind: Approximation): void {
  const record = recordOf(report);
  const key = pairKey(id, kind);
  if (record.pairs.has(key)) return;
  record.pairs.add(key);
  record.kinds.set(kind, (record.kinds.get(kind) ?? 0) + 1);
  if (report.approximations.length < REPORT_LIST_MAX) report.approximations.push({ id, kind });
  else report.approximationsTruncated += 1;
}

/** How many approximations of each kind the slide has, those past the list (`approximationsTruncated`) included. */
export function approximationCounts(report: SlideReport): ReadonlyMap<Approximation, number> {
  return recordOf(report).kinds;
}

/**
 * Lists fallback `id` with its `reason` (and the size of its raster, when it was drawn) while `fallbacks` holds fewer than
 * `REPORT_LIST_MAX`, else counts it (M3-R59).
 */
export function listFallback(report: SlideReport, id: string, reason: string, raster?: { w: number; h: number; pxPerPt: number }): void {
  if (report.fallbacks.length < REPORT_LIST_MAX) report.fallbacks.push(raster === undefined ? { id, reason } : { id, reason, raster });
  else report.fallbacksTruncated += 1;
}
