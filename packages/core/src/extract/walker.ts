import { IMAGE_KIND, OPS, parsePdfjsRef, type PageData, type PdfjsFont } from '../engine/pdfjs-adapter';
import type { Ref } from '../engine/rawpdf';
import type { BlendName, ClipDef } from '../scene/types';
import { UnsupportedOpError } from './errors';
import {
  applyPoint,
  Bounds,
  concat,
  GStateStack,
  IDENTITY,
  initialState,
  intersect,
  pageFrame,
  toMatrix,
  transformBox,
  type ClipNode,
  type Colour,
  type Matrix,
} from './gstate';
import type { Box, Glyph, LineInv, PathSeg } from './inventory';
import { axisAligned, boundsOf, lineScale, segmentsOf, strokeBounds } from './paths';
import { hexRgb, tilingPattern, type TilingPattern } from './patterns';
import { layoutRun, moveText, newTextObject, setTextMatrix, type TextObject } from './text';

export { UnsupportedOpError } from './errors';
export { pageFrame } from './gstate';

/** One paint or glyph the walker found, in paint order. Geometry is in the slide frame (see `Inventory`). */
export interface RawOp {
  /** Index of the pdf.js operator that produced it. */
  opIndex: number;
  /**
   * `invisible`: a glyph of a run with Tr 3 (0002 §6 glyphs). It has `glyph` and paints nothing.
   * `unsupported`: in lenient mode only (`walkPage`), an operator the walker could not model, which it skipped; it has
   * `unsupported` and is no paint of the inventory. Its `bbox` is the clip in force: what it paints, if anything, is not
   * known.
   */
  kind: 'fill' | 'stroke' | 'shade' | 'image' | 'pattern' | 'glyph' | 'invisible' | 'unsupported';
  /**
   * unsupported: why, in fixed words that never quote the page (`UnsupportedOpError.reason`; for any other error, that the
   * walker could not read the operator). A Scene `Note` carries it (Global Constraints, Privacy).
   */
  unsupported?: string;
  /** Paths: the bounds of every point, bezier control points included, not expanded by the line width
   * (docs/decisions/0002-inventory-contract.md §4 path bbox). Shades and patterns: the current clip, narrowed by
   * the painted shape, for a stroke as far as the stroke reaches (0002 §5 shade bbox, §9 mask and pattern contents,
   * §15 line style). Images: the unit square under the CTM.
   * Glyphs: the advance box (origin to origin + advance, font descent to ascent). */
  bbox: Box;
  /**
   * fill/stroke: the solid colour; image: the colour of a stencil, null for any other; glyph: that of its fill (of its
   * stroke when only that paints), if solid; else null.
   */
  rgb: [number, number, number] | null;
  alpha: number;
  /** Only meaningful for fills; a shade or pattern that fills a path has it too, for the Scene. */
  evenOdd: boolean;
  /** A shade or pattern whose bbox comes from approximate text-clip boxes (0002 §5 shade bbox). */
  approx?: true;
  /**
   * fill, stroke: the path as pdf.js gives it, in the slide frame (0002 §14 path geometry). A shade or pattern that paints
   * a path or a stroke has it too, for the Scene; the inventory gives those none (0002 §1).
   */
  path?: PathSeg[];
  /**
   * A shade or pattern that paints a path or a stroke: the path's bounds (0002 §4). Its `bbox` is these cut to the clip,
   * for a stroke first grown as far as the stroke reaches (0002 §15).
   */
  pathBox?: Box;
  /** stroke, and a shade or pattern that paints a stroke: its line style (0002 §15 line style). */
  line?: LineInv;
  /**
   * stroke, and a shade or pattern that paints a stroke: the CTM it is drawn under (user space → slide frame). Not part of
   * the inventory: the Scene reads from it whether `line.w` is the same in every direction (`LineStyle.anisotropic`, ruling
   * M2-R4).
   */
  lineCtm?: Matrix;
  /** shade, pattern: what it fills is text, a stretch of it (0002 §5). The Scene's text run holds it (`RunData.fill`). */
  text?: true;
  /** pattern: the tiling pattern's cell, walked in cell space. Not part of the inventory (0002 §9). */
  tile?: TileInfo;
  /** Innermost marked-content id, if any. */
  mcid: number | null;
  /**
   * `size` is the font size in slide-frame points; `fontId` is the id `setFont` named; `font` is pdf.js' `font.name`;
   * `paint`, `wmode` and `type3` are as in `Glyph` (0002 §6 glyphs). An `invisible` glyph paints nothing: its `paint` says
   * `clip` and means nothing. `adv` is not part of the inventory: the glyph's advance in the slide frame, along the text's
   * x axis (horizontal scaling, Tc and, for a space, Tw included); in vertical writing its width. A glyph of several code
   * points is one RawOp a code point at one origin, and only the first has the advance: the others have 0.
   */
  glyph?: {
    u: string;
    x: number;
    y: number;
    adv: number;
    size: number;
    fontId: string;
    font: string;
    paint: Glyph['paint'];
    wmode: 0 | 1;
    type3?: true;
    /**
     * Not part of the inventory (M8 round 1a): the glyph's code in the shown string, as pdf.js gives it, on a glyph of one
     * code point; absent where pdf.js gave none. The Scene reads a symbol font's own code from it (scene/fonts.ts).
     */
    code?: number;
  };
  /** glyph, invisible: what the glyphs of its `showText` run share, for the Scene's text run. Not part of the inventory. */
  run?: RunData;
  /**
   * image: the CTM, which carries the PDF's unit square (its origin at the image's bottom left corner, its y axis up) to the
   * slide frame (0002 §16 images and shadings).
   */
  ctm?: Matrix;
  /** image: width and height in pixels, as the image says them; absent when pdf.js gave none. */
  px?: [number, number];
  /**
   * image: an image mask, which paints `rgb` through its pixels. shade, pattern: set (true) when what it fills is an image
   * mask; the Scene makes that a fallback (Task 10). Only an image's reaches the inventory.
   */
  stencil?: boolean;
  /**
   * What a shade is made of (0002 §16). Axial and radial shadings carry their geometry, in shading space; `ctm` maps shading
   * space to the slide frame. Function-based shadings and meshes carry the triangles pdf.js turns both into (`mesh`, M5:
   * what the raster renderer draws), when its IR has them.
   */
  shading?:
    | {
        type: 'axial' | 'radial';
        colorStops: [number, string][];
        p0: [number, number];
        p1: [number, number];
        r0: number;
        r1: number;
        ctm: number[];
      }
    | { type: 'function' | 'mesh'; ctm: number[]; mesh?: RawMesh };
  /** pdf.js `imgData.ref` when present. */
  imageRef?: Ref | null;
  /**
   * The clip in force (0002 §5, §17), in the slide frame. A shade or pattern that paints a shape (a path, a stroke, text, an
   * image mask) has that shape in it too, as MuPDF clips to the shape before it paints the pattern: its clip is its bbox.
   */
  clip: Box;
  /** The clip comes from approximate text-clip boxes (0002 §5): on a shade or pattern, wherever it is `approx`. */
  clipApprox?: true;
  /**
   * The clips that make `clip` (`GState.clipChain`), innermost first, without the shape a shade or pattern paints; absent
   * when only the page (or the cell) bounds it. Not part of the inventory: the Scene's `clip`.
   */
  clipChain?: ClipNode;
  /** Its own blend mode, a lower-case PDF name (`normal`, `multiply`, ...); the groups' are in `groups` (0002 §17). */
  blend: BlendName;
  /**
   * A soft mask of its own is over it: one set in the graphics state and not taken by an enclosing transparency group.
   * One a group took is that group's `masked` (0002 §17).
   */
  masked: boolean;
  /** The soft mask `masked` says is over it, when it is. Not part of the inventory: the Scene's `mask`. */
  softMask?: SoftMask;
  /** The transparency groups it is drawn in, outermost first (0002 §17). */
  groups: readonly GroupFrame[];
}

/**
 * A transparency group (pdf.js `beginGroup` of a form with a /Group): its alpha and blend mode are those in force where it
 * is drawn, and inside it both start over at 1 and normal (0002 §17).
 */
export interface GroupFrame {
  /** The fill alpha (ca) where the group is drawn. */
  alpha: number;
  /** The blend mode where the group is drawn. */
  blend: BlendName;
  isolated: boolean;
  knockout: boolean;
  /** The group's /BBox in the slide frame; null when pdf.js gave none. */
  bbox: Box | null;
  /** It took the soft mask in force where it is drawn, which then applies to everything drawn inside it. */
  masked: boolean;
  /** The mask `masked` says it took; null when it took none. */
  mask: SoftMask | null;
}

/**
 * What every glyph of one `showText` run shares (Task 9): the glyphs whose `run` is the same object are that run. It
 * carries what the Scene's `TextRun` needs beyond the glyphs and is no part of the inventory.
 */
