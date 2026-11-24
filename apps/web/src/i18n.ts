import type { Approximation } from '@deckback/core';

/**
 * Every word the page shows, in Korean and in English (Global Constraints, Languages). Korean comes first: it is the
 * page's own language (`index.html` is written in it), and English must have every key Korean has (`Messages`, and
 * test/i18n.test.ts). A `{name}` in a message is filled by `t`; both languages use the same names.
 *
 * Nothing here is ever an error's own message: an error is shown by its kind (`error.*`) only, as a raw message could
 * quote the file.
 */

export type Lang = 'ko' | 'en';
export const LANGS: readonly Lang[] = ['ko', 'en'];

/** The approximation kinds' plain words, one key each (a kind the report has and this lacks is a type error). */
type ApproximationKeys = Record<`approx.${Approximation}`, string>;

const ko = {
  'meta.title': 'deckback — PDF를 PowerPoint로',
  'lang.other': 'English',
  'intro.title': 'PDF를 고칠 수 있는 PowerPoint로',
  'intro.lead': '글상자, 도형, 그림을 고칠 수 있게 살려 PPTX로 바꿔요.',
  'drop.title': 'PDF를 여기에 끌어다 놓으세요',
  'drop.active': '놓으면 변환을 시작해요',
  'drop.or': '또는',
  'drop.choose': 'PDF 고르기',
  'progress.label': '변환 진행',
  'progress.opening': 'PDF를 여는 중…',
  'progress.slides': '슬라이드 {done}/{total} 변환 중',
  cancel: '취소',
  'status.cancelled': '변환을 취소했어요.',
  'error.password': '열기 암호가 걸린 PDF라 열 수 없어요. 암호를 푼 PDF로 다시 해 보세요.',
  'error.not-pdf': 'PDF 파일이 아니에요. PDF 파일을 골라 주세요.',
  'error.damaged': 'PDF가 손상되어 읽을 수 없어요. 원본 파일로 다시 해 보세요.',
  'error.too-complex': '이 PDF는 이 페이지에서 변환하기엔 너무 복잡해요.',
  'error.failed': '변환하지 못했어요. 다시 해 보거나 다른 PDF로 해 보세요.',
  'error.read': '파일을 읽지 못했어요. 파일이 옮겨지거나 지워지지 않았는지 보고 다시 해 보세요.',
  'error.too-large': 'PDF가 너무 커서 이 페이지에서 열 수 없어요. 200MB보다 작은 파일로 해 보세요.',
  'done.title': '변환을 마쳤어요',
  'done.download': 'PPTX 내려받기',
  'report.title': '리포트',
  'report.slides': '슬라이드',
  'report.shapes': '도형',
  'report.textBoxes': '글상자',
  'report.pictures': '그림',
  'report.pictures.allOwn': '그림은 모두 원본 PDF에 있던 것이에요.',
  'report.pictures.share': '그림 {total}개 중 {own}개는 원본 PDF에 있던 것이고, {drawn}개는 변환하며 그린 것이에요.',
  'report.encrypted': '권한 암호가 걸린 PDF예요. 열리는 그대로 변환했어요.',
  'report.deckCut': '이 PDF는 이 페이지에서 끝까지 변환하기엔 너무 복잡해요. {page}쪽부터는 빈 슬라이드예요.',
  'report.unreadable': '읽지 못해 빈 슬라이드로 둔 쪽: {pages}',
  'report.slideTooComplex': '너무 복잡해서 일부를 그대로 옮기지 못한 쪽: {pages}',
  'report.pages.more': '{pages} 외 {count}쪽',
  'report.imageOnly.title': '그림으로만 된 페이지',
  'report.imageOnly.page': '{page}쪽',
  'report.imageOnly.message': '이 페이지는 그림으로만 된 PDF예요. 2.0에서 지원 예정',
  'report.approx.title': '비슷하게 옮긴 곳',
  'report.approx.none': '비슷하게 바꾼 곳 없이 그대로 옮겼어요.',
  'report.approx.other': '그 밖에 비슷하게 옮긴 곳',
  'report.fallback.raster': 'PowerPoint에 없는 효과라 그림으로 그린 곳',
  'report.fallback.dropped': '옮기지 못하고 뺀 곳',
  'report.links.dropped': '옮기지 못한 링크',
  'report.scaled': '크기가 달라 슬라이드에 맞춘 쪽',
  'approx.nonzero-approx': '채우기 규칙을 비슷하게 맞춘 도형',
  'approx.clip-dropped': '잘라 내기를 뺀 곳',
  'approx.clip-approx': '잘라 내기를 비슷하게 맞춘 곳',
  'approx.group-alpha-folded': '묶음의 투명도를 요소마다 나눠 준 곳',
  'approx.mask-dropped': '마스크를 뺀 곳',
  'approx.blend-dropped': '혼합 모드를 뺀 곳',
  'approx.tile-unsupported': '바둑판 무늬를 옮기지 못한 곳',
  'approx.gradient-extend': '그라데이션 끝을 비슷하게 맞춘 곳',
  'approx.radial-offset': '원형 그라데이션의 중심을 비슷하게 맞춘 곳',
  'approx.gradient-alpha-mix': '그라데이션 투명도를 비슷하게 맞춘 곳',
  'approx.skewed-picture': '기울어진 그림을 비슷하게 맞춘 곳',
  'approx.anisotropic-line': '늘어난 선 두께를 비슷하게 맞춘 곳',
  'approx.dash-phase': '점선이 시작하는 자리를 비슷하게 맞춘 곳',
  'approx.hscale': '글자 가로 비율을 비슷하게 맞춘 곳',
  'approx.vertical-text': '세로쓰기를 비슷하게 맞춘 곳',
  'approx.text-skew': '기울어진 글자를 비슷하게 맞춘 곳',
  'approx.text-pattern-fill': '무늬로 채운 글자를 비슷하게 맞춘 곳',
  'approx.type3-text': '그림 글꼴(Type 3)의 글자를 보통 글꼴로 쓴 곳',
  'approx.text-drift-split': '글자 간격이 어긋나 글상자를 나눈 곳',
  'report.fonts.title': '필요한 글꼴',
  'report.fonts.none': '글자가 없어서 필요한 글꼴이 없어요.',
  'report.fonts.installed': '설치됨 (추정)',
  'report.fonts.missing': '없음 (추정)',
  'report.fonts.unknown': '알 수 없음',
  'report.fonts.hint': '설치 여부는 이 브라우저가 보여 주는 범위에서 짐작한 것이라 틀릴 수 있어요.',
  'report.fonts.substitute': '대신 쓸 글꼴',
  'report.fonts.keep': '그대로 두기',
  'report.fonts.mapped': '{family} 글꼴로 바꿔 썼어요',
  'footer.privacy': '파일은 브라우저 밖으로 나가지 않아요. 변환은 모두 이 기기 안에서 이뤄져요.',
} as const satisfies ApproximationKeys & Record<string, string>;

