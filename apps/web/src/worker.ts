import { convert, extractScene, inventoryOfDocument, sceneHash, useBrowserPdfjs } from '@deckback/core';
import { CMAPS_PATH, errorKind, type WorkerReply, type WorkerRequest } from './protocol';
import { serveInOrder } from './serve';

declare const self: DedicatedWorkerGlobalScope;

// The file is converted here, in this worker; pdf.js runs in this same thread. Nothing is sent anywhere.
useBrowserPdfjs(new URL(`${import.meta.env.BASE_URL}${CMAPS_PATH}`, self.location.href).href);

const E2E = import.meta.env.VITE_E2E === '1';

if (E2E) {
  // The e2e build only (the production build drops this): reports each CSP violation of this worker to the site, where the e2e
  // reads it (site-hardening.spec.ts). The page cannot hear a worker's violations, and the worker may be ended at once.
  self.addEventListener('securitypolicyviolation', (violation) => {
    const event = violation as Event & { effectiveDirective: string; blockedURI: string };
    void fetch(`${import.meta.env.BASE_URL}__csp-violation`, { method: 'POST', body: `${event.effectiveDirective} ${event.blockedURI}` }).catch(() => undefined);
  });
}

/** The SHA-256 of `bytes`, lower-case hex: computed again here, so the reply vouches for the bytes, not only their keys. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function handle(request: WorkerRequest): Promise<WorkerReply> {
  switch (request.type) {
    case 'inventory': {
      if (!E2E) throw new Error('the test page requests are in the e2e build only');
      const { inventory, perPageMs } = await inventoryOfDocument(new Uint8Array(request.bytes), request.pages);
      return { type: 'result', inventory, perPageMs };
    }
    case 'scene': {
      if (!E2E) throw new Error('the test page requests are in the e2e build only');
      // The Scene and the media stay here: the reply carries their hashes only.
      const { scene, media } = await extractScene(new Uint8Array(request.bytes), { pages: request.pages });
      const mediaHashes: string[] = [];
      for (const bytes of media.values()) mediaHashes.push(await sha256(bytes));
      return { type: 'scene', hash: await sceneHash(scene), mediaHashes };
    }
    case 'convert': {
      if (!E2E) throw new Error('the test page requests are in the e2e build only');
      // The PPTX and the report stay here: the reply carries their hashes and the PPTX's length only.
      const { pptx, report } = await convert(new Uint8Array(request.bytes), { pages: request.pages });
      return { type: 'convert', pptxHash: await sha256(pptx), pptxBytes: pptx.length, reportHash: await sceneHash(report) };
    }
    case 'pptx': {
      // The website's conversion (M6): progress after each slide, then the PPTX and the report, which stay in the page.
      // An error is answered by its kind only (`errorKind`): its message could quote the file. Cancel terminates this
      // worker (app.ts), so nothing here waits for it.
      const bytes = new Uint8Array(request.bytes);
      const fontMap = Object.keys(request.fontMap).length > 0 ? { fontMap: request.fontMap } : {};
      const onProgress = (done: number, total: number): void => self.postMessage({ type: 'progress', done, total } satisfies WorkerReply);
      try {
        const { pptx, report } = await convert(bytes, { onProgress, ...fontMap });
        // the reply transfers the PPTX's buffer, so it must hold the PPTX and nothing else
        const own = pptx.byteOffset === 0 && pptx.byteLength === pptx.buffer.byteLength ? pptx : pptx.slice();
        return { type: 'pptx', pptx: own, report };
      } catch (error) {
        return { type: 'failed', kind: errorKind(error, bytes) };
      }
    }
    default:
      throw new Error(`unknown request type: ${String((request as { type?: unknown }).type)}`);
  }
}

// One request at a time, in order of arrival (pages inside a request are walked one at a time too).
const serve = serveInOrder(handle, (reply) => self.postMessage(reply, reply.type === 'pptx' ? [reply.pptx.buffer as ArrayBuffer] : []));
self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => void serve(event.data));
