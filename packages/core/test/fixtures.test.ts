import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { fixture, GOLDEN_UPDATE_IN_CI, pythonPath, repoRoot, updateGoldens } from './helpers/fixtures';

it('returns null and prints a SKIP line when a local fixture is missing', () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(fixture('does-not-exist.pdf')).toBeNull();
    expect(log).toHaveBeenCalledExactlyOnceWith('SKIP local fixture missing: does-not-exist.pdf');
  } finally {
    log.mockRestore();
  }
});

describe('pythonPath (the harness Python that runs the oracle, ruling M1-R64)', () => {
  it('uses DECKBACK_PY when it is set', () => {
    expect(pythonPath({ DECKBACK_PY: '/opt/py/bin/python3' }, 'linux')).toBe('/opt/py/bin/python3');
    expect(pythonPath({ DECKBACK_PY: 'C:/py/python.exe' }, 'win32')).toBe('C:/py/python.exe');
  });

  it('otherwise uses the repository venv: Scripts/python on Windows, bin/python elsewhere', () => {
    expect(pythonPath({}, 'win32')).toBe(`${repoRoot}harness/.venv/Scripts/python`);
    expect(pythonPath({}, 'linux')).toBe(`${repoRoot}harness/.venv/bin/python`);
    expect(pythonPath({}, 'darwin')).toBe(`${repoRoot}harness/.venv/bin/python`);
    expect(pythonPath({ DECKBACK_PY: '' }, 'linux')).toBe(`${repoRoot}harness/.venv/bin/python`); // empty = unset
  });

  it('repoRoot is the repository root', () => {
    expect(existsSync(`${repoRoot}package.json`)).toBe(true);
    expect(existsSync(`${repoRoot}harness/oracle/mupdf_inventory.py`)).toBe(true);
  });
});

describe('updateGoldens (DECKBACK_UPDATE_GOLDEN, refused in CI)', () => {
  it('is true only for DECKBACK_UPDATE_GOLDEN=1', () => {
    expect(updateGoldens({})).toBe(false);
    expect(updateGoldens({ DECKBACK_UPDATE_GOLDEN: '1' })).toBe(true);
    expect(updateGoldens({ DECKBACK_UPDATE_GOLDEN: '0' })).toBe(false);
    expect(updateGoldens({ DECKBACK_UPDATE_GOLDEN: 'true' })).toBe(false);
    expect(updateGoldens({ DECKBACK_UPDATE_GOLDEN: '', CI: 'true' })).toBe(false);
    expect(updateGoldens({ CI: 'true' })).toBe(false);
    expect(updateGoldens({ DECKBACK_UPDATE_GOLDEN: '1', CI: '' })).toBe(true); // empty = unset
  });

  it('throws its fixed message when CI is set', () => {
    for (const ci of ['true', '1', 'false']) {
      expect(() => updateGoldens({ DECKBACK_UPDATE_GOLDEN: '1', CI: ci }), ci).toThrow(GOLDEN_UPDATE_IN_CI);
    }
    expect(GOLDEN_UPDATE_IN_CI).toBe(
      'DECKBACK_UPDATE_GOLDEN=1 is refused in CI: regenerate the goldens locally, check the change, and commit them',
    );
  });

  it('both corpus ratchets that write goldens ask it, at load time', () => {
    for (const file of ['oplist-contract.corpus.test.ts', 'scene-ratchet.corpus.test.ts']) {
      const source = readFileSync(`${repoRoot}packages/core/test/corpus/${file}`, 'utf8');
      expect(source, file).toMatch(/^const update = updateGoldens\(\);$/m);
      expect(source, file).not.toMatch(/DECKBACK_UPDATE_GOLDEN ===/);
    }
  });
});
