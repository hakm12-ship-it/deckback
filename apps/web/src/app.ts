import type { Report } from '@deckback/core';
import { canvasMeasure, installedChecker } from './fonts-check';
import { initialLang, LANG_STORAGE_KEY, t, type Key, type Lang } from './i18n';
import { isWorkerReply, type ErrorKind, type PptxRequest, type WorkerReply } from './protocol';
import { makeWorker } from './make-worker';
import { fontMapFor, h, nothingConverted, renderReport, reportView, substituteSelect, type FontRow } from './report-panel';

export { makeWorker };

/**
 * The website (spec §3): a PDF dropped on the page or chosen is converted in a worker, with progress and a Cancel; the
 * PPTX is offered for download with the report panel beside it. Everything stays in this page: the file's bytes go to
 * the worker and back, never into a request, and its name only into the download's name (Global Constraints, Privacy).
 * Nothing here logs.
 */

export const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** The download's name, made here from the chosen file's: its name without `.pdf` (any case), then `.pptx`. */
export function downloadName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const stem = base.replace(/\.pdf$/i, '');
  return `${stem.trim() === '' ? 'deckback' : stem}.pptx`;
}

/** How a conversion ended, as the page shows it. */
export type Outcome = { type: 'done'; pptx: Uint8Array; report: Report } | { type: 'failed'; kind: ErrorKind } | { type: 'cancelled' };

/** The largest file the page takes: it is read into memory, twice over (the page keeps it for a font choice). */
export const MAX_FILE_BYTES = 200 * 1024 * 1024;

function outcomeOf(reply: WorkerReply): Outcome {
  if (reply.type === 'pptx') return { type: 'done', pptx: reply.pptx, report: reply.report };
  if (reply.type === 'failed') return { type: 'failed', kind: reply.kind };
  return { type: 'failed', kind: 'failed' }; // a reply that could not be sent (`error`), whose message is not shown
}

/**
 * One conversion at a time, each in a worker of its own. `cancel` (and a new `convert` while one runs) terminates the worker,
 * which stops the work at once and frees its memory; so does a conversion that ends, whatever its outcome, so nothing of
 * one file (pdf.js' caches, its memory) is alive for the next, and the next conversion makes a fresh worker (Review Focus 1).
 */
export class Converter {
  private worker: Worker | null = null;
  private running: { resolve: (outcome: Outcome) => void; onProgress: (done: number, total: number) => void; started: boolean } | null = null;

  constructor(private readonly spawn: () => Worker = makeWorker) {}

  /** Converts `bytes` (transferred) with `fontMap`; `onProgress` as `ConvertOptions.onProgress`. */
  convert(bytes: ArrayBuffer, fontMap: Record<string, string>, onProgress: (done: number, total: number) => void): Promise<Outcome> {
    this.cancel();
    this.worker ??= this.listen(this.spawn());
    const worker = this.worker;
    return new Promise((resolve) => {
      this.running = { resolve, onProgress, started: false };
      const request: PptxRequest = { type: 'pptx', bytes, fontMap };
      worker.postMessage(request, [bytes]);
    });
  }

  /** Stops the conversion that runs, if one does: it ends `cancelled`. */
  cancel(): void {
    if (this.running === null) return;
    this.stop();
    this.finish({ type: 'cancelled' });
  }

