import { describe, expect, it } from 'vitest';
import { APPROXIMATIONS } from '../../../packages/core/src/passes/report';
import { initialLang, LANGS, MESSAGES, t, type Key } from '../src/i18n';

const placeholders = (message: string): string[] => [...message.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe('i18n: every word in Korean and English', () => {
  it('both languages have exactly the same keys', () => {
    expect(Object.keys(MESSAGES.en).sort()).toEqual(Object.keys(MESSAGES.ko).sort());
  });

  it('no message is empty, and a key has the same {placeholders} in both', () => {
    for (const key of Object.keys(MESSAGES.ko) as Key[]) {
      for (const lang of LANGS) expect(MESSAGES[lang][key].trim(), `${lang} ${key}`).not.toBe('');
      expect(placeholders(MESSAGES.en[key]), key).toEqual(placeholders(MESSAGES.ko[key]));
    }
  });

  it('every approximation kind the report counts has plain words', () => {
    for (const kind of APPROXIMATIONS) {
      for (const lang of LANGS) expect(MESSAGES[lang][`approx.${kind}`], `${lang} ${kind}`).toBeTruthy();
    }
  });

  it('has the spec\'s words verbatim (spec §3; the brief)', () => {
    expect(t('ko', 'progress.slides', { done: 12, total: 24 })).toBe('슬라이드 12/24 변환 중');
    expect(t('en', 'progress.slides', { done: 12, total: 24 })).toBe('Converting slide 12 of 24');
    expect(t('ko', 'report.imageOnly.message')).toBe('이 페이지는 그림으로만 된 PDF예요. 2.0에서 지원 예정');
    expect(t('en', 'report.imageOnly.message')).toBe('This page is an image-only PDF; support is planned for 2.0');
  });

  it('an error is fixed words for each kind, in both languages, each kind its own', () => {
    const kinds = ['password', 'not-pdf', 'damaged', 'too-complex', 'failed'] as const;
    for (const kind of kinds) {
      expect(MESSAGES.ko[`error.${kind}`]).toMatch(/[가-힣]/);
      expect(MESSAGES.en[`error.${kind}`]).toMatch(/^[\x20-\x7e’]+$/);
    }
    expect(new Set(kinds.map((k) => MESSAGES.ko[`error.${k}`])).size).toBe(kinds.length);
    expect(new Set(kinds.map((k) => MESSAGES.en[`error.${k}`])).size).toBe(kinds.length);
  });

  it('t leaves a placeholder it is not given as it is', () => {
    expect(t('en', 'progress.slides', { done: 1 })).toBe('Converting slide 1 of {total}');
  });
});

describe('initialLang', () => {
  it('keeps the language chosen before', () => {
    expect(initialLang('en', ['ko-KR'])).toBe('en');
    expect(initialLang('ko', ['en-US'])).toBe('ko');
  });

  it('else follows the browser: Korean for ko, English for anything else', () => {
    expect(initialLang(null, ['ko-KR', 'en'])).toBe('ko');
    expect(initialLang(null, ['ko'])).toBe('ko');
    expect(initialLang(null, ['en-GB'])).toBe('en');
    expect(initialLang(null, ['ja-JP', 'ko-KR'])).toBe('en');
    expect(initialLang('fr', [])).toBe('en');
  });
});
