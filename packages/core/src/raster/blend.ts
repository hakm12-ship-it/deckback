import type { BlendName } from '../scene/types';

/**
 * The 16 blend modes of PDF (ISO 32000-2 11.3.5), B(Cb, Cs) on colours of 0..1 a channel, for the raster renderer: the
 * separable ones channel by channel, hue, saturation, color and luminosity through Lum, Sat, SetLum and SetSat. Only
 * +, -, *, / and a square root (soft light), which every engine rounds alike.
 */

export const BLEND_MODES = [
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'colordodge',
  'colorburn',
  'hardlight',
  'softlight',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
] as const satisfies readonly BlendName[];

function hardLight(cb: number, cs: number): number {
  return cs <= 0.5 ? cb * 2 * cs : cb + (2 * cs - 1) - cb * (2 * cs - 1);
}

function separable(mode: BlendName, cb: number, cs: number): number {
  switch (mode) {
    case 'multiply':
      return cb * cs;
    case 'screen':
      return cb + cs - cb * cs;
    case 'overlay':
      return hardLight(cs, cb);
    case 'darken':
      return Math.min(cb, cs);
    case 'lighten':
      return Math.max(cb, cs);
    case 'colordodge':
      if (cb === 0) return 0;
      return cs >= 1 ? 1 : Math.min(1, cb / (1 - cs));
    case 'colorburn':
      if (cb >= 1) return 1;
      return cs <= 0 ? 0 : 1 - Math.min(1, (1 - cb) / cs);
    case 'hardlight':
      return hardLight(cb, cs);
    case 'softlight': {
      if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
      const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(cb);
      return cb + (2 * cs - 1) * (d - cb);
    }
    case 'difference':
      return Math.abs(cb - cs);
    case 'exclusion':
      return cb + cs - 2 * cb * cs;
    default:
      return cs;
  }
}

const lum = (c: readonly number[]): number => 0.3 * c[0]! + 0.59 * c[1]! + 0.11 * c[2]!;

/** ClipColor: a colour brought into 0..1 about its luminosity, which it keeps. */
function clipColor(c: number[]): number[] {
  const l = lum(c);
  const n = Math.min(c[0]!, c[1]!, c[2]!);
  const x = Math.max(c[0]!, c[1]!, c[2]!);
  let out = c;
  if (n < 0) out = out.map((v) => l + ((v - l) * l) / (l - n));
  if (x > 1) out = out.map((v) => l + ((v - l) * (1 - l)) / (x - l));
  return out;
}

function setLum(c: readonly number[], l: number): number[] {
  const d = l - lum(c);
  return clipColor([c[0]! + d, c[1]! + d, c[2]! + d]);
}

const sat = (c: readonly number[]): number => Math.max(c[0]!, c[1]!, c[2]!) - Math.min(c[0]!, c[1]!, c[2]!);

/** SetSat: the colour's channels stretched so their range is `s`, the smallest at 0 (ties keep the first's place). */
function setSat(c: readonly number[], s: number): number[] {
  const order = [0, 1, 2].sort((a, b) => c[a]! - c[b]!);
  const [lo, mid, hi] = order as [number, number, number];
  const out = [0, 0, 0];
  if (c[hi]! > c[lo]!) {
    out[mid] = ((c[mid]! - c[lo]!) * s) / (c[hi]! - c[lo]!);
    out[hi] = s;
  }
  return out;
}

/** B(cb, cs) of `mode` into `out`: three channels of 0..1. */
export function blend(mode: BlendName, cb: readonly number[], cs: readonly number[], out: number[]): void {
  switch (mode) {
    case 'hue':
      setLum(setSat(cs, sat(cb)), lum(cb)).forEach((v, i) => (out[i] = v));
      return;
    case 'saturation':
      setLum(setSat(cb, sat(cs)), lum(cb)).forEach((v, i) => (out[i] = v));
      return;
    case 'color':
      setLum(cs, lum(cb)).forEach((v, i) => (out[i] = v));
      return;
    case 'luminosity':
      setLum(cb, lum(cs)).forEach((v, i) => (out[i] = v));
      return;
    default:
      for (let i = 0; i < 3; i++) out[i] = separable(mode, cb[i]!, cs[i]!);
  }
}

/** The luminosity of a colour of 0..255 a channel as a soft mask reads it: MuPDF's integer weights, 77, 151 and 28 / 256. */
export function luminosity(r: number, g: number, b: number): number {
  return (r * 77 + g * 151 + b * 28 + 128) >> 8;
}
