import { hasPictureChar, keptText, paragraphBullet, type Emu, type OxFill, type OxLink, type OxNode, type OxPicture, type OxShape, type OxSlide, type OxTextBox } from '@deckback/ooxml';
import { canonicalJson } from '../../scene/canonical';
import type { Element, HotspotEl, SceneDeck, SceneSlide } from '../../scene/types';
import type { PassedFallback } from '../fallbacks';
import { EMOJI_PICTURE_NOTE } from '../labels';
import type { PassedHotspot } from '../links';
import { groupAlpha } from '../invisible';
import type { PassedPicture } from '../pictures';
import { approximate, listFallback, type Approximation, type SlideReport } from '../report';
import { lowerPicture } from './picture';
import { lowerShape, type NameKind } from './shape';
import type { FontMap } from '../../fonts/typefaces';
import { lowerText } from './text';
import { placeX, placeY, solidFill, type Placement } from './units';

/**
 * How a slide is lowered.
 * - `page`: the slide's page, 1-based. Node names come from the element ids, which carry it already.
 * - `scale`, `offset`: where the page lands on the slide, a uniform scale and then an offset in pt (`convert` fits each
 *   page to the slide and centres it; 1 and [0, 0] for a page of the slide's size). Every length lowering writes is
 *   scaled: positions and sizes, line widths, text sizes and spacing, a hairline's dashes (against one pixel on the
 *   slide) and a picture tile's size; shares (dashes, crops, gradient stops and angles) do not change with it.
 * - `report`: the slide's report from `runPasses`, which lowering completes with the nodes it writes (`counts`), the
 *   fallbacks it leaves out (`fallbacks`) and the approximations it makes. Without it lowering only lowers.
 * - `reduceStops`: whether gradients' sampled stops are reduced (`reduceStops`, at `STOP_DELTA_E76`); `REDUCE_STOPS`, off,
 *   when absent. Task 12 measures both settings.
 * - `slideOf`: the slide a link to page n of the PDF (1-based, `page:<n>`) goes to, null for a page not converted, whose
 *   link is not written (ruling M3-R21; `convert` counts it); page n is slide n when absent.
 * - `slideEmu`: the slide's size in EMU, which a background must cover (`backgroundOf`); the page's own box as it lands
 *   on the slide when absent.
 */
export interface LowerCtx extends Placement {
  page: number;
  scale: number;
  offset: [x: number, y: number];
  report?: SlideReport;
  reduceStops?: boolean;
  slideOf?: (page: number) => number | null;
  slideEmu?: [w: Emu, h: Emu];
  /** M6: `ConvertOptions.fontMap`: the typefaces text is written with are mapped by it. */
  fontMap?: FontMap;
}

/**
 * Ruling M3-R52 (a part of spec pass 4, background separation): the slide's background, when its first element is an
 * unclipped, unstroked rect filled with an opaque solid colour that covers the whole slide (written as the rect preset,
 * its frame from 0, 0 to the slide's size or past it), in no group of an alpha below 1, with no soft mask and a normal
 * blend mode. PowerPoint exports a slide's background so, and the slide then has it as `p:bg`, not as a shape. Null
 * otherwise, the element left a shape.
 */
function backgroundOf(slide: SceneSlide, ctx: LowerCtx): OxFill | null {
  const el = slide.elements[0];
  if (el === undefined || el.kind !== 'shape' || el.line !== null || el.fill?.kind !== 'solid' || el.clip.length > 0) return null;
  if (groupAlpha(el) < 1 || el.mask !== null || el.groups.some((g) => g.mask !== null) || el.blend !== 'normal' || el.groups.some((g) => g.blend !== 'normal')) return null;
  const fill = solidFill(el.fill, 1);
  if (fill === null || fill.kind !== 'solid' || fill.alpha < 100000) return null;
  const written = lowerShape(el, { place: ctx, alpha: 1, name: (kind) => kind, approximate: () => {} });
  const node = written[0];
  if (written.length !== 1 || node === undefined || node.kind !== 'shape' || node.geom.kind !== 'rect') return null;
  const [w, h] = ctx.slideEmu ?? [placeX(ctx, slide.sizePt[0]), placeY(ctx, slide.sizePt[1])];
  const [x0, y0] = ctx.slideEmu === undefined ? [placeX(ctx, 0), placeY(ctx, 0)] : [0, 0];
  const { frame } = node;
  return frame.x <= x0 && frame.y <= y0 && frame.x + frame.w >= w && frame.y + frame.h >= h ? fill : null;
}

