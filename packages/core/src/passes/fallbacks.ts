import type { Box } from '../extract/inventory';
import {
  effectiveBlend,
  FALLBACK_MAX_PX,
  maskIds,
  rasterize,
  SLIDE_RASTER_MAX,
  SLIDE_RASTER_POINTS,
  SLIDE_RASTER_PX,
  SLIDE_RASTER_WORK_SAMPLES,
  type FallbackReason,
  type RasterFallback,
  type RasterSource,
} from '../raster/raster';
import type { RasterPixels } from '../raster/shading';
import { sha256Sync } from '../scene/canonical';
import type { Element, Note, SceneSlide } from '../scene/types';
import type { PassedShape } from './index';
import type { PassedPicture } from './pictures';
import { offPage, paintBox } from './invisible';

/**
 * The fallbacks the raster renderer draws (M5 Task 2, raster/raster.ts): an element the passes cannot write becomes a
 * `PassedFallback` that stands for it (`fallbackOf`), and the last pass draws each (`rasterFallbacks`), which lowering
 * writes as a picture on its box. Text never becomes one.
 */

/** A fallback as the passes leave it: the element it stands for (`of`, `RasterFallback`) and, once drawn, its picture. */
export interface PassedFallback extends RasterFallback {
  /** `rasterFallbacks`: the picture drawn of it, its media key (the PNG's SHA-256), its box (frame pt) and size. */
  picture?: { mediaHash: string; box: Box; px: { w: number; h: number }; pxPerPt: number };
}

/**
 * A fallback at `el`'s id that stands for it: its clip chain, groups, mask and blend mode, which the raster is drawn in;
 * its box the painted box, a stroke's half width included (as the shading fallbacks'). Throws a TypeError for anything but
 * a shape or a picture: text is never rasterized (spec §7).
 */
export function fallbackOf(el: RasterSource, reason: FallbackReason): PassedFallback {
  if (el.kind !== 'shape' && el.kind !== 'picture') throw new TypeError('fallbackOf: only a shape or a picture is drawn as a fallback, never text');
  const { id, provenance, clip, clipBox, groups, mask, blend } = el;
  return {
    id,
    provenance,
    clip,
    clipBox,
    groups,
    mask,
    blend,
    kind: 'fallback',
    reason,
    coveredOps: [...provenance.opIndex],
    raster: null,
    bbox: paintBox(el, (line) => line.w / 2),
    of: el,
  };
}

/** Whether an element is drawn in a text clip (a glyph's outline, which the raster renderer does not have). */
const inTextClip = (el: Element, clips: SceneSlide['clips']): boolean => el.clip.some((id) => clips[id]?.kind === 'text');

/**
 * Whether a soft mask may be stop alpha (M5 Task 3, fills/06): a shape filled with a gradient or one colour, without a
 * line, under one luminosity mask that is one shape filled with a gradient, itself unmasked. The stop-alpha pass
 * (`stopAlphas`, gradients.ts) writes it so where that is exact; else it stays, and is a `soft-mask` fallback.
 */
export function stopAlphaCandidate(el: Element, slide: SceneSlide): boolean {
  if (el.kind !== 'shape' || el.line !== null || el.fill === null) return false;
  if (el.fill.kind !== 'solid' && el.fill.kind !== 'linear' && el.fill.kind !== 'radial') return false;
  const ids = maskIds(el);
  const def = ids.length === 1 ? slide.masks[ids[0]!] : undefined;
  if (def === undefined || def.subtype !== 'luminosity' || def.elements.length !== 1) return false;
  const m = def.elements[0]!;
  return m.kind === 'shape' && m.line === null && (m.fill?.kind === 'linear' || m.fill?.kind === 'radial') && maskIds(m).length === 0;
}

/**
 * Why an element is drawn as a raster for its effects, or null: `blend-mode` for a blend mode other than Normal (its own
 * or a group's), else `soft-mask` for a soft mask in force: by now (after `stopAlphas`) one DrawingML cannot say,
 * Review Focus 4's case among them. Only shapes and pictures, and none in a text clip.
 */
export function effectReason(el: Element, slide: SceneSlide): 'blend-mode' | 'soft-mask' | null {
  if (el.kind !== 'shape' && el.kind !== 'picture') return null;
  if (inTextClip(el, slide.clips)) return null;
  if (effectiveBlend(el) !== 'normal') return 'blend-mode';
  return maskIds(el).length === 0 ? null : 'soft-mask';
}

