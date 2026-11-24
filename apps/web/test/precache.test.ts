import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashPublicFiles, precacheManifest, type BundleLike } from '../src/precache';

/** A bundle as Vite's build makes it, reduced to what the precache list reads. */
const chunk = (fileName: string, extra: Record<string, unknown> = {}) => ({ type: 'chunk' as const, fileName, imports: [] as string[], ...extra });
const asset = (fileName: string, source: string | Uint8Array = '') => ({ type: 'asset' as const, fileName, source });

const BUNDLE: BundleLike = {
  'index.html': asset('index.html', '<html>v1</html>'),
  'assets/index-AAA.js': chunk('assets/index-AAA.js', {
    isEntry: true,
    facadeModuleId: '/x/index.html',
    imports: ['assets/shared-BBB.js'],
    viteMetadata: { importedCss: new Set(['assets/index-CCC.css']) },
  }),
  'assets/shared-BBB.js': chunk('assets/shared-BBB.js'),
  'assets/index-CCC.css': asset('assets/index-CCC.css', 'a{}'),
  'sw.js': chunk('sw.js', { isEntry: true, facadeModuleId: '/x/src/sw.ts' }),
  'assets/worker-DDD.js': asset('assets/worker-DDD.js', 'worker'),
  'assets/pdf-EEE.js': chunk('assets/pdf-EEE.js'),
  'assets/pdf.worker-FFF.js': chunk('assets/pdf.worker-FFF.js'),
  'assets/pdf.worker-FFF.js.map': asset('assets/pdf.worker-FFF.js.map'),
  'pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap': asset('pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap'),
  '.vite/manifest.json': asset('.vite/manifest.json', '{}'),
};

describe('precacheManifest', () => {
  const manifest = precacheManifest(BUNDLE, ['favicon.svg']);

  it('the page is the address, the entry chunk with its static imports and styles, and the public files', () => {
    expect(manifest.page).toEqual(['/', '/assets/index-AAA.js', '/assets/shared-BBB.js', '/assets/index-CCC.css', '/favicon.svg']);
  });

  it('the rest of the app (worker, pdf.js) is warmed later; not the service worker, source maps, the build manifest or the character maps', () => {
    expect(manifest.later).toEqual(['/assets/pdf-EEE.js', '/assets/pdf.worker-FFF.js', '/assets/worker-DDD.js']);
  });

  it('the build id changes with a file name or the page, and not with the order of the bundle', () => {
    const reordered = Object.fromEntries(Object.entries(BUNDLE).reverse());
    expect(precacheManifest(reordered, ['favicon.svg']).id).toBe(manifest.id);
    expect(manifest.id).toMatch(/^[0-9a-f]{12}$/);
    const { 'assets/pdf-EEE.js': _gone, ...others } = BUNDLE;
    const renamed = { ...others, 'assets/pdf-ZZZ.js': chunk('assets/pdf-ZZZ.js') };
    expect(precacheManifest(renamed, ['favicon.svg']).id).not.toBe(manifest.id);
    const edited = { ...BUNDLE, 'index.html': asset('index.html', '<html>v2</html>') };
    expect(precacheManifest(edited, ['favicon.svg']).id).not.toBe(manifest.id);
  });

  it('a base other than the root is kept', () => {
    expect(precacheManifest(BUNDLE, ['favicon.svg'], '/deckback/').page[0]).toBe('/deckback/');
  });
});

describe('hashPublicFiles: the public files, _headers included, are in the build id', () => {
  /** A public directory with `files` (name to text), in a temporary folder that `use` may read. */
  const withPublic = <T>(files: Record<string, string>, use: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), 'deckback-public-'));
    try {
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(join(dir, name, '..'), { recursive: true });
        writeFileSync(join(dir, name), text);
      }
      return use(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const idOf = (files: Record<string, string>): string => withPublic(files, (dir) => precacheManifest(BUNDLE, ['favicon.svg'], '/', hashPublicFiles(dir)).id);

  it('two builds that differ only in _headers have different ids', () => {
    const one = idOf({ 'favicon.svg': '<svg/>', _headers: "/*\n  Content-Security-Policy: default-src 'self'\n" });
    const two = idOf({ 'favicon.svg': '<svg/>', _headers: "/*\n  Content-Security-Policy: default-src 'none'\n" });
    expect(two).not.toBe(one);
  });

  it('a changed public file changes the id, and the same files give the same id wherever they are', () => {
    const files = { 'favicon.svg': '<svg/>', _headers: 'a' };
    expect(idOf({ ...files, 'favicon.svg': '<svg id="2"/>' })).not.toBe(idOf(files));
    expect(idOf(files)).toBe(idOf({ _headers: 'a', 'favicon.svg': '<svg/>' }));
  });

  it('a file moving to another name changes the hash even when the bytes stay', () => {
    expect(withPublic({ a: 'x' }, hashPublicFiles)).not.toBe(withPublic({ b: 'x' }, hashPublicFiles));
  });

  it('no public directory is an empty hash', () => {
    expect(hashPublicFiles('')).toBe('');
  });
});
