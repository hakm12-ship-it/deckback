import type * as Pdfjs from 'pdfjs-dist';
import { assertSameOps, OPS } from './pdfjs-ops';
import type { Ref } from './rawpdf';

export { IMAGE_KIND, OPS } from './pdfjs-ops';

/** The pdf.js module this adapter drives; the legacy and the browser build have the same shape. */
export type PdfjsLib = typeof Pdfjs;

export interface PdfDoc {
  numPages: number;
}

export interface StructNode {
  role?: string;
  children?: (StructNode | { type: 'content' | 'object' | 'annotation'; id: string })[];
}

export interface PdfjsFont {
  loadedName: string;
  name: string | null;
  ascent: number | null;
  descent: number | null;
  isType3Font: boolean;
  /** pdf.js has no program of the font: it is not embedded, or pdf.js could not read it and uses one of its own. */
  missingFile: boolean;
  vertical: boolean;
  /** Vertical fonts: `[w1y, vx, vy]` from /DW2, per mille (with `fontExtraProperties`). */
  defaultVMetrics?: number[] | null;
  fontMatrix: number[];
}

export interface PageData {
  /** 0-based. */
  index: number;
  /** From pdf.js `page.ref`. */
  pageRef: Ref;
  view: [number, number, number, number];
  rotate: 0 | 90 | 180 | 270;
  ops: { fnArray: number[]; argsArray: unknown[] };
  /** `page.getStructTree()`; null when the page is not tagged. */
  structTree: StructNode | null;
  /** The pdf.js font object from `commonObjs` (`fontExtraProperties` on; it has more fields than `PdfjsFont` lists). */
  font(id: string): PdfjsFont;
  /**
   * An object (image, shading pattern, ...) from `objs`, or from `commonObjs` for the ids pdf.js shares across pages.
   * An image object's `ref` is pdf.js' reference string; read it with `parsePdfjsRef`.
   * `font()` and `obj()` are valid until `releasePage`.
   */
  obj(id: string): unknown;
  /**
   * Whether pdf.js shows the optional content the properties of a `beginMarkedContentProps('OC', props)` name, as it
   * draws the page on screen (`getOptionalContentConfig({ intent: 'display' }).isVisible`): an optional content group or
   * membership dictionary. Anything pdf.js does not know (null, a group the configuration does not list) is shown.
   */
  isOcVisible(props: unknown): boolean;
  /** The page's link annotations pdf.js shows (`getAnnotations({ intent: 'display' })`), in /Annots order. Until `releasePage`. */
  links(): Promise<PdfLink[]>;
}

/** A link annotation, as `PageData.links` gives it. */
export interface PdfLink {
  /** /Rect in the page's default user space (unrotated, not cropped), normalised: x0 ≤ x1, y0 ≤ y1. */
  rect: [number, number, number, number];
  /** The URI it opens, when pdf.js calls it a valid absolute URL (http, https, ftp, mailto, tel); else null. */
  url: string | null;
  /** The page of this document it goes to (0-based), from an explicit or a named destination; else null. */
  page: number | null;
}

/** The data-file kinds pdf.js may ask for; only `cMapUrl` is ever configured. */
export type PdfjsDataKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl';

/** pdf.js' `BinaryDataFactory` contract: constructed with the configured directories, asked for one file at a time. */
export type PdfjsBinaryDataFactory = new (urls: Record<PdfjsDataKind, string | null>) => {
  fetch(request: { kind: PdfjsDataKind; filename: string }): Promise<Uint8Array>;
};

/** A pdf.js build plus the place where its character-map files live. */
export interface PdfjsEnvironment {
  lib: PdfjsLib;
  /** Directory of pdf.js' `cmaps/`, with a trailing slash, in the form the build's data fetcher takes. */
  cMapUrl: string;
  /**
   * How pdf.js fetches its data files, for an environment where the build's own fetcher cannot work (pdf.js'
   * browser fetcher reads `document.baseURI`, which a worker does not have). Omitted: the build's default.
   */
  BinaryDataFactory?: PdfjsBinaryDataFactory;
}

