import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, convert, SceneInputError } from '@deckback/core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { main, type Io } from '../src/main';

const PACKAGE_VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

/**
 * The CLI: `deckback <in.pdf> -o <out.pptx> [--report <file.json>]`. One JSON line of counts on stdout (as the harness's
 * proto prints, plus the report's counts), exit codes 0 / 2 bad arguments / 3 unreadable or password-protected input /
 * 4 conversion error, and error text of fixed words and the user's own path.
 */

const PDF = new URL('../../../corpus/generated/probe_std.pdf', import.meta.url);
/** M5 Task 2's fixture: a Multiply ellipse under text, a raster fallback in lenient mode. */
const BLEND = new URL('../../../corpus/generated/fallback/blend-multiply.pdf', import.meta.url);
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'deckback-cli-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());

function run(args: string[], deps?: Parameters<typeof main>[2]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: Io = { out: (text) => (out += text), err: (text) => (err += text) };
  return main(args, io, deps).then((code) => ({ code, out, err }));
}

describe('deckback CLI', () => {
  it('converts: the output is convert()s bytes, stdout is one JSON line of counts, the report is written on request', async () => {
    const pptx = join(dir, 'a.pptx');
    const reportFile = join(dir, 'a.json');
    const { code, out, err } = await run([fileUrl(PDF), '-o', pptx, '--report', reportFile]);
    expect(err).toBe('');
    expect(code).toBe(0);
    const expected = await convert(new Uint8Array(readFileSync(PDF)));
    expect(new Uint8Array(readFileSync(pptx))).toEqual(expected.pptx);
    expect(JSON.parse(readFileSync(reportFile, 'utf8'))).toEqual(JSON.parse(JSON.stringify(expected.report)));
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trimEnd().split('\n')).toHaveLength(1);
    const t = expected.report.totals;
    expect(JSON.parse(out)).toEqual({
      pages: expected.report.slides.length,
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
    });
  }, 60_000);

  it('bad arguments are exit 2 with a usage line on stderr and nothing on stdout', async () => {
    for (const args of [[], ['in.pdf'], ['-o', 'x.pptx'], ['a.pdf', 'b.pdf', '-o', 'x.pptx'], ['a.pdf', '-o'], ['a.pdf', '-o', 'x.pptx', '--nope'], ['a.pdf', '-o', 'x.pptx', '--report']]) {
      const { code, out, err } = await run(args);
      expect([args, code]).toEqual([args, 2]);
      expect(out).toBe('');
      expect(err).toMatch(/^usage: deckback /);
    }
  });

  it('--embed-fonts asks convert() to embed the fonts (M4 Task 5); without it, it does not', async () => {
    const pdf = join(dir, 'fonts.pdf');
    writeFileSync(pdf, readFileSync(PDF));
    const asked: unknown[] = [];
    const deps = {
      convert: (bytes: Uint8Array, opts?: Parameters<typeof convert>[1]) => {
        asked.push(opts);
        return convert(bytes, opts);
      },
    };
    const embedded = join(dir, 'embedded.pptx');
    expect((await run([pdf, '--embed-fonts', '-o', embedded], deps)).code).toBe(0);
    expect((await run([pdf, '-o', join(dir, 'plain.pptx')], deps)).code).toBe(0);
    expect(asked).toEqual([{ embedFonts: true }, { embedFonts: false }]);
    const expected = await convert(new Uint8Array(readFileSync(PDF)), { embedFonts: true });
    expect(new Uint8Array(readFileSync(embedded))).toEqual(expected.pptx);
    // a usage line names it
    expect((await run([])).err).toContain('[--embed-fonts]');
  }, 60_000);

  it('--strict refuses a fallback (M5 Task 2): exit 5, nothing written; a PDF without one converts as without it', async () => {
    const blended = join(dir, 'blend.pdf');
    writeFileSync(blended, readFileSync(BLEND));
    const out = join(dir, 'blend.pptx');
    const refused = await run([blended, '--strict', '-o', out]);
    expect(refused).toEqual({ code: 5, out: '', err: `deckback: ${blended} needs a fallback (--strict)\n` });
    expect(readdirSync(dir).filter((name) => name.startsWith('blend.pptx'))).toEqual([]);
    const lenient = await run([blended, '-o', out]);
    expect(lenient.code).toBe(0);
    expect(JSON.parse(lenient.out)).toMatchObject({ fallbacks: 1 });
    // the probe has none: --strict converts it to the same bytes
    const asked: unknown[] = [];
    const deps = { convert: (bytes: Uint8Array, opts?: Parameters<typeof convert>[1]) => (asked.push(opts), convert(bytes, opts)) };
    const strictOut = join(dir, 'strict.pptx');
    expect((await run([fileUrl(PDF), '--strict', '-o', strictOut], deps)).code).toBe(0);
    expect(asked).toEqual([{ embedFonts: false, strict: true }]);
    expect(new Uint8Array(readFileSync(strictOut))).toEqual((await convert(new Uint8Array(readFileSync(PDF)))).pptx);
    expect((await run([])).err).toContain('[--strict]');
  }, 60_000);

  it('an output and a report at the same path are bad arguments (exit 2): one would overwrite the other', async () => {
    const same = join(dir, 'same.out');
    for (const args of [
      ['a.pdf', '-o', same, '--report', same],
      ['a.pdf', '--report', join(dir, '.', 'same.out'), '-o', same],
      ['a.pdf', '-o', 'x.pptx', '--report', './x.pptx'],
    ]) {
      const { code, out, err } = await run(args);
      expect([args, code]).toEqual([args, 2]);
      expect(out).toBe('');
      expect(err).toMatch(/^usage: deckback /);
    }
  });

  it('an input that is missing, or no PDF, or needs a password is exit 3, the error naming the path only', async () => {
    const missing = join(dir, 'missing.pdf');
    const missed = await run([missing, '-o', join(dir, 'm.pptx')]);
    expect(missed).toEqual({ code: 3, out: '', err: `deckback: cannot read ${missing}\n` });

    const junk = join(dir, 'junk.pdf');
    writeFileSync(junk, 'not a pdf at all');
    const junked = await run([junk, '-o', join(dir, 'j.pptx')]);
    expect(junked).toEqual({ code: 3, out: '', err: `deckback: cannot read ${junk}\n` });

    // a PDF pdf.js opens only with a user password: its error says so; the CLI says the same fixed words
    const locked = await run([join(dir, 'junk.pdf'), '-o', join(dir, 'l.pptx')], {
      convert: () => Promise.reject(new SceneInputError('password')),
    });
    expect(locked).toEqual({ code: 3, out: '', err: `deckback: cannot read ${junk}\n` });
  });

  it('any other conversion error is exit 4, with no text of the error', async () => {
    const pdf = join(dir, 'x.pdf');
    writeFileSync(pdf, 'x');
    const failed = await run([pdf, '-o', join(dir, 'x.pptx')], { convert: () => Promise.reject(new RangeError('secret deck text')) });
    expect(failed).toEqual({ code: 4, out: '', err: `deckback: cannot convert ${pdf}\n` });
    // an output that cannot be written is a conversion error too
    const unwritable = await run([fileUrl(PDF), '-o', join(dir, 'no', 'such', 'dir', 'o.pptx')]);
    expect(unwritable.code).toBe(4);
    expect(unwritable.out).toBe('');
  }, 60_000);

  it("prints nothing of pdf.js' warnings, which can quote the deck: the console is silent while it converts (final review F10)", async () => {
    // a page whose content stream has an operator pdf.js does not know, in a file without a cross-reference table
    const body = '0 0 1 rg 10 10 50 50 re f e9 secret9';
    const pdf = join(dir, 'warns.pdf');
    writeFileSync(
      pdf,
      '%PDF-1.4\n1 0 obj <</Type /Catalog /Pages 2 0 R>> endobj\n2 0 obj <</Type /Pages /Kids [3 0 R] /Count 1>> endobj\n' +
        '3 0 obj <</Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R>> endobj\n' +
        `4 0 obj <</Length ${body.length}>> stream\n${body}\nendstream endobj\ntrailer <</Root 1 0 R>>\n%%EOF\n`,
    );
    const printed: unknown[][] = [];
    for (const name of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, name).mockImplementation((...args) => void printed.push(args));
    // convert() alone: pdf.js is opened with `verbosity: 0` (errors only), so its warning, which quotes the content stream, is not printed
    await convert(new Uint8Array(readFileSync(pdf)));
    expect(printed.flat().join(' ')).not.toMatch(/secret9|e9/);
    printed.length = 0;
    // the CLI: nothing goes to the console, and its own output is as ever
    const { code, out, err } = await run([pdf, '-o', join(dir, 'warns.pptx')]);
    expect(code).toBe(0);
    expect(err).toBe('');
    expect(JSON.parse(out)).toMatchObject({ pages: 1, rects: 1 });
    expect(printed).toEqual([]);
    // and the console is given back
    console.warn('after');
    expect(printed).toEqual([['after']]);
  }, 60_000);

  it('writes the PPTX and the report together: when either cannot be written, neither is left, nor a temp file', async () => {
    const converted = await convert(new Uint8Array(readFileSync(PDF)));
    const deps = { convert: () => Promise.resolve(converted) };
    const input = fileUrl(PDF);
    const failed = { code: 4, out: '', err: `deckback: cannot convert ${input}\n` };
    const sub = mkdtempSync(join(dir, 'atomic-'));
    const pptx = join(sub, 'a.pptx');
    const report = join(sub, 'a.json');
    // the report cannot be written: no PPTX at -o (Task 10's review: it used to be left there with exit 4)
    expect(await run([input, '-o', pptx, '--report', join(sub, 'no', 'such', 'a.json')], deps)).toEqual(failed);
    expect(readdirSync(sub)).toEqual([]);
    // the PPTX cannot be written: no report
    expect(await run([input, '-o', join(sub, 'no', 'such', 'a.pptx'), '--report', report], deps)).toEqual(failed);
    expect(readdirSync(sub)).toEqual([]);
    // the PPTX cannot take its place (-o is a directory) after the report did: the report is taken back
    mkdirSync(join(sub, 'taken.pptx'));
    expect(await run([input, '-o', join(sub, 'taken.pptx'), '--report', report], deps)).toEqual(failed);
    expect(readdirSync(sub)).toEqual(['taken.pptx']);
    expect(readdirSync(join(sub, 'taken.pptx'))).toEqual([]);
    // an earlier PPTX stays as it was when the new pair cannot be written
    writeFileSync(pptx, 'earlier');
    expect(await run([input, '-o', pptx, '--report', join(sub, 'no', 'such', 'a.json')], deps)).toEqual(failed);
    expect(readFileSync(pptx, 'utf8')).toBe('earlier');
    expect(readdirSync(sub).sort()).toEqual(['a.pptx', 'taken.pptx']);
    // and when both can be written, both are, with nothing else beside them
    const done = await run([input, '-o', pptx, '--report', report], deps);
    expect(done.code).toBe(0);
    expect(new Uint8Array(readFileSync(pptx))).toEqual(converted.pptx);
    expect(JSON.parse(readFileSync(report, 'utf8'))).toEqual(JSON.parse(JSON.stringify(converted.report)));
    expect(readdirSync(sub).sort()).toEqual(['a.json', 'a.pptx', 'taken.pptx']);
  }, 60_000);
});

