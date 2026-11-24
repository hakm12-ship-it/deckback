import { describe, expect, it } from 'vitest';
import type { Counts, Report, SlideReport } from '@deckback/core';
import { APPROXIMATIONS } from '../../../packages/core/src/passes/report';
import { fontMapFor, nothingConverted, pageList, reportView, SUBSTITUTES } from '../src/report-panel';

const ZERO: Counts = { textBoxes: 0, freeforms: 0, rects: 0, lines: 0, pictures: 0, gradients: 0, hotspots: 0, runLinks: 0, fallbacks: 0 };

const slide = (index: number, extra: Partial<SlideReport> = {}): SlideReport => ({
  index,
  class: 'vector',
  scale: null,
  counts: ZERO,
  fallbacks: [],
  fallbacksTruncated: 0,
  approximations: [],
  approximationsTruncated: 0,
  notes: [],
  failed: null,
  ...extra,
});

const approximations = Object.fromEntries(APPROXIMATIONS.map((k) => [k, 0])) as Report['totals']['approximations'];

/**
 * A report of six slides with one of everything the panel says: an encrypted PDF, two image-only pages (one scaled), a
 * page pdf.js could not read, a page past the slide budget with a raster fallback and one written as nothing, the deck
 * cut at its budget, approximations, dropped links, and fonts (a Korean family of two fonts, two Latin ones, a Type 3).
 */
const REPORT: Report = {
  schema: 'deckback.report/1',
  source: { producer: 'Producer', creator: 'Creator', tagged: false, encrypted: true, pageCount: 6 },
  slideSizePt: [960, 540],
  slides: [
    slide(1),
    slide(2, { class: 'image-only' }),
    slide(3, { failed: 'page-unreadable' }),
    slide(4, { class: 'image-only', scale: 0.5 }),
    slide(5, {
      fallbacks: [
        { id: 's5e1', reason: 'blend-mode', raster: { w: 20, h: 10, pxPerPt: 2 } },
        { id: 's5e9', reason: 'too-complex' },
      ],
    }),
    slide(6, { failed: 'deck-too-complex' }),
  ],
  fonts: [
    { key: 'f1', latin: 'Gothic A1', ea: '고딕 A1', embedded: true, type3: false },
    { key: 'f2', latin: 'Gothic A1', ea: '고딕 A1', embedded: true, type3: false },
    { key: 'f3', latin: 'Pretendard', ea: null, embedded: true, type3: false },
    { key: 'f4', latin: 'Arial', ea: null, embedded: false, type3: false },
    { key: 'f5', latin: 'T3', ea: null, embedded: true, type3: true },
  ],
  totals: {
    ...ZERO,
    textBoxes: 340,
    freeforms: 500,
    rects: 300,
    lines: 12,
    pictures: 10,
    fallbacks: 2,
    approximations: { ...approximations, 'clip-approx': 1, 'text-drift-split': 1234 },
    droppedLinks: { url: 1, scheme: 0, slide: 0, page: 2, budget: 0, target: 0 },
  },
  budgets: { slideWeight: 500_000, deckWeight: 20_000_000, exceeded: { slide: [5], deck: true } },
};

/** Arial is installed, nothing else. */
const installed = (family: string): boolean => family === 'Arial';

