/**
 * The DrawingML model the writer serialises: a slide is a list of nodes in z-order, each already in slide EMU. It knows
 * nothing of PDF; `@deckback/core` lowers its Scene into it.
 */

export type Emu = number;                       // integer
export type Pct = number;                       // 0..100000 (1/1000 %)
export interface OxFrame { x: Emu; y: Emu; w: Emu; h: Emu; rot: number /* 60000ths of a degree, 0..21599999 */; flipH: boolean; flipV: boolean }
export type OxLink = { kind: 'url'; url: string } | { kind: 'slide'; slide: number /* 1-based */ };
export type OxCmd = ['M', Emu, Emu] | ['L', Emu, Emu] | ['C', Emu, Emu, Emu, Emu, Emu, Emu] | ['Z'];
export interface OxPath { w: Emu; h: Emu; fill: boolean; stroke: boolean; cmds: OxCmd[] }
export interface OxStop { pos: Pct; rgb: string /* RRGGBB */; alpha: Pct }
/**
 * A circle path gradient (`a:path path="circle"`): `fillToRect`, the point position 0 is at, as insets (l, t, r, b) of the
 * shape's box; `tileRect` (`a:tileRect`, insets of the shape's box, negative outwards), when given, the box whose centre
 * the circle of position 100000 is about, through its corners (measured in PowerPoint, M5 Task 3), else the shape's box.
 */
export interface OxCircleShade { kind: 'circle'; fillToRect: [Pct, Pct, Pct, Pct]; tileRect?: [Pct, Pct, Pct, Pct] }
export type OxFill =
  | { kind: 'none' }
  | { kind: 'solid'; rgb: string; alpha: Pct }
  | { kind: 'grad'; stops: OxStop[]; shade: { kind: 'lin'; ang: number; scaled: boolean } | OxCircleShade; rotWithShape: boolean }
  | { kind: 'blip'; media: string; alpha: Pct; mode: { kind: 'stretch'; fillRect: [Pct, Pct, Pct, Pct] } | { kind: 'tile'; tx: Emu; ty: Emu; sx: Pct; sy: Pct } }
  /** A preset pattern (`a:pattFill`, ruling M5-R10): its ST_PresetPatternVal and its two colours. */
  | { kind: 'patt'; prst: OxPresetPattern; fg: { rgb: string; alpha: Pct }; bg: { rgb: string; alpha: Pct } };

/** 20.1.10.51 ST_PresetPatternVal: DrawingML's 54 preset patterns. */
export const PRESET_PATTERNS = [
  'pct5', 'pct10', 'pct20', 'pct25', 'pct30', 'pct40', 'pct50', 'pct60', 'pct70', 'pct75', 'pct80', 'pct90',
  'horz', 'vert', 'ltHorz', 'ltVert', 'dkHorz', 'dkVert', 'narHorz', 'narVert', 'dashHorz', 'dashVert',
  'cross', 'dnDiag', 'upDiag', 'ltDnDiag', 'ltUpDiag', 'dkDnDiag', 'dkUpDiag', 'wdDnDiag', 'wdUpDiag',
  'dashDnDiag', 'dashUpDiag', 'diagCross', 'smCheck', 'lgCheck', 'smGrid', 'lgGrid', 'dotGrid',
  'smConfetti', 'lgConfetti', 'horzBrick', 'diagBrick', 'solidDmnd', 'openDmnd', 'dotDmnd', 'plaid',
  'sphere', 'weave', 'divot', 'shingle', 'wave', 'trellis', 'zigZag',
] as const;
export type OxPresetPattern = (typeof PRESET_PATTERNS)[number];
export interface OxLineStyle { w: Emu; fill: OxFill; cap: 'flat' | 'rnd' | 'sq'; join: 'round' | 'bevel' | 'miter'; miterLim: number /* lim units: 1000ths of a percent, the ratio x 100000 (800000 is 8) */; dash: number[] | null /* ds/sp pairs in 1000ths of % of w; null = solid */ }
interface OxBase { name: string; frame: OxFrame; link: OxLink | null }
export interface OxShape extends OxBase { kind: 'shape'; geom: { kind: 'rect' } | { kind: 'custom'; paths: OxPath[] }; fill: OxFill; line: OxLineStyle | null }
export interface OxConnector extends OxBase { kind: 'line'; line: OxLineStyle }
/**
 * A run. `kern`: the smallest size kerned, in centipoints (`a:rPr kern`; 0 kerns nothing: PowerPoint's own "no kerning",
 * ruling M4-R3); absent or null writes none, and the template's `kern="1200"` applies.
 */
export interface OxRun { text: string; sz: number /* centipoints */; b: boolean; i: boolean; kern?: number | null /* centipoints */; spc: number /* centipoints */; baseline: number /* 1000ths of % */; fill: OxFill; line: OxLineStyle | null; latin: string | null; ea: string | null; cs: string | null; sym?: string | null /* M8: a symbol font's typeface (a:sym); none when absent or null */; link?: OxLink | null /* M5 Task 5: a run-level link; none when absent or null */ }
/**
 * A paragraph's line spacing (`a:lnSpc`): exactly `val` 100ths of a point (`spcPts`), or `val` 1000ths of a percent of
 * single spacing (`spcPct`). PowerPoint lays the first out in whole points and the second in whole percents (M4 Task 1).
 */
export type OxLineSpacing = { kind: 'pts'; val: number } | { kind: 'pct'; val: number };
/** ST_TextFontAlignType: how the runs of a line of several sizes line up (`a:pPr fontAlgn`). */
export type OxFontAlign = 'auto' | 't' | 'ctr' | 'base' | 'b';
/**
 * A paragraph: its runs, its left margin (`marL`), its line spacing (null: single) and its font alignment (absent or null:
 * none written, the template's). `label` (M5 Task 5, ruling M5-R15): its first character is a list's label, which the
 * writer may write as the paragraph's bullet (text.ts); absent or false for none.
 */
export interface OxParagraph { runs: OxRun[]; marL: Emu; lnSpc: OxLineSpacing | null; fontAlgn?: OxFontAlign | null; label?: boolean }
/**
 * A text box. `warp` (M8 round 1a): `textPlain`, a WordArt transform that moves no glyph (`a:prstTxWarp`), for a box whose
 * text paints nothing: PowerPoint's PDF export then writes its text as an invisible layer (ca 0), as it does WordArt's;
 * without it the export leaves the text out. None when absent or null.
 */
export interface OxTextBox extends OxBase { kind: 'text'; vert: 'horz' | 'eaVert'; paras: OxParagraph[]; warp?: 'textPlain' | null }
/** A picture. `line`: its own outline (M5 Task 5: a picture's border, which PowerPoint strokes outside its frame); none when absent or null. */
export interface OxPicture extends OxBase { kind: 'picture'; media: string; srcRect: [Pct, Pct, Pct, Pct] | null; alpha: Pct; line?: OxLineStyle | null }
export type OxNode = OxShape | OxConnector | OxTextBox | OxPicture;
/** A slide: its nodes in z-order, and its background (`p:bg`, ruling M3-R52), null for none (the master's, noFill, shows). */
export interface OxSlide { nodes: OxNode[]; background: OxFill | null }
