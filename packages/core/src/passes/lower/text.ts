import { keptText, type OxFill, type OxFrame, type OxLineSpacing, type OxLineStyle, type OxLink, type OxParagraph, type OxRun, type OxTextBox } from '@deckback/ooxml';
import type { Box } from '../../extract/inventory';
import { typefaces, type FontMap } from '../../fonts/typefaces';
import type { FontInfo, HotspotEl, Rgb, TextLineEl, TextRun } from '../../scene/types';
import { baselineK, DEFAULT_K, descentOf } from '../baseline';
import { gradFill, type Gradient } from '../gradients';
import type { Approximation } from '../report';
import type { AssembledText } from '../text/assemble';
import { SPACE_RULE, textFrame, type TextFrame, type TextLine } from '../text/lines';
import { charSpcs, keptLine, spaceWidth, whole } from '../text/kept';
import { runSpacings, type RunSpacing } from '../text/spacing';
import { emSize, runStyle, type RunStyle } from '../text/style';
import { EPS, glyphsOfChars } from '../text/util';
import type { NameKind } from './shape';
import { direction, EMU_PER_PT, emu, hex, rot, solidFill, type Placement } from './units';

export interface TextCtx {
  place: Placement;
  /** The product of the element's group alphas, folded into its own. */
  alpha: number;
  /** The name of the node of the element. */
  name: (kind: NameKind) => string;
  approximate: (kind: Approximation) => void;
  /**
   * M5 Task 5: a run link (`LinkedText.link`) as the writer's, null where it is not written (a page not converted); the
   * runs are written without links when absent.
   */
  link?: (link: HotspotEl['link']) => OxLink | null;
  /** M6: `ConvertOptions.fontMap`, applied to every typeface written. */
  fontMap?: FontMap;
}

/** What a box is wider than its glyphs' advances (pt), so that PowerPoint's own advances may run a little longer. */
const WIDTH_MARGIN_PT = 2;

/** A skew (the tangent of the lean) up to which text counts as upright. */
const SKEW_TOL = 0.01;

/** PDF's stroke defaults (ISO 32000-2 8.4.1), which the Scene does not record for text: butt cap, miter join, limit 10. */
const TEXT_STROKE = { cap: 'flat', join: 'miter', miterLim: 1000000, dash: null } as const;

const BLACK: Rgb = [0, 0, 0];
const NONE: OxFill = { kind: 'none' };

/** Whether a written run paints nothing: no fill or one at alpha 0, and no outline. */
const paintsNothing = (r: OxRun): boolean => (r.fill.kind === 'none' || (r.fill.kind === 'solid' && r.fill.alpha === 0)) && r.line === null;

/**
 * The gradient a run fills with (its pattern a linear or radial shading), or null. It covers a text run filled with a
 * gradient pattern (Tr 0 / fill+stroke) as well as the Tr 7 / glyph-clip case (`textClipGradients`): one feature, one
 * `a:gradFill` (ruling M5-R8).
 */
function runGradient(run: TextRun): Gradient | null {
  if (run.fillMode !== 'fill' && run.fillMode !== 'fillStroke') return null;
  return run.fill !== null && (run.fill.kind === 'linear' || run.fill.kind === 'radial') ? run.fill : null;
}

/**
 * A run's fill when it fills (`fill`, `fillStroke`), its alpha times the group alphas: its solid colour; for a pattern,
 * its first stop (black for a pattern without stops, a tile, or one pdf.js could not read), recorded `text-pattern-fill`
 * but for a gradient (`runGradient`), whose first stop stands until `lowerText` lays it over its line (`lineGradients`).
 * `a:noFill` when it does not fill.
 */
function runFill(run: TextRun, ctx: TextCtx): OxFill {
  if (run.fillMode !== 'fill' && run.fillMode !== 'fillStroke') return NONE;
  const paint = run.fill;
  if (paint !== null && paint.kind === 'solid') return solidFill({ kind: 'solid', rgb: run.rgb ?? paint.rgb, alpha: run.alpha }, ctx.alpha)!;
  if (runGradient(run) === null) ctx.approximate('text-pattern-fill');
  const stops = paint !== null && (paint.kind === 'linear' || paint.kind === 'radial') ? paint.stops : [];
  const rgb = stops[0]?.rgb ?? run.rgb ?? BLACK;
  return solidFill({ kind: 'solid', rgb, alpha: paint?.alpha ?? run.alpha }, ctx.alpha)!;
}

