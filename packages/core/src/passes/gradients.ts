import type { OxFill } from '@deckback/ooxml';
import type { Box } from '../extract/inventory';
import { maskIds } from '../raster/raster';
import { anisotropic } from '../scene/build';
import { canonicalJson } from '../scene/canonical';
import type { Element, Fill, MaskDef, Note, Rgb, SceneSlide, ShapeEl, Stop, TextLineEl } from '../scene/types';
import { isRect } from './classify';
import { withOps } from './dedupe';
import { stopAlphaCandidate, type PassedFallback } from './fallbacks';
import type { PassedShape } from './index';
import { groupAlpha, paintBox } from './invisible';
import { hex, pct } from './lower/units';
import type { Approximation, SlideReport } from './report';
import { REDUCE_STOPS, reduceStops, STOP_DELTA_E76 } from './stops';

/**
 * Gradients (0001 M0-6). A linear or radial fill of the Scene becomes DrawingML's `a:gradFill` over the frame of the node
 * that has it (`gradFill`); a function-based shading or a mesh, which DrawingML cannot say, becomes a fallback element
 * (`shadingFallbacks`, M2 final review F9).
 */

/** A gradient fill of the Scene: an axial or radial shading. */
export type Gradient = Extract<Fill, { kind: 'linear' | 'radial' }>;
type Radial = Extract<Fill, { kind: 'radial' }>;
type Shade = Extract<OxFill, { kind: 'grad' }>['shade'];

/** A full turn in 60000ths of a degree. */
const TURN = 21600000;
/** How far (pt) the frame may reach past a gradient's end that does not extend before it counts (`gradient-extend`). */
const EXTEND_TOL_PT = 0.01;

type Affine = [a: number, b: number, c: number, d: number, e: number, f: number];
const affine = (m: readonly number[]): Affine => [m[0] ?? 1, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1, m[4] ?? 0, m[5] ?? 0];
const apply = ([a, b, c, d, e, f]: Affine, [x, y]: readonly [number, number]): [number, number] => [a * x + c * y + e, b * x + d * y + f];
const corners = ([x0, y0, x1, y1]: Box): [number, number][] => [
  [x0, y0],
  [x1, y0],
  [x0, y1],
  [x1, y1],
];

/**
 * Whether a gradient paints nothing: its matrix flattens the plane (no inverse), a linear one's axis has no length
 * (`t` is not defined anywhere; pdf.js and the Canvas it draws with paint nothing), or a radial one's two circles are one
 * circle or two points.
 */
export function paintsNothing(fill: Gradient): boolean {
  const [a, b, c, d] = affine(fill.matrix);
  const det = a * d - b * c;
  if (det === 0 || !Number.isFinite(det)) return true;
  const samePoint = fill.p0[0] === fill.p1[0] && fill.p0[1] === fill.p1[1];
  if (fill.kind === 'linear') return samePoint;
  return fill.r0 === fill.r1 && (samePoint || fill.r0 === 0);
}

/**
 * Where a gradient's parameter `t` runs over a frame: `tStart` at position 0, `tEnd` at position 100000 (either may be
 * the larger); `ptPerT` how far apart in pt t 0 and t 1 are, to measure a reach past an end; and DrawingML's shade.
 */
interface Ramp {
  tStart: number;
  tEnd: number;
  ptPerT: number;
  shade: Shade;
}

/** An angle (radians, clockwise on the slide, y down) in 60000ths of a degree, 0..21599999. */
function angle60k(radians: number): number {
  const turned = Math.round((radians * 180 * 60000) / Math.PI) % TURN;
  return (turned < 0 ? turned + TURN : turned) + 0;
}

/**
 * A linear gradient over a frame (`harness/spikes/m0_6_gradient.py` `remap_stops`, which PowerPoint matched; `a:lin` with
 * `scaled="0"`). The axis's `t` at a slide-frame point x is ((M⁻¹ x − p0) · (p1 − p0)) / |p1 − p0|², M the matrix's
 * linear part. That is linear in x: t = (x − M p0) · g, with g = M⁻ᵀ (p1 − p0) / |p1 − p0|². The bands of one colour run
 * across g, so the angle is g's; and the frame's corners give t its range there, position 0 at the least and 100000 at
 * the most. Where the matrix keeps angles (a turn, a mirror, one scale), g points along M (p1 − p0), the axis on the
 * slide, as in the spike; a matrix that skews or scales unequally turns the bands off the axis, and g follows the bands.
 */
