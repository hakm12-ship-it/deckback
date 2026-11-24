import type { OxNode, OxTextBox } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import { APPROXIMATIONS, lowerSlide, runPasses, type LowerCtx } from '../../../src/passes';
import { baselineK } from '../../../src/passes/baseline';
import type { SlideReport } from '../../../src/passes/report';
import { DRIFT_TOL_PT, GRID_SPACE_PT, lineDrift, MAX_DRIFT_CUTS } from '../../../src/passes/text/drift';
import type { Element, FontInfo, SceneDeck, TextLineEl, TextRun } from '../../../src/scene/types';
import { deckOf, rectPath, shape, slideOf, textline } from '../../helpers/passes';

/**
 * The drift guard (M4b Task 2): each glyph's residual along its line, the PDF's origin less the one predicted from what
 * lowering writes, and a box split where it is more than 0.5 pt (`DRIFT_TOL_PT`).
 */

const PT = 12700;
const CTX: LowerCtx = { page: 1, scale: 1, offset: [0, 0] };
const FONT: FontInfo = {
  key: 'f1',
  baseFont: 'ABCDEF+Unlisted-Regular',
  latinName: 'Unlisted Sans',
  eaName: null,
  bold: false,
  italic: false,
  embedded: true,
  fsType: 0,
  isVariable: false,
  type3: false,
  metrics: null,
};
const FONTS = { f1: FONT };

interface LineOptions {
  op?: number;
  x?: number;
  y?: number;
  deg?: number;
  sizePt?: number;
  spcPt?: number;
  wmode?: 0 | 1;
  /** Each glyph's advance (pt; Tc in it): 10 when absent. */
  adv?: number;
  struct?: string[] | null;
  run?: Partial<TextRun>;
}

/**
 * A one-run line of `text` from (`x`, `y`) along `deg`: each glyph `adv` pt wide (Tc `spcPt` in it), each next glyph
 * `gaps[i]` pt past the last one's advance.
 */
function line(text: string, gaps: number[], o: LineOptions = {}): TextLineEl {
  const t = ((o.deg ?? 0) * Math.PI) / 180;
  const [x0, y0, adv] = [o.x ?? 20, o.y ?? 40, o.adv ?? 10];
  let along = 0;
  const glyphs = [...text].map((u, i) => {
    const g = { u, x: x0 + along * Math.cos(t), y: y0 + along * Math.sin(t), adv };
    along += adv + (gaps[i] ?? 0);
    return g;
  });
  const base = textline({ op: o.op ?? 3 });
  const run: TextRun = { ...base.runs[0]!, text, glyphs, spcPt: o.spcPt ?? 0, sizePt: o.sizePt ?? 12, ...o.run };
  const ends = [x0 + along * Math.cos(t), y0 + along * Math.sin(t)];
  return {
    ...base,
    provenance: { ...base.provenance, struct: o.struct ?? null },
    runs: [run],
    baseline: { x: x0, y: y0 },
    angleDeg: o.deg ?? 0,
    wmode: o.wmode ?? 0,
    bboxPt: [Math.min(x0, ends[0]!), Math.min(y0, ends[1]!) - 10, Math.max(x0, ends[0]!), Math.max(y0, ends[1]!) + 3],
  };
}

/** One line of one member, as `lineDrift` takes it. */
const one = (el: TextLineEl) => ({ els: [el], before: ['none' as const] });

/** Runs the passes over the elements and lowers the slide. */
function lower(elements: Element[]): { nodes: OxTextBox[]; report: SlideReport } {
  const input = slideOf(elements);
  const deck: SceneDeck = { ...deckOf([input]), fonts: FONTS };
  const { slide, report } = runPasses(input, deck);
  const nodes: OxNode[] = lowerSlide(slide, deck, { ...CTX, report }).nodes;
  return { nodes: nodes as OxTextBox[], report };
}

const texts = (nodes: OxTextBox[]): string[] => nodes.map((n) => n.paras.map((p) => p.runs.map((r) => r.text).join('')).join('|'));

/** Where an upright box puts its first glyph's origin: its left edge and its first paragraph's margin, k x size down. */
const originOf = (b: OxTextBox, size = 12): [number, number] => [(b.frame.x + b.paras[0]!.marL) / PT, b.frame.y / PT + baselineK(FONT).k * size];

