import { describe, expect, it } from 'vitest';
import { esc, textNode } from '../src/xml';

/** Every code point XML 1.0 refuses outside the surrogates (its `Char` production): C0 controls but tab, LF and CR. */
const DROPPED: number[] = [
  ...Array.from({ length: 0x09 }, (_, i) => i), // U+0000–U+0008
  0x0b,
  0x0c,
  ...Array.from({ length: 0x20 - 0x0e }, (_, i) => 0x0e + i), // U+000E–U+001F
  0xfffe,
  0xffff,
];

describe('esc', () => {
  it('escapes & < > " and \'', () => {
    expect(esc(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
    expect(esc('&amp;')).toBe('&amp;amp;');
    expect(esc('plain text')).toBe('plain text');
  });
});

describe('textNode', () => {
  it('drops U+0000–U+0008, U+000B, U+000C, U+000E–U+001F, U+FFFE and U+FFFF', () => {
    expect(DROPPED).toHaveLength(9 + 2 + 18 + 2);
    for (const cp of DROPPED) expect(textNode(`a${String.fromCharCode(cp)}b`), cp.toString(16)).toBe('ab');
    expect(textNode(DROPPED.map((cp) => String.fromCharCode(cp)).join(''))).toBe('');
  });

  it('drops lone surrogates, high or low, at either end or reversed', () => {
    for (const lone of ['\uD800', '\uDBFF', '\uDC00', '\uDFFF', '\uD83D', '\uDE00']) {
      expect(textNode(`a${lone}b`)).toBe('ab');
      expect(textNode(lone)).toBe('');
    }
    expect(textNode('x\uDE00\uD83Dy')).toBe('xy'); // a low then a high is not a pair
    expect(textNode('\uD83D😀')).toBe('😀'); // the second high pairs, the first is alone
  });

  it('keeps tab, LF and the characters at the edges of the dropped ranges', () => {
    expect(textNode('a\tb\nc')).toBe('a\tb\nc');
    expect(textNode(' ퟿�')).toBe(' ퟿�');
  });

  it('keeps every valid astral pair', () => {
    let all = '';
    for (let cp = 0x10000; cp <= 0x10ffff; cp += 0x400) {
      const block: number[] = [];
      for (let i = 0; i < 0x400; i++) block.push(cp + i);
      all += String.fromCodePoint(...block);
    }
    expect(all.length).toBe(2 * 0x100000);
    expect(textNode(all) === all).toBe(true);
  });

  it('escapes what it keeps', () => {
    expect(textNode('<\u0001&\uD800>')).toBe('&lt;&amp;&gt;');
  });
});
