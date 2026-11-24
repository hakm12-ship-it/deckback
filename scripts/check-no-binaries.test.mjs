import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { IMAGE_ALLOWLIST, findRejected, findViolations, isMainModule } from './check-no-binaries.mjs';

const script = fileURLToPath(new URL('./check-no-binaries.mjs', import.meta.url));

const MIB = 1024 * 1024;
const OLD_EXTENSIONS = ['pdf', 'pptx', 'png', 'jpg', 'jpeg', 'ttf', 'otf', 'woff', 'woff2', 'fntdata', 'eot'];
const NEW_EXTENSIONS = [
  'ttc', 'otc', 'pfb', 'pfa', 'cff', 'ppt', 'ppsx', 'potx', 'pps', 'key',
  'gif', 'bmp', 'webp', 'tif', 'tiff', 'emf', 'wmf', 'zip', 'docx', 'xlsx', 'hwp', 'hwpx',
];

// The unit tests never touch the file system: every call brings its own readers.
const unreadable = () => null; // content that cannot be read (never consulted for a name that is refused outright)
const emptyFile = () => new Uint8Array(0); // a readable file with no bytes
const tiny = { sizeOf: () => 10 };

test('rejects binary, office and font files', () => {
  assert.deepEqual(findRejected(['a/b.pdf', 'x.PPTX', 'f.ttf', 'out.png'], unreadable), ['a/b.pdf', 'x.PPTX', 'f.ttf', 'out.png']);
});

test('rejects every extension on the list, case-insensitively', () => {
  const exts = [...OLD_EXTENSIONS, ...NEW_EXTENSIONS];
  const paths = exts.flatMap((ext) => [`d/file.${ext}`, `d/FILE.${ext.toUpperCase()}`]);
  assert.deepEqual(findRejected(paths, unreadable), paths);
});

test('accepts source files and a real-looking .pdf/.pptx under corpus/generated/', () => {
  assert.deepEqual(findRejected(['corpus/generated/deck.pdf', 'src/a.ts'], emptyFile, tiny), []);
  assert.deepEqual(findRejected(['corpus/generated/sub/deck.PPTX'], emptyFile, tiny), []);
});

test('the corpus/generated/ exception is anchored at the repo root and is a directory', () => {
  const paths = ['corpus/private/probe/original.pdf', 'sub/corpus/generated/x.pdf', 'corpus/generatedx/x.pdf'];
  assert.deepEqual(findRejected(paths, unreadable), paths);
});

test('only the final extension counts', () => {
  assert.deepEqual(findRejected(['pdf', 'notes.pdf.md', 'archive.png.ts'], emptyFile), []);
  assert.deepEqual(findRejected(['report.md.pdf'], emptyFile), ['report.md.pdf']);
});

// --- magic bytes: the content decides, whatever the name says ---------------------

/** Heads from byte arrays and latin1 strings, in order. */
const bytes = (...parts) => Uint8Array.from(parts.flatMap((part) => (typeof part === 'string' ? [...Buffer.from(part, 'latin1')] : part)));
const le32 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const heads = (table) => (p) => table[p] ?? null;
const bmp = (dibSize) => bytes('BM', le32(54), [0, 0, 0, 0], le32(54), le32(dibSize), le32(1), le32(1));
const eot = () => bytes(new Array(34).fill(0x41), 'LP', [1, 0]); // EOT magic number at bytes 34-35

const SIGNATURES = {
  pdf: bytes('%PDF-1.7\n'),
  zip: bytes([0x50, 0x4b, 0x03, 0x04], [0x14, 0x00, 0x06, 0x00]),
  ole2: bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], [0, 0, 0, 0]),
  png: bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
  gif: bytes('GIF89a', [1, 0]),
  webp: bytes('RIFF', le32(36), 'WEBPVP8 '),
  'tiff little-endian': bytes('II', [0x2a, 0x00], le32(8)),
  'tiff big-endian': bytes('MM', [0x00, 0x2a], [0, 0, 0, 8]),
  bmp: bmp(40),
  'sfnt 00010000': bytes([0x00, 0x01, 0x00, 0x00], [0x00, 0x11], [1, 0, 0, 0, 0, 0]),
  'sfnt OTTO': bytes('OTTO', [0x00, 0x0f], [1, 0, 0, 0]),
  'sfnt true': bytes('true', [0x00, 0x0a], [1, 0, 0, 0]),
  ttcf: bytes('ttcf', [0, 1, 0, 0]),
  wOFF: bytes('wOFF', [0, 1, 0, 0]),
  wOF2: bytes('wOF2', [0, 1, 0, 0]),
  'pfb (binary Type 1)': bytes([0x80, 0x01], [0x10, 0, 0, 0], '%!PS-AdobeFont-1.0'),
  'pfa (ascii Type 1)': bytes('%!PS-AdobeFont-1.0: Foo 1.0\n'),
  eot: eot(),
};

