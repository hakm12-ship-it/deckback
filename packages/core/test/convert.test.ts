import { readFileSync } from 'node:fs';
import Ajv, { type ValidateFunction } from 'ajv';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { convert } from '../src/convert';
import { APPROXIMATIONS } from '../src/passes';
import { emu } from '../src/passes/lower/units';
import { REPORT_SCHEMA, type Report } from '../src/report/types';
import { canonicalJson } from '../src/scene/canonical';
import { extractScene, SceneInputError, scenePages } from '../src/scene/extract';
import { DECK_WEIGHT_BUDGET, SLIDE_WEIGHT_BUDGET } from '../src/scene/weight';
import { repoRoot } from './helpers/fixtures';
import { framesOf, partsOf, slideCountOf, slideSizeOf, sizedPdf, treeOf } from './helpers/pptx';
import { schemaErrors } from './helpers/scene';

/**
 * `convert()` (M3 Task 9): the PDF to a PPTX and its report, page by page. Determinism, page sizes (Review Focus 2),
 * duplicate pages (M2 F12), links between pages (ruling M3-R21) and the report's schema. The validator's verdict on
 * what it writes: convert.local.test.ts; hostile PDFs and failed pages: convert.faults.test.ts.
 */

/** `report.schema.json` as the tests validate with it (ajv, strict, every error); src has no ajv. */
const REPORT_JSON_SCHEMA = JSON.parse(readFileSync(new URL('../src/report/report.schema.json', import.meta.url), 'utf8')) as {
  $id: string;
  definitions: { Approximation: { enum: string[] } };
};
const ajv = new Ajv({ allErrors: true, strict: true });
ajv.addSchema(REPORT_JSON_SCHEMA);
const validateReport = ajv.getSchema(REPORT_SCHEMA) as ValidateFunction;

const read = (name: string): Uint8Array => new Uint8Array(readFileSync(`${repoRoot}corpus/generated/${name}`));

/**
 * A page the Scene builder cannot build (a lenient `slide-unbuildable`): a clip whose numbers are not finite once the
 * CTM is applied, then a square in it (M2's final review F11). PDF numbers have no exponent: 10^300 is written out.
 */
const E300 = `1${'0'.repeat(300)}`;
const UNBUILDABLE = `q ${E300} 0 0 ${E300} 0 0 cm 0 0 10000000000 10000000000 re W n 0 0 1 rg 0 0 1 1 re f Q`;

/** A page-sized rect in colour `rgb` (0-1), then a smaller one at (x, y) w x h in the page's own space. */
const marked = (w: number, h: number, box: [number, number, number, number]): string =>
  `0.9 0.9 0.9 rg 0 0 ${w} ${h} re f 0 0 1 rg ${box.join(' ')} re f`;
/** The page's grey rect of `marked` as the slide's background. */
const BACKGROUND = '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="E6E6E6"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>';