export interface RunData {
  /**
   * Text space (the space of the text matrix's input, before Tf, Tz and Ts) → the walker's frame: the CTM after the text
   * matrix where the run is shown. Its x axis (a, b) runs along the baseline, its y axis (c, d) up the glyphs.
   */
  matrix: Matrix;
  /** Tc, in text space units. */
  charSpacing: number;
  /** Tz / 100. */
  hScale: number;
  /** Ts, in text space units: the glyph origins are this far up the y axis from the baseline. */
  rise: number;
  /**
   * What the run fills with, when it fills (its glyphs' `paint` is `fill` or `fillStroke`): the colour and fill alpha, or the
   * shading or tiling pattern (the one its stretch's `shade` or `pattern` paints too, 0002 §5). Null when it does not fill.
   */
  fill: RunFill | null;
  /**
   * What it strokes with, when it strokes (`stroke` or `fillStroke`): the colour, null for a pattern; the stroke alpha; and
   * the line width in the walker's frame (the PDF width × `lineScale` of the CTM, as a stroke's, 0002 §15). Else null.
   */
  stroke: { rgb: [number, number, number] | null; alpha: number; w: number } | null;
  /** pdf.js has no program for the font (`missingFile`): it is not embedded, or pdf.js could not read it. */
  missingFile: boolean;
}

/** The fill of a text run: a colour, a shading pattern (its shading as a `shade` carries it) or a tiling pattern. */
export type RunFill =
  | { kind: 'rgb'; rgb: [number, number, number]; alpha: number }
  | { kind: 'shading'; shading: RawOp['shading']; alpha: number }
  | { kind: 'tile'; tile: TileInfo; alpha: number };

/** A pdf.js operator list: the page's, or a tile cell's. */
type OpList = PageData['ops'];

/**
 * A soft mask (gs `/SMask`), captured from the group pdf.js draws it with (`beginGroup({ smask })` .. `endGroup`, sent
 * before the `setGState` that sets it). Mask data, never page content (0002 §9).
 */
export interface SoftMask {
  subtype: 'alpha' | 'luminosity';
  /** /BC, as pdf.js gives it: black for a luminosity mask without one; null for an alpha mask without one. */
  backdrop: [number, number, number] | null;
  /**
   * What the mask's group draws, in the frame the mask was set in, from alpha 1, normal, no soft mask and none of the
   * clips of what it masks: clipped only by the group's /BBox and what it clips itself.
   */
  ops: RawOp[];
  /** The operator list the ops' `opIndex` index (`imagePixels`, `opNameAt`). */
  opList: OpList;
}

/** A tiling pattern's cell (pdf.js `TilingPattern`), as a `pattern` RawOp carries it. */
export interface TileInfo {
  /** /BBox, in cell space: the cell's content is clipped to it. */
  bbox: Box;
  xStep: number;
  yStep: number;
  /** Cell space → the walker's frame (the slide frame, or an outer cell's space): the base transform after /Matrix. */
  matrix: Matrix;
  paintType: 1 | 2;
  /**
   * What the cell draws, in cell space, walked from an identity CTM; for PaintType 2 in the colour `scn` gave it. Pattern
   * data, never page content (0002 §9). Walked once per page: every cell of the page with the same pattern content,
   * colour and /BBox holds the same array (`CellWalks`), so it is only read.
   */
  ops: RawOp[];
  /** The cell's operator list, which the ops' `opIndex` index (`imagePixels`, `opNameAt`). */
  opList: OpList;
}

/** What `emit` fills in from the state: the clip of a shade or pattern is its own (see `RawOp.clip`). */
type Emitted = Omit<RawOp, 'opIndex' | 'mcid' | 'clip' | 'blend' | 'masked' | 'groups' | 'clipChain' | 'softMask'> & { clip?: Box };
/** What a shade or a pattern paints besides its box: the shape's facts, for the Scene. */
type Shape = Partial<Pick<Emitted, 'path' | 'pathBox' | 'evenOdd' | 'line' | 'lineCtm' | 'text' | 'stencil'>>;
type TilingColour = Extract<Colour, { kind: 'tiling' }>;

const OP_NAMES = new Map<number, string>();
for (const [name, code] of Object.entries(OPS)) if (!OP_NAMES.has(code)) OP_NAMES.set(code, name);
const opName = (code: number): string => OP_NAMES.get(code) ?? `op ${code}`;

/**
 * The name of the pdf.js operator at `opIndex` of the page (`paintImageXObject`, ...), as `UnsupportedOpError` names one.
 * For an op of a tile cell, `ops` is the cell's (`TileInfo.opList`).
 */
export function opNameAt(page: Pick<PageData, 'ops'>, opIndex: number): string {
  return opName(page.ops.fnArray[opIndex] ?? -1);
}

/**
 * The pixels pdf.js decoded for a picture, as it holds them (not copied):
 * - `gray1`: 1 bit a pixel, the high bit first, each row padded to a whole byte, 1 white (`GRAYSCALE_1BPP`);
 * - `rgb`: 3 bytes a pixel (`RGB_24BPP`), also for gray and CMYK images, which pdf.js turns into RGB;
 * - `rgba`: 4 bytes a pixel, not premultiplied, the soft mask or colour-key mask applied (`RGBA_32BPP`);
 * - `mask`: an image mask, 1 bit a pixel padded as `gray1`, 0 where it paints (pdf.js has applied its /Decode).
 *
 * `width` and `height` are the decoded size: for an image whose soft mask is larger, pdf.js decodes it at the mask's size,
 * which `RawOp.px` (the image's own) is not (0002 §16).
 */
/**
 * pdf.js' IR of a function-based shading or a mesh (`['Mesh', shadingType, posData, colData, vertexCount, bounds, bbox,
 * background]`): `pos` x, y and `col` r, g, b, (unused) of each vertex, in shading space, every three vertices one
 * triangle (pdf.js splits a lattice and a patch into them); `bbox` the shading's /BBox in shading space, `background`
 * its /Background (0-255), each null without one.
 */
export interface RawMesh {
  shadingType: number;
  pos: ArrayLike<number>;
  col: ArrayLike<number>;
  count: number;
  bbox: [number, number, number, number] | null;
  background: [number, number, number] | null;
}

export interface ImagePixels {
  width: number;
  height: number;
  format: 'gray1' | 'rgb' | 'rgba' | 'mask';
  data: Uint8Array | Uint8ClampedArray;
}

/**
 * The pixels of what an `image` RawOp paints, or of the image mask a shade or pattern with `stencil` fills, read from its
 * page while pdf.js still holds it (before `releasePage`); null when pdf.js has none, as for an image it could not decode.
 * The op's `opIndex` names the pdf.js operator: `paintImageXObject` and `paintImageMaskXObject` name an object of the
 * page, `paintInlineImageXObject` carries its pixels, and `paintSolidColorImageMask` is one pixel that paints. So no
 * pdf.js object id is kept in a RawOp, or reaches the Scene (Global Constraints, Determinism). For an op of a tile cell,
 * `page.ops` is the cell's operator list (`TileInfo.opList`); its objects are the page's.
 */
export function imagePixels(page: Pick<PageData, 'ops' | 'obj'>, op: Pick<RawOp, 'opIndex'>): ImagePixels | null {
  const args = (page.ops.argsArray[op.opIndex] ?? []) as unknown[];
  const object = (id: unknown): unknown => {
    if (typeof id !== 'string') return undefined;
    try {
      return page.obj(id);
    } catch {
      return undefined; // not resolved, or the page was released: no pixels
    }
  };
  switch (page.ops.fnArray[op.opIndex]) {
    case OPS.paintImageXObject:
      return decodedImage(object(args[0]));
    case OPS.paintInlineImageXObject:
      return decodedImage(args[0]);
    case OPS.paintImageMaskXObject: {
      // pdf.js sends a mask's bits as an object of the page and names it in `data` (in a Type 3 glyph, the bits themselves).
      const mask = args[0] as { data?: unknown } | null | undefined;
      return maskBits(typeof mask?.data === 'string' ? object(mask.data) : mask);
    }
    case OPS.paintSolidColorImageMask:
      return { width: 1, height: 1, format: 'mask', data: new Uint8Array(1) };
    default:
      return null;
  }
}

/** pdf.js decoded image data, `{ width, height, kind, data }`; null for anything else (no data, an ImageBitmap). */
function decodedImage(value: unknown): ImagePixels | null {
  if (typeof value !== 'object' || value === null) return null;
  const { width, height, kind, data } = value as { width?: unknown; height?: unknown; kind?: unknown; data?: unknown };
  const format =
    kind === IMAGE_KIND.GRAYSCALE_1BPP ? 'gray1' : kind === IMAGE_KIND.RGB_24BPP ? 'rgb' : kind === IMAGE_KIND.RGBA_32BPP ? 'rgba' : undefined;
  const size = pixelSize(width, height);
  if (format === undefined || size === undefined || !isBytes(data)) return null;
  return { width: size[0], height: size[1], format, data };
}

/** pdf.js image mask data, `{ width, height, data }`. */
function maskBits(value: unknown): ImagePixels | null {
  if (typeof value !== 'object' || value === null) return null;
  const { width, height, data } = value as { width?: unknown; height?: unknown; data?: unknown };
  const size = pixelSize(width, height);
  if (size === undefined || !isBytes(data)) return null;
  return { width: size[0], height: size[1], format: 'mask', data };
}

