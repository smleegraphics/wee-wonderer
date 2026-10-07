// Web Worker: run the scan cleanup off the main thread so a big upload doesn't
// freeze the UI. Receives the raw .ply ArrayBuffer (transferred in), returns the
// cleaned one (transferred back) — or an error string for a bad/compressed file.

import { cleanScan, type CleanOptions } from './clean-scan-core';

interface Req { id: number; buffer: ArrayBuffer; opts: CleanOptions }

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, buffer, opts } = e.data;
  try {
    const r = cleanScan(buffer, opts);
    (self as unknown as Worker).postMessage({ id, result: r }, [r.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
