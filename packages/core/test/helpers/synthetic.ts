import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { repoRoot } from './fixtures';
import { buildPdf, type MiniObject } from './minipdf';

/**
 * One-page synthetic PDFs for the walker's tests against the PyMuPDF oracle, so no fixture file is needed. Every page
 * has the same resources: the font, the shading, the patterns, the images, the forms and the graphics states below, and the
 * same optional content groups.
 */

/** A non-embedded TrueType font with explicit widths for ' ' (278) and 'A'..'C' (667); both engines use /Widths. */
const FONT_WIDTHS = Array.from({ length: 36 }, (_, i) => (i === 0 ? 278 : i >= 33 ? 667 : 500)).join(' ');
const simpleFont = (name: string, widths = FONT_WIDTHS): string =>
  `<< /Type /Font /Subtype /TrueType /BaseFont /${name} /FirstChar 32 /LastChar 67 /Widths [${widths}] /Encoding /WinAnsiEncoding >>`;
/** The same font with a fractional width for every code (0002 §13: MuPDF rounds widths to integers). */
const FRACTIONAL_WIDTHS = Array.from({ length: 36 }, () => '549.8').join(' ');
/**
 * A Type 3 font: a 1:1, an astral and a 1:N ToUnicode mapping, and one that says "no Unicode" (U+0000, as Skia writes,
 * with a glyph name and a code that mean nothing to MuPDF either: 0002 §13).
 */
const TYPE3_TO_UNICODE =
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def ' +
  '1 begincodespacerange <00> <FF> endcodespacerange ' +
  '5 beginbfchar <41> <0041> <42> <0042> <43> <D83DDC4D> <44> <00410042> <FB> <0000> endbfchar ' +
  'endcmap CMapName currentdict /CMap defineresource pop end end';
const type3Font = (proc: number, matrix = '0.001 0 0 0.001 0 0', widths = [600, 700, 800, 900, 500]): string =>
  `<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [${matrix}] /FirstChar 65 /LastChar 251 ` +
  `/Widths [${widths.slice(0, 4).join(' ')} ${'0 '.repeat(182)}${widths[4]}] /Encoding << /Differences [65 /g1 /g2 /g3 /g4 251 /g4F7] >> ` +
  `/CharProcs << ${['g1', 'g2', 'g3', 'g4', 'g4F7'].map((g) => `/${g} ${proc} 0 R`).join(' ')} >> /ToUnicode 27 0 R >>`;
/** A non-embedded vertical font (Identity-V). CID 2 to 4 are A to C, CID 5 a space; `metrics` are its /DW2 and /W2. */
const VERTICAL_TO_UNICODE =
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def /CMapType 2 def ' +
  '1 begincodespacerange <0000> <FFFF> endcodespacerange ' +
  '4 beginbfchar <0002> <0041> <0003> <0042> <0004> <0043> <0005> <0020> endbfchar ' +
  'endcmap CMapName currentdict /CMap defineresource pop end end';
const verticalFont = (cid: number): string =>
  `<< /Type /Font /Subtype /Type0 /BaseFont /DeckbackVertical /Encoding /Identity-V /DescendantFonts [${cid} 0 R] /ToUnicode 36 0 R >>`;
const verticalCid = (metrics: string): string =>
  '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DeckbackVertical /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> ' +
  `/FontDescriptor 37 0 R /DW 600 /CIDToGIDMap /Identity ${metrics} >>`;
/** Big-endian 16-bit fields, as a mesh shading's data reads them (/BitsPerCoordinate 16). */
const be16 = (...values: number[]): number[] => values.flatMap((v) => [v >> 8, v & 255]);
/**
 * The mesh shadings (0002 §16) all decode their coordinates to x 60..220, y 70..180 (user space), so that is their bounds:
 * the patch meshes have control points out to those edges, where the curves themselves stay inside.
 */
