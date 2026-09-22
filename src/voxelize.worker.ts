// Web Worker that runs the voxelizer core off the main thread, so the ~1s+
// first-build of a scan's collision surface doesn't freeze the frame. Receives
// splat centers + world matrix + options, returns the surface arrays (transferred
// back zero-copy). See buildCollision() in main.ts for the request/response glue.

import { voxelizeCore, type VoxelOptions } from './voxelize-core';

interface Req {
  id: number;
  positions: Float32Array;
  count: number;
  matrix: number[];
  voxelSize: number;
  opts: VoxelOptions;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, positions, count, matrix, voxelSize, opts } = e.data;
  const surface = voxelizeCore(positions, count, matrix, voxelSize, opts);
  (self as unknown as Worker).postMessage({ id, surface }, [surface.positions.buffer, surface.normals.buffer]);
};
