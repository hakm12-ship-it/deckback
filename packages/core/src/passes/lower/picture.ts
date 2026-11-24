import type { Emu, OxCmd, OxFrame, OxPath, OxPicture, OxShape } from '@deckback/ooxml';
import type { Box, PathSeg } from '../../extract/inventory';
import { drawnBox, splitSubpaths } from '../fillrule';
import { localFrame, type LocalFrame, type PassedPicture } from '../pictures';
import type { Approximation } from '../report';
import type { NameKind } from './shape';
import { emu, lineStyle, pct, placeX, placeY, type Placement } from './units';

export interface PictureCtx {
  place: Placement;
  /** The product of the element's group alphas, folded into its own. */
  alpha: number;
  /** The name of the node of the element. */
  name: (kind: NameKind) => string;
  approximate: (kind: Approximation) => void;
}

/** A turn in degrees as DrawingML's: 60000ths of a degree, 0..21599999. */
const rot = (deg: number): number => (Math.round(deg * 60000) % 21600000) + 0;

/** A share as 1000ths of a percent, rounded half away from zero (as the writer rounds). */
const share = (v: number): number => Math.sign(v) * Math.round(Math.abs(v) * 100000) + 0;

/**
 * The frame of a box `b` of the picture's own frame: of `b`'s size, turned and flipped as the picture is, centred where
 * `b`'s centre lies on the slide (a node turns about its own centre, the picture about its box's), after the placement.
 */
function frameOf(pic: PassedPicture, local: LocalFrame, b: Box, place: Placement): OxFrame {
  const [sx, sy] = local.fromLocal((b[0] + b[2]) / 2, (b[1] + b[3]) / 2);
  const [hw, hh] = [(b[2] - b[0]) / 2, (b[3] - b[1]) / 2];
  const [x0, y0, x1, y1] = [placeX(place, sx - hw), placeY(place, sy - hh), placeX(place, sx + hw), placeY(place, sy + hh)];
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rot: rot(pic.xfrm.rotDeg), flipH: pic.xfrm.flipH, flipV: pic.xfrm.flipV };
}

/** How far from 0, next to the larger of its two products, a picture matrix's determinant may be and still be 0. */
const SINGULAR_TOL = 1e-9;

/**
 * Whether a picture's matrix (`a b c d e f`) carries its unit square onto no area: its determinant is 0 (the zero
 * matrix, or one of rank 1, which draws the square as a line), or as near 0 as rounding leaves it (`SINGULAR_TOL`). The
 * PDF paints nothing for such a picture (final review F11); a matrix of a tiny scale still has an area.
 */
function singular([a = 1, b = 0, c = 0, d = 1]: readonly number[]): boolean {
  const [p, q] = [a * d, b * c];
  return Math.abs(p - q) <= SINGULAR_TOL * Math.max(Math.abs(p), Math.abs(q));
}

/** Whether a subpath draws (DrawingML draws a path only with `lnTo` or a curve). */
const draws = (sub: readonly PathSeg[]): boolean => sub.some((seg) => seg[0] === 'L' || seg[0] === 'C');

/**
 * A picture as a node of the writer's model, or null when it paints nothing (alpha 0, its groups' included; a matrix
 * that carries it onto no area, `singular`; a clip shape that draws nothing).
 * - As the picture pass planned it (`PassedPicture.plan`; uncropped without one): an `OxPicture` at its frame (`xfrm`:
 *   the box, the turn in 60000ths of a degree, the flip), named `picture`. Cropped, its frame is the part that shows, and
 *   `srcRect` the share of the image cut off on each side (l, t, r, b), which is in the image's own frame: a mirrored
 *   picture's crop on the slide's left cuts its image's right. Its border (`PassedPicture.border`, M5 Task 5) is its line,
 *   its width scaled and its colour in its group alphas, as a shape's.
 * - Or the shape of its clip (`plan.kind` `shape`), named `freeform`: a custGeom of the clip's path in the picture's own
 *   frame, one `a:path` per group of `plan.paths` that fills, turned and flipped as the picture; its frame the extent
 *   of what the path draws (`drawnBox`: a cubic's handles may lie outside it, as PowerPoint lays the fill over that
 *   extent), its fill the picture (`blip`, `stretch`), its `fillRect` the picture's frame as a share of the node's
 *   (negative where the picture reaches past it); no line. A fill is laid in a node's own space, before its flips and turn (`rotWithShape`), so the picture
 *   lands as it does on the page.
 * - Its alpha times its group alphas. It records the clip approximations the pass left (`approximations`) and
 *   `skewed-picture` for a skewed one, whose frame only nears its matrix.
 */
export function lowerPicture(pic: PassedPicture, ctx: PictureCtx): OxPicture | OxShape | null {
  if (singular(pic.matrix)) return null;
  const alpha = pct(pic.alpha * ctx.alpha);
  if (alpha === 0) return null;
  const local = localFrame(pic);
  const box = local.box;
  const plan = pic.plan ?? { kind: 'picture', crop: null };
  let node: OxPicture | OxShape;
  if (plan.kind === 'picture') {
    const crop = plan.crop;
    const [w, h] = [box[2] - box[0], box[3] - box[1]];
    const srcRect: OxPicture['srcRect'] =
      crop === null ? null : [share((crop[0] - box[0]) / w), share((crop[1] - box[1]) / h), share((box[2] - crop[2]) / w), share((box[3] - crop[3]) / h)];
    const line = pic.border === undefined ? null : lineStyle(pic.border, ctx.place.scale, ctx.alpha);
    node = { kind: 'picture', name: ctx.name('picture'), frame: frameOf(pic, local, crop ?? box, ctx.place), link: null, media: pic.mediaHash, srcRect, alpha, ...(line === null ? {} : { line }) };
  } else {
    const subpaths = splitSubpaths(plan.geom);
    const groups = plan.paths.map((g) => g.map((i) => subpaths[i]!).filter(draws)).filter((g) => g.length > 0);
    const b = drawnBox(groups.flat(2) as PathSeg[]);
    if (b === null || b[2] - b[0] <= 0 || b[3] - b[1] <= 0) return null;
    const frame = frameOf(pic, local, b, ctx.place);
    const scale = ctx.place.scale;
    const x = (v: number): Emu => emu((v - b[0]) * scale);
    const y = (v: number): Emu => emu((v - b[1]) * scale);
    const cmds = (segs: readonly PathSeg[]): OxCmd[] =>
      segs.map((seg): OxCmd => {
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
    const paths = groups.map((g): OxPath => ({ w: frame.w, h: frame.h, fill: true, stroke: false, cmds: cmds(g.flat()) }));
    const [bw, bh] = [b[2] - b[0], b[3] - b[1]];
    const fillRect: [number, number, number, number] = [share((box[0] - b[0]) / bw), share((box[1] - b[1]) / bh), share((b[2] - box[2]) / bw), share((b[3] - box[3]) / bh)];
    node = {
      kind: 'shape',
      name: ctx.name('freeform'),
      frame,
      link: null,
      geom: { kind: 'custom', paths },
      fill: { kind: 'blip', media: pic.mediaHash, alpha, mode: { kind: 'stretch', fillRect } },
      line: null,
    };
  }
  for (const kind of pic.approximations ?? []) ctx.approximate(kind);
  if (pic.skewed) ctx.approximate('skewed-picture');
  return node;
}
