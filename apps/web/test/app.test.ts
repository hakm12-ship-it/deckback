// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Report } from '@deckback/core';
import { Converter, MAX_FILE_BYTES, startApp, type ConverterLike, type Outcome } from '../src/app';
import { LANG_STORAGE_KEY, MESSAGES } from '../src/i18n';
import { emptyReport } from './report-fixture';

const ko = MESSAGES.ko;
const en = MESSAGES.en;

// --- a fake converter: each convert() waits until the test settles it ----------------------------------------------------

interface Call {
  bytes: ArrayBuffer;
  fontMap: Record<string, string>;
  onProgress: (done: number, total: number) => void;
  settle: (outcome: Outcome) => void;
  settled: boolean;
}

function fakeConverter(): ConverterLike & { calls: Call[]; cancels: () => number } {
  const calls: Call[] = [];
  let cancels = 0;
  return {
    calls,
    cancels: () => cancels,
    convert: (bytes, fontMap, onProgress) =>
      new Promise<Outcome>((resolve) => {
        const call: Call = { bytes, fontMap, onProgress, settled: false, settle: (outcome) => ((call.settled = true), resolve(outcome)) };
        calls.push(call);
      }),
    cancel: () => {
      cancels++;
      const running = calls.at(-1);
      if (running !== undefined && !running.settled) running.settle({ type: 'cancelled' }); // as Converter does
    },
  };
}

// --- files whose read the test controls ---------------------------------------------------------------------------------

interface Pending {
  file: File;
  resolve: () => void;
  reject: () => void;
  read: () => boolean;
}

/** A file of `size` bytes (as `File.size` says) whose `arrayBuffer()` settles when the test says; `first` is its first byte. */
function pendingFile(name: string, first: number, size = 8): Pending {
  let resolve!: () => void;
  let reject!: () => void;
  let read = false;
  const promise = new Promise<ArrayBuffer>((res, rej) => {
    resolve = () => res(new Uint8Array([first, 0, 0, 0]).buffer);
    reject = () => rej(new Error('the file is gone: C:\\secret\\name.pdf'));
  });
  const file = { name, size, arrayBuffer: () => ((read = true), promise) } as unknown as File;
  return { file, resolve, reject, read: () => read };
}

const readyFile = (name: string, first: number): File => {
  const p = pendingFile(name, first);
  p.resolve();
  return p.file;
};

// --- the page -----------------------------------------------------------------------------------------------------------

let doc: Document;
const el = <T extends HTMLElement = HTMLElement>(id: string): T => doc.getElementById(id) as T;

/** index.html's body in a fresh document, with the website started on it. */
function open(converter: ConverterLike): void {
  const html = readFileSync(join(import.meta.dirname, '../index.html'), 'utf8');
  const body = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/g, '');
  doc = document.implementation.createHTMLDocument('deckback');
  doc.body.innerHTML = body;
  startApp(doc, converter);
}

function drop(file: File): void {
  const event = new Event('drop', { cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files: [file] } });
  doc.dispatchEvent(event);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const alertOf = (): HTMLElement | null => el('status').querySelector('[role="alert"]');
const visible = (id: string): boolean => !el(id).hidden;

const done = (report: Report = emptyReport()): Outcome => ({ type: 'done', pptx: new Uint8Array([1]), report });