describe('reportView: the report panel of a fixture report', () => {
  it('in Korean', () => {
    const view = reportView(REPORT, 'ko', installed);
    expect(view.stats).toEqual([
      { label: '슬라이드', value: '6' },
      { label: '도형', value: '812' },
      { label: '글상자', value: '340' },
      { label: '그림', value: '11' },
    ]);
    expect(view.pictures).toBe('그림 11개 중 10개는 원본 PDF에 있던 것이고, 1개는 변환하며 그린 것이에요.');
    expect(view.notices).toEqual([
      '권한 암호가 걸린 PDF예요. 열리는 그대로 변환했어요.',
      '이 PDF는 이 페이지에서 끝까지 변환하기엔 너무 복잡해요. 6쪽부터는 빈 슬라이드예요.',
      '읽지 못해 빈 슬라이드로 둔 쪽: 3',
      '너무 복잡해서 일부를 그대로 옮기지 못한 쪽: 5',
    ]);
    expect(view.imageOnly).toEqual([
      { page: '2쪽', message: '이 페이지는 그림으로만 된 PDF예요. 2.0에서 지원 예정' },
      { page: '4쪽', message: '이 페이지는 그림으로만 된 PDF예요. 2.0에서 지원 예정' },
    ]);
    expect(view.approximations).toEqual([
      { label: '잘라 내기를 비슷하게 맞춘 곳', count: '1' },
      { label: '글자 간격이 어긋나 글상자를 나눈 곳', count: '1,234' },
      { label: 'PowerPoint에 없는 효과라 그림으로 그린 곳', count: '1' },
      { label: '옮기지 못하고 뺀 곳', count: '1' },
      { label: '옮기지 못한 링크', count: '3' },
      { label: '크기가 달라 슬라이드에 맞춘 쪽', count: '1' },
    ]);
    expect(view.fonts.map((f) => [f.family, f.other, f.status, f.substitutes.map((s) => s.label)])).toEqual([
      ['고딕 A1', 'Gothic A1', '없음 (추정)', ['맑은 고딕', 'Arial', 'Noto Sans KR', 'Pretendard', 'Calibri']],
      ['Pretendard', null, '없음 (추정)', ['맑은 고딕', 'Arial', 'Noto Sans KR', 'Calibri']],
      ['Arial', null, '설치됨 (추정)', []],
    ]);
  });

  it('in English', () => {
    const view = reportView(REPORT, 'en', installed);
    expect(view.stats.map((s) => `${s.label} ${s.value}`)).toEqual(['Slides 6', 'Shapes 812', 'Text boxes 340', 'Pictures 11']);
    expect(view.pictures).toBe('10 of 11 pictures are the PDF’s own; the rest (1) were drawn during conversion.');
    expect(view.notices[1]).toBe('This PDF is too complex to convert in full on this page. Slides from page 6 on are blank.');
    expect(view.imageOnly[0]).toEqual({ page: 'Page 2', message: 'This page is an image-only PDF; support is planned for 2.0' });
    expect(view.approximations[1]).toEqual({ label: 'Text boxes split where letter spacing drifted', count: '1,234' });
    expect(view.fonts[0]!.status).toBe('Not installed (likely)');
  });

  it('a plain deck: all pictures the PDF\'s own, nothing approximated, no notices', () => {
    const plain: Report = {
      ...REPORT,
      source: { ...REPORT.source, encrypted: false },
      slides: [slide(1), slide(2)],
      totals: { ...ZERO, pictures: 3, approximations, droppedLinks: { url: 0, scheme: 0, slide: 0, page: 0, budget: 0, target: 0 } },
      budgets: { ...REPORT.budgets, exceeded: { slide: [], deck: false } },
    };
    const view = reportView(plain, 'ko', installed);
    expect(view.pictures).toBe('그림은 모두 원본 PDF에 있던 것이에요.');
    expect(view.notices).toEqual([]);
    expect(view.imageOnly).toEqual([]);
    expect(view.approximations).toEqual([]);
    expect(reportView({ ...plain, totals: { ...plain.totals, pictures: 0 } }, 'ko', installed).pictures).toBeNull();
  });

  it('a font the browser cannot check is unknown, and offers no dropdown', () => {
    const view = reportView(REPORT, 'ko', () => null);
    expect(view.fonts.map((f) => [f.status, f.substitutes.length])).toEqual([['알 수 없음', 0], ['알 수 없음', 0], ['알 수 없음', 0]]);
  });

  it('shows the family a font was written as (`mappedTo`)', () => {
    const mapped: Report = { ...REPORT, fonts: REPORT.fonts.map((f) => (f.latin === 'Pretendard' ? { ...f, mappedTo: 'Arial' } : f)) };
    expect(reportView(mapped, 'ko', installed).fonts[1]!.mapped).toBe('Arial');
    expect(reportView(REPORT, 'ko', installed).fonts[1]!.mapped).toBeNull();
  });
});

describe('fontMapFor', () => {
  const rows = reportView(REPORT, 'ko', installed).fonts;

  it('maps every Latin and Korean name of a family to the substitute\'s', () => {
    expect(fontMapFor(rows, new Map([['고딕 A1', '맑은 고딕'], ['Pretendard', 'Arial']]))).toEqual({
      'Gothic A1': 'Malgun Gothic',
      '고딕 A1': '맑은 고딕',
      Pretendard: 'Arial',
    });
  });

  it('is empty with nothing chosen, or "keep as is", or a label it does not offer', () => {
    expect(fontMapFor(rows, new Map())).toEqual({});
    expect(fontMapFor(rows, new Map([['고딕 A1', ''], ['Pretendard', 'Comic Sans']]))).toEqual({});
  });

  it('keys the map by the written family, which differs from latin for a PostScript-named font (M6 Task 3)', () => {
    const report: Report = {
      ...REPORT,
      fonts: [{ key: 'f1', latin: 'MalgunGothic', ea: null, embedded: false, type3: false, written: { latin: 'Malgun Gothic', ea: 'Malgun Gothic' } }],
    };
    const view = reportView(report, 'en', () => false);
    expect(view.fonts.map((r) => r.family)).toEqual(['Malgun Gothic']);
    expect(fontMapFor(view.fonts, new Map([['Malgun Gothic', 'Arial']]))).toEqual({ 'Malgun Gothic': 'Arial' });
  });

  it('offers the brief\'s five families', () => {
    expect(SUBSTITUTES.map((s) => s.label)).toEqual(['맑은 고딕', 'Arial', 'Noto Sans KR', 'Pretendard', 'Calibri']);
  });
});

describe('pageList', () => {
  it('lists pages in runs', () => {
    expect(pageList('ko', [8, 1, 2, 3, 5, 7, 3])).toBe('1–3, 5, 7–8');
    expect(pageList('en', [1200])).toBe('1,200');
  });

  it('shows ten runs, then how many pages more', () => {
    const odd = Array.from({ length: 15 }, (_, i) => 2 * i + 1);
    expect(pageList('ko', odd)).toBe('1, 3, 5, 7, 9, 11, 13, 15, 17, 19 외 5쪽');
    expect(pageList('en', odd)).toBe('1, 3, 5, 7, 9, 11, 13, 15, 17, 19 and 5 more');
  });
});

describe('nothingConverted', () => {
  it('is true when every slide is blank or there are none (a damaged file pdf.js opened)', () => {
    expect(nothingConverted({ ...REPORT, slides: [slide(1, { failed: 'page-unreadable' }), slide(2, { failed: 'page-unreadable' })] })).toBe(true);
    expect(nothingConverted({ ...REPORT, slides: [] })).toBe(true);
    expect(nothingConverted(REPORT)).toBe(false);
  });
});