/**
 * The Node environment: the legacy build, with `cmaps/` found next to the installed package at run time.
 * The cMapUrl is a plain file path (forward slashes), because pdf.js' Node fetcher hands it to `fs.readFile`.
 */
async function nodeEnvironment(): Promise<PdfjsEnvironment> {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const dir = new URL('cmaps/', import.meta.resolve('pdfjs-dist/package.json'));
  const cMapUrl = decodeURIComponent(dir.pathname).replace(/^\/(?=[A-Za-z]:)/, '');
  return { lib, cMapUrl };
}

let provider: () => Promise<PdfjsEnvironment> = nodeEnvironment;
let environment: Promise<PdfjsEnvironment> | null = null;

/**
 * Replaces the environment (default: Node, legacy build). The browser worker calls this once, before the first
 * `openDocument`, with the browser build and the served `cmaps/` URL; nothing else about the adapter changes.
 */
export function setPdfjsEnvironment(provide: () => Promise<PdfjsEnvironment>): void {
  provider = provide;
  environment = null;
}

function getEnvironment(): Promise<PdfjsEnvironment> {
  environment ??= provider().then(
    (env) => {
      assertSameOps(env.lib.OPS);
      return env;
    },
    (error: unknown) => {
      environment = null; // a failed load may be retried
      throw error;
    },
  );
  return environment;
}

type OcConfig = Awaited<ReturnType<Pdfjs.PDFDocumentProxy['getOptionalContentConfig']>>;

interface Internals {
  task: Pdfjs.PDFDocumentLoadingTask;
  proxy: Pdfjs.PDFDocumentProxy;
  lib: PdfjsLib;
  /** Indexes of the pages loaded (or loading) and not yet released. */
  live: Set<number>;
  /** What pdf.js shows on screen, asked for once, by the first `loadPage`. */
  oc?: Promise<OcConfig>;
}
/** Open documents only: `closeDocument` removes its entry. */
const docs = new WeakMap<PdfDoc, Internals>();
const pages = new WeakMap<PageData, { page: Pdfjs.PDFPageProxy; live: Set<number> }>();

/** The version of the pdf.js build the adapter drives (recorded with measurements such as the oracle sweep). */
export async function pdfjsVersion(): Promise<string> {
  const { lib } = await getEnvironment();
  return lib.version;
}

/**
 * Opens a PDF. When pdf.js cannot (`openFailure` says why, if it is the file's fault), the loading task is destroyed and
 * the error is pdf.js' own.
 */
export async function openDocument(bytes: Uint8Array): Promise<PdfDoc> {
  const { lib, cMapUrl, BinaryDataFactory } = await getEnvironment();
  const task = lib.getDocument({
    // pdf.js may take ownership of (detach) the buffer it is given; the caller keeps its own bytes.
    data: new Uint8Array(bytes),
    fontExtraProperties: true,
    verbosity: 0, // errors only: pdf.js's warnings quote the file (fonts, tables) and nothing of it goes to a console
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    cMapUrl,
    cMapPacked: true,
    ...(BinaryDataFactory === undefined ? {} : { BinaryDataFactory }),
  });
  let proxy: Pdfjs.PDFDocumentProxy;
  try {
    proxy = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => undefined); // free pdf.js' side; the open error is the one to report
    throw error;
  }
  const doc: PdfDoc = { numPages: proxy.numPages };
  docs.set(doc, { task, proxy, lib, live: new Set() });
  return doc;
}

/**
 * Why pdf.js could not open a file, when the file is to blame: `not-pdf` (pdf.js' InvalidPDFException: no PDF, or an empty
 * file) or `password` (PasswordException: it needs a password to open). Null for any other error.
 */
export function openFailure(error: unknown): 'not-pdf' | 'password' | null {
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === 'InvalidPDFException' ? 'not-pdf' : name === 'PasswordException' ? 'password' : null;
}

