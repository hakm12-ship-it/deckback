import { describe, expect, it } from 'vitest';
import { emSize, runStyle, SIZE_MAP, snapSize, SYNTHETIC_BOLD, SYNTHETIC_ITALIC } from '../../../src/passes/text/style';
import type { TextRun } from '../../../src/scene/types';
import { linear, textline } from '../../helpers/passes';

/**
 * Synthetic italic and bold (M4 Task 2): PowerPoint draws the italic of a face without one as a 1/3 shear of the text
 * matrix, and the bold of a face without one as a fill and a stroke in one colour, the stroke the size / 35 wide
 * (measured on the atlas: tables/05 and charts/03, 11 runs). Both become the run's `i` / `b`.
 */

const run = (over: Partial<TextRun> = {}): TextRun => ({ ...textline().runs[0]!, ...over });

/** A run as PowerPoint's export writes a synthetic italic at `size`: its y axis leans 1/3, so it reads size × √(1 + 1/9). */
const sheared = (size: number, over: Partial<TextRun> = {}): TextRun => run({ sizePt: Math.round(size * Math.sqrt(1 + 1 / 9) * 1000) / 1000, skew: 0.3333, ...over });

/** A run filled and stroked in `rgb`, the stroke `w` pt wide. */
const stroked = (size: number, w: number, over: Partial<TextRun> = {}): TextRun =>
  run({ sizePt: size, fillMode: 'fillStroke', rgb: [10, 20, 30], fill: { kind: 'solid', rgb: [10, 20, 30], alpha: 1 }, stroke: { rgb: [10, 20, 30], alpha: 1, wPt: w }, ...over });

describe('synthetic italic', () => {
  it('the ruled values: a shear of 1/3 within 0.02; the bold stroke is the size / 35 (measured), within a quarter of it', () => {
    expect(SYNTHETIC_ITALIC).toEqual({ skew: 1 / 3, tol: 0.02 });
    expect(SYNTHETIC_BOLD).toEqual({ ratio: 1 / 35, tol: 0.25 });
  });

  it("a 1/3 shear on a face that is not italic is i, at the size of the em: the Scene's size / √(1 + skew²)", () => {
    const s = runStyle(sheared(24)); // atlas/text/06: 25.298
    expect(s).toMatchObject({ italic: true, syntheticItalic: true, bold: false, syntheticBold: false });
    expect(s.size).toBeCloseTo(24, 3);
    for (const skew of [1 / 3 - 0.019, 1 / 3 + 0.019, 0.3333]) {
      const r = run({ sizePt: 20, skew });
      expect(runStyle(r), `${skew}`).toMatchObject({ italic: true, syntheticItalic: true });
      expect(runStyle(r).size).toBeCloseTo(20 / Math.sqrt(1 + skew * skew), 9);
    }
  });

  it('another shear is not a synthetic italic: its size is the Scene size (the skew stays text-skew)', () => {
    for (const skew of [0, 0.2, 1 / 3 - 0.021, 1 / 3 + 0.021, 0.5, -1 / 3]) {
      expect(runStyle(run({ sizePt: 20, skew })), `${skew}`).toEqual({ size: 20, scale: 1, bold: false, italic: false, syntheticBold: false, syntheticItalic: false });
    }
  });

  it('emSize: the size along the line, the Scene size / √(1 + skew²)', () => {
    expect(emSize(run({ sizePt: 25.298, skew: 0.3333 }))).toBeCloseTo(24, 3);
    expect(emSize(run({ sizePt: 12, skew: 0 }))).toBe(12);
  });
});

describe('synthetic bold', () => {
  it('a fill and stroke in one colour, the stroke the size / 35, on a face that is not bold, is b (atlas/charts/03)', () => {
    expect(runStyle(stroked(15.96, 0.456))).toMatchObject({ size: 16, bold: true, italic: false, syntheticBold: true, syntheticItalic: false });
    for (const w of [(15.96 / 35) * 0.76, (15.96 / 35) * 1.24]) expect(runStyle(stroked(15.96, w)).syntheticBold, `${w}`).toBe(true);
  });

  it('with a synthetic italic too, the stroke is measured against the size of the em (atlas/tables/05)', () => {
    const s = runStyle(stroked(16.823, 0.456, { skew: 0.3333 }));
    expect(s).toMatchObject({ bold: true, italic: true, syntheticBold: true, syntheticItalic: true });
    expect(s.size).toBe(16); // the em, 15.96, is PowerPoint's export of 16 pt (M4-R4)
  });

  it('not a synthetic bold: another width, another colour or alpha, a stroke alone, a pattern fill, no stroke colour', () => {
    const cases: [string, TextRun][] = [
      ['a quarter thinner', stroked(15.96, (15.96 / 35) * 0.74)],
      ['a quarter wider', stroked(15.96, (15.96 / 35) * 1.26)],
      ['an outline in another colour', stroked(15.96, 0.456, { stroke: { rgb: [255, 0, 0], alpha: 1, wPt: 0.456 } })],
      ['another alpha', stroked(15.96, 0.456, { stroke: { rgb: [10, 20, 30], alpha: 0.5, wPt: 0.456 } })],
      ['a stroke alone (1 Tr)', stroked(15.96, 0.456, { fillMode: 'stroke', fill: null })],
      ['a pattern fill', stroked(15.96, 0.456, { rgb: null, fill: linear() })],
      ['a pattern stroke', stroked(15.96, 0.456, { stroke: null })],
    ];
    for (const [what, r] of cases) expect(runStyle(r), what).toMatchObject({ bold: false, syntheticBold: false });
  });
});

