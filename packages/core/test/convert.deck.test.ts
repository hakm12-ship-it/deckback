import { describe, expect, it, vi } from 'vitest';
import { convert } from '../src/convert';
import { canonicalJson } from '../src/scene/canonical';
import { extractScene, scenePages } from '../src/scene/extract';
import { DECK_WEIGHT_BUDGET, slideWeight } from '../src/scene/weight';
import { sizedPdf } from './helpers/pptx';

/**
 * Ruling M3-R41: the deck budget is `convert()`'s, which writes slide after slide; `extractScene` returns every slide it
 * builds, as M2 left it. A deck past the real budget (20,000,000) would hold some 2 GB as a Scene, so this file lowers
 * the budget to 1,000 for its own module graph (`vi.mock`): the same small PDF is then past it for both, and only
 * `convert` cuts. convert.faults.test.ts cuts a deck at the real budget.
 */

vi.mock('../src/scene/weight', async (importOriginal) => ({ ...(await importOriginal<typeof import('../src/scene/weight')>()), DECK_WEIGHT_BUDGET: 1_000 }));

/**
 * Six pages of 5 squares each, 275 a page (a square weighs 55 since ruling M3-R60: a shape 26, its `M` 13, three `L` and
 * the `Z` 4 each): past a deck budget of 1,000 after the fourth.
 */
const pdf = sizedPdf(
  Array.from({ length: 6 }, (_, n) => ({ size: [300, 200] as [number, number], content: `0 0 1 rg ${'10 10 5 5 re f '.repeat(4)} ${n} 0 1 1 re f` })),
);

describe('the deck budget is convert()\'s only (ruling M3-R41)', () => {
  it('extractScene on a deck past the deck budget returns every slide built', async () => {
    expect(DECK_WEIGHT_BUDGET).toBe(1_000); // the mock is in force
    const { scene } = await extractScene(pdf);
    expect(scene.slides.map((s) => s.failed)).toEqual([null, null, null, null, null, null]);
    expect(scene.slides.reduce((n, s) => n + slideWeight(s), 0)).toBeGreaterThan(DECK_WEIGHT_BUDGET);
    for (const slide of scene.slides) expect(slide.elements).toHaveLength(5);
    // strict mode too: nothing about the deck is refused
    expect(canonicalJson((await extractScene(pdf, { strict: true })).scene)).toBe(canonicalJson(scene));
    // and scenePages does not cut unless asked to
    const walk = scenePages(pdf);
    let failed = 0;
    for (let step = await walk.next(); step.done !== true; step = await walk.next()) failed += step.value.slide.failed === null ? 0 : 1;
    expect(failed).toBe(0);
  });

  it('convert cuts the same deck at the same budget, and its Scene is the slides it built', async () => {
    const { report, scene } = await convert(pdf, { scene: true });
    // 275 a page: past 1,000 after the fourth, so pages 5 and 6 are cut
    expect(report.slides.map((s) => s.failed)).toEqual([null, null, null, null, 'deck-too-complex', 'deck-too-complex']);
    expect(report.budgets).toEqual({ slideWeight: report.budgets.slideWeight, deckWeight: 1_000, exceeded: { slide: [], deck: true } });
    const built = await extractScene(pdf);
    expect(scene!.slides.slice(0, 4).map((s) => canonicalJson(s))).toEqual(built.scene.slides.slice(0, 4).map((s) => canonicalJson(s)));
    await expect(convert(pdf, { strict: true })).rejects.toThrow(/deck's weight budget/);
  });
});
