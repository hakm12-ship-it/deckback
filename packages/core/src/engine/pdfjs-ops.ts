import type * as Pdfjs from 'pdfjs-dist';

/**
 * pdf.js operator codes, a verbatim copy of `OPS` from pdfjs-dist 6.5.438 (the version pinned in package.json).
 *
 * Why a copy instead of `export { OPS } from 'pdfjs-dist'`: the walker and its unit tests need the codes
 * synchronously, and importing the non-legacy build under Node prints a warning and loads a second pdf.js,
 * while importing the legacy build here would put it into the browser bundle. `adapter.local.test.ts` checks
 * this table against the `OPS` of the loaded library, so a pdfjs-dist upgrade cannot drift silently.
 */
export const OPS: typeof Pdfjs.OPS = {
  dependency: 1,
  setLineWidth: 2,
  setLineCap: 3,
  setLineJoin: 4,
  setMiterLimit: 5,
  setDash: 6,
  setRenderingIntent: 7,
  setFlatness: 8,
  setGState: 9,
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  closeEOFillStroke: 27,
  endPath: 28,
  clip: 29,
  eoClip: 30,
  beginText: 31,
  endText: 32,
  setCharSpacing: 33,
  setWordSpacing: 34,
  setHScale: 35,
  setLeading: 36,
  setFont: 37,
  setTextRenderingMode: 38,
  setTextRise: 39,
  moveText: 40,
  setLeadingMoveText: 41,
  setTextMatrix: 42,
  nextLine: 43,
  showText: 44,
  showSpacedText: 45,
  nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
  setCharWidth: 48,
  setCharWidthAndBounds: 49,
  setStrokeColorSpace: 50,
  setFillColorSpace: 51,
  setStrokeColor: 52,
  setStrokeColorN: 53,
  setFillColor: 54,
  setFillColorN: 55,
  setStrokeGray: 56,
  setFillGray: 57,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  setStrokeCMYKColor: 60,
  setFillCMYKColor: 61,
  shadingFill: 62,
  beginInlineImage: 63,
  beginImageData: 64,
  endInlineImage: 65,
  paintXObject: 66,
  markPoint: 67,
  markPointProps: 68,
  beginMarkedContent: 69,
  beginMarkedContentProps: 70,
  endMarkedContent: 71,
  beginCompat: 72,
  endCompat: 73,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
  beginGroup: 76,
  endGroup: 77,
  beginAnnotation: 80,
  endAnnotation: 81,
  paintImageMaskXObject: 83,
  paintImageMaskXObjectGroup: 84,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88,
  paintImageMaskXObjectRepeat: 89,
  paintSolidColorImageMask: 90,
  constructPath: 91,
  setStrokeTransparent: 92,
  setFillTransparent: 93,
  rawFillPath: 94,
};

/**
 * pdf.js `ImageKind`, the layouts it decodes pixels to, copied for the same reason as `OPS`. `satisfies` holds it to the
 * library's names; `test/scene/media.test.ts` checks the values against the loaded library.
 */
export const IMAGE_KIND = { GRAYSCALE_1BPP: 1, RGB_24BPP: 2, RGBA_32BPP: 3 } as const satisfies typeof Pdfjs.ImageKind;

/**
 * Throws when `libOps` (the `OPS` of the pdf.js build that was actually loaded) differs from the table above:
 * a code that moved would silently turn every op-list reader into a misreader.
 */
export function assertSameOps(libOps: Readonly<Record<string, number>>): void {
  const mine: Readonly<Record<string, number>> = OPS;
  const names = new Set([...Object.keys(mine), ...Object.keys(libOps)]);
  const diffs = [...names].filter((name) => mine[name] !== libOps[name]);
  if (diffs.length > 0) {
    throw new Error(`pdfjs-ops.ts is out of step with the loaded pdf.js; differing operators: ${diffs.join(', ')}`);
  }
}
