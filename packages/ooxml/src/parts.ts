import type { Emu } from './model';
import { esc, XML_DECLARATION } from './xml';

/**
 * The fixed parts of a deck: one theme, one slide master and one blank layout, after python-pptx's default template
 * (which PowerPoint opens without repair), cut down: no placeholders, first-level text styles only, and a format scheme
 * of the three entries per list the schema asks for. No dates, no GUIDs; r:ids and part names are sequential.
 */

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
/** The namespace declarations of the PresentationML parts: a (DrawingML), r and p. */
export const NS_ARP = `xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"`;

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
export const REL_TYPE = {
  officeDocument: `${REL}officeDocument`,
  coreProperties: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties',
  extendedProperties: `${REL}extended-properties`,
  slideMaster: `${REL}slideMaster`,
  slideLayout: `${REL}slideLayout`,
  slide: `${REL}slide`,
  theme: `${REL}theme`,
  presProps: `${REL}presProps`,
  image: `${REL}image`,
  hyperlink: `${REL}hyperlink`,
  font: `${REL}font`,
} as const;

const PML = 'application/vnd.openxmlformats-officedocument.presentationml.';
const CONTENT_TYPE = {
  rels: 'application/vnd.openxmlformats-package.relationships+xml',
  xml: 'application/xml',
  presentation: `${PML}presentation.main+xml`,
  presProps: `${PML}presProps+xml`,
  slideMaster: `${PML}slideMaster+xml`,
  slideLayout: `${PML}slideLayout+xml`,
  slide: `${PML}slide+xml`,
  theme: 'application/vnd.openxmlformats-officedocument.theme+xml',
  core: 'application/vnd.openxmlformats-package.core-properties+xml',
  app: 'application/vnd.openxmlformats-officedocument.extended-properties+xml',
  /** An embedded font, `ppt/fonts/font<n>.fntdata`: an EOT, as PowerPoint writes one. */
  font: 'application/x-fontdata',
} as const;

export const PART = {
  rootRels: '_rels/.rels',
  core: 'docProps/core.xml',
  app: 'docProps/app.xml',
  presentation: 'ppt/presentation.xml',
  presentationRels: 'ppt/_rels/presentation.xml.rels',
  presProps: 'ppt/presProps.xml',
  theme: 'ppt/theme/theme1.xml',
  master: 'ppt/slideMasters/slideMaster1.xml',
  masterRels: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
  layout: 'ppt/slideLayouts/slideLayout1.xml',
  layoutRels: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
  contentTypes: '[Content_Types].xml',
} as const;

export const slidePart = (n: number): string => `ppt/slides/slide${n}.xml`;
export const slideRelsPart = (n: number): string => `ppt/slides/_rels/slide${n}.xml.rels`;
/** The n-th embedded font (1-based), as the presentation's relationship names it, and its part. */
const fontTarget = (n: number): string => `fonts/font${n}.fntdata`;
export const fontPart = (n: number): string => `ppt/${fontTarget(n)}`;

/** A style of an embedded font: the children of `p:embeddedFont` after `p:font`, in schema order. */
export const FONT_STYLES = ['regular', 'bold', 'italic', 'boldItalic'] as const;
export type FontStyle = (typeof FONT_STYLES)[number];

/**
 * A typeface of the deck's embedded fonts (`p:embeddedFont`): its name as written (`textNode`), and the embedded font
 * (1-based, as its part `fontPart`) of each of its styles.
 */
export interface EmbeddedTypeface {
  typeface: string;
  styles: Partial<Record<FontStyle, number>>;
}

/** The picture types the writer stores, by the extension of their part (`ppt/media/<key>.<ext>`). */
export const MEDIA_TYPES = [
  { ext: 'png', mime: 'image/png' },
  { ext: 'jpeg', mime: 'image/jpeg' },
] as const;
export type MediaMime = (typeof MEDIA_TYPES)[number]['mime'];
export type MediaExt = (typeof MEDIA_TYPES)[number]['ext'];

export interface Rel {
  id: string;
  type: string;
  target: string;
  /** A target outside the package (a URL): `TargetMode="External"`. */
  external?: boolean;
}

