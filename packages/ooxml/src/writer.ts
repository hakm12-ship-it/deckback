import { linkTarget, type DropReason, type DroppedLinks } from './links';
import type { Emu, OxLink, OxNode, OxSlide } from './model';
import {
  APP_XML,
  contentTypesXml,
  CORE_XML,
  fontPart,
  LAYOUT,
  LAYOUT_RELS,
  MASTER,
  MASTER_RELS,
  MEDIA_TYPES,
  NS_ARP,
  PART,
  presentationRelsXml,
  presentationXml,
  PRES_PROPS,
  REL_TYPE,
  relsXml,
  ROOT_RELS,
  SLIDE_LAYOUT_REL,
  slidePart,
  slideRelsPart,
  SP_TREE_GROUP,
  THEME,
  type EmbeddedTypeface,
  type FontStyle,
  type MediaExt,
  type MediaMime,
  type Rel,
} from './parts';
import { pictureXml } from './pictures';
import { connectorXml, fillXml, shapeXml, type SlideRels } from './shapes';
import { textBoxXml } from './text';
import { textNode, XML_DECLARATION } from './xml';
import { PackageZip, type ReservedEntry } from './zip';

export type { FontStyle, MediaMime } from './parts';
export type { DroppedLinks } from './links';

/** The smallest and largest slide side PowerPoint accepts, in EMU: 1 in (72 pt) and 56 in (4032 pt). */
export const SLIDE_EMU_MIN: Emu = 914400;
export const SLIDE_EMU_MAX: Emu = 51206400;

/**
 * A media key names its part, `ppt/media/<key>.<ext>`: in practice the SHA-256 of the bytes, lower-case hex. Lower case
 * only, because part names compare without case: two keys differing in case would name one part twice.
 */
const MEDIA_KEY = /^[0-9a-z_-]+$/;

const utf8 = new TextEncoder();

function isSlideSide(emu: number): boolean {
  return Number.isInteger(emu) && emu >= SLIDE_EMU_MIN && emu <= SLIDE_EMU_MAX;
}

function extensionOf(mime: MediaMime): MediaExt {
  const type = MEDIA_TYPES.find((t) => t.mime === mime);
  if (type === undefined) throw new Error(`unsupported media type ${String(mime)}`);
  return type.ext;
}

/** The kinds of dropped link, each a count of `DroppedLinks`. */
const DROP_REASONS: readonly DropReason[] = ['url', 'scheme', 'slide'];

/**
 * Writes a PPTX as it goes: the fixed parts at construction, each slide, each picture and each embedded font into the zip
 * when it is added, the presentation (which lists the slides and the fonts) and `[Content_Types].xml` at `finish`. The
 * zip's entry order is that of the calls; the same calls give the same bytes.
 *
 * The deck's slide count is given up front (ruling M3-R15), so every link is settled when its slide is added and the
 * writer keeps nothing of a slide once `addSlide` returns.
 */
export class PptxWriter {
  private readonly zip = new PackageZip();
  private readonly size: readonly [Emu, Emu];
  /** The number of slides the deck has, as given. */
  private readonly slideCount: number;
  private readonly presentation: ReservedEntry;
  private readonly presentationRels: ReservedEntry;
  private readonly media = new Map<string, MediaMime>();
  /** The typefaces of the embedded fonts, by their name as written, in the order first added. */
  private readonly typefaces = new Map<string, EmbeddedTypeface>();
  /** The number of fonts embedded so far. */
  private fonts = 0;
  /** The number of slides added so far. */
  private added = 0;
  private readonly dropped: Record<DropReason, number> = { url: 0, scheme: 0, slide: 0 };
  private finished = false;