/**
 * A run's outline when it strokes (`stroke`, `fillStroke`): the stroke's colour, alpha (times the group alphas) and width
 * after the page's scale, with PDF's default cap, join and miter limit. None when it does not stroke, at alpha 0, and for
 * a pattern stroke (the Scene has no colour for it), which records `text-pattern-fill`.
 */
function runLine(run: TextRun, ctx: TextCtx): OxLineStyle | null {
  if (run.fillMode !== 'stroke' && run.fillMode !== 'fillStroke') return null;
  if (run.stroke === null) {
    ctx.approximate('text-pattern-fill');
    return null;
  }
  const fill = solidFill({ kind: 'solid', rgb: run.stroke.rgb, alpha: run.stroke.alpha }, ctx.alpha)!;
  return fill.kind === 'none' ? null : { w: emu(run.stroke.wPt * ctx.place.scale), fill, ...TEXT_STROKE };
}

/**
 * A run's text as written (M8 round 1a): each character that is a glyph's one code point, the glyph of a symbol font
 * (`sym`, scene/fonts.ts `symbolCodes`), as that font's own character, U+F000 + its code, which PowerPoint draws in the
 * font as the PDF did (the PDF's ToUnicode names it by another character, which PowerPoint draws from another font); the
 * others as they are, one character for one. `symbol`: whether any was.
 */
function writtenText(run: TextRun): { text: string; symbol: boolean } {
  if (!run.glyphs.some((g) => g.sym !== undefined)) return { text: run.text, symbol: false };
  const glyphs = glyphsOfChars(run);
  let text = '';
  let symbol = false;
  [...run.text].forEach((ch, c) => {
    const glyph = run.glyphs[glyphs[c]!];
    const sym = glyph !== undefined && glyph.u === ch ? glyph.sym : undefined;
    text += sym ?? ch;
    symbol ||= sym !== undefined;
  });
  return { text, symbol };
}

/**
 * A run as the writer's (`lowerText`): its size, bold and italic as `runStyle` writes them (a synthetic italic at the size
 * of its em, a synthetic bold with no outline, the size PowerPoint was asked for), bold and italic also where the name
 * of a font without its own style says so (`typefaceFamily`), `spc` its spacing and `kern` its kerning (`runSpacings`).
 * Its spaces are runs of their own where they have spacing of their own (ruling M4-R6; M4b, a wide space): one `OxRun`
 * for each stretch of characters of one spacing (`charSpcs`), alike but for their text and `spc`. A symbol font's
 * glyphs are its own characters (`writtenText`), and its run names the font as its `a:sym` too, as PowerPoint writes a
 * Wingdings character.
 */
function oxRuns(run: TextRun, font: FontInfo | undefined, ctx: TextCtx, style: RunStyle, spacing: RunSpacing): OxRun[] {
  const scale = ctx.place.scale;
  const { named: face, ...faces } = typefaces(font, ctx.fontMap);
  const { text, symbol } = writtenText(run);
  const line = style.syntheticBold ? null : runLine(run, ctx);
  const filled = runFill(run, ctx);
  // M8 round 1a: text that paints nothing is solid at alpha 0 (in its colour), never a:noFill: see `lowerText`
  const fill: OxFill = filled.kind === 'none' && line === null ? { kind: 'solid', rgb: hex(run.rgb ?? run.stroke?.rgb ?? BLACK), alpha: 0 } : filled;
  const base: OxRun = {
    text,
    sz: whole(style.size * scale * 100),
    b: style.bold || face?.bold === true,
    i: style.italic || face?.italic === true,
    kern: spacing.kern,
    spc: whole(spacing.spc * scale * 100),
    baseline: style.size > 0 ? whole((run.rise / style.size) * 100000) : 0,
    fill,
    line,
    ...faces,
    ...(symbol ? { sym: faces.latin } : {}),
  };
  if (spacing.spaceSpc === null && !spacing.wide.includes(true) && spacing.own.every((v) => v === null)) return [base];
  const spcs = charSpcs(run, spacing, scale);
  const out: OxRun[] = [];
  [...text].forEach((ch, c) => {
    const spc = spcs[c]!;
    const last = out.at(-1);
    if (last !== undefined && last.spc === spc) last.text += ch;
    else out.push({ ...base, text: ch, spc });
  });
  return out;
}

