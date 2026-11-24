import { canonicalJson } from '../scene/canonical';
import type { Element, SceneSlide, ShapeEl } from '../scene/types';
import { withOps } from './dedupe';
import type { PassedShape } from './index';

/** What must be equal for a fill and a stroke to be one shape: the path and everything it is drawn in. */
const drawnAs = (s: ShapeEl): string => canonicalJson([s.geom, s.clip, s.groups, s.mask, s.blend]);

const fillOnly = (el: Element): el is ShapeEl => el.kind === 'shape' && el.geom !== null && el.fill !== null && el.line === null;
const strokeOnly = (el: Element): el is ShapeEl => el.kind === 'shape' && el.geom !== null && el.fill === null && el.line !== null;

/** The fill shape `fill` with the stroke's line, and what either only approximates (each once, the fill's first). */
function merged(fill: PassedShape, stroke: PassedShape): PassedShape {
  const { approximations: _, ...rest } = fill;
  const all = [...new Set([...(fill.approximations ?? []), ...(stroke.approximations ?? [])])];
  return { ...rest, line: stroke.line, ...(all.length > 0 ? { approximations: all } : {}) };
}

/**
 * A filled shape followed at once by a stroked shape with the same `geom`, `clip`, `groups`, `mask` and `blend` is one
 * shape with both its fill and its line: the first, with the second's ops appended to its `provenance.opIndex`. What
 * either only approximates of its clips (`PassedShape.approximations`, after the clip pass) stays with it, the union.
 * A new slide; the input is not changed.
 */
export function mergeFillStroke(slide: SceneSlide): SceneSlide {
  const elements: Element[] = [];
  for (const el of slide.elements) {
    const prev = elements[elements.length - 1];
    if (prev !== undefined && fillOnly(prev) && strokeOnly(el) && drawnAs(prev) === drawnAs(el)) {
      elements[elements.length - 1] = withOps(merged(prev, el), el.provenance.opIndex);
      continue;
    }
    elements.push(el);
  }
  return { ...slide, elements };
}
