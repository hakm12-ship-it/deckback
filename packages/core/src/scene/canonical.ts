/**
 * The rounding and the canonical JSON of the Scene (Global Constraints, Determinism): the same PDF bytes give the same
 * bytes of Scene JSON in Node and in every browser. Ruling M2-R13: numbers are rounded when the Scene is built, by unit
 * (`roundPt`, `roundUnitless`); `canonicalJson` rounds to 6 decimals only as a backstop, which leaves a correctly built
 * Scene unchanged.
 */

/** At this size a double has no fraction left: `value * scale` is a whole number, or not even finite. */
const NO_FRACTION = 2 ** 52;

/** Rounds to `1 / scale`, and turns -0 into 0. A value too large to have such a fraction is left as it is. */
function round(value: number, scale: number): number {
  const scaled = value * scale;
  if (!(Math.abs(scaled) < NO_FRACTION)) return value;
  const v = Math.round(scaled) / scale;
  return v === 0 ? 0 : v;
}

/** A slide-frame length (a coordinate, box, size, width, path point, matrix e and f): 3 decimals, as the inventory. */
export function roundPt(value: number): number {
  return round(value, 1e3);
}

/** A unitless value (an alpha, a gradient stop, matrix a to d, a ratio such as the miter limit): 6 decimals. */
export function roundUnitless(value: number): number {
  return round(value, 1e6);
}

/**
 * JSON with the keys of every object sorted (by UTF-16 code units, as `Array.prototype.sort` compares strings), every
 * number rounded to 6 decimals and -0 written as 0, and no whitespace. As `JSON.stringify`, an object property whose
 * value is `undefined` is left out. Throws a `TypeError` naming the place for what JSON cannot carry exactly: a number
 * that is not finite, `undefined` in an array, and anything that is not a plain object, an array, a string, a number,
 * a boolean or null.
 */
export function canonicalJson(value: unknown): string {
  return write(value, '$');
}

function write(value: unknown, at: string): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: ${at} is not a finite number`);
      return String(roundUnitless(value));
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (Array.isArray(value)) {
        const items: string[] = [];
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          if (item === undefined) throw new TypeError(`canonicalJson: ${at}[${i}] is undefined`);
          items.push(write(item, `${at}[${i}]`));
        }
        return `[${items.join(',')}]`;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`canonicalJson: ${at} is not a plain object`);
      const record = value as Record<string, unknown>;
      const members: string[] = [];
      for (const key of Object.keys(record).sort()) {
        if (record[key] === undefined) continue;
        members.push(`${JSON.stringify(key)}:${write(record[key], `${at}.${key}`)}`);
      }
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: ${at} is a ${typeof value}`);
  }
}

/**
 * Whether `canonicalJson` can write `value` (it would not throw): every number finite, no `undefined` in an array, and
 * only plain objects, arrays, strings, numbers, booleans and null. It builds no string, so the lenient Scene builder can ask
 * it of every element it makes.
 */
export function canWrite(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case 'number':
      return Number.isFinite(value);
    case 'string':
    case 'boolean':
      return true;
    case 'object': {
      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item: unknown = value[i];
          if (item === undefined || !canWrite(item)) return false;
        }
        return true;
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) return false;
      const record = value as Record<string, unknown>;
      for (const key of Object.keys(record)) {
        const item = record[key];
        if (item !== undefined && !canWrite(item)) return false;
      }
      return true;
    }
    default:
      return false;
  }
}

/** The SHA-256 of `canonicalJson(value)` in UTF-8, lower-case hex, through Web Crypto (Node ≥ 22.13 and browsers). */
export async function sceneHash(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalJson(value)));
}

/** The SHA-256 of `bytes`, lower-case hex, through Web Crypto: the Scene's hash, and the key of a media file. */
export async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** SHA-256's round constants: the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const SHA256_K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/**
 * The SHA-256 of `bytes`, lower-case hex, computed here (FIPS 180-4) in 32-bit integers: what a pass that makes a picture
 * (the raster fallback, M5) keys it by, as `sha256Hex` keys the Scene's media, without waiting on Web Crypto.
 */
export function sha256Sync(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));
  for (let at = 0; at < padded.length; at += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(at + i * 4);
    for (let i = 16; i < 64; i++) {
      const [a, b] = [w[i - 15]!, w[i - 2]!];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return Array.from(h, (x) => x.toString(16).padStart(8, '0')).join('');
}
