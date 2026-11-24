// scripts/release-check.mjs: the argument rules, the table, and the tree and history scans on a throw-away repository.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { KNOWN_PREPUBLIC, buildSteps, countsByKind, formatTable, knownEntry, parseArgs, runSteps, scanHistory, scanTree } from './release-check.mjs';

const script = fileURLToPath(new URL('./release-check.mjs', import.meta.url));
const NOREPLY = '123456+someone@users.noreply.github.com';
const BS = String.fromCharCode(92);
const join = (...parts) => parts.join('');
// values that the scan must find, assembled so that this file is clean itself
const TOKEN = join('ghp', '_', 'a'.repeat(36));
const WINPATH = join('C', ':', BS, 'Users', BS, 'alice', BS, 'secret.txt');
const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmpdir(), 'no-such-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

async function withRepo(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'release-check-test-'));
  try {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'someone');
    git(dir, 'config', 'user.email', NOREPLY);
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const commit = (dir, file, text, message, author = NOREPLY) => {
  writeFileSync(path.join(dir, file), text);
  git(dir, 'add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], { cwd: dir, env: { ...env, GIT_AUTHOR_EMAIL: author, GIT_COMMITTER_EMAIL: author }, encoding: 'utf8' });
  return git(dir, 'rev-parse', 'HEAD');
};

test('exactly one of --fresh and --full is required', () => {
  assert.throws(() => parseArgs([]), /--fresh or --full/);
  assert.throws(() => parseArgs(['--fresh', '--full']), /only one/);
  assert.equal(parseArgs(['--fresh']).mode, 'fresh');
  assert.equal(parseArgs(['--full', '--full']).mode, 'full');
  assert.equal(parseArgs(['--list']).list, true, '--list needs no mode');
});

test('--skip and --only take step ids; anything else is an error', () => {
  assert.deepEqual(parseArgs(['--fresh', '--skip', 'unit,corpus']).skip, ['unit', 'corpus']);
  assert.deepEqual(parseArgs(['--fresh', '--only', 'privacy']).only, ['privacy']);
  assert.throws(() => parseArgs(['--fresh', '--skip']), /needs/);
  assert.throws(() => parseArgs(['--fresh', '--push']), /unknown argument/);
});

test('every step has an id and a title, in the order the plan gives; the mode names the history step', () => {
  const ids = buildSteps('.', 'full').map((step) => step.id);
  assert.deepEqual(ids, ['typecheck', 'unit', 'scripts', 'harness', 'corpus', 'pack', 'binaries', 'privacy', 'history']);
  assert.match(buildSteps('.', 'fresh').at(-1).title, /--fresh: tree only/);
  assert.match(buildSteps('.', 'full').at(-1).title, /--full: git log -p, all refs/);
});

test('the table lists every step with its result and keeps extra lines under their row', () => {
  const table = formatTable([
    { title: 'one', status: 'pass', detail: 'fine' },
    { title: 'history', status: 'KNOWN', detail: 'first\n    second' },
  ]);
  const lines = table.split('\n');
  assert.match(lines[0], /^step\s+result\s+detail$/);
  assert.match(lines[2], /^one\s+pass\s+fine$/);
  assert.match(lines[3], /^history\s+KNOWN\s+first$/);
  assert.equal(lines[4], '    second');
});

test('a step that throws is a FAIL row, not a crash, and the following steps still run', async () => {
  const rows = await runSteps(
    [
      { id: 'a', title: 'a', run: async () => { throw new Error('boom'); } },
      { id: 'b', title: 'b', run: async () => ({ status: 'pass', detail: 'ok' }) },
    ],
    { log: () => {} },
  );
  assert.deepEqual(rows.map((row) => row.status), ['FAIL', 'pass']);
  assert.match(rows[0].detail, /boom/);
});

test('the pre-public list holds the commits the decision records name', () => {
  const prefixes = KNOWN_PREPUBLIC.map(([prefix]) => prefix);
  for (const expected of ['24a855b', 'c3bbd89', '09f9d71', '6a3ef86', 'a4f2703']) assert.ok(prefixes.includes(expected), expected);
  assert.equal(prefixes.length, 10);
  for (const [prefix, why] of KNOWN_PREPUBLIC) {
    assert.match(prefix, /^[0-9a-f]{7}$/);
    assert.match(why, /^000[36]/);
  }
  assert.ok(knownEntry('6a3ef86' + 'f'.repeat(33), KNOWN_PREPUBLIC));
  assert.equal(knownEntry('abcdef0' + '0'.repeat(33), KNOWN_PREPUBLIC), null);
});

test('the tree scan covers the tracked files at HEAD only', async () => {
  await withRepo((dir) => {
    commit(dir, 'clean.txt', 'nothing here\n', 'one');
    assert.deepEqual(scanTree(dir), []);
    commit(dir, 'notes.txt', `ok\npath: ${WINPATH}\n`, 'two');
    writeFileSync(path.join(dir, 'dirty-working-tree.txt'), TOKEN); // untracked: not published
    const findings = scanTree(dir);
    assert.deepEqual(findings.map((f) => [f.where, f.line, f.kind]), [['notes.txt', 2, 'absolute-path']]);
    assert.doesNotMatch(JSON.stringify(findings), /alice|secret/);
  });
});

test('--full finds what an old commit added even after a later commit removed it; --fresh does not see it', async () => {
  await withRepo(async (dir) => {
    commit(dir, 'a.txt', 'clean\n', 'one');
    const bad = commit(dir, 'a.txt', `clean\n${TOKEN}\n`, 'two');
    commit(dir, 'a.txt', 'clean\n', 'three, the token is gone from the tree');

    assert.deepEqual(scanTree(dir), [], 'the tree is clean (this is what --fresh scans)');
    const { commits, findings } = await scanHistory(dir, { known: [] });
    assert.equal(commits, 3);
    assert.deepEqual(findings.map((f) => [f.commit, f.where, f.kind]), [[bad, 'a.txt', 'token']]);
    assert.doesNotMatch(JSON.stringify(findings), /ghp_/);
  });
});

test('the history scan reads commit messages and authors too; an unlisted author address is a finding', async () => {
  await withRepo(async (dir) => {
    commit(dir, 'a.txt', 'x\n', join('see ', WINPATH));
    const other = commit(dir, 'b.txt', 'y\n', 'plain', ['someone', 'corp-mail.net'].join(String.fromCharCode(64)));
    const { findings } = await scanHistory(dir, { known: [] });
    assert.deepEqual(findings.map((f) => [f.where, f.kind]).sort(), [['author', 'author-email'], ['message', 'absolute-path']]);
    assert.equal(findings.find((f) => f.where === 'author').commit, other);
  });
});

test('a commit that no ref reaches is scanned when it is on the known list, and is told apart as known', async () => {
  await withRepo(async (dir) => {
    commit(dir, 'a.txt', 'clean\n', 'one');
    git(dir, 'checkout', '-q', '-b', 'side');
    const lost = commit(dir, 'a.txt', `clean\n${TOKEN}\n`, 'on a side branch');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'branch', '-D', 'side'); // now no ref reaches it, as with the squashed pull-request branches
    const known = [[lost.slice(0, 7), '0003: test']];
    const { findings } = await scanHistory(dir, { known });
    assert.deepEqual(findings.map((f) => f.commit), [lost]);
    assert.ok(knownEntry(findings[0].commit, known));
    assert.equal(countsByKind(findings), '1 token');
  });
});

function run(cwd, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env, encoding: 'utf8' });
}

test('CLI: no mode is a usage error (2); a clean repository passes (0); a finding fails (1) without printing it', async () => {
  await withRepo((dir) => {
    commit(dir, 'a.txt', 'clean\n', 'one');
    assert.equal(run(dir, '--only', 'privacy').status, 2);
    const clean = run(dir, '--fresh', '--only', 'privacy,history');
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /all steps passed/);
    assert.match(clean.stdout, /history to publish \(--fresh: tree only\)\s+pass/);

    commit(dir, 'a.txt', `clean\n${TOKEN}\n`, 'two');
    const dirty = run(dir, '--full', '--only', 'privacy,history');
    assert.equal(dirty.status, 1);
    assert.match(dirty.stdout, /FAIL/);
    assert.doesNotMatch(dirty.stdout + dirty.stderr, /ghp_/);
  });
});

test('CLI: an unknown step id is a usage error', async () => {
  await withRepo((dir) => {
    commit(dir, 'a.txt', 'x\n', 'one');
    assert.equal(run(dir, '--fresh', '--only', 'nope').status, 2);
  });
});
