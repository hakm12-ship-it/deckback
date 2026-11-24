import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { PptxWriter } from '@deckback/ooxml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convert } from '../src/convert';
import { canonicalJson } from '../src/scene/canonical';
import { COVERED_OPS_MAX } from '../src/scene/build';
import { REPORT_LIST_MAX } from '../src/passes/report';
import { RASTER_BUDGET_NOTE } from '../src/passes/fallbacks';
import { SLIDE_RASTER_MAX } from '../src/raster/raster';
import type { FallbackEl, SceneSlide, TextLineEl } from '../src/scene/types';
import { DECK_WEIGHT_BUDGET, PAGE_UNIT, SLIDE_WEIGHT_BUDGET, slideWeight } from '../src/scene/weight';
import { buildPdf, type MiniObject } from './helpers/minipdf';
import { embeddedTrueType, partsOf, slideCountOf, slideSizeOf, sizedPdf, TEST_FONT, treeOf } from './helpers/pptx';
import { trueTypeFont } from './helpers/sfnt';

/**
 * `convert()` on what it must survive (Review Focus 5): PDFs of a few KB that would make slides of millions of path
 * segments or elements, a deck past the deck budget, and pages that fail.
 *
 * Memory: `process.memoryUsage().heapUsed` is sampled where each slide has been built (pdf.js' page still held), where
 * each slide that has nodes is about to be written (the Scene slide, the passed slide and the lowered one all held), and
 * where a slide's XML of more than 100,000 characters is encoded for the zip (the XML too), each time after a full
 * collection, so the samples are what is live there and not garbage the collector has not yet taken; the peak is over
 * what was live before the conversion. The heap before each collection is kept too (`rawPeakMB`): it shows how much
 * garbage a page leaves, which the collector takes when it needs to.
 */

const faults = vi.hoisted(() => ({
  unreadable: null as number | null,
  sample: () => undefined as void,
  /** A page (0-based) whose slide throws in the fill-rule pass, or in lowering its text (ruling M3-R62). */
  throwIn: null as { where: 'pass' | 'lowering'; page: number } | null,
}));

vi.mock('../src/passes/fillrule', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/passes/fillrule')>();
  return {
    ...real,
    fillRule: (...args: Parameters<typeof real.fillRule>) => {
      if (faults.throwIn?.where === 'pass' && faults.throwIn.page === args[0].index) throw new Error('injected: a pass threw');
      return real.fillRule(...args);
    },
  };
});

vi.mock('../src/passes/lower/text', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/passes/lower/text')>();
  return {
    ...real,
    lowerText: (...args: Parameters<typeof real.lowerText>) => {
      if (faults.throwIn?.where === 'lowering' && args[0].id.startsWith(`p${faults.throwIn.page + 1}:`)) throw new Error('injected: lowering threw');
      return real.lowerText(...args);
    },
  };
});

vi.mock('../src/engine/pdfjs-adapter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/engine/pdfjs-adapter')>();
  return {
    ...real,
    loadPage: async (doc: Parameters<typeof real.loadPage>[0], index: number) => {
      if (faults.unreadable === index) throw new Error('injected: page unreadable');
      return real.loadPage(doc, index);
    },
  };
});

vi.mock('../src/scene/build', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/scene/build')>();
  return {
    ...real,
    buildSlide: async (...args: Parameters<typeof real.buildSlide>) => {
      const slide = await real.buildSlide(...args);
      faults.sample();
      return slide;
    },
  };
});

afterEach(() => {
  faults.unreadable = null;
  faults.throwIn = null;
  faults.sample = () => undefined;
  vi.restoreAllMocks();
});

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;
const MB = 1024 * 1024;
const addSlide = PptxWriter.prototype.addSlide;
const encode = TextEncoder.prototype.encode;
/**
 * The live heap a hostile slide may take while it is converted (rulings M3-R38, M3-R60, budget 500,000): 78 MB measured
 * at M3-R38 (2026-11-11, Node 24, the 20,000 rects after the crossing, whose RawOps were live while the slide was built)
 * and a margin of half that. Since M3-R60 a slide at the budget holds about 50 MB of our own heap whatever it is made
 * of; the most measured below is 113 MB, one image drawn 500,000 times through a form, of which pdf.js' operator list,
 * held while the slide is built, is 91 MB (ruling M3-R39).
 */
const HEAP_GATE_MB = 120;

/**
 * Converts `bytes` and says how much heap it held at most above what was live before it (`peakMB`, the samples above),
 * the most the heap reached before those collections (`rawPeakMB`), and how long it took (`ms`, collections included).
 */
