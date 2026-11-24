import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { convert, sceneHash } from '@deckback/core';
import { partsOf } from '../../../packages/core/test/helpers/pptx';
import { CONVERT_PROBE_PDF, GRADIENT_PROBE_PDF, OUT_DIR, SCENE_PROBE_PDF } from './global-setup';
import { testPage } from './servers';

/**
 * Review Focus 4 (M3 Task 9): the same file in Node and in a browser worker gives a byte-identical PPTX and the same
 * report, or the CLI and the website would write different files. The worker replies with the SHA-256 of the PPTX, its
 * length and the hash of the report's canonical JSON (never the file or the report); Node computes the same here, with
 * the same core code. All four engines locally, chromium in CI (playwright.config.ts). Public PDFs only.
 *
 * The cases: the four of scene-worker.spec.ts, then what they lack for the PPTX (M2-R34, `atan2`; Task 8's text boxes
 * placed with a cosine and sine rounded to EMU): atlas-smoke page 9, whose gradients run across the axes, and the
 * convert probe the global setup writes: text at 30, 45, 200 and 333.3 degrees, turned gradients, three page sizes (one
 * past PowerPoint's range, converted first so that it sets the slide size) and a link to a page `pages` moves.
 *
 * M5 Task 2 (Review Focus 2): the four raster fallback fixtures (corpus/generated/fallback/), whose pictures the worker's
 * raster renderer must draw to the same PNG bytes as Node's: a Multiply blend over its backdrop, a luminosity soft mask
 * over an image (drawn from the page's decoded pixels), a Type 4 mesh and a function-based shading.
 *
 * M5 Task 3: the gradient probe the global setup writes: a soft mask made per-stop alpha, text in clip mode painted by a
 * gradient (the run's gradFill), and a radial gradient off its box's centre (a tile rect).
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const SMOKE = `${repo}corpus/generated/atlas-smoke_std.pdf`;
const CASES = [
  { name: 'probe_std.pdf, every page', pdf: `${repo}corpus/generated/probe_std.pdf`, pages: [] as number[] },
  { name: 'atlas-smoke_std.pdf, pages 1 to 8', pdf: SMOKE, pages: [0, 1, 2, 3, 4, 5, 6, 7] },
  { name: 'atlas-smoke_std.pdf, pages 10, 32 to 34 and 38', pdf: SMOKE, pages: [9, 31, 32, 33, 37] },
  { name: 'atlas-smoke_std.pdf, pages 16, 19, 20, 23 and 37 (drift splits, wide spaces)', pdf: SMOKE, pages: [15, 18, 19, 22, 36] },
  { name: 'scene-probe.pdf (links, soft mask, groups, radial gradients)', pdf: SCENE_PROBE_PDF, pages: [] as number[] },
  { name: 'atlas-smoke_std.pdf, page 9 (gradients across the axes)', pdf: SMOKE, pages: [8] },
  { name: 'convert-probe.pdf, pages 3, 1, 2 (turned text, page sizes, a link)', pdf: CONVERT_PROBE_PDF, pages: [2, 0, 1] },
  { name: 'gradient-probe.pdf (stop alpha, gradient text, an off-centre radial)', pdf: GRADIENT_PROBE_PDF, pages: [] as number[] },
  ...['blend-multiply', 'softmask-image', 'mesh-type4', 'function-shading'].map((name) => ({
    name: `fallback/${name}.pdf (a raster fallback)`,
    pdf: `${repo}corpus/generated/fallback/${name}.pdf`,
    pages: [] as number[],
  })),
];

type Reply = { type: 'convert'; pptxHash: string; pptxBytes: number; reportHash: string } | { type: 'error'; message: string } | { type: 'result' };

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A DrawingML angle (60000ths of a degree) that is not a quarter turn. */
const offQuarter = (angle: number): boolean => angle % 5_400_000 !== 0;

