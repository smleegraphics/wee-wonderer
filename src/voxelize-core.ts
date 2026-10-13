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
  despeckle?: number;  // remove solid components smaller than this many voxels of the unit grain (default 20; 0 = off)
  close?: number;      // morphological close by this many units: fills holes/gaps (default 1; 0 = off)
  fillFloor?: number;  // fill gaps in the surface the figurine plays on: 0 = off, 1 = enclosed holes only, more = on the ground, also bare stretches nothing this many units wide can get into (fillGround)
  panelFill?: number;  // fill enclosed holes in vertical panels up to this area, in NORMALIZED scan units² (~room-relative, not metres — world coords are scaled to TARGET_RADIUS); blank cabinet doors / walls; 0 = off (default 2.5)
  smooth?: number;     // majority-filter passes on occupancy (default 0; Taubin handles smoothing)
  taubin?: number;     // Taubin mesh-smoothing iterations (default 6; 0 = off)
  floorFlat?: number;  // flatten the mesh onto the ground's splats within this many units of them (default 1.5; 0 = off)
  refine?: number;     // build the mesh on a grid up to this many times finer than the one that decides what is solid, if the scan has the splats for it (default 1 = the same grid; refineSolid)
}

export interface VoxelSurface {
  positions: Float32Array; // world-space smooth surface vertices (x,y,z,...)
  index: Uint32Array;      // triangle indices
  voxelSize: number;
  occupiedCount: number;
  detail: number;          // how many times finer than the voxels the grid the mesh was built on is (1: the same; see `refine`)
  groundY: number | null;  // the height (world) of the ground the figurine plays on: a room's floor, a table's top. null if the scan has nowhere to stand
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
  unit: number = voxelSize, // the length the options' sizes are counted in (see `per` below); the voxel size itself unless a finer grid is asked for
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
    return { positions: new Float32Array(0), index: new Uint32Array(0), voxelSize, occupiedCount: 0, detail: 1, groundY: null, triangleCount: 0 };

  // choose the voxel size, coarsening it if the dense grid would be too large to
  // allocate — a hard cap against a pathological extent OOMing the worker.
  let vs = voxelSize;
  const cellsAt = (s: number) =>
    (Math.ceil((maxX - minX) / s) + 4) * (Math.ceil((maxY - minY) / s) + 4) * (Math.ceil((maxZ - minZ) / s) + 4);
  const MAX_CELLS = 48_000_000;
  if (cellsAt(vs) > MAX_CELLS) vs *= Math.cbrt(cellsAt(vs) / MAX_CELLS) * 1.02;

  // Sizes below that are about the scan (how wide a gap to close, how much headroom is
  // room to stand, how small a blob is a speck) are given in `unit`s, the grain they were
  // tuned at, and turned into voxels here: so the same settings mean the same thing on a
  // finer grid. Sizes that are about the grid itself (MIN_VAR, Taubin passes) stay in voxels.
  const per = unit / vs, perArea = per * per; // voxels to a unit, along a line and over an area

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
  /** The splats' opacity as a density on a grid of `vs`-sized voxels with its corner at
   *  (minX, minY, minZ): pass 2, below. A splat is spread over at most MAX_R voxels each way. */
  const splatDensity = (vs: number, gx: number, gy: number, gz: number, minX: number, minY: number, minZ: number, MAX_R: number): Float32Array => {
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
    const SIGMA = 2.5;
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
    return dens;
  };
  const dens = splatDensity(vs, gx, gy, gz, minX, minY, minZ, Math.max(1, Math.round(3 * per))); // spread over at most 3 units each way

  // isovalue: a fraction of the median density among voxels that hold real
  // surface (>= ~1 opaque splat to a unit of area) — derived, so it scales to any scan.
  // A surface's opacity is so much to an area, so a voxel's share of it goes with the
  // voxel's face: these two thresholds are per unit of area.
  const strong: number[] = [];
  for (let c = 0; c < dens.length; c++) if (dens[c] >= 1 / perArea) strong.push(dens[c]);
  strong.sort((a, b) => a - b);
  const medianStrong = strong.length ? strong[strong.length >> 1] : 1 / perArea;
  const iso = Math.max(0.2 / perArea, isoFactor * medianStrong);

