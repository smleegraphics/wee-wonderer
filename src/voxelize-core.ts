// Voxelize a Gaussian-splat scan into a smooth collision surface — the pure
// compute, with NO three.js dependency so it can run inside a Web Worker (keeps
// the ~1s+ first-build off the main thread). The three.js-facing wrapper and
// BufferGeometry conversion live in voxelize.ts.
//
// Splats sit on the room's real surfaces. We accumulate each splat's OPACITY into
// a voxel grid — a density field — and extract the isosurface where density
// crosses a threshold. Because the field is continuous, Surface Nets places
// vertices SUB-VOXEL (interpolating the crossing), so the mesh hugs the real
// Gaussian surface; and floaters, being low-opacity, never reach the threshold,
// so they don't produce phantom geometry.
//
// The thresholded field is also cleaned as a binary grid before meshing:
//   despeckle — drop solid components smaller than K voxels (dense stray blobs)
//   close     — dilate then erode (fills holes / small gaps in floors & walls)
//   fillFloor — fill enclosed holes in the floor layer
// then Taubin smoothing relaxes the mesh (no occupancy drift).

export interface VoxelOptions {
  iso?: number;        // isovalue as a fraction of the median surface density (default 0.5)
  despeckle?: number;  // remove solid components smaller than this many voxels (default 12; 0 = off)
  close?: number;      // morphological-close iterations, fills holes/gaps (default 1; 0 = off)
  fillFloor?: number;  // fill enclosed holes in the floor layer (default 1; 0 = off)
  smooth?: number;     // majority-filter passes on occupancy (default 0; Taubin handles smoothing)
  taubin?: number;     // Taubin mesh-smoothing iterations (default 6; 0 = off)
  floorFlat?: number;  // snap mesh vertices within this many voxels of y=0 flat (default 0.75; 0 = off)
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
 * Voxelize splats into a smooth collision surface. `positions` is a flat
 * [x,y,z,...] array of `count` centers, `opacity` the matching per-splat rendered
 * opacity (0..1), and `m` a column-major 4x4 matrix (three's Matrix4.elements)
 * mapping centers into the leveled/scaled world.
 */
export function voxelizeCore(
  positions: ArrayLike<number>,
  count: number,
  opacity: ArrayLike<number>,
  m: ArrayLike<number>,
  voxelSize: number,
  opts: VoxelOptions = {},
  radii?: ArrayLike<number> | null, // per-splat world radius; splats cover their footprint, not just a point
): VoxelSurface {
  const isoFactor = opts.iso ?? 0.5;
  const despeckleMin = opts.despeckle ?? 12;
  const closeIters = opts.close ?? 1;
  const smoothPasses = opts.smooth ?? 0;
  const taubinIters = opts.taubin ?? 6;
  const doFillFloor = (opts.fillFloor ?? 1) !== 0;

  // affine transform of splat center i into world space (w = 1, no divide)
  const wx = (i: number) => m[0] * positions[i * 3] + m[4] * positions[i * 3 + 1] + m[8] * positions[i * 3 + 2] + m[12];
  const wy = (i: number) => m[1] * positions[i * 3] + m[5] * positions[i * 3 + 1] + m[9] * positions[i * 3 + 2] + m[13];
  const wz = (i: number) => m[2] * positions[i * 3] + m[6] * positions[i * 3 + 1] + m[10] * positions[i * 3 + 2] + m[14];

  // pass 1: world-space bounds over opacity-bearing splats only. Faint floaters
  // are excluded so a far one can't balloon the grid (they wouldn't cross the
  // isovalue anyway); fall back to all splats if almost everything is faint.
  const BOUNDS_MIN_OPACITY = 0.15;
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let kept = 0;
  for (let i = 0; i < count; i++) {
    if (opacity[i] < BOUNDS_MIN_OPACITY) continue;
    const x = wx(i), y = wy(i), z = wz(i);
    if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
    if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    kept++;
  }
  if (kept < 8) { // too few opaque splats — use every splat instead
    minX = minY = minZ = Infinity; maxX = maxY = maxZ = -Infinity;
    for (let i = 0; i < count; i++) {
      const x = wx(i), y = wy(i), z = wz(i);
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
  }
  if (!Number.isFinite(minX)) // empty scan
    return { positions: new Float32Array(0), index: new Uint32Array(0), voxelSize, occupiedCount: 0, triangleCount: 0 };

  // choose the voxel size, coarsening it if the dense grid would be too large to
  // allocate — a hard cap against a pathological extent OOMing the worker.
  let vs = voxelSize;
  const cellsAt = (s: number) =>
    (Math.ceil((maxX - minX) / s) + 4) * (Math.ceil((maxY - minY) / s) + 4) * (Math.ceil((maxZ - minZ) / s) + 4);
  const MAX_CELLS = 48_000_000;
  if (cellsAt(vs) > MAX_CELLS) vs *= Math.cbrt(cellsAt(vs) / MAX_CELLS) * 1.02;

  minX -= vs; minY -= vs; minZ -= vs; // pad by a voxel so morphology has room at the edge
  const gx = Math.max(1, Math.ceil((maxX - minX) / vs) + 2);
  const gy = Math.max(1, Math.ceil((maxY - minY) / vs) + 2);
  const gz = Math.max(1, Math.ceil((maxZ - minZ) / vs) + 2);

  // pass 2: accumulate opacity mass per voxel → a density field. A splat is a
  // Gaussian with real extent, so it contributes to every voxel inside its footprint
  // (radius from its covariance), with a linear falloff — not just its center voxel.
  // This fills large flat surfaces (a cabinet door is a few big splats covering area
  // with few centers) while small floaters stay a single faint voxel and get rejected.
  const dens = new Float32Array(gx * gy * gz);
  const MAX_SPLAT_VOXELS = 4; // cap the footprint so a huge splat can't blow up the grid or blob
  for (let i = 0; i < count; i++) {
    const cx = (wx(i) - minX) / vs, cy = (wy(i) - minY) / vs, cz = (wz(i) - minZ) / vs; // center in voxel coords
    const op = opacity[i];
    const vr = radii ? Math.min(radii[i] / vs, MAX_SPLAT_VOXELS) : 0; // footprint radius in voxels
    if (vr < 0.75) { // small splat → its single center voxel (the original behaviour)
      const vx = Math.floor(cx), vy = Math.floor(cy), vz = Math.floor(cz);
      if (vx >= 0 && vx < gx && vy >= 0 && vy < gy && vz >= 0 && vz < gz) dens[(vx * gy + vy) * gz + vz] += op;
      continue;
    }
    // conserve mass: spread this splat's opacity over its footprint with a linear
    // falloff whose weights integrate to ~1 (norm ≈ 3/(π r³)), so total density isn't
    // inflated — overlapping splats on a surface still accumulate and cross the isovalue.
    const norm = 3 / (Math.PI * vr * vr * vr);
    const r = Math.ceil(vr), vxc = Math.floor(cx), vyc = Math.floor(cy), vzc = Math.floor(cz);
    for (let dx = -r; dx <= r; dx++) {
      const vx = vxc + dx; if (vx < 0 || vx >= gx) continue;
      const px = vx + 0.5 - cx;
      for (let dy = -r; dy <= r; dy++) {
        const vy = vyc + dy; if (vy < 0 || vy >= gy) continue;
        const py = vy + 0.5 - cy;
        for (let dz = -r; dz <= r; dz++) {
          const vz = vzc + dz; if (vz < 0 || vz >= gz) continue;
          const pz = vz + 0.5 - cz, d = Math.sqrt(px * px + py * py + pz * pz);
          if (d > vr) continue;
          dens[(vx * gy + vy) * gz + vz] += op * (1 - d / vr) * norm;
        }
      }
    }
  }

  // isovalue: a fraction of the median density among voxels that hold real
  // surface (>= ~1 opaque splat) — derived, so it scales to any scan.
  const strong: number[] = [];
  for (let c = 0; c < dens.length; c++) if (dens[c] >= 1) strong.push(dens[c]);
  strong.sort((a, b) => a - b);
  const medianStrong = strong.length ? strong[strong.length >> 1] : 1;
  const iso = Math.max(0.2, isoFactor * medianStrong);

  // binary occupancy (density above the isovalue) for the cleanup passes
  let occ: Uint8Array = new Uint8Array(dens.length);
  for (let c = 0; c < dens.length; c++) occ[c] = dens[c] >= iso ? 1 : 0;
  if (despeckleMin > 0) despeckle(occ, gy, gz, despeckleMin);
  for (let i = 0; i < closeIters; i++) occ = dilate(occ, gx, gy, gz);
  for (let i = 0; i < closeIters; i++) occ = erode(occ, gx, gy, gz);
  if (doFillFloor) fillFloorHoles(occ, gx, gy, gz);
  for (let i = 0; i < smoothPasses; i++) occ = majority(occ, gx, gy, gz);

  let occupied = 0;
  for (let c = 0; c < occ.length; c++) occupied += occ[c];

  // signed field for Surface Nets: sign follows the cleaned occupancy (so the
  // cleanup's hole-fills and floater-removals are respected), magnitude follows
  // the real density (so the isosurface crossing lands sub-voxel on the actual
  // Gaussian surface). Synthesized voxels sit ~at the cell boundary.
  const EPS = 1e-3;
  const field = new Float32Array(dens.length);
  for (let c = 0; c < dens.length; c++) {
    const d = dens[c] - iso;
    field[c] = occ[c] ? Math.max(EPS, d) : Math.min(-EPS, d);
  }

  // pass 3: Surface Nets on the density field — one vertex per surface-straddling
  // cell, placed at the interpolated (sub-voxel) crossing of its edges, then
  // relaxed with Taubin smoothing into a smooth mesh that hugs the real surface.
  const sn = surfaceNets(field, gx, gy, gz, minX, minY, minZ, vs);
  taubinSmooth(sn.positions, sn.index, taubinIters);

  // Flatten the floor: the real floor is flat at y=0 (leveling), but the density
  // isosurface reconstructs it slightly wavy. Snap vertices within a thin band of
  // y=0 flat so walking is smooth. The band is small so low clutter above it
  // (toys, box lips) keeps its real height and stays collidable.
  const floorBand = (opts.floorFlat ?? 0.75) * vs;
  if (floorBand > 0) for (let i = 1; i < sn.positions.length; i += 3) if (sn.positions[i] < floorBand) sn.positions[i] = 0;

  // Safety floor plane at y=0. Leveling puts the real floor there, and the
  // reconstructed mesh isn't watertight (holes in walls/cabinet fronts let a
  // capsule slip through and fall). A plane spanning the grid backstops every
  // gap — the character always has floor — while walls/furniture (above it) still
  // collide from the surface mesh.
  const nv = sn.positions.length / 3;
  // Sit the plane just below y=0 so a real reconstructed floor (snapped to 0) is
  // hit first by downward rays — lets the spawn search tell "real floor" from
  // "fell through to the backstop plane".
  const planeY = -vs * 0.5;
  const px0 = minX, px1 = minX + gx * vs, pz0 = minZ, pz1 = minZ + gz * vs;
  const meshPos = new Float32Array(sn.positions.length + 12);
  meshPos.set(sn.positions);
  meshPos.set([px0, planeY, pz0, px1, planeY, pz0, px1, planeY, pz1, px0, planeY, pz1], sn.positions.length);
  const meshIdx = new Uint32Array(sn.index.length + 6);
  meshIdx.set(sn.index);
  meshIdx.set([nv, nv + 2, nv + 1, nv, nv + 3, nv + 2], sn.index.length); // +Y-facing

  return {
    positions: meshPos,
    index: meshIdx,
    voxelSize: vs,
    occupiedCount: occupied,
    triangleCount: meshIdx.length / 3,
  };
}

/** Naive Surface Nets over a signed scalar field (>0 inside) → smooth indexed
 *  mesh. Edge crossings are interpolated from the field, so vertices land
 *  sub-voxel on the real isosurface rather than at cell boundaries. */
function surfaceNets(
  field: Float32Array, gx: number, gy: number, gz: number,
  minX: number, minY: number, minZ: number, vs: number,
): { positions: Float32Array; index: Uint32Array } {
  const sx = gy * gz, sy = gz; // strides; R per axis = [sx, sy, 1]
  const R = [sx, sy, 1];
  const cellVert = new Int32Array(field.length).fill(-1);
  const pos: number[] = [];
  const idx: number[] = [];
  const g = new Float32Array(8); // the cell's 8 corner field values
  for (let x = 0; x < gx - 1; x++)
    for (let y = 0; y < gy - 1; y++)
      for (let z = 0; z < gz - 1; z++) {
        const cur = (x * gy + y) * gz + z;
        // 8 corner values (corner g bits: +x=1, +y=2, +z=4) → sign mask
        g[0] = field[cur]; g[1] = field[cur + sx]; g[2] = field[cur + sy]; g[3] = field[cur + sx + sy];
        g[4] = field[cur + 1]; g[5] = field[cur + sx + 1]; g[6] = field[cur + sy + 1]; g[7] = field[cur + sx + sy + 1];
        let mask = 0;
        for (let i = 0; i < 8; i++) if (g[i] > 0) mask |= 1 << i;
        if (mask === 0 || mask === 255) continue;
        // vertex = mean of the interpolated crossing points (local cell coords 0..1)
        const em = EDGE_TABLE[mask];
        let ex = 0, ey = 0, ez = 0, ec = 0;
        for (let e = 0; e < 12; e++) {
          if (!(em & (1 << e))) continue;
          const a = CUBE_EDGES[e * 2], b = CUBE_EDGES[e * 2 + 1];
          const fa = g[a], fb = g[b], denom = fa - fb;
          const t = Math.abs(denom) > 1e-8 ? fa / denom : 0.5; // crossing param a→b
          for (let axis = 0; axis < 3; axis++) {
            const aa = (a >> axis) & 1, bb = (b >> axis) & 1;
            const coord = aa === bb ? aa : aa + t * (bb - aa);
            if (axis === 0) ex += coord; else if (axis === 1) ey += coord; else ez += coord;
          }
          ec++;
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
