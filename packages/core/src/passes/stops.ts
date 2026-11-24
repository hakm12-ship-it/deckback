import type { Rgb, Stop } from '../scene/types';

/**
 * Whether lowering reduces a gradient's sampled stops (`reduceStops`). Off: writer rule 2 keeps pdf.js' samples (0001
 * M0-6), until Task 12 measures what the reduction costs in PowerPoint and the controller rules on it. `LowerCtx`
 * `reduceStops` turns it on for one lowering, so both settings can be measured.
 */
export const REDUCE_STOPS = false;

/** The CIE76 colour difference a dropped stop may have from what PowerPoint interpolates in its place, when on. */
export const STOP_DELTA_E76 = 1;

/** sRGB 0..255 to CIE L*a*b* (D65), as `harness/spikes/m0_6_gradient.py` does. */
function lab([r8, g8, b8]: Rgb): [number, number, number] {
  const linear = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [linear(r8), linear(g8), linear(b8)];
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = [f(x), f(y), f(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** The CIE76 difference of two sRGB colours (channels 0..255, fractions allowed). */
export function deltaE76(a: Rgb, b: Rgb): number {
  const [la, lb] = [lab(a), lab(b)];
  const [dl, da, db] = [la[0] - lb[0], la[1] - lb[1], la[2] - lb[2]];
  return Math.sqrt(dl * dl + da * da + db * db); // not hypot, which engines round differently (Determinism)
}

/**
 * The worst CIE76 difference, over the stops strictly between `lo` and `hi` (indexes into `stops`), between each stop and
 * the colour interpolated there linearly in sRGB from stop `lo` to stop `hi`, as PowerPoint draws between two stops.
 */
function worstBetween(stops: readonly Stop[], lo: number, hi: number): number {
  const [a, b] = [stops[lo]!, stops[hi]!];
  let worst = 0;
  for (let i = lo + 1; i < hi; i++) {
    const s = stops[i]!;
    const k = b.t > a.t ? (s.t - a.t) / (b.t - a.t) : 0;
    const between: Rgb = [0, 1, 2].map((c) => a.rgb[c]! + (b.rgb[c]! - a.rgb[c]!) * k) as Rgb;
    worst = Math.max(worst, deltaE76(between, s.rgb));
  }
  return worst;
}

/**
 * The stops (in order of `t`) with those dropped that PowerPoint would draw within `maxDeltaE76` of them anyway: one at a
 * time, always the stop whose dropping costs least, while that cost is within the limit. The cost of dropping a stop is
 * the worst difference, over every stop of the input between its two kept neighbours (those dropped before included),
 * between that stop and the colour interpolated linearly between the neighbours (`harness/spikes/m0_6_gradient.py`
 * `reduce_stops`, without its stop count). So every stop of the input is within the limit of what is drawn in its
 * place. The ends are always kept; of equal costs the first stop goes. A new list of the input's stops; the input is
 * not changed.
 */
export function reduceStops<S extends Stop>(stops: S[], maxDeltaE76: number): S[] {
  const n = stops.length;
  if (n <= 2) return [...stops];
  // a list of the kept stops, linked both ways, and the cost of dropping each inner one
  const prev = Array.from({ length: n }, (_, i) => i - 1);
  const next = Array.from({ length: n }, (_, i) => i + 1);
  const kept = new Array<boolean>(n).fill(true);
  const cost = new Array<number>(n).fill(Infinity);
  const price = (i: number): number => (i <= 0 || i >= n - 1 ? Infinity : worstBetween(stops, prev[i]!, next[i]!));
  for (let i = 1; i < n - 1; i++) cost[i] = price(i);
  for (;;) {
    let best = -1;
    for (let i = 1; i < n - 1; i++) if (kept[i] && (best < 0 || cost[i]! < cost[best]!)) best = i;
    if (best < 0 || !(cost[best]! <= maxDeltaE76)) break;
    kept[best] = false;
    const [p, q] = [prev[best]!, next[best]!];
    next[p] = q;
    prev[q] = p;
    cost[p] = price(p);
    cost[q] = price(q);
  }
  return stops.filter((_, i) => kept[i]);
}
