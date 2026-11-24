import type { Emu, OxCmd, OxConnector, OxFill, OxFrame, OxLineStyle, OxNode, OxPath, OxShape } from '@deckback/ooxml';
import type { Box, PathSeg } from '../../extract/inventory';
import type { Fill, LineStyle } from '../../scene/types';
import { isRect, shapeKind } from '../classify';
import { drawnBox, planFill, splitSubpaths, subpathPoints, type Subpath } from '../fillrule';
import { forFlips, gradFill, paintsNothing, type AlphaStop } from '../gradients';
import type { PassedShape } from '../index';
import { presetPattern, type Rgba } from '../patterns';
import type { TilePlan } from '../pictures';
import type { Approximation } from '../report';
import { EMU_PER_PT, HAIRLINE_PT, lineBase, pct, placeX, placeY, solidFill, type Placement } from './units';

/** The kind a node's name gives (ruling M3-R17). */
export type NameKind = 'rect' | 'freeform' | 'line' | 'text' | 'picture' | 'link' | 'fallback';

export interface ShapeCtx {
  place: Placement;
  /** The product of the element's group alphas, folded into its own. */
  alpha: number;
  /** The name of a node of the element. */
  name: (kind: NameKind) => string;
  approximate: (kind: Approximation) => void;
  /** Whether a gradient's stops are reduced (`gradFill`); `REDUCE_STOPS` when absent. */
  reduceStops?: boolean;
}

/** 4/3 (√2 − 1): the handle of a quarter circle drawn as a cubic. */
const KAPPA = 0.5522847498307936;

type Pt = readonly [number, number];

/** A paint once the frame of its node is known: a gradient is laid over that frame. */
type Paint = (frame: OxFrame) => OxFill;
/** A line style once the frame of its node is known (its paint may be a gradient). */
type LinePlan = (frame: OxFrame) => OxLineStyle;

const noFill = (): OxFill => ({ kind: 'none' });

/**
 * The frame of the box of `points` (slide-frame pt), after the placement, unturned: x, y its least EMU. (A loop, not
 * Math.min(...xs): a path may have more points than a call may have arguments.)
 */
function frameOf(points: readonly Pt[], place: Placement): OxFrame {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [px, py] of points) {
    const x = placeX(place, px);
    const y = placeY(place, py);
    [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rot: 0, flipH: false, flipV: false };
}

/** A frame's box in the slide frame (pt), the placement undone: where a gradient is laid. */
function slideBox(frame: OxFrame, place: Placement): Box {
  const x = (v: Emu): number => (v / EMU_PER_PT - place.offset[0]) / place.scale;
  const y = (v: Emu): number => (v / EMU_PER_PT - place.offset[1]) / place.scale;
  return [x(frame.x), y(frame.y), x(frame.x + frame.w), y(frame.y + frame.h)];
}

/** `v` (EMU) moved by whole periods `p` into (−p, 0]: where the tile that covers the corner starts. */
const wrap = (v: Emu, p: Emu): Emu => (p > 0 ? v - Math.ceil(v / p) * p + 0 : v);

/** One bit of a preset pattern on the slide, EMU: a pixel at 96 dpi (0.75 pt); a cell is 8 of them (6 pt). */
const PATTERN_BIT: Emu = 9525;
/** How far (EMU) a tile's side or corner may be from the preset's grid and still be on it: the EMU rounding of each. */
const PATTERN_TOL: Emu = 2;

/**
 * Ruling M5-R10: a tile whose picture is a cell of two colours (`TilePlan.cell`) as PowerPoint's preset (`a:pattFill`),
 * where it is one on the slide: the tile 8 bits a side (6 pt) and its corner on the bits' grid from the slide's corner,
 * and its bits, shifted by that corner's place on the 8-bit grid, a preset's (`presetPattern`). The colours take the
 * tile's alpha times the group alphas. Null where it is not one: the picture tile then.
 */
