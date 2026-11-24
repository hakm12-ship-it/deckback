// The packed `deckback` package (M7 Task 2): what `npm pack` puts in the tarball, and that the bundle needs nothing
// installed beside it. Builds the CLI first (a few seconds), so it checks this commit's bundle.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repo, 'packages', 'cli');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: repo, encoding: 'utf8', shell: process.platform === 'win32' && cmd === npm, ...options });

run(npm, ['run', 'build:cli']);
const [pack] = JSON.parse(run(npm, ['pack', '-w', 'packages/cli', '--dry-run', '--json', '--ignore-scripts']));
const names = pack.files.map((file) => file.path.split(String.fromCharCode(92)).join('/'));
const pkg = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'));

test('the package is deckback 1.0.0, public, with one bin and no runtime dependencies', () => {
  assert.equal(pkg.name, 'deckback');
  assert.equal(pkg.version, '1.0.0');
  assert.notEqual(pkg.private, true);
  assert.deepEqual(pkg.bin, { deckback: 'dist/deckback.mjs' });
  assert.equal(pkg.license, 'Apache-2.0');
  assert.equal(pkg.engines.node, '>=22.13');
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) assert.equal(pkg[field], undefined, field);
  assert.equal(JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).name, 'deckback-monorepo');
});

test('the tarball holds only the bundle, the CJK character maps, package.json, README, LICENSE and NOTICE', () => {
  const rest = names.filter((name) => !name.startsWith('dist/cmaps/'));
  assert.deepEqual(rest.sort(), ['LICENSE', 'NOTICE', 'README.md', 'dist/deckback.mjs', 'package.json']);
  assert.ok(names.filter((name) => name.startsWith('dist/cmaps/')).length > 100);
  assert.ok(names.includes('dist/cmaps/UniKS-UCS2-H.bcmap'));
  assert.ok(names.includes('dist/cmaps/UniJIS-UCS2-H.bcmap'));
});

