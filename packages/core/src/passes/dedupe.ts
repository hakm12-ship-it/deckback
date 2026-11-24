import { canonicalJson } from '../scene/canonical';
import type { Element, SceneSlide } from '../scene/types';

/** An element's canonical JSON without its `id` and `provenance`: what it paints, and how. */
const painted = (el: Element): string => canonicalJson({ ...el, id: undefined, provenance: undefined });

/**
 * Whether painting the element twice looks as painting it once: every alpha involved is 1 (its fill and line, a text
 * run's fill and stroke, a picture's; its groups'), and no soft mask or blend mode other than normal acts on it. Two
 * paints of alpha 0.5 show at 0.75, not 0.5, and a multiply darkens twice. A link paints nothing; a fallback is drawn
 * once in its place. A picture's own pixels may be translucent, which the Scene does not say: such a pair is folded.
 */
function idempotent(el: Element): boolean {
  if (el.mask !== null || el.blend !== 'normal') return false;
  if (el.groups.some((g) => g.alpha !== 1 || g.blend !== 'normal' || g.mask !== null)) return false;
  switch (el.kind) {
    case 'shape':
      return (el.fill === null || el.fill.alpha === 1) && (el.line === null || el.line.paint.alpha === 1);
    case 'textline':
      return el.runs.every((r) => r.alpha === 1 && (r.fill === null || r.fill.alpha === 1) && (r.stroke === null || r.stroke.alpha === 1));
    case 'picture':
      return el.alpha === 1;
    case 'hotspot':
    case 'fallback':
      return true;
  }
}

/** `opIndex` with those of `more` not yet in it appended. */
export function withOps(el: Element, more: readonly number[]): Element {
  const opIndex = [...el.provenance.opIndex, ...more.filter((op) => !el.provenance.opIndex.includes(op))];
  return { ...el, provenance: { ...el.provenance, opIndex } };
}

/**
 * The PDF/A duplicate paints: two consecutive elements of the same kind whose canonical JSON is equal once `id` and
 * `provenance` are left out are one, the first, with the other's ops appended to its `provenance.opIndex`. A run of
 * them is one. Only a paint that looks the same painted twice is folded (`idempotent`): a translucent pair stays two.
 * A new slide; the input is not changed.
 *
 * Linear in the slide (final review F1): a run's ops are gathered in a list and a set as it goes, and its first element
 * is copied once, when the run ends, with all of them (a copy and a scan per fold made a run of k paints cost k²).
 */
export function dedupe(slide: SceneSlide): SceneSlide {
  const elements: Element[] = [];
  let last: string | null = null;
  /** The ops of the run the last element heads, once a paint has been folded into it. */
  let run: { ops: number[]; seen: Set<number> } | null = null;
  const endRun = (): void => {
    if (run === null) return;
    const head = elements[elements.length - 1]!;
    elements[elements.length - 1] = { ...head, provenance: { ...head.provenance, opIndex: run.ops } };
    run = null;
  };
  for (const el of slide.elements) {
    const prev = elements[elements.length - 1];
    if (prev !== undefined && prev.kind === el.kind && idempotent(el)) {
      last ??= painted(prev);
      const json = painted(el);
      if (json === last) {
        run ??= { ops: [...prev.provenance.opIndex], seen: new Set(prev.provenance.opIndex) };
        for (const op of el.provenance.opIndex) {
          if (run.seen.has(op)) continue;
          run.seen.add(op);
          run.ops.push(op);
        }
        continue;
      }
      endRun();
      elements.push(el);
      last = json;
      continue;
    }
    endRun();
    elements.push(el);
    last = null;
  }
  endRun();
  return { ...slide, elements };
}