function linearRamp(p0: readonly [number, number], p1: readonly [number, number], matrix: readonly number[], frame: Box): Ramp {
  const m = affine(matrix);
  const [a, b, c, d] = m;
  const det = a * d - b * c;
  const [dx, dy] = [p1[0] - p0[0], p1[1] - p0[1]];
  const len2 = dx * dx + dy * dy;
  const gx = (d * dx - b * dy) / (det * len2);
  const gy = (a * dy - c * dx) / (det * len2);
  const [x0, y0] = apply(m, p0);
  const ts = corners(frame).map(([x, y]) => (x - x0) * gx + (y - y0) * gy);
  return {
    tStart: Math.min(...ts),
    tEnd: Math.max(...ts),
    ptPerT: 1 / Math.sqrt(gx * gx + gy * gy),
    shade: { kind: 'lin', ang: angle60k(Math.atan2(gy, gx)), scaled: false },
  };
}

/** A side of a frame as DrawingML's share of it, a Pct: where `c` lies from `v0` to `v1`, the middle when it has no size. */
function shares(v0: number, v1: number, c: number): [number, number] {
  const size = v1 - v0;
  return size > 0 ? [Math.round(((c - v0) / size) * 100000), Math.round(((v1 - c) / size) * 100000)] : [50000, 50000];
}

/**
 * A side of the tile rect centred on `c` that just holds `v0`..`v1` (`radialRamp`), as `a:tileRect`'s insets of that side,
 * Pcts (negative: outwards): the tile reaches as far from `c` as the farther end. Null when the side has no size, where an
 * inset says nothing: the tile's centre is then the side's own, which only a centre on it matches.
 */
function tileInsets(v0: number, v1: number, c: number): [number, number] | null {
  const size = v1 - v0;
  if (!(size > 0)) return null;
  const half = Math.max(c - v0, v1 - c);
  return [Math.round(((c - half - v0) / size) * 100000) + 0, Math.round(((v1 - (c + half)) / size) * 100000) + 0];
}

/** The largest share of a frame a fillToRect or tileRect side may be: ST_Percentage is an xsd:int. */
const PCT_LIMIT = 2147483647;

/** How far (pt) a centre may be off a side of no size, which a tile rect cannot move, for the circles still to be exact. */
const CENTRE_TOL_PT = 0.001;

/**
 * A radial gradient over a frame, as `a:path path="circle"`: its `a:fillToRect` a point, the centre (shares of the frame),
 * and its `a:tileRect` the rect centred on that point that just holds the frame (insets of the frame, left out when they
 * are all 0: a centre at the frame's centre). Measured in PowerPoint (M5 Task 3, `gradients.test.ts`): position 0 is at
 * the fillToRect point and 100000 on the circle about the tile rect's centre through its corners, so these circles are
 * about the centre and 100000 is at the frame's corner farthest from it, wherever the centre lies (outside the frame
 * too). The circles are taken about one centre, that of the smaller circle, their radii scaled by √|det M| (the matrix's
 * mean scale): radius s (r0 + t (r1 − r0)) on the slide, so `t` runs from −r0 / (r1 − r0) at the centre outwards. That
 * is exact for concentric circles; circles with two centres are approximated (`radial-offset`, recorded by the caller),
 * and so is a centre off a side of the frame that has no size, or so far off that a share would pass ST_Percentage and
 * be clamped by the writer (`centred` false), which a tile rect cannot move.
 */
function radialRamp(fill: Radial, frame: Box): Ramp & { centred: boolean } {
  const m = affine(fill.matrix);
  const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
  const [cx, cy] = apply(m, fill.r0 <= fill.r1 ? fill.p0 : fill.p1);
  // a square root, which every engine rounds alike, not hypot (Global Constraints, Determinism)
  const reach = Math.max(...corners(frame).map(([x, y]) => Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy))));
  const dr = fill.r1 - fill.r0;
  const [l, r] = shares(frame[0], frame[2], cx);
  const [t, b] = shares(frame[1], frame[3], cy);
  const across = tileInsets(frame[0], frame[2], cx);
  const down = tileInsets(frame[1], frame[3], cy);
  const onSide = (v0: number, v1: number, c: number): boolean => Math.abs(c - (v0 + v1) / 2) <= CENTRE_TOL_PT;
  const tile: [number, number, number, number] = [across?.[0] ?? 0, down?.[0] ?? 0, across?.[1] ?? 0, down?.[1] ?? 0];
  // a share past ST_Percentage (an xsd:int) would be clamped by the writer: the circles would move, unrecorded (task 3 review)
  const inRange = [l, t, r, b, ...tile].every((v) => Number.isFinite(v) && Math.abs(v) <= PCT_LIMIT);
  const centred = inRange && (across !== null || onSide(frame[0], frame[2], cx)) && (down !== null || onSide(frame[1], frame[3], cy));
  const shade: Shade = tile.every((v) => v === 0) ? { kind: 'circle', fillToRect: [l, t, r, b] } : { kind: 'circle', fillToRect: [l, t, r, b], tileRect: tile };
  return {
    tStart: -fill.r0 / dr,
    tEnd: (reach / s - fill.r0) / dr,
    ptPerT: s * Math.abs(dr),
    shade,
    centred,
  };
}

