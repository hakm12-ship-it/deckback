import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

/**
 * A small static server for a build (`dist/`) that does what Cloudflare Pages does for it, so the e2e can measure and check
 * the site as it is served: the rules of its `_headers` file, and brotli or gzip for text. Task 4 runs the same specs
 * against `wrangler pages dev`, the real thing, instead (set E2E_BASE_URL).
 *
 * NOT as Pages: a path that is no file is a 404 here. Pages, with no 404.html in the site, answers it with index.html (200),
 * as for a single-page app; the real thing is what `wrangler pages dev` (M6 Task 4) shows. The service worker does not cache
 * an HTML answer as a character map (sw.ts). Kept the same: `/` is index.html, and a file
 * type Pages does not compress (the character maps are `application/octet-stream`) is sent as it is.
 */

export interface HeaderRule {
  pattern: string;
  headers: [name: string, value: string][];
}

/** Parses a `_headers` file: a line without indent is a path pattern, indented `Name: value` lines are its headers. */
export function parseHeaders(text: string): HeaderRule[] {
  const rules: HeaderRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      rules.push({ pattern: raw.trim(), headers: [] });
      continue;
    }
    const colon = raw.indexOf(':');
    const rule = rules.at(-1);
    if (colon < 0 || rule === undefined) throw new Error(`_headers: cannot read "${raw}"`);
    rule.headers.push([raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()]);
  }
  return rules;
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
const matches = (pattern: string, path: string): boolean => new RegExp('^' + pattern.split('*').map(escapeRegExp).join('.*') + '$').test(path);

/** The headers `path` gets: every matching rule adds its own, and a name given twice is joined with a comma. Names in lower case. */
export function headersFor(rules: readonly HeaderRule[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue;
    for (const [name, value] of rule.headers) {
      const key = name.toLowerCase();
      out[key] = out[key] === undefined ? value : `${out[key]}, ${value}`;
    }
  }
  return out;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
};
const COMPRESSED = /^(text\/|image\/svg|application\/(json|wasm))/;

const safePath = (path: string): string => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path; // a malformed escape is a path that is no file: a 404
  }
};

/** Serves `dir` on `127.0.0.1:port` as Pages does. Resolves when it listens. */
export async function serveDist(dir: string, port: number): Promise<Server> {
  const rules = parseHeaders(readFileSync(join(dir, '_headers'), 'utf8'));
  const cache = new Map<string, Buffer>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = safePath(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(dir, path));
    let body: Buffer;
    try {
      if (!file.startsWith(dir + sep) || path === '/_headers' || !statSync(file).isFile()) throw new Error('not a file');
      body = readFileSync(file);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const headers: Record<string, string | number> = { 'content-type': type, ...headersFor(rules, url.pathname === '/index.html' ? '/' : url.pathname) };
    if (headers['cache-control'] === undefined) headers['cache-control'] = 'public, max-age=0, must-revalidate';
    if (COMPRESSED.test(type)) {
      const accept = String(req.headers['accept-encoding'] ?? '');
      const coding = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
      if (coding !== null) {
        const key = `${coding}:${file}`;
        let packed = cache.get(key);
        if (packed === undefined) {
          packed = coding === 'br' ? brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) : gzipSync(body, { level: 6 });
          cache.set(key, packed);
        }
        body = packed;
        headers['content-encoding'] = coding;
      }
      headers['vary'] = 'Accept-Encoding';
    }
    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}
