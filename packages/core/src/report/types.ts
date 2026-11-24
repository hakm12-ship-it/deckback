import type { FontEmbedding } from '../fonts/embed';
import type { Approximation, Counts, SlideReport } from '../passes/report';
import type { SceneDeck } from '../scene/types';

export type { FontEmbedding, FontSkip } from '../fonts/embed';

/**
 * The conversion report, `deckback.report/1`: what `convert()` did to a deck, beside the PPTX. `report.schema.json` beside
 * this file is its JSON Schema (validated in tests only, so the engine bundle has no ajv).
 *
 * It is the user's own output, made from their PDF: `source` holds the document information's /Producer and /Creator and
 * `fonts` the fonts' names. Everything else is numbers, element ids and fixed words (Global Constraints, Privacy): slide
 * notes, fallback reasons and approximation kinds are op names and fixed words, never deck text or paths.
 */

export const REPORT_SCHEMA = 'deckback.report/1';

/** A font of the deck (`SceneDeck.fonts`, in key order): the names the text boxes are written with. */
export interface ReportFont {
  key: string;
  /** `FontInfo.latinName`: the typeface of `a:latin`. */
  latin: string | null;
  /** `FontInfo.eaName`: the typeface of `a:ea`. */
  ea: string | null;
  /** The PDF embeds it (`FontInfo.embedded`). */
  embedded: boolean;
  type3: boolean;
  /**
   * The typefaces the font's text is written with in the PPTX (`typefaces()`, before any `fontMap`): the keys a `fontMap`
   * is looked up by. They can differ from `latin` and `ea` (a font named only by its PostScript name, `MalgunGothic`, is
   * written as `Malgun Gothic`). Each is present when the font has that typeface (a Type 3 font's are all `Arial`).
   * Optional, so a report from before M6 Task 3 stays valid.
   */
  written?: { latin?: string; ea?: string };
  /**
   * With `ConvertOptions.fontMap` only, and only for a font whose typeface it changed (M6; absent otherwise, so a report
   * without it is as before): the family the font's `a:latin` is written as, or, when only its `a:ea` changed, that one.
   */
  mappedTo?: string;
  /**
   * With `embedFonts` only (M4 Task 5; absent otherwise, so a report without it is as before): `embedded`, the PPTX
   * carries the font (`ppt/fonts/font<n>.fntdata`), or why not, in fixed words (`FontSkip`, fonts/embed.ts).
   */
  pptxEmbedding?: FontEmbedding;
}

/** Links not written, by why. */
export interface DroppedLinkCounts {
  /** A URL the writer could not parse, or longer than 2,048 characters as written, or whose host is not ASCII (M3-R61). */
  url: number;
  /** A URL of a scheme the writer does not allow (http, https, ftp, mailto and tel are allowed: ruling M3-R14). */
  scheme: number;
  /** A link to a slide the deck does not have. */
  slide: number;
  /** A link to a page of the PDF that was not converted (`pages` chose others: ruling M3-R21). */
  page: number;
  /** A link of a slide past its weight budget (scene/weight.ts): its links count toward it, and those past it are not kept. */
  budget: number;
  /**
   * M5 Task 5 (final review F6): a link with no target: neither a URL pdf.js takes nor a page of this PDF (a JavaScript or
   * launch action, a destination pdf.js cannot resolve).
   */
  target: number;
}

export interface Report {
  schema: typeof REPORT_SCHEMA;
  /** The Scene's `source`: /Producer, /Creator, whether a converted page is tagged, encrypted, the document's page count. */
  source: SceneDeck['source'];
  /** The slide size written, pt (its EMU / 12700, to 3 decimals): every page is scaled into it (`SlideReport.scale`). */
  slideSizePt: [w: number, h: number];
  /** One per slide, in slide order: `index` is the slide's page in the PDF, 1-based. */
  slides: SlideReport[];
  fonts: ReportFont[];
  /**
   * The slides' counts summed, every approximation kind's count (0 included), and the links not written. `textBoxes`
   * counts the boxes of text assembly (M4 Task 1): a line of text runs each, or on a tagged page the lines of one
   * `Textbox` or `P`, written as one text box of a paragraph per line; an approximation of a box is listed under its
   * first run's id, for every run of it.
   */
  totals: Counts & { approximations: Record<Approximation, number>; droppedLinks: DroppedLinkCounts };
  /**
   * The size-weighted budgets (scene/weight.ts): `slideWeight` and `deckWeight` are the budgets the conversion ran with.
   * `exceeded.slide`: the slides past the slide budget, by their page (1-based, as `SlideReport.index`), whose remaining
   * paints became one `too-complex` fallback (ruling M3-R40) or whose links were not all kept; `exceeded.deck`: the deck
   * went past its budget and the pages after that were not converted (`failed: 'deck-too-complex'`).
   */
  budgets: { slideWeight: number; deckWeight: number; exceeded: { slide: number[]; deck: boolean } };
}