describe('convert(): media', () => {
  it('a pattern cell written as pattFill (M5-R10) leaves no picture part behind that nothing names', async () => {
    // atlas-smoke page 10: PowerPoint's preset patterns, each exported as a tiling pattern of a 16 px picture
    const { pptx } = await convert(read('atlas-smoke_std.pdf'), { pages: [9] });
    const parts = partsOf(pptx);
    expect(treeOf(parts, 1)).toContain('<a:pattFill prst=');
    const named = new Set(Object.entries(parts).filter(([n]) => n.endsWith('.rels')).flatMap(([, xml]) => [...xml.matchAll(/media\/([^"]+)"/g)].map((m) => m[1])));
    const media = Object.keys(parts).filter((n) => n.startsWith('ppt/media/')).map((n) => n.slice('ppt/media/'.length));
    expect(media.filter((m) => !named.has(m))).toEqual([]);
  });
});

/** A 16 x 8 RGB JPEG made for this test (Pillow, quality 90): a gradient, no metadata. */
const JPEG_16X8 = Uint8Array.from(atob(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIABADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDy3wn+yp9z/Q//AB2vZvCf7Kn3P9D/APHaKK8bOeJ8z1/eHyPhtxjnHufve39bn//Z',
), (c) => c.charCodeAt(0));

describe('convert(): a picture clipped by a path (Review Focus 5, M5 Task 5)', () => {
  /** The image drawn 160 x 80 pt, turned 30 degrees clockwise on the page about its corner at (100, 120) (PDF, y up), in `clips`. */
  const turnedJpeg = (clips: string): Uint8Array =>
    sizedPdf([{ size: [300, 200], content: `q ${clips} q 138.5640646 -80 40 69.2820323 100 120 cm /Im1 Do Q Q` }], {
      resources: '/XObject << /Im1 20 0 R >>',
      objects: [{ num: 20, dict: '/Type /XObject /Subtype /Image /Width 16 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode', data: JPEG_16X8 }],
    });
  /** A circle as PDF curves (four cubics), its centre the picture's. */
  const disc = (r: number): string => {
    const [cx, cy, k] = [189.282, 114.641, 0.5523 * r];
    return (
      `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ` +
      `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c h W n`
    );
  };
  /** The one shape of slide 1, the media part its picture fill names, and that part's bytes. */
  function filled(pptx: Uint8Array): { node: string; bytes: Uint8Array | undefined; media: string[] } {
    const parts = partsOf(pptx);
    const nodes = treeOf(parts, 1).match(/<p:(?:sp|pic)>.*?<\/p:(?:sp|pic)>/gs) ?? [];
    expect(nodes).toHaveLength(1);
    const node = nodes[0]!;
    const rid = /<a:blip r:embed="(rId\d+)"/.exec(node)?.[1];
    const rel = (parts['ppt/slides/_rels/slide1.xml.rels'] ?? '').split('<Relationship ').find((r) => r.includes(`Id="${rid}"`));
    const target = rel === undefined ? undefined : /Target="[^"]*media\/([^"]+)"/.exec(rel)?.[1];
    const raw = unzipSync(pptx);
    return { node, bytes: target === undefined ? undefined : raw[`ppt/media/${target}`], media: Object.keys(raw).filter((n) => n.startsWith('ppt/media/')) };
  }

  it('a JPEG clipped by a curved path and turned: a shape with a picture fill, turned with it, the JPEG bytes as they are', async () => {
    const { pptx, report } = await convert(turnedJpeg(disc(30)));
    const { node, bytes, media } = filled(pptx);
    expect(node).toMatch(/^<p:sp>/);
    expect(node).toContain('<a:custGeom>');
    expect(node).toContain('<a:cubicBezTo>'); // one path clip within the picture: its own curves
    expect(Number(/<a:xfrm rot="(\d+)"/.exec(node)?.[1])).toBeCloseTo(1800000, -1); // 30 degrees, to 60000ths
    expect(node).toContain('<a:blipFill');
    expect(media).toHaveLength(1);
    expect(bytes).toEqual(JPEG_16X8);
    expect(report.slides[0]!.approximations).toEqual([]);
    expect(report.slides[0]!.counts).toMatchObject({ freeforms: 1, pictures: 0, fallbacks: 0 });
  });

  it('in a curved path and a box that both cut it: their intersection, turned with it, the JPEG bytes as they are, clip-approx', async () => {
    const { pptx, report } = await convert(turnedJpeg(`0 0 300 120 re W n ${disc(30)}`));
    const { node, bytes } = filled(pptx);
    expect(node).toMatch(/^<p:sp>/);
    expect(node).not.toContain('<a:cubicBezTo>'); // flattened within 0.05 pt
    expect(Number(/<a:xfrm rot="(\d+)"/.exec(node)?.[1])).toBeCloseTo(1800000, -1); // 30 degrees, to 60000ths
    expect(bytes).toEqual(JPEG_16X8);
    // fix round 1 (review Minor 5): the picture is laid over its own frame, past the intersection's box on every side
    // but none (fillRect's sides negative, 1000ths of a percent of the node's box), so the box shows its part of it
    const fill = /<a:stretch><a:fillRect([^/]*)\/><\/a:stretch>/.exec(node)?.[1] ?? '';
    const sides = Object.fromEntries([...fill.matchAll(/(\w)="(-?\d+)"/g)].map((m) => [m[1]!, Number(m[2])]));
    expect(Object.keys(sides).length).toBeGreaterThan(0);
    expect(Object.values(sides).every((v) => v <= 0)).toBe(true);
    // along its 160 pt width the picture reaches 50 pt past the 60 pt circle on each side: l about -83 %
    expect(sides.l ?? 0).toBeLessThan(-50000);
    expect(report.slides[0]!.approximations.map((a) => a.kind)).toEqual(['clip-approx']);
  });
});

describe('convert(): the same PDF gives the same bytes', () => {
  it('two conversions are byte-identical', async () => {
    for (const [name, pages] of [
      ['probe_std.pdf', undefined],
      ['atlas-smoke_std.pdf', [8, 9, 31, 37]],
    ] as const) {
      const bytes = read(name);
      const copy = bytes.slice();
      const first = await convert(bytes, pages === undefined ? {} : { pages: [...pages] });
      const second = await convert(bytes, pages === undefined ? {} : { pages: [...pages] });
      expect(first.pptx.length, name).toBeGreaterThan(10_000);
      expect(Buffer.from(second.pptx).equals(Buffer.from(first.pptx)), name).toBe(true);
      expect(canonicalJson(second.report), name).toBe(canonicalJson(first.report));
      expect(bytes, `${name}: the caller's bytes are not changed`).toEqual(copy);
      expect(first.scene, 'no Scene without scene: true').toBeUndefined();
    }
  }, 60_000);

  it("scenePages hands each slide's new pictures over once, and extractScene is what it yields, collected", async () => {
    const bytes = read('atlas-smoke_std.pdf');
    const pages = [9, 31, 32, 33, 37, 8];
    const bundle = await extractScene(bytes, { pages });
    const seen: string[] = [];
    const slides: string[] = [];
    const walk = scenePages(bytes, { pages });
    let step = await walk.next();
    for (; step.done !== true; step = await walk.next()) {
      expect(step.value.count).toBe(pages.length);
      for (const hash of step.value.media.keys()) {
        expect(seen, 'a picture is handed over once').not.toContain(hash);
        expect(step.value.deck.media[hash]).toBeDefined();
        seen.push(hash);
      }
      slides.push(canonicalJson(step.value.slide));
    }
    expect(seen).toEqual([...bundle.media.keys()]);
    expect(seen.length).toBeGreaterThan(10);
    expect(slides).toEqual(bundle.scene.slides.map((s) => canonicalJson(s)));
    expect(canonicalJson(step.value)).toBe(canonicalJson({ source: bundle.scene.source, fonts: bundle.scene.fonts, media: bundle.scene.media }));
  });

  it('scene: true keeps the Scene extractScene makes, and the PPTX is the same', async () => {
    const bytes = read('probe_std.pdf');
    const { scene, pptx } = await convert(bytes, { scene: true });
    const bundle = await extractScene(bytes);
    expect(canonicalJson(scene)).toBe(canonicalJson(bundle.scene));
    expect(Buffer.from(pptx).equals(Buffer.from((await convert(bytes)).pptx))).toBe(true);
  });
});

describe('convert(): page sizes (Review Focus 2)', () => {
  it("convert scales an oversized page into PowerPoint's range", async () => {
    // 5000 x 3000 pt: past 4032 pt, so scaled down to 4032 wide; the square at (1000, 1000) on the page, 500 pt a side.
    const big = await convert(sizedPdf([{ size: [5000, 3000], content: `${marked(5000, 3000, [1000, 1000, 500, 500])} BT /F1 100 Tf 1000 2500 Td (AB) Tj ET` }]));
    const s = 4032 / 5000;
    const parts = partsOf(big.pptx);
    expect(slideSizeOf(parts)).toEqual([emu(4032), emu(3000 * s)]);
    expect(slideSizeOf(parts)).toEqual([51206400, 30723840]);
    expect(big.report.slideSizePt).toEqual([4032, 2419.2]);
    expect(big.report.slides[0]!.scale).toBe(0.8064);
    // the page's grey rect covers the whole slide: it is the slide's background (ruling M3-R52), not a shape
    expect(parts['ppt/slides/slide1.xml']).toContain(BACKGROUND);
    const [square] = framesOf(treeOf(parts, 1)).filter((f) => !f.name.endsWith('text'));
    // y down: the square's top is 3000 - 1500 = 1500 pt from the page's top
    expect(square).toMatchObject({ x: emu(1000 * s), y: emu(1500 * s), w: emu(500 * s), h: emu(500 * s) });
    // text sizes scale too: 100 pt is 80.64 pt
    expect(parts['ppt/slides/slide1.xml']).toMatch(/<a:rPr lang="en-US" sz="8064"/);

    // 50 x 30 pt: below 72 pt, so scaled up to 72 high
    const small = await convert(sizedPdf([{ size: [50, 30], content: marked(50, 30, [10, 10, 5, 5]) }]));
    expect(slideSizeOf(partsOf(small.pptx))).toEqual([emu(120), emu(72)]);
    expect(small.report.slideSizePt).toEqual([120, 72]);
    expect(small.report.slides[0]!.scale).toBe(2.4);

    // 10000 x 50 pt: no uniform scale brings both sides into range; the page is fitted to 4032 wide and centred in a
    // slide 72 pt high
    const strip = await convert(sizedPdf([{ size: [10000, 50], content: marked(10000, 50, [0, 0, 10000, 50]) }]));
    const t = 4032 / 10000;
    expect(strip.report.slideSizePt).toEqual([4032, 72]);
    expect(strip.report.slides[0]!.scale).toBe(0.4032);
    // the page leaves the slide's top and bottom bare: its rect is no background, but a shape where the page lands
    expect(partsOf(strip.pptx)['ppt/slides/slide1.xml']).not.toContain('<p:bg>');
    const [stripPage] = framesOf(treeOf(partsOf(strip.pptx), 1));
    const top = (72 - 50 * t) / 2;
    expect(stripPage).toMatchObject({ x: 0, y: emu(top), w: emu(4032), h: emu(50 * t + top) - emu(top) });
  });

  it('mixed page sizes are scaled to the first and centred', async () => {
    const pdf = sizedPdf([
      { size: [960, 540], content: marked(960, 540, [100, 100, 50, 50]) },
      { size: [595, 842], content: marked(595, 842, [100, 100, 50, 50]) }, // A4 portrait
      { size: [1920, 1080], content: marked(1920, 1080, [100, 100, 50, 50]) }, // twice the first
      { size: [720, 540], content: marked(720, 540, [100, 100, 50, 50]), page: '/Rotate 90' }, // 540 x 720 on the slide
    ]);
    const { pptx, report } = await convert(pdf);
    const parts = partsOf(pptx);
    expect(slideSizeOf(parts)).toEqual([emu(960), emu(540)]);
    expect(report.slideSizePt).toEqual([960, 540]);
    const a4 = 540 / 842;
    const turned = 540 / 720;
    expect(report.slides.map((s) => s.scale)).toEqual([null, Math.round(a4 * 1e6) / 1e6, 0.5, 0.75]);
    expect(report.slides.map((s) => s.index)).toEqual([1, 2, 3, 4]);

    /** Where a page of w x h lands: scale `k`, centred on the 960 x 540 slide; its box (x, y, w, h) in its own frame. */
    const landed = (w: number, h: number, k: number, [x, y, bw, bh]: number[]) => {
      const [ox, oy] = [(960 - w * k) / 2, (540 - h * k) / 2];
      const [x0, y0] = [emu(x! * k + ox), emu(y! * k + oy)];
      return { x: x0, y: y0, w: emu((x! + bw!) * k + ox) - x0, h: emu((y! + bh!) * k + oy) - y0 };
    };
    const frames = [1, 2, 3, 4].map((n) => framesOf(treeOf(parts, n)));
    // a page that fills the slide has its grey rect as the slide's background (ruling M3-R52); one centred with bare
    // slide beside it keeps it as a shape where it lands
    expect([1, 2, 3, 4].map((n) => parts[`ppt/slides/slide${n}.xml`]!.includes(BACKGROUND))).toEqual([true, false, true, false]);
    expect(frames[0]).toMatchObject([landed(960, 540, 1, [100, 390, 50, 50])]);
    expect(frames[1]).toMatchObject([landed(595, 842, a4, [0, 0, 595, 842]), landed(595, 842, a4, [100, 692, 50, 50])]);
    expect(frames[2]).toMatchObject([landed(1920, 1080, 0.5, [100, 930, 50, 50])]);
    // the A4 page is centred: as much slide left and right of it
    const [a4Page] = frames[1]!;
    expect(Math.abs(a4Page!.x - (emu(960) - a4Page!.x - a4Page!.w))).toBeLessThanOrEqual(1);
    // the turned page fills the slide's height and is centred across it
    const [turnedPage] = frames[3]!;
    expect(turnedPage).toMatchObject(landed(540, 720, turned, [0, 0, 540, 720]));
    expect(turnedPage!.h).toBe(emu(540));
  });

  it('M8 round 1a: what PowerPoint exports past the slide stays past it, where it is; a page centred on the slide drops what would show', async () => {
    // as a PowerPoint export: each object in a clip of the page's box (a picture past the edge in a box of 0.0001 pt at
    // the corner); a rect above the page, text below it, a 2 x 2 image left of it, and a rect on the page
    const img = '/XObject << /Im1 20 0 R >>';
    const content =
      'q 0 0 960 540 re W* n 1 0 0 rg 100 600 50 40 re f Q ' +
      'q 0 0 960 540 re W* n BT /F1 20 Tf 100 -40 Td (AB) Tj ET Q ' +
      'q 0 0 0.0001 0.0001 re W* n 60 0 0 40 -100 100 cm /Im1 Do Q ' +
      'q 0 0 960 540 re W* n 0 0 1 rg 10 10 30 30 re f Q';
    const objects = [{ num: 20, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8', data: new Uint8Array(12).fill(128) }];
    const pdf = sizedPdf([{ size: [960, 540], content }, { size: [480, 540], content }], { resources: img, objects });
    const { pptx, report } = await convert(pdf);
    const parts = partsOf(pptx);
    const at = (n: number) => framesOf(treeOf(parts, n)).map(({ name, x, y, w, h }) => [name.replace(/ \d+$/, ''), x, y, w, h]);
    // the slide of the page's size: all four, past the edges where the PDF has them (y down: PDF y 600 is 60 pt above)
    expect(at(1)).toEqual([
      ['pdf:p1:z4 rect', emu(100), emu(-100), emu(50), emu(40)],
      ['pdf:p1:z13 text', expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number)],
      ['pdf:p1:z21 picture', emu(-100), emu(400), emu(60), emu(40)],
      ['pdf:p1:z27 rect', emu(10), emu(500), emu(30), emu(30)],
    ]);
    const text = at(1)[1]!;
    expect(text[2]).toBeGreaterThan(emu(540)); // below the slide
    // a 480 x 540 page centred on the 960 x 540 slide, 240 pt of slide left and right of it: the picture 100 pt left of
    // the page would show there and is dropped; above and below the page is past the slide, kept
    expect(at(2).map((f) => f[0])).toEqual(['pdf:p2:z4 rect', 'pdf:p2:z13 text', 'pdf:p2:z27 rect']);
    expect(report.slides.map((s) => s.counts.pictures)).toEqual([1, 0]);
  });

  it('a page within a millionth of the slide size reports no scale, and is still drawn at its own', async () => {
    const pdf = sizedPdf([
      { size: [3000, 2000], content: marked(3000, 2000, [100, 100, 50, 50]) },
      { size: [3000.001, 2000], content: marked(3000.001, 2000, [100, 100, 50, 50]) },
    ]);
    const { pptx, report } = await convert(pdf);
    expect(report.slides.map((s) => s.scale)).toEqual([null, null]);
    // drawn at 3000 / 3000.001, not at 1: the page's own width lands on the slide's
    const [page] = framesOf(treeOf(partsOf(pptx), 2));
    expect(page).toMatchObject({ x: 0, w: emu(3000) });
  });

  it('a failed page whose size is known is the first converted page: it gives the slide size', async () => {
    // page 1 cannot be built (a clip of numbers that are not finite: M2's final review F11), page 2 is 400 x 300 pt; a
    // page pdf.js cannot load has no size, and the next page gives it (convert.faults.test.ts)
    const pdf = sizedPdf([
      { size: [800, 600], content: UNBUILDABLE },
      { size: [400, 300], content: marked(400, 300, [10, 10, 5, 5]) },
    ]);
    const { report } = await convert(pdf);
    expect(report.slides.map((s) => s.failed)).toEqual(['slide-unbuildable', null]);
    expect(report.slideSizePt).toEqual([800, 600]);
    expect(report.slides.map((s) => s.scale)).toEqual([null, 2]);
  });
});

describe('convert(): pages', () => {
  it('duplicate pages are refused', async () => {
    const pdf = sizedPdf([
      { size: [300, 200], content: marked(300, 200, [10, 10, 5, 5]) },
      { size: [300, 200], content: marked(300, 200, [10, 10, 5, 5]) },
    ]);
    for (const pages of [[0, 0], [1, 0, 1]]) {
      const refused = convert(pdf, { pages });
      await expect(refused).rejects.toBeInstanceOf(SceneInputError);
      await expect(refused).rejects.toMatchObject({ kind: 'duplicate page' });
      await expect(extractScene(pdf, { pages })).rejects.toMatchObject({ kind: 'duplicate page' });
    }
    // a page outside the document is still a RangeError
    await expect(convert(pdf, { pages: [2] })).rejects.toBeInstanceOf(RangeError);
    expect((await convert(pdf, { pages: [1, 0] })).report.slides.map((s) => s.index)).toEqual([2, 1]);
  });

  it('a link to a page goes to its slide; a link to a page not converted is dropped and counted (ruling M3-R21)', async () => {
    const links =
      '/Annots [<< /Type /Annot /Subtype /Link /Rect [10 10 60 30] /Dest [104 0 R /Fit] >> ' +
      '<< /Type /Annot /Subtype /Link /Rect [70 10 120 30] /Dest [102 0 R /Fit] >> ' +
      '<< /Type /Annot /Subtype /Link /Rect [130 10 180 30] /A << /S /URI /URI (https://example.com/) >> >>]';
    const pdf = sizedPdf([
      { size: [300, 200], content: marked(300, 200, [10, 10, 5, 5]), page: links },
      { size: [300, 200], content: marked(300, 200, [20, 20, 5, 5]) },
      { size: [300, 200], content: marked(300, 200, [30, 30, 5, 5]) },
    ]);
    const slideTargets = (parts: Record<string, string>, n: number): string[] =>
      [...(parts[`ppt/slides/_rels/slide${n}.xml.rels`] ?? '').matchAll(/Target="([^"]*)"/g)].map((m) => m[1]!).filter((t) => !t.includes('Layout'));

    // every page: page n is slide n
    const all = await convert(pdf);
    expect(slideTargets(partsOf(all.pptx), 1)).toEqual(['slide3.xml', 'slide2.xml', 'https://example.com/']);
    expect(all.report.totals.hotspots).toBe(3);
    expect(all.report.totals.droppedLinks).toEqual({ url: 0, scheme: 0, slide: 0, page: 0, budget: 0, target: 0 });

    // pages 3 and 1, in that order: page 3 is slide 1, page 2 is not converted
    const some = await convert(pdf, { pages: [2, 0] });
    const parts = partsOf(some.pptx);
    expect(slideCountOf(parts)).toBe(2);
    expect(slideTargets(parts, 2)).toEqual(['slide1.xml', 'https://example.com/']);
    expect(some.report.slides.map((s) => [s.index, s.counts.hotspots])).toEqual([
      [3, 0],
      [1, 2],
    ]);
    expect(some.report.totals.droppedLinks).toEqual({ url: 0, scheme: 0, slide: 0, page: 1, budget: 0, target: 0 });
  });

  it('M5 Task 5: a link exactly over a run of text goes on the run; one with no target (final review F6) is dropped and counted', async () => {
    const content = 'BT /F1 24 Tf 50 100 Td (ABC) Tj ET';
    // where the run lands (the Scene's advance box, y down: the test font says no ascent or descent, so it is flat), so the
    // link's rect is exactly it, within 0.5 pt, as PowerPoint writes one
    const scene = await extractScene(sizedPdf([{ size: [300, 200], content }]));
    const run = scene.scene.slides[0]!.elements.find((e) => e.kind === 'textline')!;
    const [x0, y0, x1, y1] = run.kind === 'textline' ? run.bboxPt : [0, 0, 0, 0];
    const annots =
      `/Annots [<< /Type /Annot /Subtype /Link /Rect [${x0} ${200 - y1 - 0.4} ${x1} ${200 - y0 + 0.4}] /A << /S /URI /URI (https://example.com/run) >> >> ` +
      '<< /Type /Annot /Subtype /Link /Rect [150 10 200 30] /A << /S /JavaScript /JS (app.alert) >> >> ' +
      '<< /Type /Annot /Subtype /Link /Rect [150 50 200 70] /A << /S /URI /URI (https://example.com/box) >> >>]';
    const { pptx, report } = await convert(sizedPdf([{ size: [300, 200], content, page: annots }]));
    const parts = partsOf(pptx);
    const t = treeOf(parts, 1);
    expect(t).toMatch(/<a:uFill><a:noFill\/><\/a:uFill>.*<a:hlinkClick r:id="rId\d+"><a:extLst>.*<\/a:rPr><a:t>ABC<\/a:t>/);
    expect(t.match(/ link"/g)).toHaveLength(1); // the link over nothing stays a hotspot
    const rels = parts['ppt/slides/_rels/slide1.xml.rels'] ?? '';
    expect(rels).toContain('Target="https://example.com/run"');
    expect(rels).toContain('Target="https://example.com/box"');
    expect(report.totals).toMatchObject({ hotspots: 1, runLinks: 1 });
    expect(report.totals.droppedLinks).toEqual({ url: 0, scheme: 0, slide: 0, page: 0, budget: 0, target: 1 });
  });
});

describe('convert(): the report', () => {
  it('the report validates against its schema', async () => {
    const decks: Report[] = [
      (await convert(read('probe_std.pdf'))).report,
      // page 16 holds text-drift-split; page 25's clip-dropped was alpha-0 text, which paints nothing (M5 Task 3), and
      // page 3's nonzero-approx is its fill's outline now (M5 Task 4)
      (await convert(read('atlas-smoke_std.pdf'), { pages: [8, 9, 24, 31, 2, 15] })).report,
      (
        await convert(
          sizedPdf([
            { size: [5000, 3000], content: marked(5000, 3000, [10, 10, 5, 5]) },
            { size: [300, 200], content: UNBUILDABLE },
            { size: [595, 842], content: 'BT /F1 12 Tf 10 10 Td (ABC) Tj ET 0 0 1 rg 10 10 m 10 10 l S' },
          ]),
        )
      ).report,
    ];
    for (const report of decks) {
      expect(schemaErrors(validateReport, report)).toEqual([]);
      expect(report.schema).toBe('deckback.report/1');
      expect(report.budgets).toMatchObject({ slideWeight: SLIDE_WEIGHT_BUDGET, deckWeight: DECK_WEIGHT_BUDGET });
      // the totals are the slides' counts summed
      for (const key of Object.keys(report.slides[0]!.counts) as (keyof Report['slides'][0]['counts'])[]) {
        expect(report.totals[key], key).toBe(report.slides.reduce((n, s) => n + s.counts[key], 0));
      }
      for (const kind of APPROXIMATIONS) {
        expect(report.totals.approximations[kind], kind).toBe(report.slides.reduce((n, s) => n + s.approximations.filter((a) => a.kind === kind).length, 0));
      }
    }
    // the synthetic deck: a scaled page, a failed one (no scale: nothing is drawn), a font
    const [, smoke, synthetic] = decks;
    expect(smoke!.totals.approximations).not.toEqual(Object.fromEntries(APPROXIMATIONS.map((k) => [k, 0])));
    expect(synthetic!.slides.map((s) => [s.scale, s.failed])).toEqual([
      [0.8064, null],
      [null, 'slide-unbuildable'],
      [Math.round(((3000 * 0.8064) / 842) * 1e6) / 1e6, null],
    ]);
    expect(synthetic!.fonts).toEqual([{ key: 'f1', latin: 'DeckbackTest', ea: null, embedded: false, type3: false, written: { latin: 'DeckbackTest', ea: 'DeckbackTest' } }]);
    // the schema knows every approximation kind, and only those
    expect(REPORT_JSON_SCHEMA.definitions.Approximation.enum).toEqual([...APPROXIMATIONS]);
  }, 60_000);

  it('the schema refuses what a report never holds', () => {
    const report: Report = {
      schema: REPORT_SCHEMA,
      source: { producer: null, creator: null, tagged: false, encrypted: false, pageCount: 1 },
      slideSizePt: [960, 540],
      slides: [],
      fonts: [],
      totals: {
        textBoxes: 0,
        freeforms: 0,
        rects: 0,
        lines: 0,
        pictures: 0,
        gradients: 0,
        hotspots: 0,
        runLinks: 0,
        fallbacks: 0,
        approximations: Object.fromEntries(APPROXIMATIONS.map((k) => [k, 0])) as Report['totals']['approximations'],
        droppedLinks: { url: 0, scheme: 0, slide: 0, page: 0, budget: 0, target: 0 },
      },
      budgets: { slideWeight: SLIDE_WEIGHT_BUDGET, deckWeight: DECK_WEIGHT_BUDGET, exceeded: { slide: [], deck: false } },
    };
    expect(schemaErrors(validateReport, report)).toEqual([]);
    expect(schemaErrors(validateReport, { ...report, slideSizePt: [5000, 540] })).not.toEqual([]);
    expect(schemaErrors(validateReport, { ...report, extra: 1 })).not.toEqual([]);
    const { approximations } = report.totals;
    expect(schemaErrors(validateReport, { ...report, totals: { ...report.totals, approximations: { ...approximations, made_up: 1 } } })).not.toEqual([]);
  });
});
