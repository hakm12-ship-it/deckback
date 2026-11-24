import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, releasePage } from '../../src/engine/pdfjs-adapter';
import { openRawPdf } from '../../src/engine/rawpdf';
import { pageFrame, walkPage, type RawOp } from '../../src/extract/walker';
import { buildSlide } from '../../src/scene/build';
import { FontTable } from '../../src/scene/fonts';
import { MediaStore } from '../../src/scene/media';
import { encodePng } from '../../src/scene/png';
import type { PictureEl } from '../../src/scene/types';
import { pythonPath, repoRoot } from '../helpers/fixtures';
import { buildPdf } from '../helpers/minipdf';
import { runPython } from '../helpers/oracle';
import { decodePng } from '../helpers/png';
import { syntheticPdf } from '../helpers/synthetic';

/**
 * Pictures against MuPDF (Task 10): JPEG passthrough and PNG pixels on the committed smoke deck, and the kinds it does not
 * have (a gray image, a stencil) on synthetic PDFs. Runs in CI (ruling M1-R76). Image bytes are written only to a
 * temporary directory and never printed (Global Constraints, Fonts and media).
 */

const SMOKE = `${repoRoot}corpus/generated/atlas-smoke_std.pdf`;
/** The pictures/* slides of the smoke deck (atlas-smoke.manifest.json, n 32 to 34), 1-based. */
const PICTURE_PAGES = [32, 33, 34];

