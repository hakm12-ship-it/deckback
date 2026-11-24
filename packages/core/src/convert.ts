import { PptxWriter, SLIDE_EMU_MAX, SLIDE_EMU_MIN, type Emu, type MediaMime, type OxFill, type OxSlide } from '@deckback/ooxml';
import type { Box } from './extract/inventory';
import { typefaces, type FontMap } from './fonts/typefaces';
import { eotOf, fontRefusal, fontStyle, fontTypefaces, type FontEmbedding } from './fonts/embed';
import {
  APPROXIMATIONS,
  approximationCounts,
  jpegDensity,
  linkedPage,
  mayBeCell,
  patternCell,
  type PatternCell,
  lowerSlide,
  newReport,
  runPasses,
  undrawnEffects,
  type Approximation,
  type Counts,
  type SlideReport,
} from './passes';
import { emu, EMU_PER_PT } from './passes/lower/units';
import { REPORT_SCHEMA, type DroppedLinkCounts, type Report, type ReportFont } from './report/types';
import { roundPt, roundUnitless } from './scene/canonical';
import { scenePages, type ScenePage, type SceneSummary } from './scene/extract';
import type { FontFile } from './scene/fonts';
import { SCENE_SCHEMA, type FontInfo, type SceneDeck, type SceneSlide } from './scene/types';
import { DECK_WEIGHT_BUDGET, SLIDE_WEIGHT_BUDGET } from './scene/weight';

export interface ConvertOptions {
  /**
   * The pages to convert, 0-based, in this order: slide n is page `pages[n - 1]`. Every page, in order, when omitted or
   * empty. A page listed twice is refused (`SceneInputError` `duplicate page`), one outside the document too (RangeError).
   */
  pages?: number[];
  /**
   * As `extractScene`'s: throw where lenient mode makes a fallback, a failed slide or a cut deck; and (M5) `FallbackError`
   * when the passes make one (`SlideReport.fallbacks`), drawn as a raster or not, or leave an effect that needed one
   * undrawn (past the slide's raster budget, or one the renderer cannot draw: `undrawnEffects`, fix round 1), as the
   * PPTX would lose what the PDF shows either way. Default false.
   */
  strict?: boolean;
  /** Keep the Scene and return it (`scene`): the Scene `extractScene` makes of the same bytes and options. Default false. */
  scene?: boolean;
  /**
   * Embed the PDF's own TrueType programs in the PPTX (M4 Task 5, spec §7; fonts/embed.ts), those whose fsType allows it,
   * and say in the report what became of every font (`ReportFont.pptxEmbedding`). Default false: the PPTX and the
   * report are then as without the option.
   */
  embedFonts?: boolean;
  /**
   * M6: called with `(0, total)` before the first slide is written and with `(n, total)` after each slide, a blank one
   * for a slide that could not be written too; `total` is the number of slides. It is synchronous: a throw from it
   * stops the conversion with that error, and nothing is returned (the website's cancel). Changes nothing else.
   */
  onProgress?: (done: number, total: number) => void;
  /**
   * M6: maps a written typeface family to another family name, in every place one is written (`a:latin`, `a:ea`,
   * `a:cs` and the embedded fonts' typefaces); the report's `fonts[].mappedTo` says where it changed one. A key no font
   * is written with, and a value that is not a family name (not a string, blank or only control characters, or over 256 characters), are ignored. Output is as before when it is unused.
   */
  fontMap?: Record<string, string>;
}

/**
 * Strict mode (`ConvertOptions.strict`, the CLI's `--strict`) and a page that needs a fallback (M5 Task 2): one the
 * passes make (a raster of a blend mode, a soft mask, a function or mesh shading, or one written as nothing). The
 * conversion stops and writes nothing; the message is fixed words.
 */
export class FallbackError extends Error {
  constructor() {
    super('convert: a fallback would be written (strict)');
    this.name = 'FallbackError';
  }
}

export interface Converted {
  pptx: Uint8Array;
  report: Report;
  /** With `scene: true` only. */
  scene?: SceneDeck;
}

