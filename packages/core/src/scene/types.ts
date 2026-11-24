import type { Box, PathSeg } from '../extract/inventory';

/**
 * Scene v1: a versioned, engine-neutral description of a converted deck, which the passes and the PPTX writer read.
 * `scene.schema.json` beside this file is its JSON Schema. Every coordinate is in the slide frame of the inventory
 * contract (docs/decisions/0002-inventory-contract.md §1: pt, origin top left, y down). Numbers are rounded when the
 * Scene is built (ruling M2-R13): slide-frame lengths to 3 decimals, unitless values to 6.
 *
 * Parts marked with a task number are filled by that task of M2; until then they are empty or absent.
 */

export const SCENE_SCHEMA = 'deckback.scene/1';

/** 0-255 integers, sRGB. */
export type Rgb = [r: number, g: number, b: number];

export interface SceneBundle {
  scene: SceneDeck;
  /** Key: the SHA-256 of the bytes, lower-case hex. */
  media: Map<string, Uint8Array>;
}

export interface SceneDeck {
  schema: typeof SCENE_SCHEMA;
  /**
   * Task 11. `producer`, `creator`: the document information's /Producer and /Creator as pdf.js reads them, else null.
   * `tagged`: a page converted (its slide not `failed`) has a structure tree. `encrypted`: the file is encrypted (the raw
   * reader cannot read it): font names are pdf.js' only and no JPEG passes through (ruling M2-R6). `pageCount`: the
   * document's pages, all of them, whichever were converted.
   */
  source: { producer: string | null; creator: string | null; tagged: boolean; encrypted: boolean; pageCount: number };
  slides: SceneSlide[];
  /** Task 9: keyed by `FontInfo.key`, in the order the deck first uses them. */
  fonts: Record<string, FontInfo>;
  /** Task 10; keyed by `MediaInfo.hash`. */
  media: Record<string, MediaInfo>;
}

export interface SceneSlide {
  /** 0-based: the index of its page in the PDF. */
  index: number;
  /** [0, 0] when the page could not be loaded (`failed: 'page-unreadable'`). */
  sizePt: [w: number, h: number];
  /** In paint order; the page's links (hotspots) last, in /Annots order. */
  elements: Element[];
  /**
   * The clips its elements are drawn in: clip paths, text clips, and the /BBox of a form or transparency group. Ids `c1`,
   * `c2`, ... in the order the elements first use them. A soft mask and a tile cell have clips of their own.
   */
  clips: Record<string, ClipDef>;
  /**
   * The soft masks its elements are drawn under, those of masks and tile cells too: ids `m1`, `m2`, ... in the order they
   * are first used. Mask data, never page content (0002 §9).
   */
  masks: Record<string, MaskDef>;
  /** Task 11: what the Scene could not model on the slide, each with its fallback element, in the order they were met. */
  notes: Note[];
  /**
   * Task 11: why the slide has nothing at all, else null. `page-unreadable`: pdf.js could not load the page or list its
   * operators. `slide-unbuildable`: the walker or the Scene builder failed on the page as a whole, in lenient mode (one that
   * a fallback element could not stand in for). `deck-too-complex` (M3, `convert` only: ruling M3-R41): the deck had
   * already gone past its weight budget (`DECK_WEIGHT_BUDGET` in weight.ts), so the page was not converted; its size is
   * [0, 0], as it was not loaded. The other slides are not touched by it.
   */
  failed: string | null;
}

export type Element = ShapeEl | TextLineEl | PictureEl | FallbackEl | HotspotEl;

/** A PDF blend mode, lower case and without hyphens, as the contract names it (0002 §17). */
export type BlendName =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'colordodge'
  | 'colorburn'
  | 'hardlight'
  | 'softlight'
  | 'difference'
  | 'exclusion'
  | 'hue'
  | 'saturation'
  | 'color'
  | 'luminosity';

