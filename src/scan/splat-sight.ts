// How much of something a camera sees past the scan's splats: the opening shot's test
// (figurine/camera.ts, openingView), since the collision mesh leaves out much that is
// drawn (floaters, faint and thin splats: context/collision.md, "See it but cannot touch
// it") and a view clear of the mesh can still be buried in splats.

import * as THREE from 'three';

/** The room's own splats as loaded: room.ts keeps this pointing at arrays that hold them
 *  (the parsed scan until the fill takes those over, then the filled scan's first `count`). */
let source: { centers: Float32Array; covariances: Float32Array; colors: ArrayLike<number>; count: number; toWorld: THREE.Matrix4 } | null = null;
let missed = false; // a look was asked for while the fill's worker had the arrays

/** Point the sight at these splats. True if a look was asked for while there were none to
 *  look past (the fill had them), so whatever it decided was decided blind. */
export function setSightSplats(centers: Float32Array, covariances: Float32Array, colors: ArrayLike<number>, count: number, toWorld: THREE.Matrix4): boolean {
  if (!source || !source.toWorld.equals(toWorld) || source.count !== count) near = null; // (the same splats moved to new arrays keep what was gathered from them)
  source = { centers, covariances, colors, count, toWorld: toWorld.clone() };
  const was = missed; missed = false;
  return was;
}
export function clearSightSplats(): void { source = null; near = null; missed = false; }

const FAINT = 0.02;  // splats with less opacity than this are left out: they hide nothing
const CUTOFF2 = 4;   // a splat reaches out to 2 standard deviations, as GaussianSplat draws it (SPLAT_KERNEL_CUTOFF)
const CELLS = 16;    // the gathered splats are sorted into this many cells a side, so a sight line tests only the splats in the cells it crosses
const SPREAD = 8;    // a splat reaching across more cells a side than this goes in a list every line tests instead (it would fill too many cells)
const REUSE = 0.02;  // asked again within this share of the radius of the last place, the last gathering is kept (the shot's pivot sits where the figurine was placed, a snap off where the spawn search looked)
const FAR = 2;       // splats centred further than this many radii away are passed over unread: one would have to be wider than the whole gathering to reach in

/** The splats near one place, in world space, each with its opacity and its covariance
 *  inverted, sorted into cells round that place: gathered once (gatherSight), then tested
 *  along any number of lines (seeThrough). */
let near: {
  at: THREE.Vector3; radius: number; lowest: number; pos: Float32Array; inv: Float32Array; alpha: Float32Array;
  lo: THREE.Vector3; cell: number; first: Int32Array; list: Int32Array; wide: Int32Array; stamp: Int32Array; pass: number;
} | null = null;

/** Gather the splats that reach within `radius` of `around` (world) and above `lowest`, for
 *  seeThrough: lines that never go below `lowest` cannot meet a splat wholly under it (a
 *  floor, a rug), which are most of the splats round a figurine. False when there are no
 *  splats to test (none loaded, the mesh-only view, or the fill has them). Asked again for
 *  nearly the same place, the last gathering is kept. */
