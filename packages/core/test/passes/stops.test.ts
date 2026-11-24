import { describe, expect, it } from 'vitest';
import { deltaE76, REDUCE_STOPS, reduceStops, STOP_DELTA_E76 } from '../../src/passes/stops';
import type { Rgb, Stop } from '../../src/scene/types';
import { PROBE_STOPS, snapshot } from '../helpers/passes';

/**
 * Reducing a gradient's sampled stops (0001 M0-6): a stop goes when the colour PowerPoint would interpolate there, linearly
 * in sRGB between the stops kept around it, is within ΔE76 of the samples. Off until Task 12's measurement (writer rule 2).
 */

/** The colour k of the way from a to b, linearly in sRGB, to whole channels as pdf.js samples are. */
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [0, 1, 2].map((c) => Math.round(a[c]! + (b[c]! - a[c]!) * k)) as Rgb;
const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

describe('reduceStops', () => {
  it('29 samples of a two-colour ramp reduce to its 2 ends at ΔE76 1', () => {
    const blue: Rgb = [0, 112, 192];
    const white: Rgb = [255, 255, 255];
    const stops: Stop[] = Array.from({ length: 29 }, (_, i) => ({ t: round6(i / 28), rgb: mix(blue, white, i / 28) }));
    const before = snapshot(stops);
    expect(reduceStops(stops, 1)).toEqual([stops[0], stops[28]]);
    expect(stops).toEqual(before);
  });

  it('a hue sweep keeps every turn, and only the turns', () => {
    const turns: Rgb[] = [
      [255, 0, 0],
      [255, 255, 0],
      [0, 255, 0],
      [0, 255, 255],
      [0, 0, 255],
      [255, 0, 255],
      [255, 0, 0],
    ];
    const stops: Stop[] = [];
    for (let seg = 0; seg < 6; seg++) {
      for (let k = 0; k < 5; k++) stops.push({ t: round6((seg + k / 5) / 6), rgb: mix(turns[seg]!, turns[seg + 1]!, k / 5) });
    }
    stops.push({ t: 1, rgb: turns[6]! });
    expect(stops).toHaveLength(31);
    const kept = reduceStops(stops, 1);
    expect(kept.map((s) => s.rgb)).toEqual(turns);
    expect(kept.map((s) => s.t)).toEqual([0, 1, 2, 3, 4, 5, 6].map((i) => round6(i / 6)));
  });

  it('every stop it drops is within the limit of what is interpolated between the stops it keeps', () => {
    // pdf.js' 29 samples of the probe's gradient: a curve, not a straight ramp
    const kept = reduceStops(PROBE_STOPS, 1);
    expect(kept.length).toBeLessThan(PROBE_STOPS.length);
    expect(kept[0]).toEqual(PROBE_STOPS[0]);
    expect(kept.at(-1)).toEqual(PROBE_STOPS.at(-1));
    for (const s of PROBE_STOPS) {
      const hi = kept.findIndex((k) => k.t >= s.t);
      const [a, b] = [kept[Math.max(0, hi - 1)]!, kept[hi]!];
      const k = b.t === a.t ? 0 : (s.t - a.t) / (b.t - a.t);
      const between = [0, 1, 2].map((c) => a.rgb[c]! + (b.rgb[c]! - a.rgb[c]!) * k) as Rgb;
      expect(deltaE76(between, s.rgb)).toBeLessThanOrEqual(1);
    }
  });

  it('keeps the ends always, and what it cannot drop', () => {
    const red: Rgb = [255, 0, 0];
    expect(reduceStops([{ t: 0, rgb: red }], 1)).toEqual([{ t: 0, rgb: red }]);
    expect(reduceStops([{ t: 0, rgb: red }, { t: 1, rgb: red }], 1)).toHaveLength(2);
    // one colour all along: the ends stay
    expect(reduceStops([0, 0.5, 1].map((t) => ({ t, rgb: red })), 1)).toEqual([{ t: 0, rgb: red }, { t: 1, rgb: red }]);
    // a hard stop (two at one t) is a turn
    const hard: Stop[] = [
      { t: 0, rgb: red },
      { t: 0.5, rgb: red },
      { t: 0.5, rgb: [0, 0, 255] },
      { t: 1, rgb: [0, 0, 255] },
    ];
    expect(reduceStops(hard, 1)).toEqual(hard);
    // at a limit of 0 a stop off the straight line stays
    const bent: Stop[] = [{ t: 0, rgb: [0, 0, 0] }, { t: 0.5, rgb: [100, 100, 100] }, { t: 1, rgb: [255, 255, 255] }];
    expect(reduceStops(bent, 0)).toEqual(bent);
  });

  it('is off until Task 12 measures it (writer rule 2), at a limit of ΔE76 1 when on', () => {
    expect(REDUCE_STOPS).toBe(false);
    expect(STOP_DELTA_E76).toBe(1);
  });

  it('ΔE76 is the CIE76 distance in L*a*b* (D65)', () => {
    expect(deltaE76([255, 255, 255], [255, 255, 255])).toBe(0);
    // white to black is L* 100 to 0
    expect(deltaE76([255, 255, 255], [0, 0, 0])).toBeCloseTo(100, 3);
    expect(deltaE76([255, 0, 0], [0, 0, 255])).toBeCloseTo(176.3, 0);
  });
});
