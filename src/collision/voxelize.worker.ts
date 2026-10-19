// Web Worker that runs the voxelizer core off the main thread, so the ~1s+
// first-build of a scan's collision surface doesn't freeze the frame. Receives
// splat centers + world matrix + options, returns the surface arrays (transferred
// back zero-copy), or with `voxels` the voxel grid before and after cleanup instead (the
// voxel overlays). Called through workerCaller (worker-call.ts) from room-collision.ts.

import { voxelizeCore, type VoxelGrids, type VoxelOptions } from './voxelize-core';

interface Req {
  id: number;
  positions: Float32Array;
  opacity: Float32Array;
  cov: Float32Array | null;
  count: number;
  matrix: number[];
  voxelSize: number;
  unit: number; // the length the options' sizes are counted in (voxelizeCore)
  opts: VoxelOptions;
  voxels?: boolean; // the voxel grids instead of the surface
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, positions, opacity, cov, count, matrix, voxelSize, unit, opts, voxels } = e.data;
  try {
    if (voxels) {
      let grids: VoxelGrids | null = null;
      voxelizeCore(positions, count, opacity, matrix, voxelSize, opts, cov, unit, (v) => { grids = v; });
      const g = grids as VoxelGrids | null;
      if (!g) throw new Error('the voxelizer handed back no voxel grids');
      (self as unknown as Worker).postMessage({ id, result: g }, [g.density.centers.buffer, g.density.value.buffer, g.cleanup.centers.buffer, g.cleanup.change.buffer]);
      return;
    }
    const surface = voxelizeCore(positions, count, opacity, matrix, voxelSize, opts, cov, unit);
    (self as unknown as Worker).postMessage({ id, result: surface }, [surface.positions.buffer, surface.index.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err instanceof Error ? err.stack : err) });
  }
};
