import type { PageData } from '../engine/pdfjs-adapter';
import type { BlendName, ClipDef } from '../scene/types';
import type { Box } from './inventory';
import type { TilingPattern } from './patterns';
import type { SoftMask } from './walker';

/** An affine matrix `[a, b, c, d, e, f]`: x' = a·x + c·y + e, y' = b·x + d·y + f (the PDF / pdf.js layout). */
export type Matrix = [a: number, b: number, c: number, d: number, e: number, f: number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** `m1 × m2` as pdf.js `Util.transform` computes it: the result applies `m2` first, then `m1`. */
export function concat(m1: Matrix, m2: ArrayLike<number>): Matrix {
  const [a, b, c, d, e, f] = [m2[0]!, m2[1]!, m2[2]!, m2[3]!, m2[4]!, m2[5]!];
  return [
    m1[0] * a + m1[2] * b,
    m1[1] * a + m1[3] * b,
    m1[0] * c + m1[2] * d,
    m1[1] * c + m1[3] * d,
    m1[0] * e + m1[2] * f + m1[4],
    m1[1] * e + m1[3] * f + m1[5],
  ];
}

/** A pdf.js 6-number matrix (array or typed array) as a `Matrix`. */
export function toMatrix(m: ArrayLike<number>): Matrix {
  return [m[0]!, m[1]!, m[2]!, m[3]!, m[4]!, m[5]!];
}

export function applyPoint(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** The `[a, b, c, d]` part of the pdf.js viewport transform for each page rotation (scale 1, y flipped). */
const ROTATIONS: Record<PageData['rotate'], [number, number, number, number]> = {
  0: [1, 0, 0, -1],
  90: [0, 1, 1, 0],
  180: [-1, 0, 0, 1],
  270: [0, -1, -1, 0],
};

/**
 * The page's user space → slide frame transform and the slide size, as pdf.js `PageViewport` computes them at
 * scale 1 (y flipped, `/Rotate` applied clockwise, the view box offset removed). UserUnit is not applied.
 */
export function pageFrame(page: Pick<PageData, 'view' | 'rotate'>): { matrix: Matrix; size: [number, number] } {
  const [x0, y0, x1, y1] = page.view;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const [ra, rb, rc, rd] = ROTATIONS[page.rotate];
  const sideways = ra === 0;
  const offX = sideways ? Math.abs(cy - y0) : Math.abs(cx - x0);
  const offY = sideways ? Math.abs(cx - x0) : Math.abs(cy - y0);
  const w = x1 - x0;
  const h = y1 - y0;
  return {
    matrix: [ra, rb, rc, rd, offX - ra * cx - rc * cy, offY - rb * cx - rd * cy],
    size: sideways ? [h, w] : [w, h],
  };
}

/** Grows a bounding box point by point. */
export class Bounds {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;

  add(x: number, y: number): void {
    if (x < this.x0) this.x0 = x;
    if (y < this.y0) this.y0 = y;
    if (x > this.x1) this.x1 = x;
    if (y > this.y1) this.y1 = y;
  }

  addBox(box: Box): void {
    this.add(box[0], box[1]);
    this.add(box[2], box[3]);
  }

  /** null while no point was added. */
  box(): Box | null {
    return this.x0 > this.x1 ? null : [this.x0, this.y0, this.x1, this.y1];
  }
}

/** Bounds of the rectangle `[x0, y0, x1, y1]` (any corner order) after `m`. */
export function transformBox(m: Matrix, rect: ArrayLike<number>): Box {
  const b = new Bounds();
  for (const [x, y] of [
    [rect[0]!, rect[1]!],
    [rect[2]!, rect[1]!],
    [rect[0]!, rect[3]!],
    [rect[2]!, rect[3]!],
  ] as const) {
    b.add(...applyPoint(m, x, y));
  }
  return b.box()!;
}

/** The intersection of two boxes; an empty intersection is `[0, 0, 0, 0]` (as in the oracle). */
export function intersect(a: Box, b: Box): Box {
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  return x1 < x0 || y1 < y0 ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** A fill or stroke colour: a solid colour or a pattern. */
export type Colour =
  | { kind: 'rgb'; rgb: [number, number, number] }
  /** A shading pattern: `id` names the pdf.js shading object; pattern space = `base` × `matrix`. */
  | { kind: 'shading'; id: string; matrix: Matrix | null; base: Matrix }
  /**
   * A tiling pattern, as pdf.js gives it; pattern space = `base` × its matrix. What it paints is one `pattern` paint; its
   * cell is pattern data, not page content (see docs/decisions/0002-inventory-contract.md §9 mask and pattern contents).
   */
  | { kind: 'tiling'; pattern: TilingPattern; base: Matrix };

/**
 * One clip of the chain in force: an immutable linked list, innermost first, which `q` keeps and `Q` restores with the
 * rest of the state. Nodes are shared, never changed: the Scene tells clips apart by node. `def` is in the walker's frame
 * (the slide frame, or a tile cell's space) and not rounded.
 */
export interface ClipNode {
  readonly def: ClipDef;
  readonly parent: ClipNode | null;
}

/** Text state parameters (PDF 9.3): part of the graphics state, so saved and restored with it. */
export interface TextParams {
  charSpacing: number;
  wordSpacing: number;
  /** Tz / 100. */
  hScale: number;
  /** TL, as in the PDF (T* moves by -TL). */
  leading: number;
  /** The id `setFont` names (not the font's `loadedName`). */
  fontId: string | null;
  /** |Tf size|. */
  fontSize: number;
  /** -1 when Tf was given a negative size (pdf.js `fontDirection`). */
  fontDirection: 1 | -1;
  renderMode: number;
  rise: number;
}

export interface GState {
  /** User space → slide frame (the page frame transform is folded in). */
  ctm: Matrix;
  fill: Colour;
  stroke: Colour;
  fillAlpha: number;
  strokeAlpha: number;
  lineWidth: number;
  /** J, 0-2. */
  lineCap: 0 | 1 | 2;
  /** j, 0-2. */
  lineJoin: 0 | 1 | 2;
  miterLimit: number;
  dash: [array: number[], phase: number];
  /** The current clip: intersection of every active clip bbox and the page (slide frame). */
  clip: Box;
  /** True once a text clip (approximated by advance boxes) has narrowed `clip` (0002 §5 shade bbox). */
  clipApprox: boolean;
  /** The clips that make `clip`, innermost first (the Scene's `clips`); null when only the page (or the cell) bounds it. */
  clipChain: ClipNode | null;
  /** A soft mask is in force: set by a gs `/SMask` dictionary, ended by `/SMask /None` and by `Q` (0002 §10 soft-mask area). */
  masked: boolean;
  /**
   * The mask in force was taken by a transparency group, which applies it to itself as a whole: nothing drawn inside gets
   * it, so MuPDF does not clip those objects to their own bounds. A mask set inside the group is a new one (0002 §10).
   * What is drawn inside is still under the group's mask: the group's frame says so (0002 §17).
   */
  maskInGroup: boolean;
  /** The soft mask `masked` says is in force, with what it draws; null when none is. */
  softMask: SoftMask | null;
  /** The blend mode (gs `/BM`) as a lower-case PDF name without hyphens: `normal`, `multiply`, ... (0002 §17). */
  blend: BlendName;
  text: TextParams;
}

/** The state a content stream starts in: black, alpha 1, no clip but `clip` (the page, or a tile cell's /BBox). */
export function initialState(ctm: Matrix, clip: Box): GState {
  const black: Colour = { kind: 'rgb', rgb: [0, 0, 0] };
  return {
    ctm,
    fill: black,
    stroke: black,
    fillAlpha: 1,
    strokeAlpha: 1,
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    miterLimit: 10,
    dash: [[], 0],
    clip,
    clipApprox: false,
    clipChain: null,
    masked: false,
    maskInGroup: false,
    softMask: null,
    blend: 'normal',
    text: {
      charSpacing: 0,
      wordSpacing: 0,
      hScale: 1,
      leading: 0,
      fontId: null,
      fontSize: 0,
      fontDirection: 1,
      renderMode: 0,
      rise: 0,
    },
  };
}

/**
 * The q/Q stack. States are copied on write (`set`, `setText`), never mutated in place, so `save` just keeps a
 * reference.
 */
export class GStateStack {
  current: GState;
  private readonly saved: GState[] = [];

  constructor(initial: GState) {
    this.current = initial;
  }

  save(): void {
    this.saved.push(this.current);
  }

  /** Returns false for an unbalanced Q (ignored, as pdf.js and MuPDF do). */
  restore(): boolean {
    const top = this.saved.pop();
    if (top === undefined) return false;
    this.current = top;
    return true;
  }

  /** Changes the current state (copy on write). */
  set(change: Partial<GState>): void {
    this.current = { ...this.current, ...change };
  }

  setText(change: Partial<TextParams>): void {
    this.current = { ...this.current, text: { ...this.current.text, ...change } };
  }
}
