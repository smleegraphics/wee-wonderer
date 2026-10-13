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
//   fillFloor — fill the gaps in the surface the figurine plays on (fillGround)
// then Taubin smoothing relaxes the mesh (no occupancy drift).

export interface VoxelOptions {
  iso?: number;        // isovalue as a fraction of the median surface density (default 0.35)
  despeckle?: number;  // remove solid components smaller than this many voxels (default 20; 0 = off)
  close?: number;      // morphological-close iterations, fills holes/gaps (default 1; 0 = off)
  fillFloor?: number;  // fill gaps in the surface the figurine plays on: 0 = off, 1 = enclosed holes only, more = on the ground, also bare stretches nothing this many voxels wide can get into (fillGround)
  panelFill?: number;  // fill enclosed holes in vertical panels up to this area, in NORMALIZED scan units² (~room-relative, not metres — world coords are scaled to TARGET_RADIUS); blank cabinet doors / walls; 0 = off (default 2.5)
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
  cov?: ArrayLike<number> | null, // per-splat 3-D covariance (6 floats: Cxx,Cxy,Cxz,Cyy,Cyz,Czz) for anisotropic splatting
): VoxelSurface {
  const isoFactor = opts.iso ?? 0.35;
  const despeckleMin = opts.despeckle ?? 20;
  const closeIters = opts.close ?? 1;
  const smoothPasses = opts.smooth ?? 0;
  const taubinIters = opts.taubin ?? 6;
  const groundFill = opts.fillFloor ?? 1;
  const panelArea = opts.panelFill ?? 2.5; // vertical-panel hole-fill cap, in normalized world units² (~room-relative; 0 = off)

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

  // pass 2: accumulate opacity mass per voxel → a density field. Each splat is an
  // anisotropic 3-D Gaussian: its covariance is an ellipsoid — a thin DISK for a flat
  // wall/floor splat. We add its opacity to the voxels inside that ellipsoid, weighted
  // by the Gaussian and normalised so each splat's total stays its opacity. Spreading
  // ALONG a flat surface fills sparse panels (a plain cabinet door has few splat
  // centres), while NOT spreading perpendicular keeps the surface hugging the real
  // splats (no puffing / hovering). Tiny floaters stay ~1 faint voxel and get rejected.
  const dens = new Float32Array(gx * gy * gz);
  const centerBin = (cx: number, cy: number, cz: number, op: number) => {
    const vx = Math.floor(cx), vy = Math.floor(cy), vz = Math.floor(cz);
    if (vx >= 0 && vx < gx && vy >= 0 && vy < gy && vz >= 0 && vz < gz) dens[(vx * gy + vy) * gz + vz] += op;
  };
  // linear (rotation × uniform-scale) part of the world matrix, row-major 3×3
  const L0 = m[0], L1 = m[4], L2 = m[8], L3 = m[1], L4 = m[5], L5 = m[9], L6 = m[2], L7 = m[6], L8 = m[10];
  const inv2 = 1 / (vs * vs); // world → voxel² scale for the covariance
  // Floor each world-axis variance to a small epsilon (voxel²). This keeps the
  // covariance invertible for razor-flat splats WITHOUT inflating the surface
  // perpendicular: at 0.05 a flat splat spreads ~1 voxel thick (√0.05·σ), not the
  // ±2-voxel slab a larger floor produced (which made floors/items hover & bloat).
  const MIN_VAR = 0.05;
  const MAX_R = 3, SIGMA = 2.5;
  const wbuf = new Float32Array((2 * MAX_R + 1) ** 3); // per-splat weights, reused pass A → pass B
  for (let i = 0; i < count; i++) {
    const cx = (wx(i) - minX) / vs, cy = (wy(i) - minY) / vs, cz = (wz(i) - minZ) / vs;
    const op = opacity[i];
    if (!cov) { centerBin(cx, cy, cz, op); continue; }
    const a = cov[i * 6], b = cov[i * 6 + 1], c = cov[i * 6 + 2], d = cov[i * 6 + 3], e = cov[i * 6 + 4], f = cov[i * 6 + 5];
    // world covariance in voxel units = (L·Σ·Lᵀ)/vs², inlined (hot loop). Each Wab is
    // rowA(L)ᵀ · Σ · rowB(L) for the symmetric local Σ [a,b,c; b,d,e; c,e,f].
    const W00 = (a * L0 * L0 + d * L1 * L1 + f * L2 * L2 + 2 * (b * L0 * L1 + c * L0 * L2 + e * L1 * L2)) * inv2 + MIN_VAR;
    const W11 = (a * L3 * L3 + d * L4 * L4 + f * L5 * L5 + 2 * (b * L3 * L4 + c * L3 * L5 + e * L4 * L5)) * inv2 + MIN_VAR;
    const W22 = (a * L6 * L6 + d * L7 * L7 + f * L8 * L8 + 2 * (b * L6 * L7 + c * L6 * L8 + e * L7 * L8)) * inv2 + MIN_VAR;
    const W01 = (a * L0 * L3 + d * L1 * L4 + f * L2 * L5 + b * (L0 * L4 + L1 * L3) + c * (L0 * L5 + L2 * L3) + e * (L1 * L5 + L2 * L4)) * inv2;
    const W02 = (a * L0 * L6 + d * L1 * L7 + f * L2 * L8 + b * (L0 * L7 + L1 * L6) + c * (L0 * L8 + L2 * L6) + e * (L1 * L8 + L2 * L7)) * inv2;
    const W12 = (a * L3 * L6 + d * L4 * L7 + f * L5 * L8 + b * (L3 * L7 + L4 * L6) + c * (L3 * L8 + L5 * L6) + e * (L4 * L8 + L5 * L7)) * inv2;
    const det = W00 * (W11 * W22 - W12 * W12) - W01 * (W01 * W22 - W12 * W02) + W02 * (W01 * W12 - W11 * W02);
    if (!(det > 1e-9)) { centerBin(cx, cy, cz, op); continue; }
    const idet = 1 / det; // inverse covariance (symmetric) → the anisotropic distance metric
    const I00 = (W11 * W22 - W12 * W12) * idet, I11 = (W00 * W22 - W02 * W02) * idet, I22 = (W00 * W11 - W01 * W01) * idet;
    const I01 = (W02 * W12 - W01 * W22) * idet, I02 = (W01 * W12 - W02 * W11) * idet, I12 = (W01 * W02 - W00 * W12) * idet;
    const rx = Math.min(MAX_R, Math.ceil(SIGMA * Math.sqrt(W00))), ry = Math.min(MAX_R, Math.ceil(SIGMA * Math.sqrt(W11))), rz = Math.min(MAX_R, Math.ceil(SIGMA * Math.sqrt(W22)));
    const vxc = Math.floor(cx), vyc = Math.floor(cy), vzc = Math.floor(cz);
    // pass A: Gaussian weight at each footprint voxel → wbuf; sum for mass normalisation
    let sw = 0, n = 0;
    for (let dx = -rx; dx <= rx; dx++) {
      const vx = vxc + dx, ddx = vx + 0.5 - cx, inx = vx >= 0 && vx < gx;
      for (let dy = -ry; dy <= ry; dy++) {
        const vy = vyc + dy, ddy = vy + 0.5 - cy, iny = inx && vy >= 0 && vy < gy;
        for (let dz = -rz; dz <= rz; dz++) {
          const vz = vzc + dz, ddz = vz + 0.5 - cz;
          if (!iny || vz < 0 || vz >= gz) { wbuf[n++] = 0; continue; } // outside grid → no mass
          const s = I00 * ddx * ddx + I11 * ddy * ddy + I22 * ddz * ddz + 2 * (I01 * ddx * ddy + I02 * ddx * ddz + I12 * ddy * ddz);
          const w = s > 12 ? 0 : Math.exp(-0.5 * s);
          wbuf[n++] = w; sw += w;
        }
      }
    }
    if (sw <= 0) { centerBin(cx, cy, cz, op); continue; }
    // pass B: distribute opacity by the normalised weights (voxels with w>0 are in-grid)
    const scale = op / sw; n = 0;
    for (let dx = -rx; dx <= rx; dx++) {
      const vx = vxc + dx;
      for (let dy = -ry; dy <= ry; dy++) {
        const vy = vyc + dy;
        for (let dz = -rz; dz <= rz; dz++) {
          const w = wbuf[n++];
          if (w > 0) dens[(vx * gy + vy) * gz + (vzc + dz)] += w * scale;
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
  if (groundFill > 0) fillGround(occ, gx, gy, gz, -minX / vs, -minZ / vs, groundFill); // (the scan is centred on the world's origin)
  // ASSUMES a single, nav-confined room: this fills ANY enclosed vertical-panel hole
  // up to the area cap, so a real passage (doorway/window) of that size would be walled
  // off. Safe because the character can't reach such openings here; revisit for
  // multi-room scans (would need to tell a furniture panel from a passage — see PR #7).
  if (panelArea > 0) fillVerticalPanelHoles(occ, gx, gy, gz, Math.round(panelArea / (vs * vs)));
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

  // Flatten the floor so walking is smooth. The density isosurface reconstructs the
  // floor slightly wavy AND — crucially — not exactly at y=0: leveling places y=0 at
  // the floor SPLAT plane, but the reconstructed surface sits a bit below it, so
  // snapping to a hardcoded 0 would LIFT the collision floor above the real floor
  // (the figurine would hover). Instead we detect the floor's actual level (the median
  // height of the low band) and flatten to THAT — flat and flush. The band stays
  // one-sided so low clutter above it (toys, box lips) keeps its real height.
  const floorBand = (opts.floorFlat ?? 0.75) * vs;
  let floorLevel = 0;
  if (floorBand > 0) {
    const fv: number[] = [];
    for (let i = 1; i < sn.positions.length; i += 3) if (sn.positions[i] < floorBand) fv.push(sn.positions[i]);
    if (fv.length) { fv.sort((a, b) => a - b); floorLevel = fv[fv.length >> 1]; }
    for (let i = 1; i < sn.positions.length; i += 3) if (sn.positions[i] < floorBand) sn.positions[i] = floorLevel;
  }

  // Safety floor plane at y=0. Leveling puts the real floor there, and the
  // reconstructed mesh isn't watertight (holes in walls/cabinet fronts let a
  // capsule slip through and fall). A plane spanning the grid backstops every
  // gap — the character always has floor — while walls/furniture (above it) still
  // collide from the surface mesh.
  const nv = sn.positions.length / 3;
  // Sit the plane just below the detected floor level so the real reconstructed floor
  // is hit first by downward rays — lets the spawn search tell "real floor" from
  // "fell through to the backstop plane".
  const planeY = floorLevel - vs * 0.5;
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

const STAND_ROOM = 5;    // voxels of clear space over a surface for it to be somewhere to stand: about the figurine's height (a voxel is a fifth of it)
const START_NEAR = 10;   // voxels round the scan's centre in which the level the figurine starts on is looked for
const RAISED = 0.05;     // a level with more than this share of the scan's solid voxels below it is raised, not the ground (rooms: none below their floor; Kitchen's table 13%, Counter's worktop 26%)

/**
 * Fill the gaps in the surface the figurine plays on.
 *
 * Which surface: the level it starts on, found the way the spawn search finds it (the
 * lowest place with room to stand, near the scan's centre: findSpawn in collision.ts).
 * In a room that is the floor; on a scan of a worktop it is the worktop, with the real
 * floor somewhere below. (It used to be "the busiest row in the lower third", which on
 * a worktop scan is that real floor, a layer the figurine never stands on.)
 *
 * Two kinds of gap are filled, in that level's row and the one over it:
 *  - holes with the surface all round them, as before (fillSlice);
 *  - where the level is the ground, and `width` is more than 1, bare stretches that
 *    something `width` voxels across cannot get into from outside, when the surface and
 *    whatever stands on it (walls, furniture) are in its way. A one-voxel flood leaks
 *    through any crack; a wide one is kept out of bays between furniture, and still gets
 *    in where a whole wall is missing.
 * The second is for ground only. Beside a raised surface there can be open air (the
 * aisle between two worktops); beside the ground there cannot. The level is raised when
 * a fair share of the scan's solid voxels lie below it.
 */
function fillGround(occ: Uint8Array, gx: number, gy: number, gz: number, ox: number, oz: number, width: number): void {
  const sx = gy * gz, sy = gz, n = gx * gz;
  /** The lowest row in column (x, z) with something solid and room to stand on it, or -1. */
  const standRow = (x: number, z: number) => {
    const c = x * sx + z;
    for (let y = 0; y < gy; y++) {
      if (!occ[c + y * sy]) continue;
      let clear = true;
      for (let u = y + 1; u <= Math.min(gy - 1, y + STAND_ROOM); u++) if (occ[c + u * sy]) { clear = false; break; }
      if (clear) return y;
    }
    return -1;
  };
  // the level the figurine starts on: the commonest such row near the centre (one toy there does not decide it), or anywhere if there is none
  const tally = new Int32Array(gy);
  let any = false;
  for (const near of [START_NEAR, Infinity]) {
    for (let x = 0; x < gx; x++)
      for (let z = 0; z < gz; z++) {
        if (Math.hypot(x - ox, z - oz) > near) continue;
        const y = standRow(x, z);
        if (y >= 0) { tally[y]++; any = true; }
      }
    if (any) break;
  }
  if (!any) return;
  let top = 0;
  for (let y = 1; y < gy; y++) if (tally[y] > tally[top]) top = y;
  const rows = [top, Math.min(gy - 1, top + 1)]; // the level, and the row over it, where the surface is a voxel higher
  for (const y of new Set(rows)) fillSlice(occ, gx, gy, gz, y);
  if (width <= 1) return;

  let solid = 0, beneath = 0;
  for (let x = 0; x < gx; x++) for (let y = 0; y < gy; y++) for (let z = 0; z < gz; z++) if (occ[x * sx + y * sy + z]) { solid++; if (y < top - 1) beneath++; }
  if (beneath > RAISED * solid) return; // a raised surface

  const here = new Uint8Array(n), wall = new Uint8Array(n), under = new Uint8Array(n);
  for (let x = 0; x < gx; x++)
    for (let z = 0; z < gz; z++) {
      const k = x * gz + z, c = x * sx + z;
      if (occ[c + rows[0] * sy] || occ[c + rows[1] * sy]) here[k] = 1;
      for (let y = rows[1] + 1; y <= Math.min(gy - 1, rows[1] + STAND_ROOM); y++) if (occ[c + y * sy]) { wall[k] = 1; break; }
      for (let y = 0; y < top - 1; y++) if (occ[c + y * sy]) { under[k] = 1; break; }
      if (here[k]) wall[k] = 1; // (from here on: everything in the flood's way)
    }
  // where something `width` across can get to from the grid's border without touching what is in its way...
  const radius = width / 2, clear = distanceTo(wall, gx, gz), reached = new Uint8Array(n), queue = new Int32Array(n);
  let tail = 0;
  const enter = (x: number, z: number) => { const k = x * gz + z; if (!reached[k] && clear[k] >= radius) { reached[k] = 1; queue[tail++] = k; } };
  for (let x = 0; x < gx; x++) { enter(x, 0); enter(x, gz - 1); }
  for (let z = 0; z < gz; z++) { enter(0, z); enter(gx - 1, z); }
  for (let h = 0; h < tail; h++) {
    const x = Math.floor(queue[h] / gz), z = queue[h] % gz;
    if (x > 0) enter(x - 1, z); if (x < gx - 1) enter(x + 1, z); if (z > 0) enter(x, z - 1); if (z < gz - 1) enter(x, z + 1);
  }
  // ...and everything it covers there is outside. The rest of the level is ground, unless the scan has something beneath it.
  const outside = distanceTo(reached, gx, gz);
  for (let k = 0; k < n; k++) {
    if (here[k] || under[k] || outside[k] <= radius) continue;
    const c = Math.floor(k / gz) * sx + (k % gz);
    for (const y of rows) occ[c + y * sy] = 1;
  }
}

/** Per column, the distance in voxels to the nearest set column of `mask` (3-4 chamfer: within a few percent of straight-line). */
function distanceTo(mask: Uint8Array, gx: number, gz: number): Float32Array {
  const d = new Float32Array(gx * gz);
  for (let k = 0; k < d.length; k++) d[k] = mask[k] ? 0 : Infinity;
  const relax = (k: number, x: number, z: number, dx: number, dz: number, cost: number) => {
    const X = x + dx, Z = z + dz;
    if (X >= 0 && X < gx && Z >= 0 && Z < gz && d[X * gz + Z] + cost < d[k]) d[k] = d[X * gz + Z] + cost;
  };
  for (let x = 0; x < gx; x++) for (let z = 0; z < gz; z++) { const k = x * gz + z; relax(k, x, z, -1, 0, 3); relax(k, x, z, 0, -1, 3); relax(k, x, z, -1, -1, 4); relax(k, x, z, -1, 1, 4); }
  for (let x = gx - 1; x >= 0; x--) for (let z = gz - 1; z >= 0; z--) { const k = x * gz + z; relax(k, x, z, 1, 0, 3); relax(k, x, z, 0, 1, 3); relax(k, x, z, 1, 1, 4); relax(k, x, z, 1, -1, 4); }
  for (let k = 0; k < d.length; k++) d[k] /= 3;
  return d;
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

/**
 * Fill enclosed holes in vertical flat panels that splatting left empty — most
 * visibly blank cabinet/furniture doors. A featureless painted surface gives weak
 * photometric signal, so it's reconstructed as sparse/low-opacity splats that fall
 * below any density threshold (and the floater cleaner strips them entirely) — so the
 * door's OWN splats can't be used. But the panel reads as a hole fully enclosed,
 * within its own plane, by the meshed frame/edges around it, which ARE captured. So
 * we recover it geometrically: for each dense slice perpendicular to X and to Z (the
 * vertical planes) we flood the "outside" in from the slice border and fill any
 * enclosed empty region up to `maxCells` in area. The area cap keeps it honest — a
 * door-sized gap fills; larger openings (which in a single-room scene can only be
 * windows/doorways the character never uses) stay open. Horizontal panels (floor,
 * tabletops) are handled by fillGround.
 */
function fillVerticalPanelHoles(occ: Uint8Array, gx: number, gy: number, gz: number, maxCells: number): void {
  const dims = [gx, gy, gz], strides = [gy * gz, gz, 1];
  fillAxisHoles(occ, dims, strides, 0, maxCells); // YZ slices — panels facing ±X
  fillAxisHoles(occ, dims, strides, 2, maxCells); // XY slices — panels facing ±Z
}

/** Fill size-capped enclosed holes in each dense slice ⟂ `axis`. */
function fillAxisHoles(occ: Uint8Array, dims: number[], strides: number[], axis: number, maxCells: number): void {
  const na = dims[axis], sa = strides[axis];
  const others = [0, 1, 2].filter((x) => x !== axis);
  const u = others[0], v = others[1];
  const nu = dims[u], nv = dims[v], su = strides[u], sv = strides[v];
  // per-slice occupancy → only process slices dense enough to be a real surface plane
  let maxCount = 0;
  const counts = new Int32Array(na);
  for (let a = 0; a < na; a++) {
    let c = 0; const base = a * sa;
    for (let iu = 0; iu < nu; iu++) { const bu = base + iu * su; for (let iv = 0; iv < nv; iv++) if (occ[bu + iv * sv]) c++; }
    counts[a] = c; if (c > maxCount) maxCount = c;
  }
  // Only process slices dense enough to be a real surface plane. Best-effort heuristic:
  // on a scan where one plane dominates (a big wall), a smaller cabinet's slices can
  // fall below this bar and its doors won't fill — a known cause of the occasional
  // unfilled panel. An absolute floor would be more robust if this proves too coarse.
  const domThresh = 0.2 * maxCount;
  const seen = new Uint8Array(nu * nv);
  const stack: number[] = [], comp: number[] = [];
  for (let a = 0; a < na; a++) {
    if (counts[a] === 0 || counts[a] < domThresh) continue;
    const base = a * sa;
    seen.fill(0);
    // flood the outside from the slice border through empty cells
    stack.length = 0;
    const pushOut = (iu: number, iv: number) => { const k = iu * nv + iv; if (!seen[k] && !occ[base + iu * su + iv * sv]) { seen[k] = 1; stack.push(iu, iv); } };
    for (let iu = 0; iu < nu; iu++) { pushOut(iu, 0); pushOut(iu, nv - 1); }
    for (let iv = 0; iv < nv; iv++) { pushOut(0, iv); pushOut(nu - 1, iv); }
    while (stack.length) {
      const iv = stack.pop()!, iu = stack.pop()!;
      if (iu > 0) pushOut(iu - 1, iv); if (iu < nu - 1) pushOut(iu + 1, iv);
      if (iv > 0) pushOut(iu, iv - 1); if (iv < nv - 1) pushOut(iu, iv + 1);
    }
    // each enclosed empty region (not occupied, not reached from outside) → fill if ≤ cap
    for (let iu = 0; iu < nu; iu++)
      for (let iv = 0; iv < nv; iv++) {
        if (occ[base + iu * su + iv * sv] || seen[iu * nv + iv]) continue;
        comp.length = 0; stack.length = 0; seen[iu * nv + iv] = 1; stack.push(iu, iv);
        while (stack.length) {
          const jv = stack.pop()!, ju = stack.pop()!; comp.push(ju, jv);
          const grow = (pu: number, pv: number) => { const kk = pu * nv + pv; if (!seen[kk] && !occ[base + pu * su + pv * sv]) { seen[kk] = 1; stack.push(pu, pv); } };
          if (ju > 0) grow(ju - 1, jv); if (ju < nu - 1) grow(ju + 1, jv);
          if (jv > 0) grow(ju, jv - 1); if (jv < nv - 1) grow(ju, jv + 1);
        }
        if (comp.length / 2 <= maxCells) for (let m = 0; m < comp.length; m += 2) occ[base + comp[m] * su + comp[m + 1] * sv] = 1;
      }
  }
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
