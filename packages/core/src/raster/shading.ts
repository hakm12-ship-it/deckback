import type { ImagePixels } from '../extract/walker';
import type { AlphaStop } from '../passes/gradients';
import type { Fill, Rgb, ShadingMesh, Stop } from '../scene/types';
import { SS, type Grid } from './paint';

/**
 * The paints of the raster renderer (raster.ts), evaluated at each sample: a solid colour; a linear or radial gradient by
 * its formula in shading space (ISO 32000-2 8.7.4.5.3, 8.7.4.5.4) and its stops, linear between them; a function-based
 * shading or a mesh as the triangles pdf.js made of it (`ShadingMesh`), each Gouraud-shaded; a picture's pixels. Every
 * colour is 0..255 a channel, rounded half up.
 */

export interface Paint {
  /** Called before the samples of pixel row `j`: a mesh lays out that row's triangles. */
  row?(j: number): void;
  /**
   * The colour and alpha (0..255) at sample (cx, cy) of the grid, whose centre is (x, y) in the frame, into `out`; false
   * where it paints nothing (past a gradient's end that does not extend, outside a mesh or a picture).
   */
  at(cx: number, cy: number, x: number, y: number, out: number[]): boolean;
  /** A mesh: the pixels of its triangles' boxes it lays out (`MESH_WORK_PX`), which a raster's work budget counts. */
  work?: number;
}

type Affine = [number, number, number, number, number, number];

const affine = (m: readonly number[]): Affine => [m[0] ?? 1, m[1] ?? 0, m[2] ?? 0, m[3] ?? 1, m[4] ?? 0, m[5] ?? 0];

/** The inverse of a matrix, null when it has none. */
export function invert(m: readonly number[]): Affine | null {
  const [a, b, c, d, e, f] = affine(m);
  const det = a * d - b * c;
  if (!(det !== 0) || !Number.isFinite(det)) return null;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}

export function solidPaint([r, g, b]: Rgb): Paint {
  return {
    at(_cx, _cy, _x, _y, out) {
      out[0] = r;
      out[1] = g;
      out[2] = b;
      out[3] = 255;
      return true;
    },
  };
}

/** The colour of stops at `t` (0..1), linear between the two around it, rounded half up. */
function stopColour(stops: readonly Stop[], t: number, out: number[]): void {
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1]!.t < t) i++;
  const a = stops[i]!;
  const b = stops[Math.min(i + 1, stops.length - 1)]!;
  const span = b.t - a.t;
  const k = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : t >= b.t ? 1 : 0;
  for (let c = 0; c < 3; c++) out[c] = Math.floor(a.rgb[c]! + (b.rgb[c]! - a.rgb[c]!) * k + 0.5);
  out[3] = 255;
}

/** The alpha (0..255, unrounded) of alpha stops at `t` (0..1), linear between the two around it, as `stopColour`. */
function stopAlpha(stops: readonly AlphaStop[], t: number): number {
  let i = 0;
  while (i < stops.length - 1 && stops[i + 1]!.t < t) i++;
  const a = stops[i]!;
  const b = stops[Math.min(i + 1, stops.length - 1)]!;
  const span = b.t - a.t;
  const k = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : t >= b.t ? 1 : 0;
  return 255 * (a.alpha + (b.alpha - a.alpha) * k);
}

type Gradient = Extract<Fill, { kind: 'linear' | 'radial' }>;

/**
 * A linear or radial gradient; one whose matrix has no inverse or that has no stops paints nothing. With `alphas` (a soft
 * mask made stop alpha, final review I2) each sample's alpha is theirs at its `t`, as the mask would make it.
 */
