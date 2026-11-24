import type { OxRun, OxTextBox } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import type { Box } from '../../src/extract/inventory';
import { lowerSlide, runPasses } from '../../src/passes';
import { RUN_LINK_BUDGET_NOTE, RUN_LINK_WORK, runLinks, type LinkedText, type PassedHotspot } from '../../src/passes/links';
import type { Element, HotspotEl, Note, TextLineEl } from '../../src/scene/types';
import { deckOf, hotspot, slideOf, snapshot, textline } from '../helpers/passes';

/**
 * Run-level links (M5 Task 5, ruling M3-R1): a link whose rect covers exactly whole runs of one line, within 0.5 pt,
 * goes on those runs; any other stays a hotspot.
 */

const URL: HotspotEl['link'] = { url: 'https://example.com/a', dest: null };

/** A Scene run of one line at baseline y 40 from x0 to x1 (its advance box 30..43, as `textline`'s). */
function word(op: number, text: string, x0: number, x1: number, over: Partial<TextLineEl> = {}): TextLineEl {
  const adv = (x1 - x0) / text.length;
  const glyphs = [...text].map((u, k) => ({ u, x: x0 + k * adv, y: 40, adv }));
  return textline({ op, baseline: { x: x0, y: 40 }, bboxPt: [x0, 30, x1, 43], runs: [{ ...textline().runs[0]!, text, glyphs }], ...over });
}

function run(elements: Element[]): Element[] {
  const input = slideOf(elements);
  const before = snapshot(input);
  const out = runLinks(input);
  expect(input).toEqual(before); // the input is not changed
  return out.elements;
}

const linked = (els: Element[]): string[] => els.filter((e): e is LinkedText => e.kind === 'textline' && (e as LinkedText).link !== undefined).map((e) => e.id);
const onRuns = (els: Element[]): string[] => els.filter((e): e is PassedHotspot => e.kind === 'hotspot' && (e as PassedHotspot).onRuns === true).map((e) => e.id);

describe('run-level links (M5 Task 5)', () => {
  const line = [word(1, 'Link: ', 20, 52), word(2, 'deckback ', 52.04, 100), word(3, 'example', 104, 140), word(4, ' after', 140, 170)];
  // atlas text/14: PowerPoint's link rect spans the runs along the line exactly, and lies within their height
  const exact: Box = [52.06, 32.5, 140.01, 41.8];

  it('a rect that covers exactly whole runs of one line puts its link on those runs; the hotspot is marked written on them', () => {
    // atlas text/14's highlighted link: its rect is the highlight's, taller than the runs, its middle on them
    expect(onRuns(run([...line, hotspot(0, [52.06, 23.5, 140.01, 42.9], URL)]))).toEqual(['p1:a0']);
    const out = run([...line, hotspot(0, exact, URL)]);
    expect(linked(out)).toEqual(['p1:z2', 'p1:z3']);
    expect((out[1] as LinkedText).link).toEqual(URL);
    expect(onRuns(out)).toEqual(['p1:a0']);
    // a link to a page goes on runs too
    expect(onRuns(run([...line, hotspot(0, exact, { url: null, dest: 'page:2' })]))).toEqual(['p1:a0']);
  });

  it('within 0.5 pt only: a rect past the runs, or short of them, stays a hotspot', () => {
    expect(onRuns(run([...line, hotspot(0, [51.4, 32.5, 140, 41.8], URL)]))).toEqual([]);
    expect(onRuns(run([...line, hotspot(0, [52.6, 32.5, 140, 41.8], URL)]))).toEqual([]);
    expect(onRuns(run([...line, hotspot(0, [52.04, 32.5, 140.6, 41.8], URL)]))).toEqual([]);
    expect(onRuns(run([...line, hotspot(0, [52.5, 32.5, 140.45, 41.8], URL)]))).toEqual(['p1:a0']);
  });

  it('a rect that cuts a run, covers no run, or reaches another line stays a hotspot', () => {
    expect(onRuns(run([...line, hotspot(0, [52, 32.5, 120, 41.8], URL)]))).toEqual([]); // ends inside 'example'
    expect(onRuns(run([...line, hotspot(0, [200, 32.5, 260, 41.8], URL)]))).toEqual([]);
    const below = word(5, 'next', 52, 140, { baseline: { x: 52, y: 60 }, bboxPt: [52, 50, 140, 63] });
    expect(onRuns(run([...line, below, hotspot(0, [52.04, 32.5, 140, 62], URL)]))).toEqual([]);
    // one that only grazes the line: its middle is off the runs' height
    expect(onRuns(run([...line, hotspot(0, [52.04, 10, 140, 31], URL)]))).toEqual([]);
    expect(onRuns(run([...line, hotspot(0, [52.04, 42, 140, 60], URL)]))).toEqual([]);
  });

  it('a link with no target, or one the writer drops, stays a hotspot (dropped and counted once there)', () => {
    expect(onRuns(run([...line, hotspot(0, exact, { url: null, dest: null })]))).toEqual([]);
    expect(onRuns(run([...line, hotspot(0, exact, { url: 'javascript:alert(1)', dest: null })]))).toEqual([]);
  });

  it('turned or vertical text, or runs another link took first, stay out', () => {
    const turned = line.map((w) => ({ ...w, angleDeg: 90 }));
    expect(onRuns(run([...turned, hotspot(0, exact, URL)]))).toEqual([]);
    const vertical = line.map((w) => ({ ...w, wmode: 1 as const }));
    expect(onRuns(run([...vertical, hotspot(0, exact, URL)]))).toEqual([]);
    const twice = run([...line, hotspot(0, exact, URL), hotspot(1, exact, { url: 'https://example.com/b', dest: null })]);
    expect(onRuns(twice)).toEqual(['p1:a0']);
    expect((twice[1] as LinkedText).link).toEqual(URL);
  });
});