beforeEach(() => {
  // the page's font check draws in a canvas: here every width is the same, so every font reads as not installed
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => ({ font: '', measureText: () => ({ width: 10 }) })) as never);
  URL.createObjectURL = () => 'blob:test';
  URL.revokeObjectURL = () => undefined;
  localStorage.setItem(LANG_STORAGE_KEY, 'ko');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('choosing a file: the read comes first and changes nothing', () => {
  it('the conversion that runs goes on, with its progress, until the new file has been read; then it is replaced', async () => {
    const converter = fakeConverter();
    open(converter);
    drop(readyFile('a.pdf', 1));
    await tick();
    expect(converter.calls).toHaveLength(1);
    converter.calls[0]!.onProgress(5, 150);
    expect(el('progress-text').textContent).toBe('슬라이드 5/150 변환 중');

    const cancelsBefore = converter.cancels();
    const b = pendingFile('b.pdf', 2);
    drop(b.file);
    await tick();
    expect(b.read()).toBe(true);
    expect(converter.cancels()).toBe(cancelsBefore); // not cancelled while the new file is being read
    expect(visible('progress')).toBe(true);
    expect(el('progress-text').textContent).toBe('슬라이드 5/150 변환 중');
    expect(converter.calls).toHaveLength(1);

    b.resolve();
    await tick();
    expect(converter.cancels()).toBe(cancelsBefore + 1);
    expect(converter.calls).toHaveLength(2);
    expect(new Uint8Array(converter.calls[1]!.bytes)[0]).toBe(2);
    expect(alertOf()).toBeNull(); // the replaced run's "cancelled" is not shown: the new one took over
    expect(el('progress-text').textContent).toBe(ko['progress.opening']);
  });

  it('a read that fails shows the fixed words, resets the page, and never starts a conversion', async () => {
    const converter = fakeConverter();
    open(converter);
    drop(readyFile('a.pdf', 1));
    await tick();
    converter.calls[0]!.settle(done());
    await tick();
    expect(visible('outcome')).toBe(true);

    const gone = pendingFile('gone.pdf', 9);
    drop(gone.file);
    await tick();
    expect(visible('progress')).toBe(true); // reading
    gone.reject();
    await tick();

    expect(alertOf()!.textContent).toBe(ko['error.read']);
    expect(alertOf()!.getAttribute('data-error')).toBe('read');
    expect(alertOf()!.textContent).not.toContain('secret'); // the error's own words are not shown
    expect(visible('progress')).toBe(false);
    expect(visible('outcome')).toBe(false);
    expect(converter.calls).toHaveLength(1); // nothing was started for the file that could not be read
    // and the page works again: the next file converts
    drop(readyFile('c.pdf', 3));
    await tick();
    expect(converter.calls).toHaveLength(2);
    expect(alertOf()).toBeNull();
  });

  it('a read that fails while a conversion runs stops that conversion too', async () => {
    const converter = fakeConverter();
    open(converter);
    drop(readyFile('a.pdf', 1));
    await tick();
    const cancelsBefore = converter.cancels();
    const gone = pendingFile('gone.pdf', 9);
    drop(gone.file);
    await tick();
    expect(converter.cancels()).toBe(cancelsBefore); // not while it reads
    gone.reject();
    await tick();
    expect(converter.cancels()).toBe(cancelsBefore + 1);
    expect(visible('progress')).toBe(false);
    expect(alertOf()!.textContent).toBe(ko['error.read']);
  });

  it('Cancel works during a long read: the progress goes, and the file is dropped when its read ends', async () => {
    const converter = fakeConverter();
    open(converter);
    const slow = pendingFile('slow.pdf', 1);
    drop(slow.file);
    await tick();
    expect(visible('progress')).toBe(true);
    expect(el('progress-text').textContent).toBe(ko['progress.opening']);

    el('cancel').click();
    expect(visible('progress')).toBe(false);
    expect(el('status').textContent).toBe(ko['status.cancelled']);

    slow.resolve();
    await tick();
    expect(converter.calls).toHaveLength(0);
    expect(visible('progress')).toBe(false);
  });

  it('two quick picks: the last one wins, in whichever order the reads end', async () => {
    for (const order of [['b', 'a'], ['a', 'b']] as const) {
      const converter = fakeConverter();
      open(converter);
      const a = pendingFile('a.pdf', 1);
      const b = pendingFile('b.pdf', 2);
      drop(a.file);
      drop(b.file);
      await tick();
      for (const which of order) (which === 'a' ? a : b).resolve();
      await tick();
      expect(converter.calls, order.join()).toHaveLength(1);
      expect(new Uint8Array(converter.calls[0]!.bytes)[0], order.join()).toBe(2);
      expect(el('download-name').textContent).toBe('');
      converter.calls[0]!.settle(done());
      await tick();
      expect(el('download-name').textContent, order.join()).toBe('b.pptx'); // the stale one's name never shows
    }
  });
});

describe('the size guard', () => {
  it('refuses a file over 200 MB with fixed words in both languages, without reading it', async () => {
    const converter = fakeConverter();
    open(converter);
    const big = pendingFile('big.pdf', 1, MAX_FILE_BYTES + 1);
    drop(big.file);
    await tick();
    expect(big.read()).toBe(false);
    expect(alertOf()!.textContent).toBe(ko['error.too-large']);
    expect(alertOf()!.getAttribute('data-error')).toBe('too-large');
    expect(converter.calls).toHaveLength(0);
    expect(visible('progress')).toBe(false);

    el('lang').click(); // English
    expect(alertOf()!.textContent).toBe(en['error.too-large']);
    expect(en['error.too-large']).toContain('200 MB');
    expect(ko['error.too-large']).toContain('200MB');
  });

  it('takes a file of exactly 200 MB', async () => {
    const converter = fakeConverter();
    open(converter);
    const edge = pendingFile('edge.pdf', 1, MAX_FILE_BYTES);
    edge.resolve();
    drop(edge.file);
    await tick();
    expect(converter.calls).toHaveLength(1);
  });
});

