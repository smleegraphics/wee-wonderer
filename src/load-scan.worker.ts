// Web Worker: fetch and parse a scan (.ply or .spz) off the main thread. Parsing a large
// scan takes seconds (the Playroom is 453 MB), and on the main thread that froze
// the page: no clicks, no animation. The file is fetched here too, so its bytes
// never cross threads; only the parsed arrays are transferred back, zero-copy. A load
// that is no longer wanted can be cancelled while it is fetching (not once unpacking
// has begun: that is one call into three.js).

import type { BufferAttribute, BufferGeometry } from 'three';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';

/** The arrays `createGaussianSplatGeometry` rebuilds the splat geometry from. */
export interface ParsedScan {
  centers: Float32Array;
  covariances: Float32Array;
  colors: Uint8ClampedArray;
  sphericalHarmonics: Record<string, Uint32Array>; // sphericalHarmonics1..3, as many bands as the file has
}

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

/** Parse a scan by what its bytes are, not by its name (an imported scan's blob URL has
 *  none): a PLY starts with the text "ply"; anything else is read as SPZ, whose loader
 *  knows its own versions (gzip for 1 to 3, zstd for 4) and throws on what is neither. */
async function parseScan(body: ArrayBuffer): Promise<BufferGeometry> {
  const head = new Uint8Array(body, 0, Math.min(3, body.byteLength));
  if (String.fromCharCode(...head) === 'ply') return new GaussianSplatPLYLoader().parse(body);
  return await new SPZLoader().parse(body) as BufferGeometry;
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
    const geometry = await parseScan(body);
    const sphericalHarmonics: Record<string, Uint32Array> = {};
    for (const name of Object.keys(geometry.attributes)) {
      if (name.startsWith('sphericalHarmonics')) sphericalHarmonics[name] = (geometry.getAttribute(name) as BufferAttribute).array as Uint32Array;
    }
    const result: ParsedScan = {
      centers: (geometry.getAttribute('position') as BufferAttribute).array as Float32Array,
      covariances: (geometry.getAttribute('covariance') as BufferAttribute).array as Float32Array,
      colors: (geometry.getAttribute('color') as BufferAttribute).array as Uint8ClampedArray,
      sphericalHarmonics,
    };
    const buffers = [result.centers, result.covariances, result.colors, ...Object.values(sphericalHarmonics)].map((a) => a.buffer as ArrayBuffer);
    (self as unknown as Worker).postMessage({ id, result }, buffers);
  } catch (err) {
    fetching.delete(id);
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) }); // (a cancelled load's caller has stopped listening)
  }
};