async function measured(bytes: Uint8Array, opts: Parameters<typeof convert>[1] = {}) {
  const live: number[] = [];
  const raw: number[] = [];
  faults.sample = () => {
    raw.push(process.memoryUsage().heapUsed);
    gc();
    live.push(process.memoryUsage().heapUsed);
  };
  vi.spyOn(PptxWriter.prototype, 'addSlide').mockImplementation(function (this: PptxWriter, slide) {
    if (slide.nodes.length > 0) faults.sample();
    return addSlide.call(this, slide);
  });
  vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (this: TextEncoder, text?: string) {
    if (text !== undefined && text.length > 100_000) faults.sample();
    return encode.call(this, text);
  });
  gc();
  const before = process.memoryUsage().heapUsed;
  const started = performance.now();
  const result = await convert(bytes, opts);
  const ms = performance.now() - started;
  const peak = (samples: number[]) => (Math.max(before, ...samples) - before) / MB;
  return { ...result, ms, peakMB: peak(live), rawPeakMB: peak(raw) };
}

const PATTERN = '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 100 100] /XStep 100 /YStep 100';

/**
 * M2's re-review probe (M2-R37): one tile cell of a 5,000-segment path, filled `fills` times on each of `pages` pages
 * (every page the same content stream). Each fill copies the cell into its element: at 200 fills a page is 400 elements
 * but over a million path segments. Streams are compressed and the pages packed in an object stream, so 200 fills on
 * one page are about 1.2 KB, and 400 such pages a few KB more. `after`: content after the fills (the font /F1 is there
 * for it); `page`: more of each page's dictionary (`/Annots`).
 */