function isBytes(data: unknown): data is Uint8Array | Uint8ClampedArray {
  return data instanceof Uint8Array || data instanceof Uint8ClampedArray;
}

/** pdf.js `FONT_IDENTITY_MATRIX`, used when a font object has no matrix. */
const FONT_IDENTITY_MATRIX = [0.001, 0, 0, 0.001, 0, 0];
const UNIT_SQUARE: Box = [0, 0, 1, 1];
const REPLACEMENT_CHAR = '\uFFFD';
/**
 * The operators before which MuPDF paints the text it has gathered (0002 §5 shade bbox), measured against the oracle:
 * the colours, the line state, ri, cm, W and W*, ET and marked content; gs by its keys, below; Q in `restore`. A change of
 * render mode does so too, at the next glyph. Nothing else: not Tf, Td, Tm, T*, Tc, Tw, Tz, Ts, Tr, q, i, a path, a sh, an
 * image or BT. MP, DP, cs and CS also end one, but pdf.js does not pass them on (0002 §13).
 */
const ENDS_STRETCH: ReadonlySet<number> = new Set([
  OPS.setFillRGBColor,
  OPS.setStrokeRGBColor,
  OPS.setFillColorN,
  OPS.setStrokeColorN,
  OPS.setLineWidth,
  OPS.setLineCap,
  OPS.setLineJoin,
  OPS.setMiterLimit,
  OPS.setDash,
  OPS.setRenderingIntent,
  OPS.transform,
  OPS.clip,
  OPS.eoClip,
  OPS.endText,
  OPS.beginMarkedContent,
  OPS.beginMarkedContentProps,
  OPS.endMarkedContent,
]);
/** The keys of a gs dictionary that end a stretch; the others (FL, Font, TR) do not. OP, op and OPM do too: unseen (0002 §13). */
const GS_ENDS_STRETCH: ReadonlySet<string> = new Set(['LW', 'LC', 'LJ', 'ML', 'D', 'RI', 'CA', 'ca', 'BM', 'SMask']);
/** MuPDF pads text bounds by one unit for its glyph cache (fz_bound_text); text clip boxes follow it. */
const TEXT_BOUNDS_PAD = 1;
/** pdf.js sends a blend mode as the canvas operation that draws it: the contract names it as the PDF does (0002 §17). */
const BLEND_MODES: ReadonlyMap<unknown, BlendName> = new Map<unknown, BlendName>([
  ['source-over', 'normal'],
  ['multiply', 'multiply'],
  ['screen', 'screen'],
  ['overlay', 'overlay'],
  ['darken', 'darken'],
  ['lighten', 'lighten'],
  ['color-dodge', 'colordodge'],
  ['color-burn', 'colorburn'],
  ['hard-light', 'hardlight'],
  ['soft-light', 'softlight'],
  ['difference', 'difference'],
  ['exclusion', 'exclusion'],
  ['hue', 'hue'],
  ['saturation', 'saturation'],
  ['color', 'color'],
  ['luminosity', 'luminosity'],
]);

/**
 * Interprets a page's pdf.js operator list with its own graphics-state machine (modelled on pdf.js
 * `CanvasGraphics`) and returns the paints and glyphs it draws, matching the semantics of the PyMuPDF oracle
 * (`harness/oracle/mupdf_inventory.py`). The rules are the inventory contract,
 * docs/decisions/0002-inventory-contract.md (cited below as "0002 §n"):
 *
 * - A path paint yields a `fill`, a `stroke`, or a `fill` then a `stroke`; clip-only paths and paths without any
 *   segment yield nothing. A path filled with a shading pattern yields a `shade` bounded by the clip and the path;
 *   one filled with a tiling pattern yields a `pattern`, bounded the same way, and its cell content is not
 *   reported (0002 §9 mask and pattern contents). A stroke with a shading or tiling pattern yields a `shade` or
 *   `pattern` bounded by the clip and as far as the stroke reaches (`strokeBounds`, 0002 §15 line style). Fills and
 *   strokes carry their path (0002 §14 path geometry), strokes their line style.
 * - `sh` yields a `shade` whose bbox is the current clip (0002 §5 shade bbox), narrowed to the shading's own bounds when a
 *   soft mask is in force (0002 §10); images and image masks yield `image` with their matrix, pixel size and, for a mask, its
 *   colour (0002 §16; an image mask filled with a shading or tiling pattern: a `shade` or `pattern`). Text filled or stroked with one
 *   yields its glyphs and, when its stretch ends (0002 §5), a `shade` or `pattern` for the fill and for the stroke.
 * - Every text run with a render mode other than 3 yields its glyphs once (0002 §6 glyphs), not clip-culled
 *   (0002 §7 no clip culling). Runs drawn with Tr 7 only reach MuPDF at ET, so their glyphs are reported there.
 *   Runs with Tr 3 yield `invisible` glyphs.
 * - Soft-mask contents are not page content (0002 §9 mask and pattern contents): what a soft-mask group draws goes into
 *   its `SoftMask`, which the gs that sets the mask attaches to what it masks. A soft mask touches the clip only where it
 *   bounds a `sh` (0002 §10 soft-mask area). A tiling pattern's cell is walked on its own, in cell space (`TileInfo`).
 * - The clip (every paint's `clip`, and the bbox of a shade or pattern) is narrowed by clip paths, text clips (approximated
 *   by advance boxes) and form or group bounding boxes, and restored by Q; the clips themselves are its `clipChain`. A shade
 *   or pattern bounded by a text clip, or filling text, is marked `approx`; any other paint under a text clip `clipApprox`
 *   (0002 §5 shade bbox, §17).
 * - Every op carries the transparency groups it is drawn in (their alpha and blend mode are those where the group is
 *   drawn, and the soft mask one took), its own blend mode and whether a soft mask of its own is over it (0002 §17).
 * - A shade or pattern that paints a path or a stroke carries the path and the line style too, for the Scene; one that
 *   fills text is marked `text`.
 * - Optional content pdf.js does not show paints nothing: no paint, no painted glyph. Its state still counts, its text in a
 *   clip mode still clips (as a `clip` glyph), and its Tr 3 text is still invisible text, as in MuPDF (0002 §18).
 *
 * `strict` (the default, which the oracle tests use): throws `UnsupportedOpError` for any operator it does not handle.
 * Lenient (`strict: false`, what `extractScene` uses): an operator that throws, in the page, a tile cell or a soft mask,
 * becomes an `unsupported` RawOp where it was, with the reason in fixed words, and the walk goes on with the next operator,
 * from the state the failed one left.
 */
export function walkPage(page: PageData, { strict = true }: { strict?: boolean } = {}): RawOp[] {
  return new Walker(page, strict).walk();
}

/**
 * `walkPage`'s ops, as the walk makes them: the same ops in the same order, each given once the operator that makes it
 * has been walked, so that a reader that keeps nothing of an op (the Scene's builder) holds no list of them (final
 * review F2: a page of a million paints otherwise held a million RawOps before its slide was built). A strict walk
 * throws where `walkPage` would, when the reader gets there. The page must stay loaded until the walk is read to its end.
 */
export function walkOps(page: PageData, { strict = true }: { strict?: boolean } = {}): Generator<RawOp, void, undefined> {
  return new Walker(page, strict).stream();
}

/** Why an operator failed, in fixed words: an `UnsupportedOpError`'s reason, else that the walker could not read it. */
function reasonOf(error: unknown): string {
  return error instanceof UnsupportedOpError ? error.reason : 'operator the walker could not read';
}

interface PdfjsGroup {
  matrix?: ArrayLike<number> | null;
  bbox?: ArrayLike<number> | null;
  smask?: unknown;
  isolated?: unknown;
  knockout?: unknown;
}

/** A tiling pattern's cell to walk: its operator list, its /BBox and, for PaintType 2, the colour it paints in. */
interface CellInput {
  ops: OpList;
  bbox: Box;
  colour: [number, number, number] | null;
}

/**
 * The tile cells walked on one page, shared by the page's walker and every cell walker under it: by the cell's operator
 * list (the IR object pdf.js gives every `scn` of the pattern, `TilingPattern.ops`), then by its PaintType 2 colour and
 * its /BBox. What a cell walk gives depends on nothing else (it starts from an identity CTM, the cell's clip and
 * colour, and the page's objects), so each distinct cell is walked once per page however many `scn` name it: patterns
 * nested in each other's cells cost the sum of their cells, not the product (final review F1).
 */
type CellWalks = WeakMap<OpList, Map<string, RawOp[]>>;

