// How a scan file's bytes become splats: the one decision of which format it is, and
// the one form every part of the app then works with (ParsedScan). Shared by the
// scan-loading worker, the import cleanup worker and the inspector page (inspect.html).

import type { BufferAttribute, BufferGeometry } from 'three';
import { GaussianSplatPLYLoader } from 'three/addons/loaders/GaussianSplatPLYLoader.js';
import { SPZLoader } from 'three/addons/loaders/SPZLoader.js';

/** A scan as splats, whatever file it came from: the arrays `createGaussianSplatGeometry`
 *  builds the splat geometry from. Opacity is each colour's fourth byte. */
export interface ParsedScan {
  centers: Float32Array;
  covariances: Float32Array; // 6 a splat: xx, xy, xz, yy, yz, zz
  colors: Uint8ClampedArray;
  sphericalHarmonics: Record<string, Uint32Array>; // sphericalHarmonics1..3, as many bands as the file has
}

/** Parse a scan by what its bytes are, not by its name (an imported scan's blob URL has
 *  none): a PLY starts with the text "ply"; anything else is read as SPZ, whose loader
 *  knows its own versions (gzip for 1 to 3, zstd for 4) and throws on what is neither. */
export async function parseScan(body: ArrayBuffer): Promise<BufferGeometry> {
  const head = new Uint8Array(body, 0, Math.min(3, body.byteLength));
  if (String.fromCharCode(...head) === 'ply') return new GaussianSplatPLYLoader().parse(body);
  return await new SPZLoader().parse(body) as BufferGeometry;
}

/** Parse a scan's bytes into the arrays the app works with. */
export async function parseScanArrays(body: ArrayBuffer): Promise<ParsedScan> {
  const geometry = await parseScan(body);
  const sphericalHarmonics: Record<string, Uint32Array> = {};
  for (const name of Object.keys(geometry.attributes)) {
    if (name.startsWith('sphericalHarmonics')) sphericalHarmonics[name] = (geometry.getAttribute(name) as BufferAttribute).array as Uint32Array;
  }
  return {
    centers: (geometry.getAttribute('position') as BufferAttribute).array as Float32Array,
    covariances: (geometry.getAttribute('covariance') as BufferAttribute).array as Float32Array,
    colors: (geometry.getAttribute('color') as BufferAttribute).array as Uint8ClampedArray,
    sphericalHarmonics,
  };
}

/** The buffers behind a scan's arrays, to transfer it to or from a worker. */
export const scanBuffers = (scan: ParsedScan): ArrayBuffer[] =>
  [scan.centers, scan.covariances, scan.colors, ...Object.values(scan.sphericalHarmonics)].map((a) => a.buffer as ArrayBuffer);

/** A copy of a scan, for a worker to take while the original is kept. */
export function copyScan(scan: ParsedScan): ParsedScan {
  const sphericalHarmonics: Record<string, Uint32Array> = {};
  for (const [name, words] of Object.entries(scan.sphericalHarmonics)) sphericalHarmonics[name] = words.slice();
  return { centers: scan.centers.slice(), covariances: scan.covariances.slice(), colors: scan.colors.slice(), sphericalHarmonics };
}
