import { transformBox, type Matrix } from '../extract/gstate';
import type { Box, Ctm, Glyph, InvisibleGlyph, LineInv, PageInv, Paint, PathSeg } from '../extract/inventory';
import { roundPt } from './canonical';
import { pdfjsFontName } from './fonts';
import type { ElementBase, Fill, FontInfo, LineStyle, PictureEl, Rgb, SceneSlide, ShapeEl, TextLineEl } from './types';

/** The inventory rounds every number to 3 decimals and writes -0 as 0 (docs/decisions/0002-inventory-contract.md §1). */
const r3 = roundPt;

const CAP_NUMBERS = { butt: 0, round: 1, square: 2 } as const;
const JOIN_NUMBERS = { miter: 0, round: 1, bevel: 2 } as const;
const UNIT_SQUARE: Box = [0, 0, 1, 1];

/**
 * Rebuilds the inventory of the contract (0002) from the slide and the deck's fonts (`SceneDeck.fonts`) alone, so that
 * comparing it with the oracle proves the Scene lost nothing the walker found. A shape gives a paint for its fill, then
 * one for its line, as `B` paints them: `fill` and `stroke` in a solid colour, each with its path (and the stroke its line
 * style); `shade` for a gradient or another shading and `pattern` for a tile (`patternPaint`). A picture gives an `image`
 * paint (`imagePaint`). A text line gives its glyphs, or for invisible text (`noFill`) its invisible glyphs (`textGlyphs`).
 *
 * Only the slide's elements: those of its soft masks and tile cells are mask and pattern data, not page content
 * (0002 §9). Fallbacks give nothing (ruling M2-R17), and neither does the gradient or tile pattern that fills text,
 * which its run holds (`TextRun.fill`): the walker paints it as an approximate `shade` or `pattern` once per stretch of
 * text (0002 §5), and what ends a stretch is not in the Scene, so their number and places cannot be rebuilt exactly. A
 * page with such text lacks those paints here (0002 §19, ruling M2-R26); tier A has none. Nor does a pattern that
 * strokes text, which the Scene does not keep (its slide has a note instead).
 */
export function inventoryOfSlide(slide: SceneSlide, fonts: Readonly<Record<string, FontInfo>> = {}): PageInv {
  const paints: Paint[] = [];
  const glyphs: Glyph[] = [];
  const invisible: InvisibleGlyph[] = [];
  for (const el of slide.elements) {
    if (el.kind === 'picture') paints.push(imagePaint(el, slide));
    if (el.kind === 'textline') textGlyphs(el, fonts, glyphs, invisible);
    if (el.kind !== 'shape') continue;
    const { fill, line } = el;
    if (fill !== null) {
      paints.push(fill.kind === 'solid' ? solidPaint(el, slide, 'fill', fill, el.fillRule === 'evenodd') : patternPaint(el, slide, fill));
    }
    if (line !== null) {
      const { paint } = line;
      if (paint.kind === 'solid') paints.push({ ...solidPaint(el, slide, 'stroke', paint, false), line: lineInv(line) });
      else paints.push(patternPaint(el, slide, paint));
    }
  }
  return { index: slide.index, size: [r3(slide.sizePt[0]), r3(slide.sizePt[1])], paints, glyphs, invisible };
}

/**
 * The glyphs of a text line (0002 §6): each of its runs' glyphs at its origin, in the run's font by the name pdf.js gives
 * it (`pdfjsFontName`), and but for invisible text with the run's size, colour, alpha and paint, the line's writing mode,
 * and the product of its groups' alphas. A Type 3 font says so (`type3`).
 */
function textGlyphs(el: TextLineEl, fonts: Readonly<Record<string, FontInfo>>, glyphs: Glyph[], invisible: InvisibleGlyph[]): void {
  const groupAlpha = r3(el.groups.reduce((product, group) => product * group.alpha, 1));
  for (const run of el.runs) {
    const font = fonts[run.fontKey];
    if (font === undefined) throw new Error(`inventoryOfSlide: ${el.id} names font ${run.fontKey}, which the fonts do not hold`);
    const name = pdfjsFontName(font.baseFont);
    const type3 = font.type3 ? { type3: true as const } : {};
    for (const g of run.glyphs) {
      const place = { u: g.u, x: r3(g.x), y: r3(g.y), font: name };
      if (run.fillMode === 'noFill') {
        invisible.push({ ...place, ...type3 });
        continue;
      }
      const rgb: Glyph['rgb'] = run.rgb === null ? null : [run.rgb[0], run.rgb[1], run.rgb[2]];
      glyphs.push({ ...place, size: r3(run.sizePt), rgb, alpha: r3(run.alpha), groupAlpha, paint: run.fillMode, wmode: el.wmode, ...type3 });
    }
  }
}