/**
 * A line as PowerPoint lays it out at single spacing (M4 Task 1, measured): `single` its height, 1.2 x its largest size
 * whatever the font (six calibrated families, 10 to 36 pt), and `above` its baseline below its top, k x size (the
 * largest of its runs': `baselineK`).
 */
export interface LineMetrics {
  single: number;
  above: number;
}

/**
 * Where PowerPoint puts the baseline of a line of height `h` (pt) below the line's top, as measured (M4 Task 1: six
 * calibrated families, Regular and Bold, 10, 18 and 36 pt, every whole point from 0.55 to 2.05 x size and percents from
 * 80 to 150, rendered and their baselines read back, within 0.2 pt): up to the single height, `h` less the smaller of a
 * quarter of `h` and the single line's descent (`single` - `above`), so at the single height exactly `above`; past it,
 * three quarters of `h`. A line's height is its single height (no `a:lnSpc`), its `a:spcPts` in whole points or its
 * `a:spcPct` of the single height in whole percents (PowerPoint rounds both so), and the next line's baseline is this
 * line's height less this baseline, then that line's own baseline, further down.
 */
export function baselineAt(h: number, line: LineMetrics): number {
  return h <= line.single + 1e-9 ? h - Math.min(h / 4, line.single - line.above) : 0.75 * h;
}

/** A line's spacing as written (null: single) and the height PowerPoint gives the line with it. */
interface Spacing {
  lnSpc: OxLineSpacing | null;
  h: (line: LineMetrics) => number;
}

const SINGLE: Spacing = { lnSpc: null, h: (line) => line.single };
const points = (p: number): Spacing => ({ lnSpc: { kind: 'pts', val: p * 100 }, h: () => p });
const percent = (q: number): Spacing => ({ lnSpc: { kind: 'pct', val: q * 1000 }, h: (line) => (q / 100) * line.single });

/** Where `sp` puts `line`'s baseline below its top: at single spacing exactly `above`, else `baselineAt`. */
const baselineOf = (sp: Spacing, line: LineMetrics): number => (sp === SINGLE ? line.above : baselineAt(sp.h(line), line));

/** Every line of a box at one spacing is kept when its baselines all land within this (pt). */
const UNIFORM_TOL = 0.1;

/** The spacings near height `h` of `line`: the whole points and whole percents (not 100: that is single) around it. */
function near(h: number, line: LineMetrics): Spacing[] {
  const out: Spacing[] = [];
  for (const p of new Set([Math.floor(h), Math.ceil(h)])) if (p >= 1) out.push(points(p));
  const q = (h / line.single) * 100;
  for (const c of new Set([Math.floor(q), Math.ceil(q)])) if (c >= 1 && c !== 100) out.push(percent(c));
  return out;
}

/**
 * The spacing of each line of a box (`lines`: each's metrics and its baseline's `pitch` below the previous line's, slide
 * pt; the first's pitch is not read) and where PowerPoint then puts each baseline below the box's top (`y`), by
 * `baselineAt`:
 * - one spacing for every line when one lands every baseline within `UNIFORM_TOL`: single spacing, else the whole points
 *   or the whole percents nearest the median pitch, whichever lands them best (ties in that order), so that a
 *   paragraph's lines read as one spacing in PowerPoint;
 * - else the first line single and each other its own: of single, and the whole points and whole percents near the
 *   heights that would put its baseline where it is (`near`), the one that does so best. No error adds up from line to
 *   line.
 */
