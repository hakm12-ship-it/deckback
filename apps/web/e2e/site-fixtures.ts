import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JPX_SAMPLE_BASE64 } from './jpx-sample';
import { buildPdf, type MiniObject } from '../../../packages/core/test/helpers/minipdf';
import { sizedPdf } from '../../../packages/core/test/helpers/pptx';

/**
 * M6 Task 2: the files the website's e2e (site.spec.ts) drops on the page, made here at setup (global-setup.ts writes them
 * to out/m0/, git-ignored), so no binary is committed and CI needs no Python. test/site-fixtures.test.ts checks in Node
 * that each is what its name says.
 *
 * Review Focus 2: a PDF with an open password, one encrypted with permissions only (it opens with no password), a file
 * that is not a PDF, and a truncated PDF. Review Focus 1: a slow deck to cancel. Spec §3: a deck with an image-only page.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
export const PROBE_STD_PDF = `${repo}corpus/generated/probe_std.pdf`;

// --- the standard security handler, revision 2 (40-bit RC4): PDF 1.7, 7.6.3 ---------------------------------------------

const PAD = new Uint8Array([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68,
  0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = Uint8Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  let i = 0;
  j = 0;
  for (let k = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]!) & 255;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 255]!;
  }
  return out;
}

const md5 = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(createHash('md5').update(Buffer.concat(parts)).digest());

/** A password padded to 32 bytes with the standard padding (Algorithm 2, step a). */
function padded(password: string): Uint8Array {
  const bytes = new TextEncoder().encode(password).subarray(0, 32);
  const out = new Uint8Array(32);
  out.set(bytes);
  out.set(PAD.subarray(0, 32 - bytes.length), bytes.length);
  return out;
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex').toUpperCase();

/** Permissions: nothing allowed (print, modify, copy, annotate all off), as a permissions-locked PDF says. */
const PERMISSIONS = -64;

/**
 * A one-page PDF (a blue rectangle and a line of text) encrypted with the standard security handler, revision 2: owner
 * password `deckback-owner` and user password `user` (test passwords, not secrets). With an empty user password anyone
 * may open it (permissions only); with one, it needs that password to open.
 */
export function encryptedPdf(user: string): Uint8Array {
  const id = md5(new TextEncoder().encode(`deckback fixture ${user}`));
  const o = rc4(md5(padded('deckback-owner')).subarray(0, 5), padded(user));
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, PERMISSIONS, true);
  const key = md5(padded(user), o, p, id).subarray(0, 5);
  const u = rc4(key, PAD);
  const objectKey = (num: number): Uint8Array => md5(key, new Uint8Array([num & 255, (num >> 8) & 255, (num >> 16) & 255, 0, 0])).subarray(0, 10);
  const content = new TextEncoder().encode('0 0 1 rg 40 40 200 100 re f BT /F1 24 Tf 40 160 Td (Locked) Tj ET');
  const objects: MiniObject[] = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>' },
    { num: 4, data: rc4(objectKey(4), content) },
    { num: 5, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' },
    { num: 6, body: `<< /Filter /Standard /V 1 /R 2 /O <${hex(o)}> /U <${hex(u)}> /P ${PERMISSIONS} >>` },
  ];
  return buildPdf(objects, { trailer: `/Encrypt 6 0 R /ID [<${hex(id)}> <${hex(id)}>]` });
}

/** Review Focus 2: needs a password to open. */
export const passwordPdf = (): Uint8Array => encryptedPdf('deckback-user');
/** Review Focus 2: encrypted with permissions only: it opens, converts, and the report says it was encrypted (§8). */
export const permissionsOnlyPdf = (): Uint8Array => encryptedPdf('');

/** Review Focus 2: a file named .pdf that is not one (plain text). */
export const notPdf = (): Uint8Array => new TextEncoder().encode('These are meeting notes, not a PDF.\n'.repeat(20));

/** Review Focus 2: the committed probe cut in half: it starts as a PDF, and pdf.js cannot read it. */
export function truncatedPdf(): Uint8Array {
  const full = new Uint8Array(readFileSync(PROBE_STD_PDF));
  return full.slice(0, Math.floor(full.length / 2));
}

/**
 * Review Focus 1: a deck slow enough to cancel in the middle in every engine: `SLOW_PAGES` pages, each a Multiply-blended
 * fill of 200 cubics whose handles reach far off the page, which the raster renderer draws (about 140 ms a page in
 * Node). Small (about 7 KB a page) and far below the memory caps (m6-memory.spec.ts measures those).
 */
export const SLOW_PAGES = 150;

