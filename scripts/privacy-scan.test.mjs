import assert from 'node:assert/strict';
import test from 'node:test';

import { PRIVATE_NAME_HASHES, hashName, scanText } from './privacy-scan.mjs';

const kinds = (text, options) => scanText(text, options).map((finding) => finding.kind);
// Test values are assembled from pieces so that this file is itself clean for the scan it tests.
const join = (...parts) => parts.join('');
const BS = String.fromCharCode(92);

test('an absolute path on a PC is found: a drive path, a user folder, a home folder', () => {
  assert.deepEqual(kinds(join('see C', ':', BS, 'Users', BS, 'alice', BS, 'file.txt')), ['absolute-path']);
  assert.deepEqual(kinds(join('open d', ':/work/project/out.pdf')), ['absolute-path']);
  assert.deepEqual(kinds(join('cd /Us', 'ers/alice/project')), ['absolute-path']);
  assert.deepEqual(kinds(join('cd /ho', 'me/alice/project')), ['absolute-path']);
});

test('what only looks like a path is not one: URLs, a bare drive letter, relative and placeholder paths', () => {
  const fine = [
    'https://example.com/a/b',
    'file system: use forward slashes',
    'the A:B ratio and C:D keys',
    'corpus/private/ is git-ignored',
    ['C:', 'abs', 'path', 'deckback-1.0.0.tgz'].join(BS), // a placeholder the docs spell out
    '/abs/path/deckback-1.0.0.tgz',
    'files in /tmp and /usr/bin are fine',
  ];
  for (const text of fine) assert.deepEqual(kinds(text), [], text);
});

test('token shapes are found: GitHub, OpenAI-style, JWT, AWS, Slack, npm, Google, private keys', () => {
  const samples = {
    github: join('ghp', '_', 'a'.repeat(36)),
    'github-pat': join('github_pat', '_', 'A1'.repeat(15)),
    secret: join('sk', '-', 'a1B2'.repeat(6)),
    jwt: join('eyJ', 'hbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxIn0', '.', 'abc_def-ghi'),
    aws: join('AKI', 'A', 'ABCDEFGHIJKLMNOP'),
    slack: join('xox', 'b-123456789012-abcdefghij'),
    npm: join('npm', '_', 'a'.repeat(36)),
    google: join('AI', 'za', 'A'.repeat(35)),
    'private-key': join('-----BEGIN ', 'RSA PRIVATE KEY-----'),
  };
  for (const [name, text] of Object.entries(samples)) assert.deepEqual(kinds(`token = ${text}`), ['token'], name);
});

test('ordinary words and short look-alikes are not tokens', () => {
  for (const text of ['sk-learn', 'task-force', 'the ghp prefix', 'AKIA', 'eyJ', 'npm_config', 'desk-lamp-of-the-office']) {
    assert.deepEqual(kinds(text), [], text);
  }
});

test('an e-mail address is found unless it is the GitHub noreply address', () => {
  assert.deepEqual(kinds(join('write to someone', '@', 'corp-mail.net')), ['email']);
  assert.deepEqual(kinds(join('1234567+someone', '@', 'users.noreply.github.com')), []);
  assert.deepEqual(kinds('@scope/package and a@b are not addresses'), []);
});

test('a private name is found by its hash only, in a word or a run of up to three words, spaces and case ignored', () => {
  const secret = 'Quiet Harbor Deck'; // made up for the test: the real list holds only hashes
  const options = { nameHashes: new Set([hashName(secret)]) };
  for (const text of ['quiet harbor deck', 'the QuietHarborDeck.pdf', 'file: "Quiet-Harbor-Deck"', 'x quiet harbor deck y']) {
    assert.deepEqual(kinds(text, options), ['private-name'], text);
  }
  for (const text of ['quiet harbor', 'harbor deck', 'quiet harbors deck']) assert.deepEqual(kinds(text, options), [], text);
});

test('a finding never repeats the matched text: only its kind, a column and a short fingerprint', () => {
  const [finding] = scanText(join('C', ':', BS, 'Users', BS, 'alice', BS, 'x'));
  assert.deepEqual(Object.keys(finding).sort(), ['column', 'fingerprint', 'kind', 'line']);
  assert.match(finding.fingerprint, /^[0-9a-f]{8}$/);
  const options = { nameHashes: new Set([hashName('Quiet Harbor Deck')]) };
  assert.doesNotMatch(JSON.stringify(scanText('Quiet Harbor Deck', options)), /quiet|harbor/i);
});

test('the built-in name list is hashes (64 hex), not names, and hashName normalises like the scan', () => {
  assert.ok(PRIVATE_NAME_HASHES.size >= 1);
  for (const hash of PRIVATE_NAME_HASHES) assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hashName('Quiet Harbor'), hashName('quiet-harbor'));
});

test('lines are scanned one by one and the line number is kept', () => {
  const text = ['fine', join('C', ':', BS, 'Users', BS, 'alice', BS, 'x'), 'fine', join('ghp', '_', 'a'.repeat(36))].join('\n');
  assert.deepEqual(scanText(text).map((f) => [f.line, f.kind]), [[2, 'absolute-path'], [4, 'token']]);
});

test('made-up example paths and the reserved example domains are not findings; a real-looking folder or name still is', () => {
  const example = [
    ['C:', 'Users', 'someone', 'AppData', 'x.svg'].join(BS),
    ['C:', 'secret', 'name.pdf'].join(BS),
    ['C:', 'x', 'deck.pdf'].join(BS),
    ['C:', 'Windows', 'Fonts'].join(BS),
    'C:/Users/x/a',
    ['C:', 'deck.pdf'].join(BS),
    '/home/u/deck.pdf',
    '/Users/x/deck.key',
    'file:///C:/fonts/x.woff',
    join('mailto:a', '@', 'example.com'),
  ];
  for (const text of example) assert.deepEqual(kinds(text), [], text);
  for (const text of [['C:', 'Users', 'carol', 'x.txt'].join(BS), ['D:', 'projects', 'client', 'a.pdf'].join(BS), join('/ho', 'me/carol/x'), join('/Us', 'ers/carol/x')]) {
    assert.deepEqual(kinds(text), ['absolute-path'], text);
  }
});
