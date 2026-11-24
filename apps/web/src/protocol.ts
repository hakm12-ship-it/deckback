import type { Inventory, Report } from '@deckback/core';

/**
 * main → worker. `bytes` is transferred. `pages` are 0-based page indexes, walked in that order; an empty list
 * means every page.
 */
export interface InventoryRequest {
  type: 'inventory';
  bytes: ArrayBuffer;
  pages: number[];
}
/** main → worker: the Scene of `pages` (`extractScene`); `bytes` and `pages` as for an inventory. */
export interface SceneRequest {
  type: 'scene';
  bytes: ArrayBuffer;
  pages: number[];
}
/** main → worker: the PPTX and report of `pages` (`convert`); `bytes` and `pages` as for an inventory. */
export interface ConvertRequest {
  type: 'convert';
  bytes: ArrayBuffer;
  pages: number[];
}
/**
 * main → worker, the website's own request (M6): the PPTX and report of every page, for the page to offer and show.
 * `bytes` is transferred. `fontMap` is `ConvertOptions.fontMap`, given to `convert` only when it has a key (an empty
 * map changes nothing anyway). The worker posts a `progress` message for each `onProgress` call, then the reply: `pptx`,
 * or `failed` with the kind of error (`errorKind`), never its message.
 *
 * Cancel is not a message: the page terminates the worker, which stops the work at once wherever it is (in a long
 * synchronous stretch too) and frees its memory, and it makes a fresh worker for the next file (Review Focus 1). The
 * page records that conversion as `cancelled` (app.ts, `Outcome`).
 */
export interface PptxRequest {
  type: 'pptx';
  bytes: ArrayBuffer;
  fontMap: Record<string, string>;
}
export type WorkerRequest = InventoryRequest | SceneRequest | ConvertRequest | PptxRequest;

/** Why a conversion failed, as the page says it (i18n.ts `error.*`): fixed words, never the error's own message. */
export type ErrorKind = 'password' | 'not-pdf' | 'damaged' | 'too-complex' | 'failed';

/**
 * worker → main, one reply per request, in request order. A Scene is answered with its hash (`sceneHash`) and the
 * SHA-256 of each media file, in the order the Scene first uses them: never the Scene JSON or the bytes, which stay in
 * the worker. A conversion (`convert`, the e2e's) is answered with the SHA-256 of the PPTX, its length, and the hash of
 * the report (`sceneHash`, the canonical JSON's SHA-256): never the PPTX or the report, which the test page writes into
 * itself and which may hold a private deck's text.
 *
 * The website's `pptx` request is answered with the PPTX (its buffer transferred) and the report, which stay in the page,
 * or with `failed`; before that, `progress` (not a reply: any number of them) says how many slides are written.
 */
export type WorkerReply =
  | { type: 'result'; inventory: Inventory; perPageMs: number[] }
  | { type: 'scene'; hash: string; mediaHashes: string[] }
  | { type: 'convert'; pptxHash: string; pptxBytes: number; reportHash: string }
  | { type: 'error'; message: string }
  | { type: 'progress'; done: number; total: number }
  | { type: 'pptx'; pptx: Uint8Array; report: Report }
  | { type: 'failed'; kind: ErrorKind };

const REPLY_TYPES = new Set(['result', 'scene', 'convert', 'error', 'progress', 'pptx', 'failed']);

/**
 * True for a reply of ours. pdf.js' parser, loaded in the worker, also posts its own `ready` message to the page
 * (`{ sourceName, targetName, action }`), which is not a reply.
 */
export function isWorkerReply(data: unknown): data is WorkerReply {
  const type = (data as { type?: unknown } | null)?.type;
  return typeof type === 'string' && REPLY_TYPES.has(type);
}

/**
 * The request for a chosen file, as the test page's query string asks: `?request=scene` for the Scene,
 * `?request=convert` for the PPTX (else the inventory), `?pages=0,1,7` for those pages (else every page). A page list
 * it cannot read goes to the worker as it is (NaN), which refuses it. The query is test plumbing (the e2e asks through
 * it) and carries nothing secret.
 */
export function requestFor(search: string, bytes: ArrayBuffer): InventoryRequest | SceneRequest | ConvertRequest {
  const params = new URLSearchParams(search);
  const listed = params.get('pages') ?? '';
  const pages = listed === '' ? [] : listed.split(',').map((page) => (page.trim() === '' ? Number.NaN : Number(page)));
  const asked = params.get('request');
  return { type: asked === 'scene' || asked === 'convert' ? asked : 'inventory', bytes, pages };
}

/** pdf.js' own test for a PDF: `%PDF-` within the first 1,024 bytes. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, 1024);
  for (let i = 0; i + 5 <= head.length; i++) {
    if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) return true;
  }
  return false;
}

/** pdf.js' errors for a file it cannot parse (and `SceneInputError` `not-pdf` wraps InvalidPDFException). */
const UNREADABLE = new Set(['InvalidPDFException', 'FormatError', 'UnknownErrorException', 'MissingPDFException']);

/**
 * The kind of a conversion's error (worker.ts), by the error's name and fields only (so the page needs nothing of core):
 * - `SceneInputError` `password`: the PDF needs a password to open;
 * - `SceneInputError` `not-pdf` (pdf.js' InvalidPDFException) and pdf.js' parse errors: `not-pdf` when the bytes do not
 *   start as a PDF does (`looksLikePdf`), else `damaged` (a truncated PDF, say);
 * - `SceneTooComplexError` (a budget; strict mode only, which the website does not use) and a RangeError of memory or
 *   depth (an allocation that failed, an array or the stack too long): `too-complex`;
 * - anything else: `failed`.
 */
export function errorKind(error: unknown, bytes: Uint8Array): ErrorKind {
  const { name, kind } = (typeof error === 'object' && error !== null ? error : {}) as { name?: unknown; kind?: unknown };
  if (name === 'SceneInputError' && kind === 'password') return 'password';
  if ((name === 'SceneInputError' && kind === 'not-pdf') || (typeof name === 'string' && UNREADABLE.has(name))) {
    return looksLikePdf(bytes) ? 'damaged' : 'not-pdf';
  }
  if (name === 'SceneTooComplexError') return 'too-complex';
  if (error instanceof RangeError && /allocation failed|invalid (typed )?array length|call stack/i.test(error.message)) return 'too-complex';
  return 'failed';
}

/** Where the app serves pdf.js' character maps, relative to the base URL (see vite.config.ts). */
export const CMAPS_PATH = 'pdfjs/cmaps/';
