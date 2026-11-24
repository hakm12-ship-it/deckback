import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, releasePage } from '../../src/engine/pdfjs-adapter';
import type { Box } from '../../src/extract/inventory';
import { pageFrame, walkPage } from '../../src/extract/walker';
import { buildSlide } from '../../src/scene/build';
import { canonicalJson, canWrite, sceneHash } from '../../src/scene/canonical';
import { FontTable } from '../../src/scene/fonts';
import { MediaStore } from '../../src/scene/media';
import {
  SCENE_SCHEMA,
  type ClipDef,
  type ElementBase,
  type FallbackEl,
  type Fill,
  type FontInfo,
  type HotspotEl,
  type MaskDef,
  type MediaInfo,
  type PictureEl,
  type SceneDeck,
  type SceneSlide,
  type ShapeEl,
  type TextLineEl,
  type TileCell,
} from '../../src/scene/types';
import { SCENE_JSON_SCHEMA, schemaErrors, validateDeck, validateSlide } from '../helpers/scene';
import { syntheticPdf } from '../helpers/synthetic';

/**
 * `scene.schema.json` (plain data in src; only tests validate with it, so the engine bundle has no ajv) against the
 * Scene v1 types, and the canonical JSON the Scene hash is taken of.
 */

async function builtSlide(fonts = new FontTable(null)): Promise<SceneSlide> {
  const doc = await openDocument(
    syntheticPdf(
      '1 0 0 rg 0 0 1 RG /GS3 gs 10 20 30 40 re B q 2 0 0 1 0 0 cm 20 100 m 60 140 80 100 120 120 c S Q q /GS10 gs /Fm8 Do Q ' +
        // Pictures (Task 10): an image upside down, a stencil, and a stencil filled with a pattern (a fallback and a note).
        'q 30 0 0 -20 200 270 cm /Im2 Do Q q 20 0 0 20 220 20 cm /Im3 Do Q /Pattern cs /P4 scn q 10 0 0 10 250 250 cm /Im3 Do Q',
    ),
  );
  try {
    const page = await loadPage(doc, 0);
    try {
      const context = { media: new MediaStore(null), fonts, page };
      return await buildSlide({ index: 0, sizePt: pageFrame(page).size, ops: walkPage(page) }, context);
    } finally {
      await releasePage(page);
    }
  } finally {
    await closeDocument(doc);
  }
}

// -- one of everything Scene v1 has, typed, so that the TypeScript types and the schema cannot drift apart -----------

