import { canonicalPath } from './paths';
import type { RawOp } from './walker';

/**
 * The shared paint/glyph inventory contract. The pdf.js walker and the PyMuPDF oracle
 * (`harness/oracle/mupdf_inventory.py`) both emit it, and `compareInventories` checks one against the other.
 *
 * All geometry is in the slide frame: points, origin top-left, y down, page /Rotate and CropBox offset applied.
 */
export type Box = [x0: number, y0: number, x1: number, y1: number];

export interface Inventory {
  pages: PageInv[];
}

export interface PageInv {
  /** 0-based page index. */
  index: number;
  size: [w: number, h: number];
  /** In paint order. */
  paints: Paint[];
  glyphs: Glyph[];
  /** Text run with Tr 3 (docs/decisions/0002-inventory-contract.md §6 glyphs): it paints nothing, so it is no glyph. */
  invisible: InvisibleGlyph[];
}

/** One path segment, every point in the slide frame (docs/decisions/0002-inventory-contract.md §14 path geometry). */
export type PathSeg =
  | ['M', number, number]
  | ['L', number, number]
  | ['C', number, number, number, number, number, number]
  | ['Z'];

/**
 * A stroke's line style (0002 §15 line style). `w`, `dash` and `phase` are slide-frame points: the PDF value × `lineScale`
 * of the CTM. `cap` and `join` are the PDF's numbers, `miter` the PDF's limit.
 */
export interface LineInv {
  w: number;
  cap: 0 | 1 | 2;
  join: 0 | 1 | 2;
  miter: number;
  dash: number[];
  phase: number;
}

/** A matrix `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Ctm = [a: number, b: number, c: number, d: number, e: number, f: number];

/** What a `shade` is made of: MuPDF's shading types 1 (function-based), 2 (axial), 3 (radial) and 4 to 7 (meshes). */
export type ShadingKind = 'function' | 'axial' | 'radial' | 'mesh';

export interface Paint {
  /** `pattern`: something painted with a tiling pattern (its cell content is not a paint). */
  kind: 'fill' | 'stroke' | 'shade' | 'image' | 'pattern';
  /**
   * Geometry bbox; strokes are NOT expanded by the line width. Shades and patterns: bounded by the clip (one that
   * paints a stroke: as far as the stroke reaches, 0002 §15 line style).
   */
  bbox: Box;
  /** 0-255 integers; null for shade and pattern, and for an image that is no stencil (0002 §16). */
  rgb: [r: number, g: number, b: number] | null;
  /** 0-1. */
  alpha: number;
  /** False for every kind except fill. */
  evenOdd: boolean;
  /**
   * Set only by the walker, on a paint whose bbox comes from its approximate text-clip boxes (a shade or pattern
   * under a text clip, or filling text). The oracle never sets it; `compareInventories` then checks only the kind
   * and the position in the paint order.
   */
  approx?: true;
  /** fill, stroke: the path as drawn. Compared in its canonical form (`canonicalPath`). */
  path?: PathSeg[];
  /** stroke: its line style. */
  line?: LineInv;
  /**
   * image: the matrix of the PDF's unit square (its origin at the image's bottom left corner, its y axis up) in the slide
   * frame (0002 §16 images and shadings).
   */
  ctm?: Ctm;
  /** image: the picture's width and height in pixels. */
  px?: [w: number, h: number];
  /** image: an image mask, painted with `rgb`. */
  stencil?: boolean;
  /** shade: what kind of shading it is. */
  shading?: ShadingKind;
  /**
   * The clip in force when it is painted (0002 §5, §17): every clip that is on, cut to the page. A soft mask's area and an
   * image's own soft mask are not part of it; the shape MuPDF clips a pattern to before it paints it is.
   */
  clip: Box;
  /**
   * Set only by the walker, on a paint whose clip comes from its approximate text-clip boxes: `compareInventories` then
   * checks only that the clip is well formed (0002 §12).
   */
  clipApprox?: true;
  /** The product of the alphas of the transparency groups it is drawn in; `alpha` is its own (0002 §17). */
  groupAlpha: number;
  /** The first blend mode that is not `normal`, from the paint outward through its groups: a lower-case PDF name. */
  blend: string;
  /** A soft mask is over it: one of its own, or one a transparency group it is drawn in took (0002 §17). */
  masked: boolean;
}

