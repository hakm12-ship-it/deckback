import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pdfjsVersion } from '../../src/engine/pdfjs-adapter';
import { canonicalJson } from '../../src/scene/canonical';
import { repoRoot } from '../helpers/fixtures';
import { comparePdfAndScene, errorName, oracleVersions, type PageOutcome } from '../helpers/oracle';
import {
  gateProblems,
  localDate,
  recordable,
  recordBlockers,
  recordProblems,
  sceneDumpPath,
  SWEEP_SETS,
  sweepOutputPaths,
  sweepPdf,
  sweepResult,
  sweepScenes,
  type SweepPdf,
  type SweepSetRun,
} from '../helpers/sweep';

/**
 * The oracle sweep over the PDF sets (local only and opt-in: `npm run oracle:sweep`, which runs vitest in the mode
 * `sweep`; a bare `vitest run` never runs it): every page of every PDF in each set of SWEEP_SETS (helpers/sweep.ts) is
 * compared two ways with the PyMuPDF oracle, which runs once per PDF: as the walker walks it with the M0 keepGoing
 * behaviour, and as `extractScene` (lenient, its default) converts it, by the inventory its slide gives back:
 *
 *   atlas      out/atlas/*.pdf       the atlas in every variant harness/atlas/export.py exports, and the COM supplement
 *                                    atlas-com, the page-size decks and the probe in std and notags      (gate)
 *   atlas-win  out/atlas-win/*.pdf   the atlas built with the Windows fonts (Malgun Gothic and others)  (gate)
 *   producers  out/producers/*.pdf   PDFs of other producers than PowerPoint                         (no gate)
 *
 * A set whose directory is missing or holds no PDF is not swept, and the reason is printed: a non-gate set is just
 * skipped, and a gate set fails the run (below). The result is always written to
 * out/sweep/<YYYY-MM-DD>-oracle-sweep.json (git-ignored). Only `DECKBACK_SWEEP_RECORD=1` also writes the committed
 * fidelity/results/<YYYY-MM-DD>-oracle-sweep.json (ruling M1-R65; sweepOutputPaths), and only when the gate passes and
 * every PDF has a name from a committed source (ruling M2-R30: `SWEEP_PDFS`, `recordProblems`):
 *
 *   { schema: "deckback.oracle-sweep/3", date, tolerancePt, engines: { pdfjs, pymupdf, mupdf },
 *     pdfs: [ { file, set, variant, pages: [ { index, ok, diffCount, approxPaints, diffs (the first 20), unsupported,
 *                                              scene: { ok, elements: { shape, textline, picture, fallback, hotspot },
 *                                                       notes, failed } } ] } ],
 *     summary: { pages, ok, unsupported, diff, approxPaints, unsupportedOps: { "op (detail)": pages },
 *                diffKinds: { kind: pages }, sceneOk, fallbacks, notes, failed,
 *                bySet: { <set>: { gate, pages, ok, unsupported, diff, approxPaints, unsupportedOps, diffKinds,
 *                                  sceneOk, fallbacks, notes, failed } },
 *                skipped: [ <set>, ... ] } }
 *
 * `file` is the public file name only (no directory; `set` says which directory); `variant` is the export variant of a
 * `<stem>_<variant>.pdf` name, null for a file with no known variant suffix; `index` is the 0-based page index;
 * `unsupported` is the walker's UnsupportedOpError message or null. `scene`: `ok` when the Scene's inventory equals the
 * oracle's, `elements` the slide's own elements per kind (as the Scene goldens count them), `notes` its notes as op name
 * and fixed words, `failed` its `failed`. A file whose Scene could not be built or compared (`extractScene` threw, which it
 * should not as it is lenient, or the comparison did; `sceneRun`) has `sceneThrew(<the error's constructor name>)` on
 * every page, its walker outcomes as they are, and the sweep goes on. The top-level summary is over every page of every
 * set; `skipped` names the sets that were not swept. See helpers/sweep.ts for the summary and helpers/oracle.ts
 * diffKind for the diff kinds. `DECKBACK_DUMP_SCENE=1` also writes the Scene JSON of each PDF whose Scene was built
 * (also when only its comparison threw) to out/scene/<set>/<stem>.scene.json (git-ignored; sceneDumpPath), for
 * debugging.
 *
 * After writing, the test gates (`gateProblems`, read per set from `bySet`): both gate sets must have been swept and
 * hold every PDF `SWEEP_PDFS` lists for them, and every one of their pages must match the oracle as walked and as the
 * Scene gives it back, with no page refused, no slide failed, no fallback, no note and no approx paint (ruling
 * M2-R33). The producers set reports only.
 * A recording run also fails when a PDF's name comes from no committed source, with the set and the count only;
 * without `DECKBACK_SWEEP_RECORD=1` such a PDF is swept and its name printed, for debugging.
 */

/** Straight to stdout: vitest's default reporter hides console output of tests that pass or are skipped. */
const say = (line: string) => process.stdout.write(`${line}\n`);

