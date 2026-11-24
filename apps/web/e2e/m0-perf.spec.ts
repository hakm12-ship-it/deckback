import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { expect, test, type CDPSession, type Page, type Request } from '@playwright/test';
import { convert, extractScene, sceneHash, type Inventory } from '@deckback/core';
import { DECK51_PDF, PERF_JSON } from './global-setup';
import { testPage } from './servers';

/**
 * Spike M0-7: cold-load bytes, time per page and peak worker memory for a 51-slide PowerPoint-exported PDF, in the
 * chromium project only (the memory numbers need the Chrome DevTools Protocol). The numbers are recorded in
 * out/m0/perf.json, not gated; the test fails only when the measurement itself did not work.
 *
 * M2 Task 11 adds a scene step (Review Focus 5): the same deck converted to a Scene in the worker (`?request=scene`), its
 * time and peak worker memory, with the memory gated at SCENE_PEAK_LIMIT_MB.
 *
 * M3 Task 9 adds a convert step (Review Focus 5): the same deck converted to a PPTX in the worker (`?request=convert`,
 * `convert()`, which streams the slides into the zip), its time and peak worker memory, gated at CONVERT_PEAK_LIMIT_MB,
 * the PPTX and report the same as Node's (by their hashes: the deck is made from the private probe, so neither is
 * printed), and the cold load with the engine, now carrying the passes and the writer, gated at M6_BUDGET_BYTES.
 */

type Reply =
  | { type: 'result'; inventory: Inventory; perPageMs: number[] }
  | { type: 'scene'; hash: string; mediaHashes: string[] }
  | { type: 'convert'; pptxHash: string; pptxBytes: number; reportHash: string }
  | { type: 'error'; message: string };

const PAGES = 51;
const MiB = 1024 * 1024;
/**
 * Review Focus 5: the worker's peak memory while it makes the Scene of the 51-slide deck, used heap plus ArrayBuffers (the
 * PDF, decoded images and the media files live in the latter), sampled every FINE_SAMPLE_EVERY_MS. Pages are loaded,
 * walked, built and released one at a time; only the Scene and the media stay.
 */
const SCENE_PEAK_LIMIT_MB = 100;
/**
 * Review Focus 5 (M3 Task 9): the worker's peak memory while it converts the 51-slide deck to a PPTX, as for the Scene.
 * Each slide is extracted, passed, lowered and written, then released; the zip holds the slides written, compressed.
 */
const CONVERT_PEAK_LIMIT_MB = 100;
/** M6 budget for a cold load, spec §8: 1 MB gzip. Taken as 1,000,000 bytes, the stricter reading of "1 MB". */
const M6_BUDGET_BYTES = 1_000_000;
/** The brief's heap sampling interval, used in the pass that also times the pages. */
const SAMPLE_EVERY_MS = 100;
/** The second, heap-only pass: about as fast as a CDP round trip to the worker allows. */
const FINE_SAMPLE_EVERY_MS = 5;
/**
 * Samples that must fall inside the conversion (not before or after it) for the heap numbers of a pass to count as
 * measured. The conversion takes about 300 ms, so the 100 ms pass can only be asked for one; the fine pass for ten.
 */
const MIN_SAMPLES_IN_CONVERSION = 1;
const MIN_FINE_SAMPLES_IN_CONVERSION = 10;

const round = (value: number, digits: number): number => Math.round(value * 10 ** digits) / 10 ** digits;
const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
/** Nearest-rank percentile of an ascending list. */
const percentile = (ascending: number[], p: number): number => ascending[Math.max(0, Math.ceil(p * ascending.length) - 1)]!;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
/** Resolves with `promise`, or rejects after `ms`. The timer never outlives the call. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** An error's message without the terminal colour codes Playwright puts into assertion messages. */
const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, '');

// ---------------------------------------------------------------------------------------------------------------------
// Bytes on the wire

type Phase = 'beforeFile' | 'afterFile';

interface Transfer {
  url: string; // path and query only
  phase: Phase;
  status: number;
  contentEncoding: string | null;
  /**
   * Response headers plus the (possibly compressed) body as it crossed the network: CDP `encodedDataLength`. Chromium
   * reports no body for a dedicated worker's own script (headers only), see `wireBodyReported`.
   */
  wireBytes: number;
  wireBodyReported: boolean;
  /** The body after decoding. */
  rawBytes: number;
  /** The body compressed with gzip (zlib default level), whatever the server did. */
  gzipBytes: number;
}

