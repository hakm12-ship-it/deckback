import type { Box, PathSeg } from '../extract/inventory';
import type { RasterPixels } from '../raster/shading';
import { canonicalJson } from '../scene/canonical';
import type { ClipDef, Element, Fill, LineStyle, MediaInfo, PictureEl, SceneDeck, SceneSlide, ShapeEl } from '../scene/types';
import { boxOperand, CLIP_BUDGET_NOTE, curved, holds, rectGeom, rectOf } from './clip';
import { fallbackOf, type PassedFallback } from './fallbacks';
import { pathPolygons, planFill, splitSubpaths } from './fillrule';
import { localFrame, mapPath } from './frame';
import type { PassedShape } from './index';
import { groupAlpha, intersect, pictureBox } from './invisible';
import { PATTERN_MAX_SIDE, patternCell, type PatternCell } from './patterns';
import { loopsPath, regionOutline, SLIDE_REGION_WORK, type RegionBudget, type RegionOperand } from './region';
import { approximate, type Approximation, type SlideReport } from './report';

/**
 * The picture pass (Task 7). DrawingML has no clip, and a picture is a box, so each picture's clips are judged in the
 * picture's own frame (ruling M3-R31): its `xfrm` box before its flips and its turn, where its image lies upright.
 * - A clip that holds what of the picture is on the page is dropped: a rect of the slide (a box, or a path that is an
 *   axis-aligned rectangle: the clip pass's `rectOf`) that holds its box on the page, or a clip that is a rect of the
 *   picture's own frame holding that frame (a turned picture's own outline, as PowerPoint exports it).
 * - Clips that are rects of its own frame and cut it crop it: the picture is written with `srcRect`, its frame shrunk to
 *   the part that shows. For an upright picture they are the slide's rects; for one turned by a multiple of 90 degrees
 *   too; for one turned otherwise only a clip turned with it (PowerPoint's own crop of a turned picture).
 * - Any other clip (a path, or a box on a picture turned otherwise) makes it a shape (spec §6, shape-cropped pictures),
 *   filled with the picture stretched to its frame (`a:blipFill`, `fillRect`), with no line, in the picture's own frame
 *   (lowering turns and flips it as the picture; a JPEG's bytes are the media as they are, Review Focus 5):
 *   - one path clip that the fill rule writes exactly (`planFill`: proven, no `a:path`s that overlap): that clip's
 *     geometry, curves and all, its `a:path`s the fill rule's (the picture fills its own frame of it, `fillRect`);
 *   - else (M5 Task 5: more than one clip cuts it, or the fill rule cannot write its one clip exactly) the intersection
 *     of its clips and its own frame (region.ts `regionOutline`, `'all'`), one `a:path`
 *     filled even-odd, every clip written: exact for polygons, `clip-approx` where a curve was flattened (within
 *     `REGION_TOL`). It leaves nothing: the picture is dropped. The outlines of a slide spend at most `SLIDE_REGION_WORK`
 *     steps; past that budget the picture is written as before M5 Task 5 (the innermost path its shape, the other clips
 *     kept in `clip`, `clip-approx`) and the slide has the note `CLIP_BUDGET_NOTE`; past an outline's caps it is a
 *     `clip-cut` fallback that stands for the picture in all its clips, which, should the raster not be drawn, gives that
 *     picture back (`PassedPicture.clipCut`, refused by strict mode).
 * - A text clip, or a clip the slide does not hold, is dropped, kept in `clip`, and recorded `clip-dropped`.
 * - A crop that leaves nothing of it drops it.
 * - Its border (M5 Task 5, atlas pictures/08): PowerPoint strokes a picture's own line (`a:ln` on `p:pic`) outside its
 *   frame, and exports it as a stroke just after the picture, the rect of its frame grown by half the line's width. Such
 *   a stroke (`borderOf`) becomes the picture's line again (`PassedPicture.border`), which PowerPoint then dashes and
 *   joins as its own source did.
 * The clip approximations wait in `PassedPicture.approximations`; lowering records them with the node it writes.
 *
 * A tiling pattern that fills a shape (`Fill` kind `tile`) whose cell is one picture covering the cell, the step its
 * size, upright on the slide (PowerPoint's picture and texture fills, ruling M2-R18), becomes a picture tile
 * (`PassedShape.tile`): lowering writes an `a:blipFill` `a:tile`. Any other cell leaves the shape with no fill, and a
 * line painted with a pattern with no line (DrawingML has no picture line): `tile-unsupported`, recorded here, whatever
 * is left to write.
 *
 * A stencil's picture is the Scene's own PNG, RGBA in its colour with its mask as alpha (M2 Task 10): nothing to make
 * (ruling M3-R30). The pass makes no media.
 */