function cellFilled(fills: number, pages = 1, { after = '', page = '' }: { after?: string; page?: string } = {}): Uint8Array {
  const cell = `0 0 1 rg 0 0 m ${'90 90 l 0 90 l '.repeat(2500)}h f`;
  const content = Array.from({ length: fills }, (_, i) => `/Pattern cs /P scn ${(i % 10) * 25} ${(i % 10) * 25} 20 20 re f`).join(' ');
  const kids = Array.from({ length: pages }, (_, n) => 100 + n);
  return buildPdf(
    [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>` },
      { num: 3, data: `${content} ${after}`, flate: true },
      { num: 4, dict: `${PATTERN} /Resources << >>`, data: cell, flate: true },
      TEST_FONT,
      ...kids.map(
        (k): MiniObject => ({
          num: k,
          body:
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 3 0 R ' +
            `/Resources << /Pattern << /P 4 0 R >> /Font << /F1 10 0 R >> >> ${page} >>`,
        }),
      ),
    ],
    { xref: 'stream', packed: [2, ...kids] },
  );
}

/**
 * M2's final review F1 (M2-R36): tiling patterns nested `depth` deep, each cell filling 10 rectangles with the next, the
 * page filling `fills` rectangles with the first; 10^depth elements were there no budget (extract.test.ts).
 */
function nested(depth: number, fills: number): Uint8Array {
  const at = (i: number) => `${(i % 5) * 20} ${Math.floor(i / 5) * 20} 10 10 re f`;
  const objects: MiniObject[] = [];
  for (let k = 1; k <= depth; k++) {
    const inner = k < depth;
    const resources = inner ? `/Pattern << /P ${20 + k} 0 R >>` : '';
    const paints = Array.from({ length: 10 }, (_, i) => (inner ? `/Pattern cs /P scn ${at(i)}` : `0 0 1 rg ${at(i)}`));
    objects.push({ num: 19 + k, dict: `${PATTERN} /Resources << ${resources} >>`, data: paints.join(' ') });
  }
  const content = Array.from({ length: fills }, (_, i) => `/Pattern cs /P scn ${i * 150} 0 150 300 re f`).join(' ');
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Pattern << /P 20 0 R >> >> >>' },
    { num: 4, data: content },
    ...objects,
  ]);
}

const heavy = (slide: SceneSlide) => slide.notes.filter((n) => n.detail.startsWith('slide too complex'));
const fallbacksOf = (slide: SceneSlide) => slide.elements.filter((e): e is FallbackEl => e.kind === 'fallback');
/** 20,000 small rects: what M3-R40's review put after M2's 200 fills, so that each would have been a fallback of its own. */
const MANY_RECTS = Array.from({ length: 20_000 }, (_, i) => `${i % 280} ${Math.floor(i / 280) % 280} 1 1 re f`).join(' ');

describe('convert(): the size-weighted budgets (Review Focus 5, rulings M2-R36, M2-R37, M3-R38, M3-R40)', () => {
  it('weight budgets bound the hostile PDFs', async () => {
    const probe = cellFilled(200);
    expect(probe.length).toBeLessThan(1_400); // M2's 1.2 KB
    const tenfold = cellFilled(2_000);
    const deep = nested(7, 2);
    expect(deep.length).toBeLessThan(5_000); // M2's 4.7 KB
    const reviewed = cellFilled(200, 1, { after: MANY_RECTS });

    const rows: string[] = [];
    for (const [name, bytes] of [
      ['cell x200', probe],
      ['cell x2000', tenfold],
      ['depth 7', deep],
      ['cell x200 + 20,000 rects', reviewed],
    ] as const) {
      const { pptx, report, scene, ms, peakMB, rawPeakMB } = await measured(bytes, { scene: true });
      const [slide] = scene!.slides;
      const weight = slideWeight(slide!);
      const reportBytes = JSON.stringify(report).length;
      rows.push(
        `${name}: ${bytes.length} B, weight ${weight}, fallbacks ${fallbacksOf(slide!).length}, pptx ${pptx.length} B, report ${reportBytes} B, ` +
          `heap +${peakMB.toFixed(1)} MB live (+${rawPeakMB.toFixed(1)} MB before collection), ${ms.toFixed(0)} ms`,
      );
      expect(slide!.failed, name).toBeNull();
      // what the slide holds is bounded by its budget, and what it writes, reports and uses by that
      expect(weight, name).toBeLessThanOrEqual(SLIDE_WEIGHT_BUDGET);
      expect(fallbacksOf(slide!).length, name).toBeLessThanOrEqual(1);
      expect(pptx.length, name).toBeLessThan(20_000);
      expect(reportBytes, name).toBeLessThan(10_000);
      expect(peakMB, name).toBeLessThan(HEAP_GATE_MB);
      expect(ms, `${name}: a hang guard, not a speed requirement`).toBeLessThan(60_000);
      expect(report.slides[0]!.failed, name).toBeNull();
    }
    console.log(rows.join('\n'));
  }, 180_000);

  it('past the slide budget, the paint that crosses it and the rest of the slide are one too-complex fallback (ruling M3-R40)', async () => {
    const { report, scene } = await convert(cellFilled(2_000), { scene: true });
    const [slide] = scene!.slides;
    // fills of about 5,009 each: the budget is crossed at about the 100th, and that fill and the 1,900 after it are one
    const [fallback, ...more] = fallbacksOf(slide!);
    expect(more).toEqual([]);
    expect(slide!.elements.at(-1)).toBe(fallback);
    expect(slide!.elements.length).toBeGreaterThan(90);
    expect(slide!.elements.slice(0, -1).every((e) => e.kind === 'shape')).toBe(true);
    expect(fallback).toMatchObject({ kind: 'fallback', reason: 'too-complex', raster: null });
    // the ops it stands for, the first COVERED_OPS_MAX of them; the rest are cut from the list
    expect(fallback!.coveredOps).toHaveLength(COVERED_OPS_MAX);
    expect(fallback!.coveredOps[0]).toBe(fallback!.provenance.opIndex[0]);
    expect(new Set(fallback!.coveredOps).size).toBe(COVERED_OPS_MAX);
    expect(heavy(slide!)).toEqual([{ opIndex: fallback!.provenance.opIndex[0], op: 'constructPath', detail: 'slide too complex' }]);
    expect(report.budgets.exceeded).toEqual({ slide: [1], deck: false });
    expect(report.slides[0]!.fallbacks).toEqual([{ id: fallback!.id, reason: 'too-complex' }]);
    expect(report.slides[0]!.counts.fallbacks).toBe(1);
    // strict mode refuses the slide
    await expect(convert(cellFilled(2_000), { strict: true })).rejects.toThrow(/slide's weight budget/);
  }, 60_000);

  it("the review's case: 20,000 rects after the crossing are in the same one fallback, and the PPTX and report do not grow", async () => {
    const plain = await convert(cellFilled(200), { scene: true });
    const reviewed = await convert(cellFilled(200, 1, { after: MANY_RECTS }), { scene: true });
    const [slide] = reviewed.scene!.slides;
    expect(fallbacksOf(slide!)).toHaveLength(1);
    expect(fallbacksOf(slide!)[0]!.coveredOps).toHaveLength(COVERED_OPS_MAX);
    expect(slideWeight(slide!)).toBeLessThanOrEqual(SLIDE_WEIGHT_BUDGET);
    // the same slide is written, the same report made: the rects past the budget add nothing but to one bbox
    expect(Buffer.from(reviewed.pptx).equals(Buffer.from(plain.pptx))).toBe(true);
    expect(canonicalJson(reviewed.report)).toBe(canonicalJson(plain.report));
    expect(JSON.stringify(reviewed.report).length).toBeLessThan(10_000);
    // the box of what it stands for: the fills from the crossing one (its top at y 55 on the slide) and the rects
    expect(fallbacksOf(slide!)[0]!.bbox).toEqual([0, 55, 280, 300]);
  }, 60_000);

  it('a text line that crosses the slide budget keeps the glyphs it had; the rest of the run and of the slide are one fallback', async () => {
    // 98 fills (about 496,200 since ruling M3-R60), then one run of 10,000 glyphs on the page (in black, not the pattern),
    // then 5 rects
    const after = `0 0 0 rg BT /F1 1 Tf 10 290 Td (${'AB'.repeat(5_000)}) Tj ET ${'0 0 1 rg 10 10 5 5 re f '.repeat(5)}`;
    const { report, scene } = await convert(cellFilled(98, 1, { after }), { scene: true });
    const [slide] = scene!.slides;
    expect(slideWeight(slide!)).toBeLessThanOrEqual(SLIDE_WEIGHT_BUDGET);
    const kinds = slide!.elements.map((e) => e.kind);
    expect(kinds).toEqual([...new Array<string>(98).fill('shape'), 'textline', 'fallback']);
    const line = slide!.elements[98] as TextLineEl;
    const kept = line.runs[0]!.glyphs.length;
    expect(kept).toBeGreaterThan(1_000);
    expect(kept).toBeLessThan(10_000);
    expect(line.runs[0]!.text).toBe('AB'.repeat(5_000).slice(0, kept));
    // the fallback stands for the run's other glyphs (the same op) and the rects after it
    const fallback = slide!.elements[99] as FallbackEl;
    expect(fallback.coveredOps[0]).toBe(line.provenance.opIndex[0]);
    expect(fallback.coveredOps).toHaveLength(6);
    expect(heavy(slide!)).toEqual([{ opIndex: line.provenance.opIndex[0], op: 'showText', detail: 'slide too complex' }]);
    expect(report.slides[0]!.counts).toMatchObject({ textBoxes: 1, fallbacks: 1 });
    await expect(convert(cellFilled(98, 1, { after }), { strict: true })).rejects.toThrow(/slide's weight budget/);
  }, 60_000);

  it('glyphs in a tile cell weigh too: the fill whose cell crosses the budget and the rest of the slide are one fallback', async () => {
    // a cell of one 5,000-glyph run, filled 200 times: about the 100th copy of the run crosses the budget part way through
    const pdf = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Pattern << /P 5 0 R >> >> >>' },
      { num: 4, data: Array.from({ length: 200 }, (_, i) => `/Pattern cs /P scn ${(i % 10) * 25} 0 20 20 re f`).join(' '), flate: true },
      { num: 5, dict: `${PATTERN} /Resources << /Font << /F1 10 0 R >> >>`, data: `BT /F1 1 Tf 0 50 Td (${'AB'.repeat(2500)}) Tj ET`, flate: true },
      TEST_FONT,
    ]);
    const { report, scene } = await convert(pdf, { scene: true });
    const [slide] = scene!.slides;
    expect(slideWeight(slide!)).toBeLessThanOrEqual(SLIDE_WEIGHT_BUDGET);
    expect(report.budgets.exceeded).toEqual({ slide: [1], deck: false });
    // the cell's half-built line went with the fill it was in: one fallback, on the page, last
    const last = slide!.elements.at(-1)!;
    expect(last).toMatchObject({ kind: 'fallback', reason: 'too-complex' });
    expect(fallbacksOf(slide!)).toHaveLength(1);
    expect(heavy(slide!)).toEqual([{ opIndex: last.provenance.opIndex[0], op: 'constructPath', detail: 'slide too complex' }]);
    expect(slide!.elements.slice(0, -1).every((e) => e.kind === 'shape')).toBe(true);
    await expect(convert(pdf, { strict: true })).rejects.toThrow(/slide's weight budget/);
  }, 60_000);

  it('links count toward the slide budget: past it they are not written, and the report counts them', async () => {
    const annots = Array.from({ length: 3 }, (_, i) => `<< /Type /Annot /Subtype /Link /Rect [${10 + 30 * i} 10 ${30 + 30 * i} 30] /A << /S /URI /URI (https://example.com/${i}) >> >>`);
    const pdf = cellFilled(200, 1, { page: `/Annots [${annots.join(' ')}]` });
    const { pptx, report, scene } = await convert(pdf, { scene: true });
    const [slide] = scene!.slides;
    expect(slide!.elements.filter((e) => e.kind === 'hotspot')).toEqual([]);
    expect(slide!.notes.at(-1)).toEqual({ opIndex: 0, op: 'getAnnotations', detail: 'slide too complex: links dropped' });
    expect(report.totals.hotspots).toBe(0);
    expect(report.totals.droppedLinks).toEqual({ url: 0, scheme: 0, slide: 0, page: 0, budget: 3, target: 0 });
    expect(partsOf(pptx)['ppt/slides/_rels/slide1.xml.rels']).not.toMatch(/example\.com/);
    // under the budget, the same links are written
    const light = await convert(sizedPdf([{ size: [300, 300], content: '0 0 1 rg 10 10 5 5 re f', page: `/Annots [${annots.join(' ')}]` }]));
    expect(light.report.totals.hotspots).toBe(3);
    expect(light.report.totals.droppedLinks.budget).toBe(0);
    await expect(convert(pdf, { strict: true })).rejects.toThrow(/slide's weight budget/);
  }, 60_000);

  it('a deck past the deck budget writes blank failed slides and the right slide count', async () => {
    // 400 pages of the 1.2 KB probe, each page at the slide budget: the deck budget is crossed after about 40
    const bytes = cellFilled(200, 400);
    expect(bytes.length).toBeLessThan(10_000);
    const one = slideWeight((await convert(cellFilled(200), { scene: true })).scene!.slides[0]!); // every page weighs this
    // no Scene kept: what is measured is the streamed conversion
    const { pptx, report, ms, peakMB, rawPeakMB } = await measured(bytes);
    const parts = partsOf(pptx);
    expect(slideCountOf(parts)).toBe(400);
    expect(report.slides).toHaveLength(400);
    // the pages are converted until they weigh more than the deck budget: the one that crosses it is the last
    const converted = Math.floor(DECK_WEIGHT_BUDGET / one) + 1;
    expect(report.slides.map((s) => s.failed)).toEqual([...new Array<null>(converted).fill(null), ...new Array<string>(400 - converted).fill('deck-too-complex')]);
    expect(report.budgets.exceeded).toEqual({ slide: Array.from({ length: converted }, (_, i) => i + 1), deck: true });
    // a cut slide is blank, at the deck's size, with its note
    const n = converted + 1;
    expect(treeOf(parts, n)).toBe('');
    expect(treeOf(parts, 400)).toBe('');
    expect(report.slides[n - 1]).toMatchObject({ index: n, scale: null, failed: 'deck-too-complex', notes: [{ opIndex: 0, op: 'getOperatorList', detail: 'deck too complex' }] });
    expect(slideSizeOf(parts)).toEqual([3810000, 3810000]);
    console.log(`400 pages, ${bytes.length} B: ${converted} converted (${one} each), pptx ${pptx.length} B, heap +${peakMB.toFixed(1)} MB live (+${rawPeakMB.toFixed(1)} MB before collection), ${ms.toFixed(0)} ms`);
    expect(peakMB).toBeLessThan(HEAP_GATE_MB);
    expect(ms, 'a hang guard, not a speed requirement').toBeLessThan(120_000);
  }, 300_000);

  it('strict mode refuses a deck past the deck budget', async () => {
    // pages under the slide budget (90 fills, about 455,700 each), so that only the deck's is crossed, after 44 pages
    await expect(convert(cellFilled(90, 50), { strict: true })).rejects.toThrow(/deck's weight budget/);
  }, 300_000);
});

/** One 300 x 300 pt page of `content` (compressed), with the image /Im1, the form /Fm1 and /GS1 (`/BM /Multiply`). */
function hostilePage(content: string, objects: MiniObject[] = [], resources = ''): Uint8Array {
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      num: 3,
      body:
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R ' +
        `/Resources << /XObject << /Im1 20 0 R /Fm1 21 0 R >> /ExtGState << /GS1 22 0 R >> ${resources} >> >>`,
    },
    { num: 4, data: content, flate: true },
    { num: 20, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: new Uint8Array([200, 10, 10, 10, 200, 10, 10, 10, 200, 90, 90, 90]) },
    { num: 22, body: '<< /Type /ExtGState /BM /Multiply >>' },
    ...objects,
  ]);
}