const MESH = '/ColorSpace /DeviceGray /BitsPerCoordinate 16 /BitsPerComponent 8 /Decode [60 220 70 180 0 1]';
const MAX = 65535;
/** A free-form mesh (type 4): flag 8 bits, x, y, one gray of 8 bits per vertex. */
const FREE_FORM = Uint8Array.from([0, ...be16(0, 0), 0, 0, ...be16(MAX, 0), 128, 0, ...be16(0, MAX), 255]);
/** A lattice mesh (type 5), two vertices a row: x, y and one gray each. */
const LATTICE = Uint8Array.from([...be16(0, 0), 0, ...be16(MAX, 0), 90, ...be16(0, MAX), 180, ...be16(MAX, MAX), 255]);
/** A Coons patch (type 6): flag, 12 points, 4 colours. The two curves on the left and the top bulge to the edge of the range. */
const COONS_POINTS = [
  ...[10000, 20000, 0, 30000, 0, 40000, 10000, 50000], // up the left side
  ...[20000, MAX, 40000, MAX, 50000, 50000], // along the top
  ...[MAX, 40000, MAX, 30000, 50000, 20000], // down the right side
  ...[40000, 0, 20000, 0], // back along the bottom
];
const COONS = Uint8Array.from([0, ...be16(...COONS_POINTS), 0, 80, 160, 255]);
/** A tensor patch (type 7): the same, and the four inner control points. */
const TENSOR = Uint8Array.from([0, ...be16(...COONS_POINTS, 20000, 20000, 20000, 40000, 40000, 40000, 40000, 20000), 0, 80, 160, 255]);
const GRAY_FUNCTION = '<< /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >>';

const RESOURCES =
  '/Font << /F1 10 0 R /F2 25 0 R /F3 31 0 R /T3 26 0 R /T4 30 0 R /T5 32 0 R /T6 33 0 R /V1 34 0 R /V2 38 0 R /V3 40 0 R >> ' +
  '/Shading << /Sh1 11 0 R /Sh2 46 0 R /Sh3 47 0 R /Sh4 48 0 R /Sh5 50 0 R /Sh6 51 0 R /Sh7 52 0 R /Sh8 53 0 R /Sh9 54 0 R /Sh10 65 0 R /Sh11 67 0 R >> ' +
  '/Pattern << /P1 12 0 R /P2 13 0 R /P3 20 0 R /P4 22 0 R /P5 56 0 R /P6 57 0 R >> ' +
  '/XObject << /Im1 14 0 R /Fm1 15 0 R /Fm2 16 0 R /Fm3 21 0 R /Fm4 24 0 R /Im2 58 0 R /Im3 59 0 R /Im4 60 0 R /Im5 61 0 R /Im6 63 0 R /Fm5 64 0 R /Fm6 66 0 R /Fm7 68 0 R ' +
  '/Fm8 74 0 R /Fm9 75 0 R /Fm10 76 0 R /Fm11 77 0 R /Fm12 83 0 R /Fm13 84 0 R /Fm14 89 0 R /Fm15 90 0 R >> ' +
  '/ExtGState << /GS1 17 0 R /GS2 18 0 R /GS3 23 0 R /GS4 42 0 R /GS5 43 0 R /GS6 44 0 R /GS7 45 0 R /GS8 55 0 R ' +
  '/GS9 69 0 R /GS10 70 0 R /GS11 71 0 R /GS12 72 0 R /GS13 73 0 R /GS14 88 0 R >> ' +
  '/Properties << /OCon 78 0 R /OCoff 79 0 R /MDany 80 0 R /MDoff 81 0 R /MDallOff 82 0 R /MDallOn 85 0 R /MDanyOff 86 0 R /MDve 87 0 R >>';
