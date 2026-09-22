// Voxelize a Gaussian-splat scan into a blocky collision surface — the pure
// compute, with NO three.js dependency so it can run inside a Web Worker (keeps
// the ~1s+ first-build off the main thread). The three.js-facing wrapper and
// BufferGeometry conversion live in voxelize.ts.
//
// Splats sit on the room's real surfaces. We bin their centers into a voxel
// grid, mark voxels holding enough centers as "solid", CLEAN UP the raw
// occupancy, then emit the exposed cube faces between solid and empty voxels.
//
// Raw occupancy is noisy: stray floater voxels, holes in flat surfaces, and a
// bumpy ±1-voxel top. Three binary-grid passes fix that before meshing:
//   despeckle — drop solid components smaller than K voxels (removes stray cubes)
//   close     — dilate then erode (fills holes / small gaps in floors & walls)
//   smooth    — 26-neighborhood majority filter (flattens the bumpiness)

export interface VoxelOptions {
  minCount?: number;   // splat centers for a voxel to start solid (default 1)
  despeckle?: number;  // remove solid components smaller than this many voxels (default 12; 0 = off)
  close?: number;      // morphological-close iterations, fills holes/gaps (default 1; 0 = off)
  smooth?: number;     // majority-filter passes, flattens bumps (default 1; 0 = off)
}

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
const FACES: ReadonlyArray<{ c: readonly [number, number, number, number]; n: readonly [number, number, number] }> = [
  { c: [1, 5, 6, 2], n: [1, 0, 0] },   // +X
  { c: [0, 3, 7, 4], n: [-1, 0, 0] },  // -X
  { c: [3, 2, 6, 7], n: [0, 1, 0] },   // +Y
  { c: [0, 4, 5, 1], n: [0, -1, 0] },  // -Y
  { c: [4, 7, 6, 5], n: [0, 0, 1] },   // +Z
  { c: [0, 1, 2, 3], n: [0, 0, -1] },  // -Z
];

/**
 * Voxelize packed splat centers into a cleaned blocky surface. `positions` is a
 * flat [x,y,z,...] array of `count` centers; `m` is a column-major 4x4 matrix
 * (three's Matrix4.elements) mapping them into the leveled/scaled world.
 */
export function voxelizeCore(
  positions: ArrayLike<number>,
  count: number,
  m: ArrayLike<number>,
  voxelSize: number,
  opts: VoxelOptions = {},
): VoxelSurface {
  const minCount = opts.minCount ?? 1;
  const despeckleMin = opts.despeckle ?? 12;
  const closeIters = opts.close ?? 1;
  const smoothPasses = opts.smooth ?? 1;

  // affine transform of splat center i into world space (w = 1, no divide)
  const wx = (i: number) => m[0] * positions[i * 3] + m[4] * positions[i * 3 + 1] + m[8] * positions[i * 3 + 2] + m[12];
  const wy = (i: number) => m[1] * positions[i * 3] + m[5] * positions[i * 3 + 1] + m[9] * positions[i * 3 + 2] + m[13];
  const wz = (i: number) => m[2] * positions[i * 3] + m[6] * positions[i * 3 + 1] + m[10] * positions[i * 3 + 2] + m[14];

  // pass 1: world-space bounds, padded by a voxel so morphology has room at the edge
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = wx(i), y = wy(i), z = wz(i);
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
  }
  minX -= voxelSize; minY -= voxelSize; minZ -= voxelSize;
  const gx = Math.max(1, Math.ceil((maxX - minX) / voxelSize) + 2);
  const gy = Math.max(1, Math.ceil((maxY - minY) / voxelSize) + 2);
  const gz = Math.max(1, Math.ceil((maxZ - minZ) / voxelSize) + 2);

  // pass 2: splat counts per voxel → dense occupancy grid
  const counts = new Uint16Array(gx * gy * gz);
  for (let i = 0; i < count; i++) {
    const vx = Math.floor((wx(i) - minX) / voxelSize);
    const vy = Math.floor((wy(i) - minY) / voxelSize);
    const vz = Math.floor((wz(i) - minZ) / voxelSize);
    const c = (vx * gy + vy) * gz + vz;
    if (counts[c] < 65535) counts[c]++;
  }
  let occ: Uint8Array = new Uint8Array(counts.length);
  for (let c = 0; c < counts.length; c++) occ[c] = counts[c] >= minCount ? 1 : 0;

  // cleanup: despeckle → close → smooth
  if (despeckleMin > 0) despeckle(occ, gy, gz, despeckleMin);
  for (let i = 0; i < closeIters; i++) occ = dilate(occ, gx, gy, gz);
  for (let i = 0; i < closeIters; i++) occ = erode(occ, gx, gy, gz);
  for (let i = 0; i < smoothPasses; i++) occ = majority(occ, gx, gy, gz);

  // pass 3: emit exposed faces. Occupied voxels live in the padded interior, so
  // neighbors are read by flat offset. Offsets match FACES (+X,-X,+Y,-Y,+Z,-Z).
  const sx = gy * gz, sy = gz;
  const faceOff = [sx, -sx, sy, -sy, 1, -1];
  const positionsOut: number[] = [];
  const normalsOut: number[] = [];
  let occupied = 0;
  const corner = (vx: number, vy: number, vz: number, ci: number) => {
    const o = CORNERS[ci];
    positionsOut.push(minX + (vx + o[0]) * voxelSize, minY + (vy + o[1]) * voxelSize, minZ + (vz + o[2]) * voxelSize);
  };
  for (let vx = 1; vx < gx - 1; vx++)
    for (let vy = 1; vy < gy - 1; vy++) {
      let c = vx * sx + vy * sy + 1;
      for (let vz = 1; vz < gz - 1; vz++, c++) {
        if (!occ[c]) continue;
        occupied++;
        for (let fi = 0; fi < 6; fi++) {
          if (occ[c + faceOff[fi]]) continue; // face buried between two solids
          const f = FACES[fi];
          corner(vx, vy, vz, f.c[0]); corner(vx, vy, vz, f.c[1]); corner(vx, vy, vz, f.c[2]);
          corner(vx, vy, vz, f.c[0]); corner(vx, vy, vz, f.c[2]); corner(vx, vy, vz, f.c[3]);
          for (let t = 0; t < 6; t++) normalsOut.push(f.n[0], f.n[1], f.n[2]);
        }
      }
    }

  return {
    positions: new Float32Array(positionsOut),
    normals: new Float32Array(normalsOut),
    voxelSize,
    occupiedCount: occupied,
    triangleCount: positionsOut.length / 9,
  };
}