export function gradientPaint(fill: Gradient, alphas?: readonly AlphaStop[]): Paint {
  const inv = invert(fill.matrix);
  const { stops, extend } = fill;
  if (inv === null || stops.length === 0) return { at: () => false };
  const opacity = alphas === undefined || alphas.length === 0 ? null : [...alphas].sort((a, b) => a.t - b.t);
  const stopsAt = (t: number, out: number[]): void => {
    stopColour(stops, t, out);
    if (opacity !== null) out[3] = stopAlpha(opacity, t);
  };
  const [ia, ib, ic, id, ie, iff] = inv;
  if (fill.kind === 'linear') {
    const [x0, y0] = fill.p0;
    const [dx, dy] = [fill.p1[0] - x0, fill.p1[1] - y0];
    const len2 = dx * dx + dy * dy;
    if (!(len2 > 0)) return { at: () => false };
    return {
      at(_cx, _cy, x, y, out) {
        const u = ia * x + ic * y + ie;
        const v = ib * x + id * y + iff;
        let t = ((u - x0) * dx + (v - y0) * dy) / len2;
        if (t < 0) {
          if (!extend[0]) return false;
          t = 0;
        } else if (t > 1) {
          if (!extend[1]) return false;
          t = 1;
        }
        stopsAt(t, out);
        return true;
      },
    };
  }
  const [x0, y0] = fill.p0;
  const { r0, r1 } = fill;
  const [cdx, cdy, dr] = [fill.p1[0] - x0, fill.p1[1] - y0, r1 - r0];
  const a = cdx * cdx + cdy * cdy - dr * dr;
  /** Whether s is a circle of the gradient: of radius at least 0, within its ends or past one that extends. */
  const allowed = (s: number): boolean => r0 + s * dr >= 0 && (s >= 0 || extend[0]) && (s <= 1 || extend[1]);
  return {
    at(_cx, _cy, x, y, out) {
      const pdx = ia * x + ic * y + ie - x0;
      const pdy = ib * x + id * y + iff - y0;
      const b = pdx * cdx + pdy * cdy + r0 * dr;
      const c = pdx * pdx + pdy * pdy - r0 * r0;
      let s: number;
      if (a === 0) {
        if (b === 0) return false;
        s = c / (2 * b);
        if (!allowed(s)) return false;
      } else {
        const disc = b * b - a * c;
        if (disc < 0) return false;
        const root = Math.sqrt(disc);
        const [s1, s2] = a > 0 ? [(b + root) / a, (b - root) / a] : [(b - root) / a, (b + root) / a];
        if (allowed(s1)) s = s1;
        else if (allowed(s2)) s = s2;
        else return false;
      }
      stopsAt(Math.min(1, Math.max(0, s)), out);
      return true;
    },
  };
}

/** Where the row at `y` crosses the edge (x0, y0)-(x1, y1), taken as [top, bottom) in y; NaN where it does not. */
function crossX(x0: number, y0: number, x1: number, y1: number, y: number): number {
  if (y0 === y1) return Number.NaN;
  if (y0 < y1 ? y < y0 || y >= y1 : y < y1 || y >= y0) return Number.NaN;
  return x0 + ((y - y0) * (x1 - x0)) / (y1 - y0);
}

/**
 * The most pixels a mesh's triangles may reach (fix round 1, I1): the sum over its triangles of the pixels of their boxes
 * on the grid, which bounds both the rows each triangle is visited in and the samples it paints. 4 x `FALLBACK_MAX_PX`
 * (raster.ts): pdf.js' largest lattice over a whole slide reaches about 6 M (each cell's two triangles share its box). A
 * mesh past it (300,000 thin triangles the full height of a slide reach 324 M) is not painted (`meshPaint` null), which
 * the raster renderer notes.
 */
export const MESH_WORK_PX = 16_000_000;

/**
 * A mesh's triangles over the grid, in paint order, each Gouraud-shaded: each pixel row (four sample rows) is laid out
 * before its samples are asked (`row`), the triangles that reach it painted into it in order, a later one over an earlier
 * one. A sample is in a triangle when its centre is, on its left edge in, on its right edge out, so two triangles that share
 * an edge leave no sample out and paint none twice. `background` (a pattern fill's /Background) is painted where no
 * triangle is when `useBackground`; the /BBox clips it (in shading space).
 *
 * Bounded (fix round 1): null when the pixels of the triangles' boxes on the grid add up past `maxWork`; what lies off
 * the grid, or has a coordinate that is not finite, costs nothing and is not painted. The rows are swept in order, the
 * triangles that reach a row kept in paint order (sorted by their first row, then merged in), so the memory is the
 * row's samples, a few numbers a triangle, and the triangles of one row.
 */