export function lineSpacing(lines: readonly (LineMetrics & { pitch: number })[]): { lnSpc: OxLineSpacing | null; y: number }[] {
  const targets: number[] = [];
  lines.forEach((line, i) => targets.push(i === 0 ? 0 : targets[i - 1]! + line.pitch));
  const result = (spacings: Spacing[], ys: number[]) => spacings.map((sp, i) => ({ lnSpc: sp.lnSpc, y: ys[i]! }));
  if (lines.length === 1) return result([SINGLE], [lines[0]!.above]);

  // one spacing for all
  const pitches = lines.slice(1).map((l) => l.pitch).sort((a, b) => a - b);
  const median = pitches[(pitches.length - 1) >> 1]!;
  let best: { spacings: Spacing[]; ys: number[]; error: number } | null = null;
  for (const sp of [SINGLE, ...near(median, lines[0]!)]) {
    const ys: number[] = [];
    let below = 0; // the previous line's height less its baseline
    lines.forEach((line, i) => {
      const b = baselineOf(sp, line);
      ys.push(i === 0 ? b : ys[i - 1]! + below + b);
      below = sp.h(line) - b;
    });
    const error = ys.reduce((m, y, i) => Math.max(m, Math.abs(y - ys[0]! - targets[i]!)), 0);
    if (best === null || error < best.error - 1e-9) best = { spacings: lines.map(() => sp), ys, error };
  }
  if (best !== null && best.error <= UNIFORM_TOL) return result(best.spacings, best.ys);

  // each line its own: the first single, each next the spacing that lands its baseline best
  const spacings: Spacing[] = [SINGLE];
  const ys = [lines[0]!.above];
  let below = lines[0]!.single - lines[0]!.above;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    const want = ys[0]! + targets[i]! - ys[i - 1]! - below; // the baseline this line needs below its own top
    let pick = SINGLE;
    let pickB = line.above;
    for (const sp of [...near(want / 0.75, line), ...near(want + line.single - line.above, line)]) {
      const b = baselineOf(sp, line);
      if (Math.abs(b - want) < Math.abs(pickB - want) - 1e-9) [pick, pickB] = [sp, b];
    }
    spacings.push(pick);
    ys.push(ys[i - 1]! + below + pickB);
    below = pick.h(line) - pickB;
  }
  return result(spacings, ys);
}

/** A line of a box as lowering writes it: its runs as written, and its place and metrics in the box. */
interface LoweredLine {
  runs: OxRun[];
  /** Along the box's frame, unscaled: where its first written run starts, and where its advances end. */
  start: number;
  end: number;
  /** Across the box's frame, unscaled: its first written run's baseline. */
  across: number;
  size: number;
  above: number;
  below: number;
  /** `base` where its runs differ in size on one baseline (M4b Task 1), else null. */
  fontAlgn: 'base' | null;
  /** Whether its first written run starts with a list label (`KeptRun.label`, ruling M5-R15). */
  label: boolean;
  /** Every run written, for the approximations. */
  source: TextRun[];
  /** For each of `runs`, the gradient it fills with (`runGradient`), else null. */
  paints: (Gradient | null)[];
}

/**
 * Each gradient run's fill (`runGradient`; M5 Task 3, ruling M3-R27) laid over its line, as measured in PowerPoint: a
 * run's `a:gradFill` spans its line's band, across from the line's start to the end of its advances (whatever the box's
 * width; the runs of a line share it, and each line has its own), and down the line's single height, 1.2 x its size, from
 * its top. The band is the written box's: from its left edge plus the line's `marL` (its start less `left`, the
 * leftmost line's), and from its top plus the line's baseline (`plan`) less `above`, which is where the line's top is at
 * single spacing; then back in the slide frame (the placement undone), where `gradFill` lays the gradient. The band is
 * known only so, for an upright line at single spacing: elsewhere (a turned or vertical box, a line of another spacing)
 * the run keeps its first stop and records `text-pattern-fill`.
 */
