import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pythonPath, repoRoot } from './fixtures';

/** One error of the Open XML validator (`harness.ooxml.validate`, FileFormatVersions.Office2021). */
export interface ValidatorError {
  id: string;
  part: string;
  path: string;
  description: string;
}

/** Where `validatePptx` writes the PPTX it validates under `name`: `out/ooxml/<name>.pptx` (git-ignored). */
export function validatedPath(name: string): string {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`not a plain file name: ${name}`);
  return `${repoRoot}out/ooxml/${name}.pptx`;
}

/**
 * Writes `bytes` to `out/ooxml/<name>.pptx` (`validatedPath`; git-ignored; the PPTX stays there to be opened by hand)
 * and returns the validator's errors for it, `[]` when it is clean. Throws when the validator cannot run (exit 3: no
 * dotnet, a failed build) or answers with anything but one result line agreeing with its exit code.
 */
export async function validatePptx(bytes: Uint8Array, name: string): Promise<ValidatorError[]> {
  const file = validatedPath(name);
  mkdirSync(`${repoRoot}out/ooxml/`, { recursive: true });
  writeFileSync(file, bytes);
  const { code, stdout, stderr } = await run(pythonPath(), ['-m', 'harness.ooxml.validate', file]);
  if (code !== 0 && code !== 1) throw new Error(`the Open XML validator is unavailable (exit ${code}): ${stderr.trim()}`);
  const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length !== 1) throw new Error(`the validator printed ${lines.length} result lines for one file`);
  const result = JSON.parse(lines[0]!) as { file: string; errors: ValidatorError[] };
  if (result.file !== `${name}.pptx` || !Array.isArray(result.errors) || (code === 0) !== (result.errors.length === 0)) {
    throw new Error(`unexpected validator result (exit ${code}): ${lines[0]}`);
  }
  return result.errors;
}

/** S1-S6 of one slide, as `harness.fidelity.structural_cli` prints it: statuses and the checks' counts. */
export interface StructuralRow {
  slide: number;
  S1: SStatus;
  S2: SStatus;
  S3: SStatus;
  S4: SStatus;
  S5: SStatus;
  S6: SStatus;
  counts: Record<'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6', Record<string, number>>;
}

export type SStatus = 'pass' | 'fail' | 'n/a';

/**
 * S1-S6 of every page of the PDF at `pdf` against its slide of the PPTX at `pptx` (`harness.fidelity.structural_cli`):
 * one row per page, in order, and with `details` the details of every check that does not pass (its stderr). Details
 * name the deck's typefaces and shapes: ask for them for public decks only (the committed corpus). Throws when the
 * command does not run to its end (exit other than 0).
 */
export async function structuralChecks(pdf: string, pptx: string, details = false): Promise<{ rows: StructuralRow[]; details: string }> {
  const args = ['-m', 'harness.fidelity.structural_cli', '--pdf', pdf, '--pptx', pptx, ...(details ? ['--details'] : [])];
  const { code, stdout, stderr } = await run(pythonPath(), args);
  if (code !== 0) throw new Error(`structural_cli failed (exit ${code}): ${stderr.trim()}`);
  const rows = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as StructuralRow);
  return { rows, details: stderr };
}

/** Runs the harness from the repository root, where `harness` is a package. */
function run(command: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
