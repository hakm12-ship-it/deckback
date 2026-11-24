import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { jpegStreams } from '../src/engine/fonts';
import { loadPage, openDocument, OPS, parsePdfjsRef, releasePage, type PageData } from '../src/engine/pdfjs-adapter';
import { openRawPdf, type Ref } from '../src/engine/rawpdf';
import { fixture } from './helpers/fixtures';
import { buildPdf } from './helpers/minipdf';
import { opHistogram as histogram } from './helpers/oracle';

describe('pdf.js adapter on original.pdf', () => {
  const bytes = fixture('original.pdf');

  it.skipIf(bytes === null)('reports the page count, size and rotation of page 0', async () => {
    const doc = await openDocument(bytes!);
    expect(doc.numPages).toBe(3);
    const page = await loadPage(doc, 0);
    expect(page.index).toBe(0);
    expect(page.view).toEqual([0, 0, 960, 540]);
    expect(page.rotate).toBe(0);
    expect(page.pageRef.num).toBeGreaterThan(0);
    expect(page.pageRef.gen).toBeGreaterThanOrEqual(0);
    await releasePage(page);
  });

  it.skipIf(bytes === null)('op-name histogram of page 0 matches the committed golden (op-list contract)', async () => {
    const golden = JSON.parse(
      readFileSync(new URL('./golden/original-p1-ophist.json', import.meta.url), 'utf8'),
    ) as Record<string, number>;
    const doc = await openDocument(bytes!);
    const page = await loadPage(doc, 0);
    expect(page.ops.fnArray.length).toBe(page.ops.argsArray.length);
    expect(histogram(page)).toEqual(golden);
    await releasePage(page);
  });

  it.skipIf(bytes === null)('every constructPath arg is [number, [Float32Array], ArrayLike<number> | null]', async () => {
    const doc = await openDocument(bytes!);
    const page = await loadPage(doc, 0);
    let seen = 0;
    page.ops.fnArray.forEach((code, i) => {
      if (code !== OPS.constructPath) return;
      seen++;
      const args = page.ops.argsArray[i] as unknown[];
      expect(args).toHaveLength(3);
      expect(typeof args[0]).toBe('number');
      const data = args[1] as unknown[];
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(1);
      expect(data[0]).toBeInstanceOf(Float32Array);
      const extra = args[2];
      if (extra !== null) {
        expect(typeof (extra as ArrayLike<number>).length).toBe('number');
        expect(typeof (extra as ArrayLike<number>)[0]).toBe('number');
      }
    });
    expect(seen).toBeGreaterThan(0);
    await releasePage(page);
  });

  it.skipIf(bytes === null)('the tagged page has a structure tree', async () => {
    const doc = await openDocument(bytes!);
    const page = await loadPage(doc, 0);
    expect(page.structTree).not.toBeNull();
    expect(page.structTree!.children!.length).toBeGreaterThan(0);
    await releasePage(page);
  });

  it.skipIf(bytes === null)('font(id) answers for every font the page selects', async () => {
    const doc = await openDocument(bytes!);
    const page = await loadPage(doc, 0);
    const ids = page.ops.fnArray.flatMap((code, i) =>
      code === OPS.setFont ? [(page.ops.argsArray[i] as [string, number])[0]] : [],
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const font = page.font(id);
      expect(typeof font.loadedName).toBe('string');
      expect(typeof font.isType3Font).toBe('boolean');
      expect(typeof font.vertical).toBe('boolean');
      expect(font.fontMatrix).toHaveLength(6);
    }
    await releasePage(page);
  });

  it.skipIf(bytes === null)('obj(id) answers synchronously for the image a page paints', async () => {
    const doc = await openDocument(bytes!);
    const page = await loadPage(doc, 1);
    const ids = page.ops.fnArray.flatMap((code, i) =>
      code === OPS.paintImageXObject ? [(page.ops.argsArray[i] as [string])[0]] : [],
    );
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const image = page.obj(id) as { width: number; height: number; ref: unknown };
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(parsePdfjsRef(image.ref)).not.toBeNull();
    }
    await releasePage(page);
  });
});

describe('pdf.js adapter on an untagged file', () => {
  const bytes = fixture('orig_notags.pdf');
  it.skipIf(bytes === null)('structTree is null', async () => {
    const page = await loadPage(await openDocument(bytes!), 0);
    expect(page.structTree).toBeNull();
    await releasePage(page);
  });
});

