import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDocument, openDocument } from '../../src/engine/pdfjs-adapter';
import { sceneHash } from '../../src/scene/canonical';
import type { Element, Fill, SceneBundle, SceneSlide } from '../../src/scene/types';
import { repoRoot, updateGoldens } from '../helpers/fixtures';
import { compareScenePdf, type ElementCounts, type SceneOutcome } from '../helpers/oracle';
import { schemaErrors, validateDeck, validateSlide } from '../helpers/scene';

/**
 * The Scene ratchet (M2 Task 12): every page of every committed PDF in corpus/generated/, converted by `extractScene` with
 * its default options (lenient, what users get), against the PyMuPDF oracle, which runs once per PDF. For every page:
 *
 * - the inventory the slide gives back (`inventoryOfSlide`, with the deck's fonts) equals the oracle's under the whole
 *   extended contract (`compareInventories`, docs/decisions/0002-inventory-contract.md, its tolerances: an alpha or a
 *   miter limit rounded twice at an exact half stays within them), and by value: no paint pair compared `approx`;
 * - the slide validates against scene.schema.json (and the whole deck does);
 * - it has no note, no `failed` and no fallback element, also none in a tile cell (of a shape's fill or line, or of a text
 *   run's fill) or a soft mask (ruling M2-R17);
 * - the SHA-256 of its canonical JSON (`sceneHash`) and its element counts per kind equal
 *   packages/core/test/golden/<pdf-stem>-scene.json: { "<page, 1-based>": { "sha256", "elements": { "shape", "textline",
 *   "picture", "fallback", "hotspot" } }, ..., "deck": { "sha256" } }. The counts are of the slide's own elements: what a
 *   tile cell or a soft mask draws belongs to the element that owns it and is not counted.
 *
 * And for the whole deck, `deck.sha256` is the `sceneHash` of `{ fonts, source }`: the deck's font table (keys, names,
 * style, embedding, metrics) and its source, which no slide holds, as a slide names a font by its key only (ruling M2-R27).
 *
 * So element ids, the rounding and every name in the Scene, the fonts' too, are frozen from these goldens on (rulings
 * M2-R13, M2-R20, M2-R22, M2-R27): a change to any of them changes a hash. A picture's media is in its slide's hash (its
 * `mediaHash`). No Scene JSON is committed, only hashes and counts. The committed corpus has no element under a soft
 * mask; the page that does for ruling M2-R15 is in the sweep's gate sets (test/sweep: atlas_std.pdf page 39,
 * atlas/fills/06, whose gradients have alpha stops).
 *
 * Regenerate the goldens (after checking that the change is intended; refused in CI, `updateGoldens`):
 *   DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus
 */

const corpusDir = `${repoRoot}corpus/generated/`;
const goldenDir = `${repoRoot}packages/core/test/golden/`;
const update = updateGoldens();

/** One page of a golden. */
interface GoldenPage {
  sha256: string;
  elements: ElementCounts;
}

/** The deck of a golden (ruling M2-R27): the hash of its font table and source. */
interface GoldenDeck {
  sha256: string;
}

/** A golden: its pages under their 1-based numbers, and `deck`. */
type Golden = Record<string, GoldenPage | GoldenDeck>;

const pdfs = readdirSync(corpusDir)
  .filter((name) => name.toLowerCase().endsWith('.pdf'))
  .sort();

const pageCounts = new Map<string, number>();
for (const file of pdfs) {
  const doc = await openDocument(new Uint8Array(readFileSync(`${corpusDir}${file}`)));
  pageCounts.set(file, doc.numPages);
  await closeDocument(doc);
}

/**
 * Every element of a slide: its own, those of every tile cell (a shape's fill or line paint, a text run's fill) and of
 * every soft mask (the slide's `masks` hold those of masks and cells too), and those of the cells in them, at any depth.
 */
function allElements(slide: SceneSlide): Element[] {
  const out: Element[] = [];
  const cellOf = (paint: Fill | null | undefined) => {
    if (paint?.kind === 'tile') visit(paint.cell.elements);
  };
  const visit = (elements: readonly Element[]) => {
    for (const el of elements) {
      out.push(el);
      if (el.kind === 'shape') {
        cellOf(el.fill);
        cellOf(el.line?.paint);
      } else if (el.kind === 'textline') {
        for (const run of el.runs) cellOf(run.fill);
      }
    }
  };
  visit(slide.elements);
  for (const mask of Object.values(slide.masks)) visit(mask.elements);
  return out;
}

describe.each(pdfs)('%s: the Scene against the oracle and its golden', (file) => {
  const golden = `${goldenDir}${file.replace(/\.pdf$/i, '')}-scene.json`;
  let bundle: SceneBundle;
  let outcomes: SceneOutcome[] = [];
  let actual: Golden = {};
  let expected: Golden = {};
  const pages = Array.from({ length: pageCounts.get(file)! }, (_, i) => i + 1);

  beforeAll(async () => {
    ({ bundle, outcomes } = await compareScenePdf(`${corpusDir}${file}`));
    actual = {};
    for (const [i, slide] of bundle.scene.slides.entries()) {
      actual[String(i + 1)] = { sha256: await sceneHash(slide), elements: outcomes[i]!.elements };
    }
    actual.deck = { sha256: await sceneHash({ fonts: bundle.scene.fonts, source: bundle.scene.source }) };
    if (update) writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
    expected = existsSync(golden) ? (JSON.parse(readFileSync(golden, 'utf8')) as Golden) : {};
  }, 300_000);

  it('the deck validates against scene.schema.json, and its golden has its pages and one deck key', () => {
    expect(schemaErrors(validateDeck, bundle.scene)).toEqual([]);
    expect(existsSync(golden), `no golden for ${file}: DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus`).toBe(true);
    expect(Object.keys(expected)).toEqual([...pages.map(String), 'deck']);
  });

  it('the hash of its font table and source equals the golden (ruling M2-R27)', () => {
    expect(Object.keys(expected.deck ?? {})).toEqual(['sha256']);
    expect(actual.deck, `${file}: fonts and source against the golden`).toEqual(expected.deck);
  });

  it('has a slide for each page, in order', () => {
    expect(bundle.scene.source.pageCount).toBe(pages.length);
    expect(bundle.scene.slides.map((s) => s.index)).toEqual(pages.map((p) => p - 1));
  });

  it.each(pages)('page %i', (page) => {
    const key = `${file}#${page}`;
    const slide = bundle.scene.slides[page - 1]!;
    const outcome = outcomes[page - 1]!;
    expect(outcome.index, key).toBe(page - 1);
    expect(schemaErrors(validateSlide, slide), key).toEqual([]);
    // Ruling M2-R17: nothing the Scene could not model, nowhere on the slide.
    expect(slide.failed, key).toBeNull();
    expect(slide.notes, key).toEqual([]);
    expect(allElements(slide).filter((e) => e.kind === 'fallback').length, key).toBe(0);
    // The Scene lost nothing the oracle sees, every field compared by value.
    expect(outcome.diffs, `${key}: ${outcome.diffTotal} diffs`).toEqual([]);
    expect(outcome.ok, key).toBe(true);
    expect(outcome.approxPaints, `${key}: paints compared approx (kind and position only); the committed corpus has none`).toBe(0);
    expect(actual[String(page)], `${key} against its golden`).toEqual(expected[String(page)]);
  });
});
