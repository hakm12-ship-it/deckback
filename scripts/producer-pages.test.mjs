// The Skia producer pages (harness/producers/pages) are printed to PDF by harness/producers/make_skia.mjs
// (`npm run producers:skia`). They use system fonts and no network, so each page is one self-contained file; the maker
// refuses any other request (harness/producers/requests.mjs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { allowedRequest } from '../harness/producers/requests.mjs';

const PAGES = ['gradients', 'transparency', 'clips', 'text', 'patterns', 'images'];
const pageFile = (name) => new URL(`../harness/producers/pages/${name}.html`, import.meta.url);
const read = (name) => readFileSync(fileURLToPath(pageFile(name)), 'utf8');

/**
 * Every address a page (HTML and its CSS) names: src and href attributes, url(), the strings of @import and of
 * image-set() (-webkit-image-set too), and each candidate of a srcset. A data: URI may hold commas, but no white space,
 * so srcset candidates are split at a comma followed by white space (or ending the list), not at every comma.
 */
function addressesOf(html) {
  const srcset = [...html.matchAll(/\bsrcset\s*=\s*["']([^"']*)["']/gi)].flatMap((m) =>
    m[1]
      .split(/,(?:\s+|$)/)
      .map((candidate) => candidate.trim().split(/\s+/)[0])
      .filter((url) => url !== undefined && url !== ''),
  );
  const imageSet = [...html.matchAll(/image-set\(((?:[^()]|\([^()]*\))*)\)/gi)].flatMap((m) =>
    [...m[1].matchAll(/["']([^"']*)["']/g)].map((s) => s[1]),
  );
  return [
    ...[...html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)].map((m) => m[1]),
    ...[...html.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/gi)].map((m) => m[1]),
    ...[...html.matchAll(/@import\s+["']([^"']*)["']/gi)].map((m) => m[1]),
    ...srcset,
    ...imageSet,
  ];
}

test('the six producer pages exist', () => {
  for (const name of PAGES) {
    assert.ok(read(name).length > 0, `${name}.html is empty`);
  }
});

test('no producer page names a network address', () => {
  for (const name of PAGES) {
    assert.doesNotMatch(read(name), /https?:\/\//i, `${name}.html contains http:// or https://`);
  }
});

test('every src, href, url(), @import, srcset and image-set() in a producer page is a data URI or a fragment', () => {
  for (const name of PAGES) {
    for (const ref of addressesOf(read(name))) {
      assert.match(ref, /^(?:data:|#)/, `${name}.html refers to ${ref.slice(0, 40)}`);
    }
  }
});

test('the address check finds what @import, srcset and image-set() name', () => {
  const html = [
    '<style>@import "a.css"; @import url(b.css); .x { background: image-set("c.png" 1x, url(d.png) 2x); }',
    '.y { background: -webkit-image-set(\'e.png\' 1x); }</style>',
    '<img srcset="data:image/png;base64,AAAA 1x, f.png 2x" src="#g">',
    '<img srcset="//h.example/i.png">',
  ].join('\n');
  assert.deepEqual(addressesOf(html).sort(), [
    '#g',
    '//h.example/i.png',
    'a.css',
    'b.css',
    'c.png',
    'd.png',
    'data:image/png;base64,AAAA',
    'e.png',
    'f.png',
  ]);
});

test('make_skia.mjs lets a page load data:, about: and file: of this machine only', () => {
  // Every committed page's own URL, as make_skia.mjs opens it, is allowed: the pages still render.
  for (const name of PAGES) {
    const own = pathToFileURL(fileURLToPath(pageFile(name))).href;
    assert.equal(allowedRequest(own), true, `${name}.html`);
  }
  const page = pathToFileURL(fileURLToPath(pageFile('text'))).href;
  for (const url of [page, 'file:///C:/fonts/x.woff', 'file://localhost/C:/x.css', 'data:image/png;base64,AAAA', 'about:blank']) {
    assert.equal(allowedRequest(url), true, url);
  }
  // A file: URL with a host goes over the network (SMB): so does a protocol-relative //host/... in a file: page.
  const unc = new URL('//fileserver/share/x.css', page).href;
  assert.equal(unc, 'file://fileserver/share/x.css');
  for (const url of [unc, 'file://192.168.0.1/c$/x', 'http://example.com/', 'https://example.com/', 'ws://x/', 'not a url']) {
    assert.equal(allowedRequest(url), false, url);
  }
  // UNC paths that parse to an empty host: a path starting with //, a backslash, an encoded \ or / (any case).
  const fourSlashes = new URL('////fileserver/share/x.css', page).href;
  assert.equal(fourSlashes, 'file:////fileserver/share/x.css');
  assert.equal(new URL(fourSlashes).host, '');
  const backslashes = `file:///${'\\'.repeat(2)}fileserver${'\\'}x.css`;
  const uncLike = [
    fourSlashes,
    'file:////fileserver/share/x.css',
    'file://///fileserver/share/x.css',
    'file:///%5C%5Cfileserver/share/x.css',
    'file:///%5c%5cfileserver/share/x.css',
    'file:///%2F%2Ffileserver/share/x.css',
    'file:///%2f%2ffileserver/share/x.css',
    'file://localhost//fileserver/share/x.css',
    backslashes,
    // A backslash anywhere: the parser turns it into /, so the request is refused as it is sent.
    `file:///C:/pages${'\\'}x.css`,
  ];
  for (const url of uncLike) {
    assert.equal(allowedRequest(url), false, url);
  }
});

test('npm run producers:skia runs the maker', () => {
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(pkg.scripts['producers:skia'], 'node harness/producers/make_skia.mjs');
});