/** A glyph origin on the baseline, and how the glyph is painted (0002 §6 glyphs). */
export interface Glyph {
  u: string;
  x: number;
  y: number;
  /** The exact font name, subset tag included: pdf.js `font.name`, MuPDF `fz_font_name` (at most 31 bytes, 0002 §12). */
  font: string;
  /** fontSize × |the y axis of the text matrix| in the slide frame. */
  size: number;
  /** Of the fill, or of the stroke when only that paints: 0-255 integers; null when that is a pattern, and for `clip`. */
  rgb: [number, number, number] | null;
  /** Of the fill, or of the stroke when only that paints; 1 for `clip`. */
  alpha: number;
  /** The product of the alphas of the transparency groups it is drawn in (0002 §17). */
  groupAlpha: number;
  /** Tr 0 and 4: fill; 1 and 5: stroke; 2 and 6: fillStroke; 7: clip. In a Type 3 font: fill. */
  paint: 'fill' | 'stroke' | 'fillStroke' | 'clip';
  wmode: 0 | 1;
  /** A Type 3 font, on both sides: MuPDF names it by its object number, so `font` is not compared (0002 §12). */
  type3?: true;
}

/** A glyph of invisible text. */
export interface InvisibleGlyph {
  u: string;
  x: number;
  y: number;
  font: string;
  type3?: true;
}

/** Inventory numbers are rounded to 3 decimals; -0 becomes 0. */
function r3(value: number): number {
  const v = Math.round(value * 1000) / 1000;
  return v === 0 ? 0 : v;
}

function roundSeg(seg: PathSeg): PathSeg {
  return seg.map((v) => (typeof v === 'number' ? r3(v) : v)) as PathSeg;
}

function roundLine(line: LineInv): LineInv {
  return {
    w: r3(line.w),
    cap: line.cap,
    join: line.join,
    miter: r3(line.miter),
    dash: line.dash.map(r3),
    phase: r3(line.phase),
  };
}

/** The product of the alphas of the groups a paint is drawn in (0002 §17). */
function groupAlphaOf(op: RawOp): number {
  return r3(op.groups.reduce((product, group) => product * group.alpha, 1));
}

/** The first blend mode that is not normal, from the paint outward through its groups (0002 §17). */
function blendOf(op: RawOp): string {
  if (op.blend !== 'normal') return op.blend;
  for (let i = op.groups.length - 1; i >= 0; i--) if (op.groups[i]!.blend !== 'normal') return op.groups[i]!.blend;
  return 'normal';
}

const roundBox = (box: Box): Box => [r3(box[0]), r3(box[1]), r3(box[2]), r3(box[3])];

/**
 * Builds the inventory of walked pages: the paints and glyphs of the RawOps, rounded as the contract asks. An operator a
 * lenient walk skipped (`unsupported`) is none of them.
 */
export function toInventory(pages: { index: number; size: [number, number]; ops: RawOp[] }[]): Inventory {
  return {
    pages: pages.map(({ index, size, ops }) => {
      const paints: Paint[] = [];
      const glyphs: Glyph[] = [];
      const invisible: InvisibleGlyph[] = [];
      for (const op of ops) {
        if (op.kind === 'unsupported') continue; // lenient mode only: no paint, as a Scene fallback gives none (M2-R17)
        if (op.kind === 'glyph' || op.kind === 'invisible') {
          const g = op.glyph;
          if (g === undefined) continue;
          const place = { u: g.u, x: r3(g.x), y: r3(g.y), font: g.font };
          const type3 = g.type3 === true ? { type3: true as const } : {};
          if (op.kind === 'invisible') {
            invisible.push({ ...place, ...type3 });
          } else {
            const rgb = op.rgb === null ? null : ([op.rgb[0], op.rgb[1], op.rgb[2]] as [number, number, number]);
            const state = { size: r3(g.size), rgb, alpha: r3(op.alpha), groupAlpha: groupAlphaOf(op) };
            glyphs.push({ ...place, ...state, paint: g.paint, wmode: g.wmode, ...type3 });
          }
          continue;
        }
        const coloured = op.kind === 'fill' || op.kind === 'stroke' || (op.kind === 'image' && op.stencil === true);
        const paint: Paint = {
          kind: op.kind,
          bbox: roundBox(op.bbox),
          rgb: coloured && op.rgb !== null ? [op.rgb[0], op.rgb[1], op.rgb[2]] : null,
          alpha: r3(op.alpha),
          evenOdd: op.kind === 'fill' ? op.evenOdd : false,
          clip: roundBox(op.clip),
          groupAlpha: groupAlphaOf(op),
          blend: blendOf(op),
          masked: op.masked || op.groups.some((group) => group.masked),
        };
        if (op.approx === true) paint.approx = true;
        if (op.clipApprox === true) paint.clipApprox = true;
        // A shade or pattern may carry the path and line it paints, for the Scene: the contract gives them neither (0002 §1).
        if (op.path !== undefined && (op.kind === 'fill' || op.kind === 'stroke')) paint.path = op.path.map(roundSeg);
        if (op.line !== undefined && op.kind === 'stroke') paint.line = roundLine(op.line);
        if (op.kind === 'image') {
          if (op.ctm !== undefined) paint.ctm = op.ctm.map(r3) as Ctm;
          if (op.px !== undefined) paint.px = [op.px[0], op.px[1]];
          if (op.stencil !== undefined) paint.stencil = op.stencil;
        }
        if (op.kind === 'shade' && op.shading !== undefined) paint.shading = op.shading.type;
        paints.push(paint);
      }
      return { index, size: [r3(size[0]), r3(size[1])], paints, glyphs, invisible };
    }),
  };
}

