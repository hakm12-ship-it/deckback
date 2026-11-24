import { createHash } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import {
  writePptx,
  type Emu,
  type MediaMime,
  type OxConnector,
  type OxFill,
  type OxFrame,
  type OxLineStyle,
  type OxNode,
  type OxParagraph,
  type OxPicture,
  type OxRun,
  type OxShape,
  type OxSlide,
  type OxTextBox,
} from '../../src';

/** Nodes and slide parts for the serialiser tests (shapes, text, pictures, links). */

export const SIZE: [Emu, Emu] = [12192000, 6858000];
export const FRAME: OxFrame = { x: 12700, y: 25400, w: 1270000, h: 635000, rot: 0, flipH: false, flipV: false };
export const NAVY: OxFill = { kind: 'solid', rgb: '1F4E79', alpha: 100000 };
export const BLACK: OxFill = { kind: 'solid', rgb: '000000', alpha: 100000 };
export const LINE: OxLineStyle = { w: 12700, fill: BLACK, cap: 'flat', join: 'miter', miterLim: 800000, dash: null };

export const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
export const LAYOUT_REL = `<Relationship Id="rId1" Type="${REL}slideLayout" Target="../slideLayouts/slideLayout1.xml"/>`;

/** The bytes of a media file and its key, the SHA-256 of the bytes. */
export const PNG_BYTES = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
export const PNG_KEY = createHash('sha256').update(PNG_BYTES).digest('hex');
export const MEDIA = new Map([[PNG_KEY, { bytes: PNG_BYTES, mime: 'image/png' as MediaMime }]]);

export function shape(over: Partial<OxShape> = {}): OxShape {
  return { kind: 'shape', name: 'pdf:p1:z7 shape', frame: FRAME, link: null, geom: { kind: 'rect' }, fill: NAVY, line: null, ...over };
}

export function connector(over: Partial<OxConnector> = {}): OxConnector {
  return { kind: 'line', name: 'pdf:p1:z8 line', frame: FRAME, link: null, line: LINE, ...over };
}

export function run(text: string, over: Partial<OxRun> = {}): OxRun {
  return { text, sz: 1800, b: false, i: false, spc: 0, baseline: 0, fill: BLACK, line: null, latin: null, ea: null, cs: null, ...over };
}

/** A paragraph of `runs`: no margin and single line spacing but as `over` gives them. */
export function para(runs: OxRun[], over: Partial<OxParagraph> = {}): OxParagraph {
  return { runs, marL: 0, lnSpc: null, ...over };
}

/** A text box of one paragraph of `runs` (`para`); `over.paras` gives it others instead. */
export function textBox(runs: OxRun[], over: Partial<OxTextBox> = {}): OxTextBox {
  return { kind: 'text', name: 'pdf:p1:z3 text', frame: FRAME, link: null, vert: 'horz', paras: [para(runs)], ...over };
}

export function picture(over: Partial<OxPicture> = {}): OxPicture {
  return { kind: 'picture', name: 'pdf:p1:z5 picture', frame: FRAME, link: null, media: PNG_KEY, srcRect: null, alpha: 100000, ...over };
}

/** The shape tree (what follows the group shape) and the relationships of slide `n` of `pptx`. */
export function slidePartsOf(pptx: Uint8Array, n = 1): { tree: string; rels: string } {
  const files = unzipSync(pptx);
  const slide = strFromU8(files[`ppt/slides/slide${n}.xml`]!);
  const tree = /<\/p:grpSpPr>(.*)<\/p:spTree>/s.exec(slide);
  if (tree === null) throw new Error('no shape tree');
  return { tree: tree[1]!, rels: strFromU8(files[`ppt/slides/_rels/slide${n}.xml.rels`]!) };
}

/** The slide parts of a deck of `slides` with MEDIA, the first by default. */
export function slideParts(slides: OxSlide[], n = 1): { tree: string; rels: string } {
  return slidePartsOf(writePptx(SIZE, slides, MEDIA), n);
}

/** The shape tree of a one-slide deck holding `nodes`. */
export function tree(...nodes: OxNode[]): string {
  return slideParts([{ nodes, background: null }]).tree;
}

/** The ids and names of the `p:cNvPr` of a shape tree, the nodes written. */
export function ids(shapeTree: string): string[] {
  return [...shapeTree.matchAll(/<p:cNvPr id="(\d+)" name="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]}`);
}

/** The relationships of a slide as `<id> <type> <target>`, the type its last path segment. */
export function relList(rels: string): string[] {
  return [...rels.matchAll(/Id="(rId\d+)" Type="[^"]*\/(\w+)" Target="([^"]*)"/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
}
