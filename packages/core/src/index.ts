export { inventoryOfDocument, type DocumentInventory } from './extract/document';
export {
  compareInventories,
  type Box,
  type Comparison,
  type Ctm,
  type Glyph,
  type InvisibleGlyph,
  type Inventory,
  type LineInv,
  type PageInv,
  type Paint,
  type PathSeg,
  type ShadingKind,
} from './extract/inventory';
export { useBrowserPdfjs } from './engine/pdfjs-browser-bootstrap';
export { setPdfjsEnvironment, type PdfjsEnvironment } from './engine/pdfjs-adapter';
export { UnsupportedOpError } from './extract/errors';
export { convert, FallbackError, type ConvertOptions, type Converted } from './convert';
export type { FontMap } from './fonts/typefaces';
export { FALLBACK_MAX_PX, FALLBACK_REASONS, PX_PER_PT, rasterize, SLIDE_RASTER_MAX, SLIDE_RASTER_PX, type FallbackReason, type Raster, type RasterCtx } from './raster/raster';
export type { Approximation, Counts, PageClass, SlideReport } from './passes/report';
export { REPORT_SCHEMA, type DroppedLinkCounts, type FontEmbedding, type FontSkip, type Report, type ReportFont } from './report/types';
export { buildSlide, ELEMENT_BUDGET, SceneTooComplexError, type BuildContext } from './scene/build';
export { canonicalJson, sceneHash } from './scene/canonical';
export { extractScene, SceneInputError, type ExtractOptions } from './scene/extract';
export { DECK_WEIGHT_BUDGET, SLIDE_WEIGHT_BUDGET, slideWeight } from './scene/weight';
export { FontTable, type PdfjsFontFacts } from './scene/fonts';
export { inventoryOfSlide } from './scene/inventory';
export { MediaStore, type ImageInput } from './scene/media';
export {
  SCENE_SCHEMA,
  type BlendName,
  type ClipDef,
  type Element,
  type ElementBase,
  type FallbackEl,
  type Fill,
  type FontInfo,
  type GroupRef,
  type HotspotEl,
  type LineStyle,
  type MaskDef,
  type MediaInfo,
  type Note,
  type PictureEl,
  type Rgb,
  type SceneBundle,
  type SceneDeck,
  type SceneSlide,
  type ShadingMesh,
  type ShapeEl,
  type Stop,
  type TextLineEl,
  type TextRun,
  type TileCell,
} from './scene/types';
