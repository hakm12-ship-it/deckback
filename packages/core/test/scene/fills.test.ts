import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, OPS, releasePage } from '../../src/engine/pdfjs-adapter';
import { openRawPdf } from '../../src/engine/rawpdf';
import { compareInventories, toInventory, type Inventory } from '../../src/extract/inventory';
import { pageFrame, rawMesh, walkPage, type RawOp } from '../../src/extract/walker';
import { buildSlide } from '../../src/scene/build';
import { canonicalJson } from '../../src/scene/canonical';
import { FontTable } from '../../src/scene/fonts';
import { inventoryOfSlide } from '../../src/scene/inventory';
import { MediaStore } from '../../src/scene/media';
import type { Element, Fill, PictureEl, SceneSlide, ShapeEl, TileCell } from '../../src/scene/types';
import { repoRoot } from '../helpers/fixtures';
import { buildPdf, type MiniObject } from '../helpers/minipdf';
import { schemaErrors, validateSlide } from '../helpers/scene';
import { syntheticPdf } from '../helpers/synthetic';

/**
 * Scene v1, the fills that are not one colour and the state around a paint (Task 8): gradients (`sh`, shading patterns,
 * gradient strokes), tiling patterns and their cells, the clip chain, transparency groups and soft masks. Each slide built
 * here also validates against scene.schema.json, and `inventoryOfSlide` rebuilds the walker's inventory from it.
 */

/** The page frame of a 300 pt page: y flipped. */
const FRAME = [1, 0, 0, -1, 0, 300];

/**
 * The paints and glyphs the Scene maps: everything but what it maps to no paint of its own: text a pattern fills (its run
 * holds the pattern), an image mask a pattern fills and a shading pdf.js could not read (fallbacks, ruling M2-R17).
 */
function mapped(ops: RawOp[]): RawOp[] {
  return ops.filter((op) => {
    if (op.kind !== 'shade' && op.kind !== 'pattern') return true;
    return op.text !== true && op.stencil !== true && (op.kind === 'pattern' || op.shading !== undefined);
  });
}

/** The font table each slide was built with: `inventoryOfSlide` names a text run's font from it. */
const fontsOf = new WeakMap<SceneSlide, FontTable>();
const inventoryOf = (slide: SceneSlide) => inventoryOfSlide(slide, fontsOf.get(slide)?.infos());

/** `inventoryOfSlide` equals the walker's inventory of the paints the Scene maps: exactly, and so within tolerance. */
function expectSameInventory(slide: SceneSlide, size: [number, number], ops: RawOp[]): void {
  const expected: Inventory = toInventory([{ index: slide.index, size, ops: mapped(ops) }]);
  const actual: Inventory = { pages: [inventoryOf(slide)] };
  const result = compareInventories(expected, actual);
  expect(result.diffs).toEqual([]);
  expect(actual).toEqual(expected);
}

/** Walks page `index` of a PDF and builds its slide before the page is released; the slide must validate. */
async function walkPdf(bytes: Uint8Array, index = 0, media = new MediaStore(null), fonts = new FontTable(null)) {
  const doc = await openDocument(bytes);
  try {
    const data = await loadPage(doc, index);
    try {
      const ops = walkPage(data);
      const size = pageFrame(data).size;
      const slide = await buildSlide({ index, sizePt: size, ops }, { media, fonts, page: data });
      fontsOf.set(slide, fonts);
      expect(schemaErrors(validateSlide, slide)).toEqual([]);
      // Rounded when built (M2-R13), cell space to 6 decimals too: the canonical JSON changes no number.
      expect(JSON.parse(canonicalJson(slide))).toEqual(slide);
      return { ops, size, fnArray: [...data.ops.fnArray], slide, media };
    } finally {
      await releasePage(data);
    }
  } finally {
    await closeDocument(doc);
  }
}

const walk = (content: string) => walkPdf(syntheticPdf(content));
const shapes = (elements: readonly Element[]): ShapeEl[] => elements as ShapeEl[];

/**
 * A one-page PDF of 300 x 300 pt with its own resources, for the cases the shared synthetic page has nothing for. The
 * function `/Fn` goes from red to blue.
 */
