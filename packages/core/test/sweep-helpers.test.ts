import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TOLERANCE_PT } from '../src/extract/inventory';
import type { Element, SceneDeck } from '../src/scene/types';
import { repoRoot } from './helpers/fixtures';
import { elementCounts, errorName, noteLine, sceneRun, type PageOutcome, type SceneOutcome } from './helpers/oracle';
import {
  ATLAS_DECKS,
  expectedPdfs,
  gateProblems,
  localDate,
  recordable,
  recordBlockers,
  recordProblems,
  sceneDumpPath,
  sceneThrew,
  SKIA_PAGES,
  STD_NOTAGS,
  SWEEP_PDFS,
  SWEEP_SCHEMA,
  SWEEP_SETS,
  sweepOutputPaths,
  sweepPdf,
  sweepResult,
  sweepScene,
  sweepScenes,
  sweepSummary,
  unsupportedGroup,
  VARIANTS,
  variantOf,
  type SweepResult,
  type SweepScene,
  type SweepSetRun,
} from './helpers/sweep';

/** The records and summary of the oracle sweep (test/sweep/atlas.sweep.test.ts), on synthetic page outcomes. */

const ok = (index: number, approxPaints = 0): PageOutcome => ({
  index,
  ok: true,
  diffs: [],
  diffTotal: 0,
  approxPaints,
  unsupported: null,
  unsupportedOp: null,
});
const refused = (index: number, op: string, detail?: string): PageOutcome => ({
  index,
  ok: false,
  diffs: [],
  diffTotal: 0,
  approxPaints: 0,
  unsupported: `walker: unsupported operator ${op}${detail === undefined ? '' : ` (${detail})`}`,
  unsupportedOp: op,
});
const differs = (index: number, diffs: string[], diffTotal = diffs.length): PageOutcome => ({
  index,
  ok: false,
  diffs,
  diffTotal,
  approxPaints: 0,
  unsupported: null,
  unsupportedOp: null,
});

/** A Scene result: ok with no element unless given. */
const scene = (over: Partial<SweepScene> = {}): SweepScene => ({
  ok: true,
  elements: { shape: 0, textline: 0, picture: 0, fallback: 0, hotspot: 0 },
  notes: [],
  failed: null,
  ...over,
});
/** A Scene result for each outcome: ok where the walker is. */
const scenesFor = (outcomes: PageOutcome[]): SweepScene[] => outcomes.map((o) => scene({ ok: o.ok }));
/** A fallback where the walker refused, with its note. */
const NOTE = 'setCharWidth (operator the walker does not model)';
const withFallback = (n = 1): SweepScene =>
  scene({ ok: false, elements: { shape: 2, textline: 0, picture: 0, fallback: n, hotspot: 0 }, notes: Array<string>(n).fill(NOTE) });

const BBOX = (i: number) => `page 0 paint ${i} (fill #${i}): bbox expected [0,0,1,1] got [0,0,2,1] (max |delta| 1 > 0.05)`;
const GLYPHS = 'page 0 glyphs: count expected 3 got 2 (whitespace excluded)';

describe('variantOf', () => {
  it('reads the export variant from <stem>_<variant>.pdf', () => {
    expect(variantOf('atlas_std.pdf')).toBe('std');
    expect(variantOf('atlas_msprint.pdf')).toBe('msprint');
    expect(variantOf('atlas-smoke_notags.pdf')).toBe('notags');
    expect(variantOf('atlas_HIDDEN.PDF')).toBe('hidden');
    expect(variantOf('atlas_other.pdf')).toBeNull();
    expect(variantOf('atlas.pdf')).toBeNull();
  });

  it('gives null to a file with no known variant suffix, as the producers set has (M2 plan, Task 1)', () => {
    expect(variantOf('skia-gradients.pdf')).toBeNull();
    expect(variantOf('skia-text_vertical.pdf')).toBeNull();
    expect(variantOf('browser-export_v2.pdf')).toBeNull();
  });
});

describe('SWEEP_SETS', () => {
  it('has the atlas and the Windows-font atlas as gates and the other producers as no gate', () => {
    expect(SWEEP_SETS).toEqual([
      { name: 'atlas', dir: 'out/atlas', gate: true },
      { name: 'atlas-win', dir: 'out/atlas-win', gate: true },
      { name: 'producers', dir: 'out/producers', gate: false },
    ]);
  });
});

describe('unsupportedGroup', () => {
  it('keeps the operator and the detail (ruling M1-R12)', () => {
    expect(unsupportedGroup('walker: unsupported operator constructPath (stroke with a tiling pattern)')).toBe(
      'constructPath (stroke with a tiling pattern)',
    );
    expect(unsupportedGroup('walker: unsupported operator paintXObject')).toBe('paintXObject');
  });
});