function lineGradients(lines: readonly LoweredLine[], left: number, box: OxFrame, plan: readonly { lnSpc: OxLineSpacing | null; y: number }[], upright: boolean, ctx: TextCtx): void {
  const { place } = ctx;
  const scale = place.scale;
  const frame = (v: number, axis: 0 | 1): number => (v - place.offset[axis]) / scale; // slide pt to the slide frame
  lines.forEach((l, i) => {
    if (!l.paints.some((g) => g !== null)) return;
    if (!upright || plan[i]!.lnSpc !== null) {
      ctx.approximate('text-pattern-fill');
      return;
    }
    const x0 = (box.x + emu((l.start - left) * scale)) / EMU_PER_PT;
    const y0 = box.y / EMU_PER_PT + plan[i]!.y - l.above * scale;
    const band: Box = [frame(x0, 0), frame(y0, 1), frame(x0 + (l.end - l.start) * scale, 0), frame(y0 + 1.2 * l.size * scale, 1)];
    l.runs = l.runs.map((r, k) => {
      const g = l.paints[k];
      if (g === null || g === undefined) return r;
      const grad = gradFill(g, band, ctx.alpha);
      for (const kind of grad.approximations) ctx.approximate(kind);
      return { ...r, fill: grad.fill };
    });
  });
}

/** The lines of a box: an assembled box's (text assembly), else the element alone as one line of one run. */
const linesOf = (el: TextLineEl | AssembledText): TextLine[] => ('lines' in el ? el.lines : [{ els: [el], before: ['none'] }]);

/**
 * A box's lines as written: each line's kept runs (`keptLine`) styled (`runStyle`) and spaced (`runSpacings`); a
 * synthetic space is spaced by `runSpacings` (`RunSpacing.after`): where that spacing is not the last written run's,
 * the space is a run of its own, alike but for its text and `spc`. After a symbol font's run (M8 round 1a: one written
 * with `a:sym`) the space is a run of its own in the next run's font and style, its `spc` the gap over that font's space
 * (`spaceWidth`, else `SPACE_RULE.fallback` of its em): PowerPoint draws a space in a symbol font as that font's own,
 * Wingdings' a whole em wide, which the PDF does not show. A line's size and metrics are those of its runs as written; a
 * line of runs of different sizes on one baseline is `fontAlgn` `base`.
 */
function lowerLines(el: TextLineEl | AssembledText, fonts: Readonly<Record<string, FontInfo>>, ctx: TextCtx, frame: TextFrame, cos: number, sin: number): LoweredLine[] {
  const vertical = el.wmode === 1;
  const widths = 'spaceWidths' in el ? el.spaceWidths : {};
  const lines: LoweredLine[] = [];
  for (const line of linesOf(el)) {
    const found = keptLine(line, frame, widths);
    if (found === null) continue;
    const { kept, start, end, across, oneBaseline } = found;
    const spacing = runSpacings(kept, cos, sin, vertical, ctx.place.scale, 'kerned' in el && el.kerned === true);
    const out: LoweredLine = { runs: [], start, end, across, size: 0, above: 0, below: 0, fontAlgn: null, label: kept[0]?.label === true, source: [], paints: [] };
    const scale = ctx.place.scale;
    const sizes: number[] = [];
    kept.forEach(({ run, space }, i) => {
      const font = fonts[run.fontKey];
      const style = runStyle(run);
      const link = kept[i]!.link === undefined || ctx.link === undefined ? null : ctx.link(kept[i]!.link);
      const runs = oxRuns(run, font, ctx, style, spacing[i]!);
      const written = link === null ? runs : runs.map((r) => ({ ...r, link }));
      const last = out.runs.at(-1);
      if (space && last !== undefined && (last.sym ?? null) !== null) {
        // after a symbol font's run: a space of the next run's font, at the gap over its width
        const width = spaceWidth(run, widths) ?? SPACE_RULE.fallback * emSize(run) * run.hScale * style.scale;
        const { sym: _sym, ...plain } = written[0]!;
        out.runs.push({ ...plain, text: ' ', spc: whole(((kept[i - 1]!.after?.gap ?? width) - width) * scale * 100) });
        out.paints.push(runGradient(run));
      } else if (space && last !== undefined) {
        const spc = whole(spacing[i - 1]!.after! * scale * 100);
        if (spc === last.spc) out.runs[out.runs.length - 1] = { ...last, text: `${last.text} ` };
        else {
          out.runs.push({ ...last, text: ' ', spc });
          out.paints.push(out.paints.at(-1)!);
        }
      }
      out.runs.push(...written);
      out.paints.push(...written.map(() => runGradient(run)));
      out.source.push(run);
      sizes.push(style.size);
      out.size = Math.max(out.size, style.size);
      out.above = Math.max(out.above, (font === undefined ? DEFAULT_K : baselineK(font).k) * style.size);
      out.below = Math.max(out.below, descentOf(font) * style.size);
    });
    if (oneBaseline && sizes.some((s) => Math.abs(s - sizes[0]!) > EPS)) out.fontAlgn = 'base';
    lines.push(out);
  }
  return lines;
}

