import type { SStatus } from './validate';

/**
 * The PPTX ratchet's golden decision (packages/core/test/corpus/pptx-ratchet.corpus.test.ts, M3 Task 11): the checks
 * that may not get worse than the committed golden, what counts as worse, and when `DECKBACK_UPDATE_GOLDEN=1` may write
 * a new golden.
 */

/** The checks that may not get worse than the golden (S1 and S5 must pass on every slide). */
export const RATCHETED = ['S2', 'S3', 'S4', 'S6'] as const;

export type Ratcheted = (typeof RATCHETED)[number];

/** What the decision reads of a golden: each page's (1-based) statuses of the ratcheted checks. */
export interface RatchetGolden {
  slides: Record<string, Record<Ratcheted, SStatus>>;
}

/**
 * `<page> <check> <golden> -> <now>` for every ratcheted status of `now` worse than `golden`'s, in page and check
 * order. A status may stay as it is or become `pass`; any other change is worse: from `pass`, and between `fail` and
 * `n/a` either way, as `n/a` is never a pass. A page of the golden that `now` lacks is worse (`none`).
 */
export function worseThan(golden: RatchetGolden, now: RatchetGolden): string[] {
  const out: string[] = [];
  for (const [page, slide] of Object.entries(golden.slides)) {
    for (const check of RATCHETED) {
      const status = now.slides[page]?.[check];
      if (status !== slide[check] && status !== 'pass') out.push(`${page} ${check} ${slide[check]} -> ${status ?? 'none'}`);
    }
  }
  return out;
}

/**
 * Whether the ratchet writes `actual` as the new golden: only when asked (`update`, `DECKBACK_UPDATE_GOLDEN=1`), and
 * never where a status got worse than the `committed` golden (null: none yet, so nothing can be worse). `worse` lists
 * what got worse, for the test to fail on.
 */
export function goldenDecision(
  committed: RatchetGolden | null,
  actual: RatchetGolden,
  update: boolean,
): { worse: string[]; write: boolean } {
  const worse = committed === null ? [] : worseThan(committed, actual);
  return { worse, write: update && worse.length === 0 };
}
