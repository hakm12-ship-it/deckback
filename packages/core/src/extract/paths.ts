import { UnsupportedOpError } from './errors';
import { applyPoint, Bounds, IDENTITY, type Matrix } from './gstate';
import type { Box, LineInv, PathSeg } from './inventory';

/**
 * Path geometry in the slide frame: what a `constructPath` buffer draws, its bounds, the form two engines' paths are
 * compared in, and how far a stroke reaches. docs/decisions/0002-inventory-contract.md §4 path bbox, §14 path geometry,
 * §15 line style.
 */

/** pdf.js `DrawOPS`: the commands of a `constructPath` buffer. */
const DRAW = { moveTo: 0, lineTo: 1, curveTo: 2, closePath: 4 } as const;
/** C's FLT_EPSILON: MuPDF's `fz_is_rectilinear` takes a CTM entry smaller than this for 0. */
const FLT_EPSILON = 1.1920928955078125e-7;
/** Under a CTM that turns the axes, a line this close to an axis in the slide frame (pt) counts as along it (0002 §15). */
const AXIS_TOLERANCE = 0.001;

/** The segments of a pdf.js `constructPath` buffer (`DrawOPS`, in user space), every point moved to the slide frame by `m`. */
export function segmentsOf(data: ArrayLike<number>, m: Matrix): PathSeg[] {
  const segs: PathSeg[] = [];
  const point = (k: number): [number, number] => applyPoint(m, data[k]!, data[k + 1]!);
  for (let k = 0; k < data.length; ) {
    const command = data[k++];
    switch (command) {
      case DRAW.moveTo:
        segs.push(['M', ...point(k)]);
        k += 2;
        break;
      case DRAW.lineTo:
        segs.push(['L', ...point(k)]);
        k += 2;
        break;
      case DRAW.curveTo:
        segs.push(['C', ...point(k), ...point(k + 2), ...point(k + 4)]);
        k += 6;
        break;
      case DRAW.closePath:
        segs.push(['Z']);
        break;
      default:
        throw new UnsupportedOpError('constructPath', `path command ${String(command)}`, 'path command the walker does not model');
    }
  }
  return segs;
}

/**
 * Bounds of the path's points, bezier control points included (0002 §4 path bbox). As in MuPDF, a moveTo only counts
 * once a segment follows it, or a close if `m`, the CTM that put the path in the slide frame, keeps the axes; so a
 * trailing or repeated moveTo adds nothing, and whatever comes before the first moveTo has no current point and does
 * not count. null when the path has nothing that counts: such a path is no paint.
 */
export function boundsOf(segs: PathSeg[], m: Matrix = IDENTITY): Box | null {
  const closeCounts = keepsAxes(m);
  const bounds = new Bounds();
  let move: [number, number] | null = null;
  let started = false;
  const flushMove = (): void => {
    if (move !== null) bounds.add(...move);
    move = null;
  };
  for (const seg of segs) {
    switch (seg[0]) {
      case 'M':
        move = [seg[1], seg[2]];
        started = true;
        break;
      case 'L':
        if (!started) break;
        flushMove();
        bounds.add(seg[1], seg[2]);
        break;
      case 'C':
        if (!started) break;
        flushMove();
        bounds.add(seg[1], seg[2]);
        bounds.add(seg[3], seg[4]);
        bounds.add(seg[5], seg[6]);
        break;
      case 'Z':
        if (started && closeCounts) flushMove();
        break;
    }
  }
  return bounds.box();
}

const sameXY = (x0: number, y0: number, x1: number, y1: number): boolean => x0 === x1 && y0 === y1;

/** MuPDF's `fz_curveto` makes a line of a curve whose control points add nothing (0002 §14). */
function curveIsLine(x0: number, y0: number, seg: Extract<PathSeg, ['C', ...number[]]>): boolean {
  const [, x1, y1, x2, y2, x3, y3] = seg;
  const startsFlat = sameXY(x0, y0, x1, y1);
  const endsFlat = sameXY(x2, y2, x3, y3);
  return (startsFlat && endsFlat) || (startsFlat && sameXY(x1, y1, x2, y2)) || (endsFlat && sameXY(x1, y1, x2, y2));
}

/**
 * The form two engines' paths are compared in (0002 §14 path geometry): MuPDF's normalisation of a path, applied to the
 * segments of either side. It does not change what the path draws, and leaves its argument alone.
 */