export type Key = keyof typeof ko;

const en: Record<Key, string> = {
  'meta.title': 'deckback — PDF to PowerPoint',
  'lang.other': '한국어',
  'intro.title': 'Turn a PDF into a PowerPoint you can edit',
  'intro.lead': 'Text boxes, shapes and pictures stay editable in the PPTX.',
  'drop.title': 'Drop a PDF here',
  'drop.active': 'Release to start converting',
  'drop.or': 'or',
  'drop.choose': 'Choose a PDF',
  'progress.label': 'Conversion progress',
  'progress.opening': 'Opening the PDF…',
  'progress.slides': 'Converting slide {done} of {total}',
  cancel: 'Cancel',
  'status.cancelled': 'Conversion cancelled.',
  'error.password': 'This PDF needs a password to open. Try again with an unlocked copy.',
  'error.not-pdf': 'This is not a PDF file. Please choose a PDF.',
  'error.damaged': 'This PDF is damaged and cannot be read. Try again with the original file.',
  'error.too-complex': 'This PDF is too complex to convert on this page.',
  'error.failed': 'The conversion did not work. Try again, or try another PDF.',
  'error.read': 'The file could not be read. Check that it was not moved or deleted, and try again.',
  'error.too-large': 'This PDF is too large to open on this page. Try a file smaller than 200 MB.',
  'done.title': 'Conversion finished',
  'done.download': 'Download PPTX',
  'report.title': 'Report',
  'report.slides': 'Slides',
  'report.shapes': 'Shapes',
  'report.textBoxes': 'Text boxes',
  'report.pictures': 'Pictures',
  'report.pictures.allOwn': 'All pictures are the PDF’s own.',
  'report.pictures.share': '{own} of {total} pictures are the PDF’s own; the rest ({drawn}) were drawn during conversion.',
  'report.encrypted': 'This PDF is encrypted with a permissions password. It was converted as it opens.',
  'report.deckCut': 'This PDF is too complex to convert in full on this page. Slides from page {page} on are blank.',
  'report.unreadable': 'Pages left as blank slides because they could not be read: {pages}',
  'report.slideTooComplex': 'Pages too complex to carry over in full: {pages}',
  'report.pages.more': '{pages} and {count} more',
  'report.imageOnly.title': 'Image-only pages',
  'report.imageOnly.page': 'Page {page}',
  'report.imageOnly.message': 'This page is an image-only PDF; support is planned for 2.0',
  'report.approx.title': 'Approximations and fallbacks',
  'report.approx.none': 'Everything was carried over without approximation.',
  'report.approx.other': 'Other approximations',
  'report.fallback.raster': 'Effects PowerPoint lacks, drawn as pictures',
  'report.fallback.dropped': 'Parts left out',
  'report.links.dropped': 'Links left out',
  'report.scaled': 'Pages scaled to fit the slide size',
  'approx.nonzero-approx': 'Shapes whose fill rule is approximated',
  'approx.clip-dropped': 'Clipping left out',
  'approx.clip-approx': 'Clipping approximated',
  'approx.group-alpha-folded': 'Group transparency given to each element',
  'approx.mask-dropped': 'Masks left out',
  'approx.blend-dropped': 'Blend modes left out',
  'approx.tile-unsupported': 'Tiling patterns not carried over',
  'approx.gradient-extend': 'Gradient ends approximated',
  'approx.radial-offset': 'Radial gradient centres approximated',
  'approx.gradient-alpha-mix': 'Gradient transparency approximated',
  'approx.skewed-picture': 'Skewed pictures approximated',
  'approx.anisotropic-line': 'Stretched line widths approximated',
  'approx.dash-phase': 'Where dashes start, approximated',
  'approx.hscale': 'Horizontal text scaling approximated',
  'approx.vertical-text': 'Vertical text approximated',
  'approx.text-skew': 'Skewed text approximated',
  'approx.text-pattern-fill': 'Pattern-filled text approximated',
  'approx.type3-text': 'Type 3 (drawn) font text written in a regular font',
  'approx.text-drift-split': 'Text boxes split where letter spacing drifted',
  'report.fonts.title': 'Fonts needed',
  'report.fonts.none': 'No text, so no fonts are needed.',
  'report.fonts.installed': 'Installed (likely)',
  'report.fonts.missing': 'Not installed (likely)',
  'report.fonts.unknown': 'Unknown',
  'report.fonts.hint': 'Installed or not is a guess from what this browser shows: a hint only.',
  'report.fonts.substitute': 'Use instead',
  'report.fonts.keep': 'Keep as is',
  'report.fonts.mapped': 'Written as {family}',
  'footer.privacy': 'Your files never leave the browser. Everything is converted on this device.',
};

export const MESSAGES: Readonly<Record<Lang, Readonly<Record<Key, string>>>> = { ko, en };

/** `key` in `lang`, each `{name}` replaced by `params[name]` (a name it is not given stays as it is). */
export function t(lang: Lang, key: Key, params: Readonly<Record<string, string | number>> = {}): string {
  return MESSAGES[lang][key].replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : whole));
}

/** The locale numbers are written in. */
export const LOCALES: Readonly<Record<Lang, string>> = { ko: 'ko-KR', en: 'en-US' };

/** `n` as `lang` writes numbers (1,234). */
export const num = (lang: Lang, n: number): string => n.toLocaleString(LOCALES[lang]);

/** Where the choice is kept: the page's only storage, and it holds no file data (Global Constraints, Languages). */
export const LANG_STORAGE_KEY = 'deckback.lang';

/**
 * The language to show: the one chosen before (`stored`), else Korean for a browser whose language is Korean and
 * English for any other.
 */
export function initialLang(stored: string | null, browserLanguages: readonly string[]): Lang {
  if (stored === 'ko' || stored === 'en') return stored;
  const first = browserLanguages[0] ?? '';
  return first.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}
