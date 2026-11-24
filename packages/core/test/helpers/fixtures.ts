import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The repository root, with a trailing separator. */
export const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

const probeDir = `${repoRoot}corpus/private/probe/`;

/**
 * The Python that runs the harness (the PyMuPDF oracle): `DECKBACK_PY` when set, else the repository's
 * `harness/.venv`, whose interpreter is `Scripts/python` on Windows and `bin/python` everywhere else (Linux CI).
 */
export function pythonPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const configured = env.DECKBACK_PY;
  if (configured !== undefined && configured !== '') return configured;
  return platform === 'win32' ? `${repoRoot}harness/.venv/Scripts/python` : `${repoRoot}harness/.venv/bin/python`;
}

/** The fixed message `updateGoldens` throws with in CI. */
export const GOLDEN_UPDATE_IN_CI =
  'DECKBACK_UPDATE_GOLDEN=1 is refused in CI: regenerate the goldens locally, check the change, and commit them';

/**
 * Whether the corpus ratchets rewrite their goldens: `DECKBACK_UPDATE_GOLDEN=1`. In CI (`CI` set and not empty, as GitHub
 * Actions sets it) that would turn every ratchet green whatever the code does, so there it throws `GOLDEN_UPDATE_IN_CI`.
 */
export function updateGoldens(env: NodeJS.ProcessEnv = process.env): boolean {
  const update = env.DECKBACK_UPDATE_GOLDEN === '1';
  if (update && env.CI !== undefined && env.CI !== '') throw new Error(GOLDEN_UPDATE_IN_CI);
  return update;
}

/**
 * The path of a local-only fixture in `corpus/private/probe/` (gitignored), for tools that take a file name.
 * Returns `null` after printing `SKIP local fixture missing: <name>` when the file is absent.
 */
export function fixturePath(name: string): string | null {
  const file = `${probeDir}${name}`;
  if (!existsSync(file)) {
    console.log(`SKIP local fixture missing: ${name}`);
    return null;
  }
  return file;
}

/**
 * Reads a local-only fixture from `corpus/private/probe/` (gitignored).
 * Returns `null` after printing `SKIP local fixture missing: <name>` when the file is absent.
 */
export function fixture(name: string): Uint8Array | null {
  const file = fixturePath(name);
  // Copy into a plain Uint8Array: readFileSync returns a Buffer subclass.
  return file === null ? null : new Uint8Array(readFileSync(file));
}
