import { resolve } from 'node:path';

/**
 * The command line of `deckback` (M7 Task 1): what the arguments mean, and the words printed for a bad one. Nothing here
 * touches a file or the deck; `main.ts` does the reading and writing.
 */

export const USAGE =
  'usage: deckback <in.pdf> -o <out.pptx> [--report <file.json>] [--scene <file.json>] [--pages <list>] [--font-map <file.json|A=B;C=D>] [--embed-fonts] [--strict]\n';

export const HELP = `${USAGE}
Converts a PDF to an editable PPTX, on this computer only; nothing is uploaded.

Options:
  -o <out.pptx>          the PPTX to write (required)
  --report <file.json>   also write the conversion report
  --scene <file.json>    also write the Scene (the PDF as the converter read it) as canonical JSON
  --pages <list>         convert only these pages, 1-based, as in 1-3,5,8- (8- is page 8 to the last);
                         the slides are in the order written; a page twice or past the end is an error
  --font-map <map>       write another font family where a family is used. <map> is a JSON file of
                         {"written family": "family to write"}, or inline as A=B;C=D. It is a file when one
                         exists at that path, else inline when it contains "=". An empty map changes nothing
  --embed-fonts          embed the PDF's own TrueType fonts that allow it
  --strict               refuse a PDF that needs a fallback (a raster of an effect or of an unmodelled operator)
  --help, -h             print this text
  --version              print the version

-o, --report and --scene must be different paths, and none of them the input PDF (the input is never overwritten).
A value option given twice (for example -o twice) is an error. They are written together: when one cannot be
written, none is left. On success one JSON line of counts is printed on stdout.

Exit codes:
  0  done
  2  bad arguments (an unknown option, a bad --pages or --font-map, two outputs at one path, an output at the input's path, a value option given twice)
  3  the input cannot be read (missing, no PDF that can be opened, a password needed)
  4  any other conversion error, an output that cannot be written included
  5  --strict, and a fallback would be written; nothing is written
`;

/** A page range of --pages, 1-based: `to` null is "to the last page". */
export interface PageRange {
  from: number;
  to: number | null;
}

export interface Args {
  input: string;
  output: string;
  report: string | null;
  scene: string | null;
  pages: PageRange[] | null;
  /** The --font-map value, not yet read. */
  fontMap: string | null;
  embedFonts: boolean;
  strict: boolean;
}

export type Parsed = { kind: 'help' } | { kind: 'version' } | { kind: 'run'; args: Args } | { kind: 'error'; message: string };

const VALUE_OPTIONS = new Set(['-o', '--report', '--scene', '--pages', '--font-map']);

export function parseArgs(argv: readonly string[]): Parsed {
  const fail = (message: string): Parsed => ({ kind: 'error', message });
  // --help wins wherever it stands, even after an argument that would be an error (M7-R1)
  if (argv.includes('--help') || argv.includes('-h')) return { kind: 'help' };
  let input: string | null = null;
  const values = new Map<string, string>();
  let embedFonts = false;
  let strict = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    if (arg === '--version') return { kind: 'version' };
    if (VALUE_OPTIONS.has(arg)) {
      const value = argv[++i];
      if (value === undefined) return fail(`${arg} needs a value`);
      if (values.has(arg)) return fail(`${arg} is given twice`);
      values.set(arg, value);
    } else if (arg === '--embed-fonts') {
      embedFonts = true;
    } else if (arg === '--strict') {
      strict = true;
    } else if (arg.startsWith('-') && arg !== '-') {
      return fail(`unknown option ${arg}`);
    } else if (input === null) {
      input = arg;
    } else {
      return fail('more than one input');
    }
  }
  const output = values.get('-o');
  if (input === null) return fail('no input');
  if (output === undefined) return fail('-o <out.pptx> is required');
  const report = values.get('--report') ?? null;
  const scene = values.get('--scene') ?? null;
  const outputs: [string, string][] = [['-o', output]];
  if (report !== null) outputs.push(['--report', report]);
  if (scene !== null) outputs.push(['--scene', scene]);
  for (const [name, path] of outputs) {
    if (samePath(input, path)) return fail(`${name} is the same path as the input; the input is never overwritten`);
  }
  for (let a = 0; a < outputs.length; a++) {
    for (let b = a + 1; b < outputs.length; b++) {
      if (samePath(outputs[a]![1], outputs[b]![1])) return fail(`${outputs[a]![0]} and ${outputs[b]![0]} are the same path`); // one would overwrite the other
    }
  }
  let pages: PageRange[] | null = null;
  const pageList = values.get('--pages');
  if (pageList !== undefined) {
    const ranges = parsePageList(pageList);
    if (typeof ranges === 'string') return fail(ranges);
    pages = ranges;
  }
  return { kind: 'run', args: { input, output, report, scene, pages, fontMap: values.get('--font-map') ?? null, embedFonts, strict } };
}

/** Whether two paths name one file: resolved against the working directory, and on Windows without regard to case. */
function samePath(a: string, b: string): boolean {
  const [x, y] = [resolve(a), resolve(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

const PAGE = /^[1-9][0-9]{0,8}$/;

/** `1-3,5,8-` as ranges, or the message for a list that is not one. */
export function parsePageList(text: string): PageRange[] | string {
  const bad = `--pages: "${text}" is not a page list like 1-3,5,8-`;
  const ranges: PageRange[] = [];
  for (const part of text.split(',')) {
    const bounds = part.split('-');
    if (bounds.length > 2 || !PAGE.test(bounds[0]!)) return bad;
    const from = Number(bounds[0]);
    if (bounds.length === 1) {
      ranges.push({ from, to: from });
    } else if (bounds[1] === '') {
      ranges.push({ from, to: null });
    } else if (PAGE.test(bounds[1]!) && Number(bounds[1]) >= from) {
      ranges.push({ from, to: Number(bounds[1]) });
    } else {
      return bad;
    }
  }
  return ranges;
}

/** The 0-based pages `ranges` name in a document of `count` pages, in the order written, or the message for a bad one. */
export function resolvePages(ranges: readonly PageRange[], count: number): number[] | string {
  const pages: number[] = [];
  const seen = new Set<number>();
  for (const { from, to } of ranges) {
    const last = to ?? count;
    if (from > count || last > count) return `--pages: page ${Math.max(from, last)} is past the last page (${count} pages)`;
    for (let page = from; page <= last; page++) {
      if (seen.has(page)) return `--pages: page ${page} is listed twice`;
      seen.add(page);
      pages.push(page - 1);
    }
  }
  return pages;
}

/** The largest --font-map file read, in bytes. */
export const FONT_MAP_MAX_BYTES = 1024 * 1024;

const NOT_A_MAP = '--font-map: expected an object of family names to family names';

/** The map in a JSON file's text, or the message for a text that is not one. */
export function parseFontMapJson(text: string): Record<string, string> | string {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return '--font-map: the file is not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return NOT_A_MAP;
  return checkedMap(Object.entries(value));
}

/** The map in an inline `A=B;C=D`, or the message for a text that is not one. */
export function parseFontMapInline(text: string): Record<string, string> | string {
  const entries: [string, unknown][] = [];
  for (const part of text.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) return '--font-map: each entry must be family=family, as in A=B;C=D';
    entries.push([part.slice(0, at).trim(), part.slice(at + 1).trim()]);
  }
  return checkedMap(entries);
}

function checkedMap(entries: [string, unknown][]): Record<string, string> | string {
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, value] of entries) {
    if (key.trim() === '' || typeof value !== 'string' || value.trim() === '') return NOT_A_MAP;
    map[key.trim()] = value.trim();
  }
  return { ...map };
}
