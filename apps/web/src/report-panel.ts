import type { Report, ReportFont } from '@deckback/core';
import { MESSAGES, num, t, type Key, type Lang } from './i18n';

/**
 * The report panel (spec §3): what the conversion made, where it only approximates the PDF, and the fonts the deck
 * needs. `reportView` turns a report into the words and numbers the panel shows, in one language, with nothing of the
 * DOM (test/report-panel.test.ts); `renderReport` builds the panel from it.
 *
 * What a report holds of the user's file (the fonts' names, /Producer) stays in the page: it is shown, never sent or
 * logged (Global Constraints, Privacy). Font names come from the PDF, so they only ever go into `textContent` and
 * attribute values, never into HTML.
 */

/** A substitute font the dropdown offers (spec §7, the web dropdown): `latin` for `a:latin`, `ea` for a Korean name. */
export interface Substitute {
  label: string;
  latin: string;
  ea: string;
}

/** The short fixed list of common families a font that is not installed may be written as instead. */
export const SUBSTITUTES: readonly Substitute[] = [
  { label: '맑은 고딕', latin: 'Malgun Gothic', ea: '맑은 고딕' },
  { label: 'Arial', latin: 'Arial', ea: 'Arial' },
  { label: 'Noto Sans KR', latin: 'Noto Sans KR', ea: 'Noto Sans KR' },
  { label: 'Pretendard', latin: 'Pretendard', ea: 'Pretendard' },
  { label: 'Calibri', latin: 'Calibri', ea: 'Calibri' },
];

/** One family the deck needs: the report's fonts of one name (bold and regular are fonts of one family). */
export interface FontRow {
  /** The family as shown, and the row's key: its Korean name (`a:ea`), else its Latin name. */
  family: string;
  /** Its Latin name, when the Korean name is shown and they differ. */
  other: string | null;
  /** The `a:latin` names of its fonts, and their `a:ea` names where a font has its own: what a font map maps. */
  latin: string[];
  ea: string[];
  /** Whether the family seems installed (fonts-check.ts): a hint; null where the browser cannot tell. */
  installed: boolean | null;
  status: string;
  /** The family the conversion wrote instead (`ReportFont.mappedTo`), shown as such; else null. */
  mapped: string | null;
  /** The substitutes offered when it is not installed (those that are not this family); empty otherwise. */
  substitutes: readonly Substitute[];
}

export interface ReportView {
  /** Slides, shapes, text boxes and pictures, labelled, the numbers written as `lang` writes them. */
  stats: { label: string; value: string }[];
  /** How many of the pictures are the PDF's own; null when there are none. */
  pictures: string | null;
  /** What the user should know first: encrypted, the deck cut at its budget, pages left blank, pages too complex. */
  notices: string[];
  /** One entry per image-only page (spec §3). */
  imageOnly: { page: string; message: string }[];
  /** Approximations and fallbacks in plain words, with their counts; empty when there are none. */
  approximations: { label: string; count: string }[];
  fonts: FontRow[];
}

/** A slide that is blank because its page could not be read, built or written (not one cut at the deck's budget). */
const UNREADABLE = new Set(['page-unreadable', 'slide-unbuildable', 'slide-unwritable']);

/** The most groups a list of pages shows before "and n more". */
const PAGE_GROUPS_SHOWN = 10;

/** Pages as `lang` lists them, in runs: `1–3, 5, 7–8`, then "and n more" past `PAGE_GROUPS_SHOWN` runs. */
export function pageList(lang: Lang, pages: readonly number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const runs: [number, number][] = [];
  for (const page of sorted) {
    const last = runs[runs.length - 1];
    if (last !== undefined && page === last[1] + 1) last[1] = page;
    else runs.push([page, page]);
  }
  const text = (run: [number, number]): string => (run[0] === run[1] ? num(lang, run[0]) : `${num(lang, run[0])}–${num(lang, run[1])}`);
  const shown = runs.slice(0, PAGE_GROUPS_SHOWN).map(text).join(', ');
  const rest = runs.slice(PAGE_GROUPS_SHOWN).reduce((n, [a, b]) => n + b - a + 1, 0);
  return rest === 0 ? shown : t(lang, 'report.pages.more', { pages: shown, count: num(lang, rest) });
}

/** Whether the conversion made nothing of the PDF: no slide, or every slide blank (a damaged file pdf.js opened). */
export const nothingConverted = (report: Report): boolean => report.slides.every((slide) => slide.failed !== null);

/** The raster fallbacks the report lists: pictures the conversion drew, not the PDF's own (`counts.pictures`). */
const drawnPictures = (report: Report): number =>
  report.slides.reduce((n, slide) => n + slide.fallbacks.filter((f) => f.raster !== undefined).length, 0);

const same = (a: string, b: string): boolean => a.toLocaleLowerCase() === b.toLocaleLowerCase();

