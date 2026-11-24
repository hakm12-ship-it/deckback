import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDocument, openDocument } from '../../src/engine/pdfjs-adapter';
import { repoRoot } from '../helpers/fixtures';
import {
  comparePdf,
  diffKinds,
  failureKind,
  ratchetVerdict,
  type FailureKind,
  type KnownEntry,
  type PageOutcome,
} from '../helpers/oracle';

/**
 * The oracle ratchet: every page of every committed PDF in corpus/generated/ is walked and compared with the PyMuPDF
 * oracle (docs/decisions/0002-inventory-contract.md, 0.05 pt). The oracle runs once per PDF.
 *
 * - A page listed in fidelity/known/oracle-known.json as "<file>#<page>" (page 1-based) must still fail, with the
 *   listed kind: "unsupported-op" (the walker throws UnsupportedOpError) or "diff" (its inventory differs).
 * - Every other page must match the oracle.
 * - A listed page that matches now fails: remove it from oracle-known.json. So the list can only shrink.
 * - Every page is compared by value: a page with a paint compared `approx` (kind and position only) fails.
 * (ratchetVerdict in helpers/oracle.ts; its cases are unit-tested in oracle-helpers.test.ts.)
 *
 * Every page's outcome is written to out/corpus/oracle-ratchet.json (git-ignored), the input for that list.
 */

const corpusDir = `${repoRoot}corpus/generated/`;
const knownPath = `${repoRoot}fidelity/known/oracle-known.json`;
const reportPath = `${repoRoot}out/corpus/oracle-ratchet.json`;
const KINDS: readonly FailureKind[] = ['unsupported-op', 'diff'];

const pdfs = readdirSync(corpusDir)
  .filter((name) => name.toLowerCase().endsWith('.pdf'))
  .sort();

const pageCounts = new Map<string, number>();
for (const file of pdfs) {
  const doc = await openDocument(new Uint8Array(readFileSync(`${corpusDir}${file}`)));
  pageCounts.set(file, doc.numPages);
  await closeDocument(doc);
}

/** The known list, or the reason it cannot be used (then every listed page counts as unlisted). */
function readKnown(): { entries: Record<string, KnownEntry>; problem: string | null } {
  if (!existsSync(knownPath)) return { entries: {}, problem: 'fidelity/known/oracle-known.json is missing' };
  try {
    return { entries: JSON.parse(readFileSync(knownPath, 'utf8')) as Record<string, KnownEntry>, problem: null };
  } catch (error) {
    return { entries: {}, problem: `fidelity/known/oracle-known.json is not JSON: ${String(error)}` };
  }
}
const known = readKnown();

const report: Record<string, unknown[]> = {};

describe('oracle-known.json', () => {
  it('exists and names only committed pages, each with a reason and a kind', () => {
    expect(known.problem).toBeNull();
    const problems: string[] = [];
    for (const [key, entry] of Object.entries(known.entries)) {
      const m = /^(.+)#([1-9]\d*)$/.exec(key);
      const pages = m === null ? undefined : pageCounts.get(m[1]!);
      if (m === null || pages === undefined || Number(m[2]) > pages) problems.push(`${key}: not a page of a committed PDF`);
      if (typeof entry?.reason !== 'string' || entry.reason.trim().length < 10) problems.push(`${key}: no reason`);
      if (!KINDS.includes(entry?.kind)) problems.push(`${key}: kind must be one of ${KINDS.join(', ')}`);
      const extra = Object.keys(entry ?? {}).filter((k) => k !== 'reason' && k !== 'kind');
      if (extra.length > 0) problems.push(`${key}: unexpected fields ${extra.join(', ')}`);
    }
    expect(problems).toEqual([]);
  });
});

describe.each(pdfs)('%s against the oracle', (file) => {
  let outcomes: PageOutcome[] = [];

  beforeAll(async () => {
    outcomes = await comparePdf(`${corpusDir}${file}`);
    report[file] = outcomes.map((o) => ({
      page: o.index + 1,
      ok: o.ok,
      kind: failureKind(o),
      unsupported: o.unsupported,
      diffKinds: diffKinds(o.diffs),
      diffCount: o.diffTotal,
      approxPaints: o.approxPaints,
      diffs: o.diffs.slice(0, 20),
    }));
  }, 300_000);

  const pages = Array.from({ length: pageCounts.get(file)! }, (_, i) => i + 1);
  it.each(pages)('page %i', (page) => {
    const outcome = outcomes[page - 1];
    expect(outcome?.index, 'the oracle and the walker read this page').toBe(page - 1);
    const key = `${file}#${page}`;
    expect(ratchetVerdict(key, known.entries[key], outcome!)).toBeNull();
  });
});

afterAll(() => {
  mkdirSync(`${repoRoot}out/corpus`, { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
});
