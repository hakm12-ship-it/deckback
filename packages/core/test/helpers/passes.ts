import type { PathSeg } from '../../src/extract/inventory';
import { loopsArea } from '../../src/passes/region';
import {
  SCENE_SCHEMA,
  type Element,
  type FallbackEl,
  type Fill,
  type HotspotEl,
  type LineStyle,
  type PictureEl,
  type Rgb,
  type SceneDeck,
  type SceneSlide,
  type ShapeEl,
  type Stop,
  type TextLineEl,
} from '../../src/scene/types';

/**
 * Scene elements made up for the pass tests, on a 300 x 200 pt page: each builder gives a plain, visible element that a
 * test changes with `over`. Ids are `p1:z<op>`, the op given or counted up.
 */

export const PAGE: [number, number] = [300, 200];

let nextOp = 1;

function base(op?: number): Pick<ShapeEl, 'id' | 'provenance' | 'clip' | 'clipBox' | 'groups' | 'mask' | 'blend'> {
  const z = op ?? nextOp++;
  return {
    id: `p1:z${z}`,
    provenance: { opIndex: [z], mcid: null, struct: null },
    clip: [],
    clipBox: [0, 0, PAGE[0], PAGE[1]],
    groups: [],
    mask: null,
    blend: 'normal',
  };
}

export const solid = (rgb: Rgb = [255, 0, 0], alpha = 1): Fill => ({ kind: 'solid', rgb, alpha });

export function lineStyle(over: Partial<LineStyle> = {}): LineStyle {
  return { w: 2, cap: 'butt', join: 'miter', miter: 10, dash: [], phase: 0, anisotropic: false, paint: solid([0, 0, 0]), ...over };
}

/** The area (pt²) a path of closed polygons (`M`, `L`s, `Z`) fills even-odd (region.ts `loopsArea`). */
export function outlineArea(geom: readonly PathSeg[]): number {
  const loops: number[][] = [];
  for (const seg of geom) {
    if (seg[0] === 'M') loops.push([seg[1], seg[2]]);
    else if (seg[0] === 'L') loops[loops.length - 1]!.push(seg[1], seg[2]);
  }
  return Math.abs(loopsArea(loops));
}

/** The box of every point of a path, control points included. */
export function pathBox(geom: PathSeg[]): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const seg of geom) {
    for (let i = 1; i < seg.length; i += 2) {
      [x0, x1] = [Math.min(x0, seg[i] as number), Math.max(x1, seg[i] as number)];
      [y0, y1] = [Math.min(y0, seg[i + 1] as number), Math.max(y1, seg[i + 1] as number)];
    }
  }
  return x0 === Infinity ? [0, 0, 0, 0] : [x0, y0, x1, y1];
}

/** A closed polygon through `pts`, as `M L ... Z`. */
export function poly(pts: [number, number][]): PathSeg[] {
  return [['M', ...pts[0]!], ...pts.slice(1).map((p): PathSeg => ['L', ...p]), ['Z']];
}

/** A square of side `s` at (x, y), clockwise on the page (y down: right, down, left, up), or counter-clockwise. */
export function square(x: number, y: number, s: number, dir: 'cw' | 'ccw' = 'cw'): PathSeg[] {
  const cw: [number, number][] = [
    [x, y],
    [x + s, y],
    [x + s, y + s],
    [x, y + s],
  ];
  return poly(dir === 'cw' ? cw : [cw[0]!, cw[3]!, cw[2]!, cw[1]!]);
}

/** A rectangle at (x, y) of w x h, clockwise. */
export function rectPath(x: number, y: number, w: number, h: number): PathSeg[] {
  return poly([
    [x, y],
    [x + w, y],
    [x + w, y + h],
    [x, y + h],
  ]);
}

/** A circle of radius r about (cx, cy) as four cubics, clockwise on the page or counter-clockwise. */
export function circle(cx: number, cy: number, r: number, dir: 'cw' | 'ccw' = 'cw'): PathSeg[] {
  const k = 0.5523 * r;
  const s = dir === 'cw' ? 1 : -1; // y down: clockwise goes from the right point down first
  return [
    ['M', cx + r, cy],
    ['C', cx + r, cy + s * k, cx + k, cy + s * r, cx, cy + s * r],
    ['C', cx - k, cy + s * r, cx - r, cy + s * k, cx - r, cy],
    ['C', cx - r, cy - s * k, cx - k, cy - s * r, cx, cy - s * r],
    ['C', cx + k, cy - s * r, cx + r, cy - s * k, cx + r, cy],
    ['Z'],
  ];
}

export function shape(over: Partial<ShapeEl> & { op?: number } = {}): ShapeEl {
  const { op, ...rest } = over;
  const geom = rest.geom === undefined ? rectPath(10, 20, 100, 50) : rest.geom;
  return {
    ...base(op),
    kind: 'shape',
    geom,
    fillRule: 'nonzero',
    fill: solid(),
    line: null,
    bbox: geom === null ? [0, 0, PAGE[0], PAGE[1]] : pathBox(geom),
    ...rest,
  };
}

