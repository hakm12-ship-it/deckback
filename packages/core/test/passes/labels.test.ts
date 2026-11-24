import type { OxTextBox } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import { lowerSlide, runPasses } from '../../src/passes';
import { EMOJI_PICTURE_NOTE, listLabels, type LabelledText } from '../../src/passes/labels';
import type { Element, FontInfo, TextLineEl } from '../../src/scene/types';
import { deckOf, slideOf, snapshot, textline } from '../helpers/passes';

/**
 * Ruling M5-R15 (M5 Task 5 fix round 1): a character PowerPoint's PDF export draws as a picture, first in a paragraph,
 * becomes the paragraph's bullet only when it is the paragraph's list label: tagged, inside a `Lbl` structure element;
 * untagged, followed by a gap wider than one space (no space character) before the first text glyph, a bullet's indent.
 */

/** A Scene run of `text` at baseline y 40 from x0, each glyph `adv` wide (a space 5 pt: the slide's spaces say 0.25 em at 20 pt). */
function word(op: number, text: string, x0: number, adv: number, over: Partial<TextLineEl> = {}): TextLineEl {
  const glyphs = [...text].map((u, k) => ({ u, x: x0 + k * adv, y: 40, adv: u === ' ' ? 5 : adv }));
  let x = x0;
  for (const g of glyphs) [g.x, x] = [x, x + g.adv];
  const base = textline().runs[0]!;
  return textline({ op, baseline: { x: x0, y: 40 }, bboxPt: [x0, 22, x, 45], runs: [{ ...base, text, sizePt: 20, glyphs }], ...over });
}

/** The runs' font: a named face, so the writer has a typeface for a bullet. */
const FONT: FontInfo = { key: 'f1', baseFont: 'Pretendard-Regular', latinName: 'Pretendard', eaName: null, bold: false, italic: false, embedded: false, fsType: null, isVariable: false, type3: false, metrics: null };

const TAG_LBL = ['Sect', 'L', 'LI', 'Lbl'];
const TAG_BODY = ['Sect', 'L', 'LI', 'LBody', 'Span'];
const withTag = (el: TextLineEl, struct: string[] | null): TextLineEl => ({ ...el, provenance: { ...el.provenance, struct } });

function labels(elements: Element[]): string[] {
  const input = slideOf(elements);
  const before = snapshot(input);
  const out = listLabels(input);
  expect(input).toEqual(before); // the input is not changed
  return out.elements.filter((e) => e.kind === 'textline' && (e as LabelledText).label === true).map((e) => e.id);
}

describe('list labels (ruling M5-R15)', () => {
  it('tagged: a character inside a Lbl structure element is a label, whatever the gap; one in a list body is not', () => {
    expect(labels([withTag(word(1, '▶', 20, 20), TAG_LBL), withTag(word(2, 'Level 4', 46, 9), TAG_BODY)])).toEqual(['p1:z1']);
    expect(labels([withTag(word(1, '▶', 20, 20), TAG_BODY), withTag(word(2, 'Level 4', 60, 9), TAG_BODY)])).toEqual([]);
  });

  it('untagged: followed by a gap wider than one space before the first text glyph, a bullet indent, it is a label', () => {
    // atlas text/25 notags: the 24 pt mark ends at 52.2, its text starts at 58.2: 6 pt against a 5 pt space
    expect(labels([word(1, '▶', 20, 20), word(2, 'Level 4', 46, 9)])).toEqual(['p1:z1']);
    // in its own run, its text after a gap in the same run
    const inRun = word(1, '▶Level', 20, 9);
    inRun.runs[0]!.glyphs = inRun.runs[0]!.glyphs.map((g, k) => (k === 0 ? g : { ...g, x: g.x + 8 }));
    expect(labels([inRun])).toEqual(['p1:z1']);
  });

  it("untagged: '✔ Yes' with a space character, a gap of only one space, or nothing after it is content", () => {
    expect(labels([word(1, '✔ Yes', 20, 12)])).toEqual([]);
    expect(labels([word(1, '✔', 20, 12), word(2, ' Yes', 32, 12)])).toEqual([]);
    expect(labels([word(1, '✔', 20, 12), word(2, 'Yes', 37, 12)])).toEqual([]); // 5 pt: one space
    expect(labels([word(1, '✔', 20, 12)])).toEqual([]);
  });

  it('only a character PowerPoint draws as a picture, one unit, on upright text, counts', () => {
    expect(labels([word(1, '■', 20, 20), word(2, 'Level', 60, 9)])).toEqual([]); // drawn as text: never needs it
    expect(labels([word(1, '🇰🇷', 20, 20), word(2, 'Korea', 60, 9)])).toEqual([]); // a flag
    expect(labels([word(1, '▶', 20, 20, { angleDeg: 90 }), word(2, 'Level', 60, 9, { angleDeg: 90 })])).toEqual([]);
  });
});

describe('list labels, lowered', () => {
  /** The slide passed and lowered: its paragraphs' labels and texts, and its notes. */
  function lowered(elements: Element[]) {
    const input = slideOf(elements);
    const deck = { ...deckOf([input]), fonts: { f1: FONT } };
    const { slide, report } = runPasses(input, deck);
    const { nodes } = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
    const paras = nodes.filter((n): n is OxTextBox => n.kind === 'text').flatMap((n) => n.paras.map((p) => [p.label === true, p.runs.map((r) => r.text).join('')]));
    return { paras, notes: report.notes.filter((n) => n.detail === EMOJI_PICTURE_NOTE) };
  }

  it("a label's paragraph is marked a label; no note, as the writer writes the mark as a bullet", () => {
    const { paras, notes } = lowered([withTag(word(1, '▶', 20, 20), TAG_LBL), word(2, 'Level 4', 46, 9)]);
    expect(paras.find(([, t]) => (t as string).startsWith('▶'))![0]).toBe(true);
    expect(notes).toEqual([]);
  });

  it('content keeps its character in the text and the slide notes that PowerPoint exports it as a picture, once', () => {
    const { paras, notes } = lowered([word(1, '✔ Yes', 20, 12), word(3, 'and ❤', 20, 12, { baseline: { x: 20, y: 80 }, bboxPt: [20, 62, 80, 85] })]);
    expect(paras.every(([label]) => label === false)).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ op: 'text', detail: EMOJI_PICTURE_NOTE });
  });
});
