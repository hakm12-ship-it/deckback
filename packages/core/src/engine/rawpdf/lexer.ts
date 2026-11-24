/** Thrown for syntax or structure problems in a PDF (damaged xref, bad object header, ...). */
export class PdfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfParseError';
  }
}

export type Token =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'str'; v: Uint8Array }
  | { t: 'kw'; v: string }
  | { t: 'punct'; v: '[' | ']' | '<<' | '>>' }
  | { t: 'eof' };

const isWhitespace = (c: number): boolean => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
// ( ) < > [ ] { } / %
const isDelimiter = (c: number): boolean =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;
const isRegular = (c: number): boolean => c >= 0 && !isWhitespace(c) && !isDelimiter(c);

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)$/;

function latin1(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  return -1;
}

/** Splits PDF bytes into tokens. `pos` is public: the parser rewinds it and reads stream data from it. */
export class Lexer {
  constructor(
    readonly bytes: Uint8Array,
    public pos = 0,
  ) {}

  /** Byte at `pos + ahead`, or -1 past the end. */
  byteAt(ahead = 0): number {
    return this.bytes[this.pos + ahead] ?? -1;
  }

  skipWhitespaceAndComments(): void {
    for (;;) {
      const c = this.byteAt();
      if (isWhitespace(c)) this.pos++;
      else if (c === 0x25) {
        while (this.byteAt() !== -1 && this.byteAt() !== 10 && this.byteAt() !== 13) this.pos++;
      } else return;
    }
  }

  peek(): Token {
    const saved = this.pos;
    const token = this.next();
    this.pos = saved;
    return token;
  }

  next(): Token {
    this.skipWhitespaceAndComments();
    const c = this.byteAt();
    if (c === -1) return { t: 'eof' };
    switch (c) {
      case 0x2f:
        return { t: 'name', v: this.readName() };
      case 0x28:
        return { t: 'str', v: this.readLiteralString() };
      case 0x3c:
        if (this.byteAt(1) === 0x3c) {
          this.pos += 2;
          return { t: 'punct', v: '<<' };
        }
        return { t: 'str', v: this.readHexString() };
      case 0x3e:
        if (this.byteAt(1) === 0x3e) {
          this.pos += 2;
          return { t: 'punct', v: '>>' };
        }
        break;
      case 0x5b:
        this.pos++;
        return { t: 'punct', v: '[' };
      case 0x5d:
        this.pos++;
        return { t: 'punct', v: ']' };
    }
    if (!isRegular(c)) throw new PdfParseError(`unexpected character 0x${c.toString(16)} at offset ${this.pos}`);
    const start = this.pos;
    while (isRegular(this.byteAt())) this.pos++;
    const word = latin1(this.bytes.subarray(start, this.pos));
    return NUMBER.test(word) ? { t: 'num', v: Number(word) } : { t: 'kw', v: word };
  }

  private readName(): string {
    this.pos++; // '/'
    const out: number[] = [];
    while (isRegular(this.byteAt())) {
      const c = this.byteAt();
      const hi = hexValue(this.byteAt(1));
      const lo = hexValue(this.byteAt(2));
      if (c === 0x23 && hi >= 0 && lo >= 0) {
        out.push(hi * 16 + lo);
        this.pos += 3;
      } else {
        out.push(c);
        this.pos++;
      }
    }
    if (out.every((b) => b < 0x80)) return latin1(out);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(out));
    } catch {
      return latin1(out);
    }
  }

  private readLiteralString(): Uint8Array {
    this.pos++; // '('
    const out: number[] = [];
    let depth = 1;
    for (;;) {
      const c = this.byteAt();
      if (c === -1) throw new PdfParseError('unterminated string');
      this.pos++;
      if (c === 0x5c) {
        const e = this.byteAt();
        this.pos++;
        if (e === 0x6e) out.push(10);
        else if (e === 0x72) out.push(13);
        else if (e === 0x74) out.push(9);
        else if (e === 0x62) out.push(8);
        else if (e === 0x66) out.push(12);
        else if (e >= 0x30 && e <= 0x37) {
          let v = e - 0x30;
          for (let i = 0; i < 2 && this.byteAt() >= 0x30 && this.byteAt() <= 0x37; i++) {
            v = v * 8 + (this.byteAt() - 0x30);
            this.pos++;
          }
          out.push(v & 255);
        } else if (e === 13) {
          if (this.byteAt() === 10) this.pos++; // line continuation
        } else if (e === 10) {
          // line continuation
        } else if (e === -1) throw new PdfParseError('unterminated string');
        else out.push(e); // \( \) \\ and unknown escapes
      } else if (c === 0x28) {
        depth++;
        out.push(c);
      } else if (c === 0x29) {
        if (--depth === 0) return new Uint8Array(out);
        out.push(c);
      } else out.push(c);
    }
  }

  private readHexString(): Uint8Array {
    this.pos++; // '<'
    const out: number[] = [];
    let high = -1;
    for (;;) {
      const c = this.byteAt();
      if (c === -1) throw new PdfParseError('unterminated hex string');
      this.pos++;
      if (c === 0x3e) break;
      const v = hexValue(c);
      if (v < 0) continue; // whitespace and stray characters are ignored
      if (high < 0) high = v;
      else {
        out.push(high * 16 + v);
        high = -1;
      }
    }
    if (high >= 0) out.push(high * 16);
    return new Uint8Array(out);
  }
}
