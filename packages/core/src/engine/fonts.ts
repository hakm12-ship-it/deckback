import { PdfParseError, UnsupportedFilterError, type PdfObj, type RawPdf, type Ref } from './rawpdf';

export interface FontProgram {
  resName: string;
  /** The (Type0) font dict's /BaseFont, subset prefix included. */
  baseFont: string;
  /**
   * Type0: the descendant CIDFont's /BaseFont when it is another name than `baseFont` (M8 round 3c: PDFMaker writes another
   * subset tag on the CIDFont, and pdf.js names the font by it); null otherwise.
   */
  cidBaseFont: string | null;
  /** Type0: the descendant CIDFont's subtype (e.g. 'CIDFontType2'). */
  subtype: string;
  /** Which descriptor entry holds the program; null when the font is not embedded. */
  fileKind: 'FontFile' | 'FontFile2' | 'FontFile3' | null;
  /**
   * Decoded font program bytes, straight from the file (a copy, never a view of the PDF buffer).
   * null when the font is not embedded, or when it is embedded but unreadable
   * (unsupported filter, corrupt data, broken object): then `fileKind` and `ref` are still set.
   */
  bytes: Uint8Array | null;
  /** Ref of the font program stream. */
  ref: Ref | null;
  /**
   * The font descriptor's entries, null without one. `fontFamily` (M8 round 3a): its /FontFamily, a text string, null
   * when absent or not a string.
   */
  descriptor: { flags: number; ascent: number; descent: number; italicAngle: number; fontWeight: number | null; fontFamily: string | null } | null;
  /**
   * M8 round 1a, what takes a code of the font's text to a glyph of its program (a symbol font's own codes, scene/fonts.ts):
   * - `composite`: a Type0 font, whose codes go through its CMap to CIDs;
   * - `encoding`: the font dict's /Encoding when it is a name (`Identity-H`, `WinAnsiEncoding`, ...), else null;
   * - `cidToGid`: a CIDFontType2's /CIDToGIDMap: `identity` for /Identity or none (its default), else the stream's
   *   decoded bytes (two per CID, big-endian); null for any other font, and for a map that cannot be read.
   */
  composite: boolean;
  encoding: string | null;
  cidToGid: 'identity' | Uint8Array | null;
}

type Dict = Map<string, PdfObj>;

const FILE_KINDS = ['FontFile', 'FontFile2', 'FontFile3'] as const;
const MAX_PARENT_DEPTH = 64;

/**
 * Runs `load`; a damaged object or an unsupported filter gives undefined instead of an exception,
 * so one bad object costs only itself and not the whole page.
 */
function tolerate<T>(load: () => T): T | undefined {
  try {
    return load();
  } catch (e) {
    if (e instanceof PdfParseError || e instanceof UnsupportedFilterError) return undefined;
    throw e;
  }
}

/** Entry `key` of `dict`, dereferenced; undefined when absent or unreadable. */
function entry(raw: RawPdf, dict: Dict, key: string): PdfObj | undefined {
  const v = dict.get(key);
  return v === undefined ? undefined : tolerate(() => raw.resolve(v));
}

function dictEntry(raw: RawPdf, dict: Dict, key: string): Dict | undefined {
  const v = entry(raw, dict, key);
  return v?.k === 'dict' ? v.v : undefined;
}

function nameEntry(raw: RawPdf, dict: Dict, key: string): string | undefined {
  const v = entry(raw, dict, key);
  return v?.k === 'name' ? v.v : undefined;
}

function numberEntry(raw: RawPdf, dict: Dict, key: string): number | undefined {
  const v = entry(raw, dict, key);
  return v?.k === 'num' ? v.v : undefined;
}

/** A text string entry (PDF 7.9.2.2): UTF-16BE after its byte order mark, else one character a byte (PDFDocEncoding's ASCII). */
function textEntry(raw: RawPdf, dict: Dict, key: string): string | undefined {
  const v = entry(raw, dict, key);
  if (v?.k !== 'str') return undefined;
  const b = v.v;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < b.length; i += 2) out += String.fromCharCode((b[i]! << 8) | b[i + 1]!);
    return out;
  }
  let out = '';
  for (const c of b) out += String.fromCharCode(c);
  return out;
}