/** PowerPoint's shortest and longest slide side, pt: 1 in and 56 in (the writer's `SLIDE_EMU_MIN`, `SLIDE_EMU_MAX`). */
const SIDE_MIN_PT = SLIDE_EMU_MIN / EMU_PER_PT;
const SIDE_MAX_PT = SLIDE_EMU_MAX / EMU_PER_PT;
/** The slide size of a deck none of whose pages has one (pdf.js could load none of them): PowerPoint's own 16:9. */
const NO_SIZE_PT: [number, number] = [960, 540];

/**
 * Converts a PDF into a PPTX and its report (`deckback.report/1`): the one function the CLI in Node and the website in
 * its worker both call. The same bytes and options give the same PPTX bytes and the same report everywhere (Global
 * Constraints, Determinism; Review Focus 4).
 *
 * It streams (Review Focus 5): each page is extracted (`scenePages`: loaded, walked, built, released), passed
 * (`runPasses`), lowered (`lowerSlide`) and written (`PptxWriter.addSlide`), and then nothing of it is kept but its report
 * (and its Scene slide with `scene: true`). The pictures a slide uses first go into the zip just before it, and are not
 * kept either; of a JPEG only its density stays (two numbers, `jpegDensity`), which later slides' picture tiles need.
 * The size-weighted budgets (scene/weight.ts) bound each slide and, here only (ruling M3-R41), the deck; the report says
 * where they cut (`budgets.exceeded`), and counts the links a slide past its budget did not keep
 * (`totals.droppedLinks.budget`).
 *
 * Page sizes (Review Focus 2):
 * - The slide size is the first converted page's (the first whose size is known: a page pdf.js cannot load has none, so
 *   the next one gives it; with none at all, 960 x 540 pt). A size with a side past PowerPoint's 72 to 4032 pt is scaled
 *   uniformly into it: down until its longer side is 4032, or up until its shorter side is 72 (as far as the longer
 *   allows); a side still out of range then is held to it, the page centred on it.
 * - Every page is scaled uniformly to fit the slide and centred on it (`SlideReport.scale`, to 6 decimals, null when that
 *   is 1; the scale multiplies every length lowering writes, `LowerCtx`). A failed slide is blank, at no scale.
 *
 * Links (ruling M3-R21): a link to page n of the PDF goes to the slide of that page; to a page not converted (`pages`
 * chose others), it is not written and is counted (`totals.droppedLinks.page`). A link with neither a URL nor a page
 * (M5 Task 5, final review F6) is not written either and is counted (`totals.droppedLinks.target`). A link written on
 * runs (`runLinks`) counts as a hotspot does, once.
 *
 * Raster fallbacks (M5 Task 2): the passes draw each fallback they can (`runPasses`, raster/raster.ts) from the slide
 * and the page's decoded pictures (`ScenePage.pixels`), and its PNG goes into the zip just before the slide, which has
 * it as a picture in the element's place. Strict mode throws `FallbackError` for any fallback the passes make.
 *
 * One slide that cannot be written does not fail the deck (ruling M3-R62): in lenient mode, a throw while a slide is
 * passed, lowered or written makes it a blank slide whose report has `failed: 'slide-unwritable'` and the note `slide
 * could not be written` (`opIndex` 0, `op` `convert`), and the deck goes on; strict mode throws. The writer builds a
 * slide whole before it writes anything of it, so a slide it refuses leaves it as it was.
 *
 * Fonts (`embedFonts`, M4 Task 5, spec §7): the program of each font the deck uses first on a slide comes with the slide
 * (`ScenePage.fontFiles`), and goes into the zip just before it, as an EOT (fonts/embed.ts), when its fsType and its
 * tables allow, its typefaces (those its runs are written with) do not have a font of its style already, and the slide is
 * written; a font first used on a slide that could not be written waits, as its pictures do, for the first later slide
 * that uses it. So the fonts are in first-use order, and nothing of a program is kept once it is written.
 *
 * Throws what `extractScene` throws, before anything is written: `SceneInputError` (not a PDF, a password, a page listed
 * twice) and a RangeError (a page outside the document); in strict mode also what it throws on a page. The caller's
 * bytes are not changed.
 */
