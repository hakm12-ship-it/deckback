import { setPdfjsEnvironment, type PdfjsDataKind, type PdfjsLib } from './pdfjs-adapter';

/**
 * pdf.js' browser build, set up to run in the calling thread (our own module worker).
 *
 * pdf.js normally parses in a second, nested worker. Importing `pdf.worker.mjs` first sets
 * `globalThis.pdfjsWorker`; pdf.js then connects to that parser inside this thread (its "fake worker", an in-thread
 * message port) instead of starting a worker. The bundler emits both files as chunks loaded on the first
 * `openDocument`.
 *
 * Side effect to know about: when `pdf.worker.mjs` is evaluated in any worker, pdf.js also attaches a message
 * handler to that worker's own port and posts `{ sourceName: 'worker', targetName: 'main', action: 'ready' }` to
 * the page. That handler only answers messages addressed `targetName: 'worker'`; the page must ignore the `ready`.
 */
async function loadInThread(): Promise<PdfjsLib> {
  await import('pdfjs-dist/build/pdf.worker.mjs');
  const registered = (globalThis as { pdfjsWorker?: { WorkerMessageHandler?: unknown } }).pdfjsWorker;
  if (registered?.WorkerMessageHandler === undefined) {
    throw new Error('pdf.js: the worker module did not set globalThis.pdfjsWorker, so pdf.js would not run in this thread');
  }
  return import('pdfjs-dist/build/pdf.mjs');
}

/**
 * Fetches pdf.js' data files in a worker. pdf.js' own browser fetcher reads `document.baseURI`, which a worker does
 * not have, so with it no character map could load. Same contract, plain `fetch`. Only `cMapUrl` is ever configured:
 * a request for standard-font or wasm data fails with pdf.js' own message, as it does in Node, and fetches nothing.
 */
export class FetchBinaryDataFactory {
  readonly #urls: Record<PdfjsDataKind, string | null>;

  constructor(urls: Record<PdfjsDataKind, string | null>) {
    this.#urls = { ...urls };
  }

  async fetch({ kind, filename }: { kind: PdfjsDataKind; filename: string }): Promise<Uint8Array> {
    const base = this.#urls[kind];
    if (!base) throw new Error(`Ensure that the \`${kind}\` API parameter is provided.`);
    const url = `${base}${filename}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Unable to load ${kind} data at: ${url} (HTTP ${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

/**
 * Makes the adapter use pdf.js' browser build in this thread. Call once, before the first `openDocument`.
 * `cMapUrl` is the absolute URL of the served copy of pdf.js' `cmaps/` directory, ending in a slash; pdf.js fetches
 * a character map from it only when a document needs one.
 */
export function useBrowserPdfjs(cMapUrl: string): void {
  if (!cMapUrl.endsWith('/')) throw new Error(`useBrowserPdfjs: cMapUrl must end with a slash: ${cMapUrl}`);
  setPdfjsEnvironment(async () => ({ lib: await loadInThread(), cMapUrl, BinaryDataFactory: FetchBinaryDataFactory }));
}