const BOX: Box = [0, 0, 10, 10];
const HASH = 'ab'.repeat(32);
const base = (id: string, over: Partial<ElementBase> = {}): ElementBase => ({
  id,
  provenance: { opIndex: [1], mcid: null, struct: null },
  clip: [],
  clipBox: BOX,
  groups: [],
  mask: null,
  blend: 'normal',
  ...over,
});
const solid: Fill = { kind: 'solid', rgb: [1, 2, 3], alpha: 1 };
const stops = [
  { t: 0, rgb: [0, 0, 0] },
  { t: 1, rgb: [255, 255, 255] },
] satisfies { t: number; rgb: [number, number, number] }[];
const linear: Fill = { kind: 'linear', stops, p0: [0, 0], p1: [10, 0], matrix: [1, 0, 0, 1, 0, 0], extend: [true, false], alpha: 0.5 };
const radial: Fill = { kind: 'radial', stops, p0: [5, 5], r0: 0, p1: [5, 5], r1: 5, matrix: [1, 0, 0, 1, 0, 0], extend: [false, true], alpha: 1 };
const shadingFill: Fill = {
  kind: 'shading',
  shading: 'mesh',
  alpha: 1,
  mesh: { type: 4, xy: [0, 0, 10, 0, 0, 10], rgb: [0, 0, 0, 128, 128, 128, 255, 255, 255], triangles: [0, 1, 2], matrix: [1, 0, 0, 1, 0, 0], bbox: [0, 0, 10, 10], background: [255, 0, 0] },
};
const functionFill: Fill = { kind: 'shading', shading: 'function', alpha: 1, mesh: null };
const clips: Record<string, ClipDef> = {
  c0: { kind: 'path', geom: [['M', 0, 0], ['L', 10, 0], ['L', 10, 10], ['Z']], rule: 'evenodd', bbox: BOX },
  c1: { kind: 'box', bbox: BOX },
  c2: { kind: 'text', bbox: BOX, approx: true },
};
const shape: ShapeEl = {
  ...base('p1:z1', { clip: ['c0', 'c1'], provenance: { opIndex: [1, 2], mcid: 4, struct: ['Sect', 'P'] } }),
  kind: 'shape',
  geom: [['M', 0, 0], ['L', 1, 1], ['C', 1, 2, 3, 4, 5, 6], ['Z']],
  fillRule: 'nonzero',
  fill: solid,
  line: { w: 1, cap: 'round', join: 'bevel', miter: 10, dash: [1, 2], phase: 0, anisotropic: true, paint: linear },
  bbox: BOX,
};
const cell: TileCell = { bbox: BOX, xStep: 10, yStep: 10, matrix: [1, 0, 0, 1, 0, 0], paintType: 1, elements: [shape], clips };
const textline: TextLineEl = {
  ...base('p1:z2', { clip: ['c2'] }),
  kind: 'textline',
  runs: [
    {
      text: 'Ab',
      fontKey: 'f0',
      sizePt: 12,
      rgb: [0, 0, 0],
      alpha: 1,
      fillMode: 'fillStroke',
      stroke: { rgb: [9, 9, 9], alpha: 1, wPt: 0.5 },
      fill: null,
      bold: false,
      italic: true,
      spcPt: 0,
      hScale: 1,
      skew: 0,
      rise: 0,
      glyphs: [
        { u: 'A', x: 0, y: 12, adv: 6 },
        { u: 'b', x: 6, y: 12, adv: 6 },
      ],
    },
    { ...emptyRun(), fillMode: 'noFill', rgb: null, fill: radial },
  ],
  baseline: { x: 0, y: 12 },
  angleDeg: 0,
  wmode: 0,
  bboxPt: BOX,
};
const picture: PictureEl = {
  ...base('p1:z3', {
    groups: [
      { alpha: 0.5, blend: 'multiply', isolated: true, knockout: false, bbox: BOX, mask: 'm0' },
      { alpha: 1, blend: 'normal', isolated: false, knockout: false, bbox: null, mask: null },
    ],
    mask: 'm0',
  }),
  kind: 'picture',
  mediaHash: HASH,
  matrix: [10, 0, 0, -10, 0, 10],
  xfrm: { x: 0, y: 0, w: 10, h: 10, rotDeg: 0, flipH: false, flipV: false },
  skewed: false,
  alpha: 1,
  stencil: null,
  px: [2, 3],
};
const fallback: FallbackEl = { ...base('p1:z4'), kind: 'fallback', reason: 'unsupported-op', coveredOps: [4], raster: null, bbox: null };
const hotspot: HotspotEl = { ...base('p1:z5', { blend: 'screen' }), kind: 'hotspot', rect: BOX, link: { url: null, dest: 'slide 2' } };
const tiled: ShapeEl = { ...shape, id: 'p1:z6', geom: null, fill: { kind: 'tile', cell, alpha: 1 }, line: null };
const shaded: ShapeEl = { ...shape, id: 'p1:z7', fill: shadingFill, line: { ...shape.line!, paint: functionFill } };
const mask: MaskDef = { subtype: 'luminosity', backdrop: [0, 0, 0], elements: [{ ...shape, id: 'p1:z8' }], clips: {} };
const font: FontInfo = {
  key: 'f0',
  baseFont: 'Deckback-Regular',
  latinName: 'Deckback',
  eaName: null,
  bold: false,
  italic: false,
  embedded: true,
  fsType: 0,
  isVariable: false,
  type3: false,
  metrics: { upm: 1000, hheaAsc: 800, hheaDesc: -200, hheaLineGap: 0, winAsc: 800, winDesc: 200, typoAsc: 750, typoDesc: -250, typoLineGap: 200, fsSelection: 0x80 },
};
const media: MediaInfo = { hash: HASH, mime: 'image/png', widthPx: 2, heightPx: 3, byteLength: 70, passthrough: false };