export async function convert(bytes: Uint8Array, opts: ConvertOptions = {}): Promise<Converted> {
  const embedFonts = opts.embedFonts === true;
  const pages = scenePages(bytes, { pages: opts.pages ?? [], strict: opts.strict ?? false, cutDeck: true, fontFiles: embedFonts });
  const deck = new StreamedDeck(slideNumbers(opts.pages), opts.scene === true, opts.strict ?? false, embedFonts, opts.fontMap, opts.onProgress);
  let step: IteratorResult<ScenePage, SceneSummary>;
  try {
    for (step = await pages.next(); step.done !== true; step = await pages.next()) deck.add(step.value);
  } catch (error) {
    await pages.return(undefined as never).catch(() => undefined); // closes the document when the writer threw
    throw error;
  }
  return deck.finish(step.value);
}

/** The slide: its size in pt, which pages are fitted into, and in EMU, as written. */
interface SlideFrame {
  pt: [number, number];
  emu: [Emu, Emu];
}

/**
 * The slide for the first converted page's size `[w, h]` (pt): that size, scaled uniformly into PowerPoint's range when
 * a side is out of it (`convert`), each side then held to the range.
 */
function slideFrame([w, h]: [number, number]): SlideFrame {
  const [long, short] = [Math.max(w, h), Math.min(w, h)];
  let k = 1;
  if (long > SIDE_MAX_PT) k = SIDE_MAX_PT / long;
  else if (short < SIDE_MIN_PT) k = Math.min(SIDE_MIN_PT / short, SIDE_MAX_PT / long);
  const side = (v: number): number => Math.min(SIDE_MAX_PT, Math.max(SIDE_MIN_PT, v * k));
  const pt: [number, number] = [side(w), side(h)];
  return { pt, emu: [emu(pt[0]), emu(pt[1])] };
}

/** Where a page of `size` (pt) lands on the slide: the largest uniform scale that fits it, centred. */
function placement([w, h]: [number, number], slide: SlideFrame): { scale: number; offset: [number, number] } {
  if (!(w > 0 && h > 0)) return { scale: 1, offset: [0, 0] };
  const [sw, sh] = slide.pt;
  const scale = Math.min(sw / w, sh / h);
  return { scale, offset: [(sw - w * scale) / 2, (sh - h * scale) / 2] };
}

/**
 * The slide's box in the frame of a page placed at `scale` and `offset` (M8 round 1a, `PassContext.view`): what of the
 * page's frame shows on the slide. A page of the slide's size is its own box.
 */
function viewOf(scale: number, offset: readonly [number, number], slide: SlideFrame): Box {
  const [sw, sh] = slide.pt;
  return [-offset[0] / scale, -offset[1] / scale, (sw - offset[0]) / scale, (sh - offset[1]) / scale];
}

/** `ReportFont.written`: the typefaces font `info`'s text is written with, before any font map (M6 Task 3). */
function writtenFaces(info: FontInfo): NonNullable<ReportFont['written']> {
  const { latin, ea } = typefaces(info);
  return { ...(latin !== null && { latin }), ...(ea !== null && { ea }) };
}

/** Whether a slide has a size: a page pdf.js could not load (or did not, past the deck's budget) has [0, 0]. */
const sized = (slide: SceneSlide): boolean => slide.sizePt[0] > 0 && slide.sizePt[1] > 0;

/**
 * The slide of each converted page (1-based both), for links (ruling M3-R21): undefined when every page is converted
 * in order (page n is slide n), else null for a page not converted.
 */
function slideNumbers(pages: readonly number[] | undefined): ((page: number) => number | null) | undefined {
  if (pages === undefined || pages.length === 0) return undefined;
  const slides = new Map(pages.map((index, i) => [index + 1, i + 1]));
  return (page) => slides.get(page) ?? null;
}

/**
 * The deck as it is written, slide by slide. The writer is made with the first slide that has a size, which gives the
 * slide size; the slides before it (failed, blank) wait for it, holding nothing.
 */
