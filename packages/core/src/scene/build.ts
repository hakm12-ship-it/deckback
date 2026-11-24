import type { RawPageKey } from '../engine/fonts';
import type { PageData } from '../engine/pdfjs-adapter';
import { joinStructure } from '../engine/structure';
import type { ClipNode, Matrix } from '../extract/gstate';
import type { Box, LineInv, PathSeg } from '../extract/inventory';
import { gradientStops } from '../extract/patterns';
import {
  imagePixels,
  opNameAt,
  type GroupFrame,
  type ImagePixels,
  type RawMesh,
  type RawOp,
  type RunData,
  type SoftMask,
  type TileInfo,
} from '../extract/walker';
import { canWrite, roundPt, roundUnitless } from './canonical';
import type { FontTable } from './fonts';
import type { MediaStore } from './media';
import { clipWeight, DECK_WEIGHT_BUDGET, GLYPH_UNIT, NESTED_UNIT, PAGE_UNIT, pathWeight, SLIDE_WEIGHT_BUDGET, takenClipWeight } from './weight';
import type {
  ClipDef,
  Element,
  ElementBase,
  FallbackEl,
  Fill,
  GroupRef,
  LineStyle,
  MaskDef,
  Note,
  PictureEl,
  Rgb,
  SceneSlide,
  ShadingMesh,
  ShapeEl,
  TextLineEl,
  TextRun,
  TileCell,
} from './types';

/** What `buildSlide` needs besides the page's ops. */
export interface BuildContext {
  /** The deck's media (Task 10): a picture's bytes go in here, once however often it is painted. */
  media: MediaStore;
  /** The deck's fonts (Task 9): a text run's font is resolved here, and keyed in the order the deck first uses it. */
  fonts: FontTable;
  /**
   * The page the ops were walked from, still loaded (before `releasePage`): a picture's pixels and the name of the op a
   * note is about are read from it (`imagePixels`, `opNameAt`), and the role paths of `provenance.struct` from its
   * structure tree (`joinStructure`). No pdf.js object id goes further.
   */
  page: Pick<PageData, 'ops' | 'obj' | 'pageRef' | 'structTree'>;
}

/** Ruling M2-R4: the axes of a CTM may differ in scale by this much (1 %) before a line's width is only an average. */
const SCALE_TOLERANCE = 0.01;
/** (1 + SCALE_TOLERANCE)², to compare squared lengths: a product, which every engine rounds alike. */
const SCALE_SQUARED = (1 + SCALE_TOLERANCE) * (1 + SCALE_TOLERANCE);
/** Ruling M2-R4: ... or be this far from perpendicular (degrees), the tolerance `PictureEl.skewed` uses too. */
export const ANGLE_TOLERANCE_DEG = 0.01;
/**
 * sin(ANGLE_TOLERANCE_DEG), written out: `PictureEl.skewed` and `anisotropic` compare with it using only multiplication,
 * which every engine rounds alike, where `Math.sin` and `Math.asin` may differ in the last bit (Global Constraints,
 * Determinism).
 */
export const SKEW_SINE = 1.745329243133368e-4;

const CAPS = ['butt', 'round', 'square'] as const;
const JOINS = ['miter', 'round', 'bevel'] as const;

/**
 * The most elements one slide may make, those of its tile cells and soft masks included (final review F1, ruling
 * M2-R36). A cell is copied into every element it fills, so tiling patterns nested in each other's cells multiply: a
 * 3 KB PDF could make millions. The busiest slide of the gate sets (out/atlas, out/atlas-win) and of the 51-slide deck
 * has 2,773 elements, nested included (atlas_msprint.pdf page 37, measured 2026-11-10); this is the smallest round
 * number of at least 10 times that and at least 100,000. Past it, a tile cell is not built (`SceneTooComplexError`).
 * Since ruling M3-R60 every element weighs at least `NESTED_UNIT` (6), so a slide reaches `SLIDE_WEIGHT_BUDGET` at about
 * 83,000 elements, before this: it stays as a backstop, which no page reaches first.
 */
export const ELEMENT_BUDGET = 100_000;

/**
 * The most op indexes the fallback for the rest of a scope past the weight budget lists in `coveredOps` (`restOfScope`,
 * ruling M3-R40): the ops past them are cut from the list.
 */
export const COVERED_OPS_MAX = 1_000;

/** What `attempt` gives for an element that took the slide past its weight budget, in lenient mode (`restOfScope`). */
const PAST_BUDGET: unique symbol = Symbol('past the slide weight budget');

/**
 * What was past a budget. `cell`: a tile cell was not built, as its slide had already made more than `ELEMENT_BUDGET`
 * elements. `slide`: a paint (or a link) took the slide to `SLIDE_WEIGHT_BUDGET` (weight.ts). `deck`: a page came after
 * the deck went past `DECK_WEIGHT_BUDGET` (`convert` only, ruling M3-R41). Strict mode throws it; in lenient mode the
 * element becomes a fallback (`too-complex`) with a note, and a page past the deck's budget a slide
 * `failed: 'deck-too-complex'` (`scenePages` with `cutDeck`).
 */
export class SceneTooComplexError extends Error {
  readonly budget: 'cell' | 'slide' | 'deck';

  constructor(budget: 'cell' | 'slide' | 'deck' = 'cell') {
    super(
      budget === 'cell'
        ? `buildSlide: a tile cell past the slide's budget of ${ELEMENT_BUDGET} elements`
        : budget === 'slide'
          ? `buildSlide: a paint past the slide's weight budget of ${SLIDE_WEIGHT_BUDGET}`
          : `extractScene: a page past the deck's weight budget of ${DECK_WEIGHT_BUDGET}`,
    );
    this.name = 'SceneTooComplexError';
    this.budget = budget;
  }
}

/** How the lengths of a frame are rounded (ruling M2-R13): the slide frame's to 3 decimals (pt), a tile cell's to 6. */
type Round = (value: number) => number;

/**
 * Where elements are built: the slide, a soft mask or a tile cell. `opList` is the operator list their ops index (the
 * page's, or the cell's), `ids` makes their ids, `len` rounds their lengths, and a note about one of them names the
 * page op `noteAt` gives (in a cell, the one that paints the cell) and says `where` it is. `inPage`: the page's own content,
 * whose marked-content ids the page's structure tree names; a soft mask's and a tile cell's are not (`provenance.struct`).
 * `cells`: the tile cells it is in (`CellPath`).
 */
interface Scope {
  opList: PageData['ops'];
  ids: Ids;
  len: Round;
  noteAt: (op: RawOp) => number;
  where: string;
  inPage: boolean;
  cells: CellPath;
}

