import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerReply } from '../src/protocol';
import { serveInOrder } from '../src/serve';

const result = (n: number): WorkerReply => ({ type: 'result', inventory: { pages: [] }, perPageMs: [n] });

describe('serveInOrder (the worker request queue)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('handles one request at a time and answers in order of arrival', async () => {
    const posted: WorkerReply[] = [];
    let running = 0;
    let mostAtOnce = 0;
    const serve = serveInOrder(async (ms: number) => {
      mostAtOnce = Math.max(mostAtOnce, ++running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return result(ms);
    }, (reply) => posted.push(reply));
    await Promise.all([serve(30), serve(1), serve(10)]);
    expect(posted).toEqual([result(30), result(1), result(10)]);
    expect(mostAtOnce).toBe(1);
  });

  it('turns a failing request into an error reply and serves the next one', async () => {
    const posted: WorkerReply[] = [];
    const serve = serveInOrder(async (n: number) => {
      if (n === 1) throw new RangeError('page 9 is outside 0..2');
      return result(n);
    }, (reply) => posted.push(reply));
    await Promise.all([serve(1), serve(2)]);
    expect(posted).toEqual([{ type: 'error', message: 'RangeError: page 9 is outside 0..2' }, result(2)]);
  });

  it('answers with an error when a reply cannot be posted (DataCloneError), and serves the next request', async () => {
    const posted: WorkerReply[] = [];
    let first = true;
    const serve = serveInOrder(async (n: number) => result(n), (reply) => {
      if (first && reply.type === 'result') {
        first = false;
        throw new DOMException('function could not be cloned', 'DataCloneError');
      }
      posted.push(reply);
    });
    await Promise.all([serve(1), serve(2)]);
    expect(posted).toEqual([
      { type: 'error', message: 'worker: the reply could not be sent: DataCloneError: function could not be cloned' },
      result(2),
    ]);
  });

  it('logs when not even the error reply can be posted, and still serves later requests', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const posted: WorkerReply[] = [];
    let failures = 2;
    const serve = serveInOrder(async (n: number) => result(n), (reply) => {
      if (failures-- > 0) throw new Error('port closed');
      posted.push(reply);
    });
    await Promise.all([serve(1), serve(2)]);
    expect(posted).toEqual([result(2)]);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