class StreamedDeck {
  private writer: PptxWriter | null = null;
  private frame: SlideFrame | null = null;
  private readonly waiting: ScenePage[] = [];
  private readonly reports: SlideReport[] = [];
  private readonly slides: SceneSlide[] = [];
  /** The density of each JPEG written (`jpegDensity`): what the picture pass needs of a picture used on an earlier slide. */
  private readonly densities = new Map<string, [number, number] | null>();
  /** M5-R10: each small PNG's pattern cell (`patternCell`), read once: a picture tile on a later slide may use it. */
  private readonly cells = new Map<string, PatternCell | null>();
  /** Links to pages not converted (ruling M3-R21). */
  private droppedToPages = 0;
  /** Links of slides past their weight budget (`ScenePage.droppedLinks`). */
  private droppedPastBudget = 0;
  /** Links with no target (M5 Task 5, final review F6): no URL and no page of the PDF. */
  private droppedNoTarget = 0;
  /**
   * The pictures a slide that could not be written brought (ruling M3-R62), not added, and the pattern cells' pictures a
   * slide wrote as presets instead (M5-R10): each goes into the zip just before the first later slide that uses it, so the
   * zip holds no picture that no slide uses.
   */
  private readonly pending = new Map<string, { file: Uint8Array; mime: MediaMime }>();
  /** With `embedFonts`: what became of each font whose program came with a slide, by key. */
  private readonly fontResults = new Map<string, FontEmbedding>();
  /** The programs of fonts first used on a slide that could not be written: as `pending`, by font key. */
  private readonly pendingFonts = new Map<string, FontFile>();
  /** The stream objects (`num gen`) of the programs embedded: a font whose program is one of them is embedded already. */
  private readonly programResults = new Map<string, FontEmbedding>();

  constructor(
    private readonly slideOf: ((page: number) => number | null) | undefined,
    private readonly keepScene: boolean,
    private readonly strict: boolean,
    private readonly embedFonts: boolean,
    private readonly fontMap: FontMap | undefined,
    private readonly onProgress: ((done: number, total: number) => void) | undefined,
  ) {}

  /** Slides written so far (blank ones too), and the total: for `ConvertOptions.onProgress`. */
  private done = 0;
  private total: number | null = null;

  /** `onProgress`'s `(0, total)`, once, before the first slide is written. */
  private start(total: number): void {
    if (this.total !== null) return;
    this.total = total;
    this.onProgress?.(0, total);
  }

  private progress(): void {
    this.done++;
    this.onProgress?.(this.done, this.total!);
  }

  add(page: ScenePage): void {
    this.start(page.count);
    if (this.writer === null) {
      if (!sized(page.slide)) {
        this.waiting.push(page);
        return;
      }
      this.open(slideFrame(page.slide.sizePt), page.count);
    }
    this.write(page);
  }

  finish(summary: SceneSummary): Converted {
    this.start(this.waiting.length);
    if (this.writer === null) this.open(slideFrame(NO_SIZE_PT), this.waiting.length);
    const writer = this.writer!;
    const frame = this.frame!;
    const pptx = writer.finish();
    const report: Report = {
      schema: REPORT_SCHEMA,
      source: { ...summary.source },
      slideSizePt: [roundPt(frame.emu[0] / EMU_PER_PT), roundPt(frame.emu[1] / EMU_PER_PT)],
      slides: this.reports,
      fonts: Object.values(summary.fonts).map((f): ReportFont => {
        let font: ReportFont = { key: f.key, latin: f.latinName, ea: f.eaName, embedded: f.embedded, type3: f.type3, written: writtenFaces(f) };
        const mappedTo = this.mappedTo(f);
        if (mappedTo !== null) font = { ...font, mappedTo };
        return this.embedFonts ? { ...font, pptxEmbedding: this.fontEmbedding(f) } : font;
      }),
      totals: totals(this.reports, { ...writer.droppedLinks, page: this.droppedToPages, budget: this.droppedPastBudget, target: this.droppedNoTarget }),
      budgets: {
        slideWeight: SLIDE_WEIGHT_BUDGET,
        deckWeight: DECK_WEIGHT_BUDGET,
        exceeded: {
          slide: this.reports.filter((r) => r.notes.some((n) => n.detail.startsWith('slide too complex'))).map((r) => r.index),
          deck: this.reports.some((r) => r.failed === 'deck-too-complex'),
        },
      },
    };
    if (!this.keepScene) return { pptx, report };
    const scene: SceneDeck = { schema: SCENE_SCHEMA, source: summary.source, slides: this.slides, fonts: summary.fonts, media: summary.media };
    return { pptx, report, scene };
  }