/**
 * Where a scope is among the tile cells of its slide: the page, or a cell in it, known by the `TileInfo` of each cell
 * on the way (one per `scn`). The soft masks met there are known by this path and the mask. The walker walks each
 * distinct cell once per page and every cell of that pattern shares the walk (`TileInfo.ops`), so one soft mask object
 * can be under two cells; they still get a mask each, as when each `scn` had its own walk. Sharing changes no output.
 */
class CellPath {
  /** The soft masks met at this path, and their ids in the slide's `masks`. */
  readonly masks = new Map<SoftMask, string>();
  private readonly cells = new Map<TileInfo, CellPath>();

  /** The path of the cell `tile` in this scope. */
  child(tile: TileInfo): CellPath {
    let path = this.cells.get(tile);
    if (path === undefined) {
      path = new CellPath();
      this.cells.set(tile, path);
    }
    return path;
  }
}

/**
 * Builds one slide of the Scene from the RawOps of its page, in paint order, while pdf.js still holds the page (before
 * `releasePage`). One element per paint: a `fill` and a `stroke` RawOp each give a shape, so `B` gives two; merging is a
 * later pass. Numbers are rounded here (ruling M2-R13): slide-frame lengths to 3 decimals, unitless values to 6.
 *
 * - A `fill` or `stroke` in a solid colour gives a shape with a solid fill or line.
 * - A `shade` or `pattern` gives a shape too (Task 8): `sh` one with `geom: null` that paints its clip; a path filled with
 *   a gradient or tiling pattern one with that `fill`; a stroke one whose `line.paint` it is. A gradient is `linear` or
 *   `radial` (`gradientStops` reads its stops and extend flags), a function-based shading or mesh `shading`, a tiling
 *   pattern `tile` with its cell, whose elements are built in cell space.
 * - An `image` gives a picture, its media added to `ctx.media` (Task 10).
 * - The glyphs of one `showText` run (`glyph`, or `invisible` for Tr 3: those whose `run` is one object) give one text line
 *   with one run (Task 9; `textLine`), where the run's first glyph is in paint order. Its font is resolved in `ctx.fonts`.
 *   The shade or pattern that fills text (`text`) is no element: the run holds it as its `fill`.
 * - What the Scene cannot show is a fallback element with a note of the slide: an image mask filled with a pattern
 *   (`stencil-pattern`), an image pdf.js gave no pixels for (`image-unreadable`), a shading pdf.js could not read
 *   (`shading-unreadable`). Text filled with such a shading keeps its run, without a fill, and the slide a note.
 * - Every element has its clips (`clip`, ids in `clips`: `c<n>` in first-use order, outermost first), its transparency
 *   groups and the innermost soft mask over it (`mask`, an id in the slide's `masks`: `m<n>` in first-use order, ruling
 *   M2-R14). A soft mask's elements and a tile cell's are mask and pattern data, never page content (0002 §9): they are
 *   in their mask or cell, not in `elements`.
 * - `provenance.struct` is the role path `joinStructure` gives the element's marked-content id on a tagged page; null
 *   without an id, or for one the structure tree does not name, and for what a soft mask or a tile cell draws (their
 *   marked content is not the page's).
 * - An operator a lenient walk skipped (`unsupported`) is a fallback (`unsupported-op`, no `bbox`) with a note.
 * - Text stroked with a pattern keeps its run, whose `stroke` is null, and the slide a note.
 * - A slide makes at most about `ELEMENT_BUDGET` elements, those of its tile cells and soft masks included: once it has
 *   made more, no further tile cell is built (`SceneTooComplexError`).
 * - A slide weighs at most `SLIDE_WEIGHT_BUDGET` (weight.ts: each element by its kind and scope, its path segments and
 *   glyphs, clip paths, tile cells and soft masks included; rulings M2-R36, M2-R37, M3-R38, M3-R60): the paint that takes
 *   it past what leaves room for one fallback is not kept, and from there on no paint of the slide is built.
 *
 * `strict` (the default) throws for a RawOp it cannot build: a field the walker always gives is missing, a bug of the
 * walker; and for a tile cell or a slide past its budget. Lenient (`strict: false`, what `extractScene` uses): such a
 * RawOp, and one whose element would hold a number that is not finite (which `canonicalJson` cannot write), becomes a
 * fallback (`unbuildable`; `bbox` the RawOp's when that is finite) with a note, under the id the element would have had;
 * an element whose tile cell was past the budget, the same with `too-complex` and the note `tile cell too large`; a text
 * run whose line fails is that one fallback. When even that fallback cannot be built, the lenient build throws too, and
 * the caller fails the slide. A clip or a soft mask is not checked here: the caller checks the whole slide
 * (`canWrite`).
 *
 * Past the weight budget (lenient; ruling M3-R40): the paint that takes the slide past it and the rest of its scope (the
 * slide, the tile cell or the soft mask it is in) are one `too-complex` fallback, under the id that paint would have
 * had, with one note `slide too complex` (`restOfScope`). A text line whose glyph would take it past keeps the glyphs it
 * had, and that glyph and what follows it are the fallback. A scope that holds the crossing is itself in an element
 * that the crossing takes past the budget, so the scopes around it end the same way: one fallback each, and the slide's
 * is the one that stays (the inner ones went with the element they were in).
 */
export async function buildSlide(
  input: { index: number; sizePt: [number, number]; ops: Iterable<RawOp> },
  ctx: BuildContext,
  { strict = true }: { strict?: boolean } = {},
): Promise<SceneSlide> {
  const builder = new SlideBuilder(input.index, ctx, strict);
  const page: Scope = {
    opList: ctx.page.ops,
    ids: new Ids(`p${input.index + 1}:`),
    len: roundPt,
    noteAt: (op) => op.opIndex,
    where: '',
    inPage: true,
    cells: new CellPath(),
  };
  const { elements, clips } = await builder.build(input.ops, page);
  return {
    index: input.index,
    sizePt: [roundPt(input.sizePt[0]), roundPt(input.sizePt[1])],
    elements,
    clips,
    masks: builder.masks,
    notes: builder.notes,
    failed: null,
  };
}

/**
 * The elements of one scope, and the clips they use, with ids in the order they are first used. `weigh` is told the
 * weight of each clip made (weight.ts): its path's segments.
 */
class Container {
  readonly elements: Element[] = [];
  readonly clips: Record<string, ClipDef> = {};
  private readonly ids = new Map<ClipNode, string>();

  constructor(
    readonly scope: Scope,
    private readonly weigh: (weight: number) => void,
  ) {}