// --- binary-grid cleanup ops -------------------------------------------------
// The grid is padded by an empty voxel on every side, so the outermost layer is
// always empty. That lets the interior loops read all neighbors via flat index
// offsets (±1, ±sy, ±sx) without per-cell bounds checks — the hot-path win.

/** Remove solid connected components (6-connected) smaller than `minSize` voxels. */
function despeckle(occ: Uint8Array, gy: number, gz: number, minSize: number): void {
  const sx = gy * gz, sy = gz;
  const off = [1, -1, sy, -sy, sx, -sx];
  const visited = new Uint8Array(occ.length);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let start = 0; start < occ.length; start++) {
    if (!occ[start] || visited[start]) continue;
    stack.length = 0; comp.length = 0;
    stack.push(start); visited[start] = 1;
    while (stack.length) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (let d = 0; d < 6; d++) {
        const nc = cur + off[d];
        if (nc >= 0 && nc < occ.length && occ[nc] && !visited[nc]) { visited[nc] = 1; stack.push(nc); }
      }
    }
    if (comp.length < minSize) for (const c of comp) occ[c] = 0;
  }
}

/** Solid if self or any 6-neighbor is solid (grows the surface by one voxel). */
function dilate(occ: Uint8Array, gx: number, gy: number, gz: number): Uint8Array {
  const out = new Uint8Array(occ.length);
  const sx = gy * gz, sy = gz;
  for (let x = 1; x < gx - 1; x++)
    for (let y = 1; y < gy - 1; y++) {
      let c = x * sx + y * sy + 1;
      for (let z = 1; z < gz - 1; z++, c++)
        out[c] = (occ[c] || occ[c - 1] || occ[c + 1] || occ[c - sy] || occ[c + sy] || occ[c - sx] || occ[c + sx]) ? 1 : 0;
    }
  return out;
}

/** Solid only if self and all 6-neighbors are solid (shrinks the surface by one voxel). */
function erode(occ: Uint8Array, gx: number, gy: number, gz: number): Uint8Array {
  const out = new Uint8Array(occ.length);
  const sx = gy * gz, sy = gz;
  for (let x = 1; x < gx - 1; x++)
    for (let y = 1; y < gy - 1; y++) {
      let c = x * sx + y * sy + 1;
      for (let z = 1; z < gz - 1; z++, c++)
        out[c] = (occ[c] && occ[c - 1] && occ[c + 1] && occ[c - sy] && occ[c + sy] && occ[c - sx] && occ[c + sx]) ? 1 : 0;
    }
  return out;
}

/** Majority filter over the 26-neighborhood (incl. self): flips lone bumps/pits. */
function majority(occ: Uint8Array, gx: number, gy: number, gz: number): Uint8Array {
  const out = new Uint8Array(occ.length);
  const sx = gy * gz, sy = gz;
  for (let x = 1; x < gx - 1; x++)
    for (let y = 1; y < gy - 1; y++) {
      let c = x * sx + y * sy + 1;
      for (let z = 1; z < gz - 1; z++, c++) {
        let n = 0;
        for (let ox = -sx; ox <= sx; ox += sx)
          for (let oy = -sy; oy <= sy; oy += sy) {
            const b = c + ox + oy;
            n += occ[b - 1] + occ[b] + occ[b + 1];
          }
        out[c] = n >= 14 ? 1 : 0; // > half of 27
      }
    }
  return out;
}
