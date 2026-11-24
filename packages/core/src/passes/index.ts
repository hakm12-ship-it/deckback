import type { PathSeg } from '../extract/inventory';
import type { FallbackReason, RasterSource } from '../raster/raster';
import type { Element, SceneDeck, SceneSlide, ShapeEl } from '../scene/types';
import { classifyPage, classifyShapes, type ShapeKind } from './classify';
import { resolveClips } from './clip';
import { dedupe } from './dedupe';
import { fillRule } from './fillrule';
import { listLabels } from './labels';
import { runLinks } from './links';
import { shadingFallbacks, stopAlphas, textClipGradients, type AlphaStop } from './gradients';
import { effectFallbacks, rasterFallbacks, type PassedFallback } from './fallbacks';
import { dropInvisible } from './invisible';
import { mergeFillStroke } from './merge';
import { resolvePictures, type PassContext, type TilePlan } from './pictures';
import { SLIDE_REGION_WORK, type RegionBudget } from './region';
import { newReport, type Approximation, type SlideReport } from './report';
import { assembleText } from './text/assemble';

/**
 * A shape as the passes leave it: the Scene's, with what the geometry passes found out for lowering. Absent on a shape
 * that has not been through them; lowering then works it out itself (and reports nothing of it).
 */
export interface PassedShape extends ShapeEl {
  /** fillRule: the subpaths (0-based) of each `a:path` that fills; on filled shapes with a path. */
  fillPaths?: number[][];
  /**
   * fillRule (M5 Task 4): the outline of the fill's nonzero area, loops filled even-odd as one `a:path`, which lowering
   * writes instead of `fillPaths` (its stroke still follows `geom`); where the plan would be approximate, or its
   * overlapping `a:path`s translucent. The clip pass (fix round 1, I3): the fill of a shape with a line, cut by its clips.
   */
  fillGeom?: PathSeg[];
  /**
   * clip (M5 Task 4): the shape a `clip-cut` fallback stands for (`PassedFallback.of`). Should the raster not be drawn
   * (past the slide's budget), it is written as it is, `clip-dropped`, and strict mode refuses it (`undrawnEffects`).
   */
  clipCut?: true;
  /** shapeKind: how it is written. */
  shapeKind?: ShapeKind;
  /**
   * clip: what the shape only approximates of its clips (`clip-dropped`, `clip-approx`), which lowering records with the
   * nodes it writes of it, under the id they are written with; absent when nothing.
   */
  approximations?: Approximation[];
  /** pictures: a tiling pattern fill of one picture, written as a picture tile; on such a fill only. */
  tile?: TilePlan;
  /**
   * stopAlphas (M5 Task 3): the soft mask the fill was under, made alpha along its gradient's `t`, which lowering merges
   * with the colour stops (`gradFill`); on a gradient fill only.
   */
  alphaStops?: AlphaStop[];
}

