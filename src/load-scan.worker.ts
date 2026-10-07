// Web Worker: fetch and parse a scan's .ply off the main thread. Parsing a large
// scan takes seconds (the Playroom is 453 MB), and on the main thread that froze
// the page: no clicks, no animation. The file is fetched here too, so its bytes
// never cross threads; only the parsed arrays are transferred back, zero-copy.

import type { BufferAttribute } from 'three';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';

/** The arrays `createGaussianSplatGeometry` rebuilds the splat geometry from. */
export interface ParsedScan {
  centers: Float32Array;
  covariances: Float32Array;
  colors: Uint8ClampedArray;
  sphericalHarmonics: Record<string, Uint32Array>; // sphericalHarmonics1..3, as many bands as the file has
}

interface Req { id: number; url: string }

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, url } = e.data;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const geometry = new GaussianSplatPLYLoader().parse(await response.arrayBuffer());
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
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
