import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { OxFrame, OxNode, OxPicture, OxShape } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import type { PathSeg } from '../../src/extract/inventory';
import type { Box } from '../../src/extract/inventory';
import { lowerSlide, runPasses, type LowerCtx, type PassContext } from '../../src/passes';
import type { SlideReport } from '../../src/passes/report';
import { pictureXfrm } from '../../src/scene/build';
import { extractScene } from '../../src/scene/extract';
import type { ClipDef, Element, GroupRef, MediaInfo, PictureEl, SceneDeck, TileCell } from '../../src/scene/types';
import { repoRoot } from '../helpers/fixtures';
import { circle, deckOf, picture, rectPath, shape, slideOf } from '../helpers/passes';
import { decodePng } from '../helpers/png';
import { encodePng } from '../../src/scene/png';
import { syntheticPdf } from '../helpers/synthetic';

/**
 * Lowering pictures (Task 7): an `OxPicture` at its frame, cropped with `srcRect` where a rect of its own frame clips it,
 * else the shape of its clip filled with it (`blip`, stretched to its frame through `fillRect`); a pattern of one picture
 * a `blip` tile. Node names `pdf:p<page>:z<op> picture`, or `freeform` for a clipped one (ruling M3-R17).
 */

const PT = 12700;
const CTX: LowerCtx = { page: 1, scale: 1, offset: [0, 0] };
const HASH = 'a'.repeat(64);
const MEDIA: Record<string, MediaInfo> = { [HASH]: { hash: HASH, mime: 'image/png', widthPx: 16, heightPx: 16, byteLength: 100, passthrough: false } };
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Runs the passes over the elements and lowers the slide. */
function lower(elements: Element[], clips: Record<string, ClipDef> = {}, ctx: Partial<LowerCtx> = {}): { nodes: OxNode[]; report: SlideReport } {
  const input = slideOf(elements, { clips });
  const deck: SceneDeck = { ...deckOf([input]), media: MEDIA };
  const { slide, report } = runPasses(input, deck);
  return { nodes: lowerSlide(slide, deck, { ...CTX, ...ctx, report }).nodes, report };
}

const frame = (x: number, y: number, w: number, h: number, over: Partial<OxFrame> = {}): OxFrame => ({
  x: x * PT,
  y: y * PT,
  w: w * PT,
  h: h * PT,
  rot: 0,
  flipH: false,
  flipV: false,
  ...over,
});
const pic = (over: Partial<OxPicture>): OxPicture => ({ kind: 'picture', name: 'pdf:p1:z3 picture', frame: frame(20, 20, 100, 60), link: null, media: HASH, srcRect: null, alpha: 100000, ...over });
const group = (alpha: number): GroupRef => ({ alpha, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null });

