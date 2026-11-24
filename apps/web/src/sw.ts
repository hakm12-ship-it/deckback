/// <reference lib="webworker" />
import type { Manifest } from './sw-manifest';

/**
 * The service worker (spec §3, offline): after one visit the page opens and converts with the network off.
 *
 * Its precache list is made at build time from the bundle (precache.ts, vite.config.ts) and put in place of
 * `__DECKBACK_MANIFEST__`. The page's own files are cached when it installs; the conversion worker and pdf.js (about
 * 2 MB) when the page asks, once it is idle (offline.ts), so they are not part of the first load. Those files are served
 * cache-first. pdf.js' character maps are cached when they are first asked for. Nothing else is touched: no other
 * request is intercepted, and nothing is ever sent anywhere from here but a fetch of the site's own files.
 *
 * The cache is named by the build, and the other builds' caches are deleted when this one activates. It does not skip
 * waiting: a page already open keeps the build it was loaded with (and its lazily loaded files) until it is closed.
 */

declare const self: ServiceWorkerGlobalScope;
declare const __DECKBACK_MANIFEST__: Manifest;

const manifest = __DECKBACK_MANIFEST__;
const PREFIX = 'deckback-';
const CACHE = `${PREFIX}${manifest.id}`;
const CMAPS = 'pdfjs/cmaps/';

const absolute = (path: string): string => new URL(path, self.registration.scope).href;
/** A request as cached: its address without the query or fragment. */
const keyOf = (url: string): string => {
  const parsed = new URL(url);
  return parsed.origin + parsed.pathname;
};

/**
 * Fetches `urls` that are not cached yet. With the browser's cache mode as it is, a file the page has just loaded is not
 * downloaded again: the install runs at load, before the page is idle (a first-load byte count that includes it, e2e).
 */
async function add(urls: readonly string[]): Promise<void> {
  const cache = await caches.open(CACHE);
  for (const url of urls) {
    if ((await cache.match(url)) !== undefined) continue;
    const response = await fetch(url); // the browser's own cache first: the page was just loaded, and its files are in it
    if (!response.ok) throw new Error(`precache: ${url} answered ${response.status}`);
    await cache.put(url, response);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(add(manifest.page.map(absolute)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith(PREFIX) && name !== CACHE) await caches.delete(name);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'warm') event.waitUntil(add(manifest.later.map(absolute)).catch(() => undefined)); // offline now: next visit
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  const page = absolute(manifest.page[0]!);
  const isCmap = url.pathname.startsWith(new URL(CMAPS, self.registration.scope).pathname);
  const wanted = request.mode === 'navigate' ? page : keyOf(request.url);
  if (request.mode === 'navigate' && keyOf(request.url) !== keyOf(page)) return; // another address (the e2e's test page): the network

  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(wanted);
      if (hit !== undefined) return hit;
      const response = await fetch(request);
      // only a character map that really is one (a host that answers a missing file with its index page must not be cached as one),
      // and a full cache is no reason to fail a request the network answered
      if (isCmap && response.ok && !/html/i.test(response.headers.get('content-type') ?? '')) {
        event.waitUntil(cache.put(wanted, response.clone()).catch(() => undefined));
      }
      return response;
    })(),
  );
});