describe('sweepPdf', () => {
  it('keeps the first 20 diff lines, the full count and the refusal message', () => {
    const lines = Array.from({ length: 25 }, (_, i) => BBOX(i));
    const outcomes = [ok(0), differs(1, lines), refused(2, 'setGState', 'key TR')];
    const record = sweepPdf('atlas_pdfa.pdf', outcomes, 'atlas', scenesFor(outcomes));
    expect(record.file).toBe('atlas_pdfa.pdf');
    expect(record.set).toBe('atlas');
    expect(record.variant).toBe('pdfa');
    expect(record.pages[0]).toEqual({ index: 0, ok: true, diffCount: 0, approxPaints: 0, diffs: [], unsupported: null, scene: scene() });
    expect(record.pages[1]!.diffCount).toBe(25);
    expect(record.pages[1]!.diffs).toEqual(lines.slice(0, 20));
    expect(record.pages[2]).toEqual({
      index: 2,
      ok: false,
      diffCount: 0,
      approxPaints: 0,
      diffs: [],
      unsupported: 'walker: unsupported operator setGState (key TR)',
      scene: scene({ ok: false }),
    });
  });

  it('records the full diff count, also past the lines compareInventories lists, and the approx paints', () => {
    const lines = Array.from({ length: 51 }, (_, i) => BBOX(i));
    const outcomes = [differs(0, lines, 130), ok(1, 3)];
    const record = sweepPdf('atlas_std.pdf', outcomes, 'atlas-win', scenesFor(outcomes));
    expect(record.set).toBe('atlas-win');
    expect(record.pages[0]!.diffCount).toBe(130);
    expect(record.pages[0]!.diffs).toEqual(lines.slice(0, 20));
    expect(record.pages[1]!.approxPaints).toBe(3);
  });

  it('keeps the bare file name and a null variant for a file with no known variant suffix', () => {
    const record = sweepPdf('skia-gradients.pdf', [ok(0)], 'producers', [scene()]);
    expect(record.file).toBe('skia-gradients.pdf');
    expect(record.variant).toBeNull();
    expect(record.set).toBe('producers');
  });

  it('refuses a path: results name public atlas files only', () => {
    expect(() => sweepPdf('out/atlas/atlas_std.pdf', [], 'atlas', [])).toThrow(/a file name, not a path/);
    expect(() => sweepPdf('C:\\x\\atlas_std.pdf', [], 'atlas', [])).toThrow(/a file name, not a path/);
  });

  it('refuses a set the sweep does not know', () => {
    expect(() => sweepPdf('atlas_std.pdf', [], 'private', [])).toThrow(/unknown sweep set/);
  });

  it("puts the Scene's result on each page, page for page, and refuses a Scene result too many or too few", () => {
    const outcomes = [ok(0), refused(1, 'setCharWidth')];
    const scenes = [scene({ elements: { shape: 3, textline: 2, picture: 1, fallback: 0, hotspot: 1 } }), withFallback()];
    const record = sweepPdf('skia-text.pdf', outcomes, 'producers', scenes);
    expect(record.pages.map((p) => p.scene)).toEqual(scenes);
    expect(Object.keys(record.pages[0]!)).toEqual(['index', 'ok', 'diffCount', 'approxPaints', 'diffs', 'unsupported', 'scene']);
    expect(() => sweepPdf('skia-text.pdf', outcomes, 'producers', [scene()])).toThrow(/2 walker outcomes but 1 Scene results/);
    expect(() => sweepPdf('skia-text.pdf', [ok(0)], 'producers', [scene(), scene()])).toThrow(/1 walker outcomes but 2 Scene results/);
  });
});

describe('sweepScene, sceneThrew, elementCounts and noteLine', () => {
  const outcome: SceneOutcome = {
    index: 3,
    ok: false,
    diffs: [BBOX(0)],
    diffTotal: 1,
    approxPaints: 0,
    elements: { shape: 4, textline: 1, picture: 0, fallback: 1, hotspot: 2 },
    notes: [NOTE],
    failed: null,
  };

  it("a page's Scene result is ok, the slide's own element counts, its notes and failed", () => {
    expect(sweepScene(outcome)).toEqual({
      ok: false,
      elements: { shape: 4, textline: 1, picture: 0, fallback: 1, hotspot: 2 },
      notes: [NOTE],
      failed: null,
    });
    expect(Object.keys(sweepScene(outcome))).toEqual(['ok', 'elements', 'notes', 'failed']);
    // A copy: the record does not share the outcome's arrays and objects.
    expect(sweepScene(outcome).notes).not.toBe(outcome.notes);
    expect(sweepScene(outcome).elements).not.toBe(outcome.elements);
  });

  it('a file whose Scene threw: not ok, no element, one note with the error name only, and failed "threw"', () => {
    expect(sceneThrew('TypeError')).toEqual({
      ok: false,
      elements: { shape: 0, textline: 0, picture: 0, fallback: 0, hotspot: 0 },
      notes: ['extractScene threw (TypeError)'],
      failed: 'threw',
    });
    expect(sceneThrew('SceneInputError').notes).toEqual(['extractScene threw (SceneInputError)']);
    expect(sceneThrew('TypeError')).not.toBe(sceneThrew('TypeError'));
    // A message is no name: it could carry deck text or a path.
    for (const message of ['', 'cannot read C:\\deck.pdf', 'Type Error', 'x(1)']) {
      expect(() => sceneThrew(message), message).toThrow('sceneThrew: an error name, not a message');
    }
  });

  it("elementCounts counts a slide's own elements by kind; noteLine is the op name and the fixed words", () => {
    const el = (kind: string) => ({ kind }) as unknown as Element;
    expect(elementCounts([el('shape'), el('shape'), el('textline'), el('hotspot'), el('fallback'), el('picture')])).toEqual({
      shape: 2,
      textline: 1,
      picture: 1,
      fallback: 1,
      hotspot: 1,
    });
    expect(elementCounts([])).toEqual({ shape: 0, textline: 0, picture: 0, fallback: 0, hotspot: 0 });
    expect(noteLine({ opIndex: 7, op: 'setCharWidth', detail: 'operator the walker does not model in a tile cell' })).toBe(
      'setCharWidth (operator the walker does not model in a tile cell)',
    );
  });
});

