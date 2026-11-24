import { Lexer, PdfParseError, type Token } from './lexer';

export interface Ref {
  num: number;
  gen: number;
}

export type PdfObj =
  | { k: 'null' }
  | { k: 'bool'; v: boolean }
  | { k: 'num'; v: number }
  | { k: 'str'; v: Uint8Array }
  | { k: 'name'; v: string }
  | { k: 'arr'; v: PdfObj[] }
  | { k: 'dict'; v: Map<string, PdfObj> }
  | { k: 'ref'; v: Ref }
  | { k: 'stream'; dict: Map<string, PdfObj>; raw: Uint8Array }; // raw = undecoded bytes (a view into the file)

export type PdfStream = Extract<PdfObj, { k: 'stream' }>;

const isIndex = (t: Token): t is { t: 'num'; v: number } => t.t === 'num' && Number.isInteger(t.v) && t.v >= 0;

/** Parses one direct object (`N G R` is read as a reference). */
export function parseObject(lex: Lexer): PdfObj {
  return fromToken(lex, lex.next());
}

function fromToken(lex: Lexer, tok: Token): PdfObj {
  switch (tok.t) {
    case 'num': {
      if (isIndex(tok)) {
        const saved = lex.pos;
        const gen = lex.next();
        if (isIndex(gen)) {
          const r = lex.next();
          if (r.t === 'kw' && r.v === 'R') return { k: 'ref', v: { num: tok.v, gen: gen.v } };
        }
        lex.pos = saved;
      }
      return { k: 'num', v: tok.v };
    }
    case 'name':
      return { k: 'name', v: tok.v };
    case 'str':
      return { k: 'str', v: tok.v };
    case 'kw':
      if (tok.v === 'true') return { k: 'bool', v: true };
      if (tok.v === 'false') return { k: 'bool', v: false };
      if (tok.v === 'null') return { k: 'null' };
      throw new PdfParseError(`unexpected keyword "${tok.v}" at offset ${lex.pos}`);
    case 'punct':
      if (tok.v === '[') {
        const items: PdfObj[] = [];
        for (;;) {
          const t = lex.next();
          if (t.t === 'punct' && t.v === ']') return { k: 'arr', v: items };
          items.push(fromToken(lex, t));
        }
      }
      if (tok.v === '<<') {
        const dict = new Map<string, PdfObj>();
        for (;;) {
          const key = lex.next();
          if (key.t === 'punct' && key.v === '>>') return { k: 'dict', v: dict };
          if (key.t !== 'name') throw new PdfParseError(`dictionary key must be a name, at offset ${lex.pos}`);
          dict.set(key.v, parseObject(lex));
        }
      }
      throw new PdfParseError(`unexpected "${tok.v}" at offset ${lex.pos}`);
    case 'eof':
      throw new PdfParseError('unexpected end of data');
  }
}

function startsWith(bytes: Uint8Array, pos: number, ascii: string): boolean {
  for (let i = 0; i < ascii.length; i++) if (bytes[pos + i] !== ascii.charCodeAt(i)) return false;
  return true;
}

function indexOfAscii(bytes: Uint8Array, ascii: string, from: number): number {
  for (let i = from; i + ascii.length <= bytes.length; i++) if (startsWith(bytes, i, ascii)) return i;
  return -1;
}

/**
 * Parses `N G obj ... endobj` at the lexer position. `resolve` dereferences an indirect `/Length`.
 * A stream whose `/Length` does not land on `endstream` is cut at the marker instead.
 */
export function parseIndirectObject(lex: Lexer, resolve: (o: PdfObj) => PdfObj): { ref: Ref; obj: PdfObj } {
  const start = lex.pos;
  const num = lex.next();
  const gen = lex.next();
  const kw = lex.next();
  if (!isIndex(num) || !isIndex(gen) || kw.t !== 'kw' || kw.v !== 'obj') {
    throw new PdfParseError(`expected "N G obj" at offset ${start}`);
  }
  const ref = { num: num.v, gen: gen.v };
  const obj = parseObject(lex);
  if (obj.k !== 'dict') return { ref, obj };

  const afterDict = lex.pos;
  const next = lex.next();
  if (next.t !== 'kw' || next.v !== 'stream') {
    lex.pos = afterDict;
    return { ref, obj };
  }

  const bytes = lex.bytes;
  let dataStart = lex.pos;
  if (bytes[dataStart] === 13 && bytes[dataStart + 1] === 10) dataStart += 2;
  else if (bytes[dataStart] === 10 || bytes[dataStart] === 13) dataStart += 1;

  const length = resolve(obj.v.get('Length') ?? { k: 'null' });
  if (length.k === 'num' && Number.isInteger(length.v) && length.v >= 0 && dataStart + length.v <= bytes.length) {
    const lookahead = new Lexer(bytes, dataStart + length.v);
    lookahead.skipWhitespaceAndComments();
    if (startsWith(bytes, lookahead.pos, 'endstream')) {
      return { ref, obj: { k: 'stream', dict: obj.v, raw: bytes.subarray(dataStart, dataStart + length.v) } };
    }
  }

  // /Length missing or wrong: end the data at the first "endstream", minus one end-of-line marker.
  let end = indexOfAscii(bytes, 'endstream', dataStart);
  if (end < 0) throw new PdfParseError(`stream of object ${ref.num} has no endstream (offset ${start})`);
  if (end > dataStart && bytes[end - 1] === 10) end--;
  if (end > dataStart && bytes[end - 1] === 13) end--;
  return { ref, obj: { k: 'stream', dict: obj.v, raw: bytes.subarray(dataStart, end) } };
}