  /** The ids of the clips of a chain, outermost first; a clip seen for the first time gets the next id. */
  clipIds(chain: ClipNode | undefined): string[] {
    const nodes: ClipNode[] = [];
    for (let node: ClipNode | null = chain ?? null; node !== null; node = node.parent) nodes.push(node);
    return nodes.reverse().map((node) => {
      let id = this.ids.get(node);
      if (id === undefined) {
        id = `c${this.ids.size + 1}`;
        this.ids.set(node, id);
        const def = clipDef(node.def, this.scope.len);
        this.clips[id] = def;
        this.weigh(clipWeight(def));
      }
      return id;
    });
  }
}

class SlideBuilder {
  readonly masks: Record<string, MaskDef> = {};
  readonly notes: Note[] = [];
  /** The soft masks built, in the order of their ids (`m<n>` is the n-th), with the path they are known at. */
  private readonly maskOrder: { cells: CellPath; mask: SoftMask; id: string }[] = [];
  /** The elements made so far, in tile cells and soft masks too, and those a fallback replaced (`ELEMENT_BUDGET`). */
  private made = 0;
  /**
   * The weight made so far (weight.ts): each element's, its path's segments, its glyphs and the segments of the clip
   * paths made, in tile cells and soft masks too, and what a fallback replaced (`SLIDE_WEIGHT_BUDGET`). It only grows.
   */
  private weight = 0;
  /** The role paths of the page's marked-content ids (`provenance.struct`). */
  private readonly struct: Map<number, string[]>;
  /** The page, as the raw reader is to find it: by its reference, else its index (`rawPageIndex`). */
  private readonly rawPage: RawPageKey;

  constructor(
    private readonly pageIndex: number,
    private readonly ctx: BuildContext,
    private readonly strict: boolean,
  ) {
    this.struct = joinStructure(ctx.page);
    this.rawPage = { index: pageIndex, ref: ctx.page.pageRef };
  }

  /**
   * Past what leaves room for one fallback of the page under `SLIDE_WEIGHT_BUDGET`: from here on no paint of the slide is
   * built (lenient mode: `restOfScope`). So what is kept weighs at most the budget less a fallback, and the one fallback
   * that follows keeps the slide within it.
   */
  private get overWeight(): boolean {
    return this.overAt(this.weight);
  }

  /** Whether a slide weighing `weight` is past the room it must leave for one fallback (`overWeight`). */
  private overAt(weight: number): boolean {
    return weight > SLIDE_WEIGHT_BUDGET - PAGE_UNIT.fallback;
  }

  /**
   * Adds what an element made by `make` in `into` weighs besides what `base` counted for its kind (weight.ts
   * `ownWeight`): its path's segments, its glyphs, and on the page the clip geometry it may take.
   */
  private weigh(el: Element | null, into: Container): void {
    if (el === null) return;
    const nested = !into.scope.inPage;
    if (el.kind === 'shape') this.weight += pathWeight(el.geom, nested);
    else if (el.kind === 'textline') for (const run of el.runs) this.weight += run.glyphs.length * GLYPH_UNIT;
    if (!nested) this.weight += takenClipWeight(el, into.clips);
  }

  /**
   * The elements of `ops`, in paint order, in a scope of their own. In lenient mode a scope that goes past the slide's
   * weight budget (or starts past it) ends there: its paints from that one on are one fallback (`restOfScope`).
   *
   * `ops` is read once, in order, and nothing of an op is kept once its element is made: the page's ops come straight
   * from the walk (`walkOps`), so a page of a million paints does not hold a million RawOps while its slide is built
   * (final review F2), and the ops past the budget are only read for their op index and box.
   */
  async build(ops: Iterable<RawOp>, scope: Scope): Promise<Container> {
    const into = new Container(scope, (weight) => (this.weight += weight));
    /**
     * The text line of each run, made at its first glyph: a run's glyphs may have the shade of its text between them. Null
     * for a run whose line could not be built (lenient mode): its fallback covers its glyphs.
     */
    const lines = new Map<RunData, TextLineEl | null>();
    const rest = ops[Symbol.iterator]();
    for (let next = rest.next(); next.done !== true; next = rest.next()) {
      const op = next.value;
      if (!this.strict && this.overWeight) {
        into.elements.push(await this.restOfScope(op, rest, into));
        break;
      }
      if (op.kind === 'glyph' || op.kind === 'invisible') {
        const line = op.run === undefined ? undefined : lines.get(op.run);
        if (line === undefined) {
          const made = await this.attempt(op, into, () => this.textLine(op, required(op, 'run'), into));
          if (made === PAST_BUDGET) {
            into.elements.push(await this.restOfScope(op, rest, into));
            break;
          }
          if (op.run !== undefined) lines.set(op.run, made.kind === 'textline' ? made : null);
          into.elements.push(made);
        } else if (line !== null) {
          if (this.overAt(this.weight + GLYPH_UNIT)) {
            // The glyph would take the slide past its weight budget: the line keeps the glyphs before it, and this glyph
            // and the rest of the scope are one fallback.
            if (this.strict) throw new SceneTooComplexError('slide');
            this.weight += GLYPH_UNIT;
            into.elements.push(await this.restOfScope(op, rest, into));
            break;
          } else if (this.strict || glyphIsFinite(op)) {
            this.weight += GLYPH_UNIT;
            addGlyph(line, op, into.scope.len, this.ctx.fonts);
          } else {
            // The line keeps the glyphs before it; one fallback stands for the rest of the run.
            into.elements.push(await this.unbuildable(op, into, 'glyph with a number that is not finite'));
            lines.set(op.run!, null);
          }
        }
        continue;
      }
      const element = await this.attempt(op, into, () => this.element(op, into));
      if (element === PAST_BUDGET) {
        into.elements.push(await this.restOfScope(op, rest, into));
        break;
      }
      if (element !== null) into.elements.push(element);
    }
    return into;
  }

  /**
   * Lenient mode, past the slide's weight budget (ruling M3-R40): `first` and every op after it in the scope (`rest`,
   * read to its end) as one `too-complex` fallback, under the id `first` would have had, with one note `slide too
   * complex`. Its `coveredOps` are the distinct op indexes it stands for, in order, but at most `COVERED_OPS_MAX` of
   * them: the ops past that are cut from the list (the fallback still stands for them), so a few KB of PDF cannot make
   * the list, the Scene or the report large. Its `bbox` is the box of the ops' boxes that are finite, null when none is.
   */
  private async restOfScope(first: RawOp, rest: Iterator<RawOp>, into: Container): Promise<FallbackEl> {
    const covered: number[] = [];
    const seen = new Set<number>();
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (let next: IteratorResult<RawOp> = { done: false, value: first }; next.done !== true; next = rest.next()) {
      const { opIndex, bbox } = next.value;
      if (covered.length < COVERED_OPS_MAX && !seen.has(opIndex)) {
        seen.add(opIndex);
        covered.push(opIndex);
      }
      if (bbox.every(Number.isFinite)) [x0, y0, x1, y1] = [Math.min(x0, bbox[0]), Math.min(y0, bbox[1]), Math.max(x1, bbox[2]), Math.max(y1, bbox[3])];
    }
    const op = first;
    const bbox = x0 === Infinity ? null : box([x0, y0, x1, y1], into.scope.len);
    const fallback = { ...(await this.fallback(op, into, 'too-complex', 'slide too complex', bbox)), coveredOps: covered };
    if (!canWrite(fallback)) throw new Error(`buildSlide: the fallback of the ops from ${op.opIndex} has a number that is not finite`);
    return fallback;
  }