function emptyRun(): TextLineEl['runs'][number] {
  return {
    text: '',
    fontKey: 'f1',
    sizePt: 10,
    rgb: [0, 0, 0],
    alpha: 1,
    fillMode: 'fill',
    stroke: null,
    fill: null,
    bold: true,
    italic: false,
    spcPt: 0.5,
    hScale: 0.9,
    skew: 0.2,
    rise: -1,
    glyphs: [],
  };
}

/** A fresh copy each time: the tests below change it. */
function everything(): SceneDeck {
  const deck: SceneDeck = {
    schema: SCENE_SCHEMA,
    source: { producer: 'Deckback Test', creator: null, tagged: true, encrypted: false, pageCount: 2 },
    slides: [
      {
        index: 0,
        sizePt: [960, 540],
        elements: [shape, textline, picture, fallback, hotspot, tiled, shaded],
        clips,
        masks: { m0: mask, m1: { subtype: 'alpha', backdrop: null, elements: [], clips } },
        notes: [{ opIndex: 4, op: 'shadingFill', detail: 'unsupported shading' }],
        failed: null,
      },
      { index: 1, sizePt: [960, 540], elements: [], clips: {}, masks: {}, notes: [], failed: 'unreadable' },
    ],
    fonts: { f0: font, f1: { ...font, key: 'f1', latinName: null, fsType: null, metrics: null, type3: true, embedded: false } },
    media: { [HASH]: media },
  };
  return structuredClone(deck);
}

/** The JSON path of every object in `value` (arrays are walked, not listed), with its parent's key. */
function objectPaths(value: unknown, path: (string | number)[] = [], out: { path: (string | number)[]; key: string | number | null }[] = []) {
  if (Array.isArray(value)) value.forEach((v, i) => objectPaths(v, [...path, i], out));
  else if (typeof value === 'object' && value !== null) {
    out.push({ path, key: path.at(-1) ?? null });
    for (const [k, v] of Object.entries(value)) objectPaths(v, [...path, k], out);
  }
  return out;
}

function at(root: unknown, path: (string | number)[]): Record<string, unknown> {
  return path.reduce((node: unknown, k) => (node as Record<string | number, unknown>)[k], root) as Record<string, unknown>;
}

/** Maps from an id to a definition: their keys are data, not fields. */
const RECORDS: ReadonlySet<unknown> = new Set(['clips', 'masks', 'fonts', 'media']);

