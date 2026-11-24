import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { extractScene, sceneHash, type Element } from '@deckback/core';
import { OUT_DIR, SCENE_PROBE_PDF } from './global-setup';
import { testPage } from './servers';

/**
 * Review Focus 4: the same file in Node and in a browser worker gives byte-identical canonical Scene JSON and media, or the
 * CLI and the website would write different PPTX files later. The worker replies with the Scene's hash and the SHA-256 of
 * every media file it made, in order (never the Scene or the bytes); Node computes the same here, with the same core code.
 * All four engines locally, chromium in CI (playwright.config.ts). Public PDFs only: their hashes are recorded.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const SMOKE = `${repo}corpus/generated/atlas-smoke_std.pdf`;
/**
 * The brief's two, and the smoke deck's pictures, so that the media are compared too (pages 1 to 8 have none): page 10's
 * images in tile cells, the JPEGs and PNGs of the pictures/* slides 32 to 34, and page 38's images with large soft masks.
 * Then the scene probe the global setup writes, for what those pages lack: links, a soft mask, transparency groups and
 * radial gradients (`probe`: the Scene must hold them, or the comparison would not reach them).
 */
const CASES = [
  { name: 'probe_std.pdf, every page', pdf: `${repo}corpus/generated/probe_std.pdf`, pages: [] as number[], pictures: false, probe: false },
  { name: 'atlas-smoke_std.pdf, pages 1 to 8', pdf: SMOKE, pages: [0, 1, 2, 3, 4, 5, 6, 7], pictures: false, probe: false },
  { name: 'atlas-smoke_std.pdf, pages 10, 32 to 34 and 38', pdf: SMOKE, pages: [9, 31, 32, 33, 37], pictures: true, probe: false },
  { name: 'scene-probe.pdf (links, soft mask, groups, radial gradients)', pdf: SCENE_PROBE_PDF, pages: [], pictures: false, probe: true },
];

type Reply = { type: 'scene'; hash: string; mediaHashes: string[] } | { type: 'error'; message: string } | { type: 'result' };

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** What Node makes of a case: the Scene's hash, the SHA-256 of each media file in order, and how much there is. */
async function inNode(pdf: string, pages: number[]) {
  const bundle = await extractScene(new Uint8Array(readFileSync(pdf)), { pages });
  const { slides } = bundle.scene;
  const elements: Element[] = slides.flatMap((s) => s.elements);
  return {
    hash: await sceneHash(bundle.scene),
    mediaHashes: [...bundle.media.values()].map(sha256),
    slides: slides.length,
    elements: slides.reduce((n, s) => n + s.elements.length, 0),
    failed: slides.filter((s) => s.failed !== null).length,
    notes: slides.reduce((n, s) => n + s.notes.length, 0),
    /** What the slides hold of what the corpus pages above lack. */
    features: {
      hotspots: elements.filter((e) => e.kind === 'hotspot').length,
      masks: slides.reduce((n, s) => n + Object.keys(s.masks).length, 0),
      grouped: elements.filter((e) => e.groups.length > 0).length,
      radial: elements.filter((e) => e.kind === 'shape' && (e.fill?.kind === 'radial' || e.line?.paint.kind === 'radial')).length,
    },
  };
}

/** Opens the app asking for Scenes of `pages`, chooses `pdf` and returns the reply `main.ts` writes into `#result`. */
async function inWorker(page: Page, pdf: string, pages: number[]): Promise<Reply> {
  await page.goto(testPage(`?request=scene&pages=${pages.join(',')}`));
  const result = page.locator('#result');
  await page.locator('#file').setInputFiles(pdf);
  await expect(result).not.toBeEmpty({ timeout: 90_000 });
  return JSON.parse((await result.textContent()) ?? '') as Reply;
}

test('Review Focus 4: the worker makes the Scene and media Node makes, byte for byte', async ({ page }, testInfo) => {
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
    for (const { name, pdf, pages, pictures, probe } of CASES) {
      const node = await inNode(pdf, pages);
      const record = { name, node, worker: null as Reply | null, equal: false };
      evidence.cases.push(record);
      // A comparison of empty or failed Scenes would prove nothing.
      expect(node.elements, name).toBeGreaterThan(0);
      expect([node.failed, node.notes], name).toEqual([0, 0]);
      if (pictures) expect(node.mediaHashes.length, name).toBeGreaterThan(10);
      if (probe) {
        expect(node.features.hotspots, name).toBe(2);
        expect([node.features.masks, node.features.grouped, node.features.radial].every((n) => n > 0), name).toBe(true);
        expect(node.mediaHashes.length, name).toBeGreaterThan(0);
      }

      record.worker = await inWorker(page, pdf, pages);
      record.equal = record.worker.type === 'scene' && record.worker.hash === node.hash;
      expect(record.worker, name).toEqual({ type: 'scene', hash: node.hash, mediaHashes: node.mediaHashes });
    }
    expect(pageErrors).toEqual([]);
    expect(uploads).toEqual([]);
    evidence.ok = true;
  } catch (error) {
    evidence.failure = (error instanceof Error ? error.message : String(error)).replace(/\u001b\[[0-9;]*m/g, '');
    throw error;
  } finally {
    writeFileSync(`${OUT_DIR}scene-worker-${testInfo.project.name}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  }
});