/** What Node makes of a case: the reply the worker should give, and what the PPTX holds that the comparison reaches. */
async function inNode(pdf: string, pages: number[]) {
  const { pptx, report } = await convert(new Uint8Array(readFileSync(pdf)), { pages });
  const slides = Object.entries(partsOf(pptx))
    .filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .map(([, xml]) => xml);
  const textBoxes = slides.flatMap((xml) => (xml.match(/<p:sp>.*?<\/p:sp>/gs) ?? []).filter((sp) => sp.includes('txBox="1"')));
  return {
    reply: { type: 'convert', pptxHash: sha256(pptx), pptxBytes: pptx.length, reportHash: await sceneHash(report) },
    slides: report.slides.length,
    nodes:
      report.totals.textBoxes + report.totals.freeforms + report.totals.rects + report.totals.lines + report.totals.pictures + report.totals.hotspots + report.totals.fallbacks,
    failed: report.slides.filter((s) => s.failed !== null).length,
    scaled: report.slides.filter((s) => s.scale !== null).length,
    slideSizePt: report.slideSizePt,
    features: {
      /** Linear gradients across the axes (`a:lin ang`), the angle that `atan2` gives. */
      turnedGradients: slides.flatMap((xml) => [...xml.matchAll(/<a:lin ang="(\d+)"/g)].map((m) => Number(m[1]))).filter(offQuarter).length,
      /** Text boxes turned off a quarter turn: their place comes from a cosine and a sine. */
      turnedText: textBoxes.map((sp) => Number(/<a:xfrm rot="(\d+)"/.exec(sp)?.[1] ?? 0)).filter(offQuarter).length,
      pictures: report.totals.pictures,
      slideLinks: slides.reduce((n, xml) => n + (xml.match(/<a:hlinkClick r:id="[^"]+" action="ppaction:\/\/hlinksldjump"/g) ?? []).length, 0),
      /** M5 Task 3: radial gradients off their box's centre (`a:tileRect`) and gradient stops with alpha. */
      tileRects: slides.reduce((n, xml) => n + (xml.match(/<a:tileRect/g) ?? []).length, 0),
      alphaStops: slides.reduce((n, xml) => n + (xml.match(/<a:gs pos="[0-9]+"><a:srgbClr val="[0-9A-F]{6}"><a:alpha /g) ?? []).length, 0),
      fallbacks: report.totals.fallbacks,
      /** M5: fallbacks drawn by the raster renderer, each a PNG of the PPTX. */
      rasters: report.slides.reduce((n, s) => n + s.fallbacks.filter((f) => f.raster !== undefined).length, 0),
    },
  };
}

/** Opens the app asking for the PPTX of `pages`, chooses `pdf` and returns the reply `test-page.ts` writes into `#result`. */
async function inWorker(page: Page, pdf: string, pages: number[]): Promise<Reply> {
  await page.goto(testPage(`?request=convert&pages=${pages.join(',')}`));
  const result = page.locator('#result');
  await page.locator('#file').setInputFiles(pdf);
  await expect(result).not.toBeEmpty({ timeout: 90_000 });
  return JSON.parse((await result.textContent()) ?? '') as Reply;
}

test('Review Focus 4: the worker writes the PPTX and report Node writes, byte for byte', async ({ page }, testInfo) => {
  test.setTimeout(300_000); // eleven conversions in each engine, the raster fixtures among them
  const browser = page.context().browser();
  const uploads: string[] = [];
  page.context().on('request', (request) => {
    if (request.method() !== 'GET' && request.method() !== 'HEAD') uploads.push(`${request.method()} ${request.url()}`);
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));

  // Evidence, written in `finally` so a failing engine leaves its record (the global setup deletes the last run's files).
  const evidence = {
    project: testInfo.project.name,
    browser: `${browser?.browserType().name()} ${browser?.version()}`,
    ok: false,
    failure: null as string | null,
    cases: [] as { name: string; node: Awaited<ReturnType<typeof inNode>>; worker: Reply | null; equal: boolean }[],
    pageErrors,
    uploads,
  };
  try {
    for (const { name, pdf, pages } of CASES) {
      const node = await inNode(pdf, pages);
      const record = { name, node, worker: null as Reply | null, equal: false };
      evidence.cases.push(record);
      // A comparison of empty or failed decks would prove nothing.
      expect(node.nodes, name).toBeGreaterThan(0);
      expect(node.failed, name).toBe(0);

      record.worker = await inWorker(page, pdf, pages);
      record.equal = JSON.stringify(record.worker) === JSON.stringify(node.reply);
      expect(record.worker, name).toEqual(node.reply);
    }
    // What the cases reach, together: pictures, turned gradients and text, scaled pages, a link between slides.
    const all = evidence.cases.map((c) => c.node);
    expect(all.reduce((n, c) => n + c.features.pictures, 0)).toBeGreaterThan(10);
    expect(all.reduce((n, c) => n + c.features.turnedGradients, 0)).toBeGreaterThanOrEqual(3);
    expect(all.reduce((n, c) => n + c.features.turnedText, 0)).toBeGreaterThanOrEqual(4);
    expect(all.reduce((n, c) => n + c.features.slideLinks, 0)).toBeGreaterThanOrEqual(1);
    // M5 (Review Focus 2): every fallback fixture's raster drawn alike
    expect(all.reduce((n, c) => n + c.features.rasters, 0)).toBeGreaterThanOrEqual(4);
    const probe = all.find((_, i) => CASES[i]!.pdf === CONVERT_PROBE_PDF)!;
    expect(probe.slideSizePt).toEqual([4032, 2419.2]);
    expect(probe.scaled).toBe(3);
    // M5 Task 3 (review Minor 2): the gradient probe is written as gradients, not as a raster that would hash alike
    const gradients = all.find((_, i) => CASES[i]!.pdf === GRADIENT_PROBE_PDF)!;
    expect(gradients.features.fallbacks).toBe(0);
    expect(gradients.features.tileRects).toBeGreaterThanOrEqual(1);
    expect(gradients.features.alphaStops).toBeGreaterThanOrEqual(1);
    expect(pageErrors).toEqual([]);
    expect(uploads).toEqual([]);
    evidence.ok = true;
  } catch (error) {
    evidence.failure = (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, '');
    throw error;
  } finally {
    writeFileSync(`${OUT_DIR}convert-worker-${testInfo.project.name}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  }
});