/** The note of a slide with more fallbacks to draw than `SLIDE_RASTER_MAX`, or more pixels than `SLIDE_RASTER_PX`. */
export const RASTER_BUDGET_NOTE = 'raster fallbacks past the slide budget';

/** Whether an element is a fallback the raster renderer may draw. */
const drawable = (el: Element): el is PassedFallback => el.kind === 'fallback' && (el as PassedFallback).of !== undefined;

/**
 * How many elements of a passed slide still have an effect that needed a fallback and were not drawn (an effect past the
 * slide's raster budget, or one the renderer could not draw, written with its blend mode or mask dropped; M5 Task 4, a
 * shape a `clip-cut` fallback stood for, written with its clip dropped; M5 Task 5, such a picture, written in its innermost
 * path): strict mode refuses them as it refuses a fallback (fix round 1), since the PPTX loses what the PDF shows.
 */
export function undrawnEffects(slide: SceneSlide): number {
  const cut = (el: Element): boolean => (el.kind === 'shape' || el.kind === 'picture') && (el as PassedShape | PassedPicture).clipCut === true;
  return slide.elements.filter((el) => effectReason(el, slide) !== null || cut(el)).length;
}

/**
 * Whether the raster renderer draws a shape's paints: not a tiling pattern (`tile fill in a raster`). Such a shape is no
 * raster target (final review I3): the normal passes write its tile (a picture tile or a preset pattern), or record it
 * `tile-unsupported`, and drop its effect or clip, which strict mode refuses (`undrawnEffects`).
 */
export const rasterPaints = (el: Element): boolean => el.kind !== 'shape' || (el.fill?.kind !== 'tile' && el.line?.paint.kind !== 'tile');

/**
 * The pass (after the first merge, before the clip pass, which then never sees them): each shape or picture with a blend
 * mode or a soft mask DrawingML cannot say (`effectReason`) becomes a fallback that stands for it, while the slide has
 * fewer than `SLIDE_RASTER_MAX` to draw (the shading fallbacks first); past that it stays as it is (lowering drops its
 * blend mode or mask, `blend-dropped`, `mask-dropped`), and the slide has the note `RASTER_BUDGET_NOTE` (op `raster`).
 * A shape painted with a tiling pattern stays as it is too (`rasterPaints`, final review I3), with no note: the renderer
 * would draw nothing of its tile. A new slide; the input is not changed.
 */
export function effectFallbacks(slide: SceneSlide, notes: Note[] | null = null): SceneSlide {
  let drawn = slide.elements.filter(drawable).length;
  let cut = false;
  let changed = false;
  const elements = slide.elements.map((el): Element => {
    const reason = el.kind === 'shape' || el.kind === 'picture' ? effectReason(el, slide) : null;
    // M8 round 1a: wholly past the page, nothing of it shows to draw (lowering drops its effect, recorded)
    if (reason === null || !rasterPaints(el) || offPage(el, slide.sizePt)) return el;
    if (drawn >= SLIDE_RASTER_MAX) {
      cut = true;
      return el;
    }
    drawn += 1;
    changed = true;
    return fallbackOf(el as RasterSource, reason);
  });
  if (!changed && !cut) return slide;
  const added: Note[] = cut ? [{ opIndex: 0, op: 'raster', detail: RASTER_BUDGET_NOTE }] : [];
  if (notes !== null) notes.push(...added.map((n) => ({ ...n })));
  return { ...slide, elements, notes: [...slide.notes, ...added] };
}

/** What the last pass needs: the decoded pictures of the page, by media hash (`ScenePage.pixels`). */
export interface RasterPassCtx {
  pixels?: (hash: string) => RasterPixels | undefined;
  /**
   * What the element a fallback stood for is written as should its raster not be drawn (final review I3): `runPasses`
   * takes it through the passes after the one that made the fallback (index.ts `revertPasses`), as they would have left
   * it: cropped, cut by its clips, its fill planned. None, or one. Absent, the element as it was when the fallback was made.
   */
  revert?: (of: RasterSource, reason: FallbackReason) => Element[];
}