export interface ElementBase {
  /**
   * `p<page+1>:z<opIndex>`, and `:<n>` (1, 2, ...) for each further element of the same op (ruling M1-R50). In a tile cell:
   * the id of the element the cell fills, `/z<opIndex>` in the cell's operator list, and `:<n>` as above. A hotspot, which
   * no op paints: `p<page+1>:a<n>`, n its place among the page's links from 0.
   */
  id: string;
  /**
   * `opIndex`: of the operator list that holds it, the page's or a tile cell's (none for a hotspot). `mcid`: its innermost
   * marked-content id. `struct`: on a tagged page, the roles of the structure elements above that id, outermost first
   * (`joinStructure`, e.g. `['Sect', 'L', 'LI', 'LBody', 'Span']`); null without an id, for one the structure tree does not
   * name, and for what a soft mask or a tile cell draws, whose marked content is not the page's.
   */
  provenance: { opIndex: number[]; mcid: number | null; struct: string[] | null };
  /** The clips it is drawn in: ids in the `clips` of the slide, mask or tile cell that holds it, outermost first. */
  clip: string[];
  /**
   * The box of the clip in force when it is painted: the inventory's `clip` (0002 §17). For a shade or pattern that paints a
   * shape, that shape is in it, as MuPDF clips to it before it paints (ruling M2-R12): then it is the inventory's `bbox`.
   */
  clipBox: Box;
  /** The transparency groups it is drawn in, outermost first. */
  groups: GroupRef[];
  /**
   * The innermost soft mask in force: its own, else the one its innermost group took (ruling M2-R14). An id in the slide's
   * `masks`; so a soft mask is over it (the inventory's `masked`, ruling M2-R11) when this is not null.
   */
  mask: string | null;
  /** Its own blend mode (0002 §17); its groups have their own. */
  blend: BlendName;
}

/**
 * How a shape is filled or its line painted. `alpha` is the fill alpha (ca), for a line the stroke alpha (CA).
 *
 * `linear` and `radial` are an axial and a radial shading (ISO 32000-2 8.7.4.5.3, 8.7.4.5.4): `p0`, `p1`, `r0` and `r1`
 * stay in shading space, and `matrix` maps shading space to the slide frame, in a tile cell to cell space (for `sh` the
 * CTM, for a shading pattern the pattern matrix after the base transform), because a matrix that scales the axes unequally
 * or skews does not keep the axis perpendicular to the bands. Shading-space numbers are kept to 6 decimals, as their unit
 * is not pt. `stops` are pdf.js' samples of the shading's function, `t` from 0 at `p0` to 1 at `p1`; `extend` says whether
 * the gradient goes on past `p0` and past `p1` (`/Extend`).
 */
export type Fill =
  | { kind: 'solid'; rgb: Rgb; alpha: number }
  | {
      kind: 'linear';
      stops: Stop[];
      p0: [number, number];
      p1: [number, number];
      matrix: number[];
      extend: [boolean, boolean];
      alpha: number;
    }
  | {
      kind: 'radial';
      stops: Stop[];
      p0: [number, number];
      r0: number;
      p1: [number, number];
      r1: number;
      matrix: number[];
      extend: [boolean, boolean];
      alpha: number;
    }
  /**
   * A function-based shading or a mesh, which a later pass makes a Fallback: its kind and (M5) the triangles pdf.js made of
   * it (`ShadingMesh`), which the raster renderer draws; null when pdf.js gave none.
   */
  | { kind: 'shading'; shading: 'function' | 'mesh'; alpha: number; mesh: ShadingMesh | null }
  /** A tiling pattern: its cell, repeated. */
  | { kind: 'tile'; cell: TileCell; alpha: number };