test('a renamed file is caught by its first bytes, whatever its name', () => {
  for (const [name, head] of Object.entries(SIGNATURES)) {
    for (const p of ['notes.txt', 'LICENSE', 'src/a.ts']) {
      assert.deepEqual(findRejected([p], heads({ [p]: head })), [p], `${name} as ${p}`);
    }
  }
});

test('every BMP header size is caught, every sfnt needs at least one table', () => {
  for (const dib of [12, 40, 52, 56, 64, 108, 124]) {
    assert.deepEqual(findRejected(['x.dat'], heads({ 'x.dat': bmp(dib) })), ['x.dat'], `BMP DIB header ${dib}`);
  }
  for (const tag of ['true', 'OTTO']) {
    assert.deepEqual(findRejected(['x.dat'], heads({ 'x.dat': bytes(tag, [0, 1]) })), ['x.dat'], `${tag} with 1 table`);
  }
  assert.deepEqual(findRejected(['x.dat'], heads({ 'x.dat': bytes([0, 1, 0, 0], [0, 1]) })), ['x.dat'], '00010000 with 1 table');
});

test('a signature is matched at its exact length, with nothing after it', () => {
  const bare = {
    '%PDF-': bytes('%PDF-'),
    'PK\\3\\4': bytes([0x50, 0x4b, 0x03, 0x04]),
    OLE2: bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    '\\x89PNG': bytes([0x89, 0x50, 0x4e, 0x47]),
    'FF D8 FF': bytes([0xff, 0xd8, 0xff]),
    GIF8: bytes('GIF8'),
    'RIFF....WEBP': bytes('RIFF', [0, 0, 0, 0], 'WEBP'),
    'II*\\0': bytes('II', [0x2a, 0]),
    'MM\\0*': bytes('MM', [0, 0x2a]),
    ttcf: bytes('ttcf'),
    wOF2: bytes('wOF2'),
    'PFB 80 01': bytes([0x80, 0x01]),
    '%!PS-AdobeFont': bytes('%!PS-AdobeFont'),
  };
  for (const [name, head] of Object.entries(bare)) {
    assert.deepEqual(findRejected(['x.dat'], heads({ 'x.dat': head })), ['x.dat'], name);
  }
});

test('ordinary content, near misses, short and empty heads are accepted', () => {
  const fine = {
    'a.md': bytes('# title\n'),
    'b.json': bytes('{"a":1}'),
    'c.sh': bytes('#!/bin/sh\n'),
    'bom.txt': bytes([0xef, 0xbb, 0xbf, 0x23]),
    'nearpdf.txt': bytes('%PDF'),
    'nearpng.bin': bytes([0x89, 0x50, 0x4e]),
    'nearjpg.bin': bytes([0xff, 0xd8, 0x00]),
    'neargif.txt': bytes('GIF'),
    'nearzip.bin': bytes([0x50, 0x4b, 0x05, 0x06]),
    'nearole.bin': bytes([0xd0, 0xcf, 0x11, 0xe0]),
    'one.bin': bytes('B'),
    'empty.txt': bytes(),
    // text that starts like a short signature
    'bm25.md': bytes('BM25 results for the ranking function\n'),
    'bm-only.txt': bytes('BM'),
    'true-story.md': bytes('true story: how it started in 1999\n'),
    'true-line.txt': bytes('true\n'),
    'otto.txt': bytes('OTTO is a name\n'),
    // right start, wrong header
    'bmp-odd-dib.bin': bmp(41),
    'true-no-tables.bin': bytes('true', [0, 0], [1, 0, 0, 0]),
    'sfnt-high-table-count.bin': bytes([0, 1, 0, 0], [1, 0], [0, 0]),
    'wav.bin': bytes('RIFF', le32(36), 'WAVEfmt '),
    'riff-short.bin': bytes('RIFF', le32(36), 'WEB'),
    'tiff-short.bin': bytes('II*'),
    'postscript.ps': bytes('%!PS-Adobe-3.0\n'),
    'pfb-near.bin': bytes([0x80, 0x02]),
    'eot-short.bin': bytes(new Array(34).fill(0x41), 'L'), // 35 bytes: the magic is not there yet
    'eot-shifted.bin': bytes(new Array(33).fill(0x41), 'LP', 'A'),
  };
  assert.deepEqual(findRejected(Object.keys(fine), heads(fine)), []);
});

