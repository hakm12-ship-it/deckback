import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page, type Request } from '@playwright/test';
import { convert } from '@deckback/core';
import { MESSAGES } from '../src/i18n';
import { BASE_URL, BEACON_URL, DIST_DIR, E2E_DIST_DIR, EXTERNAL_SERVER, FAKE_BEACON_TOKEN, TEST_URL, testPage } from './servers';
import { jpxPdf, PRIVACY_FILE_NAME, PRIVACY_FONTS, PRIVACY_TEXT, privacyPdf, PROBE_STD_PDF, type4Pdf } from './site-fixtures';

/**
 * M6 Task 3: the site as it is served (the rules of public/_headers, brotli or gzip; Task 4 runs the same specs on
 * `wrangler pages dev`). Four things, in every engine:
 *  - the first load, until idle with no file chosen, is at most 1,000,000 bytes (Global Constraints);
 *  - Review Focus 4, privacy: converting a file named for a person puts nothing of the file in any request;
 *  - Review Focus 3, offline: after one visit the page opens and converts with the network off, to Node's bytes;
 *  - the Content-Security-Policy is met by a whole conversion (0 violations), a JPX image included.
 */

const FIRST_LOAD_BUDGET = 1_000_000;
const ko = MESSAGES.ko;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

test.use({ locale: 'ko-KR', serviceWorkers: 'allow' });

/** Chooses `bytes` as the file `name` in the file picker. */
async function choose(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  await page.locator('#file').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
}

/** Waits for the result and downloads the PPTX: its suggested name and its bytes. */
async function download(page: Page): Promise<{ name: string; bytes: Buffer }> {
  await expect(page.locator('#outcome')).toBeVisible({ timeout: 90_000 });
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
}

/** `promise`, or `fallback` if it has not settled after `ms` (and `fallback` if it rejects: the page or worker closed). */
function settled<T, F>(promise: Promise<T>, fallback: F, ms = 10_000): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<F>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  return Promise.race([promise.catch(() => fallback), timeout]).finally(() => clearTimeout(timer));
}

/** The bytes a response put on the wire, as served: its body (encoded) and its headers. Falls back to Content-Length. */
async function transferred(request: Request): Promise<number> {
  // A request of the service worker whose response never settles in CDP ("Worker closed" at teardown) hung this test for its
  // whole 120 s. Each wait is raced with a timeout; a request that gives no answer counts 0 bytes (the page's own are
  // answered at once, and the budget test would then still see its 3 or more files and 5 KB).
  const response = await settled(request.response(), null);
  if (response === null) return 0;
  await settled(response.finished(), null);
  const sizes = await settled(request.sizes().catch(() => null), null);
  if (sizes !== null && sizes.responseBodySize < 0) return 0; // answered from the browser's cache (Chromium says so with a negative size): nothing on the wire
  const length = Number((await settled(response.allHeaders(), {} as Record<string, string>))['content-length'] ?? 0);
  const body = sizes !== null && sizes.responseBodySize > 0 ? sizes.responseBodySize : length;
  return body + (sizes?.responseHeadersSize ?? 0);
}

// ---------------------------------------------------------------------------------------------------------------------
// First load

test.describe('first load', () => {
  test.use({ serviceWorkers: 'block' }); // the budget is the page's own load; the service worker's later fetches are not part of it

  test('from navigation to idle, with no file chosen, at most 1,000,000 bytes as served', async ({ page }, info) => {
    const sizes: Promise<{ path: string; bytes: number; encoding: string | undefined }>[] = [];
    page.on('requestfinished', (request) => {
      sizes.push(
        (async () => ({
          path: new URL(request.url()).pathname,
          bytes: await transferred(request),
          encoding: (await settled(request.response(), null))?.headers()['content-encoding'],
        }))(),
      );
    });
    await page.goto('/');
    await expect(page.locator('#drop-title')).toHaveText(ko['drop.title']);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
    const files = await Promise.all(sizes);
    const total = files.reduce((sum, f) => sum + f.bytes, 0);
    console.log(`first load ${info.project.name}: ${total} bytes in ${files.length} files: ${files.map((f) => `${f.path} ${f.bytes}${f.encoding ? ` ${f.encoding}` : ''}`).join(', ')}`);
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(total).toBeGreaterThan(5_000);
    expect(total).toBeLessThanOrEqual(FIRST_LOAD_BUDGET);
    // served compressed: the script and the style sheet carry a content encoding
    for (const f of files.filter((f) => /\.(js|css)$/.test(f.path))) expect(f.encoding, f.path).toMatch(/^(br|gzip)$/);
    expect(files.filter((f) => /\/assets\/(worker|pdf)/.test(f.path))).toEqual([]); // no engine before a file
  });
});