describe('sceneRun, errorName and sweepScenes: what the Scene side throws never stops the sweep', () => {
  const outcome = (index: number): SceneOutcome => ({
    index,
    ok: true,
    diffs: [],
    diffTotal: 0,
    approxPaints: 0,
    elements: { shape: 1, textline: 0, picture: 0, fallback: 0, hotspot: 0 },
    notes: [],
    failed: null,
  });
  const deck = { slides: [] } as unknown as SceneDeck;
  class SceneInputError extends Error {}

  const built = async () => deck;
  const compared = (n: number) => () => Array.from({ length: n }, (_, i) => outcome(i));

  it('passes a Scene and its outcomes through', async () => {
    const run = await sceneRun(built, compared(2), 2);
    expect(run).toEqual({ deck, outcomes: [outcome(0), outcome(1)] });
    expect(sweepScenes(run, 2)).toEqual([sweepScene(outcome(0)), sweepScene(outcome(1))]);
  });

  it('a stub that throws, in extractScene or in the comparison, gives the constructor name and never the message', async () => {
    const secret = 'SECRET deck text at C:\\private\\deck.pdf';
    const throwing = (error: unknown) => async (): Promise<never> => {
      throw error;
    };
    const early = (error: unknown) => sceneRun(throwing(error), compared(3), 3);
    expect(await early(new TypeError(secret))).toEqual({ threw: 'TypeError', deck: null });
    expect(await early(new SceneInputError(secret))).toEqual({ threw: 'SceneInputError', deck: null });
    expect(await early(new Error(secret))).toEqual({ threw: 'Error', deck: null });
    // As sceneOutcomes and inventoryOfSlide throw: after the Scene was built.
    const late = await sceneRun(
      built,
      () => {
        throw new RangeError(secret);
      },
      1,
    );
    expect(late).toEqual({ threw: 'RangeError', deck });
    const scenes = sweepScenes(late, 3);
    expect(scenes).toEqual([sceneThrew('RangeError'), sceneThrew('RangeError'), sceneThrew('RangeError')]);
    expect(JSON.stringify(scenes)).not.toMatch(/SECRET|private/);
  });

  it('keeps the Scene when only its comparison threw, so the sweep can still dump it (Task 12 minor)', async () => {
    const late = await sceneRun(
      built,
      () => {
        throw new TypeError('in inventoryOfSlide');
      },
      2,
    );
    expect('threw' in late && late.deck).toBe(deck);
    // ... and has none when extractScene itself threw.
    const early = await sceneRun(async () => Promise.reject(new TypeError('in extractScene')), compared(2), 2);
    expect(early).toEqual({ threw: 'TypeError', deck: null });
  });

  it('outcomes for another number of pages than the oracle read are a RangeError, not a stop', async () => {
    expect(await sceneRun(built, compared(1), 2)).toEqual({ threw: 'RangeError', deck });
    expect(sweepScenes({ deck, outcomes: [outcome(0)] }, 2)).toEqual([sceneThrew('RangeError'), sceneThrew('RangeError')]);
  });

  it('errorName is the constructor name, or unknown when there is none that is an identifier', () => {
    expect(errorName(new TypeError('x'))).toBe('TypeError');
    expect(errorName(new SceneInputError('x'))).toBe('SceneInputError');
    expect(errorName('a thrown string')).toBe('String');
    expect(errorName(42)).toBe('Number');
    expect(errorName(null)).toBe('unknown');
    expect(errorName(undefined)).toBe('unknown');
    expect(errorName(Object.create(null))).toBe('unknown');
    expect(errorName({ constructor: { name: 'not a name' } })).toBe('unknown');
    const hostile = new Proxy({}, { get: () => { throw new Error('no'); } });
    expect(errorName(hostile)).toBe('unknown');
  });

  it('the walker outcomes of a PDF whose Scene threw stay as they are in its record', () => {
    const outcomes = [ok(0), refused(1, 'setCharWidth')];
    const scenes = sweepScenes({ threw: 'TypeError', deck: null }, outcomes.length);
    const record = sweepPdf('skia-text.pdf', outcomes, 'producers', scenes);
    expect(record.pages.map((p) => [p.ok, p.unsupported])).toEqual([
      [true, null],
      [false, 'walker: unsupported operator setCharWidth'],
    ]);
    expect(record.pages.map((p) => p.scene)).toEqual([sceneThrew('TypeError'), sceneThrew('TypeError')]);
  });
});

describe('sweepSummary', () => {
  it('counts pages, refusals per operator and detail, and differing pages per diff kind', () => {
    const outcomes = [
      ok(0),
      ok(1),
      refused(2, 'constructPath', 'stroke with a tiling pattern'),
      refused(3, 'constructPath', 'stroke with a tiling pattern'),
      refused(4, 'showText', 'vertical writing'),
      differs(5, [BBOX(0), BBOX(1), GLYPHS]), // bbox twice on one page: one page
      differs(6, [BBOX(0)]),
      differs(7, Array.from({ length: 30 }, (_, i) => (i < 25 ? BBOX(i) : GLYPHS))), // kinds from all lines, not the kept 20
      ok(8, 2),
    ];
    const summary = sweepSummary(outcomes, scenesFor(outcomes));
    expect(summary).toEqual({
      pages: 9,
      ok: 3,
      unsupported: 3,
      diff: 3,
      approxPaints: 2,
      unsupportedOps: { 'constructPath (stroke with a tiling pattern)': 2, 'showText (vertical writing)': 1 },
      diffKinds: { 'fill:bbox': 3, 'glyphs:count': 2 },
      sceneOk: 3,
      fallbacks: 0,
      notes: 0,
      failed: 0,
    });
    expect(Object.keys(summary.unsupportedOps)).toEqual([
      'constructPath (stroke with a tiling pattern)',
      'showText (vertical writing)',
    ]);
  });

  it('counts the pages whose Scene matches, the fallback elements, the notes and the failed slides', () => {
    const outcomes = [ok(0), ok(1), refused(2, 'setCharWidth'), refused(3, 'setCharWidth'), ok(4), ok(5)];
    const scenes = [
      scene(),
      scene({ elements: { shape: 9, textline: 3, picture: 2, fallback: 0, hotspot: 4 } }),
      withFallback(),
      withFallback(3),
      scene({ ok: false, failed: 'slide-unbuildable' }),
      sceneThrew('TypeError'),
    ];
    expect(sweepSummary(outcomes, scenes)).toMatchObject({ pages: 6, ok: 4, sceneOk: 2, fallbacks: 4, notes: 5, failed: 2 });
  });

  it('refuses a Scene result too many or too few', () => {
    expect(() => sweepSummary([ok(0)], [])).toThrow(/1 walker outcomes but 0 Scene results/);
  });

  it('is all zero and empty for no pages', () => {
    expect(sweepSummary([], [])).toEqual({
      pages: 0,
      ok: 0,
      unsupported: 0,
      diff: 0,
      approxPaints: 0,
      unsupportedOps: {},
      diffKinds: {},
      sceneOk: 0,
      fallbacks: 0,
      notes: 0,
      failed: 0,
    });
  });
});