describe('run-level links, lowered', () => {
  const line = [word(1, 'Link: ', 20, 52), word(2, 'deckback ', 52.04, 100), word(3, 'example', 104, 140), word(4, ' after', 140, 170)];
  const exact: Box = [52.06, 32.5, 140.01, 41.8];

  /** The slide passed and lowered, `slideOf` as convert's: its text runs (text and link) and its nodes' names. */
  function lowered(link: HotspotEl['link'], pageSlide?: (page: number) => number | null) {
    const input = slideOf([...line, hotspot(0, exact, link)]);
    const deck = deckOf([input]);
    const { slide, report } = runPasses(input, deck);
    const { nodes } = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report, ...(pageSlide === undefined ? {} : { slideOf: pageSlide }) });
    const runs = nodes.filter((n): n is OxTextBox => n.kind === 'text').flatMap((n) => n.paras.flatMap((p) => p.runs));
    return { names: nodes.map((n) => n.name), runs: runs.map((r: OxRun) => [r.text, r.link ?? null]), report };
  }

  it('each run made of a linked run takes its link (a synthetic space between two of them too); no hotspot node; counted a run link', () => {
    const { names, runs, report } = lowered(URL);
    expect(names.some((n) => n.endsWith(' link'))).toBe(false);
    const linkedText = runs.filter(([, l]) => l !== null).map(([t]) => t).join('');
    expect(linkedText.replace(/ /g, '')).toBe('deckbackexample');
    for (const [, l] of runs) if (l !== null) expect(l).toEqual({ kind: 'url', url: URL.url });
    expect(runs.find(([t]) => (t as string).includes('Link'))![1]).toBeNull();
    expect(report.counts).toMatchObject({ hotspots: 0, runLinks: 1 });
  });

  it('fix round 1: two runs of one line with different links stay two runs, each with its own link (assembly joins no runs)', () => {
    const B: HotspotEl['link'] = { url: 'https://example.com/b', dest: null };
    const input = slideOf([...line, hotspot(0, [52.06, 32.5, 100, 41.8], URL), hotspot(1, [104, 32.5, 140.01, 41.8], B)]);
    const deck = deckOf([input]);
    const { slide, report } = runPasses(input, deck);
    const { nodes } = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
    const runs = nodes.filter((n): n is OxTextBox => n.kind === 'text').flatMap((n) => n.paras.flatMap((p) => p.runs));
    const byLink = (url: string) => runs.filter((r) => r.link?.kind === 'url' && r.link.url === url).map((r) => r.text).join('');
    expect(byLink(URL.url!).replace(/ /g, '')).toBe('deckback');
    expect(byLink(B.url!).replace(/ /g, '')).toBe('example');
    expect(runs.some((r) => r.text.includes('deckback') && r.text.includes('example'))).toBe(false);
    expect(report.counts.runLinks).toBe(2);
  });

  it('fix round 1 (review Minor 1): a link whose runs are not written (size 0) is no run link; it is written as a hotspot (final review Minor 5)', () => {
    const unseen = line.map((w) => (w.id === 'p1:z2' || w.id === 'p1:z3' ? { ...w, runs: w.runs.map((r) => ({ ...r, sizePt: 0 })) } : w));
    const input = slideOf([...unseen, hotspot(0, exact, URL)]);
    const deck = deckOf([input]);
    const { slide, report } = runPasses(input, deck);
    const { nodes } = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
    expect(nodes.flatMap((n) => (n.kind === 'text' ? n.paras.flatMap((p) => p.runs) : [])).some((r) => r.link !== undefined && r.link !== null)).toBe(false);
    // the link does not vanish: as before M5, an empty rect with the link, counted a hotspot
    expect(nodes.filter((n) => n.name === 'pdf:p1:a0 link')).toHaveLength(1);
    expect(report.counts).toMatchObject({ hotspots: 1, runLinks: 0 });
  });

  it("a page link goes to its page's slide; to a page not converted, the runs are written without it and nothing is counted here", () => {
    const toSlide = lowered({ url: null, dest: 'page:3' }, (page) => (page === 3 ? 2 : null));
    expect(toSlide.runs.filter(([, l]) => l !== null).every(([, l]) => (l as { slide: number }).slide === 2)).toBe(true);
    expect(toSlide.report.counts.runLinks).toBe(1);
    const gone = lowered({ url: null, dest: 'page:3' }, () => null);
    expect(gone.runs.every(([, l]) => l === null)).toBe(true);
    expect(gone.report.counts).toMatchObject({ hotspots: 0, runLinks: 0 });
  });
});