export function gatherSight(around: THREE.Vector3, radius: number, lowest = -Infinity): boolean {
  if (near && near.radius === radius && Math.abs(near.lowest - lowest) < radius * REUSE && near.at.distanceTo(around) < radius * REUSE) return true;
  near = null;
  if (!source) return false;
  if (source.centers.length < source.count * 3) { missed = true; return false; } // the fill's worker has the arrays for now (room.ts)
  const { centers, covariances: c, colors, count, toWorld } = source, e = toWorld.elements;
  // toWorld is a rotation and a uniform scale, then a move: a covariance Σ in world space is A Σ Aᵀ
  const scale = Math.hypot(e[0], e[1], e[2]);
  const picked: number[] = [];
  const far2 = (FAR * radius) ** 2;
  for (let i = 0; i < count; i++) {
    const lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
    const x = e[0] * lx + e[4] * ly + e[8] * lz + e[12] - around.x;
    const y = e[1] * lx + e[5] * ly + e[9] * lz + e[13] - around.y;
    const z = e[2] * lx + e[6] * ly + e[10] * lz + e[14] - around.z;
    if (x * x + y * y + z * z > far2 || colors[i * 4 + 3] / 255 < FAINT) continue;
    const reach = 2 * Math.sqrt(c[i * 6] + c[i * 6 + 3] + c[i * 6 + 5]) * scale; // 2σ of its widest axis is at most 2·√trace
    if (y + around.y + reach < lowest) continue;
    const r = radius + reach;
    if (x * x + y * y + z * z <= r * r) picked.push(i);
  }
  const n = picked.length, pos = new Float32Array(n * 3), inv = new Float32Array(n * 6), alpha = new Float32Array(n), bound = new Float32Array(n);
  const a00 = e[0], a01 = e[4], a02 = e[8], a10 = e[1], a11 = e[5], a12 = e[9], a20 = e[2], a21 = e[6], a22 = e[10];
  for (let k = 0; k < n; k++) {
    const i = picked[k], lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
    pos[k * 3] = a00 * lx + a01 * ly + a02 * lz + e[12];
    pos[k * 3 + 1] = a10 * lx + a11 * ly + a12 * lz + e[13];
    pos[k * 3 + 2] = a20 * lx + a21 * ly + a22 * lz + e[14];
    // W = A Σ Aᵀ (symmetric), by way of M = A Σ
    const sxx = c[i * 6], sxy = c[i * 6 + 1], sxz = c[i * 6 + 2], syy = c[i * 6 + 3], syz = c[i * 6 + 4], szz = c[i * 6 + 5];
    const m00 = a00 * sxx + a01 * sxy + a02 * sxz, m01 = a00 * sxy + a01 * syy + a02 * syz, m02 = a00 * sxz + a01 * syz + a02 * szz;
    const m10 = a10 * sxx + a11 * sxy + a12 * sxz, m11 = a10 * sxy + a11 * syy + a12 * syz, m12 = a10 * sxz + a11 * syz + a12 * szz;
    const m20 = a20 * sxx + a21 * sxy + a22 * sxz, m21 = a20 * sxy + a21 * syy + a22 * syz, m22 = a20 * sxz + a21 * syz + a22 * szz;
    const w01 = m00 * a10 + m01 * a11 + m02 * a12, w02 = m00 * a20 + m01 * a21 + m02 * a22, w12 = m10 * a20 + m11 * a21 + m12 * a22;
    const trace = m00 * a00 + m01 * a01 + m02 * a02 + m10 * a10 + m11 * a11 + m12 * a12 + m20 * a20 + m21 * a21 + m22 * a22;
    const floor = 1e-4 * trace + 1e-12; // a flat splat's thin axis kept off zero
    const w00 = m00 * a00 + m01 * a01 + m02 * a02 + floor, w11 = m10 * a10 + m11 * a11 + m12 * a12 + floor, w22 = m20 * a20 + m21 * a21 + m22 * a22 + floor;
    // its inverse, by cofactors
    const c00 = w11 * w22 - w12 * w12, c01 = w02 * w12 - w01 * w22, c02 = w01 * w12 - w02 * w11;
    const det = w00 * c00 + w01 * c01 + w02 * c02 || 1e-30;
    inv[k * 6] = c00 / det; inv[k * 6 + 1] = c01 / det; inv[k * 6 + 2] = c02 / det;
    inv[k * 6 + 3] = (w00 * w22 - w02 * w02) / det; inv[k * 6 + 4] = (w01 * w02 - w00 * w12) / det; inv[k * 6 + 5] = (w00 * w11 - w01 * w01) / det;
    alpha[k] = colors[i * 4 + 3] / 255;
    bound[k] = 2 * Math.sqrt(trace);
  }
  // Sort them into cells: each splat into every cell its reach overlaps, the widest into `wide`.
  // Two passes over the same boxes: count each cell's splats, then place them.
  const cell = (2 * radius) / CELLS, lo = new THREE.Vector3(around.x - radius, around.y - radius, around.z - radius);
  const box = new Int32Array(6), wide: number[] = [];
  const boxOf = (k: number): boolean => { // false: too wide for cells
    for (let axis = 0; axis < 3; axis++) {
      const p = pos[k * 3 + axis] - lo.getComponent(axis);
      box[axis * 2] = Math.max(0, Math.floor((p - bound[k]) / cell));
      box[axis * 2 + 1] = Math.min(CELLS - 1, Math.floor((p + bound[k]) / cell));
      if (box[axis * 2 + 1] - box[axis * 2] >= SPREAD) return false;
    }
    return true;
  };
  const first = new Int32Array(CELLS ** 3 + 1);
  for (let k = 0; k < n; k++) {
    if (!boxOf(k)) { wide.push(k); continue; }
    for (let x = box[0]; x <= box[1]; x++) for (let y = box[2]; y <= box[3]; y++) for (let z = box[4]; z <= box[5]; z++) first[(x * CELLS + y) * CELLS + z + 1]++;
  }
  for (let c = 0; c < CELLS ** 3; c++) first[c + 1] += first[c];
  const fill = first.slice(0, CELLS ** 3), list = new Int32Array(first[CELLS ** 3]);
  for (let k = 0; k < n; k++) {
    if (!boxOf(k)) continue;
    for (let x = box[0]; x <= box[1]; x++) for (let y = box[2]; y <= box[3]; y++) for (let z = box[4]; z <= box[5]; z++) list[fill[(x * CELLS + y) * CELLS + z]++] = k;
  }
  near = { at: around.clone(), radius, lowest, pos, inv, alpha, lo, cell, first, list, wide: Int32Array.from(wide), stamp: new Int32Array(n), pass: 0 };
  return true;
}