describe('deckback CLI options (M7 Task 1)', () => {
  const pdf = fileUrl(PDF); // three pages
  const bad = async (args: string[], message: RegExp): Promise<void> => {
    const sub = mkdtempSync(join(dir, 'bad-'));
    const { code, out, err } = await run([...args, '-o', join(sub, 'o.pptx')]);
    expect([args, code]).toEqual([args, 2]);
    expect(out).toBe('');
    expect(err).toMatch(/^usage: deckback /);
    expect(err).toMatch(message);
    expect(readdirSync(sub)).toEqual([]);
  };
  const spy = (): { asked: unknown[]; deps: { convert: (bytes: Uint8Array, opts?: Parameters<typeof convert>[1]) => ReturnType<typeof convert> } } => {
    const asked: unknown[] = [];
    return { asked, deps: { convert: (bytes, opts) => (asked.push(opts), convert(bytes, opts)) } };
  };

  it('--help prints every option and every exit code on stdout, exit 0, from any position', async () => {
    // M7-R1: --help wins even after an argument that would be an error
    for (const args of [['--help'], ['a.pdf', '-o', 'x.pptx', '--help'], ['--bogus', '--help'], ['a.pdf', '-o', 'x', '-o', 'y', '-h'], ['--pages', '0', 'a.pdf', 'b.pdf', '--help']]) {
      const { code, out, err } = await run(args);
      expect([args, code]).toEqual([args, 0]);
      expect(err).toBe('');
      for (const word of ['-o', '--report', '--scene', '--pages', '--font-map', '--embed-fonts', '--strict', '--help', '--version', '1-3,5,8-', 'A=B;C=D']) expect(out).toContain(word);
      for (const exit of ['0', '2', '3', '4', '5']) expect(out).toMatch(new RegExp(`^  ${exit}  `, 'm'));
    }
  });

  it('an unexpected throw after the conversion is exit 4 with a fixed message, not a stack trace', async () => {
    const sub = mkdtempSync(join(dir, 'throw-'));
    const errs: string[] = [];
    const code = await main([pdf, '-o', join(sub, 'o.pptx')], { out: () => { throw new Error('boom: secret detail'); }, err: (text) => errs.push(text) });
    expect(code).toBe(4);
    expect(errs.join('')).toBe('deckback: cannot convert\n');
  }, 60_000);

  it('--version prints the package version', async () => {
    expect(await run(['--version'])).toEqual({ code: 0, out: `${PACKAGE_VERSION}\n`, err: '' });
  });

  it('unknown options and options without a value are exit 2', async () => {
    for (const args of [['--nope'], ['a.pdf', '-o', 'x.pptx', '--scene'], ['a.pdf', '-o', 'x.pptx', '--pages'], ['a.pdf', '-o', 'x.pptx', '--font-map'], ['a.pdf', '-o', 'x.pptx', '-x']]) {
      const { code, out, err } = await run(args);
      expect([args, code]).toEqual([args, 2]);
      expect(out).toBe('');
      expect(err).toMatch(/^usage: deckback /);
    }
  });

  it('--pages is 1-based and gives convert() the 0-based pages, in the order written', async () => {
    const { asked, deps } = spy();
    const pptx = join(dir, 'pages.pptx');
    const r = await run([pdf, '--pages', '3,1', '-o', pptx], deps);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ pages: 2 });
    expect(asked.at(-1)).toMatchObject({ pages: [2, 0] });
    expect(new Uint8Array(readFileSync(pptx))).toEqual((await convert(new Uint8Array(readFileSync(PDF)), { pages: [2, 0] })).pptx);
    // ranges and an open end ("2-" is page 2 to the last)
    const open = await run([pdf, '--pages', '1,2-', '-o', join(dir, 'open.pptx')], deps);
    expect(JSON.parse(open.out)).toMatchObject({ pages: 3 });
    expect(asked.at(-1)).toMatchObject({ pages: [0, 1, 2] });
    expect(JSON.parse((await run([pdf, '--pages', '1-2', '-o', join(dir, 'r.pptx')])).out)).toMatchObject({ pages: 2 });
  }, 60_000);

  it('bad --pages (0, 5-3, 1,,2, past the end, duplicates, words) is exit 2 with a message, nothing written', async () => {
    for (const [list, message] of [
      ['0', /--pages/],
      ['5-3', /--pages/],
      ['1,,2', /--pages/],
      ['', /--pages/],
      ['a', /--pages/],
      ['1-2-3', /--pages/],
      ['-2', /--pages/],
      ['1.5', /--pages/],
      ['4', /page 4 .*3/],
      ['1-9', /page 9 .*3/],
      ['4-', /page 4 .*3/],
      ['1,1', /page 1 .*twice/],
      ['1-3,2', /page 2 .*twice/],
    ] as const) await bad([pdf, '--pages', list], message);
  }, 60_000);

  it('--pages on a file that is no PDF keeps the exit 3 of an unreadable input', async () => {
    const junk = join(dir, 'junk-pages.pdf');
    writeFileSync(junk, 'not a pdf at all');
    expect(await run([junk, '--pages', '1-', '-o', join(dir, 'jp.pptx')])).toEqual({ code: 3, out: '', err: `deckback: cannot read ${junk}\n` });
  });

  it('--scene writes the canonical Scene JSON together with the PPTX and the report; the three paths differ', async () => {
    const sub = mkdtempSync(join(dir, 'scene-'));
    const [pptx, report, scene] = [join(sub, 'a.pptx'), join(sub, 'a.json'), join(sub, 'a.scene.json')];
    const r = await run([pdf, '-o', pptx, '--report', report, '--scene', scene]);
    expect(r.code).toBe(0);
    const expected = await convert(new Uint8Array(readFileSync(PDF)), { scene: true });
    expect(readFileSync(scene, 'utf8')).toBe(canonicalJson(expected.scene));
    expect(new Uint8Array(readFileSync(pptx))).toEqual(expected.pptx);
    expect(readdirSync(sub).sort()).toEqual(['a.json', 'a.pptx', 'a.scene.json']);
    // without it, convert() is not asked for a scene
    const { asked, deps } = spy();
    await run([pdf, '-o', join(sub, 'b.pptx')], deps);
    expect(asked).toEqual([{ embedFonts: false }]);
    // the same path twice is exit 2
    for (const args of [
      [pdf, '-o', pptx, '--scene', pptx],
      [pdf, '-o', pptx, '--report', report, '--scene', report],
      [pdf, '-o', pptx, '--report', join(sub, 'x.json'), '--scene', join(sub, '.', 'x.json')],
    ]) {
      const same = await run(args);
      expect([args, same.code]).toEqual([args, 2]);
      expect(same.err).toMatch(/^usage: deckback /);
    }
  }, 60_000);

  it('--scene is written with the others or not at all', async () => {
    const converted = await convert(new Uint8Array(readFileSync(PDF)), { scene: true });
    const deps = { convert: () => Promise.resolve(converted) };
    const sub = mkdtempSync(join(dir, 'scene-atomic-'));
    const failed = { code: 4, out: '', err: `deckback: cannot convert ${pdf}\n` };
    expect(await run([pdf, '-o', join(sub, 'a.pptx'), '--scene', join(sub, 'no', 'such', 's.json')], deps)).toEqual(failed);
    expect(readdirSync(sub)).toEqual([]);
    expect(await run([pdf, '-o', join(sub, 'no', 'such', 'a.pptx'), '--scene', join(sub, 's.json')], deps)).toEqual(failed);
    expect(readdirSync(sub)).toEqual([]);
  }, 60_000);

  it('--font-map (a JSON file, or inline A=B;C=D) gives convert() the same bytes as convert() with that map', async () => {
    const input = new Uint8Array(readFileSync(PDF));
    const expected = await convert(input, { fontMap: { Pretendard: 'Arial', 'Gothic A1': 'Malgun Gothic' } });
    expect(expected.pptx).not.toEqual((await convert(input)).pptx); // the map does something to this deck
    const mapFile = join(dir, 'map.json');
    writeFileSync(mapFile, JSON.stringify({ Pretendard: 'Arial', 'Gothic A1': 'Malgun Gothic' }));
    const fromFile = join(dir, 'from-file.pptx');
    const fromInline = join(dir, 'from-inline.pptx');
    expect((await run([pdf, '--font-map', mapFile, '-o', fromFile])).code).toBe(0);
    expect((await run([pdf, '--font-map', 'Pretendard=Arial;Gothic A1=Malgun Gothic', '-o', fromInline])).code).toBe(0);
    expect(new Uint8Array(readFileSync(fromFile))).toEqual(expected.pptx);
    expect(new Uint8Array(readFileSync(fromInline))).toEqual(expected.pptx);
  }, 60_000);

  it('--font-map: an empty map is a no-op; an existing file wins over an inline reading; bad maps are exit 2', async () => {
    const { asked, deps } = spy();
    const empty = join(dir, 'empty-map.json');
    writeFileSync(empty, '{}');
    expect((await run([pdf, '--font-map', empty, '-o', join(dir, 'e.pptx')], deps)).code).toBe(0);
    expect(asked).toEqual([{ embedFonts: false }]);
    // a file whose name has an "=" in it is read as a file
    const odd = join(dir, 'a=b.json');
    writeFileSync(odd, JSON.stringify({ Pretendard: 'Arial' }));
    expect((await run([pdf, '--font-map', odd, '-o', join(dir, 'o.pptx')], deps)).code).toBe(0);
    expect(asked.at(-1)).toEqual({ embedFonts: false, fontMap: { Pretendard: 'Arial' } });

    const write = (name: string, text: string): string => {
      const file = join(dir, name);
      writeFileSync(file, text);
      return file;
    };
    for (const value of [
      write('bad.json', '{not json'),
      write('num.json', '{"A": 1}'),
      write('arr.json', '["A"]'),
      write('null.json', 'null'),
      write('blank.json', '{"A": " "}'),
      join(dir, 'missing-map.json'),
      'A=',
      '=B',
      'A=B;;C=D',
      'A=B;C',
      '',
    ]) await bad([pdf, '--font-map', value], /--font-map/);
  }, 60_000);

  it('Windows-style paths with spaces and Korean characters read and write correctly', async () => {
    const sub = join(dir, '바탕 화면');
    mkdirSync(sub);
    const input = join(sub, '발표 자료.pdf');
    writeFileSync(input, readFileSync(PDF));
    const [pptx, report, scene] = [join(sub, '결과 파일.pptx'), join(sub, '보고서 1.json'), join(sub, '장면 1.json')];
    const map = join(sub, '글꼴 표.json');
    writeFileSync(map, JSON.stringify({ Pretendard: 'Arial' }));
    const r = await run([input, '-o', pptx, '--report', report, '--scene', scene, '--font-map', map, '--pages', '1-2']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const expected = await convert(new Uint8Array(readFileSync(PDF)), { pages: [0, 1], fontMap: { Pretendard: 'Arial' }, scene: true });
    expect(new Uint8Array(readFileSync(pptx))).toEqual(expected.pptx);
    expect(readFileSync(scene, 'utf8')).toBe(canonicalJson(expected.scene));
    expect(readdirSync(sub).sort()).toEqual(['결과 파일.pptx', '발표 자료.pdf', '보고서 1.json', '글꼴 표.json', '장면 1.json'].sort());
    // and an error names the user's path as given
    const missing = join(sub, '없는 파일.pdf');
    expect(await run([missing, '-o', pptx])).toEqual({ code: 3, out: '', err: `deckback: cannot read ${missing}\n` });
  }, 60_000);
});

