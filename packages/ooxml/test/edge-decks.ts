import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import type { Emu, MediaMime, OxConnector, OxFill, OxFrame, OxLineStyle, OxLink, OxNode, OxPath, OxPicture, OxRun, OxShape, OxSlide, OxStop, OxTextBox } from '../src';

/**
 * Odd but legal input for the writer (Review Focus 1), as decks the Open XML validator checks (edge.local.test.ts) and
 * PowerPoint opens (ruling M3-R6: after Task 4, and in Task 12): each must open without repair. Every builder returns
 * the slides and the media `writePptx` takes, at the slide size `EDGE_SIZE`.
 */

/** 13.333 x 7.5 in, PowerPoint's 16:9. */
export const EDGE_SIZE: [Emu, Emu] = [12192000, 6858000];

export interface EdgeDeck {
  slides: OxSlide[];
  media: Map<string, { bytes: Uint8Array; mime: MediaMime }>;
}

const PT = 12700;
const CELL = 1371600; // 1.5 in: a grid of 8 x 4 cells
const LEFT = (EDGE_SIZE[0] - 8 * CELL) / 2;
const TOP = (EDGE_SIZE[1] - 4 * CELL) / 2;
const INSET = 137160;
const SIDE = CELL - 2 * INSET; // 1.2 in

/** The frame of grid cell `i` (8 a row), turned and flipped as `over` says. */
function cell(i: number, over: Partial<OxFrame> = {}): OxFrame {
  return { x: LEFT + (i % 8) * CELL + INSET, y: TOP + Math.floor(i / 8) * CELL + INSET, w: SIDE, h: SIDE, rot: 0, flipH: false, flipV: false, ...over };
}

const solid = (rgb: string, alpha = 100000): OxFill => ({ kind: 'solid', rgb, alpha });
const stop = (pos: number, rgb: string, alpha = 100000): OxStop => ({ pos, rgb, alpha });
const lin = (stops: OxStop[], ang = 0, scaled = false): OxFill => ({ kind: 'grad', stops, shade: { kind: 'lin', ang, scaled }, rotWithShape: true });
const line = (over: Partial<OxLineStyle> = {}): OxLineStyle => ({ w: 3 * PT, fill: solid('1F1F1F'), cap: 'flat', join: 'round', miterLim: 800000, dash: null, ...over });
const path = (cmds: OxPath['cmds'], over: Partial<OxPath> = {}): OxPath => ({ w: 1000, h: 1000, fill: true, stroke: true, cmds, ...over });

/** One slide of nodes, each named `pdf:p<page>:z<i> <kind>` by its place. */
function slide(page: number, nodes: (Omit<OxShape, 'name'> | Omit<OxConnector, 'name'>)[]): OxSlide {
  return { nodes: nodes.map((n, i) => ({ ...n, name: `pdf:p${page}:z${i} ${n.kind === 'line' ? 'line' : 'shape'}` }) as OxNode), background: null };
}

function rect(i: number, fill: OxFill, over: Partial<OxShape> = {}): Omit<OxShape, 'name'> {
  return { kind: 'shape', frame: cell(i), link: null, geom: { kind: 'rect' }, fill, line: null, ...over };
}

function custom(i: number, paths: OxPath[], fill: OxFill, over: Partial<OxShape> = {}): Omit<OxShape, 'name'> {
  return { kind: 'shape', frame: cell(i), link: null, geom: { kind: 'custom', paths }, fill, line: line(), ...over };
}

function connector(frame: OxFrame, style: OxLineStyle, over: Partial<OxConnector> = {}): Omit<OxConnector, 'name'> {
  return { kind: 'line', frame, link: null, line: style, ...over };
}

/** A PNG of RGBA pixels `pixel(x, y)`, 8 bits a channel, filter 0 on every row. */
function png(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const chunk = (type: string, body: Uint8Array): Buffer => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, deflate, filter 0, no interlace
  const raw = Buffer.alloc(height * (1 + 4 * width));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (1 + 4 * width) + 1 + 4 * x);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return new Uint8Array(Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]));
}

