import { describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, OPS, releasePage, type PageData } from '../../src/engine/pdfjs-adapter';
import { openRawPdf } from '../../src/engine/rawpdf';
import type { Matrix } from '../../src/extract/gstate';
import { toInventory } from '../../src/extract/inventory';
import { UnsupportedOpError, walkPage, type RawOp } from '../../src/extract/walker';
import { buildSlide, ELEMENT_BUDGET, SceneTooComplexError, type BuildContext } from '../../src/scene/build';
import { canonicalJson, sceneHash } from '../../src/scene/canonical';
import { extractScene, SceneInputError } from '../../src/scene/extract';
import { FontTable } from '../../src/scene/fonts';
import { MediaStore } from '../../src/scene/media';
import { SLIDE_WEIGHT_BUDGET, slideWeight } from '../../src/scene/weight';
import type {
  Element,
  FallbackEl,
  HotspotEl,
  PictureEl,
  SceneDeck,
  SceneSlide,
  ShapeEl,
  TextLineEl,
} from '../../src/scene/types';
import { buildPdf, type MiniObject } from '../helpers/minipdf';
import { schemaErrors, validateDeck } from '../helpers/scene';
import { testFont } from '../helpers/sfnt';
import { syntheticPdf } from '../helpers/synthetic';

/**
 * `extractScene` (Task 11): the one public function, on synthetic PDFs. It must survive what it cannot model (lenient mode,
 * Review Focus 1), a page pdf.js cannot load (Review Focus 3) and what the Scene builder cannot build, and it adds the links
 * of a page as hotspots. Owner-password PDFs and repeat runs: extract.local.test.ts.
 */

/** The Scene validates against scene.schema.json, also with its fallbacks, hotspots and failed slides. */
function expectValid(scene: SceneDeck): void {
  expect(schemaErrors(validateDeck, scene)).toEqual([]);
}

