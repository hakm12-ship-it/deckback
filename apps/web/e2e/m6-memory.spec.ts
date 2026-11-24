import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { convert, type Report } from '@deckback/core';
import { type MiniObject } from '../../../packages/core/test/helpers/minipdf';
import { sizedPdf } from '../../../packages/core/test/helpers/pptx';
import { testPage } from './servers';

/**
 * M6 Task 1 (web budgets): the peak memory of the conversion worker in Chromium, for the hostile raster inputs that sit at
 * the caps (RASTER_MAX_POINTS a raster, the mesh work cap, the slide's pixel cap: M5's hostile tests) and for a 100-page
 * atlas conversion (out/atlas/atlas_std.pdf, git-ignored: that case is skipped where the file is missing). Chromium only
 * (the numbers come from the DevTools Protocol, as M0-7's); written to out/m6/memory.json and gated at PEAK_LIMIT_MB:
 * the caps are lowered only past it. Local only, like m0-perf (playwright.config.ts): synthetic PDFs, no private file.
 *
 * Memory is the worker's used V8 heap plus its ArrayBuffers (`Runtime.getHeapUsage`: usedSize + backingStorageSize),
 * sampled every 5 ms. A worker busy in one long synchronous stretch cannot answer, so a peak inside it can be missed
 * (the longest gap between samples is recorded). These browser numbers are therefore LOWER BOUNDS, supporting evidence
 * only: the figure the caps are decided on is the OS peak resident set of a fresh Node process converting the same PDF
 * (`npm run m6:peak-rss`, scripts/m6-peak-rss.mjs, `process.resourceUsage().maxRSS`). This spec writes the PDFs to out/m6/
 * (git-ignored) and the list of them to out/m6/cases.json for that script. The cap-sized allocations happen in long
 * synchronous stretches (`longestGapMs` says how long the sampler was blind).
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const ATLAS = `${repo}out/atlas/atlas_std.pdf`;
const OUT = `${repo}out/m6/`;
const MiB = 1024 * 1024;
const PEAK_LIMIT_MB = 1024;
const SAMPLE_EVERY_MS = 5;

const GS = '/ExtGState << /GS << /BM /Multiply >> >>';
const CUBICS = Number(process.env.M6_CUBICS ?? 480);
const STROKES = Number(process.env.M6_STROKES ?? 8);
const TRIANGLES = Number(process.env.M6_TRIANGLES ?? 7);

/** A filled or stroked path of `n` cubics whose handles reach about +-30,000 pt (M5's `hostile`): ~1,000 flattened points each. */
function cubics(n: number, paint: 'fill' | 'stroke'): string {
  let path = '10 10 m ';
  for (let i = 0; i < n; i++) path += `30000 -30000 -30000 30000 ${10 + (i % 100)} ${10 + (i % 50)} c `;
  return `/GS gs 1 0.8 0.2 ${paint === 'fill' ? 'rg' : 'RG 3 w 1 j'} ${path} ${paint === 'fill' ? 'h f' : 'S'}`;
}

/** A Type 4 mesh (8-bit) of `triangles` triangles, each with a box that is the whole 960 x 540 pt page. */
function meshPdf(triangles: number): Uint8Array {
  const vertex = (x: number, y: number, rgb: string): string => `00${x.toString(16).padStart(2, '0')}${y.toString(16).padStart(2, '0')}${rgb}`;
  const one = vertex(0, 0, 'ff0000') + vertex(255, 0, '00ff00') + vertex(0, 255, '0000ff');
  const objects: MiniObject[] = [
    {
      num: 30,
      dict: '/ShadingType 4 /ColorSpace /DeviceRGB /BitsPerCoordinate 8 /BitsPerComponent 8 /BitsPerFlag 8 /Decode [0 960 0 540 0 1 0 1 0 1] /Filter /ASCIIHexDecode',
      data: `${one.repeat(triangles)}>`,
    },
  ];
  return sizedPdf([{ size: [960, 540], content: '/Sh1 sh' }], { resources: '/Shading << /Sh1 30 0 R >>', objects });
}

interface Case {
  name: string;
  pdf: () => Uint8Array;
  pages: number[];
  /** What the case must have drawn (so it is at the cap and not under it or far past it), checked on Node's report. */
  check: (report: Report) => void;
}

const drawn = (report: Report, slide = 0): number => report.slides[slide]!.counts.fallbacks;
const notes = (report: Report, slide = 0): string[] => report.slides[slide]!.notes.map((n) => n.detail);
const drawnOnce = (r: Report): void => {
  expect(drawn(r)).toBe(1);
  expect(notes(r)).not.toContain('raster past its geometry budget');
  expect(notes(r)).not.toContain('mesh too complex for a raster');
};

