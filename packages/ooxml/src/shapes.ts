import { hlinkClickXml } from './links';
import { PRESET_PATTERNS, type OxConnector, type OxFill, type OxFrame, type OxLineStyle, type OxLink, type OxNode, type OxPath, type OxShape } from './model';
import { textNode } from './xml';

/**
 * Shapes (`p:sp`), connectors (`p:cxnSp`), fills and lines, and what text boxes and pictures share with them (the
 * frame, `p:cNvPr`, the number ranges), in the element order of ECMA-376 Part 1 (the schema the validator checks) and
 * with the attributes in the order PowerPoint writes them. No `p:style` (writer rule 1): every shape says its fill and
 * its line itself.
 *
 * Normalisation, so that odd but legal input gives a file PowerPoint opens without repair (Review Focus 1):
 * - a frame of width or height 0 stays 0, which DrawingML allows; a negative one is refused (RangeError);
 * - a path with no drawing command (`L` or `C`) is dropped, and a shape left with no path is not written;
 * - a dash of all zeros (or of none) is written solid, one of odd length is repeated to pairs, as PDF reads it, and a
 *   dash or gap of 0 in the others is written 1, the least the validator takes;
 * - gradient stops are sorted by position, equal positions kept in input order; one stop is written twice, at 0 and
 *   100000;
 * - every number is rounded half away from zero and clamped to its ST type's range, as the validator's schema has it;
 *   angles wrap into 0..21599999. NaN, which has no place in a range, is refused (RangeError).
 */

/** What a node needs of its slide: a relationship, added on first use, whose r:id it writes. */
export interface SlideRels {
  /** The picture part of media `key`; an error when the writer was not given that key. */
  media(key: string): string;
  /** The target of a link: a URL (external) or a slide of the deck; `null` when the link is dropped (links.ts). */
  link(link: OxLink): string | null;
}

/**
 * The ranges are those of the schema the validator checks (Office 2021), which in places is narrower than ECMA-376's:
 * a size (ST_PositiveCoordinate) goes to 2147483647, not 27273042316900, and a dash stop is at least 1.
 */
export interface Range {
  min: number;
  max: number;
}
/** ST_Coordinate: a position in EMU (`a:off`, `a:tile` tx and ty). */
const COORDINATE: Range = { min: -27273042329600, max: 27273042316900 };
/** ST_PositiveCoordinate: a size in EMU (`a:ext`, `a:path` w and h); the validator stops it at 2147483647. */
const POSITIVE_COORDINATE: Range = { min: 0, max: 2147483647 };
/**
 * A path point (`a:pt`, ST_AdjCoordinate). The validator reads it as text (a number or a guide name) and checks no range;
 * it is held to the 32-bit range of its path's own space, whose w and h stop at 2147483647.
 */
const PATH_COORDINATE: Range = { min: -2147483648, max: 2147483647 };
/** ST_LineWidth: 0 to 1584 pt. */
const LINE_WIDTH: Range = { min: 0, max: 20116800 };
/** ST_PositiveFixedPercentage: 0 to 100 %, in 1000ths of a percent. */
export const FIXED_PERCENT: Range = { min: 0, max: 100000 };
/** ST_PositivePercentage: a non-negative xsd:int. */
const POSITIVE_PERCENT: Range = { min: 0, max: 2147483647 };
/** `a:ds` d and sp: ST_PositivePercentage, which the validator's semantic check wants at least 1. */
const DASH_STOP: Range = { min: 1, max: 2147483647 };
/** ST_Percentage: an xsd:int. */
export const PERCENT: Range = { min: -2147483648, max: 2147483647 };
/** A full turn of ST_Angle / ST_PositiveFixedAngle, in 60000ths of a degree. */
const TURN = 21600000;
/** The largest alpha, opaque: the default, so it is not written. */
const OPAQUE = 100000;

