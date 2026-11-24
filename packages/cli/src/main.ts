import { realpathSync } from 'node:fs';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { canonicalJson, convert, FallbackError, SceneInputError, SceneTooComplexError, UnsupportedOpError, type ConvertOptions, type Converted } from '@deckback/core';
import { FONT_MAP_MAX_BYTES, HELP, parseArgs, parseFontMapInline, parseFontMapJson, resolvePages, USAGE, type Args } from './args';
import { installBundledPdfjs } from './bundled-pdfjs';
import { VERSION } from './version';

/**
 * `deckback <in.pdf> -o <out.pptx> [--report <file.json>] [--scene <file.json>] [--pages <list>] [--font-map <map>] [--embed-fonts] [--strict]`
 * (`--help` lists every option; the words are in args.ts): the PDF converted by `convert()`,
 * the same function the website's worker calls, so the same bytes and options give the same PPTX and report.
 * `--embed-fonts` embeds the PDF's own TrueType fonts that allow it (`embedFonts`, M4 Task 5); the report says what became
 * of each. `--strict` (M5 Task 2) converts in strict mode: a PDF that needs any fallback (a raster of a blend mode, a soft
 * mask or a shading, or an operator the walker does not model) is refused, exit 5, and nothing is written.
 *
 * M7 Task 1: `--pages` (1-based, `1-3,5,8-`; the page count is read first, from the first progress call of `convert()`, so a
 * page past the end or a duplicate is exit 2), `--scene` (the Scene as canonical JSON, written together with the PPTX and the
 * report), `--font-map` (a JSON file, or inline `A=B;C=D`; an empty map is a no-op), `--help`, `--version`. A bad value of
 * any of them is exit 2, the message after the usage line.
 *
 * Stdout is one JSON line of counts, in the shape the harness's baseline prints (`pages`, `shapes`, `textBoxes`,
 * `pictures`: harness/fidelity/run.py `STATS` reads these) and the report's other counts (`freeforms`, `rects`, `lines`,
 * `gradients`, `hotspots`, `runLinks`, `fallbacks`). `shapes` is every shape the slides hold, hotspots not counted.
 *
 * Exit codes: 0 done, 2 bad arguments (two outputs at the same path among them), 3 the input cannot be read
 * (missing, no PDF pdf.js can open, a password needed),
 * 4 any other conversion error, an output that cannot be written included, 5 `--strict` and a fallback would be written.
 * An error's text is fixed words and the
 * user's own path; nothing of the error itself or of the deck is printed. pdf.js prints its warnings through the console
 * (`Warning: Unknown command "e9"`, a font it could not translate), which can quote the deck's content stream: the console
 * is silent while the PDF is converted (`quietConsole`; final review F10). An owner-password-only PDF converts normally
 * (`source.encrypted` true in the report). The PPTX and the report are written together (`writeTogether`): on exit 4
 * neither is left, so a PPTX at `-o` always comes with the report asked for.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface Deps {
  convert: (bytes: Uint8Array, opts: ConvertOptions) => Promise<Converted>;
}

/** The console methods pdf.js (and anything under `convert`) may print with. */
const CONSOLE = ['log', 'info', 'warn', 'error', 'debug'] as const;

/**
 * `run()`, with what it prints through the console dropped (final review F10): pdf.js' warnings can quote the deck. The
 * console is as it was once `run()` settles. The CLI's own output goes through `Io`, never the console.
 */
async function quietConsole<T>(run: () => Promise<T>): Promise<T> {
  const saved = CONSOLE.map((name) => console[name]);
  for (const name of CONSOLE) console[name] = () => undefined;
  try {
    return await run();
  } finally {
    CONSOLE.forEach((name, i) => {
      console[name] = saved[i]!;
    });
  }
}

interface OutputFile {
  path: string;
  data: Uint8Array | string;
}

/** The file beside `path` that its bytes are written to first. */
const pending = (path: string): string => `${path}.${process.pid}.tmp`;

/**
 * Writes the files all or none: each first to a temp file beside it (`pending`), then each renamed into place in order,
 * so the last one, the PPTX, is at its path only when the others are too. When any step fails, every temp file and every
 * file already renamed into place is removed (an earlier file at a path not yet reached stays as it was), and the answer
 * is false.
 */
async function writeTogether(files: readonly OutputFile[]): Promise<boolean> {
  const placed: string[] = [];
  try {
    for (const file of files) await writeFile(pending(file.path), file.data);
    for (const file of files) {
      await rename(pending(file.path), file.path);
      placed.push(file.path);
    }
    return true;
  } catch {
    const leftovers = [...files.map((file) => pending(file.path)), ...placed];
    await Promise.all(leftovers.map((path) => rm(path, { force: true }).catch(() => undefined)));
    return false;
  }
}

/** Thrown by the page-count probe once convert() has said how many pages the PDF has. */
class Counted extends Error {
  constructor(readonly pages: number) {
    super('counted');
  }
}

