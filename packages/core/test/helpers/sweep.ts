import { TOLERANCE_PT } from '../../src/extract/inventory';
import { diffKinds, failureKind, type ElementCounts, type PageOutcome, type SceneOutcome, type SceneRun } from './oracle';

/**
 * The records of the oracle sweep (test/sweep/atlas.sweep.test.ts), schema "deckback.oracle-sweep/3" (ruling M1-R65;
 * /2, M2 Task 1: every PDF names its set, and the summary has `bySet`; /3, M2 Task 12: every page has the Scene's result
 * `scene`, and the summary counts them; M2 Task 13, before any /3 file was recorded: the summary lists the sets it
 * skipped, `skipped`), the gate the sweep applies to them (`gateProblems`), the names the committed record may hold
 * (`SWEEP_PDFS`, `recordProblems`; ruling M2-R30) and when it is written (`sweepOutputPaths`).
 */

export const SWEEP_SCHEMA = 'deckback.oracle-sweep/3';

/** A group of PDFs the sweep walks, and whether its result gates (`gate`) or only reports. */
export interface SweepSet {
  name: string;
  /** Under the repository root; the PDFs are `<dir>/*.pdf`. */
  dir: string;
  gate: boolean;
}

/**
 * The sets, in the order the sweep walks them. `atlas` is out/atlas (the atlas in every export variant, and atlas-com,
 * the page-size decks and the probe in `std` and `notags`; `SWEEP_PDFS`), `atlas-win` the Windows-font atlas
 * (out/atlas-win), `producers` PDFs made by other tools (out/producers: not PowerPoint's output, so no gate, only what
 * the walker must survive). A set whose directory is missing or holds no PDF is not swept, with a printed reason: a
 * non-gate set is just skipped, and a gate set fails the run (`gateProblems`).
 */
export const SWEEP_SETS: readonly SweepSet[] = [
  { name: 'atlas', dir: 'out/atlas', gate: true },
  { name: 'atlas-win', dir: 'out/atlas-win', gate: true },
  { name: 'producers', dir: 'out/producers', gate: false },
];

function sweepSet(name: string): SweepSet {
  const set = SWEEP_SETS.find((s) => s.name === name);
  if (set === undefined) throw new Error(`unknown sweep set: ${name}`);
  return set;
}

/** The export variants of harness/atlas/export.py (`VARIANTS`): the full atlas is exported in all of them. */
export const VARIANTS = ['std', 'min', 'notags', 'pdfa', 'hidden', 'msprint'] as const;
/** The variants every other atlas deck is exported in (`--variants std,notags`, harness/README.md "Feature atlas"). */
export const STD_NOTAGS = ['std', 'notags'] as const;
/**
 * The decks of the atlas build that out/atlas holds besides the full atlas: the probe and the page-size decks of
 * harness/atlas/decks.py (`RECIPES`, `SIZE_DECKS`) and the COM supplement of harness/atlas/com_deck.py (`DECK`).
 */
export const ATLAS_DECKS = ['atlas-com', 'probe', 'sizes-43', 'sizes-a4l', 'sizes-a4p', 'sizes-custom'] as const;
/**
 * The pages harness/producers/make_skia.mjs prints (`PAGES`): each committed harness/producers/pages/<page>.html to
 * out/producers/skia-<page>.pdf.
 */
export const SKIA_PAGES = ['gradients', 'transparency', 'clips', 'text', 'patterns', 'images'] as const;

const exportsOf = (deck: string, variants: readonly string[]): string[] => variants.map((v) => `${deck}_${v}.pdf`);

/**
 * Ruling M2-R30: per set, the PDF names that come from committed sources (sorted, as the sweep reads a directory). Only
 * these may be named in the committed record (`recordProblems`), and a gate set must hold every one of them
 * (`gateProblems`), so a partly built out/atlas does not pass. Nothing in out/ decides what is public. The unit tests
 * tie these lists to the sources they come from (export.py, decks.py, com_deck.py, make_skia.mjs, the committed pages).
 */
export const SWEEP_PDFS: Readonly<Record<string, readonly string[]>> = {
  atlas: [...exportsOf('atlas', VARIANTS), ...ATLAS_DECKS.flatMap((deck) => exportsOf(deck, STD_NOTAGS))].sort(),
  'atlas-win': exportsOf('atlas', STD_NOTAGS).sort(),
  producers: SKIA_PAGES.map((page) => `skia-${page}.pdf`).sort(),
};