/** `value` rounded half away from zero; NaN is refused. */
function rounded(value: number, what: string): number {
  if (Number.isNaN(value)) throw new RangeError(`${what} is not a number`);
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** `value` as an integer of `range`. */
export function int(value: number, range: Range, what: string): number {
  return Math.min(range.max, Math.max(range.min, rounded(value, what))) + 0; // + 0: no "-0"
}

/** `value` as an angle in 0..21599999: it wraps, so that the direction stays. Infinity has none and is refused. */
function angle(value: number, what: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${what} is not a finite angle`);
  const turned = rounded(value, what) % TURN;
  return (turned < 0 ? turned + TURN : turned) + 0;
}

const RGB = /^[0-9A-Fa-f]{6}$/;

/** `a:srgbClr`, upper case, with `a:alpha` when it is below opaque. */
export function colour(rgb: string, alpha: number): string {
  if (!RGB.test(rgb)) throw new Error(`colour ${JSON.stringify(rgb)} is not RRGGBB`);
  const a = int(alpha, FIXED_PERCENT, 'alpha');
  const val = rgb.toUpperCase();
  return a < OPAQUE ? `<a:srgbClr val="${val}"><a:alpha val="${a}"/></a:srgbClr>` : `<a:srgbClr val="${val}"/>`;
}

/** A CT_RelativeRect (`a:fillRect`, `a:fillToRect`): its sides l, t, r, b, each left out at 0 (the default). */
export function relativeRect(tag: string, sides: readonly [number, number, number, number]): string {
  let attrs = '';
  ['l', 't', 'r', 'b'].forEach((side, i) => {
    const value = int(sides[i]!, PERCENT, `${tag} ${side}`);
    if (value !== 0) attrs += ` ${side}="${value}"`;
  });
  return `<a:${tag}${attrs}/>`;
}

type Grad = Extract<OxFill, { kind: 'grad' }>;
type Blip = Extract<OxFill, { kind: 'blip' }>;
type Patt = Extract<OxFill, { kind: 'patt' }>;

const PATTERN_NAMES: ReadonlySet<string> = new Set(PRESET_PATTERNS);

/** `a:pattFill` (ruling M5-R10): a preset of ST_PresetPatternVal, refused otherwise, and its two colours. */
function pattFill(fill: Patt): string {
  if (!PATTERN_NAMES.has(fill.prst)) throw new Error(`preset pattern ${JSON.stringify(fill.prst)} is not an ST_PresetPatternVal`);
  return `<a:pattFill prst="${fill.prst}"><a:fgClr>${colour(fill.fg.rgb, fill.fg.alpha)}</a:fgClr><a:bgClr>${colour(fill.bg.rgb, fill.bg.alpha)}</a:bgClr></a:pattFill>`;
}

function gradFill(fill: Grad): string {
  if (fill.stops.length === 0) throw new RangeError('a gradient has no stop');
  // Array.prototype.sort is stable: equal positions keep their input order.
  const stops = fill.stops.map((s) => ({ ...s, pos: int(s.pos, FIXED_PERCENT, 'stop position') })).sort((a, b) => a.pos - b.pos);
  // a:gsLst needs two stops at least: one alone is the colour everywhere, from 0 to 100000.
  const written = stops.length === 1 ? [{ ...stops[0]!, pos: 0 }, { ...stops[0]!, pos: FIXED_PERCENT.max }] : stops;
  const gsLst = written.map((s) => `<a:gs pos="${s.pos}">${colour(s.rgb, s.alpha)}</a:gs>`).join('');
  const { shade: s } = fill;
  const shade =
    s.kind === 'lin'
      ? `<a:lin ang="${angle(s.ang, 'gradient angle')}" scaled="${s.scaled ? 1 : 0}"/>`
      : `<a:path path="circle">${relativeRect('fillToRect', s.fillToRect)}</a:path>` + (s.tileRect === undefined ? '' : relativeRect('tileRect', s.tileRect));
  return `<a:gradFill rotWithShape="${fill.rotWithShape ? 1 : 0}"><a:gsLst>${gsLst}</a:gsLst>${shade}</a:gradFill>`;
}

/** `a:blip` of media `key`, with `a:alphaModFix` when `alpha` is below opaque (clamped to 0..100000). */
export function blipXml(key: string, alpha: number, rels: SlideRels): string {
  const rid = rels.media(key);
  const a = int(alpha, FIXED_PERCENT, 'picture alpha');
  return a < OPAQUE ? `<a:blip r:embed="${rid}"><a:alphaModFix amt="${a}"/></a:blip>` : `<a:blip r:embed="${rid}"/>`;
}

function blipFill(fill: Blip, rels: SlideRels): string {
  const blip = blipXml(fill.media, fill.alpha, rels);
  const { mode } = fill;
  const placed =
    mode.kind === 'stretch'
      ? `<a:stretch>${relativeRect('fillRect', mode.fillRect)}</a:stretch>`
      : `<a:tile tx="${int(mode.tx, COORDINATE, 'tile tx')}" ty="${int(mode.ty, COORDINATE, 'tile ty')}" ` +
        `sx="${int(mode.sx, PERCENT, 'tile sx')}" sy="${int(mode.sy, PERCENT, 'tile sy')}" flip="none" algn="tl"/>`;
  return `<a:blipFill rotWithShape="1">${blip}${placed}</a:blipFill>`;
}

/** A fill of EG_FillProperties: `a:noFill`, `a:solidFill`, `a:gradFill`, `a:blipFill` or `a:pattFill`. */
export function fillXml(fill: OxFill, rels: SlideRels): string {
  switch (fill.kind) {
    case 'none':
      return '<a:noFill/>';
    case 'solid':
      return `<a:solidFill>${colour(fill.rgb, fill.alpha)}</a:solidFill>`;
    case 'grad':
      return gradFill(fill);
    case 'blip':
      return blipFill(fill, rels);
    case 'patt':
      return pattFill(fill);
  }
}

const SOLID = '<a:prstDash val="solid"/>';

/**
 * `a:prstDash` solid, or `a:custDash` of the ds/sp pairs, each at least 1: a dash of 0 (a dot, drawn by the cap) becomes
 * the shortest, 1/100000 of the line width, and so does a gap of 0.
 */
function dashXml(dash: readonly number[] | null): string {
  if (dash === null) return SOLID;
  const values = dash.map((v) => int(v, POSITIVE_PERCENT, 'dash'));
  if (values.every((v) => v === 0)) return SOLID; // nothing to draw and no gap: a solid line
  const pairs = (values.length % 2 === 1 ? [...values, ...values] : values).map((v) => int(v, DASH_STOP, 'dash'));
  let stops = '';
  for (let i = 0; i < pairs.length; i += 2) stops += `<a:ds d="${pairs[i]}" sp="${pairs[i + 1]}"/>`;
  return `<a:custDash>${stops}</a:custDash>`;
}

function joinXml(line: OxLineStyle): string {
  switch (line.join) {
    case 'round':
      return '<a:round/>';
    case 'bevel':
      return '<a:bevel/>';
    case 'miter':
      // in lim units as given (ruling M3-R11): 1000ths of a percent, the ratio x 100000 (lim="800000" is 8)
      return `<a:miter lim="${int(line.miterLim, POSITIVE_PERCENT, 'miter limit')}"/>`;
  }
}

/**
 * `a:ln`: w and cap, then the fill, the dash and the join (CT_LineProperties order). No line is an `a:ln` without
 * fill, said outright. A line takes no picture fill (EG_LineFillProperties has none): that is refused.
 */
export function lineXml(line: OxLineStyle | null, rels: SlideRels): string {
  if (line === null) return '<a:ln><a:noFill/></a:ln>';
  if (line.fill.kind === 'blip') throw new Error('a line cannot have a picture fill');
  const w = int(line.w, LINE_WIDTH, 'line width');
  return `<a:ln w="${w}" cap="${line.cap}">${fillXml(line.fill, rels)}${dashXml(line.dash)}${joinXml(line)}</a:ln>`;
}

/** `a:xfrm`: rot, flipH and flipV each only when set, then the offset and the extent. */
export function xfrmXml(frame: OxFrame): string {
  if (frame.w < 0 || frame.h < 0) throw new RangeError(`a frame of ${frame.w} x ${frame.h} EMU: a size cannot be negative`);
  const rot = angle(frame.rot, 'rotation');
  const attrs = (rot !== 0 ? ` rot="${rot}"` : '') + (frame.flipH ? ' flipH="1"' : '') + (frame.flipV ? ' flipV="1"' : '');
  const x = int(frame.x, COORDINATE, 'x');
  const y = int(frame.y, COORDINATE, 'y');
  const cx = int(frame.w, POSITIVE_COORDINATE, 'width');
  const cy = int(frame.h, POSITIVE_COORDINATE, 'height');
  return `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;
}

export const presetGeometry = (prst: 'rect' | 'line'): string => `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>`;

function point(x: number, y: number): string {
  return `<a:pt x="${int(x, PATH_COORDINATE, 'path x')}" y="${int(y, PATH_COORDINATE, 'path y')}"/>`;
}

const draws = (path: OxPath) => path.cmds.some((cmd) => cmd[0] === 'L' || cmd[0] === 'C');

function pathXml(path: OxPath): string {
  let attrs = ` w="${int(path.w, POSITIVE_COORDINATE, 'path width')}" h="${int(path.h, POSITIVE_COORDINATE, 'path height')}"`;
  if (!path.fill) attrs += ' fill="none"';
  if (!path.stroke) attrs += ' stroke="0"';
  let body = '';
  for (const cmd of path.cmds) {
    switch (cmd[0]) {
      case 'M':
        body += `<a:moveTo>${point(cmd[1], cmd[2])}</a:moveTo>`;
        break;
      case 'L':
        body += `<a:lnTo>${point(cmd[1], cmd[2])}</a:lnTo>`;
        break;
      case 'C':
        body += `<a:cubicBezTo>${point(cmd[1], cmd[2])}${point(cmd[3], cmd[4])}${point(cmd[5], cmd[6])}</a:cubicBezTo>`;
        break;
      case 'Z':
        body += '<a:close/>';
        break;
    }
  }
  return `<a:path${attrs}>${body}</a:path>`;
}

/** The geometry of a shape: the rect preset, or a custGeom of the paths that draw; `null` when none does. */
function geometryXml(geom: OxShape['geom']): string | null {
  if (geom.kind === 'rect') return presetGeometry('rect');
  const paths = geom.paths.filter(draws);
  if (paths.length === 0) return null;
  return (
    '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/>' +
    `<a:pathLst>${paths.map(pathXml).join('')}</a:pathLst></a:custGeom>`
  );
}

/** `p:cNvPr` with its id and name, and the node's link as `a:hlinkClick` unless the link is dropped (links.ts). */
export function cNvPr(id: number, node: Pick<OxNode, 'name' | 'link'>, rels: SlideRels): string {
  const head = `<p:cNvPr id="${id}" name="${textNode(node.name)}"`;
  const rid = node.link === null ? null : rels.link(node.link);
  if (node.link === null || rid === null) return `${head}/>`;
  return `${head}>${hlinkClickXml(node.link, rid)}</p:cNvPr>`;
}

/**
 * A shape as `p:sp` with `cNvPr` id `id`, or `null` when it is not written (a custGeom with no path that draws). Its
 * relationships are added in document order: the link, then the fill, then the line's.
 */
export function shapeXml(shape: OxShape, id: number, rels: SlideRels): string | null {
  const xfrm = xfrmXml(shape.frame);
  const geometry = geometryXml(shape.geom);
  if (geometry === null) return null;
  const nvSpPr = `<p:nvSpPr>${cNvPr(id, shape, rels)}<p:cNvSpPr/><p:nvPr/></p:nvSpPr>`;
  const spPr = `<p:spPr>${xfrm}${geometry}${fillXml(shape.fill, rels)}${lineXml(shape.line, rels)}</p:spPr>`;
  return `<p:sp>${nvSpPr}${spPr}</p:sp>`;
}

/** A connector as `p:cxnSp`: the line preset from the frame's top-left to its bottom-right, turned by the flips. */
export function connectorXml(connector: OxConnector, id: number, rels: SlideRels): string {
  const xfrm = xfrmXml(connector.frame);
  const nvCxnSpPr = `<p:nvCxnSpPr>${cNvPr(id, connector, rels)}<p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr>`;
  return `<p:cxnSp>${nvCxnSpPr}<p:spPr>${xfrm}${presetGeometry('line')}${lineXml(connector.line, rels)}</p:spPr></p:cxnSp>`;
}
