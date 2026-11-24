import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { convert, type Converted } from '../../src/convert';
import { spacelessFamily } from '../../src/fonts/names';
import type { Counts } from '../../src/passes/report';
import { sceneHash } from '../../src/scene/canonical';
import { repoRoot, updateGoldens } from '../helpers/fixtures';
import { partsOf } from '../helpers/pptx';
import { goldenDecision } from '../helpers/ratchet';
import { structuralChecks, validatedPath, validatePptx, type SStatus, type StructuralRow, type ValidatorError } from '../helpers/validate';

/**
 * The PPTX ratchet (M3 Task 11): every committed PDF in corpus/generated/, converted by `convert()` with its default
 * options (what the CLI and the website give users), must
 *
 * - convert to the same bytes twice: the same PPTX and the same report (Global Constraints, Determinism);
 * - give a PPTX the Open XML validator (`harness.ooxml.validate`, Office2021) finds no error in;
 * - pass S1 (pictures) and S5 (page size) on every slide, as `harness.fidelity.structural_cli` checks them against the
 *   PDF (spec §5.2, harness/fidelity/structural.py);
 * - name no typeface that is a known family without its spaces (M4 Task 3: `MalgunGothic` for "Malgun Gothic", the
 *   families of packages/core/src/fonts/ps-family.ts), on any slide, as S6 checks it too;
 * - be nowhere worse than its golden in S2, S3, S4 and S6: a status stays as it is or becomes `pass`; every other change
 *   is worse, `fail -> n/a` too, as `n/a` is never a pass (`worseThan`, helpers/ratchet.ts);
 * - equal packages/core/test/golden/<pdf-stem>-pptx.json:
 *   `{ "sha256": <of the PPTX>, "report": <sceneHash of the report: SHA-256 of its canonical JSON>,
 *      "slides": { "<n, 1-based>": { "counts": <the report's counts of the slide>, "S1".."S6": <status>,
 *                                    "checks": <structural_cli's counts per check, S1..S6> } } }`.
 *   The checks' counts (fixed words and numbers, `structural.COUNT_NAMES`) make a change inside a status visible: a
 *   slide already at `fail` cannot get worse unseen.
 *
 * A golden holds hashes, counts and statuses only: no XML, no report, no detail. The committed corpus is public, so a
 * failure message may show structural_cli's details (`--details`) and the validator's errors.
 *
 * Regenerate the goldens (after checking that the change is intended; refused in CI, `updateGoldens`):
 *   DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus
 * A commit that changes a golden says why in its message. Even then a golden is not rewritten where a status of S2, S3,
 * S4 or S6 would get worse than the committed one (`goldenDecision`; the ratchet fails instead): making a check
 * stricter takes a ruling, and its golden is deleted and regenerated in the commit that applies it.
 */

const corpusDir = `${repoRoot}corpus/generated/`;
const goldenDir = `${repoRoot}packages/core/test/golden/`;
const update = updateGoldens();

const CHECKS = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6'] as const;
/** Checks every slide must pass. */
const ALWAYS = ['S1', 'S5'] as const;

type Statuses = Record<(typeof CHECKS)[number], SStatus>;

interface GoldenSlide extends Statuses {
  counts: Counts;
  checks: StructuralRow['counts'];
}

interface Golden {
  sha256: string;
  report: string;
  slides: Record<string, GoldenSlide>;
}

const pdfs = readdirSync(corpusDir)
  .filter((name) => name.toLowerCase().endsWith('.pdf'))
  .sort();

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const readGolden = (path: string): Golden | null => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Golden) : null);

describe.each(pdfs)('%s: the PPTX against the validator, S1-S6 and its golden', (file) => {
  const stem = file.replace(/\.pdf$/i, '');
  const golden = `${goldenDir}${stem}-pptx.json`;
  let first: Converted;
  let second: Converted;
  let errors: ValidatorError[] = [];
  let rows: StructuralRow[] = [];
  let details = '';
  let actual: Golden;
  let committed: Golden | null = null;
  let expected: Golden | null = null;
  let worse: string[] = [];

  beforeAll(async () => {
    const pdf = `${corpusDir}${file}`;
    const bytes = new Uint8Array(readFileSync(pdf));
    first = await convert(bytes);
    second = await convert(bytes);
    const name = `pptx-ratchet-${stem}`;
    errors = await validatePptx(first.pptx, name);
    ({ rows, details } = await structuralChecks(pdf, validatedPath(name), true));
    actual = { sha256: sha256(first.pptx), report: await sceneHash(first.report), slides: {} };
    for (const row of rows) {
      const counts = first.report.slides[row.slide - 1]?.counts;
      if (counts === undefined) throw new Error(`${file}: no report slide for page ${row.slide}`);
      const statuses = Object.fromEntries(CHECKS.map((c) => [c, row[c]])) as Statuses;
      actual.slides[String(row.slide)] = { counts, ...statuses, checks: row.counts };
    }
    committed = readGolden(golden);
    const decision = goldenDecision(committed, actual, update);
    worse = decision.worse;
    if (decision.write) writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
    expected = readGolden(golden);
  }, 300_000);

  it('converts to the same PPTX and report twice', async () => {
    expect(sha256(second.pptx), `${file}: PPTX`).toBe(sha256(first.pptx));
    expect(await sceneHash(second.report), `${file}: report`).toBe(await sceneHash(first.report));
  });

  it('the Open XML validator finds no error', () => {
    expect(errors.map((e) => `${e.id} ${e.part} ${e.path}: ${e.description}`)).toEqual([]);
  });

  it('has a slide for every page, and S1 and S5 pass on every slide', () => {
    expect(rows.map((row) => row.slide)).toEqual(first.report.slides.map((slide) => slide.index));
    const failing = rows.flatMap((row) => ALWAYS.filter((c) => row[c] !== 'pass').map((c) => `${row.slide} ${c} ${row[c]}`));
    expect(failing, details).toEqual([]);
  });

  it('no typeface is a known family without its spaces (M4 Task 3)', () => {
    const parts = partsOf(first.pptx);
    const faces = new Set<string>();
    for (const [name, xml] of Object.entries(parts)) {
      if (!/^ppt\/slides\/slide\d+\.xml$/.test(name)) continue;
      for (const m of xml.matchAll(/<a:(?:latin|ea|cs) typeface="([^"]*)"/g)) faces.add(m[1]!);
    }
    expect(faces.size, `${file}: typefaces`).toBeGreaterThan(0);
    expect([...faces].filter((t) => spacelessFamily(t) !== null), file).toEqual([]);
  });

  it('S2, S3, S4 and S6 are nowhere worse than the golden', () => {
    expect(committed, `no golden for ${file}: DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus`).not.toBeNull();
    expect(worse, `${file}: a status got worse (the golden was not rewritten)\n${details}`).toEqual([]);
  });

  it('the hashes, counts and statuses equal the golden', () => {
    expect(expected, `no golden for ${file}: DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus`).not.toBeNull();
    expect(Object.keys(expected!)).toEqual(['sha256', 'report', 'slides']);
    expect(actual, `${file} against its golden\n${details}`).toEqual(expected);
  });
});
