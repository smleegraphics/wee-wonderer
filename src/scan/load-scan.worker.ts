// Web Worker: fetch and parse a scan (.ply or .spz) off the main thread. Parsing a large
// scan takes seconds (the Playroom is 453 MB), and on the main thread that froze
// the page: no clicks, no animation. The file is fetched here too, so its bytes
// never cross threads; only the parsed arrays are transferred back, zero-copy. A load
// that is no longer wanted can be cancelled while it is fetching (not once unpacking
// has begun: that is one call into three.js).

import { parseScanArrays, scanBuffers } from './parse-scan';


/** How far the load has got: fetching (`fetched`: the part of the file received, 0..1), then unpacking it. */
export type ScanLoadProgress = { step: 'fetch'; fetched: number } | { step: 'unpack' };

interface Req { id: number; url: string }
interface Cancel { id: number; cancel: true }

const fetching = new Map<number, AbortController>(); // the loads that can still be cancelled, by request id

const REPORT_EVERY = 0.01; // say so each time this much more of the file has arrived

/** The response's body, telling `onFetched` what part of it has arrived as it comes in. */
async function readBody(response: Response, onFetched: (part: number) => void): Promise<ArrayBuffer> {
  const total = Number(response.headers.get('Content-Length'));
  // no size given, or the body was compressed in transit (the size is then not the size of what arrives): nothing to measure against
  if (!response.body || !(total > 0) || response.headers.get('Content-Encoding')) return response.arrayBuffer();
  const bytes = new Uint8Array(total);
  const reader = response.body.getReader();
  let got = 0, said = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > total) throw new Error('the file is longer than the server said');
    bytes.set(value, got);
    got += value.length;
    if (got / total - said >= REPORT_EVERY) onFetched(said = got / total);
  }
  if (got !== total) throw new Error('the file is shorter than the server said');
  return bytes.buffer;
}

self.onmessage = async (e: MessageEvent<Req | Cancel>) => {
  if ('cancel' in e.data) { fetching.get(e.data.id)?.abort(); return; }
  const { id, url } = e.data;
  const abort = new AbortController();
  fetching.set(id, abort);
  try {
    const response = await fetch(url, { signal: abort.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const say = (progress: ScanLoadProgress) => (self as unknown as Worker).postMessage({ id, progress });
    const body = await readBody(response, (fetched) => say({ step: 'fetch', fetched }));
    fetching.delete(id);
    abort.signal.throwIfAborted(); // cancelled between the last bytes and here
    say({ step: 'unpack' });
    const result = await parseScanArrays(body);
    (self as unknown as Worker).postMessage({ id, result }, scanBuffers(result));
  } catch (err) {
    fetching.delete(id);
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) }); // (a cancelled load's caller has stopped listening)
  }
};
