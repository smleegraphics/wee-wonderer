// Web Worker: read and clean an imported scan off the main thread, so a big file
// doesn't freeze the UI. Receives the file's bytes (transferred in), parses them in
// whatever format they are (parse-scan.ts), and returns the kept splats (transferred
// back), or an error message for a file it cannot read.

import { cleanScan, type CleanOptions } from './clean-scan-core';
import { parseScanArrays, scanBuffers } from './parse-scan';

interface Req { id: number; buffer: ArrayBuffer; opts: CleanOptions }

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, buffer, opts } = e.data;
  try {
    let scan;
    try { scan = await parseScanArrays(buffer); }
    catch (err) { throw new Error(`not a scan this app can read (${err instanceof Error ? err.message : String(err)})`); }
    const r = cleanScan(scan, opts);
    (self as unknown as Worker).postMessage({ id, result: r }, scanBuffers(r.scan));
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
