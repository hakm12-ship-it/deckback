import type { TextRun } from '../../scene/types';

/**
 * Synthetic italic and bold (M4 Task 2, spec §4.2 pass 7). PowerPoint draws the italic of a face that has none as a
 * shear of the text matrix, and its bold as a fill and a stroke in one colour; the Scene keeps that evidence raw on the
 * run (`skew`, `fillMode`, `stroke`) and the font's own style (`bold`, `italic`: nameID 2 of its program). A run whose
 * evidence is PowerPoint's and whose face does not have the style already is written `i="1"` / `b="1"`, which PowerPoint
 * draws the same way again:
 * - italic (`SYNTHETIC_ITALIC`): the skew, the tangent of the lean of the text's y axis towards its x axis, within `tol`
 *   of PowerPoint's 1/3 (`1 0 0.3333 1 x y Tm`), leaning forward. The Scene's size is the length of the y axis, which the
 *   shear lengthens by √(1 + skew²) (25.298 for 24 pt): such a run is written at the size of its em (`emSize`).
 * - bold (`SYNTHETIC_BOLD`): a fill and a stroke (Tr 2) in one solid colour and alpha, the stroke `ratio` x the size of
 *   the em wide, within `tol` of it. Measured on the atlas: every one of its 11 such runs (tables/05, charts/03; a family
 *   without a Bold face, `b="1"` in the source) is stroked the size / 35 (0.456 pt at 15.96 pt), as the harness's own
 *   reading of S2 has it. Such a run is written with no outline (`a:ln`): PowerPoint strokes it again.
 *
 * Review Focus 3: a face that is itself Italic (Bold) is `i` (`b`) from the face, once; its shear (stroke) is not taken
 * for a synthetic style, so its size is not corrected (the shear stays `text-skew`) and its stroke stays an outline.
 *
 * The size PowerPoint was asked for (ruling M4-R4, `snapSize`): PowerPoint's export draws a run from a font of its device
 * grid, the size rounded to 0.12 pt (1/600 in), or 0.024 pt past that for text it does not kern (`SIZE_MAP`; measured
 * on the atlas and atlas-win, whose source sizes are known: every size from 6 to 96 pt, 20 pt drawn at 20.04 or 20.064,
 * 16 at 15.96 or 15.984), while it lays the line out at the size asked for. Written at 20.064, PowerPoint lays the line out at that size, 0.3 %
 * longer (a 20 pt title ends 2.4 pt further on, M4 Task 2). So a size on the map is written as the half point that maps
 * to it; a size 0.024 pt past a grid point that no half point maps to, as that grid point (M4b Task 1: a reduced size,
 * small capitals drawn unkerned); one off the map (another producer's) is written as it is, in 100ths of a point. The
 * snap is counted once:
 * spacing measures a snapped run's glyphs against the font's advances at the snapped size (`RunStyle.scale`), so the
 * Tc with which PowerPoint brings a Korean run drawn at 20.064 back to 20 is not written again.
 */

export const SYNTHETIC_ITALIC = { skew: 1 / 3, tol: 0.02 } as const;
export const SYNTHETIC_BOLD = { ratio: 1 / 35, tol: 0.25 } as const;

/**
 * Ruling M4-R4, measured: PowerPoint draws a size on a `grid` of 0.12 pt, or `offsets` past it, for a size asked for in
 * half points (`step`), the nearest grid point; `tol` is the Scene's rounding of a size (3 decimals).
 */
export const SIZE_MAP = { grid: 0.12, offsets: [0, 0.024], step: 0.5, tol: 0.0015 } as const;

/**
 * The size PowerPoint was asked for, of a run it drew at `size` (pt): the half point whose grid point (`SIZE_MAP`), or
 * that point and an offset, is `size`; else, where `size` is a grid point and an offset but not a grid point itself,
 * that grid point (M4b Task 1: a reduced size, small capitals at 0.8 x 24 = 19.2 drawn unkerned at 19.224, whose asked
 * size is no half point; PowerPoint draws the grid point as it drew it); else `size` as it is.
 */
export function snapSize(size: number): number {
  const { grid, offsets, step, tol } = SIZE_MAP;
  const onGrid = (base: number, within: number): boolean => {
    const n = Math.round(base / grid);
    return n > 0 && Math.abs(base - n * grid) <= within;
  };
  for (const off of offsets) {
    const base = size - off;
    if (!onGrid(base, tol)) continue;
    const asked = Math.round(base / step) * step;
    if (asked > 0 && Math.abs(base - asked) <= grid / 2 + tol) return asked;
  }
  // a grid point and an offset exactly, as the Scene's 3 decimals hold PowerPoint's sizes (a size computed from a
  // shear, `emSize`, is not one)
  if (onGrid(size, tol)) return size;
  for (const off of offsets) if (off > 0 && onGrid(size - off, EXACT)) return Math.round((size - off) / grid) * grid;
  return size;
}

/** How near a size is to a grid point and an offset to be one exactly: the Scene's sizes are rounded to 3 decimals. */
const EXACT = 1e-6;

/**
 * How a run is written: its size (pt, before the page's scale: the size of its em for a synthetic italic, snapped to the
 * size PowerPoint was asked for), `scale` that size over the size the PDF draws it at (1 when not snapped), `b` and `i`,
 * and which of them are synthetic.
 */
export interface RunStyle {
  size: number;
  scale: number;
  bold: boolean;
  italic: boolean;
  /** The run's stroke is its bold: no `a:ln`. */
  syntheticBold: boolean;
  /** The run's skew is its italic: written at the size of its em, not recorded `text-skew`. */
  syntheticItalic: boolean;
}

/** The size of a run's em along its line (pt): the Scene's size, the length of the y axis, over √(1 + skew²). */
export const emSize = (run: TextRun): number => run.sizePt / Math.sqrt(1 + run.skew * run.skew);

const sameRgb = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Whether the run's skew is PowerPoint's synthetic italic. */
function shearedItalic(run: TextRun): boolean {
  return Math.abs(run.skew - SYNTHETIC_ITALIC.skew) <= SYNTHETIC_ITALIC.tol;
}

/** Whether the run's stroke is PowerPoint's synthetic bold: Tr 2 in its fill's solid colour and alpha, em / 35 wide. */
function strokedBold(run: TextRun): boolean {
  if (run.fillMode !== 'fillStroke' || run.stroke === null || run.fill === null || run.fill.kind !== 'solid') return false;
  const fill = run.rgb ?? run.fill.rgb;
  if (!sameRgb(run.stroke.rgb, fill) || run.stroke.alpha !== run.alpha) return false;
  const em = emSize(run);
  if (!(em > 0)) return false;
  return Math.abs(run.stroke.wPt / em - SYNTHETIC_BOLD.ratio) <= SYNTHETIC_BOLD.tol * SYNTHETIC_BOLD.ratio;
}

export function runStyle(run: TextRun): RunStyle {
  const syntheticItalic = !run.italic && shearedItalic(run);
  const syntheticBold = !run.bold && strokedBold(run);
  const drawn = syntheticItalic ? emSize(run) : run.sizePt;
  const size = snapSize(drawn);
  return {
    size,
    scale: size === drawn || !(drawn > 0) ? 1 : size / drawn,
    bold: run.bold || syntheticBold,
    italic: run.italic || syntheticItalic,
    syntheticBold,
    syntheticItalic,
  };
}