/** How much a camera at `from` sees of `to` past the gathered splats: 1 all of it, 0 none.
 *  Each splat on the line takes away its opacity where the line passes nearest its centre
 *  (in its own shape: the Mahalanobis distance, so a flat splat seen edge-on hides little),
 *  as the splats are blended when drawn. Only the splats in the cells the line crosses are
 *  tested, each once. */
export function seeThrough(from: THREE.Vector3, to: THREE.Vector3): number {
  if (!near) return 1;
  const g = near, pass = ++g.pass;
  let see = 1;
  for (let w = 0; w < g.wide.length; w++) { g.stamp[g.wide[w]] = pass; see *= letsThrough(g.wide[w], from, to); }
  // the cells along the line, a quarter of a cell at a time
  const steps = Math.max(1, Math.ceil(from.distanceTo(to) / (g.cell / 4)));
  let last = -1;
  for (let s = 0; s <= steps && see > 1e-3; s++) {
    const t = s / steps;
    const cx = Math.floor((from.x + (to.x - from.x) * t - g.lo.x) / g.cell);
    const cy = Math.floor((from.y + (to.y - from.y) * t - g.lo.y) / g.cell);
    const cz = Math.floor((from.z + (to.z - from.z) * t - g.lo.z) / g.cell);
    if (cx < 0 || cy < 0 || cz < 0 || cx >= CELLS || cy >= CELLS || cz >= CELLS) continue;
    const c = (cx * CELLS + cy) * CELLS + cz;
    if (c === last) continue;
    last = c;
    for (let j = g.first[c]; j < g.first[c + 1]; j++) {
      const k = g.list[j];
      if (g.stamp[k] === pass) continue;
      g.stamp[k] = pass;
      see *= letsThrough(k, from, to);
    }
  }
  return see < 1e-3 ? 0 : see;
}

/** What splat `k` lets through of the segment from `from` to `to`: 1 less its opacity where
 *  the segment passes nearest its centre, or 1 if it passes outside the splat's reach. */
function letsThrough(k: number, from: THREE.Vector3, to: THREE.Vector3): number {
  const { pos, inv, alpha } = near!;
  const a = inv[k * 6], b = inv[k * 6 + 1], c = inv[k * 6 + 2], d = inv[k * 6 + 3], e = inv[k * 6 + 4], f = inv[k * 6 + 5];
  const vx = to.x - from.x, vy = to.y - from.y, vz = to.z - from.z;
  const ux = pos[k * 3] - from.x, uy = pos[k * 3 + 1] - from.y, uz = pos[k * 3 + 2] - from.z;
  // S·v, then the point on the segment nearest the centre in the splat's own measure
  const sx = a * vx + b * vy + c * vz, sy = b * vx + d * vy + e * vz, sz = c * vx + e * vy + f * vz;
  const vSv = vx * sx + vy * sy + vz * sz;
  const t = vSv > 0 ? Math.min(1, Math.max(0, (ux * sx + uy * sy + uz * sz) / vSv)) : 0;
  const wx = ux - t * vx, wy = uy - t * vy, wz = uz - t * vz;
  const m2 = wx * (a * wx + b * wy + c * wz) + wy * (b * wx + d * wy + e * wz) + wz * (c * wx + e * wy + f * wz);
  return m2 >= CUTOFF2 ? 1 : 1 - Math.min(0.99, alpha[k] * Math.exp(-0.5 * m2));
}
