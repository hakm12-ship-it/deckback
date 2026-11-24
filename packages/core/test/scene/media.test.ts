import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { closeDocument, IMAGE_KIND, loadPage, openDocument, OPS, releasePage, type PageData } from '../../src/engine/pdfjs-adapter';
import { openRawPdf } from '../../src/engine/rawpdf';
import { compareInventories, toInventory, type Paint } from '../../src/extract/inventory';
import { pageFrame, walkPage, type ImagePixels, type RawOp } from '../../src/extract/walker';
import { buildSlide, pictureXfrm, SKEW_SINE, type BuildContext } from '../../src/scene/build';
import { FontTable } from '../../src/scene/fonts';
import { inventoryOfSlide } from '../../src/scene/inventory';
import { MediaStore } from '../../src/scene/media';
import { encodePng } from '../../src/scene/png';
import type { FallbackEl, PictureEl, SceneSlide } from '../../src/scene/types';
import { buildPdf, type MiniObject } from '../helpers/minipdf';
import { decodePng } from '../helpers/png';
import { syntheticPdf } from '../helpers/synthetic';

/**
 * Pictures and media (Task 10): PNG bytes, the media store, the picture's frame, and `buildSlide` on image RawOps. The
 * images are synthetic or made here; no image from a deck is in this file (Global Constraints, Fonts and media).
 */

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Deterministic pseudo-random bytes (a fixed LCG), for pixels that are not all alike. */
function noise(length: number, seed = 1): Uint8Array {
  let s = seed >>> 0;
  return Uint8Array.from({ length }, () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s >>> 24;
  });
}

/** A photo-like image: smooth gradients with a little noise, so that every PNG filter has a row it suits best. */
function photo(width: number, height: number, channels: 1 | 3 | 4): Uint8Array {
  const n = noise(width * height * channels, 7);
  return Uint8Array.from({ length: width * height * channels }, (_, i) => {
    const p = Math.floor(i / channels);
    const [x, y, c] = [p % width, Math.floor(p / width), i % channels];
    const smooth = y < height / 4 ? x * 2 : y < height / 2 ? y * 3 : (x + y + c * 40) & 255;
    return (smooth + (y % 3 === 0 ? n[i]! >> 4 : 0)) & 255;
  });
}

/**
 * Seven rows of `width` pixels, made so that each PNG filter is the best for one of them: 0 noise, 1 the same again (Up:
 * all zeros), 2 zeros (None, which wins the tie with Sub), 3 a ramp (Sub, which wins the tie with Paeth), 4 each byte the
 * mean of its left and upper neighbours (Average: all zeros), 5 stripes 4 pixels wide, 6 the stripes 10 lighter: below
 * the step Up is off by 10 everywhere, Sub by 60 at each stripe's edge, and Paeth, which takes the upper neighbour at an
 * edge and the left one elsewhere, only by 10 at the edges (Paeth). The first two pixels of rows 5 and 6 are 10, 30 over
 * 0, 30: at the second, the upper and the upper-left neighbour are equally near Paeth's estimate, a tie it breaks for
 * the upper one.
 */
function everyFilter(width: number, channels: number): Uint8Array {
  const stride = width * channels;
  const rows: Uint8Array[] = Array.from({ length: 7 }, () => new Uint8Array(stride));
  rows[0] = noise(stride, 11);
  rows[1] = Uint8Array.from(rows[0]!);
  rows[3] = Uint8Array.from({ length: stride }, (_, i) => (i * 7 + 3) & 255);
  for (let i = 0; i < stride; i++) rows[4]![i] = ((i >= channels ? rows[4]![i - channels]! : 0) + rows[3]![i]!) >> 1;
  rows[5] = Uint8Array.from({ length: stride }, (_, i) => (Math.floor(i / channels) % 8 < 4 ? 0 : 60) + (i % channels) * 20);
  rows[6] = rows[5].map((v) => v + 10);
  for (let c = 0; c < channels; c++) {
    [rows[5][c], rows[5][channels + c], rows[6]![c], rows[6]![channels + c]] = [10 + c * 20, 30 + c * 20, c * 20, 30 + c * 20];
  }
  const out = new Uint8Array(7 * stride);
  rows.forEach((row, y) => out.set(row, y * stride));
  return out;
}

