import { jpegStreams, rawPageIndex, type RawPageKey } from '../engine/fonts';
import type { RawPdf, Ref } from '../engine/rawpdf';
import type { ImagePixels } from '../extract/walker';
import { sha256Hex } from './canonical';
import { encodePng } from './png';
import type { MediaInfo, Rgb } from './types';

/** What `MediaStore.addImage` takes: the pixels pdf.js decoded and, for an image mask, the colour it paints with. */
export type ImageInput = ImagePixels & { fill?: Rgb };

/**
 * The pictures of a deck (Task 10), each stored once under the SHA-256 of its bytes, lower-case hex: what `SceneDeck.media`
 * and `SceneBundle.media` hold. A JPEG passes through byte for byte when the raw reader has it as a plain stream (spec
 * §4.2, `jpegStreams`); every other picture is a lossless PNG of pdf.js' decoded pixels (`encodePng`).
 *
 * `raw` is null when the raw reader cannot read the file (an encrypted PDF): then nothing passes through and every picture
 * is a PNG (ruling M2-R6). Add the pictures one at a time, in paint order (`buildSlide` does), and the entries are in
 * first-use order.
 */
export class MediaStore {
  private readonly info = new Map<string, MediaInfo>();
  private readonly bytes = new Map<string, Uint8Array>();
  /**
   * What a source array became, by variant (its format, size and colour): pdf.js hands a picture painted twice over as
   * one object, and the raw reader a JPEG as one array per page, so neither is encoded or hashed twice.
   */
  private readonly done = new WeakMap<object, Map<string, Promise<MediaInfo>>>();
  /**
   * The decoded pixels of each picture added since `takePixels` last ran, by hash (M5 Task 2): what the raster renderer
   * draws a picture from, the same pixels its PNG was made of (a JPEG that passes through too).
   */
  private pixels = new Map<string, ImageInput>();
  /** The plain JPEGs of the last page asked about (by the raw reader's index), by `refKey`: one page's worth at a time. */
  private page: { index: number; jpegs: Map<string, Uint8Array> } | null = null;

  constructor(private readonly raw: RawPdf | null) {}

  /**
   * The original bytes of the JPEG stream `ref` that `page` paints, when it may pass through: an entry of `jpegStreams`
   * that is `plain`. The page is its index (0-based) and, best, its object reference, by which the raw reader finds it
   * (`rawPageIndex`). Null otherwise, and always without a raw reader (M2-R6).
   */
  jpeg(page: RawPageKey, ref: Ref | null | undefined): Uint8Array | null {
    if (this.raw === null || ref === null || ref === undefined) return null;
    const index = rawPageIndex(this.raw, page);
    if (this.page?.index !== index) this.page = { index, jpegs: plainJpegs(this.raw, index) };
    return this.page.jpegs.get(refKey(ref)) ?? null;
  }

  /** How many pictures the store holds: a mark to `rewind` to. */
  mark(): number {
    return this.info.size;
  }

  /**
   * Forgets the pictures first stored since `mark`, as if what painted them had not been built (a fallback, a failed
   * slide), so the deck's media are those of what it keeps, in first-use order. A picture painted again is stored again.
   */
  rewind(mark: number): void {
    let n = 0;
    for (const hash of [...this.info.keys()]) {
      if (n++ < mark) continue;
      this.info.delete(hash);
      this.bytes.delete(hash);
    }
  }

  /**
   * Stores a picture and says what it became. With `jpeg`, the JPEG as it is (`passthrough`); without, a PNG of the pixels:
   * gray for `gray1`, RGB, RGBA, and for an image mask RGBA in its `fill` colour, opaque where it paints. `widthPx` and
   * `heightPx` are the decoded size, `image.width` and `image.height`. Rejects with a TypeError a mask without a fill, a
   * fill on anything else, and a mask with a JPEG.
   */
  async addImage(image: ImageInput, jpeg: Uint8Array | null): Promise<MediaInfo> {
    if ((image.format === 'mask') !== (image.fill !== undefined)) {
      throw new TypeError(`MediaStore.addImage: a ${image.format} image ${image.fill === undefined ? 'without' : 'with'} a fill colour`);
    }
    if (jpeg !== null && image.format === 'mask') throw new TypeError('MediaStore.addImage: an image mask cannot pass through as a JPEG');
    const source = jpeg ?? image.data;
    const variant = `${jpeg === null ? image.format : 'jpeg'} ${image.width}x${image.height} ${image.fill?.join(',') ?? ''}`;
    let variants = this.done.get(source);
    if (variants === undefined) this.done.set(source, (variants = new Map()));
    let stored = variants.get(variant);
    // What a rewind forgot is stored again.
    if (stored !== undefined && !this.info.has((await stored).hash)) stored = undefined;
    if (stored === undefined) {
      stored = this.store(image, jpeg);
      variants.set(variant, stored);
    }
    const info = await stored;
    this.pixels.set(info.hash, image);
    return { ...info };
  }

