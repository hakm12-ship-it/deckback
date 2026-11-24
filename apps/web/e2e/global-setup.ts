import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryOfDocument } from '@deckback/core';
import { buildPdf } from '../../../packages/core/test/helpers/minipdf';
import { sizedPdf } from '../../../packages/core/test/helpers/pptx';
import { syntheticPdf } from '../../../packages/core/test/helpers/synthetic';
import { serveDist } from './pages-server';
import { BEACON_DIST_DIR, BEACON_PORT, DIST_DIR, E2E_DIST_DIR, EXTERNAL_SERVER, FAKE_BEACON_TOKEN, PORT, TEST_PORT, WEB_DIR } from './servers';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const OUT_DIR = `${repo}out/m0/`;
/** The built command-line tool (M6 Task 4 compares the website's bytes with its). */
export const CLI = `${repo}packages/cli/dist/deckback.mjs`;

/** The local-only fixture (gitignored). */
export const ORIGINAL_PDF = `${repo}corpus/private/probe/original.pdf`;
/** The committed public probe (corpus/generated), compared instead where ORIGINAL_PDF is missing (CI). */
export const PROBE_STD_PDF = `${repo}corpus/generated/probe_std.pdf`;
/** Node's inventory of the spike M0-1 PDF (`m01Fixture`), from the same core functions the browser worker runs. */
export const NODE_INVENTORY = `${OUT_DIR}node-inventory.json`;

/**
 * The PDF spike M0-1 converts in the browser and in Node: the local-only original.pdf when it is present, else the
 * committed probe_std.pdf, so the comparison also runs where there are no private fixtures (CI). `label` names it in
 * the setup output and the evidence (`m0-1-<project>.json`): the private probe by a label only, never by its path.
 */
export function m01Fixture(exists: (path: string) => boolean = existsSync): { pdf: string; label: string } {
  return exists(ORIGINAL_PDF)
    ? { pdf: ORIGINAL_PDF, label: 'private probe' }
    : { pdf: PROBE_STD_PDF, label: 'public probe (corpus/generated/probe_std.pdf)' };
}

/** A generated one-page PDF whose text needs a predefined Korean CMap (`KSCms-UHC-H`), and Node's inventory of it. */
export const CMAP_PROBE_PDF = `${OUT_DIR}cmap-probe.pdf`;
export const CMAP_PROBE_INVENTORY = `${OUT_DIR}cmap-probe-node-inventory.json`;

/**
 * Review Focus 4 (M2 Task 11): a generated one-page PDF with what the committed corpus pages it is compared on lack, for
 * the Scene worker to make as Node does (scene-worker.spec.ts): two links (a URI and one to the page itself), a soft mask,
 * transparency groups (one with text, an alpha and a blend mode, an isolated knockout group in it), radial gradients (`sh`
 * and a pattern fill), an image with a soft mask, and text. Its objects are those of packages/core/test/helpers/synthetic.ts.
 */
export const SCENE_PROBE_PDF = `${OUT_DIR}scene-probe.pdf`;

function sceneProbe(): Uint8Array {
  const links =
    '/Annots [<< /Type /Annot /Subtype /Link /Rect [20 20 120 40] /Border [0 0 0] /A << /S /URI /URI (https://example.com/deckback) >> >> ' +
    '<< /Type /Annot /Subtype /Link /Rect [140 20 240 40] /Border [0 0 0] /Dest [3 0 R /Fit] >>]';
  const content = [
    'q 20 160 120 120 re W n /Sh2 sh Q', // a radial gradient, clipped
    '/Pattern cs /P5 scn 160 160 120 120 re f', // a path filled with a radial gradient
    'q /GS2 gs 0 0 1 rg 20 60 120 80 re f Q', // a soft mask
    'q /GS10 gs /Fm8 Do Q', // a transparency group with text, alpha 0.8 and screen, and a nested isolated knockout group
    'q 40 0 0 30 200 80 cm /Im5 Do Q', // an image with a larger soft mask
    'BT /F1 12 Tf 20 290 Td (ABC) Tj ET',
  ].join(' ');
  return syntheticPdf(content, `/MediaBox [0 0 300 300] ${links}`);
}

/**
 * Review Focus 4 (M3 Task 9): a generated three-page PDF with what the Scene cases lack for the PPTX, for the converting
 * worker to write as Node does (convert-worker.spec.ts): text at angles off a quarter turn (30, 45, 200 and 333.3
 * degrees), whose boxes are placed with a cosine and sine rounded to EMU; linear gradients across the axes (an `sh`
 * turned 30 degrees, one turned 45 degrees and scaled); pages of three sizes (960 x 540, A4 portrait, and 5000 x 3000,
 * past PowerPoint's range), so the slide size, the scales and the centring are computed in the browser too; and a link
 * to another page, which `pages` moves to another slide. Its objects are those of packages/core/test/helpers/pptx.ts.
 */