  /**
   * `make`'s element. In lenient mode, when it throws or its element has a number that is not finite, the RawOp's
   * `unbuildable` fallback instead; when a tile cell of it was past the slide's element budget (`SceneTooComplexError`),
   * its `too-complex` fallback with the note `tile cell too large`. What `make` left is undone first, so the fallback is
   * as if the element had never been tried: the ids it took (the fallback takes the element's), its notes, the soft
   * masks it built, and the fonts and media it added to the deck (no other slide's font keys or media move). The
   * fallback builds again what it needs (its masks). The elements it made still count against the budgets, so a slide
   * past them stays past them.
   *
   * The weight budget (rulings M2-R36, M2-R37, M3-R40): when making the element, with its tile cells and soft masks,
   * takes the slide past `SLIDE_WEIGHT_BUDGET`, it is undone as above and `PAST_BUDGET` is returned: `build` makes it and
   * the rest of its scope one fallback (`restOfScope`). Strict mode throws `SceneTooComplexError` instead.
   */
  private async attempt<T extends Element | null>(
    op: RawOp,
    into: Container,
    make: () => Promise<T>,
  ): Promise<T | FallbackEl | typeof PAST_BUDGET> {
    if (this.strict) {
      const made = await make();
      this.weigh(made, into);
      if (this.overWeight) throw new SceneTooComplexError('slide');
      return made;
    }
    const marks = {
      ids: into.scope.ids.mark(),
      notes: this.notes.length,
      masks: this.maskOrder.length,
      fonts: this.ctx.fonts.mark(),
      media: this.ctx.media.mark(),
    };
    let reason = 'unbuildable';
    let detail: string | null;
    try {
      const made = await make();
      this.weigh(made, into);
      if (this.overWeight) {
        detail = null;
      } else if (made === null || writable(made)) {
        return made;
      } else {
        detail = 'paint with a number that is not finite';
      }
    } catch (error) {
      if (error instanceof SceneTooComplexError) {
        reason = 'too-complex';
        detail = 'tile cell too large';
      } else {
        detail = 'paint the Scene could not build';
      }
    }
    into.scope.ids.rewind(marks.ids);
    this.notes.length = marks.notes;
    for (const { cells, mask, id } of this.maskOrder.splice(marks.masks)) {
      cells.masks.delete(mask);
      delete this.masks[id];
    }
    this.ctx.fonts.rewind(marks.fonts);
    this.ctx.media.rewind(marks.media);
    return detail === null ? PAST_BUDGET : this.unbuildable(op, into, detail, reason);
  }

  /**
   * Lenient mode: a RawOp the Scene cannot build, as a fallback (`unbuildable`, or `too-complex` for one whose tile
   * cell was past the budget) with a note. Its `bbox` is the RawOp's when that is finite. Throws when even the fallback
   * cannot be written: the slide cannot be built.
   */
  private async unbuildable(op: RawOp, into: Container, detail: string, reason = 'unbuildable'): Promise<FallbackEl> {
    const bbox = op.bbox.every(Number.isFinite) ? box(op.bbox, into.scope.len) : null;
    const fallback = await this.fallback(op, into, reason, detail, bbox);
    if (!canWrite(fallback)) throw new Error(`buildSlide: the fallback of RawOp ${op.kind} at op ${op.opIndex} has a number that is not finite`);
    return fallback;
  }

  private async element(op: RawOp, into: Container): Promise<Element | null> {
    const { len, opList } = into.scope;
    switch (op.kind) {
      case 'unsupported':
        return this.fallback(op, into, 'unsupported-op', op.unsupported ?? 'operator the walker does not model', null);
      case 'fill': {
        const base = await this.base(op, into, 'shape');
        return shape(base, path(required(op, 'path'), len), op.evenOdd ? 'evenodd' : 'nonzero', solid(op), null, box(op.bbox, len));
      }
      case 'stroke': {
        // A stroke fills nothing: its `fillRule` is the default, `nonzero`.
        const line = lineStyle(required(op, 'line'), required(op, 'lineCtm'), solid(op), len);
        const base = await this.base(op, into, 'shape');
        return shape(base, path(required(op, 'path'), len), 'nonzero', null, line, box(op.bbox, len));
      }
      case 'image': {
        const pixels = imagePixels({ ops: opList, obj: this.ctx.page.obj }, op);
        if (pixels === null) return this.fallback(op, into, 'image-unreadable', 'image pdf.js could not decode');
        return this.picture(op, await this.base(op, into, 'picture'), pixels, len);
      }
      case 'shade':
      case 'pattern':
        if (op.stencil === true) return this.fallback(op, into, 'stencil-pattern', 'image mask filled with a pattern');
        if (op.text === true) return null; // the run of the text it fills holds it (`TextRun.fill`)
        return this.patterned(op, into);
      case 'glyph':
      case 'invisible':
        throw new Error(`RawOp ${op.kind} at op ${op.opIndex} is text: build() makes its line`);
    }
  }