/** k of the way from colour a to b, in sRGB. */
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];

/**
 * The value of stops (in order of `t`) at t, linearly between the two around it, the end values held beyond the ends. At
 * a hard stop (two stops at one t) `right` gives the later value, `left` the earlier (the spike's `_colour_at`).
 */
function valueAt<S extends { t: number }, V>(stops: readonly S[], t: number, side: 'left' | 'right', value: (s: S) => V, lerp: (a: V, b: V, k: number) => V): V {
  for (let i = 0; i < stops.length; i++) {
    const ti = stops[i]!.t;
    if (side === 'right' ? ti > t : ti >= t) {
      if (i === 0) return value(stops[0]!);
      const [a, b] = [stops[i - 1]!, stops[i]!];
      return lerp(value(a), value(b), (t - a.t) / (b.t - a.t));
    }
  }
  return value(stops[stops.length - 1]!);
}

const colourAt = (stops: readonly Stop[], t: number, side: 'left' | 'right'): Rgb => valueAt(stops, t, side, (s) => s.rgb, mix);
const alphaAt = (stops: readonly AlphaStop[], t: number, side: 'left' | 'right'): number =>
  valueAt(stops, t, side, (s) => s.alpha, (a, b, k) => a + (b - a) * k);

/**
 * A stop of a soft mask made alpha (`stopAlphas`): at the gradient's `t`, the share (0..1) of the paint the mask lets
 * through.
 */
export interface AlphaStop {
  t: number;
  alpha: number;
}

/** A stop over a ramp: its position from 0 to 1 as `t`, its colour, and `a` the alpha of its alpha stops (1 without). */
interface RampStop extends Stop {
  a: number;
}

/**
 * The stops over a ramp, `t` now the position from 0 to 1: the colour at `tStart`, the stops strictly between, then the
 * colour at `tEnd`. Stops outside are cut, the colour interpolated at the cut; beyond the gradient's ends their colours are
 * held, as if it extended. One stop when the ramp has no length.
 *
 * With alpha stops (`stopAlphas`, M5 Task 3) the positions are the union of both lists' (Review Focus 4): at each, the
 * colour and the alpha sampled exactly from their own stops, linearly between the two around it (or cut at the ramp's
 * ends alike). A hard stop of either list (several stops at one `t`) is as many stops at that position, in order, each
 * with the other list's value there, or its hard stop's in the same order: both are linear between the positions, as
 * PowerPoint draws between two stops. Without them `a` is 1 and the stops are those of before.
 */
function remap(stops: readonly Stop[], tStart: number, tEnd: number, alphas: readonly AlphaStop[] = []): RampStop[] {
  const sorted = [...stops].sort((a, b) => a.t - b.t); // stable: a hard stop keeps its order
  const opacity = [...alphas].sort((a, b) => a.t - b.t);
  const aAt = (t: number, side: 'left' | 'right'): number => (opacity.length === 0 ? 1 : alphaAt(opacity, t, side));
  if (tStart === tEnd) return [{ t: 0, rgb: colourAt(sorted, tStart, 'right'), a: aAt(tStart, 'right') }];
  const up = tEnd > tStart;
  const [lo, hi] = up ? [tStart, tEnd] : [tEnd, tStart];
  const at = [...new Set([...sorted, ...opacity].map((s) => s.t).filter((t) => t > lo && t < hi))].sort((a, b) => a - b);
  if (!up) at.reverse();
  const inner: RampStop[] = [];
  for (const t of at) {
    const colours = sorted.filter((s) => s.t === t).map((s) => s.rgb);
    const values = opacity.filter((s) => s.t === t).map((s) => s.alpha);
    if (colours.length === 0) colours.push(colourAt(sorted, t, 'right'));
    if (values.length === 0) values.push(aAt(t, 'right'));
    if (!up) {
      colours.reverse();
      values.reverse();
    }
    const position = (t - tStart) / (tEnd - tStart);
    for (let k = 0; k < Math.max(colours.length, values.length); k++) {
      inner.push({ t: position, rgb: colours[Math.min(k, colours.length - 1)]!, a: values[Math.min(k, values.length - 1)]! });
    }
  }
  const first = up ? 'right' : 'left';
  const last = up ? 'left' : 'right';
  return [{ t: 0, rgb: colourAt(sorted, tStart, first), a: aAt(tStart, first) }, ...inner, { t: 1, rgb: colourAt(sorted, tEnd, last), a: aAt(tEnd, last) }];
}