describe('sweepResult', () => {
  const engines = { pdfjs: '6.5.438', pymupdf: '2.1', mupdf: '1.28.6' };
  const atlas = [ok(0), differs(1, [BBOX(0)]), refused(2, 'constructPath', 'stroke with a tiling pattern')];
  const atlasScenes = [scene(), scene({ ok: false }), scene({ ok: false })];
  const win = [ok(0), ok(1, 2)];
  const winScenes = [scene(), scene({ ok: false })];
  const producers = [refused(0, 'paintXObject'), differs(1, [BBOX(0), GLYPHS]), ok(2)];
  const producerScenes = [withFallback(2), scene({ ok: false, failed: 'slide-unbuildable' }), scene()];
  const run = (set: string, file: string, outcomes: PageOutcome[], scenes: SweepScene[]) => ({
    set,
    pdfs: [sweepPdf(file, outcomes, set, scenes)],
    outcomes,
  });

  it('records the schema /3, the date, the comparison tolerance, the engine versions, the PDFs and the summary', () => {
    expect(SWEEP_SCHEMA).toBe('deckback.oracle-sweep/3');
    const result = sweepResult('2026-11-09', engines, [run('atlas', 'atlas_std.pdf', atlas, atlasScenes)]);
    expect(result).toEqual({
      schema: SWEEP_SCHEMA,
      date: '2026-11-09',
      tolerancePt: TOLERANCE_PT,
      engines,
      pdfs: [sweepPdf('atlas_std.pdf', atlas, 'atlas', atlasScenes)],
      summary: {
        ...sweepSummary(atlas, atlasScenes),
        bySet: { atlas: { gate: true, ...sweepSummary(atlas, atlasScenes) } },
        skipped: ['atlas-win', 'producers'],
      },
    });
    expect(Object.keys(result)).toEqual(['schema', 'date', 'tolerancePt', 'engines', 'pdfs', 'summary']);
  });

  it('lists the sets it did not sweep in skipped, in SWEEP_SETS order: every set is in bySet or in skipped', () => {
    const all = sweepResult('2026-11-09', engines, [
      run('atlas', 'atlas_std.pdf', atlas, atlasScenes),
      run('atlas-win', 'atlas_notags.pdf', win, winScenes),
      run('producers', 'skia-gradients.pdf', producers, producerScenes),
    ]);
    expect(all.summary.skipped).toEqual([]);
    const noWin = sweepResult('2026-11-09', engines, [
      run('producers', 'skia-gradients.pdf', producers, producerScenes),
      run('atlas', 'atlas_std.pdf', atlas, atlasScenes),
    ]);
    expect(noWin.summary.skipped).toEqual(['atlas-win']);
    const accounted = [...Object.keys(noWin.summary.bySet), ...noWin.summary.skipped];
    expect(accounted.sort()).toEqual(SWEEP_SETS.map((s) => s.name).sort());
    expect(Object.keys(noWin.summary).slice(-2)).toEqual(['bySet', 'skipped']);
  });

  it('fills bySet per set, with the Scene counts, and marks producers as no gate', () => {
    const result = sweepResult('2026-11-09', engines, [
      run('atlas', 'atlas_std.pdf', atlas, atlasScenes),
      run('atlas-win', 'atlas_notags.pdf', win, winScenes),
      run('producers', 'skia-gradients.pdf', producers, producerScenes),
    ]);
    expect(Object.keys(result.summary.bySet)).toEqual(['atlas', 'atlas-win', 'producers']);
    expect(result.summary.bySet['atlas']).toEqual({
      gate: true,
      pages: 3,
      ok: 1,
      unsupported: 1,
      diff: 1,
      approxPaints: 0,
      unsupportedOps: { 'constructPath (stroke with a tiling pattern)': 1 },
      diffKinds: { 'fill:bbox': 1 },
      sceneOk: 1,
      fallbacks: 0,
      notes: 0,
      failed: 0,
    });
    expect(result.summary.bySet['atlas-win']).toEqual({
      gate: true,
      pages: 2,
      ok: 2,
      unsupported: 0,
      diff: 0,
      approxPaints: 2,
      unsupportedOps: {},
      diffKinds: {},
      sceneOk: 1,
      fallbacks: 0,
      notes: 0,
      failed: 0,
    });
    expect(result.summary.bySet['producers']).toEqual({
      gate: false,
      pages: 3,
      ok: 1,
      unsupported: 1,
      diff: 1,
      approxPaints: 0,
      unsupportedOps: { paintXObject: 1 },
      diffKinds: { 'fill:bbox': 1, 'glyphs:count': 1 },
      sceneOk: 1,
      fallbacks: 2,
      notes: 2,
      failed: 1,
    });
    expect(Object.keys(result.summary.bySet['atlas']!)).toEqual([
      'gate',
      'pages',
      'ok',
      'unsupported',
      'diff',
      'approxPaints',
      'unsupportedOps',
      'diffKinds',
      'sceneOk',
      'fallbacks',
      'notes',
      'failed',
    ]);
    // The totals add the sets up.
    expect(result.summary).toMatchObject({ pages: 8, sceneOk: 3, fallbacks: 2, notes: 2, failed: 1 });
  });

  it('keeps the totals over every page of every set and puts each PDF in its set', () => {
    const result = sweepResult('2026-11-09', engines, [
      run('atlas', 'atlas_std.pdf', atlas, atlasScenes),
      run('producers', 'skia-gradients.pdf', producers, producerScenes),
    ]);
    const { bySet, skipped, ...totals } = result.summary;
    expect(totals).toEqual(sweepSummary([...atlas, ...producers], [...atlasScenes, ...producerScenes]));
    expect(Object.keys(bySet)).toEqual(['atlas', 'producers']);
    expect(skipped).toEqual(['atlas-win']);
    expect(result.pdfs.map((p) => [p.file, p.set, p.variant])).toEqual([
      ['atlas_std.pdf', 'atlas', 'std'],
      ['skia-gradients.pdf', 'producers', null],
    ]);
  });

  it('refuses a set it does not know, a set given twice and a PDF filed under another set', () => {
    expect(() => sweepResult('2026-11-09', engines, [run('private', 'x.pdf', atlas, atlasScenes)])).toThrow(/unknown sweep set/);
    expect(() =>
      sweepResult('2026-11-09', engines, [
        run('atlas', 'a_std.pdf', atlas, atlasScenes),
        run('atlas', 'b_std.pdf', win, winScenes),
      ]),
    ).toThrow(/more than once/);
    const stray = { set: 'atlas', pdfs: [sweepPdf('a_std.pdf', atlas, 'producers', atlasScenes)], outcomes: atlas };
    expect(() => sweepResult('2026-11-09', engines, [stray])).toThrow(/belongs to set producers/);
  });

  it('is an empty sweep for no sets, every set skipped', () => {
    const result = sweepResult('2026-11-09', engines, []);
    expect(result.pdfs).toEqual([]);
    const skipped = ['atlas', 'atlas-win', 'producers'];
    expect(result.summary).toEqual({ ...sweepSummary([], []), bySet: {}, skipped });
  });
});

