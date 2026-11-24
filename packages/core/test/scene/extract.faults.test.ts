import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnsupportedOpError } from '../../src/extract/walker';
import { canonicalJson } from '../../src/scene/canonical';
import { extractScene } from '../../src/scene/extract';
import { buildPdf } from '../helpers/minipdf';

/**
 * `extractScene` when a pdf.js call around the pages fails: the document information, a page's links, releasing a page,
 * closing the document. No PDF makes pdf.js fail there on purpose, so this file wraps the adapter (`vi.mock`): each call
 * goes to the real one, and fails when its switch below is on. Nothing of this is in the public options.
 */

const faults = vi.hoisted(() => ({ info: false, links: false, release: false, close: false }));

vi.mock('../../src/engine/pdfjs-adapter', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/engine/pdfjs-adapter')>();
  return {
    ...real,
    documentInfo: async (doc: Parameters<typeof real.documentInfo>[0]) => {
      if (faults.info) throw new Error('injected: document information');
      return real.documentInfo(doc);
    },
    loadPage: async (doc: Parameters<typeof real.loadPage>[0], index: number) => {
      const page = await real.loadPage(doc, index);
      if (faults.links) page.links = async () => Promise.reject(new Error('injected: links'));
      return page;
    },
    releasePage: async (page: Parameters<typeof real.releasePage>[0]) => {
      await real.releasePage(page);
      if (faults.release) throw new Error('injected: release');
    },
    closeDocument: async (doc: Parameters<typeof real.closeDocument>[0]) => {
      await real.closeDocument(doc);
      if (faults.close) throw new Error('injected: close');
    },
  };
});

afterEach(() => Object.assign(faults, { info: false, links: false, release: false, close: false }));

/** One page with a filled square, a URI link, and `content` after the square; with document information. */
function linkedPdf(content = ''): Uint8Array {
  return buildPdf(
    [
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << >> /Annots [5 0 R] >>' },
      { num: 4, data: `1 0 0 rg 10 10 50 50 re f ${content}` },
      { num: 5, body: '<< /Type /Annot /Subtype /Link /Rect [10 20 110 60] /A << /S /URI /URI (https://example.com/) >> >>' },
      { num: 6, body: '<< /Producer (Deckback Producer) /Creator (Deckback Creator) >>' },
    ],
    { trailer: '/Info 6 0 R' },
  );
}

describe('extractScene when a pdf.js call around the pages fails', () => {
  it('links pdf.js cannot read cost the hotspots only, with a note, in strict mode too (ruling M2-R25)', async () => {
    const clean = await extractScene(linkedPdf());
    expect(clean.scene.slides[0]!.elements.map((e) => e.kind)).toEqual(['shape', 'hotspot']);
    faults.links = true;
    const { scene } = await extractScene(linkedPdf());
    const [slide] = scene.slides;
    expect(slide!.failed).toBeNull();
    expect(slide!.elements).toEqual(clean.scene.slides[0]!.elements.filter((e) => e.kind !== 'hotspot'));
    expect(slide!.notes).toEqual([{ opIndex: 0, op: 'getAnnotations', detail: 'links pdf.js could not read' }]);
    // `strict` is about the walker's model (ruling M2-R23): the same slide, not an error.
    const strict = await extractScene(linkedPdf(), { strict: true });
    expect(canonicalJson(strict.scene)).toBe(canonicalJson(scene));
  });

  it('document information pdf.js cannot read gives no producer and no creator', async () => {
    expect((await extractScene(linkedPdf())).scene.source).toMatchObject({ producer: 'Deckback Producer', creator: 'Deckback Creator' });
    faults.info = true;
    for (const strict of [false, true]) {
      const { scene } = await extractScene(linkedPdf(), { strict });
      expect(scene.source).toMatchObject({ producer: null, creator: null, pageCount: 1 });
      expect(scene.slides[0]!.elements.map((e) => e.kind)).toEqual(['shape', 'hotspot']);
    }
  });

  it('a page or a document that fails to close changes nothing and never hides the result', async () => {
    const clean = await extractScene(linkedPdf());
    faults.release = true;
    faults.close = true;
    for (const strict of [false, true]) expect(canonicalJson((await extractScene(linkedPdf(), { strict })).scene)).toBe(canonicalJson(clean.scene));
    // The error that matters is the one reported, not the cleanup's.
    await expect(extractScene(linkedPdf('500 0 d0'), { strict: true })).rejects.toThrow(UnsupportedOpError);
    await expect(extractScene(linkedPdf(), { pages: [5] })).rejects.toThrow(RangeError);
  });
});
