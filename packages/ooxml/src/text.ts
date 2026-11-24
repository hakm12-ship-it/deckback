import { emojiUnit } from './emoji';
import { runLinkXml } from './links';
import type { OxFontAlign, OxParagraph, OxRun, OxTextBox } from './model';
import { cNvPr, colour, fillXml, int, lineXml, PERCENT, presetGeometry, xfrmXml, type Range, type SlideRels } from './shapes';
import { esc, textNode, xmlChars } from './xml';

/**
 * Text boxes: a `p:sp` with `txBox="1"`, a rect without fill or line, and a `p:txBody` of its paragraphs, an `a:p` each,
 * in order (M4 Task 1: a line of the PDF each, never an `a:br`). The body has no insets and no wrapping, is anchored at
 * the top and does not autofit, so the text stands where the frame puts it; a box's `warp` (M8) is its `a:prstTxWarp`.
 *
 * A paragraph's `a:pPr` is written only when it has something to say: `marL` (not 0) and `fontAlgn` (M4b Task 1: how
 * the runs of a line of several sizes line up, ST_TextFontAlignType; another value is refused, RangeError), then
 * `a:lnSpc` (`a:spcPts` or `a:spcPct`).
 *
 * A run is an `a:r` whose `a:rPr` says everything (no `p:style`): lang, size, bold, italic, its kern where it has one
 * (ruling M4-R3, which supersedes M3-R7: `kern="0"` where the PDF shows no pair kerning; without one the template's
 * `kern="1200"` stays), spacing and baseline, then its outline, its fill and its typefaces (a symbol font's run, M8:
 * `a:sym` after them, in which PowerPoint draws its U+F000 + code characters). A box's link is on its
 * `p:cNvPr`; a run's own (M5 Task 5, ruling M3-R1) is its `a:hlinkClick` after its typefaces (`runLinkXml`, in the run's
 * own colour), and then its `a:uFill` is no fill: PowerPoint underlines a linked run whatever `u` says, and an underline
 * the PDF shows is a shape of its own (measured on atlas text/14: the same pixels, and the same PDF export, as the run
 * without a link). A run's link that is dropped (links.ts) leaves the run as it would be without one.
 *
 * A list label's paragraph (`OxParagraph.label`, ruling M5-R15: lowering says which) whose first character PowerPoint's
 * PDF export would draw as a picture in a run (M5 Task 5: `emojiUnit`, measured; ▶ in atlas text/25 and text/26) has it
 * as its bullet instead (`a:buChar`, in its run's colour, size and first typeface: PowerPoint exports a bullet as a
 * glyph of text), and the rest of the run after it, a space where nothing is left (PowerPoint draws no bullet on an
 * empty paragraph). PowerPoint lays the text after an inline bullet where the run's own advance put it (measured: the
 * same ends to 0.01 pt). Only a plain character: one unit (`emojiUnit`: no part of an emoji sequence), its run
 * solid-filled with no outline, link, spacing, rise, bold or italic (a bullet takes none of them), and with a typeface.
 * Any other character stays in `a:t` (`paragraphBullet` tells which become bullets).
 *
 * A paragraph's `a:endParaRPr` takes its last written run's lang, size, bold, italic and typefaces, as PowerPoint
 * writes it: the paragraph mark's font is in PowerPoint's line height, so a mark in the theme's font draws the first
 * baseline elsewhere (Task 8 measured up to 2.1 pt for Gothic A1 at 36 pt), and lowering's baseline calibration, whose
 * deck holds exactly these text boxes (`test/calibration-text-box.json`, ruling M3-R37), assumes the run's font alone.
 * An empty typeface (or one XML leaves nothing of) is not written, on a run or on the mark.
 *
 * Normalisation, so that odd but legal input gives a file PowerPoint opens without repair (Review Focus 1):
 * - the text drops the characters XML refuses (C0 controls but tab, LF and CR; U+FFFE, U+FFFF; lone surrogates);
 * - LF and CR are written as a space each: PowerPoint breaks the line at an LF in `a:t` (and XML reads a CR as LF),
 *   and a run is one line (seen in the edge-text deck, ruling M3-R6);
 * - a run left with no text is not written, a paragraph left with no run is not written, and a box left with no
 *   paragraph is not written (it takes no `cNvPr` id and adds no relationship);
 * - `sz`, `kern`, `spc` and `baseline` are rounded half away from zero and clamped to ST_TextFontSize,
 *   ST_TextNonNegativePoint, ST_TextPoint and ST_Percentage; so are `marL` (ST_TextMargin), `spcPts` (ST_TextSpacingPoint) and `spcPct` (ST_TextSpacingPercent);
 *   NaN is refused (RangeError).
 */