export interface Comparison {
  ok: boolean;
  /**
   * One line per disagreement, naming the page, the kind, the index and the field; at most MAX_DIFFS_PER_SECTION per
   * page section (paints, glyphs, invisible), the rest summarised in one "<page> <section>: N more diffs not listed" line.
   */
  diffs: string[];
  /** The number of disagreements, also those past a section's cap (a cap line is not one). */
  diffTotal: number;
  /** Largest bbox coordinate deviation over the paints that were paired up and compared by value (pt). */
  maxBboxDelta: number;
  /** Largest glyph-origin coordinate deviation over the glyphs, invisible ones too, that were paired up (pt). */
  maxGlyphDelta: number;
  /** Paired shades and patterns compared by kind and position only, because one side marked them `approx`. */
  approxPaints: number;
}

/** The default position tolerance of the comparison (pt; docs/decisions/0002-inventory-contract.md §12). */
export const TOLERANCE_PT = 0.05;
/** rgb channels may differ by one step: the two engines round 0-1 colour components differently. */
const RGB_TOL = 1;
/** Alpha may differ by one 8-bit step. */
const ALPHA_TOL = 1 / 255;
/** The miter limit is a ratio, not a position (0002 §12 comparison). */
const MITER_TOL = 0.01;
/** Absorbs binary floating-point noise in differences of 3-decimal numbers (0.05 must pass at 0.05). */
const EPS = 1e-9;
/** At most this many field diffs are listed per page and section; the rest are summarised in one line. */
const MAX_DIFFS_PER_SECTION = 50;

const KINDS: Paint['kind'][] = ['fill', 'stroke', 'shade', 'image', 'pattern'];

const isBlank = (u: unknown): boolean => typeof u === 'string' && u.trim() === '';
/** JSON for diff lines; NaN and the infinities are spelled out instead of becoming `null`. */
const fmt = (v: unknown): string =>
  JSON.stringify(v, (_key, x: unknown) => (typeof x === 'number' && !Number.isFinite(x) ? String(x) : x)) ?? String(v);

/** |a - b| when both are finite numbers; NaN otherwise (a missing or non-finite value), which no tolerance accepts. */
function absDelta(a: unknown, b: unknown): number {
  return typeof a === 'number' && typeof b === 'number' && Number.isFinite(a) && Number.isFinite(b)
    ? Math.abs(a - b)
    : NaN;
}

/** Written as `<=` on purpose: NaN fails it. */
const within = (delta: number, tol: number): boolean => delta <= tol + EPS;

const finiteNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);

/** True when `v` is an array of exactly `n` finite numbers. */
const finiteTuple = (v: unknown, n: number): boolean => Array.isArray(v) && v.length === n && v.every(finiteNumber);

/** The kinds whose bbox comes from the clip: only these may be `approx` (0002 §5 shade bbox). */
const APPROX_KINDS: ReadonlySet<Paint['kind']> = new Set(['shade', 'pattern']);

/** How many numbers follow the operator of each kind of path segment. */
const SEG_NUMBERS: ReadonlyMap<unknown, number> = new Map([['M', 2], ['L', 2], ['C', 6], ['Z', 0]]);

function isPath(v: unknown): v is PathSeg[] {
  return (
    Array.isArray(v) &&
    v.every(
      (seg: unknown) =>
        Array.isArray(seg) && SEG_NUMBERS.get(seg[0]) === seg.length - 1 && seg.slice(1).every(finiteNumber),
    )
  );
}

/** The largest coordinate deviation of two segments of the same operator. */
function segDelta(e: PathSeg, a: PathSeg): number {
  return e.reduce((max: number, v, i) => (typeof v === 'number' ? Math.max(max, absDelta(v, a[i])) : max), 0);
}