/**
 * A node's name (ruling M3-R17): `pdf:` and the element id with a space and the kind after its op, and the id's `:n`
 * after the kind: `p1:z7` freeform is `pdf:p1:z7 freeform`, `p1:z7:1` is `pdf:p1:z7 freeform 1`, and a hotspot `p1:a0`
 * is `pdf:p1:a0 link`.
 */
export function nodeName(id: string, kind: NameKind): string {
  const found = /^(.*):(\d+)$/.exec(id);
  return found !== null ? `pdf:${found[1]} ${kind} ${found[2]}` : `pdf:${id} ${kind}`;
}

/**
 * For each element, whether one of its groups with an alpha below 1 holds another element too. A group's elements are
 * consecutive, so an element shares a group at depth k when a neighbour has the same groups down to k (two groups alike
 * in every respect and next to each other are taken for one, which only reports more).
 */
function sharedAlphaGroups(elements: readonly Element[]): boolean[] {
  const keys = elements.map((el) => el.groups.map((_, k) => canonicalJson(el.groups.slice(0, k + 1))));
  return elements.map((el, i) =>
    el.groups.some((g, k) => g.alpha < 1 && (keys[i - 1]?.[k] === keys[i]![k] || keys[i + 1]?.[k] === keys[i]![k])),
  );
}

/**
 * What an element's groups, mask and blend mode cost, which lowering cannot write: the group alphas are folded into
 * its own (exact for an element alone in its groups, approximate where the group holds more, or the element is a fill
 * and a line merged: `group-alpha-folded`); a soft mask is dropped (`mask-dropped`); a blend mode other than normal, its
 * own or a group's, is dropped (`blend-dropped`).
 */
export function elementApproximations(el: Element, sharesAlphaGroup: boolean): Approximation[] {
  const out: Approximation[] = [];
  const merged = el.kind === 'shape' && el.fill !== null && el.line !== null;
  if (groupAlpha(el) < 1 && (sharesAlphaGroup || merged)) out.push('group-alpha-folded');
  if (el.mask !== null || el.groups.some((g) => g.mask !== null)) out.push('mask-dropped');
  if (el.blend !== 'normal' || el.groups.some((g) => g.blend !== 'normal')) out.push('blend-dropped');
  return out;
}

const PAGE_DEST = /^page:([1-9]\d*)$/;

/** The page of the PDF (1-based) a link goes to: its `page:<n>`, when it has no URL (which it would open instead). */
export function linkedPage(link: HotspotEl['link']): number | null {
  if (link.url !== null) return null;
  const page = link.dest === null ? null : PAGE_DEST.exec(link.dest);
  return page === null ? null : Number(page[1]);
}

/**
 * A link as the writer's: a URL as it is, `page:<n>` the slide `slideOf` gives (slide n without it); null when it has
 * neither, or goes to a page that is not converted.
 */
function linkOf(link: HotspotEl['link'], slideOf?: (page: number) => number | null): OxLink | null {
  if (link.url !== null) return { kind: 'url', url: link.url };
  const page = linkedPage(link);
  const slide = page === null ? null : slideOf === undefined ? page : slideOf(page);
  return slide === null ? null : { kind: 'slide', slide };
}