/** ST_TextFontSize: 1 to 4000 pt, in 100ths of a point. */
const FONT_SIZE: Range = { min: 100, max: 400000 };
/** ST_TextNonNegativePoint: 0 to 4000 pt, in 100ths of a point (`kern`). */
const NON_NEGATIVE_POINT: Range = { min: 0, max: 400000 };
/** ST_TextPoint: -4000 to 4000 pt, in 100ths of a point (`spc`). */
const TEXT_POINT: Range = { min: -400000, max: 400000 };
/** ST_TextMargin: 0 to 51206400 EMU (`marL`). */
const TEXT_MARGIN: Range = { min: 0, max: 51206400 };
/** ST_TextSpacingPoint: 0 to 1584 pt, in 100ths of a point (`spcPts`). */
const SPACING_POINT: Range = { min: 0, max: 158400 };
/** ST_TextSpacingPercent: 0 to 13200 %, in 1000ths of a percent (`spcPct`). */
const SPACING_PERCENT: Range = { min: 0, max: 13200000 };

/**
 * Hangul, by block: Jamo, Compatibility Jamo, Jamo Extended-A, Syllables, Jamo Extended-B and the halfwidth jamo. Fixed
 * ranges rather than `\p{Script=Hangul}`, whose extent follows each engine's Unicode version.
 */
const HANGUL = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힣ힰ-퟿ﾠ-ￜ]/;

/** The characters PowerPoint draws as a line break inside a run's `a:t`. */
const LINE_BREAK = /[\n\r]/g;

/**
 * A run's text as the writer keeps it, before escaping: each LF and CR a space, the characters XML refuses dropped
 * (`xmlChars`). A run whose kept text is empty is not written, and a box with no run left is not written either: lowering
 * filters its runs by this, so that the report counts only what is written (final review F5).
 */
export function keptText(text: string): string {
  return xmlChars(text.replace(LINE_BREAK, ' '));
}

/** A run as it is written: its text as kept (`keptText`) and made safe for XML, and its language. */
interface Written {
  run: OxRun;
  kept: string;
  text: string;
  lang: 'ko-KR' | 'en-US';
}

/** A run of kept text `kept` as it is written. */
const writtenOf = (run: OxRun, kept: string): Written => ({ run, kept, text: esc(kept), lang: HANGUL.test(kept) ? 'ko-KR' : 'en-US' });

function typeface(tag: 'latin' | 'ea' | 'cs', name: string | null): string {
  const face = name === null ? '' : textNode(name);
  return face === '' ? '' : `<a:${tag} typeface="${face}"/>`;
}

/**
 * A symbol font's `a:sym` (M8 round 1a): the font PowerPoint draws a run's symbol characters (U+F000 + the font's code)
 * in, with the pitch and family and the character set (2, SYMBOL_CHARSET) PowerPoint itself writes for Wingdings.
 */
function symXml(name: string | null | undefined): string {
  const face = name === null || name === undefined ? '' : textNode(name);
  return face === '' ? '' : `<a:sym typeface="${face}" pitchFamily="2" charset="2"/>`;
}

