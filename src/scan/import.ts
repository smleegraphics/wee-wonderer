// Importing a visitor's own scan: read and cleaned in a worker, then loaded like any
// other. It never leaves their browser (context/deploy.md).

import type { CleanOptions, CleanResult } from './clean-scan-core';
import { copyScan, type ParsedScan } from './parse-scan';
import { workerCaller } from '../worker-call';
import { hud } from '../app';
import { currentFile, importedId, loadScanData } from './room';
import { SCAN_FILE_TYPES } from './scans';

// scan import (upload + in-browser cleanup), session-only
export const CLEAN_OPTS: CleanOptions = { alphaMin: 0.35, minMass: 4, scaleCapMul: 4, crop: true };
/** This session's imports by id: the file as it was, for a re-clean, and the splats it
 *  was cleaned to, for the Scans card to bring back. Only imports that read and cleaned. */
const uploads = new Map<string, { name: string; bytes: ArrayBuffer; scan: ParsedScan; collision: Uint8Array }>();

// The cleanup worker is started by the first import, not with the page: it carries the
// scan readers (about 290 KB), which a visitor who never imports should not download.
type CleanCall = ReturnType<typeof workerCaller<{ buffer: ArrayBuffer; opts: CleanOptions }, CleanResult>>;
let cleaner: CleanCall | null = null;
const cleanInWorker: CleanCall = (req, transfer, options) => (cleaner ??= workerCaller<{ buffer: ArrayBuffer; opts: CleanOptions }, CleanResult>(
  new Worker(new URL('./clean-scan.worker.ts', import.meta.url), { type: 'module' }), 'scan cleanup'))(req, transfer, options);

/** Import a scan file: keep a copy for live re-clean, then clean + load it. */
export async function importScan(file: File): Promise<void> {
  if (!SCAN_FILE_TYPES.some((type) => file.name.toLowerCase().endsWith(type))) {
    hud.status(`${file.name}: not a scan the app reads (${SCAN_FILE_TYPES.join(' or ')})`, 'error');
    return;
  }
  try {
    hud.status(`Reading ${file.name}…`, 'busy');
    await cleanAndLoad(await file.arrayBuffer(), file.name);
  } catch (err) {
    hud.status(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/** Re-clean the import on screen with the current CLEAN_OPTS (the Debug sliders). Nothing
 *  if the room on screen is an example scan. */
export async function recleanUpload(): Promise<void> {
  const upload = uploads.get(currentFile);
  if (!upload) return;
  try { await cleanAndLoad(upload.bytes, upload.name); }
  catch (err) { hud.status(`${upload.name}: ${err instanceof Error ? err.message : String(err)}`, 'error'); }
}

/** Bring back an import picked in the Scans card. False if `id` is not one. */
export function pickUpload(id: string): boolean {
  const upload = uploads.get(id);
  if (!upload) return false;
  loadScanData(copyScan(upload.scan), id, upload.collision); // a copy: a load hands its arrays on to the workers that fill and build it (the mark is only read)
  return true;
}

/** Read and clean a file's bytes in the worker (which takes a copy: `bytes` are kept), and
 *  show the result. Only a file that reads and cleans is remembered. */
async function cleanAndLoad(bytes: ArrayBuffer, name: string): Promise<void> {
  hud.status(`Cleaning ${name}…`, 'busy');
  const id = importedId(name), copy = bytes.slice(0);
  const res = await cleanInWorker({ buffer: copy, opts: CLEAN_OPTS }, [copy]);
  uploads.set(id, { name, bytes, scan: res.scan, collision: res.collision });
  hud.addRoom({ id, label: `${name} (yours)` });
  pickUpload(id);
  hud.status(`${name}: kept ${res.kept.toLocaleString()} / ${res.total.toLocaleString()} splats (collision from ${res.collisionKept.toLocaleString()})`, 'done');
}
