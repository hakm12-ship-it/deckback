// Runs the core walker on a page of a PDF and writes every shading RawOp (with its clip bbox in the
// slide frame) and every glyph RawOp to a JSON file.
//
//   node scripts/dump-shading.mjs [pdf] [page] [out.json]
//   default: corpus/private/probe/original.pdf  2  out/m0/shadings-p2.json
//
// The core is TypeScript with extensionless imports, which Node cannot load directly, so it is loaded
// through a Vite dev server in SSR mode (Vite is already installed for Vitest). Dependencies such as
// pdfjs-dist stay external and are loaded by Node itself.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pdfPath = resolve(repo, process.argv[2] ?? 'corpus/private/probe/original.pdf');
const pageNumber = Number(process.argv[3] ?? 2);
const outPath = resolve(repo, process.argv[4] ?? 'out/m0/shadings-p2.json');
const round3 = (n) => Math.round(n * 1000) / 1000;

const server = await createServer({
  root: repo,
  configFile: false,
  appType: 'custom',
  logLevel: 'error',
  server: { middlewareMode: true, hmr: false, watch: null },
});
try {
  const adapter = await server.ssrLoadModule('/packages/core/src/engine/pdfjs-adapter.ts');
  const walker = await server.ssrLoadModule('/packages/core/src/extract/walker.ts');
  const doc = await adapter.openDocument(new Uint8Array(readFileSync(pdfPath)));
  try {
    const page = await adapter.loadPage(doc, pageNumber - 1);
    let ops;
    let size;
    try {
      size = walker.pageFrame(page).size;
      ops = walker.walkPage(page);
    } finally {
      await adapter.releasePage(page);
    }
    const box = (b) => b.map(round3);
    const shadings = ops
      .filter((op) => op.kind === 'shade')
      .map((op) => ({
        opIndex: op.opIndex,
        bbox: box(op.bbox),
        alpha: op.alpha,
        shading: op.shading ?? null,
      }));
    const glyphs = ops
      .filter((op) => op.kind === 'glyph')
      .map((op) => ({ opIndex: op.opIndex, u: op.glyph.u, x: round3(op.glyph.x), y: round3(op.glyph.y), size: round3(op.glyph.size), bbox: box(op.bbox) }));
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify({ page: pageNumber, size, shadings, glyphs }, null, 2)}\n`, 'utf8');
    console.log(`page ${pageNumber}: ${shadings.length} shading(s), ${glyphs.length} glyph(s) -> ${outPath}`);
  } finally {
    await adapter.closeDocument(doc);
  }
} finally {
  await server.close();
}