/** The PDF unit-square matrix of a picture DrawingML would place at (x, y, w, h), turned `rot` degrees and flipped. */
function matrixOf(x: number, y: number, w: number, h: number, rot: number, flipH = false, flipV = false): number[] {
  const t = (rot * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const right = [(flipH ? -w : w) * cos, (flipH ? -w : w) * sin];
  const down = [(flipV ? -h : h) * -sin, (flipV ? -h : h) * cos];
  const [cx, cy] = [x + w / 2, y + h / 2];
  return [right[0]!, right[1]!, -down[0]!, -down[1]!, cx - right[0]! / 2 + down[0]! / 2, cy - right[1]! / 2 + down[1]! / 2];
}

function turned(x: number, y: number, w: number, h: number, rot: number, over: Partial<PictureEl> = {}): PictureEl {
  const raw = matrixOf(x, y, w, h, rot);
  const matrix = raw.map((v, i) => (i < 4 ? Math.round(v * 1e6) / 1e6 : Math.round(v * 1e3) / 1e3));
  return { ...picture([0, 0, 1, 1], { op: 3, mediaHash: HASH }), matrix, ...pictureXfrm(raw), ...over };
}

/** A point of a node's own space (EMU from its frame's corner, before its flips and turn) on the slide, in pt. */
function nodePoint(f: OxFrame, [px, py]: [number, number]): [number, number] {
  const [cx, cy] = [f.x + f.w / 2, f.y + f.h / 2];
  const [vx, vy] = [(f.flipH ? -1 : 1) * (f.x + px - cx), (f.flipV ? -1 : 1) * (f.y + py - cy)];
  const t = (f.rot / 60000) * (Math.PI / 180);
  return [(cx + vx * Math.cos(t) - vy * Math.sin(t)) / PT, (cy + vx * Math.sin(t) + vy * Math.cos(t)) / PT];
}

const close = (actual: readonly number[], expected: readonly number[], digits = 2) =>
  expected.forEach((v, i) => expect(actual[i], `[${i}]`).toBeCloseTo(v, digits));

describe('lower pictures', () => {
  it('a picture is an OxPicture at its frame, named for its op, with its media; counted', () => {
    const { nodes, report } = lower([picture([20, 20, 120, 80], { op: 3, mediaHash: HASH })]);
    expect(nodes).toEqual([pic({})]);
    expect(report.counts).toMatchObject({ pictures: 1, freeforms: 0, rects: 0 });
    expect(report.approximations).toEqual([]);
  });

  it('a stroke just around it (M5 Task 5, its border) is its own line: the picture counted, no rect; the line in its groups alpha', () => {
    const border = shape({ op: 4, geom: rectPath(19, 19, 102, 62), fill: null, line: { w: 2, cap: 'butt', join: 'round', miter: 10, dash: [8, 6], phase: 0, anisotropic: false, paint: { kind: 'solid', rgb: [112, 48, 160], alpha: 1 } } });
    const { nodes, report } = lower([picture([20, 20, 120, 80], { op: 3, mediaHash: HASH, groups: [group(0.5)] }), { ...border, groups: [group(0.5)] }]);
    expect(nodes).toEqual([
      pic({ alpha: 50000, line: { w: 2 * PT, fill: { kind: 'solid', rgb: '7030A0', alpha: 50000 }, cap: 'flat', join: 'round', miterLim: 1000000, dash: [400000, 300000] } }),
    ]);
    expect(report.counts).toMatchObject({ pictures: 1, freeforms: 0, rects: 0 });
  });

  it("its alpha and its groups' alphas go to alpha; a picture of alpha 0 writes nothing", () => {
    const { nodes, report } = lower([picture([20, 20, 120, 80], { op: 3, mediaHash: HASH, alpha: 0.5, groups: [group(0.5)], mask: 'm1' })]);
    expect(nodes).toEqual([pic({ alpha: 25000 })]);
    expect(report.approximations).toEqual([{ id: 'p1:z3', kind: 'mask-dropped' }]);
    expect(lower([picture([20, 20, 120, 80], { op: 3, mediaHash: HASH, alpha: 0 })]).nodes).toEqual([]);
  });

  it('a turned and flipped picture keeps its frame: rot in 60000ths of a degree, the flip', () => {
    const t = turned(100, 50, 100, 60, 30);
    expect(lower([t]).nodes).toEqual([pic({ frame: frame(100, 50, 100, 60, { rot: 1800000 }) })]);
    const m = picture([20, 20, 120, 80], { op: 3, mediaHash: HASH, matrix: [-100, 0, 0, -60, 120, 80], xfrm: { x: 20, y: 20, w: 100, h: 60, rotDeg: 0, flipH: true, flipV: false } });
    expect(lower([m]).nodes).toEqual([pic({ frame: frame(20, 20, 100, 60, { flipH: true }) })]);
  });

  it('a picture whose matrix carries it onto no area (determinant 0) paints nothing in the PDF and is not written (final review F11)', () => {
    const rank1 = picture([10, 10, 122, 234], { op: 3, mediaHash: HASH, matrix: [112, 224, 56, 112, 10, 10] });
    const zero = picture([50, 50, 50, 50], { op: 4, mediaHash: HASH, matrix: [0, 0, 0, 0, 50, 50] });
    const { nodes, report } = lower([rank1, zero]);
    expect(nodes).toEqual([]);
    expect(report.counts.pictures).toBe(0);
    expect(report.approximations).toEqual([]);
    // a tiny scale still has an area: written
    expect(lower([picture([50, 50, 50.000001, 50.000001], { op: 5, mediaHash: HASH, matrix: [1e-6, 0, 0, -1e-6, 50, 50.000001] })]).nodes).toHaveLength(1);
  });

  it('a skewed picture records skewed-picture', () => {
    const { nodes, report } = lower([picture([20, 20, 120, 80], { op: 3, mediaHash: HASH, skewed: true })]);
    expect(nodes).toHaveLength(1);
    expect(report.approximations).toEqual([{ id: 'p1:z3', kind: 'skewed-picture' }]);
  });

  it('a box that cuts it: srcRect, and the frame shrinks to the visible part', () => {
    const el = picture([20, 20, 120, 80], { op: 3, mediaHash: HASH, clip: ['c1'] });
    const { nodes, report } = lower([el], { c1: { kind: 'box', bbox: [50, 0, 300, 60] } });
    // 30 of 100 pt cut on the left, 20 of 60 at the bottom
    expect(nodes).toEqual([pic({ frame: frame(50, 20, 70, 40), srcRect: [30000, 0, 0, 33333] })]);
    expect(report.approximations).toEqual([]);
  });

  it("a crop of a turned picture is in its own frame; the frame turns about the visible part's centre", () => {
    // turned 90: its frame (10, 20)-(110, 70) lies on the slide at x 35..85, y -5..95; the box keeps y up to 60, which
    // is x up to 75 of its own frame: 35 of 100 pt cut on the right
    const t = turned(10, 20, 100, 50, 90, { clip: ['c1'] });
    const { nodes } = lower([t], { c1: { kind: 'box', bbox: [0, -100, 300, 60] } });
    expect(nodes).toEqual([pic({ frame: frame(27.5, 2.5, 65, 50, { rot: 5400000 }), srcRect: [0, 0, 35000, 0] })]);
    const f = (nodes[0] as OxPicture).frame;
    close(nodePoint(f, [0, 0]), [85, -5]); // its top left corner, turned 90 degrees: where the picture's is
    close(nodePoint(f, [f.w, f.h]), [35, 60]); // its bottom right: on the cut
  });

  it('a crop of a mirrored picture cuts the image where the slide shows it', () => {
    const m = picture([20, 20, 120, 80], { op: 3, mediaHash: HASH, clip: ['c1'], matrix: [-100, 0, 0, -60, 120, 80], xfrm: { x: 20, y: 20, w: 100, h: 60, rotDeg: 0, flipH: true, flipV: false } });
    const { nodes } = lower([m], { c1: { kind: 'box', bbox: [50, 0, 300, 200] } });
    // the slide's left 30 pt is the mirrored image's right 30 %
    expect(nodes).toEqual([pic({ frame: frame(50, 20, 70, 60, { flipH: true }), srcRect: [0, 0, 30000, 0] })]);
  });

  it('a path clip: a freeform of its geometry, filled with the picture stretched to its frame through fillRect, no line', () => {
    const el = picture([20, 20, 120, 80], { op: 3, mediaHash: HASH, clip: ['c1'], alpha: 0.5 });
    const ellipse = circle(70, 50, 30);
    const { nodes, report } = lower([el], { c1: { kind: 'path', geom: ellipse, rule: 'evenodd', bbox: [40, 20, 100, 80] } });
    expect(nodes).toHaveLength(1);
    const node = nodes[0] as OxShape;
    expect(node).toMatchObject({ kind: 'shape', name: 'pdf:p1:z3 freeform', frame: frame(40, 20, 60, 60), link: null, line: null });
    // the picture (20..120) reaches 20 pt, a third of the frame, past it on either side
    expect(node.fill).toEqual({ kind: 'blip', media: HASH, alpha: 50000, mode: { kind: 'stretch', fillRect: [-33333, 0, -33333, 0] } });
    expect(node.geom.kind).toBe('custom');
    const paths = (node.geom as Extract<OxShape['geom'], { kind: 'custom' }>).paths;
    expect(paths.map((p) => [p.w, p.h, p.fill, p.stroke])).toEqual([[60 * PT, 60 * PT, true, false]]);
    expect(paths[0]!.cmds[0]).toEqual(['M', 60 * PT, 30 * PT]);
    expect(report.counts).toMatchObject({ pictures: 0, freeforms: 1 });
  });

  it("a path clip whose curves' handles reach past them: the frame is the curves' own extent, the picture laid in it", () => {
    // a heart as PowerPoint exports one (atlas/fills/14, moved 700 pt left and 30 pt up): its handles reach 39 pt left,
    // 78 pt right and 33 pt up past its curves
    const heart: PathSeg[] = [
      ['M', 87.28, 39.47],
      ['C', 100.71, 40.94, 114.19, 47.79, 122, 61.5],
      ['C', 153.25, 6.67, 275.12, 61.5, 122, 132],
      ['C', 7.16, 79.12, 47, 35.06, 87.28, 39.47],
      ['Z'],
    ];
    const el = picture([46.45, 39.165, 197.54, 132], { op: 3, mediaHash: HASH, clip: ['c1'] });
    const node = lower([el], { c1: { kind: 'path', geom: heart, rule: 'nonzero', bbox: [7.16, 6.67, 275.12, 132] } }).nodes[0] as OxShape;
    // the curves' extent, where the derivative of each cubic is 0: x 46.45..197.54, y 39.165..132 (within 0.1 pt)
    const f = node.frame;
    close([f.x / PT, f.y / PT, (f.x + f.w) / PT, (f.y + f.h) / PT], [46.45, 39.165, 197.54, 132], 1);
    // so the picture, which fills that extent, fills the frame
    const fill = node.fill as Extract<OxShape['fill'], { kind: 'blip' }>;
    expect(fill.mode.kind === 'stretch' && fill.mode.fillRect.every((v) => Math.abs(v) <= 100)).toBe(true);
    // the path keeps every point, its handles outside the frame's own space
    const [path] = (node.geom as Extract<OxShape['geom'], { kind: 'custom' }>).paths;
    expect([path!.w, path!.h]).toEqual([f.w, f.h]);
    const xs = path!.cmds.flatMap((c) => (c[0] === 'C' ? [c[1], c[3], c[5]] : c[0] === 'Z' ? [] : [c[1]]));
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(f.w);
  });

  it('a box on a picture turned 30 degrees: a freeform turned with it, the box on the slide and the picture in fillRect', () => {
    const t = turned(100, 50, 100, 60, 30, { clip: ['c1'] });
    const { nodes } = lower([t], { c1: { kind: 'box', bbox: [0, 0, 300, 90] } });
    const node = nodes[0] as OxShape;
    expect(node).toMatchObject({ name: 'pdf:p1:z3 freeform', line: null, frame: { rot: 1800000, flipH: false, flipV: false } });
    const f = node.frame;
    const [path] = (node.geom as Extract<OxShape['geom'], { kind: 'custom' }>).paths;
    const corners = path!.cmds.filter((c) => c[0] !== 'Z').map((c) => nodePoint(f, [c[1] as number, c[2] as number]));
    [
      [0, 0],
      [300, 0],
      [300, 90],
      [0, 90],
    ].forEach((c, i) => close(corners[i]!, c));
    // the fill rect, in the node's own space, is the picture's frame: its corners land on the picture's
    const fill = node.fill as Extract<OxShape['fill'], { kind: 'blip' }>;
    const [l, top, r, b] = fill.mode.kind === 'stretch' ? fill.mode.fillRect : [0, 0, 0, 0];
    const rect: Box = [(l / 100000) * f.w, (top / 100000) * f.h, f.w - (r / 100000) * f.w, f.h - (b / 100000) * f.h];
    const m = t.matrix;
    close(nodePoint(f, [rect[0], rect[1]]), [m[4]! + m[2]!, m[5]! + m[3]!], 1); // the image's top left: (0, 1) of its square
    close(nodePoint(f, [rect[2], rect[3]]), [m[4]! + m[0]!, m[5]! + m[1]!], 1); // its bottom right: (1, 0)
  });

  it("a pattern of one picture: a blip tile from the first tile's corner, scaled to the cell", () => {
    const cell: TileCell = {
      bbox: [0, 0, 16, 16],
      xStep: 16,
      yStep: 16,
      matrix: [0.375, 0, 0, -0.375, 72, 72],
      paintType: 1,
      elements: [{ ...picture([0, 0, 1, 1], { op: 3 }), id: 'p1:z5/z3', mediaHash: HASH, matrix: [16, 0, 0, 16, 0, 0], xfrm: { x: 0, y: 0, w: 16, h: 16, rotDeg: 0, flipH: false, flipV: true } }],
      clips: {},
    };
    const { nodes, report } = lower([shape({ op: 5, geom: rectPath(73, 72, 130, 80), fill: { kind: 'tile', cell, alpha: 1 } })]);
    // 6 pt tiles from (72, 66): 1 pt left of the frame, and a whole tile above it, which is none; 6 pt of a 12 pt image
    expect(nodes).toEqual([
      {
        kind: 'shape',
        name: 'pdf:p1:z5 rect',
        frame: frame(73, 72, 130, 80),
        link: null,
        geom: { kind: 'rect' },
        fill: { kind: 'blip', media: HASH, alpha: 100000, mode: { kind: 'tile', tx: -PT, ty: 0, sx: 50000, sy: 50000 } },
        line: null,
      } satisfies OxShape,
    ]);
    expect(report.counts).toMatchObject({ rects: 1 });
    // on a slide scaled by a half, the tile is half as large again
    const half = lower([shape({ op: 5, geom: rectPath(73, 72, 130, 80), fill: { kind: 'tile', cell, alpha: 1 } })], {}, { scale: 0.5 });
    expect((half.nodes[0] as OxShape).fill).toMatchObject({ mode: { kind: 'tile', tx: -PT / 2, ty: 0, sx: 25000, sy: 25000 } });
  });

  it('tile phase (M5 Task 4): a tile starts where the pattern matrix puts the cell origin, wherever that lies', () => {
    // atlas fills/08-12 (PowerPoint's hatches): measured in PowerPoint, every tile's best whole-pixel shift against the
    // source render is (0, 0); what px32_shift1 still counts there is PowerPoint's resampling of the 16 px picture onto
    // 12 px, not the phase. Here the origin is off the 6 pt grid of the frame: (75.5, 80.25), y up, so the first
    // cell spans y 74.25 to 80.25 and the tiles start 2.5 - 6 = -3.5 pt and 2.25 - 6 = -3.75 pt from the frame's corner.
    const cell: TileCell = {
      bbox: [0, 0, 16, 16],
      xStep: 16,
      yStep: 16,
      matrix: [0.375, 0, 0, -0.375, 75.5, 80.25],
      paintType: 1,
      elements: [{ ...picture([0, 0, 1, 1], { op: 3 }), id: 'p1:z5/z3', mediaHash: HASH, matrix: [16, 0, 0, 16, 0, 0], xfrm: { x: 0, y: 0, w: 16, h: 16, rotDeg: 0, flipH: false, flipV: true } }],
      clips: {},
    };
    const { nodes } = lower([shape({ op: 5, geom: rectPath(73, 72, 130, 80), fill: { kind: 'tile', cell, alpha: 1 } })]);
    expect((nodes[0] as OxShape).fill).toEqual({ kind: 'blip', media: HASH, alpha: 100000, mode: { kind: 'tile', tx: -3.5 * PT, ty: -3.75 * PT, sx: 50000, sy: 50000 } });
  });

  describe("ruling M5-R10: a cell that is one of PowerPoint's preset patterns is that preset (a:pattFill)", () => {
    const NAVY = [31, 56, 100, 255] as const;
    const CREAM = [255, 242, 204, 255] as const;
    /** narHorz (every other row) at 2 px a bit, navy on cream, as atlas fills/09 has it; `poke` changes pixels. */
    const narHorz = (poke?: (data: Uint8Array) => void): Uint8Array => {
      const data = new Uint8Array(16 * 16 * 4);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) data.set(Math.floor(y / 2) % 2 === 0 ? NAVY : CREAM, (y * 16 + x) * 4);
      poke?.(data);
      return encodePng(data, 16, 16, 4);
    };
    const cellAt = (scale: number, origin: [number, number] = [72, 72]): TileCell => ({
      bbox: [0, 0, 16, 16],
      xStep: 16,
      yStep: 16,
      matrix: [scale, 0, 0, -scale, origin[0], origin[1]],
      paintType: 1,
      elements: [{ ...picture([0, 0, 1, 1], { op: 3 }), id: 'p1:z5/z3', mediaHash: HASH, matrix: [16, 0, 0, 16, 0, 0], xfrm: { x: 0, y: 0, w: 16, h: 16, rotDeg: 0, flipH: false, flipV: true } }],
      clips: {},
    });
    const fillOf = (png: Uint8Array, cell: TileCell, alpha = 1, ctx: Partial<LowerCtx> = {}) => {
      const input = slideOf([shape({ op: 5, geom: rectPath(73, 72, 130, 80), fill: { kind: 'tile', cell, alpha } })]);
      const deck: SceneDeck = { ...deckOf([input]), media: MEDIA };
      const { slide, report } = runPasses(input, deck, { media: new Map([[HASH, png]]) });
      return (lowerSlide(slide, deck, { ...CTX, ...ctx, report }).nodes[0] as OxShape).fill;
    };

    it('narHorz in navy on cream, 6 pt on the slide on its grid: pattFill narHorz with those colours', () => {
      expect(fillOf(narHorz(), cellAt(0.375))).toEqual({ kind: 'patt', prst: 'narHorz', fg: { rgb: '1F3864', alpha: 100000 }, bg: { rgb: 'FFF2CC', alpha: 100000 } });
      // the pattern's alpha goes into both colours
      expect(fillOf(narHorz(), cellAt(0.375), 0.5)).toMatchObject({ kind: 'patt', fg: { alpha: 50000 }, bg: { alpha: 50000 } });
      // off the grid by one row (0.75 pt): narHorz shifted by a row is narHorz with its colours the other way
      expect(fillOf(narHorz(), cellAt(0.375, [72, 72.75]))).toMatchObject({ kind: 'patt', prst: 'narHorz', fg: { rgb: 'FFF2CC' }, bg: { rgb: '1F3864' } });
    });

    it('three colours, a cell not 6 pt on the slide, or off the bit grid: the picture tile, as before', () => {
      const tile = { kind: 'blip', media: HASH, alpha: 100000 };
      expect(fillOf(narHorz((d) => d.set([1, 2, 3, 255], 0)), cellAt(0.375))).toMatchObject(tile);
      expect(fillOf(narHorz(), cellAt(0.4))).toMatchObject(tile);
      expect(fillOf(narHorz(), cellAt(0.375, [72.3, 72]))).toMatchObject(tile);
      // on a slide drawn at half the page's size the cell is 3 pt: no preset is that small
      expect(fillOf(narHorz(), cellAt(0.375), 1, { scale: 0.5 })).toMatchObject(tile);
    });
  });
});