  /**
   * `sizeEmu`: the slide width and height, integers in 914400..51206400. `slideCount`: the number of slides the deck
   * will have, a whole number from 0; links to slides 1..slideCount are written, others dropped. A RangeError otherwise.
   */
  constructor(sizeEmu: [Emu, Emu], slideCount: number) {
    const [cx, cy] = sizeEmu;
    if (!isSlideSide(cx) || !isSlideSide(cy)) {
      throw new RangeError(`slide size ${cx} x ${cy} EMU: each side must be an integer in ${SLIDE_EMU_MIN}..${SLIDE_EMU_MAX}`);
    }
    if (!Number.isInteger(slideCount) || slideCount < 0) throw new RangeError(`slide count ${slideCount}: a whole number from 0`);
    this.size = [cx, cy];
    this.slideCount = slideCount;
    this.add(PART.rootRels, ROOT_RELS);
    this.add(PART.core, CORE_XML);
    this.add(PART.app, APP_XML);
    this.presentation = this.zip.reserve(PART.presentation);
    this.presentationRels = this.zip.reserve(PART.presentationRels);
    this.add(PART.presProps, PRES_PROPS);
    this.add(PART.theme, THEME);
    this.add(PART.master, MASTER);
    this.add(PART.masterRels, MASTER_RELS);
    this.add(PART.layout, LAYOUT);
    this.add(PART.layoutRels, LAYOUT_RELS);
  }

  /**
   * Stores a picture as `ppt/media/<key>.<ext>`. Its bytes are compressed into the zip now and not kept. A key already
   * added is skipped (the key names the bytes); the same key with another type is an error.
   */
  addMedia(key: string, bytes: Uint8Array, mime: MediaMime): void {
    this.assertOpen();
    if (!MEDIA_KEY.test(key)) throw new Error(`media key ${JSON.stringify(key)} is not lower-case letters, digits, - or _`);
    const known = this.media.get(key);
    if (known !== undefined) {
      if (known !== mime) throw new Error(`media key ${key} was added as ${known}, not ${mime}`);
      return;
    }
    const ext = extensionOf(mime);
    this.media.set(key, mime);
    this.zip.add(`ppt/media/${key}.${ext}`, bytes);
  }

  /**
   * Embeds a font (spec §7): `fntdata`, the font as PowerPoint reads one (an EOT), is `ppt/fonts/font<n>.fntdata`, n
   * counting up from 1, compressed into the zip now and not kept. The presentation lists it as the `style` of each of
   * `typefaces`, the names its runs are written with (`a:latin`, `a:ea`): each made safe for XML as a run's is, and
   * listed once. False, and nothing written, when one of them has a font of that style already. A list that leaves no
   * typeface is an error, in fixed words (the names are the deck's).
   */
  addFont(fntdata: Uint8Array, typefaces: readonly string[], style: FontStyle): boolean {
    this.assertOpen();
    const faces = [...new Set(typefaces.map(textNode))].filter((face) => face !== '');
    if (faces.length === 0) throw new Error('no typeface to embed a font as');
    if (faces.some((face) => this.typefaces.get(face)?.styles[style] !== undefined)) return false;
    const n = ++this.fonts;
    this.zip.add(fontPart(n), fntdata);
    for (const face of faces) {
      let entry = this.typefaces.get(face);
      if (entry === undefined) {
        entry = { typeface: face, styles: {} };
        this.typefaces.set(face, entry);
      }
      entry.styles[style] = n;
    }
    return true;
  }

  /**
   * The links dropped so far (links.ts), by why: `url`, `scheme`, `slide`. Each is counted when its slide is added, so
   * the count is complete once the last slide is. A copy, not a live view.
   */
  get droppedLinks(): DroppedLinks {
    return { ...this.dropped };
  }

  /**
   * Writes the next slide and its relationships at once. The pictures it uses must have been added before; a slide it
   * links to may come later. The slide is built whole before anything is written, so a refused slide (one past the
   * slide count among them) leaves the writer as it was.
   */
  addSlide(slide: OxSlide): void {
    this.assertOpen();
    const n = this.added + 1;
    if (n > this.slideCount) throw new Error(`slide ${n} is one more than the ${this.slideCount} slides the deck was given`);
    const rels = new SlideRelationships((key) => {
      const mime = this.media.get(key);
      if (mime === undefined) throw new Error(`media key ${JSON.stringify(key)} was not added before the slide that uses it`);
      return extensionOf(mime);
    }, this.slideCount);
    const xml = slideXml(slide, rels);
    this.added = n;
    this.add(slidePart(n), xml);
    this.add(slideRelsPart(n), relsXml(rels.list));
    for (const reason of DROP_REASONS) this.dropped[reason] += rels.dropped[reason];
  }