/**
 * A text box (text assembly, M4 Task 1: an `AssembledText`, or a Scene text line alone) as one `OxTextBox`, named
 * `text`, or null when it has no text. Each line is a paragraph of its runs but those of size 0 (which draw nothing in the
 * PDF) and those the writer would leave out, whose text keeps nothing (`keptText`: control characters, U+FFFE, U+FFFF,
 * lone surrogates; final review F5), so that every box counted is written; a line left with none is not written. Each run
 * is an `OxRun` (`sz` and `spc` in 100ths of a point after the page's scale, never rounded further; the rise as
 * `baseline` in 1000ths of a percent of the size; bold and italic, the font's own or synthetic (`runStyle`: a synthetic
 * italic at the size of its em, a size PowerPoint's export drew on its grid at the size it was asked for, ruling
 * M4-R4), or what a font's PostScript name says; `spc` from the PDF's Tc and TJ and `kern` 0 where the glyphs show no
 * pair kerning (`runSpacings`, rulings M4-R3 and M4-R6, M4b Task 1: spaces with spacing of their own, and wide ones,
 * are runs of their own; vertical writing has its Tc, the template's kern and no space runs); the typefaces of
 * `typefaces`; fill and outline by `fillMode`, `runFill`, `runLine`, a synthetic bold with no outline). A synthetic space
 * ends the run before it, spaced as its gap says (`lowerLines`). A paragraph of runs of different sizes on one baseline
 * is `fontAlgn="base"`.
 *
 * The box, in its first run's frame (x along the line, y down the glyphs): its left edge is where its leftmost line
 * starts, each paragraph's `marL` where its own line starts; it is as wide as the lines' advances reach and
 * `WIDTH_MARGIN_PT` more. Its first baseline, the first run's origin, is where PowerPoint draws it: a line's baseline
 * `k` x size below its top at single spacing (`baselineK`, the largest of its runs'), and the line pitches of
 * `lineSpacing` (`a:lnSpc`, measured: `baselineAt`). It is as high as the last baseline and that line's descent
 * (`descentOf`) x size below it. The box is turned about its centre by the line's angle as it is written (`rot`, 60000ths
 * of a degree: a Scene angle a hair off a quarter turn, as atan2 gives it, is that quarter turn), its centre put where
 * that turn lands the origin, and it is never flipped (ruling M3-R13 a: PowerPoint draws a flipped text box upside down).
 * Vertical writing (`wmode` 1, one line: text assembly makes no box of several) is `eaVert`: the box is as wide as a line
 * is high and as high as the glyphs reach down the line and a size more, and the first glyph's origin (in vertical
 * writing at the top of the glyph, across its middle) is at the middle of the box's top edge.
 *
 * A run filled with a linear or radial gradient (its own pattern, or an `sh` painted through its glyphs:
 * `textClipGradients`) has that gradient as its `a:gradFill`, laid over its line (`lineGradients`, M5 Task 3).
 *
 * Recorded, over every run of the box (the union of its members'): `hscale` (a horizontal scale other than 1, which
 * DrawingML has not), `text-skew` (a skew over 0.01 that is not a synthetic italic), `vertical-text`, `type3-text`, and
 * `clip-dropped` for a clip the box is still in after the clip pass (a text box has none) when a written run paints (a
 * `noFill` or `clip` run is editable invisible text, and a run at alpha 0 paints nothing either: their clip does not
 * matter). Its members share the clip (text assembly:
 * `sameContext`). A box the drift guard started (`AssembledText.driftSplit`, M4b Task 2) records `text-drift-split`.
 */
