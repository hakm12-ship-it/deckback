import { readFileSync } from 'node:fs';
import { writePptx, type OxFill, type OxNode, type OxShape } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import { lowerSlide, runPasses } from '../../src/passes';
import { extractScene } from '../../src/scene/extract';
import type { SceneDeck } from '../../src/scene/types';
import { repoRoot } from '../helpers/fixtures';
import { pagesPdf } from '../helpers/scene';
import { validatePptx } from '../helpers/validate';

/**
 * Gradients through the whole of M3 so far: Scene, passes, lowering, the writer and the Open XML validator (0 errors). A
 * gradient is one shape with a `gradFill`, not slivers (the parity target). The PPTX files are written to `out/ooxml/`
 * (git-ignored); the probe deck is public (`corpus/generated`), the other PDF is made here.
 */

// The validator runs .NET (it builds itself once into out/ooxml-validator/ on a cold machine): a long timeout.
const VALIDATOR_TIMEOUT_MS = 300_000;
/** 960 x 540 pt, the probe's page. */
const SLIDE_16_9: [number, number] = [12192000, 6858000];

type Grad = Extract<OxFill, { kind: 'grad' }>;
const gradNodes = (nodes: OxNode[]): OxShape[] => nodes.filter((n): n is OxShape => n.kind === 'shape' && n.fill.kind === 'grad');

/**
 * Page `index` (0-based) of a PDF through the passes and lowering: its nodes, report, the deck, and its media as the
 * writer takes them (the bundle's: the passes make none, ruling M3-R30).
 */
async function lowered(bytes: Uint8Array, index: number) {
  const bundle = await extractScene(bytes, { pages: [index] });
  const scene: SceneDeck = bundle.scene;
  const { slide, report } = runPasses(scene.slides[0]!, scene, { media: bundle.media });
  const { nodes, background } = lowerSlide(slide, scene, { page: index + 1, scale: 1, offset: [0, 0], report });
  const media = new Map([...bundle.media].map(([hash, bytes]) => [hash, { bytes, mime: scene.media[hash]!.mime }] as const));
  return { nodes, background, report, sizePt: slide.sizePt, media };
}

describe('gradients lowered, written and validated', () => {
  it(
    "probe_std.pdf page 2: the gradient is one shape with a gradFill of pdf.js' stops, 0 validator errors",
    async () => {
      // The probe's gradient is a rect filled with an axial shading pattern (`p2:z54`), not a clip path and an `sh`:
      // shapeKind writes it with the rect preset.
      const bytes = new Uint8Array(readFileSync(`${repoRoot}corpus/generated/probe_std.pdf`));
      const { nodes, background, report, media } = await lowered(bytes, 1);
      const grads = gradNodes(nodes);
      expect(grads.map((n) => n.name)).toEqual(['pdf:p2:z54 rect']);
      const fill = grads[0]!.fill as Grad;
      // down the slide; the box covers t 0.5 (the blue middle) to 1 (white): 13 samples between and the two cut ends
      expect(fill.shade).toEqual({ kind: 'lin', ang: 5400000, scaled: false });
      expect(fill.rotWithShape).toBe(true);
      expect(fill.stops).toHaveLength(15);
      expect(fill.stops[0]).toEqual({ pos: 0, rgb: '0170C0', alpha: 100000 });
      expect(fill.stops.at(-1)).toEqual({ pos: 100000, rgb: 'FFFFFF', alpha: 100000 });
      expect(report.approximations.filter((a) => a.id === 'p2:z54')).toEqual([]);
      // the page's picture is written too (Task 7): its media with it
      expect(await validatePptx(writePptx(SLIDE_16_9, [{ nodes, background }], media), 'gradient-probe-p2')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );

  it(
    'a clip path and an sh, then the stroke of that path: exactly one custGeom shape with a gradFill, 0 validator errors',
    async () => {
      // probe_std.pdf has no `sh` (see above): this page has the clip path and `sh` the parity target describes. The
      // clip pass gives the sh its clip's path, and the second merge (M3-R29) makes it one shape with the outline.
      const shading =
        '<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 50 0 250] /Extend [true true] ' +
        '/Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >>';
      const path = '50 50 m 250 50 l 150 250 l h';
      const pdf = pagesPdf([`q ${path} W n /S sh Q 0 0 1 RG 2 w ${path} S`], '/Shading << /S 10 0 R >>', [{ num: 10, body: shading }]);
      const { nodes, background, report } = await lowered(pdf, 0);
      expect(nodes).toHaveLength(1);
      const node = nodes[0] as OxShape;
      expect(node.geom.kind).toBe('custom');
      expect(node.line).not.toBeNull();
      const fill = node.fill as Grad;
      // shading space y up: from y 50 (red, the triangle's base, slide y 250) up to 250 (blue, its apex, slide y 50), so
      // the angle points up the slide (270°) and position 0 is at the base
      expect(fill.shade).toEqual({ kind: 'lin', ang: 16200000, scaled: false });
      expect(fill.stops[0]).toMatchObject({ pos: 0, rgb: 'FF0000' });
      expect(fill.stops.at(-1)).toMatchObject({ pos: 100000, rgb: '0000FF' });
      expect(report.counts).toMatchObject({ freeforms: 1, rects: 0, lines: 0 });
      expect(report.approximations).toEqual([]);
      expect(await validatePptx(writePptx([3810000, 3810000], [{ nodes, background }], new Map()), 'gradient-sh-clip')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );
});