  // binary occupancy (density above the isovalue) for the cleanup passes
  let occ: Uint8Array = new Uint8Array(dens.length);
  for (let c = 0; c < dens.length; c++) occ[c] = dens[c] >= iso ? 1 : 0;
  if (despeckleMin > 0) despeckle(occ, gy, gz, Math.round(despeckleMin * perArea)); // (a speck is a scrap of surface: so many voxels to an area)
  const closeVoxels = Math.round(closeIters * per);
  for (let i = 0; i < closeVoxels; i++) occ = dilate(occ, gx, gy, gz);
  for (let i = 0; i < closeVoxels; i++) occ = erode(occ, gx, gy, gz);
  const ground = groundRow(occ, gx, gy, gz, -minX / vs, -minZ / vs, per); // (the scan is centred on the world's origin)
  if (groundFill > 0 && ground >= 0) fillGround(occ, gx, gy, gz, ground, groundFill, per);
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
  const fieldOf = (occ: Uint8Array, dens: Float32Array, iso: number) => {
    const field = new Float32Array(dens.length);
    for (let c = 0; c < dens.length; c++) {
      const d = dens[c] - iso;
      field[c] = occ[c] ? Math.max(EPS, d) : Math.min(-EPS, d);
    }
    return field;
  };

  // pass 3: Surface Nets on the density field — one vertex per surface-straddling
  // cell, placed at the interpolated (sub-voxel) crossing of its edges, then
  // relaxed with Taubin smoothing into a smooth mesh that hugs the real surface.
  //
  // With `refine` > 1 that is done on a grid that many times finer, on a solid trimmed
  // to it (refineSolid): what is solid was decided above, on the coarse grid, where a
  // thinly scanned wall still adds up to a wall; where exactly its surface is, is then
  // read off the finer one. Skipped if the finer grid would be too large to hold.
  // The ground: the level the figurine plays on (the floor of a room, the top of a table),
  // the height its splats are at, and how far either side of that the mesh is flattened
  // onto it (below). The height is where the scan's opacity is greatest within
  // GROUND_SEARCH of that level's row.
  //
  // Only ground that is flat is flattened. Whether it is, is read from its splats too: on
  // a floor or a tabletop a fair share of the opacity near the ground is splats that
  // themselves lie flat, at one height (Playroom 15%, the other rooms and tables 4%); on
  // ground that is not flat there are next to none (Marishka, a dog on a blanket: under
  // half a percent). Flattened regardless, such ground is cut into terraces.
  const { level: groundLevel, flat: groundFlat } = (() => {
    if (ground < 0) return { level: 0, flat: false };
    const about = minY + (ground + 0.5) * vs, span = GROUND_SEARCH * unit, BINS = 8 * GROUND_SEARCH * 2; // eight bins to a unit
    const hist = new Float64Array(BINS), lying = new Float64Array(BINS);
    // the spread of splat i along two world axes (rows a and b of the matrix's linear part)
    const spread = (i: number, a: number, b: number) => {
      const a0 = m[a], a1 = m[4 + a], a2 = m[8 + a], b0 = m[b], b1 = m[4 + b], b2 = m[8 + b], c = i * 6;
      return cov![c] * a0 * b0 + cov![c + 3] * a1 * b1 + cov![c + 5] * a2 * b2 + cov![c + 1] * (a0 * b1 + a1 * b0) + cov![c + 2] * (a0 * b2 + a2 * b0) + cov![c + 4] * (a1 * b2 + a2 * b1);
    };
    for (let i = 0; i < count; i++) {
      const b = Math.floor(((wy(i) - about + span) / (2 * span)) * BINS);
      if (b < 0 || b >= BINS) continue;
      hist[b] += opacity[i];
      if (cov && Math.sqrt(spread(i, 1, 1)) < LIES_FLAT_GROUND * Math.sqrt(Math.sqrt(Math.max(0, spread(i, 0, 0) * spread(i, 2, 2) - spread(i, 0, 2) ** 2)))) lying[b] += opacity[i];
    }
    const peak = (h: Float64Array) => { let best = 0, most = -1; for (let b = 1; b < BINS - 1; b++) { const v = h[b - 1] + 2 * h[b] + h[b + 1]; if (v > most) { most = v; best = b; } } return most > 0 ? best : -1; };
    const best = peak(hist);
    if (best < 0) return { level: about, flat: false };
    let sum = 0, weight = 0; // the peak's own centre, between bins
    for (let b = Math.max(0, best - 2); b <= Math.min(BINS - 1, best + 2); b++) { sum += hist[b] * (b + 0.5); weight += hist[b]; }
    let all = 0, level = 0;
    const at = peak(lying);
    for (let b = 0; b < BINS; b++) { all += hist[b]; if (at >= 0 && Math.abs(b - at) <= 4) level += lying[b]; } // (within half a unit of the flat-lying splats' own peak)
    return { level: about + (sum / weight / BINS) * 2 * span - span, flat: !cov || level >= GROUND_FLAT * all }; // (with no shapes to go by, as before: taken as flat)
  })();
  const flatten = groundFlat ? (opts.floorFlat ?? 1.5) * unit : 0;

