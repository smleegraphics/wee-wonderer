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
  fillFloor?: number;  // fill enclosed holes in the floor layer (default 1; 0 = off)
}

export interface VoxelSurface {
  positions: Float32Array; // world-space smooth surface vertices (x,y,z,...)
  index: Uint32Array;      // triangle indices
  voxelSize: number;
  occupiedCount: number;
  triangleCount: number;
}

// Surface Nets tables: the 12 edges of the cube (as pairs of corner ids, where a
// corner id's bits are +x=1, +y=2, +z=4), and, per 8-corner occupancy mask, which
// edges are crossed by the surface. Built once at module load.
const CUBE_EDGES = new Int32Array(24);
const EDGE_TABLE = new Int32Array(256);
(() => {
  let k = 0;
  for (let i = 0; i < 8; i++)
    for (let j = 1; j <= 4; j <<= 1) {
      const p = i ^ j;
      if (i <= p) { CUBE_EDGES[k++] = i; CUBE_EDGES[k++] = p; }
    }
  for (let mask = 0; mask < 256; mask++) {
    let em = 0;
    for (let e = 0; e < 12; e++) {
      const a = (mask >> CUBE_EDGES[e * 2]) & 1;
      const b = (mask >> CUBE_EDGES[e * 2 + 1]) & 1;
      if (a !== b) em |= 1 << e;
    }
    EDGE_TABLE[mask] = em;
  }
})();

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
  const doFillFloor = (opts.fillFloor ?? 1) !== 0;

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

  // cleanup: despeckle → close → fill floor holes → smooth
  if (despeckleMin > 0) despeckle(occ, gy, gz, despeckleMin);
  for (let i = 0; i < closeIters; i++) occ = dilate(occ, gx, gy, gz);
  for (let i = 0; i < closeIters; i++) occ = erode(occ, gx, gy, gz);
  if (doFillFloor) fillFloorHoles(occ, gx, gy, gz);
  for (let i = 0; i < smoothPasses; i++) occ = majority(occ, gx, gy, gz);

  let occupied = 0;
  for (let c = 0; c < occ.length; c++) occupied += occ[c];

  // pass 3: Surface Nets — one vertex per surface-straddling cell, placed at the
  // average of its crossing-edge midpoints, then relaxed (Taubin smoothing) into a
  // smooth mesh. This replaces blocky cube faces: the floor becomes a smooth plane
  // instead of stairs, sub-voxel accurate so feet still seat on the real surface.
  const sn = surfaceNets(occ, gx, gy, gz, minX, minY, minZ, voxelSize);
  taubinSmooth(sn.positions, sn.index, smoothPasses > 0 ? 8 : 0);

  return {
    positions: sn.positions,
    index: sn.index,
    voxelSize,
    occupiedCount: occupied,
    triangleCount: sn.index.length / 3,
  };
}

/** Naive Surface Nets over a binary occupancy grid → smooth indexed mesh. */
function surfaceNets(
  occ: Uint8Array, gx: number, gy: number, gz: number,
  minX: number, minY: number, minZ: number, vs: number,
): { positions: Float32Array; index: Uint32Array } {
  const sx = gy * gz, sy = gz; // strides; R per axis = [sx, sy, 1]
  const R = [sx, sy, 1];
  const cellVert = new Int32Array(occ.length).fill(-1);
  const pos: number[] = [];
  const idx: number[] = [];
  const midAxis = (a: number, b: number, axis: number) => {
    const av = (a >> axis) & 1, bv = (b >> axis) & 1;
    return av === bv ? av : 0.5;
  };
  for (let x = 0; x < gx - 1; x++)
    for (let y = 0; y < gy - 1; y++)
      for (let z = 0; z < gz - 1; z++) {
        const cur = (x * gy + y) * gz + z;
        // 8 corner occupancies → mask (bit g, corner g bits: +x=1,+y=2,+z=4)
        const mask =
          occ[cur] |
          (occ[cur + sx] << 1) |
          (occ[cur + sy] << 2) |
          (occ[cur + sx + sy] << 3) |
          (occ[cur + 1] << 4) |
          (occ[cur + sx + 1] << 5) |
          (occ[cur + sy + 1] << 6) |
          (occ[cur + sx + sy + 1] << 7);
        if (mask === 0 || mask === 255) continue;
        // vertex = mean of crossing-edge midpoints (local cell coords 0..1)
        const em = EDGE_TABLE[mask];
        let ex = 0, ey = 0, ez = 0, ec = 0;
        for (let e = 0; e < 12; e++) {
          if (!(em & (1 << e))) continue;
          const a = CUBE_EDGES[e * 2], b = CUBE_EDGES[e * 2 + 1];
          ex += midAxis(a, b, 0); ey += midAxis(a, b, 1); ez += midAxis(a, b, 2); ec++;
        }
        const inv = 1 / ec;
        cellVert[cur] = pos.length / 3;
        pos.push(
          minX + (x + ex * inv + 0.5) * vs,
          minY + (y + ey * inv + 0.5) * vs,
          minZ + (z + ez * inv + 0.5) * vs,
        );
        // emit a quad for each of the 3 base edges (+x,+y,+z) that the surface crosses
        for (let axis = 0; axis < 3; axis++) {
          if (!(em & (1 << axis))) continue;
          const iu = (axis + 1) % 3, iv = (axis + 2) % 3;
          const cu = iu === 0 ? x : iu === 1 ? y : z; // coord along the iu axis
          const cv = iv === 0 ? x : iv === 1 ? y : z; // coord along the iv axis
          if (cu === 0 || cv === 0) continue;
          const du = R[iu], dv = R[iv];
          const v0 = cellVert[cur], v1 = cellVert[cur - du], v2 = cellVert[cur - du - dv], v3 = cellVert[cur - dv];
          if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) continue;
          if (mask & 1) { idx.push(v0, v1, v2, v0, v2, v3); }
          else { idx.push(v0, v3, v2, v0, v2, v1); }
        }
      }
  return { positions: new Float32Array(pos), index: new Uint32Array(idx) };
}