  /**
   * The decoded pixels of the pictures added since the last call, by hash, handed over: the store forgets them (M5 Task 2,
   * `ScenePage.pixels`). They hold pdf.js' arrays, so `scenePages` keeps them only for a slide the raster renderer may draw.
   */
  takePixels(): Map<string, ImageInput> {
    const pixels = this.pixels;
    this.pixels = new Map();
    return pixels;
  }

  /** Every picture's `MediaInfo`, keyed by its hash: `SceneDeck.media`. */
  infos(): Record<string, MediaInfo> {
    return Object.fromEntries([...this.info].map(([hash, info]) => [hash, { ...info }]));
  }

  /** Every picture's bytes, keyed by their hash, in first-use order: `SceneBundle.media`. The arrays are the store's own. */
  files(): Map<string, Uint8Array> {
    return new Map(this.bytes);
  }

  /**
   * The bytes of the pictures stored since the last call (since the store was made, the first time), keyed by their hash
   * in first-use order, handed over: the store forgets them and keeps only their `MediaInfo`, so a picture painted again
   * is not stored again. What streams a deck slide by slide takes each slide's new pictures this way (`scenePages`).
   */
  takeFiles(): Map<string, Uint8Array> {
    const files = new Map(this.bytes);
    this.bytes.clear();
    return files;
  }

  private async store(image: ImageInput, jpeg: Uint8Array | null): Promise<MediaInfo> {
    const bytes = jpeg === null ? pngOf(image) : jpeg.slice();
    const hash = await sha256Hex(bytes);
    let info = this.info.get(hash);
    if (info === undefined) {
      info = {
        hash,
        mime: jpeg === null ? 'image/png' : 'image/jpeg',
        widthPx: image.width,
        heightPx: image.height,
        byteLength: bytes.length,
        passthrough: jpeg !== null,
      };
      this.info.set(hash, info);
      this.bytes.set(hash, bytes);
    }
    return info;
  }
}

/** A Ref as a map key. */
function refKey(ref: Ref): string {
  return `${ref.num} ${ref.gen}`;
}

/**
 * The page's JPEG streams that may pass through. A page the raw reader cannot read, or does not have where pdf.js does,
 * has none: its pictures are PNG, which is never wrong.
 */
function plainJpegs(raw: RawPdf, pageIndex: number): Map<string, Uint8Array> {
  try {
    return new Map(jpegStreams(raw, pageIndex).flatMap((j) => (j.plain ? [[refKey(j.ref), j.bytes] as const] : [])));
  } catch {
    return new Map();
  }
}

/** The PNG of decoded pixels: gray, RGB or RGBA, as the format says; a mask in its colour. */
function pngOf(image: ImageInput): Uint8Array<ArrayBuffer> {
  const { width, height } = image;
  const rowBytes = (width + 7) >> 3;
  switch (image.format) {
    case 'rgb':
      return encodePng(exactly(image.data, width * height * 3), width, height, 3);
    case 'rgba':
      return encodePng(exactly(image.data, width * height * 4), width, height, 4);
    case 'gray1': {
      const bits = exactly(image.data, rowBytes * height);
      const gray = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) gray[y * width + x] = bits[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7)) ? 255 : 0;
      }
      return encodePng(gray, width, height, 1);
    }
    case 'mask': {
      const bits = exactly(image.data, rowBytes * height);
      const [r, g, b] = image.fill!;
      const rgba = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4;
          rgba[i] = r;
          rgba[i + 1] = g;
          rgba[i + 2] = b;
          rgba[i + 3] = bits[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7)) ? 0 : 255; // a 0 bit paints
        }
      }
      return encodePng(rgba, width, height, 4);
    }
  }
}

/**
 * `data` as exactly `length` bytes: a view of its first `length`, or, when pdf.js gave fewer (a damaged stream), a copy
 * padded with zeros, as pdf.js' canvas reads the missing bytes: black, and for a mask, painted.
 */
function exactly(data: Uint8Array | Uint8ClampedArray, length: number): Uint8Array {
  if (data.length >= length) return new Uint8Array(data.buffer, data.byteOffset, length);
  const out = new Uint8Array(length);
  out.set(data);
  return out;
}