test.describe('first load with the service worker', () => {
  /** What a first visit transfers until idle: the page, and what the service worker's install fetches (not the warm-up after idle). */
  async function visit(browser: Browser, serviceWorkers: 'allow' | 'block'): Promise<{ total: number; files: string[] }> {
    const context = await browser.newContext({ locale: 'ko-KR', serviceWorkers });
    const page = await context.newPage();
    const sizes: Promise<{ path: string; bytes: number }>[] = [];
    context.on('requestfinished', (request) => {
      const path = new URL(request.url()).pathname;
      if (/\/assets\/(worker|pdf)/.test(path)) return; // the warm-up is not the first load: never wait on it
      sizes.push((async () => ({ path, bytes: await transferred(request) }))());
    });
    await page.goto('/');
    await expect(page.locator('#drop-title')).toHaveText(ko['drop.title']);
    if (serviceWorkers === 'allow') await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)); // the install is done
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(500); // the warm-up starts 3 s after load
    const files = await Promise.all(sizes);
    await context.close();
    return { total: files.reduce((sum, f) => sum + f.bytes, 0), files: files.map((f) => `${f.path} ${f.bytes}`) };
  }

  test('the service worker adds sw.js and little else: the page is not downloaded twice before idle', async ({ browser }, info) => {
    const plain = await visit(browser, 'block');
    const worked = await visit(browser, 'allow');
    console.log(`first load with the service worker ${info.project.name}: ${worked.total} bytes (${plain.total} without): ${worked.files.join(', ')}`);
    expect(worked.total).toBeLessThanOrEqual(FIRST_LOAD_BUDGET);
    // sw.js (under 1 KB packed) and a revalidation of the address: not a second copy of the 13 KB of the page
    expect(worked.total - plain.total).toBeLessThan(6_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Privacy (Review Focus 4)

interface Seen {
  url: string;
  method: string;
  headers: string;
  body: Buffer;
}

/**
 * What a request showed of its headers if the browser never reports the raw ones (Chromium does not for some requests answered
 * by `wrangler pages dev`, and `allHeaders()` would wait for ever): the headers the page set, after 5 s. The address and the
 * body are still checked in full.
 */
const headersGaveUp = (request: Request): Promise<Record<string, string>> => new Promise((resolve) => setTimeout(() => resolve(request.headers()), 5_000));

/** Every request of `context`: the page's, its workers' and the service worker's, with headers and body. */
function recordRequests(context: BrowserContext): { all: () => Promise<Seen[]> } {
  const pending: Promise<Seen>[] = [];
  context.on('request', (request) => {
    pending.push(
      (async () => ({
        url: request.url(),
        method: request.method(),
        headers: JSON.stringify(await Promise.race([request.allHeaders(), headersGaveUp(request)]).catch(() => request.headers())),
        body: request.postDataBuffer() ?? Buffer.alloc(0),
      }))(),
    );
  });
  return { all: () => Promise.all(pending) };
}

/** What stands in for Cloudflare's beacon: a script that reports the page address, as the real one does. Nothing leaves the machine. */
const BEACON_STUB = "navigator.sendBeacon('https://cloudflareinsights.com/cdn-cgi/rum', JSON.stringify({ url: location.href, referrer: document.referrer }));";

/** The strings that must be in no request, each in the forms a request could carry it. */
function secretsOf(pdf: Uint8Array): { label: string; needle: Buffer }[] {
  const stem = PRIVACY_FILE_NAME.replace(/\.pdf$/, '');
  const middle = Math.floor(pdf.length / 2);
  const slice = Buffer.from(pdf.subarray(middle, middle + 64));
  const texts = [PRIVACY_FILE_NAME, stem, '홍길동', '발표자료', ...PRIVACY_TEXT, ...PRIVACY_FONTS];
  const encodings = (text: string): string[] => [
    text,
    encodeURIComponent(text),
    encodeURIComponent(text).toLowerCase(),
    Buffer.from(text).toString('base64'),
    Buffer.from(text).toString('base64url'),
  ];
  // each of those for the text as typed and as a Mac writes a file name (NFD): NFD then percent-encoded, NFD then base64, ...
  const forms = texts.flatMap((text) => [...encodings(text), ...encodings(text.normalize('NFD'))]);
  const bytes = [slice, Buffer.from(slice.toString('base64')), Buffer.from(slice.toString('base64url')), Buffer.from(slice.toString('hex'))];
  return [...new Set(forms)]
    .map((text) => ({ label: text, needle: Buffer.from(text) }))
    .concat(bytes.map((needle, i) => ({ label: `file bytes (64 from the middle), form ${i}`, needle })));
}

const safeDecode = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Every secret of `pdf` found in `seen` (in a request's address, headers or body), as `label in where`. */
function findLeaks(seen: readonly Seen[], pdf: Uint8Array): string[] {
  const found: string[] = [];
  for (const { label, needle } of secretsOf(pdf)) {
    for (const r of seen) {
      const head = Buffer.from(`${r.url}\n${safeDecode(r.url)}\n${r.headers}`);
      if (head.includes(needle)) found.push(`${label} in the address or headers of ${r.method} ${r.url}`);
      if (r.body.includes(needle)) found.push(`${label} in the body of ${r.method} ${r.url}`);
    }
  }
  return found;
}

async function convertPrivately(page: Page, base: string, outside: string[]): Promise<void> {
  const pdf = privacyPdf();
  const node = await convert(pdf);
  const requests = recordRequests(page.context());
  await page.goto(`${base}/`);
  await expect(page.locator('#drop-title')).toHaveText(ko['drop.title']);
  await choose(page, pdf, PRIVACY_FILE_NAME);
  const pptx = await download(page);
  expect(pptx.name).toBe('홍길동_발표자료.pptx'); // the name is made here, from the file's
  expect(sha256(pptx.bytes)).toBe(sha256(node.pptx));
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  const seen = await requests.all();
  const origin = new URL(base).origin;
  // the engine and the CMap really were fetched (so this is not a check of a page that did nothing)
  expect(seen.some((r) => /\/assets\/worker-/.test(r.url))).toBe(true);
  expect(seen.some((r) => r.url.endsWith('/pdfjs/cmaps/KSCms-UHC-H.bcmap'))).toBe(true);
  // nothing leaves the site but to the hosts allowed (the beacon's, when the build has one)
  const hosts = [...new Set(seen.map((r) => new URL(r.url).origin))].filter((o) => o !== origin && o !== 'null');
  expect(hosts.sort()).toEqual(outside);
  expect(seen.filter((r) => r.method !== 'GET' && r.method !== 'HEAD' && new URL(r.url).origin === origin)).toEqual([]);
  // and none of them, in its address, headers or body, carries the file
  expect(findLeaks(seen, pdf)).toEqual([]);
  expect(await page.context().cookies()).toEqual([]); // analytics is cookie-free, and so is the site
}

test('privacy: converting 홍길동_발표자료.pdf sends nothing of it anywhere, and nothing goes outside the site', async ({ page }) => {
  await convertPrivately(page, BASE_URL, []);
});

test('privacy with the analytics beacon: only its hosts are added, and its payload is as clean', async ({ page }) => {
  const beacon: { url: string; body: string }[] = [];
  await page.route('https://static.cloudflareinsights.com/**', (route) => route.fulfill({ contentType: 'text/javascript', body: BEACON_STUB }));
  await page.route('https://cloudflareinsights.com/**', async (route) => {
    beacon.push({ url: route.request().url(), body: route.request().postData() ?? '' });
    await route.fulfill({ status: 204 });
  });
  await convertPrivately(page, BEACON_URL, ['https://cloudflareinsights.com', 'https://static.cloudflareinsights.com']);
  // the build's page carries the beacon with its token, as a data attribute; the stub reported the page's address only
  await expect(page.locator('script[data-cf-beacon]')).toHaveAttribute('data-cf-beacon', JSON.stringify({ token: FAKE_BEACON_TOKEN }));
  expect(beacon).toHaveLength(1);
  expect(JSON.parse(beacon[0]!.body)).toEqual({ url: `${BEACON_URL}/`, referrer: '' });
});

test.describe('negative control: the privacy check finds a leak', () => {
  /** Leaks, one a way, from a page of the e2e build (the test server answers 404 to all of them: only what they carry matters). */
  async function leakFrom(page: Page): Promise<Seen[]> {
    const requests = recordRequests(page.context());
    await page.goto(`${TEST_URL}/`);
    const pdf = privacyPdf();
    const slice = Buffer.from(pdf.subarray(Math.floor(pdf.length / 2), Math.floor(pdf.length / 2) + 64));
    await page.evaluate(
      async ({ name, sliceB64 }) => {
        const nfd = name.normalize('NFD');
        const b64 = (text: string): string => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
        await fetch(`/leak-url?n=${encodeURIComponent(nfd)}`).catch(() => undefined); // NFD, then percent-encoded, in the address
        await fetch('/leak-header', { headers: { 'x-name': encodeURIComponent(name) } }).catch(() => undefined); // in a header
        await fetch('/leak-body', { method: 'POST', body: `n=${b64(nfd)}&bytes=${sliceB64}` }).catch(() => undefined); // NFD then base64, and the bytes
        navigator.sendBeacon('/leak-beacon', name); // the way a beacon posts
        await new Promise((resolve) => setTimeout(resolve, 300));
      },
      { name: PRIVACY_FILE_NAME, sliceB64: slice.toString('base64') },
    );
    await page.waitForTimeout(500);
    return requests.all();
  }

  test('a name in the address (NFD, percent-encoded), in a header, in a body (NFD, base64), the bytes in a body, and a beacon are all found', async ({ page }) => {
    const found = findLeaks(await leakFrom(page), privacyPdf());
    const where = (needle: RegExp): boolean => found.some((line) => needle.test(line));
    expect(where(/in the address or headers of GET [^\n]*leak-url/)).toBe(true);
    expect(where(/in the address or headers of GET [^\n]*leak-header/)).toBe(true);
    expect(where(/in the body of POST [^\n]*leak-body/)).toBe(true);
    expect(where(/file bytes \(64 from the middle\), form 1 in the body of POST [^\n]*leak-body/)).toBe(true); // the bytes, base64
    expect(where(/in the body of POST [^\n]*leak-beacon/)).toBe(true);
    // the combined forms, found as such: NFD then percent-encoded (the address), NFD then base64 (the body)
    const nfd = PRIVACY_FILE_NAME.normalize('NFD');
    expect(found).toContainEqual(expect.stringContaining(`${encodeURIComponent(nfd)} in the address`));
    expect(found).toContainEqual(expect.stringContaining(`${Buffer.from(nfd).toString('base64')} in the body of POST`));
  });
});

test('no beacon without a token: the build has none, and no request goes to Cloudflare', async ({ page }) => {
  const requests = recordRequests(page.context());
  await page.goto('/');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('script[data-cf-beacon]')).toHaveCount(0);
  expect((await requests.all()).filter((r) => /cloudflare/.test(new URL(r.url).host))).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------------
// Offline (Review Focus 3)

/** Waits until the service worker's cache holds every file of its precache list (the page's, and the engine's cached at idle). */
async function waitForPrecache(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const source = await (await fetch('/sw.js')).text();
          const found = /\{"id":"[0-9a-f]+".*?"later":\[.*?\]\}/.exec(source);
          if (found === null) return 'no manifest in sw.js';
          const manifest = JSON.parse(found[0]) as { id: string; page: string[]; later: string[] };
          const cache = await caches.open(`deckback-${manifest.id}`);
          const cached = new Set((await cache.keys()).map((r) => new URL(r.url).pathname));
          const missing = [...manifest.page, ...manifest.later].filter((p) => !cached.has(p));
          return missing.length === 0 ? 'complete' : `missing ${missing.join(' ')}`;
        }),
      { timeout: 60_000, intervals: [500] },
    )
    .toBe('complete');
}

test('offline: after one visit the page opens with the network off and converts to the bytes Node writes', async ({ page, context }) => {
  const probe = new Uint8Array(readFileSync(PROBE_STD_PDF));
  const privacy = privacyPdf();
  const [nodeProbe, nodePrivacy] = [await convert(probe), await convert(privacy)];

  // the one visit, online. A file with a CJK CMap is converted, so the service worker caches that map as it is fetched.
  await page.goto('/');
  await expect(page.locator('#drop-title')).toHaveText(ko['drop.title']);
  await waitForPrecache(page);
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);
  await choose(page, privacy, PRIVACY_FILE_NAME);
  expect(sha256((await download(page)).bytes)).toBe(sha256(nodePrivacy.pptx));
  await expect
    .poll(() =>
      page.evaluate(async () => {
        for (const name of await caches.keys()) {
          if ((await (await caches.open(name)).keys()).some((r) => r.url.endsWith('KSCms-UHC-H.bcmap'))) return true;
        }
        return false;
      }),
    )
    .toBe(true);

  // the network off: reload and convert in the same page, then open the page new and convert
  await context.setOffline(true);
  for (const reopen of [() => page.reload(), () => page.goto('/')]) {
    await reopen();
    await expect(page.locator('#drop-title')).toHaveText(ko['drop.title']);
    await choose(page, probe, 'offline.pdf');
    const out = await download(page);
    expect(out.name).toBe('offline.pptx');
    expect(sha256(out.bytes)).toBe(sha256(nodeProbe.pptx));
  }
  // the file that needs the CMap fetched during the visit
  await page.reload();
  await choose(page, privacy, PRIVACY_FILE_NAME);
  expect(sha256((await download(page)).bytes)).toBe(sha256(nodePrivacy.pptx));
  await context.setOffline(false);
});

test('a worker of this build deletes the caches of other builds when it activates, and leaves other caches alone', async ({ page }) => {
  await page.goto('/');
  await waitForPrecache(page);
  await page.evaluate(async () => {
    await caches.open('deckback-000000000000'); // an old build
    await caches.open('someone-elses-cache');
    for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister();
  });
  await page.reload(); // registers and activates it again
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes('deckback-000000000000'))).toBe(false);
  expect(await page.evaluate(async () => (await caches.keys()).includes('someone-elses-cache'))).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------------------
// The Content-Security-Policy

/** The address the e2e build's worker reports a violation to (worker.ts): a POST to the site, which the test server answers 404. */
const WORKER_REPORT_PATH = '/__csp-violation';

/**
 * What the conversion worker heard of `securitypolicyviolation`. A violation inside a worker is raised on the worker's own
 * scope, which the page's listener does not see, and Playwright shows no such line in the console. So the e2e build (the one
 * the CSP tests use; VITE_E2E, worker.ts) listens as the worker starts and POSTs each violation to the site, where the
 * request recorder (recordRequests) reads it, however soon the page ends the worker. The production build has no listener.
 * (Chosen over a Report-Only copy of the policy with a report-uri: that is a second policy the site does not ship, and
 * needs a server of ours behind it; this one sees the shipped policy, and runs unchanged on `wrangler pages dev`.)
 */
const workerReports = (seen: readonly Seen[]): string[] => seen.filter((r) => r.url.endsWith(WORKER_REPORT_PATH)).map((r) => r.body.toString());

test('CSP in the worker is observed: a request the worker makes to another host is blocked and reported', async ({ page }) => {
  const requests = recordRequests(page.context());
  // the e2e's test page makes the conversion worker at load and leaves it idle: a worker to talk to (a conversion's ends with it).
  // It is the very worker module the site makes (make-worker.ts), served with the same _headers.
  const made = page.waitForEvent('worker');
  await page.goto(testPage('?request=inventory'));
  const worker = await made;
  await page.waitForTimeout(500);
  expect(workerReports(await requests.all())).toEqual([]); // so far, none
  const outcome = await worker.evaluate(async () => {
    const result = await fetch('https://example.com/probe').then(
      () => 'allowed',
      () => 'blocked',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    return result;
  });
  expect(outcome).toBe('blocked');
  await expect.poll(async () => workerReports(await requests.all())).toEqual([expect.stringContaining('connect-src https://example.com')]);
});

test('CSP: converting four decks, the CMap, JPX and PostScript-function ones included, raises 0 violations in the page and in the worker; the policy is in force', async ({ page, browserName }) => {
  const violations: string[] = [];
  const consoleLines: string[] = [];
  const errors: string[] = [];
  await page.addInitScript(() => {
    const heard: string[] = ((window as unknown as { __csp: string[] }).__csp = []);
    document.addEventListener('securitypolicyviolation', (e) => heard.push(`${e.effectiveDirective} ${e.blockedURI} ${(e.target as Element | null)?.nodeName ?? ''}`));
  });
  const watchConsole = (text: string): void => {
    if (/content security policy|refused to/i.test(text)) consoleLines.push(text);
  };
  page.on('console', (m) => watchConsole(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('worker', (worker) => {
    // a violation in the conversion worker is reported to the console of the worker (Playwright 1.57 and later)
    (worker as unknown as { on(event: 'console', handler: (m: { text(): string }) => void): void }).on('console', (m) => watchConsole(m.text()));
  });
  const requests = recordRequests(page.context());

  const response = (await page.goto(`${TEST_URL}/`))!;
  const policy = response.headers()['content-security-policy'] ?? '';
  expect(policy).toContain("default-src 'self'");
  expect(policy).toContain("worker-src 'self'");
  expect(policy.replace("'wasm-unsafe-eval'", '')).not.toMatch(/unsafe-/); // WebAssembly compile only: no eval, no inline

  const decks: [string, Uint8Array][] = [
    ['probe.pdf', new Uint8Array(readFileSync(PROBE_STD_PDF))],
    ['privacy.pdf', privacyPdf()],
    ['jpx.pdf', jpxPdf()],
    ['type4.pdf', type4Pdf()],
  ];
  for (const [name, bytes] of decks) {
    await page.goto(`${TEST_URL}/`);
    await choose(page, bytes, name);
    const out = await download(page);
    expect(sha256(out.bytes), name).toBe(sha256((await convert(bytes)).pptx));
    violations.push(...(await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)));
  }
  await page.waitForTimeout(500);

  // WebKit's own <select> sets an inline style when it is made (a bare createElement('select') plus an option does it, on a
  // page with no script of ours), which style-src-attr refuses: not ours to fix, and the only thing WebKit reports.
  const ours = violations.filter((v) => !(browserName === 'webkit' && v === 'style-src-attr inline SELECT'));
  expect(ours).toEqual([]);
  expect(workerReports(await requests.all())).toEqual([]); // the worker's own, where pdf.js runs: an eval, a wasm or a fetch it needs would be here
  expect(consoleLines.filter((line) => !(browserName === 'webkit' && /refused to apply a stylesheet/i.test(line)))).toEqual([]);
  expect(errors).toEqual([]);
  // pdf.js asked for no WebAssembly: nothing of pdfjs-dist but the character maps is fetched (no .wasm, no standard fonts)
  expect((await requests.all()).filter((r) => /\.wasm(\?|$)|standard_fonts|openjpeg|jbig2|qcms/.test(r.url))).toEqual([]);

  // the policy is in force, and the listener hears it: a request to another host is blocked as connect-src
  await page.goto(`${TEST_URL}/`);
  const blocked = await page.evaluate(async () => {
    const heard = new Promise<string>((resolve) =>
      document.addEventListener('securitypolicyviolation', (e) => resolve(`${e.effectiveDirective} ${e.blockedURI}`), { once: true }),
    );
    const result = await fetch('https://example.com/probe').then(
      () => 'allowed',
      () => 'blocked',
    );
    return { result, heard: await Promise.race([heard, new Promise<string>((resolve) => setTimeout(() => resolve('silent'), 2000))]) };
  });
  expect(blocked.result).toBe('blocked');
  expect(blocked.heard).toContain('connect-src');
});

// ---------------------------------------------------------------------------------------------------------------------
// Ruling M6-R3: the production build is the site only

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? filesUnder(join(dir, name), `${prefix}${name}/`) : [`${prefix}${name}`]));
}