describe('encodePng', () => {
  it('encodePng round-trips through fflate and Pillow-free decoding', () => {
    for (const channels of [1, 3, 4] as const) {
      for (const [width, height] of [
        [1, 1],
        [3, 5],
        [64, 48],
      ] as const) {
        const data = photo(width, height, channels);
        const png = encodePng(data, width, height, channels);
        const decoded = decodePng(png);
        expect([decoded.width, decoded.height, decoded.channels]).toEqual([width, height, channels]);
        expect(decoded.data).toEqual(data);
        // Only the three chunks a PNG needs: no time, no text, no colour profile.
        expect(decoded.chunks).toEqual(['IHDR', 'IDAT', 'IEND']);
      }
    }
    // Rows made for each filter: the round trip checks the arithmetic of every one of them, in every layout.
    for (const channels of [1, 3, 4] as const) {
      const data = everyFilter(24, channels);
      const decoded = decodePng(encodePng(data, 24, 7, channels));
      expect(decoded.data).toEqual(data);
      // Rows 0 and 5 are noise, whatever suits them; then Up, None, Sub, Average, Paeth.
      expect([1, 2, 3, 4, 6].map((y) => decoded.filters[y])).toEqual([2, 0, 1, 3, 4]);
    }
  });

  it('the same pixels give the same bytes twice', () => {
    const data = photo(40, 30, 4);
    const first = encodePng(data, 40, 30, 4);
    expect(encodePng(data, 40, 30, 4)).toEqual(first);
    expect(encodePng(Uint8Array.from(data), 40, 30, 4)).toEqual(first); // another array with the same pixels
    // Pinned: the zlib level, memory level and filter choice are fixed, so these bytes may only change on purpose (a
    // change here changes every media hash, and so the PPTX files the CLI and the website write).
    expect(sha256(encodePng(photo(16, 16, 3), 16, 16, 3))).toBe(PINNED_PNG_SHA256);
  });

  it('refuses a size the data does not have', () => {
    expect(() => encodePng(new Uint8Array(11), 2, 2, 3)).toThrow(RangeError);
    expect(() => encodePng(new Uint8Array(0), 0, 1, 1)).toThrow(RangeError);
    expect(() => encodePng(new Uint8Array(3), 1.5, 2, 1)).toThrow(RangeError);
  });
});

/** The SHA-256 of `encodePng(photo(16, 16, 3), 16, 16, 3)`, taken when the encoder was written (fflate 0.8.3). */
const PINNED_PNG_SHA256 = '5bb9e2a19df655bcbc000f35be09488ee6b6203bef390e501d8ae55f8ede427a';

