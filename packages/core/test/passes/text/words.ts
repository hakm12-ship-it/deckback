import type { TextLineEl, TextRun } from '../../../src/scene/types';
import { textline } from '../../helpers/passes';

/**
 * Text lines made up for the text assembly tests: a word is one `showText` run, as PowerPoint exports a word, its glyphs
 * each `adv` x size wide (a space glyph `SPACE` x size) along `angleDeg` (clockwise, y down) from its baseline origin; the
 * box of its advances from 0.8 of the size above the baseline to 0.2 below.
 */

/** A space glyph's advance, a share of the size: the fallback width of a space (M4-R1). */
export const SPACE = 0.25;

const advOf = (u: string, adv: number): number => (u === ' ' ? SPACE : adv);

export interface WordOptions {
  op?: number;
  size?: number;
  /** A glyph's advance as a share of the size. */
  adv?: number;
  angleDeg?: number;
  fontKey?: string;
  struct?: string[] | null;
  mcid?: number | null;
  run?: Partial<TextRun>;
  el?: Partial<TextLineEl>;
}

/** Where a word's advances end along its line, from its origin: its glyphs' advances. */
export const wordWidth = (text: string, size = 12, adv = 0.5): number => [...text].reduce((w, u) => w + advOf(u, adv) * size, 0);

export function word(text: string, x: number, y: number, o: WordOptions = {}): TextLineEl {
  const size = o.size ?? 12;
  const t = ((o.angleDeg ?? 0) * Math.PI) / 180;
  const [c, s] = [Math.cos(t), Math.sin(t)];
  let at = 0;
  const glyphs = [...text].map((u) => {
    const adv = advOf(u, o.adv ?? 0.5) * size;
    const g = { u, x: x + at * c, y: y + at * s, adv };
    at += adv;
    return g;
  });
  const end = [x + at * c, y + at * s];
  // the box of the advances: along the line from the origin to the end, across from 0.8 size above to 0.2 below
  const corners = [
    [x, y],
    [end[0]!, end[1]!],
  ].flatMap(([px, py]) => [
    [px! + 0.8 * size * s, py! - 0.8 * size * c],
    [px! - 0.2 * size * s, py! + 0.2 * size * c],
  ]);
  const xs = corners.map((p) => p[0]!);
  const ys = corners.map((p) => p[1]!);
  const base = textline({ op: o.op });
  return {
    ...base,
    provenance: { ...base.provenance, struct: o.struct ?? null, mcid: o.mcid ?? null },
    runs: [{ ...base.runs[0]!, text, fontKey: o.fontKey ?? 'f1', sizePt: size, glyphs, ...o.run }],
    baseline: { x, y },
    angleDeg: o.angleDeg ?? 0,
    bboxPt: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)],
    ...o.el,
  };
}

/** Words left to right on one baseline from `x`, each `gap` (a share of the size) after the last one's advances end. */
export function words(texts: string[], x: number, y: number, gap: number, o: WordOptions = {}): TextLineEl[] {
  const out: TextLineEl[] = [];
  let at = x;
  for (const text of texts) {
    out.push(word(text, at, y, o));
    at += wordWidth(text, o.size, o.adv) + gap * (o.size ?? 12);
  }
  return out;
}

/** A tagged paragraph's struct path, as PowerPoint tags a text box's paragraph. */
export const P_SPAN = ['Sect', 'Sect', 'P', 'Span'];