/**
 * The typefaces a font's text is written with, the names a font map is keyed by: the report's `written` (M6 Task 3), which
 * can differ from `latin` and `ea` for a font named only by its PostScript name; those two for a report without it.
 */
const facesOf = (font: ReportFont): { latin: string | null; ea: string | null } => ({
  latin: font.written?.latin ?? font.latin,
  ea: font.written?.ea ?? font.ea,
});

function fontRows(lang: Lang, fonts: readonly ReportFont[], installed: (family: string) => boolean | null): FontRow[] {
  const groups = new Map<string, ReportFont[]>();
  for (const font of fonts) {
    if (font.type3) continue; // its glyphs are the PDF's drawings; its text is written in Arial
    const faces = facesOf(font);
    const family = faces.ea ?? faces.latin;
    if (family === null || family === '') continue;
    groups.set(family, [...(groups.get(family) ?? []), font]);
  }
  return [...groups].map(([family, members]): FontRow => {
    const latin = [...new Set(members.map((f) => facesOf(f).latin).filter((n): n is string => n !== null && n !== ''))];
    const ea = [...new Set(members.map((f) => facesOf(f).ea).filter((n): n is string => n !== null && n !== ''))];
    const answers = [...new Set([...latin, ...ea])].map(installed);
    const found = answers.includes(true) ? true : answers.length > 0 && answers.every((a) => a === false) ? false : null;
    const names = [...latin, ...ea];
    return {
      family,
      other: ea.length > 0 && latin[0] !== undefined && latin[0] !== family ? latin[0] : null,
      latin,
      ea,
      installed: found,
      status: t(lang, found === true ? 'report.fonts.installed' : found === false ? 'report.fonts.missing' : 'report.fonts.unknown'),
      mapped: members.find((f) => f.mappedTo !== undefined)?.mappedTo ?? null,
      substitutes: found === false ? SUBSTITUTES.filter((s) => !names.some((n) => same(n, s.latin) || same(n, s.ea))) : [],
    };
  });
}

/** The panel's words and numbers for `report`, in `lang`; `installed` answers for a family name (fonts-check.ts). */
export function reportView(report: Report, lang: Lang, installed: (family: string) => boolean | null): ReportView {
  const { totals } = report;
  const own = totals.pictures;
  const drawn = drawnPictures(report);
  const stats: [Key, number][] = [
    ['report.slides', report.slides.length],
    ['report.shapes', totals.freeforms + totals.rects + totals.lines],
    ['report.textBoxes', totals.textBoxes],
    ['report.pictures', own + drawn],
  ];

  const notices: string[] = [];
  if (report.source.encrypted) notices.push(t(lang, 'report.encrypted'));
  const cut = report.slides.find((s) => s.failed === 'deck-too-complex');
  if (report.budgets.exceeded.deck && cut !== undefined) notices.push(t(lang, 'report.deckCut', { page: num(lang, cut.index) }));
  const unreadable = report.slides.filter((s) => s.failed !== null && UNREADABLE.has(s.failed)).map((s) => s.index);
  if (unreadable.length > 0) notices.push(t(lang, 'report.unreadable', { pages: pageList(lang, unreadable) }));
  if (report.budgets.exceeded.slide.length > 0) notices.push(t(lang, 'report.slideTooComplex', { pages: pageList(lang, report.budgets.exceeded.slide) }));

  const approximations: { label: string; count: string }[] = [];
  const row = (label: string, count: number): void => {
    if (count > 0) approximations.push({ label, count: num(lang, count) });
  };
  let other = 0;
  for (const [kind, count] of Object.entries(totals.approximations)) {
    const key = `approx.${kind}`;
    if (Object.hasOwn(MESSAGES[lang], key)) row(t(lang, key as Key), count);
    else other += count; // a kind this page does not know yet (a newer core): counted, in general words
  }
  row(t(lang, 'report.approx.other'), other);
  row(t(lang, 'report.fallback.raster'), drawn);
  row(t(lang, 'report.fallback.dropped'), totals.fallbacks - drawn);
  row(t(lang, 'report.links.dropped'), Object.values(totals.droppedLinks).reduce((n, c) => n + c, 0));
  row(t(lang, 'report.scaled'), report.slides.filter((s) => s.failed === null && s.scale !== null).length);

  const total = own + drawn;
  return {
    stats: stats.map(([key, n]) => ({ label: t(lang, key), value: num(lang, n) })),
    pictures:
      total === 0
        ? null
        : drawn === 0
          ? t(lang, 'report.pictures.allOwn')
          : t(lang, 'report.pictures.share', { total: num(lang, total), own: num(lang, own), drawn: num(lang, drawn) }),
    notices,
    imageOnly: report.slides
      .filter((s) => s.class === 'image-only')
      .map((s) => ({ page: t(lang, 'report.imageOnly.page', { page: num(lang, s.index) }), message: t(lang, 'report.imageOnly.message') })),
    approximations,
    fonts: fontRows(lang, report.fonts, installed),
  };
}