/**
 * The shapes deck (Task 3): every geometry (rect, custGeom, line), cap, join and dash, every fill, and every
 * normalisation rule of the writer — a frame of width or height 0, a path with no drawing command (dropped) and a shape
 * left with none (not written), a dash of all zeros (solid) or with a 0 among others (written 1), stops out of order or
 * at one position, a gradient of one stop, numbers outside their ST type range (clamped) — and links to URLs with spaces
 * and non-ASCII and to a slide. The link to a host that is not ASCII is dropped since ruling M3-R61 (.NET cannot read
 * it percent-encoded; the validator reports such a target): its rect is written without one.
 *
 * Slide 1: fills and geometries. Slide 2: lines. Slide 3: links. Slide 4: a line wider than ST_LineWidth (it covers
 * the slide, so it has one of its own).
 */
export function edgeShapesDeck(): EdgeDeck {
  const bytes = png(4, 4, (x, y) => ((x + y) % 2 === 0 ? [0xc0, 0x30, 0x30, 0xff] : [0x30, 0x60, 0xc0, x === 3 ? 0x40 : 0xff]));
  const key = createHash('sha256').update(bytes).digest('hex');
  const media = new Map([[key, { bytes, mime: 'image/png' as const }]]);
  const stretch = (alpha: number, fillRect: [number, number, number, number] = [0, 0, 0, 0]): OxFill => ({ kind: 'blip', media: key, alpha, mode: { kind: 'stretch', fillRect } });

  const triangle = path([['M', 500, 0], ['L', 1000, 1000], ['L', 0, 1000], ['Z']]);
  const curve = path([['M', 0, 500], ['C', 250, 0, 750, 1000, 1000, 500]], { fill: false });

  const fills = slide(1, [
    rect(0, solid('1F4E79')),
    rect(1, solid('1F4E79', 50000)),
    rect(2, solid('C00000', 0), { line: line() }), // alpha 0: only the outline shows
    rect(3, lin([stop(0, 'FF0000'), stop(100000, '0000FF')])),
    // out of order, two at 50000, one below 0 and one above 100000 (clamped); the angle wraps to 18900000, scaled
    rect(4, lin([stop(100000, '0000FF'), stop(50000, 'FFFFFF'), stop(-1000, 'FF0000'), stop(50000, '000000'), stop(120000, '00FF00')], -2700000, true)),
    rect(5, { kind: 'grad', stops: [stop(0, 'FFFF00'), stop(60000, 'FF8000', 60000), stop(100000, '800000')], shade: { kind: 'circle', fillToRect: [50000, 50000, 50000, 50000] }, rotWithShape: false }),
    rect(6, lin([stop(40000, '00A0A0')]), { line: line() }), // one stop: written twice
    rect(7, lin([stop(50000, 'FF0000'), stop(50000, '0000FF')], 5400000)), // two stops at one position: a hard edge
    rect(8, stretch(100000)),
    rect(9, stretch(50000, [10000, 10000, 10000, 10000])),
    rect(10, { kind: 'blip', media: key, alpha: 150000, mode: { kind: 'tile', tx: 0, ty: 0, sx: 50000, sy: 50000 } }), // alpha clamped: no alphaModFix
    rect(11, stretch(0), { line: line() }), // a picture at alpha 0
    custom(12, [triangle, curve], solid('70AD47')),
    // a path that only moves is dropped; the stroke-less path keeps its fill
    custom(13, [path([['M', 100, 100], ['Z']]), path([['M', 0, 0], ['L', 1000, 0], ['L', 1000, 1000], ['Z']], { stroke: false })], solid('ED7D31')),
    custom(14, [path([]), path([['M', 500, 500]]), path([['M', 500, 500], ['Z']])], solid('FF0000')), // no path left: not written
    custom(15, [path([['M', 500, 500], ['L', 500, 500]], { fill: false })], { kind: 'none' }, { line: line({ w: 12 * PT, cap: 'rnd' }) }), // one point: a dot
    custom(16, [path([['M', 0, 0], ['L', SIDE, 0], ['L', SIDE / 2, SIDE], ['Z']], { w: 0, h: 0 })], solid('5B9BD5')), // path in the shape's own EMU
    // a path box past ST_PositiveCoordinate and points past the path's 32-bit space, all clamped to 2147483647: a right
    // triangle filling the frame
    custom(17, [path([['M', 0, 0], ['L', 3e13, 0], ['L', 3e13, 3e13], ['Z']], { w: 3e13, h: 3e13 })], solid('A5A5A5')),
    rect(18, solid('FFC000'), { frame: cell(18, { rot: 2700000 }) }),
    custom(19, [triangle], solid('4472C4'), { frame: cell(19, { rot: -5400000, flipH: true, flipV: true }) }), // rot wraps to 16200000
    custom(20, [triangle], solid('4472C4'), { frame: cell(20, { flipH: true }) }),
    custom(21, [triangle], solid('4472C4'), { frame: cell(21, { flipV: true }) }),
    rect(22, solid('000000'), { frame: cell(22, { w: 0 }), line: line() }), // width 0
    rect(23, solid('000000'), { frame: cell(23, { h: 0 }), line: line() }), // height 0
    rect(24, solid('000000'), { frame: cell(24, { w: 0, h: 0 }), line: line({ w: 8 * PT, cap: 'sq' }) }),
    custom(25, [path([['M', 0, 0], ['L', 500, 0], ['L', 1000, 0]], { h: 0, fill: false })], { kind: 'none' }, { frame: cell(25, { h: 0 }) }),
    // the frame the extent the path draws (as lowering writes a curve): its handles outside, negative and past h
    custom(26, [path([['M', 0, 500], ['C', 0, -300, 1000, -300, 1000, 500], ['C', 1000, 1300, 0, 1300, 0, 500], ['Z']])], lin([stop(0, 'FFC000'), stop(100000, '7030A0')], 5400000)),
    custom(27, [path([['M', 0, 1000], ['C', -200, -400, 1200, -400, 1000, 1000], ['Z']], { stroke: false })], solid('70AD47'), { line: null }),
  ]);

  const across = (i: number, over: Partial<OxFrame> = {}) => cell(i, { y: cell(i).y + SIDE / 2, h: 0, ...over });
  const zigzag = path([['M', 0, 1000], ['L', 250, 0], ['L', 500, 1000], ['L', 750, 0], ['L', 1000, 1000]], { fill: false });
  const lines = slide(2, [
    connector(across(0), line({ w: 12 * PT, cap: 'flat' })), // a zero-height horizontal line, each cap
    connector(across(1), line({ w: 12 * PT, cap: 'rnd' })),
    connector(across(2), line({ w: 12 * PT, cap: 'sq' })),
    connector(cell(3, { x: cell(3).x + SIDE / 2, w: 0 }), line()), // a zero-width vertical line
    connector(cell(4), line()), // top-left to bottom-right
    connector(cell(5, { flipH: true }), line()), // top-right to bottom-left
    connector(cell(6, { flipV: true }), line()), // bottom-left to top-right
    connector(cell(7, { flipH: true, flipV: true }), line()), // bottom-right to top-left
    connector(cell(8, { x: cell(8).x + SIDE / 2, y: cell(8).y + SIDE / 2, w: 0, h: 0 }), line({ w: 10 * PT, cap: 'rnd' })), // zero length: a dot
    connector(across(9), line({ dash: [300000, 100000] })),
    connector(across(10), line({ dash: [300000, 100000, 100000] })), // odd: repeated to pairs
    connector(across(11), line({ dash: [0, 0] })), // all zeros: solid
    connector(across(12), line({ dash: [] })), // empty: solid
    connector(across(13), line({ w: 6 * PT, cap: 'rnd', dash: [-100, 200000] })), // a dash of 0 (and below): written 1, round dots
    connector(across(14), line({ w: 8 * PT, fill: lin([stop(0, 'FF0000'), stop(100000, '0000FF')]) })),
    connector(across(15), line({ fill: { kind: 'none' } })), // paints nothing
    custom(16, [zigzag], { kind: 'none' }, { line: line({ w: 8 * PT, join: 'round' }) }),
    custom(17, [zigzag], { kind: 'none' }, { line: line({ w: 8 * PT, join: 'bevel' }) }),
    custom(18, [zigzag], { kind: 'none' }, { line: line({ w: 8 * PT, join: 'miter', miterLim: 800000 }) }),
    custom(19, [zigzag], { kind: 'none' }, { line: line({ w: 8 * PT, join: 'miter', miterLim: -5 }) }), // lim clamped to 0
    custom(20, [triangle], solid('DDEBF7'), { line: line({ w: 6 * PT, join: 'miter', miterLim: 3e9 }) }), // lim clamped to 2147483647
    custom(21, [triangle], { kind: 'none' }, { line: line({ w: 0 }) }), // width 0: the thinnest line
    custom(22, [curve], { kind: 'none' }, { line: line({ w: 4 * PT, cap: 'sq', dash: [200000, 100000], fill: solid('C00000', 50000) }) }),
    connector(across(23), line({ dash: [300000, 0, 0, 100000] })), // a gap of 0: written 1
  ]);

  const url = (u: string) => ({ kind: 'url', url: u }) as const;
  const links = slide(3, [
    rect(0, solid('DDEBF7'), { link: url('https://example.com/a b/c d.html?q=x y&r=%41%zz') }),
    rect(1, solid('DDEBF7'), { link: url('https://example.com/경로/été?값=\u{1F600}') }),
    rect(2, solid('DDEBF7'), { link: url('https://한국.example/') }), // dropped (ruling M3-R61)
    rect(3, solid('DDEBF7'), { link: url('https://example.com/a b/c d.html?q=x y&r=%41%zz') }), // the same target as z0
    rect(4, { kind: 'none' }, { link: { kind: 'slide', slide: 1 } }), // a hotspot: no fill, no line
    connector(across(5), line(), { link: { kind: 'slide', slide: 2 } }),
    custom(6, [triangle], stretch(100000), { link: url('mailto:someone@example.com?subject=a b') }),
  ]);

  const wide = slide(4, [connector(cell(9, { y: EDGE_SIZE[1] / 2, h: 0 }), line({ w: 30000000, fill: solid('4472C4', 20000) }))]);

  return { slides: [fills, lines, links, wide], media };
}

