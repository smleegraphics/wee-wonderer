// Request/response over a Web Worker. The worker answers each request with
// `{ id, result }` or `{ id, error }`; the caller gets a promise that resolves or
// rejects accordingly, so a failed job is never silent.

type Reply<Res> = { id: number; result?: Res; error?: string };

/** Returns `call(request, transfer)` for `worker`. `job` names the work in error messages. */
export function workerCaller<Req extends object, Res>(worker: Worker, job: string): (req: Req, transfer?: Transferable[]) => Promise<Res> {
  const pending = new Map<number, { resolve: (r: Res) => void; reject: (e: Error) => void }>();
  let lastId = 0;
  worker.onmessage = (e: MessageEvent<Reply<Res>>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error === undefined) p.resolve(e.data.result as Res);
    else p.reject(new Error(`${job} failed: ${e.data.error}`));
  };
  // the worker itself died (a script error, not a failed job): nothing it was asked for is coming back
  worker.onerror = (e) => {
    for (const p of pending.values()) p.reject(new Error(`${job} worker error: ${e.message}`));
    pending.clear();
  };
  return (req, transfer = []) => new Promise((resolve, reject) => {
    const id = ++lastId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, ...req }, transfer);
  });
}