/** The document information dictionary's /Producer and /Creator, as pdf.js reads them (`getMetadata().info`); else null. */
export async function documentInfo(doc: PdfDoc): Promise<{ producer: string | null; creator: string | null }> {
  const internals = docs.get(doc);
  if (internals === undefined) throw new Error('documentInfo: the document is closed, or was not returned by openDocument');
  const { info } = await internals.proxy.getMetadata();
  const text = (key: string): string | null => {
    const value = (info as Record<string, unknown> | null)?.[key];
    return typeof value === 'string' ? value : null;
  };
  return { producer: text('Producer'), creator: text('Creator') };
}

/**
 * Frees everything pdf.js holds for the document (`loadingTask.destroy()`, which also ends pdf.js' worker side).
 * Pages of the document must not be used afterwards, and `loadPage` rejects it. Closing twice is a no-op.
 */
export async function closeDocument(doc: PdfDoc): Promise<void> {
  const internals = docs.get(doc);
  if (internals === undefined) return;
  docs.delete(doc);
  internals.live.clear();
  await internals.task.destroy();
}

/**
 * When getOperatorList resolves, fonts and (above all) images may still be on their way into `objs` /
 * `commonObjs`. pdf.js' own renderer waits for exactly the ids named by `dependency` ops before it paints;
 * we wait for the same ids, so that `font()` and `obj()` can be synchronous.
 */
async function settleDependencies(page: Pdfjs.PDFPageProxy, list: PageData['ops']): Promise<void> {
  const waits: Promise<void>[] = [];
  list.fnArray.forEach((code, i) => {
    if (code !== OPS.dependency) return;
    for (const id of list.argsArray[i] as string[]) {
      const store = id.startsWith('g_') ? page.commonObjs : page.objs;
      waits.push(new Promise((resolve, reject) => void store.get(id, () => resolve(), reject)));
    }
  });
  await Promise.all(waits);
}

/**
 * pdf.js names objects by string: image objects carry `ref: "9R"` (object 9, generation 0) or `"9R2"` (generation 2).
 * Returns that reference as a `Ref`, accepts an already-parsed `{ num, gen }` too, and gives null for anything else.
 */
export function parsePdfjsRef(value: unknown): Ref | null {
  if (typeof value === 'string') {
    const m = /^([1-9]\d*)R([1-9]\d*)?$/.exec(value);
    return m === null ? null : { num: Number(m[1]), gen: m[2] === undefined ? 0 : Number(m[2]) };
  }
  if (typeof value === 'object' && value !== null) {
    const { num, gen } = value as { num?: unknown; gen?: unknown };
    if (Number.isInteger(num) && Number.isInteger(gen)) return { num: num as number, gen: gen as number };
  }
  return null;
}

function isRotation(n: number): n is 0 | 90 | 180 | 270 {
  return n === 0 || n === 90 || n === 180 || n === 270;
}

/**
 * Loads one page: its operator list, with every object the list depends on already resolved, its structure tree, and
 * what pdf.js shows of its optional content.
 *
 * A page index can be loaded once at a time: a second `loadPage` of an index that is loaded (or still loading)
 * and not yet released rejects at once. pdf.js hands both calls the same page, so releasing one would clear the
 * objects the other may still be waiting for, and that wait would never end.
 */
export async function loadPage(doc: PdfDoc, index: number): Promise<PageData> {
  const internals = docs.get(doc);
  if (internals === undefined) throw new Error('loadPage: the document is closed, or was not returned by openDocument');
  if (!Number.isInteger(index) || index < 0 || index >= doc.numPages) {
    throw new RangeError(`loadPage: page index ${index} is outside 0..${doc.numPages - 1}`);
  }
  const { proxy, lib, live } = internals;
  if (live.has(index)) throw new Error(`loadPage: page ${index} is already loaded; release it before loading it again`);
  live.add(index); // before the first await, so that a concurrent second call sees it
  let page: Pdfjs.PDFPageProxy | undefined;
  try {
    // pdf.js answers with an empty configuration (everything shown) when it cannot read one.
    internals.oc ??= proxy.getOptionalContentConfig({ intent: 'display' }).catch((error: unknown) => {
      internals.oc = undefined; // a failed request may be retried
      throw error;
    });
    const oc = await internals.oc;
    page = await proxy.getPage(index + 1);
    return await readPage(page, index, internals, oc);
  } catch (error) {
    page?.cleanup();
    live.delete(index);
    throw error;
  }
}

