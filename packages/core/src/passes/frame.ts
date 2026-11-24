import type { Box, PathSeg } from '../extract/inventory';
import type { PictureEl } from '../scene/types';

/**
 * A picture's own frame (ruling M3-R31): its `xfrm` box before its flips and its turn, where its image lies upright, and
 * the maps between it and the slide. The picture pass judges a picture's clips in it and plans its crop or shape there
 * (pictures.ts); lowering writes it from there (lower/picture.ts); the raster renderer draws a picture below a fallback
 * as so planned (final review I1). A module of its own, with no import but types, so the renderer may read it.
 */

type Pt = [number, number];

/** A picture's own frame: its `xfrm` box, and the maps between the slide and that frame (before its flips and turn). */
export interface LocalFrame {
  box: Box;
  toLocal: (x: number, y: number) => Pt;
  fromLocal: (x: number, y: number) => Pt;
}

/**
 * The direction of the frame's x axis on the slide, (cos, sin) of its turn, from the matrix as `pictureXfrm` reads it:
 * the image's top edge, reversed when `flipH`; of an image with no width, its left edge. A quotient and a square root,
 * which every engine rounds alike (no sine of the turn: Global Constraints, Determinism), and exactly (±1, 0) upright.
 */
function axis(pic: PictureEl): Pt {
  const [a = 1, b = 0, c = 0, d = 1] = pic.matrix;
  const w = Math.sqrt(a * a + b * b);
  if (w > 0) return pic.xfrm.flipH ? [-a / w, -b / w] : [a / w, b / w];
  const h = Math.sqrt(c * c + d * d);
  return h > 0 ? [-d / h, c / h] : [1, 0];
}

/** The picture's own frame. Upright and unflipped, the maps are the identity, exactly. */
export function localFrame(pic: PictureEl): LocalFrame {
  const { x, y, w, h, flipH, flipV } = pic.xfrm;
  const box: Box = [x, y, x + w, y + h];
  const [cos, sin] = axis(pic);
  if (cos === 1 && sin === 0 && !flipH && !flipV) return { box, toLocal: (px, py) => [px, py], fromLocal: (qx, qy) => [qx, qy] };
  const [cx, cy] = [x + w / 2, y + h / 2];
  const [fx, fy] = [flipH ? -1 : 1, flipV ? -1 : 1];
  return {
    box,
    // turned back about the centre, then flipped back
    toLocal: (px, py) => {
      const [dx, dy] = [px - cx, py - cy];
      return [cx + fx * (dx * cos + dy * sin), cy + fy * (dy * cos - dx * sin)];
    },
    // flipped about the centre, then turned clockwise (y down)
    fromLocal: (qx, qy) => {
      const [vx, vy] = [fx * (qx - cx), fy * (qy - cy)];
      return [cx + vx * cos - vy * sin, cy + vx * sin + vy * cos];
    },
  };
}

/** A path with every point (control points too: the map is affine) taken through `map`. */
export function mapPath(geom: readonly PathSeg[], map: (x: number, y: number) => Pt): PathSeg[] {
  return geom.map((seg): PathSeg => {
    switch (seg[0]) {
      case 'M':
        return ['M', ...map(seg[1], seg[2])];
      case 'L':
        return ['L', ...map(seg[1], seg[2])];
      case 'C':
        return ['C', ...map(seg[1], seg[2]), ...map(seg[3], seg[4]), ...map(seg[5], seg[6])];
      case 'Z':
        return ['Z'];
    }
  });
}