function runXml({ run, text, lang }: Written, rels: SlideRels): string {
  const kern = run.kern === undefined || run.kern === null ? '' : `kern="${int(run.kern, NON_NEGATIVE_POINT, 'kerning')}" `;
  const attrs =
    `lang="${lang}" sz="${int(run.sz, FONT_SIZE, 'font size')}" b="${run.b ? 1 : 0}" i="${run.i ? 1 : 0}" ${kern}` +
    `spc="${int(run.spc, TEXT_POINT, 'character spacing')}" baseline="${int(run.baseline, PERCENT, 'baseline')}" dirty="0"`;
  const outline = run.line === null ? '' : lineXml(run.line, rels);
  const fill = fillXml(run.fill, rels);
  const rid = run.link === undefined || run.link === null ? null : rels.link(run.link);
  const link = rid === null ? '' : runLinkXml(run.link!, rid);
  const underline = rid === null ? '' : '<a:uFill><a:noFill/></a:uFill>';
  const body = outline + fill + underline + typeface('latin', run.latin) + typeface('ea', run.ea) + typeface('cs', run.cs) + symXml(run.sym) + link;
  return `<a:r><a:rPr ${attrs}>${body}</a:rPr><a:t>${text}</a:t></a:r>`;
}

/** ST_TextFontAlignType's values. */
const FONT_ALIGNS: ReadonlySet<string> = new Set<OxFontAlign>(['auto', 't', 'ctr', 'base', 'b']);

/** The character a paragraph's bullet is written as (the module comment), or null when it has none. */
export function paragraphBullet(para: OxParagraph): string | null {
  return para.label === true ? (bulletOf(writtenRuns(para.runs))?.bullet.char ?? null) : null;
}

/** A paragraph's `a:pPr`, or nothing when it has no margin, no font alignment, no line spacing and no bullet. */
function pPrXml(para: OxParagraph, bullet: Bullet | null = null): string {
  const marL = int(para.marL, TEXT_MARGIN, 'left margin');
  const fontAlgn = para.fontAlgn ?? null;
  if (fontAlgn !== null && !FONT_ALIGNS.has(fontAlgn)) throw new RangeError('font alignment: not an ST_TextFontAlignType');
  const lnSpc =
    para.lnSpc === null
      ? ''
      : para.lnSpc.kind === 'pts'
        ? `<a:lnSpc><a:spcPts val="${int(para.lnSpc.val, SPACING_POINT, 'line spacing')}"/></a:lnSpc>`
        : `<a:lnSpc><a:spcPct val="${int(para.lnSpc.val, SPACING_PERCENT, 'line spacing')}"/></a:lnSpc>`;
  const body = lnSpc + (bullet === null ? '' : bulletXml(bullet));
  if (marL === 0 && fontAlgn === null && body === '') return '';
  const attrs = (marL === 0 ? '' : ` marL="${marL}"`) + (fontAlgn === null ? '' : ` fontAlgn="${fontAlgn}"`);
  return body === '' ? `<a:pPr${attrs}/>` : `<a:pPr${attrs}>${body}</a:pPr>`;
}

/** A paragraph's runs as they are written: each made safe for XML, with its language; those left with no text dropped. */
function writtenRuns(runs: readonly OxRun[]): Written[] {
  const written: Written[] = [];
  for (const run of runs) {
    const kept = keptText(run.text);
    if (kept !== '') written.push(writtenOf(run, kept));
  }
  return written;
}

/** A paragraph's bullet (the module comment): its character and the run it was the first of. */
interface Bullet {
  char: string;
  run: OxRun;
  typeface: string;
}