  /**
   * The text line of a run, from its first glyph: one `TextRun` with what the run shares (`RunData`), its font from
   * `ctx.fonts`, and the glyph. The run's other glyphs are added as they come (`addGlyph`).
   *
   * - `rgb` and `alpha` are the glyph's (0002 §6: of the fill, of the stroke when only that paints; null and 1 for a clip and
   *   for invisible text); `fill` is the fill when the run fills (a pattern too) and `stroke` the stroke when it strokes in
   *   a colour, with its width (`wPt`). `fillMode` is the glyph's `paint`, `noFill` for invisible text (Tr 3).
   * - `bold` and `italic` are the font's own (nameID 2); `spcPt` (Tc × Tz along the x axis), `hScale` (Tz), `skew` and
   *   `rise` (Ts along the y axis) are the raw evidence of synthetic bold and italic, which M4 decides.
   * - `skew` is the tangent of the angle by which the text's y axis leans from the perpendicular of its x axis, towards it:
   *   (a c + b d) / |a d − b c| of the text matrix, 0.2 for the usual synthetic italic.
   * - `baseline` is the first glyph's origin without the rise; `angleDeg` the direction of the x axis on the slide,
   *   clockwise (y runs down), 0 to < 360, as `PictureEl.xfrm.rotDeg`; `bboxPt` the box of the glyphs' advance boxes.
   */
  private async textLine(op: RawOp, run: RunData, into: Container): Promise<TextLineEl> {
    const base = await this.base(op, into, 'textline');
    const { len } = into.scope;
    const glyph = required(op, 'glyph');
    const font = this.ctx.fonts.resolve(glyph.font, this.rawPage, { type3: glyph.type3 === true, missingFile: run.missingFile });
    const [a, b, c, d] = run.matrix;
    const det = a * d - b * c;
    const stroke = run.stroke;
    const textRun: TextRun = {
      text: '',
      fontKey: font.key,
      sizePt: len(glyph.size),
      rgb: op.rgb === null ? null : [op.rgb[0], op.rgb[1], op.rgb[2]],
      alpha: roundUnitless(op.alpha),
      fillMode: op.kind === 'invisible' ? 'noFill' : glyph.paint,
      stroke:
        stroke === null || stroke.rgb === null
          ? null
          : { rgb: [stroke.rgb[0], stroke.rgb[1], stroke.rgb[2]], alpha: roundUnitless(stroke.alpha), wPt: len(stroke.w) },
      fill: await this.runFill(op, run, base.id, into.scope),
      bold: font.bold,
      italic: font.italic,
      spcPt: len(run.charSpacing * run.hScale * Math.sqrt(a * a + b * b)),
      hScale: roundUnitless(run.hScale),
      skew: det === 0 ? 0 : roundUnitless((a * c + b * d) / Math.abs(det)),
      rise: len(run.rise * Math.sqrt(c * c + d * d)),
      glyphs: [],
    };
    // A pattern stroke has no colour to give the run (`stroke` is null): the slide says it was lost.
    if (stroke !== null && stroke.rgb === null) this.note(op, into.scope, 'text stroked with a pattern');
    const line: TextLineEl = {
      ...base,
      kind: 'textline',
      runs: [textRun],
      baseline: { x: len(glyph.x - run.rise * c), y: len(glyph.y - run.rise * d) },
      angleDeg: clockwiseDegrees(Math.atan2(b, a)),
      wmode: glyph.wmode,
      bboxPt: box(op.bbox, len),
    };
    addGlyph(line, op, len, this.ctx.fonts);
    return line;
  }

  /**
   * What a text run fills with, when it fills: its colour, or the gradient or tile cell (in a scope of its own under the
   * line's id) of the pattern its stretch's `shade` or `pattern` paints. A shading pdf.js could not read gives no fill and a
   * note.
   */
  private async runFill(op: RawOp, run: RunData, id: string, scope: Scope): Promise<Fill | null> {
    const fill = run.fill;
    if (fill === null) return null;
    switch (fill.kind) {
      case 'rgb':
        return { kind: 'solid', rgb: [fill.rgb[0], fill.rgb[1], fill.rgb[2]], alpha: roundUnitless(fill.alpha) };
      case 'shading': {
        const gradient = gradientFill(fill.shading, fill.alpha, scope.len);
        if (gradient === null) this.note(op, scope, 'text shading pdf.js could not read');
        return gradient;
      }
      case 'tile':
        return this.tileFill(op, fill.tile, fill.alpha, id, scope);
    }
  }

  /**
   * What every element has (`ElementBase`): its id, its clips in this scope, its groups and the innermost soft mask over it,
   * its own if it has one, else the one its innermost group took (ruling M2-R14).
   */
  private async base(op: RawOp, into: Container, kind: Element['kind']): Promise<ElementBase> {
    const { scope } = into;
    this.made++; // every element starts here, a fallback too
    this.weight += scope.inPage ? PAGE_UNIT[kind] : NESTED_UNIT;
    const id = scope.ids.next(op.opIndex);
    const groups: GroupRef[] = [];
    for (const group of op.groups) groups.push(await this.groupRef(op, group, scope));
    let mask = op.masked ? await this.maskId(softMaskOf(op, op.softMask), scope) : null;
    for (let i = groups.length - 1; i >= 0 && mask === null; i--) mask = groups[i]!.mask;
    // The structure tree names the page's marked content only: a soft mask's or a tile cell's is no part of it.
    const struct = op.mcid === null || !scope.inPage ? undefined : this.struct.get(op.mcid);
    return {
      id,
      provenance: { opIndex: [op.opIndex], mcid: op.mcid, struct: struct === undefined ? null : [...struct] },
      clip: into.clipIds(op.clipChain),
      clipBox: box(op.clip, scope.len),
      groups,
      mask,
      blend: op.blend,
    };
  }

  /** A GroupFrame with the id of the mask it took, if any. */
  private async groupRef(op: RawOp, group: GroupFrame, scope: Scope): Promise<GroupRef> {
    return {
      alpha: roundUnitless(group.alpha),
      blend: group.blend,
      isolated: group.isolated,
      knockout: group.knockout,
      bbox: group.bbox === null ? null : box(group.bbox, scope.len),
      mask: group.masked ? await this.maskId(softMaskOf(op, group.mask), scope) : null,
    };
  }

  /**
   * The id of a soft mask in the slide's `masks`: `m<n>` in the order masks are first used, a mask known by the tile
   * cells it is met in (`CellPath`) and itself. The first use builds its elements, in the frame of the scope that uses
   * it (a mask's ops are of the same operator list), with clips of its own.
   */
  private async maskId(mask: SoftMask, scope: Scope): Promise<string> {
    const { cells } = scope;
    let id = cells.masks.get(mask);
    if (id === undefined) {
      id = `m${this.maskOrder.length + 1}`;
      cells.masks.set(mask, id);
      this.maskOrder.push({ cells, mask, id });
      const backdrop: Rgb | null = mask.backdrop === null ? null : [mask.backdrop[0], mask.backdrop[1], mask.backdrop[2]];
      const def: MaskDef = { subtype: mask.subtype, backdrop, elements: [], clips: {} };
      this.masks[id] = def;
      const built = await this.build(mask.ops, { ...scope, opList: mask.opList, where: `${scope.where} in a soft mask`, inPage: false });
      def.elements = built.elements;
      def.clips = built.clips;
    }
    return id;
  }

