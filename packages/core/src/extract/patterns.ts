import type { PageData } from '../engine/pdfjs-adapter';
import { toMatrix, type Matrix } from './gstate';
import type { Box } from './inventory';

/**
 * What pdf.js' pattern IRs say, read for the walker and the Scene: a tiling pattern as `setFillColorN` gives it, and the
 * stops of an axial or radial shading.
 */

type Rgb = [r: number, g: number, b: number];

/**
 * pdf.js `BaseShading.SMALL_NUMBER`: at an end of a gradient that does not extend, pdf.js adds a stop there and moves the
 * stop beside it inward by this much (`RadialAxialShading`).
 */
const PDFJS_SMALL_NUMBER = 1e-6;

/** A CSS `#rrggbb` colour, as pdf.js sends every solid colour, as 0-255 integers; null for anything else. */
export function hexRgb(value: unknown): Rgb | null {
  const m = typeof value === 'string' ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value) : null;
  return m === null ? null : [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)];
}

/**
 * A tiling pattern (pdf.js `getTilingPatternIR`: `['TilingPattern', color, operatorList, matrix, bbox, xstep, ystep,
 * paintType, tilingType, needsIsolation]`).
 */
export interface TilingPattern {
  /** PaintType 2 (uncoloured): the colour `scn` gave it, which the cell paints in; null for PaintType 1. */
  colour: Rgb | null;
  /**
   * The cell's own operator list: what it draws, in cell space. It is the IR object pdf.js gives, not a copy: pdf.js
   * reads a pattern's content once per content stream (`localTilingPatternCache`) and hands that one object to every
   * `scn` that names the pattern, so the walker can walk the cell once (`Walker.cellOf`).
   */
  ops: PageData['ops'];
  /** /Matrix: pattern space to the base transform's space. */
  matrix: Matrix;
  /** /BBox, as pdf.js normalised it (x0 < x1, y0 < y1). */
  bbox: Box;
  xStep: number;
  yStep: number;
  paintType: 1 | 2;
}

const isNumbers = (value: unknown, length: number): value is ArrayLike<number> =>
  typeof value === 'object' &&
  value !== null &&
  (value as ArrayLike<unknown>).length === length &&
  Array.from(value as ArrayLike<unknown>).every((v) => typeof v === 'number' && Number.isFinite(v));

/**
 * The tiling pattern of `setFillColorN` / `setStrokeColorN` arguments that name one. A pattern pdf.js gave in another form,
 * or whose paint type is neither 1 nor 2 (which pdf.js cannot draw either), is an error naming what is wrong in fixed
 * words.
 */
export function tilingPattern(args: readonly unknown[]): TilingPattern | string {
  const [, color, ops, matrix, bbox, xStep, yStep, paintType] = args;
  if (paintType !== 1 && paintType !== 2) return `tiling pattern of paint type ${String(paintType)}`;
  const list = ops as { fnArray?: unknown; argsArray?: unknown } | null | undefined;
  if (!Array.isArray(list?.fnArray) || !Array.isArray(list.argsArray)) return 'tiling pattern without a cell';
  if (!isNumbers(matrix, 6) || !isNumbers(bbox, 4) || typeof xStep !== 'number' || typeof yStep !== 'number') {
    return 'tiling pattern without its geometry';
  }
  return {
    colour: paintType === 2 ? hexRgb(color) : null,
    ops: list as PageData['ops'],
    matrix: toMatrix(matrix),
    bbox: [bbox[0]!, bbox[1]!, bbox[2]!, bbox[3]!],
    xStep,
    yStep,
    paintType,
  };
}

/**
 * The stops of an axial or radial shading from pdf.js' `colorStops` (`[t, '#rrggbb' | 'transparent']`, t from 0 at the
 * start point to 1 at the end point), and whether it extends at each end. pdf.js samples the shading's function into
 * stops from t 0 to t 1; at an end that does not extend it adds a stop of the shading's /Background there, `transparent`
 * when it has none, and moves the stop beside it inward by 1e-6. So a `transparent` first or last stop means no extend
 * at that end: it is dropped from the stops, and the stop beside it moved back. Null when no stop is left or a stop has a
 * colour that is neither.
 */
export function gradientStops(
  colorStops: readonly (readonly [number, string])[],
): { stops: { t: number; rgb: Rgb }[]; extend: [boolean, boolean] } | null {
  const list = colorStops.map(([t, colour]) => [t, colour] as [number, string]);
  const extend: [boolean, boolean] = [true, true];
  if (list[0]?.[1] === 'transparent') {
    extend[0] = false;
    list.shift();
    if (list[0] !== undefined) list[0][0] -= PDFJS_SMALL_NUMBER;
  }
  if (list.at(-1)?.[1] === 'transparent') {
    extend[1] = false;
    list.pop();
    const last = list.at(-1);
    if (last !== undefined) last[0] += PDFJS_SMALL_NUMBER;
  }
  const stops: { t: number; rgb: Rgb }[] = [];
  for (const [t, colour] of list) {
    const rgb = hexRgb(colour);
    if (rgb === null || !Number.isFinite(t)) return null;
    stops.push({ t: Math.min(1, Math.max(0, t)), rgb });
  }
  return stops.length === 0 ? null : { stops, extend };
}