/** A frame of `w` x `h` pt at (`x`, `y`) pt, turned and flipped as `over` says. */
function pt(x: number, y: number, w: number, h: number, over: Partial<OxFrame> = {}): OxFrame {
  return { x: x * PT, y: y * PT, w: w * PT, h: h * PT, rot: 0, flipH: false, flipV: false, ...over };
}

const INK = solid('1F1F1F');

function r(text: string, over: Partial<OxRun> = {}): OxRun {
  return { text, sz: 1800, b: false, i: false, spc: 0, baseline: 0, fill: INK, line: null, latin: null, ea: null, cs: null, ...over };
}

type Unnamed = Omit<OxTextBox, 'name'> | Omit<OxPicture, 'name'> | Omit<OxShape, 'name'>;

/** One slide of text boxes, pictures and shapes, each named `pdf:p<page>:z<i> <kind>` by its place. */
function mixed(page: number, nodes: Unnamed[]): OxSlide {
  return { nodes: nodes.map((n, i) => ({ ...n, name: `pdf:p${page}:z${i} ${n.kind}` }) as OxNode), background: null };
}

function box(frame: OxFrame, runs: OxRun[], over: Partial<OxTextBox> = {}): Omit<OxTextBox, 'name'> {
  return { kind: 'text', frame, link: null, vert: 'horz', paras: [{ runs, marL: 0, lnSpc: null }], ...over };
}

