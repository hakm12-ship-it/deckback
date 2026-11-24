import { createHash } from 'node:crypto';
import { writePptx } from '@deckback/ooxml';
import { describe, expect, it } from 'vitest';
import { lowerSlide, runPasses } from '../../src/passes';
import { pictureXfrm } from '../../src/scene/build';
import { encodePng } from '../../src/scene/png';
import type { ClipDef, Element, PictureEl, SceneDeck, TileCell } from '../../src/scene/types';
import { circle, deckOf, picture, rectPath, shape, slideOf } from '../helpers/passes';
import { validatePptx } from '../helpers/validate';

/**
 * Every way a picture is written (Task 7) in one PPTX, through the passes, lowering, the writer and the Open XML validator:
 * 0 errors. The PPTX is written to `out/ooxml/` (git-ignored); its one picture is made here.
 */

// The validator runs .NET (it builds itself once into out/ooxml-validator/ on a cold machine): a long timeout.
const VALIDATOR_TIMEOUT_MS = 300_000;

describe('pictures lowered, written and validated', () => {
  it(
    'a picture, crops (upright, turned, mirrored), clipped freeforms and a picture tile: 0 validator errors',
    async () => {
      const bytes = encodePng(Uint8Array.from({ length: 4 * 4 * 3 }, (_, i) => (i * 37) & 255), 4, 4, 3);
      const hash = createHash('sha256').update(bytes).digest('hex');
      const at = (box: [number, number, number, number], op: number, over: Partial<PictureEl> = {}) => picture(box, { op, mediaHash: hash, ...over });
      /** Turned `rot` degrees clockwise about the centre of (x, y, w, h), as the Scene builds it. */
      const turned = (op: number, x: number, y: number, w: number, h: number, rot: number, clip: string[]): PictureEl => {
        const r = (rot * Math.PI) / 180;
        const [right, down] = [[w * Math.cos(r), w * Math.sin(r)], [-h * Math.sin(r), h * Math.cos(r)]];
        const [cx, cy] = [x + w / 2, y + h / 2];
        const m = [right[0]!, right[1]!, -down[0]!, -down[1]!, cx - right[0]! / 2 + down[0]! / 2, cy - right[1]! / 2 + down[1]! / 2];
        return at([0, 0, 1, 1], op, { matrix: m, ...pictureXfrm(m), clip });
      };
      const quarter = turned(4, 10, 20, 100, 50, 90, ['c2']);
      const thirty = turned(6, 100, 270, 100, 60, 30, ['c4']);
      const cell: TileCell = {
        bbox: [0, 0, 4, 4],
        xStep: 4,
        yStep: 4,
        matrix: [1.5, 0, 0, -1.5, 300, 300],
        paintType: 1,
        elements: [{ ...at([0, 0, 1, 1], 3), id: 'p1:z9/z3', matrix: [4, 0, 0, 4, 0, 0], xfrm: { x: 0, y: 0, w: 4, h: 4, rotDeg: 0, flipH: false, flipV: true } }],
        clips: {},
      };
      const elements: Element[] = [
        at([20, 120, 120, 180], 1, { alpha: 0.5, skewed: true }),
        at([150, 20, 250, 80], 2, { clip: ['c1'] }),
        quarter,
        at([300, 20, 400, 80], 5, { clip: ['c3'], matrix: [-100, 0, 0, -60, 400, 80], xfrm: { x: 300, y: 20, w: 100, h: 60, rotDeg: 0, flipH: true, flipV: false } }),
        thirty,
        at([250, 150, 350, 210], 7, { clip: ['c5'] }),
        shape({ op: 9, geom: rectPath(301, 250, 120, 80), fill: { kind: 'tile', cell, alpha: 0.8 } }),
      ];
      const clips: Record<string, ClipDef> = {
        c1: { kind: 'box', bbox: [180, 0, 400, 60] },
        c2: { kind: 'box', bbox: [0, -100, 300, 60] },
        c3: { kind: 'box', bbox: [330, 0, 500, 200] },
        c4: { kind: 'box', bbox: [0, 0, 500, 320] },
        c5: { kind: 'path', geom: circle(300, 180, 30), rule: 'evenodd', bbox: [270, 150, 330, 210] },
      };
      // the helpers' elements are drawn on a 300 x 200 page: this one is 500 x 400
      const input = slideOf(
        elements.map((el) => ({ ...el, clipBox: [0, 0, 500, 400] })),
        { clips, sizePt: [500, 400] },
      );
      const deck: SceneDeck = { ...deckOf([input]), media: { [hash]: { hash, mime: 'image/png', widthPx: 4, heightPx: 4, byteLength: bytes.length, passthrough: false } } };
      const { slide, report } = runPasses(input, deck, { media: new Map([[hash, bytes]]) });
      const { nodes, background } = lowerSlide(slide, deck, { page: 1, scale: 1, offset: [0, 0], report });
      expect(nodes.map((n) => [n.name, n.kind === 'picture' ? n.srcRect !== null : n.kind === 'shape' ? n.fill.kind : null])).toEqual([
        ['pdf:p1:z1 picture', false],
        ['pdf:p1:z2 picture', true],
        ['pdf:p1:z4 picture', true],
        ['pdf:p1:z5 picture', true],
        ['pdf:p1:z6 freeform', 'blip'],
        ['pdf:p1:z7 freeform', 'blip'],
        ['pdf:p1:z9 rect', 'blip'],
      ]);
      const pptx = writePptx([500 * 12700, 400 * 12700], [{ nodes, background }], new Map([[hash, { bytes, mime: 'image/png' as const }]]));
      expect(await validatePptx(pptx, 'pictures-variants')).toEqual([]);
    },
    VALIDATOR_TIMEOUT_MS,
  );
});