test('a file whose content cannot be read is refused, not waved through', () => {
  const [violation] = findViolations(['gone.txt'], unreadable);
  assert.equal(violation.path, 'gone.txt');
  assert.match(violation.reason, /could not be read/);
  assert.deepEqual(findRejected(['gone.txt'], unreadable), ['gone.txt']);
});

test('content is not read for a file the extension already rejects', () => {
  const asked = [];
  const read = (p) => (asked.push(p), new Uint8Array(0));
  assert.deepEqual(findRejected(['a.ttf', 'b.txt'], read), ['a.ttf']);
  assert.deepEqual(asked, ['b.txt']);
});

test('a path with no file content (symlink, submodule) is judged by its name only', () => {
  const options = { contentless: () => true };
  assert.deepEqual(findRejected(['link', 'link.pdf', 'corpus/generated/link.md'], unreadable, options), ['link.pdf']);
});

// --- corpus/generated/: only .pdf .pptx .png .md .json, with size caps -----------------------

const sizes = (table) => ({ sizeOf: (p) => table[p] ?? null });

test('corpus/generated/ rejects every other type, by extension and by content', () => {
  const paths = [
    'corpus/generated/a.ttf',
    'corpus/generated/b.zip',
    'corpus/generated/c.docx',
    'corpus/generated/d.gif',
    'corpus/generated/e.woff2',
    'corpus/generated/f.JPG',
    'corpus/generated/x.dat',
    'corpus/generated/notes.txt',
    'corpus/generated/table.csv',
    'corpus/generated/.gitkeep',
    'corpus/generated/LICENSE',
    'corpus/generated/old.doc',
    'corpus/generated/sub/x.dat',
  ];
  assert.deepEqual(findRejected(paths, emptyFile, tiny), paths);
  const disguised = {
    'corpus/generated/g.md': SIGNATURES.pdf,
    'corpus/generated/h.json': SIGNATURES['sfnt true'],
    'corpus/generated/i.md': SIGNATURES.ole2,
    'corpus/generated/j.json': SIGNATURES.zip,
  };
  assert.deepEqual(findRejected(Object.keys(disguised), heads(disguised), tiny), Object.keys(disguised));
});

test('corpus/generated/ may hold a README.md and a manifest.json', () => {
  const text = {
    'corpus/generated/README.md': bytes('# corpus\n'),
    'corpus/generated/manifest.json': bytes('{"files":[]}'),
    'corpus/generated/sub/NOTES.MD': bytes('BM25 notes\n'),
  };
  assert.deepEqual(findRejected(Object.keys(text), heads(text), tiny), []);
});

test('a .pdf .pptx .png under corpus/generated/ must really be that type', () => {
  const good = {
    'corpus/generated/a.pdf': SIGNATURES.pdf,
    'corpus/generated/b.pptx': SIGNATURES.zip,
    'corpus/generated/c/d.PNG': SIGNATURES.png,
  };
  assert.deepEqual(findRejected(Object.keys(good), heads(good), tiny), []);
  const bad = {
    'corpus/generated/a.pdf': SIGNATURES['sfnt OTTO'],
    'corpus/generated/b.pptx': SIGNATURES.pdf,
    'corpus/generated/c.png': SIGNATURES.zip,
    'corpus/generated/d.png': SIGNATURES.pdf,
    'corpus/generated/e.pptx': SIGNATURES.ole2,
  };
  assert.deepEqual(findRejected(Object.keys(bad), heads(bad), tiny), Object.keys(bad));
});

