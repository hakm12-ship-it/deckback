import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { convert } from '@deckback/core';
import { fontMapFor, reportView } from '../src/report-panel';
import { CLI } from './global-setup';
import { imageOnlyPdf, PROBE_STD_PDF } from './site-fixtures';

/**
 * M6 Task 4: the website writes the bytes the command-line tool writes (Review Focus 5), in every engine, on the site as it
 * is served (the local Pages emulation, `wrangler pages dev`, when E2E_BASE_URL is set). The reference is the built CLI
 * (`packages/cli/dist/deckback.mjs`, made by the global setup), run on the same file: the probe, atlas-smoke, a raster
 * fallback fixture. The CLI has no --font-map flag yet (M7), so a deck converted with a font map is compared with Node's
 * `convert` given the same fontMap. Public PDFs only.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const FILES = [
  { name: 'probe_std.pdf', path: PROBE_STD_PDF },
  { name: 'atlas-smoke_std.pdf', path: `${repo}corpus/generated/atlas-smoke_std.pdf` },
  { name: 'fallback/blend-multiply.pdf (a raster fallback)', path: `${repo}corpus/generated/fallback/blend-multiply.pdf` },
];

test.use({ locale: 'ko-KR' });

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function download(page: Page): Promise<Buffer> {
  await expect(page.locator('#outcome')).toBeVisible({ timeout: 120_000 });
  const [file] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
  return readFileSync(await file.path());
}

/** What the built CLI writes for `pdf`. */
function cliHash(pdf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'deckback-cli-'));
  try {
    execFileSync(process.execPath, [CLI, pdf, '-o', join(dir, 'out.pptx')], { stdio: 'pipe' });
    return sha256(readFileSync(join(dir, 'out.pptx')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const { name, path } of FILES) {
  test(`the website's PPTX of ${name} is the CLI's, byte for byte`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.goto('/');
    await page.locator('#file').setInputFiles(path);
    expect(sha256(await download(page))).toBe(cliHash(path));
  });
}

test('a deck converted with a font map is what Node writes for the same fontMap (the CLI has no flag yet)', async ({ page }) => {
  const bytes = imageOnlyPdf();
  const node = await convert(bytes);
  await page.goto('/');
  await page.locator('#file').setInputFiles({ name: 'mixed.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  const first = await download(page);
  expect(sha256(first)).toBe(sha256(node.pptx));
  const row = page.locator('[data-part="fonts"] .font');
  await row.locator('select').selectOption('Arial');
  await expect(row.locator('.mapped')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#outcome')).not.toHaveClass(/stale/);
  const fontMap = fontMapFor(reportView(node.report, 'ko', () => false).fonts, new Map([[node.report.fonts[0]!.latin!, 'Arial']]));
  expect(fontMap).toEqual({ DeckbackTest: 'Arial' });
  const mapped = await download(page);
  expect(sha256(mapped)).toBe(sha256((await convert(bytes, { fontMap })).pptx));
  expect(sha256(mapped)).not.toBe(sha256(first));
});
