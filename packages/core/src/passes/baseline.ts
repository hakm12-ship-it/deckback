import { typefaceFamily } from '../fonts/names';
import type { FontInfo } from '../scene/types';
import { BASELINE_CALIB } from './baseline-calib';

/**
 * Where PowerPoint puts the first baseline of a text box with no insets (Task 8): `k` x the font size below the box's
 * top. PowerPoint does not document it; it follows the font's line metrics. `baseline-calib.ts` holds `k` as PowerPoint
 * draws it for the calibrated families (`harness/fonts/baseline_calib.py`, which measures it in PowerPoint's own PDF
 * export of the writer's own text boxes), per weight where both were measured (ruling M3-R36), and for any other font
 * with metrics the formula M3 Task 8 found (ruling M3-R35, M4 Task 3): PowerPoint's single line, 1.2 x the size, shared
 * between the font's ascent A and descent D, `k = scale x A / (A + D)`, `scale` fitted on the calibrated families
 * (`_fallback`). A and D are the font's line metrics as Windows takes them: OS/2 usWinAscent and usWinDescent, or, for a
 * font that sets USE_TYPO_METRICS (fsSelection bit 7), sTypoAscender with sTypoLineGap over it and -sTypoDescender.
 */

type Metrics = NonNullable<FontInfo['metrics']>;

/** fsSelection bit 7: the typo metrics are the font's line metrics. */
const USE_TYPO_METRICS = 0x80;

/** What the calibration measured of a family, or of one weight of it. */
export interface Calibrated {
  k: number;
  n: number;
  spread: number;
}

/** A calibrated family: its k over all its samples, and each weight's where both were measured. */
export interface CalibEntry extends Calibrated {
  regular?: Calibrated;
  bold?: Calibrated;
}

/** The calibration as `baselineK` reads it (`calibTable`). */
export interface CalibTable {
  /** By family name (nameID 1, the typeface name). */
  families: ReadonlyMap<string, CalibEntry>;
  /** A family's Korean name (nameID 1 for 0x412) to the family: a font may carry that name alone. */
  aliases: ReadonlyMap<string, string>;
  /** `k = scale x A / (A + D)` for a font the table does not hold (`lineShare`). */
  fallback: { scale: number };
}

/** `k` for a font that is neither calibrated nor has plausible metrics. */
export const DEFAULT_K = 0.9;

/** The descent below the baseline, as a share of the size, for a font without metrics. */
export const DEFAULT_DESC = 0.25;

/** The largest ascent (over unitsPerEm) taken for a font's own: past it, or at 0 or below, the metrics are not believed. */
const MAX_ASC = 3;

/**
 * The calibration of the object `baseline-calib.ts` generates (or one of its shape): its families (every key but those
 * starting with `_`), `_alias` and `_fallback`.
 */
export function calibTable(raw: object): CalibTable {
  const record = raw as Record<string, unknown>;
  const families = new Map<string, CalibEntry>();
  for (const [name, entry] of Object.entries(record)) if (!name.startsWith('_')) families.set(name, entry as CalibEntry);
  const aliases = new Map(Object.entries((record['_alias'] ?? {}) as Record<string, string>));
  return { families, aliases, fallback: record['_fallback'] as CalibTable['fallback'] };
}

/** The committed calibration. */
export const CALIB: CalibTable = calibTable(BASELINE_CALIB);

/** Metrics that can be divided by: a positive unitsPerEm. */
const usable = (m: FontInfo['metrics']): m is Metrics => m !== null && m.upm > 0;

/**
 * The share A / (A + D) of a font's line its ascent takes: A and D the OS/2 win ascent and descent, or for a font with
 * USE_TYPO_METRICS (fsSelection bit 7) the typo ascent and line gap and the typo descent; null where they are not
 * plausible (A over unitsPerEm at most 0 or over `MAX_ASC`, a negative D).
 */
export function lineShare(m: Metrics): number | null {
  const typo = (m.fsSelection & USE_TYPO_METRICS) !== 0;
  const [a, d] = typo ? [m.typoAsc + m.typoLineGap, -m.typoDesc] : [m.winAsc, m.winDesc];
  if (!(m.upm > 0) || !(a > 0) || a / m.upm > MAX_ASC || !(d >= 0)) return null;
  return a / (a + d);
}

/**
 * The share of the size below a box's top at which PowerPoint draws the font's first baseline:
 * - when the font's `latinName` or `eaName` (an empty one is none), or the family its PostScript name is in the table of
 *   known fonts (`typefaceFamily`: `MalgunGothic` is Malgun Gothic), is a family of the table, or an alias of one
 *   (`source` `calib`): the k of the font's weight (`bold`, or the weight its name says) where both weights were
 *   measured, else the family's;
 * - else `_fallback.scale` x A / (A + D) (`lineShare`) for a font with plausible metrics (`metrics`);
 * - else `DEFAULT_K`, 0.9 (also `metrics`: what the formula falls back to).
 */
export function baselineK(font: FontInfo, table: CalibTable = CALIB): { k: number; source: 'calib' | 'metrics' } {
  const named = typefaceFamily(font);
  const bold = font.bold || named?.bold === true;
  for (const name of [font.latinName, font.eaName, named?.family ?? null]) {
    if (name === null || name === '') continue;
    const alias = table.aliases.get(name);
    const entry = table.families.get(name) ?? (alias === undefined ? undefined : table.families.get(alias));
    if (entry !== undefined) return { k: (bold ? entry.bold : entry.regular)?.k ?? entry.k, source: 'calib' };
  }
  const share = usable(font.metrics) ? lineShare(font.metrics) : null;
  return share === null ? { k: DEFAULT_K, source: 'metrics' } : { k: table.fallback.scale * share, source: 'metrics' };
}

/**
 * The share of the size a line reaches below its baseline: the hhea descent over unitsPerEm; `DEFAULT_DESC` without
 * usable metrics (or without the font). Only the box's height follows it: the box neither wraps nor fits its text.
 */
export function descentOf(font: FontInfo | undefined): number {
  if (font === undefined || !usable(font.metrics)) return DEFAULT_DESC;
  return Math.abs(font.metrics.hheaDesc) / font.metrics.upm;
}
