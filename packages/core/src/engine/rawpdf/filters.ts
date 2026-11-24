import { unzlibSync } from 'fflate';
import { PdfParseError } from './lexer';
import type { PdfObj, PdfStream } from './parser';

/** Thrown by `decode` for any filter (or filter parameter) other than FlateDecode with a PNG or no predictor. */
export class UnsupportedFilterError extends Error {
  constructor(readonly filter: string) {
    super(`unsupported stream filter: ${filter}`);
    this.name = 'UnsupportedFilterError';
  }
}

const NULL: PdfObj = { k: 'null' };

function numberParam(params: Map<string, PdfObj> | undefined, key: string, fallback: number, resolve: (o: PdfObj) => PdfObj): number {
  const v = resolve(params?.get(key) ?? NULL);
  return v.k === 'num' ? v.v : fallback;
}

/** Applies a stream's /Filter chain. `resolve` dereferences indirect /Filter and /DecodeParms values. */
export function decodeStream(s: PdfStream, resolve: (o: PdfObj) => PdfObj): Uint8Array {
  const filter = resolve(s.dict.get('Filter') ?? NULL);
  const names: string[] = [];
  if (filter.k === 'name') names.push(filter.v);
  else if (filter.k === 'arr') {
    for (const f of filter.v) {
      const n = resolve(f);
      if (n.k !== 'name') throw new PdfParseError('stream /Filter array holds a non-name');
      names.push(n.v);
    }
  } else if (filter.k !== 'null') throw new PdfParseError('stream /Filter is neither a name nor an array');

  const parms = resolve(s.dict.get('DecodeParms') ?? NULL);
  const parmList: (Map<string, PdfObj> | undefined)[] = [];
  if (parms.k === 'dict') parmList.push(parms.v);
  else if (parms.k === 'arr') {
    for (const p of parms.v) {
      const d = resolve(p);
      parmList.push(d.k === 'dict' ? d.v : undefined);
    }
  }

  let data = s.raw;
  names.forEach((name, i) => {
    if (name !== 'FlateDecode') throw new UnsupportedFilterError(name);
    data = predictor(inflate(data), parmList[i], resolve);
  });
  return data;
}

function inflate(data: Uint8Array): Uint8Array {
  if (data.length === 0) return data;
  try {
    return unzlibSync(data);
  } catch (e) {
    throw new PdfParseError(`FlateDecode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function predictor(data: Uint8Array, params: Map<string, PdfObj> | undefined, resolve: (o: PdfObj) => PdfObj): Uint8Array {
  const kind = numberParam(params, 'Predictor', 1, resolve);
  if (kind === 1) return data;
  if (kind < 10) throw new UnsupportedFilterError(`FlateDecode with /Predictor ${kind}`);

  const colors = numberParam(params, 'Colors', 1, resolve);
  const bits = numberParam(params, 'BitsPerComponent', 8, resolve);
  const columns = numberParam(params, 'Columns', 1, resolve);
  if (![colors, bits, columns].every((n) => Number.isInteger(n) && n > 0)) {
    throw new PdfParseError(`invalid PNG predictor parameters (Colors ${colors}, BitsPerComponent ${bits}, Columns ${columns})`);
  }
  const rowBytes = Math.ceil((colors * bits * columns) / 8);
  const bpp = Math.max(1, Math.ceil((colors * bits) / 8));
  const rows = Math.ceil(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let outLen = 0;

  for (let r = 0; r < rows; r++) {
    const src = r * (rowBytes + 1);
    const n = Math.min(rowBytes, data.length - src - 1); // a truncated last row is decoded as far as it goes
    if (n <= 0) break;
    const type = data[src]!;
    const row = r * rowBytes;
    const prev = row - rowBytes; // only read when r > 0
    for (let i = 0; i < n; i++) {
      const x = data[src + 1 + i]!;
      const left = i >= bpp ? out[row + i - bpp]! : 0;
      const up = r > 0 ? out[prev + i]! : 0;
      const upLeft = r > 0 && i >= bpp ? out[prev + i - bpp]! : 0;
      let v: number;
      switch (type) {
        case 0:
          v = x;
          break;
        case 1:
          v = x + left;
          break;
        case 2:
          v = x + up;
          break;
        case 3:
          v = x + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          throw new PdfParseError(`invalid PNG predictor row type ${type}`);
      }
      out[row + i] = v & 255;
    }
    outLen = row + n;
  }
  return out.subarray(0, outLen);
}
