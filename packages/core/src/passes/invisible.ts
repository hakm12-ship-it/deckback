import type { Box } from '../extract/inventory';
import type { Element, LineStyle, PictureEl, SceneSlide, ShapeEl } from '../scene/types';

/** The product of the alphas of the transparency groups `el` is drawn in. */
export const groupAlpha = (el: Element): number => el.groups.reduce((a, g) => a * g.alpha, 1);

/** Whether a shape paints: a fill or a line whose alpha, its groups' included, is above 0. */
export function paints(shape: ShapeEl): boolean {
  const g = groupAlpha(shape);
  return (shape.fill !== null && shape.fill.alpha * g > 0) || (shape.line !== null && shape.line.paint.alpha * g > 0);
}

/** How far a stroke reaches past its path: half the width, times the miter limit at a miter join, √2 at a square cap. */
export function strokeReach(line: LineStyle): number {
  const join = line.join === 'miter' ? Math.max(1, line.miter) : 1;
  const cap = line.cap === 'square' ? Math.SQRT2 : 1;
  return (line.w / 2) * Math.max(join, cap);
}

/** The box a picture's unit square lands on. */
export function pictureBox(pic: PictureEl): Box {
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = pic.matrix;
  const xs = [e, a + e, c + e, a + c + e];
  const ys = [f, b + f, d + f, b + d + f];
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * The box an element paints in before its clip, a stroke's reach included (`reach`: at most `strokeReach`, which
 * bounds it; a measure of the box itself rather takes half the width); a fallback without a box: its clip box.
 */
export function paintBox(el: Element, reach: (line: LineStyle) => number = strokeReach): Box {
  switch (el.kind) {
    case 'shape': {
      const r = el.geom !== null && el.line !== null ? reach(el.line) : 0;
      return [el.bbox[0] - r, el.bbox[1] - r, el.bbox[2] + r, el.bbox[3] + r];
    }
    case 'textline':
      return el.bboxPt;
    case 'picture':
      return pictureBox(el);
    case 'hotspot':
      return el.rect;
    case 'fallback':
      return el.bbox ?? el.clipBox;
  }
}

/** The common part of two boxes, null when they have none (touching boxes share an edge). */
export function intersect(a: Box, b: Box): Box | null {
  const box: Box = [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
  return box[0] > box[2] || box[1] > box[3] ? null : box;
}

const area = (b: Box): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/** Whether a box lies entirely outside the page `[0, 0, w, h]` (on its edge counts as outside). */
const outside = (b: Box, [w, h]: readonly [number, number]): boolean => b[2] <= 0 || b[0] >= w || b[3] <= 0 || b[1] >= h;

/** Whether box `b` lies entirely outside box `view` (on its edge counts as outside). */
const outsideBox = (b: Box, view: Box): boolean => b[2] <= view[0] || b[0] >= view[2] || b[3] <= view[1] || b[1] >= view[3];

/**
 * Text that paints nothing: painted in no way (Tr 3), or (M8 round 1a) filled and stroked only at alpha 0, its groups'
 * alpha included (PowerPoint exports WordArt's text and a link's so, ca 0). Kept as editable text, so its clip does not
 * matter (spec §6).
 */
const invisibleText = (el: Element): boolean => {
  if (el.kind !== 'textline') return false;
  const g = groupAlpha(el);
  return el.runs.every((r) => {
    if (r.fillMode === 'noFill') return true;
    if (r.fillMode === 'clip') return false;
    const fills = (r.fillMode === 'fill' || r.fillMode === 'fillStroke') && r.alpha * g > 0;
    const strokes = (r.fillMode === 'stroke' || r.fillMode === 'fillStroke') && (r.stroke === null || r.stroke.alpha * g > 0);
    return !fills && !strokes;
  });
};

/**
 * Whether an element lies wholly outside the page with a box of its own (M8 round 1a): a shape with a path, a text line
 * or a picture whose paint box (`paintBox`) does not reach onto the page. Nothing of it shows on the page, whatever its
 * clips, and nothing of it would on the slide, where it lies past the edge as the page's box clips it (with `view`,
 * the slide's box in the page's frame, nothing of it reaches onto the slide either). An `sh` has no box of its own (its
 * clip's), a link and a fallback none that paints.
 */
export function offPage(el: Element, sizePt: readonly [number, number], view: Box = [0, 0, sizePt[0], sizePt[1]]): boolean {
  if (!((el.kind === 'shape' && el.geom !== null) || el.kind === 'textline' || el.kind === 'picture')) return false;
  const box = paintBox(el);
  return outside(box, sizePt) && outsideBox(box, view);
}

/**
 * The most elements wholly outside the page that a slide keeps (M8 round 1 review M10): nothing of them shows, so a page
 * with very many (a hostile or generated one) must not cost as much as its visible content. The first of them in
 * z-order stay; the rest are dropped, and the slide has the note `OFF_PAGE_CAP_NOTE`.
 */
export const OFF_PAGE_MAX = 5000;
export const OFF_PAGE_CAP_NOTE = 'off-page elements past the cap dropped';

/**
 * Drops what paints nothing on the page:
 * - a shape whose fill and line are both absent or of alpha 0 (its groups' alpha included);
 * - an element whose clip box has no area;
 * - an element entirely outside the page, or outside its clip box: its paint box (`paintBox`) within its clip box does
 *   not reach onto the page.
 *
 * But (M8 round 1a) a shape with a path, a text line or a picture wholly outside the page (`offPage`) stays, where it
 * is: PowerPoint keeps a shape past the slide's edge and exports it so, within a clip of the page's box (or of a box of
 * 0.0001 pt at its corner, for a picture), and the source decks have them. It shows nothing on the slide, as it showed
 * nothing on the page. One that is past the page but would land on the slide (`view`: the slide's box in the page's
 * frame, which a page of another size, centred on the slide, does not fill) is dropped, as it would show there. What
 * the page shows of an element partly on it is as before: a clip that hides that part still drops it.
 *
 * Text painted in no way (`noFill`) is editable invisible text and stays whatever its clips (spec §6), on the page or,
 * as above, past the page and the slide. A new slide; the input is not changed.
 */
export function dropInvisible(slide: SceneSlide, view?: Box): SceneSlide {
  let kept = 0;
  let capped = false;
  const elements = slide.elements.filter((el) => {
    if (el.kind === 'shape' && !paints(el)) return false;
    if (offPage(el, slide.sizePt, view)) {
      if (kept < OFF_PAGE_MAX) {
        kept++;
        return true;
      }
      capped = true; // M8 I-M10: nothing shows of it; past the cap it costs more than it keeps
      return false;
    }
    if (invisibleText(el)) return !outside(paintBox(el), slide.sizePt);
    if (area(el.clipBox) === 0) return false;
    const seen = intersect(paintBox(el), el.clipBox);
    return seen !== null && !outside(seen, slide.sizePt);
  });
  if (!capped) return { ...slide, elements };
  return { ...slide, elements, notes: [...slide.notes, { opIndex: 0, op: 'invisible', detail: OFF_PAGE_CAP_NOTE }] };
}