export const CONVERT_PROBE_PDF = `${OUT_DIR}convert-probe.pdf`;

function convertProbe(): Uint8Array {
  const turned = (deg: number, x: number, y: number) => {
    const [c, s] = [Math.cos((deg * Math.PI) / 180).toFixed(6), Math.sin((deg * Math.PI) / 180).toFixed(6)];
    return `${c} ${s} ${(-Number(s)).toFixed(6)} ${c} ${x} ${y}`;
  };
  const text = (deg: number, x: number, y: number, size: number, s: string) => `BT ${turned(deg, x, y)} Tm /F1 ${size} Tf (${s}) Tj ET`;
  const shading =
    '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Extend [true true] ' +
    '/Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>';
  const link = '/Annots [<< /Type /Annot /Subtype /Link /Rect [20 20 120 60] /Border [0 0 0] /Dest [104 0 R /Fit] >>]';
  return sizedPdf(
    [
      {
        size: [960, 540],
        content: [
          `q 100 100 300 200 re W n ${turned(30, 250, 200)} cm /Sh1 sh Q`,
          text(30, 500, 300, 24, 'ABC'),
          text(45, 600, 100, 18, 'CAB'),
          text(200, 900, 500, 12, 'BCA'),
          text(333.3, 450, 450, 30, 'AB'),
        ].join(' '),
        page: link,
      },
      { size: [595, 842], content: `0 0 1 rg 50 50 200 300 re f ${text(30, 100, 600, 18, 'CAB')}` },
      {
        size: [5000, 3000],
        content: `q 1000 500 3000 2000 re W n 20 0 0 20 1000 500 cm ${turned(45, 0, 0)} cm /Sh1 sh Q ${text(30, 500, 2500, 200, 'ABC')}`,
      },
    ],
    { resources: '/Shading << /Sh1 11 0 R >>', objects: [{ num: 11, body: shading }] },
  );
}

/**
 * M5 Task 3: a generated one-page PDF with the gradients DrawingML now says exactly, for the converting worker to write as
 * Node does: a linear gradient under a luminosity soft mask that is a grey gradient of the same axis (per-stop alpha);
 * text in clip mode (Tr 7) painted by that gradient (the run's gradFill); and a radial gradient whose centre is off its
 * clip's centre (a circle path with a tile rect).
 */
export const GRADIENT_PROBE_PDF = `${OUT_DIR}gradient-probe.pdf`;

function gradientProbe(): Uint8Array {
  const axial = (c0: string, c1: string) =>
    `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [100 0 300 0] /Extend [true true] /Function << /FunctionType 2 /Domain [0 1] /C0 [${c0}] /C1 [${c1}] /N 1 >> >>`;
  const radial =
    '<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [640 130 0 640 130 90] /Extend [true true] ' +
    '/Function << /FunctionType 2 /Domain [0 1] /C0 [1 1 1] /C1 [0 0 1] /N 1 >> >>';
  const mask = '/Type /XObject /Subtype /Form /BBox [0 0 960 540] /Group << /S /Transparency /CS /DeviceRGB >> /Resources << /Shading << /Sh2 21 0 R >> >>';
  return sizedPdf(
    [
      {
        size: [960, 540],
        content: [
          'q /GS1 gs 100 100 200 100 re W n /Sh1 sh Q',
          'q BT 7 Tr /F1 40 Tf 100 300 Td (ABC) Tj ET /Sh1 sh Q',
          'q 600 100 200 100 re W n /Sh3 sh Q',
        ].join(' '),
      },
    ],
    {
      resources: '/Shading << /Sh1 20 0 R /Sh3 22 0 R >> /ExtGState << /GS1 << /SMask << /S /Luminosity /G 23 0 R >> >> >>',
      objects: [
        { num: 20, body: axial('1 0 0', '0 0 1') },
        { num: 21, body: axial('1 1 1', '0 0 0') },
        { num: 22, body: radial },
        { num: 23, dict: mask, data: '100 100 200 100 re W n /Sh2 sh' },
      ],
    },
  );
}

/** Spike M0-7: the 51-slide PDF (made by harness/spikes/m0_7_make_deck.ps1, local only) and the measurement of it. */
export const DECK51_PDF = `${OUT_DIR}deck51.pdf`;
export const PERF_JSON = `${OUT_DIR}perf.json`;