/**
 * Records every response of the browser context (the page's and its workers'), with its sizes, as it finishes.
 * Gzip is computed from the decoded body of each response (the same way Task 8 sized the build) instead of being
 * read from the wire: the wire size depends on what the server does (`vite preview` compresses scripts, not the
 * 387-byte page), and Chromium reports no body size for the worker's own script.
 */
function watchTransfers(page: Page) {
  const phases = new Map<Request, Phase>();
  const pending: Promise<void>[] = [];
  const transfers: Transfer[] = [];
  const failures: string[] = [];
  let phase: Phase = 'beforeFile';

  page.context().on('request', (request) => phases.set(request, phase));
  page.context().on('requestfinished', (request) => {
    pending.push(
      (async () => {
        const response = await request.response();
        if (response === null) throw new Error('no response');
        // a redirect has no body to read (Pages sends /test.html on to /test): the page it leads to is the transfer
        if (response.status() >= 300 && response.status() < 400) return;
        const [body, sizes] = await Promise.all([response.body(), request.sizes()]);
        const url = new URL(request.url());
        transfers.push({
          url: `${url.pathname}${url.search}`,
          phase: phases.get(request) ?? phase,
          status: response.status(),
          contentEncoding: response.headers()['content-encoding'] ?? null,
          wireBytes: sizes.responseHeadersSize + sizes.responseBodySize,
          wireBodyReported: sizes.responseBodySize > 0 || body.length === 0,
          rawBytes: body.length,
          gzipBytes: gzipSync(body).length,
        });
      })().catch((error: unknown) => {
        failures.push(`${request.url()}: ${message(error)}`);
      }),
    );
  });
  page.context().on('requestfailed', (request) => failures.push(`${request.url()}: ${request.failure()?.errorText ?? 'failed'}`));

  return {
    chooseFile: () => {
      phase = 'afterFile';
    },
    /** Waits for the sizes of every response seen so far. */
    settle: async () => {
      for (let seen = -1; seen !== pending.length; ) {
        seen = pending.length;
        await Promise.all(pending);
      }
      return { transfers: [...transfers].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0)), failures };
    },
  };
}

/**
 * A transfer's URL with the build hash of its file name masked: `/assets/worker-C2ZJw-Q7.js` becomes `/assets/worker-HASH.js`.
 * Pages' clean address for the test page (`/test?...`, where `/test.html?...` is redirected to) is turned back into the file's.
 */
const stem = (transfer: Transfer): string => transfer.url.replace(/-[\w-]{8}\.(js|css)$/, '-HASH.$1').replace(/^\/test\?/, '/test.html?');

/** pdf.js assets that are fetched only when a document needs them (CJK cMaps, JPX/JBIG2/ICC wasm): not engine code. */
const isLazyAsset = (url: string): boolean => url.startsWith('/pdfjs/') || /\.wasm(\?|$)/.test(url);

function totals(transfers: Transfer[]) {
  return { gzip: sum(transfers.map((t) => t.gzipBytes)), raw: sum(transfers.map((t) => t.rawBytes)) };
}


// ---------------------------------------------------------------------------------------------------------------------
// Worker heap, through the Chrome DevTools Protocol

/** A command channel to one worker target. Playwright's own session API reaches pages only, so this goes through it. */
interface WorkerChannel {
  send<T>(method: string, params?: object): Promise<T>;
  close(): Promise<void>;
}

/**
 * Attaches to the page's dedicated worker: `Target.setAutoAttach` on a page session reports the workers that already
 * exist, and the session it opens is driven with `Target.sendMessageToTarget` (Playwright's `CDPSession.send` cannot
 * name a flattened session). The worker is created at page load, so this works any time after `goto`.
 */
async function attachToWorker(page: Page): Promise<WorkerChannel> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const attached = new Promise<string>((resolve) => {
    cdp.on('Target.attachedToTarget', (event) => {
      if (event.targetInfo.type === 'worker') resolve(event.sessionId);
    });
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  const sessionId = await within(attached, 10_000, 'attaching to the page worker');

  let nextId = 0;
  const waiting = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  cdp.on('Target.receivedMessageFromTarget', (event) => {
    if (event.sessionId !== sessionId) return;
    const reply = JSON.parse(event.message) as { id?: number; result?: never; error?: { message: string } };
    const entry = reply.id === undefined ? undefined : waiting.get(reply.id);
    if (reply.id === undefined || entry === undefined) return;
    waiting.delete(reply.id);
    if (reply.error !== undefined) entry.reject(new Error(reply.error.message));
    else entry.resolve(reply.result as never);
  });
  return {
    send: <T>(method: string, params: object = {}) =>
      new Promise<T>((resolve, reject) => {
        const id = ++nextId;
        waiting.set(id, { resolve: resolve as (value: never) => void, reject });
        cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) }).catch(reject);
      }),
    close: () => cdp.detach(),
  };
}