  //
  // How much finer is the scan's to say: as fine as it has splats for, up to `refine`.
  // The finer grid's density is only worth reading where there are several splats to a
  // fine voxel; with fewer it is noise, and a mesh trimmed to noise is pitted and rough.
  // Of the five scans this was tried on, one has the splats for a grid twice as fine
  // (Playroom: 37 to a solid voxel, so 4.6 to a fine one) and comes out better for it;
  // the other four have 4 to 17 (0.6 to 2.1) and come out bumpier, at no gain.
  const perVoxel = occupied ? count / occupied : 0;
  let detail = 1;
  for (let s = 2; s <= Math.round(opts.refine ?? 1) && perVoxel / (s * s * s) >= SPLATS_PER_FINE_VOXEL; s++) detail = s;
  const fine = refineSolid(occ, gx, gy, gz, detail, MAX_CELLS);
  let sn: { positions: Float32Array; index: Uint32Array };
  if (fine) {
    const { s, x0, y0, z0, nx, ny, nz } = fine, fvs = vs / s, fx = minX + x0 * vs, fy = minY + y0 * vs, fz = minZ + z0 * vs;
    const fdens = splatDensity(fvs, nx, ny, nz, fx, fy, fz, Math.max(1, Math.round(3 * per * s)));
    // The trim reads the density evened out over neighbouring voxels. Voxel by voxel, a
    // sparse scan's density on the fine grid is noise (that is why the coarse grid decides
    // what is solid), and a trim that follows it stops at a different depth in every
    // column: the mesh came out three times as bumpy as the coarse one.
    // The ground is left out of it. It is put on its splats another way, below: flattened
    // to the level its surface is found at. Trimmed as well, its surface steps up and down
    // by a fine voxel about the edge of the band that is flattened, and whatever ends up
    // just over that edge is left standing as a bump (Playroom's floor was dotted with them).
    const keepFrom = Math.floor((groundLevel - flatten - fy) / fvs), keepTo = Math.ceil((groundLevel + flatten - fy) / fvs); // the rows that are flattened
    const before = Uint8Array.from(fine.occ);
    fine.trim(blur(fdens, nx, ny, nz, CALM_PASSES), iso / (s * s), flatten > 0 ? [keepFrom, keepTo] : [0, 0]); // (a voxel's share of a sheet's opacity goes with its face)
    // Where the surface goes within its voxel:
    //  - where nothing was trimmed, where the coarse grid's density puts it, read between
    //    the coarse voxels: exactly the surface there would be without refining, on a
    //    finer mesh. (Placed from the solid's shape there too, it sat at the voxel's edge,
    //    half a voxel further out: Playroom's rug rose a grain, the step up to it from the
    //    floor passed what can be walked, and the floor fell into two platforms.)
    //  - where something was trimmed, from the trimmed solid's own shape, evened out: the
    //    coarse density knows nothing of the trim, and the fine one is noise.
    // Either way its sign follows the solid exactly, so placing can move the surface
    // within a voxel but never open or close anything.
    const gone = new Float32Array(before.length);
    for (let c = 0; c < gone.length; c++) gone[c] = before[c] && !fine.occ[c] ? 1 : 0;
    const near = blur(gone, nx, ny, nz, 1), soft = blur(Float32Array.from(fine.occ), nx, ny, nz, 1), field = new Float32Array(soft.length);
    const coarseAt = (X: number, Y: number, Z: number) => { // (density − iso) / iso of the coarse grid at a fine voxel's centre
      const px = Math.min(gx - 1, Math.max(0, x0 + (X + 0.5) / s - 0.5)), py = Math.min(gy - 1, Math.max(0, y0 + (Y + 0.5) / s - 0.5)), pz = Math.min(gz - 1, Math.max(0, z0 + (Z + 0.5) / s - 0.5));
      const ax = Math.min(gx - 2, Math.floor(px)), ay = Math.min(gy - 2, Math.floor(py)), az = Math.min(gz - 2, Math.floor(pz)), tx = px - ax, ty = py - ay, tz = pz - az;
      const c = (ax * gy + ay) * gz + az, sxc = gy * gz, l = (p: number, q: number, t: number) => p + (q - p) * t;
      return l(l(l(dens[c], dens[c + 1], tz), l(dens[c + gz], dens[c + gz + 1], tz), ty), l(l(dens[c + sxc], dens[c + sxc + 1], tz), l(dens[c + sxc + gz], dens[c + sxc + gz + 1], tz), ty), tx) / iso - 1;
    };
    for (let X = 0; X < nx; X++) for (let Y = 0; Y < ny; Y++) for (let Z = 0; Z < nz; Z++) {
      const c = (X * ny + Y) * nz + Z, v = near[c] > 0 ? soft[c] - 0.5 : coarseAt(X, Y, Z);
      field[c] = fine.occ[c] ? Math.max(EPS, v) : Math.min(-EPS, v);
    }
    sn = surfaceNets(field, nx, ny, nz, fx, fy, fz, fvs);
    taubinSmooth(sn.positions, sn.index, taubinIters * s); // the solid's steps are still the coarse grid's where nothing was trimmed: the same smoothing, in finer steps
  } else {
    sn = surfaceNets(fieldOf(occ, dens, iso), gx, gy, gz, minX, minY, minZ, vs);
    taubinSmooth(sn.positions, sn.index, taubinIters);
  }