class Walker {
  private readonly ops: RawOp[] = [];
  /** Where `emit` puts what it makes: `ops`, or the soft mask being captured. */
  private target: RawOp[] = this.ops;
  private readonly gs: GStateStack;
  /** The operator list walked: the page's, or a tile cell's. */
  private readonly opList: OpList;
  /** The clip it starts with: the page, or the cell's /BBox. A soft mask's content starts with it too. */
  private readonly start: Box;
  private opIndex = 0;
  /** Set by W / W* with its rule, consumed by the next path operator, dropped by Q (as pdf.js does). */
  private pendingClip: 'nonzero' | 'evenodd' | null = null;
  private text: TextObject = newTextObject();
  /** Glyph boxes of the clip-mode runs (Tr 4-7) of the current BT..ET; null when there were none. */
  private textClip: Bounds | null = null;
  /** The text MuPDF has gathered and not painted yet (0002 §5 shade bbox); null when there is none. */
  private stretch: TextStretch | null = null;
  /** Glyphs of Tr 7 runs, reported at ET. */
  private deferredGlyphs: RawOp[] = [];
  /** One entry per open marked-content sequence: its MCID, and whether it is optional content pdf.js does not show. */
  private readonly marked: { mcid: number | null; hides: boolean }[] = [];
  /**
   * One entry per open beginGroup: the groups that were open before it, and for a soft-mask group the mask it captures and
   * where `emit` put its ops before.
   */
  private readonly groups: { outer: readonly GroupFrame[]; capture: { mask: SoftMask; target: RawOp[] } | null }[] = [];
  /** The transparency groups open now, outermost first; replaced, never changed, so that RawOps can share it. */
  private frames: readonly GroupFrame[] = [];
  /** The mask the last soft-mask group drew, until the gs that sets it takes it (pdf.js sends the group first). */
  private pendingMask: SoftMask | null = null;
  /** > 0 inside optional content pdf.js does not show: state is tracked, nothing is painted (0002 §18). */
  private ocHidden = 0;
  /** The form's (or the page's) base transform: pattern space is relative to it (pdf.js `baseTransform`). */
  private base: Matrix;
  private readonly bases: Matrix[] = [];
  private readonly fonts = new Map<string, FontMetrics>();
  /**
   * The cell of each colour that names a pattern (one `scn`), however often it paints. Two colours of one pattern have
   * cells of their own (their matrix may differ), which share the walked ops (`walks`).
   */
  private readonly cells = new WeakMap<Colour, TileInfo>();

  /**
   * Walks the page, or with `cell` a tile cell of it: from an identity CTM, clipped to the cell's /BBox, and in the cell's
   * colour for PaintType 2 (pdf.js `TilingPattern`). The page's objects, fonts and optional content serve both. A cell is
   * walked as strictly as its page. `walks`: the cells already walked on the page (`CellWalks`), new for the page.
   */
  constructor(
    private readonly page: PageData,
    private readonly strict: boolean,
    cell?: CellInput,
    private readonly walks: CellWalks = new WeakMap(),
  ) {
    if (cell === undefined) {
      const frame = pageFrame(page);
      this.opList = page.ops;
      this.start = [0, 0, frame.size[0], frame.size[1]];
      this.base = frame.matrix;
    } else {
      this.opList = cell.ops;
      this.start = cell.bbox;
      this.base = IDENTITY;
    }
    const state = initialState(this.base, this.start);
    const colour: Colour | null = cell?.colour ? { kind: 'rgb', rgb: cell.colour } : null;
    this.gs = new GStateStack(colour === null ? state : { ...state, fill: colour, stroke: colour });
  }

  walk(): RawOp[] {
    return [...this.stream()];
  }

  /**
   * The walk, op by op (`walkOps`): after each operator, the ops it made for the page (or the cell), which then leave
   * `ops`; the walker keeps none of them. What goes into a soft mask stays in the mask's own list.
   */
  *stream(): Generator<RawOp, void, undefined> {
    const { fnArray, argsArray } = this.opList;
    for (let i = 0; i < fnArray.length; i++) {
      this.opIndex = i;
      if (this.strict) {
        this.step(fnArray[i]!, (argsArray[i] ?? []) as unknown[]);
      } else {
        try {
          this.step(fnArray[i]!, (argsArray[i] ?? []) as unknown[]);
        } catch (error) {
          this.skip(error);
        }
      }
      if (this.ops.length > 0) yield* this.ops.splice(0);
    }
    this.opIndex = fnArray.length;
    this.flushText();
    yield* this.ops.splice(0);
  }

  /**
   * Lenient mode: the operator at `at` threw (by default the one being walked). It becomes an `unsupported` RawOp where it
   * was, in the page, the cell or the soft mask being drawn, with what the state says of it; its box is the clip in force.
   * Inside optional content pdf.js does not show, it paints nothing either way: nothing is recorded.
   */
  private skip(error: unknown, at = this.opIndex): void {
    if (this.silent) return;
    const { clip } = this.gs.current;
    const walking = this.opIndex;
    this.opIndex = at;
    try {
      this.emit({ kind: 'unsupported', bbox: clip, rgb: null, alpha: 1, evenOdd: false, unsupported: reasonOf(error) });
    } finally {
      this.opIndex = walking;
    }
  }

  private step(fn: number, args: unknown[]): void {
    if (ENDS_STRETCH.has(fn)) this.flushText();
    const gs = this.gs;
    const state = gs.current;
    switch (fn) {
      // State that does not change the inventory.
      case OPS.dependency:
      case OPS.setRenderingIntent:
      case OPS.setFlatness:
      case OPS.beginCompat:
      case OPS.endCompat:
      case OPS.markPoint:
      case OPS.markPointProps:
        return;
      case OPS.setLineWidth:
        gs.set({ lineWidth: args[0] as number });
        return;
      case OPS.setLineCap:
        gs.set({ lineCap: lineEnum(args[0] as number) });
        return;
      case OPS.setLineJoin:
        gs.set({ lineJoin: lineEnum(args[0] as number) });
        return;
      case OPS.setMiterLimit:
        gs.set({ miterLimit: args[0] as number });
        return;
      case OPS.setDash:
        gs.set({ dash: [[...(args[0] as number[])], args[1] as number] });
        return;
      case OPS.setGState:
        this.setGState(args[0] as [string, unknown][]);
        return;
      case OPS.save:
        gs.save();
        return;
      case OPS.restore:
        this.restore();
        return;
      case OPS.transform:
        gs.set({ ctm: concat(state.ctm, args as number[]) });
        return;

      // Paths and clips.
      case OPS.constructPath:
        this.constructPath(args[0] as number, (args[1] as (ArrayLike<number> | null)[])[0] ?? null);
        return;
      case OPS.clip:
        this.pendingClip = 'nonzero'; // the clip rule does not change the clip's bbox, only its ClipDef
        return;
      case OPS.eoClip:
        this.pendingClip = 'evenodd';
        return;

      // Colours.
      case OPS.setFillRGBColor:
        gs.set({ fill: { kind: 'rgb', rgb: parseHexColour(args[0]) } });
        return;
      case OPS.setStrokeRGBColor:
        gs.set({ stroke: { kind: 'rgb', rgb: parseHexColour(args[0]) } });
        return;
      case OPS.setFillColorN:
        gs.set({ fill: this.patternColour(args, 'setFillColorN') });
        return;
      case OPS.setStrokeColorN:
        gs.set({ stroke: this.patternColour(args, 'setStrokeColorN') });
        return;

      // Text.
      case OPS.beginText:
        this.text = newTextObject();
        this.textClip = null;
        this.deferredGlyphs = [];
        return;
      case OPS.endText:
        this.endText();
        return;
      case OPS.setFont:
        this.setFont(args[0] as string, args[1] as number);
        return;
      case OPS.setCharSpacing:
        gs.setText({ charSpacing: args[0] as number });
        return;
      case OPS.setWordSpacing:
        gs.setText({ wordSpacing: args[0] as number });
        return;
      case OPS.setHScale:
        gs.setText({ hScale: (args[0] as number) / 100 });
        return;
      case OPS.setLeading:
        gs.setText({ leading: args[0] as number });
        return;
      case OPS.setTextRenderingMode:
        gs.setText({ renderMode: args[0] as number });
        return;
      case OPS.setTextRise:
        gs.setText({ rise: args[0] as number });
        return;
      case OPS.setTextMatrix:
        setTextMatrix(this.text, args[0] as ArrayLike<number>);
        return;
      case OPS.moveText:
        moveText(this.text, args[0] as number, args[1] as number);
        return;
      case OPS.setLeadingMoveText:
        gs.setText({ leading: -(args[1] as number) });
        moveText(this.text, args[0] as number, args[1] as number);
        return;
      case OPS.nextLine:
        moveText(this.text, 0, -state.text.leading);
        return;
      case OPS.showText:
        this.showText(args[0] as unknown[]);
        return;

      // Shadings and images. (pdf.js only merges repeated images into the *Repeat / *Group operators when it
      // optimises for rendering; `getOperatorList` does not, so those reach the default case.)
      case OPS.shadingFill:
        this.sh(args[0] as string);
        return;
      case OPS.paintImageXObject: // [objId, width, height]: the image's own size, which its object's need not be (a soft mask)
        this.image(state.ctm, pixelSize(args[1], args[2]), this.imageRef(args[0]));
        return;
      case OPS.paintInlineImageXObject:
        this.image(state.ctm, sizeOf(args[0]), null);
        return;
      case OPS.paintImageMaskXObject:
        this.imageMask(state.ctm, sizeOf(args[0]));
        return;
      case OPS.paintSolidColorImageMask: // a 1x1 image mask that paints
        this.imageMask(state.ctm, [1, 1]);
        return;

      // Forms and transparency groups.
      case OPS.paintFormXObjectBegin: {
        const [matrix, bbox] = args as [ArrayLike<number> | null, ArrayLike<number> | null];
        gs.save();
        this.bases.push(this.base);
        if (matrix) gs.set({ ctm: concat(state.ctm, matrix) });
        this.base = gs.current.ctm;
        if (bbox) this.clipToBox(bbox, gs.current.ctm);
        return;
      }
      case OPS.paintFormXObjectEnd:
        try {
          this.restore();
        } finally {
          this.base = this.bases.pop() ?? this.base;
        }
        return;
      case OPS.beginGroup:
        this.beginGroup(args[0] as PdfjsGroup);
        return;
      case OPS.endGroup: {
        try {
          this.restore();
        } finally {
          this.endGroup();
        }
        return;
      }

      // Marked content. pdf.js also puts a form's own /OC around the form as 'OC' marked content (0002 §18).
      case OPS.beginMarkedContent:
        this.marked.push({ mcid: null, hides: false });
        return;
      case OPS.beginMarkedContentProps: {
        const [tag, props] = args as [string, unknown];
        const hides = tag === 'OC' && !this.page.isOcVisible(props);
        if (hides) this.ocHidden++;
        this.marked.push({ mcid: Number.isInteger(props) ? (props as number) : null, hides });
        return;
      }
      case OPS.endMarkedContent:
        if (this.marked.pop()?.hides) this.ocHidden--;
        return;

      default:
        throw new UnsupportedOpError(opName(fn));
    }
  }

