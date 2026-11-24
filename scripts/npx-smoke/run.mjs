// The clean-machine check of the packed `deckback` package (M7 Task 2). Run after `npm run build:cli`; CI runs it on
// windows-latest and ubuntu-latest, and it runs the same on a developer's machine:
//   node scripts/npx-smoke/run.mjs
// 1. `npm pack -w packages/cli` (the tarball is all that is used: nothing is published);
// 2. in a new folder outside the checkout (a name with a space and Korean), the probe PDF under a Korean name with a
//    space, and `npx --yes --package <tgz> -- deckback "<pdf>" -o out.pptx --report r.json`: exit 0, the PPTX's SHA-256 is the committed one
//    (probe_std.pptx.sha256, the repository build's output), the report is valid JSON;
// 3. `--version` is the package's version and `--help` starts with the usage line;
// 4. a Korean deck that needs a character map converts from the tarball and keeps its text;
// 5. no network: the tarball installed into a folder, then run with every connection refused (the preload
//    no-network.mjs; on Linux also in an empty network namespace, `unshare -rn`, when the runner allows it): the same hash.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { cjkPdf } from './make-cjk-pdf.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const isWindows = process.platform === 'win32';
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const step = (text) => console.log(`\n== ${text}`);
const summary = [];

/** Runs a program with exact arguments (no shell, so spaces and Korean survive on every OS). */
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (r.error !== undefined) throw r.error;
  return r;
}

/** npm's own CLI scripts, run with this node: no .cmd shim, so no shell quoting. */
function npmCli(name) {
  const bases = [join(dirname(process.execPath), 'node_modules', 'npm', 'bin'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin')];
  const found = bases.map((base) => join(base, `${name}-cli.js`)).find((file) => existsSync(file));
  if (found === undefined) throw new Error(`npm's ${name}-cli.js not found beside ${process.execPath}`);
  return found;
}
const npm = (args, options = {}) => run(process.execPath, [npmCli('npm'), ...args], options);
const npx = (args, options = {}) => run(process.execPath, [npmCli('npx'), ...args], options);
// `npx --yes --package <tgz> -- deckback ...`: npm 11 reads a plain `npx --yes <abs path>.tgz` as a command to run (Linux:
// "Permission denied", exit 126; Windows: runs nothing and exits 0), so the package is named with --package.
const deckback = (tgz, args, options = {}) => npx(['--yes', '--package', tgz, '--', 'deckback', ...args], options);

function mustSucceed(r, what) {
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    throw new Error(`${what}: exit ${r.status}`);
  }
  return r;
}

const expected = readFileSync(join(here, 'probe_std.pptx.sha256'), 'utf8').trim();
const version = JSON.parse(readFileSync(join(repo, 'packages', 'cli', 'package.json'), 'utf8')).version;
assert.ok(existsSync(join(repo, 'packages', 'cli', 'dist', 'deckback.mjs')), 'build first: npm run build:cli');

step('npm pack');
const root = mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'deckback-smoke-'));
const packDir = join(root, 'pack');
mkdirSync(packDir);
// prepack (the build and the package check) runs here too and logs to stdout before the JSON
const packOut = mustSucceed(npm(['pack', '-w', 'packages/cli', '--json', '--pack-destination', packDir], { cwd: repo }), 'npm pack').stdout;
const packed = JSON.parse(packOut.slice(packOut.search(/^\[\s*$/m)))[0];
const tgz = join(packDir, packed.filename);
const sizes = `tarball ${packed.filename}: ${packed.size} bytes packed, ${packed.unpackedSize} bytes unpacked, ${packed.entryCount} files`;
console.log(sizes);
console.log(
  packed.files
    .map((f) => `  ${f.path} (${f.size})`)
    .filter((line) => !line.includes('cmaps'))
    .join('\n'),
);
summary.push(`- ${sizes}`);

step('a fresh folder outside the checkout, a Korean name with a space');
const work = join(root, '빈 폴더');
mkdirSync(work);
const pdf = join(work, '발표 자료 probe.pdf');
copyFileSync(join(repo, 'corpus', 'generated', 'probe_std.pdf'), pdf);
console.log(work);

step('npx --yes --package <tgz> -- deckback "<pdf>" -o out.pptx --report r.json');
const r = mustSucceed(deckback(tgz, [pdf, '-o', 'out.pptx', '--report', 'r.json'], { cwd: work }), 'npx convert');
console.log(r.stdout.trim());
assert.equal(JSON.parse(r.stdout).pages, 3);
assert.equal(sha256(join(work, 'out.pptx')), expected, 'the PPTX is not the one the repository build gives');
assert.equal(JSON.parse(readFileSync(join(work, 'r.json'), 'utf8')).schema, 'deckback.report/1');
console.log(`out.pptx sha256 ${expected} (as committed)`);

step('--version and --help');
const v = mustSucceed(deckback(tgz, ['--version'], { cwd: work }), 'npx --version');
assert.equal(v.stdout, `${version}\n`);
const h = mustSucceed(deckback(tgz, ['--help'], { cwd: work }), 'npx --help');
assert.match(h.stdout, /^usage: deckback <in\.pdf> -o <out\.pptx>/);
assert.equal(deckback(tgz, [pdf], { cwd: work }).status, 2, 'no -o is exit 2');

step('a Korean deck that needs a character map');
const cjk = join(work, '한글 문서.pdf');
writeFileSync(cjk, cjkPdf());
mustSucceed(deckback(tgz, [cjk, '-o', '한글.pptx'], { cwd: work }), 'npx cjk');
assert.match(strFromU8(unzipSync(new Uint8Array(readFileSync(join(work, '한글.pptx'))))['ppt/slides/slide1.xml']), /<a:t>한글<\/a:t>/);
console.log('the text 한글 is in the slide');

step('no network: the installed package, every connection refused');
const prefix = join(root, 'installed');
mkdirSync(prefix);
writeFileSync(join(prefix, 'package.json'), '{"name":"smoke","private":true}\n');
mustSucceed(npm(['install', '--no-audit', '--no-fund', '--prefix', prefix, tgz]), 'npm install');
const installed = join(prefix, 'node_modules', 'deckback');
assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).dependencies ?? {}), []);
assert.ok(!existsSync(join(prefix, 'node_modules', 'pdfjs-dist')), 'pdf.js must be inside the bundle, not installed beside it');
const preload = pathToFileURL(join(here, 'no-network.mjs')).href;
// the bin as npm links it: a symlink on Linux (the entry check must see through it), a .cmd shim on Windows (run its target)
const bin = isWindows ? join(installed, 'dist', 'deckback.mjs') : join(prefix, 'node_modules', '.bin', 'deckback');

