import { setPdfjsEnvironment, type PdfjsEnvironment } from '@deckback/core';

/**
 * The bundle's pdf.js (M7 Task 2). The package has no dependencies, so pdf.js is inside `deckback.mjs`: its parser side
 * ("worker") is imported here and handed over through `globalThis.pdfjsWorker`, where pdf.js looks before it would load
 * `pdf.worker.mjs` from beside itself, and the character maps are read from `cmaps/` beside the bundle. Nothing is
 * fetched, and nothing depends on where the package sits (an npx cache, a global install).
 */
export function installBundledPdfjs(bundleUrl: string): void {
  setPdfjsEnvironment(async (): Promise<PdfjsEnvironment> => {
    const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const dir = new URL('cmaps/', bundleUrl);
    // a plain path with forward slashes: pdf.js' Node fetcher hands it to fs.readFile
    const cMapUrl = decodeURIComponent(dir.pathname).replace(/^\/(?=[A-Za-z]:)/, '');
    return { lib, cMapUrl };
  });
}