/** The optional content of every page (0002 §18): /OCon is shown, /OCoff hidden in the default configuration. */
const OC_PROPERTIES = '/OCProperties << /OCGs [78 0 R 79 0 R] /D << /OFF [79 0 R] >> >>';
const SHARED_OBJECTS: MiniObject[] = [
  { num: 10, body: simpleFont('DeckbackTest') },
  { num: 25, body: simpleFont('ABCDEF+DeckbackSubset') }, // /F2: the subset tag is part of the name (0002 §6)
  { num: 31, body: simpleFont('DeckbackFractional', FRACTIONAL_WIDTHS) }, // /F3
  { num: 26, body: type3Font(28) }, // /T3: d1 glyphs, which MuPDF caches
  { num: 27, data: TYPE3_TO_UNICODE },
  { num: 28, data: '1000 0 0 0 1000 1000 d1 0 0 500 500 re f' },
  { num: 29, data: '1000 0 d0 0 0 500 500 re f' },
  { num: 30, body: type3Font(29) }, // /T4: d0 in the inherited colour: MuPDF draws them directly
  { num: 32, body: type3Font(28, '1 0 0 1 0 0', [0.6, 0.7, 0.8, 0.9, 0.5]) }, // /T5: another font matrix
  // /T6: a fractional width (0002 §13: MuPDF cuts a Type 3 width down to an integer per mille).
  { num: 33, body: type3Font(28, '1 0 0 1 0 0', Array<number>(5).fill(0.5498)) },
  { num: 34, body: verticalFont(35) }, // /V1: the default metrics
  { num: 35, body: verticalCid('') },
  { num: 36, data: VERTICAL_TO_UNICODE },
  {
    num: 37,
    body: '<< /Type /FontDescriptor /FontName /DeckbackVertical /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>',
  },
  { num: 38, body: verticalFont(39) }, // /V2: /DW2 and /W2, in both of its forms
  { num: 39, body: verticalCid('/DW2 [700 -800] /W [3 [500]] /W2 [2 [-900 300 800] 4 4 -700 200 600]') },
  { num: 40, body: verticalFont(41) }, // /V3: fractional metrics, which MuPDF rounds (0002 §13)
  { num: 41, body: verticalCid('/DW2 [700.6 -800.6]') },
  {
    num: 11,
    body:
      '<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 300 0] /Extend [true true] ' +
      '/Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >>',
  },
  { num: 12, body: '<< /Type /Pattern /PatternType 2 /Shading 11 0 R >>' },
  {
    num: 13,
    dict: '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10 /Resources << >>',
    data: '1 0 0 rg 0 0 5 5 re f',
  },
  { num: 14, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8', data: '\x10\x20\x30\x40' },
  {
    num: 15,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 50 50] /Matrix [2 0 0 2 10 10] /Resources << /Shading << /Sh1 11 0 R >> >>',
    data: '/Sh1 sh 0 0 1 rg 0 0 100 100 re f',
  },
  {
    num: 16,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency >> /Resources << >>',
    data: '0 1 0 rg 20 20 50 50 re f 1 0 0 RG 20 20 50 50 re S',
  },
  { num: 17, body: '<< /Type /ExtGState /ca 0.5 /CA 0.25 >>' },
  { num: 18, body: '<< /Type /ExtGState /SMask << /Type /Mask /S /Luminosity /G 19 0 R >> >>' },
  {
    num: 19,
    dict: '/Type /XObject /Subtype /Form /BBox [20 30 220 130] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /Shading << /Sh1 11 0 R >> >>',
    data: '/Sh1 sh 0 g 0 0 10 10 re f',
  },
  {
    // A cell holding an image, as PowerPoint writes a picture fill: a 100 x 50 pt fill at (150, 200) is one cell.
    num: 20,
    dict:
      '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 ' +
      '/Matrix [100 0 0 50 150 200] /Resources << /XObject << /Im1 14 0 R >> >>',
    data: '/Im1 Do',
  },
  {
    // A transparency group filled with a tiling pattern: drawn under an alpha, the group's alpha is not the fill's.
    num: 21,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency >> /Resources << /Pattern << /P2 13 0 R >> >>',
    data: '/Pattern cs /P2 scn 200 20 50 50 re f',
  },
  {
    // 50 pt cells: text and image masks no larger than one cell, but across cell boundaries.
    num: 22,
    dict: '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 50 50] /XStep 50 /YStep 50 /Resources << >>',
    data: '1 0 0 rg 0 0 25 25 re f',
  },
  // Every line state a graphics state dictionary can set (0002 §15 line style).
  { num: 23, body: '<< /Type /ExtGState /LW 3 /LC 1 /LJ 2 /ML 7 /D [[4 2] 1] >>' },
  // What a graphics state dictionary may hold that does not end a stretch of text (0002 §5): dropped by pdf.js, ...
  { num: 42, body: '<< /Type /ExtGState /SA true /AIS false /TK false /SM 0.1 >>' },
  { num: 43, body: '<< /Type /ExtGState /FL 2 /TR /Identity /Font [10 0 R 10] >>' }, // ... or passed on.
  { num: 44, body: '<< /Type /ExtGState /OP true /op true /OPM 1 >>' }, // These end one in MuPDF, and pdf.js drops them (0002 §13).
  { num: 45, body: '<< /Type /ExtGState /CA 1 >>' }, // Any of these ends one, whatever it changes.
  {
    // A form with no line state of its own: it strokes with what the page set, and what it changes ends with it.
    num: 24,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Matrix [2 0 0 2 0 0] /Resources << >>',
    data: '10 10 m 40 10 l S 2 J 5 w 10 20 m 40 20 l S',
  },
  // The kinds of shading (0002 §16): /Sh1 is axial and has no bounds; /Sh2 is radial, /Sh3 axial with a /BBox.
  {
    num: 46,
    body: `<< /ShadingType 3 /ColorSpace /DeviceGray /Coords [150 150 0 150 150 80] /Extend [false false] /Function ${GRAY_FUNCTION} >>`,
  },
  {
    num: 47,
    body: `<< /ShadingType 2 /ColorSpace /DeviceGray /Coords [0 0 300 0] /BBox [60 80 200 160] /Extend [true true] /Function ${GRAY_FUNCTION} >>`,
  },
  // /Sh4: function-based, over its /Domain through its /Matrix: 120 x 90 pt at (40, 60).
  {
    num: 48,
    body: '<< /ShadingType 1 /ColorSpace /DeviceGray /Domain [0 1 0 1] /Matrix [120 0 0 90 40 60] /Function 49 0 R >>',
  },
  { num: 49, dict: '/FunctionType 4 /Domain [0 1 0 1] /Range [0 1]', data: '{ add 2 div }' },
  // /Sh5 to /Sh8: a mesh of each type, bounded by their vertices; /Sh9: a mesh that has a /BBox inside those bounds too.
  { num: 50, dict: `/ShadingType 4 /BitsPerFlag 8 ${MESH}`, data: FREE_FORM },
  { num: 51, dict: `/ShadingType 5 /VerticesPerRow 2 ${MESH}`, data: LATTICE },
  { num: 52, dict: `/ShadingType 6 /BitsPerFlag 8 ${MESH}`, data: COONS },
  { num: 53, dict: `/ShadingType 7 /BitsPerFlag 8 ${MESH}`, data: TENSOR },
  { num: 54, dict: `/ShadingType 4 /BitsPerFlag 8 /BBox [100 100 180 150] ${MESH}`, data: FREE_FORM },
  // /Sh11: a mesh whose /BBox is nowhere near its vertices.
  { num: 67, dict: `/ShadingType 4 /BitsPerFlag 8 /BBox [500 500 600 600] ${MESH}`, data: FREE_FORM },
  // No soft mask (/GS2 sets one).
  { num: 55, body: '<< /Type /ExtGState /SMask /None >>' },
  // Shading patterns of a radial and of a mesh shading.
  { num: 56, body: '<< /Type /Pattern /PatternType 2 /Shading 46 0 R >>' },
  { num: 57, body: '<< /Type /Pattern /PatternType 2 /Shading 50 0 R /Matrix [1 0 0 1 20 30] >>' },
  // Images (0002 §16): /Im1 is 2 x 2 gray, /Im2 3 x 5 RGB, /Im3 a stencil of 8 x 8, /Im4 a stencil of one opaque pixel,
  // /Im6 one of a transparent pixel, /Im5 is 2 x 2 with a soft mask of 4 x 4.
  {
    num: 58,
    dict: '/Type /XObject /Subtype /Image /Width 3 /Height 5 /ColorSpace /DeviceRGB /BitsPerComponent 8',
    data: Uint8Array.from({ length: 45 }, (_, i) => (i * 17) & 255),
  },
  {
    num: 59,
    dict: '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ImageMask true /BitsPerComponent 1',
    data: Uint8Array.from([0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f]),
  },
  { num: 60, dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ImageMask true /BitsPerComponent 1', data: Uint8Array.of(0) },
  {
    num: 61,
    dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /SMask 62 0 R',
    data: Uint8Array.of(0x10, 0x20, 0x30, 0x40),
  },
  {
    num: 62,
    dict: '/Type /XObject /Subtype /Image /Width 4 /Height 4 /ColorSpace /DeviceGray /BitsPerComponent 8',
    data: Uint8Array.from({ length: 16 }, (_, i) => i * 16),
  },
  { num: 63, dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ImageMask true /BitsPerComponent 1', data: Uint8Array.of(0x80) },
  {
    // A transparency group: a soft mask that is set when it is drawn belongs to the group, and not to what is inside it.
    num: 64,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency >> /Resources << /Shading << /Sh5 50 0 R >> >>',
    data: '/Sh5 sh',
  },
  {
    // /Sh10: function-based, with a turned /Matrix, a /Domain inside the unit square and a /BBox that cuts the domain.
    num: 65,
    body: '<< /ShadingType 1 /ColorSpace /DeviceGray /Domain [0.2 0.8 0.1 0.9] /Matrix [60 40 -40 60 150 40] /BBox [100 60 250 200] /Function 49 0 R >>',
  },
  {
    // A group that sets a soft mask of its own: that one is in force for what is inside.
    num: 68,
    dict:
      '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency >> ' +
      '/Resources << /Shading << /Sh5 50 0 R >> /ExtGState << /GS2 18 0 R >> >>',
    data: '/GS2 gs /Sh5 sh',
  },
  {
    // The same without the group: what is inside it is masked one by one.
    num: 66,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << /Shading << /Sh5 50 0 R >> >>',
    data: '/Sh5 sh',
  },
  // Blend modes and alphas (0002 §17): /GS9 multiplies, /GS10 screens at ca 0.8, /GS11 is back to normal, /GS12 is ca 0.4,
  // /GS13 a name pdf.js spells with a hyphen, /GS14 an array whose first name is no blend mode.
  { num: 69, body: '<< /Type /ExtGState /BM /Multiply >>' },
  { num: 70, body: '<< /Type /ExtGState /BM /Screen /ca 0.8 >>' },
  { num: 71, body: '<< /Type /ExtGState /BM /Normal >>' },
  { num: 72, body: '<< /Type /ExtGState /ca 0.4 >>' },
  { num: 73, body: '<< /Type /ExtGState /BM /ColorDodge >>' },
  { num: 88, body: '<< /Type /ExtGState /BM [/NoSuchMode /Screen] >>' },
  {
    // A transparency group with text, an alpha and a blend mode of its own, and a group nested in it.
    num: 74,
    dict:
      '/Type /XObject /Subtype /Form /BBox [20 20 280 200] /Group << /S /Transparency >> ' +
      '/Resources << /Font << /F1 10 0 R >> /ExtGState << /GS11 71 0 R /GS12 72 0 R /GS13 73 0 R >> /XObject << /Fm9 75 0 R >> >>',
    data:
      'BT /F1 10 Tf 30 180 Td (A) Tj ET 0 1 0 rg 30 30 40 40 re f /GS12 gs 0 0 1 rg 80 30 40 40 re f ' +
      '/GS13 gs 130 30 40 40 re f /GS11 gs /Fm9 Do',
  },
  {
    // An isolated knockout group, moved by its /Matrix: its /BBox is at 110 105 230 185 on the page.
    num: 75,
    dict:
      '/Type /XObject /Subtype /Form /BBox [100 100 220 180] /Matrix [1 0 0 1 10 5] /Group << /S /Transparency /I true /K true >> ' +
      '/Resources << /Font << /F1 10 0 R >> /ExtGState << /GS1 17 0 R >> >>',
    data: 'BT /F1 10 Tf 110 160 Td (B) Tj ET 1 0 0 rg 100 110 30 30 re f /GS1 gs 1 1 0 rg 150 110 30 30 re f',
  },
  {
    // A transparency group that ends the soft mask inside: the group's own mask still applies to what it holds.
    num: 76,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency >> /Resources << /ExtGState << /GS8 55 0 R >> >>',
    data: '/GS8 gs 0 0 1 rg 10 10 20 20 re f',
  },
  {
    // A transparency group with a small /BBox.
    num: 77,
    dict: '/Type /XObject /Subtype /Form /BBox [40 40 140 120] /Group << /S /Transparency >> /Resources << >>',
    data: '1 0 0 rg 0 0 300 300 re f',
  },
  // Optional content (0002 §18): two groups, and membership dictionaries over them.
  { num: 78, body: '<< /Type /OCG /Name (Shown) >>' },
  { num: 79, body: '<< /Type /OCG /Name (Hidden) >>' },
  { num: 80, body: '<< /Type /OCMD /OCGs [78 0 R 79 0 R] /P /AnyOn >>' }, // shown
  { num: 81, body: '<< /Type /OCMD /OCGs 79 0 R >>' }, // hidden
  { num: 82, body: '<< /Type /OCMD /OCGs [79 0 R] /P /AllOff >>' }, // shown
  // Membership MuPDF 1.28 gets wrong (0002 §13). As the PDF says, and in pdf.js, the first and the third are hidden and the
  // second is shown; MuPDF does the opposite.
  { num: 85, body: '<< /Type /OCMD /OCGs [78 0 R 79 0 R] /P /AllOn >>' },
  { num: 86, body: '<< /Type /OCMD /OCGs [78 0 R 79 0 R] /P /AnyOff >>' },
  { num: 87, body: '<< /Type /OCMD /OCGs [78 0 R] /VE [/Not 78 0 R] >>' },
  {
    // Forms with optional content of their own: hidden, shown, and a hidden transparency group.
    num: 83,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /OC 79 0 R /Resources << >>',
    data: '1 0 0 rg 60 60 20 20 re f',
  },
  {
    num: 84,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /OC 78 0 R /Resources << >>',
    data: '0 0 1 rg 90 60 20 20 re f',
  },
  {
    num: 89,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /OC 81 0 R /Group << /S /Transparency >> /Resources << >>',
    data: '0 1 0 rg 120 60 20 20 re f',
  },
  {
    // A /Group that is no transparency group (0002 §13).
    num: 90,
    dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /NoSuchGroup >> /Resources << >>',
    data: '0 1 0 rg 20 20 50 50 re f',
  },
];

export function syntheticPdf(content: string, page = '/MediaBox [0 0 300 300]'): Uint8Array {
  return buildPdf([
    { num: 1, body: `<< /Type /Catalog /Pages 2 0 R ${OC_PROPERTIES} >>` },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R ${page} /Contents 4 0 R /Resources << ${RESOURCES} >> >>` },
    { num: 4, data: content },
    ...SHARED_OBJECTS,
  ]);
}

/** Writes test output under out/ (git-ignored) and returns its path; `name` is relative to out/. */
export function writeOut(name: string, data: string | Uint8Array): string {
  const file = `${repoRoot}out/${name}`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  return file;
}