/**
 * The last pass: each fallback that stands for an element (`PassedFallback.of`) drawn (`rasterize`), against the slide
 * as the passes leave it, and given its picture; the PNGs, keyed by their SHA-256, are the slide's new media, which the
 * caller adds to the writer. At most `SLIDE_RASTER_MAX` are drawn, of `SLIDE_RASTER_PX` pixels in all (each capped at
 * what is left); past either, the slide has the note `RASTER_BUDGET_NOTE`. One not drawn (past the budget; nothing of
 * it on the page; a picture whose pixels are not at hand) is, for a blend mode or soft mask, its element again as the
 * passes after the effect fallbacks write it (`ctx.revert`, final review I3: cropped, clipped, its fill planned), which
 * lowering writes as before M5, only its effect dropped and recorded (`blend-dropped`, `mask-dropped`), and for a clip
 * that cuts a fill (`clip-cut`, M5 Task 4) the shape as the clip pass gave it (`clip-dropped`) through the passes after,
 * or a picture (M5 Task 5) as the picture pass planned it (`clip-approx`); a shading stays unwritten, counted. Later
 * rasters see it so in their backdrops. What a raster left
 * out, or why it drew nothing, is a note of the slide (op `raster`, at the fallback's first op), into `notes` too. The
 * rasters of a slide share `SLIDE_RASTER_WORK_SAMPLES` of work and `SLIDE_RASTER_POINTS` of geometry (raster.ts, final
 * review C1). A new slide; the input is not changed.
 */
export function rasterFallbacks(slide: SceneSlide, notes: Note[] | null, ctx: RasterPassCtx = {}): { slide: SceneSlide; media: Map<string, Uint8Array> } {
  const media = new Map<string, Uint8Array>();
  const elements = slide.elements.slice();
  const added: Note[] = [];
  let count = 0;
  let px = 0;
  let cut = false;
  const work = { left: SLIDE_RASTER_WORK_SAMPLES };
  const points = { left: SLIDE_RASTER_POINTS };
  /** What fallbacks not drawn are written as, by their place (none or one each). */
  const written = new Map<number, Element[]>();
  /** An effect not drawn is its element again, written as before M5 (its blend mode or mask dropped); a shading stays. */
  const undrawn = (el: PassedFallback, index: number): void => {
    if (el.reason !== 'blend-mode' && el.reason !== 'soft-mask' && el.reason !== 'clip-cut') return;
    const as = ctx.revert === undefined ? [el.of!] : ctx.revert(el.of!, el.reason);
    written.set(index, as);
    // what the later rasters' backdrops see in its place (one that writes nothing, its clips leaving nothing, paints none)
    elements[index] = as[0] ?? el;
  };
  elements.forEach((el, index) => {
    if (!drawable(el)) return;
    const left = SLIDE_RASTER_PX - px;
    if (count >= SLIDE_RASTER_MAX || !(left >= 1)) {
      cut = true;
      undrawn(el, index);
      return;
    }
    count += 1;
    const pixels = ctx.pixels === undefined ? {} : { pixels: ctx.pixels };
    const said: string[] = [];
    const raster = rasterize(el, { slide: { ...slide, elements }, index, maxPx: Math.min(FALLBACK_MAX_PX, left), work, points, notes: said, ...pixels });
    // what it left out or why it drew nothing, each once a fallback
    for (const detail of new Set(said)) added.push({ opIndex: el.provenance.opIndex[0] ?? 0, op: 'raster', detail });
    if (raster === null) {
      undrawn(el, index);
      return;
    }
    px += raster.px.w * raster.px.h;
    const mediaHash = sha256Sync(raster.png);
    media.set(mediaHash, raster.png);
    const drawn: PassedFallback = { ...el, picture: { mediaHash, box: raster.box, px: raster.px, pxPerPt: raster.pxPerPt } };
    elements[index] = drawn;
  });
  if (cut && !slide.notes.some((n) => n.op === 'raster' && n.detail === RASTER_BUDGET_NOTE)) added.push({ opIndex: 0, op: 'raster', detail: RASTER_BUDGET_NOTE });
  if (notes !== null) notes.push(...added.map((n) => ({ ...n })));
  const out = written.size === 0 ? elements : elements.flatMap((el, i) => written.get(i) ?? [el]);
  const same = out.length === slide.elements.length && out.every((el, i) => el === slide.elements[i]);
  return { slide: same && added.length === 0 ? slide : { ...slide, elements: out, notes: [...slide.notes, ...added] }, media };
}