export function textline(over: Partial<TextLineEl> & { op?: number } = {}): TextLineEl {
  const { op, ...rest } = over;
  return {
    ...base(op),
    kind: 'textline',
    runs: [
      {
        text: 'Hi',
        fontKey: 'f1',
        sizePt: 12,
        rgb: [0, 0, 0],
        alpha: 1,
        fillMode: 'fill',
        stroke: null,
        fill: solid([0, 0, 0]),
        bold: false,
        italic: false,
        spcPt: 0,
        hScale: 1,
        skew: 0,
        rise: 0,
        glyphs: [
          { u: 'H', x: 20, y: 40, adv: 8 },
          { u: 'i', x: 28, y: 40, adv: 4 },
        ],
      },
    ],
    baseline: { x: 20, y: 40 },
    angleDeg: 0,
    wmode: 0,
    bboxPt: [20, 30, 32, 43],
    ...rest,
  };
}

/** A picture whose unit square lands on the box (x0, y0)-(x1, y1), upright. */
export function picture(box: [number, number, number, number], over: Partial<PictureEl> & { op?: number } = {}): PictureEl {
  const { op, ...rest } = over;
  const [x0, y0, x1, y1] = box;
  return {
    ...base(op),
    kind: 'picture',
    mediaHash: '0'.repeat(64),
    matrix: [x1 - x0, 0, 0, -(y1 - y0), x0, y1],
    xfrm: { x: x0, y: y0, w: x1 - x0, h: y1 - y0, rotDeg: 0, flipH: false, flipV: false },
    skewed: false,
    alpha: 1,
    stencil: null,
    px: [10, 10],
    ...rest,
  };
}

export function hotspot(n: number, rect: [number, number, number, number], link: HotspotEl['link']): HotspotEl {
  return {
    id: `p1:a${n}`,
    provenance: { opIndex: [], mcid: null, struct: null },
    clip: [],
    clipBox: [0, 0, PAGE[0], PAGE[1]],
    groups: [],
    mask: null,
    blend: 'normal',
    kind: 'hotspot',
    rect,
    link,
  };
}

export function fallback(reason: string, over: Partial<FallbackEl> & { op?: number } = {}): FallbackEl {
  const { op, ...rest } = over;
  const b = base(op);
  return { ...b, kind: 'fallback', reason, coveredOps: b.provenance.opIndex, raster: null, bbox: [10, 10, 50, 50], ...rest };
}

export function slideOf(elements: Element[], over: Partial<SceneSlide> = {}): SceneSlide {
  return { index: 0, sizePt: [...PAGE], elements, clips: {}, masks: {}, notes: [], failed: null, ...over };
}

export function deckOf(slides: SceneSlide[]): SceneDeck {
  return {
    schema: SCENE_SCHEMA,
    source: { producer: null, creator: null, tagged: false, encrypted: false, pageCount: slides.length },
    slides,
    fonts: {},
    media: {},
  };
}

/** A deep copy, to check that a pass leaves its input as it was. */
export const snapshot = <T>(value: T): T => structuredClone(value);

/**
 * pdf.js' 29 stops of the probe's gradient (`corpus/generated/probe_std.pdf` page 2, `p2:z54`): PowerPoint's two-stop
 * 0070C0 to FFFFFF gradient, mirrored about its middle, as the PDF samples it.
 */
export const PROBE_STOPS: Stop[] = (
  [
    [0, 255, 255, 255],
    [0.069048, 249, 250, 252],
    [0.136905, 235, 238, 246],
    [0.191667, 215, 222, 237],
    [0.230952, 196, 207, 230],
    [0.27381, 172, 188, 221],
    [0.307143, 150, 173, 214],
    [0.336905, 131, 159, 209],
    [0.347619, 123, 154, 206],
    [0.355952, 117, 151, 205],
    [0.409524, 81, 131, 198],
    [0.465476, 43, 117, 193],
    [0.491667, 20, 113, 192],
    [0.496429, 12, 112, 192],
    [0.49881, 1, 112, 192],
    [0.50119, 1, 112, 192],
    [0.503571, 12, 112, 192],
    [0.510714, 23, 113, 192],
    [0.545238, 51, 119, 194],
    [0.603571, 90, 135, 199],
    [0.629762, 108, 145, 203],
    [0.692857, 150, 173, 214],
    [0.733333, 176, 192, 223],
    [0.784524, 204, 213, 233],
    [0.805952, 214, 221, 237],
    [0.84881, 230, 235, 244],
    [0.89881, 243, 245, 250],
    [0.955952, 252, 252, 253],
    [1, 255, 255, 255],
  ] as const
).map(([t, r, g, b]): Stop => ({ t, rgb: [r, g, b] }));

type Linear = Extract<Fill, { kind: 'linear' }>;
type Radial = Extract<Fill, { kind: 'radial' }>;

/** A linear gradient fill, `over` changing any part of it: by default red to blue along x from 0 to 100 pt. */
export function linear(over: Partial<Linear> = {}): Linear {
  return {
    kind: 'linear',
    stops: [
      { t: 0, rgb: [255, 0, 0] },
      { t: 1, rgb: [0, 0, 255] },
    ],
    p0: [0, 0],
    p1: [100, 0],
    matrix: [1, 0, 0, 1, 0, 0],
    extend: [true, true],
    alpha: 1,
    ...over,
  };
}

/** A radial gradient fill, `over` changing any part of it: by default white to black from (50, 50) out to 50 pt. */
export function radial(over: Partial<Radial> = {}): Radial {
  return {
    kind: 'radial',
    stops: [
      { t: 0, rgb: [255, 255, 255] },
      { t: 1, rgb: [0, 0, 0] },
    ],
    p0: [50, 50],
    r0: 0,
    p1: [50, 50],
    r1: 50,
    matrix: [1, 0, 0, 1, 0, 0],
    extend: [true, true],
    alpha: 1,
    ...over,
  };
}
