/**
 * The service worker's precache list, made from the bundle at build time (vite.config.ts `deckbackServiceWorker`).
 *
 * - `page`: what the page needs to open (the address, the entry chunk with its static imports and styles, the public
 *   files). Cached when the worker installs.
 * - `later`: the rest of the app, the conversion worker and pdf.js (about 2 MB). Cached after the first visit, once the
 *   page is idle (the page asks, offline.ts), so they are not part of the first load.
 * - `id`: names the cache; it changes with any file name (they carry a content hash) or the page's own text.
 *
 * pdf.js' character maps (`pdfjs/cmaps/`) are in neither: a PDF needs one only for some Asian fonts, and the service worker
 * caches the ones it is asked for.
 */
export interface Manifest {
  id: string;
  page: string[];
  later: string[];
}
