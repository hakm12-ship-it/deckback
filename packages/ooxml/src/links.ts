import type { OxLink } from './model';
import { REL_TYPE } from './parts';

/**
 * Links: a node's `link` becomes an `a:hlinkClick` on its `p:cNvPr` and a relationship of its slide; a run's (M5 Task 5,
 * ruling M3-R1) an `a:hlinkClick` in its `a:rPr` (`runLinkXml`), counted and dropped by the same rules, each run on its
 * own.
 *
 * - A URL is an external hyperlink relationship (`TargetMode="External"`). Its target is the URL as the URL parser
 *   reads it (C0 controls and spaces at either end trimmed, tab, LF and CR removed), percent-encoded as UTF-8 where a
 *   URI may not hold the character, then XML-escaped (`relsXml`). So the target starts with the scheme that was
 *   checked, never as a relative reference (which PowerPoint would open as a file).
 * - A URL that `new URL()` rejects is dropped and counted (`url`). So is one whose scheme is not http, https, ftp,
 *   mailto or tel (`scheme`, ruling M3-R14): `javascript:`, `vbscript:`, `file:`, `data:` and the rest never reach the
 *   deck. So is one whose target, as written (percent-encoded), is longer than `URL_MAX`, and one whose host is not
 *   ASCII or holds a `%` (`url`, ruling M3-R61): .NET's System.Uri cannot read a target of about 65,520 characters or
 *   more, nor a percent-encoded host, and the Open XML SDK replaced such a target silently. pdf.js gives a link's URL as
 *   the URL parser writes it (`href`), its host in ASCII (punycode), so only a URL made by hand has such a host.
 * - A slide link is a slide relationship to `slide<n>.xml` with `action="ppaction://hlinksldjump"`; the part may come
 *   later in the zip, which OPC allows. The writer knows the deck's slide count up front (ruling M3-R15), so a link to
 *   a slide past it is dropped and counted (`slide`, ruling M3-R10) at once. Slide numbers that are not whole numbers
 *   from 1 are malformed input and refused (RangeError), like NaN anywhere else.
 * - A dropped link leaves its node written, without `a:hlinkClick`, and adds no relationship.
 */

/**
 * How many links the writer dropped, by why: `url`, a URL `new URL()` rejects, one longer than `URL_MAX` as written or
 * one whose host is not ASCII; `scheme`, a URL whose scheme is not http, https, ftp, mailto or tel; `slide`, a link to a
 * slide past the deck's last.
 */
export interface DroppedLinks {
  readonly url: number;
  readonly scheme: number;
  readonly slide: number;
}

/** Why a link is dropped: the count of `DroppedLinks` it goes to. */
export type DropReason = keyof DroppedLinks;

/**
 * The longest hyperlink target the writer writes, in characters as written (ruling M3-R61): what browsers and servers
 * commonly take, far below the length .NET's System.Uri refuses (about 65,520).
 */
export const URL_MAX = 2_048;

/** The schemes whose URLs have a host (the URL parser's special schemes among `SCHEMES`). */
const HOSTED: ReadonlySet<string> = new Set(['http:', 'https:', 'ftp:']);

/**
 * The host of `url`, of scheme `protocol` (`URL.protocol`), as written, with its port: what follows the scheme's colon
 * and the slashes or backslashes after it (any number, as the URL parser takes them) and any `user@`, up to the path,
 * query or fragment; '' for a scheme without a host (`mailto:`, `tel:`).
 */