  // Flatten the floor so walking is smooth. The density isosurface reconstructs the
  // floor slightly wavy AND — crucially — not exactly at y=0: leveling places y=0 at
  // the floor SPLAT plane, but the reconstructed surface sits a bit below it, so
  // snapping to a hardcoded 0 would LIFT the collision floor above the real floor
  // (the figurine would hover). Instead the floor is flattened to the level its splats
  // are at — flat and flush. The band stays one-sided so low clutter above it (toys,
  // box lips) keeps its real height.
  //
  // Both the level and the band are taken from the ground's own splats (groundLevel,
  // above). They used to be taken from y = 0 and from the mesh: everything under
  // 0.75 units over y = 0 went to the median height of those vertices. But y = 0 is only
  // a low percentile of the scan's heights, and the floor's splats lie a little over it,
  // so that cut ran through the floor's own top surface: part of it was flattened, and to
  // a level the slab's underside dragged below the splats, and the rest was left as it
  // came, up to a grain and a half above them. The floor was in two layers, neither where
  // the floor is drawn (Playroom: 2,390 cells at −0.5 grains and 6,350 at +0.75 to +1.75,
  // its splats at +0.25; Living Room the same).
  //
  // The band reaches as far under the level as over it, to take in the slab's underside,
  // and no further: under a table there are chairs. (It used to take in everything
  // below, which is right for a floor and pulls a table's surroundings up into it.)
  if (flatten > 0) for (let i = 1; i < sn.positions.length; i += 3) if (Math.abs(sn.positions[i] - groundLevel) < flatten) sn.positions[i] = groundLevel;
  // Where the ground is raised clear of y = 0 (a table, a worktop), what the scan has of
  // the real floor down there is flattened too, as it always was: everything under
  // FLOOR_UNDER, to its median height. Left as it comes, its scraps are places to stand,
  // and the spawn search, which takes the lowest one with headroom, starts the figurine
  // in a pocket under Counter's worktop.
  let floorLevel = groundLevel; // for the backstop plane, which goes just under the floor
  if (flatten === 0 || groundLevel - flatten > FLOOR_UNDER * unit) {
    const low: number[] = [];
    for (let i = 1; i < sn.positions.length; i += 3) if (sn.positions[i] < FLOOR_UNDER * unit) low.push(sn.positions[i]);
    floorLevel = low.length ? low.sort((a, b) => a - b)[low.length >> 1] : 0;
    for (let i = 1; i < sn.positions.length; i += 3) if (sn.positions[i] < FLOOR_UNDER * unit) sn.positions[i] = floorLevel;
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
    detail: fine ? detail : 1,
    groundY: ground >= 0 ? groundLevel : null,
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
 * A coarse solid on a grid `s` times finer, ready to be trimmed to the splats.
 *
 * The coarse grid decides WHETHER there is surface: a voxel pools enough of a sparse
 * scan's splats to call a thinly captured wall solid. But a voxel is solid all the way
 * across, so the mesh round it stands about a voxel off the sheet of splats it is there
 * for. On the finer grid the same solid can be cut back to where the splats are.
 * `trim(density, iso)` takes fine voxels off its outside, layer by layer, under three rules:
 *  - on a sheet, only one that is less dense than the voxel behind it, so a face walks in
 *    to where the density peaks and stops there; on a lump, only one the finer grid does
 *    not itself call solid (see mayGo);
 *  - never one whose going would change the solid's shape in kind: open a hole through
 *    it, split it, or join two gaps (a "simple point" test, the standard guarantee of
 *    thinning). So a wall the coarse grid made whole stays whole, however little density
 *    the finer grid finds in it: it only gets thinner;
 *  - only through the solid's thickness, not along it: a voxel goes only along the axis
 *    the solid is thinnest on there, so a sheet is thinned, and neither its free edge nor
 *    a narrow strip of it is eaten back.
 * The first version had the first rule only in spirit ("a denser voxel lies behind") and
 * neither of the others. A thin wall was first cut to one voxel, alternating sides, and
 * the next layers then went in through the steps that left: Playroom's walls came out
 * full of holes, and its sight lines meeting no collision rose from 23% to 32%.
 *
 * Only the box round the solid is refined, not the whole grid. Returns null when `s` is
 * 1, or that box would hold more than `maxCells`.
 */
const CALM_PASSES = 2;  // times the fine density is evened out between neighbouring voxels before the trim reads it

/** `src` (a value per voxel) evened out: each voxel becomes ¼, ½, ¼ of itself and its two neighbours, along each axis in turn, `passes` times. */
function blur(src: Float32Array, nx: number, ny: number, nz: number, passes: number): Float32Array {
  let a: Float32Array = src, b: Float32Array = new Float32Array(src.length);
  const sx = ny * nz, sy = nz;
  for (let pass = 0; pass < passes; pass++)
    for (const [step, n, stride] of [[sx, nx, 0], [sy, ny, 1], [1, nz, 2]]) {
      for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
        const c = (x * ny + y) * nz + z, i = stride === 0 ? x : stride === 1 ? y : z;
        b[c] = 0.5 * a[c] + 0.25 * (i > 0 ? a[c - step] : a[c]) + 0.25 * (i < n - 1 ? a[c + step] : a[c]);
      }
      const t = a === src ? new Float32Array(src.length) : a; a = b; b = t;
    }
  return a;
}

const SHEET_MIN = 2;    // fine voxels: the least a sheet is thinned to
const LUMP_LAYERS = 1;  // fine layers taken off a lump, at most. On a sparse scan most of a lump is under the finer grid's threshold (which is why the coarse grid decides what is solid): taken as deep as a sheet is, Counter lost a third of its walkable area
const TRIM_DEPTH = 1.5; // coarse voxels: how many layers deep the trim may go, from each side. A slab two coarse voxels thick can come down to one fine one

function refineSolid(coarse: Uint8Array, gx: number, gy: number, gz: number, s: number, maxCells: number): {
  s: number; x0: number; y0: number; z0: number; nx: number; ny: number; nz: number; occ: Uint8Array; trim(density: Float32Array, iso: number, keep: number[]): void;
} | null {
  if (s <= 1) return null;
  let x0 = gx, y0 = gy, z0 = gz, x1 = -1, y1 = -1, z1 = -1;
  for (let x = 0; x < gx; x++) for (let y = 0; y < gy; y++) for (let z = 0; z < gz; z++) if (coarse[(x * gy + y) * gz + z]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); z0 = Math.max(0, z0 - 1); // a voxel of room round it, for the mesh to close in
  x1 = Math.min(gx - 1, x1 + 1); y1 = Math.min(gy - 1, y1 + 1); z1 = Math.min(gz - 1, z1 + 1);
  const nx = (x1 - x0 + 1) * s, ny = (y1 - y0 + 1) * s, nz = (z1 - z0 + 1) * s;
  if (nx * ny * nz > maxCells) return null;
  const occ = new Uint8Array(nx * ny * nz);
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) {
    const from = ((x0 + Math.floor(x / s)) * gy + y0 + Math.floor(y / s)) * gz + z0, to = (x * ny + y) * nz;
    for (let z = 0; z < nz; z++) occ[to + z] = coarse[from + Math.floor(z / s)];
  }
  const sx = ny * nz, sy = nz;
  const solidAt = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < nx && y < ny && z < nz && occ[(x * ny + y) * nz + z] === 1;
  const depth = Math.round(TRIM_DEPTH * s), thin = 2 * depth + 1; // a run of solid this long or less is thickness; longer, the solid runs along that way

