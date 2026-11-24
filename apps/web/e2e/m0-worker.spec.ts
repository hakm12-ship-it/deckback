import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { compareInventories, type Inventory } from '@deckback/core';
import { CMAP_PROBE_INVENTORY, CMAP_PROBE_PDF, m01Fixture, NODE_INVENTORY, OUT_DIR } from './global-setup';
import { testPage } from './servers';

/** The worker's reply, as `main.ts` writes it into `#result`. */
type Reply = { type: 'result'; inventory: Inventory; perPageMs: number[] } | { type: 'error'; message: string };

/** Largest request body, and largest http(s) URL, allowed (spec §8 privacy smoke check). */
const MAX_BYTES = 1024;

interface SeenRequest {
  method: string;
  url: string;
  /** What Playwright could read of the body: Blob and FormData bodies read as 0 in some engines. */
  bodyBytes: number;
  /** Made after the file was chosen. */
  afterChoice: boolean;
}

/**
 * True for a request that could carry the file out. The app only ever fetches its own static files, so any method
 * but GET or HEAD fails (this is what catches Blob and FormData uploads, whose bodies Playwright cannot always
 * read), and so does a body or an http(s) URL longer than MAX_BYTES.
 */
const couldLeak = (r: SeenRequest): boolean =>
  (r.method !== 'GET' && r.method !== 'HEAD') || r.bodyBytes > MAX_BYTES || (/^https?:/.test(r.url) && r.url.length > MAX_BYTES);

/** Records every request of the browser context, the page's and its workers'. */
function watchRequests(page: Page) {
  const requests: SeenRequest[] = [];
  let chosen = false;
  page.context().on('request', (request) => {
    requests.push({
      method: request.method(),
      url: request.url(),
      bodyBytes: request.postDataBuffer()?.length ?? 0,
      afterChoice: chosen,
    });
  });
  return {
    requests,
    leaks: () => requests.filter(couldLeak),
    markChoice: () => {
      chosen = true;
    },
  };
}

/** Records the URL of every worker the page starts. */
function watchWorkers(page: Page): string[] {
  const workers: string[] = [];
  page.on('worker', (worker) => workers.push(new URL(worker.url()).pathname));
  return workers;
}

/**
 * Browser types whose Playwright driver reports workers started by a worker. Checked with a mutation in which our
 * worker starts one nested worker: chromium (and msedge) and firefox reported 2 workers, webkit only 1.
 */
const REPORTS_NESTED_WORKERS = new Set(['chromium', 'firefox']);

/** pdf.js' mode as observed: in-thread only when our own worker was the only one, in an engine that would show more. */
function observedMode(workers: string[], browserType: string | undefined): string {
  if (workers.length !== 1) return `unexpected: ${workers.length} workers [${workers.join(', ')}]`;
  if (browserType !== undefined && REPORTS_NESTED_WORKERS.has(browserType)) return 'in-thread';
  return 'in-thread (not observable: this engine does not report nested workers to Playwright)';
}

/** Chooses `pdf` in `#file` and returns the reply `main.ts` writes into `#result`. */
async function convert(page: Page, pdf: string, markChoice: () => void): Promise<Reply> {
  const result = page.locator('#result');
  markChoice();
  await page.locator('#file').setInputFiles(pdf);
  await expect(result).not.toBeEmpty({ timeout: 60_000 });
  return JSON.parse((await result.textContent()) ?? '') as Reply;
}

const readInventory = (file: string): Inventory => JSON.parse(readFileSync(file, 'utf8')) as Inventory;
/** An error's message without the terminal colour codes Playwright puts into assertion messages. */
const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, '');

test('spike M0-1: the worker inventory of the probe PDF equals the Node inventory', async ({ page }, testInfo) => {
  // original.pdf where it is present (local), else the committed probe_std.pdf (CI); the evidence records which, by its
  // label (never the private probe's path).
  const { pdf, label } = m01Fixture();
  const browser = page.context().browser();
  const watch = watchRequests(page);
  const workers = watchWorkers(page);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // Evidence for the gate decision (Task 13). Written in `finally`, so a failing, hanging or crashing engine leaves
  // its own record (the global setup deletes the previous run's files first).
  const evidence = {
    project: testInfo.project.name,
    fixture: label,
    browser: `${browser?.browserType().name()} ${browser?.version()}`,
    pdfjsMode: null as string | null,
    workers,
    ok: false,
    failure: null as string | null,
    workerError: null as string | null,
    pageErrors,
    pages: null as number | null,
    diffs: null as string[] | null,
    perPageMs: null as number[] | null,
    requests: 0,
    leakingRequests: [] as SeenRequest[],
  };
  try {
    const node = readInventory(NODE_INVENTORY);
    expect(node.pages.length).toBeGreaterThan(0); // equality with an empty inventory would prove nothing
    for (const p of node.pages) expect(p.paints.length * p.glyphs.length).toBeGreaterThan(0);

    await page.goto(testPage('?request=inventory')); // the test page (test.html, e2e build only); `/` is the website
    const reply = await convert(page, pdf, watch.markChoice);
    evidence.pdfjsMode = observedMode(workers, browser?.browserType().name()); // pdf.js ran: the worker replied
    if (reply.type === 'error') evidence.workerError = reply.message;

    expect(reply).toMatchObject({ type: 'result' });
    if (reply.type !== 'result') return;
    const comparison = compareInventories(node, reply.inventory, 0);
    evidence.pages = reply.inventory.pages.length;
    evidence.diffs = comparison.diffs;
    evidence.perPageMs = reply.perPageMs.map((ms) => Math.round(ms * 10) / 10);

    expect(reply.inventory).toEqual(node);
    expect(comparison.diffs).toEqual([]);
    expect(comparison.ok).toBe(true);
    expect(reply.perPageMs).toHaveLength(node.pages.length);
    expect(watch.leaks()).toEqual([]);
    evidence.ok = true;
  } catch (error) {
    evidence.failure = message(error);
    throw error;
  } finally {
    evidence.requests = watch.requests.length;
    evidence.leakingRequests = watch.leaks();
    writeFileSync(`${OUT_DIR}m0-1-${testInfo.project.name}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  }
});

test('Korean text through a predefined CMap: cMaps load only when needed, same inventory as Node', async ({ page }) => {
  const node = readInventory(CMAP_PROBE_INVENTORY);
  expect(node.pages[0]!.glyphs.map((g) => g.u).join('')).toBe('가각'); // Node read the CMap too
  const watch = watchRequests(page);

  await page.goto(testPage('?request=inventory')); // the test page (test.html, e2e build only); `/` is the website
  const reply = await convert(page, CMAP_PROBE_PDF, watch.markChoice);

  expect(reply).toMatchObject({ type: 'result' });
  if (reply.type !== 'result') return;
  expect(reply.inventory).toEqual(node);
  expect(compareInventories(node, reply.inventory, 0).ok).toBe(true);
  const cmaps = watch.requests.filter((r) => /\/pdfjs\/cmaps\/[^/]+\.bcmap$/.test(new URL(r.url).pathname));
  expect(cmaps.map((r) => new URL(r.url).pathname)).toContain('/pdfjs/cmaps/KSCms-UHC-H.bcmap');
  expect(cmaps.filter((r) => !r.afterChoice)).toEqual([]); // none at page load
  expect(watch.leaks()).toEqual([]);
});