/**
 * M5, the one Scene change plan 7 allows (for the raster renderer): a function-based shading or a mesh as the triangles
 * pdf.js draws it with, each Gouraud-shaded (its colour linear between its corners'), in paint order.
 * - `type`: the /ShadingType, 1 (function-based: pdf.js samples the function at a lattice of at most 512 x 512 steps, one
 *   a unit of shading space) or 4 to 7 (meshes; pdf.js splits a lattice into two triangles a cell, and a patch of types 6
 *   and 7 into a lattice of 3 to 20 cells a side first).
 * - `xy`: each vertex's x and y, in shading space (6 decimals); `rgb`: its colour, 0-255 a channel. Each vertex is there
 *   once, in the order pdf.js first gives it.
 * - `triangles`: three indices into the vertices a triangle.
 * - `matrix`: shading space to the frame, as a gradient's. `bbox`: the shading's /BBox in shading space, which clips it;
 *   null without one. `background`: its /Background, which a pattern fill paints where no triangle is (`sh` does not);
 *   null without one.
 */
export interface ShadingMesh {
  type: 1 | 4 | 5 | 6 | 7;
  xy: number[];
  rgb: number[];
  triangles: number[];
  matrix: number[];
  bbox: Box | null;
  background: Rgb | null;
}

export interface Stop {
  t: number;
  rgb: Rgb;
}

/**
 * `w`, `dash` and `phase` are slide-frame pt: the PDF values × √|ad − bc| of the CTM (0002 §15 line style). Inside a
 * tile cell they are cell units instead, as the cell's elements are drawn in cell space from an identity CTM, and kept
 * to 6 decimals (ruling M2-R13); `TileCell.matrix` takes them to the frame of the element the cell fills.
 * `anisotropic`: the CTM's axes differ in scale by more than 1 % or are not perpendicular within 0.01°, so `w` is only an
 * average (ruling M2-R4).
 */
export interface LineStyle {
  w: number;
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  miter: number;
  dash: number[];
  phase: number;
  anisotropic: boolean;
  paint: Fill;
}

/**
 * A path filled or stroked: one element per paint (a merge is a later pass). `geom: null` paints its whole clip (`sh`), and
 * its `bbox` is the inventory's: the clip, or under a soft mask of its own the shading's bounds in it (0002 §10). Else
 * `bbox` is the path's, not widened by the line (0002 §4).
 */
export interface ShapeEl extends ElementBase {
  kind: 'shape';
  geom: PathSeg[] | null;
  fillRule: 'nonzero' | 'evenodd';
  fill: Fill | null;
  line: LineStyle | null;
  bbox: Box;
}

/**
 * One `showText` run (Task 9): its text, its font and how it is painted, and every glyph, for the text passes (M3, M4).
 * Lengths are in the frame of what holds it (slide-frame pt, rounded to 3 decimals; in a tile cell, cell units to 6).
 * - `text`: its glyphs' code points, in order; a glyph of no code point adds nothing. Whitespace stays (0002 §8).
 * - `fontKey`: its font in `SceneDeck.fonts`. `sizePt`: the font size × the length of the text's y axis (0002 §6 `size`).
 * - `rgb`, `alpha`: as the inventory's glyph (0002 §6): the fill's colour and alpha (ca) when it fills, the stroke's (CA)
 *   when it only strokes; null and 1 for `clip` and `noFill`, and `rgb` null for a pattern.
 * - `fillMode`: Tr 0 and 4 `fill`, 1 and 5 `stroke`, 2 and 6 `fillStroke`, 3 `noFill` (invisible text), 7 `clip`; a Type 3
 *   font's text `fill` (or `noFill` for Tr 3 and 7). A clip mode also adds a text clip after the text object (`ClipDef`).
 * - `fill`: what it fills with when it fills: a solid colour, or the pattern (a gradient, a shading, a tile) that the walker
 *   paints through the text; null when it does not fill, and for a shading pdf.js could not read (with a note).
 * - `stroke`: the stroke's colour, alpha (CA) and line width when it strokes in a solid colour; null otherwise (a pattern
 *   stroke too).
 * - `bold`, `italic`: the font's own style (nameID 2 of its program, `FontInfo`). Synthetic bold and italic are M4's to
 *   decide, from the raw evidence here: `fillMode` and `stroke.wPt` (Tr 2 with a width), `skew`.
 * - `spcPt`: Tc after horizontal scaling, along the text's x axis. `hScale`: Tz / 100. `rise`: Ts along the text's y axis
 *   (up the glyphs; negative is down). `skew`: the tangent of the angle by which the text's y axis leans towards its x axis
 *   from the perpendicular, (a c + b d) / |a d − b c| of the text matrix (a synthetic italic is about 0.2).
 * - `glyphs`: one per code point, at its glyph's origin (`u`, `x`, `y`, the rise included). `adv`: the glyph's advance
 *   along the text's x axis (Tz, Tc and for a space Tw included; in vertical writing its width); a glyph of several code
 *   points has it on the first and 0 on the others. `sym` (M8 round 1a): on a glyph of one code point in a symbol font
 *   (scene/fonts.ts `symbolCodes`: Wingdings and the like), its character in that font's own encoding, U+F000 + its code;
 *   absent on any other.
 */
