import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { closeDocument, loadPage, openDocument, OPS, releasePage, type PageData } from '../../src/engine/pdfjs-adapter';
import { compareInventories, TOLERANCE_PT, toInventory, type Inventory, type PageInv } from '../../src/extract/inventory';
import { pageFrame, UnsupportedOpError, walkPage, type RawOp } from '../../src/extract/walker';
import { extractScene } from '../../src/scene/extract';
import { inventoryOfSlide } from '../../src/scene/inventory';
import type { Element, Note, SceneBundle, SceneDeck } from '../../src/scene/types';
import { pythonPath, repoRoot } from './fixtures';

/**
 * The walker and the Scene against the PyMuPDF oracle (`harness/oracle/mupdf_inventory.py`), shared by the M0 test
 * (walker.local.test.ts), the corpus ratchets (test/corpus) and the atlas sweep (test/sweep). Page numbers given to
 * these functions are 1-based; an inventory's `index` is 0-based (docs/decisions/0002-inventory-contract.md §2).
 */

export function runPython(args: string[]): string {
  return execFileSync(pythonPath(), args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
}

/** The versions of PyMuPDF and of the MuPDF library in it, as the oracle's Python has them. */
export function oracleVersions(): { pymupdf: string; mupdf: string } {
  const code = 'import json, pymupdf; print(json.dumps({"pymupdf": pymupdf.__version__, "mupdf": pymupdf.VersionFitz}))';
  return JSON.parse(runPython(['-I', '-c', code])) as { pymupdf: string; mupdf: string };
}

/** The oracle inventory of `pages` (1-based), or of every page in one Python run when `pages` is omitted. */
export function oracleInventory(pdf: string, pages?: number[]): Inventory {
  const args = [`${repoRoot}harness/oracle/mupdf_inventory.py`, pdf];
  if (pages !== undefined) args.push('--pages', pages.join(','));
  return JSON.parse(runPython(args)) as Inventory;
}

export interface WalkResult {
  inventory: Inventory;
  /** Pages the walker reported unsupported (only collected with `keepGoing`; any other error always propagates). */
  errors: { page: number; op: string; error: string }[];
}

/**
 * The walker inventory of `pages` (1-based; every page when omitted). With `keepGoing`, a page that throws
 * `UnsupportedOpError` is listed in `errors` and left out of the inventory; any other error fails the caller.
 */
export async function walkerInventory(bytes: Uint8Array, pages?: number[], keepGoing = false): Promise<WalkResult> {
  const doc = await openDocument(bytes);
  const walked: { index: number; size: [number, number]; ops: RawOp[] }[] = [];
  const errors: WalkResult['errors'] = [];
  try {
    for (const number of pages ?? Array.from({ length: doc.numPages }, (_, i) => i + 1)) {
      const page = await loadPage(doc, number - 1);
      try {
        walked.push({ index: page.index, size: pageFrame(page).size, ops: walkPage(page) });
      } catch (error) {
        if (!keepGoing || !(error instanceof UnsupportedOpError)) throw error;
        errors.push({ page: number, op: error.op, error: error.message });
      } finally {
        await releasePage(page);
      }
    }
  } finally {
    await closeDocument(doc);
  }
  return { inventory: toInventory(walked), errors };
}

/** How one page fared against the oracle. */
export interface PageOutcome {
  /** 0-based page index. */
  index: number;
  /** The walker walked the page and its inventory equals the oracle's (TOLERANCE_PT, 0.05 pt). */
  ok: boolean;
  /** compareInventories' diff lines for this page (empty when ok or unsupported; at most 50 per section). */
  diffs: string[];
  /** The number of diffs, also those past the lines `diffs` lists (compareInventories' `diffTotal`). */
  diffTotal: number;
  /** Paint pairs compared by kind and position only because one side was `approx` (compareInventories). */
  approxPaints: number;
  /** The walker's UnsupportedOpError message, or null. */
  unsupported: string | null;
  /** The operator that error names (`UnsupportedOpError.op`), or null. */
  unsupportedOp: string | null;
}

export type FailureKind = 'unsupported-op' | 'diff';

export function failureKind(outcome: PageOutcome): FailureKind | null {
  if (outcome.unsupported !== null) return 'unsupported-op';
  return outcome.ok ? null : 'diff';
}

/**
 * Every page of `pdf`: the oracle runs once for the whole file, the walker walks every page (keepGoing), and each
 * walked page is compared with its oracle page on its own.
 */
export async function comparePdf(pdf: string): Promise<PageOutcome[]> {
  return walkerOutcomes(new Uint8Array(readFileSync(pdf)), oracleInventory(pdf));
}

/** The walker's outcome on every page of `expected`, the oracle inventory of the whole file `bytes`. */
async function walkerOutcomes(bytes: Uint8Array, expected: Inventory): Promise<PageOutcome[]> {
  const { inventory, errors } = await walkerInventory(bytes, undefined, true);
  const walkedPages = inventory.pages.length + errors.length;
  if (expected.pages.length !== walkedPages) {
    throw new Error(`comparePdf: the oracle read ${expected.pages.length} pages, the walker ${walkedPages}`);
  }
  const walked = new Map<number, PageInv>(inventory.pages.map((p) => [p.index, p]));
  const failed = new Map(errors.map((e) => [e.page - 1, e]));
  return expected.pages.map((exp): PageOutcome => {
    const error = failed.get(exp.index);
    if (error !== undefined) {
      return {
        index: exp.index,
        ok: false,
        diffs: [],
        diffTotal: 0,
        approxPaints: 0,
        unsupported: error.error,
        unsupportedOp: error.op,
      };
    }
    const act = walked.get(exp.index);
    if (act === undefined) throw new Error(`comparePdf: the walker has no page ${exp.index}`);
    const { ok, diffs, diffTotal, approxPaints } = compareInventories({ pages: [exp] }, { pages: [act] }, TOLERANCE_PT);
    return { index: exp.index, ok, diffs, diffTotal, approxPaints, unsupported: null, unsupportedOp: null };
  });
}

/** The element kinds of Scene v1, in the order the goldens and the sweep list their counts. */
export const ELEMENT_KINDS = ['shape', 'textline', 'picture', 'fallback', 'hotspot'] as const;
export type ElementCounts = Record<(typeof ELEMENT_KINDS)[number], number>;

/**
 * The number of `elements` of each kind: a slide's own elements only. What a tile cell or a soft mask draws (ids
 * `<owner>/z<n>`, `MaskDef.elements`) belongs to the element that owns it and is not counted.
 */
export function elementCounts(elements: readonly Element[]): ElementCounts {
  const counts: ElementCounts = { shape: 0, textline: 0, picture: 0, fallback: 0, hotspot: 0 };
  for (const el of elements) counts[el.kind]++;
  return counts;
}

/** A Note as one line of the sweep: its op name and its fixed words, never deck text (Global Constraints, Privacy). */
export function noteLine(note: Note): string {
  return `${note.op} (${note.detail})`;
}

/** How one slide of `extractScene` (lenient, the default) fared against the oracle. */
export interface SceneOutcome {
  /** 0-based page index. */
  index: number;
  /** `inventoryOfSlide` of the slide equals the oracle's inventory of its page (compareInventories, TOLERANCE_PT). */
  ok: boolean;
  /** compareInventories' diff lines (empty when ok; at most 50 per page section). */
  diffs: string[];
  diffTotal: number;
  /** Paint pairs compared by kind and position only because one side was `approx`. */
  approxPaints: number;
  /** The slide's own elements per kind (`elementCounts`). */
  elements: ElementCounts;
  /** The slide's notes as `noteLine`s, in order. */
  notes: string[];
  /** The slide's `failed`, else null. */
  failed: string | null;
}

/**
 * Every slide of `scene` against `expected`, the oracle inventory of the same file: the inventory the Scene gives back
 * (`inventoryOfSlide`, with the deck's fonts) is compared with its oracle page on its own. The Scene must have converted
 * every page of the file, in order.
 */
export function sceneOutcomes(scene: SceneDeck, expected: Inventory): SceneOutcome[] {
  if (scene.slides.length !== expected.pages.length) {
    throw new Error(`sceneOutcomes: the oracle read ${expected.pages.length} pages, the Scene has ${scene.slides.length} slides`);
  }
  return expected.pages.map((exp, i): SceneOutcome => {
    const slide = scene.slides[i]!;
    if (slide.index !== exp.index) throw new Error(`sceneOutcomes: slide ${i} is page ${slide.index}, the oracle's ${exp.index}`);
    const actual = inventoryOfSlide(slide, scene.fonts);
    const { ok, diffs, diffTotal, approxPaints } = compareInventories({ pages: [exp] }, { pages: [actual] }, TOLERANCE_PT);
    return {
      index: exp.index,
      ok,
      diffs,
      diffTotal,
      approxPaints,
      elements: elementCounts(slide.elements),
      notes: slide.notes.map(noteLine),
      failed: slide.failed,
    };
  });
}

/**
 * Every page of `pdf` as `extractScene` converts it with its default options (lenient, what users get), against the
 * oracle, which runs once for the whole file. For the Scene ratchet (test/corpus/scene-ratchet.corpus.test.ts).
 */
export async function compareScenePdf(pdf: string): Promise<{ bundle: SceneBundle; outcomes: SceneOutcome[] }> {
  const bytes = new Uint8Array(readFileSync(pdf));
  const expected = oracleInventory(pdf);
  const bundle = await extractScene(bytes);
  return { bundle, outcomes: sceneOutcomes(bundle.scene, expected) };
}

/**
 * The name of what was thrown, for a record that must not carry its message (which may hold deck text or a path): the
 * name of its constructor (`TypeError`, `SceneInputError`, ...), an identifier and so a fixed word; `unknown` when it has
 * none (null, undefined, an object without a prototype) or one that is not an identifier.
 */
export function errorName(error: unknown): string {
  let name: unknown;
  try {
    name = (error as { constructor?: { name?: unknown } } | null | undefined)?.constructor?.name;
  } catch {
    name = undefined; // a proxy or a getter that throws
  }
  return typeof name === 'string' && /^[A-Za-z_$][\w$]*$/.test(name) ? name : 'unknown';
}

/**
 * The Scene side of one PDF in the sweep: its deck and the outcome of every page, or what was thrown on the way, with
 * the deck when it was built before the throw (the comparison threw), else null.
 */
export type SceneRun = { deck: SceneDeck; outcomes: SceneOutcome[] } | { threw: string; deck: SceneDeck | null };

/**
 * Runs `extract` (the Scene of one PDF), then `compare` on its deck, so that nothing they throw stops the sweep: an
 * error in `extractScene` (it should throw none: it is lenient), in `sceneOutcomes` or `inventoryOfSlide`, a page-count
 * mismatch, and outcomes for another number of pages than the oracle's `pages` all become
 * `{ threw: errorName(error), deck }`, the deck kept when `extract` built it (so the sweep can still dump it), null
 * when `extract` threw.
 */
export async function sceneRun(
  extract: () => Promise<SceneDeck>,
  compare: (deck: SceneDeck) => SceneOutcome[],
  pages: number,
): Promise<SceneRun> {
  let deck: SceneDeck | null = null;
  try {
    deck = await extract();
    const outcomes = compare(deck);
    if (outcomes.length !== pages) throw new RangeError('sceneRun: Scene outcomes for another number of pages');
    return { deck, outcomes };
  } catch (error) {
    return { threw: errorName(error), deck };
  }
}

/**
 * The walker (as `comparePdf`) and the Scene (as `compareScenePdf`) against one oracle run of `pdf`, for the sweep. What
 * the Scene side throws is caught by `sceneRun` (`scene.threw`): the sweep records it for that PDF and goes on, and the
 * walker's outcomes stay as they are.
 */
export async function comparePdfAndScene(pdf: string): Promise<{ outcomes: PageOutcome[]; scene: SceneRun }> {
  const bytes = new Uint8Array(readFileSync(pdf));
  const expected = oracleInventory(pdf);
  const outcomes = await walkerOutcomes(bytes, expected);
  const scene = await sceneRun(
    async () => (await extractScene(bytes)).scene,
    (deck) => sceneOutcomes(deck, expected),
    expected.pages.length,
  );
  return { outcomes, scene };
}

/** One entry of fidelity/known/oracle-known.json, keyed by "<file>#<page>" (page 1-based). */
export interface KnownEntry {
  reason: string;
  kind: FailureKind;
}

/** How a page fails, for a message: the walker's refusal, or the number of diffs, their kinds and the first lines. */
export function explainOutcome(key: string, outcome: PageOutcome): string {
  if (outcome.unsupported !== null) return `${key}: ${outcome.unsupported}`;
  const kinds = diffKinds(outcome.diffs).join(', ');
  return `${key}: ${outcome.diffTotal} diffs (${kinds}): ${outcome.diffs.slice(0, 5).join(' | ')}`;
}

/**
 * The oracle ratchet's verdict on one page of the committed corpus (test/corpus/oracle-ratchet.corpus.test.ts): null
 * when the page is as the known list says, else why not.
 *
 * - Every page is compared by value: no paint pair may be `approx` (compared by kind and position only). The committed
 *   corpus has none; a page that needs them would need its count pinned here.
 * - A page not in the list (`entry` undefined) must match the oracle.
 * - A listed page must still fail, with the listed kind; a listed page that matches now must leave the list, so the
 *   list only shrinks.
 */
export function ratchetVerdict(key: string, entry: KnownEntry | undefined, outcome: PageOutcome): string | null {
  if (outcome.approxPaints !== 0) {
    return `${key}: ${outcome.approxPaints} paints compared approx (kind and position only); the committed corpus has none`;
  }
  const kind = failureKind(outcome);
  if (entry === undefined) return kind === null ? null : explainOutcome(key, outcome);
  if (kind === null) return `${key} matches the oracle now: remove from oracle-known.json`;
  if (kind !== entry.kind) return `${key} is listed in oracle-known.json as ${entry.kind}; now ${explainOutcome(key, outcome)}`;
  return null;
}

const JSON_STRING = String.raw`"(?:[^"\\]|\\.)*"`;
const PAINT_FIELD = new RegExp(
  String.raw`^page \d+ paint \d+(?:/\d+)? \((fill|stroke|shade|image|pattern) #\d+(?:, expected/actual index)?\): ` +
    String.raw`(?:(?:expected|actual) )?(bbox|rgb|alpha|evenOdd|approx|path|line|ctm|px|stencil|shading|clip|groupAlpha|blend|masked)\b`,
);
const GLYPH_FIELD = new RegExp(
  String.raw`^page \d+ (glyph|invisible) \d+ \((?:${JSON_STRING}|[^)]*)\): (u|x|y|font|type3|size|rgb|alpha|groupAlpha|paint|wmode) `,
);

/**
 * The kind of one compareInventories diff line, for the sweep summary and the known list:
 * `page:index`, `page:size`, `paints:count`, `paints:order`, `<paint kind>:<field>` (bbox, rgb, alpha, evenOdd,
 * approx, path, line, ctm, px, stencil of an image, shading of a shade, clip, groupAlpha, blend, masked), `glyphs:count`,
 * `glyph:<field>` (u, x, y, font, type3, size, rgb, alpha, groupAlpha, paint, wmode),
 * `invisible:count`, `invisible:<field>` (u, x, y, font, type3), `pages:count`; `paints:more` / `glyphs:more` /
 * `invisible:more` for the "N more diffs not listed" line of a section that hit its cap; `other` for anything else.
 */
export function diffKind(line: string): string {
  if (line.startsWith('pages: count')) return 'pages:count';
  let m = /^page \d+: (index|size) /.exec(line);
  if (m) return `page:${m[1]}`;
  m = /^page \d+ (paints|glyphs|invisible): (count|order) /.exec(line);
  if (m) return `${m[1]}:${m[2]}`;
  if (/^page \d+ invisible: expected /.test(line)) return 'invisible:count';
  m = /^page \d+ (paints|glyphs|invisible): \d+ more diffs not listed$/.exec(line);
  if (m) return `${m[1]}:more`;
  m = PAINT_FIELD.exec(line);
  if (m) return `${m[1]}:${m[2]}`;
  m = GLYPH_FIELD.exec(line);
  if (m) return `${m[1]}:${m[2]}`;
  return 'other';
}

/** The distinct diff kinds of a page, sorted. */
export function diffKinds(diffs: string[]): string[] {
  return [...new Set(diffs.map(diffKind))].sort();
}

const opNames = new Map<number, string>();
for (const [name, code] of Object.entries(OPS)) if (!opNames.has(code)) opNames.set(code, name);

/** pdf.js op-name histogram of one page's operator list, keys sorted (the op-list contract). */
export function opHistogram(page: PageData): Record<string, number> {
  const counts = new Map<string, number>();
  for (const code of page.ops.fnArray) {
    const name = opNames.get(code) ?? `unknown_${code}`;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** The op-name histogram of every page, keyed by the 1-based page number. */
export async function pdfOpHistograms(bytes: Uint8Array): Promise<Record<string, Record<string, number>>> {
  const doc = await openDocument(bytes);
  const pages: Record<string, Record<string, number>> = {};
  try {
    for (let i = 0; i < doc.numPages; i++) {
      const page = await loadPage(doc, i);
      try {
        pages[String(i + 1)] = opHistogram(page);
      } finally {
        await releasePage(page);
      }
    }
  } finally {
    await closeDocument(doc);
  }
  return pages;
}