/** How to get PDFs into a set that has none, for the line printed when it is skipped. */
const HOW: Record<string, string> = {
  atlas:
    'build the decks with `python -m harness.atlas.build --deck atlas --fonts ofl --out out/atlas` (and --deck sizes, ' +
    '--deck probe, `python -m harness.atlas.com_deck --out out/atlas`), then export them with ' +
    '`python -m harness.atlas.export` (the atlas in all variants, the others with --variants std,notags)',
  'atlas-win':
    'build the Windows-font atlas with `python -m harness.atlas.build --deck atlas --fonts windows --out out/atlas-win`, ' +
    'then export it with `python -m harness.atlas.export --pptx out/atlas-win/atlas.pptx --out out/atlas-win ' +
    '--variants std,notags`',
  producers: 'PDFs made by a producer other than PowerPoint go there',
};

const sets = SWEEP_SETS.map((set) => {
  const dir = `${repoRoot}${set.dir}/`;
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.pdf'))
        .sort()
    : [];
  if (files.length === 0) {
    const kind = set.gate ? 'a gate: the run fails' : 'no gate';
    const how = `${HOW[set.name]}; harness/README.md, "Feature atlas"`;
    say(`SKIP oracle sweep set ${set.name} (${kind}): no PDF in ${set.dir} (${how})`);
  }
  return { set, dir, files };
}).filter((entry) => entry.files.length > 0);

/** A recording run names no file whose name no committed source gives (ruling M2-R30), not even on the console. */
const recording = process.env['DECKBACK_SWEEP_RECORD'] === '1';

describe('oracle sweep over out/atlas, out/atlas-win and out/producers', () => {
  it('writes out/sweep/ always, fidelity/results/ only for a passing recording run, then gates', async () => {
    const runs: SweepSetRun[] = [];
    for (const { set, dir, files } of sets) {
      const pdfs: SweepPdf[] = [];
      const all: PageOutcome[] = [];
      for (const file of files) {
        const named = recordable(set.name, file);
        const shown = named || !recording ? file : '(a PDF whose name no committed source gives)';
        if (!named && !recording) say(`${set.name}/${file}: no committed source gives this name; a record refuses it`);
        const started = Date.now();
        const { outcomes, scene } = await comparePdfAndScene(`${dir}${file}`);
        const scenes = sweepScenes(scene, outcomes.length);
        pdfs.push(sweepPdf(file, outcomes, set.name, scenes));
        all.push(...outcomes);
        // Whenever a Scene was built, also when only its comparison threw; a dump that fails does not stop the sweep.
        const dump = sceneDumpPath(set.name, file, process.env);
        if (dump !== null && scene.deck !== null) {
          try {
            mkdirSync(dirname(`${repoRoot}${dump}`), { recursive: true });
            writeFileSync(`${repoRoot}${dump}`, `${JSON.stringify(JSON.parse(canonicalJson(scene.deck)), null, 1)}\n`);
          } catch (error) {
            say(`${set.name}/${shown}: the Scene was not dumped (${errorName(error)} thrown)`);
          }
        }
        const ok = outcomes.filter((o) => o.ok).length;
        const sceneOk = 'threw' in scene ? `none: ${scene.threw} thrown` : String(scenes.filter((s) => s.ok).length);
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const matched = `${ok}/${outcomes.length} pages match the oracle, the Scene ${sceneOk}`;
        say(`${set.name}/${shown}: ${matched} (${seconds} s)`);
      }
      runs.push({ set: set.name, pdfs, outcomes: all });
    }
    const date = localDate();
    const engines = { pdfjs: await pdfjsVersion(), ...oracleVersions() };
    const result = sweepResult(date, engines, runs);
    const gate = gateProblems(result);
    const refused = recordProblems(result);
    // out/sweep/ always, so a failing run keeps its local record; fidelity/results/ only for a passing, nameable run.
    const written = sweepOutputPaths(date, process.env, recordBlockers(result));
    for (const relative of written) {
      const out = `${repoRoot}${relative}`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
      say(`wrote ${relative}`);
    }
    if (recording && !written.some((relative) => relative.startsWith('fidelity/'))) {
      say('fidelity/results/ was not written: the gate or the record check failed');
    }
    for (const [name, set] of Object.entries(result.summary.bySet)) {
      const { gate: gates, ...counts } = set;
      say(`${name} (${gates ? 'gate' : 'no gate'}): ${JSON.stringify(counts)}`);
    }
    for (const name of result.summary.skipped) say(`${name}: skipped`);
    expect(written.every((relative) => existsSync(`${repoRoot}${relative}`))).toBe(true);
    // The gate, per set from bySet (never the totals, which add producers).
    expect(gate).toEqual([]);
    // A record names only what committed sources name: the set and the count, never the name (ruling M2-R30).
    if (recording) expect(refused).toEqual([]);
  }, 3_600_000);
});
