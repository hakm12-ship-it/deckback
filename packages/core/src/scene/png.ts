import { unzlibSync, zlibSync } from 'fflate';

/**
 * A PNG writer for the pictures that do not pass through as the original JPEG (Task 10): lossless, 8 bits a channel,
 * gray, RGB or RGBA (not premultiplied), no interlacing. The file is the signature, IHDR, one IDAT and IEND: no time, no
 * text, no colour chunk. The same pixels give the same bytes on every run and in every engine (Global Constraints,
 * Determinism): the filter of each row is chosen by integer arithmetic alone, and the zlib settings are fixed.
 */

/** PNG colour types by channels: gray, truecolour, truecolour with alpha. */
const COLOUR_TYPE = { 1: 0, 3: 2, 4: 6 } as const;

/**
 * fflate's deflate at a fixed level and memory level. Without `mem`, fflate picks the memory level from the input's
 * length through `Math.log`, which engines need not compute alike.
 */
const ZLIB = { level: 6, mem: 8 } as const;

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

/**
 * `data` is `height` rows of `width` pixels of `channels` bytes each, top to bottom, with no padding. Throws a RangeError
 * when the size is not a positive whole number of pixels or `data` does not have exactly that many bytes.
 */
export function encodePng(data: Uint8Array, width: number, height: number, channels: 1 | 3 | 4): Uint8Array<ArrayBuffer> {
  if (!isDimension(width) || !isDimension(height) || COLOUR_TYPE[channels] === undefined) {
    throw new RangeError(`encodePng: a ${width} x ${height} image of ${channels} channels`);
  }
  if (data.length !== width * height * channels) {
    throw new RangeError(`encodePng: ${data.length} bytes for ${width} x ${height} x ${channels}`);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, COLOUR_TYPE[channels], 0, 0, 0], 8); // bit depth, colour type, deflate, adaptive filtering, no interlace
  const parts = [SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlibSync(filtered(data, width * channels, height, channels), ZLIB)), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return png;
}

/** PNG holds sizes in 31 bits. */
function isDimension(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 0x7fffffff;
}

/**
 * The rows, each behind the filter that suits it best: the one whose output, read as signed bytes, has the least sum of
 * absolute values (the heuristic of the PNG specification, 12.8), the lowest filter type on a tie.
 */
function filtered(data: Uint8Array, stride: number, height: number, bpp: number): Uint8Array {
  const out = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const none = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = data.subarray(y * stride, (y + 1) * stride);
    const up = y > 0 ? data.subarray((y - 1) * stride, y * stride) : none;
    let best = 0;
    let bestSum = Infinity;
    for (let type = 0; type < 5; type++) {
      const dst = trial[type]!;
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const x = row[i]!;
        const a = i >= bpp ? row[i - bpp]! : 0;
        const b = up[i]!;
        const c = i >= bpp ? up[i - bpp]! : 0;
        const v = (x - predict(type, a, b, c)) & 0xff;
        dst[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        best = type;
        bestSum = sum;
      }
    }
    out[y * (stride + 1)] = best;
    out.set(trial[best]!, y * (stride + 1) + 1);
  }
  return out;
}

/** What the filter of `type` predicts from the byte to the left (a), above (b) and above left (c). */
function predict(type: number, a: number, b: number, c: number): number {
  switch (type) {
    case 0:
      return 0;
    case 1:
      return a;
    case 2:
      return b;
    case 3:
      return (a + b) >> 1;
    default: {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
  }
}

/** Length, type, data and the CRC of type and data. */
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

let crcTable: Uint32Array | null = null;

/** CRC-32 as PNG and zlib compute it (ISO 3309, the reflected polynomial 0xEDB88320). */
function crc32(bytes: Uint8Array): number {
  const table = (crcTable ??= Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The pixels of a PNG as `encodePng` writes them (8-bit gray, RGB or RGBA, no interlacing, any of the five row filters),
 * rows top to bottom (M5-R10: a tile's cell picture, matched against PowerPoint's preset patterns). Null for anything
 * else, a side past `maxSide` (read from IHDR before anything is inflated), or a file that does not hold what it says.
 * CRCs are not checked: the bytes are the converter's own media.
 */
export function readPng(png: Uint8Array, maxSide: number): { width: number; height: number; channels: 1 | 3 | 4; data: Uint8Array } | null {
  if (png.length < 33 || !SIGNATURE.every((b, i) => png[i] === b)) return null;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(png[12]!, png[13]!, png[14]!, png[15]!) !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const [depth, colourType, compression, filter, interlace] = [png[24], png[25], png[26], png[27], png[28]];
  const channels = colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 6 ? 4 : null;
  if (channels === null || depth !== 8 || compression !== 0 || filter !== 0 || interlace !== 0) return null;
  if (width < 1 || height < 1 || width > maxSide || height > maxSide) return null;
  const parts: Uint8Array[] = [];
  for (let pos = 33; pos + 12 <= png.length; ) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(png[pos + 4]!, png[pos + 5]!, png[pos + 6]!, png[pos + 7]!);
    if (pos + 12 + length > png.length) return null;
    if (type === 'IDAT') parts.push(png.subarray(pos + 8, pos + 8 + length));
    if (type === 'IEND') break;
    pos += 12 + length;
  }
  const stride = width * channels;
  let raw: Uint8Array;
  try {
    const joined = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
      joined.set(part, at);
      at += part.length;
    }
    raw = unzlibSync(joined);
  } catch {
    return null;
  }
  if (raw.length !== height * (stride + 1)) return null;
  const data = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]!;
    if (type > 4) return null;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? data[y * stride + i - channels]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const c = y > 0 && i >= channels ? data[(y - 1) * stride + i - channels]! : 0;
      data[y * stride + i] = (raw[y * (stride + 1) + 1 + i]! + predict(type, a, b, c)) & 0xff;
    }
  }
  return { width, height, channels, data };
}