  // Would taking (x, y, z) out leave the solid the same in kind? Yes if, in the 3 × 3 × 3
  // block round it, the solid voxels that touch it by a face are one piece (joined by
  // faces, through the block less its corners), and the empty ones are one piece too
  // (touching by face, edge or corner). Solid counts as joined only across faces: the
  // mesh drawn round two voxels that meet at an edge or a corner has a gap between them,
  // and counting those as joined let a wall thin to a lattice that sight passed through
  // (Playroom's sight lines meeting no collision: 23.1% to 24.9%).
  const block = new Uint8Array(27), seen = new Uint8Array(27), stack = new Int8Array(27);
  const pieces = (wanted: number, corners: boolean, byFaceOnly: boolean, countFaceTouchingOnly: boolean): number => {
    seen.fill(0);
    let n = 0;
    for (let start = 0; start < 27; start++) {
      if (start === 13 || seen[start] || block[start] !== wanted) continue;
      const ax = Math.floor(start / 9) - 1, ay = Math.floor(start / 3) % 3 - 1, az = start % 3 - 1;
      if (!corners && Math.abs(ax) + Math.abs(ay) + Math.abs(az) === 3) continue;
      let touches = false, top = 0;
      stack[top++] = start; seen[start] = 1;
      while (top) {
        const c = stack[--top], cx = Math.floor(c / 9) - 1, cy = Math.floor(c / 3) % 3 - 1, cz = c % 3 - 1;
        if (Math.abs(cx) + Math.abs(cy) + Math.abs(cz) === 1) touches = true;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
          const steps = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
          if (steps === 0 || (byFaceOnly && steps !== 1)) continue;
          const qx = cx + dx, qy = cy + dy, qz = cz + dz;
          if (qx < -1 || qx > 1 || qy < -1 || qy > 1 || qz < -1 || qz > 1) continue;
          if (!corners && Math.abs(qx) + Math.abs(qy) + Math.abs(qz) === 3) continue;
          const q = (qx + 1) * 9 + (qy + 1) * 3 + qz + 1;
          if (q === 13 || seen[q] || block[q] !== wanted) continue;
          seen[q] = 1; stack[top++] = q;
        }
      }
      if (!countFaceTouchingOnly || touches) n++;
    }
    return n;
  };
  const simple = (x: number, y: number, z: number): boolean => {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) block[(dx + 1) * 9 + (dy + 1) * 3 + dz + 1] = solidAt(x + dx, y + dy, z + dz) ? 1 : 0;
    return pieces(1, false, true, true) === 1 && pieces(0, true, false, false) === 1;
  };
  /** How many solid voxels in a row (x, y, z) is part of along an axis, counted up to `thin` + 1. */
  const run = (x: number, y: number, z: number, dx: number, dy: number, dz: number): number => {
    let n = 1;
    for (let k = 1; n <= thin && solidAt(x + dx * k, y + dy * k, z + dz * k); k++) n++;
    for (let k = 1; n <= thin && solidAt(x - dx * k, y - dy * k, z - dz * k); k++) n++;
    return n;
  };
  const trim = (density: Float32Array, iso: number, keep: number[]) => {
    /** May (x, y, z) go? It needs one face open and the opposite one backed, along some
     *  axis, with the voxel that backs it denser than it is: that walks a face in to where
     *  the density peaks, the sheet of splats itself, and no further. (Solid with no
     *  density in it, filled ground or a filled panel, has nothing denser behind
     *  anything, and stays as it is.) That is for a sheet (a wall, a floor, a tabletop),
     *  and only across it: along it is the way it runs, and going that way narrows it and
     *  widens whatever gaps it has. A lump has no such peak to walk to: the evened-out
     *  density of a small thing is greatest in its middle, and walking in to that ate
     *  Playroom's toys down to a core. A lump's voxel goes, from any side, only while the
     *  finer grid does not call it solid (density under `iso`). */
    // Which way is thickness is settled once, from the solid as the coarse grid left it.
    // (Asked afresh each pass, it changes as the trim goes: a layer comes off unevenly, the
    // scraps of it left standing are narrower than they are tall, "thinnest" turns sideways,
    // and they can no longer be taken from above. Playroom's floor and rug were left
    // dotted with them.)
    const axes = new Uint8Array(occ.length); // bits 1, 2, 4: may go along x, y, z
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
      const c = (x * ny + y) * nz + z;
      if (!occ[c] || (y >= keep[0] && y < keep[1])) continue; // (rows keep[0] to keep[1] are not trimmed at all: the caller's ground)
      const rx = run(x, y, z, 1, 0, 0), ry = run(x, y, z, 0, 1, 0), rz = run(x, y, z, 0, 0, 1), least = Math.min(rx, ry, rz);
      // A sheet is thin one way and runs on the other two. Anything else (a toy, a cushion,
      // a chair's leg) is a lump: it has no sheet to walk in to, and comes in from every
      // side, but only as far as the finer grid says it is not solid (bit 8).
      const long = (rx > thin ? 1 : 0) + (ry > thin ? 1 : 0) + (rz > thin ? 1 : 0);
      // (What is neither, thin more than one way, is left alone: a strip of wall between
      // two gaps in it, a rail. Taken as a lump, it loses a layer off its sides too, and
      // every gap a sparse wall already has gets wider: Playroom's open sight lines 24.4% to 26.9%.)
      axes[c] = least > thin ? 7 | 8 : long === 2 ? (rx === least ? 1 : ry === least ? 2 : 4) : 0;
    }
    const mayGo = (x: number, y: number, z: number, pass: number): boolean => {
      const c = (x * ny + y) * nz + z, may = axes[c];
      const lump = (may & 8) !== 0;
      if (lump && (pass >= LUMP_LAYERS || density[c] >= iso)) return false;
      // A sheet keeps SHEET_MIN voxels of thickness. Thinner, its two faces come out of the
      // mesher touching or crossed, and what probes the mesh is misled: a spot on a tabletop
      // finds the table's own underside over it and has no headroom, a wall is met from
      // behind and cannot be climbed. (Counter lost a third of its walkable area that way,
      // and Playroom a sixth of its climbing reach.)
      const along = (step: number, ahead: boolean, behind: boolean, dx: number, dy: number, dz: number) => ahead !== behind
        && (lump || (density[ahead ? c + step : c - step] > density[c] && run(x, y, z, dx, dy, dz) > SHEET_MIN));
      return ((may & 1) !== 0 && along(sx, solidAt(x + 1, y, z), solidAt(x - 1, y, z), 1, 0, 0))
        || ((may & 2) !== 0 && along(sy, solidAt(x, y + 1, z), solidAt(x, y - 1, z), 0, 1, 0))
        || ((may & 4) !== 0 && along(1, solidAt(x, y, z + 1), solidAt(x, y, z - 1), 0, 0, 1));
    };
    for (let pass = 0; pass < depth; pass++) {
      // this pass's layer: the voxels that could go as things stand, least dense first
      const layer: number[] = [];
      for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) if (occ[(x * ny + y) * nz + z] && mayGo(x, y, z, pass)) layer.push((x * ny + y) * nz + z);
      layer.sort((a, b) => density[a] - density[b]);
      let gone = 0;
      for (const c of layer) {
        const x = Math.floor(c / sx), y = Math.floor((c % sx) / sy), z = c % sy;
        if (mayGo(x, y, z, pass) && simple(x, y, z)) { occ[c] = 0; gone++; } // (asked again: its neighbours may have gone since)
      }
      if (!gone) break;
    }
  };
  return { s, x0, y0, z0, nx, ny, nz, occ, trim };
}

