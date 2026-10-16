// How a scan file's bytes become splat geometry: the one decision of which format it
// is, shared by the scan-loading worker and the inspector page (inspect.html).

import type { BufferGeometry } from 'three';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';

/** Parse a scan by what its bytes are, not by its name (an imported scan's blob URL has
 *  none): a PLY starts with the text "ply"; anything else is read as SPZ, whose loader
 *  knows its own versions (gzip for 1 to 3, zstd for 4) and throws on what is neither. */
export async function parseScan(body: ArrayBuffer): Promise<BufferGeometry> {
  const head = new Uint8Array(body, 0, Math.min(3, body.byteLength));
  if (String.fromCharCode(...head) === 'ply') return new GaussianSplatPLYLoader().parse(body);
  return await new SPZLoader().parse(body) as BufferGeometry;
}