const CATALOG: MiniObject = { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' };

/**
 * A PDF of the pages `pages` (object 3, 5, 7, ...; each content stream the next number) with the resources `resources`,
 * and `objects` numbered from 20 up. `catalog` replaces the catalog.
 */
function pdfOf(
  pages: { content: string; page?: string }[],
  options: { resources?: string; objects?: MiniObject[]; catalog?: string; info?: string } = {},
): Uint8Array {
  const nums = pages.map((_, i) => 3 + 2 * i);
  const objects: MiniObject[] = [
    options.catalog === undefined ? CATALOG : { num: 1, body: options.catalog },
    { num: 2, body: `<< /Type /Pages /Kids [${nums.map((n) => `${n} 0 R`).join(' ')}] /Count ${nums.length} >>` },
    ...pages.flatMap(({ content, page }, i): MiniObject[] => [
      {
        num: nums[i]!,
        body: `<< /Type /Page /Parent 2 0 R ${page ?? '/MediaBox [0 0 300 300]'} /Contents ${nums[i]! + 1} 0 R /Resources << ${options.resources ?? ''} >> >>`,
      },
      { num: nums[i]! + 1, data: content },
    ]),
    ...(options.objects ?? []),
  ];
  if (options.info !== undefined) objects.push({ num: 99, body: options.info });
  return buildPdf(objects, options.info === undefined ? {} : { trailer: '/Info 99 0 R' });
}

const shapes = (elements: readonly Element[]): ShapeEl[] => elements.filter((e): e is ShapeEl => e.kind === 'shape');
const fallbacks = (elements: readonly Element[]): FallbackEl[] => elements.filter((e): e is FallbackEl => e.kind === 'fallback');
const hotspots = (elements: readonly Element[]): HotspotEl[] => elements.filter((e): e is HotspotEl => e.kind === 'hotspot');
/** The colour a solid shape fills with, and its box: what says "this paint survived". */
const painted = (e: ShapeEl) => [e.fill?.kind === 'solid' ? e.fill.rgb : null, e.bbox];

/** A tiling pattern's dictionary: 10 pt cells. */
const CELL = '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>';

/** `d0` (setCharWidth) belongs in a Type 3 glyph: on a page, pdf.js passes it on and the walker does not model it. */
const UNKNOWN = '500 0 d0';

describe('extractScene: lenient and strict', () => {
  it('lenient: an unknown operator becomes a note and a fallback and later paints survive', async () => {
    const content = `1 0 0 rg 10 10 50 50 re f ${UNKNOWN} 0 0 1 rg 100 100 50 50 re f`;
    const { scene } = await extractScene(pdfOf([{ content }]));
    const [slide] = scene.slides;
    expect(slide!.failed).toBeNull();
    // pdf.js: setFillRGBColor, constructPath, setCharWidth (2), setFillRGBColor, constructPath (4).
    expect(slide!.elements.map((e) => [e.kind, e.id])).toEqual([
      ['shape', 'p1:z1'],
      ['fallback', 'p1:z2'],
      ['shape', 'p1:z4'],
    ]);
    expect(slide!.elements[1]).toEqual({
      id: 'p1:z2',
      provenance: { opIndex: [2], mcid: null, struct: null },
      clip: [],
      clipBox: [0, 0, 300, 300],
      groups: [],
      mask: null,
      blend: 'normal',
      kind: 'fallback',
      reason: 'unsupported-op',
      coveredOps: [2],
      raster: null,
      bbox: null,
    });
    expect(slide!.notes).toEqual([{ opIndex: 2, op: 'setCharWidth', detail: 'operator the walker does not model' }]);
    expectValid(scene);

    // The rest of the page is intact: the same two shapes as on the page without the operator.
    const { scene: clean } = await extractScene(pdfOf([{ content: '1 0 0 rg 10 10 50 50 re f 0 0 1 rg 100 100 50 50 re f' }]));
    expect(shapes(slide!.elements).map(painted)).toEqual(shapes(clean.slides[0]!.elements).map(painted));
    expect(shapes(slide!.elements).map(painted)).toEqual([
      [[255, 0, 0], [10, 240, 60, 290]],
      [[0, 0, 255], [100, 150, 150, 200]],
    ]);
  });

  it('strict: the same page throws UnsupportedOpError', async () => {
    const bytes = pdfOf([{ content: `1 0 0 rg 10 10 50 50 re f ${UNKNOWN} 0 0 1 rg 100 100 50 50 re f` }]);
    await expect(extractScene(bytes, { strict: true })).rejects.toThrow(UnsupportedOpError);
    await expect(extractScene(bytes, { strict: true })).rejects.toThrow('walker: unsupported operator setCharWidth');
    // walkPage is strict by default (the oracle tests); lenient on request.
    const doc = await openDocument(bytes);
    try {
      const page = await loadPage(doc, 0);
      try {
        expect(() => walkPage(page)).toThrow(UnsupportedOpError);
        expect(() => walkPage(page, { strict: true })).toThrow(UnsupportedOpError);
        const ops = walkPage(page, { strict: false });
        expect(ops.map((op) => [op.kind, op.opIndex])).toEqual([
          ['fill', 1],
          ['unsupported', 2],
          ['fill', 4],
        ]);
        // What the walker could not model is no paint of the inventory (as a fallback is none, ruling M2-R17).
        expect(toInventory([{ index: 0, size: [300, 300], ops }]).pages[0]!.paints.map((p) => p.kind)).toEqual(['fill', 'fill']);
      } finally {
        await releasePage(page);
      }
    } finally {
      await closeDocument(doc);
    }
  });

  it('lenient in a tile cell and in a soft mask: the fallback is where the operator was, the note names the page op', async () => {
    const objects: MiniObject[] = [
      {
        num: 20,
        dict: '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>',
        data: `1 0 0 rg 0 0 5 5 re f ${UNKNOWN} 0 1 0 rg 5 5 5 5 re f`,
      },
      { num: 21, body: '<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 22 0 R >> >>' },
      {
        num: 22,
        dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>',
        data: `1 g 0 0 100 100 re f ${UNKNOWN} 0.5 g 0 0 50 50 re f`,
      },
    ];
    const content = '/Pattern cs /P1 scn 10 10 100 100 re f /GS1 gs 0 0 1 rg 150 150 50 50 re f';
    const { scene } = await extractScene(pdfOf([{ content }], { resources: '/Pattern << /P1 20 0 R >> /ExtGState << /GS1 21 0 R >>', objects }));
    const [slide] = scene.slides;
    const [tiled, masked] = shapes(slide!.elements);
    const cell = tiled!.fill!.kind === 'tile' ? tiled!.fill!.cell : null;
    expect(cell!.elements.map((e) => [e.kind, e.id])).toEqual([
      ['shape', `${tiled!.id}/z1`],
      ['fallback', `${tiled!.id}/z2`],
      ['shape', `${tiled!.id}/z4`],
    ]);
    const mask = slide!.masks[masked!.mask!]!;
    expect(mask.elements.map((e) => e.kind)).toEqual(['shape', 'fallback', 'shape']);
    expect(slide!.notes.map((n) => [n.op, n.detail])).toEqual([
      ['setCharWidth', 'operator the walker does not model in a tile cell'],
      ['setCharWidth', 'operator the walker does not model in a soft mask'],
    ]);
    expect(slide!.notes[0]!.opIndex).toBe(tiled!.provenance.opIndex[0]); // the page op that paints the cell
    expectValid(scene);
  });

  it('a paint with a number that is not finite becomes a fallback and a note; the rest of the slide stays', async () => {
    // pdf.js reads a number of 400 digits as Infinity: the shape under that CTM has no finite coordinates.
    const huge = '9'.repeat(400);
    const content = `1 0 0 rg q ${huge} 0 0 1 0 0 cm 0 0 10 10 re f Q 0 0 1 rg 100 100 50 50 re f`;
    const { scene } = await extractScene(pdfOf([{ content }]));
    const [slide] = scene.slides;
    expect(slide!.failed).toBeNull();
    // The fallback has the id the shape would have had.
    expect(slide!.elements.map((e) => [e.kind, e.id])).toEqual([
      ['fallback', 'p1:z3'],
      ['shape', 'p1:z6'],
    ]);
    expect(fallbacks(slide!.elements)[0]).toMatchObject({ reason: 'unbuildable', coveredOps: [3], bbox: null, clipBox: [0, 0, 300, 300] });
    expect(slide!.notes).toEqual([{ opIndex: 3, op: 'constructPath', detail: 'paint with a number that is not finite' }]);
    expect(() => canonicalJson(scene)).not.toThrow();
    expectValid(scene);
    await expect(extractScene(pdfOf([{ content }]), { strict: true })).rejects.toThrow('has a number that is not finite');
  });

  it('a glyph with a number that is not finite ends its line; one fallback stands for the rest of the run', async () => {
    // A word spacing of 400 digits is Infinity: the space advances that far, and what follows it is nowhere.
    const content = `BT /F1 10 Tf 20 200 Td ${'9'.repeat(400)} Tw (AB CA) Tj ET 0 0 1 rg 10 10 5 5 re f`;
    const { scene } = await extractScene(syntheticPdf(content));
    const [slide] = scene.slides;
    // pdf.js: beginText, dependency, setFont, moveText, setWordSpacing, showText (5), endText, ...
    expect(slide!.elements.map((e) => [e.kind, e.id])).toEqual([
      ['textline', 'p1:z5'],
      ['fallback', 'p1:z5:1'],
      ['shape', 'p1:z8'],
    ]);
    expect((slide!.elements[0] as TextLineEl).runs[0]!.text).toBe('AB');
    expect(fallbacks(slide!.elements)[0]).toMatchObject({ reason: 'unbuildable', coveredOps: [5] });
    expect(slide!.notes).toEqual([{ opIndex: 5, op: 'showText', detail: 'glyph with a number that is not finite' }]);
    expect(() => canonicalJson(scene)).not.toThrow();
    expectValid(scene);
  });

  it('a slide that cannot be built at all is failed, and the deck continues', async () => {
    // A clip with no finite bounds: no element under it can say its clip.
    const huge = '9'.repeat(400);
    const bytes = pdfOf([
      { content: `q 0 0 ${huge} 10 re W n 1 0 0 rg 0 0 5 5 re f Q` },
      { content: '0 0 1 rg 10 10 50 50 re f' },
    ]);
    const { scene } = await extractScene(bytes);
    expect(scene.slides.map((s) => [s.index, s.failed, s.elements.length])).toEqual([
      [0, 'slide-unbuildable', 0],
      [1, null, 1],
    ]);
    expect(scene.slides[0]).toEqual({
      index: 0,
      sizePt: [300, 300],
      elements: [],
      clips: {},
      masks: {},
      notes: [],
      failed: 'slide-unbuildable',
    });
    expect(() => canonicalJson(scene)).not.toThrow();
    expectValid(scene);
  });

  it('buildSlide, lenient: a RawOp the builder cannot build becomes a fallback and a note', async () => {
    const ctx = (): BuildContext => ({
      media: new MediaStore(null),
      fonts: new FontTable(null),
      page: { ops: { fnArray: [], argsArray: [] }, obj: () => undefined, pageRef: { num: 0, gen: 0 }, structTree: null },
    });
    const op = (over: Partial<RawOp>): RawOp => ({
      opIndex: 0,
      kind: 'fill',
      bbox: [10, 10, 20, 20],
      rgb: [1, 2, 3],
      alpha: 1,
      evenOdd: false,
      path: [['M', 10, 10], ['L', 20, 20]],
      mcid: null,
      clip: [0, 0, 100, 100],
      blend: 'normal',
      masked: false,
      groups: [],
      ...over,
    });
    // A stroke without the line style the walker always gives it, and a fill after it.
    const ops = [op({ kind: 'stroke', opIndex: 1 }), op({ opIndex: 2 })];
    await expect(buildSlide({ index: 0, sizePt: [100, 100], ops }, ctx())).rejects.toThrow('RawOp stroke at op 1 has no line');
    const slide = await buildSlide({ index: 0, sizePt: [100, 100], ops }, ctx(), { strict: false });
    expect(slide.elements.map((e) => [e.kind, e.id])).toEqual([
      ['fallback', 'p1:z1'],
      ['shape', 'p1:z2'],
    ]);
    expect(fallbacks(slide.elements)[0]).toMatchObject({ reason: 'unbuildable', coveredOps: [1], bbox: [10, 10, 20, 20] });
    // No page behind these ops: the op is named by the walker's kind.
    expect(slide.notes).toEqual([{ opIndex: 1, op: 'op -1', detail: 'paint the Scene could not build' }]);
  });
});

describe('extractScene: pages', () => {
  it('a page that cannot be listed becomes a failed slide and the deck continues', async () => {
    // Page 2 of 3 is a page tree node that holds itself: pdf.js cannot load it, and loads the others.
    const bytes = buildPdf([
      CATALOG,
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << >> >>' },
      { num: 4, data: '1 0 0 rg 10 10 50 50 re f' },
      { num: 5, body: '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R] /Count 1 >>' },
      { num: 7, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 8 0 R /Resources << >> >>' },
      { num: 8, data: '0 0 1 rg 20 20 50 50 re f' },
    ]);
    const { scene } = await extractScene(bytes);
    expect(scene.source.pageCount).toBe(3);
    expectValid(scene);
    expect(scene.slides).toHaveLength(3);
    expect(scene.slides[1]).toEqual({
      index: 1,
      sizePt: [0, 0],
      elements: [],
      clips: {},
      masks: {},
      notes: [],
      failed: 'page-unreadable',
    });
    expect(scene.slides.map((s) => [s.index, s.failed, s.sizePt])).toEqual([
      [0, null, [300, 300]],
      [1, 'page-unreadable', [0, 0]],
      [2, null, [200, 100]],
    ]);
    // Every other page is as it is on its own.
    for (const index of [0, 2]) {
      const alone = await extractScene(bytes, { pages: [index] });
      expect(canonicalJson(scene.slides[index])).toBe(canonicalJson(alone.scene.slides[0]));
    }
    expect(shapes(scene.slides[2]!.elements).map(painted)).toEqual([[[0, 0, 255], [20, 30, 70, 80]]]);
    // It is no walker matter: strict mode fails the slide the same way.
    expect((await extractScene(bytes, { strict: true })).scene.slides.map((s) => s.failed)).toEqual([null, 'page-unreadable', null]);
  });

  it('pages picks the slides and their order; an index outside the document is a RangeError', async () => {
    const bytes = pdfOf([{ content: '1 0 0 rg 0 0 1 1 re f' }, { content: '0 1 0 rg 0 0 2 2 re f' }, { content: '0 0 1 rg 0 0 3 3 re f' }]);
    const all = await extractScene(bytes);
    expect(all.scene.slides.map((s) => s.index)).toEqual([0, 1, 2]);
    expect((await extractScene(bytes, { pages: [] })).scene.slides.map((s) => s.index)).toEqual([0, 1, 2]); // empty: every page
    const picked = await extractScene(bytes, { pages: [2, 0] });
    expect(picked.scene.slides.map((s) => [s.index, s.elements[0]!.id])).toEqual([
      [2, 'p3:z1'],
      [0, 'p1:z1'],
    ]);
    expect(picked.scene.source.pageCount).toBe(3);
    for (const pages of [[3], [-1], [0.5], [Number.NaN]]) {
      await expect(extractScene(bytes, { pages }), String(pages)).rejects.toThrow(RangeError);
    }
  });

  it('source: producer and creator from the document information, tagged from the structure tree, the page count', async () => {
    const tagged = pdfOf([{ content: '/P << /MCID 0 >> BDC 1 0 0 rg 0 0 10 10 re f EMC', page: '/MediaBox [0 0 300 300] /StructParents 0' }], {
      catalog: '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 20 0 R >>',
      objects: [
        { num: 20, body: '<< /Type /StructTreeRoot /K 21 0 R /ParentTree 22 0 R >>' },
        { num: 21, body: '<< /Type /StructElem /S /P /P 20 0 R /Pg 3 0 R /K 0 >>' },
        { num: 22, body: '<< /Nums [0 [21 0 R]] >>' },
      ],
      info: '<< /Producer (Deckback Producer) /Creator <FEFF00440065006300B0> >>',
    });
    const { scene } = await extractScene(tagged);
    expect(scene.source).toEqual({ producer: 'Deckback Producer', creator: 'Dec°', tagged: true, encrypted: false, pageCount: 1 });
    expect(scene.slides[0]!.elements[0]!.provenance).toEqual({ opIndex: [2], mcid: 0, struct: ['P'] });
    expectValid(scene);
    const plain = await extractScene(pdfOf([{ content: '1 0 0 rg 0 0 10 10 re f' }]));
    expect(plain.scene.source).toEqual({ producer: null, creator: null, tagged: false, encrypted: false, pageCount: 1 });
    expect(plain.scene.schema).toBe('deckback.scene/1');
  });

  it('source.tagged counts converted pages only: a tagged page whose slide failed leaves no trace (final review F3)', async () => {
    const tagged = (content: string) =>
      pdfOf([{ content, page: '/MediaBox [0 0 300 300] /StructParents 0' }], {
        catalog: '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 20 0 R >>',
        objects: [
          { num: 20, body: '<< /Type /StructTreeRoot /K 21 0 R /ParentTree 22 0 R >>' },
          { num: 21, body: '<< /Type /StructElem /S /P /P 20 0 R /Pg 3 0 R /K 0 >>' },
          { num: 22, body: '<< /Nums [0 [21 0 R]] >>' },
        ],
      });
    // The page's clip has no finite bounds: its slide cannot be built, and nothing of it is in the deck.
    const failing = await extractScene(tagged(`/P << /MCID 0 >> BDC q 0 0 ${'9'.repeat(400)} 10 re W n 1 0 0 rg 0 0 5 5 re f Q EMC`));
    expect(failing.scene.slides.map((s) => s.failed)).toEqual(['slide-unbuildable']);
    expect(failing.scene.source).toEqual({ producer: null, creator: null, tagged: false, encrypted: false, pageCount: 1 });
    // The same page converted is tagged.
    const converted = await extractScene(tagged('/P << /MCID 0 >> BDC 1 0 0 rg 0 0 10 10 re f EMC'));
    expect(converted.scene.slides.map((s) => s.failed)).toEqual([null]);
    expect(converted.scene.source.tagged).toBe(true);
  });

  it('struct is looked up only on the page: what a tile cell or a soft mask draws has none', async () => {
    const objects: MiniObject[] = [
      { num: 20, body: '<< /Type /StructTreeRoot /K 21 0 R /ParentTree 22 0 R >>' },
      { num: 21, body: '<< /Type /StructElem /S /Figure /P 20 0 R /Pg 3 0 R /K 0 >>' },
      { num: 22, body: '<< /Nums [0 [21 0 R]] >>' },
      {
        // The cell's own marked content says MCID 0 too: in the cell's content, not the page's.
        num: 23,
        dict: '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>',
        data: '/P << /MCID 0 >> BDC 1 0 0 rg 0 0 5 5 re f EMC',
      },
      { num: 24, body: '<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 25 0 R >> >>' },
      {
        num: 25,
        dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>',
        data: '1 g 0 0 100 100 re f',
      },
    ];
    const content = '/Figure << /MCID 0 >> BDC /Pattern cs /P1 scn 10 10 100 100 re f q /GS1 gs 0 0 1 rg 150 150 50 50 re f Q EMC';
    const bytes = pdfOf([{ content, page: '/MediaBox [0 0 300 300] /StructParents 0' }], {
      catalog: '<< /Type /Catalog /Pages 2 0 R /MarkInfo << /Marked true >> /StructTreeRoot 20 0 R >>',
      resources: '/Pattern << /P1 23 0 R >> /ExtGState << /GS1 24 0 R >>',
      objects,
    });
    const { scene } = await extractScene(bytes);
    const [slide] = scene.slides;
    const [tiled, masked] = shapes(slide!.elements);
    expect(tiled!.provenance).toMatchObject({ mcid: 0, struct: ['Figure'] });
    expect(masked!.provenance).toMatchObject({ mcid: 0, struct: ['Figure'] });
    const cell = tiled!.fill!.kind === 'tile' ? tiled!.fill!.cell : null;
    expect(cell!.elements[0]!.provenance).toEqual({ opIndex: [2], mcid: 0, struct: null });
    const mask = slide!.masks[masked!.mask!]!;
    expect(mask.elements).toHaveLength(1);
    expect(mask.elements[0]!.provenance).toMatchObject({ mcid: 0, struct: null });
  });

  it('not a PDF throws SceneInputError not-pdf', async () => {
    for (const bytes of [new TextEncoder().encode('hello, this is no PDF at all'), new Uint8Array(0)]) {
      const error: unknown = await extractScene(bytes).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SceneInputError);
      expect(error).toMatchObject({ kind: 'not-pdf', name: 'SceneInputError' });
    }
  });
});

describe('extractScene: links', () => {
  /** Two pages; page 1 has a URI link, links to page 2 by an explicit and by a named destination, a JavaScript link and a note. */
  function linked(page = '/MediaBox [0 0 300 300]'): Uint8Array {
    return pdfOf(
      [
        { content: '1 0 0 rg 10 20 100 40 re f', page: `${page} /Annots [20 0 R 21 0 R 22 0 R 23 0 R 24 0 R]` },
        { content: '0 0 1 rg 0 0 10 10 re f' },
      ],
      {
        catalog: '<< /Type /Catalog /Pages 2 0 R /Names << /Dests << /Names [(chapter) [5 0 R /Fit]] >> >> >>',
        objects: [
          { num: 20, body: '<< /Type /Annot /Subtype /Link /Rect [10 20 110 60] /Border [0 0 0] /A << /S /URI /URI (https://example.com/a?b=1) >> >>' },
          { num: 21, body: '<< /Type /Annot /Subtype /Link /Rect [10 100 50 120] /Dest [5 0 R /XYZ 0 0 0] >>' },
          { num: 22, body: '<< /Type /Annot /Subtype /Link /Rect [60 100 90 120] /A << /S /GoTo /D (chapter) >> >>' },
          { num: 23, body: '<< /Type /Annot /Subtype /Link /Rect [100 100 140 120] /A << /S /URI /URI (javascript:alert(1)) >> >>' },
          { num: 24, body: '<< /Type /Annot /Subtype /Text /Rect [200 200 220 220] /Contents (a note) >>' },
        ],
      },
    );
  }

  it('a link annotation is a hotspot with its URL', async () => {
    const { scene } = await extractScene(linked());
    const [slide] = scene.slides;
    // After the paints, in the order of /Annots; a note is no link.
    expect(slide!.elements.map((e) => [e.kind, e.id])).toEqual([
      ['shape', 'p1:z1'],
      ['hotspot', 'p1:a0'],
      ['hotspot', 'p1:a1'],
      ['hotspot', 'p1:a2'],
      ['hotspot', 'p1:a3'],
    ]);
    expect(slide!.elements[1]).toEqual({
      id: 'p1:a0',
      provenance: { opIndex: [], mcid: null, struct: null },
      clip: [],
      clipBox: [0, 0, 300, 300],
      groups: [],
      mask: null,
      blend: 'normal',
      kind: 'hotspot',
      rect: [10, 240, 110, 280],
      link: { url: 'https://example.com/a?b=1', dest: null },
    });
    // A destination in the document is its page, 1-based as the ids' p<n> (ruling M2-R22): both links go to page 2.
    // A link pdf.js does not call safe has no URL.
    expect(hotspots(slide!.elements).map((h) => [h.rect, h.link])).toEqual([
      [[10, 240, 110, 280], { url: 'https://example.com/a?b=1', dest: null }],
      [[10, 180, 50, 200], { url: null, dest: 'page:2' }],
      [[60, 180, 90, 200], { url: null, dest: 'page:2' }],
      [[100, 180, 140, 200], { url: null, dest: null }],
    ]);
    expect(scene.slides[1]!.elements.map((e) => e.kind)).toEqual(['shape']);
    expectValid(scene);
  });

  it('the page frame applies to a hotspot on a /Rotate 90 page', async () => {
    const { scene } = await extractScene(linked('/MediaBox [0 0 300 200] /Rotate 90'));
    const [slide] = scene.slides;
    expect(slide!.sizePt).toEqual([200, 300]);
    const [link] = hotspots(slide!.elements);
    // The link's /Rect is the rectangle the page fills: the same box in the slide frame.
    const [shape] = shapes(slide!.elements);
    expect(shape!.bbox).toEqual([20, 10, 60, 110]);
    expect(link!.rect).toEqual(shape!.bbox);
    expect(link!.clipBox).toEqual([0, 0, 200, 300]);
  });
});

describe('extractScene: privacy', () => {
  it('notes and fallback reasons never contain text from the page', async () => {
    const S = 'SECRETTEXT';
    const resources =
      `/Font << /${S} 20 0 R >> /XObject << /${S} 21 0 R /${S}M 22 0 R >> /Pattern << /${S}P 23 0 R /${S}C 24 0 R >> ` +
      `/Shading << /${S}S 25 0 R >>`;
    const objects: MiniObject[] = [
      {
        num: 20,
        body: `<< /Type /Font /Subtype /TrueType /BaseFont /${S} /FirstChar 32 /LastChar 90 /Widths [${'500 '.repeat(59)}] /Encoding /WinAnsiEncoding >>`,
      },
      // A JPEG pdf.js cannot decode (image-unreadable).
      { num: 21, dict: '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: `${S} ${S}` },
      // An image mask, painted with a pattern below (stencil-pattern).
      { num: 22, dict: '/Type /XObject /Subtype /Image /Width 8 /Height 1 /ImageMask true /BitsPerComponent 1', data: Uint8Array.of(0x0f) },
      { num: 23, dict: CELL, data: '1 0 0 rg 0 0 5 5 re f' },
      // A cell with an operator the walker does not model (unsupported-op in a tile cell).
      { num: 24, dict: CELL, data: `${UNKNOWN} 0 0 5 5 re f` },
      // A shading whose function is missing (shading-unreadable).
      { num: 25, body: '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 300 0] /Function 99 0 R >>' },
    ];
    const content = [
      `BT /${S} 12 Tf 10 280 Td (${S}) Tj ET`,
      `/Pattern CS /${S}P SCN BT /${S} 12 Tf 1 Tr 10 260 Td (${S}) Tj ET`, // text stroked with a pattern: a note
      UNKNOWN,
      `q 20 0 0 20 10 200 cm /${S} Do Q`,
      `q /Pattern cs /${S}P scn 80 0 0 10 10 180 cm /${S}M Do Q`,
      `q /Pattern cs /${S}C scn 10 100 50 50 re f Q`,
      `q 0 0 300 50 re W n /${S}S sh Q`,
    ].join(' ');
    const { scene } = await extractScene(pdfOf([{ content }], { resources, objects }));
    const [slide] = scene.slides;
    const all = (elements: readonly Element[]): Element[] =>
      elements.flatMap((e) => [e, ...(e.kind === 'shape' && e.fill?.kind === 'tile' ? all(e.fill.cell.elements) : [])]);
    const found = fallbacks(all(slide!.elements));
    expect(new Set(found.map((f) => f.reason))).toEqual(new Set(['unsupported-op', 'image-unreadable', 'stencil-pattern', 'shading-unreadable']));
    expect(slide!.notes.map((n) => n.detail)).toEqual([
      'text stroked with a pattern',
      'operator the walker does not model',
      'image pdf.js could not decode',
      'image mask filled with a pattern',
      'operator the walker does not model in a tile cell',
      'shading pdf.js could not read',
    ]);
    // The page's text is in the Scene (its runs), and nowhere in what the notes and fallbacks say.
    expect((slide!.elements.find((e) => e.kind === 'textline') as TextLineEl).runs[0]!.text).toBe(S);
    for (const said of [JSON.stringify(slide!.notes), JSON.stringify(found)]) expect(said).not.toMatch(/secret/i);
    expectValid(scene);
  });
});

describe('extractScene: the bundle', () => {
  it('holds the media bytes under their SHA-256, and its hash is the same twice', async () => {
    const bytes = syntheticPdf('q 30 0 0 20 10 10 cm /Im2 Do Q q 20 0 0 20 100 100 cm /Im3 Do Q 1 0 0 rg 0 0 5 5 re f');
    const first = await extractScene(bytes);
    const second = await extractScene(bytes);
    expect(await sceneHash(first.scene)).toBe(await sceneHash(second.scene));
    expect([...first.media.keys()]).toEqual(Object.keys(first.scene.media));
    expect([...first.media.keys()]).toHaveLength(2);
    for (const [hash, data] of first.media) {
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
      expect(Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')).toBe(hash);
      expect(first.scene.media[hash]!.byteLength).toBe(data.length);
    }
  });
});

// -- Fix round 1 -------------------------------------------------------------------------------------------------------

/** A number of 400 digits: pdf.js reads it as Infinity. */
const HUGE = '9'.repeat(400);

describe('extractScene, lenient: what it returns can always be written', () => {
  it('a page whose size is not finite is a failed slide of size [0, 0], and the Scene hashes', async () => {
    const bytes = pdfOf([{ content: '1 0 0 rg 0 0 10 10 re f', page: `/MediaBox [0 0 ${HUGE} 100]` }, { content: '0 0 1 rg 0 0 10 10 re f' }]);
    const { scene } = await extractScene(bytes);
    expect(scene.slides[0]).toEqual({ index: 0, sizePt: [0, 0], elements: [], clips: {}, masks: {}, notes: [], failed: 'slide-unbuildable' });
    expect(scene.slides[1]!.failed).toBeNull();
    await expect(sceneHash(scene)).resolves.toMatch(/^[0-9a-f]{64}$/);
    expectValid(scene);
    await expect(extractScene(bytes, { strict: true })).rejects.toThrow('not finite');
  });

  it('every PDF made here to break it gives a Scene canonicalJson can write', async () => {
    const circular = buildPdf([
      CATALOG,
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << >> >>' },
      { num: 4, data: '1 0 0 rg 10 10 50 50 re f' },
      { num: 5, body: '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R] /Count 1 >>' },
    ]);
    const huge = (content: string, page?: string) => pdfOf([{ content, ...(page === undefined ? {} : { page }) }]);
    const link = `<< /Type /Annot /Subtype /Link /Rect [0 0 ${HUGE} 10] /A << /S /URI /URI (https://example.com/) >> >>`;
    const malformed: [string, Uint8Array][] = [
      ['a /MediaBox of 400 digits', huge('1 0 0 rg 0 0 10 10 re f', `/MediaBox [0 0 ${HUGE} ${HUGE}]`)],
      ['a /CropBox of 400 digits', huge('1 0 0 rg 0 0 10 10 re f', `/MediaBox [0 0 300 300] /CropBox [0 0 ${HUGE} 300]`)],
      ['a CTM', huge(`q ${HUGE} 0 0 1 0 0 cm 0 0 10 10 re f Q`)],
      ['a clip', huge(`q 0 0 ${HUGE} 10 re W n 0 0 5 5 re f Q`)],
      ['a line width', huge(`${HUGE} w 10 10 m 100 100 l S`)],
      ['a dash', huge(`[${HUGE} 2] 0 d 10 10 m 100 100 l S`)],
      ['a font size', syntheticPdf(`BT /F1 ${HUGE} Tf 10 10 Td (A) Tj ET`)],
      ['a word spacing', syntheticPdf(`BT /F1 10 Tf ${HUGE} Tw 10 10 Td (A B) Tj ET`)],
      ['a text rise', syntheticPdf(`BT /F1 10 Tf ${HUGE} Ts 10 10 Td (A) Tj ET`)],
      ['a character spacing', syntheticPdf(`BT /F1 10 Tf ${HUGE} Tc 10 10 Td (AB) Tj ET`)],
      ['an image matrix', syntheticPdf(`q ${HUGE} 0 0 20 10 10 cm /Im2 Do Q q 20 0 0 ${HUGE} 10 10 cm /Im3 Do Q`)],
      ['a shading under a CTM', syntheticPdf(`q ${HUGE} 0 0 1 0 0 cm /Sh2 sh Q /Pattern cs /P5 scn 0 0 10 10 re f`)],
      ['a form and a soft mask under a CTM', syntheticPdf(`q ${HUGE} 0 0 1 0 0 cm /Fm8 Do /GS2 gs 0 0 10 10 re f Q`)],
      ['a link /Rect', pdfOf([{ content: '0 0 10 10 re f', page: '/MediaBox [0 0 300 300] /Annots [20 0 R]' }], { objects: [{ num: 20, body: link }] })],
      ['a page tree that holds itself', circular],
      ['an operator the walker does not model', huge(UNKNOWN)],
    ];
    for (const [name, bytes] of malformed) {
      const { scene } = await extractScene(bytes);
      expect(() => canonicalJson(scene), name).not.toThrow();
      expect(schemaErrors(validateDeck, scene), name).toEqual([]);
    }
  });
});

describe('extractScene, lenient: what fails leaves no trace in the deck', () => {
  /** Helvetica and Courier, not embedded, and two small images. */
  const resources = '/Font << /FH 20 0 R /FC 21 0 R >> /XObject << /ImA 22 0 R /ImB 23 0 R >>';
  const objects: MiniObject[] = [
    { num: 20, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' },
    { num: 21, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>' },
    { num: 22, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: Uint8Array.of(255, 0, 0, 0, 255, 0) },
    { num: 23, dict: '/Type /XObject /Subtype /Image /Width 1 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: Uint8Array.of(0, 0, 255, 9, 9, 9) },
  ];
  /** The second page: Courier and image B. */
  const courier = 'BT /FC 12 Tf 10 280 Td (Mono) Tj ET q 30 0 0 20 100 100 cm /ImB Do Q';

  it('a failed slide adds no font and no media: the next page is as it is in a deck without the failed one', async () => {
    // Page 1 has Helvetica and image A, then a clip of no finite bounds: the slide cannot be written, after its text and
    // picture were made.
    const failing = `BT /FH 12 Tf 10 280 Td (Hello) Tj ET q 30 0 0 20 10 10 cm /ImA Do Q q 0 0 ${HUGE} 10 re W n 1 0 0 rg 0 0 5 5 re f Q`;
    const bytes = pdfOf([{ content: failing }, { content: courier }], { resources, objects });
    const deck = await extractScene(bytes);
    const alone = await extractScene(bytes, { pages: [1] });
    expect(deck.scene.slides.map((s) => s.failed)).toEqual(['slide-unbuildable', null]);
    expect(Object.values(deck.scene.fonts).map((f) => [f.key, f.baseFont])).toEqual([['f1', 'Courier']]);
    expect(deck.scene.fonts).toEqual(alone.scene.fonts);
    expect(deck.scene.media).toEqual(alone.scene.media);
    expect([...deck.media.keys()]).toEqual([...alone.media.keys()]);
    expect(Object.keys(deck.scene.media)).toHaveLength(1);
    expect(canonicalJson(deck.scene.slides[1])).toBe(canonicalJson(alone.scene.slides[0]));
  });

  it('an element that becomes a fallback adds no font and no media', async () => {
    // Moved 400 digits to the right, the text (its font resolved) and the picture (its media stored) are made and found not
    // finite: each is a fallback.
    const failing = `q 1 0 0 1 ${HUGE} 0 cm BT /FH 12 Tf 10 10 Td (Hi) Tj ET 30 0 0 20 10 10 cm /ImA Do Q ${courier}`;
    const bytes = pdfOf([{ content: failing }], { resources, objects });
    const { scene, media } = await extractScene(bytes);
    const [slide] = scene.slides;
    expect(slide!.elements.map((e) => [e.kind, e.kind === 'fallback' ? e.reason : null])).toEqual([
      ['fallback', 'unbuildable'],
      ['fallback', 'unbuildable'],
      ['textline', null],
      ['picture', null],
    ]);
    expect(Object.values(scene.fonts).map((f) => [f.key, f.baseFont])).toEqual([['f1', 'Courier']]);
    expect((slide!.elements[2] as TextLineEl).runs[0]!.fontKey).toBe('f1');
    expect(Object.keys(scene.media)).toHaveLength(1);
    expect([...media.keys()]).toEqual(Object.keys(scene.media));
    const clean = await extractScene(pdfOf([{ content: courier }], { resources, objects }));
    expect(scene.media).toEqual(clean.scene.media);
    expectValid(scene);
  });
});

describe('lenient walking: a failure never unbalances the state', () => {
  /** A page of pdf.js operators made up here, for what no PDF makes pdf.js give: a text paint that throws when flushed. */
  function fakePage(list: [number, unknown[]][], objs: Record<string, unknown>): PageData {
    return {
      index: 0,
      pageRef: { num: 1, gen: 0 },
      view: [0, 0, 100, 100],
      rotate: 0,
      ops: { fnArray: list.map(([fn]) => fn), argsArray: list.map(([, args]) => args) },
      structTree: null,
      font: () => ({
        loadedName: 'f1',
        name: 'F',
        ascent: 0.8,
        descent: -0.2,
        isType3Font: false,
        missingFile: true,
        vertical: false,
        fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      }),
      obj: (id: string) => objs[id],
      isOcVisible: () => true,
      links: async () => [],
    };
  }
  const glyph = (unicode: string) => ({ unicode, width: 500, isSpace: false });
  /** A shading pdf.js gave in a form the walker cannot read: the stroke of the text below throws when its stretch is painted. */
  const BAD_SHADING = { bad: ['RadialAxial', 'axial', null, 'no stops', [0, 0], [1, 0], null, null] };
  const rect = (x: number, y: number, w: number, h: number): [number, unknown[]] => [
    OPS.constructPath,
    [OPS.fill, [Float32Array.of(0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 4)], null],
  ];
  /** q, a CTM of scale 2, a stroke in that shading, and text stroked with it (Tr 1): op 6 shows it. */
  const TEXT: [number, unknown[]][] = [
    [OPS.save, []],
    [OPS.transform, [2, 0, 0, 2, 0, 0]],
    [OPS.setStrokeColorN, ['Shading', 'bad', null]],
    [OPS.beginText, []],
    [OPS.setFont, ['f1', 10]],
    [OPS.setTextRenderingMode, [1]],
    [OPS.showText, [[glyph('A'), glyph('B')]]],
  ];

  it('a text paint that throws when Q flushes it: Q still restores the state, and the paint is skipped', () => {
    const page = fakePage([...TEXT, [OPS.restore, []], [OPS.setFillRGBColor, ['#ff0000']], rect(10, 10, 20, 20)], BAD_SHADING);
    expect(() => walkPage(page)).toThrow(TypeError);
    const ops = walkPage(page, { strict: false });
    expect(ops.map((op) => [op.kind, op.opIndex])).toEqual([
      ['glyph', 6],
      ['glyph', 6],
      ['unsupported', 6],
      ['fill', 9],
    ]);
    expect(ops[2]!.unsupported).toBe('operator the walker could not read');
    // After Q the CTM is the page's again: a 20 pt square, not a 40 pt one.
    expect(ops[3]!.bbox).toEqual([10, 70, 30, 90]);
  });

  it('a text paint that throws at the end of the walk is skipped too', () => {
    const page = fakePage(TEXT, BAD_SHADING);
    expect(() => walkPage(page)).toThrow(TypeError);
    expect(walkPage(page, { strict: false }).map((op) => [op.kind, op.opIndex])).toEqual([
      ['glyph', 6],
      ['glyph', 6],
      ['unsupported', 6],
    ]);
  });

  it('an operator it cannot model in hidden optional content gives no fallback and no note; in shown content, both', async () => {
    const hidden = await extractScene(syntheticPdf(`/OC /OCoff BDC ${UNKNOWN} EMC 1 0 0 rg 0 0 5 5 re f`));
    expect(hidden.scene.slides[0]!.elements.map((e) => e.kind)).toEqual(['shape']);
    expect(hidden.scene.slides[0]!.notes).toEqual([]);
    const shown = await extractScene(syntheticPdf(`/OC /OCon BDC ${UNKNOWN} EMC 1 0 0 rg 0 0 5 5 re f`));
    expect(shown.scene.slides[0]!.elements.map((e) => e.kind)).toEqual(['fallback', 'shape']);
    expect(shown.scene.slides[0]!.notes.map((n) => n.op)).toEqual(['setCharWidth']);
  });
});

describe('the raw reader finds a page by its reference, where the page trees disagree', () => {
  /** An embedded TrueType font named `name` at `num` (font, descriptor, program), whose program's family is `family`. */
  const embeddedFont = (num: number, name: string, family: string): MiniObject[] => [
    {
      num,
      body:
        `<< /Type /Font /Subtype /TrueType /BaseFont /${name} /FirstChar 65 /LastChar 67 /Widths [600 600 600] ` +
        `/Encoding /WinAnsiEncoding /FontDescriptor ${num + 1} 0 R >>`,
    },
    {
      num: num + 1,
      body:
        `<< /Type /FontDescriptor /FontName /${name} /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 ` +
        `/Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${num + 2} 0 R >>`,
    },
    { num: num + 2, data: testFont({ names: [[3, 1, 0x409, 1, family]], upm: 1000 }), flate: true },
  ];
  /**
   * A plain JPEG stream: the raw reader passes it through by its object reference. Its markers only: SOI, an 8-bit
   * baseline frame header of 3 components (M2 final review F10), EOI.
   */
  const fakeJpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 1, 0, 2, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9);
  /**
   * pdf.js counts 3 pages, and cannot load the second, a page tree node that holds itself; the raw reader counts 2. So
   * pdf.js' third page (object 7) is the raw reader's second.
   */
  const bytes = buildPdf([
    CATALOG,
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << /Font << /F1 20 0 R >> >> >>' },
    { num: 4, data: 'BT /F1 12 Tf 10 10 Td (A) Tj ET' },
    { num: 5, body: '<< /Type /Pages /Parent 2 0 R /Kids [5 0 R] /Count 1 >>' },
    {
      num: 7,
      body:
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 8 0 R ' +
        '/Resources << /Font << /F2 30 0 R >> /XObject << /Im1 40 0 R >> >> >>',
    },
    { num: 8, data: 'BT /F2 12 Tf 10 10 Td (B) Tj ET' },
    ...embeddedFont(20, 'ABCDEF+DeckbackFirst', 'Deckback First'),
    ...embeddedFont(30, 'ABCDEF+DeckbackThird', 'Deckback Third'),
    { num: 40, dict: '/Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: fakeJpeg },
  ]);
  const third = { index: 2, ref: { num: 7, gen: 0 } };

  it('extractScene reads the font program of the page pdf.js loaded', async () => {
    expect(openRawPdf(bytes).pageRefs().map((r) => r.num)).toEqual([3, 7]);
    const { scene } = await extractScene(bytes);
    expect(scene.slides.map((s) => s.failed)).toEqual([null, 'page-unreadable', null]);
    expect(Object.values(scene.fonts).map((f) => [f.baseFont, f.latinName, f.metrics?.upm ?? null])).toEqual([
      ['ABCDEF+DeckbackFirst', 'Deckback First', 1000],
      ['ABCDEF+DeckbackThird', 'Deckback Third', 1000],
    ]);
  });

  it('FontTable and MediaStore take the page by reference, and by index only when the reference is not there', () => {
    const raw = openRawPdf(bytes);
    expect(new FontTable(raw).resolve('ABCDEF+DeckbackThird', third).latinName).toBe('Deckback Third');
    expect(new FontTable(raw).resolve('ABCDEF+DeckbackThird', 2).latinName).toBe('DeckbackThird'); // no raw page 2: pdf.js' name
    expect(new FontTable(raw).resolve('ABCDEF+DeckbackThird', { index: 1, ref: { num: 99, gen: 0 } }).latinName).toBe('Deckback Third');
    expect(new FontTable(raw).resolve('ABCDEF+DeckbackThird', { index: 2, ref: { num: 7, gen: 1 } }).latinName).toBe('DeckbackThird');
    const image = { num: 40, gen: 0 };
    expect(new MediaStore(raw).jpeg(third, image)).toEqual(fakeJpeg);
    expect(new MediaStore(raw).jpeg(2, image)).toBeNull();
    expect(new MediaStore(raw).jpeg({ index: 1, ref: null }, image)).toEqual(fakeJpeg);
  });
});

describe('extractScene, lenient: a fallback is as if its element had never been tried', () => {
  it('the soft mask its element built is built again by the fallback: its notes once, its ids unchanged', async () => {
    const objects: MiniObject[] = [
      { num: 20, body: '<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 21 0 R >> >>' },
      {
        num: 21,
        dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency /CS /DeviceGray >> /Resources << >>',
        data: `1 g 0 0 100 100 re f ${UNKNOWN} 0.5 g 0 0 50 50 re f`,
      },
    ];
    // The mask is drawn where gs sets it; the fill under it is moved 400 digits to the right, so it is a fallback.
    const content = `q /GS1 gs 1 0 0 1 ${HUGE} 0 cm 0 0 1 rg 10 10 50 50 re f Q`;
    const { scene } = await extractScene(pdfOf([{ content }], { resources: '/ExtGState << /GS1 20 0 R >>', objects }));
    const [slide] = scene.slides;
    const [fallback] = fallbacks(slide!.elements);
    expect(fallback).toMatchObject({ reason: 'unbuildable', mask: 'm1' });
    expect(Object.keys(slide!.masks)).toEqual(['m1']);
    const mask = slide!.masks.m1!;
    expect(mask.elements.map((e) => e.kind)).toEqual(['shape', 'fallback', 'shape']);
    expect(mask.elements.every((e) => !e.id.includes(':', 3))).toBe(true); // p1:z<n>, no :1 from a first try
    expect(slide!.notes.map((n) => n.detail)).toEqual(['paint with a number that is not finite', 'operator the walker does not model in a soft mask']);
    expectValid(scene);
  });

  it('a picture painted again after its first painting was undone is stored again', async () => {
    const resources = '/XObject << /ImA 22 0 R >>';
    const objects: MiniObject[] = [
      { num: 22, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: Uint8Array.of(255, 0, 0, 0, 255, 0) },
    ];
    // The same image, first out of reach (a fallback), then where it can be shown.
    const content = `q 1 0 0 1 ${HUGE} 0 cm 30 0 0 20 10 10 cm /ImA Do Q q 30 0 0 20 100 100 cm /ImA Do Q`;
    const { scene, media } = await extractScene(pdfOf([{ content }], { resources, objects }));
    const [slide] = scene.slides;
    expect(slide!.elements.map((e) => e.kind)).toEqual(['fallback', 'picture']);
    const picture = slide!.elements[1] as PictureEl;
    expect(Object.keys(scene.media)).toEqual([picture.mediaHash]);
    expect([...media.keys()]).toEqual([picture.mediaHash]);
  });
});

describe('lenient walking: a text paint that fails does not cost the operator that flushed it', () => {
  it('cm still applies after the text it ends could not be painted', () => {
    // As above: text stroked with an unreadable shading, under a CTM of scale 2; then cm halves it, which ends the stretch.
    const glyph = (unicode: string) => ({ unicode, width: 500, isSpace: false });
    const list: [number, unknown[]][] = [
      [OPS.transform, [2, 0, 0, 2, 0, 0]],
      [OPS.setStrokeColorN, ['Shading', 'bad', null]],
      [OPS.beginText, []],
      [OPS.setFont, ['f1', 10]],
      [OPS.setTextRenderingMode, [1]],
      [OPS.showText, [[glyph('A')]]],
      [OPS.transform, [0.5, 0, 0, 0.5, 0, 0]],
      [OPS.endText, []],
      [OPS.setFillRGBColor, ['#ff0000']],
      [OPS.constructPath, [OPS.fill, [Float32Array.of(0, 10, 10, 1, 30, 10, 1, 30, 30, 1, 10, 30, 4)], null]],
    ];
    const page: PageData = {
      index: 0,
      pageRef: { num: 1, gen: 0 },
      view: [0, 0, 100, 100],
      rotate: 0,
      ops: { fnArray: list.map(([fn]) => fn), argsArray: list.map(([, args]) => args) },
      structTree: null,
      font: () => ({
        loadedName: 'f1',
        name: 'F',
        ascent: 0.8,
        descent: -0.2,
        isType3Font: false,
        missingFile: true,
        vertical: false,
        fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      }),
      obj: (id: string) => ({ bad: ['RadialAxial', 'axial', null, 'no stops', [0, 0], [1, 0], null, null] })[id],
      isOcVisible: () => true,
      links: async () => [],
    };
    const ops = walkPage(page, { strict: false });
    expect(ops.map((op) => [op.kind, op.opIndex])).toEqual([
      ['glyph', 5],
      ['unsupported', 5],
      ['fill', 9],
    ]);
    expect(ops[2]!.bbox).toEqual([10, 70, 30, 90]); // the CTM is 2 × 0.5: the square is 20 pt
  });
});

// -- Final fix wave ---------------------------------------------------------------------------------------------------

describe("extractScene: patterns nested in each other's cells stay bounded (final review F1, ruling M2-R36)", () => {
  /** An operator list with no operator, for made-up RawOps. */
  const NO_OPS: PageData['ops'] = { fnArray: [], argsArray: [] };

  /**
   * A page that fills `fills` rectangles, each after its own `scn`, with pattern 1, whose cell fills 10 rectangles,
   * each after its own `scn`, with pattern 2, and so on down to pattern `depth`, whose cell fills 10 solid two-point
   * paths. pdf.js gives every `scn` of a pattern the same operator list. Were every cell built into every element it
   * fills, one page fill would be 1 + 10 + ... + 10^depth elements: 111,111 at depth 5, from 3.3 KB.
   *
   * Since ruling M3-R60 an element of a tile cell weighs `NESTED_UNIT` (6) and its segments one each, so a slide reaches
   * `SLIDE_WEIGHT_BUDGET` (500,000) at about 83,000 such elements, before `ELEMENT_BUDGET` (100,000): the weight budget
   * bounds these pages, and the element budget is a backstop no page reaches first. (M3 Task 9 made the innermost paints
   * two-point paths, so that the element budget came first; under M3-R60 none can.)
   */
  function nested(depth: number, fills = 1): Uint8Array {
    const pattern = '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 100 100] /XStep 100 /YStep 100';
    const [x, y] = [(i: number) => (i % 5) * 20, (i: number) => Math.floor(i / 5) * 20];
    const at = (i: number) => `${x(i)} ${y(i)} 10 10 re f`;
    const point = (i: number) => `${x(i)} ${y(i)} m ${x(i) + 10} ${y(i) + 10} l f`;
    const objects: MiniObject[] = [];
    for (let k = 1; k <= depth; k++) {
      const inner = k < depth;
      const resources = inner ? `/Pattern << /P ${20 + k} 0 R >>` : '';
      const paints = Array.from({ length: 10 }, (_, i) => (inner ? `/Pattern cs /P scn ${at(i)}` : `0 0 1 rg ${point(i)}`));
      objects.push({ num: 19 + k, dict: `${pattern} /Resources << ${resources} >>`, data: paints.join(' ') });
    }
    const content = Array.from({ length: fills }, (_, i) => `/Pattern cs /P scn ${i * 150} 0 150 300 re f`).join(' ');
    return pdfOf([{ content }], { resources: '/Pattern << /P 20 0 R >>', objects });
  }

  /** Every element of a slide: each copy of a tile cell's (in a fill, a line or a text run) and a soft mask's too. */
  function everyElement(slide: SceneSlide): Element[] {
    const all: Element[] = [];
    const visit = (elements: readonly Element[]): void => {
      for (const e of elements) {
        all.push(e);
        if (e.kind === 'shape' && e.fill?.kind === 'tile') visit(e.fill.cell.elements);
        if (e.kind === 'shape' && e.line?.paint.kind === 'tile') visit(e.line.paint.cell.elements);
        if (e.kind !== 'textline') continue;
        for (const run of e.runs) if (run.fill?.kind === 'tile') visit(run.fill.cell.elements);
      }
    };
    visit(slide.elements);
    for (const mask of Object.values(slide.masks)) visit(mask.elements);
    return all;
  }

  it('the walker walks each distinct cell once, however many scn name it', async () => {
    const doc = await openDocument(nested(5));
    try {
      const page = await loadPage(doc, 0);
      try {
        // Level by level: the pattern RawOps, each `scn` with a cell (TileInfo) of its own, all holding one walk.
        let level = walkPage(page).filter((op) => op.kind === 'pattern');
        const walked: RawOp[][] = [];
        for (let k = 1; k <= 5; k++) {
          expect(level, `level ${k}`).toHaveLength(k === 1 ? 1 : 10);
          expect(new Set(level.map((op) => op.tile)).size, `level ${k}`).toBe(level.length);
          const cells = new Set(level.map((op) => op.tile!.ops));
          expect(cells.size, `level ${k}`).toBe(1);
          const [cell] = cells;
          walked.push(cell!);
          level = cell!.filter((op) => op.kind === 'pattern');
        }
        expect(level).toEqual([]); // the innermost cell fills solid squares
        // Five cells of 10 RawOps each, walked once: 50 RawOps, not 111,110.
        expect(walked.map((cell) => cell.length)).toEqual([10, 10, 10, 10, 10]);
      } finally {
        await releasePage(page);
      }
    } finally {
      await closeDocument(doc);
    }
  });

  it('depth 5: the fill whose cells are past the weight budget is a too-complex fallback at its id; strict throws', async () => {
    const bytes = nested(5);
    expect(bytes.length).toBeLessThan(4_000);
    const { scene } = await extractScene(bytes);
    const [slide] = scene.slides;
    expect(slide!.failed).toBeNull();
    expect(slideWeight(slide!)).toBeLessThanOrEqual(SLIDE_WEIGHT_BUDGET);
    // the page's one fill would hold 111,111 elements: it (the rest of the page) is one fallback, under its own id
    const [fallback, ...more] = slide!.elements;
    expect(more).toEqual([]);
    expect(everyElement(slide!)).toHaveLength(1);
    const opIndex = fallback!.provenance.opIndex[0];
    expect(fallback).toMatchObject({ kind: 'fallback', reason: 'too-complex', raster: null, id: `p1:z${opIndex}` });
    expect(slide!.notes).toEqual([{ opIndex, op: 'constructPath', detail: 'slide too complex' }]);
    await expect(extractScene(bytes, { strict: true })).rejects.toThrow(SceneTooComplexError);
  }, 30_000);

  it('depth 7, filled twice (4.7 KB): each cell walked once, a Scene bounded in elements and JSON size', async () => {
    const bytes = nested(7, 2);
    // The walker: seven distinct cells of 10 RawOps each, every one walked once (a set, as the copies are shared).
    const doc = await openDocument(bytes);
    try {
      const page = await loadPage(doc, 0);
      try {
        const walked = new Set<RawOp[]>();
        const visit = (ops: readonly RawOp[]): void => {
          for (const op of ops) {
            if (op.tile === undefined || walked.has(op.tile.ops)) continue;
            walked.add(op.tile.ops);
            visit(op.tile.ops);
          }
        };
        visit(walkPage(page));
        expect([...walked].map((cell) => cell.length)).toEqual([10, 10, 10, 10, 10, 10, 10]);
      } finally {
        await releasePage(page);
      }
    } finally {
      await closeDocument(doc);
    }
    const started = performance.now();
    const { scene } = await extractScene(bytes);
    // A hang guard only, not a speed requirement: a shared CI runner's wall clock varies too much to hold it to a
    // close time. Measured: about 0.25 s here (2026-11-10, Windows desktop), under 2 s on CI; unbounded, the walker ran
    // out of a 2 GB heap. What bounds the work is checked below, by counts that do not depend on the machine.
    expect(performance.now() - started).toBeLessThan(10_000);
    const [slide] = scene.slides;
    expect(everyElement(slide!).length).toBeLessThanOrEqual(ELEMENT_BUDGET);
    expect(slideWeight(slide!)).toBeLessThanOrEqual(SLIDE_WEIGHT_BUDGET);
    // 35.8 MB when the element budget bounded it (2026-11-10); unbounded, it would be some 8 GB.
    expect(canonicalJson(scene).length).toBeLessThan(40_000_000);
    // The first page fill is past the weight budget (ruling M3-R60): it and the second are one fallback on the slide,
    // whose note is the fixed words alone.
    expect(slide!.elements.map((e) => [e.kind, e.kind === 'fallback' ? e.reason : null])).toEqual([['fallback', 'too-complex']]);
    const first = slide!.elements[0] as FallbackEl;
    const opIndex = first.provenance.opIndex[0];
    expect(slide!.notes).toEqual([{ opIndex, op: 'constructPath', detail: 'slide too complex' }]);
    expect(first.id).toBe(`p1:z${opIndex}`);
    expect(first.coveredOps).toHaveLength(2);
  }, 30_000);

  it('buildSlide, lenient: a cell whose own matrix is not finite fails its element (checked once, not skipped)', async () => {
    // Made-up RawOps: no PDF gives a finite path whose pattern space is not finite (pdf.js does not keep such numbers).
    const ctx = (): BuildContext => ({
      media: new MediaStore(null),
      fonts: new FontTable(null),
      page: { ops: NO_OPS, obj: () => undefined, pageRef: { num: 0, gen: 0 }, structTree: null },
    });
    const common = { alpha: 1, evenOdd: false, mcid: null, blend: 'normal' as const, masked: false, groups: [] };
    const square: RawOp = {
      ...common,
      opIndex: 0,
      kind: 'fill',
      bbox: [0, 0, 5, 5],
      rgb: [255, 0, 0],
      clip: [0, 0, 10, 10],
      path: [['M', 0, 0], ['L', 5, 5]],
    };
    const tiled = (matrix: Matrix): RawOp => ({
      ...common,
      opIndex: 3,
      kind: 'pattern',
      bbox: [10, 10, 60, 60],
      rgb: null,
      clip: [10, 10, 60, 60],
      path: [['M', 10, 10], ['L', 60, 60]],
      pathBox: [10, 10, 60, 60],
      tile: { bbox: [0, 0, 10, 10], xStep: 10, yStep: 10, matrix, paintType: 1, ops: [square], opList: NO_OPS },
    });
    const build = (matrix: Matrix) => buildSlide({ index: 0, sizePt: [100, 100], ops: [tiled(matrix)] }, ctx(), { strict: false });
    expect((await build([1, 0, 0, 1, 0, 0])).elements.map((e) => e.kind)).toEqual(['shape']);
    const slide = await build([Infinity, 0, 0, 1, 0, 0]);
    expect(slide.elements.map((e) => [e.kind, e.kind === 'fallback' ? e.reason : null])).toEqual([
      ['fallback', 'unbuildable'],
    ]);
    expect(slide.notes.map((n) => n.detail)).toEqual(['paint with a number that is not finite']);
    expect(() => canonicalJson(slide)).not.toThrow();
  });

  it('cells that share one walk still get a soft mask each, as when each scn had its own walk', async () => {
    const objects: MiniObject[] = [
      {
        num: 20,
        dict:
          '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 ' +
          '/Resources << /ExtGState << /GS1 21 0 R >> >>',
        data: 'q /GS1 gs 0 0 1 rg 0 0 5 5 re f Q 1 0 0 rg 5 5 5 5 re f',
      },
      { num: 21, body: '<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 22 0 R >> >>' },
      {
        num: 22,
        dict: '/Type /XObject /Subtype /Form /BBox [0 0 10 10] /Group << /S /Transparency /CS /DeviceGray >> /Resources <<>>',
        data: '1 g 0 0 8 8 re f',
      },
    ];
    // Two `scn`, each with a cell; then one `scn` whose cell fills two rectangles.
    const content = '/Pattern cs /P1 scn 0 0 50 50 re f /P1 scn 60 0 50 50 re f /P1 scn 0 60 50 50 re f 60 60 50 50 re f';
    const { scene } = await extractScene(pdfOf([{ content }], { resources: '/Pattern << /P1 20 0 R >>', objects }));
    const [slide] = scene.slides;
    const cellMask = (e: ShapeEl) => (e.fill?.kind === 'tile' ? e.fill.cell.elements[0]!.mask : 'no cell');
    expect(shapes(slide!.elements).map(cellMask)).toEqual(['m1', 'm2', 'm3', 'm3']);
    expect(Object.keys(slide!.masks)).toEqual(['m1', 'm2', 'm3']);
    expectValid(scene);
  });
});
