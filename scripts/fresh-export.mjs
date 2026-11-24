// Fresh-history export: a copy of the current tree (the tracked files at HEAD, nothing else) in a new folder under the
// temp directory, with one new commit, ready to be pushed to a NEW public repository if the author chooses that.
//
//   node scripts/fresh-export.mjs             makes the folder and prints its path
//   node scripts/fresh-export.mjs --dry-run   says what it would do, creates nothing
//
// What it does: git init in the new folder, one commit whose author is the identity of the current git config (it must be
// a GitHub noreply address, so no personal address can reach the new history). What it never does: it does not touch the
// existing repository or its history, adds no remote and does not publish anything. Publishing is a separate step that the
// author takes by hand, after the history scan (scripts/release-check.mjs --fresh) is clean.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NOREPLY = /@users\.noreply\.github\.com$/i;

/**
 * @param {{ repo?: string, outRoot?: string, env?: NodeJS.ProcessEnv, dryRun?: boolean, log?: (line: string) => void }} [options]
 * @returns {{ dir: string | null, dryRun: boolean, files: number }}
 */
export function freshExport({ repo = process.cwd(), outRoot = tmpdir(), env = process.env, dryRun = false, log = console.log } = {}) {
  const git = (cwd, args, extraEnv = {}) => execFileSync('git', args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();

  const root = git(repo, ['rev-parse', '--show-toplevel']);
  const name = git(root, ['config', 'user.name']);
  const email = git(root, ['config', 'user.email']);
  if (!name || !NOREPLY.test(email)) {
    throw new Error('the git config must name an author with a GitHub noreply address (…@users.noreply.github.com); set user.name and user.email first');
  }

  const tracked = git(root, ['ls-tree', '-r', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  let version = null;
  try {
    version = JSON.parse(git(root, ['show', 'HEAD:packages/cli/package.json'])).version;
  } catch {
    // a repository without the CLI package: the subject just has no version
  }
  const subject = version ? `deckback v${version} 첫 공개 기록` : '첫 공개 기록';

  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) {
    log('warning: tracked files have uncommitted changes. The export is HEAD, not the working tree.');
  }
  log(`source: ${tracked.length} tracked files at HEAD ${git(root, ['rev-parse', '--short', 'HEAD'])}`);

  if (dryRun) {
    log(`dry run: would copy them into a new folder under ${outRoot}, run git init and make one commit "${subject}" as ${name} <${email}>. Nothing was created.`);
    return { dir: null, dryRun: true, files: tracked.length };
  }

  const dir = mkdtempSync(path.join(outRoot, 'deckback-fresh-'));
  try {
    // The very same tree as HEAD, byte for byte (no line-ending or attribute conversion on the way): the new repository
    // reads the source's objects through git's "alternates" for the length of this function, makes its index from the
    // tree of HEAD and commits it; `repack -a -d` then copies into the new repository the objects that one commit needs,
    // and the link to the old object store is deleted again. Nothing is written to the source repository.
    git(dir, ['init', '-q', '-b', 'main']);
    const alternates = path.join(dir, '.git', 'objects', 'info', 'alternates');
    writeFileSync(alternates, `${path.resolve(root, git(root, ['rev-parse', '--git-path', 'objects']))}\n`);
    git(dir, ['config', 'user.name', name]);
    git(dir, ['config', 'user.email', email]);
    git(dir, ['read-tree', git(root, ['rev-parse', 'HEAD^{tree}'])]);
    git(dir, ['checkout-index', '-a', '-f']);
    git(dir, ['commit', '-q', '-m', `${subject}\n\n지금 저장소의 HEAD 파일 ${tracked.length}개로 새로 만든 첫 기록이다. 예전 기록은 들어 있지 않다.`]);
    git(dir, ['repack', '-a', '-d', '-q']);
    rmSync(alternates);
    git(dir, ['fsck', '--no-dangling']); // fails if an object was left behind in the old store
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  log(`made: ${dir}`);
  log('one commit, no remote. To publish, create a NEW empty repository and push this folder yourself; this script never pushes.');
  return { dir, dryRun: false, files: tracked.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]) && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--dry-run');
  if (unknown.length > 0) {
    console.error(`fresh-export: unknown argument ${unknown.join(' ')}\nusage: node scripts/fresh-export.mjs [--dry-run]`);
    process.exitCode = 2;
  } else {
    try {
      const result = freshExport({ dryRun: args.includes('--dry-run') });
      if (result.dir) console.log(result.dir);
    } catch (error) {
      console.error(`fresh-export: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