const scratch = mkdtempSync(join(tmpdir(), 'deckback-media-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let written = 0;

/** The slides of `pages` (1-based), built with one media store and the raw reader beside pdf.js, as a deck is. */
async function build(bytes: Uint8Array, pages: number[]) {
  const raw = openRawPdf(bytes);
  const media = new MediaStore(raw);
  const fonts = new FontTable(raw);
  const doc = await openDocument(bytes);
  const pictures: { op: RawOp; picture: PictureEl }[] = [];
  try {
    for (const number of pages) {
      const page = await loadPage(doc, number - 1);
      try {
        const ops = walkPage(page);
        const slide = await buildSlide({ index: page.index, sizePt: pageFrame(page).size, ops }, { media, fonts, page });
        for (const op of ops.filter((o) => o.kind === 'image')) {
          const picture = slide.elements.find((e) => e.kind === 'picture' && e.provenance.opIndex[0] === op.opIndex);
          expect(picture, `page ${number} op ${op.opIndex}`).toBeDefined();
          pictures.push({ op, picture: picture as PictureEl });
        }
      } finally {
        await releasePage(page);
      }
    }
  } finally {
    await closeDocument(doc);
  }
  return { media, pictures };
}

/**
 * `python -m harness.oracle.image_pixels`: the largest channel difference between a PNG and MuPDF's pixels of the image
 * `xref` of `pdf`, its soft mask applied (for a stencil, the alpha against the mask).
 */
function mupdfDifference(pdf: string, xref: number, png: Uint8Array): number {
  const file = join(scratch, `image-${written++}.png`);
  writeFileSync(file, png);
  const out = execFileSync(pythonPath(), ['-m', 'harness.oracle.image_pixels', pdf, String(xref), file], { cwd: repoRoot, encoding: 'utf8' });
  expect(out.trim()).toMatch(/^\d+$/);
  return Number(out.trim());
}

function writePdf(bytes: Uint8Array): string {
  const file = join(scratch, `synthetic-${written++}.pdf`);
  writeFileSync(file, bytes);
  return file;
}

interface ImageFacts {
  filter: string;
  colorSpace: string;
  smask: boolean;
  mask: boolean;
  decode: boolean;
  sha256: string;
  length: number;
}

/** What PyMuPDF says of every image XObject of `pages` (1-based), by object number; the hash is of the raw stream. */
function imageFacts(pdf: string, pages: number[]): Record<string, ImageFacts> {
  const code = [
    'import hashlib, json, sys, pymupdf',
    'doc = pymupdf.open(sys.argv[1])',
    'out = {}',
    'for n in map(int, sys.argv[2:]):',
    '    for img in doc[n - 1].get_images(full=True):',
    '        x = img[0]',
    '        has = lambda k: doc.xref_get_key(x, k)[0] != "null"',
    '        raw = doc.xref_stream_raw(x)',
    '        out[str(x)] = {"filter": doc.xref_get_key(x, "Filter")[1], "colorSpace": doc.xref_get_key(x, "ColorSpace")[1],',
    '            "smask": has("SMask"), "mask": has("Mask"), "decode": has("Decode"),',
    '            "sha256": hashlib.sha256(raw).hexdigest(), "length": len(raw)}',
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(runPython(['-I', '-c', code, pdf, ...pages.map(String)])) as Record<string, ImageFacts>;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe('pictures of atlas-smoke_std.pdf (pictures/* pages)', () => {
  const bytes = new Uint8Array(readFileSync(SMOKE));

  it('a JPEG with no mask is passthrough, and its hash is the SHA-256 of the raw stream', async () => {
    const { media, pictures } = await build(bytes, PICTURE_PAGES);
    const facts = imageFacts(SMOKE, PICTURE_PAGES);
    const infos = media.infos();
    const passed = new Set<number>();
    const encoded = new Set<number>();
    for (const { op, picture } of pictures) {
      const xref = op.imageRef?.num;
      expect(xref, `op ${op.opIndex}`).toBeDefined();
      const f = facts[String(xref)]!;
      const info = infos[picture.mediaHash]!;
      const plain = f.filter === '/DCTDecode' && ['/DeviceRGB', '/DeviceGray'].includes(f.colorSpace) && !f.smask && !f.mask && !f.decode;
      if (plain) {
        passed.add(xref!);
        expect(info, `xref ${xref}`).toEqual({ hash: f.sha256, mime: 'image/jpeg', widthPx: op.px![0], heightPx: op.px![1], byteLength: f.length, passthrough: true });
        expect(sha256(media.files().get(info.hash)!)).toBe(f.sha256);
      } else {
        encoded.add(xref!);
        expect(info, `xref ${xref}`).toMatchObject({ mime: 'image/png', passthrough: false });
        expect(decodePng(media.files().get(info.hash)!).width).toBe(info.widthPx);
      }
    }
    // The pages hold both kinds: JPEGs (one of them on all three pages) and Flate images with and without a soft mask.
    expect(passed.size).toBeGreaterThanOrEqual(5);
    expect(encoded.size).toBeGreaterThanOrEqual(2);
    // One media entry per distinct image: a JPEG painted on three pages is stored once.
    expect(Object.keys(infos)).toHaveLength(passed.size + encoded.size);
  });

  it('a PNG with an SMask decodes within ±1 of MuPDF', async () => {
    const { media, pictures } = await build(bytes, PICTURE_PAGES);
    const facts = imageFacts(SMOKE, PICTURE_PAGES);
    const masked = pictures.filter(({ op }) => facts[String(op.imageRef?.num)]?.smask === true);
    expect(masked.length).toBeGreaterThan(0);
    for (const { op, picture } of masked) {
      const png = media.files().get(picture.mediaHash)!;
      expect(decodePng(png).channels).toBe(4);
      expect(mupdfDifference(SMOKE, op.imageRef!.num, png)).toBeLessThanOrEqual(1);

      // The comparison sees a wrong pixel: one opaque pixel turned to its complement is far from MuPDF.
      const decoded = decodePng(png);
      const i = decoded.data.findIndex((v, k) => k % 4 === 3 && v === 255) - 3;
      for (let c = 0; c < 3; c++) decoded.data[i + c] = 255 - decoded.data[i + c]!;
      const wrong = encodePng(decoded.data, decoded.width, decoded.height, 4);
      expect(mupdfDifference(SMOKE, op.imageRef!.num, wrong)).toBeGreaterThan(1);
    }
  });
});

describe('pictures the smoke deck does not have (synthetic)', () => {
  it('a gray image', async () => {
    // /Im1 of the synthetic page (object 14) is 2 x 2 gray at 8 bits: pdf.js decodes it to RGB.
    const synthetic = syntheticPdf('q 40 0 0 40 10 10 cm /Im1 Do Q');
    // 1 bit a pixel, as is and inverted by /Decode: pdf.js gives these as GRAYSCALE_1BPP, a gray PNG.
    const oneBit = buildPdf([
      { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
      { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
      { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /G1 5 0 R /G2 6 0 R >> >> >>' },
      { num: 4, data: 'q 100 0 0 30 10 10 cm /G1 Do Q q 100 0 0 30 10 100 cm /G2 Do Q' },
      { num: 5, dict: '/Type /XObject /Subtype /Image /Width 10 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 1', data: Uint8Array.of(0b10110011, 0b01000000, 0xff, 0xc0, 0x0f, 0x00) },
      {
        num: 6,
        dict: '/Type /XObject /Subtype /Image /Width 10 /Height 3 /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0]',
        data: Uint8Array.of(0b10110011, 0b01000000, 0xff, 0xc0, 0x0f, 0x00),
      },
    ]);
    for (const [pdf, channels, xrefs] of [
      [synthetic, 3, [14]],
      [oneBit, 1, [5, 6]],
    ] as const) {
      const file = writePdf(pdf);
      const { media, pictures } = await build(pdf, [1]);
      expect(pictures.map(({ op }) => op.imageRef?.num)).toEqual(xrefs);
      for (const { op, picture } of pictures) {
        const png = media.files().get(picture.mediaHash)!;
        expect(decodePng(png).channels).toBe(channels);
        expect(mupdfDifference(file, op.imageRef!.num, png)).toBe(0);
      }
    }
  });

  it('a stencil', async () => {
    // /Im3 of the synthetic page (object 59) is an 8 x 8 image mask; MuPDF's pixmap of it is its coverage.
    const pdf = syntheticPdf('0.2 0.4 0.6 rg q 80 0 0 80 10 10 cm /Im3 Do Q');
    const file = writePdf(pdf);
    const { media, pictures } = await build(pdf, [1]);
    expect(pictures).toHaveLength(1);
    const picture = pictures[0]!.picture;
    expect(picture.stencil).toEqual([51, 102, 153]);
    const png = media.files().get(picture.mediaHash)!;
    const decoded = decodePng(png);
    expect(decoded.channels).toBe(4);
    for (let i = 0; i < decoded.data.length; i += 4) expect(Array.from(decoded.data.subarray(i, i + 3))).toEqual([51, 102, 153]);
    expect(mupdfDifference(file, 59, png)).toBe(0);
  });
});