/**
 * The review's 4.3 KB PDF (final review F1, F2): one image drawn `n` times, each at its own place, by a form that draws it
 * 1,000 times; with `blend` under `/BM /Multiply`, so that every picture records `blend-dropped`.
 */
function formImages(n: number, blend = false): Uint8Array {
  const at = (i: number) => `${i % 280} ${Math.floor(i / 280) % 280}`;
  const form = Array.from({ length: 1_000 }, (_, i) => `q 2 0 0 2 ${at(i)} cm /Im1 Do Q`).join(' ');
  const calls = Array.from({ length: Math.ceil(n / 1_000) }, (_, k) => `q 1 0 0 1 ${(k % 7) * 0.5} ${Math.floor(k / 7) * 0.5} cm /Fm1 Do Q`);
  const formObject: MiniObject = { num: 21, dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /XObject << /Im1 20 0 R >> >>', data: form, flate: true };
  return hostilePage(`${blend ? '/GS1 gs ' : ''}${calls.join(' ')}`, [formObject]);
}

describe('convert(): pages dense in elements (final review F1, F2; rulings M3-R59, M3-R60)', () => {
  /** The pictures a slide keeps: those that weigh less than the budget, less the room for its one fallback. */
  const KEPT = Math.floor((SLIDE_WEIGHT_BUDGET - PAGE_UNIT.fallback) / PAGE_UNIT.picture);

  it('100,000 reused images under one non-normal blend: linear, and the report lists 1,000 approximations (M3-R59)', async () => {
    const bytes = formImages(100_000, true);
    expect(bytes.length).toBeLessThan(5_000);
    const { report, ms, peakMB } = await measured(bytes);
    const [slide] = report.slides;
    console.log(`100,000 images under a blend, ${bytes.length} B: report ${JSON.stringify(report).length} B, heap +${peakMB.toFixed(1)} MB live, ${ms.toFixed(0)} ms`);
    // M5: the first SLIDE_RASTER_MAX are raster fallbacks; past the slide's raster budget the rest stay pictures
    const blended = KEPT - SLIDE_RASTER_MAX;
    expect(slide!.counts).toMatchObject({ pictures: blended, fallbacks: 1 + SLIDE_RASTER_MAX });
    expect(slide!.fallbacks.filter((f) => f.reason === 'blend-mode')).toHaveLength(SLIDE_RASTER_MAX);
    expect(slide!.notes).toContainEqual({ opIndex: 0, op: 'raster', detail: RASTER_BUDGET_NOTE });
    // every other picture is approximated (its blend dropped): the first 1,000 are listed, the rest counted, the totals exact
    expect(slide!.approximations).toHaveLength(REPORT_LIST_MAX);
    expect(slide!.approximations.every((a) => a.kind === 'blend-dropped')).toBe(true);
    expect(slide!.approximationsTruncated).toBe(blended - REPORT_LIST_MAX);
    expect(report.totals.approximations['blend-dropped']).toBe(blended);
    // 4.3 MB and 70 s before M3-R59 (a scan of the slide's list for each approximation)
    expect(JSON.stringify(report).length).toBeLessThan(60_000);
    expect(peakMB).toBeLessThan(HEAP_GATE_MB);
    expect(ms, 'a hang guard, not a speed requirement').toBeLessThan(30_000);
  }, 120_000);

  it('a run of 50,000 identical image paints is one picture, in linear time', async () => {
    const bytes = hostilePage('q 10 0 0 10 50 50 cm /Im1 Do Q '.repeat(50_000));
    expect(bytes.length).toBeLessThan(6_000);
    const { pptx, report, scene, ms, peakMB } = await measured(bytes, { scene: true });
    console.log(`50,000 identical paints, ${bytes.length} B: heap +${peakMB.toFixed(1)} MB live, ${ms.toFixed(0)} ms`);
    // the Scene keeps the paints within the budget, then one fallback; dedupe folds the run into its first picture
    const [built] = scene!.slides;
    expect(built!.elements.filter((e) => e.kind === 'picture')).toHaveLength(KEPT);
    expect(report.slides[0]!.counts).toMatchObject({ pictures: 1, fallbacks: 1 });
    expect(treeOf(partsOf(pptx), 1).match(/<p:pic>/g)).toHaveLength(1);
    expect(peakMB).toBeLessThan(HEAP_GATE_MB);
    // 9.4 s before (a copy and a scan of the run's ops at each fold)
    expect(ms, 'a hang guard, not a speed requirement').toBeLessThan(30_000);
  }, 120_000);

  it.each([100_000, 500_000])('one image drawn %i times through a form: memory bounded by the weight (M3-R60)', async (n) => {
    const bytes = formImages(n);
    expect(bytes.length).toBeLessThan(6_000);
    const { pptx, report, ms, peakMB, rawPeakMB } = await measured(bytes);
    console.log(`${n} images through a form, ${bytes.length} B: pptx ${pptx.length} B, heap +${peakMB.toFixed(1)} MB live (+${rawPeakMB.toFixed(1)} MB before collection), ${ms.toFixed(0)} ms`);
    // before M3-R60 a picture weighed 1: 100,000 held 175 MB, 500,000 (the budget) 875 MB and 1 GB was not enough
    expect(report.slides[0]!.counts).toMatchObject({ pictures: KEPT, fallbacks: 1 });
    expect(report.budgets.exceeded).toEqual({ slide: [1], deck: false });
    expect(peakMB).toBeLessThan(HEAP_GATE_MB);
    expect(ms, 'a hang guard, not a speed requirement').toBeLessThan(60_000);
  }, 180_000);

  it("an sh in a path clip weighs the clip's segments, which it takes as its geometry (M3-R60)", async () => {
    // one clip of 5,000 segments, then 200 axial shadings in it, each after a small rect (so that dedupe folds none)
    const shading: MiniObject = { num: 24, body: '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 300 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>' };
    const clip = ['10 10 m', ...Array.from({ length: 4_999 }, (_, k) => `${10 + ((k + 1) % 2) * 200} ${10 + (280 * (k + 1)) / 5_000} l`)].join(' ');
    const paints = Array.from({ length: 200 }, (_, i) => `/Sh1 sh 0 0 1 rg ${i} 5 1 1 re f`).join(' ');
    const bytes = hostilePage(`${clip} h W n ${paints}`, [shading], '/Shading << /Sh1 24 0 R >>');
    const { pptx, report, scene, peakMB } = await measured(bytes, { scene: true });
    console.log(`200 sh in a 5,000-segment clip, ${bytes.length} B: pptx ${pptx.length} B, heap +${peakMB.toFixed(1)} MB live`);
    // before M3-R60 the slide weighed 6,401 and held 120 MB: each sh writes the clip's 5,000 segments
    const [slide] = scene!.slides;
    expect(slideWeight(slide!)).toBeLessThanOrEqual(SLIDE_WEIGHT_BUDGET);
    expect(slideWeight(slide!)).toBeGreaterThan(SLIDE_WEIGHT_BUDGET - 20_100); // the next sh (20,039) and rect did not fit
    expect(report.budgets.exceeded).toEqual({ slide: [1], deck: false });
    expect(slide!.elements.filter((e) => e.kind === 'shape' && e.geom === null).length).toBeLessThan(30);
    expect(peakMB).toBeLessThan(HEAP_GATE_MB);
  }, 120_000);
});

describe('convert(): a page that fails', () => {
  /** Three pages: text and a picture first used on page 2, and again on page 3. */
  const IMAGE: MiniObject = { num: 20, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: new Uint8Array(12).fill(200) };
  const FONT2: MiniObject = { num: 21, body: '<< /Type /Font /Subtype /TrueType /BaseFont /DeckbackOther /FirstChar 65 /LastChar 67 /Widths [600 600 600] /Encoding /WinAnsiEncoding >>' };
  const page2 = 'BT /F2 20 Tf 20 100 Td (ABC) Tj ET q 50 0 0 50 100 100 cm /Im1 Do Q';
  const page3 = 'BT /F1 12 Tf 20 20 Td (AB) Tj ET BT /F2 20 Tf 20 100 Td (CAB) Tj ET q 40 0 0 40 150 50 cm /Im1 Do Q';
  const E300 = `1${'0'.repeat(300)}`;
  const unbuildable = `q ${E300} 0 0 ${E300} 0 0 cm 0 0 10000000000 10000000000 re W n 0 0 1 rg 0 0 1 1 re f Q`;
  const pdf = (second: string) =>
    sizedPdf(
      [
        { size: [300, 200], content: 'BT /F1 12 Tf 20 20 Td (ABC) Tj ET 0 0 1 rg 10 10 50 50 re f' },
        { size: [300, 200], content: second },
        { size: [300, 200], content: page3 },
      ],
      { resources: '/XObject << /Im1 20 0 R >>', fonts: '/F2 21 0 R', objects: [IMAGE, FONT2] },
    );

  it('a failed page is a blank slide and the next slide is unchanged', async () => {
    // pages 1 and 3 alone: what slide 3 must be, whatever page 2 did
    const reference = partsOf((await convert(pdf(page2), { pages: [0, 2] })).pptx);
    const expected = reference['ppt/slides/slide2.xml'];
    expect(expected).toMatch(/pdf:p3:z\d+ picture/);

    // page 2 met its font and picture, then could not be built: nothing of it stays
    const built = await convert(pdf(`${page2} ${unbuildable}`));
    const parts = partsOf(built.pptx);
    expect(built.report.slides.map((s) => s.failed)).toEqual([null, 'slide-unbuildable', null]);
    expect(treeOf(parts, 2)).toBe('');
    expect(parts['ppt/slides/slide3.xml']).toBe(expected);
    expect(parts['ppt/slides/_rels/slide3.xml.rels']).toBe(reference['ppt/slides/_rels/slide2.xml.rels']);
    expect(built.report.fonts.map((f) => f.key)).toEqual(['f1', 'f2']);

    // page 2 pdf.js cannot load: the same
    faults.unreadable = 1;
    const unread = await convert(pdf(page2));
    const unreadParts = partsOf(unread.pptx);
    expect(unread.report.slides.map((s) => [s.failed, s.scale])).toEqual([
      [null, null],
      ['page-unreadable', null],
      [null, null],
    ]);
    expect(treeOf(unreadParts, 2)).toBe('');
    expect(unreadParts['ppt/slides/slide3.xml']).toBe(expected);
    expect(canonicalJson(unread.report.slides[2])).toBe(canonicalJson(built.report.slides[2]));
  });

  it('a slide that throws in a pass, in lowering or in the writer is a blank unwritable slide, and the deck goes on (ruling M3-R62)', async () => {
    const bytes = pdf(page2);
    const plain = await convert(bytes);
    const reference = partsOf(plain.pptx);
    expect(reference['ppt/slides/slide3.xml']).toMatch(/pdf:p3:z\d+ picture/);
    const mediaOf = (parts: Record<string, string>) => Object.keys(parts).filter((name) => name.startsWith('ppt/media/'));
    const refuse = () =>
      vi.spyOn(PptxWriter.prototype, 'addSlide').mockImplementation(function (this: PptxWriter, slide) {
        if (slide.nodes.some((node) => node.name.startsWith('pdf:p2:'))) throw new RangeError('injected: the writer refused the slide');
        return addSlide.call(this, slide);
      });
    for (const where of ['pass', 'lowering', 'writer'] as const) {
      if (where === 'writer') refuse();
      else faults.throwIn = { where, page: 1 };
      const { pptx, report } = await convert(bytes);
      const parts = partsOf(pptx);
      expect(slideCountOf(parts), where).toBe(3);
      expect(report.slides.map((s) => s.failed), where).toEqual([null, 'slide-unwritable', null]);
      expect(treeOf(parts, 2), where).toBe('');
      expect(parts['ppt/slides/_rels/slide2.xml.rels'], where).toBe(reference['ppt/slides/_rels/slide1.xml.rels']); // its layout only
      expect(report.slides[1], where).toEqual({
        ...plain.report.slides[1],
        scale: null,
        counts: { textBoxes: 0, freeforms: 0, rects: 0, lines: 0, pictures: 0, gradients: 0, hotspots: 0, runLinks: 0, fallbacks: 0 },
        fallbacks: [],
        approximations: [],
        failed: 'slide-unwritable',
        notes: [...plain.report.slides[1]!.notes, { opIndex: 0, op: 'convert', detail: 'slide could not be written' }],
      });
      // the other slides are byte for byte the deck's without the throw: slide 3's picture, which page 2 brought first,
      // is in the zip once, before slide 3
      for (const part of ['ppt/slides/slide1.xml', 'ppt/slides/slide3.xml', 'ppt/slides/_rels/slide3.xml.rels']) expect(parts[part], `${where} ${part}`).toBe(reference[part]);
      expect(mediaOf(parts), where).toEqual(mediaOf(reference));
      expect(report.slides.filter((_, i) => i !== 1), where).toEqual(plain.report.slides.filter((_, i) => i !== 1));
      // strict mode throws
      await expect(convert(bytes, { strict: true }), where).rejects.toThrow(/injected/);
      faults.throwIn = null;
      vi.restoreAllMocks();
    }
  });

  it('a font first used on a slide that could not be written is embedded before the next slide that uses it; one no written slide uses is unused (M4 Task 5)', async () => {
    const font = (family: string) => trueTypeFont({ names: [[3, 1, 0x409, 1, family]] });
    const pages = sizedPdf(
      [
        { size: [300, 200], content: 'BT /F3 12 Tf 20 20 Td (ABC) Tj ET' },
        { size: [300, 200], content: 'BT /F4 12 Tf 20 20 Td (ABC) Tj ET BT /F5 12 Tf 20 60 Td (ABC) Tj ET' },
        { size: [300, 200], content: 'BT /F4 12 Tf 20 20 Td (CAB) Tj ET' },
      ],
      {
        fonts: '/F3 30 0 R /F4 40 0 R /F5 50 0 R',
        objects: [
          ...embeddedTrueType(30, 'ABCDEF+FirstSans', font('First Sans')),
          ...embeddedTrueType(40, 'BCDEFG+SecondSans', font('Second Sans')),
          ...embeddedTrueType(50, 'CDEFGH+OnlySans', font('Only Sans')),
        ],
      },
    );
    faults.throwIn = { where: 'lowering', page: 1 };
    const { pptx, report } = await convert(pages, { embedFonts: true });
    expect(report.slides.map((s) => s.failed)).toEqual([null, 'slide-unwritable', null]);
    expect(report.fonts.map((f) => [f.latin, f.pptxEmbedding])).toEqual([
      ['First Sans', 'embedded'],
      ['Second Sans', 'embedded'],
      ['Only Sans', 'unused'],
    ]);
    const names = Object.keys(partsOf(pptx));
    expect(names.filter((n) => n.startsWith('ppt/fonts/'))).toEqual(['ppt/fonts/font1.fntdata', 'ppt/fonts/font2.fntdata']);
    // Second Sans goes into the zip just before slide 3, the first written slide that uses it
    expect(names.indexOf('ppt/fonts/font2.fntdata')).toBe(names.indexOf('ppt/slides/slide3.xml') - 1);
    expect(names.indexOf('ppt/fonts/font1.fntdata')).toBe(names.indexOf('ppt/slides/slide1.xml') - 1);
  });

  it('a first page pdf.js cannot load has no size: the next page gives the slide size', async () => {
    faults.unreadable = 0;
    const pages = sizedPdf([
      { size: [960, 540], content: '0 0 1 rg 10 10 50 50 re f' },
      { size: [400, 300], content: '0 0 1 rg 10 10 50 50 re f' },
    ]);
    const { pptx, report } = await convert(pages);
    expect(report.slides.map((s) => [s.failed, s.scale])).toEqual([
      ['page-unreadable', null],
      [null, null],
    ]);
    expect(report.slideSizePt).toEqual([400, 300]);
    expect(slideSizeOf(partsOf(pptx))).toEqual([400 * 12700, 300 * 12700]);
  });
});

describe('onProgress on the fault paths (M6 Task 1)', () => {
  const three = sizedPdf([1, 2, 3].map(() => ({ size: [300, 200] as [number, number], content: '0 0 1 rg 10 10 50 50 re f' })));
  const watch = () => {
    const calls: [number, number][] = [];
    return { calls, onProgress: (done: number, total: number) => void calls.push([done, total]) };
  };

  it('a blank slide that could not be written counts as a slide written', async () => {
    faults.throwIn = { where: 'pass', page: 1 };
    const { calls, onProgress } = watch();
    const { report } = await convert(three, { onProgress });
    expect(report.slides.map((s) => s.failed)).toEqual([null, 'slide-unwritable', null]);
    expect(calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it('pages that wait for a first sized page: (0, total) first, then one call per slide written', async () => {
    faults.unreadable = 0;
    const { calls, onProgress } = watch();
    await convert(three, { onProgress });
    expect(calls).toEqual([[0, 3], [1, 3], [2, 3], [3, 3]]);
  });

  it('a throw from the last call (done === total) still stops the conversion with that error', async () => {
    const abort = new Error('cancelled at the end');
    await expect(
      convert(three, {
        onProgress: (done, total) => {
          if (done === total) throw abort;
        },
      }),
    ).rejects.toBe(abort);
  });
});
