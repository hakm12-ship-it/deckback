import { describe, expect, it } from 'vitest';
import type { PathSeg } from '../../src/extract/inventory';
import { resolveClips } from '../../src/passes/clip';
import { effectFallbacks, rasterFallbacks } from '../../src/passes/fallbacks';
import { flattenedCount, pathPolygons, planFill } from '../../src/passes/fillrule';
import { covered, indexRuns } from '../../src/passes/links';
import { resolvePictures } from '../../src/passes/pictures';
import { newReport } from '../../src/passes/report';
import type { ClipDef, Note, ShapeEl } from '../../src/scene/types';
import { circle, deckOf, pathBox, picture, rectPath, shape, slideOf, solid, textline } from '../helpers/passes';

/** M6 Task 1 fix round 1: a NaN count or budget is past a cap, never under it (`!(n <= cap)`). */

const NAN_GEOM: PathSeg[] = [['M', 0, 0], ['C', Number.NaN, 10, 20, Number.NaN, 30, 30], ['L', 40, 0], ['Z']];

describe('NaN in the passes\' counts and budgets', () => {
  it('fillrule: a count made of NaN geometry is past the cap: the path is approximated / refused', () => {
    expect(flattenedCount(NAN_GEOM, 0.05, 20_000) <= 20_000).toBe(false); // NaN is not under the cap
    expect(pathPolygons(NAN_GEOM)).toBeNull();
    const el = shape({ op: 1, geom: [...NAN_GEOM, ['M', 50, 50], ['L', 60, 50], ['L', 60, 60], ['Z']], fill: solid() }) as ShapeEl;
    expect(planFill({ ...el, fillRule: 'nonzero' }).approx).toBe(true);
  });

  it('links: a NaN budget is over-budget, nothing looked at', () => {
    const runs = [textline({ op: 1 })];
    const index = indexRuns(runs);
    const budget = { left: Number.NaN };
    expect(covered([0, 0, 300, 200], index, budget)).toBe('over-budget');
  });

  it('clip: a NaN budget is spent as 0 is', () => {
    const ring = circle(150, 100, 80);
    const clips: Record<string, ClipDef> = { c1: { kind: 'path', geom: ring, rule: 'nonzero', bbox: pathBox(ring) } };
    const geom = rectPath(20, 20, 240, 150);
    const make = () => slideOf([shape({ op: 1, geom, fill: solid(), clip: ['c1'] })], { clips });
    const [a, b] = [Number.NaN, 0].map((left) => {
      const notes: Note[] = [];
      return { out: resolveClips(make(), notes, { left }), notes };
    });
    expect(a!.notes).toEqual(b!.notes);
    expect(a!.out.elements).toEqual(b!.out.elements);
  });

  it('pictures: a NaN budget is spent as 0 is', () => {
    const ring = circle(150, 100, 80);
    const clips: Record<string, ClipDef> = { c1: { kind: 'path', geom: ring, rule: 'nonzero', bbox: pathBox(ring) } };
    const make = () => slideOf([picture([60, 20, 240, 180], { op: 1, clip: ['c1'] })], { clips });
    const [a, b] = [Number.NaN, 0].map((left) => {
      const slide = make();
      return resolvePictures(slide, { ...deckOf([slide]), media: {} }, newReport(slide), {}, { left }).elements;
    });
    expect(a).toEqual(b);
  });

  it('fallbacks: a raster of NaN geometry draws nothing and does not throw', () => {
    const slide = slideOf([shape({ op: 1, geom: NAN_GEOM, fill: solid(), blend: 'multiply' })]);
    const effect = effectFallbacks(slide);
    const { media } = rasterFallbacks(effect, null);
    expect(media.size).toBe(0);
  });
});