export interface TextRun {
  text: string;
  fontKey: string;
  sizePt: number;
  rgb: Rgb | null;
  alpha: number;
  fillMode: 'fill' | 'stroke' | 'fillStroke' | 'noFill' | 'clip';
  stroke: { rgb: Rgb; alpha: number; wPt: number } | null;
  fill: Fill | null;
  bold: boolean;
  italic: boolean;
  spcPt: number;
  hScale: number;
  skew: number;
  rise: number;
  glyphs: { u: string; x: number; y: number; adv: number; sym?: string }[];
}

/**
 * A line of text (Task 9): in Scene v1 one `showText` run, one `TextRun`; joining runs into lines and lines into boxes is
 * a later pass. Its id is that of the `showText` op.
 * - `baseline`: the first glyph's origin without the rise. `angleDeg`: the direction of the text's x axis on the slide,
 *   clockwise (y runs down), 0 to < 360, as `PictureEl.xfrm.rotDeg`: text that runs up the page is 270.
 * - `wmode`: 1 for vertical writing (0002 §6). `bboxPt`: the box of its glyphs' advance boxes (origin to origin + advance,
 *   the font's descent to its ascent), as the walker makes them.
 */
export interface TextLineEl extends ElementBase {
  kind: 'textline';
  runs: TextRun[];
  baseline: { x: number; y: number };
  angleDeg: number;
  wmode: 0 | 1;
  bboxPt: Box;
}

/**
 * Task 10. An image, or an image mask painted in a solid colour (`stencil`), as one picture.
 * - `mediaHash`: its entry in `SceneDeck.media`.
 * - `matrix`: the CTM it is painted under, which carries the PDF's unit square (origin at the image's bottom left corner,
 *   y up) to the slide frame (0002 §16, ruling M2-R9), as it is but for the rounding of M2-R13.
 * - `xfrm`: the same as DrawingML says it: the unrotated box (`x`, `y`, `w`, `h`), then `flipH` or `flipV` within it (never
 *   both: that is a half turn), then a clockwise turn of `rotDeg` (0 to < 360) about its centre. Of the two ways to say a
 *   mirrored picture, the one whose turn is less than 90 degrees from upright either way; at exactly 90, `flipV`.
 * - `skewed`: the matrix's axes are not perpendicular within 0.01°, so `xfrm` is only near it (`w` and `h` are the lengths
 *   of the image's edges, `rotDeg` the direction of its top edge, and the centre is the same).
 * - `alpha`: the fill alpha it is painted with. `stencil`: an image mask's colour; its picture is RGBA in that colour.
 * - `px`: the image's own width and height in pixels (the inventory's `px`, 0002 §16), null when pdf.js gave none. The
 *   media's may be larger: pdf.js decodes an image with a larger soft mask at the mask's size.
 */