function onePage(content: string, resources: string, objects: MiniObject[]): Uint8Array {
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
    { num: 3, body: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R /Resources << ${resources} >> >>` },
    { num: 4, data: content },
    { num: 5, body: '<< /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >>' },
    ...objects,
  ]);
}

describe('buildSlide: gradients', () => {
  it('sh gives a shape with geom null and a linear fill', async () => {
    // /Sh1: axial from black at x 0 to white at x 300 (user space), extended at both ends.
    const { ops, size, fnArray, slide } = await walk('q 20 20 260 100 re W n /Sh1 sh Q');
    const n = fnArray.indexOf(OPS.shadingFill);
    expect(slide.elements).toEqual([
      {
        kind: 'shape',
        id: `p1:z${n}`,
        provenance: { opIndex: [n], mcid: null, struct: null },
        clip: ['c1'],
        clipBox: [20, 180, 280, 280],
        groups: [],
        mask: null,
        blend: 'normal',
        geom: null, // it paints its whole clip
        fillRule: 'nonzero',
        fill: {
          kind: 'linear',
          stops: [
            { t: 0, rgb: [0, 0, 0] },
            { t: 1, rgb: [255, 255, 255] },
          ],
          p0: [0, 0], // in shading space; `matrix` takes it to the slide frame
          p1: [300, 0],
          matrix: FRAME,
          extend: [true, true],
          alpha: 1,
        },
        line: null,
        bbox: [20, 180, 280, 280],
      },
    ]);
    expectSameInventory(slide, size, ops);
  });

  it('a shading-pattern fill keeps the path geometry', async () => {
    // /P1: /Sh1 in pattern space, which is the page's (the base transform), not the CTM; /P5: the radial /Sh2; /P6: a mesh.
    const { ops, size, slide } = await walk(
      '/Pattern cs /P1 scn 10 10 100 50 re f /P5 scn 150 150 m 250 150 l 200 250 l h f* ' +
        'q 0.5 0 0 0.5 0 0 cm /GS1 gs /P1 scn 20 20 100 100 re f Q /P6 scn 200 20 50 50 re f',
    );
    const [linear, radial, scaled, mesh] = shapes(slide.elements);
    expect(slide.elements).toHaveLength(4);
    expect(linear).toMatchObject({
      geom: [['M', 10, 290], ['L', 110, 290], ['L', 110, 240], ['L', 10, 240], ['Z']],
      fillRule: 'nonzero',
      line: null,
      bbox: [10, 240, 110, 290],
      clip: [],
      clipBox: [10, 240, 110, 290], // the shape it paints is in it, as in the inventory (ruling M2-R12)
      fill: { kind: 'linear', p0: [0, 0], p1: [300, 0], matrix: FRAME, extend: [true, true], alpha: 1 },
    });
    expect(radial).toMatchObject({
      geom: [['M', 150, 150], ['L', 250, 150], ['L', 200, 50], ['Z']],
      fillRule: 'evenodd',
      bbox: [150, 50, 250, 150],
      fill: { kind: 'radial', p0: [150, 150], r0: 0, p1: [150, 150], r1: 80, matrix: FRAME, extend: [false, false], alpha: 1 },
    });
    // Under the CTM the path halves and the pattern does not; /GS1 sets ca 0.5.
    expect(scaled).toMatchObject({ geom: [['M', 10, 290], ['L', 60, 290], ['L', 60, 240], ['L', 10, 240], ['Z']], bbox: [10, 240, 60, 290] });
    expect(scaled!.fill).toMatchObject({ kind: 'linear', matrix: FRAME, alpha: 0.5 });
    // M5 (plan 7's one Scene change): the triangles pdf.js made of it, for the raster renderer. /Sh5 is one triangle of
    // gray 0, 128 and 255 at x 60..220, y 70..180 of shading space; /P6 moves it by (20, 30) before the page frame.
    expect(mesh!.fill).toEqual({
      kind: 'shading',
      shading: 'mesh',
      alpha: 1,
      mesh: {
        type: 4,
        xy: [60, 70, 220, 70, 60, 180],
        rgb: [0, 0, 0, 128, 128, 128, 255, 255, 255],
        triangles: [0, 1, 2],
        matrix: [1, 0, 0, -1, 20, 270],
        bbox: null,
        background: null,
      },
    });
    expectSameInventory(slide, size, ops);
  });

  it("a mesh's triangles with a coordinate that is not finite are dropped as pdf.js gives them (fix round 1)", () => {
    const pos = Float32Array.of(0, 0, 10, 0, 0, 10, 0, 0, Number.NaN, 0, 0, 10, 5, 5, 6, 5, 5, Number.POSITIVE_INFINITY);
    const col = new Uint8Array(9 * 4).fill(7);
    const mesh = rawMesh(['Mesh', 4, pos, col, 9, [0, 0, 10, 10], null, null])!;
    expect(mesh.count).toBe(3);
    expect(Array.from(mesh.pos)).toEqual([0, 0, 10, 0, 0, 10]);
    expect(Array.from(mesh.col)).toEqual(new Array(12).fill(7));
    expect(rawMesh(['Mesh', 4, Float32Array.of(Number.NaN, 0, 1, 0, 0, 1), new Uint8Array(12), 3, null, null, null])).toBeNull();
  });

  it('a function-based shading carries the lattice pdf.js sampled it at, as triangles (M5)', async () => {
    // /Sh4: gray (x + y) / 2 over the unit square, carried by its /Matrix onto 120 x 90 at (40, 60): pdf.js samples it
    // at 120 x 90 steps, so 121 x 91 vertices, two triangles a step. /Sh10 has a /BBox in shading space.
    const { slide } = await walk('/Sh4 sh /Sh10 sh');
    const [fn, cut] = shapes(slide.elements);
    expect(fn!.fill).toMatchObject({ kind: 'shading', shading: 'function', alpha: 1 });
    const mesh = (fn!.fill as Extract<Fill, { kind: 'shading' }>).mesh!;
    expect(mesh).toMatchObject({ type: 1, matrix: FRAME, bbox: null, background: null });
    expect(mesh.xy).toHaveLength(121 * 91 * 2);
    expect(mesh.rgb).toHaveLength(121 * 91 * 3);
    expect(mesh.triangles).toHaveLength(120 * 90 * 2 * 3);
    // The corners: (40, 60) gray 0, (160, 150) near white (pdf.js samples the last step at its middle).
    expect(mesh.xy.slice(0, 2)).toEqual([40, 60]);
    expect(mesh.rgb.slice(0, 3)).toEqual([0, 0, 0]);
    const last = 121 * 91 - 1;
    expect(mesh.xy.slice(last * 2, last * 2 + 2)).toEqual([160, 150]);
    expect(mesh.rgb[last * 3]).toBeGreaterThan(245);
    expect(Math.max(...mesh.triangles)).toBe(last);
    expect((cut!.fill as Extract<Fill, { kind: 'shading' }>).mesh).toMatchObject({ type: 1, bbox: [100, 60, 250, 200] });
  });

  it('a gradient stroke is line.paint', async () => {
    const { ops, size, slide } = await walk(
      '/Pattern CS /P1 SCN 6 w 1 J 20 20 m 120 80 l S ' +
        // /GS1: ca 0.5, CA 0.25; /P3 is a tiling pattern, /P2 another one.
        'q /GS1 gs /Pattern cs /P3 scn /Pattern CS /P2 SCN 150 150 100 50 re B Q',
    );
    const [stroke, tileFill, tileStroke] = shapes(slide.elements);
    expect(slide.elements).toHaveLength(3);
    expect(stroke).toMatchObject({
      geom: [['M', 20, 280], ['L', 120, 220]],
      fill: null,
      fillRule: 'nonzero',
      bbox: [20, 220, 120, 280], // the path's, not widened by the line
      // As far as the stroke reaches, cut to the page (0002 §15): 3 pt each side, times 2 x the miter limit of 10.
      clipBox: [0, 160, 180, 300],
      line: { w: 6, cap: 'round', join: 'miter', miter: 10, dash: [], phase: 0, anisotropic: false },
    });
    expect(stroke!.line!.paint).toMatchObject({ kind: 'linear', p0: [0, 0], p1: [300, 0], matrix: FRAME, alpha: 1 });
    expect(tileFill).toMatchObject({ fill: { kind: 'tile', alpha: 0.5 }, line: null, bbox: [150, 100, 250, 150] });
    expect(tileStroke).toMatchObject({ fill: null, line: { w: 6, paint: { kind: 'tile', alpha: 0.25 } }, bbox: [150, 100, 250, 150] });
    expect(tileStroke!.provenance.opIndex).toEqual(tileFill!.provenance.opIndex);
    expect(tileStroke!.id).toBe(`${tileFill!.id}:1`);
    expectSameInventory(slide, size, ops);
  });

  it('extend flags come from the transparent stops', async () => {
    const { slide } = await walk('/Sh1 sh /Sh2 sh');
    const [axial, radial] = shapes(slide.elements).map((e) => e.fill as Extract<Fill, { stops: unknown }>);
    expect(axial!.extend).toEqual([true, true]);
    // pdf.js ends a gradient that does not extend with a transparent stop, and moves the stop beside it by 1e-6: the
    // Scene has neither, and the flag instead.
    expect(radial!.extend).toEqual([false, false]);
    expect(radial!.stops).toEqual([
      { t: 0, rgb: [0, 0, 0] },
      { t: 1, rgb: [255, 255, 255] },
    ]);

    // One end each, and stops pdf.js sampled from a function of two pieces.
    const stitched = '<< /FunctionType 3 /Domain [0 1] /Functions [5 0 R 5 0 R] /Bounds [0.25] /Encode [0 1 1 0] >>';
    const pdf = onePage('/A sh /R sh', '/Shading << /A 10 0 R /R 11 0 R >>', [
      { num: 10, body: `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 300 0] /Extend [false true] /Function ${stitched} >>` },
      { num: 11, body: '<< /ShadingType 3 /ColorSpace /DeviceRGB /Coords [150 150 0 150 150 100] /Extend [true false] /Function 5 0 R >>' },
    ]);
    const fills = shapes((await walkPdf(pdf)).slide.elements).map((e) => e.fill as Extract<Fill, { stops: unknown }>);
    expect(fills.map((f) => f.extend)).toEqual([
      [false, true],
      [true, false],
    ]);
    for (const { stops } of fills) {
      expect(stops.length).toBeGreaterThanOrEqual(2);
      expect([stops[0]!.t, stops.at(-1)!.t]).toEqual([0, 1]);
      expect(stops.every((s, i) => i === 0 || s.t > stops[i - 1]!.t)).toBe(true);
    }
    // Red, to blue at a quarter, back to red: a stop at the turn.
    const [a] = fills;
    expect([a!.stops[0]!.rgb, a!.stops.at(-1)!.rgb]).toEqual([
      [255, 0, 0],
      [255, 0, 0],
    ]);
    expect(a!.stops.some((s) => Math.abs(s.t - 0.25) < 0.002 && s.rgb[2] > 250)).toBe(true);
  });

  it('a shading pdf.js could not read is a fallback with a note', async () => {
    // /Coords is missing: pdf.js keeps a Dummy shading, and the walker's shade has no `shading` (0002 §13).
    const pdf = onePage('/X sh', '/Shading << /X 10 0 R >>', [
      { num: 10, body: '<< /ShadingType 2 /ColorSpace /DeviceRGB /Function 5 0 R >>' },
    ]);
    const { fnArray, slide } = await walkPdf(pdf);
    const n = fnArray.indexOf(OPS.shadingFill);
    expect(slide.elements).toMatchObject([{ kind: 'fallback', reason: 'shading-unreadable', coveredOps: [n], bbox: [0, 0, 300, 300] }]);
    expect(slide.notes).toEqual([{ opIndex: n, op: 'shadingFill', detail: 'shading pdf.js could not read' }]);
  });
});

describe('buildSlide: tiling patterns', () => {
  it('a tile cell holds its image as a picture in cell space', async () => {
    // /P3: one cell [0 0 1 1] holds /Im1 (2 x 2 gray), its /Matrix [100 0 0 50 150 200]: PowerPoint's picture fill.
    const { ops, size, fnArray, slide, media } = await walk('/Pattern cs /P3 scn 150 200 100 50 re f');
    const n = fnArray.indexOf(OPS.constructPath);
    expect(slide.elements).toHaveLength(1); // the cell's picture is pattern data, not page content (0002 §9)
    const [shape] = shapes(slide.elements);
    expect(shape).toMatchObject({ id: `p1:z${n}`, geom: [['M', 150, 100], ['L', 250, 100], ['L', 250, 50], ['L', 150, 50], ['Z']] });
    const fill = shape!.fill as Extract<Fill, { kind: 'tile' }>;
    expect(fill.alpha).toBe(1);
    const { elements, ...cell } = fill.cell;
    // Cell space to the slide frame: the page frame after the pattern matrix.
    expect(cell).toEqual({ bbox: [0, 0, 1, 1], xStep: 1, yStep: 1, matrix: [100, 0, 0, -50, 150, 100], paintType: 1, clips: {} });
    const [picture] = elements as PictureEl[];
    expect(elements).toHaveLength(1);
    expect(picture).toMatchObject({
      kind: 'picture',
      // In the cell's own operator list: `dependency`, then the image at 1.
      id: `p1:z${n}/z1`,
      provenance: { opIndex: [1], mcid: null, struct: null },
      clip: [],
      clipBox: [0, 0, 1, 1], // the cell
      groups: [],
      mask: null,
      matrix: [1, 0, 0, 1, 0, 0], // the unit square in cell space, where y runs up
      xfrm: { x: 0, y: 0, w: 1, h: 1, rotDeg: 0, flipH: false, flipV: true },
      alpha: 1,
      stencil: null,
      px: [2, 2],
    });
    expect(Object.keys(media.infos())).toEqual([picture!.mediaHash]);
    expectSameInventory(slide, size, ops);
  });

  it('an uncoloured tile cell paints in the colour scn gives it', async () => {
    const pdf = onePage(
      '/CS0 cs 0 0.5 1 /U scn 20 20 100 100 re f',
      '/ColorSpace << /CS0 [/Pattern /DeviceRGB] >> /Pattern << /U 10 0 R >>',
      [
        {
          num: 10,
          dict: '/Type /Pattern /PatternType 1 /PaintType 2 /TilingType 1 /BBox [0 0 20 20] /XStep 20 /YStep 20 /Resources << >>',
          data: '0 0 10 10 re f 1 w 0 0 m 20 20 l S',
        },
      ],
    );
    const { ops, size, slide } = await walkPdf(pdf);
    const cell = ((slide.elements[0] as ShapeEl).fill as Extract<Fill, { kind: 'tile' }>).cell;
    expect(cell).toMatchObject({ paintType: 2, bbox: [0, 0, 20, 20], xStep: 20, yStep: 20, matrix: FRAME });
    const [fill, stroke] = shapes(cell.elements);
    expect(fill).toMatchObject({ geom: [['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['L', 0, 10], ['Z']], fill: { kind: 'solid', rgb: [0, 128, 255] } });
    expect(stroke!.line).toMatchObject({ w: 1, paint: { kind: 'solid', rgb: [0, 128, 255] } });
    expectSameInventory(slide, size, ops);
  });

  it("a JPEG in a tile cell passes through, as PowerPoint's picture and texture fills want (M2-R18)", async () => {
    // An 8 x 8 RGB JPEG made for this test (Pillow, quality 40): a red and green ramp over blue. Its second quantization
    // table is its 64 bytes (it had 67, which hid the frame header from a marker walk: since M2 final review F10 that
    // JPEG would not be plain, ruling M3-R31).
    const jpeg = Uint8Array.from(
      Buffer.from(
        'ffd8ffe000104a46494600010100000100010000ffdb004300140e0f120f0d14121012171514181e32211e1c1c1e3d2c2e243249404c4b4740' +
          '4645505a736250556d5645466488656d777b8182814e608d978c7d96737e817cffdb0043011517171e1a1e3b21213b7c5346537c7c7c7c7c' +
          '7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7c7cffc000110800080008' +
          '03012200021101031101ffc4001500010100000000000000000000000000000003ffc4001810010003010000000000000000000000000004' +
          '052231ffc4001501010100000000000000000000000000000203ffc4001c110001030500000000000000000000000003000104021213213' +
          '1ffda000c03010002110311003f008c3a8e6404087aeeea712493136d7fffd9',
        'hex',
      ),
    );
    const pdf = onePage('/Pattern cs /P scn 50 50 100 100 re f', '/Pattern << /P 10 0 R >>', [
      {
        num: 10,
        dict: '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Matrix [100 0 0 100 50 50] /Resources << /XObject << /J 11 0 R >> >>',
        data: '/J Do',
      },
      { num: 11, dict: '/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: jpeg },
    ]);
    for (const [media, passthrough] of [
      [new MediaStore(openRawPdf(pdf)), true],
      [new MediaStore(null), false], // without the raw reader, a PNG (M2-R6)
    ] as const) {
      const { slide } = await walkPdf(pdf, 0, media);
      const [picture] = ((slide.elements[0] as ShapeEl).fill as Extract<Fill, { kind: 'tile' }>).cell.elements as PictureEl[];
      const info = media.infos()[picture!.mediaHash]!;
      expect(info).toMatchObject({ mime: passthrough ? 'image/jpeg' : 'image/png', passthrough, widthPx: 8, heightPx: 8 });
      if (passthrough) expect(media.files().get(info.hash)).toEqual(jpeg);
    }
  });

  it('a cell keeps cell-space numbers to 6 decimals, its clips its own', async () => {
    // A cell of 1 unit drawn 300 pt wide: 3 decimals would move a point by up to 0.15 pt.
    const pdf = onePage(
      '/Pattern cs /P scn 0 0 300 300 re f',
      '/Pattern << /P 10 0 R >>',
      [
        {
          num: 10,
          dict: '/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 1 1] /XStep 1 /YStep 1 /Matrix [300 0 0 300 0 0] /Resources << >>',
          data: '0.1234567 0.2 0.3 0.3 re W n 1 0 0 rg 0.3333333 0.25 0.5 0.5 re f',
        },
      ],
    );
    const { slide } = await walkPdf(pdf);
    const cell = ((slide.elements[0] as ShapeEl).fill as Extract<Fill, { kind: 'tile' }>).cell as TileCell;
    expect(cell.clips).toEqual({
      c1: {
        kind: 'path',
        geom: [['M', 0.123457, 0.2], ['L', 0.423457, 0.2], ['L', 0.423457, 0.5], ['L', 0.123457, 0.5], ['Z']],
        rule: 'nonzero',
        bbox: [0.123457, 0.2, 0.423457, 0.5],
      },
    });
    expect(cell.elements[0]).toMatchObject({ clip: ['c1'], geom: [['M', 0.333333, 0.25], ['L', 0.833333, 0.25], ['L', 0.833333, 0.75], ['L', 0.333333, 0.75], ['Z']] });
    expect(slide.clips).toEqual({});
  });
});

describe('buildSlide: clips, groups and masks', () => {
  it('clip ids nest and restore with Q', async () => {
    const { ops, size, slide } = await walk(
      'q 10 10 200 200 re W n 1 0 0 rg 20 20 10 10 re f ' +
        'q 50 50 100 100 re W* n 30 30 10 10 re f /Pattern cs /P1 scn 70 70 10 10 re f Q 40 40 10 10 re f Q 60 60 10 10 re f ' +
        // A text clip (Tr 7), and a form whose /BBox clips what it draws.
        'q BT 7 Tr /F1 20 Tf 100 250 Td (AB) Tj ET 0 g 120 240 10 10 re f /Sh1 sh Q /Fm1 Do',
    );
    // The Tr 7 text is a line of its own, clipped by what was in force when it was shown: its clip starts after ET.
    expect(slide.elements.map((e) => [e.kind, e.clip])).toEqual([
      ['shape', ['c1']],
      ['shape', ['c1', 'c2']],
      ['shape', ['c1', 'c2']],
      ['shape', ['c1']],
      ['shape', []],
      ['textline', []],
      ['shape', ['c3']],
      ['shape', ['c3']],
      ['shape', ['c4']],
      ['shape', ['c4']],
    ]);
    expect(slide.clips).toEqual({
      c1: { kind: 'path', geom: [['M', 10, 290], ['L', 210, 290], ['L', 210, 90], ['L', 10, 90], ['Z']], rule: 'nonzero', bbox: [10, 90, 210, 290] },
      c2: { kind: 'path', geom: [['M', 50, 250], ['L', 150, 250], ['L', 150, 150], ['L', 50, 150], ['Z']], rule: 'evenodd', bbox: [50, 150, 150, 250] },
      c3: { kind: 'text', bbox: expect.any(Array) as unknown, approx: true },
      // /Fm1's /BBox [0 0 50 50] under its /Matrix [2 0 0 2 10 10]: a box, as the CTM keeps the axes.
      c4: { kind: 'box', bbox: [10, 190, 110, 290] },
    });
    // The pattern fill's own shape is no clip of the chain: it is its geometry, and in its clip box.
    expect(slide.elements[2]!.clipBox).toEqual([70, 220, 80, 230]);
    expect(slide.elements[6]!.clipBox).toEqual((slide.clips.c3 as { bbox: number[] }).bbox);
    expectSameInventory(slide, size, ops);
    // Under the text clip: the fill's clip is approximate, and the sh's box too (0002 §5).
    const paints = inventoryOf(slide).paints;
    expect(paints.map((p) => p.clipApprox ?? false)).toEqual([false, false, false, false, false, true, true, false, false]);
    expect(paints.map((p) => p.approx ?? false)).toEqual([false, false, false, false, false, false, true, false, false]);
  });

  it("a form's and a group's clips end with them, without Q: a paint after the Do has the outer clip", async () => {
    // /Fm1 is a form and /Fm2 a transparency group; each clips with W n and never restores (no q, no Q inside). The
    // paint after each Do, still inside the page's own q, must be in the page's clip only (Task 8 minor).
    const pdf = onePage(
      'q 10 10 200 200 re W n /Fm1 Do 1 0 0 rg 20 20 10 10 re f /Fm2 Do 1 0 0 rg 30 30 10 10 re f Q 40 40 10 10 re f',
      '/XObject << /Fm1 6 0 R /Fm2 7 0 R >>',
      [
        {
          num: 6,
          dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Resources << >>',
          data: '50 50 100 100 re W n 0 0 1 rg 0 0 300 300 re f',
        },
        {
          num: 7,
          dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency >> /Resources << >>',
          data: '60 60 80 80 re W n 0 1 0 rg 0 0 300 300 re f',
        },
      ],
    );
    const { ops, size, slide } = await walkPdf(pdf);
    const page = [10, 90, 210, 290];
    expect(slide.elements.map((e) => [(e as ShapeEl).fill, e.clipBox])).toEqual([
      [{ kind: 'solid', rgb: [0, 0, 255], alpha: 1 }, [50, 150, 150, 250]], // in /Fm1: its W n
      [{ kind: 'solid', rgb: [255, 0, 0], alpha: 1 }, page], // after /Fm1 Do: the page's clip again
      [{ kind: 'solid', rgb: [0, 255, 0], alpha: 1 }, [60, 160, 140, 240]], // in /Fm2: its W n
      [{ kind: 'solid', rgb: [255, 0, 0], alpha: 1 }, page], // after /Fm2 Do
      [{ kind: 'solid', rgb: [0, 0, 0], alpha: 1 }, [0, 0, 300, 300]], // after Q: no clip (and black again)
    ]);
    // The chain too: the form's and the group's clips (their /BBox and their W n) are gone after their Do.
    const [inForm, afterForm, inGroup, afterGroup, afterQ] = slide.elements.map((e) => e.clip);
    expect(afterForm).toEqual(['c1']);
    expect(afterGroup).toEqual(['c1']);
    expect(afterQ).toEqual([]);
    expect(inForm![0]).toBe('c1');
    expect(inForm!.length).toBeGreaterThan(1);
    expect(inGroup![0]).toBe('c1');
    expect(inGroup!.length).toBeGreaterThan(1);
    expect(slide.clips.c1).toMatchObject({ kind: 'path', bbox: page });
    expect(slide.elements.map((e) => e.groups.length)).toEqual([0, 0, 1, 0, 0]);
    expectSameInventory(slide, size, ops);
  });

  it('a form or group box under a turning CTM is a path clip', async () => {
    const { slide } = await walk('q 0.8 0.6 -0.6 0.8 150 0 cm /Fm1 Do Q');
    expect(Object.values(slide.clips)).toHaveLength(1);
    const clip = slide.clips.c1!;
    expect(clip.kind).toBe('path');
    // [0 0 50 50] under [2 0 0 2 10 10], then turned: the four corners, in the order `re` gives them.
    const corner = (x: number, y: number): [number, number] => [0.8 * x - 0.6 * y + 150, 300 - (0.6 * x + 0.8 * y)];
    const [x0, y0] = corner(10, 10);
    const [x1, y1] = corner(110, 10);
    const [x2, y2] = corner(110, 110);
    const [x3, y3] = corner(10, 110);
    expect(clip).toEqual({
      kind: 'path',
      geom: [['M', x0, y0], ['L', x1, y1], ['L', x2, y2], ['L', x3, y3], ['Z']],
      rule: 'nonzero',
      bbox: [Math.min(x0, x3), Math.min(y1, y2), Math.max(x1, x2), Math.max(y0, y3)].map((v) => Math.round(v * 1000) / 1000),
    });
  });

  it('group refs nest, outermost first', async () => {
    // /Fm8 is a group drawn at ca 0.8 in Screen (/GS10); inside it, /Fm9 is an isolated knockout group drawn at ca 0.4.
    // /Fm5, drawn under the soft mask /GS2 sets, is a group that takes the mask.
    const { ops, size, slide } = await walk('q /GS10 gs /Fm8 Do Q q /GS2 gs /Fm5 Do Q');
    const outer = { alpha: 0.8, blend: 'screen', isolated: false, knockout: false, bbox: [20, 100, 280, 280], mask: null };
    const inner = { alpha: 0.4, blend: 'normal', isolated: true, knockout: true, bbox: [110, 115, 230, 195], mask: null };
    const masking = { alpha: 1, blend: 'normal', isolated: false, knockout: false, bbox: [0, 0, 300, 300], mask: 'm1' };
    // Each group's text comes first: a line, in the same groups as the fills after it.
    expect(slide.elements.map((e) => e.kind)).toEqual(['textline', 'shape', 'shape', 'shape', 'textline', 'shape', 'shape', 'shape']);
    expect(slide.elements.map((e) => e.groups)).toEqual([[outer], [outer], [outer], [outer], [outer, inner], [outer, inner], [outer, inner], [masking]]);
    expect(slide.elements.map((e) => [e.blend, e.mask])).toEqual([
      ['normal', null],
      ['normal', null],
      ['normal', null],
      ['colordodge', null],
      ['normal', null],
      ['normal', null],
      ['normal', null],
      ['normal', 'm1'], // the mask its innermost group took (ruling M2-R14)
    ]);
    // A group's /BBox clips what it holds.
    expect(slide.elements.map((e) => e.clip)).toEqual([['c1'], ['c1'], ['c1'], ['c1'], ['c1', 'c2'], ['c1', 'c2'], ['c1', 'c2'], ['c3']]);
    expect(Object.keys(slide.masks)).toEqual(['m1']);
    expectSameInventory(slide, size, ops);
    expect(inventoryOf(slide).paints.map((p) => p.masked)).toEqual([false, false, false, false, false, true]);
  });

  it('a soft mask holds its elements and attaches to the masked paint only', async () => {
    // /GS2's mask is the luminosity of /Sh1 and a black square, in a group whose /BBox is [20 30 220 130]. It is set under a
    // clip of the page, which clips what it masks and not the mask.
    const { ops, size, fnArray, slide } = await walk(
      'q 0 0 100 280 re W n /GS2 gs 0 0 1 rg 10 10 50 50 re f /GS8 gs 70 10 50 50 re f Q 1 0 0 rg 100 100 20 20 re f',
    );
    expect(slide.elements.map((e) => e.mask)).toEqual(['m1', null, null]); // /GS8 is /SMask /None, and Q ends it too
    expect(slide.elements.map((e) => e.clip)).toEqual([['c1'], ['c1'], []]);
    expect(slide.clips).toMatchObject({ c1: { kind: 'path', bbox: [0, 20, 100, 300] } });
    const sh = fnArray.indexOf(OPS.shadingFill);
    expect(Object.keys(slide.masks)).toEqual(['m1']);
    const mask = slide.masks.m1!;
    expect(mask).toMatchObject({ subtype: 'luminosity', backdrop: [0, 0, 0] });
    expect(mask.clips).toEqual({ c1: { kind: 'box', bbox: [20, 170, 220, 270] } }); // its own /BBox, and no clip of the page
    expect(mask.elements).toMatchObject([
      { kind: 'shape', id: `p1:z${sh}`, geom: null, fill: { kind: 'linear' }, clip: ['c1'], clipBox: [20, 170, 220, 270], mask: null, groups: [] },
      { kind: 'shape', geom: [['M', 0, 300], ['L', 10, 300], ['L', 10, 290], ['L', 0, 290], ['Z']], fill: { kind: 'solid', rgb: [0, 0, 0] }, mask: null },
    ]);
    // Mask data is no page content (0002 §9): no element of the slide comes from it, and the inventory has none of it.
    const maskOps = new Set(mask.elements.map((e) => e.provenance.opIndex[0]));
    expect(slide.elements.some((e) => maskOps.has(e.provenance.opIndex[0]!))).toBe(false);
    expectSameInventory(slide, size, ops);
    expect(inventoryOf(slide).paints.map((p) => [p.kind, p.masked])).toEqual([
      ['fill', true],
      ['fill', false],
      ['fill', false],
    ]);
  });

  it('a soft mask with /Alpha and a backdrop', async () => {
    const pdf = onePage(
      'q /G gs 0 0 1 rg 10 10 100 100 re f Q',
      '/ExtGState << /G 10 0 R >>',
      [
        { num: 10, body: '<< /Type /ExtGState /SMask << /Type /Mask /S /Alpha /G 11 0 R /BC [1 0.5 0] >> >>' },
        { num: 11, dict: '/Type /XObject /Subtype /Form /BBox [0 0 300 300] /Group << /S /Transparency /CS /DeviceRGB >> /Resources << >>', data: '0 0 50 50 re f' },
      ],
    );
    const { slide } = await walkPdf(pdf);
    expect(slide.masks.m1).toMatchObject({ subtype: 'alpha', backdrop: [255, 128, 0] });
    expect(slide.masks.m1!.elements).toHaveLength(1);
  });
});

describe('the fills slides of atlas-smoke_std.pdf', () => {
  const SMOKE = `${repoRoot}corpus/generated/atlas-smoke_std.pdf`;
  const manifest = JSON.parse(readFileSync(`${repoRoot}corpus/generated/atlas-smoke.manifest.json`, 'utf8')) as {
    slides: { n: number; id: string }[];
  };
  const pages = manifest.slides.filter((s) => s.id.startsWith('atlas/fills/')).map((s) => s.n);

  /** Every tile cell of the elements, and of the cells in them. */
  function cells(elements: readonly Element[]): TileCell[] {
    const out: TileCell[] = [];
    for (const el of elements) {
      if (el.kind !== 'shape') continue;
      for (const fill of [el.fill, el.line?.paint]) {
        if (fill?.kind === 'tile') out.push(fill.cell, ...cells(fill.cell.elements));
      }
    }
    return out;
  }

  it("every tile cell has at least one element, and inventoryOfSlide equals the walker's inventory for the paints", async () => {
    expect(pages.length).toBeGreaterThanOrEqual(5);
    const bytes = new Uint8Array(readFileSync(SMOKE));
    const media = new MediaStore(openRawPdf(bytes));
    let tiles = 0;
    let gradients = 0;
    for (const n of pages) {
      const { ops, size, slide } = await walkPdf(bytes, n - 1, media);
      for (const cell of cells(slide.elements)) {
        tiles++;
        expect(cell.elements.length, `page ${n}`).toBeGreaterThan(0);
      }
      gradients += slide.elements.filter((e) => e.kind === 'shape' && (e.fill?.kind === 'linear' || e.fill?.kind === 'radial')).length;
      expectSameInventory(slide, size, ops);
    }
    // The pages reach what they are meant to: pattern fills (atlas/fills/08) and gradients (atlas/fills/04).
    expect(tiles).toBeGreaterThanOrEqual(12);
    expect(gradients).toBeGreaterThanOrEqual(6);
  }, 60_000);
});