/**
 * A hotspot as an empty rect (no fill, no line) at its rect, carrying its link; null for a link to nothing (`convert`
 * counts it, `droppedLinks.target`, M5 Task 5), or to a page that is not converted (`droppedLinks.page`).
 */
function lowerHotspot(el: HotspotEl, place: Placement, slideOf?: (page: number) => number | null): OxShape | null {
  const link = linkOf(el.link, slideOf);
  if (link === null) return null;
  const [x0, y0, x1, y1] = el.rect;
  const [ex0, ey0, ex1, ey1] = [placeX(place, x0), placeY(place, y0), placeX(place, x1), placeY(place, y1)];
  const frame = { x: Math.min(ex0, ex1), y: Math.min(ey0, ey1), w: Math.abs(ex1 - ex0), h: Math.abs(ey1 - ey0), rot: 0, flipH: false, flipV: false };
  return { kind: 'shape', name: nodeName(el.id, 'link'), frame, link, geom: { kind: 'rect' }, fill: { kind: 'none' }, line: null };
}

/**
 * Whether a text box writes a character PowerPoint's PDF export draws as a picture in a run (ruling M5-R15): any but a
 * paragraph's bullet (`paragraphBullet`), which it exports as text.
 */
function picturedText(box: OxTextBox): boolean {
  return box.paras.some((para) => {
    const text = para.runs.map((r) => keptText(r.text)).join('');
    const bullet = paragraphBullet(para);
    return hasPictureChar(bullet === null ? text : text.slice(bullet.length));
  });
}

/**
 * A raster fallback's picture (M5 Task 2) as a picture node placed exactly on its box, upright, uncropped and opaque (its
 * alphas are in its pixels), named `fallback`.
 */
function lowerRaster(id: string, picture: NonNullable<PassedFallback['picture']>, place: Placement): OxPicture {
  const [x0, y0, x1, y1] = picture.box;
  const [ex0, ey0, ex1, ey1] = [placeX(place, x0), placeY(place, y0), placeX(place, x1), placeY(place, y1)];
  const frame = { x: ex0, y: ey0, w: ex1 - ex0, h: ey1 - ey0, rot: 0, flipH: false, flipV: false };
  return { kind: 'picture', name: nodeName(id, 'fallback'), frame, link: null, media: picture.mediaHash, srcRect: null, alpha: 100000 };
}

/**
 * A passed slide (`runPasses`) as the writer's slide: its elements in the Scene's order, which is the z-order (S4 reads
 * it). Shapes: `lowerShape`. Pictures: `lowerPicture`, a picture (counted in `pictures`) or the shape of its clip
 * filled with it (in `freeforms`); the media a node names is the picture's own, of the bundle. A text box of text
 * assembly (`AssembledText`, M4 Task 1): `lowerText`, one text box of a paragraph per line, placed by the baseline
 * calibration (`baselineK`) and PowerPoint's measured line pitch (`lineSpacing`) with the deck's fonts (in `textBoxes`;
 * its approximations, the union of its runs', under its first run's id; a run's link, `runLinks`', on the runs made of
 * it). A hotspot: an empty rect with its link; one written on its runs (M5 Task 5) no node, counted `runLinks`. A
 * fallback the raster renderer drew (`PassedFallback.picture`, M5) is a picture on its box, named `fallback`; one it did
 * not draw writes nothing. Each is counted (`fallbacks`, not `pictures`) and listed with its reason. A first element that is the slide's background (`backgroundOf`, ruling M3-R52) is its
 * `background`, not a node, and is not counted. The slide is not changed.
 */