const ENGINES = { pdfjs: '6.5.438', pymupdf: '2.1', mupdf: '1.28.6' };
/**
 * A run of `set` over `files` (by default every PDF SWEEP_PDFS expects of it): the first file has `outcomes` and
 * `scenes`, the others no page, so the page counts are the first file's.
 */
const setRun = (
  set: string,
  outcomes: PageOutcome[],
  scenes: SweepScene[] = scenesFor(outcomes),
  files: readonly string[] = expectedPdfs(set),
): SweepSetRun => {
  const [first, ...rest] = files;
  const pdfs = [sweepPdf(first!, outcomes, set, scenes), ...rest.map((file) => sweepPdf(file, [], set, []))];
  return { set, pdfs, outcomes };
};
const resultOf = (...runs: SweepSetRun[]) => sweepResult('2026-11-10', ENGINES, runs);
const CLEAN = [ok(0), ok(1)];

describe('gateProblems: the sweep gate, read per set from bySet', () => {
  it('passes when both gate sets were swept and every page of theirs is clean, whatever producers show', () => {
    const producerScenes = [withFallback(), scene({ ok: false, failed: 'threw' })];
    const producers = setRun('producers', [differs(0, [BBOX(0)]), refused(1, 'paintXObject')], producerScenes);
    expect(gateProblems(resultOf(setRun('atlas', CLEAN), setRun('atlas-win', CLEAN), producers))).toEqual([]);
  });

  it('fails when a gate set was not swept, also when the totals look clean (Task 1 minor)', () => {
    // Producers alone: every page ok, so the totals are all ok; still both gates fail.
    const onlyProducers = resultOf(setRun('producers', CLEAN));
    expect(onlyProducers.summary.ok).toBe(onlyProducers.summary.pages);
    expect(gateProblems(onlyProducers)).toEqual([
      'atlas (a gate) was not swept: no PDF in out/atlas',
      'atlas-win (a gate) was not swept: no PDF in out/atlas-win',
    ]);
    expect(gateProblems(resultOf(setRun('atlas', CLEAN), setRun('producers', CLEAN)))).toEqual([
      'atlas-win (a gate) was not swept: no PDF in out/atlas-win',
    ]);
    expect(gateProblems(resultOf())).toHaveLength(2);
  });

  it('fails when a gate set lacks a PDF it must hold: a partly built out/atlas does not pass (ruling M2-R30)', () => {
    const partly = expectedPdfs('atlas').filter((file) => file !== 'atlas_pdfa.pdf' && file !== 'sizes-43_notags.pdf');
    const onlyStd = ['atlas_std.pdf'];
    const result = resultOf(setRun('atlas', CLEAN, undefined, partly), setRun('atlas-win', CLEAN, undefined, onlyStd));
    expect(gateProblems(result)).toEqual([
      'atlas (a gate) lacks 2 of the 18 PDFs it must hold: atlas_pdfa.pdf, sizes-43_notags.pdf',
      'atlas-win (a gate) lacks 1 of the 2 PDFs it must hold: atlas_notags.pdf',
    ]);
    // A PDF the list does not name adds nothing the gate needs: it is the record's to refuse (recordProblems).
    const withOther = [...partly, 'atlas_other.pdf'];
    const extra = resultOf(setRun('atlas', CLEAN, undefined, withOther), setRun('atlas-win', CLEAN));
    expect(gateProblems(extra)).toHaveLength(1);
  });

  it('fails on a differing page, a Scene unlike the oracle, a refusal, a failed slide, a fallback, a note', () => {
    const atlas = setRun(
      'atlas',
      [ok(0), differs(1, [BBOX(0)]), refused(2, 'setCharWidth'), ok(3), ok(4)],
      [scene(), scene({ ok: false }), withFallback(2), scene({ failed: 'slide-unbuildable' }), scene({ ok: false })],
    );
    expect(gateProblems(resultOf(atlas, setRun('atlas-win', CLEAN)))).toEqual([
      'atlas (a gate): 2 of 5 pages do not match the oracle as walked',
      'atlas (a gate): 3 of 5 pages whose Scene does not match the oracle',
      'atlas (a gate): 1 pages the walker refused',
      'atlas (a gate): 1 slides failed',
      'atlas (a gate): 2 fallback elements',
      'atlas (a gate): 2 notes',
    ]);
  });

  it('fails on approx paint pairs in a gate set, and not in producers (ruling M2-R33)', () => {
    // Pages that match, but with paint pairs compared by kind and position only.
    const approx = setRun('atlas', [ok(0), ok(1, 3)]);
    expect(gateProblems(resultOf(approx, setRun('atlas-win', CLEAN)))).toEqual([
      'atlas (a gate): 3 approx paints (compared by kind and position only)',
    ]);
    expect(gateProblems(resultOf(setRun('atlas', CLEAN), setRun('atlas-win', [ok(0, 1)])))).toEqual([
      'atlas-win (a gate): 1 approx paints (compared by kind and position only)',
    ]);
    const producers = setRun('producers', [ok(0, 9)]);
    expect(gateProblems(resultOf(setRun('atlas', CLEAN), setRun('atlas-win', CLEAN), producers))).toEqual([]);
  });

  it('takes whether a set gates from SWEEP_SETS, not from the record, and needs pages', () => {
    const result = resultOf(setRun('atlas', [differs(0, [BBOX(0)])], [scene()]), setRun('atlas-win', CLEAN));
    const { pdfs, summary } = result;
    const atlas = { ...summary.bySet['atlas']!, gate: false };
    const relabelled = { pdfs, summary: { bySet: { ...summary.bySet, atlas } } };
    expect(gateProblems(relabelled)).toEqual(['atlas (a gate): 1 of 1 pages do not match the oracle as walked']);
    const empty = { pdfs, summary: { bySet: { ...summary.bySet, atlas: { ...sweepSummary([], []), gate: true } } } };
    expect(gateProblems(empty)).toEqual(['atlas (a gate) has no page']);
  });
});