export interface GradOptions {
  /** Reduce the stops (`reduceStops` at `STOP_DELTA_E76`); `REDUCE_STOPS` when absent. Never with `alphas`. */
  reduceStops?: boolean;
  /** A soft mask made alpha (`stopAlphas`, `PassedShape.alphaStops`), along the gradient's own `t`. */
  alphas?: readonly AlphaStop[];
}

/**
 * A gradient as DrawingML's fill over `frame`, the box (slide-frame pt) of the node that has it, with what it only
 * approximates.
 * - `linear`: `a:lin` at the angle of its bands with `scaled="0"` (`linearRamp`).
 * - `radial`: `a:path path="circle"` from its centre with a tile rect centred there (`radialRamp`): exact for
 *   concentric circles wherever their centre lies (M5 Task 3). It records `radial-offset` where a circle path is only
 *   near it: circles with two centres, a centre off a side of the frame that has no size, and a matrix that does not keep
 *   angles (`anisotropic`, ruling M2-R4), under which the PDF paints ellipses. Circles of one radius moving along an
 *   axis (a tube) are that axis as a linear gradient, also `radial-offset`.
 * - The stops are pdf.js' samples (writer rule 2), cut at the frame with the colour interpolated at the cut, and reduced
 *   only when `opts.reduceStops` (or `REDUCE_STOPS`) says so.
 * - An end that does not extend (`extend` false) and that the frame reaches past by more than 0.01 pt records
 *   `gradient-extend`: its end colour is held there, where the PDF paints nothing.
 * - The fill alpha times `alphaMul` (the group alphas) goes onto every stop, times its alpha stops' where it has them
 *   (`opts.alphas`, merged over the union of positions: `remap`); `rotWithShape` is on, as in the spike.
 * - Where colour and alpha both change within one interval of the stops written, PowerPoint draws a mix the PDF's
 *   composite is not (ruling M5-R8): one `gradient-alpha-mix` for each such interval, the stops not densified.
 * - `a:noFill` when it paints nothing: alpha 0, no stops, or `paintsNothing`.
 */
export function gradFill(fill: Gradient, frame: Box, alphaMul: number, opts: GradOptions = {}): { fill: OxFill; approximations: Approximation[] } {
  const alpha = pct(fill.alpha * alphaMul);
  if (alpha === 0 || fill.stops.length === 0 || paintsNothing(fill)) return { fill: { kind: 'none' }, approximations: [] };
  const approximations: Approximation[] = [];
  let ramp: Ramp;
  if (fill.kind === 'linear') {
    ramp = linearRamp(fill.p0, fill.p1, fill.matrix, frame);
  } else if (fill.r0 === fill.r1) {
    ramp = linearRamp(fill.p0, fill.p1, fill.matrix, frame);
    approximations.push('radial-offset');
  } else {
    const radialR = radialRamp(fill, frame);
    ramp = radialR;
    const twoCentres = fill.p0[0] !== fill.p1[0] || fill.p0[1] !== fill.p1[1];
    if (twoCentres || anisotropic(affine(fill.matrix)) || !radialR.centred) approximations.push('radial-offset');
  }
  const lo = Math.min(ramp.tStart, ramp.tEnd);
  const hi = Math.max(ramp.tStart, ramp.tEnd);
  const past = (!fill.extend[0] && -lo * ramp.ptPerT > EXTEND_TOL_PT) || (!fill.extend[1] && (hi - 1) * ramp.ptPerT > EXTEND_TOL_PT);
  if (past) approximations.push('gradient-extend');
  const alphas = opts.alphas ?? [];
  const ramped = remap(fill.stops, ramp.tStart, ramp.tEnd, alphas);
  // the reduction weighs colours only: a gradient with alpha stops keeps every one
  // PowerPoint mixes colour and alpha in a gradient apart from the PDF's straight composite (up to 37 levels, ruling M5-R8):
  // each interval where both change is recorded, the stops as they are
  for (let k = 1; k < ramped.length; k++) {
    const [a, b] = [ramped[k - 1]!, ramped[k]!];
    if (b.t > a.t && a.a !== b.a && hex(a.rgb) !== hex(b.rgb)) approximations.push('gradient-alpha-mix');
  }
  const stops = (opts.reduceStops ?? REDUCE_STOPS) && alphas.length === 0 ? reduceStops(ramped, STOP_DELTA_E76) : ramped;
  return {
    fill: {
      kind: 'grad',
      stops: stops.map((s) => ({ pos: Math.min(100000, Math.max(0, Math.round(s.t * 100000))), rgb: hex(s.rgb), alpha: pct(s.a * fill.alpha * alphaMul) })),
      shade: ramp.shade,
      rotWithShape: true,
    },
    approximations,
  };
}

