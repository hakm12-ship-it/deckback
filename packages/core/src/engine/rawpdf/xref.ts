import { decodeStream } from './filters';
import { Lexer, PdfParseError } from './lexer';
import { parseIndirectObject, parseObject, type PdfObj } from './parser';

export type XrefEntry =
  | { t: 'free' }
  | { t: 'offset'; offset: number }
  | { t: 'objstm'; stm: number; index: number }; // object `index` of object stream `stm`

export interface XrefData {
  /** Newest definition of every object number. */
  entries: Map<number, XrefEntry>;
  /** Trailer of the newest section (xref-stream dictionary for stream sections). */
  trailer: Map<string, PdfObj>;
}

interface Section {
  entries: Map<number, XrefEntry>;
  trailer: Map<string, PdfObj>;
}

const identity = (o: PdfObj): PdfObj => o;

function findStartXref(bytes: Uint8Array): number {
  const marker = 'startxref';
  for (let i = bytes.length - marker.length; i >= Math.max(0, bytes.length - 2048); i--) {
    let match = true;
    for (let j = 0; j < marker.length && match; j++) match = bytes[i + j] === marker.charCodeAt(j);
    if (!match) continue;
    const lex = new Lexer(bytes, i + marker.length);
    const offset = lex.next();
    if (offset.t !== 'num') break;
    return offset.v;
  }
  throw new PdfParseError('startxref not found in the last 2 KB: not a PDF, or the xref is damaged');
}

function readSection(bytes: Uint8Array, offset: number): Section {
  if (!Number.isInteger(offset) || offset < 0 || offset >= bytes.length) {
    throw new PdfParseError(`xref offset ${offset} is outside the file`);
  }
  const lex = new Lexer(bytes, offset);
  const first = lex.peek();
  if (first.t === 'kw' && first.v === 'xref') return readTable(lex);
  if (first.t === 'num') return readStream(lex, offset);
  throw new PdfParseError(`no xref table or xref stream at offset ${offset}`);
}

function readTable(lex: Lexer): Section {
  lex.next(); // 'xref'
  const entries = new Map<number, XrefEntry>();
  for (;;) {
    const start = lex.next();
    if (start.t === 'kw' && start.v === 'trailer') break;
    const count = lex.next();
    if (start.t !== 'num' || count.t !== 'num') throw new PdfParseError(`malformed xref subsection header at offset ${lex.pos}`);
    for (let i = 0; i < count.v; i++) {
      const offset = lex.next();
      const gen = lex.next();
      const flag = lex.next();
      if (offset.t !== 'num' || gen.t !== 'num' || flag.t !== 'kw' || (flag.v !== 'n' && flag.v !== 'f')) {
        throw new PdfParseError(`malformed xref entry at offset ${lex.pos}`);
      }
      entries.set(start.v + i, flag.v === 'n' ? { t: 'offset', offset: offset.v } : { t: 'free' });
    }
  }
  const trailer = parseObject(lex);
  if (trailer.k !== 'dict') throw new PdfParseError('xref trailer is not a dictionary');
  return { entries, trailer: trailer.v };
}

function readStream(lex: Lexer, offset: number): Section {
  const { obj } = parseIndirectObject(lex, identity);
  const kind = obj.k === 'stream' ? obj.dict.get('Type') : undefined;
  if (obj.k !== 'stream' || kind?.k !== 'name' || kind.v !== 'XRef') {
    throw new PdfParseError(`object at offset ${offset} is not an xref stream`);
  }

  const w = obj.dict.get('W');
  if (w?.k !== 'arr' || w.v.length < 3 || !w.v.every((x) => x.k === 'num')) {
    throw new PdfParseError('xref stream has no valid /W');
  }
  const widths = w.v.slice(0, 3).map((x) => (x.k === 'num' ? x.v : 0));
  const size = obj.dict.get('Size');
  const indexObj = obj.dict.get('Index');
  const index: number[] =
    indexObj?.k === 'arr' ? indexObj.v.map((x) => (x.k === 'num' ? x.v : 0)) : [0, size?.k === 'num' ? size.v : 0];

  const data = decodeStream(obj, identity);
  const [w0, w1, w2] = widths as [number, number, number];
  const rowLen = w0 + w1 + w2;
  const field = (at: number, width: number): number => {
    let v = 0;
    for (let i = 0; i < width; i++) v = v * 256 + data[at + i]!;
    return v;
  };

  const entries = new Map<number, XrefEntry>();
  let pos = 0;
  for (let s = 0; s + 1 < index.length; s += 2) {
    const first = index[s]!;
    const count = index[s + 1]!;
    for (let i = 0; i < count && pos + rowLen <= data.length; i++, pos += rowLen) {
      const type = w0 === 0 ? 1 : field(pos, w0); // a zero-width type field means "in use, not compressed"
      const f2 = field(pos + w0, w1);
      const f3 = field(pos + w0 + w1, w2);
      entries.set(first + i, type === 1 ? { t: 'offset', offset: f2 } : type === 2 ? { t: 'objstm', stm: f2, index: f3 } : { t: 'free' });
    }
  }
  return { entries, trailer: obj.dict };
}

/**
 * Reads the whole xref chain: the newest section first, then `/Prev` links back to the oldest.
 * The newest definition of each object wins. A trailer `/XRefStm` (hybrid file) is merged into its section.
 */
export function readXref(bytes: Uint8Array): XrefData {
  const entries = new Map<number, XrefEntry>();
  let trailer: Map<string, PdfObj> | null = null;
  const visited = new Set<number>();
  let next: number | undefined = findStartXref(bytes);

  while (next !== undefined) {
    if (visited.has(next)) throw new PdfParseError(`xref /Prev chain loops back to offset ${next}`);
    visited.add(next);
    const section = readSection(bytes, next);
    trailer ??= section.trailer;

    const hybrid = section.trailer.get('XRefStm');
    if (hybrid?.k === 'num') {
      // In a hybrid file the classic table marks objects living in object streams as free;
      // the XRefStm stream (searched right after the table) is what actually locates them.
      for (const [num, entry] of readSection(bytes, hybrid.v).entries) {
        const seen = section.entries.get(num);
        if (entry.t !== 'free' && (seen === undefined || seen.t === 'free')) section.entries.set(num, entry);
      }
    }

    for (const [num, entry] of section.entries) if (!entries.has(num)) entries.set(num, entry);
    const prev = section.trailer.get('Prev');
    next = prev?.k === 'num' ? prev.v : undefined;
  }
  return { entries, trailer: trailer! };
}
