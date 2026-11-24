/**
 * The conversion worker. Made on first use only, so its chunks (pdf.js and core, about 2 MB) load when a file is first
 * chosen and not with the page. The literal `new Worker(new URL(...))` is what Vite bundles the worker from. Alone in its
 * file so that the e2e's test page (test-page.ts) can make a worker without the website's code.
 */
export const makeWorker = (): Worker => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