describe('scene.schema.json', () => {
  it('is Scene v1: its $id is the schema name', () => {
    expect(SCENE_JSON_SCHEMA.$id).toBe('deckback.scene/1');
    expect(SCENE_SCHEMA).toBe('deckback.scene/1');
  });

  it('a built slide validates', async () => {
    const fonts = new FontTable(null);
    const slide = await builtSlide(fonts);
    expect(slide.elements.length).toBeGreaterThan(4);
    expect(new Set(slide.elements.map((e) => e.kind))).toEqual(new Set(['shape', 'textline', 'picture', 'fallback']));
    expect(slide.elements.some((e) => e.kind === 'picture' && e.xfrm.flipV && e.stencil === null)).toBe(true);
    expect(slide.notes).toHaveLength(1);
    expect(schemaErrors(validateSlide, slide)).toEqual([]);
    expect(schemaErrors(validateSlide, JSON.parse(canonicalJson(slide)))).toEqual([]);
    const deck: SceneDeck = {
      schema: SCENE_SCHEMA,
      source: { producer: null, creator: null, tagged: false, encrypted: false, pageCount: 1 },
      slides: [slide],
      fonts: fonts.infos(),
      media: {},
    };
    expect(Object.keys(deck.fonts)).toEqual(['f1']); // the text of /Fm8 and /Fm9
    expect(schemaErrors(validateDeck, deck)).toEqual([]);
  });

  it('a deck with every kind of element, fill, clip, group, mask, font and media validates', () => {
    expect(schemaErrors(validateDeck, everything())).toEqual([]);
  });

  it('an unknown field fails', async () => {
    const slide = await builtSlide();
    const extended = { ...slide, elements: [{ ...slide.elements[0], extra: 1 }, ...slide.elements.slice(1)] };
    expect(validateSlide(extended)).toBe(false);
    expect(schemaErrors(validateSlide, extended)).toContain('/elements/0 must NOT have additional properties');

    // additionalProperties: false throughout: an unknown field on any object of the deck makes it invalid.
    const paths = objectPaths(everything());
    expect(paths.length).toBeGreaterThan(70);
    for (const { path } of paths) {
      const deck = everything();
      at(deck, path).unknownField = true;
      expect(validateDeck(deck), `/${path.join('/')}`).toBe(false);
    }
  });

  it('every field is required, and a wrong value fails', () => {
    for (const { path, key } of objectPaths(everything())) {
      if (RECORDS.has(key)) continue; // a map may lose an entry
      for (const field of Object.keys(at(everything(), path))) {
        const deck = everything();
        delete at(deck, path)[field];
        expect(validateDeck(deck), `/${[...path, field].join('/')}`).toBe(false);
      }
    }
    const wrong: [string, (deck: SceneDeck) => void][] = [
      ['an unknown schema', (d) => void ((d as { schema: string }).schema = 'deckback.scene/2')],
      ['a blend mode named as pdf.js does', (d) => void ((d.slides[0]!.elements[0] as { blend: string }).blend = 'color-dodge')],
      ['a box of 5 numbers', (d) => void (d.slides[0]!.elements[0]!.clipBox = [0, 0, 1, 1, 1] as unknown as Box)],
      ['a channel past 255', (d) => void ((d.slides[0]!.elements[0] as ShapeEl).fill = { kind: 'solid', rgb: [256, 0, 0], alpha: 1 })],
      ['a path segment of 3 numbers', (d) => void ((d.slides[0]!.elements[0] as ShapeEl).geom = [['M', 0, 0, 0]] as never)],
      ['a matrix of 4 numbers', (d) => void ((d.slides[0]!.elements[2] as PictureEl).matrix = [1, 0, 0, 1])],
      ['a pixel size of 0', (d) => void ((d.slides[0]!.elements[2] as PictureEl).px = [0, 3])],
      ['a media key that is no SHA-256', (d) => void (d.media = { 'not-a-hash': media })],
      ['a raster before M5', (d) => void ((d.slides[0]!.elements[3] as { raster: unknown }).raster = 'x')],
      ['a string for a number', (d) => void ((d.slides[0]!.sizePt as unknown[])[0] = '960')],
    ];
    for (const [name, change] of wrong) {
      const deck = everything();
      change(deck);
      expect(validateDeck(deck), name).toBe(false);
    }
  });
});

describe('canonicalJson and sceneHash', () => {
  it('canonicalJson sorts keys and rounds, -0 becomes 0', () => {
    expect(canonicalJson({ b: 1, a: [-0, 1.23456789, { d: -0.0000001, c: 'x', e: null, f: true }], C: -2.5e-7 })).toBe(
      '{"C":0,"a":[0,1.234568,{"c":"x","d":0,"e":null,"f":true}],"b":1}',
    );
    expect(canonicalJson({ y: { b: 2, a: 1 }, x: [3] })).toBe(canonicalJson({ x: [3], y: { a: 1, b: 2 } }));
    expect(canonicalJson('é "')).toBe(JSON.stringify('é "'));
    expect(canonicalJson({ skipped: undefined, kept: 0 })).toBe('{"kept":0}'); // as JSON.stringify
  });

  it('canonicalJson refuses what JSON cannot carry exactly', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, { a: [1, Number.NEGATIVE_INFINITY] }, [undefined], new Map(), 1n, () => 1]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
    }
    expect(() => canonicalJson({ a: [1, Number.NaN] })).toThrow('canonicalJson: $.a[1] is not a finite number');
  });

  it('canWrite says, without writing, whether canonicalJson can write a value', async () => {
    const bad = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      { a: [1, Number.NEGATIVE_INFINITY] },
      [undefined],
      new Map(),
      1n,
      () => 1,
      [1, , 2],
      { a: { b: new Date(0) } },
    ];
    const good = [
      null,
      0,
      -0,
      'x',
      true,
      [],
      {},
      { a: undefined, b: [1, 'x', null, { c: false }] },
      Object.create(null) as object,
      everything(),
      await builtSlide(),
    ];
    for (const [i, value] of [...bad, ...good].entries()) {
      let writes = true;
      try {
        canonicalJson(value);
      } catch {
        writes = false;
      }
      expect(canWrite(value), `value ${i}`).toBe(writes);
    }
    expect(bad.map(canWrite)).toEqual(bad.map(() => false));
    expect(good.map(canWrite)).toEqual(good.map(() => true));
  });

  it('canonicalJson leaves a built slide as it is (its numbers are rounded when it is built: M2-R13)', async () => {
    const slide = await builtSlide();
    expect(JSON.parse(canonicalJson(slide))).toEqual(slide);
  });

  it('sceneHash is the SHA-256 of the canonical JSON in UTF-8, the same for the same scene', async () => {
    const deck = everything();
    const hash = await sceneHash(deck);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash('sha256').update(canonicalJson(deck), 'utf8').digest('hex'));
    const reordered = Object.fromEntries(Object.entries(deck).reverse());
    expect(await sceneHash(reordered)).toBe(hash);
    expect(await sceneHash({ ...deck, slides: [] })).not.toBe(hash);
  });
});