describe('lineDrift', () => {
  it('an exact line: every glyph where the PDF has it; blank glyphs are not measured', () => {
    expect(DRIFT_TOL_PT).toBe(0.5);
    const r = lineDrift(one(line('ab cd ef', [])), { spaceWidths: {} });
    expect(r.map((v) => (Number.isNaN(v) ? null : v))).toEqual([0, 0, null, 0, 0, null, 0, 0]);
  });

  it('a space PowerPoint will not put back: Korean letters with Tc written as spc, their spaces short (atlas/text/23)', () => {
    // 12 pt, Tc 0.05 written as spc 5; each space 0.3 pt short of the font's space and that spc
    const r = lineDrift(one(line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05 })), { spaceWidths: {} });
    expect(r.map((v) => (Number.isNaN(v) ? null : Math.round(v * 1000) / 1000))).toEqual([0, 0, null, -0.3, -0.3, null, -0.6, -0.6]);
  });

  it("Review Focus 1: a title whose spaces PowerPoint's grid shortens, letters written with no spacing, has no residual", () => {
    // 20 pt drawn at 20.064 (M4-R4): the letters 10 pt there, so 9.968 at 20; every space 0.35 pt short
    const title = line('WAVE Tower AV Tower AV', [0, 0, 0, -0.35, 0, 0, 0, 0, -0.35, 0, -0.35, 0, 0, 0, 0, -0.35, 0], { sizePt: 20.064 });
    const r = lineDrift(one(title), { spaceWidths: {} }).filter((v) => !Number.isNaN(v));
    expect(Math.max(...r.map(Math.abs))).toBeLessThan(DRIFT_TOL_PT);
  });

  it('Review Focus 2: a line written with template kern whose pair offsets add up past 0.5 pt has no residual', () => {
    // 24 pt: four pairs kerned by -0.9 to -1.8 pt, each within 0.1 x size, 5.4 pt in all; the others not kerned
    const kerned = line('AVAToTxyzw', [-1.5, -1.2, -1.8, -0.9, 0, 0, 0, 0, 0], { sizePt: 24 });
    const r = lineDrift(one(kerned), { spaceWidths: {} }).filter((v) => !Number.isNaN(v));
    expect(r.every((v) => Math.abs(v) < 1e-9)).toBe(true);
  });

  it('Review Focus 4: a rotated line is measured along its own direction; vertical writing is not measured', () => {
    const turned = line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05, deg: 30 });
    const r = lineDrift(one(turned), { spaceWidths: {} });
    expect(Math.round(r.at(-1)! * 1000) / 1000).toBe(-0.6);
    const vertical = line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05, deg: 90, wmode: 1 });
    expect(lineDrift(one(vertical), { spaceWidths: {} }).every(Number.isNaN)).toBe(true);
  });

  it("Task 2 review Minor 1: an offset of the floor's size, computed a hair under it, is not grid noise (the other thresholds' EPS)", () => {
    // (10 pt: under the size the template kerns, M8 round 2a K1's grid allowance below does not apply)
    const at = (gap: number) => lineDrift(one(line('ab', [gap], { sizePt: 10 })), { spaceWidths: {} })[1]!;
    expect(at(0.1 - 1e-9)).toBeCloseTo(0.1, 6);
    expect(at(0.09)).toBe(0);
  });

  it("M8 round 2a (K1): in a run written kern=\"0\" at 12 pt or more, an offset up to KERN_PAIR_PT is the grid K1 reads it as", () => {
    // atlas/text/18: a justified line's words each 0.12-0.14 pt short at one pair, once kerned, now kern="0"; counted, the
    // guard split the line once (its V1 line 149 -> 160 px)
    const at = (gap: number) => lineDrift(one(line('abcd', [0, 0, gap])), { spaceWidths: {} })[3]!;
    expect(at(-0.15)).toBe(0);
    expect(at(0.2)).toBe(0);
    // more is no grid (a gap of 1.5 pt is no kerning either)
    expect(at(1.5)).toBeCloseTo(1.5, 6);
  });

  it("Task 2 review Minor 3: at a page scale other than 1 the size and the spacing are as lowering rounds them after it", () => {
    // Tc 0.05 is spc 5 at scale 1 and whole(2.5) = 3 at 0.5: 0.06 pt a glyph on the page's own scale, 0.01 pt more than the PDF's
    const gaps = [0, 0, -0.3, 0, 0, -0.3, 0];
    const at = (scale: number) => lineDrift(one(line('ab cd ef', gaps, { spcPt: 0.05 })), { spaceWidths: {}, scale }).map((v) => (Number.isNaN(v) ? null : v));
    expect(at(1)).toEqual([0, 0, null, expect.closeTo(-0.3, 6), expect.closeTo(-0.3, 6), null, expect.closeTo(-0.6, 6), expect.closeTo(-0.6, 6)]);
    expect(at(0.5)).toEqual([0, 0, null, expect.closeTo(-0.31, 6), expect.closeTo(-0.31, 6), null, expect.closeTo(-0.62, 6), expect.closeTo(-0.62, 6)]);
  });

  it('no widths, no prediction: a run whose glyphs have no advance', () => {
    const glyphless = line('ab cd', [3, 3, 3, 3], { adv: 0 });
    expect(lineDrift(one(glyphless), { spaceWidths: {} }).filter((v) => !Number.isNaN(v))).toEqual([0, 0, 0, 0]);
  });

  it("M8 round 2a (G1): a line's one space up to GRID_SPACE_PT off is not written, and is PowerPoint's grid: no residual", () => {
    const one = (gap: number) => lineDrift({ els: [line('ab cd ef', [0, 0, gap, 0, 0, 0, 0])], before: ['none'] }, { spaceWidths: {} }).at(-1)!;
    expect(one(0.6)).toBe(0);
    expect(one(0.7)).toBe(0);
    // past it the space is a wide space, written: predicted, no residual either
    expect(one(0.8)).toBeCloseTo(0, 6);
  });

  it("a space of a run with no spacing is PowerPoint's own grid up to GRID_SPACE_PT, as measured; past it, drift", () => {
    expect(GRID_SPACE_PT).toBe(0.7);
    // two spaces that net under the M4b-R1 gate, so neither is written: the first as given, the second against it
    const at = (gap: number, back: number) => lineDrift(one(line('ab cd ef', [0, 0, gap, 0, 0, back, 0])), { spaceWidths: {} }).at(-1)!;
    expect(at(0.6, -0.3)).toBe(0);
    expect(at(-0.7, 0.4)).toBe(0);
    expect(Math.round(at(0.8, -0.5) * 1000) / 1000).toBe(0.8);
  });
});