  /** Makes the writer for `frame` and `count` slides, and writes the slides that waited for it. */
  private open(frame: SlideFrame, count: number): void {
    this.frame = frame;
    this.writer = new PptxWriter(frame.emu, count);
    for (const page of this.waiting.splice(0)) this.write(page);
  }

  /**
   * Where `fontMap` changed a typeface of font `info`: the family its `a:latin` is written as, or, when only its `a:ea`
   * changed, that one; null when the map changed neither.
   */
  private mappedTo(info: FontInfo): string | null {
    if (this.fontMap === undefined) return null;
    const was = typefaces(info);
    const now = typefaces(info, this.fontMap);
    if (now.latin !== was.latin) return now.latin;
    return now.ea !== was.ea ? now.ea : null;
  }

  /**
   * What became of font `info` (`embedFonts`): as decided when its program came with a written slide (`embedFont`); a
   * program still waiting for one, `unused`; one that never came, why the font has none (`fontRefusal`).
   */
  private fontEmbedding(info: FontInfo): FontEmbedding {
    const decided = this.fontResults.get(info.key);
    if (decided !== undefined) return decided;
    if (this.pendingFonts.has(info.key)) return 'unused';
    return fontRefusal(info, undefined) ?? 'unreadable';
  }

  /**
   * Font `key`'s program into the zip as an EOT, under the typefaces its runs are written with, when it may be embedded
   * (`fontRefusal`) and those typefaces have no font of its style yet (`same-face`); what became of it is kept. A font
   * whose program is the very stream of one embedded already (an Office export draws a font through a Type0 and a
   * TrueType font dict that share it) is embedded: the same names give the same typefaces and style. A font that leaves
   * its runs no typeface is `incomplete`: its program names no family, or only in characters XML refuses (the writer's
   * `addFont` then has no typeface to list it by and throws; caught here in either mode, as the font is optional and
   * its slide is written all the same).
   */
  private embedFont(key: string, file: FontFile, files: ReadonlyMap<string, FontFile>, fonts: SceneDeck['fonts'], slide: SceneSlide): void {
    const info = fonts[key];
    if (info === undefined) throw new Error(`convert: font ${key} has no FontInfo`);
    const program = file.ref === null ? null : `${file.ref.num} ${file.ref.gen}`;
    const decided = program === null ? undefined : this.programResults.get(program);
    if (decided !== undefined) {
      this.fontResults.set(key, decided);
      return;
    }
    // one decision per program: the characters of every font dict of the slide that shares it must be drawable
    const points = codePointsOf(slide, key);
    if (program !== null) {
      for (const [other, otherFile] of files) {
        if (otherFile.ref !== null && `${otherFile.ref.num} ${otherFile.ref.gen}` === program) for (const p of codePointsOf(slide, other)) points.add(p);
      }
    }
    let faces: string[];
    let added: boolean;
    try {
      const refusal = fontRefusal(info, file, points);
      if (refusal !== null) {
        // a refusal of the program itself holds for every font dict that shares it
        if (program !== null && info.embedded && !info.type3) this.programResults.set(program, refusal);
        this.fontResults.set(key, refusal);
        return;
      }
      faces = fontTypefaces(info, this.fontMap);
      if (faces.length === 0) {
        this.fontResults.set(key, 'incomplete');
        return;
      }
      added = this.writer!.addFont(eotOf(file.bytes), faces, fontStyle(info));
    } catch {
      this.fontResults.set(key, 'incomplete');
      return;
    }
    const result = added ? 'embedded' : 'same-face';
    // only an embedded program is kept: `same-face` is the writer's state at that time, not the program's
    if (program !== null && added) this.programResults.set(program, result);
    this.fontResults.set(key, result);
  }

