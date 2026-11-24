/** The declaration every XML part starts with. */
export const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

const ESCAPES: Readonly<Record<string, string>> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

/** `text` with `& < > " '` escaped, for a text node or an attribute value. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]!);
}

/**
 * What XML 1.0 refuses (its `Char` production): the C0 controls other than tab, LF and CR, U+FFFE, U+FFFF and, read by
 * code point (the `u` flag), every surrogate that is not half of a valid pair.
 */
const NOT_XML_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu;

/** `text` without the characters XML refuses (`NOT_XML_CHAR`), not escaped. */
export function xmlChars(text: string): string {
  return text.replace(NOT_XML_CHAR, '');
}

/** `text` made safe for a text node: the characters XML refuses are dropped, the rest escaped. */
export function textNode(text: string): string {
  return esc(xmlChars(text));
}
