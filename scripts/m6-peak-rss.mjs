// M6 Task 1: the true peak memory of a conversion: each PDF that apps/web/e2e/m6-memory.spec.ts wrote to out/m6/ (and
// out/atlas/atlas_std.pdf, whole) is converted by the built CLI in a fresh Node process, which reports its OS peak
// resident set (`process.resourceUsage().maxRSS`, KiB) when it exits. Needs `npm run build:cli`. Local only.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const cli = join(repo, 'packages/cli/dist/deckback.mjs');
const work = mkdtempSync(join(tmpdir(), 'deckback-rss-'));
const hook = join(work, 'hook.mjs');
await import('node:fs').then((fs) =>
  fs.writeFileSync(hook, "process.on('exit', () => process.stderr.write(`MAXRSS_KIB=${process.resourceUsage().maxRSS}\n`));\n"),
);

const cases = existsSync(join(repo, 'out/m6/memory.json')) ? Object.entries(JSON.parse(readFileSync(join(repo, 'out/m6/memory.json'), 'utf8'))) : [];
const files = cases.map(([name, c]) => [c.pages === null ? name : `${name} (the CLI converts every page of the file: 159)`, join(repo, 'out/m6', c.file)]);
for (const [name, pdf] of files) {
  if (!existsSync(pdf)) continue;
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--import', pathToFileURL(hook).href, cli, pdf, '-o', join(work, 'out.pptx')], { encoding: 'utf8' });
  const kib = /MAXRSS_KIB=(\d+)/.exec(run.stderr)?.[1];
  console.log(`${name}: ${kib === undefined ? 'no figure (exit ' + run.status + ')' : (Number(kib) / 1024).toFixed(1) + ' MB'} peak resident, ${((Date.now() - started) / 1000).toFixed(0)} s`);
}

rmSync(work, { recursive: true, force: true }); // the hostile deck's PPTX and the hook are not left in the temp folder