/**
 * The passes, in order, over one slide of the Scene: a new slide for lowering and its report. The input is not changed;
 * the Scene stays as M2 left it. `ctx` is what they may read of the whole deck (`PassContext`: the bundle's media bytes),
 * made once for the deck by the caller and shared by its slides, and the slide's own scale. They make no media (ruling M3-R30): every node lowering
 * writes uses media of the bundle (`SceneBundle.media`), which the caller adds to the writer.
 * 1. classify page: the report's `class`;
 * 2. dedupe: PDF/A duplicate paints are one;
 * 3. invisible: what paints nothing on the page is dropped, but for what lies wholly past the page and the slide
 *    (M8 round 1a: kept where it is, as PowerPoint keeps a shape past the slide's edge; `ctx.view`);
 * 4. shading fallbacks: a function-based shading or a mesh, and an `sh` in a text clip (ruling M3-R27), are fallbacks,
 *    each with a note; but first (M5 Task 3, `textClipGradients`) a linear or radial `sh` that alone paints the text clip
 *    of the clip-mode text just before it is that text filled with its gradient, and is gone;
 * 5. merge: a fill and a stroke of one path are one shape; then stop alpha (M5 Task 3, `stopAlphas`): a soft mask that
 *    is a luminosity gradient over a gradient or solid fill of its geometry is per-stop alpha (`PassedShape.alphaStops`),
 *    the mask gone; any other stays for the next pass;
 * 5a. effect fallbacks (M5 Task 2, `effectFallbacks`): a shape or picture with a blend mode other than Normal or a soft
 *    mask DrawingML cannot say is a fallback that stands for it (not a shape painted with a tiling pattern, which the
 *    renderer does not draw: final review I3). After merge, so a fill and its stroke are one raster; before the clip
 *    pass, so it is drawn in its own clips;
 * 6. clip: each clip dropped where it cuts nothing on the page, folded into the geometry where exact (an `sh` gets its
 *    clip's), else recorded (`clip-dropped`, `clip-approx`). After merge (ruling M3-R28), so a fill and its stroke are
 *    decided once, at the stroke's reach;
 * 7. merge again (ruling M3-R29): what the clip pass made alike, an `sh` that took its clip's path and the outline
 *    stroked along that path after it, or a fill in a clip of its own that held it and its outline outside that clip, is
 *    one shape, as PowerPoint exports one gradient shape with an outline. It merges only shapes whose clips the pass has
 *    already resolved the same way;
 * 8. gradients: no pass of their own; lowering lays a linear or radial gradient over its node's frame (`gradFill`);
 * 9. pictures (Task 7, `resolvePictures`): a picture's clips judged in its own frame (dropped, a crop, or the shape of
 *    a path clip filled with it; M5 Task 5: of the intersection of its clips, exactly, where more than one cuts it), and
 *    a tiling pattern of one picture a picture tile, any other `tile-unsupported`.
 *    After the clip pass and the second merge (ruling M3-R31), before the fill rule, which plans a tile-filled shape's
 *    `a:path`s as any other's and none for a fill the pass left out;
 * 10. fillRule: a nonzero fill's `a:path`s (`nonzero-approx` where not proven exact);
 * 11. shapeKind: rect, line or custom;
 * 11a. run links (M5 Task 5, `runLinks`): a link whose rect covers exactly whole runs of one line goes on those runs;
 *     then list labels (ruling M5-R15, `listLabels`): a mark PowerPoint draws as a picture that is a list item's label;
 *     before text assembly, whose runs then carry them;
 * 12. text assembly (M4 Task 1, spec pass 7, `assembleText`): text runs into lines and, on a tagged page, the lines of a
 *     `Textbox` or `P` into one box (`AssembledText`, at its first run's place and with its id), split where the drift
 *     guard (M4b Task 2) predicts its glyphs leave the PDF by more than 0.5 pt (at the page's scale, `PassContext.scale`).
 *     Last but one, as it reads the final paints: one painted between two runs in z-order that covers the later one
 *     keeps them apart.
 * 13. raster fallbacks (M5 Task 2, `rasterFallbacks`): each fallback that stands for an element drawn by the raster
 *     renderer against the slide as the passes leave it, with the page's decoded pictures (`PassContext.pixels`). Its
 *     PNGs are `media`, keyed by their SHA-256, which the caller adds to the writer: the only media the passes make
 *     (ruling M3-R30 otherwise holds). One not drawn is its element as passes 6 to 11 write it (`revertPasses`, final
 *     review I3), its effect or clip dropped and recorded.
 */
