import type { Emu, OxFill, OxLineStyle, Pct } from '@deckback/ooxml';
import type { Fill, LineStyle, Rgb } from '../../scene/types';

/**
 * Units of lowering (Global Constraints, DrawingML rules): geometry is integer EMU, 12700 per pt, rounded half away from
 * zero; alphas are 1000ths of a percent (100000 is opaque).
 */

export const EMU_PER_PT = 12700;

/**
 * `pt` in EMU, rounded half away from zero. The product is first snapped to 1e-6 EMU, so that the decimal value the Scene
 * holds rounds as written: 9.995 pt is 126936.5 EMU, which a double computes as 126936.49999999999.
 */
export function emu(pt: number): Emu {
  const product = Math.round(pt * EMU_PER_PT * 1e6) / 1e6;
  return Math.sign(product) * Math.round(Math.abs(product)) + 0; // + 0: no -0
}

/** An alpha (0..1) as a Pct, held to 0..100000. */
export function pct(alpha: number): Pct {
  return Math.min(100000, Math.max(0, Math.round(alpha * 100000)));
}

/** `RRGGBB`, upper case. */
export function hex(rgb: Rgb): string {
  return rgb.map((c) => Math.min(255, Math.max(0, Math.round(c))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/**
 * How a slide-frame point lands on the slide: scaled by `scale`, then moved by `offset` (pt), then in EMU (Task 9 fills
 * scale and offset for pages of another size; until then 1 and [0, 0]).
 */
export interface Placement {
  scale: number;
  offset: readonly [x: number, y: number];
}

export const placeX = (p: Placement, x: number): Emu => emu(x * p.scale + p.offset[0]);
export const placeY = (p: Placement, y: number): Emu => emu(y * p.scale + p.offset[1]);

/**
 * A solid Scene paint as a fill, its alpha times `alphaMul` (`a:noFill` at alpha 0); null for any other paint (a gradient
 * is laid over its node's frame: `gradFill`).
 */
export function solidFill(paint: Fill, alphaMul: number): OxFill | null {
  if (paint.kind !== 'solid') return null;
  const alpha = pct(paint.alpha * alphaMul);
  return alpha === 0 ? { kind: 'none' } : { kind: 'solid', rgb: hex(paint.rgb), alpha };
}

const CAP: Record<LineStyle['cap'], OxLineStyle['cap']> = { butt: 'flat', round: 'rnd', square: 'sq' };

/**
 * The width a line of `w` 0 is drawn with on the slide, a hairline: one pixel at 96 dpi. Dashes are a share of the
 * line's width in DrawingML, so a hairline's are measured against this.
 */
export const HAIRLINE_PT = 0.75;

/**
 * A dash array (slide-frame pt) as 1000ths of a percent of the width `w` (slide-frame pt); null for a solid line. A share
 * does not change with the page's `scale`, except a hairline's: it stays one pixel wide on the slide, which is
 * `HAIRLINE_PT / scale` in the page's units.
 *
 * With a round or square cap (`capped`), a PDF dash is drawn half a width longer at each end than its length, and a
 * DrawingML dash takes its caps in: PowerPoint exports a 4:3 dash at width w as [3w 4w] (atlas/lines/03, and lines/12's
 * custDash 4:1 1:1 with round caps as [3w 2w 0 2w]). So each dash gains a width and each gap loses one, a gap under a
 * width being none (the caps meet; the writer writes its least, 1). An odd array is repeated first, as PDF reads it. A
 * hairline's caps reach nothing past its ends.
 */
export function dashPct(dash: readonly number[], w: number, scale: number, capped = false): number[] | null {
  if (dash.length === 0) return null;
  const width = w > 0 ? w : HAIRLINE_PT / scale;
  const pairs = capped && w > 0 ? (dash.length % 2 === 1 ? [...dash, ...dash] : dash) : dash;
  const reach = capped && w > 0 ? w : 0;
  return pairs.map((d, i) => Math.round((Math.max(0, i % 2 === 0 ? d + reach : d - reach) / width) * 100000));
}

/**
 * A Scene line style as DrawingML's but for its paint: width in EMU after `scale`, the cap by name (butt flat, round rnd,
 * square sq), the miter limit in `lim` units (the ratio x 100000, ruling M3-R11) and the dashes as a share of the width
 * (a share does not change with the scale; with a round or square cap, each dash with its caps: `dashPct`). The dash
 * phase has no place in DrawingML and is not written.
 */
export function lineBase(line: LineStyle, scale: number): Omit<OxLineStyle, 'fill'> {
  return {
    w: emu(line.w * scale),
    cap: CAP[line.cap],
    join: line.join,
    miterLim: Math.round(line.miter * 100000),
    dash: dashPct(line.dash, line.w, scale, line.cap !== 'butt'),
  };
}

/** A Scene line style with a solid paint as DrawingML's (`lineBase`); null for another paint or a fully transparent one. */
export function lineStyle(line: LineStyle, scale: number, alphaMul: number): OxLineStyle | null {
  const fill = solidFill(line.paint, alphaMul);
  if (fill === null || fill.kind === 'none') return null;
  return { ...lineBase(line, scale), fill };
}

/** A turn in degrees as DrawingML's: 60000ths of a degree, 0..21599999. */
export const rot = (deg: number): number => (Math.round(deg * 60000) % 21600000) + 0;

/**
 * The unit vector of a direction `deg` degrees clockwise from the x axis (y down): exact at the quarter turns, which are
 * most text, so that no engine's trigonometry is on their path (Global Constraints, Determinism). Off them, `Math.cos`
 * and `Math.sin` are on the output path, accepted as `Math.atan2` is (ruling M3-R64, as M2-R34): the four-engine e2e
 * converts text at 30, 45, 200 and 333.3 degrees and compares the PPTX hashes; one that differs would replace them.
 */
export function direction(deg: number): [cos: number, sin: number] {
  switch (deg) {
    case 0:
      return [1, 0];
    case 90:
      return [0, 1];
    case 180:
      return [-1, 0];
    case 270:
      return [0, -1];
  }
  const t = (deg * Math.PI) / 180;
  return [Math.cos(t), Math.sin(t)];
}
