// How much of something a camera sees past the scan's splats: the opening shot's test
// (figurine/camera.ts, openingView), since the collision mesh leaves out much that is
// drawn (floaters, faint and thin splats: context/collision.md, "See it but cannot touch
// it") and a view clear of the mesh can still be buried in splats.
//
// The room's splats are sorted into a grid of cells once, when it loads (setSightSplats);
// a sight line then visits only the cells it crosses, and works out the shape of only the
// splats in them, so a look costs about the same in any room.

import * as THREE from 'three';
import { invertSymmetric, worldCovariance } from './splat-covariance';

const FAINT = 0.02;  // splats with less opacity than this are left out: they hide nothing
const CUTOFF2 = 4;   // a splat reaches out to 2 standard deviations, as GaussianSplat draws it (SPLAT_KERNEL_CUTOFF)
const SPREAD = 4;    // a splat reaching across more cells a side than this goes in a list every line tests (it would fill too many cells)
const MAX_CELLS = 128; // cells a side at most: a bigger room gets bigger cells

/** The room's own splats as loaded (room.ts keeps this pointing at arrays that hold them:
 *  the parsed scan until the fill takes those over, then the filled scan's first `count`),
 *  and the grid they are sorted into: `list` from `first[c]` to `first[c + 1]` holds the
 *  splats reaching into cell c. */
let room: {
  centers: Float32Array; covariances: Float32Array; colors: ArrayLike<number>; count: number; m: number[];
  lo: number; cell: number; size: number; first: Int32Array; list: Int32Array; wide: Int32Array; stamp: Int32Array; pass: number;
} | null = null;
let missed = false; // a look was asked for while the fill's worker had the arrays

/** Point the sight at a room's splats (their world transform `toWorld`), sorting them into
 *  cells of about `cell` across a box `extent` either side of the origin; splats outside it
 *  are left out. The same splats in new arrays (the fill hands them back) keep the cells
 *  already sorted. True if a look was asked for while there were none to look past (the fill
 *  had them), so whatever it decided was decided blind. */
export function setSightSplats(centers: Float32Array, covariances: Float32Array, colors: ArrayLike<number>, count: number, toWorld: THREE.Matrix4, cell: number, extent: number): boolean {
  const m = Array.from(toWorld.elements);
  if (room && room.count === count && room.m.every((v, i) => v === m[i])) Object.assign(room, { centers, covariances, colors });
  else room = sortIntoCells(centers, covariances, colors, count, m, cell, extent);
  const was = missed; missed = false;
  return was;
}
export function clearSightSplats(): void { room = null; missed = false; }

/** Can the sight look past the splats now? False with none loaded (the mesh-only view
 *  loads none) or while the fill's worker has the arrays (which it notes, for room.ts). */
export function sightReady(): boolean {
  if (!room) return false;
  if (room.centers.length < room.count * 3) { missed = true; return false; }
  return true;
}

function sortIntoCells(centers: Float32Array, cov: Float32Array, colors: ArrayLike<number>, count: number, m: number[], cellWanted: number, extent: number) {
  const cell = Math.max(cellWanted, (2 * extent) / MAX_CELLS), size = Math.ceil((2 * extent) / cell), lo = -extent;
  const scale = Math.hypot(m[0], m[1], m[2]); // toWorld: a rotation and a uniform scale, then a move
  const box = new Int32Array(6);
  /** The cells splat i reaches into, in `box`: 1 a box, 0 none (faint, or out of the grid), -1 too wide for cells. */
  const boxOf = (i: number): number => {
    if (colors[i * 4 + 3] / 255 < FAINT) return 0;
    const lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
    const reach = 2 * scale * Math.sqrt(cov[i * 6] + cov[i * 6 + 3] + cov[i * 6 + 5]); // 2σ of its widest axis is at most 2·√trace
    for (let axis = 0; axis < 3; axis++) {
      const p = m[axis] * lx + m[4 + axis] * ly + m[8 + axis] * lz + m[12 + axis] - lo;
      const a = Math.floor((p - reach) / cell), b = Math.floor((p + reach) / cell);
      if (b < 0 || a >= size) return 0;
      if (b - a >= SPREAD) return -1;
      box[axis * 2] = Math.max(0, a); box[axis * 2 + 1] = Math.min(size - 1, b);
    }
    return 1;
  };
  // two passes over the same boxes: count each cell's splats, then place them
  const first = new Int32Array(size ** 3 + 1), wide: number[] = [];
  for (let i = 0; i < count; i++) {
    const b = boxOf(i);
    if (b < 0) wide.push(i);
    if (b <= 0) continue;
    for (let x = box[0]; x <= box[1]; x++) for (let y = box[2]; y <= box[3]; y++) for (let z = box[4]; z <= box[5]; z++) first[(x * size + y) * size + z + 1]++;
  }
  for (let c = 0; c < size ** 3; c++) first[c + 1] += first[c];
  const fill = first.slice(0, size ** 3), list = new Int32Array(first[size ** 3]);
  for (let i = 0; i < count; i++) {
    if (boxOf(i) <= 0) continue;
    for (let x = box[0]; x <= box[1]; x++) for (let y = box[2]; y <= box[3]; y++) for (let z = box[4]; z <= box[5]; z++) list[fill[(x * size + y) * size + z]++] = i;
  }
  return { centers, covariances: cov, colors, count, m, lo, cell, size, first, list, wide: Int32Array.from(wide), stamp: new Int32Array(count), pass: 0 };
}