describe('a font choice made while the one before it converts', () => {
  it('is not undone when that one finishes: the next conversion has both', async () => {
    vi.useFakeTimers();
    const converter = fakeConverter();
    open(converter);
    const report: Report = {
      ...emptyReport(),
      fonts: ['Zed', 'Yak'].map((name, i) => ({ key: `f${i}`, latin: name, ea: null, embedded: false, type3: false })),
    };
    drop(readyFile('a.pdf', 1));
    await vi.advanceTimersByTimeAsync(0);
    converter.calls[0]!.settle(done(report));
    await vi.advanceTimersByTimeAsync(0);
    const pick = (family: string, label: string): void => {
      const select = [...el('report').querySelectorAll<HTMLSelectElement>('select')].find((s) => s.getAttribute('data-family') === family)!;
      select.value = label;
      select.dispatchEvent(new Event('change'));
    };

    pick('Zed', 'Arial');
    await vi.advanceTimersByTimeAsync(400);
    expect(converter.calls).toHaveLength(2);
    expect(converter.calls[1]!.fontMap).toEqual({ Zed: 'Arial' });

    pick('Yak', 'Calibri'); // while the conversion for Zed runs
    converter.calls[1]!.settle(done(report));
    await vi.advanceTimersByTimeAsync(0);
    const yak = [...el('report').querySelectorAll<HTMLSelectElement>('select')].find((s) => s.getAttribute('data-family') === 'Yak')!;
    expect(yak.value).toBe('Calibri'); // still chosen after the result for Zed came in

    await vi.advanceTimersByTimeAsync(400);
    expect(converter.calls).toHaveLength(3);
    expect(converter.calls[2]!.fontMap).toEqual({ Zed: 'Arial', Yak: 'Calibri' });
  });
});

describe('progress is announced in a polite live region, at coarse steps', () => {
  it('the region is outside the hidden progress section and says the first words, then about every tenth', async () => {
    const converter = fakeConverter();
    open(converter);
    const live = el('progress-live');
    expect(live.getAttribute('aria-live')).toBe('polite');
    expect(live.closest('#progress')).toBeNull(); // a hidden section is not announced
    drop(readyFile('a.pdf', 1));
    await tick();
    const said: string[] = [live.textContent ?? ''];
    for (let n = 0; n <= 38; n++) {
      converter.calls[0]!.onProgress(n, 38);
      if (live.textContent !== said.at(-1)) said.push(live.textContent ?? '');
    }
    expect(said[0]).toBe(ko['progress.opening']);
    expect(said.length).toBeLessThanOrEqual(12); // not one per slide (39)
    expect(said.at(-1)).toBe('슬라이드 38/38 변환 중');
    converter.calls[0]!.settle(done());
    await tick();
    expect(live.textContent).toBe(''); // and nothing is left to be read after
  });
});

// --- Converter: a worker of its own for each conversion -----------------------------------------------------------------

class FakeWorker extends EventTarget {
  terminated = false;
  posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data }));
  }
}

describe('Converter: a fresh worker for each conversion', () => {
  it('a conversion that ends ends its worker, and the next one makes a new one', async () => {
    const workers: FakeWorker[] = [];
    const converter = new Converter(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const first = converter.convert(new ArrayBuffer(4), {}, () => undefined);
    workers[0]!.reply({ type: 'pptx', pptx: new Uint8Array(1), report: emptyReport() });
    expect((await first).type).toBe('done');
    expect(workers[0]!.terminated).toBe(true);

    const second = converter.convert(new ArrayBuffer(4), {}, () => undefined);
    expect(workers).toHaveLength(2);
    workers[1]!.reply({ type: 'failed', kind: 'damaged' });
    expect(await second).toEqual({ type: 'failed', kind: 'damaged' });
    expect(workers[1]!.terminated).toBe(true);
  });

  it('progress keeps the worker; cancel ends it and the conversion is cancelled', async () => {
    const workers: FakeWorker[] = [];
    const converter = new Converter(() => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    });
    const seen: number[] = [];
    const run = converter.convert(new ArrayBuffer(4), {}, (n) => seen.push(n));
    workers[0]!.reply({ type: 'progress', done: 1, total: 3 });
    expect(workers[0]!.terminated).toBe(false);
    expect(seen).toEqual([1]);
    converter.cancel();
    expect(await run).toEqual({ type: 'cancelled' });
    expect(workers[0]!.terminated).toBe(true);
    workers[0]!.reply({ type: 'pptx', pptx: new Uint8Array(1), report: emptyReport() }); // a late message from the dead worker
    expect(seen).toEqual([1]);
  });
});

describe('focus', () => {
  it('a conversion that fails while focus is on Cancel moves focus to the choose button, not to the page', async () => {
    const converter = fakeConverter();
    open(converter);
    drop(readyFile('a.pdf', 1));
    await tick();
    el('cancel').focus();
    expect(doc.activeElement).toBe(el('cancel'));
    converter.calls[0]!.settle({ type: 'failed', kind: 'failed' });
    await tick();
    expect(visible('progress')).toBe(false);
    expect(doc.activeElement).toBe(el('choose'));
  });
});