/**
 * The one diff of a path, or null: their canonical forms must have the same length and operators, and every coordinate
 * must be within `tolPt`. However many points differ, it is one line, naming the first difference (0002 §12).
 */
function pathDiff(expected: unknown, actual: unknown, tolPt: number): string | null {
  if (expected === undefined && actual === undefined) return null;
  if (!isPath(expected) || !isPath(actual)) {
    const brief = (v: unknown): string => fmt(v).slice(0, 200); // the other side may be a whole page's outline
    return `path expected ${brief(expected)} got ${brief(actual)} (not a path)`;
  }
  const e = canonicalPath(expected);
  const a = canonicalPath(actual);
  const same = (i: number): boolean => e[i]![0] === a[i]![0] && within(segDelta(e[i]!, a[i]!), tolPt);
  if (e.length !== a.length) {
    let i = 0;
    while (i < Math.min(e.length, a.length) && same(i)) i++;
    const seg = (s: PathSeg | undefined): string => (s === undefined ? 'none' : fmt(s));
    return (
      `path has ${a.length} segments, expected ${e.length}; ` +
      `first difference at segment ${i}: expected ${seg(e[i])} got ${seg(a[i])}`
    );
  }
  const other = e.findIndex((seg, i) => seg[0] !== a[i]![0]);
  if (other >= 0) return `path segment ${other} expected ${fmt(e[other])} got ${fmt(a[other])} (another operator)`;
  const off = e.flatMap((_, i) => (same(i) ? [] : [i]));
  if (off.length === 0) return null;
  const first = off[0]!;
  const delta = off.reduce((max, i) => Math.max(max, segDelta(e[i]!, a[i]!)), 0); // no spread: a path can be long
  const more = off.length > 1 ? `, ${off.length} segments differ` : '';
  return `path segment ${first} expected ${fmt(e[first])} got ${fmt(a[first])} (max |delta| ${r3(delta)} > ${tolPt}${more})`;
}

/** The diffs of a line style, one per field; a `line` missing on one side is one diff (0002 §12). */
function lineDiffs(expected: unknown, actual: unknown, tolPt: number): string[] {
  if (expected === undefined && actual === undefined) return [];
  const isObject = (v: unknown): v is Record<keyof LineInv, unknown> => typeof v === 'object' && v !== null;
  if (!isObject(expected) || !isObject(actual)) return [`line expected ${fmt(expected)} got ${fmt(actual)}`];
  const diffs: string[] = [];
  const field = (name: keyof LineInv, ok: boolean): void => {
    if (!ok) diffs.push(`line ${name} expected ${fmt(expected[name])} got ${fmt(actual[name])}`);
  };
  const near = (name: keyof LineInv, tol: number): boolean => within(absDelta(expected[name], actual[name]), tol);
  const sameInt = (name: keyof LineInv): boolean => Number.isInteger(expected[name]) && expected[name] === actual[name];
  const [dashE, dashA] = [expected.dash, actual.dash];
  field('w', near('w', tolPt));
  field('cap', sameInt('cap'));
  field('join', sameInt('join'));
  field('miter', near('miter', MITER_TOL));
  field(
    'dash',
    Array.isArray(dashE) &&
      Array.isArray(dashA) &&
      dashE.length === dashA.length &&
      dashE.every((v, i) => within(absDelta(v, dashA[i]), tolPt)),
  );
  field('phase', near('phase', tolPt));
  return diffs;
}

const SHADING_KINDS: ReadonlySet<unknown> = new Set<ShadingKind>(['function', 'axial', 'radial', 'mesh']);

/**
 * The diffs of the fields an image and a shade add (0002 §12, §16), a line for each of `ctm`, `px`, `stencil` and `shading`.
 * A field on one side only is a diff, on neither it is left alone; a malformed one is a diff on both sides.
 */
