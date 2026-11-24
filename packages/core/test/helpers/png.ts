import { crc32, inflateSync } from 'node:zlib';

/**
 * A PNG decoder for the tests, independent of the encoder under test (`src/scene/png.ts`): Node's zlib inflates and
 * checks the CRCs. It reads what `encodePng` writes, 8-bit gray, RGB and RGBA without interlacing, and refuses anything
 * else, so a test cannot pass on a PNG it did not really read.
 */
export interface DecodedPng {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  /** Rows top to bottom, no filter bytes. */
  data: Uint8Array;
  /** The chunk types in file order. */
  chunks: string[];
  /** The filter type of each row (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth). */
  filters: number[];
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const CHANNELS: Record<number, 1 | 3 | 4> = { 0: 1, 2: 3, 6: 4 };

export function decodePng(png: Uint8Array): DecodedPng {
  if (!SIGNATURE.every((b, i) => png[i] === b)) throw new Error('not a PNG signature');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: string[] = [];
  const idat: Uint8Array[] = [];
  let header: { width: number; height: number; channels: 1 | 3 | 4 } | null = null;
  let pos = 8;
  while (pos < png.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const body = png.subarray(pos + 8, pos + 8 + length);
    const crc = view.getUint32(pos + 8 + length);
    if (crc32(png.subarray(pos + 4, pos + 8 + length)) !== crc) throw new Error(`bad CRC in ${type}`);
    chunks.push(type);
    if (type === 'IHDR') {
      const [depth, colourType, compression, filter, interlace] = body.subarray(8, 13);
      const channels = CHANNELS[colourType!];
      if (depth !== 8 || channels === undefined || compression !== 0 || filter !== 0 || interlace !== 0) {
        throw new Error(`unsupported IHDR ${[depth, colourType, compression, filter, interlace].join(' ')}`);
      }
      header = { width: view.getUint32(pos + 8), height: view.getUint32(pos + 12), channels };
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    pos += 12 + length;
  }
  if (header === null || chunks[0] !== 'IHDR' || chunks.at(-1) !== 'IEND') throw new Error(`bad chunk order ${chunks.join(' ')}`);
  const { width, height, channels } = header;
  const raw = new Uint8Array(inflateSync(Buffer.concat(idat)));
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) throw new Error(`inflated ${raw.length} bytes, expected ${height * (stride + 1)}`);
  const data = new Uint8Array(height * stride);
  const filters: number[] = [];
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)]!;
    filters.push(type);
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? data[y * stride + i - channels]! : 0;
      const b = y > 0 ? data[(y - 1) * stride + i]! : 0;
      const c = i >= channels && y > 0 ? data[(y - 1) * stride + i - channels]! : 0;
      let predicted: number;
      switch (type) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = a;
          break;
        case 2:
          predicted = b;
          break;
        case 3:
          predicted = (a + b) >> 1;
          break;
        case 4: {
          const p = a + b - c;
          const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)];
          predicted = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default:
          throw new Error(`row ${y}: filter type ${type}`);
      }
      data[y * stride + i] = (row[i]! + predicted) & 0xff;
    }
  }
  return { width, height, channels, data, chunks, filters };
}
