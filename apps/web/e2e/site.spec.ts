import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type FileChooser, type Page } from '@playwright/test';
import { convert } from '@deckback/core';
import { MESSAGES } from '../src/i18n';
import { fontMapFor, reportView } from '../src/report-panel';
import { imageOnlyPdf, notPdf, passwordPdf, permissionsOnlyPdf, PROBE_STD_PDF, SLOW_PAGES, slowPdf, truncatedPdf } from './site-fixtures';

/**
 * M6 Task 2: the website (`/`), as a user meets it: drop or choose a PDF, watch the progress, cancel, download the PPTX,
 * read the report; and each Review Focus 2 file. All four engines locally, chromium in CI (playwright.config.ts). The
 * files are the committed public corpus and the ones site-fixtures.ts makes, handed to the page from memory.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const SMOKE_PDF = `${repo}corpus/generated/atlas-smoke_std.pdf`;
const ko = MESSAGES.ko;
const en = MESSAGES.en;

test.use({ locale: 'ko-KR' });

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Drops `bytes` on the drop zone as the file `name`, as a drag from the desktop does. */
async function drop(page: Page, bytes: Uint8Array, name: string): Promise<void> {
  const dataTransfer = await page.evaluateHandle(
    ({ b64, name }) => {
      const raw = atob(b64);
      const data = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) data[i] = raw.charCodeAt(i);
      const transfer = new DataTransfer();
      transfer.items.add(new File([data], name, { type: 'application/pdf' }));
      return transfer;
    },
    { b64: Buffer.from(bytes).toString('base64'), name },
  );
  for (const type of ['dragenter', 'dragover', 'drop']) await page.dispatchEvent('#drop', type, { dataTransfer });
}

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

/** Records what could carry a file out (any request but GET or HEAD, and every address in full, query string included), the page's errors and its console. */
function watch(page: Page) {
  const seen = { uploads: [] as string[], requests: [] as string[], errors: [] as string[], console: [] as string[] };
  page.context().on('request', (request) => {
    const url = new URL(request.url());
    seen.requests.push(`${url.pathname}${url.search}`);
    if (request.method() !== 'GET' && request.method() !== 'HEAD') seen.uploads.push(`${request.method()} ${request.url()}`);
  });
  page.on('pageerror', (error) => seen.errors.push(String(error)));
  page.on('console', (message) => seen.console.push(message.text()));
  return seen;
}

test('drop the probe PDF: the worker loads on the drop, and the PPTX downloaded is the one Node writes', async ({ page }) => {
  const bytes = new Uint8Array(readFileSync(PROBE_STD_PDF));
  const node = await convert(bytes);
  const seen = watch(page);
  await page.goto('/');
  await expect(page.locator('#drop-title')).toHaveText(ko['drop.title']);
  await page.waitForLoadState('networkidle');
  const beforeDrop = [...seen.requests];
  expect(beforeDrop.filter((path) => /\/assets\/(worker|pdf)/.test(path))).toEqual([]); // no engine before a file

  const name = '분기 보고 (최종).pdf';
  await drop(page, bytes, name);
  const pptx = await download(page);
  expect(pptx.name).toBe('분기 보고 (최종).pptx');
  expect(sha256(pptx.bytes)).toBe(sha256(node.pptx));
  expect(seen.requests.filter((path) => /\/assets\/worker-/.test(path)).length).toBeGreaterThanOrEqual(1);

  // the report panel: the stats of the spec's example, the fonts with their hint
  const stats = page.locator('[data-part="stats"] .stat');
  await expect(stats.nth(0)).toHaveText(`${ko['report.slides']}${node.report.slides.length}`);
  await expect(stats.nth(2)).toHaveText(`${ko['report.textBoxes']}${node.report.totals.textBoxes}`);
  await expect(page.locator('[data-part="fonts"] .font')).toHaveCount(2); // Gothic A1 (고딕 A1) and Pretendard
  await expect(page.locator('.report .hint')).toHaveText(ko['report.fonts.hint']);

  expect(seen.uploads).toEqual([]);
  expect(seen.errors).toEqual([]);
  expect(seen.console.filter((text) => text.includes('분기 보고'))).toEqual([]); // the file name is never logged
  // nor is it in any address, query string included, plain or percent-encoded
  for (const form of [name, name.normalize('NFD'), '분기 보고', encodeURIComponent(name), encodeURIComponent('분기 보고'), encodeURIComponent(name).toLowerCase()]) {
    expect(seen.requests.filter((address) => address.includes(form) || decodeURIComponent(address).includes(form))).toEqual([]);
  }
});