/** Two KS X 1001 codes, B0A1 B0A2 = 가각, shown with a non-embedded CID font that needs the CMap. */
function cmapProbe(): Uint8Array {
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    {
      num: 3,
      body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    },
    { num: 4, data: 'BT /F1 12 Tf 10 50 Td <B0A1B0A2> Tj ET' },
    {
      num: 5,
      body: '<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /KSCms-UHC-H /DescendantFonts [6 0 R] >>',
    },
    {
      num: 6,
      body:
        '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium ' +
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor 7 0 R >>',
    },
    {
      num: 7,
      body:
        '<< /Type /FontDescriptor /FontName /HYSMyeongJo-Medium /Flags 6 /FontBBox [0 -200 1000 900] ' +
        '/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
    },
  ]);
}

async function writeInventory(pdf: Uint8Array, file: string): Promise<void> {
  const { inventory } = await inventoryOfDocument(pdf, []);
  writeFileSync(file, `${JSON.stringify(inventory)}\n`);
}

/**
 * Writes the Node inventories the browser results are compared with. First deletes everything an earlier run wrote,
 * including the per-engine evidence (`m0-1-<project>.json`, `scene-worker-<project>.json`, `convert-worker-<project>.json`)
 * and `perf.json`, so no file can outlive the run that wrote it. (deck51.pdf is an input, not a result: it is kept.)
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  mkdirSync(OUT_DIR, { recursive: true });
  const evidence = readdirSync(OUT_DIR).filter((name) => /^(?:m0-1|scene-worker|convert-worker)-.+\.json$/.test(name));
  const stale = [NODE_INVENTORY, CMAP_PROBE_PDF, CMAP_PROBE_INVENTORY, SCENE_PROBE_PDF, CONVERT_PROBE_PDF, GRADIENT_PROBE_PDF, PERF_JSON, ...evidence.map((name) => `${OUT_DIR}${name}`)];
  for (const file of stale) {
    rmSync(file, { force: true });
  }

  const probe = cmapProbe();
  writeFileSync(CMAP_PROBE_PDF, probe);
  await writeInventory(probe, CMAP_PROBE_INVENTORY);

  writeFileSync(SCENE_PROBE_PDF, sceneProbe());
  writeFileSync(CONVERT_PROBE_PDF, convertProbe());
  writeFileSync(GRADIENT_PROBE_PDF, gradientProbe());

  const { pdf, label } = m01Fixture();
  console.log(`spike M0-1 compares the ${label}`);
  await writeInventory(new Uint8Array(readFileSync(pdf)), NODE_INVENTORY);

  return await startSite();
}

/**
 * `vite build` of this app into `outDir`, with the beacon token `token` if given (and none otherwise, whatever the environment
 * has), and with the e2e's test page (test.html) only if `testPage`: the other builds are what is shipped.
 */
function build(outDir: string, token?: string, testPage = false): void {
  const vite = `${dirname(createRequire(import.meta.url).resolve('vite/package.json'))}/bin/vite.js`;
  const env: NodeJS.ProcessEnv = { ...process.env, VITE_CF_BEACON_TOKEN: token ?? '', VITE_E2E: testPage ? '1' : '' };
  execFileSync(process.execPath, [vite, 'build', '--outDir', outDir, '--emptyOutDir'], { cwd: WEB_DIR, env, stdio: 'pipe' });
}

/** `vite build` of the command-line tool, afresh, so cli-bytes.spec.ts compares with this commit's. */
function buildCli(): void {
  const vite = `${dirname(createRequire(import.meta.url).resolve('vite/package.json'))}/bin/vite.js`;
  execFileSync(process.execPath, [vite, 'build', '--config', 'packages/cli/vite.config.ts'], { cwd: repo, stdio: 'pipe' });
}

/**
 * Builds the site afresh, three times (as shipped; with a fake beacon token; and with the e2e's test page), and serves them as
 * Cloudflare Pages would. Returns what stops them. With E2E_BASE_URL set the site is somebody else's (`wrangler pages dev`):
 * the first two are not built here; the test page's build always is, unless E2E_TEST_URL says it is served elsewhere.
 */
async function startSite(): Promise<() => Promise<void>> {
  const servers: Server[] = [];
  buildCli();
  if (!EXTERNAL_SERVER) {
    build(DIST_DIR);
    build(BEACON_DIST_DIR, FAKE_BEACON_TOKEN);
    servers.push(await serveDist(DIST_DIR, PORT), await serveDist(BEACON_DIST_DIR, BEACON_PORT));
  }
  if (process.env.E2E_TEST_URL === undefined) {
    build(E2E_DIST_DIR, undefined, true);
    servers.push(await serveDist(E2E_DIST_DIR, TEST_PORT));
  }
  return async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => (server.closeAllConnections(), server.close(() => resolve())))));
  };
}