  // -- emission ------------------------------------------------------------

  /**
   * Adds an op, with what the state says of it (0002 §17): the clip (unless the op has its own) and the clips that make it,
   * the blend mode, whether a soft mask of its own is over it and which, and the groups it is drawn in. It goes where ops go
   * now: to the page's (or the cell's), or into the soft mask being drawn.
   */
  private emit(op: Emitted, into: RawOp[] = this.target): void {
    let mcid: number | null = null;
    for (let i = this.marked.length - 1; i >= 0 && mcid === null; i--) mcid = this.marked[i]!.mcid;
    const { clip, clipApprox, clipChain, blend, masked, maskInGroup, softMask } = this.gs.current;
    const own = masked && !maskInGroup;
    const raw: RawOp = { opIndex: this.opIndex, mcid, clip, blend, masked: own, groups: this.frames, ...op };
    if (op.clip === undefined && clipApprox) raw.clipApprox = true;
    if (clipChain !== null) raw.clipChain = clipChain;
    if (own && softMask !== null) raw.softMask = softMask;
    into.push(raw);
  }

  /** Nothing is painted: optional content pdf.js does not show (0002 §18). */
  private get silent(): boolean {
    return this.ocHidden > 0;
  }

  /**
   * `approx`: the bbox comes from approximate text-clip boxes (0002 §5 shade bbox). `clip`: the clip it is painted in, which
   * holds the shape it paints, if any; so it is approximate where the bbox is. `shape`: what it paints, for the Scene: a
   * path, a stroke, text, an image mask (`stencil`), or nothing (`sh`).
   */
  private shade(
    bbox: Box,
    approx: boolean,
    shading: RawOp['shading'],
    alpha = this.gs.current.fillAlpha,
    clip = bbox,
    shape: Shape = {},
  ): void {
    if (this.silent) return;
    const op: Emitted = { kind: 'shade', bbox, rgb: null, alpha, evenOdd: false, clip, ...shape };
    if (approx) {
      op.approx = true;
      op.clipApprox = true;
    }
    if (shading !== undefined) op.shading = shading;
    this.emit(op);
  }

  /**
   * Something filled with a tiling pattern: one `pattern` paint, which carries the cell (`cellOf`); the cell is not page
   * content (0002 §9). `shape`: what it paints, as for `shade`.
   */
  private tile(bbox: Box, approx: boolean, colour: TilingColour, alpha = this.gs.current.fillAlpha, shape: Shape = {}): void {
    if (this.silent) return;
    const op: Emitted = { kind: 'pattern', bbox, rgb: null, alpha, evenOdd: false, clip: bbox, ...shape, tile: this.cellOf(colour) };
    if (approx) {
      op.approx = true;
      op.clipApprox = true;
    }
    this.emit(op);
  }

  /**
   * The cell of a tiling pattern, one for the colour that names it: what it draws does not depend on where it paints.
   * Its matrix is the base transform where the pattern was set, after the pattern's own; its ops are walked once per
   * page (`walkCell`).
   */
  private cellOf(colour: TilingColour): TileInfo {
    let cell = this.cells.get(colour);
    if (cell === undefined) {
      const { pattern, base } = colour;
      const { bbox, xStep, yStep, paintType } = pattern;
      const matrix = concat(base, pattern.matrix);
      cell = { bbox, xStep, yStep, matrix, paintType, ops: this.walkCell(pattern), opList: pattern.ops };
      this.cells.set(colour, cell);
    }
    return cell;
  }

  /**
   * What a pattern's cell draws, walked the first time the page meets this cell (`CellWalks`), else as walked then: the
   * same RawOps, which the cells that share them only read. A walk that throws (strict mode) is not kept.
   */
  private walkCell(pattern: TilingPattern): RawOp[] {
    let walked = this.walks.get(pattern.ops);
    if (walked === undefined) {
      walked = new Map();
      this.walks.set(pattern.ops, walked);
    }
    const key = `${pattern.colour?.join(' ') ?? 'own colours'} / ${pattern.bbox.join(' ')}`;
    let ops = walked.get(key);
    if (ops === undefined) {
      const cell: CellInput = { ops: pattern.ops, bbox: pattern.bbox, colour: pattern.colour };
      ops = new Walker(this.page, this.strict, cell, this.walks).walk();
      walked.set(key, ops);
    }
    return ops;
  }

  /** An image: its box is the unit square under the CTM. A stencil has the colour it paints with (0002 §16). */
  private image(
    m: Matrix,
    px: [number, number] | undefined,
    imageRef: Ref | null,
    stencil: [number, number, number] | null = null,
  ): void {
    if (this.silent) return;
    this.emit({
      kind: 'image',
      bbox: transformBox(m, UNIT_SQUARE),
      rgb: stencil,
      alpha: this.gs.current.fillAlpha,
      evenOdd: false,
      imageRef,
      ctm: m,
      stencil: stencil !== null,
      ...(px === undefined ? {} : { px }),
    });
  }

  /**
   * An image mask paints the fill colour through the mask: MuPDF reports a solid one as an image. One filled with a
   * pattern is a shade or pattern marked `stencil`.
   */
  private imageMask(m: Matrix, px: [number, number] | undefined): void {
    const { fill, clip, clipApprox } = this.gs.current;
    const bbox = intersect(clip, transformBox(m, UNIT_SQUARE));
    if (fill.kind === 'rgb') this.image(m, px, null, fill.rgb);
    else if (fill.kind === 'shading') this.shade(bbox, clipApprox, this.patternShading(fill), undefined, undefined, { stencil: true });
    else this.tile(bbox, clipApprox, fill, undefined, { stencil: true });
  }

  // -- state ---------------------------------------------------------------

  /** Q, and a form's or a group's end: the text is painted first, under the state it was shown in; the state goes back anyway. */
  private restore(): void {
    try {
      this.flushText();
    } finally {
      this.gs.restore();
      this.pendingClip = null;
    }
  }

  /** endGroup, after its restore: the group's frame is closed, and a soft mask's group gives its mask to the gs that sets it. */
  private endGroup(): void {
    const group = this.groups.pop();
    if (group === undefined) return;
    if (group.capture !== null) {
      // The mask is drawn: the gs that sets it comes next (`setGState`).
      this.pendingMask = group.capture.mask;
      this.target = group.capture.target;
    }
    this.frames = group.outer;
  }

  /** Narrows the clip to `box` and adds `def`, the clip that does so, to the chain; a text clip makes the clip approximate. */
  private narrowClip(box: Box, def: ClipDef): void {
    const { clip, clipChain } = this.gs.current;
    const change = { clip: intersect(clip, box), clipChain: { def, parent: clipChain } };
    this.gs.set(def.kind === 'text' ? { ...change, clipApprox: true } : change);
  }

