import type { Box } from '../../extract/inventory';
import type { Element } from '../../scene/types';
import { angleApart, endOf, LINE_RULES, MAX_PAINTS_BETWEEN, overlaps, paintBox, sameContext, sizeOf, textFrame, type FoundLine, type TextFrame } from './lines';
import { EPS } from './util';

/**
 * Text assembly, lines into boxes (M4 Task 1, spec §4.2 pass 7). On a tagged page, lines that share a `Textbox` or `P`
 * structure element are one text box, a paragraph (`a:p`) per line; untagged, each line is its own box.
 *
 * The Scene names a run's structure by the roles above its marked content (`provenance.struct`), not by the elements
 * themselves, so two paragraphs with the same roles look alike. A line's element is its runs' `structKey` (the role path
 * down to the outermost `Textbox`, else to the innermost `P`); a line whose runs differ in it, or have none, has none and
 * is a box of its own. A line joins the box before it when, besides the same key (`BOX_RULES`):
 * - it is the next line in z-order (lines are consecutive text runs, so nothing but other paints is between them);
 * - it is horizontal writing in the box's direction (0.1°), in the same clip, group, soft mask and blend mode;
 * - it stacks under the box's last line: its baseline 0.5 to 3 x size further down the box (`pitchMin`, `pitchMax`, the
 *   larger line's size), it overlaps the box along the line, and the two lines' sizes are within 1.25 times of each
 *   other (`sizeRatio`: a small label over larger text is two boxes);
 * - nothing painted since the box's first run, in z-order, covers one of its runs: the box is written where that run is.
 * So paragraphs of one text box join too where their role paths agree, which is the shape PowerPoint drew them in.
 */

export const BOX_RULES = { pitchMin: 0.5, pitchMax: 3, sizeRatio: 1.25 } as const;

/**
 * A run's structure element, by its role path: the path down to the outermost `Textbox`, else down to the innermost
 * `P`, `/`-joined; null without either (a list item's label and body, a figure's caption, untagged text).
 */
export function structKey(struct: readonly string[] | null): string | null {
  if (struct === null) return null;
  const box = struct.indexOf('Textbox');
  const end = box >= 0 ? box : struct.lastIndexOf('P');
  return end < 0 ? null : struct.slice(0, end + 1).join('/');
}

/** A line's structure element: its runs' one `structKey`, or null when they have none or differ. */
function lineKey(line: FoundLine): string | null {
  const key = structKey(line.els[0]!.provenance.struct);
  return key !== null && line.els.every((el) => structKey(el.provenance.struct) === key) ? key : null;
}

const lineSize = (line: FoundLine): number => line.els.reduce((m, el) => Math.max(m, sizeOf(el)), 0);

/** A box being assembled: its lines, key, frame, extent along its lines, and the paints since its first run. */
interface OpenBox {
  lines: FoundLine[];
  key: string | null;
  frame: TextFrame;
  start: number;
  end: number;
  paints: Box[];
}

const extent = (line: FoundLine, frame: TextFrame): [number, number] => [
  frame.along(line.els[0]!.baseline),
  line.els.reduce((m, el) => Math.max(m, endOf(el, frame)), -Infinity),
];

/** The paints of `elements` from index `from` to `to` (both included) that paint something: what is not text. */
function paintsIn(elements: readonly Element[], from: number, to: number): Box[] {
  const out: Box[] = [];
  for (let i = from; i <= to; i++) {
    const el = elements[i]!;
    const box = el.kind === 'textline' ? null : paintBox(el);
    if (box !== null) out.push(box);
  }
  return out;
}

function open(elements: readonly Element[], line: FoundLine): OpenBox {
  const frame = textFrame(line.els[0]!);
  const [start, end] = extent(line, frame);
  return { lines: [line], key: lineKey(line), frame, start, end, paints: paintsIn(elements, line.first + 1, line.last) };
}

/**
 * The slide's lines (`textLines`, in z-order) as boxes: runs of consecutive lines, each a box (`BOX_RULES`). `elements`
 * are the slide's, which the lines index. A box takes no further line once more than `MAX_PAINTS_BETWEEN` paints lie
 * between its runs, which bounds the covering checks on a page of many paints.
 */
export function textBoxes(elements: readonly Element[], lines: readonly FoundLine[]): FoundLine[][] {
  const boxes: FoundLine[][] = [];
  let box: OpenBox | null = null;
  for (const line of lines) {
    if (box !== null && joinsBox(elements, box, line)) continue;
    box = open(elements, line);
    boxes.push(box.lines);
  }
  return boxes;
}

/** Whether `line` joins `box` (the rules above); when it does, `box` takes it. */
function joinsBox(elements: readonly Element[], box: OpenBox, line: FoundLine): boolean {
  const last = box.lines.at(-1)!;
  const head = box.lines[0]!.els[0]!;
  const lead = line.els[0]!;
  if (box.key === null || lineKey(line) !== box.key || line.first !== nextText(elements, last.last)) return false;
  if (head.wmode !== 0 || lead.wmode !== 0 || angleApart(head.angleDeg, lead.angleDeg) > LINE_RULES.angleTolDeg + EPS) return false;
  if (!sameContext(head, lead)) return false;
  const { frame } = box;
  const [lastSize, size] = [lineSize(last), lineSize(line)];
  if (Math.max(lastSize, size) > BOX_RULES.sizeRatio * Math.min(lastSize, size) + EPS) return false;
  const pitch = frame.across(lead.baseline) - frame.across(last.els[0]!.baseline);
  const larger = Math.max(lastSize, size);
  if (pitch < BOX_RULES.pitchMin * larger - EPS || pitch > BOX_RULES.pitchMax * larger + EPS) return false;
  // along the line it overlaps the box
  const [l0, l1] = extent(line, frame);
  if (!(l0 < box.end - EPS && box.start < l1 - EPS)) return false;
  // nothing painted since the box's first run covers a run of the line
  const between = paintsIn(elements, last.last + 1, line.first - 1);
  const paints = [...box.paints, ...between];
  if (paints.length > MAX_PAINTS_BETWEEN) return false;
  if (paints.some((paint) => line.els.some((run) => overlaps(paint, run.bboxPt)))) return false;
  box.lines.push(line);
  box.start = Math.min(box.start, l0);
  box.end = Math.max(box.end, l1);
  box.paints = [...paints, ...paintsIn(elements, line.first + 1, line.last)];
  return true;
}

/** The index of the first text run after index `i` of `elements`, or -1. */
function nextText(elements: readonly Element[], i: number): number {
  for (let j = i + 1; j < elements.length; j++) if (elements[j]!.kind === 'textline') return j;
  return -1;
}