export function meshPaint(mesh: ShadingMesh, grid: Grid, useBackground: boolean, maxWork = MESH_WORK_PX): Paint | null {
  const [a, b, c, d, e, f] = affine(mesh.matrix);
  const n = mesh.xy.length / 2;
  // vertices in sample space
  const sx = new Float64Array(n);
  const sy = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const [u, w] = [mesh.xy[v * 2]!, mesh.xy[v * 2 + 1]!];
    sx[v] = (a * u + c * w + e - grid.x0) * grid.s * SS;
    sy[v] = (b * u + d * w + f - grid.y0) * grid.s * SS;
  }
  const width = grid.w * SS;
  const rows = grid.h;
  const count = Math.floor(mesh.triangles.length / 3);
  // each triangle's first and last pixel row on the grid (first > last: none), and the work of its box
  const first = new Int32Array(count).fill(1);
  const last = new Int32Array(count);
  const starting = new Int32Array(rows + 1);
  let work = 0;
  for (let t = 0; t < count; t++) {
    const [p, q, r] = [mesh.triangles[t * 3]!, mesh.triangles[t * 3 + 1]!, mesh.triangles[t * 3 + 2]!];
    if (!(p < n && q < n && r < n)) continue;
    const top = Math.min(sy[p]!, sy[q]!, sy[r]!);
    const bottom = Math.max(sy[p]!, sy[q]!, sy[r]!);
    const j0 = Math.max(0, Math.floor((top - 0.5) / SS));
    const j1 = Math.min(rows - 1, Math.floor((bottom - 0.5) / SS));
    const i0 = Math.max(0, Math.floor(Math.min(sx[p]!, sx[q]!, sx[r]!) / SS));
    const i1 = Math.min(grid.w, Math.ceil(Math.max(sx[p]!, sx[q]!, sx[r]!) / SS));
    if (!(j0 <= j1 && i0 < i1)) continue; // off the grid, or not finite
    work += (j1 - j0 + 1) * (i1 - i0);
    if (!(work <= maxWork)) return null;
    first[t] = j0;
    last[t] = j1;
    starting[j0 + 1]! += 1;
  }
  // the triangles by their first row, in paint order within a row (a counting sort: stable)
  for (let j = 0; j < rows; j++) starting[j + 1]! += starting[j]!;
  const byFirst = new Int32Array(starting[rows]!);
  const fill = starting.slice(0, rows);
  for (let t = 0; t < count; t++) if (first[t]! <= last[t]!) byFirst[fill[first[t]!]!++] = t;
  let next = 0;
  let active: number[] = [];
  let swept = -1;
  /** The triangles that reach row `j`, in paint order (rows asked out of order start the sweep again). */
  const reach = (j: number): number[] => {
    if (j < swept) {
      next = 0;
      active = [];
    }
    swept = j;
    const added: number[] = [];
    while (next < byFirst.length && first[byFirst[next]!]! <= j) added.push(byFirst[next++]!);
    const kept = active.filter((t) => last[t]! >= j);
    if (added.length === 0) return (active = kept);
    added.sort((x, y) => x - y);
    // merge two lists sorted by triangle index
    const merged: number[] = [];
    let [i, k] = [0, 0];
    while (i < kept.length || k < added.length) {
      if (k >= added.length || (i < kept.length && kept[i]! < added[k]!)) merged.push(kept[i++]!);
      else merged.push(added[k++]!);
    }
    return (active = merged.filter((t) => last[t]! >= j));
  };
  const inv = mesh.bbox === null ? null : invert(mesh.matrix);
  const box = mesh.bbox;
  const band = new Uint8Array(SS * width * 3);
  const set = new Uint8Array(SS * width);
  let bandRow = -1;
  const lay = (j: number): void => {
    bandRow = j;
    set.fill(0);
    for (const t of reach(j)) {
      const p = mesh.triangles[t * 3]!;
      const q = mesh.triangles[t * 3 + 1]!;
      const r = mesh.triangles[t * 3 + 2]!;
      const ax = sx[p]!;
      const ay = sy[p]!;
      const bx = sx[q]!;
      const by = sy[q]!;
      const cx = sx[r]!;
      const cy = sy[r]!;
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (!(Math.abs(area) > 0)) continue;
      for (let k = 0; k < SS; k++) {
        const y = j * SS + k + 0.5;
        // where the row crosses the triangle's edges (each edge [top, bottom) in y); no allocation in this loop
        let lo = Infinity;
        let hi = -Infinity;
        const e1 = crossX(ax, ay, bx, by, y);
        const e2 = crossX(bx, by, cx, cy, y);
        const e3 = crossX(cx, cy, ax, ay, y);
        if (!Number.isNaN(e1)) [lo, hi] = [Math.min(lo, e1), Math.max(hi, e1)];
        if (!Number.isNaN(e2)) [lo, hi] = [Math.min(lo, e2), Math.max(hi, e2)];
        if (!Number.isNaN(e3)) [lo, hi] = [Math.min(lo, e3), Math.max(hi, e3)];
        if (!(hi > lo)) continue;
        const from = Math.max(0, Math.ceil(lo - 0.5));
        const to = Math.min(width, Math.ceil(hi - 0.5));
        for (let col = from; col < to; col++) {
          const x = col + 0.5;
          const l1 = ((x - ax) * (cy - ay) - (y - ay) * (cx - ax)) / area;
          const l2 = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / area;
          const at = k * width + col;
          for (let ch = 0; ch < 3; ch++) {
            const ca = mesh.rgb[p * 3 + ch]!;
            const v = ca + l1 * (mesh.rgb[q * 3 + ch]! - ca) + l2 * (mesh.rgb[r * 3 + ch]! - ca);
            band[at * 3 + ch] = Math.min(255, Math.max(0, Math.floor(v + 0.5)));
          }
          set[at] = 1;
        }
      }
    }
  };
  const background = useBackground ? mesh.background : null;
  return {
    work,
    row(j) {
      if (j !== bandRow) lay(j);
    },
    at(cx, cy, x, y, out) {
      if (box !== null && inv !== null) {
        const u = inv[0] * x + inv[2] * y + inv[4];
        const v = inv[1] * x + inv[3] * y + inv[5];
        if (u < box[0] || u > box[2] || v < box[1] || v > box[3]) return false;
      }
      const j = Math.floor(cy / SS);
      if (j !== bandRow) lay(j);
      const at = (cy - j * SS) * width + cx;
      if (set[at] === 1) {
        out[0] = band[at * 3]!;
        out[1] = band[at * 3 + 1]!;
        out[2] = band[at * 3 + 2]!;
      } else if (background !== null) {
        [out[0], out[1], out[2]] = background;
      } else {
        return false;
      }
      out[3] = 255;
      return true;
    },
  };
}

