import { describe, expect, it } from 'vitest';
import type { Grid } from '../../src/raster/paint';
import { gradientPaint, MESH_WORK_PX, meshPaint, type Paint } from '../../src/raster/shading';
import type { ShadingMesh } from '../../src/scene/types';
import { linear, radial } from '../helpers/passes';

/** The paints the raster renderer evaluates at each sample: gradients by their formulas, meshes Gouraud-shaded. */

const BLACK_WHITE = [
  { t: 0, rgb: [0, 0, 0] as [number, number, number] },
  { t: 1, rgb: [255, 255, 255] as [number, number, number] },
];

/** The paint at a point of the frame (`at`'s sample indices do not matter to a gradient). */
function colourAt(paint: Paint, x: number, y: number): number[] | null {
  const out = [0, 0, 0, 0];
  return paint.at(0, 0, x, y, out) ? out : null;
}

describe('gradient paints', () => {
  it('linear: t along the axis in shading space, through the matrix; ends extend or paint nothing', () => {
    // Shading space x 0..100 is the frame's x 10..210 (scaled by 2).
    const fill = linear({ stops: BLACK_WHITE, p0: [0, 0], p1: [100, 0], matrix: [2, 0, 0, 1, 10, 0], extend: [false, true] });
    const paint = gradientPaint(fill);
    expect(colourAt(paint, 10, 5)).toEqual([0, 0, 0, 255]);
    expect(colourAt(paint, 110, 5)).toEqual([128, 128, 128, 255]);
    expect(colourAt(paint, 210, 5)).toEqual([255, 255, 255, 255]);
    expect(colourAt(paint, 400, 5)).toEqual([255, 255, 255, 255]); // extended
    expect(colourAt(paint, 0, 5)).toBeNull(); // before p0, not extended
  });

  it('linear: stops between are interpolated, and rounded half up', () => {
    const fill = linear({
      stops: [
        { t: 0, rgb: [0, 0, 0] },
        { t: 0.5, rgb: [200, 100, 0] },
        { t: 1, rgb: [200, 100, 255] },
      ],
      p0: [0, 0],
      p1: [100, 0],
      matrix: [1, 0, 0, 1, 0, 0],
      extend: [true, true],
    });
    expect(colourAt(gradientPaint(fill), 25, 0)).toEqual([100, 50, 0, 255]);
    expect(colourAt(gradientPaint(fill), 75, 0)).toEqual([200, 100, 128, 255]);
  });

  it('radial: the largest s whose circle passes through the point (two circles, ISO 32000-2 8.7.4.5.4)', () => {
    // Concentric: radius 0 to 100 about (100, 100).
    const fill = radial({ stops: BLACK_WHITE, p0: [100, 100], r0: 0, p1: [100, 100], r1: 100, matrix: [1, 0, 0, 1, 0, 0], extend: [false, false] });
    const paint = gradientPaint(fill);
    expect(colourAt(paint, 100, 100)).toEqual([0, 0, 0, 255]);
    expect(colourAt(paint, 150, 100)).toEqual([128, 128, 128, 255]);
    expect(colourAt(paint, 100, 175)).toEqual([191, 191, 191, 255]);
    expect(colourAt(paint, 201, 100)).toBeNull();
    // A cone (r0 = r1 = 10, centres apart): only points within the swept circles are painted.
    const cone = gradientPaint(radial({ stops: BLACK_WHITE, p0: [50, 50], r0: 10, p1: [150, 50], r1: 10, matrix: [1, 0, 0, 1, 0, 0], extend: [false, false] }));
    expect(colourAt(cone, 100, 50)).toEqual([153, 153, 153, 255]); // s 0.4 and 0.6 pass through it: the larger
    expect(colourAt(cone, 100, 70)).toBeNull();
  });
});

