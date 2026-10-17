// Importing a visitor's own scan: cleaned in a worker, then loaded like any other. It
// never leaves their browser (context/deploy.md).

import type { CleanOptions } from './clean-scan-core';
import { workerCaller } from '../worker-call';
import { hud } from '../app';
import { loadFromURL } from './room';

// scan import (upload + in-browser cleanup), session-only
export const CLEAN_OPTS: CleanOptions = { alphaMin: 0.35, minMass: 4, scaleCapMul: 4, crop: true };
export const uploads = new Map<string, string>(); // upload id → blob object URL
let lastUploadBuffer: ArrayBuffer | null = null; // raw bytes of the active upload (for live re-clean)
let lastUploadName = '';

const cleanInWorker = workerCaller<{ buffer: ArrayBuffer; opts: CleanOptions }, { buffer: ArrayBuffer; kept: number; total: number }>(
  new Worker(new URL('./clean-scan.worker.ts', import.meta.url), { type: 'module' }), 'scan cleanup');

/** Import an uploaded .ply: keep a copy for live re-clean, then clean + load it. */
export async function importScan(file: File): Promise<void> {
  if (!/\.ply$/i.test(file.name)) { hud.status(`${file.name}: not a .ply file`, 'error'); return; }
  try {
    hud.status(`Reading ${file.name}…`, 'busy');
    const raw = await file.arrayBuffer();
    lastUploadBuffer = raw.slice(0); // retain a copy; the worker transfers (detaches) the other
    lastUploadName = file.name;
    await cleanAndLoad(raw, file.name);
  } catch (err) {
    hud.status(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, 'error');
  }
}

/** Re-clean the active upload with the current CLEAN_OPTS (for the debug sliders). */
export async function recleanUpload(): Promise<void> {
  if (!lastUploadBuffer) return;
  try { await cleanAndLoad(lastUploadBuffer.slice(0), lastUploadName); } // pass a copy; keep the original
  catch (err) { hud.status(`${lastUploadName}: ${err instanceof Error ? err.message : String(err)}`, 'error'); }
}

async function cleanAndLoad(rawToTransfer: ArrayBuffer, name: string): Promise<void> {
  hud.status(`Cleaning ${name}…`, 'busy');
  const id = `upload:${name}`;
  const res = await cleanInWorker({ buffer: rawToTransfer, opts: CLEAN_OPTS }, [rawToTransfer]); // the buffer is transferred (detached here)
  const url = URL.createObjectURL(new Blob([res.buffer], { type: 'application/octet-stream' }));
  const prev = uploads.get(id); if (prev) URL.revokeObjectURL(prev);
  uploads.set(id, url);
  hud.addRoom({ id, label: `${name} (yours)` });
  loadFromURL(url, id);
  hud.status(`${name}: kept ${res.kept.toLocaleString()} / ${res.total.toLocaleString()} splats`, 'done');
}
