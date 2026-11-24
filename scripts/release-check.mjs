// The release check: everything that must be true before the repository is published, in order, as a pass/fail table.
//
//   node scripts/release-check.mjs --fresh          the history to publish is a fresh one (scripts/fresh-export.mjs):
//                                                   the history scan covers the tree only
//   node scripts/release-check.mjs --full           the history to publish is this repository's: the history scan is
//                                                   `git log -p` over every ref (messages, authors and all added lines)
//   --skip <ids>   leave steps out (comma-separated ids)       --only <ids>   run just these steps
//   --list         print the step ids
//
// Exactly one of --fresh and --full is required: which history gets published is the author's decision, and the check
// does not pick one for them.
//
// Steps: typecheck, unit tests (with the web unit tests), script tests, harness tests (PowerPoint ones are skipped by
// default), the corpus ratchets (with the Open XML validator on every PPTX of the corpus), the packed package, the
// binary guard over every tracked file, the privacy scan of the tree, and the history scan.
//
// Findings in --full mode that are on the pre-public list (docs/decisions 0003, 0006, 0011) are reported as KNOWN: they
// are already decided to be the author's call before any publication, so they do not fail the check, but they are shown.
// Any other finding fails it. Findings never repeat the text they found (see scripts/privacy-scan.mjs).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { IMAGE_ALLOWLIST } from './check-no-binaries.mjs';
import { scanText } from './privacy-scan.mjs';

const ALLOWED_AUTHOR = /@users\.noreply\.github\.com$/i;

/**
 * Commits the decision records name as holding something the author must decide about before the repository is public:
 * 0003 "안전 기록" 5 (the baseline results of the experimental converter carry fonts of private test decks: `24a855b`
 * and the seven commits `c3bbd89`..`09f9d71`), 0006 M4-R8 (`6a3ef86`, `a4f2703`: font tables made from private decks).
 * Entries are commit hashes (any unique prefix of 7 or more); the check matches by prefix.
 */
export const KNOWN_PREPUBLIC = [
  ['24a855b', '0003: first baseline record'],
  ['c3bbd89', '0003: baseline results, private deck descriptions'],
  ['dd47a06', '0003: commit of the range c3bbd89..09f9d71'],
  ['dcf0961', '0003: commit of the range c3bbd89..09f9d71'],
  ['4b045d4', '0003: commit of the range c3bbd89..09f9d71'],
  ['274fe75', '0003: commit of the range c3bbd89..09f9d71'],
  ['2ff5096', '0003: commit of the range c3bbd89..09f9d71'],
  ['09f9d71', '0003: commit of the range c3bbd89..09f9d71'],
  ['6a3ef86', '0006: font tables from private decks'],
  ['a4f2703', '0006: font tables, public sources only (fix of 6a3ef86)'],
];

export const knownEntry = (hash, known) => known.find(([prefix]) => hash.startsWith(prefix)) ?? null;

// --- what to scan ----------------------------------------------------------------------------

