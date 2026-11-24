import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, releasePage } from '../../src/engine/pdfjs-adapter';
import { pageFrame, walkPage } from '../../src/extract/walker';
import { buildSlide } from '../../src/scene/build';
import { FontTable } from '../../src/scene/fonts';
import { MediaStore } from '../../src/scene/media';
import type { Fill, Rgb, ShapeEl } from '../../src/scene/types';
import { pythonPath, repoRoot } from '../helpers/fixtures';
import { buildPdf, type MiniObject } from '../helpers/minipdf';

/**
 * The Scene's gradients against MuPDF's rendering (Task 8). The colour a gradient fill of the Scene gives at a point,
 * evaluated as the PDF says (ISO 32000-2 8.7.4.5.3 axial, 8.7.4.5.4 radial) from its stops, its shading-space geometry, its
 * matrix and its extend flags, is within ±8 per channel of what MuPDF paints there (`harness/oracle/sample_pixels.py`, a
 * 2 px/pt render). The stops are pdf.js' samples of the shading's function, so the two differ a little; a wrong axis,
 * matrix, stop or extend flag is far off, as the control case shows. A point the gradient does not paint is the white page.
 * Runs in CI (ruling M1-R76); the PDFs are made here and written only to a temporary directory.
 */

const TOLERANCE = 8;
const WHITE: Rgb = [255, 255, 255];