const FLOOR_UNDER = 0.75;  // units over y = 0: under a raised ground, the real floor's mesh below this is flattened (the band the floor flatten had before it followed the ground)
const SPLATS_PER_FINE_VOXEL = 3; // the mesh is built on a finer grid only while the scan has at least this many splats to each of its solid voxels
const GROUND_FLAT = 0.015; // ground is flat when at least this share of the opacity near it is splats lying flat at one height
const LIES_FLAT_GROUND = 0.3; // a splat lies flat when it is thinner than this, up and down, as a share of its width
const GROUND_SEARCH = 2;  // units either side of the ground's row in which its splats are looked for
const STAND_ROOM = 5;    // units of clear space over a surface for it to be somewhere to stand: about the figurine's height (a unit is a fifth of it)
const START_NEAR = 10;   // units round the scan's centre in which the level the figurine starts on is looked for
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
 *    something `width` units across cannot get into from outside, when the surface and
 *    whatever stands on it (walls, furniture) are in its way. A one-voxel flood leaks
 *    through any crack; a wide one is kept out of bays between furniture, and still gets
 *    in where a whole wall is missing.
 * The second is for ground only. Beside a raised surface there can be open air (the
 * aisle between two worktops); beside the ground there cannot. The level is raised when
 * a fair share of the scan's solid voxels lie below it.
 */