/**
 * What the passes may read of the whole deck, made once by the caller for the deck and shared by its slides; never
 * changed. A picture tile's scale needs a JPEG's density (`jpegDensity`):
 * - `jpegDensity`: each JPEG's density, read once, for a caller that does not keep the bytes (`convert`, which streams
 *   the deck: it keeps two numbers per JPEG, not the picture); read first;
 * - `media`: the deck's media bytes (`SceneBundle.media`), whose density is read when `jpegDensity` has none.
 * Without either a JPEG is taken at 96 dpi.
 */
export interface PassContext {
  readonly jpegDensity?: ReadonlyMap<string, Pt | null>;
  /** M5 Task 2: the page's decoded pictures by media hash (`ScenePage.pixels`), which the raster fallbacks draw. */
  readonly pixels?: (hash: string) => RasterPixels | undefined;
  readonly media?: ReadonlyMap<string, Uint8Array>;
  /**
   * M5-R10: each small PNG's pattern cell (`patternCell`, null where it is none), read once, for a caller that does not
   * keep the bytes (`convert`); read first. Else read from `media` where its bytes are there.
   */
  readonly patternCells?: ReadonlyMap<string, PatternCell | null>;
  /**
   * The page's scale on the slide, the slide's own (`LowerCtx.scale`): text assembly's drift guard predicts what lowering
   * writes after it (M4b Task 2). 1 when absent.
   */
  readonly scale?: number;
  /**
   * M8 round 1a: the slide's box in the page's frame (`convert`: the page scaled and centred on the slide, which it fills
   * along one side), past which nothing shows; the page when absent. `dropInvisible` keeps what lies past it.
   */
  readonly view?: Box;
}

/**
 * How a picture is written. `picture`: as a picture, cropped to `crop` (a box of its own frame, within its `xfrm` box)
 * when not null. `shape`: as the shape of `geom` (a path of its own frame), its subpaths in the `a:path`s `paths`.
 */
export type PicturePlan = { kind: 'picture'; crop: Box | null } | { kind: 'shape'; geom: PathSeg[]; paths: number[][] };

/** A picture as the pass leaves it: its plan, and what it only approximates of its clips (absent when nothing). */
export interface PassedPicture extends PictureEl {
  plan?: PicturePlan;
  approximations?: Approximation[];
  /** M5 Task 5: its own line, a stroke just around it that the pass took in (`borderOf`); absent for none. */
  border?: LineStyle;
  /**
   * M5 Task 5: the picture a `clip-cut` fallback stands for (`PassedFallback.of`), its clips all kept for the raster.
   * Should the raster not be drawn, it is written as planned (`clip-approx`), and strict mode refuses it (`undrawnEffects`).
   */
  clipCut?: true;
}

/**
 * A picture tile: the media of the cell's picture, its alpha (the pattern's times the picture's and its groups'), the box
 * of one tile on the slide (pt, from the cell matrix: where the tiling starts) and the media's natural size (pt), which
 * DrawingML's tile scale is a share of.
 */
export interface TilePlan {
  media: string;
  alpha: number;
  image: Box;
  natural: [w: number, h: number];
  /**
   * M5-R10: the picture's 8 x 8 cell of two colours (`patternCell`), where it is one; lowering writes it as PowerPoint's
   * preset (`a:pattFill`) where it is one of those on the slide's grid, else the picture tile.
   */
  cell?: PatternCell;
}

/** Whether a picture may be a pattern cell (`patternCell`): a PNG, square, 8k pixels a side up to `PATTERN_MAX_SIDE`. */
export const mayBeCell = (info: Pick<MediaInfo, 'mime' | 'widthPx' | 'heightPx'>): boolean =>
  info.mime === 'image/png' && info.widthPx === info.heightPx && info.widthPx % 8 === 0 && info.widthPx <= PATTERN_MAX_SIDE;