  /** A shape a shade or pattern paints, or a fallback for a shading pdf.js could not read. */
  private async patterned(op: RawOp, into: Container): Promise<ShapeEl | FallbackEl> {
    const { len } = into.scope;
    if (op.kind === 'shade') {
      const fill = gradientFill(op.shading, op.alpha, len);
      if (fill === null) return this.fallback(op, into, 'shading-unreadable', 'shading pdf.js could not read');
      return patternShape(op, await this.base(op, into, 'shape'), fill, len);
    }
    const tile = op.tile;
    if (tile === undefined) throw new Error(`RawOp ${op.kind} at op ${op.opIndex} has no tile`);
    const base = await this.base(op, into, 'shape');
    return patternShape(op, base, await this.tileFill(op, tile, op.alpha, base.id, into.scope), len);
  }

  /**
   * A tiling pattern's fill at fill alpha `alpha`: its cell, whose elements are built in cell space, in a scope of their own:
   * ids under the id of the element the cell fills, lengths to 6 decimals (M2-R13), notes about the page op `op` that
   * paints the cell. Throws `SceneTooComplexError`, and builds nothing, when the slide has made more than
   * `ELEMENT_BUDGET` elements.
   */
  private async tileFill(op: RawOp, tile: TileInfo, alpha: number, id: string, scope: Scope): Promise<Fill> {
    if (this.made > ELEMENT_BUDGET) throw new SceneTooComplexError();
    const cellScope: Scope = {
      opList: tile.opList,
      ids: new Ids(`${id}/`),
      len: roundUnitless,
      noteAt: () => scope.noteAt(op),
      where: `${scope.where} in a tile cell`,
      inPage: false,
      cells: scope.cells.child(tile),
    };
    const built = await this.build(tile.ops, cellScope);
    const cell: TileCell = {
      bbox: box(tile.bbox, roundUnitless),
      xStep: roundUnitless(tile.xStep),
      yStep: roundUnitless(tile.yStep),
      matrix: matrixOf(tile.matrix, scope.len), // into the frame of the element it fills
      paintType: tile.paintType,
      elements: built.elements,
      clips: built.clips,
    };
    return { kind: 'tile', cell, alpha: roundUnitless(alpha) };
  }

  /**
   * A fallback element and its note: op names and fixed words only (Global Constraints, Privacy). `bbox`: what it covers,
   * by default the RawOp's box.
   */
  private async fallback(
    op: RawOp,
    into: Container,
    reason: string,
    detail: string,
    bbox: Box | null = box(op.bbox, into.scope.len),
  ): Promise<FallbackEl> {
    this.note(op, into.scope, detail);
    const base = await this.base(op, into, 'fallback');
    return { ...base, kind: 'fallback', reason, coveredOps: [op.opIndex], raster: null, bbox };
  }

  /**
   * A note of the slide about `op`: the page op `noteAt` gives (in a tile cell, the one that paints the cell), the name of
   * `op`'s own operator in its scope's operator list (in a cell, the cell's: `Note`), and fixed words only (Global
   * Constraints, Privacy).
   */
  private note(op: RawOp, scope: Scope, detail: string): void {
    this.notes.push({ opIndex: scope.noteAt(op), op: opNameAt({ ops: scope.opList }, op.opIndex), detail: `${detail}${scope.where}` });
  }

  /**
   * An image as a picture: its media (the JPEG as it is when there is one, else a PNG of `pixels`), its matrix and the
   * frame DrawingML would say it with (`pictureXfrm`). A stencil's picture is its mask in its colour.
   */
  private async picture(op: RawOp, base: ElementBase, pixels: ImagePixels, len: Round): Promise<PictureEl> {
    const ctm = required(op, 'ctm');
    const rgb = op.stencil === true ? required(op, 'rgb') : null;
    const stencil: Rgb | null = rgb === null ? null : [rgb[0], rgb[1], rgb[2]];
    if ((pixels.format === 'mask') !== (stencil !== null)) {
      throw new Error(`RawOp image at op ${op.opIndex} is ${stencil === null ? 'no' : 'a'} stencil and its pixels are ${pixels.format}`);
    }
    const jpeg = stencil === null ? this.ctx.media.jpeg(this.rawPage, op.imageRef) : null;
    const info = await this.ctx.media.addImage(stencil === null ? pixels : { ...pixels, fill: stencil }, jpeg);
    const { xfrm, skewed } = pictureXfrm(ctm, len);
    return {
      ...base,
      kind: 'picture',
      mediaHash: info.hash,
      matrix: matrixOf(ctm, len),
      xfrm,
      skewed,
      alpha: roundUnitless(op.alpha),
      stencil,
      px: op.px === undefined ? null : [op.px[0], op.px[1]],
    };
  }
}

/**
 * The shape of a shade or pattern: of a stroke, its path with the paint as `line.paint`; of a filled path, the path with
 * the paint as `fill`; of `sh`, no path (it paints its whole clip). Its `bbox` is the path's (0002 §4), as a solid shape's;
 * its `clipBox` holds the shape (ruling M2-R12).
 */
function patternShape(op: RawOp, base: ElementBase, paint: Fill, len: Round): ShapeEl {
  if (op.line !== undefined) {
    const line = lineStyle(op.line, required(op, 'lineCtm'), paint, len);
    return shape(base, path(required(op, 'path'), len), 'nonzero', null, line, box(required(op, 'pathBox'), len));
  }
  if (op.path !== undefined) {
    return shape(base, path(op.path, len), op.evenOdd ? 'evenodd' : 'nonzero', paint, null, box(required(op, 'pathBox'), len));
  }
  if (op.kind !== 'shade') throw new Error(`RawOp ${op.kind} at op ${op.opIndex} has no path`);
  return shape(base, null, 'nonzero', paint, null, box(op.bbox, len));
}

/** A shape element: what every element has, and what it draws. */
function shape(
  base: ElementBase,
  geom: PathSeg[] | null,
  fillRule: ShapeEl['fillRule'],
  fill: Fill | null,
  line: LineStyle | null,
  bbox: Box,
): ShapeEl {
  return { ...base, kind: 'shape', geom, fillRule, fill, line, bbox };
}

/**
 * A shade's gradient, at fill alpha `fillAlpha`: `linear` or `radial` with its stops and extend flags (`gradientStops`),
 * its geometry in shading space and `matrix` from shading space to the frame, or `shading` for a function-based shading or
 * a mesh, with the triangles pdf.js made of it (`meshOf`, M5). Shading-space numbers have no unit of pt and are kept to 6
 * decimals. Null when pdf.js could not read the shading.
 */