function pageDict(raw: RawPdf, pageIndex: number): Dict {
  const refs = raw.pageRefs();
  const ref = refs[pageIndex];
  if (ref === undefined) throw new RangeError(`page ${pageIndex} is outside the document (${refs.length} pages)`);
  const page = raw.get(ref);
  if (page.k !== 'dict') throw new Error(`page ${pageIndex} (object ${ref.num}) is not a dictionary`);
  return page.v;
}

/** The page's /Resources, inherited from /Parent /Pages nodes when the page has none. */
function pageResources(raw: RawPdf, page: Dict): Dict | undefined {
  let node: Dict | undefined = page;
  for (let depth = 0; node && depth < MAX_PARENT_DEPTH; depth++) {
    const resources = dictEntry(raw, node, 'Resources');
    if (resources) return resources;
    node = dictEntry(raw, node, 'Parent');
  }
  return undefined;
}

/**
 * Calls `visit` for the page's resources, then for the resources of every Form XObject reachable from it (once each), and
 * with `patterns` of every tiling pattern too: a tiling pattern's cell is a content stream with resources of its own.
 */
function forEachResources(raw: RawPdf, pageIndex: number, visit: (resources: Dict) => void, patterns = false): void {
  const seen = new Set<number>();
  /** The resources of the stream `value` refers to, if `isOne` takes it and it was not seen yet. */
  const inner = (value: PdfObj, isOne: (dict: Dict) => boolean): Dict | undefined => {
    if (value.k !== 'ref' || seen.has(value.v.num)) return undefined;
    seen.add(value.v.num);
    const stream = tolerate(() => raw.get(value.v));
    return stream?.k === 'stream' && isOne(stream.dict) ? dictEntry(raw, stream.dict, 'Resources') : undefined;
  };
  const walk = (resources: Dict): void => {
    visit(resources);
    for (const value of dictEntry(raw, resources, 'XObject')?.values() ?? []) {
      const found = inner(value, (dict) => nameEntry(raw, dict, 'Subtype') === 'Form');
      if (found) walk(found);
    }
    if (!patterns) return;
    for (const value of dictEntry(raw, resources, 'Pattern')?.values() ?? []) {
      const found = inner(value, (dict) => numberEntry(raw, dict, 'PatternType') === 1);
      if (found) walk(found);
    }
  };
  const resources = pageResources(raw, pageDict(raw, pageIndex));
  if (resources) walk(resources);
}

/** A CIDFontType2's /CIDToGIDMap (`FontProgram.cidToGid`): `identity` for the name or none, else the stream's bytes. */
function cidToGidOf(raw: RawPdf, cid: Dict): 'identity' | Uint8Array | null {
  if (!cid.has('CIDToGIDMap')) return 'identity';
  const map = entry(raw, cid, 'CIDToGIDMap');
  if (map?.k === 'name') return map.v === 'Identity' ? 'identity' : null;
  if (map?.k !== 'stream') return null;
  return tolerate(() => raw.decode(map))?.slice() ?? null;
}