  private stop(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private finish(outcome: Outcome): void {
    const running = this.running;
    this.running = null;
    running?.resolve(outcome);
  }

  private listen(worker: Worker): Worker {
    worker.addEventListener('message', (event: MessageEvent<unknown>) => {
      if (worker !== this.worker || this.running === null || !isWorkerReply(event.data)) return;
      const reply = event.data;
      if (reply.type === 'progress') {
        this.running.started = true;
        this.running.onProgress(reply.done, reply.total);
        return;
      }
      this.stop(); // done with this file: the worker goes with it
      this.finish(outcomeOf(reply));
    });
    // The worker failed to start, or died: after it had started on the file, most likely of its size (memory).
    const broken = (event: Event): void => {
      event.preventDefault();
      if (worker !== this.worker) return;
      const started = this.running?.started ?? false;
      this.stop();
      this.finish({ type: 'failed', kind: started ? 'too-complex' : 'failed' });
    };
    worker.addEventListener('error', broken);
    worker.addEventListener('messageerror', broken);
    return worker;
  }
}

/** The page's elements, by id (index.html). */
function elements(doc: Document) {
  const get = <T extends HTMLElement>(id: string): T => {
    const el = doc.getElementById(id);
    if (el === null) throw new Error(`index.html has no #${id}`);
    return el as T;
  };
  return {
    lang: get<HTMLButtonElement>('lang'),
    drop: get('drop'),
    dropTitle: get('drop-title'),
    choose: get<HTMLButtonElement>('choose'),
    file: get<HTMLInputElement>('file'),
    progress: get('progress'),
    progressText: get('progress-text'),
    progressBar: get<HTMLProgressElement>('progress-bar'),
    progressLive: get('progress-live'),
    cancel: get<HTMLButtonElement>('cancel'),
    status: get('status'),
    outcome: get('outcome'),
    outcomeTitle: get('outcome-title'),
    download: get<HTMLAnchorElement>('download'),
    downloadName: get('download-name'),
    report: get('report'),
  };
}

/** How long a font choice waits for another before it converts again (arrow keys on a closed select fire `change`). */
const CHOICE_SETTLE_MS = 350;

/** The language stored before, where the browser lets the page read it. */
function storedLang(): string | null {
  try {
    return localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    return null;
  }
}

function storeLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang);
  } catch {
    // the choice holds for this visit only
  }
}

/** What the page needs of its converter (a fake stands in for it in the tests). */
export type ConverterLike = Pick<Converter, 'convert' | 'cancel'>;

