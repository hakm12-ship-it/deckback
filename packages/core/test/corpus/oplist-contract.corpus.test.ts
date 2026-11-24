import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoRoot, updateGoldens } from '../helpers/fixtures';
import { pdfOpHistograms } from '../helpers/oracle';

/**
 * The op-list contract on the committed corpus: for every PDF in corpus/generated/, the pdf.js op-name histogram of
 * every page equals packages/core/test/golden/<pdf-stem>-ophist.json ({ "<page, 1-based>": { "<op name>": count } }).
 * A pdf.js upgrade or a change of the getDocument/getOperatorList options that changes what the walker is given shows
 * up here first.
 *
 * Regenerate the goldens (after checking that the change is intended; refused in CI, `updateGoldens`):
 *   DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus
 */

const corpusDir = `${repoRoot}corpus/generated/`;
const goldenDir = `${repoRoot}packages/core/test/golden/`;
const update = updateGoldens();

const pdfs = readdirSync(corpusDir)
  .filter((name) => name.toLowerCase().endsWith('.pdf'))
  .sort();

describe.each(pdfs)('%s op-list contract', (file) => {
  it('the op-name histogram of every page equals its golden', async () => {
    const actual = await pdfOpHistograms(new Uint8Array(readFileSync(`${corpusDir}${file}`)));
    const golden = `${goldenDir}${file.replace(/\.pdf$/i, '')}-ophist.json`;
    if (update) writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`);
    expect(existsSync(golden), `no golden for ${file}: DECKBACK_UPDATE_GOLDEN=1 npm run test:corpus`).toBe(true);
    expect(actual).toEqual(JSON.parse(readFileSync(golden, 'utf8')));
  }, 120_000);
});
