import { strFromU8, unzipSync } from 'fflate';
import { buildPdf, type MiniObject } from './minipdf';

/** Reading what `convert()` wrote, and PDFs of pages of any size for it. */

/** Every part of a PPTX, as text (media parts too, which no test reads as text). */
export function partsOf(pptx: Uint8Array): Record<string, string> {
  return Object.fromEntries(Object.entries(unzipSync(pptx)).map(([name, bytes]) => [name, strFromU8(bytes)]));
}

/** The slide size `presentation.xml` declares, EMU. */
export function slideSizeOf(parts: Record<string, string>): [number, number] {
  const found = /<p:sldSz cx="(\d+)" cy="(\d+)"/.exec(parts['ppt/presentation.xml'] ?? '');
  if (found === null) throw new Error('no p:sldSz');
  return [Number(found[1]), Number(found[2])];
}

/** The slide parts' count, `ppt/slides/slide<n>.xml`. */
export function slideCountOf(parts: Record<string, string>): number {
  return Object.keys(parts).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).length;
}

/** The shape tree of slide `n` (1-based): what follows the group shape's properties. */
export function treeOf(parts: Record<string, string>, n: number): string {
  const tree = /<\/p:grpSpPr>(.*)<\/p:spTree>/s.exec(parts[`ppt/slides/slide${n}.xml`] ?? '');
  if (tree === null) throw new Error(`no shape tree in slide ${n}`);
  return tree[1]!;
}

/** The nodes of a shape tree: each node's name and frame (`a:off`, `a:ext`), in z-order. */
export function framesOf(tree: string): { name: string; x: number; y: number; w: number; h: number }[] {
  const nodes = tree.match(/<p:(?:sp|cxnSp|pic)>.*?<\/p:(?:sp|cxnSp|pic)>/gs) ?? [];
  return nodes.map((node) => {
    const name = /<p:cNvPr id="\d+" name="([^"]*)"/.exec(node)?.[1] ?? '';
    const frame = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(node);
    if (frame === null) throw new Error(`no frame for ${name}`);
    return { name, x: Number(frame[1]), y: Number(frame[2]), w: Number(frame[3]), h: Number(frame[4]) };
  });
}

/**
 * What the shape trees of a deck hold, counted as the report counts them (`Counts`). Run links (M5 Task 5) are counted by
 * the relationships the runs' `a:hlinkClick`s name on each slide: two links of one slide to one target count once here.
 */
export function nodeCounts(parts: Record<string, string>): Record<string, number> {
  const counts = { textBoxes: 0, freeforms: 0, rects: 0, lines: 0, pictures: 0, gradients: 0, hotspots: 0, runLinks: 0 };
  for (let n = 1; n <= slideCountOf(parts); n++) {
    const tree = treeOf(parts, n);
    const runRels = new Set([...tree.matchAll(/<a:rPr[^>]*>(?:(?!<\/a:rPr>).)*<a:hlinkClick r:id="(rId\d+)"/gs)].map((m) => m[1]));
    counts.runLinks += runRels.size;
    for (const node of tree.match(/<p:(?:sp|cxnSp|pic)>.*?<\/p:(?:sp|cxnSp|pic)>/gs) ?? []) {
      // a gradient fill: in the shape's own fill, not its line's (ruling M3-R43); counted besides the shape's kind
      if (node.startsWith('<p:sp>') && /<a:gradFill/.test(node.replace(/<a:ln\b.*?<\/a:ln>/gs, ''))) counts.gradients++;
      if (node.startsWith('<p:cxnSp>')) counts.lines++;
      else if (node.startsWith('<p:pic>')) counts.pictures++;
      else if (node.includes('txBox="1"')) counts.textBoxes++;
      else if (node.includes('<a:custGeom>')) counts.freeforms++;
      else if (/ link"/.test(node)) counts.hotspots++;
      else counts.rects++;
    }
  }
  return counts;
}

/** A non-embedded TrueType font with widths for ' ' to 'C' (as the synthetic PDFs have), for text on any page. */
export const TEST_FONT: MiniObject = {
  num: 10,
  body:
    '<< /Type /Font /Subtype /TrueType /BaseFont /DeckbackTest /FirstChar 32 /LastChar 67 ' +
    `/Widths [${Array.from({ length: 36 }, (_, i) => (i === 0 ? 278 : i >= 33 ? 667 : 500)).join(' ')}] /Encoding /WinAnsiEncoding >>`,
};

/**
 * An embedded TrueType font at `num` (the font, its descriptor at `num + 1`, its program at `num + 2`): /BaseFont
 * `baseFont`, WinAnsi with widths for A to C, and `program` as its FontFile2 (`trueTypeFont`, helpers/sfnt.ts).
 */
export function embeddedTrueType(num: number, baseFont: string, program: Uint8Array): MiniObject[] {
  return [
    {
      num,
      body:
        `<< /Type /Font /Subtype /TrueType /BaseFont /${baseFont} /FirstChar 65 /LastChar 67 /Widths [600 600 600] ` +
        `/Encoding /WinAnsiEncoding /FontDescriptor ${num + 1} 0 R >>`,
    },
    {
      num: num + 1,
      body:
        `<< /Type /FontDescriptor /FontName /${baseFont} /Flags 32 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 ` +
        `/Descent -200 /CapHeight 700 /StemV 80 /FontFile2 ${num + 2} 0 R >>`,
    },
    { num: num + 2, dict: `/Length1 ${program.length}`, data: program, flate: true },
  ];
}

/**
 * A PDF of pages of any size: page n (from 0) is object 100 + 2n with its content in 101 + 2n, `page` added to its
 * dictionary (`/Annots`, `/Rotate`), the font /F1 (`TEST_FONT`) and `fonts` in its font resources, and `resources` in its
 * resources. Objects 1, 2 and 10 are taken; `objects` may use any other number below 100.
 */
export function sizedPdf(
  pages: { size: [number, number]; content: string; page?: string }[],
  options: { resources?: string; fonts?: string; objects?: MiniObject[] } = {},
): Uint8Array {
  const nums = pages.map((_, n) => 100 + 2 * n);
  return buildPdf([
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: `<< /Type /Pages /Kids [${nums.map((p) => `${p} 0 R`).join(' ')}] /Count ${nums.length} >>` },
    TEST_FONT,
    ...pages.flatMap(({ size, content, page }, n): MiniObject[] => [
      {
        num: nums[n]!,
        body:
          `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${size[0]} ${size[1]}] /Contents ${nums[n]! + 1} 0 R ` +
          `/Resources << /Font << /F1 10 0 R ${options.fonts ?? ''} >> ${options.resources ?? ''} >> ${page ?? ''} >>`,
      },
      { num: nums[n]! + 1, data: content },
    ]),
    ...(options.objects ?? []),
  ]);
}