/** How much a camera at `from` sees of `to` past the room's splats: 1 all of it, 0 none.
 *  Each splat on the line takes away its opacity where the line passes nearest its centre
 *  (in its own shape: the Mahalanobis distance, so a flat splat seen edge-on hides little),
 *  as the splats are blended when drawn. Walks the cells the line crosses, each splat once.
 *  Ask sightReady first. */
export function seeThrough(from: THREE.Vector3, to: THREE.Vector3): number {
  const g = room!, pass = ++g.pass;
  let see = 1;
  const test = (i: number) => {
    if (g.stamp[i] === pass) return;
    g.stamp[i] = pass;
    see *= letsThrough(i, from, to);
  };
  for (let w = 0; w < g.wide.length && see > 1e-3; w++) test(g.wide[w]);
  // the cells along the line, exactly (Amanatides and Woo), from `from` to `to`
  const d = [to.x - from.x, to.y - from.y, to.z - from.z], o = [from.x - g.lo, from.y - g.lo, from.z - g.lo];
  const at = [0, 0, 0], step = [0, 0, 0], tMax = [0, 0, 0], tDelta = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    at[a] = Math.floor(o[a] / g.cell);
    step[a] = d[a] > 0 ? 1 : d[a] < 0 ? -1 : 0;
    const edge = (at[a] + (step[a] > 0 ? 1 : 0)) * g.cell;
    tMax[a] = step[a] ? (edge - o[a]) / d[a] : Infinity;
    tDelta[a] = step[a] ? g.cell / Math.abs(d[a]) : Infinity;
  }
  for (let t = 0; t <= 1 && see > 1e-3;) {
    if (at[0] >= 0 && at[1] >= 0 && at[2] >= 0 && at[0] < g.size && at[1] < g.size && at[2] < g.size) {
      const c = (at[0] * g.size + at[1]) * g.size + at[2];
      for (let j = g.first[c]; j < g.first[c + 1] && see > 1e-3; j++) test(g.list[j]);
    }
    const a = tMax[0] < tMax[1] ? (tMax[0] < tMax[2] ? 0 : 2) : (tMax[1] < tMax[2] ? 1 : 2);
    t = tMax[a];
    at[a] += step[a];
    tMax[a] += tDelta[a];
  }
  return see < 1e-3 ? 0 : see;
}

const W = new Float64Array(6), S = new Float64Array(6);
/** What splat `i` lets through of the segment from `from` to `to`: 1 less its opacity where
 *  the segment passes nearest its centre, or 1 if it passes outside the splat's reach. */
function letsThrough(i: number, from: THREE.Vector3, to: THREE.Vector3): number {
  const { centers, covariances, colors, m } = room!;
  const lx = centers[i * 3], ly = centers[i * 3 + 1], lz = centers[i * 3 + 2];
  const ux = m[0] * lx + m[4] * ly + m[8] * lz + m[12] - from.x;
  const uy = m[1] * lx + m[5] * ly + m[9] * lz + m[13] - from.y;
  const uz = m[2] * lx + m[6] * ly + m[10] * lz + m[14] - from.z;
  const vx = to.x - from.x, vy = to.y - from.y, vz = to.z - from.z;
  // first, cheaply: a line further from the centre than the splat's widest reach misses it
  const along = Math.min(1, Math.max(0, (ux * vx + uy * vy + uz * vz) / (vx * vx + vy * vy + vz * vz || 1)));
  const ex = ux - along * vx, ey = uy - along * vy, ez = uz - along * vz;
  const t2 = covariances[i * 6] + covariances[i * 6 + 3] + covariances[i * 6 + 5], s2 = m[0] * m[0] + m[1] * m[1] + m[2] * m[2];
  if (ex * ex + ey * ey + ez * ez > 4 * s2 * t2) return 1; // (2σ of the widest axis, squared: 4·scale²·trace)
  worldCovariance(covariances, i, m, W);
  const floor = 1e-4 * (W[0] + W[3] + W[5]) + 1e-12; // a flat splat's thin axis kept off zero
  W[0] += floor; W[3] += floor; W[5] += floor;
  if (!(invertSymmetric(W, S) > 0)) return 1;
  const a = S[0], b = S[1], c = S[2], d = S[3], e = S[4], f = S[5];
  // S·v, then the point on the segment nearest the centre in the splat's own measure
  const sx = a * vx + b * vy + c * vz, sy = b * vx + d * vy + e * vz, sz = c * vx + e * vy + f * vz;
  const vSv = vx * sx + vy * sy + vz * sz;
  const t = vSv > 0 ? Math.min(1, Math.max(0, (ux * sx + uy * sy + uz * sz) / vSv)) : 0;
  const wx = ux - t * vx, wy = uy - t * vy, wz = uz - t * vz;
  const m2 = wx * (a * wx + b * wy + c * wz) + wy * (b * wx + d * wy + e * wz) + wz * (c * wx + e * wy + f * wz);
  return m2 >= CUTOFF2 ? 1 : 1 - Math.min(0.99, (colors[i * 4 + 3] / 255) * Math.exp(-0.5 * m2));
}
