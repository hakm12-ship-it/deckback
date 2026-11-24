// scripts/fresh-export.mjs on a throw-away repository: one new commit, the same tree, nothing pushed, the source untouched.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { freshExport } from './fresh-export.mjs';

const NOREPLY = '123456+someone@users.noreply.github.com';
const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmpdir(), 'no-such-global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

function withSource(fn, email = NOREPLY) {
  const root = mkdtempSync(path.join(tmpdir(), 'fresh-export-test-'));
  const source = path.join(root, 'source');
  const out = path.join(root, 'out');
  mkdirSync(source);
  mkdirSync(out);
  try {
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.name', 'someone');
    git(source, 'config', 'user.email', email);
    mkdirSync(path.join(source, 'src'));
    writeFileSync(path.join(source, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(path.join(source, 'README.md'), '# hello\n');
    writeFileSync(path.join(source, 'crlf.txt'), Buffer.from([0x61, 0x0d, 0x0a, 0x62, 0x0d, 0x0a])); // a blob with CRLF line ends, committed before any attributes exist
    writeFileSync(path.join(source, '.gitignore'), 'ignored.txt\n');
    mkdirSync(path.join(source, 'packages', 'cli'), { recursive: true });
    writeFileSync(path.join(source, 'packages', 'cli', 'package.json'), JSON.stringify({ name: 'x', version: '9.9.9' }));
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'first');
    writeFileSync(path.join(source, 'src', 'b.ts'), 'export const b = 2;\n');
    writeFileSync(path.join(source, '.gitattributes'), '* text=auto eol=lf\n'); // a later rule must not change what the export copies
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'second');
    writeFileSync(path.join(source, 'ignored.txt'), 'private\n'); // ignored: never copied
    writeFileSync(path.join(source, 'untracked.txt'), 'new\n'); // untracked: never copied
    writeFileSync(path.join(source, 'README.md'), '# edited, not committed\n'); // the export is HEAD, not the working tree
    return fn({ source, out, root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('one commit with the same tree as HEAD, the author from the git config, no remote', () => {
  withSource(({ source, out }) => {
    const before = { head: git(source, 'rev-parse', 'HEAD'), count: git(source, 'rev-list', '--count', 'HEAD'), refs: git(source, 'for-each-ref') };
    const result = freshExport({ repo: source, outRoot: out, env, log: () => {} });

    assert.ok(result.dir.startsWith(out), 'the folder is under the given root');
    assert.equal(git(result.dir, 'rev-list', '--count', 'HEAD'), '1', 'a single commit');
    assert.equal(git(result.dir, 'rev-parse', 'HEAD^{tree}'), git(source, 'rev-parse', 'HEAD^{tree}'), 'the very same tree as HEAD');
    assert.equal(git(result.dir, 'log', '-1', '--format=%ae'), NOREPLY);
    assert.equal(git(result.dir, 'remote'), '', 'no remote');
    assert.equal(git(result.dir, 'status', '--porcelain'), '', 'a clean working tree');
    assert.deepEqual(readdirSync(result.dir).sort(), ['.git', '.gitattributes', '.gitignore', 'README.md', 'crlf.txt', 'packages', 'src']);
    assert.equal(readFileSync(path.join(result.dir, 'README.md'), 'utf8'), '# hello\n', 'HEAD content, not the edit');
    assert.equal(existsSync(path.join(result.dir, 'ignored.txt')), false);
    assert.equal(existsSync(path.join(result.dir, 'untracked.txt')), false);
    assert.match(git(result.dir, 'log', '-1', '--format=%s'), /9\.9\.9/, 'the subject names the package version');

    // the source repository is exactly as it was
    assert.deepEqual({ head: git(source, 'rev-parse', 'HEAD'), count: git(source, 'rev-list', '--count', 'HEAD'), refs: git(source, 'for-each-ref') }, before);
    assert.equal(git(source, 'remote'), '');
  });
});

test('the author is taken from the config, and only a GitHub noreply address is accepted', () => {
  withSource(
    ({ source, out }) => assert.throws(() => freshExport({ repo: source, outRoot: out, env, log: () => {} }), /noreply/),
    ['someone', 'corp-mail.net'].join(String.fromCharCode(64)),
  );
});

test('a dry run says what it would do and creates nothing', () => {
  withSource(({ source, out }) => {
    const lines = [];
    const result = freshExport({ repo: source, outRoot: out, env, dryRun: true, log: (line) => lines.push(line) });
    assert.equal(result.dryRun, true);
    assert.deepEqual(readdirSync(out), []);
    assert.match(lines.join('\n'), /\d+ tracked files/);
    assert.match(lines.join('\n'), /dry run/i);
  });
});

test('the script has no push in it and no remote is ever added', () => {
  const text = readFileSync(fileURLToPath(new URL('./fresh-export.mjs', import.meta.url)), 'utf8');
  const code = text.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');
  assert.doesNotMatch(code, /'push'|"push"|'remote'|'fetch'|'--force'/);
});

test('the copy is byte for byte HEAD (CRLF blobs and attribute rules included), is self-contained and passes fsck', () => {
  withSource(({ source, out }) => {
    const result = freshExport({ repo: source, outRoot: out, env, log: () => {} });
    assert.equal(git(result.dir, 'ls-tree', '-r', 'HEAD'), git(source, 'ls-tree', '-r', 'HEAD'), 'same modes, object ids and paths');
    assert.equal(existsSync(path.join(result.dir, '.git', 'objects', 'info', 'alternates')), false, 'no link back to the old object store');
    assert.equal(git(result.dir, 'fsck', '--no-dangling'), '');
    // the old repository can disappear and the new one still reads
    rmSync(source, { recursive: true, force: true });
    assert.equal(git(result.dir, 'cat-file', '-p', 'HEAD:src/a.ts'), 'export const a = 1;');
  });
});
