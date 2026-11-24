import { zlibSync } from 'fflate';

/**
 * Builds small but valid PDFs for unit tests, so no fixture file is needed.
 * Object bodies are given as text; the builder lays them out and computes every xref offset.
 */

const enc = new TextEncoder();

export type MiniObject =
  | { num: number; body: string }
  | { num: number; dict?: string; data: Uint8Array | string; flate?: boolean; length?: string };
type BodyObject = Extract<MiniObject, { body: string }>;

export interface BuildOptions {
  /** `table`: classic xref. `stream`: xref stream. `hybrid`: classic table plus a trailer `/XRefStm`. */
  xref?: 'table' | 'stream' | 'hybrid';
  /** Numbers of non-stream objects to store inside one object stream (needs `stream` or `hybrid`). */
  packed?: number[];
  /** Object number of the catalog (default 1). */
  root?: number;
  /** Extra trailer entries, e.g. `/Encrypt 9 0 R`. */
  trailer?: string;
}

class Writer {
  private chunks: Uint8Array[] = [];
  length = 0;

  constructor(initial?: Uint8Array) {
    if (initial) this.write(initial);
  }

  write(part: string | Uint8Array): void {
    const bytes = typeof part === 'string' ? enc.encode(part) : part;
    this.chunks.push(bytes);
    this.length += bytes.length;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.length);
    let pos = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return out;
  }
}

const pad10 = (n: number): string => String(n).padStart(10, '0');

/** Writes one object and returns the offset it starts at. */
function writeObject(w: Writer, o: MiniObject): number {
  const offset = w.length;
  if ('body' in o) {
    w.write(`${o.num} 0 obj\n${o.body}\nendobj\n`);
    return offset;
  }
  let data = typeof o.data === 'string' ? enc.encode(o.data) : o.data;
  let dict = o.dict ?? '';
  if (o.flate) {
    data = zlibSync(data);
    dict += ' /Filter /FlateDecode';
  }
  w.write(`${o.num} 0 obj\n<< ${dict} /Length ${o.length ?? data.length} >>\nstream\n`);
  w.write(data);
  w.write('\nendstream\nendobj\n');
  return offset;
}

type Entry = [type: 0 | 1 | 2, field2: number, field3: number];

/** An xref stream with /W [1 4 2] and the PNG "Up" predictor, covering exactly `rows`. */
function xrefStreamObject(num: number, rows: [number, Entry][], size: number, extra: string): MiniObject {
  const rowLen = 7;
  const index: number[] = [];
  for (const [n] of rows) {
    const last = index.length - 2;
    if (last >= 0 && index[last]! + index[last + 1]! === n) index[last + 1] = index[last + 1]! + 1;
    else index.push(n, 1);
  }
  const data = new Uint8Array(rows.length * (rowLen + 1));
  let prev = new Uint8Array(rowLen);
  rows.forEach(([, [type, f2, f3]], i) => {
    const row = new Uint8Array([type, f2 >>> 24, (f2 >>> 16) & 255, (f2 >>> 8) & 255, f2 & 255, f3 >>> 8, f3 & 255]);
    const base = i * (rowLen + 1);
    data[base] = 2; // PNG Up
    for (let j = 0; j < rowLen; j++) data[base + 1 + j] = (row[j]! - prev[j]! + 256) & 255;
    prev = row;
  });
  return {
    num,
    dict: `/Type /XRef /Size ${size} /W [1 4 2] /Index [${index.join(' ')}] ${extra} /DecodeParms << /Predictor 12 /Columns ${rowLen} >>`,
    data,
    flate: true,
  };
}

export function buildPdf(objs: MiniObject[], opts: BuildOptions = {}): Uint8Array {
  const mode = opts.xref ?? 'table';
  const root = opts.root ?? 1;
  const packedNums = new Set(opts.packed ?? []);
  const packed = objs.filter((o): o is BodyObject => packedNums.has(o.num) && 'body' in o);
  if (packed.length !== packedNums.size) throw new Error('packed objects must exist and have a plain body');
  if (packed.length > 0 && mode === 'table') throw new Error('packed objects need an xref stream');

  const w = new Writer();
  w.write('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  const offsets = new Map<number, number>();
  for (const o of objs) if (!packedNums.has(o.num)) offsets.set(o.num, writeObject(w, o));

  let maxNum = Math.max(...objs.map((o) => o.num));
  const compressed = new Map<number, [stm: number, index: number]>();
  if (packed.length > 0) {
    const stm = ++maxNum;
    let header = '';
    let body = '';
    packed.forEach((o, i) => {
      header += `${o.num} ${body.length} `;
      body += `${o.body}\n`;
      compressed.set(o.num, [stm, i]);
    });
    offsets.set(
      stm,
      writeObject(w, { num: stm, dict: `/Type /ObjStm /N ${packed.length} /First ${header.length}`, data: header + body, flate: true }),
    );
  }

  const extra = opts.trailer ?? '';
  if (mode === 'stream') {
    const stmNum = ++maxNum;
    const size = maxNum + 1;
    offsets.set(stmNum, w.length);
    const rows: [number, Entry][] = [];
    for (let n = 0; n < size; n++) {
      const off = offsets.get(n);
      const comp = compressed.get(n);
      rows.push([n, n === 0 ? [0, 0, 65535] : off !== undefined ? [1, off, 0] : comp ? [2, comp[0], comp[1]] : [0, 0, 0]]);
    }
    const startxref = w.length;
    writeObject(w, xrefStreamObject(stmNum, rows, size, `/Root ${root} 0 R ${extra}`));
    w.write(`startxref\n${startxref}\n%%EOF\n`);
    return w.bytes();
  }

  let xrefStm = '';
  if (mode === 'hybrid') {
    const stmNum = ++maxNum;
    const rows: [number, Entry][] = [...compressed].map(([n, [stm, i]]) => [n, [2, stm, i]]);
    xrefStm = `/XRefStm ${writeObject(w, xrefStreamObject(stmNum, rows, maxNum + 1, ''))}`;
  }
  const size = maxNum + 1;
  const startxref = w.length;
  let table = `xref\n0 ${size}\n`;
  for (let n = 0; n < size; n++) {
    const off = offsets.get(n);
    table += off !== undefined ? `${pad10(off)} 00000 n \n` : `0000000000 ${n === 0 ? '65535' : '00000'} f \n`;
  }
  w.write(`${table}trailer\n<< /Size ${size} /Root ${root} 0 R ${xrefStm} ${extra} >>\nstartxref\n${startxref}\n%%EOF\n`);
  return w.bytes();
}

/**
 * Appends an incremental-update section (classic table, `/Prev` to the previous section) to `base`.
 * `size` is the new total /Size.
 */
export function appendUpdate(
  base: Uint8Array,
  objs: MiniObject[],
  opts: { size: number; root?: number; trailer?: string },
): Uint8Array {
  const tail = new TextDecoder().decode(base.subarray(Math.max(0, base.length - 64)));
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail);
  if (!m) throw new Error('base has no trailing startxref');
  const w = new Writer(base);
  const placed = objs.map((o) => [o.num, writeObject(w, o)] as const).sort((a, b) => a[0] - b[0]);
  const startxref = w.length;
  let table = 'xref\n';
  for (const [n, off] of placed) table += `${n} 1\n${pad10(off)} 00000 n \n`;
  w.write(
    `${table}trailer\n<< /Size ${opts.size} /Root ${opts.root ?? 1} 0 R /Prev ${m[1]} ${opts.trailer ?? ''} >>\nstartxref\n${startxref}\n%%EOF\n`,
  );
  return w.bytes();
}