function describeFont(raw: RawPdf, resName: string, font: Dict): FontProgram {
  const baseFont = nameEntry(raw, font, 'BaseFont') ?? '';
  let subtype = nameEntry(raw, font, 'Subtype') ?? '';
  let holder = font; // the dict that owns /FontDescriptor
  let cidBaseFont: string | null = null;
  if (subtype === 'Type0') {
    const descendants = entry(raw, font, 'DescendantFonts');
    const first = descendants?.k === 'arr' ? descendants.v[0] : undefined;
    const cid = first && tolerate(() => raw.resolve(first));
    if (cid?.k === 'dict') {
      holder = cid.v;
      subtype = nameEntry(raw, cid.v, 'Subtype') ?? subtype;
      const cidName = nameEntry(raw, cid.v, 'BaseFont');
      if (cidName !== undefined && cidName !== baseFont) cidBaseFont = cidName;
    }
  }

  const composite = nameEntry(raw, font, 'Subtype') === 'Type0';
  const encoding = nameEntry(raw, font, 'Encoding') ?? null;
  const cidToGid = subtype === 'CIDFontType2' ? cidToGidOf(raw, holder) : null;
  const base = { resName, baseFont, cidBaseFont, subtype, fileKind: null, bytes: null, ref: null, descriptor: null, composite, encoding, cidToGid } satisfies FontProgram;
  const fd = dictEntry(raw, holder, 'FontDescriptor');
  if (!fd) return base;

  const descriptor = {
    flags: numberEntry(raw, fd, 'Flags') ?? 0,
    ascent: numberEntry(raw, fd, 'Ascent') ?? 0,
    descent: numberEntry(raw, fd, 'Descent') ?? 0,
    italicAngle: numberEntry(raw, fd, 'ItalicAngle') ?? 0,
    fontWeight: numberEntry(raw, fd, 'FontWeight') ?? null,
    fontFamily: textEntry(raw, fd, 'FontFamily') ?? null,
  };
  for (const fileKind of FILE_KINDS) {
    const value = fd.get(fileKind);
    if (!value) continue;
    const stream = tolerate(() => raw.resolve(value));
    if (stream !== undefined && stream.k !== 'stream') continue; // dangling or malformed entry: nothing embedded
    // From here the descriptor claims an embedded program. If it cannot be loaded or decoded the font is
    // still reported, with fileKind and ref set and bytes null ("embedded but unreadable").
    const decoded = stream && tolerate(() => raw.decode(stream));
    return {
      ...base,
      fileKind,
      // decode() hands back the stored bytes themselves for an unfiltered stream: copy, so callers own them
      bytes: decoded ? decoded.slice() : null,
      ref: value.k === 'ref' ? value.v : null,
      descriptor,
    };
  }
  return { ...base, descriptor };
}

/**
 * A page as pdf.js knows it: its index (0-based) and its object reference (`PageData.pageRef`). A bare index is taken as it
 * is.
 */
export type RawPageKey = number | { index: number; ref: Ref | null };

/**
 * The raw reader's index of a page pdf.js loaded: the one whose object is the page's reference, as the two readers may
 * walk a damaged page tree differently (pdf.js may count a page the raw reader does not). The page's own index when the
 * reference is not in the raw reader's page list, or the list cannot be read.
 */
export function rawPageIndex(raw: RawPdf, page: RawPageKey): number {
  if (typeof page === 'number') return page;
  const { index, ref } = page;
  if (ref === null) return index;
  let refs: Ref[];
  try {
    refs = raw.pageRefs();
  } catch {
    return index;
  }
  const found = refs.findIndex((r) => r.num === ref.num && r.gen === ref.gen);
  return found >= 0 ? found : index;
}

/**
 * Fonts used by a page (and the Form XObjects it draws), each once per font dict ref.
 * Fonts without an embedded program, or whose program cannot be read, come back with `bytes: null`.
 * A font dict or Form XObject that cannot be loaded at all is skipped. A page index outside the
 * document throws RangeError.
 */
export function fontPrograms(raw: RawPdf, pageIndex: number): FontProgram[] {
  const out: FontProgram[] = [];
  const seen = new Set<number>();
  forEachResources(raw, pageIndex, (resources) => {
    const fonts = dictEntry(raw, resources, 'Font');
    if (!fonts) return;
    for (const [resName, value] of fonts) {
      if (value.k === 'ref') {
        if (seen.has(value.v.num)) continue;
        seen.add(value.v.num);
      }
      const font = tolerate(() => raw.resolve(value));
      if (font?.k === 'dict') out.push(describeFont(raw, resName, font.v));
    }
  });
  return out;
}

function isPlainDct(raw: RawPdf, dict: Dict): boolean {
  const filter = entry(raw, dict, 'Filter');
  if (filter?.k === 'name') return filter.v === 'DCTDecode';
  if (filter?.k === 'arr' && filter.v.length === 1) {
    const only = tolerate(() => raw.resolve(filter.v[0]!));
    return only?.k === 'name' && only.v === 'DCTDecode';
  }
  return false;
}

/** The key holds a value: it is there, and not null (a reference to no object is null too). Unreadable counts as there. */
function hasValue(raw: RawPdf, dict: Dict, key: string): boolean {
  const v = dict.get(key);
  if (v === undefined) return false;
  const resolved = tolerate(() => raw.resolve(v));
  return resolved === undefined || resolved.k !== 'null';
}

