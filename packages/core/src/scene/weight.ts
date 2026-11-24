import type { PathSeg } from '../extract/inventory';
import type { ClipDef, Element, Fill, SceneSlide, ShadingMesh, TileCell } from './types';

/**
 * The size-weighted budgets (rulings M2-R36, M2-R37, M3-R38, M3-R60). An element count alone does not bound a slide: one
 * element can carry a path of a million segments, and a tile cell is copied into every element it fills. So a slide is
 * weighed, in units of about 100 B of live heap each, while it is converted (built, passed, lowered and written):
 *
 * - each element of the page by its kind (`PAGE_UNIT`), its path's segments by their kind (`SEGMENT_UNIT`), its glyphs
 *   (`GLYPH_UNIT`); an element drawn in a path clip whose geometry it may take (an `sh`, which paints its whole clip,
 *   and a picture, which the picture pass may write as its clip's shape) weighs that clip's segments too, as its own;
 * - each element of a tile cell (each copy, as the Scene holds one per fill) and of a soft mask, which the Scene holds
 *   and nothing writes, `NESTED_UNIT`, and its segments and glyphs one each;
 * - each clip path's segments one each;
 * - the triangles of a mesh shading (M5), by their numbers (`meshWeight`).
 *
 * The units (ruling M3-R60; final review F2) are the live heap each kind holds at the peak of one slide's conversion,
 * over 100 B, rounded. Measured 2026-11-11 (Node 24, Windows) with `convert()` on one-page PDFs of n paints of one kind,
 * at two sizes each, the heap sampled after a full collection where the slide is built (less the heap there before the
 * walk, pdf.js' page: ruling M3-R39), where its nodes are about to be written, and where its XML is encoded for the zip
 * (the peak for every kind that is written); a kind's bytes are the difference between the two peaks over the
 * difference in count:
 *
 * | kind | sizes (n x segments or glyphs) | bytes | units |
 * |---|---|---|---|
 * | picture | 5,000; 15,000 | 2,150 | 22 |
 * | shape; a line segment (`L`, `Z`) | 3,000 x 6; 9,000 x 6; 1,000 x 66; 1,000 x 130 | 2,627; 401 | 26; 4 |
 * | a cubic segment (`C`) | 1,000 x 34; 1,000 x 66 | 849 | 8 |
 * | a one-segment subpath, a connector of its own (M3-R49) | 10,000; 20,000 | 1,688 (802 its 2 segments) | `M` 13 |
 * | text line; a glyph | 5,000 x 2; 15,000 x 2; 2,000 x 32; 2,000 x 96 | 4,525; 102 | 45; 1 |
 * | hotspot (pdf.js' own annotation, 2,076 B, aside) | 5,000; 15,000 | 2,433 | 24 |
 * | fallback of the Scene, with its note (and the note's copy in the report, about 44 B) | 10,000; 30,000 | 629 | 7 |
 * | element of a tile cell (5 segments); a segment of it | 100 x 100; 100 x 300 cells; 100 x 50 of 66 | 560; 102 | 6; 1 |
 *
 * Checks of the units against cases they were not taken from: a rect subpath that M3-R49 writes as a rect of its own,
 * 1,704 B (weighed 29); a segment an `sh` takes from its clip, 302 B (weighed 4). So a slide at the budget holds about
 * 50 MB of our own heap whatever it is made of (one image drawn 500,000 times through a form: 46 MB). Before M3-R60
 * every element weighed one: 100,000 pictures (175 MB) weighed 100,000, a fifth of the budget, and 200 `sh` in one clip
 * of 5,000 segments (120 MB) 6,401.
 *
 * The heaviest slide and deck measured (2026-11-11, `slideWeight` of every page of the gate sets out/atlas and
 * out/atlas-win, of the 51-slide deck of the M0-7 perf spec, of the committed corpus/generated and of the fidelity run's
 * private decks; ruling M3-R60), none of whose slides the budget cuts:
 * - slide: 157,538, atlas_msprint.pdf page 37 (out/atlas; 18,459 in the units before M3-R60);
 * - deck: 1,243,470, atlas_msprint.pdf (out/atlas, 159 pages; 161,881 before).
 *
 * `SLIDE_WEIGHT_BUDGET` (rulings M3-R38, M3-R60): 500,000, about 50 MB, 3.2 times the heaviest slide.
 * `DECK_WEIGHT_BUDGET`: 20,000,000, 16 times the heaviest deck. It bounds what `convert` writes, slide after slide
 * (`scenePages`' deck cut, which only `convert` asks for: ruling M3-R41); `extractScene` keeps every slide it builds.
 */
export const SLIDE_WEIGHT_BUDGET = 500_000;
export const DECK_WEIGHT_BUDGET = 20_000_000;