  /**
   * A form's or a transparency group's /BBox clips what it draws (0002 §5): a `box` where the CTM `m` keeps the axes, else
   * the `path` of its four corners, in the order `re` would give them.
   */
  private clipToBox(rect: ArrayLike<number>, m: Matrix): void {
    const bbox = transformBox(m, rect);
    if ((m[1] === 0 && m[2] === 0) || (m[0] === 0 && m[3] === 0)) {
      this.narrowClip(bbox, { kind: 'box', bbox });
      return;
    }
    const [x0, y0, x1, y1] = [rect[0]!, rect[1]!, rect[2]!, rect[3]!];
    const geom: PathSeg[] = [
      ['M', ...applyPoint(m, x0, y0)],
      ['L', ...applyPoint(m, x1, y0)],
      ['L', ...applyPoint(m, x1, y1)],
      ['L', ...applyPoint(m, x0, y1)],
      ['Z'],
    ];
    this.narrowClip(bbox, { kind: 'path', geom, rule: 'nonzero', bbox });
  }

  private setGState(entries: [string, unknown][]): void {
    if (entries.some(([key]) => GS_ENDS_STRETCH.has(key))) this.flushText();
    for (const [key, value] of entries) {
      switch (key) {
        case 'LW':
          this.gs.set({ lineWidth: value as number });
          break;
        case 'LC': // an integer only, unlike the operator: MuPDF ignores any other number here
          if (Number.isInteger(value)) this.gs.set({ lineCap: lineEnum(value as number) });
          break;
        case 'LJ':
          if (Number.isInteger(value)) this.gs.set({ lineJoin: lineEnum(value as number) });
          break;
        case 'ML':
          this.gs.set({ miterLimit: value as number });
          break;
        case 'D': {
          const [array, phase] = value as [number[], number];
          this.gs.set({ dash: [[...array], phase] });
          break;
        }
        case 'Font':
          this.setFont(...(value as [string, number]));
          break;
        case 'CA':
          this.gs.set({ strokeAlpha: value as number });
          break;
        case 'ca':
          this.gs.set({ fillAlpha: value as number });
          break;
        // SMask: pdf.js passes true for a dictionary, after the mask's group, which `beginGroup` captured; false for /None.
        // MuPDF clips each masked object to that object's own bounds and pops the clip right after it, which narrows no
        // bbox, except for a `sh` whose shading itself is bounded (0002 §10): `masked` tells `sh`. A mask pdf.js drew no
        // group for (its /G is no transparency group) is still a mask: one that draws nothing.
        case 'SMask': {
          const drawn: SoftMask = this.pendingMask ?? { subtype: 'luminosity', backdrop: null, ops: [], opList: this.opList };
          const softMask = value === false ? null : drawn;
          this.pendingMask = null;
          this.gs.set({ masked: softMask !== null, maskInGroup: false, softMask });
          break;
        }
        case 'BM': {
          const blend = BLEND_MODES.get(value);
          if (blend === undefined) throw new UnsupportedOpError('setGState', `blend mode ${String(value)}`, 'blend mode the walker does not model');
          this.gs.set({ blend });
          break;
        }
        // Not part of the inventory.
        case 'RI':
        case 'FL':
        case 'TR':
          break;
        default:
          throw new UnsupportedOpError('setGState', `key ${key}`, 'graphics state key the walker does not model');
      }
    }
  }

  /** Tf (also via a gstate /Font): the font is keyed by the id `setFont` names; a negative size flips the glyphs. */
  private setFont(id: string, size: number): void {
    this.gs.setText({ fontId: id, fontSize: Math.abs(size), fontDirection: size < 0 ? -1 : 1 });
  }

  private beginGroup(group: PdfjsGroup): void {
    const smask = group.smask as { subtype?: unknown; backdrop?: unknown } | null | undefined;
    if (smask != null) this.flushText(); // pdf.js puts the mask's group where the page says gs, which ends a stretch
    this.gs.save();
    const state = this.gs.current;
    const m = group.matrix ? concat(state.ctm, group.matrix) : state.ctm;
    if (smask != null) {
      // A soft mask's group: what it draws is the mask, captured until its endGroup and not page content (0002 §9). It is
      // drawn as a group of its own (ISO 32000-2 11.6.5.2): at alpha 1, in normal, under no soft mask and none of the clips
      // of the page, only its /BBox. pdf.js reads every subtype but Luminosity as Alpha.
      const mask: SoftMask = {
        subtype: smask.subtype === 'Luminosity' ? 'luminosity' : 'alpha',
        backdrop: hexRgb(smask.backdrop),
        ops: [],
        opList: this.opList,
      };
      this.groups.push({ outer: this.frames, capture: { mask, target: this.target } });
      this.frames = [];
      this.target = mask.ops;
      const fresh = { fillAlpha: 1, strokeAlpha: 1, blend: 'normal' as const, masked: false, maskInGroup: false, softMask: null };
      this.gs.set({ ...fresh, clip: this.start, clipApprox: false, clipChain: null });
      if (group.bbox) this.clipToBox(group.bbox, m);
      return;
    }
    // A transparency group's content starts at alpha 1 and blend mode normal, and the soft mask in force is the group's:
    // all three apply to the group as a whole, and not to what is inside it (0002 §17).
    const takes = state.masked && !state.maskInGroup;
    const frame: GroupFrame = {
      alpha: state.fillAlpha,
      blend: state.blend,
      isolated: group.isolated === true,
      knockout: group.knockout === true,
      bbox: group.bbox ? transformBox(m, group.bbox) : null,
      masked: takes,
      mask: takes ? state.softMask : null,
    };
    this.groups.push({ outer: this.frames, capture: null });
    this.frames = [...this.frames, frame];
    this.gs.set({ fillAlpha: 1, strokeAlpha: 1, blend: 'normal', maskInGroup: state.masked });
    if (group.bbox) this.clipToBox(group.bbox, m);
  }

  private patternColour(args: unknown[], op: string): Colour {
    if (args[0] === 'TilingPattern') {
      const pattern = tilingPattern(args);
      if (typeof pattern === 'string') throw new UnsupportedOpError(op, pattern, 'tiling pattern the walker cannot read');
      return { kind: 'tiling', pattern, base: this.base };
    }
    if (args[0] === 'Shading') {
      const matrix = args[2] as ArrayLike<number> | null;
      return { kind: 'shading', id: args[1] as string, matrix: matrix ? toMatrix(matrix) : null, base: this.base };
    }
    throw new UnsupportedOpError(op, `pattern ${String(args[0])}`, 'pattern the walker does not model');
  }

  // -- paths ---------------------------------------------------------------

  private constructPath(op: number, data: ArrayLike<number> | null): void {
    // pdf.js has already put the close of s, b and b* in the buffer.
    const { ctm } = this.gs.current;
    const segs = data === null ? [] : segmentsOf(data, ctm);
    const box = boundsOf(segs, ctm);
    switch (op) {
      case OPS.fill:
        this.fillPath(segs, box, false);
        break;
      case OPS.eoFill:
        this.fillPath(segs, box, true);
        break;
      case OPS.stroke:
      case OPS.closeStroke:
        this.strokePath(segs, box);
        break;
      case OPS.fillStroke:
      case OPS.closeFillStroke:
        this.fillPath(segs, box, false);
        this.strokePath(segs, box);
        break;
      case OPS.eoFillStroke:
      case OPS.closeEOFillStroke:
        this.fillPath(segs, box, true);
        this.strokePath(segs, box);
        break;
      case OPS.endPath:
        break;
      default:
        throw new UnsupportedOpError(`constructPath(${opName(op)})`, undefined, 'path paint the walker does not model');
    }
    if (this.pendingClip !== null) {
      // A clip path without segments clips everything away.
      const bbox = box ?? [0, 0, 0, 0];
      this.narrowClip(bbox, { kind: 'path', geom: segs, rule: this.pendingClip, bbox });
      this.pendingClip = null;
    }
  }

  private fillPath(path: PathSeg[], box: Box | null, evenOdd: boolean): void {
    const { fill, fillAlpha, clip, clipApprox } = this.gs.current;
    if (box === null || this.silent) return;
    if (fill.kind === 'rgb') {
      this.emit({ kind: 'fill', bbox: box, rgb: fill.rgb, alpha: fillAlpha, evenOdd, path });
      return;
    }
    const shape: Shape = { path, pathBox: box, evenOdd };
    if (fill.kind === 'shading') this.shade(intersect(clip, box), clipApprox, this.patternShading(fill), undefined, undefined, shape);
    else this.tile(intersect(clip, box), clipApprox, fill, undefined, shape);
  }

  private strokePath(path: PathSeg[], box: Box | null): void {
    const { stroke, strokeAlpha, ctm, clip, clipApprox } = this.gs.current;
    if (box === null || this.silent) return;
    const line = this.lineInv();
    if (stroke.kind === 'rgb') {
      this.emit({ kind: 'stroke', bbox: box, rgb: stroke.rgb, alpha: strokeAlpha, evenOdd: false, path, line, lineCtm: ctm });
      return;
    }
    // MuPDF clips to the stroke-expanded outline and paints the pattern through it (0002 §15 line style).
    const bbox = intersect(clip, strokeBounds(box, line, ctm, axisAligned(path, ctm)));
    const shape: Shape = { path, pathBox: box, line, lineCtm: ctm };
    if (stroke.kind === 'shading') this.shade(bbox, clipApprox, this.patternShading(stroke), strokeAlpha, undefined, shape);
    else this.tile(bbox, clipApprox, stroke, strokeAlpha, shape);
  }