describe('SWEEP_PDFS, recordable and recordProblems: the names the committed record may hold (ruling M2-R30)', () => {
  const read = (path: string) => readFileSync(`${repoRoot}${path}`, 'utf8');

  it('lists, per set, the PDFs the atlas build and make_skia.mjs write', () => {
    expect(SWEEP_PDFS['atlas']).toEqual([
      'atlas-com_notags.pdf',
      'atlas-com_std.pdf',
      'atlas_hidden.pdf',
      'atlas_min.pdf',
      'atlas_msprint.pdf',
      'atlas_notags.pdf',
      'atlas_pdfa.pdf',
      'atlas_std.pdf',
      'probe_notags.pdf',
      'probe_std.pdf',
      'sizes-43_notags.pdf',
      'sizes-43_std.pdf',
      'sizes-a4l_notags.pdf',
      'sizes-a4l_std.pdf',
      'sizes-a4p_notags.pdf',
      'sizes-a4p_std.pdf',
      'sizes-custom_notags.pdf',
      'sizes-custom_std.pdf',
    ]);
    expect(SWEEP_PDFS['atlas-win']).toEqual(['atlas_notags.pdf', 'atlas_std.pdf']);
    expect(SWEEP_PDFS['producers']).toEqual([
      'skia-clips.pdf',
      'skia-gradients.pdf',
      'skia-images.pdf',
      'skia-patterns.pdf',
      'skia-text.pdf',
      'skia-transparency.pdf',
    ]);
    expect(Object.keys(SWEEP_PDFS)).toEqual(SWEEP_SETS.map((set) => set.name));
  });

  it('ties the atlas names to the build: export.py, decks.py, com_deck.py and the export commands', () => {
    const tuple = (source: string, name: string) => {
      const m = new RegExp(`^${name} = \\(([^)]*)\\)`, 'm').exec(source);
      expect(m, name).not.toBeNull();
      return [...m![1]!.matchAll(/"([^"]+)"/g)].map((s) => s[1]);
    };
    expect(tuple(read('harness/atlas/export.py'), 'VARIANTS')).toEqual([...VARIANTS]);
    const decks = read('harness/atlas/decks.py');
    const sizes = [...decks.matchAll(/\("(sizes-[^"]+)", \(\d+, \d+\)\)/g)].map((m) => m[1]);
    expect(sizes).toEqual(['sizes-43', 'sizes-a4l', 'sizes-a4p', 'sizes-custom']);
    expect(decks).toMatch(/^RECIPES = \{"atlas": atlas, .*"probe": probe, .*\}$/m);
    expect(read('harness/atlas/com_deck.py')).toMatch(/^DECK = "atlas-com"$/m);
    expect([...ATLAS_DECKS].sort()).toEqual(['atlas-com', 'probe', ...sizes].sort());
    // harness/README.md, "Feature atlas": the atlas is exported in every variant, each other deck with std,notags.
    const readme = read('harness/README.md');
    const exportLine = (pptx: string, out: string) =>
      new RegExp(`^harness/\\.venv/Scripts/python -m harness\\.atlas\\.export --pptx ${pptx} --out ${out}(.*)$`, 'm');
    const stdNotags = ` --variants ${STD_NOTAGS.join(',')}`;
    expect(exportLine('out/atlas/atlas\\.pptx', 'out/atlas').exec(readme)?.[1]).toBe('');
    for (const deck of ['atlas-com', 'probe', 'sizes-43']) {
      expect(exportLine(`out/atlas/${deck}\\.pptx`, 'out/atlas').exec(readme)?.[1], deck).toBe(stdNotags);
    }
    expect(exportLine('out/atlas-win/atlas\\.pptx', 'out/atlas-win').exec(readme)?.[1]).toBe(stdNotags);
  });

  it("ties the producers' names to make_skia.mjs and its committed pages", () => {
    const skia = read('harness/producers/make_skia.mjs');
    const pages = /^const PAGES = \[([^\]]*)\];$/m.exec(skia);
    expect(pages).not.toBeNull();
    expect([...pages![1]!.matchAll(/'([^']+)'/g)].map((m) => m[1])).toEqual([...SKIA_PAGES]);
    expect(skia).toContain('pathToFileURL(`${pagesDir}${name}.html`)');
    expect(skia).toContain('writeFileSync(`${outDir}skia-${name}.pdf`, pdf)');
    const git = ['ls-files', '--', 'harness/producers/pages'];
    const committed = execFileSync('git', git, { cwd: repoRoot, encoding: 'utf8' }).split('\n');
    const html = committed.filter((line) => line.endsWith('.html')).map((line) => line.replace(/^.*\//, ''));
    expect(html.sort()).toEqual(SKIA_PAGES.map((page) => `${page}.html`).sort());
  });

  it('refuses an unknown producer name and an unknown atlas name', () => {
    for (const set of ['atlas', 'atlas-win', 'producers']) {
      for (const file of expectedPdfs(set)) expect(recordable(set, file), `${set}/${file}`).toBe(true);
    }
    expect(recordable('producers', 'skia-quarterly-plan.pdf')).toBe(false);
    expect(recordable('producers', 'client-deck.pdf')).toBe(false);
    expect(recordable('producers', 'atlas_std.pdf')).toBe(false);
    expect(recordable('atlas', 'client-deck_std.pdf')).toBe(false);
    expect(recordable('atlas', 'atlas-smoke_std.pdf')).toBe(false); // a deck of the build that out/atlas does not hold
    expect(recordable('atlas', 'sizes-43_pdfa.pdf')).toBe(false); // a variant the deck is not exported in
    expect(recordable('atlas-win', 'atlas_min.pdf')).toBe(false);
    expect(recordable('atlas-win', 'skia-text.pdf')).toBe(false);
    expect(() => recordable('private', 'x.pdf')).toThrow(/unknown sweep set/);
  });

  it('gives the set and the count of refused PDFs, never a name', () => {
    const clean = resultOf(setRun('atlas', CLEAN), setRun('atlas-win', CLEAN), setRun('producers', CLEAN));
    expect(recordProblems(clean)).toEqual([]);
    const secret = ['Quarterly-Plan-Client.pdf', 'skia-secret.pdf'];
    const result = resultOf(
      setRun('atlas', CLEAN, undefined, [...expectedPdfs('atlas'), 'Board-Deck_std.pdf']),
      setRun('atlas-win', CLEAN),
      setRun('producers', CLEAN, undefined, [...expectedPdfs('producers'), ...secret]),
    );
    const problems = recordProblems(result);
    expect(problems).toEqual([
      'atlas: 1 PDF whose name no committed source gives (ruling M2-R30); the committed record is not written',
      'producers: 2 PDFs whose name no committed source gives (ruling M2-R30); the committed record is not written',
    ]);
    expect(JSON.stringify(problems)).not.toMatch(/quarterly|client|secret|board/i);
  });

  it('finds no name to refuse in any committed sweep record of schema /3', () => {
    const dir = `${repoRoot}fidelity/results/`;
    const records = readdirSync(dir)
      .filter((file) => file.endsWith('-oracle-sweep.json'))
      .sort()
      .map((file) => ({ file, record: JSON.parse(readFileSync(`${dir}${file}`, 'utf8')) as SweepResult }))
      .filter(({ record }) => record.schema === SWEEP_SCHEMA);
    expect(records.length).toBeGreaterThan(0);
    for (const { file, record } of records) {
      expect(record.pdfs.length, file).toBeGreaterThan(0);
      expect(recordProblems(record), file).toEqual([]);
    }
  });
});

describe('sceneDumpPath', () => {
  it('only with DECKBACK_DUMP_SCENE=1, under out/scene/<set>/, never under fidelity/', () => {
    expect(sceneDumpPath('atlas', 'atlas_std.pdf', {})).toBeNull();
    expect(sceneDumpPath('atlas', 'atlas_std.pdf', { DECKBACK_DUMP_SCENE: '0' })).toBeNull();
    expect(sceneDumpPath('atlas', 'atlas_std.pdf', { DECKBACK_DUMP_SCENE: 'true' })).toBeNull();
    expect(sceneDumpPath('atlas', 'atlas_std.pdf', { DECKBACK_DUMP_SCENE: '1' })).toBe('out/scene/atlas/atlas_std.scene.json');
    expect(sceneDumpPath('atlas-win', 'atlas_std.PDF', { DECKBACK_DUMP_SCENE: '1' })).toBe('out/scene/atlas-win/atlas_std.scene.json');
    expect(sceneDumpPath('producers', 'skia-text.pdf', { DECKBACK_DUMP_SCENE: '1' })).toBe('out/scene/producers/skia-text.scene.json');
  });

  it('refuses a path and a set the sweep does not know (a private deck has none)', () => {
    expect(() => sceneDumpPath('atlas', 'out/atlas/atlas_std.pdf', { DECKBACK_DUMP_SCENE: '1' })).toThrow(/a file name, not a path/);
    expect(() => sceneDumpPath('atlas', '..\\atlas_std.pdf', { DECKBACK_DUMP_SCENE: '1' })).toThrow(/a file name, not a path/);
    expect(() => sceneDumpPath('private', 'x.pdf', { DECKBACK_DUMP_SCENE: '1' })).toThrow(/unknown sweep set/);
  });
});

describe('sweepOutputPaths', () => {
  const LOCAL = 'out/sweep/2026-11-09-oracle-sweep.json';
  const COMMITTED = 'fidelity/results/2026-11-09-oracle-sweep.json';

  it('writes out/sweep/<date>-oracle-sweep.json and nothing committed by default', () => {
    expect(sweepOutputPaths('2026-11-09', {}, [])).toEqual([LOCAL]);
    expect(sweepOutputPaths('2026-11-09', { DECKBACK_SWEEP_RECORD: '' }, [])).toEqual([LOCAL]);
    expect(sweepOutputPaths('2026-11-09', { DECKBACK_SWEEP_RECORD: '0' }, [])).toEqual([LOCAL]);
    expect(sweepOutputPaths('2026-11-09', { DECKBACK_SWEEP_RECORD: 'true' }, [])).toEqual([LOCAL]);
  });

  it('writes to fidelity/results/ only with DECKBACK_SWEEP_RECORD=1 and no problem', () => {
    expect(sweepOutputPaths('2026-11-09', { DECKBACK_SWEEP_RECORD: '1' }, [])).toEqual([LOCAL, COMMITTED]);
  });

  it('recordBlockers, what the sweep passes it: the gate problems, then the record problems', () => {
    const clean = resultOf(setRun('atlas', CLEAN), setRun('atlas-win', CLEAN), setRun('producers', CLEAN));
    expect(recordBlockers(clean)).toEqual([]);
    const unnamed = setRun('producers', CLEAN, undefined, [...expectedPdfs('producers'), 'private-deck.pdf']);
    const both = resultOf(setRun('atlas', [differs(0, [BBOX(0)])]), setRun('atlas-win', CLEAN), unnamed);
    expect(recordBlockers(both)).toEqual([...gateProblems(both), ...recordProblems(both)]);
    expect(recordBlockers(both)).toEqual([
      'atlas (a gate): 1 of 1 pages do not match the oracle as walked',
      'atlas (a gate): 1 of 1 pages whose Scene does not match the oracle',
      'producers: 1 PDF whose name no committed source gives (ruling M2-R30); the committed record is not written',
    ]);
  });

  it('never writes, so never overwrites, the committed record of a failing or partial run (review Minor 1)', () => {
    const record = { DECKBACK_SWEEP_RECORD: '1' };
    const pathsFor = (result: SweepResult) => sweepOutputPaths('2026-11-09', record, recordBlockers(result));
    // Passing: both.
    expect(pathsFor(resultOf(setRun('atlas', CLEAN), setRun('atlas-win', CLEAN), setRun('producers', CLEAN)))).toEqual([
      LOCAL,
      COMMITTED,
    ]);
    // Failing: a gate page differs.
    expect(pathsFor(resultOf(setRun('atlas', [differs(0, [BBOX(0)])]), setRun('atlas-win', CLEAN)))).toEqual([LOCAL]);
    // Partial: a gate set not swept, or one that lacks a PDF.
    expect(pathsFor(resultOf(setRun('atlas', CLEAN), setRun('producers', CLEAN)))).toEqual([LOCAL]);
    const partly = expectedPdfs('atlas').slice(1);
    expect(pathsFor(resultOf(setRun('atlas', CLEAN, undefined, partly), setRun('atlas-win', CLEAN)))).toEqual([LOCAL]);
    // A PDF the record may not name, though the gate passes.
    const unnamed = setRun('producers', CLEAN, undefined, [...expectedPdfs('producers'), 'private-deck.pdf']);
    expect(pathsFor(resultOf(setRun('atlas', CLEAN), setRun('atlas-win', CLEAN), unnamed))).toEqual([LOCAL]);
    // A gate set with an approx paint pair (ruling M2-R33).
    expect(pathsFor(resultOf(setRun('atlas', [ok(0, 1)]), setRun('atlas-win', CLEAN)))).toEqual([LOCAL]);
  });
});

describe('localDate', () => {
  it('is the local calendar date, not the UTC one', () => {
    expect(localDate(new Date(2026, 10, 5, 0, 30))).toBe('2026-11-05');
    expect(localDate(new Date(2026, 0, 9, 23, 59))).toBe('2026-01-09');
  });
});