/** The PDFs `set` must hold if it gates and the only ones its record may name (`SWEEP_PDFS`). */
export function expectedPdfs(set: string): readonly string[] {
  sweepSet(set);
  return SWEEP_PDFS[set] ?? [];
}

/** Whether the committed record may name `file` of `set` (ruling M2-R30). */
export function recordable(set: string, file: string): boolean {
  return expectedPdfs(set).includes(file);
}
/**
 * Diff lines kept per page. `diffCount` has the full number of diffs (compareInventories' `diffTotal`), also those past
 * the 50 lines per page section compareInventories lists.
 */
export const DIFFS_KEPT = 20;

export interface SweepPage {
  /** 0-based page index. */
  index: number;
  ok: boolean;
  diffCount: number;
  /** Paint pairs compared by kind and position only (`approx`), not by value. */
  approxPaints: number;
  /** The first DIFFS_KEPT diff lines. */
  diffs: string[];
  /** The walker's UnsupportedOpError message, or null. */
  unsupported: string | null;
  /** How `extractScene` (lenient, its default) converted the page. */
  scene: SweepScene;
}

/**
 * The Scene's result on one page. `ok`: the inventory the slide gives back (`inventoryOfSlide`) equals the oracle's.
 * `elements`: the slide's own elements per kind, as the Scene goldens count them (a tile cell's or a soft mask's are
 * their owner's). `notes`: its notes as op name and fixed words (`noteLine`). `failed`: the slide's `failed`, or null.
 */
export interface SweepScene {
  ok: boolean;
  elements: ElementCounts;
  notes: string[];
  failed: string | null;
}

/**
 * What every page of a file records when its Scene could not be built or compared (`sceneRun` in helpers/oracle.ts):
 * `extractScene` threw (it should not: it is lenient), or the comparison did. `errorName` is the constructor name of
 * what was thrown (`errorName` in helpers/oracle.ts), never its message, which may hold deck text or a path.
 */
export function sceneThrew(errorName: string): SweepScene {
  if (!/^[A-Za-z_$][\w$]*$/.test(errorName)) throw new Error('sceneThrew: an error name, not a message');
  return {
    ok: false,
    elements: { shape: 0, textline: 0, picture: 0, fallback: 0, hotspot: 0 },
    notes: [`extractScene threw (${errorName})`],
    failed: 'threw',
  };
}

/** A page's SweepScene from its SceneOutcome. */
export function sweepScene(outcome: SceneOutcome): SweepScene {
  return { ok: outcome.ok, elements: { ...outcome.elements }, notes: [...outcome.notes], failed: outcome.failed };
}

/**
 * The Scene results of one PDF of `pages` pages (the oracle's, as the walker's outcomes): its pages' `sweepScene`, or
 * `sceneThrew` on every page when its Scene could not be built or compared (`sceneRun`), and as `sceneRun` does,
 * `sceneThrew('RangeError')` for outcomes of another number of pages, so that the sweep never stops on it.
 */
export function sweepScenes(run: SceneRun, pages: number): SweepScene[] {
  const threw = (name: string) => Array.from({ length: pages }, () => sceneThrew(name));
  if ('threw' in run) return threw(run.threw);
  if (run.outcomes.length !== pages) return threw('RangeError');
  return run.outcomes.map(sweepScene);
}

export interface SweepPdf {
  /** The public file name, without any directory (the same name can be in two sets: atlas_std.pdf). */
  file: string;
  /** The SWEEP_SETS name of the directory the PDF was in. */
  set: string;
  /** The export variant of a `<stem>_<variant>.pdf` name; null for a file with no known variant suffix. */
  variant: string | null;
  pages: SweepPage[];
}

export interface SweepSummary {
  pages: number;
  ok: number;
  /** Pages the walker refused (UnsupportedOpError). */
  unsupported: number;
  /** Pages walked whose inventory differs from the oracle's. */
  diff: number;
  /** Paint pairs compared by kind and position only (`approx`), over every page. */
  approxPaints: number;
  /** Refused pages per operator and detail ("constructPath (stroke with a tiling pattern)"), most frequent first. */
  unsupportedOps: Record<string, number>;
  /**
   * Differing pages per diff kind (a page counts once per kind it shows), most frequent first. The kinds come from the
   * lines compareInventories lists (at most 50 per page section); a section past that cap adds `paints:more` or
   * `glyphs:more`, so a kind that shows only past the cap is not seen.
   */
  diffKinds: Record<string, number>;
  /** Pages whose Scene inventory equals the oracle's (`scene.ok`). */
  sceneOk: number;
  /** Fallback elements, the slides' own (`scene.elements.fallback`; one in a tile cell or a soft mask shows as its note). */
  fallbacks: number;
  /** Notes, over every slide. */
  notes: number;
  /** Slides with `failed`. */
  failed: number;
}

