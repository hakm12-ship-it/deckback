import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from './sw-manifest.ts';

export type { Manifest } from './sw-manifest.ts';

interface ChunkLike {
  type: 'chunk';
  fileName: string;
  imports: readonly string[];
  isEntry?: boolean;
  facadeModuleId?: string | null;
  viteMetadata?: { importedCss?: ReadonlySet<string> };
}
interface AssetLike {
  type: 'asset';
  fileName: string;
  source: string | Uint8Array;
}
/** The part of Rollup's `OutputBundle` this reads. */
export type BundleLike = Record<string, ChunkLike | AssetLike>;

export const SERVICE_WORKER_FILE = 'sw.js';

/**
 * A hash of every file under `publicDir` (names and contents, in name order), `_headers` and the other Pages control
 * files included. They are not precached, but the cached page carries the headers it was installed with, so a deploy
 * that changes only `_headers` must still change `sw.js`, or returning visitors keep the old CSP. '' if there is no directory.
 */
export function hashPublicFiles(publicDir: string): string {
  if (publicDir === '' || !existsSync(publicDir)) return '';
  const hash = createHash('sha256');
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.isDirectory()) walk(join(dir, entry.name), `${prefix}${entry.name}/`);
      else hash.update(JSON.stringify(`${prefix}${entry.name}`)).update('\0').update(readFileSync(join(dir, entry.name))).update('\0');
    }
  };
  walk(publicDir, '');
  return hash.digest('hex');
}

/** `publicHash` is `hashPublicFiles` of the public directory: the contents of those files are part of the build id. */
export function precacheManifest(bundle: BundleLike, publicFiles: readonly string[], base = '/', publicHash = ''): Manifest {
  const url = (file: string): string => `${base}${file}`;
  const html = bundle['index.html'];
  const entry = Object.values(bundle).find((o): o is ChunkLike => o.type === 'chunk' && o.isEntry === true && (o.facadeModuleId ?? '').endsWith('/index.html'));
  if (html === undefined || html.type !== 'asset' || entry === undefined) throw new Error('precacheManifest: no index.html and its entry chunk in the bundle');

  // the entry chunk, its static imports (depth first, in order) and the styles of those
  const page: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const found = bundle[name];
    if (found?.type !== 'chunk') return;
    page.push(name);
    for (const next of found.imports) visit(next);
    for (const css of found.viteMetadata?.importedCss ?? []) {
      if (!seen.has(css)) page.push(css);
      seen.add(css);
    }
  };
  visit(entry.fileName);

  const later = Object.keys(bundle)
    .filter((name) => !seen.has(name) && name !== 'index.html' && name !== SERVICE_WORKER_FILE && !name.endsWith('.map') && !name.startsWith('pdfjs/') && !name.startsWith('.vite/'))
    .sort();

  const id = createHash('sha256')
    .update(JSON.stringify([page, later, publicFiles, publicHash, typeof html.source === 'string' ? html.source : Buffer.from(html.source).toString('latin1')]))
    .digest('hex')
    .slice(0, 12);
  return { id, page: [base, ...page.map(url), ...publicFiles.map(url)], later: later.map(url) };
}