/** A picture's pattern cell, as the context gives it, else read from its bytes where they are there; null for none. */
function cellOf(info: MediaInfo, ctx: PassContext): PatternCell | null {
  if (!mayBeCell(info)) return null;
  const known = ctx.patternCells?.get(info.hash);
  if (known !== undefined) return known;
  const bytes = ctx.media?.get(info.hash);
  return bytes === undefined ? null : patternCell(bytes);
}

/**
 * How far (pt) a clip may stray from a rect of the picture's frame, or inside its box, and still count as that rect, or
 * as holding it. PowerPoint writes 2 decimals: its outline of a turned picture misses the image's own corners by up to
 * about 0.015 pt (atlas-smoke p33:z155: 0.012), which is no cut.
 */
const LOCAL_TOL = 0.02;
/** How far a cell's picture, step or clip may stray from the cell, as a share of the cell's larger side. */
const CELL_TOL = 1e-4;
/** How far from upright (the cosine of the angle off, roughly) a tile may be. */
const AXIS_TOL = 1e-6;
/** The resolution DrawingML takes for an image that says none: our PNGs say none (`encodePng`). */
const DEFAULT_DPI = 96;

type Pt = [number, number];

export { localFrame, type LocalFrame } from './frame';

const near = (a: number, b: number, tol: number): boolean => Math.abs(a - b) <= tol;

/**
 * The rect a path is within `tol`: one subpath of four corners (a repeated point dropped), each side along an axis,
 * turning at each corner; else null. Its rule does not matter, as a rect does not cross itself.
 */
