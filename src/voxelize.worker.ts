// Web Worker that runs the voxelizer core off the main thread, so the ~1s+
// first-build of a scan's collision surface doesn't freeze the frame. Receives
// splat centers + world matrix + options, returns the surface arrays (transferred
// back zero-copy). Called through workerCaller (worker-call.ts) from main.ts.

import { voxelizeCore, type VoxelOptions } from './voxelize-core';

interface Req {
  id: number;
  positions: Float32Array;
  opacity: Float32Array;
  cov: Float32Array | null;
  count: number;
  matrix: number[];
  voxelSize: number;
  opts: VoxelOptions;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, positions, opacity, cov, count, matrix, voxelSize, opts } = e.data;
  try {
    const surface = voxelizeCore(positions, count, opacity, matrix, voxelSize, opts, cov);
    (self as unknown as Worker).postMessage({ id, result: surface }, [surface.positions.buffer, surface.index.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err instanceof Error ? err.stack : err) });
  }
};