export function slowPdf(): Uint8Array {
  let path = '10 10 m ';
  for (let i = 0; i < 200; i++) path += `30000 -30000 -30000 30000 ${10 + (i % 100)} ${10 + (i % 50)} c `;
  const page = { size: [300, 200] as [number, number], content: `/GS gs 1 0.8 0.2 rg ${path} h f` };
  return sizedPdf(Array.from({ length: SLOW_PAGES }, () => page), { resources: '/ExtGState << /GS << /BM /Multiply >> >>' });
}

/** Spec §3: page 1 is one picture over the whole page (an image-only page); page 2 is text. */
export function imageOnlyPdf(): Uint8Array {
  const pixels = new Uint8Array([200, 60, 60, 60, 200, 60, 60, 60, 200, 230, 230, 230]);
  return sizedPdf(
    [
      { size: [300, 200], content: 'q 300 0 0 200 0 0 cm /Im1 Do Q' },
      { size: [300, 200], content: 'BT /F1 24 Tf 20 100 Td (ABC) Tj ET' },
    ],
    {
      resources: '/XObject << /Im1 20 0 R >>',
      objects: [{ num: 20, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: pixels }],
    },
  );
}

/**
 * M6 Task 3 (Review Focus 4): a two-page deck whose every private part is a distinctive string the privacy test looks for in
 * each request: slide text (page 1, a font that is not embedded, named `SecretCorpSans`) and a Korean text on page 2 shown
 * with a CID font that needs a predefined CMap (`KSCms-UHC-H`, which pdf.js fetches from the site, so a request is made
 * while converting). The file is dropped as `PRIVACY_FILE_NAME`.
 */
export const PRIVACY_FILE_NAME = '홍길동_발표자료.pdf';
export const PRIVACY_TEXT = ['Confidential Quarterly Zebra 4711', 'Zebra 4711'];
export const PRIVACY_FONTS = ['SecretCorpSans', 'HYSMyeongJo'];

export function privacyPdf(): Uint8Array {
  const widths = Array.from({ length: 95 }, () => 500).join(' ');
  return sizedPdf(
    [
      { size: [400, 200], content: `BT /F2 24 Tf 20 100 Td (${PRIVACY_TEXT[0]}) Tj ET` },
      { size: [400, 200], content: 'BT /F3 24 Tf 20 100 Td <B0A1B0A2> Tj ET' },
    ],
    {
      fonts: '/F2 20 0 R /F3 31 0 R',
      objects: [
        { num: 20, body: `<< /Type /Font /Subtype /TrueType /BaseFont /SecretCorpSans-Bold /FirstChar 32 /LastChar 126 /Widths [${widths}] /Encoding /WinAnsiEncoding >>` },
        { num: 31, body: '<< /Type /Font /Subtype /Type0 /BaseFont /HYSMyeongJo-Medium /Encoding /KSCms-UHC-H /DescendantFonts [32 0 R] >>' },
        {
          num: 32,
          body:
            '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /HYSMyeongJo-Medium ' +
            '/CIDSystemInfo << /Registry (Adobe) /Ordering (Korea1) /Supplement 1 >> /FontDescriptor 33 0 R >>',
        },
        {
          num: 33,
          body:
            '<< /Type /FontDescriptor /FontName /HYSMyeongJo-Medium /Flags 6 /FontBBox [0 -200 1000 900] ' +
            '/ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 700 /StemV 80 >>',
        },
      ],
    },
  );
}

/** M6 Task 3: a deck whose picture is a JPEG 2000 (`JPXDecode`), which pdf.js decodes with WebAssembly (jpx-sample.ts). */
export function jpxPdf(): Uint8Array {
  return sizedPdf([{ size: [300, 200], content: 'q 160 0 0 160 20 20 cm /Im1 Do Q' }], {
    resources: '/XObject << /Im1 30 0 R >>',
    objects: [{ num: 30, dict: '/Type /XObject /Subtype /Image /Width 16 /Height 16 /Filter /JPXDecode', data: new Uint8Array(Buffer.from(JPX_SAMPLE_BASE64, 'base64')) }],
  });
}

/**
 * M6 Task 3 (fix round): a deck with a PostScript calculator function (a Type 4 function) under a gradient. pdf.js compiles such
 * a function to WebAssembly in the thread that parses (`new WebAssembly.Module`, its own bytes), which a Content-Security-Policy
 * without 'wasm-unsafe-eval' blocks: the e2e shows the policy lets it through, so the browser computes it as Node does.
 */
export function type4Pdf(): Uint8Array {
  const shading = '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 200 0] /Extend [true true] /Function 41 0 R >>';
  return sizedPdf([{ size: [300, 200], content: 'q 20 20 200 100 re W n /Sh1 sh Q' }], {
    resources: '/Shading << /Sh1 40 0 R >>',
    objects: [
      { num: 40, body: shading },
      { num: 41, dict: '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]', data: '{ dup 0.5 mul exch 1 exch sub 0.25 }' },
    ],
  });
}
