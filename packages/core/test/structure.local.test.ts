import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { closeDocument, loadPage, openDocument, releasePage, type PageData, type StructNode } from '../src/engine/pdfjs-adapter';
import { joinStructure, mcidAncestors } from '../src/engine/structure';
import { walkPage, type RawOp } from '../src/extract/walker';
import { fixture, repoRoot } from './helpers/fixtures';
import { buildDeck } from './helpers/scene';

/**
 * Spike M0-4: the walker's marked-content ids against the structure tree of a PowerPoint-tagged PDF.
 * Writes the observed role paths to `out/m0/structure-p1.json` for the decision doc.
 */

const outDir = fileURLToPath(new URL('../../../out/m0/', import.meta.url));

interface Walked {
  page: PageData;
  ops: RawOp[];
  map: Map<number, string[]>;
  nodes: Map<number, StructNode[]>;
}

async function walkFirstPage(bytes: Uint8Array): Promise<Walked> {
  const page = await loadPage(await openDocument(bytes), 0);
  try {
    return { page, ops: walkPage(page), map: joinStructure(page), nodes: mcidAncestors(page) };
  } finally {
    await releasePage(page);
  }
}

describe('structure join on original.pdf page 1', () => {
  const bytes = fixture('original.pdf');

  it.skipIf(bytes === null)('every MCID of a glyph is in the map, and the glyphs sit under exactly 4 LI nodes', async () => {
    const { ops, map, nodes } = await walkFirstPage(bytes!);
    const glyphs = ops.filter((op) => op.kind === 'glyph');
    expect(glyphs.length).toBeGreaterThan(0);

    // Glyphs outside marked content (mcid null) are untagged text; every MCID the glyphs do carry must be known.
    const tagged = glyphs.filter((op): op is RawOp & { mcid: number } => op.mcid !== null);
    expect(tagged.length).toBeGreaterThan(0);
    const missing = tagged.filter((op) => !map.has(op.mcid));
    expect(missing.map((op) => op.glyph!.u)).toEqual([]);
    // pdf.js' own `Root` label is not in the paths: they start at the document element.
    for (const path of map.values()) expect(path[0]).toBe('Document');

    // Count the distinct LI nodes (by identity, not by role name) above any glyph; the slide has 4 bullets.
    const listItems = new Set<StructNode>();
    for (const op of tagged) for (const node of nodes.get(op.mcid)!) if (node.role === 'LI') listItems.add(node);
    expect(listItems.size).toBe(4);

    // The role paths are the roles of those nodes.
    for (const op of tagged) {
      expect(map.get(op.mcid)).toEqual(nodes.get(op.mcid)!.map((node) => node.role));
    }

    // Numbers for the decision doc: distinct role paths and how many glyphs each carries.
    const counts = new Map<string, number>();
    for (const op of tagged) {
      const key = map.get(op.mcid)!.join('/');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const paths = [...counts].map(([path, glyphCount]) => ({ path, glyphs: glyphCount }));
    console.log(`structure paths on original.pdf p1 (${glyphs.length} glyphs, ${map.size} MCIDs):`);
    for (const { path, glyphs: n } of paths) console.log(`  ${String(n).padStart(4)}  ${path}`);

    // Both directions: MCIDs an op carries that the tree lacks, and MCIDs the tree names that no op carries.
    const opMcids = new Set(ops.flatMap((op) => (op.mcid === null ? [] : [op.mcid])));
    const unmappedOpMcids = [...opMcids].filter((id) => !map.has(id));
    const treeOnlyMcids = [...map.keys()].filter((id) => !opMcids.has(id));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(
      `${outDir}structure-p1.json`,
      JSON.stringify(
        {
          file: 'original.pdf',
          page: 1,
          glyphs: glyphs.length,
          untaggedGlyphs: glyphs.length - tagged.length,
          mcids: map.size,
          liNodes: listItems.size,
          paths,
          unmappedOpMcids,
          treeOnlyMcids,
        },
        null,
        2,
      ) + '\n',
      'utf8',
    );

    // The decision doc (docs/decisions/0001-m0-engine-gate.md, M0-4) quotes 0 untagged glyphs on this page: pin it.
    // Checked after the evidence file is written, so a failure still leaves the observed count in it.
    expect(glyphs.length - tagged.length).toBe(0);
  });
});

describe('provenance.struct on the committed probe', () => {
  const read = (name: string) => new Uint8Array(readFileSync(`${repoRoot}corpus/generated/${name}`));

  it('a tagged page gives provenance.struct', async () => {
    const tagged = await buildDeck(read('probe_std.pdf'), { pages: [0] });
    const doc = await openDocument(read('probe_std.pdf'));
    let map = new Map<number, string[]>();
    try {
      const page = await loadPage(doc, 0);
      map = joinStructure(page);
      await releasePage(page);
    } finally {
      await closeDocument(doc);
    }
    const elements = tagged.slides[0]!.elements;
    const text = elements.filter((e) => e.kind === 'textline');
    expect(text.length).toBeGreaterThan(0);
    // Every element with an MCID the tree knows has its role path, every other one none.
    for (const el of elements) {
      const { mcid, struct } = el.provenance;
      expect(struct, el.id).toEqual(mcid === null ? null : (map.get(mcid) ?? null));
    }
    // PowerPoint tags the text of this slide: every text line has a role path, the bullets' under a list item, and the
    // pictures and shapes PowerPoint calls figures under a Figure.
    for (const el of text) expect(el.provenance.struct, el.id).not.toBeNull();
    expect(text.some((el) => el.provenance.struct!.includes('LI'))).toBe(true);
    expect(elements.some((el) => el.kind !== 'textline' && el.provenance.struct?.includes('Figure'))).toBe(true);

    // The same page without its structure tree has none.
    const untagged = await buildDeck(read('probe_notags.pdf'), { pages: [0] });
    expect(untagged.slides[0]!.elements.some((e) => e.kind === 'textline')).toBe(true);
    expect(untagged.slides[0]!.elements.every((e) => e.provenance.struct === null)).toBe(true);
  });
});

describe('structure join on orig_notags.pdf page 1', () => {
  const bytes = fixture('orig_notags.pdf');

  it.skipIf(bytes === null)('gives empty maps and does not throw', async () => {
    const { page, ops, map, nodes } = await walkFirstPage(bytes!);
    expect(page.structTree).toBeNull();
    expect(ops.some((op) => op.kind === 'glyph')).toBe(true);
    expect(map.size).toBe(0);
    expect(nodes.size).toBe(0);
  });
});
