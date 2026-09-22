// three.js-facing wrapper around the (three-free) voxelizer core. The heavy
// compute lives in voxelize-core.ts so it can run in a Web Worker; here we just
// adapt three types and turn a VoxelSurface into a BufferGeometry.

import * as THREE from 'three';
import { voxelizeCore, type VoxelOptions, type VoxelSurface } from './voxelize-core';

export type { VoxelOptions, VoxelSurface };

/** Synchronous voxelization (fallback / non-worker path). `pos` is the loader's
 *  raw position attribute; `matrixWorld` maps centers into the leveled world. */
export function voxelizeSplat(
  pos: THREE.BufferAttribute,
  matrixWorld: THREE.Matrix4,
  voxelSize: number,
  opts: VoxelOptions = {},
): VoxelSurface {
  return voxelizeCore(pos.array, pos.count, matrixWorld.elements, voxelSize, opts);
}

/** Wrap a VoxelSurface's arrays in a BufferGeometry for rendering / BVH. */
export function surfaceToGeometry(s: VoxelSurface): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
  return g;
}
