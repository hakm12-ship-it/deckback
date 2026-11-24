// Prints the pages in harness/producers/pages/ to PDF with Playwright's Chromium, whose PDF backend is Skia.
//
//   npm run producers:skia        (from the repository root)
//
// Writes out/producers/skia-<page>.pdf, one single-page PDF per page. `npm run oracle:sweep` walks that folder as the
// set `producers` (not PowerPoint's output: no gate, it shows what the walker must survive).
//
// The PDFs embed Windows system fonts (Malgun Gothic, Segoe UI, Batang ...), so they are local-only: they stay under
// out/ (gitignored) and are never committed. The pages use no network; any request other than data:, about: and a
// file: URL of this machine (no host, and no UNC-like path such as `file:////host/...`: those go over the network) is
// refused and fails the run (`allowedRequest`). Chromium is found the way the e2e tests find it (`@playwright/test`,
// workspace apps/web); if the browser is missing, `npx playwright install chromium` installs it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { allowedRequest } from './requests.mjs';

const PAGES = ['gradients', 'transparency', 'clips', 'text', 'patterns', 'images'];

const repo = fileURLToPath(new URL('../../', import.meta.url));
const pagesDir = fileURLToPath(new URL('./pages/', import.meta.url));
const outDir = `${repo}out/producers/`;

/** The pages of the PDF, counted from the page tree (`/Type /Page`, not `/Type /Pages`); null if not readable that way. */
function countPages(bytes) {
  const text = Buffer.from(bytes).toString('latin1');
  const count = text.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
  return count > 0 ? count : null;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const refused = [];
  const problems = [];
  try {
    console.log(`Chromium ${browser.version()}`);
    const context = await browser.newContext();
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (allowedRequest(url)) {
        return route.continue();
      }
      refused.push(url.slice(0, 60));
      return route.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));

    for (const name of PAGES) {
      await page.goto(pathToFileURL(`${pagesDir}${name}.html`).href, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const pdf = await page.pdf({ printBackground: true, preferCSSPageSize: true });
      if (Buffer.from(pdf.subarray(0, 5)).toString('latin1') !== '%PDF-') {
        problems.push(`${name}: Chromium did not return a PDF`);
        continue;
      }
      writeFileSync(`${outDir}skia-${name}.pdf`, pdf);
      const pages = countPages(pdf);
      console.log(`out/producers/skia-${name}.pdf  ${pdf.length} bytes  ${pages ?? '?'} page(s)`);
      if (pages !== null && pages !== 1) {
        problems.push(`${name}: the page printed as ${pages} PDF pages, expected 1 (its content overflows the page)`);
      }
    }
    if (errors.length > 0) {
      problems.push(`a page script failed: ${errors[0]}`);
    }
    if (refused.length > 0) {
      problems.push(`a page asked for the network: ${refused.join(', ')}`);
    }
  } finally {
    await browser.close();
  }
  if (problems.length > 0) {
    throw new Error(problems.join('\n'));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