// the preload does what it says
// (fetch, and a NAMED ESM import of each module: those keep the real function unless the preload syncs the ESM exports)
const probeSource = `
import { connect } from 'node:net';
import { request } from 'node:http';
import { spawn } from 'node:child_process';
import { connect as connect2 } from 'node:http2';
import { createSocket } from 'node:dgram';
import { Worker } from 'node:worker_threads';
import * as tlsNamespace from 'node:tls';
const attempts = {
  fetch: () => fetch('http://127.0.0.1:9/'),
  'net.connect': () => connect(9, '127.0.0.1'),
  'http.request': () => request('http://127.0.0.1:9/'),
  'child_process.spawn': () => spawn(process.execPath, ['-e', '0']),
  'http2.connect': () => connect2('http://127.0.0.1:9/'),
  'dgram.createSocket': () => createSocket('udp4'),
  'worker_threads.Worker': () => new Worker('0', { eval: true }),
  'tls.connect (namespace)': () => tlsNamespace.connect(9, '127.0.0.1'),
};
const open = [];
for (const [name, attempt] of Object.entries(attempts)) {
  try {
    await attempt();
    open.push(name);
  } catch (error) {
    if (!String(error.message).startsWith('NETWORK ATTEMPT BLOCKED')) open.push(name + ' (' + error.message + ')');
  }
}
console.log(JSON.stringify(open));
process.exit(open.length === 0 ? 7 : 0);
`;
const probe = run(process.execPath, ['--import', preload, '--input-type=module', '-e', probeSource]);
assert.equal(probe.status, 7, `the preload must refuse every attempt; not refused: ${probe.stdout}${probe.stderr}`);
const offline = join(work, 'offline');
mkdirSync(offline);
const offlinePdf = join(offline, '오프라인 자료.pdf');
copyFileSync(join(repo, 'corpus', 'generated', 'probe_std.pdf'), offlinePdf);
const out1 = join(offline, 'preload.pptx');
const offlineRun = mustSucceed(run(process.execPath, ['--import', preload, bin, offlinePdf, '-o', out1, '--report', join(offline, 'r.json')], { cwd: offline }), 'no-network (preload) run');
assert.equal(offlineRun.stderr, '', 'a successful run prints nothing on stderr (no pdf.js warnings)'); // node itself, no npx: nothing else can write there
assert.equal(sha256(out1), expected);
console.log('preload run: ok, same hash');
summary.push('- no network (every connection refused by a preload): same PPTX hash');

if (process.platform === 'linux') {
  const ns = run('unshare', ['-rn', 'true']);
  if (ns.status === 0) {
    const out2 = join(offline, 'netns.pptx');
    mustSucceed(run('unshare', ['-rn', bin, offlinePdf, '-o', out2], { cwd: offline }), 'no-network (unshare -rn) run');
    assert.equal(sha256(out2), expected);
    console.log('unshare -rn run: ok, same hash');
    summary.push('- no network (unshare -rn, an empty network namespace): same PPTX hash');
  } else {
    console.log(`unshare -rn is not allowed here (${ns.stderr.trim()}); the preload run stands`);
    summary.push('- unshare -rn not allowed on this runner');
  }
}

if (process.env.GITHUB_STEP_SUMMARY !== undefined) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### npx-smoke (${process.platform})\n${summary.join('\n')}\n`);
rmSync(root, { recursive: true, force: true });
console.log('\nnpx-smoke: all steps passed');