test('LICENSE is the repository Apache-2.0 text, and NOTICE names what the bundle holds', () => {
  assert.equal(readFileSync(join(cli, 'LICENSE'), 'utf8'), readFileSync(join(repo, 'LICENSE'), 'utf8'));
  const notice = readFileSync(join(cli, 'NOTICE'), 'utf8');
  assert.match(notice, /pdfjs-dist.*Apache-2\.0/s);
  assert.match(notice, /Copyright .*Mozilla Foundation/);
  assert.match(notice, /fflate.*MIT/s);
  assert.match(notice, /Arjun Barrett/);
  assert.doesNotMatch(notice, /@deckback\//);
  assert.match(notice, /^Copyright 2026 the deckback authors$/m);
});

test('NOTICE carries the full licence text of every bundled package that is not Apache-2.0 (fflate: MIT)', () => {
  const notice = readFileSync(join(cli, 'NOTICE'), 'utf8').replace(/\r\n/g, '\n');
  const fflateLicense = readFileSync(join(repo, 'node_modules', 'fflate', 'LICENSE'), 'utf8').replace(/\r\n/g, '\n').trim();
  assert.ok(fflateLicense.includes('Permission is hereby granted, free of charge'));
  assert.ok(notice.includes(fflateLicense), 'the whole fflate LICENSE text is in NOTICE');
  assert.match(notice, /THE SOFTWARE IS PROVIDED "AS IS"/);
  // every package the bundle names has its licence in NOTICE, or is Apache-2.0 (the LICENSE file covers it)
  for (const [, name, license] of notice.matchAll(/^(\S+) \d[^\n]*\n  License:   ([^\n]+)/gm)) {
    if (license === 'Apache-2.0') continue;
    assert.ok(notice.includes(`Licence text of ${name}`), `${name} (${license}) has no licence text in NOTICE`);
  }
});

test('the version the skill pins is the package version', () => {
  const skill = readFileSync(join(repo, 'skills', 'pdf-to-pptx', 'SKILL.md'), 'utf8');
  const pins = [...skill.matchAll(/deckback@(\d+\.\d+\.\d+\S*?)(?=\s|`)/g)].map((m) => m[1]);
  assert.ok(pins.length > 0);
  assert.deepEqual([...new Set(pins)], [pkg.version]);
});

test('prepack builds the package, and fails when the bundle, LICENSE or NOTICE is missing', () => {
  const check = join(cli, 'scripts', 'check-package.mjs');
  const saved = { LICENSE: readFileSync(join(cli, 'LICENSE')), NOTICE: readFileSync(join(cli, 'NOTICE')) };
  try {
    for (const file of ['LICENSE', 'NOTICE', 'dist/deckback.mjs']) {
      const path = join(cli, ...file.split('/'));
      const content = readFileSync(path);
      rmSync(path);
      assert.throws(() => run(process.execPath, [check], { stdio: 'pipe' }), (error) => error.status !== 0 && String(error.stderr).includes(file), `${file} missing must fail`);
      writeFileSync(path, content);
    }
    run(process.execPath, [check]); // all there: passes
    // from a state where dist is gone, `npm pack` (not --ignore-scripts) builds first and the tarball has the bin
    rmSync(join(cli, 'dist'), { recursive: true, force: true });
    rmSync(join(cli, 'LICENSE'));
    rmSync(join(cli, 'NOTICE'));
    const out = run(npm, ['pack', '-w', 'packages/cli', '--dry-run', '--json']); // the build's own log comes first
    const [packed] = JSON.parse(out.slice(out.search(/^\[\s*$/m)));
    const files = packed.files.map((file) => file.path.split(String.fromCharCode(92)).join('/'));
    for (const file of ['dist/deckback.mjs', 'LICENSE', 'NOTICE', 'dist/cmaps/UniKS-UCS2-H.bcmap']) assert.ok(files.includes(file), `${file} in the tarball`);
  } finally {
    writeFileSync(join(cli, 'LICENSE'), saved.LICENSE);
    writeFileSync(join(cli, 'NOTICE'), saved.NOTICE);
  }
});

test('the bundle has a shebang and imports nothing but Node built-ins', () => {
  const text = readFileSync(join(cli, 'dist', 'deckback.mjs'), 'utf8');
  assert.ok(text.startsWith('#!/usr/bin/env node\n'));
  const specifiers = [...text.matchAll(/(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/gm)].map((m) => m[1] ?? m[2]);
  assert.deepEqual(
    specifiers.filter((s) => !s.includes('${') && !s.startsWith('node:') && !builtinModules.includes(s)),
    [],
  );
  // the no-network claim leans on this: the bundle may not import anything that opens a connection or starts a program
  const forbidden = ['net', 'http', 'https', 'http2', 'dgram', 'tls', 'child_process', 'dns', 'worker_threads', 'cluster', 'inspector'];
  assert.deepEqual(
    specifiers.filter((s) => forbidden.includes(s.replace(/^node:/, ''))),
    [],
  );
});

test('the bundle runs from a folder with nothing beside it: --version, and the probe deck converts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deckback-pack-'));
  try {
    cpSync(join(cli, 'dist'), join(dir, 'dist'), { recursive: true });
    const bin = join(dir, 'dist', 'deckback.mjs');
    assert.equal(run(process.execPath, [bin, '--version'], { cwd: dir }), '1.0.0\n');
    const done = spawnSync(process.execPath, [bin, join(repo, 'corpus', 'generated', 'probe_std.pdf'), '-o', join(dir, 'o.pptx')], { cwd: dir, encoding: 'utf8' });
    assert.equal(done.status, 0);
    assert.equal(done.stderr, '', 'nothing on stderr on success (no pdf.js warnings)');
    assert.equal(JSON.parse(done.stdout).pages, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a Korean deck that needs a character map converts from the copied bundle, and loses its text without cmaps/', async () => {
  const { cjkPdf } = await import('./npx-smoke/make-cjk-pdf.mjs');
  const { unzipSync, strFromU8 } = await import('fflate');
  const dir = mkdtempSync(join(tmpdir(), 'deckback-cjk-'));
  try {
    cpSync(join(cli, 'dist'), join(dir, 'dist'), { recursive: true });
    const pdf = join(dir, 'cjk.pdf');
    writeFileSync(pdf, cjkPdf());
    const text = (pptx) => strFromU8(unzipSync(new Uint8Array(readFileSync(pptx)))['ppt/slides/slide1.xml']);
    run(process.execPath, [join(dir, 'dist', 'deckback.mjs'), pdf, '-o', join(dir, 'with.pptx')], { cwd: dir });
    assert.match(text(join(dir, 'with.pptx')), /<a:t>한글<\/a:t>/);
    rmSync(join(dir, 'dist', 'cmaps'), { recursive: true });
    run(process.execPath, [join(dir, 'dist', 'deckback.mjs'), pdf, '-o', join(dir, 'without.pptx')], { cwd: dir });
    assert.doesNotMatch(text(join(dir, 'without.pptx')), /<a:t>한글<\/a:t>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
