import { decodeStream } from './filters';
import { Lexer, PdfParseError } from './lexer';
import { parseIndirectObject, parseObject, type PdfObj, type PdfStream, type Ref } from './parser';
import { readXref, type XrefEntry } from './xref';

export class EncryptedPdfError extends Error {
  constructor(message = 'PDF is encrypted (/Encrypt in the trailer); raw stream bytes are not readable') {
    super(message);
    this.name = 'EncryptedPdfError';
  }
}

export interface RawPdf {
  trailer: Map<string, PdfObj>;
  /** Follows xref tables, xref streams, /Prev chains and object streams. An undefined object is `null`. */
  get(ref: Ref): PdfObj;
  /** Dereferences `{k:'ref'}` (also chains of refs); anything else is returned as is. */
  resolve(o: PdfObj): PdfObj;
  /** Leaf pages in document order, through nested /Pages /Kids. */
  pageRefs(): Ref[];
  /** FlateDecode (+ PNG predictors). Any other filter throws UnsupportedFilterError. */
  decode(s: PdfStream): Uint8Array;
}

interface ObjectStream {
  nums: number[];
  offsets: number[];
  first: number;
  data: Uint8Array;
}

const NULL: PdfObj = { k: 'null' };
const MAX_REF_CHAIN = 32;

class RawPdfImpl implements RawPdf {
  private readonly cache = new Map<number, PdfObj>();
  private readonly objectStreams = new Map<number, ObjectStream>();
  private readonly loading = new Set<number>();
  private pages: Ref[] | null = null;

  constructor(
    private readonly bytes: Uint8Array,
    private readonly entries: Map<number, XrefEntry>,
    readonly trailer: Map<string, PdfObj>,
  ) {}

  get(ref: Ref): PdfObj {
    const cached = this.cache.get(ref.num);
    if (cached) return cached;
    const entry = this.entries.get(ref.num);
    if (!entry || entry.t === 'free') return NULL;
    if (this.loading.has(ref.num)) throw new PdfParseError(`object ${ref.num} refers to itself while loading`);
    this.loading.add(ref.num);
    try {
      const obj = entry.t === 'offset' ? this.loadAt(ref.num, entry.offset) : this.loadCompressed(ref.num, entry.stm, entry.index);
      this.cache.set(ref.num, obj);
      return obj;
    } finally {
      this.loading.delete(ref.num);
    }
  }

  resolve(o: PdfObj): PdfObj {
    let cur = o;
    for (let i = 0; cur.k === 'ref'; i++) {
      if (i >= MAX_REF_CHAIN) throw new PdfParseError('reference chain is too long (loop?)');
      cur = this.get(cur.v);
    }
    return cur;
  }

  decode(s: PdfStream): Uint8Array {
    return decodeStream(s, (o) => this.resolve(o));
  }

  pageRefs(): Ref[] {
    if (this.pages) return this.pages;
    const root = this.resolve(this.trailer.get('Root') ?? NULL);
    const top = root.k === 'dict' ? root.v.get('Pages') : undefined;
    if (top?.k !== 'ref') throw new PdfParseError('catalog has no /Pages reference');

    const pages: Ref[] = [];
    const seen = new Set<number>();
    const visit = (ref: Ref): void => {
      if (seen.has(ref.num)) return;
      seen.add(ref.num);
      const node = this.get(ref);
      if (node.k !== 'dict') return;
      const kids = this.resolve(node.v.get('Kids') ?? NULL);
      if (kids.k !== 'arr') {
        pages.push(ref); // no /Kids: a page
        return;
      }
      for (const kid of kids.v) if (kid.k === 'ref') visit(kid.v);
    };
    visit(top.v);
    return (this.pages = pages);
  }

  private loadAt(num: number, offset: number): PdfObj {
    if (!(offset >= 0 && offset < this.bytes.length)) {
      throw new PdfParseError(`object ${num}: xref offset ${offset} is outside the file`);
    }
    const { ref, obj } = parseIndirectObject(new Lexer(this.bytes, offset), (o) => this.resolve(o));
    if (ref.num !== num) throw new PdfParseError(`xref points object ${num} at offset ${offset}, which holds object ${ref.num}`);
    return obj;
  }

  private loadCompressed(num: number, stm: number, index: number): PdfObj {
    const os = this.objectStream(stm);
    const at = os.nums[index] === num ? index : os.nums.indexOf(num);
    if (at < 0) throw new PdfParseError(`object ${num} is not in object stream ${stm}`);
    return parseObject(new Lexer(os.data, os.first + os.offsets[at]!));
  }

  private objectStream(stm: number): ObjectStream {
    const cached = this.objectStreams.get(stm);
    if (cached) return cached;
    const s = this.get({ num: stm, gen: 0 });
    if (s.k !== 'stream') throw new PdfParseError(`object ${stm} is not an object stream`);
    const n = this.resolve(s.dict.get('N') ?? NULL);
    const first = this.resolve(s.dict.get('First') ?? NULL);
    if (n.k !== 'num' || first.k !== 'num') throw new PdfParseError(`object stream ${stm} lacks /N or /First`);

    const data = this.decode(s);
    const header = new Lexer(data);
    const nums: number[] = [];
    const offsets: number[] = [];
    for (let i = 0; i < n.v; i++) {
      const num = header.next();
      const offset = header.next();
      if (num.t !== 'num' || offset.t !== 'num') throw new PdfParseError(`object stream ${stm} has a malformed header`);
      nums.push(num.v);
      offsets.push(offset.v);
    }
    const parsed: ObjectStream = { nums, offsets, first: first.v, data };
    this.objectStreams.set(stm, parsed);
    return parsed;
  }
}

/** Opens a PDF for raw object access. Throws EncryptedPdfError when the trailer has /Encrypt. */
export function openRawPdf(bytes: Uint8Array): RawPdf {
  const { entries, trailer } = readXref(bytes);
  const encrypt = trailer.get('Encrypt');
  if (encrypt && encrypt.k !== 'null') throw new EncryptedPdfError();
  return new RawPdfImpl(bytes, entries, trailer);
}
