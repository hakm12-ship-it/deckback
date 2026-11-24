import type { WorkerReply } from './protocol';

/** An error as one line: `Name: message`. */
export const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/**
 * The worker's request queue: one request at a time, in order of arrival, one reply each.
 *
 * A request that fails becomes an error reply. A reply that cannot be posted (a DataCloneError, say) is replaced by
 * an error reply. Should even that fail, it is logged. In every case the queue goes on to the next request, so a
 * single failure can never silence the worker.
 */
export function serveInOrder<Request>(
  handle: (request: Request) => Promise<WorkerReply>,
  post: (reply: WorkerReply) => void,
): (request: Request) => Promise<void> {
  async function answer(request: Request): Promise<void> {
    let reply: WorkerReply;
    try {
      reply = await handle(request);
    } catch (error) {
      reply = { type: 'error', message: describeError(error) };
    }
    try {
      post(reply);
    } catch (error) {
      try {
        post({ type: 'error', message: `worker: the reply could not be sent: ${describeError(error)}` });
      } catch (again) {
        console.error('worker: no reply could be sent', again);
      }
    }
  }

  let queue = Promise.resolve();
  return (request) => {
    queue = queue.then(() => answer(request)); // answer() never rejects, so the queue never stalls
    return queue;
  };
}