function gradientFill(shading: RawOp['shading'], fillAlpha: number, len: Round): Fill | null {
  if (shading === undefined) return null;
  const alpha = roundUnitless(fillAlpha);
  if (!('colorStops' in shading)) {
    return { kind: 'shading', shading: shading.type, alpha, mesh: shading.mesh === undefined ? null : meshOf(shading.mesh, matrixOf(shading.ctm, len)) };
  }
  const read = gradientStops(shading.colorStops);
  if (read === null) return null;
  const stops = read.stops.map(({ t, rgb }) => ({ t: roundUnitless(t), rgb }));
  const p0: [number, number] = [roundUnitless(shading.p0[0]), roundUnitless(shading.p0[1])];
  const p1: [number, number] = [roundUnitless(shading.p1[0]), roundUnitless(shading.p1[1])];
  const { extend } = read;
  const matrix = matrixOf(shading.ctm, len);
  if (shading.type === 'axial') return { kind: 'linear', stops, p0, p1, matrix, extend, alpha };
  return { kind: 'radial', stops, p0, r0: roundUnitless(shading.r0), p1, r1: roundUnitless(shading.r1), matrix, extend, alpha };
}

/**
 * The Scene's mesh of pdf.js' (`ShadingMesh`, M5): each vertex once, by its place (6 decimals) and colour, in the order
 * pdf.js first gives it, and the triangles as triples of their indices, in pdf.js' order, which is the paint order. A
 * lattice, which pdf.js gives as two triangles a cell of six vertices each, so keeps each vertex once.
 */
function meshOf(raw: RawMesh, matrix: number[]): ShadingMesh {
  const xy: number[] = [];
  const rgb: number[] = [];
  const triangles: number[] = [];
  const seen = new Map<string, number>();
  for (let v = 0; v < raw.count; v++) {
    const x = roundUnitless(raw.pos[v * 2]!);
    const y = roundUnitless(raw.pos[v * 2 + 1]!);
    const [r, g, b] = [raw.col[v * 4]!, raw.col[v * 4 + 1]!, raw.col[v * 4 + 2]!];
    const key = `${x} ${y} ${r} ${g} ${b}`;
    let index = seen.get(key);
    if (index === undefined) {
      index = seen.size;
      seen.set(key, index);
      xy.push(x, y);
      rgb.push(r, g, b);
    }
    triangles.push(index);
  }
  const type = raw.shadingType === 1 || (raw.shadingType >= 4 && raw.shadingType <= 7) ? (raw.shadingType as ShadingMesh['type']) : 4;
  const bbox = raw.bbox === null ? null : (raw.bbox.map(roundUnitless) as Box);
  const background = raw.background === null ? null : (raw.background.map((c) => Math.min(255, Math.max(0, Math.round(c)))) as Rgb);
  return { type, xy, rgb, triangles, matrix, bbox, background };
}

/**
 * The frame of a picture painted under `m`, the PDF's unit square → slide frame (0002 §16: the square's origin is the
 * image's bottom left corner and its y axis runs up the image, so an upright image has d < 0; ruling M2-R9), as
 * `PictureEl.xfrm` says it: the image's top edge, left to right, is (a, b), and its left edge, top to bottom, is (−c, −d).
 *
 * - `w` and `h` are the lengths of those edges, and the box is centred where the image is: m (0.5, 0.5).
 * - Not mirrored (ad − bc < 0, as upright): no flip, and `rotDeg` is the direction of the top edge, atan2(b, a).
 * - Mirrored (ad − bc > 0): `flipH` with the turn atan2(−b, −a), or `flipV` with atan2(b, a), the same picture. The one
 *   whose turn is under 90 degrees either way is taken, which is `flipH` when a < 0 and `flipV` when a > 0; at a = 0
 *   (to 6 decimals, the precision of `PictureEl.matrix`, so noise in a turn of 90 degrees does not decide) `flipV`.
 * - `rotDeg` runs clockwise on the slide (y down), 0 to < 360, to 6 decimals.
 * - `skewed`: the edges are not perpendicular within 0.01° (as M2-R4); then the box is only near the image.
 * - `len` rounds the lengths: `roundPt` in the slide frame; in a tile cell's space, whose unit is not pt, `roundUnitless`.
 *
 * Example: [86.602540, 50, 25, −43.301270, 144.198730, 146.650635] has ad − bc = −5000, so no flip; w = 100, h = 50;
 * rotDeg = atan2(50, 86.60254) = 30; the centre is (144.19873 + (86.60254 + 25) / 2, 146.650635 + (50 − 43.30127) / 2) =
 * (200, 150), so x = 150 and y = 125.
 */
export function pictureXfrm(m: readonly number[], len: Round = roundPt): { xfrm: PictureEl['xfrm']; skewed: boolean } {
  const [a, b, c, d, e, f] = m as [number, number, number, number, number, number];
  const w = Math.sqrt(a * a + b * b);
  const h = Math.sqrt(c * c + d * d);
  let flipH = false;
  let flipV = false;
  let turn: number;
  if (a * d - b * c <= 0) {
    // An image with no width has the direction of its left edge, (−c, −d) = h (−sin, cos).
    turn = w > 0 ? Math.atan2(b, a) : h > 0 ? Math.atan2(c, -d) : 0;
  } else if (roundUnitless(a) < 0) {
    flipH = true;
    turn = Math.atan2(-b, -a);
  } else {
    flipV = true;
    turn = Math.atan2(b, a);
  }
  const [cx, cy] = [e + (a + c) / 2, f + (b + d) / 2];
  const dot = a * c + b * d;
  return {
    xfrm: { x: len(cx - w / 2), y: len(cy - h / 2), w: len(w), h: len(h), rotDeg: clockwiseDegrees(turn), flipH, flipV },
    skewed: dot * dot > SKEW_SINE * SKEW_SINE * (a * a + b * b) * (c * c + d * d),
  };
}

/** A turn in radians on the slide (y down, so clockwise) as degrees 0 to < 360, to 6 decimals. */
function clockwiseDegrees(turn: number): number {
  let degrees = roundUnitless((turn * 180) / Math.PI);
  if (degrees < 0) degrees = roundUnitless(degrees + 360);
  return degrees >= 360 ? 0 : degrees;
}

/**
 * Adds a glyph RawOp to its line's run: its code point to `text`, its origin and advance to `glyphs`, its advance box to
 * `bboxPt`. Rounding keeps the order of numbers, so the box of rounded boxes is the rounded box. A glyph of a symbol font
 * (M8 round 1a) has its character in the font's own encoding as `sym` (`FontTable.symbolChar`, from its code).
 */