/** A paragraph's written runs with its first character as its bullet, where that is one (the module comment), else null. */
function bulletOf(written: readonly Written[]): { bullet: Bullet; runs: Written[] } | null {
  const first = written[0];
  if (first === undefined) return null;
  const char = emojiUnit(first.kept);
  if (char === null) return null;
  const rest = first.kept.slice(char.length);
  const run = first.run;
  if (run.fill.kind !== 'solid' || run.line !== null || (run.link ?? null) !== null || run.b || run.i) return null;
  if (int(run.spc, TEXT_POINT, 'character spacing') !== 0 || int(run.baseline, PERCENT, 'baseline') !== 0) return null;
  const typeface = [run.latin, run.ea, run.cs].map((name) => (name === null ? '' : textNode(name))).find((name) => name !== '');
  if (typeface === undefined) return null;
  const others = written.slice(1);
  const runs = rest !== '' ? [writtenOf(run, rest), ...others] : others.length > 0 ? others : [writtenOf(run, ' ')];
  return { bullet: { char, run, typeface }, runs };
}

/** A bullet's `a:buClr`, `a:buSzPts`, `a:buFont` and `a:buChar` (CT_TextParagraphProperties order, after `a:lnSpc`). */
function bulletXml({ char, run, typeface }: Bullet): string {
  const fill = run.fill as Extract<OxRun['fill'], { kind: 'solid' }>;
  return (
    `<a:buClr>${colour(fill.rgb, fill.alpha)}</a:buClr><a:buSzPts val="${int(run.sz, FONT_SIZE, 'font size')}"/>` +
    `<a:buFont typeface="${typeface}"/><a:buChar char="${esc(char)}"/>`
  );
}

/** A paragraph as `a:p`: its `a:pPr`, its runs and the mark of its last run (`a:endParaRPr`). */
function paragraphXml(para: OxParagraph, kept: Written[], rels: SlideRels): string {
  const bulleted = para.label === true ? bulletOf(kept) : null;
  const written = bulleted === null ? kept : bulleted.runs;
  const last = written.at(-1)!;
  const pPr = pPrXml(para, bulleted === null ? null : bulleted.bullet);
  const runs = written.map((w) => runXml(w, rels)).join('');
  const faces = typeface('latin', last.run.latin) + typeface('ea', last.run.ea) + typeface('cs', last.run.cs);
  const endAttrs = `lang="${last.lang}" sz="${int(last.run.sz, FONT_SIZE, 'font size')}" b="${last.run.b ? 1 : 0}" i="${last.run.i ? 1 : 0}" dirty="0"`;
  const end = faces === '' ? `<a:endParaRPr ${endAttrs}/>` : `<a:endParaRPr ${endAttrs}>${faces}</a:endParaRPr>`;
  return `<a:p>${pPr}${runs}${end}</a:p>`;
}

/**
 * A text box as `p:sp` with `cNvPr` id `id`, or `null` when no paragraph is left to write. Its relationships are added
 * in document order: the link, then each run's outline, fill and link.
 */
export function textBoxXml(box: OxTextBox, id: number, rels: SlideRels): string | null {
  const xfrm = xfrmXml(box.frame);
  for (const para of box.paras) pPrXml(para); // a NaN is refused even in a paragraph that is not written
  const paras = box.paras.map((para) => ({ para, written: writtenRuns(para.runs) })).filter((p) => p.written.length > 0);
  if (paras.length === 0) return null;
  const nvSpPr = `<p:nvSpPr>${cNvPr(id, box, rels)}<p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>`;
  const spPr = `<p:spPr>${xfrm}${presetGeometry('rect')}<a:noFill/></p:spPr>`;
  const warp = box.warp === 'textPlain' ? '<a:prstTxWarp prst="textPlain"><a:avLst/></a:prstTxWarp>' : '';
  const bodyPr = `<a:bodyPr vert="${box.vert}" wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t">${warp}<a:noAutofit/></a:bodyPr>`;
  const body = paras.map(({ para, written }) => paragraphXml(para, written, rels)).join('');
  return `<p:sp>${nvSpPr}${spPr}<p:txBody>${bodyPr}<a:lstStyle/>${body}</p:txBody></p:sp>`;
}
