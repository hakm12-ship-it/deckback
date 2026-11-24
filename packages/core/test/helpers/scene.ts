import { readFileSync } from 'node:fs';
import Ajv, { type ValidateFunction } from 'ajv';
import { closeDocument, loadPage, openDocument, releasePage } from '../../src/engine/pdfjs-adapter';
import { openRawPdf, type RawPdf } from '../../src/engine/rawpdf';
import { pageFrame, walkPage, type RawOp } from '../../src/extract/walker';
import { buildSlide } from '../../src/scene/build';
import { FontTable } from '../../src/scene/fonts';
import { MediaStore } from '../../src/scene/media';
import { SCENE_SCHEMA, type SceneSlide } from '../../src/scene/types';
import { buildPdf, type MiniObject } from './minipdf';

/**
 * `scene.schema.json` as the tests validate with it (ajv, strict, every error). It is plain data in src; only tests
 * validate with it, so the engine bundle has no ajv.
 */
export const SCENE_JSON_SCHEMA = JSON.parse(
  readFileSync(new URL('../../src/scene/scene.schema.json', import.meta.url), 'utf8'),
) as { $id: string };
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(SCENE_JSON_SCHEMA);
/** A whole Scene (`SceneDeck`). */
export const validateDeck = ajv.getSchema(SCENE_SCHEMA) as ValidateFunction;
/** One slide (`#/definitions/SceneSlide`). */
export const validateSlide = ajv.getSchema(`${SCENE_SCHEMA}#/definitions/SceneSlide`) as ValidateFunction;

/** The errors of a validation as `<instance path> <message>`, short enough to read in a failed expectation. */
export function schemaErrors(validate: ValidateFunction, value: unknown): string[] {
  return validate(value) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`);
}

/**
 * A PDF of 300 x 300 pt pages, one per content stream, with the same resources: objects 1 and 2 are the catalog and the
 * page tree, page n (from 0) is object 100 + 2n and its content 101 + 2n, so `objects` may use any other number.
 */
export function pagesPdf(contents: string[], resources: string, objects: MiniObject[]): Uint8Array {
  const pages = contents.map((_, n) => 100 + 2 * n);
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: `<< /Type /Pages /Kids [${pages.map((p) => `${p} 0 R`).join(' ')}] /Count ${pages.length} >>` },
    ...contents.flatMap((content, n): MiniObject[] => [
      {
        num: pages[n]!,
        body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents ${pages[n]! + 1} 0 R /Resources << ${resources} >> >>`,
      },
      { num: pages[n]! + 1, data: content },
    ]),
    ...objects,
  ]);
}

export interface BuiltDeck {
  slides: SceneSlide[];
  /** The walker's RawOps of each page. */
  ops: RawOp[][];
  /** The pdf.js operators of each page. */
  fnArrays: number[][];
  sizes: [number, number][];
  fonts: FontTable;
  media: MediaStore;
}

/**
 * Walks every page of a PDF and builds its slide while the page is loaded, with one font table and one media store for
 * the deck, as `extractScene` will. `raw: false` builds without the raw reader (ruling M2-R6: pdf.js names only).
 */
export async function buildDeck(bytes: Uint8Array, options: { raw?: boolean; pages?: number[] } = {}): Promise<BuiltDeck> {
  const raw: RawPdf | null = options.raw === false ? null : openRawPdf(bytes);
  const fonts = new FontTable(raw);
  const media = new MediaStore(raw);
  const deck: BuiltDeck = { slides: [], ops: [], fnArrays: [], sizes: [], fonts, media };
  const doc = await openDocument(bytes);
  try {
    const indexes = options.pages ?? Array.from({ length: doc.numPages }, (_, i) => i);
    for (const index of indexes) {
      const page = await loadPage(doc, index);
      try {
        const ops = walkPage(page);
        const size = pageFrame(page).size;
        deck.slides.push(await buildSlide({ index, sizePt: size, ops }, { media, fonts, page }));
        deck.ops.push(ops);
        deck.fnArrays.push([...page.ops.fnArray]);
        deck.sizes.push(size);
      } finally {
        await releasePage(page);
      }
    }
  } finally {
    await closeDocument(doc);
  }
  return deck;
}