/**
 * An `image` paint (0002 §16): its box is the unit square under its matrix, `ctm` the matrix itself, `px` the image's own
 * pixel size (not its media's), and a stencil has its colour as `rgb`.
 */
function imagePaint(el: PictureEl, slide: SceneSlide): Paint {
  const paint: Paint = {
    kind: 'image',
    bbox: roundBox(transformBox(el.matrix as Matrix, UNIT_SQUARE)), // a matrix is 6 numbers (scene.schema.json)
    rgb: el.stencil === null ? null : [el.stencil[0], el.stencil[1], el.stencil[2]],
    alpha: r3(el.alpha),
    evenOdd: false,
    ...paintState(el, slide),
    ctm: el.matrix.map(r3) as Ctm,
    stencil: el.stencil !== null,
  };
  if (el.px !== null) paint.px = [el.px[0], el.px[1]];
  return paint;
}

/** A fill or stroke paint of a shape in a solid colour, with the shape's path when it has one. */
function solidPaint(
  el: ShapeEl,
  slide: SceneSlide,
  kind: 'fill' | 'stroke',
  paint: { rgb: Rgb; alpha: number },
  evenOdd: boolean,
): Paint {
  const { rgb, alpha } = paint;
  return {
    kind,
    bbox: roundBox(el.bbox),
    rgb: [rgb[0], rgb[1], rgb[2]],
    alpha: r3(alpha),
    evenOdd,
    ...paintState(el, slide),
    ...(el.geom === null ? {} : { path: el.geom.map(roundSeg) }),
  };
}

/**
 * The `shade` (a gradient, or a function-based shading or mesh, with its kind of shading: 0002 §16) or `pattern` (a tile)
 * that fills a shape or paints its line. Its box is its clip, which holds the shape it paints (0002 §5, §9; ruling M2-R12);
 * of `sh`, which has no shape, the shape's `bbox` (the clip, or under a soft mask of its own the shading's bounds in it,
 * 0002 §10). It has no colour, path or line in the contract, and is approximate (`approx`) where its clip is.
 */
function patternPaint(el: ShapeEl, slide: SceneSlide, fill: Exclude<Fill, { kind: 'solid' }>): Paint {
  const state = paintState(el, slide);
  const paint: Paint = {
    kind: fill.kind === 'tile' ? 'pattern' : 'shade',
    bbox: roundBox(el.geom === null ? el.bbox : el.clipBox),
    rgb: null,
    alpha: r3(fill.alpha),
    evenOdd: false,
    ...state,
  };
  if (state.clipApprox === true) paint.approx = true;
  if (fill.kind !== 'tile') paint.shading = fill.kind === 'linear' ? 'axial' : fill.kind === 'radial' ? 'radial' : fill.shading;
  return paint;
}

/**
 * What every paint has (0002 §17): its clip box, the product of its groups' alphas, the first blend mode that is not
 * `normal` from the element outward through its groups, and whether a soft mask is over it, its own or one a group took
 * (`mask`, rulings M2-R11, M2-R14). The clip is approximate (`clipApprox`) when a text clip is part of it.
 */
function paintState(el: ElementBase, slide: SceneSlide): Pick<Paint, 'clip' | 'groupAlpha' | 'blend' | 'masked' | 'clipApprox'> {
  let blend: string = el.blend;
  for (let i = el.groups.length - 1; i >= 0 && blend === 'normal'; i--) blend = el.groups[i]!.blend;
  const state = {
    clip: roundBox(el.clipBox),
    groupAlpha: r3(el.groups.reduce((product, group) => product * group.alpha, 1)),
    blend,
    masked: el.mask !== null,
  };
  return el.clip.some((id) => slide.clips[id]?.kind === 'text') ? { ...state, clipApprox: true } : state;
}

/** `cap` and `join` back to the PDF's numbers. */
function lineInv(line: LineStyle): LineInv {
  return {
    w: r3(line.w),
    cap: CAP_NUMBERS[line.cap],
    join: JOIN_NUMBERS[line.join],
    miter: r3(line.miter),
    dash: line.dash.map(r3),
    phase: r3(line.phase),
  };
}

function roundBox(b: Box): Box {
  return [r3(b[0]), r3(b[1]), r3(b[2]), r3(b[3])];
}

function roundSeg(seg: PathSeg): PathSeg {
  return seg.map((v) => (typeof v === 'number' ? r3(v) : v)) as PathSeg;
}