/** Text files of the tree at HEAD, as [path, text]. Binary files and the allowlisted pictures are skipped. */
export function headTextFiles(root) {
  const listing = execFileSync('git', ['ls-tree', '-r', '-z', 'HEAD'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const entries = listing.split('\0').filter(Boolean).map((record) => {
    const tab = record.indexOf('\t');
    const [mode, , oid] = record.slice(0, tab).split(' ');
    return { mode, oid, path: record.slice(tab + 1) };
  }).filter((entry) => entry.mode !== '160000' && entry.mode !== '120000' && !IMAGE_ALLOWLIST.has(entry.path));
  if (entries.length === 0) return [];

  const out = execFileSync('git', ['cat-file', '--batch'], { cwd: root, input: `${entries.map((e) => e.oid).join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024 });
  const files = [];
  let offset = 0;
  for (const entry of entries) {
    const newline = out.indexOf(0x0a, offset);
    const [, type, size] = out.subarray(offset, newline).toString('latin1').split(' ');
    if (type !== 'blob') throw new Error(`cannot read ${entry.path} from HEAD`);
    const start = newline + 1;
    const body = out.subarray(start, start + Number(size));
    offset = start + Number(size) + 1;
    if (!body.subarray(0, 8000).includes(0)) files.push([entry.path, body.toString('utf8')]);
  }
  return files;
}

/** Findings in the tree at HEAD: [{ where: path, line, column, kind, fingerprint }]. */
export function scanTree(root, scan = scanText) {
  return headTextFiles(root).flatMap(([file, text]) => scan(text).map((finding) => ({ where: file, ...finding })));
}

/**
 * Findings in the history: `git log -p` over all refs, plus the pre-public commits when they exist in this repository
 * (they may be reachable by no ref, yet are in the object store and on the hosting side).
 * @returns {Promise<{ listedPresent: number, listed: number, commits: number, findings: { commit: string, where: string, kind: string, fingerprint: string }[] }>}
 */
export function scanHistory(root, { known = KNOWN_PREPUBLIC, scan = scanText } = {}) {
  const present = known.map(([prefix]) => prefix).filter((prefix) => {
    try {
      execFileSync('git', ['cat-file', '-e', `${prefix}^{commit}`], { cwd: root, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  });
  const seen = new Set();
  const findings = [];
  const runLog = (args) =>
    new Promise((resolve, reject) => {
      const format = '--format=%x01%H %ae%n%B%x02';
      const child = spawn('git', ['log', '-p', '--no-color', '--no-ext-diff', format, ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (data) => (stderr += data));
      let rest = '';
      let commit = null; // the commit being read; null while skipping one already seen
      let part = 'head'; // head (hash line), message, diff
      let file = '';
      const line = (text) => {
        if (text.startsWith('\u0001')) {
          const [hash, email] = text.slice(1).split(' ');
          if (seen.has(hash)) {
            commit = null;
          } else {
            seen.add(hash);
            commit = hash;
            if (!ALLOWED_AUTHOR.test(email ?? '')) findings.push({ commit, where: 'author', kind: 'author-email', fingerprint: scan(`${email}`)[0]?.fingerprint ?? '' });
          }
          part = 'message';
          return;
        }
        if (commit === null) return;
        if (part === 'message') {
          const end = text.includes('\u0002');
          for (const f of scan(text.replace('\u0002', ''))) findings.push({ commit, where: 'message', kind: f.kind, fingerprint: f.fingerprint });
          if (end) part = 'diff';
          return;
        }
        if (text.startsWith('+++ ')) {
          file = text.slice(4).replace(/^b\//, '');
          return;
        }
        if (text.startsWith('+') && !IMAGE_ALLOWLIST.has(file)) {
          for (const f of scan(text.slice(1))) findings.push({ commit, where: file, kind: f.kind, fingerprint: f.fingerprint });
        }
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        const lines = (rest + chunk).split('\n');
        rest = lines.pop();
        for (const text of lines) line(text);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (rest) line(rest);
        if (code !== 0) reject(new Error(`git log failed (exit ${code}): ${stderr.trim()}`));
        else resolve();
      });
    });
  return (async () => {
    await runLog(['--all']);
    if (present.length > 0) await runLog(['--no-walk=unsorted', ...present]);
    return { commits: seen.size, findings, listedPresent: present.length, listed: known.length };
  })();
}

/** Counts of a list of findings by kind, as "2 token, 1 email". */
export const countsByKind = (findings) => {
  const counts = new Map();
  for (const { kind } of findings) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${n} ${kind}`).join(', ') || 'none';
};

// --- steps -----------------------------------------------------------------------------------

const isWindows = process.platform === 'win32';

function command(root, title, program, args, env = {}) {
  return async () => {
    const result = spawnSync(isWindows && (program === 'npm' || program === 'npx') ? `${program}.cmd` : program, args, {
      cwd: root,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      shell: isWindows && (program === 'npm' || program === 'npx'),
      maxBuffer: 256 * 1024 * 1024,
    });
    const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-3).join(' | ').slice(0, 200);
    return { status: result.status === 0 ? 'pass' : 'FAIL', detail: result.status === 0 ? title : `exit ${result.status ?? result.error?.code ?? result.signal}: ${tail}` };
  };
}

function packStep(root) {
  return async () => {
    // Build first and pack with --ignore-scripts, as scripts/pack-contents.test.mjs does: the build's own log must not mix into the JSON.
    const npm = isWindows ? 'npm.cmd' : 'npm';
    const build = spawnSync(npm, ['run', 'build:cli'], { cwd: root, encoding: 'utf8', shell: isWindows, maxBuffer: 64 * 1024 * 1024 });
    if (build.status !== 0) return { status: 'FAIL', detail: `npm run build:cli exit ${build.status}` };
    const result = spawnSync(npm, ['pack', '-w', 'packages/cli', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: isWindows, maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) return { status: 'FAIL', detail: `npm pack exit ${result.status}` };
    const [pack] = JSON.parse(result.stdout);
    const names = pack.files.map((file) => file.path.split(String.fromCharCode(92)).join('/'));
    const missing = ['LICENSE', 'NOTICE', 'README.md', 'package.json', 'dist/deckback.mjs'].filter((name) => !names.includes(name));
    const stray = names.filter((name) => !['LICENSE', 'NOTICE', 'README.md', 'package.json', 'dist/deckback.mjs'].includes(name) && !name.startsWith('dist/cmaps/'));
    if (missing.length > 0 || stray.length > 0) return { status: 'FAIL', detail: `missing: ${missing.join(', ') || 'none'}; unexpected: ${stray.length}` };
    return { status: 'pass', detail: `${pack.name}@${pack.version}, ${names.length} files, ${(pack.size / 1024 / 1024).toFixed(1)} MB packed` };
  };
}

function treeStep(root) {
  return async () => {
    const findings = scanTree(root);
    return findings.length === 0
      ? { status: 'pass', detail: 'no absolute path, user name, private deck name, token or personal e-mail in the tracked files at HEAD' }
      : { status: 'FAIL', detail: `${findings.length} (${countsByKind(findings)}) in ${[...new Set(findings.map((f) => f.where))].slice(0, 5).join(', ')}` };
  };
}

function historyStep(root, mode) {
  return async () => {
    const tree = scanTree(root);
    if (mode === 'fresh') {
      return tree.length === 0
        ? { status: 'pass', detail: '--fresh: the history to publish is one new commit of this tree; the tree is clean' }
        : { status: 'FAIL', detail: `--fresh: ${tree.length} finding(s) in the tree (${countsByKind(tree)}); it would be published` };
    }
    const { commits, findings, listedPresent, listed } = await scanHistory(root);
    const knownFindings = findings.filter((f) => knownEntry(f.commit, KNOWN_PREPUBLIC));
    const newFindings = findings.filter((f) => !knownEntry(f.commit, KNOWN_PREPUBLIC));
    const knownCommits = [...new Set(knownFindings.map((f) => f.commit))];
    const lines = knownCommits.map((c) => `    known ${c.slice(0, 7)} (${knownEntry(c, KNOWN_PREPUBLIC)[1]}): ${countsByKind(knownFindings.filter((f) => f.commit === c))}`);
    const detail = `--full: ${commits} commits (${listedPresent} of ${listed} pre-public listed commits are in this repository); ${newFindings.length} new, ${knownFindings.length} known in ${knownCommits.length} listed commit(s)${lines.length ? `\n${lines.join('\n')}` : ''}`;
    if (newFindings.length > 0) {
      const where = [...new Set(newFindings.map((f) => `${f.commit.slice(0, 7)}:${f.where}`))].slice(0, 5).join(', ');
      return { status: 'FAIL', detail: `${detail}\n    new: ${countsByKind(newFindings)} at ${where}` };
    }
    return { status: knownFindings.length > 0 || tree.length > 0 ? 'KNOWN' : 'pass', detail: tree.length > 0 ? `${detail}\n    tree: ${tree.length} finding(s)` : detail };
  };
}

export function buildSteps(root, mode) {
  const venvPython = path.join(root, 'harness', '.venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
  const python = existsSync(venvPython) ? venvPython : 'python';
  return [
    { id: 'typecheck', title: 'types (tsc -b)', run: command(root, 'tsc -b clean', 'npx', ['tsc', '-b']) },
    { id: 'unit', title: 'unit tests (npm test, with the web unit tests)', run: command(root, 'npm test passed', 'npm', ['test']) },
    { id: 'scripts', title: 'script tests (npm run test:scripts)', run: command(root, 'script tests passed (the pack content check included)', 'npm', ['run', 'test:scripts']) },
    { id: 'harness', title: 'harness tests (pytest, PowerPoint tests skipped)', run: command(root, 'pytest passed', python, ['-m', 'pytest', 'harness', '-q'], { DECKBACK_PY: python }) },
    { id: 'corpus', title: 'corpus ratchets and the Open XML validator', run: command(root, 'npm run test:corpus passed', 'npm', ['run', 'test:corpus'], { DECKBACK_PY: python }) },
    { id: 'pack', title: 'npm pack (dry run) and its contents', run: packStep(root) },
    { id: 'binaries', title: 'binary guard over every tracked file', run: command(root, 'no binary, office or font file but the allowlisted pictures', 'node', ['scripts/check-no-binaries.mjs', '--all']) },
    { id: 'privacy', title: 'privacy scan of the tree', run: treeStep(root) },
    { id: 'history', title: mode === 'fresh' ? 'history to publish (--fresh: tree only)' : 'history to publish (--full: git log -p, all refs)', run: historyStep(root, mode) },
  ];
}

// --- command line ----------------------------------------------------------------------------

export function parseArgs(args) {
  const options = { mode: null, skip: [], only: null, list: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--fresh' || arg === '--full') {
      const mode = arg.slice(2);
      if (options.mode !== null && options.mode !== mode) throw new Error('give only one of --fresh and --full');
      options.mode = mode;
    } else if (arg === '--skip' || arg === '--only') {
      const value = args[(i += 1)];
      if (!value) throw new Error(`${arg} needs a comma-separated list of step ids`);
      const ids = value.split(',').filter(Boolean);
      if (arg === '--skip') options.skip.push(...ids);
      else options.only = [...(options.only ?? []), ...ids];
    } else if (arg === '--list') {
      options.list = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.mode === null && !options.list) throw new Error('give --fresh or --full: which history is published is the author\'s decision');
  return options;
}

/** The result table: one row per step. A row's extra lines (indented) follow it. */
export function formatTable(rows) {
  const width = Math.max(4, ...rows.map((row) => row.title.length));
  const lines = [`${'step'.padEnd(width)}  result  detail`, `${'-'.repeat(width)}  ------  ------`];
  for (const row of rows) {
    const [first, ...more] = row.detail.split('\n');
    lines.push(`${row.title.padEnd(width)}  ${row.status.padEnd(6)}  ${first}`, ...more);
  }
  return lines.join('\n');
}

export async function runSteps(steps, { log = console.log } = {}) {
  const rows = [];
  for (const step of steps) {
    log(`... ${step.title}`);
    const started = Date.now();
    let outcome;
    try {
      outcome = await step.run();
    } catch (error) {
      outcome = { status: 'FAIL', detail: `error: ${error.message}` };
    }
    rows.push({ id: step.id, title: step.title, ...outcome, seconds: Math.round((Date.now() - started) / 1000) });
  }
  return rows;
}

async function main(args) {
  let options;
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(`release-check: ${error.message}\nusage: node scripts/release-check.mjs (--fresh | --full) [--skip <ids>] [--only <ids>] [--list]`);
    return 2;
  }
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const all = buildSteps(root, options.mode ?? 'full');
  if (options.list) {
    console.log(all.map((step) => step.id).join('\n'));
    return 0;
  }
  const unknown = [...options.skip, ...(options.only ?? [])].filter((id) => !all.some((step) => step.id === id));
  if (unknown.length > 0) {
    console.error(`release-check: unknown step id ${unknown.join(', ')} (see --list)`);
    return 2;
  }
  const steps = all.filter((step) => (options.only ? options.only.includes(step.id) : !options.skip.includes(step.id)));
  const rows = await runSteps(steps);
  console.log(`\n${formatTable(rows)}\n`);
  const failed = rows.filter((row) => row.status === 'FAIL');
  const known = rows.filter((row) => row.status === 'KNOWN');
  if (failed.length > 0) console.log(`release-check: ${failed.length} step(s) FAILED: ${failed.map((row) => row.id).join(', ')}`);
  else if (known.length > 0) console.log('release-check: no failure, but KNOWN findings are on the pre-public list: the author decides about them before the repository is public (docs/decisions 0003, 0006, 0011).');
  else console.log('release-check: all steps passed.');
  if (rows.length < all.length) console.log(`(${all.length - rows.length} step(s) were skipped.)`);
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main(process.argv.slice(2));
}