export function relsXml(rels: readonly Rel[]): string {
  const items = rels.map(
    (rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${esc(rel.target)}"${rel.external ? ' TargetMode="External"' : ''}/>`,
  );
  return `${XML_DECLARATION}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
}

export const ROOT_RELS = relsXml([
  { id: 'rId1', type: REL_TYPE.officeDocument, target: PART.presentation },
  { id: 'rId2', type: REL_TYPE.coreProperties, target: PART.core },
  { id: 'rId3', type: REL_TYPE.extendedProperties, target: PART.app },
]);

export const CORE_XML =
  `${XML_DECLARATION}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
  'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
  'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  '<dc:title>deckback</dc:title></cp:coreProperties>';

export const APP_XML =
  `${XML_DECLARATION}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">` +
  '<Application>deckback</Application></Properties>';

export const PRES_PROPS = `${XML_DECLARATION}<p:presentationPr ${NS_ARP}/>`;

const SCHEME_COLOURS: [string, string][] = [
  ['dk1', '000000'],
  ['lt1', 'FFFFFF'],
  ['dk2', '1F497D'],
  ['lt2', 'EEECE1'],
  ['accent1', '4F81BD'],
  ['accent2', 'C0504D'],
  ['accent3', '9BBB59'],
  ['accent4', '8064A2'],
  ['accent5', '4BACC6'],
  ['accent6', 'F79646'],
  ['hlink', '0000FF'],
  ['folHlink', '800080'],
];
const FONTS = '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>';
const PH_FILL = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
const themeLine = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${PH_FILL}<a:prstDash val="solid"/></a:ln>`;

/** The theme: colours and fonts of the template; the format scheme reduced to its three required entries per list. */
export const THEME =
  `${XML_DECLARATION}<a:theme xmlns:a="${NS_A}" name="deckback"><a:themeElements>` +
  `<a:clrScheme name="deckback">${SCHEME_COLOURS.map(([n, rgb]) => `<a:${n}><a:srgbClr val="${rgb}"/></a:${n}>`).join('')}</a:clrScheme>` +
  `<a:fontScheme name="deckback"><a:majorFont>${FONTS}</a:majorFont><a:minorFont>${FONTS}</a:minorFont></a:fontScheme>` +
  '<a:fmtScheme name="deckback">' +
  `<a:fillStyleLst>${PH_FILL.repeat(3)}</a:fillStyleLst>` +
  `<a:lnStyleLst>${themeLine(9525)}${themeLine(25400)}${themeLine(38100)}</a:lnStyleLst>` +
  `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
  `<a:bgFillStyleLst>${PH_FILL.repeat(3)}</a:bgFillStyleLst>` +
  '</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

/** The group shape every shape tree starts with (`cNvPr` id 1; shapes count up from 2). */
export const SP_TREE_GROUP =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const PARA = 'defTabSz="457200" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"';
const TX1 = '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill>';
const MINOR = '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/>';
const MAJOR = '<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/>';
/**
 * The text defaults (the default paragraph and its first level) of the presentation, and of the master for shapes that
 * are not placeholders, which all of the writer's text boxes are. As in the template, text of 12 pt and up is kerned.
 */
const TEXT_DEFAULTS =
  `<a:defPPr><a:defRPr lang="en-US"/></a:defPPr><a:lvl1pPr marL="0" algn="l" ${PARA}>` +
  `<a:defRPr sz="1800" kern="1200">${TX1}${MINOR}</a:defRPr></a:lvl1pPr>`;

/**
 * The master, under every slide that has no `p:bg` of its own (ruling M3-R52 writes one only for a page's opaque solid
 * background). Its background is `noFill` (M3-R55 (b), M4 Task 4): the theme's white (`bgRef idx="1001"` to `bg1`)
 * came back from PowerPoint's PDF export as one more full-page fill on every such slide, while with `noFill` the
 * export has none, and PowerPoint renders the slide on the same white (measured: renders pixel-identical on
 * atlas/backgrounds/03-11 and the A4 decks).
 */
export const MASTER =
  `${XML_DECLARATION}<p:sldMaster ${NS_ARP}><p:cSld><p:bg><p:bgPr><a:noFill/><a:effectLst/></p:bgPr></p:bg>` +
  `<p:spTree>${SP_TREE_GROUP}</p:spTree></p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles>' +
  `<p:titleStyle><a:lvl1pPr algn="ctr" ${PARA}><a:spcBef><a:spcPct val="0"/></a:spcBef><a:buNone/>` +
  `<a:defRPr sz="4400" kern="1200">${TX1}${MAJOR}</a:defRPr></a:lvl1pPr></p:titleStyle>` +
  `<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900" algn="l" ${PARA}><a:spcBef><a:spcPct val="20000"/></a:spcBef>` +
  `<a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="3200" kern="1200">${TX1}${MINOR}</a:defRPr></a:lvl1pPr></p:bodyStyle>` +
  `<p:otherStyle>${TEXT_DEFAULTS}</p:otherStyle></p:txStyles></p:sldMaster>`;

export const MASTER_RELS = relsXml([
  { id: 'rId1', type: REL_TYPE.slideLayout, target: '../slideLayouts/slideLayout1.xml' },
  { id: 'rId2', type: REL_TYPE.theme, target: '../theme/theme1.xml' },
]);

export const LAYOUT =
  `${XML_DECLARATION}<p:sldLayout ${NS_ARP} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${SP_TREE_GROUP}</p:spTree></p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>';

export const LAYOUT_RELS = relsXml([{ id: 'rId1', type: REL_TYPE.slideMaster, target: '../slideMasters/slideMaster1.xml' }]);

/** The r:id of the n-th slide (1-based) in the presentation's relationships, after the master, presProps and theme. */
const slideRid = (n: number) => `rId${3 + n}`;
/** The r:id of the n-th embedded font (1-based) in the presentation's relationships, after the slides. */
const fontRid = (slideCount: number, n: number) => `rId${3 + slideCount + n}`;

/**
 * The presentation. With embedded fonts (`typefaces`, in the order first added), `p:embeddedFontLst` after `p:notesSz`
 * (CT_Presentation's order): a `p:embeddedFont` per typeface, its `p:font` then its styles in schema order, each by its
 * font's r:id. And `embedTrueTypeFonts`, so that PowerPoint keeps them when the deck is saved, with `saveSubsetFonts`,
 * as they are the PDF's subsets.
 */
export function presentationXml(size: readonly [Emu, Emu], slideCount: number, typefaces: readonly EmbeddedTypeface[] = []): string {
  let slides = '';
  // Slide ids start at 256, the smallest the schema allows.
  for (let n = 1; n <= slideCount; n++) slides += `<p:sldId id="${255 + n}" r:id="${slideRid(n)}"/>`;
  let fonts = '';
  for (const { typeface, styles } of typefaces) {
    fonts += `<p:embeddedFont><p:font typeface="${typeface}"/>`;
    for (const style of FONT_STYLES) {
      const n = styles[style];
      if (n !== undefined) fonts += `<p:${style} r:id="${fontRid(slideCount, n)}"/>`;
    }
    fonts += '</p:embeddedFont>';
  }
  return (
    `${XML_DECLARATION}<p:presentation ${NS_ARP}${fonts === '' ? '' : ' embedTrueTypeFonts="1" saveSubsetFonts="1"'}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    (slideCount > 0 ? `<p:sldIdLst>${slides}</p:sldIdLst>` : '') +
    `<p:sldSz cx="${size[0]}" cy="${size[1]}"/><p:notesSz cx="6858000" cy="9144000"/>` +
    (fonts === '' ? '' : `<p:embeddedFontLst>${fonts}</p:embeddedFontLst>`) +
    `<p:defaultTextStyle>${TEXT_DEFAULTS}</p:defaultTextStyle></p:presentation>`
  );
}

