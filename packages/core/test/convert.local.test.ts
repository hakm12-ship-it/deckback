import { readFileSync } from 'node:fs';
import { PptxWriter } from '@deckback/ooxml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { convert } from '../src/convert';
import { repoRoot } from './helpers/fixtures';
import { nodeCounts, partsOf, sizedPdf, slideCountOf } from './helpers/pptx';
import { validatePptx } from './helpers/validate';

/**
 * `convert()` against the Open XML validator (harness/ooxml, .NET): what it writes has 0 errors, and holds what its report
 * counts. The PPTX files are written to `out/ooxml/` (git-ignored); the PDFs are public (`corpus/generated`) or made here.
 */

// The validator runs .NET (it builds itself once into out/ooxml-validator/ on a cold machine): a long timeout.
const VALIDATOR_TIMEOUT_MS = 300_000;

/** A page (0-based) whose slide throws while it is lowered (ruling M3-R62). */
const faults = vi.hoisted(() => ({ lowering: null as number | null }));

vi.mock('../src/passes/lower/text', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/passes/lower/text')>();
  return {
    ...real,
    lowerText: (...args: Parameters<typeof real.lowerText>) => {
      if (faults.lowering !== null && args[0].id.startsWith(`p${faults.lowering + 1}:`)) throw new Error('injected: lowering threw');
      return real.lowerText(...args);
    },
  };
});

afterEach(() => {
  faults.lowering = null;
  vi.restoreAllMocks();
});

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(`${repoRoot}corpus/generated/${name}`));

describe('convert() against the Open XML validator', () => {
  it(
    'a deck with a slide that could not be written (ruling M3-R62) has 0 validator errors, and holds no picture no slide uses',
    async () => {
      const bytes = read('probe_std.pdf');
      const plain = partsOf((await convert(bytes)).pptx);
      const media = Object.keys(plain).filter((p) => p.startsWith('ppt/media/'));
      expect(media).toHaveLength(1);
      // the slide whose picture it is
      const owner = [1, 2, 3].find((n) => plain[`ppt/slides/_rels/slide${n}.xml.rels`]!.includes('../media/'))!;
      // it throws in lowering: its picture waits for a later slide, and none uses it
      faults.lowering = owner - 1;
      const lowered = await convert(bytes);
      expect(lowered.report.slides[owner - 1]!.failed).toBe('slide-unwritable');
      expect(Object.keys(partsOf(lowered.pptx)).filter((p) => p.startsWith('ppt/media/'))).toEqual([]);
      expect(await validatePptx(lowered.pptx, 'convert-unwritable-lowering')).toEqual([]);
      faults.lowering = null;
      // the writer refuses it: its picture was added just before it (it stays, though no slide uses it)
      const addSlide = PptxWriter.prototype.addSlide;
      vi.spyOn(PptxWriter.prototype, 'addSlide').mockImplementation(function (this: PptxWriter, slide) {
        if (slide.nodes.some((node) => node.name.startsWith(`pdf:p${owner}:`))) throw new RangeError('injected: the writer refused the slide');
        return addSlide.call(this, slide);
      });
      const refused = await convert(bytes);
      expect(refused.report.slides[owner - 1]!.failed).toBe('slide-unwritable');
      expect(await validatePptx(refused.pptx, 'convert-unwritable-writer')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );

  it(
    'probe_std converts with the counts the report shows and 0 validator errors',
    async () => {
      const { pptx, report } = await convert(read('probe_std.pdf'));
      const parts = partsOf(pptx);
      expect(slideCountOf(parts)).toBe(3);
      expect(report.slides.map((s) => s.failed)).toEqual([null, null, null]);
      const { approximations, droppedLinks, fallbacks, ...counts } = report.totals;
      expect(nodeCounts(parts)).toEqual(counts);
      // the probe is text, shapes, lines, a gradient and a picture: each is there
      for (const [kind, n] of Object.entries(counts)) if (kind !== 'hotspots' && kind !== 'runLinks') expect(n, kind).toBeGreaterThan(0);
      expect(fallbacks).toBe(0);
      expect(droppedLinks).toEqual({ url: 0, scheme: 0, slide: 0, page: 0, budget: 0, target: 0 });
      expect(Object.keys(parts).filter((p) => p.startsWith('ppt/media/'))).toHaveLength(1);
      expect(await validatePptx(pptx, 'convert-probe_std')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );

  it(
    'atlas-smoke_std, every page, converts with the counts the report shows and 0 validator errors',
    async () => {
      const { pptx, report } = await convert(read('atlas-smoke_std.pdf'));
      const parts = partsOf(pptx);
      expect(slideCountOf(parts)).toBe(38);
      const { approximations, droppedLinks, fallbacks, ...counts } = report.totals;
      expect(nodeCounts(parts)).toEqual(counts);
      expect(await validatePptx(pptx, 'convert-atlas-smoke_std')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );

  it(
    'pages of every size, scaled into the slide, have 0 validator errors',
    async () => {
      const page = (w: number, h: number) => ({
        size: [w, h] as [number, number],
        content: `0.9 0.9 0.9 rg 0 0 ${w} ${h} re f 0 0 1 rg ${w / 4} ${h / 4} ${w / 2} ${h / 2} re f BT /F1 ${h / 10} Tf ${w / 10} ${h / 10} Td (ABC) Tj ET`,
      });
      const decks = [
        sizedPdf([page(5000, 3000), page(595, 842), page(50, 30)]),
        sizedPdf([page(50, 30), page(5000, 3000), page(10000, 50)]),
        sizedPdf([page(10000, 50), page(50, 10000), page(960, 540)]),
      ];
      for (const [i, pdf] of decks.entries()) {
        const { pptx, report } = await convert(pdf);
        expect(report.slides.map((s) => s.failed)).toEqual([null, null, null]);
        expect(await validatePptx(pptx, `convert-sizes-${i + 1}`)).toEqual([]);
      }
    },
    VALIDATOR_TIMEOUT_MS,
  );

  it(
    'decks with their fonts embedded (M4 Task 5) have 0 validator errors: the public corpus, whose OFL subsets PowerPoint exported',
    async () => {
      // each font program there is drawn through a Type0 and a TrueType font dict that share it: a part per program,
      // every font embedded
      for (const [name, programs] of [
        ['probe_std.pdf', 4],
        ['atlas-smoke_std.pdf', 11],
      ] as const) {
        const { pptx, report } = await convert(read(name), { embedFonts: true });
        expect(Object.keys(partsOf(pptx)).filter((p) => p.startsWith('ppt/fonts/')), name).toHaveLength(programs);
        expect(new Set(report.fonts.map((f) => f.pptxEmbedding)), name).toEqual(new Set(['embedded']));
        expect(await validatePptx(pptx, `convert-fonts-${name.replace('.pdf', '')}`), name).toEqual([]);
      }
    },
    VALIDATOR_TIMEOUT_MS,
  );
});
