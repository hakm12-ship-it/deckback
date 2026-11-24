import { describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, releasePage } from '../src/engine/pdfjs-adapter';
import { inventoryOfDocument } from '../src/extract/document';
import { toInventory } from '../src/extract/inventory';
import { pageFrame, walkPage, type RawOp } from '../src/extract/walker';
import { buildPdf, type MiniObject } from './helpers/minipdf';

/** Three pages of different sizes; page i fills one rectangle in red, green or blue. */
function threePages(): Uint8Array {
  const sizes = [
    [300, 200],
    [200, 300],
    [400, 100],
  ];
  const objs: MiniObject[] = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [10 0 R 11 0 R 12 0 R] /Count 3 >>' },
  ];
  sizes.forEach(([w, h], i) => {
    objs.push({ num: 10 + i, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Contents ${20 + i} 0 R >>` });
    const rgb = [0, 1, 2].map((c) => (c === i ? 1 : 0)).join(' ');
    objs.push({ num: 20 + i, data: `${rgb} rg 10 10 ${50 + i} 40 re f` });
  });
  return buildPdf(objs);
}

describe('inventoryOfDocument (the walk the browser worker runs)', () => {
  it('walks every page in order when no pages are named, exactly like a page-by-page walk', async () => {
    const bytes = threePages();
    const { inventory, perPageMs } = await inventoryOfDocument(bytes, []);
    expect(inventory.pages.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(inventory.pages.map((p) => p.size)).toEqual([
      [300, 200],
      [200, 300],
      [400, 100],
    ]);
    expect(inventory.pages.map((p) => p.paints.map((paint) => paint.rgb))).toEqual([[[255, 0, 0]], [[0, 255, 0]], [[0, 0, 255]]]);
    expect(perPageMs).toHaveLength(3);
    for (const ms of perPageMs) expect(ms).toBeGreaterThanOrEqual(0);

    const doc = await openDocument(bytes);
    const walked: { index: number; size: [number, number]; ops: RawOp[] }[] = [];
    for (let index = 0; index < doc.numPages; index++) {
      const page = await loadPage(doc, index);
      walked.push({ index, size: pageFrame(page).size, ops: walkPage(page) });
      await releasePage(page);
    }
    await closeDocument(doc);
    expect(inventory).toEqual(toInventory(walked));
  });

  it('walks only the named pages, in the order given, one at a time (a page may repeat)', async () => {
    const { inventory, perPageMs } = await inventoryOfDocument(threePages(), [2, 0, 2]);
    expect(inventory.pages.map((p) => p.index)).toEqual([2, 0, 2]);
    expect(perPageMs).toHaveLength(3);
  });

  it('rejects a page outside the document', async () => {
    await expect(inventoryOfDocument(threePages(), [3])).rejects.toThrow(RangeError);
  });
});