export function lowerSlide(slide: SceneSlide, deck: Pick<SceneDeck, 'fonts'>, ctx: LowerCtx): OxSlide {
  const report = ctx.report ?? null;
  const nodes: OxNode[] = [];
  const shared = sharedAlphaGroups(slide.elements);
  const background = backgroundOf(slide, ctx);
  /** The run links written on runs of the text boxes written (fix round 1): a hotspot written on its runs counts once one is. */
  const runLinks = new Set<HotspotEl['link']>();
  slide.elements.forEach((el, i) => {
    if (i === 0 && background !== null) return;
    const later: Approximation[] = [];
    const record = (written: readonly OxNode[]) => {
      if (report === null || written.length === 0) return;
      for (const kind of [...elementApproximations(el, shared[i]!), ...later]) approximate(report, el.id, kind);
    };
    switch (el.kind) {
      case 'shape': {
        const written = lowerShape(el, {
          place: ctx,
          alpha: groupAlpha(el),
          name: (kind) => nodeName(el.id, kind),
          approximate: (kind) => later.push(kind),
          ...(ctx.reduceStops === undefined ? {} : { reduceStops: ctx.reduceStops }),
        });
        nodes.push(...written);
        record(written);
        if (report !== null) {
          for (const node of written) {
            if (node.kind === 'line') report.counts.lines += 1;
            else if (node.kind === 'shape' && node.geom.kind === 'rect') report.counts.rects += 1;
            else report.counts.freeforms += 1;
            if (node.kind === 'shape' && node.fill?.kind === 'grad') report.counts.gradients += 1;
          }
        }
        break;
      }
      case 'hotspot': {
        // a link written on its runs (`runLinks`, M5 Task 5): no node; a run link where a written run carries it (the
        // hotspots come last, after the text boxes). One no written run carries (its runs not written) is a hotspot again,
        // as before M5, so the link is not lost uncounted (final review Minor 5)
        if ((el as PassedHotspot).onRuns === true && runLinks.has(el.link)) {
          if (report !== null) report.counts.runLinks += 1;
          break;
        }
        const node = lowerHotspot(el, ctx, ctx.slideOf);
        if (node === null) break;
        nodes.push(node);
        if (report !== null) report.counts.hotspots += 1;
        break;
      }
      case 'fallback': {
        const picture = (el as PassedFallback).picture;
        if (picture !== undefined) nodes.push(lowerRaster(el.id, picture, ctx));
        if (report !== null) {
          report.counts.fallbacks += 1;
          listFallback(report, el.id, el.reason, picture === undefined ? undefined : { ...picture.px, pxPerPt: picture.pxPerPt });
        }
        break;
      }
      case 'picture': {
        const node = lowerPicture(el as PassedPicture, {
          place: ctx,
          alpha: groupAlpha(el),
          name: (kind) => nodeName(el.id, kind),
          approximate: (kind) => later.push(kind),
        });
        if (node === null) break;
        nodes.push(node);
        record([node]);
        if (report !== null) {
          if (node.kind === 'picture') report.counts.pictures += 1;
          else report.counts.freeforms += 1;
        }
        break;
      }
      case 'textline': {
        const linked: HotspotEl['link'][] = [];
        const node = lowerText(el, deck.fonts, {
          place: ctx,
          alpha: groupAlpha(el),
          name: (kind) => nodeName(el.id, kind),
          approximate: (kind) => later.push(kind),
          ...(ctx.fontMap === undefined ? {} : { fontMap: ctx.fontMap }),
          link: (link) => {
            const written = linkOf(link, ctx.slideOf);
            if (written !== null) linked.push(link);
            return written;
          },
        });
        if (node === null) break;
        for (const link of linked) runLinks.add(link);
        nodes.push(node);
        record([node]);
        if (report !== null) {
          report.counts.textBoxes += 1;
          // ruling M5-R15: text PowerPoint's own export draws as a picture (an S7 difference, not the converter's), once
          if (picturedText(node) && !report.notes.some((n) => n.detail === EMOJI_PICTURE_NOTE)) {
            report.notes.push({ opIndex: el.provenance.opIndex[0] ?? 0, op: 'text', detail: EMOJI_PICTURE_NOTE });
          }
        }
        break;
      }
    }
  });
  return { nodes, background };
}