/** The row of the level the figurine starts on (see fillGround), or -1 if there is nowhere to stand. `ox`, `oz`: the scan's centre, in voxels. */
function groundRow(occ: Uint8Array, gx: number, gy: number, gz: number, ox: number, oz: number, per: number): number {
  const sx = gy * gz, sy = gz, room = Math.round(STAND_ROOM * per);
  /** The lowest row in column (x, z) with something solid and room to stand on it, or -1. */
  const standRow = (x: number, z: number) => {
    const c = x * sx + z;
    for (let y = 0; y < gy; y++) {
      if (!occ[c + y * sy]) continue;
      let clear = true;
      for (let u = y + 1; u <= Math.min(gy - 1, y + room); u++) if (occ[c + u * sy]) { clear = false; break; }
      if (clear) return y;
    }
    return -1;
  };
  // the commonest such row near the centre (one toy there does not decide it), or anywhere if there is none
  const tally = new Int32Array(gy);
  let any = false;
  for (const near of [START_NEAR * per, Infinity]) {
    for (let x = 0; x < gx; x++)
      for (let z = 0; z < gz; z++) {
        if (Math.hypot(x - ox, z - oz) > near) continue;
        const y = standRow(x, z);
        if (y >= 0) { tally[y]++; any = true; }
      }
    if (any) break;
  }
  if (!any) return -1;
  let top = 0;
  for (let y = 1; y < gy; y++) if (tally[y] > tally[top]) top = y;
  return top;
}