/** Starts the website on `doc` (index.html). */
export function startApp(doc: Document = document, converter: ConverterLike = new Converter()): void {
  const el = elements(doc);
  const installed = installedChecker(canvasMeasure(doc));

  let lang: Lang = initialLang(storedLang(), [navigator.language, ...(navigator.languages ?? [])]);
  /** The file chosen: its name (for the download's) and its bytes, kept to convert again with another font map. */
  let file: { name: string; bytes: ArrayBuffer } | null = null;
  let converting = false;
  /** A chosen file is being read into memory (the conversion starts when it has been). */
  let reading = false;
  /** The last `onProgress` of the conversion that runs; null before its first. */
  let progress: { done: number; total: number } | null = null;
  let message: { key: Key; error: ErrorKind | 'read' | 'too-large' | null } | null = null;
  /** The result shown, and the substitutes it was converted with. */
  let result: { report: Report; url: string; choices: Map<string, string> } | null = null;
  /** The substitutes chosen (a family to a substitute's label), and the rows they were chosen in. */
  let choices = new Map<string, string>();
  let rows: FontRow[] = [];
  let run = 0;
  /** The file pick that counts: a newer pick makes an older one's read a stale one, dropped when it ends. */
  let pick = 0;
  /** What the polite live region says now, so that it is written at coarse steps only (a screen reader hears each write). */
  let announced = '';
  let settle: ReturnType<typeof setTimeout> | undefined;

  // --- showing ------------------------------------------------------------------------------------------------------

  function showStatic(): void {
    doc.documentElement.lang = lang;
    doc.title = t(lang, 'meta.title');
    for (const node of doc.querySelectorAll<HTMLElement>('[data-i18n]')) node.textContent = t(lang, node.dataset.i18n as Key);
    el.lang.textContent = t(lang, 'lang.other');
    el.lang.lang = lang === 'ko' ? 'en' : 'ko';
    el.progressBar.setAttribute('aria-label', t(lang, 'progress.label'));
    showDropTitle();
  }

  function showDropTitle(): void {
    el.dropTitle.textContent = t(lang, el.drop.classList.contains('dragging') ? 'drop.active' : 'drop.title');
  }

  /** The live region's text: the first words, then every tenth of the slides (not every slide). */
  function announce(text: string, step: number): void {
    const key = `${lang}:${step}`;
    if (key === announced) return;
    announced = key;
    el.progressLive.textContent = text;
  }

  function showProgress(): void {
    el.progress.hidden = !(converting || reading);
    if (!(converting || reading)) {
      announced = '';
      el.progressLive.textContent = '';
      return;
    }
    if (progress === null) {
      el.progressText.textContent = t(lang, 'progress.opening');
      announce(t(lang, 'progress.opening'), -1);
      el.progressBar.removeAttribute('value'); // indeterminate while the PDF opens
      el.progress.removeAttribute('data-done');
      el.progress.removeAttribute('data-total');
      return;
    }
    el.progressText.textContent = t(lang, 'progress.slides', { done: progress.done, total: progress.total });
    el.progressBar.max = Math.max(progress.total, 1);
    el.progressBar.value = progress.done;
    el.progress.dataset.done = String(progress.done);
    el.progress.dataset.total = String(progress.total);
    announce(el.progressText.textContent ?? '', Math.floor((progress.done * 10) / Math.max(progress.total, 1)));
  }

  function showMessage(): void {
    el.status.replaceChildren();
    if (message === null) return;
    const text = t(lang, message.key);
    el.status.append(message.error === null ? h('p', { class: 'info' }, text) : h('p', { class: 'alert', role: 'alert', 'data-error': message.error }, text));
  }

  function showResult(focus: 'title' | { family: string } | null): void {
    el.outcome.hidden = result === null;
    if (result === null || file === null) return;
    const view = reportView(result.report, lang, installed);
    rows = view.fonts;
    el.download.href = result.url;
    el.download.download = downloadName(file.name);
    el.downloadName.textContent = downloadName(file.name);
    el.report.replaceChildren(renderReport(view, { lang, choices, onChoose: choose }));
    if (focus === 'title') el.outcomeTitle.focus();
    else if (focus !== null) substituteSelect(el.report, focus.family)?.focus();
  }

  /** A result converted again for a font choice stays shown, dimmed, until the new one replaces it. */
  function setStale(on: boolean): void {
    el.outcome.classList.toggle('stale', on);
    el.outcome.setAttribute('aria-busy', String(on));
  }

  // --- converting ---------------------------------------------------------------------------------------------------

  function clearResult(): void {
    if (result !== null) URL.revokeObjectURL(result.url);
    result = null;
    el.download.removeAttribute('href');
    showResult(null);
  }

  /** Converts the chosen file with the substitutes chosen; `again` for a new font choice (the result stays, dimmed). */
  async function convert(again: { family: string } | null): Promise<void> {
    if (file === null) return;
    const mine = ++run;
    message = null;
    progress = null;
    showMessage();
    if (again === null) clearResult();
    setStale(again !== null);
    converting = true;
    showProgress();
    const used = new Map(choices);
    const outcome = await converter.convert(file.bytes.slice(0), fontMapFor(rows, used), (done, total) => {
      if (mine !== run) return;
      progress = { done, total };
      showProgress();
    });
    if (mine !== run) return; // a newer conversion took over
    progress = null;
    converting = false;
    showProgress();
    setStale(false);
    if (doc.activeElement === el.cancel) el.choose.focus(); // Cancel is hidden with the progress: focus must not fall to the page

    if (outcome.type === 'done' && !nothingConverted(outcome.report)) {
      if (result !== null) URL.revokeObjectURL(result.url);
      const blob = new Blob([outcome.pptx as Uint8Array<ArrayBuffer>], { type: PPTX_MIME });
      result = { report: outcome.report, url: URL.createObjectURL(blob), choices: used };
      showResult(again ?? 'title'); // `choices` stays as the user has it: a pick made while this converted is not undone
      return;
    }
    if (outcome.type === 'cancelled') message = { key: 'status.cancelled', error: null };
    else message = { key: `error.${outcome.type === 'done' ? 'damaged' : outcome.kind}`, error: outcome.type === 'done' ? 'damaged' : outcome.kind };
    showMessage();
    if (again !== null && result !== null) {
      if (settle === undefined) choices = new Map(result.choices); // the result shown is still the one converted before the choice (a newer pick, waiting to convert, stays)
      showResult(again);
    } else {
      clearResult();
    }
  }

  async function take(chosen: File | undefined): Promise<void> {
    if (chosen === undefined) return;
    const mine = ++pick;
    if (chosen.size > MAX_FILE_BYTES) return void refuse('error.too-large', 'too-large');
    // Reading comes first and changes nothing: the conversion that runs (if one does) goes on, with its progress and its
    // Cancel, until the bytes are in hand. Only then is it replaced. A read that fails ends in the page reset, with fixed words.
    reading = true;
    message = null;
    showMessage();
    showProgress();
    let bytes: ArrayBuffer;
    try {
      bytes = await chosen.arrayBuffer();
    } catch {
      if (mine === pick) refuse('error.read', 'read');
      return;
    }
    if (mine !== pick) return; // a newer pick, or Cancel, came while this was read
    reading = false;
    clearTimeout(settle);
    settle = undefined;
    converter.cancel();
    run++;
    file = { name: chosen.name, bytes };
    choices = new Map();
    rows = [];
    await convert(null);
  }

  /** The chosen file cannot be taken: whatever ran or showed is stopped and cleared, and `key` says why. */
  function refuse(key: Key, error: 'read' | 'too-large'): void {
    clearTimeout(settle);
    settle = undefined;
    converter.cancel();
    run++;
    converting = false;
    reading = false;
    progress = null;
    file = null;
    choices = new Map();
    rows = [];
    setStale(false);
    clearResult();
    showProgress();
    message = { key, error };
    showMessage();
  }

  function choose(family: string, label: string): void {
    if (label === '') choices.delete(family);
    else choices.set(family, label);
    clearTimeout(settle);
    settle = setTimeout(() => {
      settle = undefined;
      void convert({ family });
    }, CHOICE_SETTLE_MS);
  }

  // --- wiring -------------------------------------------------------------------------------------------------------

  el.lang.addEventListener('click', () => {
    lang = lang === 'ko' ? 'en' : 'ko';
    storeLang(lang);
    showStatic();
    showProgress();
    showMessage();
    showResult(null);
  });

  el.choose.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    const chosen = el.file.files?.[0];
    el.file.value = ''; // so choosing the same file again converts it again
    void take(chosen);
  });

  el.cancel.addEventListener('click', () => {
    clearTimeout(settle);
    settle = undefined;
    const wasReading = reading;
    pick++; // a file still being read is dropped when its read ends
    reading = false;
    converter.cancel();
    if (wasReading) {
      message = { key: 'status.cancelled', error: null };
      showMessage();
    }
    showProgress();
    el.choose.focus();
  });

  // Drop anywhere on the page; dropping a file must never open it in the tab instead.
  const hasFiles = (event: DragEvent): boolean => event.dataTransfer?.types.includes('Files') ?? false;
  const dragging = (on: boolean): void => {
    el.drop.classList.toggle('dragging', on);
    showDropTitle();
  };
  doc.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy';
    if (!el.drop.classList.contains('dragging')) dragging(true);
  });
  doc.addEventListener('dragleave', (event) => {
    if (event.relatedTarget === null) dragging(false); // left the window
  });
  doc.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragging(false);
    void take(event.dataTransfer?.files[0]);
  });

  showStatic();
}
