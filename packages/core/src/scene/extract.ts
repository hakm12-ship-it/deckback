import {
  closeDocument,
  documentInfo,
  loadPage,
  openDocument,
  openFailure,
  releasePage,
  type PageData,
  type PdfDoc,
  type PdfLink,
} from '../engine/pdfjs-adapter';
import { EncryptedPdfError, openRawPdf, type RawPdf } from '../engine/rawpdf';
import { transformBox, type Matrix } from '../extract/gstate';
import { pageFrame, walkOps } from '../extract/walker';
import { buildSlide, SceneTooComplexError } from './build';
import { canWrite, roundPt } from './canonical';
import { FontTable, type FontFile } from './fonts';
import { MediaStore, type ImageInput } from './media';
import { SCENE_SCHEMA, type HotspotEl, type SceneBundle, type SceneDeck, type SceneSlide } from './types';
import { DECK_WEIGHT_BUDGET, PAGE_UNIT, SLIDE_WEIGHT_BUDGET, slideWeight } from './weight';

export interface ExtractOptions {
  /**
   * The pages to convert, 0-based, in this order; every page, in order, when omitted or empty. A page listed twice is
   * refused (`SceneInputError` `duplicate page`, M2's final review F12): its slide and element ids would be there twice.
   */
  pages?: readonly number[];
  /**
   * Throw `UnsupportedOpError` for an operator the walker does not model, and an Error for a page the Scene builder cannot
   * build, as the oracle tests want. Default false (lenient): what cannot be modelled becomes a fallback element with a
   * note, and a page that cannot be built at all a `failed` slide. A page pdf.js cannot load is a `failed` slide either way,
   * and links pdf.js cannot read are a note either way (rulings M2-R23, M2-R25).
   */
  strict?: boolean;
}

/**
 * The file is no PDF pdf.js can open (`not-pdf`, also for an empty file), it needs a password to open (`password`), or
 * `pages` lists a page twice (`duplicate page`).
 */
export class SceneInputError extends Error {
  readonly kind: 'not-pdf' | 'password' | 'duplicate page';

  constructor(kind: 'not-pdf' | 'password' | 'duplicate page', options?: { cause?: unknown }) {
    super(MESSAGES[kind], options);
    this.name = 'SceneInputError';
    this.kind = kind;
  }
}

const MESSAGES: Record<SceneInputError['kind'], string> = {
  'not-pdf': 'extractScene: the file is not a PDF that can be read',
  password: 'extractScene: the PDF needs a password to open',
  'duplicate page': 'extractScene: a page is listed twice in pages',
};

/** One converted page of `scenePages`, in the order of the pages converted. */
export interface ScenePage {
  /** Its slide, as `extractScene` has it. */
  slide: SceneSlide;
  /**
   * The pictures the deck uses first on this slide, keyed by hash in first-use order: handed over (`MediaStore.takeFiles`),
   * so no page's bytes are kept once its slide is yielded.
   */
  media: Map<string, Uint8Array>;
  /**
   * With `fontFiles`: the programs of the fonts the deck uses first on this slide, keyed by font key in first-use order,
   * handed over (`FontTable.takeFiles`) as the pictures are; a font whose program could not be read has none. Empty
   * without `fontFiles`.
   */
  fontFiles: Map<string, FontFile>;
  /** The deck so far, this slide included: its fonts and the media's `MediaInfo`, which the passes and lowering read. */
  deck: Pick<SceneDeck, 'fonts' | 'media'>;
  /**
   * M5 Task 2: the decoded pixels of the pictures the page painted, by media hash, which the raster renderer draws a
   * picture from; only for a slide it may draw (`mayRaster`: a blend mode or a soft mask), else empty.
   */
  pixels: ReadonlyMap<string, ImageInput>;
  /** How many pages are converted: the deck's slide count, known before its first slide. */
  count: number;
  /** The page's links that are not hotspots of the slide, as the slide was past its weight budget (its note says so). */
  droppedLinks: number;
}

/** What `scenePages` returns once every page is yielded: the rest of the `SceneDeck`. */
export type SceneSummary = Pick<SceneDeck, 'source' | 'fonts' | 'media'>;

/** `scenePages`' options: `extractScene`'s, and what only `convert` asks for. */
export interface ScenePagesOptions extends ExtractOptions {
  /**
   * Cut the deck at `DECK_WEIGHT_BUDGET` (ruling M3-R41; `convert` only, which writes slide after slide): once the slides
   * converted weigh more, the pages after are not loaded and each is a slide with no elements and size [0, 0],
   * `failed: 'deck-too-complex'`, with the note `deck too complex` (`opIndex` 0, `op` `getOperatorList`, the call not
   * made); strict mode throws `SceneTooComplexError` instead. `extractScene` never cuts: it returns every slide built.
   */
  cutDeck?: boolean;
  /**
   * Hand over the program of each font as the deck first uses it (`ScenePage.fontFiles`; `convert` only, for its
   * `embedFonts`). The Scene is the same either way.
   */
  fontFiles?: boolean;
}