function fillGround(occ: Uint8Array, gx: number, gy: number, gz: number, top: number, width: number, per: number): void {
  const sx = gy * gz, sy = gz, n = gx * gz;
  const room = Math.round(STAND_ROOM * per), slab = Math.max(1, Math.round(per)); // in voxels: room to stand, and how thick the level's surface is taken to be
  const rows: number[] = []; // the level, and what is over it to a unit's height, where the surface is that much higher
  for (let y = top; y <= Math.min(gy - 1, top + slab); y++) rows.push(y);
  for (const y of rows) fillSlice(occ, gx, gy, gz, y);
  if (width <= 1) return;

  let solid = 0, beneath = 0;
  for (let x = 0; x < gx; x++) for (let y = 0; y < gy; y++) for (let z = 0; z < gz; z++) if (occ[x * sx + y * sy + z]) { solid++; if (y < top - slab) beneath++; }
  if (beneath > RAISED * solid) return; // a raised surface

  const here = new Uint8Array(n), wall = new Uint8Array(n), under = new Uint8Array(n);
  for (let x = 0; x < gx; x++)
    for (let z = 0; z < gz; z++) {
      const k = x * gz + z, c = x * sx + z;
      const over = rows[rows.length - 1];
      for (const y of rows) if (occ[c + y * sy]) { here[k] = 1; break; }
      for (let y = over + 1; y <= Math.min(gy - 1, over + room); y++) if (occ[c + y * sy]) { wall[k] = 1; break; }
      for (let y = 0; y < top - slab; y++) if (occ[c + y * sy]) { under[k] = 1; break; }
      if (here[k]) wall[k] = 1; // (from here on: everything in the flood's way)
    }
  // where something `width` across can get to from the grid's border without touching what is in its way...
  const radius = (width * per) / 2, clear = distanceTo(wall, gx, gz), reached = new Uint8Array(n), queue = new Int32Array(n);
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