/** The presentation's relationships: master, presProps, theme, the slides, then the `fontCount` embedded fonts. */
export function presentationRelsXml(slideCount: number, fontCount = 0): string {
  const rels: Rel[] = [
    { id: 'rId1', type: REL_TYPE.slideMaster, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: REL_TYPE.presProps, target: 'presProps.xml' },
    { id: 'rId3', type: REL_TYPE.theme, target: 'theme/theme1.xml' },
  ];
  for (let n = 1; n <= slideCount; n++) rels.push({ id: slideRid(n), type: REL_TYPE.slide, target: `slides/slide${n}.xml` });
  for (let n = 1; n <= fontCount; n++) rels.push({ id: fontRid(slideCount, n), type: REL_TYPE.font, target: fontTarget(n) });
  return relsXml(rels);
}

/** The relationships every slide starts with: its layout, as rId1. */
export const SLIDE_LAYOUT_REL: Rel = { id: 'rId1', type: REL_TYPE.slideLayout, target: '../slideLayouts/slideLayout1.xml' };

/** `[Content_Types].xml`: a Default per picture type in use and for embedded fonts when there are any, an Override per XML part. */
export function contentTypesXml(slideCount: number, mediaInUse: ReadonlySet<MediaMime>, fonts = false): string {
  const override = (part: string, type: string) => `<Override PartName="/${part}" ContentType="${type}"/>`;
  let xml =
    `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="${CONTENT_TYPE.rels}"/><Default Extension="xml" ContentType="${CONTENT_TYPE.xml}"/>`;
  for (const { ext, mime } of MEDIA_TYPES) if (mediaInUse.has(mime)) xml += `<Default Extension="${ext}" ContentType="${mime}"/>`;
  if (fonts) xml += `<Default Extension="fntdata" ContentType="${CONTENT_TYPE.font}"/>`;
  xml +=
    override(PART.core, CONTENT_TYPE.core) +
    override(PART.app, CONTENT_TYPE.app) +
    override(PART.presentation, CONTENT_TYPE.presentation) +
    override(PART.presProps, CONTENT_TYPE.presProps) +
    override(PART.theme, CONTENT_TYPE.theme) +
    override(PART.master, CONTENT_TYPE.slideMaster) +
    override(PART.layout, CONTENT_TYPE.slideLayout);
  for (let n = 1; n <= slideCount; n++) xml += override(slidePart(n), CONTENT_TYPE.slide);
  return `${xml}</Types>`;
}