/**
 * DeviceRGB, DeviceGray, or an ICCBased space of 3 or 1 components (its stream's /N): the number of components, or null
 * for any other space.
 */
function plainColourSpace(raw: RawPdf, dict: Dict): 1 | 3 | null {
  const cs = entry(raw, dict, 'ColorSpace');
  if (cs?.k === 'name') return cs.v === 'DeviceRGB' ? 3 : cs.v === 'DeviceGray' ? 1 : null;
  if (cs?.k !== 'arr' || cs.v.length !== 2) return null;
  const family = tolerate(() => raw.resolve(cs.v[0]!));
  const profile = tolerate(() => raw.resolve(cs.v[1]!));
  if (family?.k !== 'name' || family.v !== 'ICCBased' || profile?.k !== 'stream') return null;
  const n = numberEntry(raw, profile.dict, 'N');
  return n === 3 || n === 1 ? n : null;
}

/** What a JPEG's markers before its scan say of how it is to be shown; null where a marker is absent or unreadable. */
interface JpegHeader {
  /** The first frame header's marker (SOF0 0xC0 ... SOF15 0xCF) and sample precision in bits. */
  frame: { marker: number; precision: number } | null;
  /** How many frame headers come before the scan: one in a JPEG of one frame. */
  frames: number;
  /** The frame header's component count. */
  components: number | null;
  /** The frame header's component ids are R, G and B: a decoder takes the data for RGB, not YCbCr. */
  rgbIds: boolean;
  /** The Adobe APP14 marker's transform: 0 none (RGB, CMYK), 1 YCbCr, 2 YCCK. */
  adobeTransform: number | null;
  /** The EXIF Orientation (tag 0x0112 of IFD0 in APP1), 1 upright. */
  orientation: number | null;
}

const SOF_MARKERS: ReadonlySet<number> = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const ascii = (bytes: Uint8Array, at: number, text: string): boolean =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0));

/** Reads the markers of a JPEG up to its first scan (a cheap scan of the header, never of the picture data). */
function jpegHeader(bytes: Uint8Array): JpegHeader {
  const header: JpegHeader = { frame: null, frames: 0, components: null, rgbIds: false, adobeTransform: null, orientation: null };
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return header;
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at++; // a fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // the scan, or the end
    const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
    const start = at + 4;
    const end = at + 2 + length;
    if (length < 2 || end > bytes.length) break;
    if (SOF_MARKERS.has(marker) && end - start >= 6) {
      header.frame ??= { marker, precision: bytes[start]! };
      header.frames++;
      const n = bytes[start + 5]!;
      header.components = n;
      header.rgbIds = n === 3 && end - start >= 6 + 3 * n && [0, 1, 2].every((i) => bytes[start + 6 + 3 * i] === 'RGB'.charCodeAt(i));
    } else if (marker === 0xee && end - start >= 12 && ascii(bytes, start, 'Adobe')) {
      header.adobeTransform = bytes[start + 11]!;
    } else if (marker === 0xe1 && ascii(bytes, start, 'Exif\0\0')) {
      header.orientation = exifOrientation(bytes.subarray(start + 6, end)) ?? header.orientation;
    }
    at = end;
  }
  return header;
}

/** The Orientation (0x0112) of a TIFF structure's first IFD, as EXIF holds it in APP1; null when it has none. */
function exifOrientation(tiff: Uint8Array): number | null {
  const le = ascii(tiff, 0, 'II');
  if (!le && !ascii(tiff, 0, 'MM')) return null;
  const u16 = (at: number): number => (le ? tiff[at]! | (tiff[at + 1]! << 8) : (tiff[at]! << 8) | tiff[at + 1]!);
  const u32 = (at: number): number => (le ? u16(at) + u16(at + 2) * 65536 : u16(at) * 65536 + u16(at + 2));
  if (tiff.length < 8 || u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return null;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + 12 * i;
    if (entry + 12 > tiff.length) return null;
    if (u16(entry) === 0x0112) return u16(entry + 2) === 3 ? u16(entry + 8) : null; // a SHORT, left in its field
  }
  return null;
}