async function readPage(page: Pdfjs.PDFPageProxy, index: number, internals: Internals, oc: OcConfig): Promise<PageData> {
  const { lib, live, proxy } = internals;
  const ref = page.ref;
  if (ref === null) throw new Error(`loadPage: pdf.js gave page ${index} no object reference`);
  const view = page.view;
  if (view.length !== 4 || !isRotation(page.rotate)) {
    throw new Error(`loadPage: page ${index} has an unexpected view [${view.join(', ')}] or rotation ${page.rotate}`);
  }
  const list = await page.getOperatorList({ annotationMode: lib.AnnotationMode.DISABLE });
  await settleDependencies(page, list);
  const structTree = (await page.getStructTree()) as StructNode | null;
  const data: PageData = {
    index,
    pageRef: { num: ref.num, gen: ref.gen },
    view: [view[0]!, view[1]!, view[2]!, view[3]!],
    rotate: page.rotate,
    ops: { fnArray: list.fnArray, argsArray: list.argsArray },
    structTree,
    font: (id) => page.commonObjs.get(id) as PdfjsFont,
    obj: (id) => (page.objs.has(id) ? page.objs.get(id) : page.commonObjs.get(id)),
    isOcVisible: (props) => oc.isVisible(props),
    links: () => linksOf(page, proxy),
  };
  pages.set(data, { page, live });
  return data;
}

/** pdf.js `AnnotationType.LINK`. */
const LINK = 2;

/** The link annotations of a page pdf.js shows, with their destinations resolved to pages of the document. */
async function linksOf(page: Pdfjs.PDFPageProxy, proxy: Pdfjs.PDFDocumentProxy): Promise<PdfLink[]> {
  const annotations = (await page.getAnnotations({ intent: 'display' })) as { annotationType?: unknown; rect?: unknown; url?: unknown; dest?: unknown }[];
  const links: PdfLink[] = [];
  for (const annotation of annotations) {
    const rect = annotation.rect;
    if (annotation.annotationType !== LINK || !Array.isArray(rect) || rect.length !== 4) continue;
    if (!rect.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    const [x0, y0, x1, y1] = rect as number[];
    links.push({
      rect: [Math.min(x0!, x1!), Math.min(y0!, y1!), Math.max(x0!, x1!), Math.max(y0!, y1!)],
      url: typeof annotation.url === 'string' ? annotation.url : null,
      page: await destinationPage(proxy, annotation.dest),
    });
  }
  return links;
}

/**
 * The page (0-based) a destination goes to: a named destination is looked up first; an explicit one names its page by
 * reference, or by index. Null for none, and for one pdf.js cannot resolve to a page of the document.
 */
async function destinationPage(proxy: Pdfjs.PDFDocumentProxy, dest: unknown): Promise<number | null> {
  let explicit: unknown = dest;
  if (typeof dest === 'string') explicit = await proxy.getDestination(dest).catch(() => null);
  if (!Array.isArray(explicit) || explicit.length === 0) return null;
  const target: unknown = explicit[0];
  if (typeof target === 'number') return Number.isInteger(target) && target >= 0 && target < proxy.numPages ? target : null;
  const ref = parsePdfjsRef(target);
  if (ref === null) return null;
  return proxy.getPageIndex(ref).catch(() => null);
}

/**
 * Frees what pdf.js holds for the page (`page.cleanup()`) and lets its index be loaded again; `font()` and
 * `obj()` must not be used afterwards. Releasing twice is a no-op.
 */
export async function releasePage(page: PageData): Promise<void> {
  const held = pages.get(page);
  if (held === undefined) return;
  pages.delete(page);
  held.page.cleanup();
  held.live.delete(page.index);
}