/**
 * A fill as it is given to a node drawn flipped (`flipH`, `flipV`: a connector that runs left or up), so that it comes out
 * as `fill` on the slide: DrawingML flips a node about its centre with its fill. Across a horizontal flip a linear angle
 * θ is given as 180° − θ, across a vertical one as −θ; a circle's centre, and its tile rect, are given on the other
 * side. The stops stay: the corner of least projection flips with the direction. Any other fill, or no flip, is as it
 * is.
 */
export function forFlips(fill: OxFill, flipH: boolean, flipV: boolean): OxFill {
  if (fill.kind !== 'grad' || (!flipH && !flipV)) return fill;
  if (fill.shade.kind === 'lin') {
    let ang = fill.shade.ang;
    if (flipH) ang = TURN / 2 - ang;
    if (flipV) ang = -ang;
    return { ...fill, shade: { ...fill.shade, ang: (((ang % TURN) + TURN) % TURN) + 0 } };
  }
  const mirror = ([l, t, r, b]: [number, number, number, number]): [number, number, number, number] => [flipH ? r : l, flipV ? b : t, flipH ? l : r, flipV ? t : b];
  const { fillToRect, tileRect } = fill.shade;
  return { ...fill, shade: tileRect === undefined ? { kind: 'circle', fillToRect: mirror(fillToRect) } : { kind: 'circle', fillToRect: mirror(fillToRect), tileRect: mirror(tileRect) } };
}

// ---- soft masks that are stop alpha (M5 Task 3) ---------------------------------------------------------------------

/** How far (pt) a mask's region may fall short of the shape it masks and still hold it: the Scene's rounding of lengths. */
const COVER_TOL_PT = 0.001;

/** The luminosity of an sRGB colour, 0..255: MuPDF's weights, as the raster renderer's (`raster/blend.ts`), unrounded. */
const lum = ([r, g, b]: Rgb): number => (r * 77 + g * 151 + b * 28) / 256;

/** Whether box `outer` holds box `inner`, within `COVER_TOL_PT`. */
const holds = (outer: Box, inner: Box): boolean =>
  outer[0] <= inner[0] + COVER_TOL_PT && outer[1] <= inner[1] + COVER_TOL_PT && outer[2] >= inner[2] - COVER_TOL_PT && outer[3] >= inner[3] - COVER_TOL_PT;

/** What makes a gradient's `t` at each point: two gradients alike in this give every point the same `t`. */
const geometryOf = (f: Gradient): string => canonicalJson(f.kind === 'linear' ? [f.kind, f.p0, f.p1, f.matrix, f.extend] : [f.kind, f.p0, f.r0, f.p1, f.r1, f.matrix, f.extend]);

/**
 * Whether the mask's shape `m` paints all of what `el` may paint (its `bbox`), so that only its gradient decides the
 * alpha there, never the mask's backdrop: `m` is a path-less `sh` (it paints its clips), an axis-aligned rectangle that
 * holds the box, or el's very outline and fill rule; and each of its clips is a box or a rectangle that holds the box, or
 * el's outline. Anything else (a text clip, another outline, a rectangle short of the box) cannot be told this simply.
 */
function maskCovers(el: ShapeEl, m: ShapeEl, clips: MaskDef['clips']): boolean {
  const outline = el.geom === null ? null : canonicalJson([el.geom, el.fillRule]);
  const region = (geom: ShapeEl['geom'], rule: ShapeEl['fillRule'], box: Box): boolean =>
    (outline !== null && canonicalJson([geom, rule]) === outline) || (isRect({ geom, line: null }) && holds(box, el.bbox));
  if (m.geom !== null && !region(m.geom, m.fillRule, m.bbox)) return false;
  return m.clip.every((id) => {
    const def = clips[id];
    if (def === undefined || def.kind === 'text') return false;
    return def.kind === 'box' ? holds(def.bbox, el.bbox) : region(def.geom, def.rule, def.bbox);
  });
}