export function lowerText(el: TextLineEl | AssembledText, fonts: Readonly<Record<string, FontInfo>>, ctx: TextCtx): OxTextBox | null {
  const { place } = ctx;
  const vertical = el.wmode === 1;
  // the turn as written: the box turns by it in PowerPoint (a Scene angle of 90.000003 is a quarter turn there)
  const turn = rot(el.angleDeg);
  const [cos, sin] = direction(turn / 60000);
  const frame = textFrame(el);
  const lines = lowerLines(el, fonts, ctx, frame, cos, sin);
  if (lines.length === 0) return null;

  const scale = place.scale;
  const first = lines[0]!;
  const left = lines.reduce((m, l) => Math.min(m, l.start), Infinity);
  const along = lines.reduce((m, l) => Math.max(m, l.end), -Infinity) - left + WIDTH_MARGIN_PT;
  const plan = vertical
    ? [{ lnSpc: null, y: first.above * scale }]
    : lineSpacing(lines.map((l, i) => ({ single: 1.2 * l.size * scale, above: l.above * scale, pitch: (i === 0 ? 0 : l.across - lines[i - 1]!.across) * scale })));
  // one line: as high as k x size and the descent below it (M3); more: down to the last baseline and its descent
  const height = lines.length === 1 ? (first.above + first.below) * scale : plan.at(-1)!.y + lines.at(-1)!.below * scale;
  const [w, h] = vertical ? [emu(height), emu(along * scale)] : [emu(along * scale), emu(height)];
  const [wPt, hPt] = [w / EMU_PER_PT, h / EMU_PER_PT];
  // the first baseline origin in the box's own frame, from its centre
  const [vx, vy] = vertical ? [0, -hPt / 2] : [(first.start - left) * scale - wPt / 2, plan[0]!.y - hPt / 2];
  const [ox, oy] = frame.at(first.start, first.across);
  const [bx, by] = [ox * scale + place.offset[0], oy * scale + place.offset[1]];
  const [cx, cy] = [bx - (vx * cos - vy * sin), by - (vx * sin + vy * cos)];
  const box: OxFrame = { x: emu(cx - wPt / 2), y: emu(cy - hPt / 2), w, h, rot: turn, flipH: false, flipV: false };
  lineGradients(lines, left, box, plan, turn === 0 && !vertical, ctx);

  const paras: OxParagraph[] = lines.map((l, i) => ({
    runs: l.runs,
    marL: emu((l.start - left) * scale),
    lnSpc: plan[i]!.lnSpc,
    ...(l.fontAlgn === null ? {} : { fontAlgn: l.fontAlgn }),
    ...(l.label ? { label: true } : {}),
  }));
  const node: OxTextBox = { kind: 'text', name: ctx.name('text'), frame: box, link: null, vert: vertical ? 'eaVert' : 'horz', paras };
  // M8 round 1a: a box whose every run paints nothing is a plain WordArt box (`warp`), which PowerPoint's export keeps
  if (lines.every((l) => l.runs.every(paintsNothing))) node.warp = 'textPlain';
  const runs = lines.flatMap((l) => l.source);
  if (runs.some((run) => run.hScale !== 1)) ctx.approximate('hscale');
  if (runs.some((run) => Math.abs(run.skew) > SKEW_TOL && !runStyle(run).syntheticItalic)) ctx.approximate('text-skew');
  if (vertical) ctx.approximate('vertical-text');
  if (runs.some((run) => fonts[run.fontKey]?.type3 === true)) ctx.approximate('type3-text');
  // a clip matters only where the box paints: never for noFill or clip runs, nor for runs at alpha 0 (M5 Task 3)
  if (el.clip.length > 0 && lines.some((l) => l.runs.some((r) => !paintsNothing(r)))) ctx.approximate('clip-dropped');
  if ('driftSplit' in el && el.driftSplit === true) ctx.approximate('text-drift-split');
  return node;
}

