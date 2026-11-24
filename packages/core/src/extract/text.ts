import { UnsupportedOpError } from './errors';
import { IDENTITY, toMatrix, type Matrix, type TextParams } from './gstate';

/**
 * The text object of one BT..ET: the text matrix and the line start, kept the way pdf.js `CanvasGraphics` keeps
 * them (`textMatrix` plus the `x`/`y` and `lineX`/`lineY` offsets in its space). Unlike the text state parameters
 * (`TextParams`), this is not part of the graphics state: q/Q do not save it (PDF 9.4.1, as MuPDF does).
 */
export interface TextObject {
  tm: Matrix;
  /** Current point, in the space `tm` maps from. */
  x: number;
  y: number;
  /** Start of the current line, in the same space. */
  lineX: number;
  lineY: number;
}

/** BT. */
export function newTextObject(): TextObject {
  return { tm: IDENTITY, x: 0, y: 0, lineX: 0, lineY: 0 };
}

/** Tm. */
export function setTextMatrix(t: TextObject, m: ArrayLike<number>): void {
  t.tm = toMatrix(m);
  t.x = t.lineX = 0;
  t.y = t.lineY = 0;
}

/** Td (TD and T* are Td with the leading folded in). */
export function moveText(t: TextObject, tx: number, ty: number): void {
  t.x = t.lineX += tx;
  t.y = t.lineY += ty;
}

/** The fields of a pdf.js `showText` glyph object the walker reads; numbers in the run are TJ adjustments. */
export interface PdfjsGlyph {
  unicode: string;
  /** Advance in glyph space (scaled by the font matrix). */
  width: number;
  /** A single-byte code 32: word spacing applies. */
  isSpace: boolean;
  /** Vertical fonts: `[w1y, vx, vy]`, the advance and the position vector of /W2 (PDF 9.7.4.3), per mille. */
  vmetric?: ArrayLike<number> | null;
  /** The glyph's code in the shown string (pdf.js keeps it with `fontExtraProperties`): a composite font's CID under Identity-H. */
  originalCharCode?: number;
}

/** What a vertical font's glyphs fall back on (pdf.js `font.defaultVMetrics`: `[w1y, vx, vy]`, /DW2, per mille). */
export interface VerticalMetrics {
  defaultVMetrics?: ArrayLike<number> | null;
}

export interface PlacedGlyph {
  unicode: string;
  /** Origin (text rise included), in the space `tm` maps from: the glyph's own, also in vertical writing. */
  x: number;
  y: number;
  /** Signed width along x in the same space (horizontal scaling included); in horizontal writing, also its advance. */
  advance: number;
  /** Its code in the shown string (`PdfjsGlyph.originalCharCode`), null where pdf.js gave none that is a whole number. */
  code: number | null;
}

/** A glyph's code (`PlacedGlyph.code`): pdf.js' when it is a whole number from 0, else null. */
const codeOf = (item: PdfjsGlyph): number | null => {
  const code = item.originalCharCode;
  return typeof code === 'number' && Number.isInteger(code) && code >= 0 ? code : null;
};

function isGlyph(item: unknown): item is PdfjsGlyph {
  return typeof item === 'object' && item !== null && typeof (item as { unicode?: unknown }).unicode === 'string';
}

/** A glyph's `[w1y, vx, vy]`: its own, else the font's default at half its width (as pdf.js `_charToGlyph`). */
function vmetricOf(item: PdfjsGlyph, index: number, vertical: VerticalMetrics): [number, number, number] {
  const own = item.vmetric;
  const fallback = vertical.defaultVMetrics;
  const m = own != null ? [own[0], own[1], own[2]] : fallback != null ? [fallback[0], item.width * 0.5, fallback[2]] : [];
  if (m.length !== 3 || !m.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    throw new UnsupportedOpError('showText', `glyph ${index} has no vertical metrics`, 'glyph without vertical metrics');
  }
  return m as [number, number, number];
}

/**
 * Lays out one `showText` run the way pdf.js `showText` / `showType3Text` advance. Horizontal writing:
 *
 *   advance = (width × fontSize × fontMatrix[0] + (charSpacing + (isSpace ? wordSpacing : 0)) × fontDirection)
 *             × hScale × fontDirection
 *
 * and a TJ number n moves by -n × fontSize / 1000 (× hScale × fontDirection). Type 3 fonts follow the same
 * maths with their own font matrix.
 *
 * Vertical writing (`vertical` given): `x` runs down the column, and with `s` = fontSize × fontMatrix[0]:
 *
 *   origin = (t.x - vx × s × hScale × fontDirection, t.y + rise - (x + vy × s) × fontDirection)
 *   x += -w1y × s - (charSpacing + (isSpace ? wordSpacing : 0)) × fontDirection
 *
 * and a TJ number n moves `x` by n × fontSize / 1000. pdf.js then moves its point by -x whatever the direction; a
 * negative size runs up the page in the PDF and in MuPDF, so here the point moves by -x × fontDirection.
 *
 * Returns the glyph origins and the total advance along x and y; the caller moves the text object by them.
 *
 * Throws `UnsupportedOpError` for an item that is neither a glyph nor a finite TJ number, for a glyph without a
 * finite width, and for a vertical one without metrics: skipping any would silently misplace every later glyph.
 */
export function layoutRun(
  t: TextObject,
  items: readonly unknown[],
  params: TextParams,
  fontMatrix: readonly number[],
  vertical: VerticalMetrics | null = null,
): { glyphs: PlacedGlyph[]; advance: number; advanceY: number } {
  const dir = params.fontDirection;
  const hs = params.hScale * dir;
  const widthScale = params.fontSize * (fontMatrix[0] ?? 0.001);
  const glyphs: PlacedGlyph[] = [];
  let x = 0;
  items.forEach((item, i) => {
    if (typeof item === 'number' && Number.isFinite(item)) {
      x += ((vertical !== null ? item : -item) * params.fontSize) / 1000;
      return;
    }
    if (!isGlyph(item)) throw new UnsupportedOpError('showText', `run item ${i} is neither a glyph nor a TJ number`, 'text item the walker cannot read');
    if (!Number.isFinite(item.width)) throw new UnsupportedOpError('showText', `glyph ${i} has no finite width`, 'glyph without a finite width');
    const spacing = params.charSpacing + (item.isSpace ? params.wordSpacing : 0);
    if (vertical !== null) {
      const [w1y, vx, vy] = vmetricOf(item, i, vertical);
      glyphs.push({
        unicode: item.unicode,
        x: t.x - vx * widthScale * hs,
        y: t.y + params.rise - (x + vy * widthScale) * dir,
        advance: item.width * widthScale * hs,
        code: codeOf(item),
      });
      x += -w1y * widthScale - spacing * dir;
      return;
    }
    const advance = item.width * widthScale + spacing * dir;
    glyphs.push({ unicode: item.unicode, x: t.x + x * hs, y: t.y + params.rise, advance: advance * hs, code: codeOf(item) });
    x += advance;
  });
  return vertical !== null ? { glyphs, advance: 0, advanceY: -x * dir } : { glyphs, advance: x * hs, advanceY: 0 };
}