  /**
   * One slide: passed and lowered at its placement, then its new pictures and those waiting for it (`pending`) go into
   * the zip, then its new fonts and those waiting for it (`pendingFonts`, `embedFonts`), then the slide; its report kept.
   * When passing, lowering or writing it throws (lenient mode, ruling M3-R62), it is a blank slide (`unwritable`), and its
   * new pictures and fonts, if it threw before they were added, wait.
   */
  private write({ slide, media, pixels, fontFiles, deck, droppedLinks }: ScenePage): void {
    const writer = this.writer!;
    const fresh: { hash: string; file: Uint8Array; mime: MediaMime }[] = [];
    for (const [hash, file] of media) {
      const info = deck.media[hash];
      if (info === undefined) throw new Error(`convert: media ${hash} has no MediaInfo`);
      fresh.push({ hash, file, mime: info.mime });
      if (info.mime === 'image/jpeg') this.densities.set(hash, jpegDensity(file));
      if (mayBeCell(info)) this.cells.set(hash, patternCell(file));
    }
    this.droppedPastBudget += droppedLinks;
    if (this.keepScene) this.slides.push(slide);
    let report: SlideReport;
    let passed: SceneSlide;
    let lowered: OxSlide;
    let rasters: Map<string, Uint8Array>;
    try {
      const { scale, offset } = slide.failed === null ? placement(slide.sizePt, this.frame!) : { scale: 1, offset: [0, 0] as [number, number] };
      const view = viewOf(scale, offset, this.frame!);
      ({ slide: passed, report, media: rasters } = runPasses(slide, deck, { jpegDensity: this.densities, patternCells: this.cells, scale, view, pixels: (hash) => pixels.get(hash) }));
      // as reported: a page within a millionth of the slide's size reports no scale (it is still drawn at its own)
      const shown = roundUnitless(scale);
      report.scale = shown === 1 ? null : shown;
      const ctx = { page: slide.index + 1, scale, offset, report, slideEmu: this.frame!.emu, ...(this.slideOf === undefined ? {} : { slideOf: this.slideOf }), ...(this.fontMap === undefined ? {} : { fontMap: this.fontMap }) };
      lowered = lowerSlide(passed, deck, ctx);
      if (this.strict && (report.counts.fallbacks > 0 || undrawnEffects(passed) > 0)) throw new FallbackError();
    } catch (error) {
      if (this.strict) throw error;
      for (const { hash, file, mime } of fresh) this.pending.set(hash, { file, mime });
      for (const [key, file] of fontFiles) this.pendingFonts.set(key, file);
      this.unwritable(slide);
      return;
    }
    // a pattern cell's picture the slide does not name (written as a preset, `a:pattFill`, M5-R10) waits, as a picture
    // of a slide that failed does: a later slide may use it, and none left over is written, so no part goes unnamed
    const named = mediaOf(lowered);
    for (const { hash, file, mime } of fresh) {
      const info = deck.media[hash]!;
      if (!named.has(hash) && mayBeCell(info)) this.pending.set(hash, { file, mime });
      else writer.addMedia(hash, file, mime);
    }
    // M5 Task 2: the raster fallbacks' pictures, which the passes made (a hash met before is not written twice)
    for (const [hash, png] of rasters) writer.addMedia(hash, png, 'image/png');
    for (const hash of named) {
      const waiting = this.pending.get(hash);
      if (waiting === undefined) continue;
      writer.addMedia(hash, waiting.file, waiting.mime);
      this.pending.delete(hash);
    }
    const files = new Map([...this.pendingFonts, ...fontFiles]);
    for (const [key, file] of fontFiles) this.embedFont(key, file, files, deck.fonts, slide);
    for (const key of fontsOf(slide)) {
      const waiting = this.pendingFonts.get(key);
      if (waiting === undefined) continue;
      this.embedFont(key, waiting, files, deck.fonts, slide);
      this.pendingFonts.delete(key);
    }
    try {
      writer.addSlide(lowered);
    } catch (error) {
      if (this.strict) throw error;
      this.unwritable(slide);
      return;
    }
    for (const el of passed.elements) {
      if (el.kind !== 'hotspot') continue;
      const target = linkedPage(el.link);
      if (el.link.url === null && target === null) this.droppedNoTarget++;
      else if (this.slideOf !== undefined && target !== null && this.slideOf(target) === null) this.droppedToPages++;
    }
    this.reports.push(report);
    this.progress();
  }