function hostOf(url: string, protocol: string): string {
  if (!HOSTED.has(protocol)) return '';
  const authority = /^[^:]*:[\\/]*([^\\/?#]*)/.exec(url)?.[1] ?? '';
  return authority.slice(authority.lastIndexOf('@') + 1);
}

/** A host .NET's System.Uri cannot read as the writer would write it: not ASCII (percent-encoded then), or with a `%`. */
const UNREADABLE_HOST = /[^\u0000-\u007F]|%/;

/** The URL schemes a link may have (ruling M3-R14), as `URL.protocol` gives them: lower case, with the colon. */
const SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ftp:', 'mailto:', 'tel:']);

/** The relationship a link needs. */
export interface LinkTarget {
  type: string;
  target: string;
  external: boolean;
}

/**
 * `url` as the WHATWG URL parser reads it before parsing: C0 controls and spaces at either end trimmed, and every tab,
 * LF and CR removed. `new URL()` of the result is `new URL(url)`.
 */
function asParsed(url: string): string {
  return url.replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '').replace(/[\t\n\r]/g, '');
}

/** The scheme of `url` as `new URL()` gives it (`"https:"`), or `null` when it rejects the URL. */
function protocolOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** The characters a URI may hold as they are (RFC 3986: unreserved and reserved); `%` only before two hex digits. */
const URI_CHAR = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/;
const PERCENT_ESCAPE = /^%[0-9A-Fa-f]{2}/;

/**
 * `url` as a relationship target (xsd:anyURI): every other character percent-encoded as UTF-8, a space, non-ASCII (the
 * host's too: it stays Unicode, not punycode) and the C0 controls included; a `%` not starting an escape becomes `%25`.
 * A lone surrogate, which has no UTF-8, is dropped. Plain string work, so it is the same in every engine.
 */
function uriReference(url: string): string {
  let out = '';
  let i = 0;
  for (const ch of url) {
    const loneSurrogate = ch.length === 1 && ch >= '\uD800' && ch <= '\uDFFF';
    if (URI_CHAR.test(ch) || (ch === '%' && PERCENT_ESCAPE.test(url.slice(i, i + 3)))) out += ch;
    else if (!loneSurrogate) out += encodeURIComponent(ch);
    i += ch.length;
  }
  return out;
}

/**
 * The relationship `link` needs in a deck of `slideCount` slides, or why it is dropped. A slide number that is not a
 * whole number from 1 is refused (RangeError).
 */
export function linkTarget(link: OxLink, slideCount: number): LinkTarget | DropReason {
  if (link.kind === 'url') {
    const url = asParsed(link.url);
    const protocol = protocolOf(url);
    if (protocol === null) return 'url';
    if (!SCHEMES.has(protocol)) return 'scheme';
    if (UNREADABLE_HOST.test(hostOf(url, protocol))) return 'url';
    const target = uriReference(url);
    if (target.length > URL_MAX) return 'url';
    return { type: REL_TYPE.hyperlink, target, external: true };
  }
  if (!Number.isInteger(link.slide) || link.slide < 1) throw new RangeError(`a link to slide ${link.slide}: slides count from 1`);
  if (link.slide > slideCount) return 'slide';
  return { type: REL_TYPE.slide, target: `slide${link.slide}.xml`, external: false };
}

/**
 * The Office 2019 extension (`ahyp:hlinkClr val="tx"`) that draws a linked run in its own colour: without it PowerPoint
 * draws the run in the theme's hyperlink colour (measured, M5 Task 5).
 */
const OWN_COLOUR =
  '<a:extLst><a:ext uri="{A12FA001-AC4F-418D-AE19-62706E023703}">' +
  '<ahyp:hlinkClr xmlns:ahyp="http://schemas.microsoft.com/office/drawing/2018/hyperlinkcolor" val="tx"/></a:ext></a:extLst>';

/** A run's `a:hlinkClick` for `link` through relationship `rid`: as `hlinkClickXml`, in the run's own colour. */
export function runLinkXml(link: OxLink, rid: string): string {
  const action = link.kind === 'slide' ? ' action="ppaction://hlinksldjump"' : '';
  return `<a:hlinkClick r:id="${rid}"${action}>${OWN_COLOUR}</a:hlinkClick>`;
}

/** `a:hlinkClick` for `link` through relationship `rid`; a slide link jumps (`ppaction://hlinksldjump`). */
export function hlinkClickXml(link: OxLink, rid: string): string {
  const action = link.kind === 'slide' ? ' action="ppaction://hlinksldjump"' : '';
  return `<a:hlinkClick r:id="${rid}"${action}/>`;
}