/** Whether a gradient that does not extend at an end is reached past that end over `box` (by over 0.01 pt), as in `gradFill`. */
function reachesPastEnd(f: Gradient, box: Box): boolean {
  if (f.extend[0] && f.extend[1]) return false;
  const ramp = f.kind === 'linear' || f.r0 === f.r1 ? linearRamp(f.p0, f.p1, f.matrix, box) : radialRamp(f, box);
  const [lo, hi] = [Math.min(ramp.tStart, ramp.tEnd), Math.max(ramp.tStart, ramp.tEnd)];
  return (!f.extend[0] && -lo * ramp.ptPerT > EXTEND_TOL_PT) || (!f.extend[1] && (hi - 1) * ramp.ptPerT > EXTEND_TOL_PT);
}

/** Whether `elements[index]` is alone, among its neighbours, in each of its groups that took soft mask `id`. */
function aloneInMaskedGroups(elements: readonly Element[], index: number, id: string): boolean {
  const el = elements[index]!;
  const key = (e: Element, k: number): string => canonicalJson(e.groups.slice(0, k + 1));
  return el.groups.every(
    (g, k) => g.mask !== id || ![elements[index - 1], elements[index + 1]].some((n) => n !== undefined && n.groups.length > k && key(n, k) === key(el, k)),
  );
}

/**
 * Element `index` of the slide with its soft mask made per-stop alpha (`PassedShape.alphaStops`), or null when that would
 * not be exact. It must be a candidate (`stopAlphaCandidate`: a shape with one solid or gradient fill and no line, under
 * one luminosity mask that is one unmasked shape filled with a gradient), and then:
 * - the mask's gradient is the fill's, the same geometry (kind, points, radii, matrix, extend), so both have the same `t`
 *   everywhere; a solid fill becomes that gradient in its one colour;
 * - the mask paints all the shape may paint (`maskCovers`), and its gradient reaches no end it does not extend over the
 *   shape's box (`reachesPastEnd`): only the gradient decides the alpha, never the mask's backdrop;
 * - the mask's shape is drawn as it is (Normal, no group alpha but its own) and, when a group took the mask, the shape is
 *   alone in that group: a group's mask applies to the group's composite.
 * The alpha at each of the mask's stops is its luminosity, the mask shape's alpha `a` over the backdrop `BC` (black
 * without one): (a lum(C) + (1 − a) lum(BC)) / 255, MuPDF's weights. Both it and the colour are linear in `t` between
 * stops, so `gradFill` writes them exactly over the union of positions (Review Focus 4).
 */
function stopAlphaOf(slide: SceneSlide, index: number): PassedShape | null {
  const el = slide.elements[index] as ShapeEl;
  const id = maskIds(el)[0]!;
  const def = slide.masks[id]!;
  const m = def.elements[0] as ShapeEl;
  const mf = m.fill as Gradient;
  if (el.fill === null || (el.fill.kind !== 'solid' && el.fill.kind !== 'linear' && el.fill.kind !== 'radial')) return null;
  if (el.fill.kind !== 'solid' && geometryOf(el.fill) !== geometryOf(mf)) return null;
  if (mf.stops.length === 0 || paintsNothing(mf) || reachesPastEnd(mf, el.bbox) || !maskCovers(el, m, def.clips)) return null;
  if (m.blend !== 'normal' || m.groups.some((g) => g.blend !== 'normal')) return null;
  if (!aloneInMaskedGroups(slide.elements, index, id)) return null;
  const a = mf.alpha * groupAlpha(m);
  const backdrop = lum(def.backdrop ?? [0, 0, 0]);
  const alphaStops: AlphaStop[] = mf.stops.map((st) => ({ t: st.t, alpha: (a * lum(st.rgb) + (1 - a) * backdrop) / 255 }));
  const fill: Gradient = el.fill.kind === 'solid' ? { ...mf, stops: [{ t: 0, rgb: el.fill.rgb }, { t: 1, rgb: el.fill.rgb }], alpha: el.fill.alpha } : el.fill;
  return { ...el, fill, mask: null, groups: el.groups.map((g) => (g.mask === null ? g : { ...g, mask: null })), alphaStops };
}