function presetFill(tile: TilePlan, left: Emu, top: Emu, w: Emu, h: Emu, ctx: ShapeCtx): OxFill | null {
  if (tile.cell === undefined) return null;
  const onGrid = (v: Emu): boolean => Math.abs(v - Math.round(v / PATTERN_BIT) * PATTERN_BIT) <= PATTERN_TOL;
  if (Math.abs(w - 8 * PATTERN_BIT) > PATTERN_TOL || Math.abs(h - 8 * PATTERN_BIT) > PATTERN_TOL || !onGrid(left) || !onGrid(top)) return null;
  const preset = presetPattern(tile.cell, Math.round(left / PATTERN_BIT), Math.round(top / PATTERN_BIT));
  if (preset === null) return null;
  const colour = ([r, g, b, a]: Rgba) => ({ rgb: [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase(), alpha: pct((a / 255) * tile.alpha * ctx.alpha) });
  return { kind: 'patt', prst: preset.prst as Extract<OxFill, { kind: 'patt' }>['prst'], fg: colour(preset.fg), bg: colour(preset.bg) };
}

/**
 * A picture tile (`TilePlan`, the picture pass's) as a `Paint`: PowerPoint's preset pattern where its cell is one
 * (`presetFill`, ruling M5-R10), else `a:blipFill` with `a:tile` (`algn` top left, no flip, as the writer writes it), its
 * alpha times the group alphas. `sx` and `sy` are the tile's size on the slide as a share of the media's natural size;
 * `tx` and `ty` the offset from the frame's corner to where a tile starts, the cell matrix's, moved by whole tiles to the
 * one that covers the corner (the tiling is the same). Null at alpha 0.
 */
function tilePaint(tile: TilePlan, ctx: ShapeCtx): Paint | null {
  const alpha = pct(tile.alpha * ctx.alpha);
  if (alpha === 0) return null;
  const { place } = ctx;
  const [x0, y0, x1, y1] = tile.image;
  const [left, top] = [placeX(place, x0), placeY(place, y0)];
  const [w, h] = [placeX(place, x1) - left, placeY(place, y1) - top];
  const preset = presetFill(tile, left, top, w, h, ctx);
  if (preset !== null) return () => preset;
  const share = (size: number, natural: number): number => Math.round(((size * place.scale) / natural) * 100000);
  const [sx, sy] = [share(x1 - x0, tile.natural[0]), share(y1 - y0, tile.natural[1])];
  return (frame) => ({ kind: 'blip', media: tile.media, alpha, mode: { kind: 'tile', tx: wrap(left - frame.x, w), ty: wrap(top - frame.y, h), sx, sy } });
}

/**
 * A Scene paint as a `Paint`, the group alphas multiplied in: a solid colour as it is, a linear or radial gradient over
 * the frame (`gradFill`, its approximations recorded, `alphas`, a soft mask made stop alpha, merged into its stops;
 * mirrored for a frame drawn flipped, `forFlips`), a tiling pattern the picture pass made a tile of (`tile`) as a
 * picture tile (`tilePaint`). Null when it paints nothing (alpha 0, a
 * gradient that `paintsNothing`) or is not written here: a function-based shading or a mesh is a fallback
 * (`shadingFallbacks`), and any other tiling pattern `tile-unsupported` (the picture pass).
 */
function paintOf(paint: Fill, ctx: ShapeCtx, tile?: TilePlan, alphas?: readonly AlphaStop[]): Paint | null {
  switch (paint.kind) {
    case 'solid': {
      const fill = solidFill(paint, ctx.alpha)!;
      return fill.kind === 'none' ? null : () => fill;
    }
    case 'linear':
    case 'radial': {
      if (pct(paint.alpha * ctx.alpha) === 0 || paint.stops.length === 0 || paintsNothing(paint)) return null;
      const opts = { ...(ctx.reduceStops === undefined ? {} : { reduceStops: ctx.reduceStops }), ...(alphas === undefined ? {} : { alphas }) };
      return (frame) => {
        const grad = gradFill(paint, slideBox(frame, ctx.place), ctx.alpha, opts);
        for (const kind of grad.approximations) ctx.approximate(kind);
        return forFlips(grad.fill, frame.flipH, frame.flipV);
      };
    }
    case 'tile':
      return tile === undefined ? null : tilePaint(tile, ctx);
    case 'shading':
      return null;
  }
}

/** A Scene line as a `LinePlan`; null when its paint is not written (`paintOf`). */
function linePlan(line: LineStyle, ctx: ShapeCtx): LinePlan | null {
  const paint = paintOf(line.paint, ctx);
  if (paint === null) return null;
  const base = lineBase(line, ctx.place.scale);
  return (frame) => ({ ...base, fill: paint(frame) });
}

/** A subpath's commands in EMU relative to the frame. */
function relative(sub: readonly PathSeg[], frame: OxFrame, place: Placement): OxCmd[] {
  const x = (v: number): Emu => placeX(place, v) - frame.x;
  const y = (v: number): Emu => placeY(place, v) - frame.y;
  return sub.map((seg): OxCmd => {
    switch (seg[0]) {
      case 'M':
      case 'L':
        return [seg[0], x(seg[1]), y(seg[2])];
      case 'C':
        return ['C', x(seg[1]), y(seg[2]), x(seg[3]), y(seg[4]), x(seg[5]), y(seg[6])];
      case 'Z':
        return ['Z'];
    }
  });
}

/** Whether a subpath draws a segment (DrawingML draws a path only with `lnTo` or a curve). */
const draws = (sub: readonly PathSeg[]): boolean => sub.some((seg) => seg[0] === 'L' || seg[0] === 'C');

/**
 * Whether a stroke of the subpath has zero length: all its points, control points included, are one point, and it is
 * more than a lone `M` (`M Z`, `M L` to the same point, ...). PDF draws a dot there with a round cap only (ISO 32000-2
 * §8.5.3.2); PowerPoint draws nothing (ruling M3-R13 b).
 */
function zeroLength(sub: Subpath): boolean {
  if (sub.length < 2) return false;
  const pts = subpathPoints(sub);
  return pts.every((p) => p[0] === pts[0]![0] && p[1] === pts[0]![1]);
}

interface PathSpec {
  subs: readonly number[];
  fill: boolean;
  stroke: boolean;
  /** A dashed stroke's: each closed subpath written open (`opened`). */
  open?: boolean;
}

/** The end point of a subpath's last drawing segment; null for one with none. */
function endOf(sub: readonly PathSeg[]): Pt | null {
  for (let i = sub.length - 1; i >= 0; i--) {
    const seg = sub[i]!;
    if (seg[0] === 'M' || seg[0] === 'L') return [seg[1], seg[2]];
    if (seg[0] === 'C') return [seg[5], seg[6]];
  }
  return null;
}

/**
 * A closed subpath written open (M5 Task 4, atlas lines/12): its close a line back to its start, none where it ends there
 * already. PowerPoint starts the dashes of a closed path elsewhere than its first point, and those of an open path at its
 * first point with no phase, as PDF starts a closed one's (measured: lines/12's dashed rects and rounded rects, 95 to 904
 * px off the PDF's render as closed paths, 0 as open ones). A dash across the start then has its caps there rather than a
 * join. An open subpath is as it is.
 */
function opened(sub: Subpath): Subpath {
  if (sub[sub.length - 1]?.[0] !== 'Z') return sub;
  const body = sub.slice(0, -1);
  while (body.length > 0 && body[body.length - 1]![0] === 'Z') body.pop();
  const first = body[0];
  const end = endOf(body);
  if (first === undefined || first[0] !== 'M' || end === null) return body;
  return end[0] === first[1] && end[1] === first[2] ? body : [...body, ['L', first[1], first[2]]];
}

/**
 * A custGeom shape of `specs`, each an `a:path` of those subpaths; null when none draws. Its frame is the extent the
 * paths draw (`drawnBox`): PowerPoint lays a fill over that, not over a cubic's handles, which may lie outside it.
 */
function custom(
  subpaths: readonly Subpath[],
  specs: readonly PathSpec[],
  fill: Paint | null,
  line: LinePlan | null,
  name: string,
  place: Placement,
): OxShape | null {
  const kept = specs
    .map((spec) => ({ ...spec, segs: spec.subs.flatMap((i) => (spec.open === true ? opened(subpaths[i]!) : subpaths[i]!)) }))
    .filter((spec) => draws(spec.segs));
  if (kept.length === 0) return null;
  const [x0, y0, x1, y1] = drawnBox(kept.flatMap((spec) => spec.segs))!;
  const frame = frameOf(
    [
      [x0, y0],
      [x1, y1],
    ],
    place,
  );
  const paths = kept.map((spec): OxPath => ({ w: frame.w, h: frame.h, fill: spec.fill, stroke: spec.stroke, cmds: relative(spec.segs, frame, place) }));
  return { kind: 'shape', name, frame, link: null, geom: { kind: 'custom', paths }, fill: (fill ?? noFill)(frame), line: line === null ? null : line(frame) };
}

/** A filled circle of diameter `w` about `c` (a round cap's dot), as a subpath, clockwise on the page. */
function dot([cx, cy]: Pt, w: number): Subpath {
  const r = w / 2;
  const k = KAPPA * r;
  return [
    ['M', cx + r, cy],
    ['C', cx + r, cy + k, cx + k, cy + r, cx, cy + r],
    ['C', cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    ['C', cx - r, cy - k, cx - k, cy - r, cx, cy - r],
    ['C', cx + k, cy - r, cx + r, cy - k, cx + r, cy],
    ['Z'],
  ];
}

/**
 * A shape as nodes of the writer's model, in z-order: none, one, or two when its stroke has zero-length subpaths beside
 * others (the dots follow the stroke).
 * - The kind (`shapeKind`): `rect` is the rect preset at the box of its corners; `line` a connector from its first point
 *   to its second (flipH when it runs left, flipV when it runs up); `custom` a custGeom whose frame is the extent its
 *   paths draw (`drawnBox`: a cubic's handles may reach past it, as PowerPoint lays a fill over that extent), its paths
 *   in EMU relative to the frame with `w` and `h` the frame's size. A shape
 *   with no path (`sh`) that has not been through the clip pass, which gives it its clip's geometry, is a rect at its
 *   box (its clip's).
 * - The fill's `a:path`s (`fillPaths`, the fillRule pass). One that holds every subpath fills and strokes. When the fill
 *   is split, each `a:path` only fills and one more `a:path` of every subpath only strokes, last: DrawingML paints its
 *   `a:path`s in order, each its fill and then its stroke, so a later fill would cover an earlier outline that the PDF
 *   strokes after the whole fill. A fill outline (`fillGeom`, M5 Task 4) is the fill's one `a:path` of its own loops, in a
 *   custGeom whatever its shape, and the stroke, if any, an `a:path` of the PDF's path after it.
 * - A dashed stroke writes each closed subpath open from its start (`opened`, M5 Task 4), where PowerPoint starts its
 *   dashes as PDF does.
 * - Subpaths that draw nothing in PowerPoint (a lone `M`, or zero length: `M Z`, `M L` to the same point) are left out
 *   of every `a:path` and so of the frame. A zero-length stroked subpath with a round cap is a dot in the PDF (ruling
 *   M3-R13 b, ISO 32000-2 §8.5.3.2): a filled circle of diameter `w` in the stroke's paint, with no line, in a node of
 *   its own, one `a:path` each so that overlapping dots stay filled. With a butt or a square cap the PDF draws nothing,
 *   and so does this. Dashes are not looked at: a dotted line of zero-length dashes stays a dash pattern.
 * - Paints (`paintOf`), the group alphas multiplied in: a solid colour, a linear or radial gradient laid over the frame
 *   of the node that has it (`gradFill`; a fill's `alphaStops`, a soft mask made stop alpha, merged into its stops), or
 *   for a fill the picture tile the picture pass planned (`tile`). A
 *   function-based shading or mesh is a fallback by now; any other tiling pattern the picture pass took off
 *   (`tile-unsupported`): the shape is written without it, and not at all when nothing is left.
 * - The clip pass's `approximations` are recorded, then a gradient's; an `anisotropic` line records `anisotropic-line`;
 *   a dashed line with a phase, which DrawingML cannot say, records `dash-phase` (ruling M3-R20).
 */
export function lowerShape(shape: PassedShape, ctx: ShapeCtx): OxNode[] {
  const fill = shape.fill === null ? null : paintOf(shape.fill, ctx, shape.tile, shape.alphaStops);
  const line = shape.line === null ? null : linePlan(shape.line, ctx);
  if (fill === null && line === null) return [];
  for (const kind of shape.approximations ?? []) ctx.approximate(kind);

  const nodes = shape.geom === null ? (fill === null ? [] : noPath(shape, fill, ctx)) : withPath(shape, shape.geom, fill, line, ctx);
  const style = shape.line;
  if (nodes.length > 0 && line !== null && style !== null) {
    if (style.anisotropic) ctx.approximate('anisotropic-line');
    const stroked = nodes.some((n) => n.kind === 'line' || (n.kind === 'shape' && n.line !== null));
    if (stroked && style.dash.length > 0 && style.phase !== 0) ctx.approximate('dash-phase');
  }
  return nodes;
}

/** `sh` not through the clip pass: a rect at its box, which is its clip's. */
function noPath(shape: PassedShape, fill: Paint, ctx: ShapeCtx): OxNode[] {
  const [x0, y0, x1, y1] = shape.bbox;
  const frame = frameOf([[x0, y0], [x1, y1]], ctx.place);
  return [{ kind: 'shape', name: ctx.name('rect'), frame, link: null, geom: { kind: 'rect' }, fill: fill(frame), line: null }];
}

function withPath(shape: PassedShape, geom: readonly PathSeg[], fill: Paint | null, line: LinePlan | null, ctx: ShapeCtx): OxNode[] {
  const { place } = ctx;
  const subpaths = splitSubpaths(geom);
  const point = subpaths.map(zeroLength);
  const dead = subpaths.map((sub, i) => point[i]! || !draws(sub));
  const outline = fill === null || shape.fillGeom === undefined ? null : splitSubpaths(shape.fillGeom);
  const kind = outline !== null ? 'custom' : (shape.shapeKind ?? shapeKind(shape));
  const live = (subs: readonly number[]) => subs.filter((i) => !dead[i]);
  const dashed = shape.line !== null && shape.line.dash.length > 0;

  if (!dead.some(Boolean) && kind === 'rect') {
    const frame = frameOf(subpathPoints(geom), place);
    const [fillOx, lineOx] = [(fill ?? noFill)(frame), line === null ? null : line(frame)];
    return [{ kind: 'shape', name: ctx.name('rect'), frame, link: null, geom: { kind: 'rect' }, fill: fillOx, line: lineOx }];
  }
  if (!dead.some(Boolean) && kind === 'line' && line !== null) {
    const [[, x0, y0], [, x1, y1]] = geom as [['M', number, number], ['L', number, number]];
    const frame = { ...frameOf([[x0, y0], [x1, y1]], place), flipH: x1 < x0, flipV: y1 < y0 };
    return [{ kind: 'line', name: ctx.name('line'), frame, link: null, line: line(frame) } satisfies OxConnector];
  }

  const pieces = outline === null ? splitPieces(shape, subpaths, point, fill, line, ctx) : null;
  if (pieces !== null) return pieces;

  const every = subpaths.map((_, i) => i);
  const specs: PathSpec[] = [];
  const all = outline === null ? subpaths : [...subpaths, ...outline];
  if (outline !== null) {
    specs.push({ subs: outline.map((_, i) => subpaths.length + i), fill: true, stroke: false });
    if (line !== null) specs.push({ subs: live(every), fill: false, stroke: true, open: dashed });
  } else if (fill !== null) {
    const groups = shape.fillPaths ?? planFill(shape).paths;
    const whole = groups.length === 1 && groups[0]!.length === subpaths.length && new Set(groups[0]).size === subpaths.length;
    if (line !== null && whole) {
      specs.push({ subs: live(every), fill: true, stroke: true, open: dashed });
    } else {
      for (const g of groups) specs.push({ subs: live(g), fill: true, stroke: false });
      if (line !== null) specs.push({ subs: live(every), fill: false, stroke: true, open: dashed });
    }
  } else if (line !== null) {
    specs.push({ subs: live(every), fill: false, stroke: true, open: dashed });
  }

  const nodes: OxNode[] = [];
  const main = custom(all, specs, fill, line, ctx.name('freeform'), place);
  if (main !== null) nodes.push(main);
  const style = shape.line;
  if (line !== null && style !== null && style.cap === 'round' && style.w > 0) {
    const dots = every.filter((i) => point[i]).map((i) => dot(subpathPoints(subpaths[i]!)[0]!, style.w));
    if (dots.length > 0) {
      const paint = paintOf(style.paint, ctx)!;
      const node = custom(dots, dots.map((_, i) => ({ subs: [i], fill: true, stroke: false })), paint, null, ctx.name('freeform'), place);
      if (node !== null) nodes.push(node);
    }
  }
  return nodes;
}

/** Whether a subpath is one straight segment of some length: `M` then `L` to another point. */
function oneSegment(sub: Subpath): boolean {
  if (sub.length !== 2) return false;
  const [m, l] = sub as [PathSeg, PathSeg];
  return m[0] === 'M' && l[0] === 'L' && (m[1] !== l[1] || m[2] !== l[2]);
}

/** Whether two boxes share some area (boxes that only touch do not). */
const overlap = (a: Box, b: Box): boolean => Math.min(a[2], b[2]) > Math.max(a[0], b[0]) && Math.min(a[3], b[3]) > Math.max(a[1], b[1]);

/** The box of a subpath's points, grown by `by` on every side. */
function boxOf(sub: Subpath, by: number): Box {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of subpathPoints(sub)) [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  return [x0 - by, y0 - by, x1 + by, y1 + by];
}

/**
 * Ruling M3-R49: a chart's gridlines and bars, which the PDF draws as one path and PowerPoint had as objects of their
 * own (spec §13.6's "one paint, one shape" set aside for these two cases only). Null when the shape is not one of them.
 * - A stroke-only path whose every subpath is one straight segment (`M L`, of some length) is one connector per subpath,
 *   in path order: the PDF starts a dash pattern anew on every subpath, as a connector does.
 * - A filled path whose every subpath is a closed axis-aligned rectangle (`isRect`, with the shape's line: a stroke needs
 *   its `Z` and a dashed one the preset's start) is one rect per subpath, when no two of them overlap or nest, nor, with
 *   a line, come within its width of each other (each stroke reaching half of it past its rectangle, a hairline's one
 *   pixel on the slide): then no fill or stroke of one meets another's, and painting them one by one is the PDF's paint.
 * Subpaths that draw nothing (a lone `M`) are left out; at least two must be left. Each piece has the shape's fill and
 * line and is named as the shape's node of its kind with its 1-based place after it (`pdf:p1:z7 line 2`). Only solid
 * paints are split: a gradient or tile is laid over its node's frame, and one PDF shading is one gradient shape (S3);
 * a shape whose Scene line is not solid is not split, whether its line is written or not.
 *
 * Ruling M3-R56: a translucent stroke (its written alpha below 100000, the group alphas folded in) is split into
 * connectors only when no two segments' boxes, each grown by half the width (a hairline's one pixel on the slide),
 * overlap: the PDF composites a stroke's union once, where segments cross, share an end or overlap, and separate
 * connectors would composite it twice there.
 */
function splitPieces(
  shape: PassedShape,
  subpaths: readonly Subpath[],
  point: readonly boolean[],
  fill: Paint | null,
  line: LinePlan | null,
  ctx: ShapeCtx,
): OxNode[] | null {
  const style = shape.line;
  if (point.some(Boolean)) return null;
  const live = subpaths.filter(draws);
  if (live.length < 2) return null;
  if (style !== null && style.paint.kind !== 'solid') return null;
  const { place } = ctx;
  const reach = line === null || style === null ? 0 : Math.max(style.w, HAIRLINE_PT / place.scale) / 2;
  const apart = (subs: readonly Subpath[]): boolean => {
    const boxes = subs.map((sub) => boxOf(sub, reach));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) if (overlap(boxes[i]!, boxes[j]!)) return false;
    }
    return true;
  };

  if (fill === null) {
    if (line === null || style === null || !live.every(oneSegment)) return null;
    const opaque = style.paint.kind === 'solid' && pct(style.paint.alpha * ctx.alpha) === 100000;
    if (!opaque && !apart(live)) return null;
    return live.map((sub, k): OxConnector => {
      const [[, x0, y0], [, x1, y1]] = sub as [['M', number, number], ['L', number, number]];
      const frame = { ...frameOf([[x0, y0], [x1, y1]], place), flipH: x1 < x0, flipV: y1 < y0 };
      return { kind: 'line', name: `${ctx.name('line')} ${k + 1}`, frame, link: null, line: line(frame) };
    });
  }

  if (shape.fill?.kind !== 'solid') return null;
  if (!live.every((sub) => isRect({ geom: sub, line: line === null ? null : style }))) return null;
  if (!apart(live)) return null;
  return live.map((sub, k): OxShape => {
    const frame = frameOf(subpathPoints(sub), place);
    return { kind: 'shape', name: `${ctx.name('rect')} ${k + 1}`, frame, link: null, geom: { kind: 'rect' }, fill: fill(frame), line: line === null ? null : line(frame) };
  });
}