test('a file under corpus/generated/ may be 3 MB but not a byte more', () => {
  const table = { 'corpus/generated/ok.pdf': 3 * MIB, 'corpus/generated/big.pdf': 3 * MIB + 1, 'corpus/generated/small.png': 1 * MIB };
  assert.deepEqual(findRejected(Object.keys(table), emptyFile, sizes(table)), ['corpus/generated/big.pdf']);
});

test('size caps apply to text files under corpus/generated/ too, and not to files elsewhere', () => {
  const table = { 'corpus/generated/manifest.json': 4 * MIB, 'docs/big.md': 50 * MIB };
  assert.deepEqual(findRejected(Object.keys(table), emptyFile, sizes(table)), ['corpus/generated/manifest.json']);
});

test('a file under corpus/generated/ whose size is unknown is refused', () => {
  const [violation] = findViolations(['corpus/generated/a.pdf'], heads({ 'corpus/generated/a.pdf': SIGNATURES.pdf }), sizes({}));
  assert.equal(violation.path, 'corpus/generated/a.pdf');
  assert.match(violation.reason, /size could not be read/);
});

test('corpus/generated/ may total 12 MB but not a byte more; the directory is a violation, not a listed file', () => {
  const four = Object.fromEntries([1, 2, 3, 4].map((n) => [`corpus/generated/${n}.pdf`, 3 * MIB]));
  assert.deepEqual(findViolations(Object.keys(four), emptyFile, sizes(four)), []);
  const five = { ...four, 'corpus/generated/5.png': 1 };
  const violations = findViolations(Object.keys(five), emptyFile, sizes(five));
  assert.deepEqual(violations.map(({ path: p, directory }) => [p, directory]), [['corpus/generated/', true]]);
  assert.match(violations[0].reason, /\(\d+ bytes\) in total/);
  assert.deepEqual(findRejected(Object.keys(five), emptyFile, sizes(five)), []);
});

test('the 12 MB total counts files that are already tracked, not just the ones being checked', () => {
  const tracked = Object.fromEntries([1, 2, 3, 4].map((n) => [`corpus/generated/${n}.pdf`, 3 * MIB]));
  const table = { ...tracked, 'corpus/generated/new.png': 1024 };
  const violations = findViolations(['corpus/generated/new.png', 'src/a.ts'], emptyFile, {
    ...sizes(table),
    generatedPaths: Object.keys(table),
  });
  assert.deepEqual(violations.map(({ path: p }) => p), ['corpus/generated/']);
});

// --- the entry-point test ---------------------------------------------------------

test('isMainModule: same URL is main, a non-file is not, a link is main, any other error is not swallowed', () => {
  const self = pathToFileURL(script).href;
  const denied = () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' });
  };
  assert.equal(isMainModule(script, self, denied), true, 'equal URLs need no realpath');
  assert.equal(isMainModule(undefined, self), false);
  assert.equal(isMainModule(path.join(tmpdir(), 'no-such-file.mjs'), self), false);
  assert.equal(isMainModule(path.join(tmpdir(), 'link-to-it.mjs'), self, () => 'same real path'), true);
  assert.equal(isMainModule(path.join(tmpdir(), 'other.mjs'), self, (p) => p), false);
  assert.throws(() => isMainModule(path.join(tmpdir(), 'other.mjs'), self, denied), /denied/);
});

test('the prepare script wires the hooks and cannot fail an install', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.prepare, 'git config core.hooksPath .githooks || exit 0');
});

// --- command line: runs the script in a throwaway git repository -----------------

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: cleanEnv,
    encoding: 'utf8',
  });
}

function withRepo(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deckback-guard-'));
  try {
    git(dir, 'init', '-q');
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir, rel, content = 'x') {
  const file = path.join(dir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Puts `content` into the index at `rel` with the given mode, without touching the working tree (a symlink needs no privileges). */
function stageRaw(dir, mode, rel, content) {
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, env: cleanEnv, input: content, encoding: 'utf8' }).trim();
  git(dir, 'update-index', '--add', '--cacheinfo', `${mode},${oid},${rel}`);
  return oid;
}

function runGuard(cwd, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env: cleanEnv, encoding: 'utf8' });
}

