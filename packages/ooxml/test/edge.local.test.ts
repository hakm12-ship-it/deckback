import { describe, expect, it } from 'vitest';
import { writePptx } from '../src';
import { EDGE_SIZE, edgeShapesDeck, edgeTextDeck } from './edge-decks';
import { validatePptx } from './helpers/validate';

// The validator runs .NET (it builds itself once into out/ooxml-validator/ on a cold machine): a long timeout.
const VALIDATOR_TIMEOUT_MS = 300_000;

describe('the edge decks against the Open XML validator (Review Focus 1)', () => {
  it(
    'edge-shapes deck has 0 validator errors',
    async () => {
      const { slides, media } = edgeShapesDeck();
      // among them, curves whose handles lie outside their frame (negative path coordinates, and past w and h), as
      // lowering writes a curve framed by the extent it draws
      const handles = slides[0]!.nodes.filter((n) => n.kind === 'shape' && n.geom.kind === 'custom' && n.geom.paths.some((p) => p.cmds.some((c) => c[0] === 'C' && c.slice(1).some((v, i) => (v as number) < 0 || (v as number) > (i % 2 === 0 ? p.w : p.h)))));
      expect(handles.length).toBeGreaterThanOrEqual(2);
      // written to out/ooxml/edge-shapes.pptx, where PowerPoint opens it (ruling M3-R6, Task 12)
      expect(await validatePptx(writePptx(EDGE_SIZE, slides, media), 'edge-shapes')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );

  it(
    'edge-text deck has 0 validator errors',
    async () => {
      const { slides, media } = edgeTextDeck();
      // written to out/ooxml/edge-text.pptx, where PowerPoint opens it (ruling M3-R6, Task 12)
      expect(await validatePptx(writePptx(EDGE_SIZE, slides, media), 'edge-text')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );
});