  /** The current line style in the slide frame (0002 §15 line style). */
  private lineInv(): LineInv {
    const { lineWidth, lineCap, lineJoin, miterLimit, dash, ctm } = this.gs.current;
    const scale = lineScale(ctm);
    return {
      w: lineWidth * scale,
      cap: lineCap,
      join: lineJoin,
      miter: miterLimit,
      dash: dash[0].map((v) => v * scale),
      phase: dash[1] * scale,
    };
  }

  // -- shadings and images -------------------------------------------------

  /**
   * `sh`: the shade's box is the current clip (0002 §5). Under a soft mask MuPDF has clipped to the shading's own bounds
   * first, when it has any (0002 §10).
   */
  private sh(id: string): void {
    const { clip, clipApprox, ctm, masked, maskInGroup } = this.gs.current;
    const bounds = masked && !maskInGroup ? this.shadingBounds(id, ctm) : null;
    // Its clip is the clip: the area of its own soft mask is no part of it (0002 §17).
    this.shade(bounds === null ? clip : intersect(clip, bounds), clipApprox, this.shadingInfo(id, ctm), undefined, clip);
  }

  /**
   * The bounds a shading has of its own in the slide frame, as `fz_bound_shade` gives them, or null when it has none: an
   * axial or radial shading is bounded by its /BBox, a mesh and a function-based shading (which pdf.js calls a mesh of type
   * 1) by their vertices or their domain, and by their /BBox too. Both are boxes in shading space, and the box of the
   * result is that of the transformed corners (0002 §10).
   */
  private shadingBounds(id: string, ctm: Matrix): Box | null {
    const ir = this.obj(id);
    if (!Array.isArray(ir)) return null;
    const rect = (v: unknown): Box | null =>
      Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n))
        ? [v[0] as number, v[1] as number, v[2] as number, v[3] as number]
        : null;
    let box: Box | null;
    if (ir[0] === 'RadialAxial') {
      box = rect(ir[2]);
    } else if (ir[0] === 'Mesh') {
      const [bounds, bbox] = [rect(ir[5]), rect(ir[6])];
      if (bounds !== null && bbox !== null) {
        const [x0, y0] = [Math.max(bounds[0], bbox[0]), Math.max(bounds[1], bbox[1])];
        const [x1, y1] = [Math.min(bounds[2], bbox[2]), Math.min(bounds[3], bbox[3])];
        if (x1 < x0 || y1 < y0) return [0, 0, 0, 0]; // the two do not meet: nothing is left
        box = [x0, y0, x1, y1];
      } else {
        box = bounds ?? bbox;
      }
    } else {
      return null;
    }
    return box === null ? null : transformBox(ctm, box);
  }

  private obj(id: unknown): unknown {
    if (typeof id !== 'string') return undefined;
    try {
      return this.page.obj(id);
    } catch {
      return undefined;
    }
  }

  private imageRef(id: unknown): Ref | null {
    const image = this.obj(id);
    return typeof image === 'object' && image !== null ? parsePdfjsRef((image as { ref?: unknown }).ref) : null;
  }

  private patternShading(colour: Extract<Colour, { kind: 'shading' }>): RawOp['shading'] {
    return this.shadingInfo(colour.id, colour.matrix ? concat(colour.base, colour.matrix) : colour.base);
  }

  /**
   * The pdf.js shading IR `['RadialAxial', type, bbox, colorStops, p0, p1, r0, r1]`, or `['Mesh', shadingType, ...]` of which
   * a function-based shading is type 1; anything else gives undefined.
   */
  private shadingInfo(id: string, ctm: Matrix): RawOp['shading'] {
    const ir = this.obj(id);
    if (Array.isArray(ir) && ir[0] === 'Mesh') {
      const mesh = rawMesh(ir);
      return { type: ir[1] === 1 ? 'function' : 'mesh', ctm, ...(mesh === null ? {} : { mesh }) };
    }
    if (!Array.isArray(ir) || ir[0] !== 'RadialAxial') return undefined;
    type Ir = [string, 'axial' | 'radial', unknown, [number, string][], number[], number[], number | null, number | null];
    const [, type, , colorStops, p0, p1, r0, r1] = ir as Ir;
    return {
      type,
      colorStops: colorStops.map(([t, c]) => [t, c]),
      p0: [p0[0]!, p0[1]!],
      p1: [p1[0]!, p1[1]!],
      r0: r0 ?? 0,
      r1: r1 ?? 0,
      ctm,
    };
  }

  // -- text ----------------------------------------------------------------

  /**
   * What the walker reads from the font a `setFont` id names (keyed by that id, not by `loadedName`). pdf.js may
   * have no object for a font that failed to load, and gives a font without an embedded program no matrix and
   * NaN metrics: those fall back to the identity font matrix and zero ascent/descent.
   */
  private fontMetrics(id: string | null): FontMetrics {
    const key = id ?? '';
    let metrics = this.fonts.get(key);
    if (metrics === undefined) {
      let font: Partial<PdfjsFont> | null = null;
      if (id !== null) {
        try {
          const value: unknown = this.page.font(id);
          if (typeof value === 'object' && value !== null) font = value as Partial<PdfjsFont>;
        } catch {
          // not resolved: treated like a font that failed to load
        }
      }
      const matrix = font?.fontMatrix as ArrayLike<number> | null | undefined;
      metrics = {
        fontMatrix:
          matrix != null && matrix.length === 6 && Array.from(matrix).every(Number.isFinite)
            ? Array.from(matrix)
            : FONT_IDENTITY_MATRIX,
        ascent: finiteOr0(font?.ascent),
        descent: finiteOr0(font?.descent),
        vertical: font?.vertical === true,
        defaultVMetrics: font?.defaultVMetrics ?? null,
        name: typeof font?.name === 'string' ? font.name : '',
        type3: font?.isType3Font === true,
        missingFile: font?.missingFile !== false,
      };
      this.fonts.set(key, metrics);
    }
    return metrics;
  }

  private showText(items: unknown[]): void {
    const { text: params, ctm, fill, stroke, fillAlpha, strokeAlpha } = this.gs.current;
    const font = this.fontMetrics(params.fontId);
    const run = layoutRun(this.text, items, params, font.fontMatrix, font.vertical ? font : null);
    const m = concat(ctm, this.text.tm); // text space -> slide frame
    this.text.x += run.advance;
    this.text.y += run.advanceY;
    if (run.glyphs.length === 0) return;

    const shown = params.renderMode;
    let mode = font.type3 ? (shown === 3 || shown === 7 ? 3 : 0) : shown; // 0002 §6: the mode has no effect on Type 3
    if (this.ocHidden > 0) {
      // Hidden optional content paints nothing (0002 §18). As in MuPDF, its Tr 3 text is still invisible text, and a clip
      // mode still clips: a clip glyph, at ET. The rest is not reported.
      if (mode < 3) return;
      if (mode > 3) mode = 7;
    }
    const fills = mode === 0 || mode === 2 || mode === 4 || mode === 6;
    const strokes = mode === 1 || mode === 2 || mode === 5 || mode === 6;
    const solid = (colour: Colour) => (colour.kind === 'rgb' ? colour.rgb : null);

    // sqrt, not hypot: correctly rounded in every engine (Global Constraints, Determinism).
    const size = params.fontSize * Math.sqrt(m[2] * m[2] + m[3] * m[3]);
    const ascent = font.ascent * params.fontSize;
    const descent = font.descent * params.fontSize;
    const rgb = fills ? solid(fill) : strokes ? solid(stroke) : null;
    const alpha = fills ? fillAlpha : strokes ? strokeAlpha : 1;
    const paint: Glyph['paint'] = fills && strokes ? 'fillStroke' : fills ? 'fill' : strokes ? 'stroke' : 'clip';
    const shared = {
      size,
      fontId: params.fontId ?? '',
      font: font.name,
      paint,
      wmode: font.vertical ? (1 as const) : (0 as const),
      ...(font.type3 ? { type3: true as const } : {}),
    };
    // For the Scene: one object the run's glyphs share. The stroke's line width is in user space, as a path's.
    const data: RunData = {
      matrix: m,
      charSpacing: params.charSpacing,
      hScale: params.hScale,
      rise: params.rise,
      fill: fills ? this.runFill(fill, fillAlpha) : null,
      stroke: strokes ? { rgb: solid(stroke), alpha: strokeAlpha, w: this.lineInv().w } : null,
      missingFile: font.missingFile,
    };
    const xScale = Math.sqrt(m[0] * m[0] + m[1] * m[1]); // sqrt, not hypot: correctly rounded in every engine
    const into = mode === 7 ? this.deferredGlyphs : this.target;
    for (const g of run.glyphs) {
      // MuPDF compares the mode with the one it gathers text in at every glyph. It gathers Type 3 text in the mode
      // above, so anything but Tr 0 and 3 paints it glyph by glyph.
      if (this.stretch !== null && this.stretch.mode !== shown) this.flushText();
      const bbox = transformBox(m, [g.x, g.y + descent, g.x + g.advance, g.y + ascent]);
      (this.stretch ??= { mode, bounds: new Bounds(), opIndex: this.opIndex }).bounds.addBox(bbox);
      if (mode >= 4) (this.textClip ??= new Bounds()).addBox(bbox);
      const [x, y] = applyPoint(m, g.x, g.y);
      // One glyph per code point, all at the glyph's origin (as MuPDF reports one-to-many ToUnicode mappings). A
      // ToUnicode entry of U+0000 says the glyph has none: U+FFFD, as in MuPDF (0002 §1 types).
      const chars = g.unicode === '' ? [''] : g.unicode === '\0' ? [REPLACEMENT_CHAR] : Array.from(g.unicode);
      const code = chars.length === 1 && g.code !== null ? { code: g.code } : {};
      chars.forEach((u, i) => {
        const glyph = { u, x, y, adv: i === 0 ? g.advance * xScale : 0, ...shared, ...code };
        if (mode === 3) this.emit({ kind: 'invisible', bbox, rgb: null, alpha: 1, evenOdd: false, glyph, run: data });
        else this.emit({ kind: 'glyph', bbox, rgb, alpha, evenOdd: false, glyph, run: data }, into);
      });
    }
  }

  /** What a text run fills with (`RunData.fill`): a pattern's shading or cell as a `shade` or `pattern` would carry it. */
  private runFill(colour: Colour, alpha: number): RunFill {
    if (colour.kind === 'rgb') return { kind: 'rgb', rgb: colour.rgb, alpha };
    if (colour.kind === 'shading') return { kind: 'shading', shading: this.patternShading(colour), alpha };
    return { kind: 'tile', tile: this.cellOf(colour), alpha };
  }

  /**
   * The current stretch of text ends: MuPDF paints it now, with one shade or pattern for the fill and one for the stroke
   * when those are patterns (0002 §5 shade bbox). Every state change that ends a stretch calls this before it changes
   * anything, so the state is the one the text was shown in. MuPDF clips to the text bounds and paints the pattern through
   * them. The walker's text bounds are advance boxes, so the bbox is approximate.
   */
  private flushText(): void {
    const stretch = this.stretch;
    if (stretch === null) return;
    this.stretch = null;
    if (this.strict) {
      this.paintStretch(stretch);
      return;
    }
    // Lenient: a paint that throws is skipped, at the op that showed the text, and whatever ended the stretch goes on.
    try {
      this.paintStretch(stretch);
    } catch (error) {
      this.skip(error, stretch.opIndex);
    }
  }

  /** The shade or pattern of a stretch's fill, and of its stroke, when those are patterns (`flushText`). */
  private paintStretch(stretch: TextStretch): void {
    const box = stretch.bounds.box();
    if (box === null) return;
    const { fill, stroke, strokeAlpha, clip, ctm } = this.gs.current;
    const { mode } = stretch;
    const text: Shape = { text: true };
    if ((mode === 0 || mode === 2 || mode === 4 || mode === 6) && fill.kind !== 'rgb') {
      const bbox = intersect(clip, padded(box));
      if (fill.kind === 'shading') this.shade(bbox, true, this.patternShading(fill), undefined, undefined, text);
      else this.tile(bbox, true, fill, undefined, text);
    }
    // ... and so for a stroke: the text bounds grown as a stroke's (fz_bound_text), as approximate as they were.
    if ((mode === 1 || mode === 2 || mode === 5 || mode === 6) && stroke.kind !== 'rgb') {
      const bbox = intersect(clip, strokeBounds(padded(box), this.lineInv(), ctm));
      if (stroke.kind === 'shading') this.shade(bbox, true, this.patternShading(stroke), strokeAlpha, undefined, text);
      else this.tile(bbox, true, stroke, strokeAlpha, text);
    }
  }

  private endText(): void {
    if (this.textClip !== null) {
      const box = this.textClip.box();
      const bbox = box === null ? ([0, 0, 0, 0] as Box) : padded(box);
      this.narrowClip(bbox, { kind: 'text', bbox, approx: true });
    }
    this.target.push(...this.deferredGlyphs);
    this.textClip = null;
    this.deferredGlyphs = [];
  }
}