describe('MediaStore', () => {
  const rgb = (fill = 0): ImagePixels => ({ width: 2, height: 2, format: 'rgb', data: Uint8Array.from({ length: 12 }, (_, i) => (i * 20 + fill) & 255) });

  it('identical images share one media entry', async () => {
    const media = new MediaStore(null);
    const a = await media.addImage(rgb(), null);
    const again = await media.addImage(rgb(), null); // a new array with the same pixels
    expect(again).toEqual(a);
    expect(a).toEqual({ hash: a.hash, mime: 'image/png', widthPx: 2, heightPx: 2, byteLength: media.files().get(a.hash)!.length, passthrough: false });
    expect(a.hash).toBe(sha256(media.files().get(a.hash)!)); // keyed by the SHA-256 of the bytes stored

    const other = await media.addImage(rgb(1), null);
    expect(other.hash).not.toBe(a.hash);

    // A stencil is its mask in its colour: the same mask in another colour is another picture.
    const mask: ImagePixels = { width: 8, height: 1, format: 'mask', data: Uint8Array.of(0x0f) };
    const red = await media.addImage({ ...mask, fill: [255, 0, 0] }, null);
    expect(await media.addImage({ ...mask, data: Uint8Array.of(0x0f), fill: [255, 0, 0] }, null)).toEqual(red);
    const blue = await media.addImage({ ...mask, fill: [0, 0, 255] }, null);
    expect(blue.hash).not.toBe(red.hash);

    // A JPEG is stored as it is, once.
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 0xff, 0xd9);
    const j1 = await media.addImage(rgb(), jpeg);
    const j2 = await media.addImage(rgb(), Uint8Array.from(jpeg));
    expect(j2).toEqual(j1);
    expect(j1).toEqual({ hash: sha256(jpeg), mime: 'image/jpeg', widthPx: 2, heightPx: 2, byteLength: 8, passthrough: true });
    expect(media.files().get(j1.hash)).toEqual(jpeg);

    expect(Object.keys(media.infos()).sort()).toEqual([a.hash, other.hash, red.hash, blue.hash, j1.hash].sort());
    expect(media.files().size).toBe(5);
    for (const [hash, info] of Object.entries(media.infos())) expect(info.hash).toBe(hash);
  });

  it('takeFiles hands the bytes stored since the last call over once, in first-use order, and keeps the infos', async () => {
    const media = new MediaStore(null);
    const a = await media.addImage(rgb(), null);
    const b = await media.addImage(rgb(1), null);
    const first = media.takeFiles();
    expect([...first.keys()]).toEqual([a.hash, b.hash]);
    expect(sha256(first.get(a.hash)!)).toBe(a.hash);
    expect(media.takeFiles().size).toBe(0);
    // painted again: known, not stored again; a new picture is the next take's
    expect(await media.addImage(rgb(), null)).toEqual(a);
    const mark = media.mark();
    const c = await media.addImage(rgb(2), null);
    const d = await media.addImage(rgb(3), null);
    media.rewind(mark + 1); // what painted d was not built
    expect([...media.takeFiles().keys()]).toEqual([c.hash]);
    expect(Object.keys(media.infos())).toEqual([a.hash, b.hash, c.hash]);
    expect(d.hash).not.toBe(c.hash);
  });

  it('writes gray, RGB, RGBA and a stencil as PNG of that kind, the stencil in its colour', async () => {
    const media = new MediaStore(null);
    const png = async (image: Parameters<MediaStore['addImage']>[0]) => {
      const { hash } = await media.addImage(image, null);
      return decodePng(media.files().get(hash)!);
    };

    // 1 bit a pixel, rows padded to a byte, 1 white: 10 x 2.
    const gray = await png({ width: 10, height: 2, format: 'gray1', data: Uint8Array.of(0b10110000, 0b01000000, 0xff, 0xc0) });
    expect([gray.channels, ...gray.data]).toEqual([1, 255, 0, 255, 255, 0, 0, 0, 0, 0, 255, ...Array<number>(10).fill(255)]);

    const rgba = Uint8Array.from({ length: 16 }, (_, i) => i * 16);
    expect(await png({ width: 2, height: 2, format: 'rgba', data: rgba })).toMatchObject({ channels: 4, data: rgba });
    const clamped = new Uint8ClampedArray([1, 2, 3, 4, 5, 6]); // pdf.js gives decoded JPEGs as Uint8ClampedArray
    expect(await png({ width: 2, height: 1, format: 'rgb', data: clamped })).toMatchObject({ channels: 3, data: Uint8Array.from(clamped) });

    // An image mask paints where its bit is 0 (pdf.js has applied /Decode): there the PNG is opaque in the fill colour.
    const stencil = await png({ width: 3, height: 2, format: 'mask', data: Uint8Array.of(0b01000000, 0b10100000), fill: [10, 20, 30] });
    expect(stencil.channels).toBe(4);
    expect(Array.from(stencil.data)).toEqual([10, 20, 30, 255, 10, 20, 30, 0, 10, 20, 30, 255, 10, 20, 30, 0, 10, 20, 30, 255, 10, 20, 30, 0]);
  });

  it('pads pixels pdf.js gave short with zeros, and refuses a stencil without its colour or passed through', async () => {
    const media = new MediaStore(null);
    const info = await media.addImage({ width: 2, height: 2, format: 'rgb', data: Uint8Array.of(9, 9, 9) }, null);
    expect(Array.from(decodePng(media.files().get(info.hash)!).data)).toEqual([9, 9, 9, ...Array<number>(9).fill(0)]);
    const mask: ImagePixels = { width: 1, height: 1, format: 'mask', data: Uint8Array.of(0) };
    await expect(media.addImage(mask, null)).rejects.toThrow(TypeError);
    await expect(media.addImage({ ...mask, fill: [0, 0, 0] }, Uint8Array.of(0xff, 0xd8))).rejects.toThrow(TypeError);
  });

  it('passes a JPEG through only when the raw reader has it as a plain stream (M2-R6: never without a raw reader)', () => {
    const fakeJpeg = jpegOf();
    const raw = openRawPdf(
      buildPdf([
        ...HEAD,
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R /Im2 5 0 R >> >> >>' },
        { num: 4, dict: '/Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: fakeJpeg },
        { num: 5, dict: '/Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /DCTDecode', data: fakeJpeg },
      ]),
    );
    const media = new MediaStore(raw);
    expect(media.jpeg(0, { num: 4, gen: 0 })).toEqual(fakeJpeg);
    expect(media.jpeg(0, { num: 5, gen: 0 })).toBeNull(); // not plain: CMYK
    expect(media.jpeg(0, { num: 4, gen: 1 })).toBeNull();
    expect(media.jpeg(0, null)).toBeNull();
    expect(media.jpeg(7, { num: 4, gen: 0 })).toBeNull(); // no such page: a picture is still a PNG
    expect(new MediaStore(null).jpeg(0, { num: 4, gen: 0 })).toBeNull();
  });

  /** Whether the raw reader passes `jpeg` through as a DeviceRGB image of page 1. */
  const passes = (jpeg: Uint8Array): boolean => {
    const raw = openRawPdf(
      buildPdf([
        ...HEAD,
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> >>' },
        { num: 4, dict: '/Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: jpeg },
      ]),
    );
    return new MediaStore(raw).jpeg(0, { num: 4, gen: 0 }) !== null;
  };

  it('a baseline or progressive 8-bit JPEG (SOF0, SOF2) is passed through (M2 final review F10)', () => {
    expect(passes(jpegOf(0xc0))).toBe(true);
    expect(passes(jpegOf(0xc2))).toBe(true);
  });

  it('a 12-bit JPEG (SOF1, precision 12) is not passed through', () => {
    // PowerPoint and most viewers read only 8-bit JPEGs: pdf.js decodes it, and it becomes a PNG.
    expect(passes(jpegOf(0xc1, 12))).toBe(false);
    expect(passes(jpegOf(0xc0, 12))).toBe(false); // 12 bits in a baseline frame header: not 8 either
    expect(passes(jpegOf(0xc1, 8))).toBe(false); // extended sequential: neither SOF0 nor SOF2
  });

  it('an SOF3 lossless JPEG is not passed through', () => {
    expect(passes(jpegOf(0xc3))).toBe(false);
    expect(passes(jpegOf(0xc9))).toBe(false); // arithmetic coding
  });

  it('a JPEG whose frame header cannot be read is not passed through (ruling M3-R31)', () => {
    expect(passes(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 7, 7, 0xff, 0xd9))).toBe(false); // a marker longer than the file
    expect(passes(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBe(false); // no frame header at all
    expect(passes(jpegOf().subarray(0, 8))).toBe(false); // cut inside the frame header
    // two frame headers before the scan: not a JPEG of one frame
    const twice = jpegOf();
    expect(passes(Uint8Array.from([...twice.subarray(0, -2), ...twice.subarray(2)]))).toBe(false);
  });
});

/**
 * A JPEG's markers up to its end, as `isPlainJpeg` reads them: SOI, a frame header (`sof`, its precision, 1 x 1 pixels,
 * `components` of ids 1, 2, 3), EOI. No scan: nothing here decodes the picture.
 */
function jpegOf(sof = 0xc0, precision = 8, components = 3): Uint8Array {
  const specs = Array.from({ length: components }, (_, i) => [i + 1, 0x11, 0]).flat();
  return Uint8Array.from([0xff, 0xd8, 0xff, sof, 0, 8 + 3 * components, precision, 0, 1, 0, 1, components, ...specs, 0xff, 0xd9]);
}

const HEAD: MiniObject[] = [
  { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
  { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
];

/**
 * The PDF unit-square matrix (0002 §16: origin at the image's bottom left, y up, in the slide frame) of a picture that
 * DrawingML would write as `a:xfrm` with `off` (x, y), `ext` (w, h), `rot`, `flipH` and `flipV`: the picture is flipped in
 * its box, turned clockwise about the box's centre by `rot` degrees, and the box placed at (x, y).
 */
function matrixOf(x: number, y: number, w: number, h: number, rot: number, flipH = false, flipV = false): number[] {
  const t = (rot * Math.PI) / 180;
  const [cos, sin] = [Math.cos(t), Math.sin(t)];
  const right = [(flipH ? -w : w) * cos, (flipH ? -w : w) * sin]; // the image's top edge, left to right
  const down = [(flipV ? -h : h) * -sin, (flipV ? -h : h) * cos]; // its left edge, top to bottom
  const [cx, cy] = [x + w / 2, y + h / 2];
  // The unit square's origin is the image's bottom left corner, and its v axis runs up the image.
  return [right[0]!, right[1]!, -down[0]!, -down[1]!, cx - right[0]! / 2 + down[0]! / 2, cy - right[1]! / 2 + down[1]! / 2];
}

describe('the frame of a picture', () => {
  const xfrm = (x: number, y: number, w: number, h: number, rotDeg: number, flipH = false, flipV = false) => ({ x, y, w, h, rotDeg, flipH, flipV });

  it('a rotated and flipped matrix gives rotDeg, flipH, flipV', () => {
    const cases: [string, number[], ReturnType<typeof xfrm>][] = [
      ['upright: d < 0 (M2-R9)', [120, 0, 0, -60, 20, 100], xfrm(20, 40, 120, 60, 0)],
      ['turned 30 degrees clockwise', matrixOf(150, 125, 100, 50, 30), xfrm(150, 125, 100, 50, 30)],
      ['turned 90', matrixOf(10, 20, 100, 50, 90), xfrm(10, 20, 100, 50, 90)],
      ['turned 180', matrixOf(10, 20, 100, 50, 180), xfrm(10, 20, 100, 50, 180)],
      ['turned 270 (never negative)', matrixOf(10, 20, 100, 50, 270), xfrm(10, 20, 100, 50, 270)],
      ['turned 345', matrixOf(10, 20, 100, 50, 345), xfrm(10, 20, 100, 50, 345)],
      ['mirrored left to right', [-120, 0, 0, -60, 140, 100], xfrm(20, 40, 120, 60, 0, true)],
      ['upside down: d > 0', [120, 0, 0, 60, 20, 40], xfrm(20, 40, 120, 60, 0, false, true)],
      ['flipH, turned 30', matrixOf(150, 125, 100, 50, 30, true), xfrm(150, 125, 100, 50, 30, true)],
      ['flipV, turned 30', matrixOf(150, 125, 100, 50, 30, false, true), xfrm(150, 125, 100, 50, 30, false, true)],
      // The same picture can be written two ways (flipH and rot + 180 is flipV): the flag that keeps the turn under 90
      // degrees either way is the one, and at exactly 90 it is flipV.
      ['flipH turned 150 is flipV turned 330', matrixOf(150, 125, 100, 50, 150, true), xfrm(150, 125, 100, 50, 330, false, true)],
      ['flipV turned 90', matrixOf(10, 20, 100, 50, 90, false, true), xfrm(10, 20, 100, 50, 90, false, true)],
      ['flipH turned 90 is flipV turned 270', matrixOf(10, 20, 100, 50, 90, true), xfrm(10, 20, 100, 50, 270, false, true)],
      ['both flips are a half turn', matrixOf(10, 20, 100, 50, 0, true, true), xfrm(10, 20, 100, 50, 180)],
    ];
    for (const [name, m, expected] of cases) {
      expect(pictureXfrm(m), name).toEqual({ xfrm: expected, skewed: false });
    }
  });

  it('any box, turn and flips come back as a frame that draws the same matrix', () => {
    const r = noise(600, 3);
    for (let i = 0; i < 100; i++) {
      const [x, y, w, h] = [r[6 * i]! * 4 - 100, r[6 * i + 1]! * 3 - 50, 1 + r[6 * i + 2]! * 2, 1 + r[6 * i + 3]!];
      const rot = (r[6 * i + 4]! * 360) / 256;
      const m = matrixOf(x, y, w, h, rot, (r[6 * i + 5]! & 1) === 1, (r[6 * i + 5]! & 2) === 2);
      const { xfrm: f, skewed } = pictureXfrm(m);
      expect(skewed).toBe(false);
      expect(f.flipH && f.flipV).toBe(false);
      expect(f.rotDeg >= 0 && f.rotDeg < 360).toBe(true);
      const back = matrixOf(f.x, f.y, f.w, f.h, f.rotDeg, f.flipH, f.flipV);
      back.forEach((v, k) => expect(Math.abs(v - m[k]!), `case ${i} [${k}]`).toBeLessThan(2e-3));
    }
  });

  it('a skewed matrix sets skewed', () => {
    // The axes of the unit square (a, b) and (c, d) must be perpendicular within 0.01 degrees (as M2-R4).
    expect(pictureXfrm([100, 0, 0.0049, -50, 0, 50]).skewed).toBe(false); // atan(0.0049 / 50) = 0.0056 degrees
    expect(pictureXfrm([100, 0, -0.0049, -50, 0, 50]).skewed).toBe(false);
    expect(pictureXfrm([100, 0, 0.0101, -50, 0, 50]).skewed).toBe(true); // 0.0116 degrees
    expect(pictureXfrm([100, 0, -0.0101, -50, 0, 50]).skewed).toBe(true);
    expect(pictureXfrm([100, 0, 30, -50, 0, 50]).skewed).toBe(true);
    expect(pictureXfrm(matrixOf(10, 20, 300, 20, 33, true)).skewed).toBe(false); // turned, mirrored and stretched: not skewed
    expect(pictureXfrm([0, 0, 0, -50, 0, 50]).skewed).toBe(false); // an axis that collapsed has no angle
    // The sine of the tolerance is a literal (no Math.sin at run time, which engines may round differently).
    expect(Math.abs(SKEW_SINE - Math.sin((0.01 * Math.PI) / 180))).toBeLessThan(1e-19);
  });
});

/** The engine's copy of pdf.js' image kinds (beside `OPS`) is the library's: a moved code would misread every picture. */
it("IMAGE_KIND is pdf.js' ImageKind", async () => {
  const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
  expect(IMAGE_KIND).toEqual(lib.ImageKind);
});

/** Walks page 1 of a synthetic PDF and builds its slide with a media store of its own, before the page is released. */
async function walk(content: string, page?: string) {
  const doc = await openDocument(syntheticPdf(content, page));
  try {
    const data = await loadPage(doc, 0);
    try {
      const ops = walkPage(data);
      const media = new MediaStore(null);
      const fonts = new FontTable(null);
      const size = pageFrame(data).size;
      const slide = await buildSlide({ index: 0, sizePt: size, ops }, { media, fonts, page: data });
      return { ops, size, fnArray: [...data.ops.fnArray], slide, media, fonts };
    } finally {
      await releasePage(data);
    }
  } finally {
    await closeDocument(doc);
  }
}

const pictures = (slide: SceneSlide): PictureEl[] => slide.elements.filter((e): e is PictureEl => e.kind === 'picture');

describe('buildSlide: pictures', () => {
  it('an image is a picture: its media, its matrix as it is, its frame, its pixel size, no stencil', async () => {
    const { fnArray, slide, media } = await walk('q 120 0 0 60 20 200 cm /Im2 Do Q');
    const n = fnArray.indexOf(OPS.paintImageXObject);
    const [picture] = pictures(slide);
    const hash = picture!.mediaHash;
    expect(slide.elements).toEqual([
      {
        kind: 'picture',
        id: `p1:z${n}`,
        provenance: { opIndex: [n], mcid: null, struct: null },
        clip: [],
        clipBox: [0, 0, 300, 300],
        groups: [],
        mask: null,
        blend: 'normal',
        mediaHash: hash,
        matrix: [120, 0, 0, -60, 20, 100],
        xfrm: { x: 20, y: 40, w: 120, h: 60, rotDeg: 0, flipH: false, flipV: false },
        skewed: false,
        alpha: 1,
        stencil: null,
        px: [3, 5],
      },
    ]);
    // /Im2 is 3 x 5 RGB: the PNG holds its samples as they are.
    expect(media.infos()).toEqual({ [hash]: { hash, mime: 'image/png', widthPx: 3, heightPx: 5, byteLength: media.files().get(hash)!.length, passthrough: false } });
    expect(decodePng(media.files().get(hash)!)).toMatchObject({ width: 3, height: 5, channels: 3, data: Uint8Array.from({ length: 45 }, (_, i) => (i * 17) & 255) });
  });

  it('the same image twice is one media entry and two pictures; a gray image is RGB as pdf.js decodes it', async () => {
    const { slide, media } = await walk('q 20 0 0 20 10 10 cm /Im1 Do Q q 40 0 0 40 100 100 cm /Im1 Do Q');
    const [a, b] = pictures(slide);
    expect(a!.mediaHash).toBe(b!.mediaHash);
    expect(Object.keys(media.infos())).toEqual([a!.mediaHash]);
    // /Im1 is 2 x 2 gray, 8 bits: pdf.js gives it as RGB.
    expect(Array.from(decodePng(media.files().get(a!.mediaHash)!).data)).toEqual([16, 16, 16, 32, 32, 32, 48, 48, 48, 64, 64, 64]);
  });

  it('a stencil is an RGBA picture in the fill colour, with its alpha; one opaque pixel too', async () => {
    const { slide, media } = await walk('0.5 0 1 rg /GS1 gs q 80 0 0 80 10 10 cm /Im3 Do Q q 5 0 0 5 200 200 cm /Im4 Do Q q 5 0 0 5 220 200 cm /Im6 Do Q');
    const [im3, im4, im6] = pictures(slide);
    expect([im3!.stencil, im3!.alpha, im3!.px, im4!.px, im6!.px]).toEqual([[128, 0, 255], 0.5, [8, 8], [1, 1], [1, 1]]);
    const png = (p: PictureEl) => decodePng(media.files().get(p.mediaHash)!);
    // /Im3: the left half of the top four rows and the right half of the bottom four are not painted (bit 1).
    const alpha = Array.from({ length: 64 }, (_, i) => ((i >> 3 < 4) === ((i & 7) < 4) ? 0 : 255));
    expect(png(im3!)).toMatchObject({ width: 8, height: 8, channels: 4 });
    expect(Array.from(png(im3!).data)).toEqual(alpha.flatMap((a) => [128, 0, 255, a]));
    expect(Array.from(png(im4!).data)).toEqual([128, 0, 255, 255]); // paintSolidColorImageMask: one opaque pixel
    expect(Array.from(png(im6!).data)).toEqual([128, 0, 255, 0]); // one transparent pixel
    expect(media.infos()[im3!.mediaHash]).toMatchObject({ mime: 'image/png', widthPx: 8, heightPx: 8, passthrough: false });
  });

  it("an image whose soft mask is larger: the PNG has pdf.js' decoded size, px stays the operator's", async () => {
    const { slide, media } = await walk('q 40 0 0 40 10 10 cm /Im5 Do Q');
    const [picture] = pictures(slide);
    expect(picture!.px).toEqual([2, 2]);
    expect(media.infos()[picture!.mediaHash]).toMatchObject({ widthPx: 4, heightPx: 4 });
    expect(decodePng(media.files().get(picture!.mediaHash)!).channels).toBe(4); // RGBA: the mask is applied
  });

  it('an inline image is a picture of its decoded pixels', async () => {
    const { slide, media } = await walk('q 30 0 0 15 50 50 cm BI /W 2 /H 1 /CS /RGB /BPC 8 /F /AHx ID 102030405060> EI Q');
    const [picture] = pictures(slide);
    expect(picture!.px).toEqual([2, 1]);
    const png = decodePng(media.files().get(picture!.mediaHash)!);
    expect(png.channels).toBe(4); // pdf.js decodes an inline image to RGBA
    expect(Array.from(png.data)).toEqual([16, 32, 48, 255, 64, 80, 96, 255]);
  });

  it('a stencil filled with a pattern is a note and a fallback, with no picture', async () => {
    const { fnArray, ops, slide, media } = await walk(
      '/Pattern cs /P4 scn q 80 0 0 80 10 10 cm /Im3 Do Q /P1 scn q 5 0 0 5 200 200 cm /Im4 Do Q 10 150 30 30 re f',
    );
    const [mask, solid] = [fnArray.indexOf(OPS.paintImageMaskXObject), fnArray.indexOf(OPS.paintSolidColorImageMask)];
    expect(ops.map((op) => [op.kind, op.opIndex, op.stencil])).toEqual([
      ['pattern', mask, true],
      ['shade', solid, true],
      ['shade', fnArray.indexOf(OPS.constructPath), undefined],
    ]);
    const fallback = (opIndex: number, bbox: number[]): FallbackEl => ({
      kind: 'fallback',
      id: `p1:z${opIndex}`,
      provenance: { opIndex: [opIndex], mcid: null, struct: null },
      clip: [],
      clipBox: bbox as FallbackEl['clipBox'],
      groups: [],
      mask: null,
      blend: 'normal',
      reason: 'stencil-pattern',
      coveredOps: [opIndex],
      raster: null,
      bbox: bbox as FallbackEl['bbox'],
    });
    // The path filled with a pattern is a shape since Task 8 (fills.test.ts).
    expect(slide.elements.slice(0, 2)).toEqual([fallback(mask, [10, 210, 90, 290]), fallback(solid, [200, 95, 205, 100])]);
    expect(slide.elements[2]).toMatchObject({ kind: 'shape', fill: { kind: 'linear' } });
    expect(slide.notes).toEqual([
      { opIndex: mask, op: 'paintImageMaskXObject', detail: 'image mask filled with a pattern' },
      { opIndex: solid, op: 'paintSolidColorImageMask', detail: 'image mask filled with a pattern' },
    ]);
    expect(media.files().size).toBe(0);
  });

  it('an image pdf.js could not decode is a note and a fallback, and the slide goes on', async () => {
    const page = fakePage([[OPS.paintImageXObject, ['img_1', 2, 2]]], { img_1: null });
    const media = new MediaStore(null);
    const ops = [image({ opIndex: 0 }), image({ opIndex: 0, kind: 'fill', path: [['M', 0, 0], ['L', 1, 1]], rgb: [1, 2, 3] })];
    const slide = await buildSlide({ index: 0, sizePt: [100, 100], ops }, { media, fonts: new FontTable(null), page });
    expect(slide.elements.map((e) => [e.kind, e.id, e.kind === 'fallback' ? [e.reason, e.bbox] : null])).toEqual([
      ['fallback', 'p1:z0', ['image-unreadable', [10, 10, 30, 30]]],
      ['shape', 'p1:z0:1', null],
    ]);
    expect(slide.notes).toEqual([{ opIndex: 0, op: 'paintImageXObject', detail: 'image pdf.js could not decode' }]);
  });

  it('a plain JPEG passes through, byte for byte; without a raw reader it is a PNG (M2-R6)', async () => {
    const fakeJpeg = jpegOf();
    const raw = openRawPdf(
      buildPdf([
        ...HEAD,
        { num: 3, body: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im1 4 0 R >> >> >>' },
        { num: 4, dict: '/Subtype /Image /Width 2 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: fakeJpeg },
      ]),
    );
    const page = fakePage([[OPS.paintImageXObject, ['img_1', 2, 1]]], { img_1: { width: 2, height: 1, kind: 2, data: Uint8Array.of(1, 2, 3, 4, 5, 6) } });
    const ops = [image({ opIndex: 0, imageRef: { num: 4, gen: 0 }, px: [2, 1] })];
    for (const [reader, passthrough] of [
      [raw, true],
      [null, false],
    ] as const) {
      const media = new MediaStore(reader);
      const [picture] = pictures(await buildSlide({ index: 0, sizePt: [100, 100], ops }, { media, fonts: new FontTable(null), page }));
      const info = media.infos()[picture!.mediaHash]!;
      expect(info).toMatchObject({ mime: passthrough ? 'image/jpeg' : 'image/png', passthrough, widthPx: 2, heightPx: 1 });
      if (passthrough) {
        expect(media.files().get(info.hash)).toEqual(fakeJpeg);
        expect(info.hash).toBe(sha256(fakeJpeg));
      }
    }
  });

  it('a skewed matrix sets skewed, and matrix keeps the raw value', async () => {
    const page = fakePage([[OPS.paintImageXObject, ['img_1', 2, 1]]], { img_1: { width: 2, height: 1, kind: 2, data: new Uint8Array(6) } });
    const ctm: RawOp['ctm'] = [100.12345678, 0.00000049, 30.00049, -50, 10.0004, 60.0006];
    const context = { media: new MediaStore(null), fonts: new FontTable(null), page };
    const [picture] = pictures(await buildSlide({ index: 0, sizePt: [300, 300], ops: [image({ opIndex: 0, ctm })] }, context));
    expect(picture!.skewed).toBe(true);
    expect(picture!.matrix).toEqual([100.123457, 0, 30.00049, -50, 10, 60.001]); // M2-R13: a-d to 6 decimals, e and f to 3
  });

  it("inventoryOfSlide equals the walker's inventory for fills, strokes, pictures and glyphs", async () => {
    const content =
      '1 0 0 rg 0 0 300 20 re f q 120 0 0 60 20 200 cm /Im2 Do Q ' +
      'q 0.8660254 0.5 -0.5 0.8660254 150 150 cm 60 0 0 30 0 0 cm /Im2 Do Q ' + // turned
      'q -40 0 0 40 120 20 cm /Im1 Do Q q 40 0 0 -40 150 60 cm /Im1 Do Q ' + // mirrored, upside down
      'q 40 0 20 40 200 20 cm /Im2 Do Q ' + // skewed
      'q 50 50 100 100 re W n /GS1 gs 0 0 1 rg 80 0 0 80 60 60 cm /Im3 Do Q ' + // a stencil, clipped, at half alpha
      'q 30 0 0 30 230 230 cm /Im5 Do Q q 10 0 0 10 10 280 cm /Im4 Do Q 0 1 0 RG 5 5 m 50 50 l S ' +
      'q /GS10 gs /Fm8 Do Q q 30 0 0 15 250 100 cm BI /W 2 /H 1 /CS /G /BPC 8 /F /AHx ID 1020> EI Q';
    for (const page of [undefined, '/MediaBox [0 0 300 300] /CropBox [10 20 290 260] /Rotate 90']) {
      const { ops, size, slide, fonts } = await walk(content, page);
      const kinds: ReadonlySet<RawOp['kind']> = new Set(['fill', 'stroke', 'image', 'glyph', 'invisible']);
      const expected = toInventory([{ index: 0, size, ops: ops.filter((op) => kinds.has(op.kind)) }]);
      const actual = { pages: [inventoryOfSlide(slide, fonts.infos())] };
      const result = compareInventories(expected, actual);
      expect(result.diffs).toEqual([]);
      const images = actual.pages[0]!.paints.filter((p: Paint) => p.kind === 'image');
      expect(images).toHaveLength(9);
      expect(images.some((p) => p.stencil === true && p.rgb !== null && p.clip.join() !== [0, 0, ...size].join())).toBe(true);
      expect(images.some((p) => p.px?.join() === '4,4')).toBe(false); // /Im5: the operator's size, not its decoded one
    }
  });
});

/** A stand-in for a loaded page: the ops at their indexes and the objects pdf.js would hold; untagged. */
function fakePage(list: [number, unknown[]][], objs: Record<string, unknown>): BuildContext['page'] {
  return {
    ops: { fnArray: list.map(([fn]) => fn), argsArray: list.map(([, args]) => args) },
    obj: (id: string) => {
      if (!(id in objs)) throw new Error(`no object ${id}`);
      return objs[id];
    },
    pageRef: { num: 0, gen: 0 },
    structTree: null,
  } satisfies Pick<PageData, 'ops' | 'obj' | 'pageRef' | 'structTree'>;
}

/** An image RawOp as the walker gives one: 20 x 20 at (10, 10), upright. */
function image(over: Partial<RawOp>): RawOp {
  return {
    opIndex: 0,
    kind: 'image',
    bbox: [10, 10, 30, 30],
    rgb: null,
    alpha: 1,
    evenOdd: false,
    mcid: null,
    clip: [0, 0, 100, 100],
    blend: 'normal',
    masked: false,
    groups: [],
    ctm: [20, 0, 0, -20, 10, 30],
    px: [2, 2],
    stencil: false,
    imageRef: null,
    ...over,
  };
}