/**
 * The pass (M5 Task 3, fills/06; after the first merge, before the effect fallbacks): each shape whose soft mask is a
 * luminosity gradient that is exactly per-stop alpha (`stopAlphaOf`) loses the mask and gains `alphaStops`, which
 * lowering merges with its colour stops (`gradFill`). Any other soft mask stays, and the effect fallbacks make the shape a
 * `soft-mask` raster (Review Focus 4: a fallback with its reason, never a mask silently dropped). A new slide; the input
 * is not changed.
 */
export function stopAlphas(slide: SceneSlide): SceneSlide {
  let changed = false;
  const elements = slide.elements.map((el, index) => {
    if (!stopAlphaCandidate(el, slide)) return el;
    const written = stopAlphaOf(slide, index);
    if (written === null) return el;
    changed = true;
    return written;
  });
  return changed ? { ...slide, elements } : slide;
}

// ---- a gradient painted through text (M5 Task 3, ruling M3-R27) ----------------------------------------------------

/**
 * How far (pt) a text clip may reach past the glyph boxes of its text: the walker pads them by 1 pt (MuPDF's
 * `fz_bound_text`, `TEXT_BOUNDS_PAD`), and the Scene rounds lengths to 0.001 pt.
 */
const TEXT_CLIP_PAD_PT = 1.01;

const grow = (b: Box, by: number): Box => [b[0] - by, b[1] - by, b[2] + by, b[3] + by];
const union = (a: Box, b: Box): Box => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];

/**
 * The text lines (indexes, the last first) whose glyphs make text clip `id`, the innermost of `el`'s chain, painted by
 * `el` alone; null when they cannot be told for sure. They are the lines just before `el` (a Tr 7 line is in the clip
 * of before its `ET`, and the clip starts after it: `scene/fills.test.ts`), each all clip mode (Tr 7), in `el`'s chain
 * but the text clip and in its groups, unmasked and Normal, their glyph boxes within the clip; and together they make all
 * of it (the clip is their glyph boxes padded, `TEXT_CLIP_PAD_PT`).
 */
function clipText(slide: SceneSlide, elements: readonly Element[], index: number, id: string): number[] | null {
  const el = elements[index]!;
  const box = slide.clips[id]!.bbox;
  const parent = canonicalJson(el.clip.slice(0, -1));
  const groups = canonicalJson(el.groups);
  const made: number[] = [];
  for (let j = index - 1; j >= 0; j--) {
    const t = elements[j]!;
    if (t.kind !== 'textline' || t.runs.length === 0 || !t.runs.every((r) => r.fillMode === 'clip')) break;
    if (canonicalJson(t.clip) !== parent || canonicalJson(t.groups) !== groups || t.mask !== null || t.blend !== 'normal') break;
    if (!holds(box, t.bboxPt)) break;
    made.push(j);
  }
  if (made.length === 0) return null;
  const glyphs = made.map((j) => (elements[j] as TextLineEl).bboxPt).reduce(union);
  return holds(grow(glyphs, TEXT_CLIP_PAD_PT), box) ? made : null;
}

/**
 * The pass (before the shading fallbacks): an `sh` of a linear or radial gradient drawn in a text clip (ruling M3-R27;
 * text filled with a gradient, as Word or a browser writes it: `BT 7 Tr ... ET /Sh sh`) is that text filled with the
 * gradient, which lowering writes as each run's `a:gradFill` (`lowerText`). The text stays text (spec §7). The `sh` must be
 * the only paint in the clip and the clip innermost in its chain, drawn as the text is (no mask, Normal, the same
 * groups), and the clip's text must be found whole (`clipText`). Its runs then fill (`fill` mode) with the gradient, the
 * line just before the `sh` takes its op, and the `sh` is gone. Anything else stays for `shadingFallbacks`
 * (`text-clip-shading`). A new slide; the input is not changed.
 */
export function textClipGradients(slide: SceneSlide): SceneSlide {
  const elements = slide.elements.slice();
  const isText = (id: string): boolean => slide.clips[id]?.kind === 'text';
  const painters = new Map<string, number>();
  for (const el of elements) for (const id of el.clip) if (isText(id)) painters.set(id, (painters.get(id) ?? 0) + 1);
  const gone = new Set<number>();
  elements.forEach((el, index) => {
    if (el.kind !== 'shape' || el.geom !== null || el.line !== null || (el.fill?.kind !== 'linear' && el.fill?.kind !== 'radial')) return;
    const id = el.clip.at(-1);
    if (id === undefined || !isText(id) || el.clip.filter(isText).length !== 1 || painters.get(id) !== 1) return;
    if (el.mask !== null || el.blend !== 'normal' || el.groups.some((g) => g.mask !== null || g.blend !== 'normal')) return;
    const made = clipText(slide, elements, index, id);
    if (made === null) return;
    const fill = el.fill;
    for (const j of made) {
      const t = elements[j] as TextLineEl;
      elements[j] = { ...t, runs: t.runs.map((r) => ({ ...r, fillMode: 'fill' as const, rgb: null, alpha: fill.alpha, fill })) };
    }
    elements[made[0]!] = withOps(elements[made[0]!]!, el.provenance.opIndex);
    gone.add(index);
  });
  return gone.size === 0 ? slide : { ...slide, elements: elements.filter((_, i) => !gone.has(i)) };
}