describe('run links stay bounded on a hostile slide (final review I4)', () => {
  /** `n` runs side by side on one baseline, 0.1 pt each from x 10. */
  const many = (n: number): TextLineEl[] => Array.from({ length: n }, (_, k) => word(1000 + k, 'a', 10 + k * 0.1, 10.1 + k * 0.1));

  it('2,000 runs on one line and 2,000 links each covering all of them finish fast: the first takes them, the rest stay hotspots', () => {
    const runs = many(2_000);
    const links = Array.from({ length: 2_000 }, (_, k) => hotspot(k, [10, 32.5, 210, 41.8], { url: `https://example.com/${k}`, dest: null }));
    const notes: Note[] = [];
    const started = performance.now();
    const out = runLinks(slideOf([...runs, ...links]), notes).elements;
    expect(performance.now() - started, 'a hang guard').toBeLessThan(500);
    expect(onRuns(out)).toEqual(['p1:a0']);
    expect(linked(out)).toHaveLength(2_000);
    expect(notes.map((n) => n.detail)).toEqual([RUN_LINK_BUDGET_NOTE]);
  });

  it('runs are looked up by their line: 2,000 runs on 100 lines and a link on each run all go on their runs, fast', () => {
    const runs: TextLineEl[] = [];
    const links: HotspotEl[] = [];
    for (let line = 0; line < 100; line++) {
      for (let k = 0; k < 20; k++) {
        const [x0, y] = [10 + k * 12, 40 + line * 20];
        runs.push(word(1000 + line * 20 + k, 'ab', x0, x0 + 10, { baseline: { x: x0, y }, bboxPt: [x0, y - 10, x0 + 10, y + 3] }));
        links.push(hotspot(line * 20 + k, [x0, y - 8, x0 + 10, y + 1], { url: `https://example.com/${line}/${k}`, dest: null }));
      }
    }
    const notes: Note[] = [];
    const started = performance.now();
    const out = runLinks(slideOf([...runs, ...links], { sizePt: [300, 2100] }), notes).elements;
    expect(performance.now() - started, 'a hang guard').toBeLessThan(500);
    expect(onRuns(out)).toHaveLength(2_000);
    expect(notes).toEqual([]);
  });

  it(`past RUN_LINK_WORK runs looked at a slide, a link stays a hotspot, with the note once`, () => {
    expect(RUN_LINK_WORK).toBe(1_000_000);
    const runs = many(2_000);
    // links beside the line, covering none of its runs, each looking at all 2,000; then one that covers runs exactly
    const decoys = (n: number) => Array.from({ length: n }, (_, k) => hotspot(k, [220, 32.5, 230, 41.8], URL));
    const exact = hotspot(9_999, [10, 32.5, 10.3, 41.8], URL);
    expect(onRuns(runLinks(slideOf([...runs, ...decoys(100), exact])).elements)).toEqual(['p1:a9999']);
    const notes: Note[] = [];
    const out = runLinks(slideOf([...runs, ...decoys(600), exact]), notes);
    expect(onRuns(out.elements)).toEqual([]);
    expect(notes).toEqual([{ opIndex: 0, op: 'link', detail: RUN_LINK_BUDGET_NOTE }]);
    expect(out.notes).toEqual(notes);
  });
});