test('a phone, 360 px wide: the page and its report do not scroll sideways', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto('/');
  await expect(page.locator('#drop-title')).toHaveText(ko['drop.title']);
  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(await sideways()).toBeLessThanOrEqual(0);
  await choose(page, new Uint8Array(readFileSync(PROBE_STD_PDF)), 'phone.pdf');
  await expect(page.locator('#outcome')).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('.report')).toBeVisible();
  expect(await page.evaluate(() => window.innerWidth)).toBe(360);
  expect(await sideways()).toBeLessThanOrEqual(0);
});

test('progress: a count per slide, up to total/total', async ({ page }) => {
  const bytes = new Uint8Array(readFileSync(SMOKE_PDF));
  const total = (await convert(bytes, { pages: [0] })).report.source.pageCount;
  await page.goto('/');
  await page.evaluate(() => {
    const progress = document.querySelector<HTMLElement>('#progress')!;
    const seen: [number, number, string][] = [];
    (window as unknown as { seen: typeof seen }).seen = seen;
    new MutationObserver(() => {
      const { done, total } = progress.dataset;
      if (done === undefined || total === undefined) return;
      const last = seen[seen.length - 1];
      if (last === undefined || last[0] !== Number(done)) seen.push([Number(done), Number(total), document.querySelector('#progress-text')!.textContent ?? '']);
    }).observe(progress, { attributes: true, childList: true, characterData: true, subtree: true });
  });
  await choose(page, bytes, 'atlas-smoke_std.pdf');
  await expect(page.locator('#outcome')).toBeVisible({ timeout: 90_000 });
  const seen = await page.evaluate(() => (window as unknown as { seen: [number, number, string][] }).seen);
  expect(seen.map(([done]) => done)).toEqual(Array.from({ length: total + 1 }, (_, i) => i)); // 0/38 .. 38/38, each once
  expect(seen.every(([, t]) => t === total)).toBe(true);
  expect(seen[seen.length - 1]![2]).toBe(`슬라이드 ${total}/${total} 변환 중`);
  await expect(page.locator('#progress')).toBeHidden();
});

test('cancel stops the conversion at once (the worker is terminated), and the next file converts', async ({ page }) => {
  const seen = watch(page);
  const workers: { closed: boolean }[] = [];
  page.on('worker', (worker) => {
    const record = { closed: false };
    workers.push(record);
    worker.on('close', () => (record.closed = true));
  });
  await page.goto('/');
  await choose(page, slowPdf(), 'slow.pdf');
  const progress = page.locator('#progress');
  await expect.poll(async () => Number((await progress.getAttribute('data-done')) ?? -1), { timeout: 60_000 }).toBeGreaterThanOrEqual(2);
  const done = Number(await progress.getAttribute('data-done'));
  expect(done).toBeLessThan(SLOW_PAGES); // mid-way
  await expect(progress).toHaveAttribute('data-total', String(SLOW_PAGES));

  await page.locator('#cancel').click();
  await expect(page.locator('#status')).toHaveText(ko['status.cancelled']);
  await expect(progress).toBeHidden();
  await expect(page.locator('#outcome')).toBeHidden();
  await expect(page.locator('#choose')).toBeFocused();
  await expect.poll(() => workers[0]?.closed, { timeout: 10_000 }).toBe(true);

  // a second conversion, in a fresh worker
  const bytes = new Uint8Array(readFileSync(PROBE_STD_PDF));
  await choose(page, bytes, 'probe_std.pdf');
  const pptx = await download(page);
  expect(sha256(pptx.bytes)).toBe(sha256((await convert(bytes)).pptx));
  expect(workers.length).toBe(2);
  await expect(page.locator('#status')).toBeEmpty();
  expect(seen.errors).toEqual([]);
});

test('Review Focus 2: a password, not a PDF, a truncated PDF: fixed words in both languages, nothing hangs', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/');
  const alert = page.locator('#status .alert');
  for (const [bytes, kind] of [
    [passwordPdf(), 'password'],
    [notPdf(), 'not-pdf'],
    [truncatedPdf(), 'damaged'],
  ] as const) {
    await choose(page, bytes, `${kind}.pdf`);
    await expect(alert).toHaveText(ko[`error.${kind}`], { timeout: 30_000 });
    await expect(alert).toHaveAttribute('data-error', kind);
    await expect(page.locator('#outcome')).toBeHidden();
    await expect(page.locator('#progress')).toBeHidden();
    await page.locator('#lang').click();
    await expect(alert).toHaveText(en[`error.${kind}`]);
    await page.locator('#lang').click();
  }
  expect(seen.errors).toEqual([]);
  expect(seen.uploads).toEqual([]);
});