const CASES: Case[] = [
  {
    name: 'fill: hostile cubics at the raster point cap',
    pdf: () => sizedPdf([{ size: [300, 200], content: cubics(CUBICS, 'fill') }], { resources: GS }),
    pages: [],
    check: drawnOnce,
  },
  {
    name: 'stroke: hostile cubics at the raster point cap',
    pdf: () => sizedPdf([{ size: [300, 200], content: cubics(STROKES, 'stroke') }], { resources: GS }),
    pages: [],
    check: drawnOnce,
  },
  {
    name: 'mesh: triangles whose boxes are the page, at the mesh work cap',
    pdf: () => meshPdf(TRIANGLES),
    pages: [],
    check: drawnOnce,
  },
  {
    name: 'slide: full-page Multiply rasters of a 2000 pt page, to the slide pixel cap',
    pdf: () => sizedPdf([{ size: [2000, 2000], content: `/GS gs ${'1 0.8 0.2 rg 0 0 2000 2000 re f '.repeat(5)}` }], { resources: GS }),
    pages: [],
    check: (r) => expect(drawn(r)).toBeGreaterThanOrEqual(3),
  },
  {
    name: 'hostile slides in a deck: 100 pages of the fill case',
    pdf: () => sizedPdf(Array.from({ length: 100 }, () => ({ size: [300, 200] as [number, number], content: cubics(CUBICS, 'fill') })), { resources: GS }),
    pages: [],
    check: (r) => expect(drawn(r, 99)).toBe(1),
  },
  {
    name: 'atlas_std.pdf, pages 1 to 100',
    pdf: () => new Uint8Array(readFileSync(ATLAS)),
    pages: Array.from({ length: 100 }, (_, i) => i),
    check: (r) => expect(r.slides).toHaveLength(100),
  },
];

// --- the worker's heap through the DevTools Protocol (as m0-perf.spec.ts) -----------------------------------------------

interface WorkerChannel {
  send: <T>(method: string, params?: object) => Promise<T>;
  close: () => Promise<void>;
}

async function attachToWorker(page: Page): Promise<WorkerChannel> {
  const cdp: CDPSession = await page.context().newCDPSession(page);
  const attached = new Promise<string>((resolve) => {
    cdp.on('Target.attachedToTarget', (event) => {
      if (event.targetInfo.type === 'worker') resolve(event.sessionId);
    });
  });
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false });
  const sessionId = await attached;
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
  backingStorageSize: number;
}

test.describe('M6 web budgets: peak worker memory in Chromium', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'memory is measured through the DevTools Protocol, in Chromium');
  test.skip(() => !!process.env.CI, 'local only');

  const record: Record<string, unknown> = {};

  for (const c of CASES) {
    test(c.name, async ({ browser }) => {
      test.setTimeout(360_000);
      test.skip(c.name.startsWith('atlas') && !existsSync(ATLAS), 'out/atlas/atlas_std.pdf is local only');
      const bytes = c.pdf();
      const path = `${OUT}${createHash('sha256').update(c.name).digest('hex').slice(0, 8)}.pdf`;
      mkdirSync(OUT, { recursive: true });
      writeFileSync(path, bytes);

      // Node: the report that says the case is at its cap, and the bytes the worker must also make
      const node = await convert(bytes, { pages: c.pages });
      c.check(node.report);

      const context = await browser.newContext();
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const search = `?request=convert${c.pages.length > 0 ? `&pages=${c.pages.join(',')}` : ''}`;
      await page.goto(testPage(search));
      await page.waitForLoadState('networkidle');
      const worker = await attachToWorker(page);
      const samples: { at: number; used: number; backing: number; total: number }[] = [];
      let running = true;
      const sampler = (async () => {
        while (running) {
          try {
            const u = await worker.send<HeapUsage>('Runtime.getHeapUsage');
            samples.push({ at: Date.now(), used: u.usedSize, backing: u.backingStorageSize, total: u.totalSize });
          } catch {
            return;
          }
          await new Promise((r) => setTimeout(r, SAMPLE_EVERY_MS));
        }
      })();
      const idle = (await worker.send<HeapUsage>('Runtime.getHeapUsage')).usedSize;
      const started = Date.now();
      await page.locator('#file').setInputFiles(path);
      await expect(page.locator('#result')).not.toBeEmpty({ timeout: 280_000 });
      const reply = JSON.parse((await page.locator('#result').textContent()) ?? '') as { type: string; pptxHash?: string };
      const ms = Date.now() - started;
      running = false;
      await Promise.race([sampler, new Promise((r) => setTimeout(r, 2_000))]);
      await worker.close().catch(() => undefined);
      await context.close();

      expect(errors).toEqual([]);
      expect(reply.type).toBe('convert');
      expect(reply.pptxHash).toBe(createHash('sha256').update(node.pptx).digest('hex'));

      const peakMB = Math.max(...samples.map((s) => (s.used + s.backing) / MiB));
      const peakTotalMB = Math.max(...samples.map((s) => (s.total + s.backing) / MiB));
      const gaps = samples.slice(1).map((s, i) => s.at - samples[i]!.at);
      const round = (n: number): number => Math.round(n * 10) / 10;
      record[c.name] = {
        pdfMB: round(bytes.length / MiB),
        slides: node.report.slides.length,
        ms,
        samples: samples.length,
        longestGapMs: Math.max(0, ...gaps),
        idleUsedMB: round(idle / MiB),
        peakUsedPlusBuffersMB: round(peakMB),
        peakTotalPlusBuffersMB: round(peakTotalMB),
        file: path.slice(OUT.length),
        pages: c.pages.length === 0 ? null : c.pages.length,
      };
      writeFileSync(`${OUT}memory.json`, JSON.stringify(record, null, 2));
      expect(Math.max(0, ...gaps), 'the sampler was not blind for the whole conversion').toBeLessThan(ms);
      console.log(c.name, JSON.stringify(record[c.name]));
      expect(peakMB, 'the peak worker memory of a web conversion').toBeLessThan(PEAK_LIMIT_MB);
    });
  }
});