export interface PictureEl extends ElementBase {
  kind: 'picture';
  mediaHash: string;
  matrix: number[];
  xfrm: { x: number; y: number; w: number; h: number; rotDeg: number; flipH: boolean; flipV: boolean };
  skewed: boolean;
  alpha: number;
  stencil: Rgb | null;
  px: [w: number, h: number] | null;
}

/**
 * What the Scene cannot show, in its place. `raster` is always null in the Scene: the raster renderer (M5) draws a
 * fallback in the passes, which keep its picture beside it (`PassedFallback.picture`). Each comes with a `Note` of the
 * slide. `reason`:
 * - `unsupported-op` (Task 11): an operator the walker does not model (lenient mode); `bbox` null, as what it paints is not
 *   known (`clipBox` bounds it);
 * - `unbuildable` (Task 11): a paint the Scene builder could not build, or one with a number that is not finite (lenient
 *   mode); `bbox` the paint's box when that is finite;
 * - `too-complex` (final review F1): a shape or text line painted with a tiling pattern whose cell was not built,
 *   because the slide had already made more elements than its budget (`ELEMENT_BUDGET` in build.ts; lenient mode); or
 *   (M3, rulings M2-R36, M2-R37, M3-R40) the paint that took the slide to its weight budget (`SLIDE_WEIGHT_BUDGET` in
 *   weight.ts) and the rest of its scope, as one: `coveredOps` lists the first `COVERED_OPS_MAX` (build.ts) of the ops it
 *   stands for and `bbox` is the box of their boxes; otherwise `bbox` as for `unbuildable`;
 * - `stencil-pattern` (Task 10): an image mask filled with a pattern; `image-unreadable` (Task 10): an image pdf.js gave no
 *   pixels for; `shading-unreadable` (Task 8): a shading pdf.js could not read.
 */
export interface FallbackEl extends ElementBase {
  kind: 'fallback';
  reason: string;
  coveredOps: number[];
  raster: null;
  bbox: Box | null;
}

/**
 * Task 11: a link annotation of the page that pdf.js shows. `rect`: its /Rect in the slide frame. `link.url`: the URI it
 * opens when pdf.js calls it a valid absolute URL (http, https, ftp, mailto, tel), else null; `link.dest`: `page:<n>` for a
 * destination in this PDF, n its page 1-based as the `p<n>` of the ids (`SceneSlide.index` + 1, ruling M2-R22), else null.
 * Both are null for a link to something else
 * (JavaScript, another file, a named action). It is drawn in nothing: no clip, no group, no mask; `clipBox` is the slide.
 */
export interface HotspotEl extends ElementBase {
  kind: 'hotspot';
  rect: Box;
  link: { url: string | null; dest: string | null };
}

/**
 * One clip, in the frame of what it clips (the slide frame, or a tile cell's space):
 * - `path`: a clip path (`W`, `W*`), with its rule and the bounds of its points (0002 §4);
 * - `box`: the /BBox of a form or a transparency group where the CTM keeps the axes (else it is a `path` of four corners);
 * - `text`: a text clip (Tr 4 to 7), whose box is the walker's approximation from advance boxes (0002 §5).
 */
export type ClipDef =
  | { kind: 'path'; geom: PathSeg[]; rule: 'nonzero' | 'evenodd'; bbox: Box }
  | { kind: 'box'; bbox: Box }
  | { kind: 'text'; bbox: Box; approx: true };

/**
 * A transparency group: its alpha and blend mode are those in force where it is drawn (0002 §17). `mask`: the soft mask it
 * took, which applies to the group as a whole (an id in the slide's `masks`), else null (ruling M2-R14).
 */
export interface GroupRef {
  alpha: number;
  blend: BlendName;
  isolated: boolean;
  knockout: boolean;
  bbox: Box | null;
  mask: string | null;
}

/**
 * A soft mask (gs `/SMask`): what its group draws, as elements in the frame the mask was set in, with clips of their own.
 * Their alpha and blend mode start at 1 and normal, and no soft mask and no clip of the page applies to them. `backdrop`:
 * `/BC`, as pdf.js gives it (black for a luminosity mask without one).
 */
