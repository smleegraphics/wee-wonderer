// Web Worker: adds the walkable-ground fill splats to a scan off the main thread (on
// Playroom, working them out takes over a second). The scan's arrays are transferred in
// and the arrays to draw are transferred back: the same ones if nothing was added, or if
// the fill could not be worked out. That is reported in the answer, not as a failed job,
// so that the scan comes back whatever happens: a room without its fill is still a room.
// Called through workerCaller (worker-call.ts) from walk-fill.ts.

import { fillWalkable, appendFill, type Walkable, type WalkableFillOptions } from './fill-scan-core';
import type { ParsedScan } from './load-scan.worker';

interface Req { id: number; scan: ParsedScan; matrix: number[]; walk: Walkable; opts: WalkableFillOptions }

/** The scan with its fill: the scan's `own` splats come first in every array, the added ones after. */
export interface FilledScan { scan: ParsedScan; own: number; cells: number; seeThrough: number; failed?: string } // cells, seeThrough: see ScanFill. failed: why there is no fill

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, scan, matrix, walk, opts } = e.data;
  const own = scan.centers.length / 3;
  let result: FilledScan;
  try {
    const fill = fillWalkable(scan.centers, scan.covariances, scan.colors, own, matrix, walk, opts);
    result = { scan: appendFill(scan, fill), own, cells: fill.cells, seeThrough: fill.seeThrough };
  } catch (err) {
    result = { scan, own, cells: 0, seeThrough: 0, failed: String(err instanceof Error ? err.stack : err) };
  }
  const s = result.scan;
  (self as unknown as Worker).postMessage({ id, result }, [s.centers, s.covariances, s.colors, ...Object.values(s.sphericalHarmonics)].map((a) => a.buffer as ArrayBuffer));
};