// ---- shadings DrawingML cannot say ----------------------------------------------------------------------------------

/** The note a shading's fallback adds to its slide: fixed words (Global Constraints, Privacy). */
export const SHADING_NOTE = 'shading needs a raster fallback';
/** The note of an `sh` drawn in a text clip (ruling M3-R27): fixed words. */
export const TEXT_CLIP_SHADING_NOTE = 'shading clipped by text needs a raster fallback';

/** The pdf.js operator that paints a shape: `shadingFill` for `sh`, else the paint op its path carries. */
function paintOp(shape: ShapeEl, byFill: boolean): string {
  if (shape.geom === null) return 'shadingFill';
  if (!byFill) return 'stroke';
  return shape.fillRule === 'evenodd' ? 'eoFill' : 'fill';
}

/** Why a shape can only be a raster, with its note; null when it can be written. */
function rasterOnly(el: ShapeEl, clips: SceneSlide['clips']): { reason: string; note: Note } | null {
  const opIndex = el.provenance.opIndex[0] ?? 0;
  const byFill = el.fill?.kind === 'shading';
  const paint = byFill ? el.fill : el.line?.paint;
  if (paint?.kind === 'shading') {
    return { reason: `shading-${paint.shading}`, note: { opIndex, op: paintOp(el, byFill), detail: SHADING_NOTE } };
  }
  if (el.geom === null && el.clip.some((id) => clips[id]?.kind === 'text')) {
    return { reason: 'text-clip-shading', note: { opIndex, op: 'shadingFill', detail: TEXT_CLIP_SHADING_NOTE } };
  }
  return null;
}

/**
 * The pass: a shape DrawingML cannot draw becomes a fallback element at its id, which the raster renderer draws (M5,
 * `rasterFallbacks`; it stands for the shape, `PassedFallback.of`):
 * - one whose fill or line is painted with a function-based shading or a mesh (M2 final review F9): the reason
 *   `shading-function` or `shading-mesh`, the note `SHADING_NOTE`;
 * - an `sh` drawn in a text clip (ruling M3-R27), text filled with a gradient: the reason `text-clip-shading`, the note
 *   `TEXT_CLIP_SHADING_NOTE`. Its clip chain says where; the clip-mode text itself stays, as editable text (Task 8). It
 *   stands for nothing the raster renderer draws (text is never rasterized), so stays unwritten, counted.
 *
 * The fallback keeps the shape's clip chain, groups, mask and blend mode, which the raster is drawn in; its box is the
 * painted box, a stroke's half width included. Each adds a note to the slide at the shape's first op, naming the op that
 * paints it (`shadingFill`, or `fill`, `eoFill`, `stroke`). The notes go after the Scene's, and into `report`'s too. It
 * runs before merge and the clip pass, which then never see these shapes. A new slide; the input is not changed.
 */
export function shadingFallbacks(slide: SceneSlide, report: SlideReport | null): SceneSlide {
  const added: Note[] = [];
  const elements = slide.elements.map((el): Element => {
    if (el.kind !== 'shape') return el;
    const why = rasterOnly(el, slide.clips);
    if (why === null) return el;
    added.push(why.note);
    const { id, provenance, clip, clipBox, groups, mask, blend } = el;
    const fallback: PassedFallback = {
      id,
      provenance,
      clip,
      clipBox,
      groups,
      mask,
      blend,
      kind: 'fallback',
      reason: why.reason,
      coveredOps: [...provenance.opIndex],
      raster: null,
      bbox: paintBox(el, (line) => line.w / 2),
      // M5: the raster renderer draws a shading from its triangles; text filled with a gradient stays text (Task 3)
      ...(why.reason === 'text-clip-shading' ? {} : { of: el }),
    };
    return fallback;
  });
  if (report !== null) report.notes.push(...added.map((note) => ({ ...note })));
  return { ...slide, elements, notes: [...slide.notes, ...added] };
}