/** Decoded pixels as pdf.js gives them, and an image mask's colour (`MediaStore`'s `ImageInput`). */
export type RasterPixels = ImagePixels & { fill?: Rgb };

/**
 * A picture painted under `matrix` (its unit square to the frame, y up the image): the pixel a sample falls in, nearest,
 * so the 16 samples of a pixel average it. Gray of one bit: 0 black, 1 white; an image mask paints `stencil` where a bit is
 * 0. Outside the unit square nothing.
 */
export function imagePaint(pixels: RasterPixels, matrix: readonly number[], stencil: Rgb | null): Paint {
  const inv = invert(matrix);
  const { width, height, format, data } = pixels;
  if (inv === null || !(width > 0 && height > 0)) return { at: () => false };
  const [ia, ib, ic, id, ie, iff] = inv;
  const rowBytes = (width + 7) >> 3;
  const fill = stencil ?? pixels.fill ?? [0, 0, 0];
  return {
    at(_cx, _cy, x, y, out) {
      const u = ia * x + ic * y + ie;
      const v = ib * x + id * y + iff;
      if (!(u >= 0 && u < 1 && v > 0 && v <= 1)) return false;
      const col = Math.min(width - 1, Math.floor(u * width));
      const row = Math.min(height - 1, Math.floor((1 - v) * height));
      switch (format) {
        case 'rgb': {
          const at = (row * width + col) * 3;
          [out[0], out[1], out[2], out[3]] = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, 255];
          return true;
        }
        case 'rgba': {
          const at = (row * width + col) * 4;
          [out[0], out[1], out[2], out[3]] = [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 255];
          return true;
        }
        case 'gray1': {
          const g = (data[row * rowBytes + (col >> 3)] ?? 0) & (0x80 >> (col & 7)) ? 255 : 0;
          [out[0], out[1], out[2], out[3]] = [g, g, g, 255];
          return true;
        }
        case 'mask': {
          const painted = ((data[row * rowBytes + (col >> 3)] ?? 0) & (0x80 >> (col & 7))) === 0;
          if (!painted) return false;
          [out[0], out[1], out[2], out[3]] = [fill[0], fill[1], fill[2], 255];
          return true;
        }
      }
    },
  };
}