describe('mesh paint', () => {
  // One triangle of shading space, 0..8 x 0..8, gray 0 at (0, 0), red at (8, 0) and blue at (0, 8), through the identity.
  const mesh: ShadingMesh = {
    type: 4,
    xy: [0, 0, 8, 0, 0, 8],
    rgb: [0, 0, 0, 255, 0, 0, 0, 0, 255],
    triangles: [0, 1, 2],
    matrix: [1, 0, 0, 1, 0, 0],
    bbox: null,
    background: null,
  };
  const grid: Grid = { x0: 0, y0: 0, w: 8, h: 8, s: 1 };

  /** The paint at sample (cx, cy) of the grid (4 a pixel). */
  function sampleAt(maybe: Paint | null, cx: number, cy: number): number[] | null {
    expect(maybe).not.toBeNull();
    const paint = maybe!;
    paint.row?.(cy >> 2);
    const out = [0, 0, 0, 0];
    return paint.at(cx, cy, (cx + 0.5) / 4, (cy + 0.5) / 4, out) ? out : null;
  }

  it('is linear between the corners of a triangle (Gouraud), and paints nothing outside', () => {
    const paint = meshPaint(mesh, grid, false);
    // Sample (1, 1): (0.375, 0.375) pt: red 0.375 / 8, blue the same.
    expect(sampleAt(paint, 1, 1)).toEqual([Math.round((255 * 0.375) / 8), 0, Math.round((255 * 0.375) / 8), 255]);
    // Sample (15, 15): (3.875, 3.875), on the triangle's long side's near side.
    expect(sampleAt(paint, 15, 15)).toEqual([Math.round((255 * 3.875) / 8), 0, Math.round((255 * 3.875) / 8), 255]);
    expect(sampleAt(paint, 20, 20)).toBeNull();
  });

  it('a later triangle paints over an earlier one; a background fills where none paints', () => {
    // The same triangle twice, the second all green: the second paints over the first.
    const twice: ShadingMesh = { ...mesh, xy: [...mesh.xy, ...mesh.xy], rgb: [...mesh.rgb, 0, 255, 0, 0, 255, 0, 0, 255, 0] };
    expect(sampleAt(meshPaint({ ...twice, triangles: [0, 1, 2, 3, 4, 5] }, grid, false), 1, 1)).toEqual([0, 255, 0, 255]);
    expect(sampleAt(meshPaint({ ...twice, triangles: [3, 4, 5, 0, 1, 2] }, grid, false), 1, 1)).toEqual([12, 0, 12, 255]);
    const withBackground = meshPaint({ ...mesh, background: [9, 9, 9] }, grid, true);
    expect(sampleAt(withBackground, 30, 30)).toEqual([9, 9, 9, 255]);
    expect(sampleAt(meshPaint({ ...mesh, background: [9, 9, 9] }, grid, false), 30, 30)).toBeNull();
  });

  it('is clipped to its /BBox, carried by its matrix', () => {
    const paint = meshPaint({ ...mesh, bbox: [0, 0, 2, 8] }, grid, false);
    expect(sampleAt(paint, 1, 1)).not.toBeNull();
    expect(sampleAt(paint, 9, 1)).toBeNull(); // x 2.375 is past the box
  });
});

describe('hostile meshes (fix round 1, I1): the work of a mesh is bounded', () => {
  it('300,000 thin triangles the full height of a slide are not painted: past MESH_WORK_PX, found in linear time', () => {
    expect(MESH_WORK_PX).toBe(16_000_000);
    const n = 300_000;
    const xy: number[] = [];
    const triangles: number[] = [];
    for (let t = 0; t < n; t++) {
      const x = (t % 9600) / 10;
      xy.push(x, 0, x + 0.05, 0, x, 540);
      triangles.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    const mesh: ShadingMesh = { type: 4, xy, rgb: new Array(n * 9).fill(128), triangles, matrix: [1, 0, 0, 1, 0, 0], bbox: null, background: null };
    const started = performance.now();
    expect(meshPaint(mesh, { x0: 0, y0: 0, w: 1920, h: 1080, s: 2 }, false)).toBeNull();
    expect(performance.now() - started, 'a hang guard').toBeLessThan(2_000);
  });

  it("the cap is on the pixels of the triangles' boxes: at it a mesh paints, one pixel past it not", () => {
    // ten triangles, each in a 10 x 10 px box of a 100 x 100 px grid at 1 px a pt: 1,000 px of boxes
    const xy: number[] = [];
    const triangles: number[] = [];
    for (let t = 0; t < 10; t++) {
      xy.push(t * 10, 0, t * 10 + 10, 0, t * 10, 10);
      triangles.push(t * 3, t * 3 + 1, t * 3 + 2);
    }
    const mesh: ShadingMesh = { type: 4, xy, rgb: new Array(90).fill(200), triangles, matrix: [1, 0, 0, 1, 0, 0], bbox: null, background: null };
    const grid: Grid = { x0: 0, y0: 0, w: 100, h: 100, s: 1 };
    expect(meshPaint(mesh, grid, false, 1_000)).not.toBeNull();
    expect(meshPaint(mesh, grid, false, 999)).toBeNull();
    // what lies off the grid costs nothing
    expect(meshPaint({ ...mesh, matrix: [1, 0, 0, 1, 500, 500] }, grid, false, 0)).not.toBeNull();
  });
});

describe('NaN budgets (M6)', () => {
  it('a mesh with a NaN work budget is not painted', () => {
    const mesh: ShadingMesh = { type: 4, xy: [0, 0, 8, 0, 0, 8], rgb: [255, 0, 0, 0, 255, 0, 0, 0, 255], triangles: [0, 1, 2], matrix: [1, 0, 0, 1, 0, 0], bbox: null, background: null };
    expect(meshPaint(mesh, { x0: 0, y0: 0, w: 16, h: 16, s: 2 }, false, Number.NaN)).toBeNull();
  });
});