export interface MaskDef {
  subtype: 'alpha' | 'luminosity';
  backdrop: Rgb | null;
  elements: Element[];
  clips: Record<string, ClipDef>;
}

/**
 * A tiling pattern's cell (`/BBox`, `/XStep`, `/YStep`, `/PaintType`), its elements drawn in cell space from an identity
 * CTM and clipped to `bbox`. `matrix` maps cell space to the frame of the element it fills: the base transform after the
 * pattern's `/Matrix`. Cell-space lengths are kept to 6 decimals, as their unit is not pt (M2-R13); so are a picture's
 * matrix and `xfrm` in it, which describe it in cell space, where y runs up.
 */
export interface TileCell {
  bbox: Box;
  xStep: number;
  yStep: number;
  matrix: number[];
  paintType: 1 | 2;
  elements: Element[];
  clips: Record<string, ClipDef>;
}

/**
 * A font of the deck (Task 9; `FontTable` in fonts.ts says how each field is found). Its names come from the PDF's own font
 * program (spec §7): `latinName` for `a:latin`, `eaName` (Korean, else another CJK name) for `a:ea`.
 * - `key`: `f1`, `f2`, ... in the order the deck first uses the fonts.
 * - `baseFont`: the name pdf.js gives the font (the descriptor's /FontName, else /BaseFont), subset tag included; read as
 *   UTF-8 when its bytes are UTF-8 and give a character above U+00FF (a Korean name), else one character per byte.
 * - `bold`, `italic`: nameID 2 of the program; false when there is none to read.
 * - `embedded`: the PDF holds a program (or, for Type 3, its glyphs). A font that is not embedded has the `latinName` of
 *   its name without the subset tag and the style; one whose program cannot be read, or is no sfnt, has no names.
 * - `fsType`: OS/2 embedding permissions. `isVariable`: the program has `fvar`. `metrics`: from `head`, `hhea` and `OS/2`,
 *   in font units as the tables hold them (`readSfntMetrics`); null without all three. Its line gaps (`hheaLineGap`,
 *   `typoLineGap`) and `fsSelection` (bit 7, USE_TYPO_METRICS: the typo metrics are the font's line metrics) came in M4
 *   (Task 3, the one Scene change plan 5 allows), for the baseline PowerPoint draws a font's line at.
 */
export interface FontInfo {
  key: string;
  baseFont: string;
  latinName: string | null;
  eaName: string | null;
  bold: boolean;
  italic: boolean;
  embedded: boolean;
  fsType: number | null;
  isVariable: boolean;
  type3: boolean;
  metrics: {
    upm: number;
    hheaAsc: number;
    hheaDesc: number;
    hheaLineGap: number;
    winAsc: number;
    winDesc: number;
    typoAsc: number;
    typoDesc: number;
    typoLineGap: number;
    fsSelection: number;
  } | null;
}

/** Task 10. */
export interface MediaInfo {
  hash: string;
  mime: 'image/jpeg' | 'image/png';
  widthPx: number;
  heightPx: number;
  byteLength: number;
  passthrough: boolean;
}

/**
 * Task 11: something on the slide the Scene could not model. `opIndex`: the index of a page op: of the one that failed,
 * or for one in a tile cell, of the page op that paints the (outermost) cell. `op`: the name of the pdf.js operator that
 * failed, in a tile cell the cell's own operator; so inside a cell `opIndex` and `op` name two different operators
 * (final review F7). `detail`: fixed words, and where it was (` in a tile cell`, ` in a soft mask`). Links pdf.js could
 * not read, which no op draws, are `{ opIndex: 0, op: 'getAnnotations' }`. Op names and fixed words only, never deck
 * text, font names or paths (Global Constraints, Privacy).
 */
export interface Note {
  opIndex: number;
  op: string;
  detail: string;
}