describe('pdf.js adapter on a generated rotated, cropped page', () => {
  it('passes the CropBox view and the /Rotate through untouched', async () => {
    const pdf = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        num: 3,
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /CropBox [10 20 110 80] /Rotate 90 /Contents 4 0 R /Resources << >> >>',
      },
      { num: 4, data: '0 0 1 rg 10 20 30 40 re f' },
    ]);
    const page = await loadPage(await openDocument(pdf), 0);
    expect(page.view).toEqual([10, 20, 110, 80]);
    expect(page.rotate).toBe(90);
    expect(page.structTree).toBeNull();
    expect(histogram(page)).toEqual({ constructPath: 1, setFillRGBColor: 1 });
    await releasePage(page);
  });
});

describe('pdf.js adapter, character maps', () => {
  it('decodes text through a predefined CMap read from the package cmaps/ directory', async () => {
    const pdf = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      {
        num: 3,
        body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
      },
      { num: 4, data: 'BT /F1 12 Tf 10 50 Td <B0A1B0A2> Tj ET' }, // two UHC (KS X 1001) codes
      {
        num: 5,
        body: '<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /KSCms-UHC-H /DescendantFonts [6 0 R] >>',
      },
      {
        num: 6,
        body: '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium /CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor 7 0 R >>',
      },
      {
        num: 7,
        body: '<< /Type /FontDescriptor /FontName /HYSMyeongJo-Medium /Flags 6 /FontBBox [0 -200 1000 900] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
      },
    ]);
    const page = await loadPage(await openDocument(pdf), 0);
    const shown = page.ops.argsArray[page.ops.fnArray.indexOf(OPS.showText)] as [{ unicode: string }[]];
    expect(shown[0].map((glyph) => glyph.unicode).join('')).toBe('가각');
    await releasePage(page);
  });
});

// Spec M0-3: a JPEG stream of the file can be tied to the pdf.js image that paints it.
// pdf.js exposes the link as `ref` (a string such as "120R") on the image object, so no byte comparison is needed.
describe('pdf.js adapter, JPEG passthrough link (spec M0-3)', () => {
  const bytes = fixture('hard_std.pdf');

  /** Ids of image objects painted by `ops`, including those inside tiling-pattern operator lists. */
  function paintedImageIds(ops: PageData['ops'], nested: boolean): string[] {
    const ids: string[] = [];
    ops.fnArray.forEach((code, i) => {
      const args = ops.argsArray[i] as unknown[];
      if (code === OPS.paintImageXObject) ids.push(args[0] as string);
      else if (nested && (code === OPS.setFillColorN || code === OPS.setStrokeColorN) && args[0] === 'TilingPattern') {
        ids.push(...paintedImageIds(args[2] as PageData['ops'], true));
      }
    });
    return ids;
  }

  const same = (a: Ref, b: Ref): boolean => a.num === b.num && a.gen === b.gen;

  // Only pages that hold a JPEG are loaded: they are the only ones that can link, and the last page of this
  // file uses a font without an embedded program, for which pdf.js prints font warnings.
  async function linkedRefs(nested: boolean): Promise<{ jpegs: Ref[]; linked: Ref[] }[]> {
    const raw = openRawPdf(bytes!);
    const doc = await openDocument(bytes!);
    const result: { jpegs: Ref[]; linked: Ref[] }[] = [];
    for (let index = 0; index < doc.numPages; index++) {
      const jpegs = jpegStreams(raw, index).map((j) => j.ref);
      if (jpegs.length === 0) continue;
      const page = await loadPage(doc, index);
      const linked = paintedImageIds(page.ops, nested)
        .map((id) => parsePdfjsRef((page.obj(id) as { ref?: unknown } | null)?.ref))
        .filter((ref): ref is Ref => ref !== null && jpegs.some((j) => same(j, ref)));
      result.push({ jpegs, linked });
      await releasePage(page);
    }
    return result;
  }

  it.skipIf(bytes === null)('an image painted by paintImageXObject carries the ref of its JPEG stream', async () => {
    const pages = await linkedRefs(false);
    expect(pages.length).toBeGreaterThanOrEqual(1);
    expect(pages.flatMap((p) => p.linked).length).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(bytes === null)('every JPEG stream is linked, also when the picture is a tiling-pattern fill', async () => {
    const pages = await linkedRefs(true);
    for (const { jpegs, linked } of pages) {
      for (const jpeg of jpegs) expect(linked.some((ref) => same(ref, jpeg))).toBe(true);
    }
  });
});