export function canonicalPath(segs: PathSeg[]): PathSeg[] {
  const out: PathSeg[] = [];
  let current: [number, number] | null = null;
  let start: [number, number] = [0, 0];
  const line = (x: number, y: number): void => {
    // A lineTo to the current point is dropped, except right after a moveTo: that one is a dot.
    if (sameXY(current![0], current![1], x, y) && out.at(-1)?.[0] !== 'M') return;
    out.push(['L', x, y]);
    current = [x, y];
  };
  for (const seg of segs) {
    if (seg[0] === 'M') {
      if (out.at(-1)?.[0] === 'M') out.pop(); // a moveTo collapses into the next one
      out.push(seg);
      current = start = [seg[1], seg[2]];
    } else if (current === null) {
      // Nothing before the first moveTo: there is no current point.
    } else if (seg[0] === 'L') {
      line(seg[1], seg[2]);
    } else if (seg[0] === 'C') {
      if (curveIsLine(current[0], current[1], seg)) {
        line(seg[5], seg[6]);
      } else {
        out.push(seg);
        current = [seg[5], seg[6]];
      }
    } else if (out.at(-1)?.[0] !== 'Z') {
      out.push(seg); // a second close adds nothing
      current = start;
    }
  }
  if (out.at(-1)?.[0] === 'M') out.pop(); // a trailing moveTo draws nothing

  // pdf.js writes a rectangle of no width or height as M L Z, MuPDF walks all four corners: one form for both.
  const tidy: PathSeg[] = [];
  let begin: PathSeg = ['Z'];
  out.forEach((seg, i) => {
    const previous = tidy.at(-1);
    const next = out[i + 1]?.[0];
    if (seg[0] === 'M') begin = seg;
    if (seg[0] === 'L' && previous !== undefined) {
      const afterMove = previous[0] === 'M';
      // A dot that goes on is no dot.
      if (afterMove && (next === 'L' || next === 'C') && sameXY(previous[1], previous[2], seg[1], seg[2])) return;
      // A line back to the start right before the close: the close draws it.
      if (!afterMove && next === 'Z' && begin[0] === 'M' && sameXY(begin[1], begin[2], seg[1], seg[2])) return;
    }
    tidy.push(seg);
  });
  return tidy;
}

/** The scale of a line under `m`, √|ad − bc|: slide-frame width, dash and phase are the PDF values times this (0002 §15). */
export function lineScale(m: Matrix): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/** MuPDF's `fz_is_rectilinear`: `m` keeps the axes (a mirror, a quarter turn, a scale). */
function keepsAxes(m: Matrix): boolean {
  const zero = (v: number): boolean => Math.abs(v) < FLT_EPSILON;
  return (zero(m[1]) && zero(m[2])) || (zero(m[0]) && zero(m[3]));
}

/**
 * True when every line of the path, closing lines included, runs along an axis of the slide frame and no curve is left
 * in it: then a stroke reaches no miter (0002 §15 line style). `segs` is in the slide frame, `m` the CTM that put it there.
 */
export function axisAligned(segs: PathSeg[], m: Matrix): boolean {
  const exact = keepsAxes(m);
  const none = (delta: number): boolean => (exact ? delta === 0 : Math.abs(delta) < AXIS_TOLERANCE);
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  for (const seg of canonicalPath(segs)) {
    switch (seg[0]) {
      case 'M':
        x = startX = seg[1];
        y = startY = seg[2];
        break;
      case 'L':
        if (!none(seg[1] - x) && !none(seg[2] - y)) return false;
        x = seg[1];
        y = seg[2];
        break;
      case 'C':
        return false;
      case 'Z':
        if (!none(startX - x) && !none(startY - y)) return false;
        x = startX;
        y = startY;
        break;
    }
  }
  return true;
}

/**
 * MuPDF's `fz_bound_path(path, stroke, ctm)` from the path's unexpanded bounds: the box grown on every side by half the
 * width (a zero width counts as 1) times the largest of |a|, |b|, |c| and |d|, and that doubled and times the miter limit
 * for a miter join with a limit over 0.5, unless the box has no width or height or the path is `alongAxes` (`axisAligned`).
 * `line` is in slide-frame points, as in the inventory (0002 §15 line style).
 */
export function strokeBounds(box: Box, line: LineInv, m: Matrix, alongAxes = false): Box {
  const scale = lineScale(m);
  const width = scale > 0 ? line.w / scale : 0;
  let grow = ((width === 0 ? 1 : width) / 2) * Math.max(Math.abs(m[0]), Math.abs(m[1]), Math.abs(m[2]), Math.abs(m[3]));
  // MuPDF holds the box in single precision.
  const flat = Math.fround(box[0]) === Math.fround(box[2]) || Math.fround(box[1]) === Math.fround(box[3]);
  if (line.join === 0 && line.miter > 0.5 && !flat && !alongAxes) grow *= 2 * line.miter;
  return [box[0] - grow, box[1] - grow, box[2] + grow, box[3] + grow];
}