describe('Review Focus 3: a synthetic style on a face that has it already', () => {
  it("a real Italic face that is also sheared 1/3: i once, from the face; its size is not corrected (the shear stays text-skew)", () => {
    const s = runStyle(sheared(24, { italic: true }));
    expect(s).toEqual({ size: 25.298, scale: 1, bold: false, italic: true, syntheticBold: false, syntheticItalic: false });
  });

  it('a real Bold face filled and stroked size / 35: b once, from the face; its stroke stays an outline (a:ln)', () => {
    expect(runStyle(stroked(15.96, 0.456, { bold: true }))).toMatchObject({ size: 16, bold: true, italic: false, syntheticBold: false, syntheticItalic: false });
  });

  it('a real Bold face with a synthetic italic: b from the face, i synthetic, the size of the em', () => {
    const s = runStyle(sheared(24, { bold: true }));
    expect(s).toMatchObject({ bold: true, italic: true, syntheticBold: false, syntheticItalic: true });
    expect(s.size).toBeCloseTo(24, 3);
  });
});

describe('M4-R4: the size PowerPoint was asked for', () => {
  it("the map measured on the atlas: PowerPoint's export draws a size on a 0.12 pt grid (1/600 in), or 0.024 pt past it", () => {
    expect(SIZE_MAP).toEqual({ grid: 0.12, offsets: [0, 0.024], step: 0.5, tol: 0.0015 });
  });

  it('a size on the map is snapped to the half point that maps to it (atlas, atlas-win: 6 to 96 pt)', () => {
    const cases: [number, number][] = [
      [20.064, 20], [20.04, 20], [15.96, 16], [15.984, 16], [14.04, 14], [14.064, 14], [9.024, 9], [9, 9], [12.024, 12],
      [18.024, 18], [21.96, 22], [24.024, 24], [27.96, 28], [32.064, 32], [36.024, 36], [39.984, 40], [39.96, 40],
      [44.064, 44], [44.04, 44], [6.96, 7], [12.96, 13], [96.024, 96], [10.56, 10.5], [20.0645, 20],
    ];
    for (const [pdf, asked] of cases) expect(snapSize(pdf), `${pdf}`).toBe(asked);
  });

  it('a size off the map stays as it is: no half point maps to it, or it is not on the grid', () => {
    for (const pdf of [20.05, 20.1, 11.28, 12.5, 10.02, 19.9, 0, 0.12]) expect(snapSize(pdf), `${pdf}`).toBe(pdf);
  });

  it('M4b Task 1: a size no half point maps to, 0.024 pt past a grid point, is that grid point (a reduced size drawn unkerned)', () => {
    // small capitals at 0.8 x 24 pt: PowerPoint draws 19.2, or 19.224 with kern="0" (atlas/text/12); 19.22 written, the
    // round trip drew the line 0.36 pt longer than 19.2 did
    expect(snapSize(19.224)).toBeCloseTo(19.2, 9);
    expect(snapSize(11.304)).toBeCloseTo(11.28, 9);
    expect(snapSize(19.2)).toBe(19.2);
    // a half point still wins, and a size off the grid either way stays; exactly, as the Scene's 3 decimals hold
    // PowerPoint's sizes (an em size from a shear, 18.8634, is no grid point and offset)
    expect(snapSize(20.064)).toBe(20);
    for (const pdf of [19.23, 19.225, 0.024, 20 / Math.sqrt(1 + (1 / 3 + 0.019) ** 2)]) expect(snapSize(pdf), `${pdf}`).toBe(pdf);
  });

  it('runStyle writes the snapped size, and its scale (snapped over the size the Scene draws at) is what spacing reads', () => {
    expect(runStyle(run({ sizePt: 20.064 }))).toMatchObject({ size: 20, bold: false, italic: false });
    expect(runStyle(run({ sizePt: 20.064 })).scale).toBeCloseTo(20 / 20.064, 12);
    expect(runStyle(run({ sizePt: 18 })).scale).toBe(1);
    // a synthetic italic is snapped at the size of its em (25.298 -> 24.0, on the map)
    const s = runStyle(sheared(24));
    expect(s.size).toBe(24);
    expect(s.scale).toBeCloseTo(24 / emSize(sheared(24)), 12);
  });
});