const scratch = mkdtempSync(join(tmpdir(), 'deckback-gradient-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let written = 0;

type Gradient = Extract<Fill, { kind: 'linear' | 'radial' }>;
type Point = [x: number, y: number];

/** `python -m harness.oracle.sample_pixels`: MuPDF's colour at each slide-frame point of page 1. */
function samplePixels(pdf: string, points: Point[]): Rgb[] {
  const args = ['-m', 'harness.oracle.sample_pixels', pdf, '1', ...points.map(([x, y]) => `${x},${y}`)];
  const lines = execFileSync(pythonPath(), args, { cwd: repoRoot, encoding: 'utf8' }).trim().split(/\r?\n/);
  expect(lines).toHaveLength(points.length);
  return lines.map((line) => {
    expect(line).toMatch(/^\d+ \d+ \d+$/);
    return line.split(' ').map(Number) as Rgb;
  });
}

/** The inverse of an affine matrix `[a, b, c, d, e, f]`. */
function invert([a, b, c, d, e, f]: number[]): number[] {
  const det = a! * d! - b! * c!;
  return [d! / det, -b! / det, -c! / det, a! / det, (c! * f! - d! * e!) / det, (b! * e! - a! * f!) / det];
}

const apply = (m: number[], [x, y]: Point): Point => [m[0]! * x + m[2]! * y + m[4]!, m[1]! * x + m[3]! * y + m[5]!];

/**
 * The parameter s of the gradient at a point of shading space: along the axis for an axial one; for a radial one the
 * largest s whose circle passes through the point with a radius of 0 or more. Past an end that does not extend there is
 * none (null); past one that does, the end's.
 */
function parameterAt(fill: Gradient, [u, v]: Point): number | null {
  const [x0, y0] = fill.p0;
  const [x1, y1] = fill.p1;
  const [dx, dy] = [x1 - x0, y1 - y0];
  const allowed = (s: number): boolean => (s >= 0 || fill.extend[0]) && (s <= 1 || fill.extend[1]);
  let s: number | null;
  if (fill.kind === 'linear') {
    s = ((u - x0) * dx + (v - y0) * dy) / (dx * dx + dy * dy);
    if (!allowed(s)) s = null;
  } else {
    const dr = fill.r1 - fill.r0;
    const [px, py] = [u - x0, v - y0];
    const a = dx * dx + dy * dy - dr * dr;
    const b = px * dx + py * dy + fill.r0 * dr;
    const c = px * px + py * py - fill.r0 * fill.r0;
    let roots: number[];
    if (Math.abs(a) < 1e-9) roots = b === 0 ? [] : [c / (2 * b)];
    else {
      const disc = b * b - a * c;
      roots = disc < 0 ? [] : [(b + Math.sqrt(disc)) / a, (b - Math.sqrt(disc)) / a];
    }
    const valid = roots.filter((r) => fill.r0 + r * dr >= 0 && allowed(r));
    s = valid.length === 0 ? null : Math.max(...valid);
  }
  return s === null ? null : Math.min(1, Math.max(0, s));
}

/** The colour of the stops at t, linearly between the two around it. */
function stopColour(fill: Gradient, t: number): Rgb {
  const { stops } = fill;
  if (t <= stops[0]!.t) return stops[0]!.rgb;
  for (let i = 1; i < stops.length; i++) {
    const [a, b] = [stops[i - 1]!, stops[i]!];
    if (t <= b.t) {
      const k = b.t === a.t ? 1 : (t - a.t) / (b.t - a.t);
      return [0, 1, 2].map((c) => a.rgb[c]! + k * (b.rgb[c]! - a.rgb[c]!)) as Rgb;
    }
  }
  return stops.at(-1)!.rgb;
}

/** What the Scene's fill paints at a slide-frame point: a colour, or the page where the gradient paints nothing. */
function colourAt(fill: Gradient, point: Point): Rgb {
  const t = parameterAt(fill, apply(invert(fill.matrix), point));
  return t === null ? WHITE : stopColour(fill, t);
}

/** The centre of the 2 px/pt pixel that holds a point: the place MuPDF samples for it. */
const centre = ([x, y]: Point): Point => [(Math.floor(x * 2) + 0.5) / 2, (Math.floor(y * 2) + 0.5) / 2];

/** The gradient fill of the one element of page 1, built as a deck would be, and the PDF written for MuPDF. */
async function gradientOf(pdf: Uint8Array): Promise<{ file: string; fill: Gradient }> {
  const file = join(scratch, `gradient-${written++}.pdf`);
  writeFileSync(file, pdf);
  const doc = await openDocument(pdf);
  try {
    const page = await loadPage(doc, 0);
    try {
      const context = { media: new MediaStore(null), fonts: new FontTable(null), page };
      const slide = await buildSlide({ index: 0, sizePt: pageFrame(page).size, ops: walkPage(page) }, context);
      expect(slide.elements).toHaveLength(1);
      const fill = (slide.elements[0] as ShapeEl).fill;
      expect(['linear', 'radial']).toContain(fill?.kind);
      return { file, fill: fill as Gradient };
    } finally {
      await releasePage(page);
    }
  } finally {
    await closeDocument(doc);
  }
}

/** The largest channel difference between what the Scene says and what MuPDF paints, per point. */
function differences(file: string, fill: Gradient, points: Point[]): number[] {
  const at = points.map(centre);
  const sampled = samplePixels(file, at);
  return at.map((p, i) => Math.max(...colourAt(fill, p).map((v, c) => Math.abs(v - sampled[i]![c]!))));
}

// -- the PDFs -------------------------------------------------------------------------------------------------------

/** Red to green at 0.3, then to blue: stops pdf.js has to place where the function bends. */
const RGB =
  '<< /FunctionType 3 /Domain [0 1] /Bounds [0.3] /Encode [0 1 0 1] /Functions [' +
  '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 1 0] /N 1 >> << /FunctionType 2 /Domain [0 1] /C0 [0 1 0] /C1 [0 0 1] /N 1 >>] >>';
const axial = (coords: string, extend: string): string =>
  `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${coords}] /Extend [${extend}] /Function ${RGB} >>`;
const radial = (coords: string, extend: string): string =>
  `<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [${coords}] /Extend [${extend}] /Function ${RGB} >>`;

/** A 300 x 300 pt page that paints `content` with resources `resources`. */
function page(content: string, resources: string, objects: MiniObject[]): Uint8Array {
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << ${resources} >> >>` },
    { num: 4, data: content },
    ...objects,
  ]);
}

/** The slide frame of a 300 pt page: y down. */
const slide = ([x, y]: Point): Point => [x, 300 - y];

describe('gradients of the Scene against MuPDF (±8 per channel at 5 points)', () => {
  it('an axial sh, extended at both ends', async () => {
    const pdf = page('q 20 100 260 100 re W n /S sh Q', '/Shading << /S 10 0 R >>', [{ num: 10, body: axial('60 0 240 0', 'true true') }]);
    const { file, fill } = await gradientOf(pdf);
    expect(fill.extend).toEqual([true, true]);
    // Before the axis, across it (red, green at 0.3, blue) and past it.
    const points = [[30, 150], [80, 120], [114, 180], [200, 150], [270, 130]].map((p) => slide(p as Point));
    expect(Math.max(...differences(file, fill, points))).toBeLessThanOrEqual(TOLERANCE);

    // The control: the same gradient the other way round is far off, so the comparison sees a wrong axis.
    const reversed: Gradient = { ...fill, p0: fill.p1, p1: fill.p0 };
    expect(Math.max(...differences(file, reversed, points))).toBeGreaterThan(100);
  });

  it('an axial sh that does not extend: white past both ends', async () => {
    const pdf = page('q 20 100 260 100 re W n /S sh Q', '/Shading << /S 10 0 R >>', [{ num: 10, body: axial('60 0 240 0', 'false false') }]);
    const { file, fill } = await gradientOf(pdf);
    expect(fill.extend).toEqual([false, false]);
    const points = [[30, 150], [80, 120], [114, 180], [200, 150], [270, 130]].map((p) => slide(p as Point));
    expect(points.map((p) => colourAt(fill, centre(p)))[0]).toEqual(WHITE);
    expect(Math.max(...differences(file, fill, points))).toBeLessThanOrEqual(TOLERANCE);
  });

  it('a radial sh with a focus off its centre, extended only at its end', async () => {
    // Inside the start circle the gradient paints nothing; past the end circle it is extended.
    const pdf = page('/S sh', '/Shading << /S 10 0 R >>', [{ num: 10, body: radial('120 150 10 160 150 90', 'false true') }]);
    const { file, fill } = await gradientOf(pdf);
    expect(fill).toMatchObject({ kind: 'radial', p0: [120, 150], r0: 10, p1: [160, 150], r1: 90, extend: [false, true] });
    const points = [[121, 151], [140, 160], [190, 120], [230, 190], [285, 280]].map((p) => slide(p as Point));
    expect(colourAt(fill, centre(points[0]!))).toEqual(WHITE);
    expect(Math.max(...differences(file, fill, points))).toBeLessThanOrEqual(TOLERANCE);
  });

  it("a shading pattern in a form: pattern space is the form's", async () => {
    const form = [0.8, 0.3, -0.3, 0.8, 80, 20];
    const pdf = page('/Fm Do', '/XObject << /Fm 20 0 R >>', [
      { num: 10, body: axial('0 0 200 0', 'true true') },
      { num: 11, body: '<< /Type /Pattern /PatternType 2 /Shading 10 0 R /Matrix [1 0 0 1 -20 0] >>' },
      {
        num: 20,
        dict: `/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Matrix [${form.join(' ')}] /Resources << /Pattern << /P 11 0 R >> >>`,
        data: '/Pattern cs /P scn 0 0 200 150 re f',
      },
    ]);
    const { file, fill } = await gradientOf(pdf);
    const points = [[10, 75], [60, 30], [100, 75], [150, 120], [190, 140]].map((p) => slide(apply(form, p as Point)));
    expect(Math.max(...differences(file, fill, points))).toBeLessThanOrEqual(TOLERANCE);
  });

  it('a shading pattern under a non-uniform, skewed matrix: the axis is no longer perpendicular to the bands', async () => {
    const pdf = page('/Pattern cs /P scn 20 20 260 260 re f', '/Pattern << /P 11 0 R >>', [
      { num: 10, body: axial('0 0 100 100', 'true true') },
      { num: 11, body: '<< /Type /Pattern /PatternType 2 /Shading 10 0 R /Matrix [1.5 0 0.8 0.6 30 40] >>' },
    ]);
    const { file, fill } = await gradientOf(pdf);
    expect(fill.p1).toEqual([100, 100]); // in shading space: the matrix carries it
    const points = [[40, 40], [100, 200], [150, 120], [220, 90], [260, 260]].map((p) => slide(p as Point));
    expect(Math.max(...differences(file, fill, points))).toBeLessThanOrEqual(TOLERANCE);
  });

  it('a radial shading pattern under a non-uniform matrix: an ellipse, extended at its start only', async () => {
    const pdf = page('/Pattern cs /P scn 10 10 280 280 re f', '/Pattern << /P 11 0 R >>', [
      { num: 10, body: radial('0 0 0 0 0 100', 'true false') },
      { num: 11, body: '<< /Type /Pattern /PatternType 2 /Shading 10 0 R /Matrix [1.2 0 0 0.6 150 150] >>' },
    ]);
    const { file, fill } = await gradientOf(pdf);
    // Inside the ellipse 120 x 60 pt about (150, 150) and outside it (not extended: white).
    const points = [[150, 150], [200, 160], [120, 120], [240, 150], [150, 260]].map((p) => slide(p as Point));
    expect(colourAt(fill, centre(points[4]!))).toEqual(WHITE);
    expect(Math.max(...differences(file, fill, points))).toBeLessThanOrEqual(TOLERANCE);
  });
});