/**
 * Converts a PDF into a Scene (Scene JSON v1, `types.ts`) and the media files it names: the one function every caller
 * uses, the CLI in Node and the website in its worker alike. The same bytes give byte-identical canonical Scene JSON and
 * media everywhere (Global Constraints, Determinism).
 *
 * - Pages are handled strictly one at a time: load, walk, build, release, then the next. Only the Scene and the media
 *   bytes stay in memory; the fonts' and the JPEGs' raw bytes are read one page's worth at a time.
 * - Lenient by default (`ExtractOptions.strict`): a page never takes the deck down or changes the other pages.
 *   - An operator the walker does not model becomes a fallback element and a note where it was (`unsupported-op`), and
 *     the walk goes on; so does a paint the Scene cannot build (`unbuildable`).
 *   - A page pdf.js cannot load is a slide with no elements and size [0, 0], `failed: 'page-unreadable'`; one that cannot
 *     be built at all, `failed: 'slide-unbuildable'`, with its size when that is finite, else [0, 0].
 *   - What a failed slide or a fallback met is undone: no font or media of theirs is left in the deck's tables, so every
 *     other slide, its font keys and its media included, is as it is in a deck without the failed one.
 *   - Links pdf.js cannot read cost the slide its hotspots only, with a note, and document information it cannot read
 *     gives no producer and no creator, in strict mode too. Releasing a page or closing the document never fails a
 *     conversion.
 *   - So what it returns can always be written: `canonicalJson` and `sceneHash` take it.
 * - The page's link annotations pdf.js shows become hotspots at the end of its elements, their /Rect in the slide frame.
 * - `source`: /Producer and /Creator of the document information, whether a converted page (one whose slide is not
 *   `failed`) has a structure tree, and the document's page count. An encrypted file opens through pdf.js (when no
 *   password is needed to open it), and the raw reader cannot read it: `encrypted` is true, font names are pdf.js' only
 *   and every picture is a PNG (ruling M2-R6). The raw reader finds a page by its object reference, so the two agree on a
 *   damaged page tree too.
 *
 * - A slide weighs at most about `SLIDE_WEIGHT_BUDGET` (weight.ts; rulings M2-R36, M2-R37, M3-R40): past it the rest of the
 *   paints are one fallback (`buildSlide`), and its links count too: those past the budget are not hotspots, and the
 *   slide has the note `slide too complex: links dropped` (`opIndex` 0, `op` `getAnnotations`); strict mode throws.
 *   There is no budget for the deck here (ruling M3-R41): every page asked for is built.
 *
 * Throws `SceneInputError` when the file is no PDF or needs a password, or `pages` lists a page twice, and a RangeError
 * for a page index outside the document. The caller's bytes are not changed. It collects what `scenePages` yields.
 */
export async function extractScene(bytes: Uint8Array, opts: ExtractOptions = {}): Promise<SceneBundle> {
  const slides: SceneSlide[] = [];
  const media = new Map<string, Uint8Array>();
  const pages = scenePages(bytes, { pages: opts.pages ?? [], strict: opts.strict ?? false });
  let step = await pages.next();
  for (; step.done !== true; step = await pages.next()) {
    slides.push(step.value.slide);
    for (const [hash, file] of step.value.media) media.set(hash, file);
  }
  const { source, fonts, media: infos } = step.value;
  return { scene: { schema: SCENE_SCHEMA, source, slides, fonts, media: infos }, media };
}

/**
 * `extractScene` a page at a time (internal: `extractScene` and `convert` use it): each page converted is loaded, walked,
 * built and released, and then its slide is yielded with the pictures it uses first, which the deck's store hands over
 * and does not keep. Only the deck's font table and the media's `MediaInfo` stay from page to page. Once every page is
 * yielded it returns the deck's `source`, fonts and media. What `extractScene` documents holds for each slide, and the
 * same throws come from the first `next()` (opening the file, checking `pages`) or from the page that causes them.
 * Stopping early (`return`, a `break` out of `for await`) closes the document. `cutDeck` (`convert` only) cuts the deck
 * at its weight budget (`ScenePagesOptions`).
 */