function addGlyph(line: TextLineEl, op: RawOp, len: Round, fonts: Pick<FontTable, 'symbolChar'>): void {
  const glyph = required(op, 'glyph');
  const run = line.runs[0]!;
  run.text += glyph.u;
  const sym = glyph.code === undefined ? null : fonts.symbolChar(run.fontKey, glyph.code);
  run.glyphs.push({ u: glyph.u, x: len(glyph.x), y: len(glyph.y), adv: len(glyph.adv), ...(sym === null ? {} : { sym }) });
  const [x0, y0, x1, y1] = box(op.bbox, len);
  const b = line.bboxPt;
  line.bboxPt = [Math.min(b[0], x0), Math.min(b[1], y0), Math.max(b[2], x1), Math.max(b[3], y1)];
}

/**
 * Ruling M2-R4: true when the CTM's two axes, the images of the x and y unit vectors (a, b) and (c, d), differ in length
 * by more than 1 % or are more than 0.01° from perpendicular. `a:ln` has one width, so a later pass must know when `w`
 * (the PDF width × √|ad − bc|) is only an average. A CTM that collapses one axis is anisotropic; one that collapses both
 * is not. It compares squared lengths, and the squared sine of the angle off a right angle with `SKEW_SINE`², as
 * `PictureEl.skewed` does: products only, which every engine rounds alike.
 */
export function anisotropic(m: Matrix): boolean {
  const [a, b, c, d] = m;
  const sx = a * a + b * b;
  const sy = c * c + d * d;
  if (sx === 0 || sy === 0) return sx !== sy;
  if (Math.max(sx, sy) > SCALE_SQUARED * Math.min(sx, sy)) return true;
  // The cosine of the angle between the axes is the sine of its distance from a right angle.
  const dot = a * c + b * d;
  return dot * dot > SKEW_SINE * SKEW_SINE * sx * sy;
}

/**
 * The ids of a scope (a soft mask's are its slide's or cell's): `<prefix>z<opIndex>` for the first element of an op, then
 * `:1`, `:2`, ... in the order they are made (M1-R50). What could not be built gives its ids back (`mark`, `rewind`),
 * so its fallback, and the soft masks it builds again, take the same ones.
 */
class Ids {
  private readonly made = new Map<number, number>();
  /** The op of every id made, in order: what `rewind` takes back. */
  private readonly log: number[] = [];

  constructor(private readonly prefix: string) {}

  next(opIndex: number): string {
    const n = this.made.get(opIndex) ?? 0;
    this.made.set(opIndex, n + 1);
    this.log.push(opIndex);
    const id = `${this.prefix}z${opIndex}`;
    return n === 0 ? id : `${id}:${n}`;
  }

  /** How many ids were made. */
  mark(): number {
    return this.log.length;
  }

  /** Forgets the ids made since `mark`. */
  rewind(mark: number): void {
    while (this.log.length > mark) {
      const opIndex = this.log.pop()!;
      this.made.set(opIndex, this.made.get(opIndex)! - 1);
    }
  }
}

/**
 * `canWrite` of an element that lenient `attempt` made, without going into its tile cells' elements again: each of them
 * was made through `attempt` too and so is writable (a later glyph of a line only if it is finite), and a cell's own
 * fields (its box, steps, matrix and clips) are still checked. So nested cells are checked once each, not once per
 * level of cells above them (final review F1).
 */
function writable(element: Element): boolean {
  const cellless = <F extends Fill | null>(fill: F): F =>
    fill?.kind === 'tile' ? ({ ...fill, cell: { ...fill.cell, elements: [] } } as F) : fill;
  switch (element.kind) {
    case 'shape': {
      const line = element.line && { ...element.line, paint: cellless(element.line.paint) };
      return canWrite({ ...element, fill: cellless(element.fill), line });
    }
    case 'textline':
      return canWrite({ ...element, runs: element.runs.map((run) => ({ ...run, fill: cellless(run.fill) })) });
    default:
      return canWrite(element);
  }
}

/** The glyph RawOp's numbers are finite: its origin, advance, size and box. */
function glyphIsFinite(op: RawOp): boolean {
  const glyph = op.glyph;
  return glyph !== undefined && [glyph.x, glyph.y, glyph.adv, glyph.size, ...op.bbox].every(Number.isFinite);
}

/** A field the walker always gives this kind of RawOp; its absence is a bug in the walker, not in the PDF. */
function required<K extends 'path' | 'pathBox' | 'line' | 'lineCtm' | 'rgb' | 'ctm' | 'glyph' | 'run'>(op: RawOp, key: K): NonNullable<RawOp[K]> {
  const value = op[key];
  if (value === undefined || value === null) throw new Error(`RawOp ${op.kind} at op ${op.opIndex} has no ${key}`);
  return value;
}

/** The mask the walker says is over an op or a group of it (`masked`): it always gives one. */
function softMaskOf(op: RawOp, mask: SoftMask | null | undefined): SoftMask {
  if (mask === undefined || mask === null) throw new Error(`RawOp ${op.kind} at op ${op.opIndex} has no softMask`);
  return mask;
}

function solid(op: RawOp): Fill {
  const [r, g, b] = required(op, 'rgb');
  return { kind: 'solid', rgb: [r, g, b], alpha: roundUnitless(op.alpha) };
}

/** The line style in the frame (0002 §15): `cap` and `join` by name, `miter` a ratio. */
function lineStyle(line: LineInv, ctm: Matrix, paint: Fill, len: Round): LineStyle {
  return {
    w: len(line.w),
    cap: CAPS[line.cap],
    join: JOINS[line.join],
    miter: roundUnitless(line.miter),
    dash: line.dash.map(len),
    phase: len(line.phase),
    anisotropic: anisotropic(ctm),
    paint,
  };
}

/** A clip of the walker's chain, rounded. */
function clipDef(def: ClipDef, len: Round): ClipDef {
  switch (def.kind) {
    case 'path':
      return { kind: 'path', geom: path(def.geom, len), rule: def.rule, bbox: box(def.bbox, len) };
    case 'box':
      return { kind: 'box', bbox: box(def.bbox, len) };
    case 'text':
      return { kind: 'text', bbox: box(def.bbox, len), approx: true };
  }
}

/** A matrix into a frame: a to d unitless (6 decimals), e and f lengths of that frame. */
function matrixOf(m: readonly number[], len: Round): number[] {
  return [roundUnitless(m[0]!), roundUnitless(m[1]!), roundUnitless(m[2]!), roundUnitless(m[3]!), len(m[4]!), len(m[5]!)];
}

function box(b: Box, len: Round): Box {
  return [len(b[0]), len(b[1]), len(b[2]), len(b[3])];
}

function path(segs: PathSeg[], len: Round): PathSeg[] {
  return segs.map((seg) => seg.map((v) => (typeof v === 'number' ? len(v) : v)) as PathSeg);
}