/** Node's built-in modules, without the `node:` prefix: `fs`, `fs/promises`, `path`, `crypto`, ... */
const BUILTINS: ReadonlySet<string> = new Set(builtinModules.filter((name) => !name.startsWith('_')).map((name) => name.replace(/^node:/, '')));

/**
 * What a source file loads that does not run in a module worker: `ajv` (tests only), a `node:` module, a Node built-in by
 * its bare name (`fs`, `path/posix`), and anything through `require(`. Every form that names a module is read: `import ...
 * from`, a bare `import '...'`, `export ... from`, `import(...)` and `require(...)`.
 */
function forbiddenImports(text: string): string[] {
  const found: string[] = [];
  const specifiers = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]|\brequire\s*\(\s*['"]?([^'")]*)/g;
  for (const [, imported, required] of text.matchAll(specifiers)) {
    if (required !== undefined) {
      found.push(`require(${required})`);
      continue;
    }
    const name = imported!;
    const bare = name.replace(/^node:/, '');
    if (name === 'ajv' || name.startsWith('node:') || BUILTINS.has(bare) || BUILTINS.has(bare.split('/')[0]!)) found.push(name);
  }
  return found;
}

describe('the scene code runs everywhere', () => {
  const srcDir = new URL('../../src/', import.meta.url);
  const sources = (): [string, string][] => {
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    return files.map((file) => [file, readFileSync(new URL(file.replaceAll('\\', '/'), srcDir), 'utf8')]);
  };

  it('the scan finds every form of a Node-only import', () => {
    expect(BUILTINS.has('fs') && BUILTINS.has('path') && BUILTINS.has('crypto')).toBe(true);
    const caught: [string, string[]][] = [
      ["import { readFileSync } from 'node:fs';", ['node:fs']],
      ["import 'node:fs';", ['node:fs']],
      ['import "fs";', ['fs']],
      ["import * as path from 'path';", ['path']],
      ["import { readFile } from 'fs/promises';", ['fs/promises']],
      ["export { createHash } from 'crypto';", ['crypto']],
      ["const m = await import('node:module');", ['node:module']],
      ['const z = await import ( "zlib" );', ['zlib']],
      ["const fs = require('fs');", ['require(fs)']],
      ['const x = require(name);', ['require(name)']],
      ["import Ajv from 'ajv';", ['ajv']],
    ];
    for (const [text, expected] of caught) expect(forbiddenImports(text), text).toEqual(expected);
    const fine = [
      "import { OPS } from './pdfjs-ops';",
      "import { zlibSync } from 'fflate';",
      "await import('pdfjs-dist/legacy/build/pdf.mjs');",
      "import type * as Pdfjs from 'pdfjs-dist';",
      "import { fsType } from './fs';",
      '// the path of a file',
    ];
    for (const text of fine) expect(forbiddenImports(text), text).toEqual([]);
  });

  it('nothing in src imports ajv, a node: module or a Node built-in, or calls require', () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(10);
    for (const [file, text] of files) expect(forbiddenImports(text), file).toEqual([]);
  });

  it('nothing in src uses Math.hypot, whose result engines may round differently (Global Constraints, Determinism)', () => {
    for (const [file, text] of sources()) expect(text, file).not.toMatch(/Math\.hypot\b/);
  });

  it('fflate, whose deflate makes the PNG bytes and so the media hashes, is pinned to one version', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
    expect(manifest.dependencies.fflate).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