/** An element of the page by its kind. */
export const PAGE_UNIT: Readonly<Record<Element['kind'], number>> = { picture: 22, shape: 26, textline: 45, hotspot: 24, fallback: 7 };
/** A segment of a path of the page by its kind: `M` starts a subpath, which M3-R49 may write as a node of its own. */
export const SEGMENT_UNIT: Readonly<Record<PathSeg[0], number>> = { M: 13, L: 4, C: 8, Z: 4 };
/** A glyph, of the page or not. */
export const GLYPH_UNIT = 1;
/** An element of a tile cell or a soft mask, of any kind; its segments and glyphs weigh one each. */
export const NESTED_UNIT = 6;

/** The weight of a path of the page (`nested` false: by `SEGMENT_UNIT`) or of a cell, mask or clip (one a segment). */
export function pathWeight(geom: readonly PathSeg[] | null, nested = false): number {
  if (geom === null) return 0;
  if (nested) return geom.length;
  let weight = 0;
  for (const seg of geom) weight += SEGMENT_UNIT[seg[0]];
  return weight;
}

/** The weight of one clip: the segments of a clip path, one each; a box or a text clip has none. */
export function clipWeight(def: ClipDef): number {
  return def.kind === 'path' ? pathWeight(def.geom, true) : 0;
}

/**
 * The weight of the clip geometry an element of the page may take (an `sh`: a shape without a path; a picture): the
 * segments of its largest path clip, by `SEGMENT_UNIT`, as the clip pass or the picture pass may write it as the
 * element's own. 0 for any other element.
 */
export function takenClipWeight(el: Element, clips: Readonly<Record<string, ClipDef>>): number {
  if (!((el.kind === 'shape' && el.geom === null) || el.kind === 'picture')) return 0;
  let most = 0;
  for (const id of el.clip) {
    const def = clips[id];
    if (def?.kind === 'path') most = Math.max(most, pathWeight(def.geom));
  }
  return most;
}

/**
 * The weight of an element by itself, of the page or (`nested`) of a tile cell or soft mask: its kind's, its path's
 * segments, its glyphs, and for one of the page the clip geometry it may take (`takenClipWeight`, of `clips`, its
 * scope's clips). Not its tile cells' elements (`elementWeight` counts those).
 */
export function ownWeight(el: Element, nested = false, clips: Readonly<Record<string, ClipDef>> = {}): number {
  let weight = nested ? NESTED_UNIT : PAGE_UNIT[el.kind];
  if (el.kind === 'shape') weight += pathWeight(el.geom, nested);
  if (el.kind === 'textline') for (const run of el.runs) weight += run.glyphs.length * GLYPH_UNIT;
  if (!nested) weight += takenClipWeight(el, clips);
  return weight;
}

/** The weight of a tile cell: its elements (with their own cells) and its clips, all nested. */
function cellWeight(cell: TileCell): number {
  return elementsWeight(cell.elements, true, cell.clips) + clipsWeight(cell.clips);
}

/**
 * The weight of a mesh shading's triangles (M5, `ShadingMesh`), which the Scene holds for the raster renderer: its
 * numbers (five a vertex, three a triangle), 8 B each, in units of 100 B, rounded up. pdf.js' largest lattice, 513 x 513
 * vertices of a function-based shading, weighs 231,097: within `SLIDE_WEIGHT_BUDGET`, as it fits in its 50 MB.
 */
export function meshWeight(mesh: ShadingMesh): number {
  return Math.ceil(((mesh.xy.length / 2) * 5 + mesh.triangles.length) * 8 / 100);
}

function fillWeight(fill: Fill | null): number {
  if (fill?.kind === 'tile') return cellWeight(fill.cell);
  return fill?.kind === 'shading' && fill.mesh !== null ? meshWeight(fill.mesh) : 0;
}

/** The weight of an element with the tile cells it fills or strokes with, a text run's too (`ownWeight`'s arguments). */
export function elementWeight(el: Element, nested = false, clips: Readonly<Record<string, ClipDef>> = {}): number {
  let weight = ownWeight(el, nested, clips);
  if (el.kind === 'shape') weight += fillWeight(el.fill) + fillWeight(el.line?.paint ?? null);
  if (el.kind === 'textline') for (const run of el.runs) weight += fillWeight(run.fill);
  return weight;
}

function elementsWeight(elements: readonly Element[], nested: boolean, clips: Readonly<Record<string, ClipDef>>): number {
  let weight = 0;
  for (const el of elements) weight += elementWeight(el, nested, clips);
  return weight;
}

function clipsWeight(clips: Readonly<Record<string, ClipDef>>): number {
  let weight = 0;
  for (const def of Object.values(clips)) weight += clipWeight(def);
  return weight;
}

/** The weight of a slide: its elements, clips and soft masks (their elements and clips), tile cells included. */
export function slideWeight(slide: SceneSlide): number {
  let weight = elementsWeight(slide.elements, false, slide.clips) + clipsWeight(slide.clips);
  for (const mask of Object.values(slide.masks)) weight += elementsWeight(mask.elements, true, mask.clips) + clipsWeight(mask.clips);
  return weight;
}