/** One set's totals: the summary over its pages, and whether the set gates. */
export interface SweepSetSummary extends SweepSummary {
  gate: boolean;
}

/**
 * The summary of a sweep file: the totals over every page of every set, the same per set that was swept (`bySet`), and
 * the sets that were not, as their directory was missing or held no PDF (`skipped`, in SWEEP_SETS order). Every set of
 * SWEEP_SETS is in exactly one of the two.
 */
export interface SweepResultSummary extends SweepSummary {
  bySet: Record<string, SweepSetSummary>;
  skipped: string[];
}

/** The engines a sweep compared: pdf.js (the walker's), PyMuPDF and its MuPDF (the oracle's). */
export interface EngineVersions {
  pdfjs: string;
  pymupdf: string;
  mupdf: string;
}

/**
 * The sweep file, out/sweep/<date>-oracle-sweep.json, and with DECKBACK_SWEEP_RECORD=1 also the committed
 * fidelity/results/<date>-oracle-sweep.json (`sweepOutputPaths`).
 */
export interface SweepResult {
  schema: typeof SWEEP_SCHEMA;
  date: string;
  /** The comparison's position tolerance (pt). */
  tolerancePt: number;
  engines: EngineVersions;
  pdfs: SweepPdf[];
  summary: SweepResultSummary;
}

/**
 * The PDFs of one set and every page outcome of them, as the sweep collects them: `outcomes` the walker's, page for page
 * as in `pdfs` (whose pages hold the Scene's results).
 */
export interface SweepSetRun {
  /** A SWEEP_SETS name. */
  set: string;
  pdfs: SweepPdf[];
  outcomes: PageOutcome[];
}

/** `<stem>_<variant>.pdf` -> the export variant, or null for a file not named that way. */
export function variantOf(file: string): string | null {
  const m = /_([a-z]+)\.pdf$/i.exec(file);
  const variant = m?.[1]?.toLowerCase();
  return variant !== undefined && (VARIANTS as readonly string[]).includes(variant) ? variant : null;
}

/**
 * The group of a refused page: the UnsupportedOpError message without its "walker: unsupported operator " prefix,
 * i.e. the operator and the detail together (ruling M1-R12: errors are grouped by op AND detail).
 */
export function unsupportedGroup(message: string): string {
  return message.replace(/^walker: unsupported operator /, '');
}

/**
 * The record of one PDF: the walker's outcome of every page and, page for page, the Scene's result (`sweepScene`, or
 * `sceneThrew` for every page when the Scene of the file could not be built or compared).
 */
export function sweepPdf(file: string, outcomes: PageOutcome[], set: string, scenes: readonly SweepScene[]): SweepPdf {
  if (file.includes('/') || file.includes('\\')) throw new Error('sweepPdf: a file name, not a path');
  sweepSet(set);
  if (scenes.length !== outcomes.length) {
    throw new Error(`sweepPdf: ${outcomes.length} walker outcomes but ${scenes.length} Scene results`);
  }
  return {
    file,
    set,
    variant: variantOf(file),
    pages: outcomes.map((o, i) => ({
      index: o.index,
      ok: o.ok,
      diffCount: o.diffTotal,
      approxPaints: o.approxPaints,
      diffs: o.diffs.slice(0, DIFFS_KEPT),
      unsupported: o.unsupported,
      scene: scenes[i]!,
    })),
  };
}

const byCount = (counts: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...counts].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : a > b ? 1 : 0)));

/**
 * The summary over every page of every PDF, from the walker's outcomes and, page for page, the Scene's results;
 * `diffKinds` uses every line compareInventories listed, not only the DIFFS_KEPT a page record keeps.
 */
