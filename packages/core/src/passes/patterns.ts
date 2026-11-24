import { readPng } from '../scene/png';
import { PRESET_PATTERNS } from './pattern-presets';

/**
 * PowerPoint's preset patterns (ruling M5-R10). PowerPoint exports a pattern fill as a tiling pattern whose cell is a
 * picture: its 8 x 8 cell of two colours, each bit k x k pixels, 6 pt a side (8 px at 96 dpi), anchored on the slide's
 * 6 pt grid (measured: harness/atlas/pattern_presets.py, whichever pt the shape is at). Writing such a cell back as a
 * picture tile, PowerPoint resamples the picture onto the slide (atlas fills/08-12: px32_shift1 1.0-2.9 %); written as the
 * preset (`a:pattFill`) it draws as the source did, and stays editable.
 * - `patternCell`: of a cell picture (a PNG of the converter's own: `encodePng`), its 8 rows and two colours, where it is
 *   an exact k x k upscale of 8 x 8 bits in exactly two colours; else null. Pictures past `PATTERN_MAX_SIDE` are not
 *   read.
 * - `presetPattern`: the preset whose cell that is, with its bits shifted by the cell's place on the slide's grid
 *   (`tx`, `ty`, in bits), either colour the foreground; else null. Of two presets with one cell (cross, lgGrid), the
 *   table's first, the picker's.
 */

/** The largest cell picture read, a side in pixels: an 8 x 8 cell at 8 pixels a bit. */
export const PATTERN_MAX_SIDE = 64;

export type Rgba = [r: number, g: number, b: number, a: number];

/** A cell of two colours: `rows` from the top, bit 7 the leftmost column, 1 where it is `a`, 0 where it is `b`. */
export interface PatternCell {
  rows: number[];
  a: Rgba;
  b: Rgba;
}

/** The preset's name by its cell rows (8 bytes as one key), the table's first for a cell two presets share. */
const BY_ROWS = new Map<string, string>();
for (const { prst, rows } of PRESET_PATTERNS) {
  const key = rows.join(',');
  if (!BY_ROWS.has(key)) BY_ROWS.set(key, prst);
}

/** A cell picture's 8 rows and two colours (the module comment); null when it is not one. */
export function patternCell(png: Uint8Array): PatternCell | null {
  const image = readPng(png, PATTERN_MAX_SIDE);
  if (image === null || image.width !== image.height || image.width % 8 !== 0) return null;
  const { width, channels, data } = image;
  const k = width / 8;
  const rgba = (x: number, y: number): Rgba => {
    const at = (y * width + x) * channels;
    if (channels === 1) return [data[at]!, data[at]!, data[at]!, 255];
    return [data[at]!, data[at + 1]!, data[at + 2]!, channels === 4 ? data[at + 3]! : 255];
  };
  const same = (p: Rgba, q: Rgba): boolean => p[0] === q[0] && p[1] === q[1] && p[2] === q[2] && p[3] === q[3];
  const a = rgba(0, 0);
  let b: Rgba | null = null;
  const rows: number[] = [];
  for (let r = 0; r < 8; r++) {
    let byte = 0;
    for (let c = 0; c < 8; c++) {
      const bit = rgba(c * k, r * k);
      for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) if (!same(rgba(c * k + dx, r * k + dy), bit)) return null;
      if (same(bit, a)) byte |= 0x80 >> c;
      else if (b === null) b = bit;
      else if (!same(bit, b)) return null;
    }
    rows.push(byte);
  }
  return b === null ? null : { rows, a, b };
}

/** A byte's bits turned right by `n` (bit 7 the leftmost column: the columns move right). */
const rotr = (byte: number, n: number): number => ((byte >> n) | (byte << (8 - n))) & 0xff;

/**
 * The preset a cell is on the slide (the module comment): `tx`, `ty` its place on the slide's grid in bits, so that the
 * preset's bit (i, j) is the cell's bit (i - tx, j - ty), each mod 8. Its colour `a` the foreground first, then `b`.
 */
export function presetPattern(cell: PatternCell, tx: number, ty: number): { prst: string; fg: Rgba; bg: Rgba } | null {
  const [sx, sy] = [((tx % 8) + 8) % 8, ((ty % 8) + 8) % 8];
  const rows = Array.from({ length: 8 }, (_, j) => rotr(cell.rows[(j - sy + 8) % 8]!, sx));
  const asA = BY_ROWS.get(rows.join(','));
  if (asA !== undefined) return { prst: asA, fg: cell.a, bg: cell.b };
  const asB = BY_ROWS.get(rows.map((r) => r ^ 0xff).join(','));
  return asB === undefined ? null : { prst: asB, fg: cell.b, bg: cell.a };
}