function placementDiffs(e: Paint, a: Paint, tolPt: number): string[] {
  const diffs: string[] = [];
  const said = (name: 'ctm' | 'px' | 'stencil' | 'shading'): boolean => e[name] !== undefined || a[name] !== undefined;
  const line = (name: string, expected: unknown, actual: unknown, why = ''): void => {
    diffs.push(`${name} expected ${fmt(expected)} got ${fmt(actual)}${why}`);
  };
  if (said('ctm')) {
    const [ec, ac] = [e.ctm, a.ctm];
    if (ec === undefined || ac === undefined || !finiteTuple(ec, 6) || !finiteTuple(ac, 6)) {
      line('ctm', ec, ac, ' (not 6 finite numbers)');
    } else {
      const delta = Math.max(...ec.map((v, i) => absDelta(v, ac[i])));
      if (!within(delta, tolPt)) line('ctm', ec, ac, ` (max |delta| ${r3(delta)} > ${tolPt})`);
    }
  }
  if (said('px')) {
    const size = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every((n) => Number.isInteger(n) && n > 0);
    if (!size(e.px) || !size(a.px) || e.px[0] !== a.px[0] || e.px[1] !== a.px[1]) line('px', e.px, a.px);
  }
  if (said('stencil') && (typeof e.stencil !== 'boolean' || e.stencil !== a.stencil)) line('stencil', e.stencil, a.stencil);
  if (said('shading') && (!SHADING_KINDS.has(e.shading) || e.shading !== a.shading)) line('shading', e.shading, a.shading);
  return diffs;
}

/** The PDF blend modes, as the contract names them: lower case, without hyphens (0002 §17). */
const BLEND_MODES: ReadonlySet<unknown> = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'colordodge',
  'colorburn',
  'hardlight',
  'softlight',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);

/**
 * The diffs of what every paint has (0002 §12, §17), a line for each of `clip`, `groupAlpha`, `blend` and `masked`. The clip
 * is compared like the bbox; when it is approximate (`clipByValue` false) it only has to be 4 finite numbers on each side.
 */
function sceneDiffs(e: Paint, a: Paint, tolPt: number, clipByValue: boolean): string[] {
  const diffs: string[] = [];
  if (!clipByValue) {
    for (const [side, paint] of [['expected', e], ['actual', a]] as const) {
      if (!finiteTuple(paint.clip, 4)) diffs.push(`${side} clip ${fmt(paint.clip)} (not 4 finite numbers)`);
    }
  } else if (!finiteTuple(e.clip, 4) || !finiteTuple(a.clip, 4)) {
    diffs.push(`clip expected ${fmt(e.clip)} got ${fmt(a.clip)} (not 4 finite numbers)`);
  } else {
    const delta = Math.max(...e.clip.map((v, i) => absDelta(v, a.clip[i])));
    if (!within(delta, tolPt)) diffs.push(`clip expected ${fmt(e.clip)} got ${fmt(a.clip)} (max |delta| ${r3(delta)} > ${tolPt})`);
  }
  if (!within(absDelta(e.groupAlpha, a.groupAlpha), ALPHA_TOL)) {
    diffs.push(`groupAlpha expected ${fmt(e.groupAlpha)} got ${fmt(a.groupAlpha)}`);
  }
  if (!BLEND_MODES.has(e.blend) || e.blend !== a.blend) diffs.push(`blend expected ${fmt(e.blend)} got ${fmt(a.blend)}`);
  if (typeof e.masked !== 'boolean' || e.masked !== a.masked) diffs.push(`masked expected ${fmt(e.masked)} got ${fmt(a.masked)}`);
  return diffs;
}

/** MuPDF keeps this many bytes of a font name (`fz_font.name` is a char[32]; 0002 §12). */
const FONT_NAME_BYTES = 31;
const UTF8 = new TextEncoder();

/** The oracle's name is the walker's, or the start of it when MuPDF had to cut it. Non-strings never match. */
function sameFontName(expected: unknown, actual: unknown): boolean {
  if (typeof expected !== 'string' || typeof actual !== 'string') return false;
  if (expected === actual) return true;
  return UTF8.encode(expected).length === FONT_NAME_BYTES && actual.startsWith(expected);
}

const GLYPH_PAINTS: ReadonlySet<unknown> = new Set(['fill', 'stroke', 'fillStroke', 'clip']);

function kindCounts(paints: Paint[]): string {
  return KINDS.map((k) => `${k} ${paints.filter((p) => p.kind === k).length}`).join(', ');
}

/** Collects diff lines for one page section, keeping at most MAX_DIFFS_PER_SECTION of them. */
class Section {
  readonly lines: string[] = [];
  private dropped = 0;

  constructor(readonly label: string) {}

  add(line: string): void {
    if (this.lines.length < MAX_DIFFS_PER_SECTION) this.lines.push(line);
    else this.dropped++;
  }

  /** Appends the kept lines (and the cap line) to `into`; returns the number of diffs the section had in all. */
  flush(into: string[]): number {
    into.push(...this.lines);
    if (this.dropped > 0) into.push(`${this.label}: ${this.dropped} more diffs not listed`);
    return this.lines.length + this.dropped;
  }
}