/** /DecodeParms /ColorTransform of a DCTDecode stream (a dictionary, or one in an array of one), or null when it has none. */
function colorTransform(raw: RawPdf, dict: Dict): number | null {
  let parms = entry(raw, dict, 'DecodeParms');
  if (parms?.k === 'arr' && parms.v.length === 1) {
    const only = parms.v[0]!;
    parms = tolerate(() => raw.resolve(only));
  }
  if (parms?.k !== 'dict') return null;
  return numberEntry(raw, parms.v, 'ColorTransform') ?? null;
}

/**
 * A JPEG stream that may pass through as it is (spec §4.2): a JPEG viewer draws it as the PDF does. Its colour space is
 * DeviceRGB, DeviceGray or a 3- or 1-component ICCBased space, and it has no /Decode, /SMask or /Mask, each of which
 * changes the pixels after the JPEG is decoded. Its one frame header is baseline or progressive (SOF0, SOF2) with 8-bit
 * samples, the JPEGs every viewer reads (M2 final review F10): a 12-bit, lossless, hierarchical or arithmetic-coded one,
 * or one whose frame header cannot be read, is not plain (ruling M3-R31), and pdf.js' pixels of it become a PNG. And its
 * markers show nothing a viewer reads otherwise than a PDF reader:
 * - an EXIF Orientation other than 1, which a viewer may turn the picture by and a PDF reader ignores;
 * - a frame of another number of components than the colour space's;
 * - a /DecodeParms /ColorTransform other than the transform the JPEG's own markers say (the Adobe marker's, else YCbCr
 *   for 3 components unless their ids are R, G, B, else none), which a viewer follows and a PDF reader may not.
 * Other markers it cannot read prove nothing, and leave it to the colour space and the keys.
 */
function isPlainJpeg(raw: RawPdf, dict: Dict, bytes: Uint8Array): boolean {
  const components = plainColourSpace(raw, dict);
  if (components === null || ['Decode', 'SMask', 'Mask'].some((key) => hasValue(raw, dict, key))) return false;
  const header = jpegHeader(bytes);
  const frame = header.frame;
  if (frame === null || header.frames !== 1 || (frame.marker !== 0xc0 && frame.marker !== 0xc2) || frame.precision !== 8) return false;
  if (header.orientation !== null && header.orientation !== 1) return false;
  if (header.components !== null && header.components !== components) return false;
  const declared = colorTransform(raw, dict);
  if (declared === null) return true;
  let own: boolean | null = null; // whether the JPEG's own markers say its colours are transformed
  if (header.adobeTransform !== null) own = header.adobeTransform !== 0;
  else if (header.components !== null) own = header.components === 3 && !header.rgbIds;
  return own === null || own === (declared !== 0);
}

/**
 * Image XObjects of the page whose only filter is DCTDecode: those of its Form XObjects and of its tiling patterns' cells
 * too (ruling M2-R18: PowerPoint's picture and texture fills), and of the forms and patterns in those.
 * `bytes` is the stream's raw data - the original JPEG file, never re-encoded - copied out of the PDF
 * buffer. `plain`: it may pass through as it is (`isPlainJpeg`); one that is not becomes a PNG of pdf.js' pixels.
 * An image, form or pattern that cannot be loaded is skipped. A page index outside the document throws RangeError.
 */
export function jpegStreams(raw: RawPdf, pageIndex: number): { ref: Ref; bytes: Uint8Array; plain: boolean }[] {
  const out: { ref: Ref; bytes: Uint8Array; plain: boolean }[] = [];
  const seen = new Set<number>();
  forEachResources(
    raw,
    pageIndex,
    (resources) => {
      const xobjects = dictEntry(raw, resources, 'XObject');
      if (!xobjects) return;
      for (const value of xobjects.values()) {
        if (value.k !== 'ref' || seen.has(value.v.num)) continue;
        const image = tolerate(() => raw.get(value.v));
        if (image?.k !== 'stream' || nameEntry(raw, image.dict, 'Subtype') !== 'Image' || !isPlainDct(raw, image.dict)) continue;
        seen.add(value.v.num);
        out.push({ ref: value.v, bytes: image.raw.slice(), plain: isPlainJpeg(raw, image.dict, image.raw) });
      }
    },
    true,
  );
  return out;
}
