import { PRESET_PATTERNS as ST_PRESET_PATTERNS } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import { PRESET_PATTERNS } from '../../src/passes/pattern-presets';
import { patternCell, presetPattern } from '../../src/passes/patterns';
import { encodePng, readPng } from '../../src/scene/png';

/**
 * Ruling M5-R10: a tiling pattern whose cell picture is an exact k x k upscale of one of PowerPoint's preset 8 x 8 cells
 * in two colours is that preset (`a:pattFill`). The presets' cells are PowerPoint's own export
 * (harness/atlas/pattern_presets.py, pattern-presets.ts).
 */

type Rgba = [number, number, number, number];
const NAVY: Rgba = [31, 56, 100, 255];
const CREAM: Rgba = [255, 242, 204, 255];

/** A cell picture of `rows` (bit 7 leftmost, 1 = `fg`) at `k` pixels a bit, RGBA, as a PNG. */
function cellPng(rows: readonly number[], fg: Rgba, bg: Rgba, k = 2, poke?: (data: Uint8Array) => void): Uint8Array {
  const side = 8 * k;
  const data = new Uint8Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const on = (rows[Math.floor(y / k)]! >> (7 - Math.floor(x / k))) & 1;
      data.set(on ? fg : bg, (y * side + x) * 4);
    }
  }
  poke?.(data);
  return encodePng(data, side, side, 4);
}

const rowsOf = (prst: string): readonly number[] => PRESET_PATTERNS.find((p) => p.prst === prst)!.rows;

describe('the preset table (measured, harness/atlas/pattern_presets.py)', () => {
  it("holds PowerPoint's two-colour presets, each a valid ST_PresetPatternVal of 8 rows; the picker's first", () => {
    expect(PRESET_PATTERNS.length).toBe(51); // 54 less the three smoothed diagonal hatches
    const names = new Set<string>(ST_PRESET_PATTERNS);
    for (const p of PRESET_PATTERNS) {
      expect(names.has(p.prst), p.prst).toBe(true);
      expect(p.rows).toHaveLength(8);
      expect(p.rows.every((r) => Number.isInteger(r) && r >= 0 && r <= 255)).toBe(true);
    }
    for (const legacy of ['dnDiag', 'upDiag', 'diagCross']) expect(PRESET_PATTERNS.some((p) => p.prst === legacy)).toBe(false);
    // cross draws what lgGrid draws: the picker's name comes first, so it is the one written
    const at = (prst: string) => PRESET_PATTERNS.findIndex((p) => p.prst === prst);
    expect(rowsOf('cross')).toEqual(rowsOf('lgGrid'));
    expect(at('lgGrid')).toBeLessThan(at('cross'));
  });
});

describe('a pattern cell and its preset', () => {
  it('reads the PNG of a 2x upscale of narHorz in navy on cream as its rows and two colours', () => {
    const cell = patternCell(cellPng(rowsOf('narHorz'), NAVY, CREAM));
    expect(cell).not.toBeNull();
    expect(presetPattern(cell!, 0, 0)).toEqual({ prst: 'narHorz', fg: NAVY, bg: CREAM });
    // k 1 and k 4 read alike
    expect(presetPattern(patternCell(cellPng(rowsOf('narHorz'), NAVY, CREAM, 1))!, 0, 0)?.prst).toBe('narHorz');
    expect(presetPattern(patternCell(cellPng(rowsOf('narHorz'), NAVY, CREAM, 4))!, 0, 0)?.prst).toBe('narHorz');
  });

  it("finds the preset whichever colour is the foreground, and the phase of the slide's grid", () => {
    // ltUpDiag's corner is background: the colour there is not taken for the foreground
    const cell = patternCell(cellPng(rowsOf('ltUpDiag'), NAVY, CREAM))!;
    expect(presetPattern(cell, 0, 0)).toEqual({ prst: 'ltUpDiag', fg: NAVY, bg: CREAM });
    expect(presetPattern(patternCell(cellPng(rowsOf('ltUpDiag'), CREAM, NAVY))!, 0, 0)).toEqual({ prst: 'ltUpDiag', fg: CREAM, bg: NAVY });
    // a cell drawn 3 bits right of and 1 bit below the slide's grid: the preset's own rows shifted that way
    const rotr = (b: number, n: number) => ((b >> n) | (b << (8 - n))) & 0xff;
    const dash = rowsOf('dashHorz');
    const shifted = Array.from({ length: 8 }, (_, r) => rotr(dash[(r + 1) % 8]!, 5)); // B[r][c] = P[r + 1][c + 3]
    const off = patternCell(cellPng(shifted, NAVY, CREAM))!;
    expect(presetPattern(off, 3, 1)?.prst).toBe('dashHorz');
    expect(presetPattern(off, 0, 0)).toBeNull();
  });

  it('three colours, a block of two, a size not 8k, or one colour: no cell', () => {
    const rows = rowsOf('pct50');
    expect(patternCell(cellPng(rows, NAVY, CREAM, 2, (d) => d.set([10, 20, 30, 255], 0)))).toBeNull(); // a third colour
    expect(patternCell(cellPng(rows, NAVY, CREAM, 2, (d) => d.set(CREAM, 0)))).toBeNull(); // a 2 x 2 block of two
    expect(patternCell(encodePng(new Uint8Array(12 * 12 * 4).fill(255), 12, 12, 4))).toBeNull();
    expect(patternCell(cellPng([0, 0, 0, 0, 0, 0, 0, 0], NAVY, CREAM))).toBeNull();
    // a picture past PATTERN_MAX_SIDE is not read at all
    expect(patternCell(encodePng(new Uint8Array(128 * 128 * 3), 128, 128, 3))).toBeNull();
  });
});

describe('readPng', () => {
  it("reads what encodePng writes, every filter, gray, RGB and RGBA; past its side, or not ours, null", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) % 256;
    for (const channels of [1, 3, 4] as const) {
      const [w, h] = [13, 9];
      const data = Uint8Array.from({ length: w * h * channels }, (_, i) => (i % 7 === 0 ? rnd() : (i * 3) & 0xff));
      expect(readPng(encodePng(data, w, h, channels), 64)).toEqual({ width: w, height: h, channels, data });
    }
    expect(readPng(encodePng(new Uint8Array(100 * 4 * 3), 100, 4, 3), 64)).toBeNull();
    expect(readPng(Uint8Array.of(1, 2, 3), 64)).toBeNull();
  });
});