/**
 * The glyphs of one list, paired in order after dropping whitespace on both sides (0002 §8): count, `u`, origin, and
 * what `more` adds per pair. Returns the largest origin deviation.
 */
function compareGlyphs<G extends InvisibleGlyph>(
  section: Section,
  name: string,
  page: string,
  expected: readonly G[],
  actual: readonly G[],
  tolPt: number,
  more: (e: G, a: G, where: string) => void,
): number {
  let maxDelta = 0;
  const expGlyphs = expected.filter((g) => !isBlank(g.u));
  const actGlyphs = actual.filter((g) => !isBlank(g.u));
  if (expGlyphs.length !== actGlyphs.length) {
    section.add(`${section.label}: count expected ${expGlyphs.length} got ${actGlyphs.length} (whitespace excluded)`);
  }
  for (let i = 0; i < Math.min(expGlyphs.length, actGlyphs.length); i++) {
    const e = expGlyphs[i]!;
    const a = actGlyphs[i]!;
    const where = `${page} ${name} ${i} (${fmt(e.u)})`;
    if (e.u !== a.u) section.add(`${where}: u expected ${fmt(e.u)} got ${fmt(a.u)}`);
    for (const axis of ['x', 'y'] as const) {
      const delta = absDelta(e[axis], a[axis]);
      if (within(delta, tolPt)) {
        maxDelta = Math.max(maxDelta, delta);
        continue;
      }
      const why = Number.isNaN(delta) ? 'not a finite number' : `|delta| ${r3(delta)} > ${tolPt}`;
      section.add(`${where}: ${axis} expected ${fmt(e[axis])} got ${fmt(a[axis])} (${why})`);
      if (!Number.isNaN(delta)) maxDelta = Math.max(maxDelta, delta);
    }
    // Both sides say whether it is a Type 3 font; MuPDF's name for one means nothing to the walker.
    if (e.type3 !== a.type3) section.add(`${where}: type3 expected ${fmt(e.type3)} got ${fmt(a.type3)}`);
    const type3 = e.type3 === true || a.type3 === true;
    const nameOk = type3 ? typeof e.font === 'string' && typeof a.font === 'string' : sameFontName(e.font, a.font);
    if (!nameOk) section.add(`${where}: font expected ${fmt(e.font)} got ${fmt(a.font)}`);
    more(e, a, where);
  }
  return maxDelta;
}

/**
 * Compares the walker inventory (`actual`) with the oracle inventory (`expected`).
 *
 * - Pages are paired in order; their index and size must agree (size within `tolPt`).
 * - Paints: the per-kind counts and the kind sequence (paint order) must agree. Paints are then paired per kind,
 *   in order, so one extra fill does not shift every stroke: bbox within `tolPt`, rgb within 1 per channel
 *   (null only against null), alpha within 1/255, evenOdd equal. A shade or pattern pair where either side is
 *   `approx` (the walker's approximate text-clip bboxes) is checked by kind and position only, plus that its values
 *   are well formed, and counted in `approxPaints`. `approx` on any other kind is a diff.
 * - A paint's `path` (on both sides or neither): the canonical forms must have the same length and operators, every
 *   coordinate within `tolPt`; one diff per path. Its `line` (on both sides or neither): width, dash entries and phase
 *   within `tolPt`, miter limit within 0.01, cap and join equal; one diff per field.
 * - An image's `ctm` (every coefficient within `tolPt`, one diff for the matrix), `px` and `stencil` (equal), a shade's
 *   `shading` (equal), each on both sides or neither; a shade that is `approx` is compared on `shading` too.
 * - Every paint's `clip` (like the bbox; only well formed when either side is `approx` or `clipApprox`), `groupAlpha`
 *   (within 1/255), `blend` (one of the PDF modes, equal) and `masked` (equal); an `approx` paint on these too.
 * - Glyphs: whitespace-only glyphs are dropped on both sides; then the count must agree and glyphs are paired in
 *   order: same `u` and `paint` and `wmode`, origin and `size` within `tolPt`, rgb within 1 per channel (null only
 *   against null), alpha and groupAlpha within 1/255, the same font name (the oracle's may be cut at 31 bytes; Type 3
 *   fonts: not compared, but both sides must say `type3`).
 * - Invisible text: the same, with its `u`, origin and font.
 *
 * A missing or non-finite number (NaN, a bbox without exactly 4 numbers, a renamed key) is always a diff.
 */