/** Taubin smoothing (λ|μ) over the mesh graph — smooths without net shrinkage. */
function taubinSmooth(pos: Float32Array, index: Uint32Array, iterations: number): void {
  if (iterations <= 0) return;
  const n = pos.length / 3;
  // build neighbor lists from triangle edges
  const nbr: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i], b = index[i + 1], c = index[i + 2];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  const tmp = new Float32Array(pos.length);
  const step = (factor: number) => {
    for (let v = 0; v < n; v++) {
      const ns = nbr[v]; const k = ns.size;
      if (k === 0) { tmp[v * 3] = pos[v * 3]; tmp[v * 3 + 1] = pos[v * 3 + 1]; tmp[v * 3 + 2] = pos[v * 3 + 2]; continue; }
      let ax = 0, ay = 0, az = 0;
      for (const u of ns) { ax += pos[u * 3]; ay += pos[u * 3 + 1]; az += pos[u * 3 + 2]; }
      const inv = 1 / k;
      tmp[v * 3] = pos[v * 3] + factor * (ax * inv - pos[v * 3]);
      tmp[v * 3 + 1] = pos[v * 3 + 1] + factor * (ay * inv - pos[v * 3 + 1]);
      tmp[v * 3 + 2] = pos[v * 3 + 2] + factor * (az * inv - pos[v * 3 + 2]);
    }
    pos.set(tmp);
  };
  for (let i = 0; i < iterations; i++) { step(0.5); step(-0.53); } // λ then μ
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

/**
 * Fill enclosed holes in the floor. The floor is the most-occupied horizontal
 * row in the lower third of the grid; for it (and the row above) we flood-fill
 * the "outside" from the slice border through empty cells, then fill any empty
 * cell the flood never reached — i.e. a gap surrounded by floor. Restricting this
 * to the floor band is deliberate: a mid-height slice is mostly empty room
 * interior enclosed by walls, which a blind hole-fill would wrongly solidify.
 */
function fillFloorHoles(occ: Uint8Array, gx: number, gy: number, gz: number): void {
  const sx = gy * gz, sy = gz;
  const rowCount = new Int32Array(gy);
  for (let x = 1; x < gx - 1; x++)
    for (let y = 1; y < gy - 1; y++) {
      let c = x * sx + y * sy + 1;
      for (let z = 1; z < gz - 1; z++, c++) if (occ[c]) rowCount[y]++;
    }
  const limit = Math.max(2, Math.floor(gy / 3));
  let floorY = 1, best = -1;
  for (let y = 1; y <= limit; y++) if (rowCount[y] > best) { best = rowCount[y]; floorY = y; }
  for (let y = floorY; y <= Math.min(gy - 2, floorY + 1); y++) fillSlice(occ, gx, gy, gz, y);
}

/** Flood the outside of one horizontal (y=vy) slice from its border, then fill unreached empties. */
function fillSlice(occ: Uint8Array, gx: number, gy: number, gz: number, vy: number): void {
  const sx = gy * gz, base = vy * gz;
  const at = (x: number, z: number) => x * sx + base + z;
  const k2 = (x: number, z: number) => x * gz + z;
  const seen = new Uint8Array(gx * gz);
  const stack: number[] = [];
  const push = (x: number, z: number) => { const k = k2(x, z); if (!occ[at(x, z)] && !seen[k]) { seen[k] = 1; stack.push(x, z); } };
  for (let x = 0; x < gx; x++) { push(x, 0); push(x, gz - 1); }
  for (let z = 0; z < gz; z++) { push(0, z); push(gx - 1, z); }
  while (stack.length) {
    const z = stack.pop()!, x = stack.pop()!;
    if (x > 0) push(x - 1, z);
    if (x < gx - 1) push(x + 1, z);
    if (z > 0) push(x, z - 1);
    if (z < gz - 1) push(x, z + 1);
  }
  for (let x = 0; x < gx; x++)
    for (let z = 0; z < gz; z++)
      if (!occ[at(x, z)] && !seen[k2(x, z)]) occ[at(x, z)] = 1;
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
