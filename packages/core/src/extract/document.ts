import { closeDocument, loadPage, openDocument, releasePage } from '../engine/pdfjs-adapter';
import { toInventory, type Inventory } from './inventory';
import { pageFrame, walkPage, type RawOp } from './walker';

export interface DocumentInventory {
  inventory: Inventory;
  /** Milliseconds per walked page (load, walk and release), in the order of `inventory.pages`. */
  perPageMs: number[];
}

/**
 * Opens a PDF, walks the pages at the 0-based indexes `pages` (every page, in order, when the list is empty) and
 * returns their inventory. Pages are handled strictly one at a time: load, walk, release, then the next.
 * The document is closed afterwards, also when a page fails.
 */
export async function inventoryOfDocument(bytes: Uint8Array, pages: readonly number[]): Promise<DocumentInventory> {
  const doc = await openDocument(bytes);
  try {
    const indexes = pages.length > 0 ? pages : Array.from({ length: doc.numPages }, (_, i) => i);
    const walked: { index: number; size: [number, number]; ops: RawOp[] }[] = [];
    const perPageMs: number[] = [];
    for (const index of indexes) {
      const start = performance.now();
      const page = await loadPage(doc, index);
      try {
        walked.push({ index, size: pageFrame(page).size, ops: walkPage(page) });
      } finally {
        await releasePage(page);
      }
      perPageMs.push(performance.now() - start);
    }
    return { inventory: toInventory(walked), perPageMs };
  } finally {
    await closeDocument(doc);
  }
}