export async function* scenePages(bytes: Uint8Array, opts: ScenePagesOptions = {}): AsyncGenerator<ScenePage, SceneSummary, undefined> {
  const strict = opts.strict ?? false;
  let doc: PdfDoc;
  try {
    doc = await openDocument(bytes);
  } catch (error) {
    const kind = openFailure(error);
    if (kind !== null) throw new SceneInputError(kind, { cause: error });
    throw error;
  }
  try {
    const indexes = pageIndexes(opts.pages, doc.numPages);
    const count = indexes.length;
    const { raw, encrypted } = rawReader(bytes);
    const fonts = new FontTable(raw, opts.fontFiles === true);
    const media = new MediaStore(raw);
    const { producer, creator } = await documentInfo(doc).catch(() => ({ producer: null, creator: null }));
    let tagged = false;
    let deckWeight = 0;
    const done = (slide: SceneSlide, droppedLinks = 0): ScenePage => ({
      slide,
      media: media.takeFiles(),
      pixels: mayRaster(slide) ? media.takePixels() : (media.takePixels(), NO_PIXELS),
      fontFiles: fonts.takeFiles(),
      deck: { fonts: fonts.infos(), media: media.infos() },
      count,
      droppedLinks,
    });
    for (const index of indexes) {
      if (opts.cutDeck === true && deckWeight > DECK_WEIGHT_BUDGET) {
        if (strict) throw new SceneTooComplexError('deck');
        const cut = emptySlide(index, [0, 0], 'deck-too-complex');
        cut.notes.push({ opIndex: 0, op: 'getOperatorList', detail: 'deck too complex' });
        yield done(cut);
        continue;
      }
      const loaded = await builtPage(doc, index, fonts, media, strict);
      if (loaded === null) {
        yield done(emptySlide(index, [0, 0], 'page-unreadable'));
        continue;
      }
      const { built } = loaded;
      if (built.slide.failed === null) {
        tagged ||= loaded.tagged;
        deckWeight += built.weight;
      }
      yield done(built.slide, built.droppedLinks);
    }
    return { source: { producer, creator, tagged, encrypted, pageCount: doc.numPages }, fonts: fonts.infos(), media: media.infos() };
  } finally {
    await quietly(closeDocument(doc));
  }
}

const NO_PIXELS: ReadonlyMap<string, ImageInput> = new Map();

/**
 * Whether the raster renderer may draw a picture of the slide (M5 Task 2): an element of it has a blend mode other than
 * Normal or a soft mask, its own or a group's, so a picture may be its target, under it or in its mask.
 */
function mayRaster(slide: SceneSlide): boolean {
  return slide.elements.some((el) => el.blend !== 'normal' || el.mask !== null || el.groups.some((g) => g.blend !== 'normal' || g.mask !== null));
}

/**
 * Page `index` loaded, its slide built (`slideOf`) and the page released; null when pdf.js cannot load it. `tagged`:
 * whether the page has a structure tree. Nothing of a failed slide stays in the deck: the next font gets the key it would
 * have had without it, and `source.tagged` is that of the converted pages (final review F3). Nothing of the page stays
 * either once this returns, so the caller does not hold pdf.js' operator list while the slide is passed, lowered and
 * written (final review F2: it was held through the generator's `yield`, 90 MB for a page of 500,000 paints).
 */
async function builtPage(
  doc: PdfDoc,
  index: number,
  fonts: FontTable,
  media: MediaStore,
  strict: boolean,
): Promise<{ built: Built; tagged: boolean } | null> {
  let page: PageData;
  try {
    page = await loadPage(doc, index);
  } catch {
    return null;
  }
  try {
    const marks = { fonts: fonts.mark(), media: media.mark() };
    const built = await slideOf(page, fonts, media, strict);
    if (built.slide.failed !== null) {
      fonts.rewind(marks.fonts);
      media.rewind(marks.media);
    }
    return { built, tagged: page.structTree !== null };
  } finally {
    await quietly(releasePage(page));
  }
}

/** Cleanup that must never fail a conversion, nor hide its result or its real error. */
async function quietly(cleanup: Promise<void>): Promise<void> {
  await cleanup.catch(() => undefined);
}

/**
 * The slide of a loaded page. One `canonicalJson` cannot write (a clip or a soft mask with a number that is not finite)
 * throws in strict mode; in lenient mode it is a `slide-unbuildable` slide, as one that cannot be built.
 */
async function slideOf(page: PageData, fonts: FontTable, media: MediaStore, strict: boolean): Promise<Built> {
  const frame = pageFrame(page);
  if (strict) {
    const built = await build(page, frame, fonts, media, true);
    if (!canWrite(built.slide)) throw new Error(`extractScene: the slide of page ${page.index} has a number that is not finite`);
    return built;
  }
  try {
    const built = await build(page, frame, fonts, media, false);
    if (canWrite(built.slide)) return built;
  } catch {
    // below: the page as a whole could not be built
  }
  const [w, h] = frame.size;
  const slide = emptySlide(page.index, Number.isFinite(w) && Number.isFinite(h) ? [roundPt(w), roundPt(h)] : [0, 0], 'slide-unbuildable');
  return { slide, weight: 0, droppedLinks: 0 };
}

