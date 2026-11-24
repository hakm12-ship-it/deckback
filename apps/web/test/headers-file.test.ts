import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { headersFor, parseHeaders } from '../e2e/pages-server';

describe('Cloudflare Pages _headers, as the e2e server reads it', () => {
  const rules = parseHeaders(['# a comment', '/*', '  X-A: one', '  X-B:two', '', '/assets/*', '  Cache-Control: immutable', '  X-A: two', '/sw.js', '  Cache-Control: no-cache'].join('\n'));

  it('reads patterns and their headers', () => {
    expect(rules).toEqual([
      { pattern: '/*', headers: [['X-A', 'one'], ['X-B', 'two']] },
      { pattern: '/assets/*', headers: [['Cache-Control', 'immutable'], ['X-A', 'two']] },
      { pattern: '/sw.js', headers: [['Cache-Control', 'no-cache']] },
    ]);
  });

  it('every rule that matches adds its headers; the same name is joined with a comma', () => {
    expect(headersFor(rules, '/')).toEqual({ 'x-a': 'one', 'x-b': 'two' });
    expect(headersFor(rules, '/assets/a.js')).toEqual({ 'x-a': 'one, two', 'x-b': 'two', 'cache-control': 'immutable' });
    expect(headersFor(rules, '/sw.js')).toEqual({ 'x-a': 'one', 'x-b': 'two', 'cache-control': 'no-cache' });
  });

  it('the shipped file parses, and sends no inline-script, eval or outside host to anything', () => {
    const shipped = parseHeaders(readFileSync(new URL('../public/_headers', import.meta.url), 'utf8'));
    const all = headersFor(shipped, '/');
    expect(all['x-robots-tag']).toBe('noindex');
    expect(all['referrer-policy']).toBe('no-referrer');
    expect(all['x-content-type-options']).toBe('nosniff');
    expect(all['permissions-policy']).toMatch(/camera=\(\)/);
    const csp = all['content-security-policy']!;
    expect(csp.replace("'wasm-unsafe-eval'", '')).not.toMatch(/unsafe-inline|unsafe-eval|\*|data:|http:/);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("worker-src 'self'");
  });
});
