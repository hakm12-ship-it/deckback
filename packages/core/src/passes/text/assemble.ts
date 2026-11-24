import { typefaces } from '../../fonts/typefaces';
import type { Element, FontInfo, SceneSlide, TextLineEl, TextRun } from '../../scene/types';
import { textBoxes } from './boxes';
import { guardBoxes } from './drift';
import { spaceWidths, textLines, type TextLine } from './lines';

export type { Separator, TextLine } from './lines';

/**
 * A text box as text assembly leaves it (M4 Task 1): the element of its first run, which keeps that run's id and place
 * in z-order, and its lines, a paragraph each, of the Scene's text runs (the first line's first run is the element's
 * own). Lowering writes it as one `OxTextBox` (`lowerText`). Its members keep their own ids, run properties and glyphs.
 * `spaceWidths`: the space width of each font of its runs that the slide shows (`spaceWidths`, a share of the em), by
 * which lowering measures a synthetic space (M4b Task 1); a font the slide shows no space of is not in it.
 * `driftSplit`: the drift guard started it (M4b Task 2, `guardBoxes`): lowering records it `text-drift-split`. `kerned`: a
 * line of the box shows kerning, so lowering kerns each of its lines (M8 round 3a, `boxKerning`).
 */
export interface AssembledText extends TextLineEl {
  lines: TextLine[];
  spaceWidths: Readonly<Record<string, number>>;
  driftSplit?: true;
  /** M8 round 3a: a line of the box (before the drift guard split it) shows kerning (`boxKerning`): every line is kerned. */
  kerned?: true;
}

/**
 * The elements with each run of a font whose PostScript name says Italic (`typefaceFamily`, names.ts; a font that is not
 * embedded has no style of its own in FontInfo) as an italic face's: `italic`, so that a shear of 1/3 on it is not taken for
 * PowerPoint's synthetic italic (`runStyle`, M4-R5; final review Minor 5). An element with no such run is returned as it
 * is; the input is not changed.
 */
function withNamedItalics(elements: readonly Element[], fonts: Readonly<Record<string, FontInfo>>): readonly Element[] {
  const named = (run: TextRun): boolean => {
    const font = fonts[run.fontKey];
    return !run.italic && font !== undefined && typefaces(font).named?.italic === true;
  };
  return elements.map((el) =>
    el.kind === 'textline' && el.runs.some(named) ? { ...el, runs: el.runs.map((run) => (named(run) ? { ...run, italic: true } : run)) } : el,
  );
}

/**
 * Text assembly (spec §4.2 pass 7): the slide's text runs as lines (`textLines`: lines.ts, with the deck's `fonts`), the
 * lines as boxes (`textBoxes`: boxes.ts), and the boxes after the drift guard (`guardBoxes`: drift.ts, which predicts
 * each line as lowering writes it at the page's `scale` on the slide, and splits a box where it would leave the PDF by
 * more than 0.5 pt). Each box is one element, `AssembledText`, at its first run's place (the parts of a split box in
 * order); the other runs it holds leave the slide's elements. Every text run is in exactly one box, or in parts of it
 * the guard made. Nothing else changes; the input is not changed. Deterministic: it reads the elements in z-order,
 * their geometry and their fonts' baseline shares.
 */
export function assembleText(slide: SceneSlide, fonts: Readonly<Record<string, FontInfo>> = {}, scale = 1): SceneSlide {
  const elements = withNamedItalics(slide.elements, fonts);
  const widths = spaceWidths(elements, fonts);
  const boxes = textBoxes(elements, textLines(elements, fonts, widths));
  const inBox = new Set<number>();
  for (const box of boxes) for (const line of box) for (let i = line.first; i <= line.last; i++) if (elements[i]!.kind === 'textline') inBox.add(i);
  const at = new Map<number, AssembledText[]>();
  for (const box of guardBoxes(elements, boxes, { spaceWidths: Object.fromEntries(widths), scale })) {
    const own: Record<string, number> = {};
    for (const line of box.lines) {
      for (const el of line.els) {
        for (const run of el.runs) {
          const w = widths.get(run.fontKey);
          if (w !== undefined) own[run.fontKey] = w;
        }
      }
    }
    const head = box.lines[0]!.els[0]!;
    const lines = box.lines.map(({ els, before }) => ({ els: [...els], before: [...before] }));
    const assembled: AssembledText = { ...head, lines, spaceWidths: own, ...(box.split ? { driftSplit: true as const } : {}), ...(box.kerned ? { kerned: true as const } : {}) };
    at.set(box.first, [...(at.get(box.first) ?? []), assembled]);
  }
  const out: Element[] = [];
  elements.forEach((el, i) => {
    const placed = at.get(i);
    if (placed !== undefined) out.push(...placed);
    else if (!inBox.has(i)) out.push(el);
  });
  return { ...slide, elements: out };
}