/** A slide built: its weight (`slideWeight`, its hotspots included) and the links past its weight budget. */
interface Built {
  slide: SceneSlide;
  weight: number;
  droppedLinks: number;
}

/**
 * Walks the page, builds its slide while pdf.js still holds the page, and adds its links. Links pdf.js cannot read are a
 * note in strict mode too (ruling M2-R25: `strict` is about the walker's model, M2-R23), with no hotspot; no op draws
 * them: `opIndex` 0, `op` `getAnnotations` (ruling M2-R24). A hotspot weighs `PAGE_UNIT.hotspot` (weight.ts): the links
 * that would take the slide past its weight budget, all of them on a slide already past it, are not hotspots, and the
 * slide has the note `slide too complex: links dropped` (`getAnnotations` again); strict mode throws
 * `SceneTooComplexError`.
 */
async function build(
  page: PageData,
  frame: { matrix: Matrix; size: [number, number] },
  fonts: FontTable,
  media: MediaStore,
  strict: boolean,
): Promise<Built> {
  const ops = walkOps(page, { strict });
  const slide = await buildSlide({ index: page.index, sizePt: frame.size, ops }, { fonts, media, page }, { strict });
  let links: PdfLink[];
  try {
    links = await page.links();
  } catch {
    links = [];
    slide.notes.push({ opIndex: 0, op: 'getAnnotations', detail: 'links pdf.js could not read' });
  }
  const weight = slideWeight(slide);
  const past = slide.notes.some((note) => note.detail.startsWith('slide too complex'));
  const room = past ? 0 : Math.max(0, SLIDE_WEIGHT_BUDGET - weight);
  const kept = links.slice(0, Math.floor(room / PAGE_UNIT.hotspot));
  if (kept.length < links.length) {
    if (strict) throw new SceneTooComplexError('slide');
    slide.notes.push({ opIndex: 0, op: 'getAnnotations', detail: 'slide too complex: links dropped' });
  }
  slide.elements.push(...kept.map((link, n) => hotspot(link, `p${page.index + 1}:a${n}`, frame.matrix, slide.sizePt)));
  return { slide, weight: weight + kept.length * PAGE_UNIT.hotspot, droppedLinks: links.length - kept.length };
}

/** A link as a hotspot: its /Rect through the page frame; it is drawn in nothing, so its clip box is the slide. */
function hotspot(link: PdfLink, id: string, frame: Matrix, sizePt: [number, number]): HotspotEl {
  const rect = transformBox(frame, link.rect);
  return {
    id,
    provenance: { opIndex: [], mcid: null, struct: null },
    clip: [],
    clipBox: [0, 0, sizePt[0], sizePt[1]],
    groups: [],
    mask: null,
    blend: 'normal',
    kind: 'hotspot',
    rect: [roundPt(rect[0]), roundPt(rect[1]), roundPt(rect[2]), roundPt(rect[3])],
    // `page:<n>` is 1-based, as the `p<n>` of the ids (ruling M2-R22); PdfLink.page is 0-based.
    link: { url: link.url, dest: link.page === null ? null : `page:${link.page + 1}` },
  };
}

function emptySlide(index: number, sizePt: [number, number], failed: string): SceneSlide {
  return { index, sizePt, elements: [], clips: {}, masks: {}, notes: [], failed };
}

/** The pages to convert: `pages`, checked against the document and for a page listed twice, or every page. */
function pageIndexes(pages: readonly number[] | undefined, numPages: number): number[] {
  if (pages === undefined || pages.length === 0) return Array.from({ length: numPages }, (_, i) => i);
  const seen = new Set<number>();
  for (const index of pages) {
    if (!Number.isInteger(index) || index < 0 || index >= numPages) {
      throw new RangeError(`extractScene: page index ${index} is outside 0..${numPages - 1}`);
    }
    if (seen.has(index)) throw new SceneInputError('duplicate page');
    seen.add(index);
  }
  return [...pages];
}

/** The raw reader of the file; null when it cannot read it, and then `encrypted` when that is because it is encrypted. */
function rawReader(bytes: Uint8Array): { raw: RawPdf | null; encrypted: boolean } {
  try {
    return { raw: openRawPdf(bytes), encrypted: false };
  } catch (error) {
    return { raw: null, encrypted: error instanceof EncryptedPdfError };
  }
}