export function compareInventories(expected: Inventory, actual: Inventory, tolPt = TOLERANCE_PT): Comparison {
  const diffs: string[] = [];
  let diffTotal = 0;
  const pageDiff = (line: string): void => {
    diffs.push(line);
    diffTotal++;
  };
  let maxBboxDelta = 0;
  let maxGlyphDelta = 0;
  let approxPaints = 0;
  const near = (a: unknown, b: unknown, tol: number): boolean => within(absDelta(a, b), tol);

  if (expected.pages.length !== actual.pages.length) {
    pageDiff(`pages: count expected ${expected.pages.length} got ${actual.pages.length}`);
  }
  const pageCount = Math.min(expected.pages.length, actual.pages.length);
  for (let p = 0; p < pageCount; p++) {
    const exp = expected.pages[p]!;
    const act = actual.pages[p]!;
    const page = `page ${exp.index}`;
    if (exp.index !== act.index) pageDiff(`${page}: index expected ${exp.index} got ${act.index}`);
    const sizeOk =
      finiteTuple(exp.size, 2) && finiteTuple(act.size, 2) && exp.size.every((v, i) => near(v, act.size[i], tolPt));
    if (!sizeOk) {
      pageDiff(`${page}: size expected ${fmt(exp.size)} got ${fmt(act.size)}`);
    }

    // Paints.
    const paintDiffs = new Section(`${page} paints`);
    if (exp.paints.length !== act.paints.length || kindCounts(exp.paints) !== kindCounts(act.paints)) {
      paintDiffs.add(
        `${page} paints: count expected ${exp.paints.length} (${kindCounts(exp.paints)}) ` +
          `got ${act.paints.length} (${kindCounts(act.paints)})`,
      );
    }
    const firstOrderDiff = exp.paints.findIndex((paint, i) => i < act.paints.length && act.paints[i]!.kind !== paint.kind);
    if (firstOrderDiff >= 0) {
      paintDiffs.add(
        `${page} paints: order differs first at paint ${firstOrderDiff}: ` +
          `expected ${exp.paints[firstOrderDiff]!.kind} got ${act.paints[firstOrderDiff]!.kind}`,
      );
    }
    for (const kind of KINDS) {
      const expIdx = exp.paints.flatMap((paint, i) => (paint.kind === kind ? [i] : []));
      const actIdx = act.paints.flatMap((paint, i) => (paint.kind === kind ? [i] : []));
      for (let k = 0; k < Math.min(expIdx.length, actIdx.length); k++) {
        const e = exp.paints[expIdx[k]!]!;
        const a = act.paints[actIdx[k]!]!;
        const where =
          expIdx[k] === actIdx[k]
            ? `${page} paint ${expIdx[k]} (${kind} #${k})`
            : `${page} paint ${expIdx[k]}/${actIdx[k]} (${kind} #${k}, expected/actual index)`;
        const approx = e.approx === true || a.approx === true;
        if (approx && !APPROX_KINDS.has(kind)) {
          // Not honoured: compared by value below.
          paintDiffs.add(`${where}: approx on a ${kind} paint (only shade and pattern may be approx)`);
        } else if (approx) {
          // Its kind and position were checked by the count and order checks above; its values are not compared,
          // but they must still be well formed.
          approxPaints++;
          for (const diff of placementDiffs(e, a, tolPt)) paintDiffs.add(`${where}: ${diff}`); // a kind of shading is exact
          for (const diff of sceneDiffs(e, a, tolPt, false)) paintDiffs.add(`${where}: ${diff}`); // and so are these
          for (const [side, paint] of [['expected', e], ['actual', a]] as const) {
            if (!finiteTuple(paint.bbox, 4)) {
              paintDiffs.add(`${where}: ${side} bbox ${fmt(paint.bbox)} (not 4 finite numbers)`);
            }
            if (paint.rgb !== null && !finiteTuple(paint.rgb, 3)) {
              paintDiffs.add(`${where}: ${side} rgb ${fmt(paint.rgb)} (neither null nor 3 finite numbers)`);
            }
            if (!finiteNumber(paint.alpha)) {
              paintDiffs.add(`${where}: ${side} alpha ${fmt(paint.alpha)} (not a finite number)`);
            }
            if (typeof paint.evenOdd !== 'boolean') {
              paintDiffs.add(`${where}: ${side} evenOdd ${fmt(paint.evenOdd)} (not a boolean)`);
            }
          }
          continue;
        }
        if (!finiteTuple(e.bbox, 4) || !finiteTuple(a.bbox, 4)) {
          paintDiffs.add(`${where}: bbox expected ${fmt(e.bbox)} got ${fmt(a.bbox)} (not 4 finite numbers)`);
        } else {
          const delta = Math.max(...e.bbox.map((v, i) => absDelta(v, a.bbox[i])));
          maxBboxDelta = Math.max(maxBboxDelta, delta);
          if (!within(delta, tolPt)) {
            paintDiffs.add(
              `${where}: bbox expected ${fmt(e.bbox)} got ${fmt(a.bbox)} (max |delta| ${r3(delta)} > ${tolPt})`,
            );
          }
        }
        const rgbOk =
          e.rgb === null || a.rgb === null
            ? e.rgb === a.rgb
            : finiteTuple(e.rgb, 3) && finiteTuple(a.rgb, 3) && e.rgb.every((v, i) => near(v, a.rgb![i], RGB_TOL));
        if (!rgbOk) paintDiffs.add(`${where}: rgb expected ${fmt(e.rgb)} got ${fmt(a.rgb)}`);
        if (!near(e.alpha, a.alpha, ALPHA_TOL)) paintDiffs.add(`${where}: alpha expected ${e.alpha} got ${a.alpha}`);
        if (e.evenOdd !== a.evenOdd) paintDiffs.add(`${where}: evenOdd expected ${e.evenOdd} got ${a.evenOdd}`);
        const path = pathDiff(e.path, a.path, tolPt);
        if (path !== null) paintDiffs.add(`${where}: ${path}`);
        for (const line of lineDiffs(e.line, a.line, tolPt)) paintDiffs.add(`${where}: ${line}`);
        for (const diff of placementDiffs(e, a, tolPt)) paintDiffs.add(`${where}: ${diff}`);
        const clipByValue = e.clipApprox !== true && a.clipApprox !== true;
        for (const diff of sceneDiffs(e, a, tolPt, clipByValue)) paintDiffs.add(`${where}: ${diff}`);
      }
    }
    diffTotal += paintDiffs.flush(diffs);

    // Glyphs (whitespace-only glyphs do not count on either side).
    const glyphDiffs = new Section(`${page} glyphs`);
    const glyphDelta = compareGlyphs(glyphDiffs, 'glyph', page, exp.glyphs, act.glyphs, tolPt, (e, a, where) => {
      if (!near(e.size, a.size, tolPt)) glyphDiffs.add(`${where}: size expected ${fmt(e.size)} got ${fmt(a.size)}`);
      const rgbOk =
        e.rgb === null || a.rgb === null
          ? e.rgb === a.rgb
          : finiteTuple(e.rgb, 3) && finiteTuple(a.rgb, 3) && e.rgb.every((v, i) => near(v, a.rgb![i], RGB_TOL));
      if (!rgbOk) glyphDiffs.add(`${where}: rgb expected ${fmt(e.rgb)} got ${fmt(a.rgb)}`);
      if (!near(e.alpha, a.alpha, ALPHA_TOL)) glyphDiffs.add(`${where}: alpha expected ${fmt(e.alpha)} got ${fmt(a.alpha)}`);
      if (!near(e.groupAlpha, a.groupAlpha, ALPHA_TOL)) {
        glyphDiffs.add(`${where}: groupAlpha expected ${fmt(e.groupAlpha)} got ${fmt(a.groupAlpha)}`);
      }
      if (!GLYPH_PAINTS.has(e.paint) || e.paint !== a.paint) {
        glyphDiffs.add(`${where}: paint expected ${fmt(e.paint)} got ${fmt(a.paint)}`);
      }
      if ((e.wmode !== 0 && e.wmode !== 1) || e.wmode !== a.wmode) {
        glyphDiffs.add(`${where}: wmode expected ${fmt(e.wmode)} got ${fmt(a.wmode)}`);
      }
    });
    maxGlyphDelta = Math.max(maxGlyphDelta, glyphDelta);
    diffTotal += glyphDiffs.flush(diffs);

    // Invisible text: it can only be missing altogether from a hand-made inventory.
    const invisibleDiffs = new Section(`${page} invisible`);
    if (!Array.isArray(exp.invisible) || !Array.isArray(act.invisible)) {
      invisibleDiffs.add(`${page} invisible: expected ${fmt(exp.invisible)} got ${fmt(act.invisible)} (not a list)`);
    } else {
      const delta = compareGlyphs(invisibleDiffs, 'invisible', page, exp.invisible, act.invisible, tolPt, () => {});
      maxGlyphDelta = Math.max(maxGlyphDelta, delta);
    }
    diffTotal += invisibleDiffs.flush(diffs);
  }
  return { ok: diffs.length === 0, diffs, diffTotal, maxBboxDelta, maxGlyphDelta, approxPaints };
}
