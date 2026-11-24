import type { Counts, Report } from '@deckback/core';
import { APPROXIMATIONS } from '../../../packages/core/src/passes/report';

export const ZERO: Counts = { textBoxes: 0, freeforms: 0, rects: 0, lines: 0, pictures: 0, gradients: 0, hotspots: 0, runLinks: 0, fallbacks: 0 };

/** A report of one plain slide, no fonts: tests add what they need. */
export function emptyReport(): Report {
  const approximations = Object.fromEntries(APPROXIMATIONS.map((k) => [k, 0])) as Report['totals']['approximations'];
  return {
    schema: 'deckback.report/1',
    source: { producer: 'Producer', creator: 'Creator', tagged: false, encrypted: false, pageCount: 1 },
    slideSizePt: [960, 540],
    slides: [{ index: 1, class: 'vector', scale: null, counts: ZERO, fallbacks: [], fallbacksTruncated: 0, approximations: [], approximationsTruncated: 0, notes: [], failed: null }],
    fonts: [],
    totals: { ...ZERO, approximations, droppedLinks: { url: 0, scheme: 0, slide: 0, page: 0, budget: 0, target: 0 } },
    budgets: { slideWeight: 500_000, deckWeight: 20_000_000, exceeded: { slide: [], deck: false } },
  };
}
