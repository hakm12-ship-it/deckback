import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convert, FallbackError } from '../src/convert';
import { decodePng } from './helpers/png';
import { framesOf, partsOf, treeOf } from './helpers/pptx';
import { syntheticPdf } from './helpers/synthetic';

/**
 * `convert()` and the raster fallbacks (M5 Task 2): the picture goes into the zip and the slide in the element's place,
 * the report lists it with its reason and its raster, a soft-masked picture is drawn from the page's decoded pixels,
 * and strict mode refuses any fallback.
 */

/** The PNG media of a PPTX, by part name. */
const pngsOf = (pptx: Uint8Array): Record<string, Uint8Array> =>
  Object.fromEntries(Object.entries(unzipSync(pptx)).filter(([name]) => name.startsWith('ppt/media/') && name.endsWith('.png')));

/** A blue page, a yellow Multiply square on it, text over the square: /GS9 sets Multiply, /GS11 Normal again. */
const MULTIPLY_UNDER_TEXT = '0 0 1 rg 0 0 300 300 re f q /GS9 gs 1 1 0 rg 50 150 100 100 re f Q BT /F1 12 Tf 60 190 Td (ABC) Tj ET';

describe('convert(): raster fallbacks', () => {
  it('Review Focus 1: the Multiply square is one picture between the page and the text box; the text stays text', async () => {
    const { pptx, report } = await convert(syntheticPdf(MULTIPLY_UNDER_TEXT));
    const tree = treeOf(partsOf(pptx), 1);
    expect(framesOf(tree).map((f) => f.name)).toEqual(['pdf:p1:z5 fallback', 'pdf:p1:z11 text']);
    expect(tree.match(/<p:pic>/g)).toHaveLength(1);
    expect(report.slides[0]!.fallbacks).toEqual([{ id: 'p1:z5', reason: 'blend-mode', raster: { w: 200, h: 200, pxPerPt: 2 } }]);
    expect(report.totals.fallbacks).toBe(1);
    expect(report.totals.approximations['blend-dropped']).toBe(0);
    // Multiply of yellow over blue: black, opaque, everywhere it covers
    const pngs = Object.values(pngsOf(pptx));
    expect(pngs).toHaveLength(1);
    const png = decodePng(pngs[0]!);
    expect([png.width, png.height]).toEqual([200, 200]);
    expect(Array.from(png.data.subarray(0, 4))).toEqual([0, 0, 0, 255]);
  });

  it('the same PDF twice gives the same PPTX bytes (Review Focus 2, in Node)', async () => {
    const [a, b] = [await convert(syntheticPdf(MULTIPLY_UNDER_TEXT)), await convert(syntheticPdf(MULTIPLY_UNDER_TEXT))];
    expect(Buffer.from(a.pptx).equals(Buffer.from(b.pptx))).toBe(true);
  });

  it("a picture under a luminosity soft mask is drawn from the page's decoded pixels", async () => {
    // /GS2: a luminosity soft mask; /Im2: 3 x 5 RGB
    const { pptx, report } = await convert(syntheticPdf('q /GS2 gs q 150 0 0 150 50 50 cm /Im2 Do Q Q'));
    expect(report.slides[0]!.fallbacks).toEqual([{ id: 'p1:z12', reason: 'soft-mask', raster: { w: 300, h: 300, pxPerPt: 2 } }]);
    expect(report.slides[0]!.notes.filter((n) => n.op === 'raster')).toEqual([]);
    const png = decodePng(Object.values(pngsOf(pptx))[0]!);
    expect(png.data.some((v, i) => i % 4 === 3 && v > 0)).toBe(true);
  });

  it('strict mode throws FallbackError when a fallback would be written, and writes nothing', async () => {
    await expect(convert(syntheticPdf(MULTIPLY_UNDER_TEXT), { strict: true })).rejects.toThrow(FallbackError);
    await expect(convert(syntheticPdf('0 0 1 rg 0 0 300 300 re f'), { strict: true })).resolves.toBeDefined();
  });

  it('strict mode also refuses an effect the raster renderer could not draw (fix round 1): a blend mode on a tile fill', async () => {
    // /P3 is a tiling pattern, which the raster renderer does not draw: no raster is tried (final review I3), and lenient
    // mode leaves the shape to the passes and lowering as before M5, its blend mode dropped and recorded
    const content = 'q /GS9 gs /Pattern cs /P3 scn 50 50 100 100 re f Q';
    const { report } = await convert(syntheticPdf(content));
    expect(report.totals.fallbacks).toBe(0);
    expect(report.slides[0]!.notes.filter((n) => n.op === 'raster')).toEqual([]);
    expect(report.totals.approximations['blend-dropped']).toBe(1);
    await expect(convert(syntheticPdf(content), { strict: true })).rejects.toThrow(FallbackError);
  });
});