  /**
   * Writes the presentation and `[Content_Types].xml` and returns the package. A deck with fewer slides than it was
   * given is an error here (the writer stays open for the rest).
   */
  finish(): Uint8Array {
    this.assertOpen();
    if (this.added !== this.slideCount) throw new Error(`the deck was given ${this.slideCount} slides, but ${this.added} were added`);
    this.finished = true;
    this.presentation.write(utf8.encode(presentationXml(this.size, this.slideCount, [...this.typefaces.values()])));
    this.presentationRels.write(utf8.encode(presentationRelsXml(this.slideCount, this.fonts)));
    this.add(PART.contentTypes, contentTypesXml(this.slideCount, new Set(this.media.values()), this.fonts > 0));
    return this.zip.finish();
  }

  private add(name: string, xml: string): void {
    this.zip.add(name, utf8.encode(xml));
  }

  private assertOpen(): void {
    if (this.finished) throw new Error('the PptxWriter is finished');
  }
}

/**
 * The relationships of one slide: its layout as rId1, then one per picture or link target, numbered from rId2 in the
 * order the nodes first use them (z-order, then document order within a node). A dropped link takes no number.
 */
class SlideRelationships implements SlideRels {
  readonly list: Rel[] = [SLIDE_LAYOUT_REL];
  /** The links dropped, one per link (a node's), by why. */
  readonly dropped: Record<DropReason, number> = { url: 0, scheme: 0, slide: 0 };
  private readonly ids = new Map<string, string>();

  /**
   * `extensionOf(key)`: the extension of media `key`'s part; it throws for a key the writer does not have.
   * `slideCount`: the deck's slide count; a link to a slide past it is dropped.
   */
  constructor(
    private readonly extensionOf: (key: string) => MediaExt,
    private readonly slideCount: number,
  ) {}

  media(key: string): string {
    return this.add(REL_TYPE.image, `../media/${key}.${this.extensionOf(key)}`, false);
  }

  link(link: OxLink): string | null {
    const target = linkTarget(link, this.slideCount);
    if (typeof target === 'string') {
      this.dropped[target]++;
      return null;
    }
    return this.add(target.type, target.target, target.external);
  }

  private add(type: string, target: string, external: boolean): string {
    const key = `${type}\n${target}`;
    let id = this.ids.get(key);
    if (id === undefined) {
      id = `rId${this.list.length + 1}`;
      this.ids.set(key, id);
      this.list.push({ id, type, target, external });
    }
    return id;
  }
}

function nodeXml(node: OxNode, id: number, rels: SlideRels): string | null {
  switch (node.kind) {
    case 'shape':
      return shapeXml(node, id, rels);
    case 'line':
      return connectorXml(node, id, rels);
    case 'text':
      return textBoxXml(node, id, rels);
    case 'picture':
      return pictureXml(node, id, rels);
  }
}

/**
 * The slide: its background, then its nodes in z-order, `cNvPr` ids counting up from 2 over the nodes written. The
 * background is `p:bg/p:bgPr` (CT_BackgroundProperties: the fill, then the effects, an empty `a:effectLst` as PowerPoint
 * writes it), first in `p:cSld`; none without one, so the master's (noFill, `MASTER`) shows (ruling M3-R52). Its
 * relationship, a picture's, comes before the nodes'.
 */
function slideXml(slide: OxSlide, rels: SlideRels): string {
  const bg = slide.background === null ? '' : `<p:bg><p:bgPr>${fillXml(slide.background, rels)}<a:effectLst/></p:bgPr></p:bg>`;
  let tree = '';
  let id = 2;
  for (const node of slide.nodes) {
    const xml = nodeXml(node, id, rels);
    if (xml === null) continue;
    tree += xml;
    id++;
  }
  return (
    `${XML_DECLARATION}<p:sld ${NS_ARP}><p:cSld>${bg}<p:spTree>${SP_TREE_GROUP}${tree}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

/**
 * The whole deck at once, of `slides.length` slides: the media first, in map order, then the slides. The links it
 * drops are not reported here: a caller that needs the count uses `PptxWriter` and its `droppedLinks`.
 */
export function writePptx(
  sizeEmu: [Emu, Emu],
  slides: readonly OxSlide[],
  media: ReadonlyMap<string, { bytes: Uint8Array; mime: MediaMime }>,
): Uint8Array {
  const writer = new PptxWriter(sizeEmu, slides.length);
  for (const [key, { bytes, mime }] of media) writer.addMedia(key, bytes, mime);
  for (const slide of slides) writer.addSlide(slide);
  return writer.finish();
}