const lines = (text) => text.split('\n').filter(Boolean);

test('exits 1 and prints each rejected staged path on its own line', () => {
  withRepo((dir) => {
    for (const rel of ['a/b.pdf', 'src/a.ts', 'x.PPTX', '한글 자료.png', 'corpus/generated/deck.pdf']) write(dir, rel);
    git(dir, 'add', '-A');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(result.stdout.split('\n').filter(Boolean).sort(), ['a/b.pdf', 'x.PPTX', '한글 자료.png']);
  });
});

test('exits 0 and prints nothing when nothing rejected is staged', () => {
  withRepo((dir) => {
    for (const rel of ['src/a.ts', 'corpus/generated/deck.pdf']) write(dir, rel);
    git(dir, 'add', '-A');
    const result = runGuard(dir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
});

test('ignores binaries that are not staged and allows deleting a committed one', () => {
  withRepo((dir) => {
    write(dir, 'old.pdf');
    git(dir, 'add', '-f', 'old.pdf');
    git(dir, 'commit', '-q', '-m', 'seed');
    write(dir, 'unstaged.png');
    git(dir, 'rm', '-q', 'old.pdf');
    const result = runGuard(dir);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
});

test('still blocks when the script is reached through a symlink or junction', () => {
  withRepo((dir) => {
    write(dir, 'a.png');
    git(dir, 'add', '-A');
    const linkBase = mkdtempSync(path.join(tmpdir(), 'deckback-guard-link-'));
    const link = path.join(linkBase, 'scripts-link');
    try {
      // 'junction' needs no privileges on Windows; elsewhere it is an ordinary directory symlink.
      symlinkSync(path.dirname(script), link, 'junction');
      const result = spawnSync(process.execPath, [path.join(link, path.basename(script))], {
        cwd: dir,
        env: cleanEnv,
        encoding: 'utf8',
      });
      assert.equal(result.status, 1);
      assert.deepEqual(result.stdout.split('\n').filter(Boolean), ['a.png']);
    } finally {
      // Remove the link itself first, so the recursive delete below can never reach the real scripts directory.
      // If this unlink fails the temp directory is left behind on purpose; that is the safe failure.
      try {
        unlinkSync(link);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      rmSync(linkBase, { recursive: true, force: true });
    }
  });
});

test('importing the module does not throw when argv[1] is not a file', () => {
  const moduleUrl = pathToFileURL(script).href;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`, 'no-such-file.mjs'],
    { cwd: tmpdir(), env: cleanEnv, encoding: 'utf8' },
  );
  assert.equal(result.stderr, '');
  assert.equal(result.status, 0);
});

test('a renamed PDF (notes.txt starting with %PDF-) is rejected at commit time', () => {
  withRepo((dir) => {
    write(dir, 'notes.txt', '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n');
    write(dir, 'readme.md', '# fine\n');
    git(dir, 'add', '-A');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout), ['notes.txt']);
    assert.match(result.stderr, /notes\.txt/);
  });
});

test('.ttc and .key files are rejected', () => {
  withRepo((dir) => {
    for (const rel of ['fonts/set.ttc', 'slides.key', 'src/a.ts']) write(dir, rel);
    git(dir, 'add', '-A');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout).sort(), ['fonts/set.ttc', 'slides.key']);
  });
});

test('the staged content is what counts, not the working-tree copy', () => {
  withRepo((dir) => {
    write(dir, 'staged-pdf.txt', '%PDF-1.4\n');
    write(dir, 'later-pdf.txt', 'plain text\n');
    git(dir, 'add', '-A');
    write(dir, 'staged-pdf.txt', 'edited afterwards to look harmless\n'); // not re-staged: the PDF is still what gets committed
    write(dir, 'later-pdf.txt', '%PDF-1.4\n'); // not staged: the commit only holds the plain text
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout), ['staged-pdf.txt']);
  });
});

test('a staged type change (symlink to regular file) is checked, not skipped', () => {
  withRepo((dir) => {
    stageRaw(dir, '120000', 'notes', 'target.txt');
    git(dir, 'commit', '-q', '-m', 'a symlink');
    stageRaw(dir, '100644', 'notes', '%PDF-1.7\nnow a regular file holding a PDF\n');
    assert.match(git(dir, 'diff', '--cached', '--name-status'), /^T\tnotes$/m, 'the scenario is a T (type change) entry');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout), ['notes']);
  });
});

test('a symlink is judged by its name, not by the text of its target; a regular file is read', () => {
  withRepo((dir) => {
    stageRaw(dir, '120000', 'current', '%PDF-1.7 looks like a PDF but is only a link target');
    stageRaw(dir, '120000', 'shortcut.pdf', 'somewhere');
    stageRaw(dir, '100644', 'real.dat', '%PDF-1.7\n');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout).sort(), ['real.dat', 'shortcut.pdf']);
  });
});

test('a staged file with a non-ASCII name is checked by content too', () => {
  withRepo((dir) => {
    write(dir, '한글 메모', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    git(dir, 'add', '-A');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout), ['한글 메모']);
  });
});

test('the blob reader stays in step over many staged files of odd sizes, empty ones and duplicates included', () => {
  withRepo((dir) => {
    let seed = 12345;
    const nextSize = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return [0, 1, 7, 8, 9, 65535, 65536, 65537][seed % 8] + (seed >> 8) % 3000;
    };
    for (let i = 0; i < 120; i += 1) {
      const filler = Buffer.alloc(nextSize(), 0x41 + (i % 20)); // one repeated letter: never a signature
      if (i === 0) write(dir, 'f000', Buffer.concat([Buffer.from('%PDF-1.4\n'), filler]));
      else if (i === 57) write(dir, 'f057', Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), filler]));
      else if (i === 119) write(dir, 'f119', Buffer.concat([Buffer.from('wOF2'), filler]));
      else if (i === 60) write(dir, 'f060-empty', Buffer.alloc(0));
      else write(dir, `f${String(i).padStart(3, '0')}`, filler);
    }
    write(dir, 'empty-a', Buffer.alloc(0));
    write(dir, 'empty-b', Buffer.alloc(0));
    git(dir, 'add', '-A');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout).sort(), ['f000', 'f057', 'f119']);
  });
});

test('corpus/generated/a.pdf: 3.1 MB is rejected, 1 MB is accepted', () => {
  withRepo((dir) => {
    write(dir, 'corpus/generated/a.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(Math.round(3.1 * MIB))]));
    git(dir, 'add', '-A');
    const big = runGuard(dir);
    assert.equal(big.status, 1);
    assert.deepEqual(lines(big.stdout), ['corpus/generated/a.pdf']);
    assert.match(big.stderr, /3\.1 MB \(\d+ bytes\) is over the 3 MB limit/);

    write(dir, 'corpus/generated/a.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(1 * MIB)]));
    git(dir, 'add', '-A');
    const small = runGuard(dir);
    assert.equal(small.status, 0);
    assert.equal(small.stdout, '');
  });
});

test('corpus/generated/a.ttf, x.dat and an OLE2 file are rejected; README.md and manifest.json are accepted', () => {
  withRepo((dir) => {
    write(dir, 'corpus/generated/a.ttf', Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]));
    write(dir, 'corpus/generated/x.dat', 'plain');
    write(dir, 'corpus/generated/old.md', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]));
    write(dir, 'corpus/generated/README.md', '# generated\n');
    write(dir, 'corpus/generated/manifest.json', '{"files":[]}\n');
    git(dir, 'add', '-A');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout).sort(), ['corpus/generated/a.ttf', 'corpus/generated/old.md', 'corpus/generated/x.dat']);
  });
});

test('corpus/generated/ total counts committed files; over it is exit 1 with nothing on stdout; a deletion that fits is allowed', () => {
  withRepo((dir) => {
    for (const n of [1, 2, 3, 4]) write(dir, `corpus/generated/${n}.pdf`, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3 * MIB - 9)]));
    git(dir, 'add', '-A');
    assert.equal(runGuard(dir).status, 0, 'exactly 12 MB is allowed');
    git(dir, 'commit', '-q', '-m', 'seed');

    write(dir, 'corpus/generated/extra.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
    git(dir, 'add', '-A');
    const over = runGuard(dir);
    assert.equal(over.status, 1);
    assert.equal(over.stdout, '', 'the directory is not a file path');
    assert.match(over.stderr, /corpus\/generated\/: holds .*\(\d+ bytes\) in total/);

    git(dir, 'rm', '-q', '--cached', 'corpus/generated/1.pdf');
    assert.equal(runGuard(dir).status, 0);
  });
});

test('--all lists every violation among the tracked files', () => {
  withRepo((dir) => {
    for (const rel of [
      'src/a.ts',
      'notes.txt',
      'deck.pptx',
      'fonts/set.ttc',
      'img/logo.png',
      'corpus/generated/ok.pdf',
      'corpus/generated/README.md',
      'corpus/generated/font.ttf',
      'corpus/generated/blob.dat',
      '한글 자료.hwp',
    ]) {
      write(dir, rel);
    }
    write(dir, 'notes.txt', '%PDF-1.7\n');
    write(dir, 'corpus/generated/huge.png', Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4 * MIB)]));
    git(dir, 'add', '-A', '-f');
    git(dir, 'commit', '-q', '-m', 'seed');
    write(dir, 'untracked.pdf'); // not tracked: --all ignores it
    const result = runGuard(dir, '--all');
    assert.equal(result.status, 1);
    assert.deepEqual(
      lines(result.stdout).sort(),
      [
        'corpus/generated/blob.dat',
        'corpus/generated/font.ttf',
        'corpus/generated/huge.png',
        'deck.pptx',
        'fonts/set.ttc',
        'img/logo.png',
        'notes.txt',
        '한글 자료.hwp',
      ].sort(),
    );
  });
});

test('--all exits 0 and prints nothing on a clean repository, and works from a subdirectory', () => {
  withRepo((dir) => {
    for (const rel of ['src/a.ts', 'corpus/generated/ok.pdf', 'corpus/generated/manifest.json']) write(dir, rel);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'seed');
    const result = runGuard(dir, '--all');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');

    write(dir, 'src/deep/bad.pdf');
    git(dir, 'add', '-f', 'src/deep/bad.pdf');
    git(dir, 'commit', '-q', '-m', 'bad');
    const fromSubdir = runGuard(path.join(dir, 'src', 'deep'), '--all');
    assert.equal(fromSubdir.status, 1);
    assert.deepEqual(lines(fromSubdir.stdout), ['src/deep/bad.pdf']);
  });
});

test('--all judges what git holds: a tracked file deleted or overwritten in the working tree is still caught', () => {
  withRepo((dir) => {
    write(dir, 'notes.txt', '%PDF-1.7\n');
    write(dir, 'other.txt', '%PDF-1.7\n');
    write(dir, 'fine.txt', 'ok');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'seed');
    rmSync(path.join(dir, 'notes.txt'));
    write(dir, 'other.txt', 'harmless text now');
    const result = runGuard(dir, '--all');
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout).sort(), ['notes.txt', 'other.txt']);
  });
});

test('--all skips the text of symlinks but still checks their names', () => {
  withRepo((dir) => {
    stageRaw(dir, '120000', 'current', '%PDF-1.7 only a link target');
    stageRaw(dir, '100644', 'src.ts', 'export {};\n');
    git(dir, 'commit', '-q', '-m', 'seed');
    assert.equal(runGuard(dir, '--all').status, 0);
    stageRaw(dir, '120000', 'x.pdf', 'target');
    git(dir, 'commit', '-q', '-m', 'bad name');
    assert.deepEqual(lines(runGuard(dir, '--all').stdout), ['x.pdf']);
  });
});

test('--all counts the directory total', () => {
  withRepo((dir) => {
    for (const n of [1, 2, 3, 4]) write(dir, `corpus/generated/${n}.pdf`, Buffer.alloc(3 * MIB));
    write(dir, 'corpus/generated/5.png', Buffer.alloc(10));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'seed');
    const result = runGuard(dir, '--all');
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /corpus\/generated\/: holds/);
  });
});

test('an object git cannot deliver fails the run (exit 1 with the path), staged and --all', () => {
  withRepo((dir) => {
    write(dir, 'a.txt', 'content a');
    git(dir, 'add', '-A');
    const lost = (rel) => {
      const oid = git(dir, 'ls-files', '-s', rel).split(/\s+/)[1];
      rmSync(path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
    };

    lost('a.txt');
    const staged = runGuard(dir);
    assert.equal(staged.status, 1);
    assert.equal(staged.stdout, '');
    assert.match(staged.stderr, /cannot read a\.txt/);
  });
  withRepo((dir) => {
    write(dir, 'b.txt', 'content b');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'seed');
    const oid = git(dir, 'ls-files', '-s', 'b.txt').split(/\s+/)[1];
    rmSync(path.join(dir, '.git', 'objects', oid.slice(0, 2), oid.slice(2)), { force: true });
    const all = runGuard(dir, '--all');
    assert.equal(all.status, 1);
    assert.match(all.stderr, /cannot read b\.txt/);
  });
});

test('an unknown argument is a usage error (exit 2), not a silent pass', () => {
  withRepo((dir) => {
    const result = runGuard(dir, '--everything');
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage/i);
  });
});

// --- the image allowlist: the README's comparison pictures, by path and SHA-256 --------------

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const REPO = fileURLToPath(new URL('..', import.meta.url));

test('the allowlist names 3-4 pictures under docs/images/, each a .png with a 64-hex SHA-256', () => {
  const entries = [...IMAGE_ALLOWLIST];
  assert.ok(entries.length >= 3 && entries.length <= 4, `${entries.length} pictures`);
  for (const [p, hash] of entries) {
    assert.match(p, /^docs\/images\/[a-z0-9-]+\.png$/);
    assert.match(hash, /^[0-9a-f]{64}$/);
  }
});

test('an allowlisted path passes only with exactly the listed bytes', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pic')]);
  const allowlist = new Map([['docs/images/a.png', sha256(png)]]);
  const head = () => png.subarray(0, 36);
  assert.deepEqual(findRejected(['docs/images/a.png'], head, { allowlist, hashOf: () => sha256(png) }), []);
  const other = findViolations(['docs/images/a.png'], head, { allowlist, hashOf: () => sha256('other') });
  assert.equal(other.length, 1);
  assert.match(other[0].reason, /allowlist.*differs/);
  assert.deepEqual(findRejected(['docs/images/a.png'], head, { allowlist, hashOf: () => null }), ['docs/images/a.png'], 'unreadable is refused');
});

test('a .png that is not on the allowlist is refused, wherever it is, even next to an allowed one', () => {
  const allowlist = new Map([['docs/images/a.png', 'a'.repeat(64)]]);
  const paths = ['docs/images/b.png', 'images/a.png', 'docs/images/sub/a.png', 'docs/images/a.png.png', 'DOCS/images/a.png'];
  assert.deepEqual(findRejected(paths, emptyFile, { allowlist, hashOf: () => 'a'.repeat(64) }), paths);
});

test('an allowlisted name cannot carry another type of file: the hash decides, the extension never widens', () => {
  const allowlist = new Map([['docs/images/a.png', sha256('fake')]]);
  // same path, other bytes (a PDF renamed to .png): refused by the hash
  assert.deepEqual(findRejected(['docs/images/a.png'], () => SIGNATURES.pdf, { allowlist, hashOf: () => sha256(SIGNATURES.pdf) }), ['docs/images/a.png']);
});

test('CLI: the real committed pictures pass, a changed copy or an extra picture is refused', () => {
  const [[listed, hash]] = IMAGE_ALLOWLIST;
  const original = readFileSync(path.join(REPO, listed));
  assert.equal(sha256(original), hash, 'the file in the repository is the listed one');
  withRepo((dir) => {
    write(dir, listed, original);
    git(dir, 'add', '-A');
    assert.equal(runGuard(dir).status, 0);
    assert.equal(runGuard(dir, '--all').status, 0);
    write(dir, listed, Buffer.concat([original, Buffer.from([0])]));
    write(dir, 'docs/images/extra.png', original);
    git(dir, 'add', '-A');
    const result = runGuard(dir);
    assert.equal(result.status, 1);
    assert.deepEqual(lines(result.stdout).sort(), [listed, 'docs/images/extra.png'].sort());
  });
});