/**
 * The font map for the substitutes chosen (`choices`: a row's family to a substitute's label): each `a:latin` name of
 * the row to the substitute's Latin name, and each `a:ea` name of its own to the substitute's Korean name.
 */
export function fontMapFor(rows: readonly FontRow[], choices: ReadonlyMap<string, string>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) {
    const chosen = SUBSTITUTES.find((s) => s.label === choices.get(row.family));
    if (chosen === undefined) continue;
    for (const name of row.latin) map[name] = chosen.latin;
    for (const name of row.ea) if (!row.latin.includes(name)) map[name] = chosen.ea;
  }
  return map;
}

// ---------------------------------------------------------------------------------------------------------------------
// The DOM

type Child = Node | string | null | false;

/** An element with attributes and children; text goes in as text nodes only. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  for (const child of children) if (child !== null && child !== false) el.append(child);
  return el;
}

export interface PanelOptions {
  lang: Lang;
  /** The substitute chosen for each family so far (its label), shown as selected. */
  choices: ReadonlyMap<string, string>;
  /** The user chose a substitute for `family` (`label`, or '' to keep it). */
  onChoose: (family: string, label: string) => void;
}

/**
 * The dropdown of the font family `family` in `root`, or null. Found by comparing `data-family`, not with a selector: the
 * name comes from the PDF, and a selector would need it escaped.
 */
export function substituteSelect(root: ParentNode, family: string): HTMLSelectElement | null {
  for (const select of root.querySelectorAll<HTMLSelectElement>('select[data-family]')) if (select.getAttribute('data-family') === family) return select;
  return null;
}

/** The report panel for `view`: open, in a `details` the user may close. */
export function renderReport(view: ReportView, { lang, choices, onChoose }: PanelOptions): HTMLElement {
  const section = (title: Key, ...body: Child[]): HTMLElement =>
    h('section', { class: 'report-part' }, h('h3', {}, t(lang, title)), ...body);

  const notices =
    view.notices.length > 0 && h('ul', { class: 'notices', 'data-part': 'notices' }, ...view.notices.map((n) => h('li', { class: 'notice' }, n)));

  const imageOnly =
    view.imageOnly.length > 0 &&
    section(
      'report.imageOnly.title',
      h('ul', { class: 'image-only', 'data-part': 'image-only' }, ...view.imageOnly.map((p) => h('li', {}, h('strong', {}, p.page), ' ', p.message))),
    );

  const stats = h(
    'dl',
    { class: 'stats', 'data-part': 'stats' },
    ...view.stats.map((s) => h('div', { class: 'stat' }, h('dt', {}, s.label), h('dd', {}, s.value))),
  );

  const approximations = section(
    'report.approx.title',
    view.approximations.length === 0
      ? h('p', { class: 'muted' }, t(lang, 'report.approx.none'))
      : h('ul', { class: 'rows', 'data-part': 'approximations' }, ...view.approximations.map((a) => h('li', {}, h('span', {}, a.label), h('span', { class: 'count' }, a.count)))),
  );

  const fonts = section(
    'report.fonts.title',
    view.fonts.length === 0
      ? h('p', { class: 'muted' }, t(lang, 'report.fonts.none'))
      : h('ul', { class: 'fonts', 'data-part': 'fonts' }, ...view.fonts.map((row, i) => fontItem(row, i))),
    view.fonts.length > 0 && h('p', { class: 'hint' }, t(lang, 'report.fonts.hint')),
  );

  function fontItem(row: FontRow, i: number): HTMLElement {
    const state = row.installed === true ? 'installed' : row.installed === false ? 'missing' : 'unknown';
    const item = h(
      'li',
      { class: 'font', 'data-family': row.family },
      h('span', { class: 'family' }, row.family),
      row.other !== null && h('span', { class: 'other' }, row.other),
      h('span', { class: `badge ${state}` }, row.status),
    );
    if (row.substitutes.length > 0) {
      const id = `substitute-${i}`;
      const chosen = choices.get(row.family) ?? '';
      const select = h(
        'select',
        { id, 'data-family': row.family },
        h('option', { value: '' }, t(lang, 'report.fonts.keep')),
        ...row.substitutes.map((s) => h('option', { value: s.label, lang: s.label === '맑은 고딕' ? 'ko' : 'en' }, s.label)),
      );
      select.value = chosen;
      select.addEventListener('change', () => onChoose(row.family, select.value));
      item.append(h('span', { class: 'substitute' }, h('label', { for: id }, t(lang, 'report.fonts.substitute')), select));
    }
    if (row.mapped !== null) item.append(h('span', { class: 'mapped' }, t(lang, 'report.fonts.mapped', { family: row.mapped })));
    return item;
  }

  return h(
    'details',
    { class: 'report', open: '' },
    h('summary', {}, t(lang, 'report.title')),
    notices,
    imageOnly,
    stats,
    view.pictures !== null && h('p', { class: 'muted pictures' }, view.pictures),
    approximations,
    fonts,
  );
}
