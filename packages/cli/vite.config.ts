import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

/**
 * `npm run build:cli`: the CLI as one Node ES module, `dist/deckback.mjs`, with a shebang. Everything it needs is inside it:
 * @deckback/core and @deckback/ooxml from their TypeScript source, pdf.js (legacy build, and its parser side) and fflate
 * from node_modules; only Node's own modules are imported at run time. pdf.js' character maps (CJK text needs them)
 * are copied to `dist/cmaps/`. The package therefore has no runtime dependencies (M7 Task 2).
 *
 * The build also writes `LICENSE` (the repository's, Apache-2.0) and `NOTICE` beside package.json: NOTICE lists the
 * third-party packages the bundle really contains, read from the modules Rollup put in it, so it cannot drift.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const repo = join(root, '..', '..');

/** Forward slashes, whatever the platform. */
const slash = (path: string): string => path.split(String.fromCharCode(92)).join('/');

interface Manifest {
  name: string;
  version: string;
  license?: string;
  author?: string | { name?: string };
  homepage?: string;
}

/** The package.json of the node_modules package a module id lies in, or null for the repository's own source. */
function packageOf(id: string): { dir: string; manifest: Manifest } | null {
  const marker = '/node_modules/';
  const at = slash(id).lastIndexOf(marker);
  if (at < 0) return null;
  const path = slash(id);
  const rest = path.slice(at + marker.length).split('/');
  const parts = rest[0]!.startsWith('@') ? 2 : 1;
  const dir = path.slice(0, at + marker.length) + rest.slice(0, parts).join('/');
  return { dir, manifest: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest };
}

/** The copyright line of a package: its LICENSE's own, else its source's header, else its author. */
function copyrightOf(dir: string, manifest: Manifest, bundleModules: string[]): string {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license']) {
    const file = join(dir, name);
    if (!existsSync(file)) continue;
    const line = readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .find((text) => /^\s*Copyright\s*(\(c\)|©)?\s*\d{4}/i.test(text));
    if (line !== undefined) return line.trim();
  }
  for (const id of bundleModules) {
    if (!slash(id).startsWith(`${dir}/`)) continue;
    const head = readFileSync(id, 'utf8').slice(0, 2000).split(/\r?\n/);
    const line = head.find((text) => /Copyright\s+\d{4}/i.test(text));
    if (line !== undefined) return line.replace(/^[\s*/#]+/, '').trim();
  }
  const author = typeof manifest.author === 'string' ? manifest.author : manifest.author?.name;
  return author === undefined ? '(no copyright line in the package)' : `Copyright ${author.replace(/\s*<.*>/, '')}`;
}

function packageFiles(): Plugin {
  return {
    name: 'deckback-package-files',
    apply: 'build',
    generateBundle(_options, bundle) {
      const modules = Object.values(bundle).flatMap((chunk) => (chunk.type === 'chunk' ? Object.keys(chunk.modules) : []));
      const found = new Map<string, { dir: string; manifest: Manifest }>();
      for (const id of modules) {
        const pkg = packageOf(id);
        if (pkg !== null) found.set(pkg.manifest.name, pkg);
      }
      const entries = [...found.values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
      if (entries.length === 0) throw new Error('NOTICE: no third-party package found in the bundle');
      const lines = [
        'deckback',
        'Copyright 2026 the deckback authors',
        '',
        'This product is licensed under the Apache License, Version 2.0 (see LICENSE).',
        '',
        'It bundles the following third-party software, in dist/deckback.mjs and dist/cmaps/:',
        '',
      ];
      for (const { dir, manifest } of entries) {
        lines.push(`${manifest.name} ${manifest.version}`, `  License:   ${manifest.license ?? 'UNKNOWN'}`, `  Copyright: ${copyrightOf(dir, manifest, modules)}`, '');
      }
      // The permission notice of every package that is not Apache-2.0 (MIT and the like require it to travel with the
      // code), in full, from the package's own licence file in node_modules. Apache-2.0 packages: LICENSE covers them.
      for (const { dir, manifest } of entries) {
        if (manifest.license === 'Apache-2.0') continue;
        const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE'].map((name) => join(dir, name)).find((path) => existsSync(path));
        if (file === undefined) throw new Error(`NOTICE: ${manifest.name} (${manifest.license ?? 'UNKNOWN'}) has no licence file to include`);
        lines.push('-'.repeat(72), `Licence text of ${manifest.name} ${manifest.version} (${manifest.license ?? 'UNKNOWN'})`, '-'.repeat(72), '', readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim(), '');
      }
      writeFileSync(join(root, 'NOTICE'), `${lines.join('\n')}`);
      writeFileSync(join(root, 'LICENSE'), readFileSync(join(repo, 'LICENSE')));
    },
    closeBundle() {
      const cmaps = join(dirname(fileURLToPath(import.meta.resolve('pdfjs-dist/package.json'))), 'cmaps');
      cpSync(cmaps, join(root, 'dist', 'cmaps'), { recursive: true });
    },
  };
}

export default defineConfig({
  root,
  // `--version`: the package's version, written into the bundle (src/version.ts)
  define: { __DECKBACK_VERSION__: JSON.stringify((JSON.parse(readFileSync(new URL('package.json', import.meta.url), 'utf8')) as { version: string }).version) },
  ssr: { noExternal: true },
  plugins: [packageFiles()],
  build: {
    ssr: 'src/main.ts',
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'deckback.mjs', codeSplitting: false, banner: '#!/usr/bin/env node' },
    },
  },
});