interface FontMetrics {
  fontMatrix: readonly number[];
  /** In text space units per unit of font size (pdf.js `ascent` / `descent`). */
  ascent: number;
  descent: number;
  vertical: boolean;
  /** `[w1y, vx, vy]`, for a glyph of a vertical font without its own. */
  defaultVMetrics: ArrayLike<number> | null;
  /** pdf.js `font.name`, subset tag included; empty for a font that failed to load. */
  name: string;
  type3: boolean;
  /** pdf.js `font.missingFile`: it has no program of the font (not embedded, or unreadable); true when it says nothing. */
  missingFile: boolean;
}

/**
 * Text gathered and not painted yet: `mode` is the render mode MuPDF gathers it in (0002 §5 shade bbox); `opIndex` the
 * op that showed its first glyph.
 */
interface TextStretch {
  mode: number;
  bounds: Bounds;
  opIndex: number;
}

/** `[width, height]` when both are positive integers. */
function pixelSize(width: unknown, height: unknown): [number, number] | undefined {
  return Number.isInteger(width) && Number.isInteger(height) && (width as number) > 0 && (height as number) > 0
    ? [width as number, height as number]
    : undefined;
}

/** The size of what pdf.js sent as an image (inline image data, an image mask): its `width` and `height`. */
function sizeOf(data: unknown): [number, number] | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { width, height } = data as { width?: unknown; height?: unknown };
  return pixelSize(width, height);
}

function finiteOr0(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function padded(box: Box): Box {
  return [box[0] - TEXT_BOUNDS_PAD, box[1] - TEXT_BOUNDS_PAD, box[2] + TEXT_BOUNDS_PAD, box[3] + TEXT_BOUNDS_PAD];
}

/** J and j take 0, 1 or 2: as MuPDF, the fraction is cut off and anything else clamped (0002 §15 line style). */
function lineEnum(value: number): 0 | 1 | 2 {
  return value >= 2 ? 2 : value >= 1 ? 1 : 0;
}

/** pdf.js sends every solid colour as a CSS hex string, `#rrggbb`. */
function parseHexColour(value: unknown): [number, number, number] {
  const rgb = hexRgb(value);
  if (rgb === null) throw new UnsupportedOpError('setRGBColor', `colour ${String(value)}`, 'colour the walker cannot read');
  return rgb;
}

/**
 * The triangles of pdf.js' mesh IR (`RawMesh`), or null when it has none to read: a vertex count that is not a positive
 * multiple of 3, or arrays too short for it. A /BBox or /Background that is not four or three finite numbers is none. A
 * triangle with a coordinate that is not finite is dropped (fix round 1), so the Scene never holds one; null when none is
 * left.
 */
export function rawMesh(ir: readonly unknown[]): RawMesh | null {
  const [, shadingType, pos, col, count, , bbox, background] = ir;
  const numbers = (v: unknown): v is ArrayLike<number> =>
    (ArrayBuffer.isView(v) && !(v instanceof DataView)) || (Array.isArray(v) && v.every((n) => typeof n === 'number'));
  if (typeof shadingType !== 'number' || !numbers(pos) || !numbers(col) || typeof count !== 'number') return null;
  if (!Number.isInteger(count) || count <= 0 || count % 3 !== 0 || pos.length < count * 2 || col.length < count * 4) return null;
  const finite = (v: unknown, n: number): boolean =>
    (Array.isArray(v) || ArrayBuffer.isView(v)) && (v as ArrayLike<unknown>).length === n && Array.from(v as ArrayLike<unknown>).every((x) => typeof x === 'number' && Number.isFinite(x));
  let [kept, keptCol, kept3] = [pos, col, count];
  const whole = (t: number): boolean => {
    for (let i = t * 6; i < t * 6 + 6; i++) if (!Number.isFinite(pos[i])) return false;
    return true;
  };
  let all = true;
  for (let t = 0; t < count / 3 && all; t++) all = whole(t);
  if (!all) {
    const [p, c] = [new Float64Array(count * 2), new Uint8Array(count * 4)];
    let at = 0;
    for (let t = 0; t < count / 3; t++) {
      if (!whole(t)) continue;
      for (let i = 0; i < 6; i++) p[at * 2 + i] = pos[t * 6 + i]!;
      for (let i = 0; i < 12; i++) c[at * 4 + i] = col[t * 12 + i]!;
      at += 3;
    }
    if (at === 0) return null;
    [kept, keptCol, kept3] = [p.subarray(0, at * 2), c.subarray(0, at * 4), at];
  }
  return {
    shadingType,
    pos: kept,
    col: keptCol,
    count: kept3,
    bbox: finite(bbox, 4) ? (Array.from(bbox as ArrayLike<number>) as [number, number, number, number]) : null,
    background: finite(background, 3) ? (Array.from(background as ArrayLike<number>) as [number, number, number]) : null,
  };
}
