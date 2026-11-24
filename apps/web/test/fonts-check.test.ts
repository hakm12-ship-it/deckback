import { describe, expect, it } from 'vitest';
import { cssFamily, fontInstalled, installedChecker, type Measure } from '../src/fonts-check';

/** A browser whose installed families are `installed`: a font list measures as its first family the browser has. */
function browser(installed: Record<string, number>): { measure: Measure; asked: string[] } {
  const generic: Record<string, number> = { monospace: 600, serif: 500, 'sans-serif': 520 };
  const asked: string[] = [];
  const measure: Measure = (font) => {
    asked.push(font);
    const families = font.replace(/^72px /, '').split(/,\s*/);
    for (const family of families) {
      const name = family.startsWith('"') ? JSON.parse(family.replace(/\\(.)/g, '$1').replace(/^"(.*)"$/, '"$1"')) : family;
      if (Object.hasOwn(installed, name)) return installed[name]!;
      if (Object.hasOwn(generic, name)) return generic[name]!;
    }
    return 0;
  };
  return { measure, asked };
}

describe('fontInstalled (a hint from canvas widths)', () => {
  it('a family that measures differently from the generic fallbacks is installed', () => {
    const { measure } = browser({ 'Malgun Gothic': 530, '맑은 고딕': 530 });
    expect(fontInstalled('Malgun Gothic', measure)).toBe(true);
    expect(fontInstalled('맑은 고딕', measure)).toBe(true);
  });

  it('a family the browser lacks measures as the generic family: not installed', () => {
    const { measure } = browser({});
    expect(fontInstalled('Pretendard', measure)).toBe(false);
  });

  it('a family as wide as one generic family is still found through the others', () => {
    const { measure } = browser({ Arial: 600 }); // as wide as monospace, not as serif
    expect(fontInstalled('Arial', measure)).toBe(true);
  });

  it('quotes the family name for CSS, so a name cannot break out of the font list', () => {
    expect(cssFamily('Noto Sans KR')).toBe('"Noto Sans KR"');
    expect(cssFamily('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it('escapes a newline and other control characters, which cannot be in a CSS string', () => {
    expect(cssFamily('a\nb')).toBe('"a\\a b"');
    expect(cssFamily('a\r\fb\0c')).toBe('"a\\d \\c b\\0 c"');
    expect(cssFamily('x\u007fy')).toBe('"x\\7f y"');
    expect(cssFamily('tab\there')).not.toMatch(/[\x00-\x1f]/);
  });
});

describe('installedChecker', () => {
  it('measures each family once', () => {
    const { measure, asked } = browser({ Arial: 540 });
    const check = installedChecker(measure);
    expect(check('Arial')).toBe(true);
    const after = asked.length;
    expect(check('Arial')).toBe(true);
    expect(asked.length).toBe(after);
    expect(check('Nope')).toBe(false);
  });

  it('answers null where nothing can be measured', () => {
    expect(installedChecker(null)('Arial')).toBeNull();
  });
});
