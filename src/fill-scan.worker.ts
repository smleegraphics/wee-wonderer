// Web Worker: adds the walkable-ground fill splats to a scan off the main thread (on Playroom,
// working them out and copying the scan's arrays to make room takes 0.6 s). The scan's
// arrays are transferred in and the arrays to draw are transferred back: the same
// ones if nothing was added. Called through workerCaller (worker-call.ts) from main.ts.

import { fillWalkable, appendFill, type Walkable, type WalkableFillOptions } from './fill-scan-core';
import type { ParsedScan } from './load-scan.worker';

interface Req { id: number; scan: ParsedScan; matrix: number[]; walk: Walkable; opts: WalkableFillOptions }

/** The scan with its fill: the scan's `own` splats come first in every array, the added ones after. */
export interface FilledScan { scan: ParsedScan; own: number; cells: number; seeThrough: number } // cells, seeThrough: see ScanFill

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, scan, matrix, walk, opts } = e.data;
  try {
    const own = scan.centers.length / 3;
    const fill = fillWalkable(scan.centers, scan.covariances, scan.colors, own, matrix, walk, opts);
    const result: FilledScan = { scan: appendFill(scan, fill), own, cells: fill.cells, seeThrough: fill.seeThrough };
    const s = result.scan;
    (self as unknown as Worker).postMessage({ id, result }, [s.centers, s.covariances, s.colors, ...Object.values(s.sphericalHarmonics)].map((a) => a.buffer as ArrayBuffer));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err instanceof Error ? err.stack : err) });
  }
};