export function sweepSummary(outcomes: PageOutcome[], scenes: readonly SweepScene[]): SweepSummary {
  if (scenes.length !== outcomes.length) {
    throw new Error(`sweepSummary: ${outcomes.length} walker outcomes but ${scenes.length} Scene results`);
  }
  const ops = new Map<string, number>();
  const kinds = new Map<string, number>();
  let ok = 0;
  let unsupported = 0;
  let diff = 0;
  let approxPaints = 0;
  for (const outcome of outcomes) {
    approxPaints += outcome.approxPaints;
    const kind = failureKind(outcome);
    if (kind === null) {
      ok++;
    } else if (kind === 'unsupported-op') {
      unsupported++;
      const group = unsupportedGroup(outcome.unsupported!);
      ops.set(group, (ops.get(group) ?? 0) + 1);
    } else {
      diff++;
      for (const k of diffKinds(outcome.diffs)) kinds.set(k, (kinds.get(k) ?? 0) + 1);
    }
  }
  let sceneOk = 0;
  let fallbacks = 0;
  let notes = 0;
  let failed = 0;
  for (const scene of scenes) {
    if (scene.ok) sceneOk++;
    fallbacks += scene.elements.fallback;
    notes += scene.notes.length;
    if (scene.failed !== null) failed++;
  }
  return {
    pages: outcomes.length,
    ok,
    unsupported,
    diff,
    approxPaints,
    unsupportedOps: byCount(ops),
    diffKinds: byCount(kinds),
    sceneOk,
    fallbacks,
    notes,
    failed,
  };
}

/** The Scene results of every page of `pdfs`, in order. */
const scenesOf = (pdfs: readonly SweepPdf[]): SweepScene[] => pdfs.flatMap((pdf) => pdf.pages.map((page) => page.scene));

/**
 * The whole sweep file: the PDF records of every set, and the summary over every page of every PDF with `bySet`, the
 * same numbers per set and its `gate`. A set that was skipped (no run) is not in `bySet` but in `skipped`.
 */
export function sweepResult(date: string, engines: EngineVersions, runs: SweepSetRun[]): SweepResult {
  const bySet: Record<string, SweepSetSummary> = {};
  for (const run of runs) {
    const { gate } = sweepSet(run.set);
    if (run.set in bySet) throw new Error(`sweepResult: set ${run.set} given more than once`);
    for (const pdf of run.pdfs) {
      if (pdf.set !== run.set) throw new Error(`sweepResult: ${pdf.file} belongs to set ${pdf.set}, not ${run.set}`);
    }
    bySet[run.set] = { gate, ...sweepSummary(run.outcomes, scenesOf(run.pdfs)) };
  }
  const outcomes = runs.flatMap((run) => run.outcomes);
  const scenes = runs.flatMap((run) => scenesOf(run.pdfs));
  const skipped = SWEEP_SETS.filter((set) => !(set.name in bySet)).map((set) => set.name);
  return {
    schema: SWEEP_SCHEMA,
    date,
    tolerancePt: TOLERANCE_PT,
    engines,
    pdfs: runs.flatMap((run) => run.pdfs),
    summary: { ...sweepSummary(outcomes, scenes), bySet, skipped },
  };
}

/** What `gateProblems` and `recordProblems` read of a sweep's PDFs: which file of which set. */
export interface SweepFiles {
  pdfs: readonly Pick<SweepPdf, 'file' | 'set'>[];
}

/**
 * Why the sweep's gate fails, or nothing when it passes: read from `bySet` per set, never from the totals, which add
 * the sets that do not gate. Every set SWEEP_SETS marks as a gate must have been swept (a gate set that was skipped,
 * its directory missing or empty, fails it) and hold every PDF `SWEEP_PDFS` expects of it (ruling M2-R30: a partly
 * built set fails), and every one of its pages must match the oracle as the walker walks it (`ok`) and as the Scene
 * gives it back (`sceneOk`), with no page the walker refused (`unsupported`), no slide `failed`, no fallback element
 * and no note (ruling M2-R17), and no paint pair compared by kind and position only (`approxPaints`, ruling M2-R33:
 * a text-clip box is approximate, and exact ones wait only while the gate sets have none). Whether a set gates is
 * SWEEP_SETS' say, not the record's `gate`. A missing PDF is named: its name is one of the committed list's.
 */
