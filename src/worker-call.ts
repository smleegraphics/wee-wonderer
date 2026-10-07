// Request/response over a Web Worker. The worker answers each request with
// `{ id, result }` or `{ id, error }`; the caller gets a promise that resolves or
// rejects accordingly, so a failed job is never silent. Before answering, a worker
// may say how far it has got, any number of times, with `{ id, progress }`. A caller
// that no longer wants an answer can say so with an AbortSignal: the worker is sent
// `{ id, cancel: true }`, which it must be written to expect (load-scan.worker.ts is).

type Reply<Res, Progress> = { id: number; result?: Res; error?: string; progress?: Progress };

export interface CallOptions<Progress> { onProgress?: (p: Progress) => void; signal?: AbortSignal }

/** Returns `call(request, transfer, options)` for `worker`. `job` names the work in error messages. */
export function workerCaller<Req extends object, Res, Progress = never>(worker: Worker, job: string): (req: Req, transfer?: Transferable[], options?: CallOptions<Progress>) => Promise<Res> {
  const pending = new Map<number, { resolve: (r: Res) => void; reject: (e: Error) => void; onProgress?: (p: Progress) => void }>();
  let lastId = 0;
  worker.onmessage = (e: MessageEvent<Reply<Res, Progress>>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    if (e.data.progress !== undefined) { p.onProgress?.(e.data.progress); return; }
    pending.delete(e.data.id);
    if (e.data.error === undefined) p.resolve(e.data.result as Res);
    else p.reject(new Error(`${job} failed: ${e.data.error}`));
  };
  // the worker itself died (a script error, not a failed job): nothing it was asked for is coming back
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`${job} worker error: ${e.message}`));
    pending.clear();
  };
  return (req, transfer = [], { onProgress, signal } = {}) => new Promise((resolve, reject) => {
    const id = ++lastId;
    pending.set(id, { resolve, reject, onProgress });
    signal?.addEventListener('abort', () => {
      if (!pending.delete(id)) return; // already answered
      worker.postMessage({ id, cancel: true });
      reject(new Error(`${job} cancelled`));
    }, { once: true });
    worker.postMessage({ id, ...req }, transfer);
  });
}