interface HeapUsage {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize: number;
  backingStorageSize: number;
}

interface HeapSample {
  /** Wall-clock time (`Date.now()`, ms since the epoch) at which the worker's answer arrived. */
  at: number;
  usedMB: number;
  /** ArrayBuffer and external string storage, which `usedSize` does not count. */
  backingMB: number;
  /** V8 heap size including free space (`totalSize`). */
  totalMB: number;
}

/** Samples `Runtime.getHeapUsage` of the worker about every `everyMs` until stopped. */
function sampleHeap(worker: WorkerChannel, everyMs: number) {
  const samples: HeapSample[] = [];
  let running = true;
  let failure: string | null = null;
  const sampleOnce = async (): Promise<void> => {
    const usage = await worker.send<HeapUsage>('Runtime.getHeapUsage');
    samples.push({
      at: Date.now(),
      usedMB: round(usage.usedSize / MiB, 3),
      backingMB: round(usage.backingStorageSize / MiB, 3),
      totalMB: round(usage.totalSize / MiB, 3),
    });
  };
  const loop = (async () => {
    try {
      while (running) {
        await sampleOnce();
        await sleep(everyMs);
      }
    } catch (error) {
      failure = message(error);
    }
  })();
  return {
    samples,
    sampleOnce,
    /** Stops sampling. A worker that is busy for a long stretch cannot answer, so waiting for it is bounded. */
    stop: async () => {
      running = false;
      await within(loop, 2_000, 'the heap sampler stopping').catch(() => undefined);
    },
    /** The error that ended the sampling loop, if any. */
    failure: () => failure,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// One conversion of the deck in a fresh page, with the worker heap sampled while it runs

/** The in-page clock: `change` of the file input to the first non-empty `#result`. */
interface PageClock {
  /** `performance.now()` at the `change` event. */
  start: number;
  /** `Date.now()` at the same moment: the common time base of the heap samples. */
  startedAt: number;
  end: number | null;
}

interface Pass {
  reply: Reply;
  /** Milliseconds from the `change` event to the result, by the page clock. */
  totalMs: number;
  /** Wall-clock time of the `change` event. Every sample time in the record is relative to this one instant. */
  startedAt: number;
  samples: HeapSample[];
  pageErrors: string[];
}

async function waitForReply(page: Page): Promise<Reply> {
  const result = page.locator('#result');
  await expect(result).not.toBeEmpty({ timeout: 90_000 });
  return JSON.parse((await result.textContent()) ?? '') as Reply;
}

/**
 * Loads the test page cold at `path` (`test.html?request=inventory` asks the worker for the inventory, `?request=scene` for the
 * Scene; `/` is the website, M6), attaches to its worker, chooses the deck and waits for the reply, sampling the worker
 * heap every `sampleEveryMs` from just before the file is chosen until just after the result is shown.
 * `beforeChoice` runs once the page has settled and nothing has been chosen yet; `onChoice` right before the choice.
 */
async function runPass(
  page: Page,
  sampleEveryMs: number,
  hooks: { beforeChoice?: () => Promise<void>; onChoice?: () => void } = {},
  path = testPage('?request=inventory'),
): Promise<Pass> {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // A cold load: a fresh context starts with an empty HTTP cache; the page session also turns the cache off.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.goto(path);
  await page.waitForLoadState('networkidle');

  let worker: WorkerChannel | undefined;
  let sampler: ReturnType<typeof sampleHeap> | undefined;
  try {
    worker = await attachToWorker(page);
    await worker.send('Network.enable'); // the worker's own fetches (the engine chunks) must not come from a cache either
    await worker.send('Network.setCacheDisabled', { cacheDisabled: true });

    // In-page clock, so Playwright's file reading and polling are not in the number.
    await page.evaluate(() => {
      const w = window as unknown as { __perf?: { start: number; startedAt: number; end: number | null } };
      const result = document.querySelector('#result')!;
      document.querySelector('#file')!.addEventListener(
        'change',
        () => (w.__perf = { start: performance.now(), startedAt: Date.now(), end: null }),
        { capture: true },
      );
      new MutationObserver(() => {
        if (result.textContent !== '' && w.__perf !== undefined && w.__perf.end === null) w.__perf.end = performance.now();
      }).observe(result, { childList: true, characterData: true, subtree: true });
    });

    await hooks.beforeChoice?.();
    sampler = sampleHeap(worker, sampleEveryMs);
    await sampler.sampleOnce(); // the idle worker, before anything is chosen

    hooks.onChoice?.();
    await page.locator('#file').setInputFiles(DECK51_PDF);
    const reply = await waitForReply(page);
    await sampler.sampleOnce(); // the worker right after the result
    await sampler.stop();
    expect(sampler.failure()).toBeNull();
    expect(pageErrors).toEqual([]);

    const clock = await page.evaluate(() => (window as unknown as { __perf: { start: number; startedAt: number; end: number | null } }).__perf);
    expect(clock.end).not.toBeNull();
    return { reply, totalMs: clock.end! - clock.start, startedAt: clock.startedAt, samples: sampler.samples, pageErrors };
  } finally {
    await sampler?.stop().catch(() => undefined);
    await worker?.close().catch(() => undefined);
  }
}

/**
 * What the heap samples of a pass say. All times are relative to the one instant the file input fired `change`
 * (negative: before), so the conversion is [0, totalMs] and the gaps are differences of the same time base.
 */
function heapStats(pass: Pass, sampleEveryMs: number) {
  const timeline = pass.samples.map((s) => ({ ...s, tMs: s.at - pass.startedAt }));
  const inside = timeline.filter((s) => s.tMs >= 0 && s.tMs <= pass.totalMs);
  const before = timeline.filter((s) => s.tMs < 0);
  const peak = timeline.reduce((best, s) => (s.usedMB > best.usedMB ? s : best));
  const gaps = (times: number[]) => Math.max(...times.slice(1).map((t, i) => t - times[i]!));
  return {
    sampleEveryMs,
    samples: timeline.length,
    /** Samples taken while the conversion was running. A peak that rests on one or two of them is a weak peak. */
    samplesInConversion: inside.length,
    conversionMs: round(pass.totalMs, 1),
    peakWorkerHeapMB: Math.max(...timeline.map((s) => s.usedMB)),
    peakWorkerBackingMB: Math.max(...timeline.map((s) => s.backingMB)),
    peakWorkerHeapPlusBuffersMB: round(Math.max(...timeline.map((s) => s.usedMB + s.backingMB)), 3),
    peakWorkerTotalHeapMB: Math.max(...timeline.map((s) => s.totalMB)),
    /** When the highest used-heap sample was taken, relative to the start of the conversion. */
    peakAtMs: round(peak.tMs, 1),
    heapBeforeFileMB: before.length > 0 ? before[before.length - 1]!.usedMB : null,
    heapAfterMB: timeline[timeline.length - 1]!.usedMB,
    longestGapMs: round(gaps(timeline.map((s) => s.tMs)), 1),
    /** Longest stretch of the conversion without a sample; its two ends count as sample times. */
    longestGapInConversionMs: round(gaps([0, ...inside.map((s) => s.tMs), pass.totalMs]), 1),
    timeline: timeline.map((s): [tMs: number, usedMB: number, backingMB: number] => [round(s.tMs, 1), s.usedMB, s.backingMB]),
  };
}

// ---------------------------------------------------------------------------------------------------------------------

test('spike M0-7: cold load, time per page and peak worker memory on a 51-slide deck', async ({ page }, testInfo) => {
  test.skip(!existsSync(DECK51_PDF), 'SKIP local fixture missing: deck51.pdf (run harness/spikes/m0_7_make_deck.ps1)');
  const browser = page.context().browser();

  // The record. Written in `finally`, so a failing, hanging or crashing run leaves its own `ok: false` file (the
  // global setup deleted the previous one). Numbers stay null until they are measured.
  const perf = {
    ok: false,
    failure: null as string | null,
    project: testInfo.project.name,
    browser: `${browser?.browserType().name()} ${browser?.version()}`,
    pages: null as number | null,
    deckBytes: statSync(DECK51_PDF).size,

    // Cold load. Brief fields: bytes of what loads before a file is chosen. The with-engine numbers are added on top;
    // those are the ones that compare to the M6 budget (see m6Budget, and docs/decisions/0001-m0-engine-gate.md M0-7).
    coldLoadBytesGzip: null as number | null,
    coldLoadBytesRaw: null as number | null,
    coldLoadBeforeFileGzip: null as number | null,
    coldLoadBeforeFileRaw: null as number | null,
    coldLoadWithEngineGzip: null as number | null,
    coldLoadWithEngineRaw: null as number | null,
    lazyAssetsFetched: null as { url: string; gzipBytes: number; rawBytes: number }[] | null,
    lazyAssetsGzip: null as number | null,
    m6Budget: null as { limitBytes: number; comparedField: string; measuredBytes: number; withinBudget: boolean } | null,
    contentEncodings: null as string[] | null,

    perPageMs: null as { p50: number; p95: number; max: number } | null,
    totalMs: null as number | null,
    sumPerPageMs: null as number | null,
    overheadMs: null as number | null,

    // Worker heap, first pass (the brief's 100 ms sampling, the pass that also times the pages). With a conversion of
    // about 300 ms this has only a few samples inside it, so these peaks are LOWER BOUNDS: read the fine pass below.
    heapSampleEveryMs: SAMPLE_EVERY_MS,
    heapSamples: null as number | null,
    heapSamplesInConversion: null as number | null,
    peakWorkerHeapMB: null as number | null,
    peakWorkerHeapPlusBuffersMB: null as number | null,
    peakWorkerBackingMB: null as number | null,
    peakWorkerTotalHeapMB: null as number | null,
    workerHeapBeforeFileMB: null as number | null,
    workerHeapAfterMB: null as number | null,
    longestHeapGapMs: null as number | null,
    longestHeapGapInConversionMs: null as number | null,

    // Worker heap, second pass: the same conversion in a fresh page and context, sampled every FINE_SAMPLE_EVERY_MS.
    // THESE are the peak figures to quote; the three copies below are the same numbers as in `fineHeap`.
    peakWorkerHeapFineMB: null as number | null,
    peakWorkerHeapPlusBuffersFineMB: null as number | null,
    peakWorkerTotalHeapFineMB: null as number | null,
    fineHeap: null as ReturnType<typeof heapStats> | null,

    perPageMsAll: null as number[] | null,
    heapTimeline: null as [tMs: number, usedMB: number, backingMB: number][] | null,
    transfers: null as Transfer[] | null,

    // M2 Task 11, Review Focus 5: the deck to a Scene in the worker, in a fresh context, sampled every 5 ms.
    scene: null as {
      ok: boolean;
      pages: number;
      totalMs: number;
      /** The conversion's time over its pages: the worker reports no time per page for a Scene, only its hash. */
      msPerPage: number;
      peakWorkerHeapMB: number;
      peakWorkerHeapPlusBuffersMB: number;
      peakWorkerTotalHeapMB: number;
      limitMB: number;
      comparedField: 'peakWorkerHeapPlusBuffersMB';
      withinLimit: boolean;
      sameAsNode: boolean;
      media: number;
      heap: ReturnType<typeof heapStats>;
    } | null,

    // M3 Task 9, Review Focus 5: the deck to a PPTX in the worker, in a fresh context, sampled every 5 ms.
    convert: null as {
      ok: boolean;
      pages: number;
      totalMs: number;
      msPerPage: number;
      pptxBytes: number;
      peakWorkerHeapMB: number;
      peakWorkerHeapPlusBuffersMB: number;
      peakWorkerTotalHeapMB: number;
      limitMB: number;
      comparedField: 'peakWorkerHeapPlusBuffersMB';
      withinLimit: boolean;
      sameAsNode: boolean;
      firstLoad: { limitBytes: number; comparedField: 'coldLoadWithEngineGzip'; measuredBytes: number; withinBudget: boolean };
      heap: ReturnType<typeof heapStats>;
    } | null,
    notes: [
      'Sizes: raw = decoded body; gzip = zlib default level over the decoded body (what Task 8 used); wireBytes = response headers + body as sent by vite preview (CDP encodedDataLength), per transfer only: Chromium reports no body for the worker script itself (wireBodyReported false), so wire sums are not made. Scripts were served gzip-encoded.',
      'coldLoadBytesGzip/Raw are the brief fields and mean "before a file is chosen". The M6 budget compares with coldLoadWithEngineGzip: it adds the pdf.js core that arrives with the first file; lazy assets (cMaps, wasm decoders) are excluded and listed apart.',
      'MB = 1024 * 1024 bytes. Heap = Runtime.getHeapUsage of the worker; PlusBuffers adds backingStorageSize (ArrayBuffers), the PDF and decoded images live there.',
      'Heap, two passes. Pass 1 (peakWorkerHeap*, heapTimeline, 100 ms) is the brief\'s sampling and the pass that times the pages; it has few samples inside the ~300 ms conversion (heapSamplesInConversion), so its peak is a lower bound. Pass 2 (fineHeap, peakWorkerHeap*Fine*) repeats the conversion in a fresh context sampled every 5 ms (as fast as a CDP round trip allows) and is the figure to quote; a peak between two samples can still be missed, and the worker cannot answer while it runs a long synchronous stretch (see longestGapInConversionMs).',
      'All heap times (tMs) are relative to one instant: the file input\'s change event in the page (negative = before). The conversion is [0, conversion ms]. Page and test process share the machine\'s wall clock (Date.now()).',
      'perPageMs: nearest-rank percentiles over the 51 pages, one run on a loaded desktop.',
      'scene (M2 Task 11): the same deck to a Scene (`?request=scene`) in a third fresh context, heap sampled every 5 ms; msPerPage = totalMs / pages (the reply carries only the hash and the media hashes); the gate is peakWorkerHeapPlusBuffersMB <= limitMB; sameAsNode: the hash and media hashes equal those Node computes for the deck.',
      'convert (M3 Task 9): the same deck to a PPTX (`?request=convert`) in a fourth fresh context, heap sampled every 5 ms; msPerPage = totalMs / pages; the gates are peakWorkerHeapPlusBuffersMB <= limitMB and the first load (coldLoadWithEngineGzip, pass 1) <= firstLoad.limitBytes; sameAsNode: the PPTX SHA-256, its length and the report hash equal those Node computes (the reply carries nothing else).',
    ],
  };

  try {
    const watch = watchTransfers(page);

    // Pass 1: the brief's measurement. Sizes and times come from this pass.
    let beforeFile: Awaited<ReturnType<typeof watch.settle>> | undefined;
    const pass = await runPass(page, SAMPLE_EVERY_MS, {
      beforeChoice: async () => {
        beforeFile = await watch.settle(); // every response of the page load is in before the file is chosen
      },
      onChoice: watch.chooseFile,
    });
    expect(beforeFile?.failures).toEqual([]);
    const { reply } = pass;

    // Heap, pass 1.
    const heap = heapStats(pass, SAMPLE_EVERY_MS);
    perf.heapSamples = heap.samples;
    perf.heapSamplesInConversion = heap.samplesInConversion;
    perf.peakWorkerHeapMB = heap.peakWorkerHeapMB;
    perf.peakWorkerBackingMB = heap.peakWorkerBackingMB;
    perf.peakWorkerHeapPlusBuffersMB = heap.peakWorkerHeapPlusBuffersMB;
    perf.peakWorkerTotalHeapMB = heap.peakWorkerTotalHeapMB;
    perf.workerHeapBeforeFileMB = heap.heapBeforeFileMB;
    perf.workerHeapAfterMB = heap.heapAfterMB;
    perf.longestHeapGapMs = heap.longestGapMs;
    perf.longestHeapGapInConversionMs = heap.longestGapInConversionMs;
    perf.heapTimeline = heap.timeline;

    // Time.
    if (reply.type === 'error') throw new Error(`the worker replied with an error: ${reply.message}`);
    if (reply.type !== 'result') throw new Error(`the worker replied with a ${reply.type}, not an inventory`);
    const perPage = [...reply.perPageMs];
    const ascending = [...perPage].sort((a, b) => a - b);
    perf.pages = reply.inventory.pages.length;
    perf.perPageMsAll = perPage.map((ms) => round(ms, 1));
    perf.perPageMs = { p50: round(percentile(ascending, 0.5), 1), p95: round(percentile(ascending, 0.95), 1), max: round(ascending[ascending.length - 1]!, 1) };
    perf.totalMs = round(pass.totalMs, 1);
    perf.sumPerPageMs = round(sum(perPage), 1);
    perf.overheadMs = round(perf.totalMs - perf.sumPerPageMs, 1);

    // Bytes.
    const { transfers, failures } = await watch.settle();
    expect(failures).toEqual([]);
    perf.transfers = transfers;
    perf.contentEncodings = [...new Set(transfers.map((t) => t.contentEncoding ?? 'identity'))];
    const before = transfers.filter((t) => t.phase === 'beforeFile');
    const after = transfers.filter((t) => t.phase === 'afterFile');
    const lazy = after.filter((t) => isLazyAsset(t.url));
    const engine = after.filter((t) => !isLazyAsset(t.url));
    const cold = totals(before);
    const withEngine = totals([...before, ...engine]);
    perf.coldLoadBytesGzip = perf.coldLoadBeforeFileGzip = cold.gzip;
    perf.coldLoadBytesRaw = perf.coldLoadBeforeFileRaw = cold.raw;
    perf.coldLoadWithEngineGzip = withEngine.gzip;
    perf.coldLoadWithEngineRaw = withEngine.raw;
    perf.lazyAssetsFetched = lazy.map((t) => ({ url: t.url, gzipBytes: t.gzipBytes, rawBytes: t.rawBytes }));
    perf.lazyAssetsGzip = sum(lazy.map((t) => t.gzipBytes));
    perf.m6Budget = {
      limitBytes: M6_BUDGET_BYTES,
      comparedField: 'coldLoadWithEngineGzip',
      measuredBytes: withEngine.gzip,
      withinBudget: withEngine.gzip <= M6_BUDGET_BYTES,
    };

    // Pass 2: the same conversion in a fresh context, with fine heap sampling. Not used for sizes or times.
    if (browser === null) throw new Error('no browser to start the fine heap pass in');
    const fineContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
    let finePass: Pass;
    try {
      finePass = await runPass(await fineContext.newPage(), FINE_SAMPLE_EVERY_MS);
    } finally {
      await fineContext.close();
    }
    const fine = heapStats(finePass, FINE_SAMPLE_EVERY_MS);
    perf.fineHeap = fine;
    perf.peakWorkerHeapFineMB = fine.peakWorkerHeapMB;
    perf.peakWorkerHeapPlusBuffersFineMB = fine.peakWorkerHeapPlusBuffersMB;
    perf.peakWorkerTotalHeapFineMB = fine.peakWorkerTotalHeapMB;

    // The measurement itself must have worked.
    expect(reply.type).toBe('result');
    expect(perf.pages).toBe(PAGES);
    expect(perPage).toHaveLength(PAGES);
    expect(heap.samplesInConversion).toBeGreaterThanOrEqual(MIN_SAMPLES_IN_CONVERSION); // idle samples do not count
    expect(finePass.reply).toMatchObject({ type: 'result' });
    expect(finePass.reply.type === 'result' ? finePass.reply.inventory.pages.length : 0).toBe(PAGES);
    expect(fine.samplesInConversion).toBeGreaterThanOrEqual(MIN_FINE_SAMPLES_IN_CONVERSION);
    expect(transfers.every((t) => t.status === 200)).toBe(true);
    expect(transfers.every((t) => t.wireBytes > 0)).toBe(true); // nothing came from a cache
    expect(transfers.filter((t) => !t.wireBodyReported).map(stem)).toEqual(['/assets/worker-HASH.js']);
    // Before the file: the test page (test.html, e2e build only), its script (and the module it shares with the site: the worker's constructor) and the worker, which the test page makes at once.
    // After it: the pdf.js core (a parser and a worker module).
    expect(before.map(stem).sort()).toEqual(['/assets/make-worker-HASH.js', '/assets/test-HASH.js', '/assets/worker-HASH.js', '/test.html?request=inventory']);
    expect(engine.map(stem)).toEqual(['/assets/pdf-HASH.js', '/assets/pdf.worker-HASH.js']);

    await test.step('scene: the deck to a Scene in the worker, peak memory within the limit', async () => {
      const sceneContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
      let scenePass: Pass;
      try {
        scenePass = await runPass(await sceneContext.newPage(), FINE_SAMPLE_EVERY_MS, {}, testPage('?request=scene'));
      } finally {
        await sceneContext.close();
      }
      const stats = heapStats(scenePass, FINE_SAMPLE_EVERY_MS);
      const node = await extractScene(new Uint8Array(readFileSync(DECK51_PDF)));
      const nodeReply = {
        type: 'scene',
        hash: await sceneHash(node.scene),
        mediaHashes: [...node.media.values()].map((bytes) => createHash('sha256').update(bytes).digest('hex')),
      };
      perf.scene = {
        ok: false,
        pages: node.scene.slides.length,
        totalMs: round(scenePass.totalMs, 1),
        msPerPage: round(scenePass.totalMs / PAGES, 1),
        peakWorkerHeapMB: stats.peakWorkerHeapMB,
        peakWorkerHeapPlusBuffersMB: stats.peakWorkerHeapPlusBuffersMB,
        peakWorkerTotalHeapMB: stats.peakWorkerTotalHeapMB,
        limitMB: SCENE_PEAK_LIMIT_MB,
        comparedField: 'peakWorkerHeapPlusBuffersMB',
        withinLimit: stats.peakWorkerHeapPlusBuffersMB <= SCENE_PEAK_LIMIT_MB,
        sameAsNode: JSON.stringify(scenePass.reply) === JSON.stringify(nodeReply),
        media: nodeReply.mediaHashes.length,
        heap: stats,
      };
      expect(node.scene.slides).toHaveLength(PAGES);
      expect(node.scene.slides.filter((s) => s.failed !== null)).toEqual([]);
      expect(scenePass.reply).toEqual(nodeReply);
      expect(stats.samplesInConversion).toBeGreaterThanOrEqual(MIN_FINE_SAMPLES_IN_CONVERSION);
      expect(stats.peakWorkerHeapPlusBuffersMB).toBeLessThanOrEqual(SCENE_PEAK_LIMIT_MB);
      perf.scene.ok = true;
    });

    await test.step('convert: the deck to a PPTX in the worker, peak memory and first load within their limits', async () => {
      const convertContext = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
      let convertPass: Pass;
      try {
        convertPass = await runPass(await convertContext.newPage(), FINE_SAMPLE_EVERY_MS, {}, testPage('?request=convert'));
      } finally {
        await convertContext.close();
      }
      const stats = heapStats(convertPass, FINE_SAMPLE_EVERY_MS);
      const node = await convert(new Uint8Array(readFileSync(DECK51_PDF)));
      const nodeReply = {
        type: 'convert',
        pptxHash: createHash('sha256').update(node.pptx).digest('hex'),
        pptxBytes: node.pptx.length,
        reportHash: await sceneHash(node.report),
      };
      const firstLoad = perf.m6Budget!;
      perf.convert = {
        ok: false,
        pages: node.report.slides.length,
        totalMs: round(convertPass.totalMs, 1),
        msPerPage: round(convertPass.totalMs / PAGES, 1),
        pptxBytes: node.pptx.length,
        peakWorkerHeapMB: stats.peakWorkerHeapMB,
        peakWorkerHeapPlusBuffersMB: stats.peakWorkerHeapPlusBuffersMB,
        peakWorkerTotalHeapMB: stats.peakWorkerTotalHeapMB,
        limitMB: CONVERT_PEAK_LIMIT_MB,
        comparedField: 'peakWorkerHeapPlusBuffersMB',
        withinLimit: stats.peakWorkerHeapPlusBuffersMB <= CONVERT_PEAK_LIMIT_MB,
        sameAsNode: JSON.stringify(convertPass.reply) === JSON.stringify(nodeReply),
        firstLoad: { limitBytes: M6_BUDGET_BYTES, comparedField: 'coldLoadWithEngineGzip', measuredBytes: firstLoad.measuredBytes, withinBudget: firstLoad.withinBudget },
        heap: stats,
      };
      expect(node.report.slides).toHaveLength(PAGES);
      expect(node.report.slides.filter((s) => s.failed !== null)).toEqual([]);
      // hashes only: the deck is the private probe's, so a failure must not print its report
      expect(convertPass.reply).toEqual(nodeReply);
      expect(stats.samplesInConversion).toBeGreaterThanOrEqual(MIN_FINE_SAMPLES_IN_CONVERSION);
      expect(stats.peakWorkerHeapPlusBuffersMB).toBeLessThanOrEqual(CONVERT_PEAK_LIMIT_MB);
      expect(firstLoad.measuredBytes).toBeLessThanOrEqual(M6_BUDGET_BYTES);
      perf.convert.ok = true;
    });
    perf.ok = true;
  } catch (error) {
    perf.failure = message(error);
    throw error;
  } finally {
    writeFileSync(PERF_JSON, `${JSON.stringify(perf, null, 2)}\n`);
  }
});