/** The exit code, and the message, for an error convert() threw. */
function failure(error: unknown, args: Args): { code: number; message: string } {
  if (error instanceof SceneInputError && (error.kind === 'not-pdf' || error.kind === 'password')) {
    return { code: 3, message: `deckback: cannot read ${args.input}\n` };
  }
  // strict mode throws these where lenient mode makes a fallback
  if (args.strict && (error instanceof FallbackError || error instanceof UnsupportedOpError || error instanceof SceneTooComplexError)) {
    return { code: 5, message: `deckback: ${args.input} needs a fallback (--strict)\n` };
  }
  return { code: 4, message: `deckback: cannot convert ${args.input}\n` };
}

/** The `--font-map` value as a map: the file at that path when there is one, else inline `A=B;C=D` when it has an "=". */
async function readFontMap(value: string): Promise<Record<string, string> | string> {
  let text: string | null = null;
  try {
    if ((await stat(value)).size > FONT_MAP_MAX_BYTES) return `--font-map: ${value} is over 1 MB`;
    text = await readFile(value, 'utf8');
  } catch {
    // not a file: inline, or a path that is not there
  }
  if (text !== null) return parseFontMapJson(text);
  return value.includes('=') ? parseFontMapInline(value) : `--font-map: cannot read ${value}, and it is not inline A=B;C=D`;
}

/** Whatever goes wrong that nothing above caught is exit 4 with a fixed message, never a stack trace. */
export async function main(argv: readonly string[], io: Io, deps: Deps = { convert }): Promise<number> {
  try {
    return await mainUnguarded(argv, io, deps);
  } catch {
    io.err('deckback: cannot convert\n');
    return 4;
  }
}

async function mainUnguarded(argv: readonly string[], io: Io, deps: Deps): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.out(HELP);
    return 0;
  }
  if (parsed.kind === 'version') {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const badArguments = (message: string): number => {
    io.err(`${USAGE}deckback: ${message}\n`);
    return 2;
  };
  if (parsed.kind === 'error') return badArguments(parsed.message);
  const args = parsed.args;
  let fontMap: Record<string, string> | undefined;
  if (args.fontMap !== null) {
    const map = await readFontMap(args.fontMap);
    if (typeof map === 'string') return badArguments(map);
    if (Object.keys(map).length > 0) fontMap = map; // an empty map changes nothing
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(args.input));
  } catch {
    io.err(`deckback: cannot read ${args.input}\n`);
    return 3;
  }
  let pages: number[] | undefined;
  if (args.pages !== null) {
    // the page count: convert() reports it, as the total of its first progress call, before it writes a slide
    let count: number | null = null;
    try {
      await quietConsole(() =>
        deps.convert(bytes, {
          onProgress: (_done, total) => {
            throw new Counted(total);
          },
        }),
      );
    } catch (error) {
      if (error instanceof Counted) count = error.pages;
      else {
        const { code, message } = failure(error, args);
        io.err(message);
        return code;
      }
    }
    if (count === null) {
      io.err(`deckback: cannot convert ${args.input}\n`);
      return 4;
    }
    const resolved = resolvePages(args.pages, count);
    if (typeof resolved === 'string') return badArguments(resolved);
    pages = resolved;
  }
  let converted: Converted;
  try {
    converted = await quietConsole(() =>
      deps.convert(bytes, {
        embedFonts: args.embedFonts,
        ...(args.strict ? { strict: true } : {}),
        ...(pages === undefined ? {} : { pages }),
        ...(fontMap === undefined ? {} : { fontMap }),
        ...(args.scene === null ? {} : { scene: true }),
      }),
    );
  } catch (error) {
    const { code, message } = failure(error, args);
    io.err(message);
    return code;
  }
  const files: OutputFile[] = [{ path: args.output, data: converted.pptx }];
  if (args.report !== null) files.unshift({ path: args.report, data: `${JSON.stringify(converted.report, null, 2)}\n` });
  if (args.scene !== null) {
    if (converted.scene === undefined) {
      io.err(`deckback: cannot convert ${args.input}\n`);
      return 4;
    }
    files.unshift({ path: args.scene, data: canonicalJson(converted.scene) });
  }
  if (!(await writeTogether(files))) {
    io.err(`deckback: cannot convert ${args.input}\n`);
    return 4;
  }
  const t = converted.report.totals;
  io.out(
    `${JSON.stringify({
      pages: converted.report.slides.length,
      shapes: t.textBoxes + t.freeforms + t.rects + t.lines + t.pictures,
      textBoxes: t.textBoxes,
      pictures: t.pictures,
      freeforms: t.freeforms,
      rects: t.rects,
      lines: t.lines,
      gradients: t.gradients,
      hotspots: t.hotspots,
      runLinks: t.runLinks,
      fallbacks: t.fallbacks,
    })}\n`,
  );
  return 0;
}

// Run as the bundle's entry (`node deckback.mjs ...`, or the `deckback` bin, a symlink on Linux and macOS: compare real paths),
// not when a test imports `main`.
function isEntry(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntry()) {
  installBundledPdfjs(import.meta.url);
  main(process.argv.slice(2), { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }).then(
    (code) => {
      process.exitCode = code;
    },
  );
}