describe('pictures of real PDFs', () => {
  it("the probe's one picture gives one OxPicture with the media key of its bytes (a PNG: it is Flate, ruling M3-R31)", async () => {
    const bytes = new Uint8Array(readFileSync(`${repoRoot}corpus/generated/probe_std.pdf`));
    const { scene, media } = await extractScene(bytes, { pages: [1] });
    const ctx: PassContext = { media };
    const { slide, report } = runPasses(scene.slides[0]!, scene, ctx);
    const pictures = lowerSlide(slide, scene, { page: 2, scale: 1, offset: [0, 0], report }).nodes.filter((n) => n.kind === 'picture');
    const [hash] = Object.keys(scene.media);
    expect(pictures).toEqual([
      // its clip is its own frame: dropped, so it is uncropped
      { kind: 'picture', name: 'pdf:p2:z279 picture', frame: frame(580, 90, 180, 120), link: null, media: hash, srcRect: null, alpha: 100000 },
    ]);
    expect(hash).toBe(sha256(media.get(hash!)!));
    expect(scene.media[hash!]?.mime).toBe('image/png');
  });

  it("stencils (ruling M3-R30): the Scene's PNG as it is, RGBA in the stencil colour with the mask as alpha; one mask in one colour is one entry, two colours two", async () => {
    // /Im3 is an 8 x 8 image mask: twice in red, once in blue
    const content = '1 0 0 rg q 80 0 0 80 10 10 cm /Im3 Do Q q 40 0 0 40 150 10 cm /Im3 Do Q 0 0 1 rg q 80 0 0 80 10 150 cm /Im3 Do Q';
    const { scene, media } = await extractScene(syntheticPdf(content));
    const { slide, report } = runPasses(scene.slides[0]!, scene, { media });
    const result = runPasses(scene.slides[0]!, scene, { media });
    // no media of its own: the bundle's are all there is (M5: only a raster fallback makes one, and there is none)
    expect(Object.keys(result)).toEqual(['slide', 'report', 'media']);
    expect(result.media.size).toBe(0);
    const nodes = lowerSlide(slide, scene, { ...CTX, report }).nodes as OxPicture[];
    expect(nodes.map((n) => n.kind)).toEqual(['picture', 'picture', 'picture']);
    const [red, again, blue] = nodes.map((n) => n.media);
    expect(again).toBe(red);
    expect(blue).not.toBe(red);
    expect([...media.keys()].sort()).toEqual([red!, blue!].sort());
    const alpha = Array.from({ length: 64 }, (_, i) => ((i >> 3 < 4) === ((i & 7) < 4) ? 0 : 255));
    for (const [key, rgb] of [
      [red!, [255, 0, 0]],
      [blue!, [0, 0, 255]],
    ] as const) {
      const png = decodePng(media.get(key)!);
      expect([png.width, png.height, png.channels]).toEqual([8, 8, 4]);
      expect(Array.from(png.data)).toEqual(alpha.flatMap((a) => [...rgb, a]));
    }
  });
});
