import type { OxPicture } from './model';
import { blipXml, cNvPr, lineXml, presetGeometry, relativeRect, xfrmXml, type SlideRels } from './shapes';

/**
 * A picture as `p:pic` with `cNvPr` id `id`: its `p:blipFill` is the `a:blip` (with `a:alphaModFix` below opaque, as
 * for a picture fill), then `a:srcRect` when it is set (its zero sides left out, each side an ST_Percentage, so a
 * negative side pads), then `a:stretch/a:fillRect`; its `p:spPr` is the frame and the rect preset, then its line
 * (`lineXml`) when it has one (M5 Task 5), else none. Its relationships are added in document order: the link, then the
 * picture.
 */
export function pictureXml(picture: OxPicture, id: number, rels: SlideRels): string {
  const xfrm = xfrmXml(picture.frame);
  const nvPicPr = `<p:nvPicPr>${cNvPr(id, picture, rels)}<p:cNvPicPr/><p:nvPr/></p:nvPicPr>`;
  const srcRect = picture.srcRect === null ? '' : relativeRect('srcRect', picture.srcRect);
  const blipFill = `<p:blipFill>${blipXml(picture.media, picture.alpha, rels)}${srcRect}<a:stretch><a:fillRect/></a:stretch></p:blipFill>`;
  const line = picture.line === undefined || picture.line === null ? '' : lineXml(picture.line, rels);
  return `<p:pic>${nvPicPr}${blipFill}<p:spPr>${xfrm}${presetGeometry('rect')}${line}</p:spPr></p:pic>`;
}