test('Review Focus 2: a PDF encrypted with permissions only converts, and the report says so', async ({ page }) => {
  const bytes = permissionsOnlyPdf();
  await page.goto('/');
  await choose(page, bytes, 'locked.pdf');
  const pptx = await download(page);
  expect(pptx.name).toBe('locked.pptx');
  expect(sha256(pptx.bytes)).toBe(sha256((await convert(bytes)).pptx));
  await expect(page.locator('[data-part="notices"] .notice')).toHaveText([ko['report.encrypted']]);
});

test('an image-only page is named in the report, the deck still downloads, and a missing font can be replaced', async ({ page }) => {
  const bytes = imageOnlyPdf();
  const node = await convert(bytes);
  await page.goto('/');
  await choose(page, bytes, 'mixed.pdf');
  const first = await download(page);
  expect(sha256(first.bytes)).toBe(sha256(node.pptx));
  await expect(page.locator('[data-part="image-only"] li')).toHaveText([`1쪽 ${ko['report.imageOnly.message']}`]);

  // the text's font (DeckbackTest) is installed nowhere: its row offers substitutes; Arial converts again with a font map
  const row = page.locator('[data-part="fonts"] .font');
  await expect(row).toHaveCount(1);
  await expect(row.locator('.badge')).toHaveText(ko['report.fonts.missing']);
  await row.locator('select').selectOption('Arial');
  await expect(row.locator('.mapped')).toHaveText('Arial 글꼴로 바꿔 썼어요', { timeout: 60_000 });
  await expect(page.locator('#outcome')).not.toHaveClass(/stale/);
  const fontMap = fontMapFor(reportView(node.report, 'ko', () => false).fonts, new Map([[node.report.fonts[0]!.latin!, 'Arial']]));
  expect(fontMap).toEqual({ DeckbackTest: 'Arial' });
  const mapped = await download(page);
  expect(sha256(mapped.bytes)).toBe(sha256((await convert(bytes, { fontMap })).pptx));
  expect(sha256(mapped.bytes)).not.toBe(sha256(node.pptx));
  await expect(row.locator('select')).toHaveValue('Arial');
});

test('languages: the browser\'s by default, a toggle, kept for the next visit', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#drop-title')).toHaveText(en['drop.title']);
  await expect(page.locator('#choose')).toHaveText(en['drop.choose']);
  await page.locator('#lang').click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'ko');
  await expect(page.locator('#choose')).toHaveText(ko['drop.choose']);
  await expect(page.locator('.foot p')).toHaveText(ko['footer.privacy']);
  await page.reload();
  await expect(page.locator('#choose')).toHaveText(ko['drop.choose']);
  await context.close();
});

test('keyboard: every step reachable, with a visible focus ring', async ({ page, browserName }) => {
  // Listened for before the page loads: Playwright turns the file chooser's interception on when the first listener is
  // added, asynchronously, and a chooser opened before that is a real one that never reports (1 run in 8 under load).
  const choosers: FileChooser[] = [];
  page.on('filechooser', (chooser) => choosers.push(chooser));
  await page.goto('/');
  const tabTo = async (selector: string): Promise<void> => {
    for (let i = 0; i < 10 && !(await page.locator(selector).evaluate((el) => el === document.activeElement)); i++) {
      await page.keyboard.press('Tab');
    }
    await expect(page.locator(selector)).toBeFocused();
  };
  await tabTo('#lang');
  await tabTo('#choose');
  expect(await page.locator('#choose').evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('solid');
  await page.keyboard.press('Enter');
  await expect.poll(() => choosers.length).toBe(1);
  await choosers[0]!.setFiles({ name: 'probe.pdf', mimeType: 'application/pdf', buffer: readFileSync(PROBE_STD_PDF) });
  await expect(page.locator('#outcome-title')).toBeFocused({ timeout: 90_000 });
  // WebKit's Tab skips links unless the user turns on "Press Tab to highlight each item" (Safari's default), so there
  // the download link is reached by the pointer or that setting; every other engine tabs to it.
  if (browserName !== 'webkit') await tabTo('#download');
  await tabTo('.report summary');
});
