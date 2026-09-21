// Voxelize a Gaussian-splat scan into a collision surface mesh.
//
// The scan is a cloud of splats sitting on the room's real surfaces (floor,
// walls, furniture). We bin splat centers into a voxel grid, mark voxels that
// hold enough splats as "solid", then emit the blocky surface between solid and
// empty voxels — the exposed cube faces. That surface is what the character
// collides against (via three-mesh-bvh, next spike).
//
// Blocky on purpose: simple, robust, watertight, and the controller already
// handles discrete steps. A smoother isosurface (marching cubes) can replace the
// face-extraction step later without touching the occupancy stage.
//
// Runs in-browser on the loaded splat (world space, so it's already leveled +
// scaled to match the character). The result is a plain positions/normals pair,
// deliberately serializable so a load-once cache can persist it later.

import * as THREE from 'three';

export interface VoxelSurface {
  positions: Float32Array; // world-space triangle soup (blocky room surface)
  normals: Float32Array;
  voxelSize: number;
  occupiedCount: number;
  triangleCount: number;
}

// Unit-cube corners and the 6 faces (corner indices ordered CCW from outside).
const CORNERS: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const FACES: ReadonlyArray<{ d: readonly [number, number, number]; c: readonly [number, number, number, number]; n: readonly [number, number, number] }> = [
  { d: [1, 0, 0], c: [1, 5, 6, 2], n: [1, 0, 0] },
  { d: [-1, 0, 0], c: [0, 3, 7, 4], n: [-1, 0, 0] },
  { d: [0, 1, 0], c: [3, 2, 6, 7], n: [0, 1, 0] },
  { d: [0, -1, 0], c: [0, 4, 5, 1], n: [0, -1, 0] },
  { d: [0, 0, 1], c: [4, 7, 6, 5], n: [0, 0, 1] },
  { d: [0, 0, -1], c: [0, 1, 2, 3], n: [0, 0, -1] },
];

/**
 * Voxelize splat centers into a blocky collision surface. `pos` is the loader's
 * raw position attribute (the real centers — GaussianSplat itself keeps only a
 * billboard quad), `matrixWorld` maps those into the leveled/scaled world.
 * `voxelSize`/`minCount` are world-space; a voxel is solid when it holds at
 * least `minCount` centers.
 */
export function voxelizeSplat(
  pos: THREE.BufferAttribute,
  matrixWorld: THREE.Matrix4,
  voxelSize: number,
  minCount = 2,
): VoxelSurface {
  const m = matrixWorld;
  const n = pos.count;
  const v = new THREE.Vector3();

  // pass 1: world-space bounds
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    if (v.x < minX) minX = v.x; if (v.y < minY) minY = v.y; if (v.z < minZ) minZ = v.z;
    if (v.x > maxX) maxX = v.x; if (v.y > maxY) maxY = v.y; if (v.z > maxZ) maxZ = v.z;
  }
  const gx = Math.max(1, Math.ceil((maxX - minX) / voxelSize) + 1);
  const gy = Math.max(1, Math.ceil((maxY - minY) / voxelSize) + 1);
  const gz = Math.max(1, Math.ceil((maxZ - minZ) / voxelSize) + 1);
  const keyOf = (vx: number, vy: number, vz: number) => (vx * gy + vy) * gz + vz;

  // pass 2: splat counts per voxel
  const counts = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    const vx = Math.floor((v.x - minX) / voxelSize);
    const vy = Math.floor((v.y - minY) / voxelSize);
    const vz = Math.floor((v.z - minZ) / voxelSize);
    const k = keyOf(vx, vy, vz);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const solid = new Set<number>();
  for (const [k, c] of counts) if (c >= minCount) solid.add(k);

  // pass 3: emit exposed faces (solid voxel adjacent to empty/out-of-bounds)
  const positions: number[] = [];
  const normals: number[] = [];
  const corner = (vx: number, vy: number, vz: number, ci: number) => {
    const o = CORNERS[ci];
    positions.push(minX + (vx + o[0]) * voxelSize, minY + (vy + o[1]) * voxelSize, minZ + (vz + o[2]) * voxelSize);
  };
  for (const k of solid) {
    const vz = k % gz;
    const k2 = (k - vz) / gz;
    const vy = k2 % gy;
    const vx = (k2 - vy) / gy;
    for (const f of FACES) {
      const nx = vx + f.d[0], ny = vy + f.d[1], nz = vz + f.d[2];
      const inside = nx >= 0 && nx < gx && ny >= 0 && ny < gy && nz >= 0 && nz < gz;
      if (inside && solid.has(keyOf(nx, ny, nz))) continue; // face buried between two solids
      // two triangles: (c0,c1,c2) (c0,c2,c3)
      corner(vx, vy, vz, f.c[0]); corner(vx, vy, vz, f.c[1]); corner(vx, vy, vz, f.c[2]);
      corner(vx, vy, vz, f.c[0]); corner(vx, vy, vz, f.c[2]); corner(vx, vy, vz, f.c[3]);
      for (let t = 0; t < 6; t++) normals.push(f.n[0], f.n[1], f.n[2]);
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    voxelSize,
    occupiedCount: solid.size,
    triangleCount: positions.length / 9,
  };
}

/** Wrap a VoxelSurface's arrays in a BufferGeometry for rendering / BVH. */
export function surfaceToGeometry(s: VoxelSurface): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(s.positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(s.normals, 3));
  return g;
}