/**
 * The text deck (Task 4): text boxes, pictures and links with the input PowerPoint might "repair" — control characters
 * and lone surrogates, Korean with Latin, `spc`, `baseline` and `sz` past their extremes (clamped), vertical text, a
 * 10,000-character run, empty runs and boxes (not written), every run fill and an outline, odd typeface names; URLs
 * with spaces and Hangul; a URL `new URL()` rejects, a `javascript:` URL and a link to slide 99 of 3 (all dropped and
 * counted); pictures with `srcRect` (a crop, a negative side), every flip and rotation, and alpha; a box of paragraphs with a
 * margin, line spacing and values past their ranges (M4 Task 1).
 *
 * Slide 1: text. Slide 2: links (one to slide 3, ahead). Slide 3: pictures.
 */
export function edgeTextDeck(): EdgeDeck {
  // quadrants red, green, blue and yellow, and a white mark in the red one: every flip and turn shows
  const bytes = png(8, 8, (x, y) => {
    if (x === 1 && y === 1) return [0xff, 0xff, 0xff, 0xff];
    if (y < 4) return x < 4 ? [0xd0, 0x20, 0x20, 0xff] : [0x20, 0xa0, 0x40, 0xff];
    return x < 4 ? [0x20, 0x40, 0xd0, 0xff] : [0xf0, 0xd0, 0x20, 0xff];
  });
  const key = createHash('sha256').update(bytes).digest('hex');
  const media = new Map([[key, { bytes, mime: 'image/png' as const }]]);
  const pic = (frame: OxFrame, over: Partial<OxPicture> = {}): Omit<OxPicture, 'name'> => ({ kind: 'picture', frame, link: null, media: key, srcRect: null, alpha: 100000, ...over });
  const blip: OxFill = { kind: 'blip', media: key, alpha: 100000, mode: { kind: 'stretch', fillRect: [0, 0, 0, 0] } };
  const url = (u: string): OxLink => ({ kind: 'url', url: u });
  const KO = { latin: 'Calibri', ea: 'Malgun Gothic', cs: 'Arial' };

  const text = mixed(1, [
    // sz past 4000 pt (clamped to 400000): the glyph lies far below the slide
    box(pt(0, 0, 20, 20), [r('.', { sz: 500000 })]),
    box(pt(36, 14, 200, 4), [r('tiny: sz below 1 pt, clamped to 100', { sz: 50 })]),
    box(pt(36, 24, 600, 30), [r('Edge text: Latin, 한글, controls', { sz: 2400, b: true, ...KO })]),
    // the controls XML refuses are dropped; tab is kept; LF and CR are written as spaces (PowerPoint breaks the line at
    // them); a lone surrogate is dropped, a pair kept; LS, PS and NEL are kept
    box(pt(36, 64, 880, 24), [r('ctl[\u0001\u0008\u000B\u000C\u001F] tab[\t] lf[\n] cr[\r] crlf[\r\n] ls[\u2028] ps[\u2029] nel[\u0085] lone[\uD800x\uDC00] pair[\u{1F600}] fffe[\uFFFE\uFFFF]')]),
    box(pt(36, 104, 600, 26), [r('한글 Korean 텍스트 mixed 123', { sz: 2000, ...KO })]),
    box(pt(36, 140, 880, 26), [
      r('Bold ', { sz: 2000, b: true }),
      r(''), // empty: not written
      r('Italic ', { sz: 2000, i: true }),
      r('Both ', { sz: 2000, b: true, i: true }),
      r('\u0002\uDFFF'), // only refused characters: not written
      r('sub', { sz: 2000, baseline: -25000 }),
      r(' super ', { sz: 2000, baseline: 30000 }),
      r('Outline ', { sz: 2400, b: true, fill: { kind: 'none' }, line: line({ w: PT, fill: solid('C00000') }) }),
      r('Gradient ', { sz: 2400, b: true, fill: lin([stop(0, 'FF0000'), stop(100000, '0000FF')]) }),
      r('Picture ', { sz: 2400, b: true, fill: blip }),
      r('Alpha', { sz: 2400, b: true, fill: solid('1F4E79', 40000), line: line({ w: PT / 2, fill: solid('000000'), dash: [300000, 100000] }) }),
    ]),
    // spc past ST_TextPoint (clamped to ±400000): the letters stand 4000 pt apart, one each way off the slide
    box(pt(36, 184, 200, 24), [r('S', { spc: 500000 }), r('pc max')]),
    box(pt(480, 184, 200, 24), [r('spc min', { spc: -500000 })]),
    // kern (ruling M4-R3): 0, and past ST_TextNonNegativePoint (clamped to 400000)
    box(pt(700, 184, 200, 24), [r('WAVE kern 0 ', { kern: 0 }), r('AV max', { kern: 500000 })]),
    // baseline past ST_Percentage (clamped to the int32 range)
    box(pt(36, 220, 400, 24), [r('baseline: '), r('HI', { baseline: 3e9 }), r('LO', { baseline: -3e9 }), r(' end')]),
    box(pt(860, 24, 40, 480), [r('세로 쓰기 縦書き Vertical', { sz: 2000, ...KO })], { vert: 'eaVert' }),
    box(pt(36, 256, 880, 12), [r('The quick brown fox jumps over the lazy dog. 다람쥐 헌 쳇바퀴에 타고파. '.repeat(200).slice(0, 10000), { sz: 800, ...KO })]),
    box(pt(36, 280, 100, 20), []), // no runs: not written
    box(pt(36, 300, 100, 20), [r(''), r('\u0001\uD800')]), // no run left: not written
    box(pt(36, 320, 400, 24), [r('odd typeface names', { latin: 'A&B <"Font">', ea: '', cs: 'Sym\u0001bol' })]),
    box(pt(500, 340, 260, 30), [r('turned 30° and flipped', { sz: 2000 })], { frame: pt(500, 340, 260, 30, { rot: 1800000, flipH: true }) }),
    box(pt(500, 420, 260, 30), [r('flipped vertically', { sz: 2000 })], { frame: pt(500, 420, 260, 30, { flipV: true }) }),
    // paragraphs (M4 Task 1): a margin, exact and percent line spacing past their ranges (clamped), a tab in a run,
    // and a paragraph of nothing written (left out); M4b Task 1: runs of two sizes aligned on the baseline (fontAlgn)
    box(pt(36, 380, 400, 120), [], {
      paras: [
        { runs: [r('•\t', { sz: 2000 }), r('after a tab', { sz: 2000 })], marL: 0, lnSpc: null },
        { runs: [r('small ', { sz: 1200 }), r('large', { sz: 2400 })], marL: PT * 18, lnSpc: null, fontAlgn: 'base' },
        { runs: [r('marL 18 pt, exactly 24 pt', { sz: 2000 })], marL: PT * 18, lnSpc: { kind: 'pts', val: 2400 } },
        { runs: [r(''), r('\u0001')], marL: PT * 9, lnSpc: { kind: 'pts', val: 1000 } },
        { runs: [r('90 %', { sz: 2000 })], marL: 0, lnSpc: { kind: 'pct', val: 90000 } },
        { runs: [r('spcPts past 1584 pt, spcPct past 13200 %, marL past 4032 pt', { sz: 1000 })], marL: 6e7, lnSpc: { kind: 'pts', val: 1e9 } },
        { runs: [r('spcPct past 13200 %', { sz: 1000 })], marL: -5, lnSpc: { kind: 'pct', val: 1e9 } },
      ],
    }),
  ]);

  const links = mixed(2, [
    box(pt(36, 24, 600, 30), [r('Links', { sz: 2400, b: true })]),
    box(pt(36, 70, 600, 24), [r('URL with spaces and 한글', KO)], { link: url('https://example.com/검색 결과?q=한글 텍스트&x=a b') }),
    box(pt(36, 110, 600, 24), [r('to slide 99 of 3 (dropped)')], { link: { kind: 'slide', slide: 99 } }),
    box(pt(36, 150, 600, 24), [r('to slide 3 (ahead)')], { link: { kind: 'slide', slide: 3 } }),
    box(pt(36, 190, 600, 24), [r('to slide 1 (back)')], { link: { kind: 'slide', slide: 1 } }),
    box(pt(36, 230, 600, 24), [r('a URL new URL() rejects (dropped)')], { link: url('https://exa mple.com/') }),
    box(pt(36, 270, 600, 24), [r('mailto with a space')], { link: url('mailto:someone@example.com?subject=a b') }),
    pic(pt(36, 320, 120, 90), { link: url('https://example.com/그림 링크.png') }),
    rect(0, { kind: 'none' }, { frame: pt(200, 320, 120, 90), link: { kind: 'slide', slide: 99 } }), // a hotspot to slide 99: dropped
    // a scheme outside the allowlist (ruling M3-R14): dropped and counted
    box(pt(36, 430, 600, 24), [r('javascript: URL (dropped)')], { link: url('javascript:alert(1)') }),
  ]);

  const turned = (i: number, rot: number, flipH = false, flipV = false) => cell(i, { rot, flipH, flipV });
  const pictures = mixed(3, [
    pic(cell(0)),
    pic(cell(1), { srcRect: [25000, 25000, 0, 0] }), // the bottom-right three quarters
    pic(cell(2), { srcRect: [-25000, 0, -25000, 0] }), // padded left and right: the picture narrower
    pic(cell(3), { srcRect: [0, 0, 0, 0] }),
    pic(turned(4, 0, true)),
    pic(turned(5, 0, false, true)),
    pic(turned(6, 0, true, true)),
    pic(turned(7, 5400000)),
    pic(turned(8, 10800000)),
    pic(turned(9, -5400000)), // wraps to 16200000
    pic(turned(10, 2700000, true, true), { srcRect: [10000, 20000, 30000, 0] }),
    pic(turned(11, 27000000)), // wraps to 5400000
    pic(cell(12), { alpha: 50000 }),
    pic(cell(13), { alpha: 0 }),
    pic(cell(14), { link: { kind: 'slide', slide: 1 } }),
    pic(cell(15, { w: 0 })), // width 0
  ]);

  return { slides: [text, links, pictures], media };
}
