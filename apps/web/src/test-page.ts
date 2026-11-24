import { makeWorker } from './make-worker';
import { isWorkerReply, requestFor, type WorkerReply } from './protocol';

/**
 * The e2e's test page (`/test.html?request=...`), built only when the e2e builds the site (`VITE_E2E=1`, vite.config.ts):
 * the production build has no such page (ruling M6-R3). The worker is made at once (the perf and memory specs attach to
 * it before choosing), a file chosen in `#file` goes to it as the query asks (`requestFor`), and each reply is written
 * into `#result` as JSON: hashes and an inventory, never a PPTX or a report.
 */
const input = document.querySelector<HTMLInputElement>('#file')!;
const result = document.createElement('pre');
result.id = 'result';
document.body.append(result);

const worker = makeWorker();
const show = (reply: WorkerReply): void => {
  result.textContent = JSON.stringify(reply);
};
worker.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (isWorkerReply(event.data)) show(event.data);
});
worker.addEventListener('error', (event) => show({ type: 'error', message: `worker: ${event.message || 'failed to start'}` }));

input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (file === undefined) return;
  result.textContent = '';
  const bytes = await file.arrayBuffer();
  // The inventory of every page, unless the page's address asks otherwise (`?request=scene&pages=0,1`): see requestFor.
  worker.postMessage(requestFor(location.search, bytes), [bytes]);
});
