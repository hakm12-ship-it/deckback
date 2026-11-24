import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './helpers/fixtures';

/**
 * The repository's vitest projects as the CLI resolves them from vitest.config.ts. The atlas sweep is a heavy local run
 * over out/ (it writes out/sweep/, and the committed fidelity/results/ file only with DECKBACK_SWEEP_RECORD=1), so it is
 * opt-in: a bare `vitest run` must not even list it.
 */

/** The `[project] file` lines of `vitest list --filesOnly <args>` (an error, such as an unknown project, gives []). */
function listed(args: string[]): string[] {
  // The child is a vitest of its own: none of this worker's VITEST_* variables may leak into it.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST')));
  let out: string;
  try {
    out = execFileSync(process.execPath, [`${repoRoot}node_modules/vitest/vitest.mjs`, 'list', '--filesOnly', ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return [];
  }
  return out.split(/\r?\n/).filter((line) => line.startsWith('['));
}

const SWEEP_FILE = '[sweep] packages/core/test/sweep/atlas.sweep.test.ts';

describe('vitest projects', () => {
  it('a bare run lists the unit, local and corpus tests but never the sweep', () => {
    const lines = listed([]);
    expect(lines.some((line) => line.startsWith('[unit] '))).toBe(true);
    expect(lines.some((line) => line.startsWith('[corpus] '))).toBe(true);
    expect(lines.filter((line) => line.startsWith('[sweep]') || line.endsWith('.sweep.test.ts'))).toEqual([]);
  }, 60_000);

  it('the sweep project exists only in the mode `sweep`', () => {
    expect(listed(['--project', 'sweep'])).toEqual([]);
    expect(listed(['--mode', 'sweep', '--project', 'sweep'])).toEqual([SWEEP_FILE]);
  }, 60_000);

  it('npm run oracle:sweep asks for that mode', () => {
    const scripts = (JSON.parse(readFileSync(`${repoRoot}package.json`, 'utf8')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts['oracle:sweep']).toBe('vitest run --mode sweep --project sweep');
  });
});
