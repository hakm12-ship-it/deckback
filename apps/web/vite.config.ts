import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { hashPublicFiles, precacheManifest, SERVICE_WORKER_FILE, type BundleLike } from './src/precache.ts';
import { CMAPS_PATH } from './src/protocol.ts';

/** pdf.js' `cmaps/` directory, found from @deckback/core, the package that depends on pdfjs-dist. */
const fromCore = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const cmapsDir = join(dirname(fromCore.resolve('pdfjs-dist/package.json')), 'cmaps');

/**
 * Serves pdf.js' character maps at `/${CMAPS_PATH}` as static files (copied into the build), so pdf.js fetches one
 * only when a document needs it. Nothing else of pdfjs-dist (standard_fonts, wasm decoders, quickjs) is shipped.
 */
function pdfjsCmaps(): Plugin {
  return {
    name: 'deckback:pdfjs-cmaps',
    configureServer(server) {
      server.middlewares.use(`/${CMAPS_PATH}`, (req, res) => {
        const name = (req.url ?? '').slice(1).split('?')[0]!;
        const file = join(cmapsDir, name);
        if (!/^[\w.-]+\.bcmap$/.test(name) || !existsSync(file)) {
          res.statusCode = 404; // not the SPA fallback: pdf.js must see a failed fetch, not HTML
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const name of readdirSync(cmapsDir)) {
        this.emitFile({ type: 'asset', fileName: `${CMAPS_PATH}${name}`, source: readFileSync(join(cmapsDir, name)) });
      }
    },
  };
}

/**
 * The core adapter's default (Node) environment imports pdf.js' legacy build on demand. The worker switches to the
 * browser build before the first document, so in the browser that import is replaced by a module that throws, and no
 * legacy pdf.js chunk is emitted.
 */
function noLegacyPdfjs(): Plugin {
  const stub = '\0deckback:node-only-pdfjs';
  return {
    name: 'deckback:no-legacy-pdfjs',
    enforce: 'pre',
    resolveId: (source) => (source === 'pdfjs-dist/legacy/build/pdf.mjs' ? stub : null),
    load: (id) =>
      id === stub ? 'throw new Error("The legacy pdf.js build is not in the browser bundle: call useBrowserPdfjs() first.");' : null,
  };
}

/** Public files Cloudflare Pages reads itself: they are not part of the site. */
const PAGES_CONTROL_FILES = new Set(['_headers', '_redirects', '_routes.json']);

/**
 * The service worker (src/sw.ts, built as `/sw.js`) gets its precache list here, from the finished bundle
 * (`precacheManifest`): its code says `__DECKBACK_MANIFEST__`, which becomes the list. It runs after the worker and
 * pdf.js chunks exist, so those are on it. Production builds only.
 */
function deckbackServiceWorker(): Plugin {
  let base = '/';
  let publicDir = '';
  return {
    name: 'deckback:service-worker',
    apply: 'build',
    enforce: 'post',
    configResolved(config) {
      base = config.base;
      publicDir = config.publicDir;
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const sw = bundle[SERVICE_WORKER_FILE];
        if (sw === undefined || sw.type !== 'chunk') throw new Error('The service worker (src/sw.ts) was not built as sw.js');
        const publicFiles = publicDir !== '' && existsSync(publicDir) ? readdirSync(publicDir).filter((f) => !PAGES_CONTROL_FILES.has(f)).sort() : [];
        const manifest = precacheManifest(bundle as unknown as BundleLike, publicFiles, base, hashPublicFiles(publicDir));
        if (!sw.code.includes('__DECKBACK_MANIFEST__')) throw new Error('sw.js has no __DECKBACK_MANIFEST__ to fill');
        sw.code = sw.code.replaceAll('__DECKBACK_MANIFEST__', JSON.stringify(manifest));
      },
    },
  };
}

/**
 * Cloudflare Web Analytics' beacon (page views, no cookies): added to the page only when the build has a
 * `VITE_CF_BEACON_TOKEN` (the author's `.env`, never committed). Without one there is no beacon and no request to it.
 */
function cloudflareBeacon(): Plugin {
  let token = '';
  return {
    name: 'deckback:cf-beacon',
    configResolved(config) {
      token = (process.env.VITE_CF_BEACON_TOKEN ?? loadEnv(config.mode, config.envDir || config.root, 'VITE_').VITE_CF_BEACON_TOKEN ?? '').trim();
      if (token !== '' && !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('VITE_CF_BEACON_TOKEN is not a token (letters, digits, - and _ only)');
    },
    transformIndexHtml: () =>
      token === ''
        ? []
        : [
            {
              tag: 'script',
              attrs: { defer: true, src: 'https://static.cloudflareinsights.com/beacon.min.js', 'data-cf-beacon': JSON.stringify({ token }) },
              injectTo: 'body',
            },
          ],
  };
}

/**
 * The e2e's test page (test.html: the worker's replies as JSON, the whole inventory) is built only when `VITE_E2E=1`, which
 * the e2e's global-setup sets for its own build. The production build has no such entry (ruling M6-R3).
 */
const E2E_BUILD = process.env.VITE_E2E === '1';

// one switch for both: `import.meta.env.VITE_E2E` in the code is this value, never an `.env` file's (final review I1)
export default defineConfig({
  define: { 'import.meta.env.VITE_E2E': JSON.stringify(E2E_BUILD ? '1' : '') },
  plugins: [pdfjsCmaps(), noLegacyPdfjs(), cloudflareBeacon(), deckbackServiceWorker()], // in dev these also serve the worker
  worker: { format: 'es', plugins: () => [noLegacyPdfjs()] }, // the build bundles the worker with these only
  build: {
    manifest: true, // the build's own list of files (dist/.vite/manifest.json), for whoever looks at what it made
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./index.html', import.meta.url)),
        sw: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
        ...(E2E_BUILD ? { test: fileURLToPath(new URL('./test.html', import.meta.url)) } : {}),
      },
      // the service worker must sit at the site root to control the whole site; everything else keeps its hashed name
      output: { entryFileNames: (chunk) => (chunk.name === 'sw' ? SERVICE_WORKER_FILE : 'assets/[name]-[hash].js') },
    },
  },
  preview: { host: '127.0.0.1', port: 4317, strictPort: true },
});