export function rectWithin(geom: readonly PathSeg[], tol: number): Box | null {
  const subs = splitSubpaths(geom);
  if (subs.length !== 1) return null;
  const pts: Pt[] = [];
  for (const seg of subs[0]!) {
    if (seg[0] === 'C') return null;
    if (seg[0] === 'Z') continue;
    const last = pts[pts.length - 1];
    if (last === undefined || !near(last[0], seg[1], tol) || !near(last[1], seg[2], tol)) pts.push([seg[1], seg[2]]);
  }
  if (pts.length > 1 && near(pts[0]![0], pts[pts.length - 1]![0], tol) && near(pts[0]![1], pts[pts.length - 1]![1], tol)) pts.pop();
  if (pts.length !== 4) return null;
  const across = pts.map((p, i) => {
    const q = pts[(i + 1) % 4]!;
    const [flatY, flatX] = [near(p[1], q[1], tol), near(p[0], q[0], tol)];
    return flatY === flatX ? null : flatY; // true: a side along x
  });
  if (across.some((a) => a === null) || across[0] === across[1] || across[0] !== across[2] || across[1] !== across[3]) return null;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

const holdsWithin = (outer: Box, inner: Box, tol: number): boolean =>
  outer[0] <= inner[0] + tol && outer[1] <= inner[1] + tol && outer[2] >= inner[2] - tol && outer[3] >= inner[3] - tol;

/** The picture with its plan, its clips now `kept` (in the order of its chain) and `approximations` if any. */
function planned(pic: PictureEl, plan: PicturePlan, kept: readonly string[], approximations: Approximation[]): PassedPicture {
  return { ...pic, clip: pic.clip.filter((id) => kept.includes(id)), plan, ...(approximations.length > 0 ? { approximations } : {}) };
}

/** What the picture pass keeps for a slide: the work its clip outlines may still spend, and whether a picture found it spent. */
interface PictureClipCtx {
  budget: RegionBudget;
  spent: boolean;
}

/** A clip of a picture, in the picture's own frame: its path there, its rule, and the rect it is there (null for none). */
interface LocalClip {
  id: string;
  local: PathSeg[];
  rule: 'nonzero' | 'evenodd';
  rect: Box | null;
}

/** The path of a clip as a filled shape of the picture's, which the fill rule plans (`planFill`). */
function clipShape(pic: PictureEl, c: LocalClip): ShapeEl {
  const { id, provenance, clipBox, groups, mask, blend } = pic;
  return { id, provenance, clip: [], clipBox, groups, mask, blend, kind: 'shape', geom: c.local, fillRule: c.rule, fill: null, line: null, bbox: clipBox };
}

/**
 * A picture in its clips (`clips`) on the page `page`, as the module comment says; null when a crop or its clips leave
 * nothing; a `clip-cut` fallback past an outline's caps.
 */
function pictureClips(pic: PictureEl, clips: Record<string, ClipDef>, page: Box, ctx: PictureClipCtx): PassedPicture | PassedFallback | null {
  const frame = localFrame(pic);
  const painted = pictureBox(pic);
  // M8 round 1a: a picture wholly past the page (kept by `dropInvisible`) shows nothing: no clip cuts it
  if (intersect(painted, page) === null) return planned(pic, { kind: 'picture', crop: null }, [], []);
  const unknown: string[] = [];
  const real: LocalClip[] = [];
  for (const id of pic.clip) {
    const def = clips[id];
    if (def === undefined || def.kind === 'text') {
      unknown.push(id);
      continue;
    }
    const slideRect = rectOf(def);
    if (slideRect !== null && holds(slideRect, painted, page)) continue;
    const local = mapPath(def.kind === 'box' ? rectGeom(def.bbox) : def.geom, frame.toLocal);
    const rect = rectWithin(local, LOCAL_TOL);
    if (rect !== null && holdsWithin(rect, frame.box, LOCAL_TOL)) continue;
    real.push({ id, local, rule: def.kind === 'path' ? def.rule : 'nonzero', rect });
  }
  const recorded: Approximation[] = unknown.length > 0 ? ['clip-dropped'] : [];
  const paths = real.filter((c) => c.rect === null);
  if (paths.length === 0) {
    let crop: Box | null = real.length === 0 ? null : frame.box;
    for (const c of real) crop = crop === null ? null : intersect(crop, c.rect!);
    if (real.length > 0 && (crop === null || crop[2] - crop[0] <= 0 || crop[3] - crop[1] <= 0)) return null;
    return planned(pic, { kind: 'picture', crop }, unknown, recorded);
  }
  // one path clip, which the fill rule writes exactly: its own geometry, curves and all (the picture fills its own frame
  // of it, `fillRect`: PowerPoint's knockout clips of baked shadows, the page less the shape, stay as they are)
  if (real.length === 1) {
    const only = real[0]!;
    const plan = planFill(clipShape(pic, only));
    if (!plan.approx && plan.overlap !== true) return planned(pic, { kind: 'shape', geom: only.local, paths: plan.paths }, unknown, recorded);
  }
  /** As before M5 Task 5: the innermost path the shape, the other clips kept and recorded `clip-approx`. */
  const innermost = (): PassedPicture => {
    const inner = paths[paths.length - 1]!;
    const others = real.filter((c) => c !== inner).map((c) => c.id);
    const approx: Approximation[] = others.length > 0 ? [...recorded, 'clip-approx'] : [...recorded];
    const plan = planFill(clipShape(pic, inner));
    if (plan.approx) approx.push('nonzero-approx');
    return planned(pic, { kind: 'shape', geom: inner.local, paths: plan.paths }, [...unknown, ...others], approx);
  };
  if (!(ctx.budget.left > 0)) {
    ctx.spent = true;
    return innermost();
  }
  const operands: (RegionOperand | null)[] = real.map((c) => {
    if (c.rect !== null) return boxOperand(c.rect);
    const polygons = pathPolygons(c.local);
    return polygons === null ? null : { polygons, rule: c.rule };
  });
  const cut = operands.some((op) => op === null) ? 'too-large' : regionOutline([...(operands as RegionOperand[]), boxOperand(frame.box)], 'all', ctx.budget);
  if (cut === 'over-budget') {
    ctx.spent = true;
    return innermost();
  }
  if (cut === 'too-large') {
    const of: PassedPicture = { ...innermost(), clip: [...pic.clip], clipCut: true };
    return { ...fallbackOf(pic, 'clip-cut'), of };
  }
  if (cut.loops.length === 0) return null;
  const flattened: Approximation[] = paths.some((c) => curved(c.local)) ? ['clip-approx'] : [];
  const geom = loopsPath(cut.loops);
  return planned(pic, { kind: 'shape', geom, paths: [cut.loops.map((_, i) => i)] }, unknown, [...recorded, ...flattened]);
}

/**
 * Whether a stroke's path draws the whole outline of a rect as `a:ln` does, joined all round (fix round 1): one subpath,
 * closed (`Z`), or back at its start with caps that cover the corner (round or square: butt caps leave the start corner
 * notched, where `a:ln` joins it). `rectWithin` then says it has four corners and four sides.
 */
function closedRing(geom: readonly PathSeg[], cap: LineStyle['cap']): boolean {
  const subs = splitSubpaths(geom);
  if (subs.length !== 1) return false;
  const sub = subs[0]!;
  if (sub.some((seg) => seg[0] === 'Z')) return true;
  const [first, last] = [sub[0]!, sub[sub.length - 1]!];
  if (first[0] === 'Z' || last[0] === 'Z') return false;
  const end = last[0] === 'C' ? [last[5], last[6]] : [last[1], last[2]];
  return cap !== 'butt' && near(first[1], end[0]!, LOCAL_TOL) && near(first[2], end[1]!, LOCAL_TOL);
}

/**
 * Whether `el` is the border of the picture `pic` just before it (the module comment): a stroke of one solid colour with no
 * fill, in no clip, mask or blend mode and in the picture's groups, recording nothing, undashed or dashed from its start
 * (`a:ln` has no dash phase: fix round 1; such a stroke stays a shape, which records `dash-phase`), whose path is closed
 * all round (`closedRing`) and is, in the picture's own frame, the rect of what the picture shows (its crop, else its
 * frame) grown by half the stroke's width, within `LOCAL_TOL`. Only for a picture written as one (not the shape of its
 * clip).
 */
function borderOf(pic: PassedPicture, el: Element): el is ShapeEl & { line: LineStyle } {
  if (pic.plan?.kind !== 'picture' || el.kind !== 'shape' || el.geom === null || el.fill !== null || el.line === null) return false;
  const line = el.line;
  if (line.paint.kind !== 'solid' || line.anisotropic || !(line.w > 0)) return false;
  if (line.dash.length > 0 && line.phase !== 0) return false;
  if (!closedRing(el.geom, line.cap)) return false;
  if (el.clip.length > 0 || el.mask !== null || el.blend !== 'normal' || (el as PassedShape).approximations !== undefined) return false;
  if (canonicalJson(el.groups) !== canonicalJson(pic.groups)) return false;
  const frame = localFrame(pic);
  const rect = rectWithin(mapPath(el.geom, frame.toLocal), LOCAL_TOL);
  if (rect === null) return false;
  const [x0, y0, x1, y1] = pic.plan.crop ?? frame.box;
  const h = line.w / 2;
  return [x0 - h, y0 - h, x1 + h, y1 + h].every((v, i) => near(v, rect[i]!, LOCAL_TOL));
}

/** The box the unit square lands on under `m`. */
function squareBox(m: readonly number[]): Box {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const xs = [e, a + e, c + e, a + c + e];
  const ys = [f, b + f, d + f, b + d + f];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** `m` then `n` (PDF row vectors: a point is taken through `m`, then through `n`). */
function compose(m: readonly number[], n: readonly number[]): number[] {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = m;
  const [a2 = 1, b2 = 0, c2 = 0, d2 = 1, e2 = 0, f2 = 0] = n;
  return [a * a2 + b * c2, a * b2 + b * d2, c * a2 + d * c2, c * b2 + d * d2, e * a2 + f * c2 + e2, e * b2 + f * d2 + f2];
}

/** A big-endian 16-bit number. */
const u16be = (bytes: Uint8Array, at: number): number => (bytes[at]! << 8) | bytes[at + 1]!;
const isAscii = (bytes: Uint8Array, at: number, text: string): boolean => [...text].every((ch, i) => bytes[at + i] === ch.charCodeAt(0));

/**
 * The resolution (dots per inch, x and y) an EXIF block (APP1, after `Exif\0\0`: a TIFF structure) gives in IFD0:
 * XResolution, YResolution (rationals) and ResolutionUnit (2 inch, the default; 3 centimetre; else none). Null without
 * both, or with a unit of none.
 */
function exifDensity(tiff: Uint8Array): Pt | null {
  const le = isAscii(tiff, 0, 'II');
  if (!le && !isAscii(tiff, 0, 'MM')) return null;
  const u16 = (at: number): number => (le ? tiff[at]! | (tiff[at + 1]! << 8) : u16be(tiff, at));
  const u32 = (at: number): number => (le ? u16(at) + u16(at + 2) * 65536 : u16(at) * 65536 + u16(at + 2));
  if (tiff.length < 8 || u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const rational = (entry: number): number | null => {
    const at = u32(entry + 8);
    if (u16(entry + 2) !== 5 || at + 8 > tiff.length || u32(at + 4) === 0) return null;
    return u32(at) / u32(at + 4);
  };
  let [x, y, unit]: [number | null, number | null, number] = [null, null, 2];
  for (let i = 0; i < u16(ifd); i++) {
    const entry = ifd + 2 + 12 * i;
    if (entry + 12 > tiff.length) break;
    const tag = u16(entry);
    if (tag === 0x011a) x = rational(entry);
    else if (tag === 0x011b) y = rational(entry);
    else if (tag === 0x0128 && u16(entry + 2) === 3) unit = u16(entry + 8);
  }
  if (x === null || y === null || !(x > 0 && y > 0) || (unit !== 2 && unit !== 3)) return null;
  return unit === 2 ? [x, y] : [(x * 254) / 100, (y * 254) / 100];
}

/**
 * Walks a JPEG's marker segments before its scan, as `jpegDensity` reads them: `visit` gets each segment's marker and
 * the bounds of its payload, and stops the walk by returning true. The walk also stops at the scan, the end, a byte
 * that is no marker and a segment cut short; it does not start for bytes that are no JPEG.
 */
function jpegSegments(bytes: Uint8Array, visit: (marker: number, start: number, end: number) => boolean): void {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++; // a fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // the scan, or the end
    const length = u16be(bytes, at + 2);
    const [start, end] = [at + 4, at + 2 + length];
    if (length < 2 || end > bytes.length || visit(marker, start, end)) break;
    at = end;
  }
}

/**
 * The resolution (dots per inch, x and y) a JPEG's markers before its scan give: the EXIF resolution (`exifDensity`,
 * of the first EXIF block), else the JFIF APP0 density in dots per inch or per centimetre (of the first JFIF block that
 * says one); null when neither does, which is 96 dpi. PowerPoint reads them in this order: Task 12 measured its tile
 * periods, and with JFIF 300 dpi and EXIF 150 dpi both there it tiles at 150.
 */
export function jpegDensity(bytes: Uint8Array): Pt | null {
  let jfif: Pt | null = null;
  let exif: Pt | null = null;
  jpegSegments(bytes, (marker, start, end) => {
    if (marker === 0xe0 && jfif === null && end - start >= 12 && isAscii(bytes, start, 'JFIF\0')) {
      const [units, x, y] = [bytes[start + 7]!, u16be(bytes, start + 8), u16be(bytes, start + 10)];
      if ((units === 1 || units === 2) && x > 0 && y > 0) jfif = units === 1 ? [x, y] : [(x * 254) / 100, (y * 254) / 100];
    } else if (marker === 0xe1 && exif === null && isAscii(bytes, start, 'Exif\0\0')) {
      exif = exifDensity(bytes.subarray(start + 6, end));
    }
    return false;
  });
  return exif ?? jfif;
}

/**
 * The size (pt) DrawingML gives the media at its own resolution, which a tile's scale is a share of: its pixels at 96 dpi
 * (our PNGs say no resolution), a JPEG's at its density (`jpegDensity`: as the context gives it, else read from the
 * bytes when they are there) when it says one (ruling M3-R31; unmeasured in PowerPoint until Task 12).
 */
function naturalSize(info: MediaInfo, ctx: PassContext): Pt {
  const known = ctx.jpegDensity?.get(info.hash);
  const bytes = ctx.media?.get(info.hash);
  const dpi = info.mime !== 'image/jpeg' ? null : known !== undefined ? known : bytes !== undefined ? jpegDensity(bytes) : null;
  const [dx, dy] = dpi ?? [DEFAULT_DPI, DEFAULT_DPI];
  return [(info.widthPx * 72) / dx, (info.heightPx * 72) / dy];
}

/** A tiling pattern as a picture tile (the module comment), or null when it is not one. */
function tilePlan(fill: Extract<Fill, { kind: 'tile' }>, deck: Pick<SceneDeck, 'media'>, ctx: PassContext): TilePlan | null {
  const { cell } = fill;
  const [only, ...more] = cell.elements;
  if (only === undefined || more.length > 0 || only.kind !== 'picture') return null;
  const pic = only;
  if (pic.mask !== null || pic.blend !== 'normal' || pic.groups.some((g) => g.mask !== null || g.blend !== 'normal')) return null;
  const info = deck.media[pic.mediaHash];
  if (info === undefined) return null;
  const [x0, y0, x1, y1] = cell.bbox;
  const tol = CELL_TOL * Math.max(x1 - x0, y1 - y0);
  if (!(x1 - x0 > 0 && y1 - y0 > 0) || !near(Math.abs(cell.xStep), x1 - x0, tol) || !near(Math.abs(cell.yStep), y1 - y0, tol)) return null;
  const box = pictureBox(pic);
  if (!box.every((v, i) => near(v, cell.bbox[i]!, tol))) return null;
  for (const id of pic.clip) {
    const def = cell.clips[id];
    const rect = def === undefined ? null : rectOf(def);
    if (rect === null || !holdsWithin(rect, box, tol)) return null;
  }
  const m = compose(pic.matrix, cell.matrix);
  const [a = 0, b = 0, c = 0, d = 0] = m;
  if (!(a > 0 && d < 0) || Math.abs(b) > AXIS_TOL * a || Math.abs(c) > AXIS_TOL * -d) return null;
  const patternCellOf = cellOf(info, ctx);
  return { media: pic.mediaHash, alpha: fill.alpha * pic.alpha * groupAlpha(pic), image: squareBox(m), natural: naturalSize(info, ctx), ...(patternCellOf === null ? {} : { cell: patternCellOf }) };
}

/** A shape's tiling patterns: a fill of one picture is a tile (`tile`), any other leaves no fill, a line no line. */
function shapeTiles(el: ShapeEl, deck: Pick<SceneDeck, 'media'>, report: SlideReport, ctx: PassContext): PassedShape {
  let out: PassedShape = el;
  if (el.fill?.kind === 'tile') {
    const tile = tilePlan(el.fill, deck, ctx);
    if (tile !== null) out = { ...out, tile };
    else {
      out = { ...out, fill: null };
      approximate(report, el.id, 'tile-unsupported');
    }
  }
  if (el.line?.paint.kind === 'tile') {
    out = { ...out, line: null };
    approximate(report, el.id, 'tile-unsupported');
  }
  return out;
}

/**
 * The pass over the slide's elements (the page is `[0, 0, ...slide.sizePt]`): pictures as `pictureClips` (with the stroke
 * just after one that is its border, `borderOf`, as its line), shapes painted with a tiling pattern as `shapeTiles`; the
 * rest as it is. Text painted with a pattern is the text passes' (Task 8). The
 * pictures' clip outlines share `SLIDE_REGION_WORK` steps (or `budget`, as `resolveClips`'); a slide past it has the note
 * `CLIP_BUDGET_NOTE` (op `clip`), in the report too, once. A new slide; the input is not changed.
 */
export function resolvePictures(slide: SceneSlide, deck: Pick<SceneDeck, 'media'>, report: SlideReport, ctx: PassContext = {}, budget: RegionBudget = { left: SLIDE_REGION_WORK }): SceneSlide {
  const page: Box = [0, 0, slide.sizePt[0], slide.sizePt[1]];
  const elements: Element[] = [];
  const clipCtx: PictureClipCtx = { budget, spent: false };
  for (let i = 0; i < slide.elements.length; i++) {
    const el = slide.elements[i]!;
    if (el.kind === 'picture') {
      const out = pictureClips(el, slide.clips, page, clipCtx);
      if (out === null) continue;
      const next = slide.elements[i + 1];
      if (out.kind === 'picture' && next !== undefined && borderOf(out, next)) {
        const bordered: PassedPicture = { ...out, border: next.line };
        elements.push(bordered);
        i += 1;
        continue;
      }
      elements.push(out);
    } else if (el.kind === 'shape' && (el.fill?.kind === 'tile' || el.line?.paint.kind === 'tile')) {
      elements.push(shapeTiles(el, deck, report, ctx));
    } else {
      elements.push(el);
    }
  }
  if (!clipCtx.spent || slide.notes.some((n) => n.op === 'clip' && n.detail === CLIP_BUDGET_NOTE)) return { ...slide, elements };
  const note = { opIndex: 0, op: 'clip', detail: CLIP_BUDGET_NOTE };
  report.notes.push({ ...note });
  return { ...slide, elements, notes: [...slide.notes, note] };
}
