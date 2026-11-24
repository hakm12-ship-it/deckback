// One version, everywhere it is written: the package, the skill's pin, the site footer and the README (M9).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8');
const version = JSON.parse(read('packages/cli/package.json')).version;
const escaped = version.replaceAll('.', '\\.');

test('the version is a release, not a pre-release', () => {
  assert.match(version, /^\d+\.\d+\.\d+$/);
});

test('the skill pins exactly this version, in SKILL.md and in its README', () => {
  const pins = [...read('skills/pdf-to-pptx/SKILL.md').matchAll(/deckback@([\d.]+)/g)].map((m) => m[1]);
  assert.ok(pins.length >= 1);
  for (const pin of pins) assert.equal(pin, version);
  for (const pin of read('skills/pdf-to-pptx/README.md').matchAll(/deckback@([\d.]+)/g)) assert.equal(pin[1], version);
});

test('the site footer shows this version', () => {
  assert.match(read('apps/web/index.html'), new RegExp(`<div class="foot-version">deckback ${escaped}</div>`));
});

test('the lockfile names this version, and the root README says how to run exactly it', () => {
  assert.equal(JSON.parse(read('package-lock.json')).packages['packages/cli'].version, version);
  assert.ok(read('README.md').includes(`deckback@${version}`), 'README names deckback@<version>');
});

test('the changelog has an entry for this version', () => {
  assert.match(read('CHANGELOG.md'), new RegExp(`^## \\[?${escaped}\\]?`, 'm'));
});