describe('M8 round 2a: the guard predicts kerned runs as written (K2, K3)', () => {
  it("K2: a kerned run whose spc is its unkerned pairs' level has no residual: PowerPoint kerns the others", () => {
    // tier B's "DATA" at 24 pt: written spc 0 with the template's kern, A-T and T-A PowerPoint's kerning
    const data = line('DATA', [0.017, -1.906, -1.835], { sizePt: 24 });
    expect(lineDrift(one(data), { spaceWidths: {} }).every((v) => Math.abs(v) < 0.1)).toBe(true);
  });

  it('K3: a space PowerPoint kerns with the glyph after it, in a kerned run, has no residual', () => {
    // 20 pt, A-T kerned, the space before A 0.76 pt short: kerning, not drift (it was a wide space, written twice)
    const kerned = line('GE ARTE', [0, 0, -0.76, 0, -1.3, 0], { sizePt: 20 });
    expect(lineDrift(one(kerned), { spaceWidths: {} }).filter((v) => !Number.isNaN(v)).every((v) => Math.abs(v) < 1e-9)).toBe(true);
    // before a glyph that does not kern with the space: it is a wide space, written, so no residual either
    const wide = line('GE BRTE', [0, 0, -0.76, 0, -1.3, 0], { sizePt: 20 });
    expect(lineDrift(one(wide), { spaceWidths: {} }).filter((v) => !Number.isNaN(v)).every((v) => Math.abs(v) < 1e-9)).toBe(true);
  });

  it("K2: a run written kern=\"0\" with each kerned pair on its own is predicted exactly", () => {
    const title = line('Summary', [-1.05, -0.85, -1.48, -1.52, -1.1, -1.11], { sizePt: 28 });
    expect(lineDrift(one(title), { spaceWidths: {} }).every((v) => Math.abs(v) < 0.1)).toBe(true);
  });
});