  /**
   * Ruling M3-R62: `slide`, which could not be passed, lowered or written, as a blank slide; its report the Scene's notes
   * and the note `slide could not be written`, with `failed: 'slide-unwritable'`, no scale and nothing counted.
   */
  private unwritable(slide: SceneSlide): void {
    this.writer!.addSlide({ nodes: [], background: null });
    const report = newReport(slide);
    report.failed = 'slide-unwritable';
    report.notes.push({ opIndex: 0, op: 'convert', detail: 'slide could not be written' });
    this.reports.push(report);
    this.progress();
  }
}

/** The font keys a slide's text runs name, each once, in the order first named. */
function fontsOf(slide: SceneSlide): Set<string> {
  const keys = new Set<string>();
  for (const el of slide.elements) if (el.kind === 'textline') for (const run of el.runs) keys.add(run.fontKey);
  return keys;
}

/**
 * A character drawn as no glyph: Unicode category Cc (U+0000-001F, U+007F-009F) or Cf. The Cf set is listed, not asked of
 * the engine (`\p{Cf}`): Cf grows between Unicode versions, so Node versions and browsers would decide an embedding
 * differently for one deck (the repo's Hangul ranges are fixed for the same reason).
 */
const UNDRAWN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0xad, 0xad],
  [0x600, 0x605],
  [0x61c, 0x61c],
  [0x6dd, 0x6dd],
  [0x70f, 0x70f],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
];
const undrawn = (ch: string): boolean => {
  const cp = ch.codePointAt(0)!;
  return UNDRAWN_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
};

/**
 * The code points the text runs of font `key` show on a slide, each once (what the font's `cmap` must draw, `fontRefusal`),
 * but the characters never drawn as glyphs, Unicode categories Cc and Cf (controls, the zero width space, the soft hyphen,
 * bidi marks: `keptText` and PowerPoint draw none), which need no outlines.
 */
export function codePointsOf(slide: SceneSlide, key: string): Set<number> {
  const points = new Set<number>();
  for (const el of slide.elements) {
    if (el.kind !== 'textline') continue;
    for (const run of el.runs) if (run.fontKey === key) for (const ch of run.text) if (!undrawn(ch)) points.add(ch.codePointAt(0)!);
  }
  return points;
}

/** The media keys a slide's background and nodes name (in their fills and their lines' fills), as the writer looks them up. */
function mediaOf(slide: OxSlide): Set<string> {
  const keys = new Set<string>();
  const fill = (f: OxFill | null | undefined): void => {
    if (f?.kind === 'blip') keys.add(f.media);
  };
  fill(slide.background);
  for (const node of slide.nodes) {
    if (node.kind === 'picture') keys.add(node.media);
    if (node.kind === 'shape') fill(node.fill);
    if (node.kind === 'shape' || node.kind === 'line') fill(node.line?.fill);
    if (node.kind === 'text') {
      for (const run of node.paras.flatMap((p) => p.runs)) {
        fill(run.fill);
        fill(run.line?.fill);
      }
    }
  }
  return keys;
}

/**
 * The slides' counts summed, every approximation kind counted (0 included, in `APPROXIMATIONS` order; those past a slide's
 * list too, ruling M3-R59), the links dropped.
 */
function totals(slides: readonly SlideReport[], droppedLinks: DroppedLinkCounts): Report['totals'] {
  const counts: Counts = { textBoxes: 0, freeforms: 0, rects: 0, lines: 0, pictures: 0, gradients: 0, hotspots: 0, runLinks: 0, fallbacks: 0 };
  const approximations = Object.fromEntries(APPROXIMATIONS.map((kind) => [kind, 0])) as Record<Approximation, number>;
  for (const slide of slides) {
    for (const key of Object.keys(counts) as (keyof Counts)[]) counts[key] += slide.counts[key];
    for (const [kind, n] of approximationCounts(slide)) approximations[kind] += n;
  }
  return { ...counts, approximations, droppedLinks };
}