function fileUrl(url: URL): string {
  return decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:)/, '');
}

describe('deckback CLI: never overwrite the input, and small clean-ups (M7 Task 2)', () => {
  const pdf = fileUrl(PDF);
  const exit2 = async (args: string[], message: RegExp): Promise<void> => {
    const { code, out, err } = await run(args);
    expect([args, code]).toEqual([args, 2]);
    expect(out).toBe('');
    expect(err).toMatch(/^usage: deckback /);
    expect(err).toMatch(message);
  };

  it('-o, --report or --scene at the input path is exit 2 and the input is untouched', async () => {
    const sub = mkdtempSync(join(dir, 'same-'));
    const input = join(sub, 'in.pdf');
    writeFileSync(input, readFileSync(pdf));
    const before = readFileSync(input);
    const other = join(sub, 'other');
    for (const args of [
      [input, '-o', input],
      [input, '-o', other, '--report', input],
      [input, '-o', other, '--scene', input],
      [input, '-o', join(sub, '.', 'in.pdf')], // the same file by another spelling
      [input, '-o', join(sub, 'x', '..', 'in.pdf')],
    ]) await exit2(args, /input/);
    if (process.platform === 'win32') await exit2([input, '-o', input.toUpperCase()], /input/);
    expect(readFileSync(input).equals(before)).toBe(true);
    expect(readdirSync(sub)).toEqual(['in.pdf']);
  }, 60_000);

  it('--help documents -h and that a repeated value option is exit 2', async () => {
    const { out } = await run(['--help']);
    expect(out).toMatch(/-h\b/);
    expect(out).toMatch(/twice|more than once|repeat/i);
    await exit2([pdf, '-o', join(dir, 'r1.pptx'), '-o', join(dir, 'r2.pptx')], /twice/);
  });

  it('--pages 01, " 1" and a ten-digit page are exit 2', async () => {
    for (const list of ['01', ' 1', '1 ', '1234567890', '1-1234567890']) await exit2([pdf, '--pages', list, '-o', join(dir, 'p.pptx')], /--pages/);
  }, 60_000);

  it('a JSON --font-map is trimmed like an inline one; a file over 1 MB is exit 2', async () => {
    const asked: unknown[] = [];
    const deps = { convert: (bytes: Uint8Array, opts?: Parameters<typeof convert>[1]) => (asked.push(opts), convert(bytes, opts)) };
    const map = join(dir, 'trim-map.json');
    writeFileSync(map, JSON.stringify({ ' Pretendard ': ' Arial ' }));
    expect((await run([pdf, '--font-map', map, '-o', join(dir, 'trim.pptx')], deps)).code).toBe(0);
    expect(asked.at(-1)).toMatchObject({ fontMap: { Pretendard: 'Arial' } });
    const big = join(dir, 'big-map.json');
    writeFileSync(big, JSON.stringify({ A: 'B'.repeat(1024 * 1024 + 1) }));
    await exit2([pdf, '--font-map', big, '-o', join(dir, 'big.pptx')], /--font-map.*1 MB/);
  }, 60_000);
});
