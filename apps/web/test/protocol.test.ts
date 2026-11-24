import { describe, expect, it } from 'vitest';
import { errorKind, isWorkerReply, looksLikePdf, requestFor } from '../src/protocol';

describe('requestFor (what main.ts sends the worker for a chosen file)', () => {
  const bytes = new ArrayBuffer(4);

  it('asks for the inventory of every page by default', () => {
    expect(requestFor('', bytes)).toEqual({ type: 'inventory', bytes, pages: [] });
    expect(requestFor('?request=inventory&pages=2', bytes)).toEqual({ type: 'inventory', bytes, pages: [2] });
  });

  it('asks for the Scene with ?request=scene, of the 0-based pages listed in ?pages', () => {
    expect(requestFor('?request=scene', bytes)).toEqual({ type: 'scene', bytes, pages: [] });
    expect(requestFor('?request=scene&pages=0,1,2,3,4,5,6,7', bytes)).toEqual({ type: 'scene', bytes, pages: [0, 1, 2, 3, 4, 5, 6, 7] });
    expect(requestFor('?pages=&request=scene', bytes)).toEqual({ type: 'scene', bytes, pages: [] });
  });

  it('asks for the PPTX with ?request=convert, of the pages listed', () => {
    expect(requestFor('?request=convert', bytes)).toEqual({ type: 'convert', bytes, pages: [] });
    expect(requestFor('?request=convert&pages=2,0', bytes)).toEqual({ type: 'convert', bytes, pages: [2, 0] });
    expect(requestFor('?request=pptx', bytes)).toEqual({ type: 'inventory', bytes, pages: [] });
  });

  it('passes a page list it cannot read on as it is, for the worker to refuse', () => {
    expect(requestFor('?request=scene&pages=1,x', bytes).pages).toEqual([1, Number.NaN]);
  });
});

describe('isWorkerReply', () => {
  it('knows the four replies and nothing else', () => {
    expect(isWorkerReply({ type: 'result', inventory: { pages: [] }, perPageMs: [] })).toBe(true);
    expect(isWorkerReply({ type: 'scene', hash: 'ab', mediaHashes: [] })).toBe(true);
    expect(isWorkerReply({ type: 'convert', pptxHash: 'ab', pptxBytes: 1, reportHash: 'cd' })).toBe(true);
    expect(isWorkerReply({ type: 'error', message: 'x' })).toBe(true);
    expect(isWorkerReply({ sourceName: 'worker', targetName: 'main', action: 'ready' })).toBe(false);
    expect(isWorkerReply(null)).toBe(false);
  });
});

describe('isWorkerReply: the website replies (M6)', () => {
  it('knows progress, pptx and failed', () => {
    expect(isWorkerReply({ type: 'progress', done: 1, total: 3 })).toBe(true);
    expect(isWorkerReply({ type: 'pptx', pptx: new Uint8Array(1), report: {} })).toBe(true);
    expect(isWorkerReply({ type: 'failed', kind: 'password' })).toBe(true);
    expect(isWorkerReply({ type: 'ready' })).toBe(false);
    expect(isWorkerReply({ type: 7 })).toBe(false);
  });
});