export function runPasses(
  slide: SceneSlide,
  deck: Pick<SceneDeck, 'fonts' | 'media'>,
  ctx: PassContext = {},
): { slide: SceneSlide; report: SlideReport; media: Map<string, Uint8Array> } {
  const report = newReport(slide);
  report.class = classifyPage(slide);
  let out = dedupe(slide);
  out = dropInvisible(out, ctx.view);
  out = textClipGradients(out);
  out = shadingFallbacks(out, report);
  out = mergeFillStroke(out);
  out = stopAlphas(out);
  out = effectFallbacks(out, report.notes);
  out = resolveClips(out, report.notes);
  out = mergeFillStroke(out);
  out = resolvePictures(out, deck, report, ctx);
  out = fillRule(out, report);
  out = classifyShapes(out);
  out = runLinks(out, report.notes);
  out = listLabels(out, deck.fonts);
  out = assembleText(out, deck.fonts, ctx.scale ?? 1);
  const revert = revertPasses(out, deck, report, ctx);
  const drawn = rasterFallbacks(out, report.notes, ctx.pixels === undefined ? { revert } : { pixels: ctx.pixels, revert });
  return { slide: drawn.slide, report, media: drawn.media };
}

/**
 * What an element a fallback stood for is written as should its raster not be drawn (final review I3, ruling M5-R4:
 * "written as before M5"): the element through the passes after the one that made the fallback, alone on `slide`, as
 * they would have left it, so that only its effect is dropped (lowering records `blend-dropped`, `mask-dropped`) or its
 * clip (`clip-dropped`, a `clip-cut` fallback's element, already the clip or picture pass's). For a blend mode or soft
 * mask: the clip pass (a clip cutting it past the outline caps: its `clip-cut` element, as that fallback's would be),
 * the picture pass (its crop or the shape of its clips), the fill rule, the shape kind; for `clip-cut`: the fill rule and
 * the shape kind. Their approximations and notes go into `report`; their outlines share one `SLIDE_REGION_WORK` of their
 * own a slide, past which those passes keep what they did before M5 Task 4, noted. None (its clips leave nothing) or one.
 */
function revertPasses(slide: SceneSlide, deck: Pick<SceneDeck, 'fonts' | 'media'>, report: SlideReport, ctx: PassContext): (of: RasterSource, reason: FallbackReason) => Element[] {
  const budget: RegionBudget = { left: SLIDE_REGION_WORK };
  /** The slide's notes, those of earlier reverts too: each note once. */
  let notes = slide.notes;
  /** A fallback such a pass makes of it stands for it again: its element, as the raster is not drawn. */
  const unwrap = (s: SceneSlide): SceneSlide => ({ ...s, elements: s.elements.map((el) => (el.kind === 'fallback' ? ((el as PassedFallback).of ?? el) : el)) });
  return (of, reason) => {
    let one: SceneSlide = { ...slide, notes, elements: [of] };
    if (reason !== 'clip-cut') {
      one = unwrap(resolveClips(one, report.notes, budget));
      one = unwrap(resolvePictures(one, deck, report, ctx, budget));
    }
    notes = one.notes;
    one = fillRule(one, report, budget);
    return classifyShapes(one).elements;
  };
}

export { classifyPage, shapeKind, type ShapeKind } from './classify';
export { effectFallbacks, effectReason, fallbackOf, rasterFallbacks, stopAlphaCandidate, undrawnEffects, type PassedFallback } from './fallbacks';
export { planFill, type FillPlan } from './fillrule';
export { gradFill, stopAlphas, textClipGradients, type AlphaStop, type GradOptions } from './gradients';
export { EMOJI_PICTURE_NOTE, listLabels, type LabelledText } from './labels';
export { LINK_TOL, runLinks, type LinkedText, type PassedHotspot } from './links';
export { linkedPage, lowerSlide, nodeName, type LowerCtx } from './lower/slide';
export { jpegDensity, mayBeCell, type PassContext, type PassedPicture, type PicturePlan, type TilePlan } from './pictures';
export { patternCell, presetPattern, type PatternCell } from './patterns';
export { APPROXIMATIONS, approximationCounts, newReport, REPORT_LIST_MAX, type Approximation, type Counts, type PageClass, type SlideReport } from './report';
export { REDUCE_STOPS, reduceStops, STOP_DELTA_E76 } from './stops';
export { assembleText, type AssembledText } from './text/assemble';