export function gateProblems(result: SweepFiles & { summary: Pick<SweepResultSummary, 'bySet'> }): string[] {
  const problems: string[] = [];
  for (const set of SWEEP_SETS.filter((s) => s.gate)) {
    const { bySet } = result.summary;
    const counts = Object.hasOwn(bySet, set.name) ? bySet[set.name] : undefined;
    const gate = `${set.name} (a gate)`;
    if (counts === undefined) {
      problems.push(`${gate} was not swept: no PDF in ${set.dir}`);
      continue;
    }
    const present = new Set(result.pdfs.filter((pdf) => pdf.set === set.name).map((pdf) => pdf.file));
    const expected = expectedPdfs(set.name);
    const missing = expected.filter((file) => !present.has(file));
    if (missing.length > 0) {
      const lacks = `${gate} lacks ${missing.length} of the ${expected.length} PDFs it must hold`;
      problems.push(`${lacks}: ${missing.join(', ')}`);
    }
    const { pages, ok, sceneOk, unsupported, failed, fallbacks, notes, approxPaints } = counts;
    if (pages === 0) problems.push(`${gate} has no page`);
    if (ok !== pages) problems.push(`${gate}: ${pages - ok} of ${pages} pages do not match the oracle as walked`);
    if (sceneOk !== pages) {
      problems.push(`${gate}: ${pages - sceneOk} of ${pages} pages whose Scene does not match the oracle`);
    }
    if (unsupported !== 0) problems.push(`${gate}: ${unsupported} pages the walker refused`);
    if (failed !== 0) problems.push(`${gate}: ${failed} slides failed`);
    if (fallbacks !== 0) problems.push(`${gate}: ${fallbacks} fallback elements`);
    if (notes !== 0) problems.push(`${gate}: ${notes} notes`);
    if (approxPaints !== 0) problems.push(`${gate}: ${approxPaints} approx paints (compared by kind and position only)`);
  }
  return problems;
}

/**
 * Why the committed record may not be written for these PDFs (ruling M2-R30), or nothing: per set, how many PDFs have
 * a name that does not come from a committed source (`recordable`). The message gives the set and the count, never a
 * name, which may be a private file's; only a sweep that does not record may print the names, and only to the console.
 */
export function recordProblems(result: SweepFiles): string[] {
  const problems: string[] = [];
  for (const set of SWEEP_SETS) {
    const refused = result.pdfs.filter((pdf) => pdf.set === set.name && !recordable(set.name, pdf.file)).length;
    if (refused > 0) {
      const pdfs = `${set.name}: ${refused} PDF${refused === 1 ? '' : 's'} whose name no committed source gives`;
      problems.push(`${pdfs} (ruling M2-R30); the committed record is not written`);
    }
  }
  return problems;
}

/**
 * Every reason not to write the committed record: the gate's (`gateProblems`), then the record's (`recordProblems`).
 * The sweep passes it to `sweepOutputPaths`; one function, so that the unit tests test the sweep's own wiring.
 */
export function recordBlockers(result: SweepFiles & { summary: Pick<SweepResultSummary, 'bySet'> }): string[] {
  return [...gateProblems(result), ...recordProblems(result)];
}

/**
 * Where the sweep file goes, relative to the repository root: always out/sweep/<date>-oracle-sweep.json (git-ignored),
 * so a failing run still leaves its local record; the committed fidelity/results/<date>-oracle-sweep.json only with
 * DECKBACK_SWEEP_RECORD=1 and no `problems` (`recordBlockers`: the gate's and the record's). A failing or partial run
 * never writes, nor overwrites, the committed record.
 */
export function sweepOutputPaths(
  date: string,
  env: Record<string, string | undefined>,
  problems: readonly string[],
): string[] {
  const name = `${date}-oracle-sweep.json`;
  const local = `out/sweep/${name}`;
  return env['DECKBACK_SWEEP_RECORD'] === '1' && problems.length === 0 ? [local, `fidelity/results/${name}`] : [local];
}

/**
 * Where `DECKBACK_DUMP_SCENE=1` has the sweep write the Scene JSON of a PDF of a sweep set, for debugging, relative to the
 * repository root: out/scene/<set>/<stem>.scene.json, git-ignored as all of out/; null without it. Only the sweep's own
 * sets, which are public, and a bare file name; never anything under fidelity/, as no Scene JSON is committed.
 */
export function sceneDumpPath(set: string, file: string, env: Record<string, string | undefined>): string | null {
  if (file.includes('/') || file.includes('\\')) throw new Error('sceneDumpPath: a file name, not a path');
  sweepSet(set);
  if (env['DECKBACK_DUMP_SCENE'] !== '1') return null;
  return `out/scene/${set}/${file.replace(/\.pdf$/i, '')}.scene.json`;
}

/** Today's local date, YYYY-MM-DD (as harness/fidelity/run.py dates its results). */
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