/** What the worker's CSP-violation hook (src/worker.ts, e2e build only) is made of: the event it listens to and the address it reports to. */
const CSP_HOOK_STRINGS = ['securitypolicyviolation', '__csp-violation'];

test.describe('the e2e test page is not in the production build', () => {
  test.use({ serviceWorkers: 'block' });

  test('no test entry in the build output, and the e2e build (which has it) is another directory', () => {
    test.skip(EXTERNAL_SERVER, "the build under test is somebody else's: the address checks below cover it");
    const shipped = filesUnder(DIST_DIR).filter((f) => !f.startsWith('pdfjs/'));
    expect(shipped.filter((f) => /^test\.html$|^assets\/test-/.test(f))).toEqual([]);
    for (const file of shipped.filter((f) => /\.(html|js|css)$/.test(f))) {
      const text = readFileSync(join(DIST_DIR, file), 'utf8');
      expect(text.includes('e2e test page'), `${file} is the test page`).toBe(false);
      expect(text.includes('?request='), `${file} knows the test page's query`).toBe(false);
      for (const hook of CSP_HOOK_STRINGS) expect(text.includes(hook), `${file} has the e2e's worker hook (${hook})`).toBe(false);
    }
    // the check itself can fail: the build the e2e makes for the test page does have the entry
    expect(existsSync(join(E2E_DIST_DIR, 'test.html'))).toBe(true);
    expect(filesUnder(E2E_DIST_DIR).some((f) => /^assets\/test-.*\.js$/.test(f))).toBe(true);
    // ... and so does the hook: the e2e build's worker chunk holds both strings that the production check looks for
    const hooked = filesUnder(E2E_DIST_DIR).filter(
      (f) => /^assets\/worker-.*\.js$/.test(f) && CSP_HOOK_STRINGS.every((hook) => readFileSync(join(E2E_DIST_DIR, f), 'utf8').includes(hook)),
    );
    expect(hooked.length, 'the e2e worker chunk has the CSP-violation hook').toBeGreaterThan(0);
  });

  test('as served: /test.html is not the test page, and /?request=inventory is the website with no worker', async ({ page, request }) => {
    const served = await request.get('/test.html', { maxRedirects: 5 });
    expect(await served.text()).not.toContain('e2e test page');
    const workers: string[] = [];
    page.context().on('request', (r) => {
      if (/\/assets\/(worker|pdf)/.test(r.url())) workers.push(r.url());
    });
    await page.goto('/?request=inventory');
    await expect(page.locator('#drop-title')).toHaveText(ko['drop.title']);
    await page.waitForLoadState('networkidle');
    expect(await page.locator('#result').count()).toBe(0);
    expect(workers).toEqual([]);
  });

  test('as served: an unknown path is the website (Pages answers index.html, 200) or a 404, never the test page, and /__csp-violation is no endpoint', async ({ request }) => {
    const index = await (await request.get('/')).text();
    expect(index).not.toContain('e2e test page');
    for (const path of ['/no-such-page', '/test.html', '/test', '/__csp-violation', '/assets/no-such-file.js']) {
      const served = await request.get(path);
      expect([200, 404], `${path} answers ${served.status()}`).toContain(served.status());
      const body = await served.text();
      expect(body, path).not.toContain('e2e test page');
      // a 200 is the site's own page (Pages' single-page-app fallback), not another file
      if (served.status() === 200) expect(body, path).toBe(index);
    }
  });

  test('the e2e build does serve it (so the test above can tell)', async ({ request }) => {
    const served = await request.get(`${TEST_URL}/test.html`);
    expect(served.status()).toBe(200);
    expect(await served.text()).toContain('e2e test page');
  });
});