describe('the guard: a box split where the residual passes 0.5 pt', () => {
  it('an exact line is one box', () => {
    const { nodes, report } = lower([line('ab cd ef', [])]);
    expect(texts(nodes)).toEqual(['ab cd ef']);
    expect(report.approximations).toEqual([]);
  });

  it('a tail 0.6 pt off splits at the word boundary before it, the new box at its PDF origin; 0.45 pt does not', () => {
    const drifting = line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05 });
    const { nodes, report } = lower([drifting]);
    expect(texts(nodes)).toEqual(['ab cd ', 'ef']);
    const e = drifting.runs[0]!.glyphs[6]!;
    const [x, y] = originOf(nodes[1]!);
    expect(x).toBeCloseTo(e.x, 3);
    expect(y).toBeCloseTo(e.y, 2);
    // the new box is a piece of the run: its own id after the op's, its own name, recorded text-drift-split
    expect(nodes.map((n) => n.name)).toEqual([`pdf:${drifting.id} text`, `pdf:${drifting.id} text 1`]);
    expect(report.approximations).toEqual([{ id: `${drifting.id}:1`, kind: 'text-drift-split' }]);
    expect(report.counts.textBoxes).toBe(2);
    expect(APPROXIMATIONS).toContain('text-drift-split');
    // 0.45 pt by the line's end is under the guard
    expect(texts(lower([line('ab cd ef', [0, 0, -0.225, 0, 0, -0.225, 0], { spcPt: 0.05 })]).nodes)).toEqual(['ab cd ef']);
  });

  it('a word that drifts with no boundary before it splits at the glyph itself', () => {
    // one word at 12 pt, one pair 1.5 pt apart: more than kerning (0.1 x size), so the rest of the word is a box
    const word = line('abcdef', [0, 0, 0, 1.5, 0]);
    const { nodes } = lower([word]);
    expect(texts(nodes)).toEqual(['abcd', 'ef']);
  });

  it('Task 1 review Minor 4: a wide space the M4b-R1 gate nets away (+0.8 and -0.4 pt) is split at', () => {
    // a run with no spacing: +0.8 then -0.4, 0.4 in all, under the gate, so neither is written
    const gated = line('ab cd ef', [0, 0, 0.8, 0, 0, -0.4, 0]);
    const { nodes } = lower([gated]);
    expect(texts(nodes)).toEqual(['ab ', 'cd ef']);
    const c = gated.runs[0]!.glyphs[3]!;
    expect(originOf(nodes[1]!)[0]).toBeCloseTo(c.x, 3);
  });

  it("final review Minor 1: one wide space written takes nothing from the grid allowance of the same run's other, short spaces", () => {
    // a title: letters with no spacing, one space +2 pt (written, M4b-R1), three spaces 0.32 pt short that PowerPoint's
    // grid shortens again: nothing drifts, the title is one box
    const title = line('ab cd ef gh ij', [0, 0, 2, 0, 0, -0.32, 0, 0, -0.32, 0, 0, -0.32, 0], { sizePt: 20.064 });
    expect(lineDrift(one(title), { spaceWidths: {} }).filter((v) => !Number.isNaN(v) && Math.abs(v) > DRIFT_TOL_PT)).toEqual([]);
    expect(texts(lower([title]).nodes)).toEqual(['ab cd ef gh ij']);
  });

  it('Review Focus 1, 2 and 4 in the pass: a title, a kerned line and a vertical line are not split', () => {
    const title = line('WAVE Tower AV Tower AV', [0, 0, 0, -0.35, 0, 0, 0, 0, -0.35, 0, -0.35, 0, 0, 0, 0, -0.35, 0], { sizePt: 20.064 });
    expect(texts(lower([title]).nodes)).toEqual(['WAVE Tower AV Tower AV']);
    const kerned = line('AVAToTxyzw', [-1.5, -1.2, -1.8, -0.9, 0, 0, 0, 0, 0], { sizePt: 24 });
    expect(texts(lower([kerned]).nodes)).toEqual(['AVAToTxyzw']);
    const vertical = line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05, deg: 90, wmode: 1 });
    expect(texts(lower([vertical]).nodes)).toEqual(['ab cd ef']);
  });

  it('a rotated line splits along its own direction, the new box at its PDF origin', () => {
    const turned = line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05, deg: 30 });
    const { nodes } = lower([turned]);
    expect(texts(nodes)).toEqual(['ab cd ', 'ef']);
    expect(nodes[1]!.frame.rot).toBe(30 * 60000);
  });

  it("a rotated split puts the new box at the glyph's PDF origin, turned about the box's own centre", () => {
    const turned = line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05, deg: 30 });
    const box = lower([turned]).nodes[1]!;
    const { x, y, w, h } = box.frame;
    const [dx, dy] = [box.paras[0]!.marL + 0 - w / 2, baselineK(FONT).k * 12 * PT - h / 2];
    const t = (30 * Math.PI) / 180;
    const origin = [(x + w / 2 + dx * Math.cos(t) - dy * Math.sin(t)) / PT, (y + h / 2 + dx * Math.sin(t) + dy * Math.cos(t)) / PT];
    const e = turned.runs[0]!.glyphs[6]!;
    expect(origin[0]).toBeCloseTo(e.x, 2);
    expect(origin[1]).toBeCloseTo(e.y, 2);
  });

  it('a cut inside a member of several runs: the first part keeps the id and the runs before the cut, the rest is a run of its own', () => {
    // one member of two runs, the second Tc 0.05 and set as the drifting line is: the cut is at its glyph 6, not at a member
    const first = line('ab cd', [], { op: 3 });
    const second = line(' ef gh ij', [0, 0, 0, -0.3, 0, 0, -0.3, 0, 0], { op: 4, x: 20 + 50, spcPt: 0.05 });
    const member: TextLineEl = { ...first, runs: [first.runs[0]!, second.runs[0]!], bboxPt: [20, 30, 160, 43] };
    const { nodes, report } = lower([member]);
    expect(texts(nodes)).toEqual(['ab cd ef gh ', 'ij']);
    const i = second.runs[0]!.glyphs[7]!;
    expect(originOf(nodes[1]!)[0]).toBeCloseTo(i.x, 3);
    expect(nodes.map((n) => n.name)).toEqual([`pdf:${member.id} text`, `pdf:${member.id} text 1`]);
    expect(report.approximations).toEqual([{ id: `${member.id}:1`, kind: 'text-drift-split' }]);
  });

  it('a cut inside a member that follows a synthetic space: the space and the runs before the cut stay with the first part', () => {
    const P = { spcPt: 0.05 };
    const head = line('ab', [0], { ...P, op: 3 });
    const a = line('cd', [0], { ...P, op: 4, x: 20 + 20 + 9.7 });
    const b = line('ef gh ij', [0, 0, -0.3, 0, 0, -0.3, 0, 0], { ...P, op: 4, x: 20 + 20 + 9.7 + 20 });
    const member: TextLineEl = { ...a, runs: [a.runs[0]!, b.runs[0]!], bboxPt: [49.7, 30, 160, 43] };
    const lone = line('x y', [0, 0], { op: 6, y: 120 });
    const { nodes, report } = lower([head, member, lone]);
    // the synthetic space (0.3 pt short) and the space after 'ef' (0.3 pt short) put 'gh' 0.6 pt off: the cut is at its word
    expect(texts(nodes)).toEqual(['ab cdef ', 'gh ij', 'x y']);
    expect(originOf(nodes[1]!)[0]).toBeCloseTo(b.runs[0]!.glyphs[3]!.x, 3);
    expect(report.approximations).toEqual([{ id: `${member.id}:1`, kind: 'text-drift-split' }]);
  });

  it('Task 2 review Minor 5: a cut before the first kept run of a member whose leading runs are dropped is a member boundary: the id is kept', () => {
    // 'cdef' follows 'ab' with one synthetic space; its first run (empty, size 0) is not written, and 'e' is 1.5 pt off
    const head = line('ab', [0], { op: 3 });
    const kept = line('cdef', [0, 1.5, 0], { op: 4, x: 20 + 20 + 10 });
    const member: TextLineEl = { ...kept, runs: [{ ...kept.runs[0]!, text: '', glyphs: [], sizePt: 0 }, kept.runs[0]!] };
    const lone = line('x y', [0, 0], { op: 6, y: 120 });
    const { nodes, report } = lower([head, member, lone]);
    expect(texts(nodes)).toEqual(['ab', 'cd', 'ef', 'x y']);
    // 'cd' is the member's own element; only 'ef', a piece of its run, is a new one
    expect(nodes.map((n) => n.name)).toEqual([`pdf:${head.id} text`, `pdf:${member.id} text`, `pdf:${member.id} text 1`, `pdf:${lone.id} text`]);
    expect(report.approximations).toEqual([{ id: member.id, kind: 'text-drift-split' }, { id: `${member.id}:1`, kind: 'text-drift-split' }]);
  });

  it("Task 2 review Minor 3: a new id is the op's next free `:n`: with `:1` taken, the piece is `:2`", () => {
    const drifting = line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05 });
    const taken: TextLineEl = { ...line('zz', [], { op: 3, y: 150 }), id: `${drifting.id}:1` };
    const { nodes, report } = lower([drifting, taken]);
    expect(nodes.map((n) => n.name)).toEqual([`pdf:${drifting.id} text`, `pdf:${drifting.id} text 2`, `pdf:${drifting.id} text 1`]);
    expect(report.approximations).toEqual([{ id: `${drifting.id}:2`, kind: 'text-drift-split' }]);
  });

  it('Task 2 review Minor 3: the parts of a split sit at the place of their first run in z-order, with what lies between the runs after them', () => {
    const P = { spcPt: 0.05 };
    const words = [line('ab', [0], { ...P, op: 3 }), line('cd', [0], { ...P, op: 5, x: 20 + 20 + 9.7 }), line('ef', [0], { ...P, op: 6, x: 20 + 20 + 9.7 + 20 + 9.7 })];
    words.push(line('x y', [0, 0], { op: 7, y: 120 }));
    const under = shape({ op: 4, geom: rectPath(200, 150, 10, 10) });
    const { nodes } = lower([words[0]!, under, ...words.slice(1)]);
    // 'ab cd' is the first part at its first run, the rectangle follows it, the part 'ef' starts at its own run
    expect(nodes.map((n) => (n.kind === 'text' ? texts([n as OxTextBox])[0] : n.kind))).toEqual(['ab cd', 'shape', 'ef', 'x y']);
    // a split within one run: both parts at that run's place, in order, the rectangle after them
    const drifting = line('ab cd ef', [0, 0, -0.3, 0, 0, -0.3, 0], { spcPt: 0.05, op: 3 });
    const after = lower([drifting, shape({ op: 4, geom: rectPath(200, 150, 10, 10) })]).nodes;
    expect(after.map((n) => (n.kind === 'text' ? texts([n as OxTextBox])[0] : n.kind))).toEqual(['ab cd ', 'ef', 'shape']);
  });

  it('words joined with synthetic spaces split at the synthetic space before the drift, the next word its own box', () => {
    // a word per run (PowerPoint's export), Tc 0.05 written as spc; the slide shows the font's space (10 pt at 12 pt)
    const P = { spcPt: 0.05 };
    const words = [line('ab', [0], { ...P, op: 3 }), line('cd', [0], { ...P, op: 4, x: 20 + 20 + 9.7 }), line('ef', [0], { ...P, op: 5, x: 20 + 20 + 9.7 + 20 + 9.7 })];
    words.push(line('x y', [0, 0], { op: 6, y: 120 }));
    const { nodes, report } = lower(words);
    expect(texts(nodes)).toEqual(['ab cd', 'ef', 'x y']);
    // the new box is the next word's own element: its id, recorded once
    expect(nodes[1]!.name).toBe(`pdf:${words[2]!.id} text`);
    expect(report.approximations).toEqual([{ id: words[2]!.id, kind: 'text-drift-split' }]);
  });

  it('a line is cut at most MAX_DRIFT_CUTS times', () => {
    expect(MAX_DRIFT_CUTS).toBe(64);
    // 200 words of 2 glyphs, Tc 0.05 written as spc, each space 0.3 pt short (under the wide space): a cut at every
    // other word, 99 of them without the cap
    const text = Array.from({ length: 200 }, () => 'ab').join(' ');
    const gaps = [...text].map((u) => (u === ' ' ? -0.3 : 0));
    const long = line(text, gaps, { spcPt: 0.05, x: 0 });
    const { nodes, report } = lower([long]);
    expect(nodes).toHaveLength(MAX_DRIFT_CUTS + 1);
    expect(report.approximations).toHaveLength(MAX_DRIFT_CUTS);
    expect(texts(nodes).join('')).toBe(text);
  });

  it('in a box of several lines, the box splits at the line that drifts; the lines before and after are boxes of their own', () => {
    const P = ['Sect', 'P', 'Span'];
    const first = line('ab cd ef', [], { op: 3, struct: P });
    const drifting = line('gh ij kl', [0, 0, -0.3, 0, 0, -0.3, 0], { op: 4, y: 54.4, spcPt: 0.05, struct: P });
    const last = line('mn op', [], { op: 5, y: 68.8, struct: P });
    expect(texts(lower([first, last]).nodes)).toEqual(['ab cd ef|mn op']);
    const { nodes, report } = lower([first, drifting, last]);
    expect(texts(nodes)).toEqual(['ab cd ef', 'gh ij ', 'kl', 'mn op']);
    expect(report.approximations.map((a) => a.kind)).toEqual(['text-drift-split']);
  });
});
