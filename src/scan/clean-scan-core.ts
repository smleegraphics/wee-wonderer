// Scan cleanup: one pass, two sets of splats (cleanMasks). The scan is levelled once, and the
// room box is worked out once, from the splats that pass the floater filters on opacity, size
// and density. What is drawn: every splat inside that box (the far-off spray past the walls,
// above the ceiling and below the floor is left out). What the collision is built from: those of
// them that are not big floaters (oversized, unless flat and solid: a piece of a surface). It runs
// on an imported scan in a Web Worker (clean-scan.worker.ts); on a scan loaded by name, in the
// load worker (load-scan.worker.ts), for its collision only (the file is drawn as it is); and on
// .ply files offline (scripts/clean-scan.mjs, through Vite), which keep what is drawn: the
// shipped files.
//
// The floater filters used to choose what was drawn, and then what the collision was built from.
// They made scans see-through (Living Room 0.2% of the view raw, 25% cleaned; Counter 0.2% and
// 8.5%), and the collision missed what was drawn (Kitchen: a quarter of its visible splats with no
// collision near). context/collision.md, "Scan cleanup".

import * as THREE from 'three';
import { orientScan } from './orient-scan';
import type { ParsedScan } from './parse-scan';

export interface CleanOptions {
  alphaMin?: number;    // room box only: it is worked out from splats at least this opaque (default 0.35)
  scaleCapMul?: number; // a splat larger than this x the median size is a floater (default 4): left out of the room box, and of the collision unless it is a piece of a surface
  minMass?: number;     // room box only: from splats in a voxel with at least this much opacity in it (default 4)
  grid?: number;        // the density grid's cells across 2 x radius (default 160)
  ceil?: number;        // room box: the ceiling, this percentile of levelled height (default 0.98)
  wall?: number;        // room box: across, this percentile of levelled x and z (default 0.99)
  margin?: number;      // room box: slack on each face, as a share of its span (default 0.08)
  floorMargin?: number; // room box: kept this far below the floor, in radii (default 0.03)
  crop?: boolean;       // crop to the room box (default true); off, every splat is drawn
}

export interface CleanResult {
  scan: ParsedScan;      // the splats drawn
  collision: Uint8Array; // per splat drawn, 1 if the collision is built from it
  kept: number;
  total: number;
  collisionKept: number;
}

const median = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
const pct = (sorted: Float32Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

/** The largest and smallest eigenvalues of the symmetric 3x3 matrix (xx, xy, xz, yy, yz, zz),
 *  in closed form. A splat's covariance is R·S²·Rᵀ, so these are its widest and thinnest
 *  scales, squared. */
function eigenExtremes(xx: number, xy: number, xz: number, yy: number, yz: number, zz: number): { largest: number; smallest: number } {
  const off = xy * xy + xz * xz + yz * yz;
  const q = (xx + yy + zz) / 3;
  const p = Math.sqrt(((xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * off) / 6);
  if (p < 1e-30) return { largest: q, smallest: q }; // a sphere: all three the same
  const a = (xx - q) / p, d = (yy - q) / p, f = (zz - q) / p, b = xy / p, c = xz / p, e = yz / p;
  const r = Math.max(-1, Math.min(1, (a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c)) / 2));
  const phi = Math.acos(r) / 3;
  return { largest: q + 2 * p * Math.cos(phi), smallest: q + 2 * p * Math.cos(phi + (2 * Math.PI) / 3) };
}

// A big splat is left out of the collision as a floater only if it is not a piece of a surface:
// one at most FLAT_MAX as thick as it is wide, and at least SOLID_MIN opaque, is the tile of a wall
// or floor it looks like (85% of an AI-generated room's big splats are; 25% of the Mip-NeRF
// captures'). Big round or see-through ones stay out: they are what made solid lumps in mid-air
// (Kitchen, without the size filter: 6 surfaces nothing reaches).
const FLAT_MAX = 0.1;
const SOLID_MIN = 0.5;

/** Which splats are drawn, and which of those the collision is built from (see the top of the
 *  file). `tiltDeg` is how far the levelling turned the floor. */
export function cleanMasks(scan: ParsedScan, opts: CleanOptions = {}): { drawn: Uint8Array; collision: Uint8Array; tiltDeg: number } {
  const ALPHA_MIN = opts.alphaMin ?? 0.35;
  const SCALE_CAP_MUL = opts.scaleCapMul ?? 4;
  const MIN_MASS = opts.minMass ?? 4;
  const GRID = opts.grid ?? 160;
  const CEIL_PCT = opts.ceil ?? 0.98;
  const WALL_PCT = opts.wall ?? 0.99;
  const MARGIN = opts.margin ?? 0.08;
  const FLOOR_MARGIN = opts.floorMargin ?? 0.03;

  const { centers, covariances, colors } = scan;
  const count = centers.length / 3;
  const o = orientScan(new THREE.BufferAttribute(centers, 3));
  const cx = o.center.x, cy = o.center.y, cz = o.center.z, radius = o.radius;

  // the floater filters: opacity and size, then the opacity in each voxel of what passes those
  const alpha = new Float32Array(count), sizeOf = new Float32Array(count), surface = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    alpha[i] = colors[i * 4 + 3] / 255;
    const c = i * 6, e = eigenExtremes(covariances[c], covariances[c + 1], covariances[c + 2], covariances[c + 3], covariances[c + 4], covariances[c + 5]);
    sizeOf[i] = Math.sqrt(Math.max(0, e.largest));
    surface[i] = Math.sqrt(Math.max(0, e.smallest)) <= FLAT_MAX * sizeOf[i] && alpha[i] >= SOLID_MIN ? 1 : 0;
  }
  const sampleStride = Math.max(1, Math.floor(count / 40000));
  const sizeSample: number[] = [];
  for (let i = 0; i < count; i += sampleStride) sizeSample.push(sizeOf[i]);
  const scaleCap = median(sizeSample) * SCALE_CAP_MUL;
  const voxel = (2 * radius) / GRID;
  const key = (i: number) => {
    const vx = Math.floor((centers[i * 3] - cx) / voxel), vy = Math.floor((centers[i * 3 + 1] - cy) / voxel), vz = Math.floor((centers[i * 3 + 2] - cz) / voxel);
    return (vx + 524288) * 1099511627776 + (vy + 524288) * 1048576 + (vz + 524288);
  };
  const solid = new Uint8Array(count), mass = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    if (alpha[i] < ALPHA_MIN || sizeOf[i] > scaleCap) continue;
    solid[i] = 1;
    const k = key(i);
    mass.set(k, (mass.get(k) ?? 0) + alpha[i]);
  }
  let solidCount = 0;
  for (let i = 0; i < count; i++) if (solid[i] && (mass.get(key(i)) ?? 0) < MIN_MASS) solid[i] = 0; else if (solid[i]) solidCount++;
  // (filters that leave nothing are not floater filters for this scan: the box falls back to every splat)
  const boxFrom = solidCount ? solid : new Uint8Array(count).fill(1);

  // the room box: every splat levelled, and the robust extent of those that pass the filters
  const drawn = new Uint8Array(count).fill(1);
  if (opts.crop ?? true) {
    const lx = new Float32Array(count), ly = new Float32Array(count), lz = new Float32Array(count);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]).sub(o.center).applyQuaternion(o.quaternion);
      lx[i] = v.x; ly[i] = v.y + o.floorOffsetY; lz[i] = v.z;
    }
    const pick = (a: Float32Array) => { const out: number[] = []; for (let i = 0; i < count; i++) if (boxFrom[i]) out.push(a[i]); return Float32Array.from(out).sort(); };
    const sx = pick(lx), sy = pick(ly), sz = pick(lz);
    const spanX = pct(sx, WALL_PCT) - pct(sx, 1 - WALL_PCT), spanZ = pct(sz, WALL_PCT) - pct(sz, 1 - WALL_PCT), ceil = pct(sy, CEIL_PCT);
    const minX = pct(sx, 1 - WALL_PCT) - MARGIN * spanX, maxX = pct(sx, WALL_PCT) + MARGIN * spanX;
    const minZ = pct(sz, 1 - WALL_PCT) - MARGIN * spanZ, maxZ = pct(sz, WALL_PCT) + MARGIN * spanZ;
    const minY = -FLOOR_MARGIN * radius, maxY = ceil + MARGIN * ceil;
    for (let i = 0; i < count; i++) drawn[i] = lx[i] >= minX && lx[i] <= maxX && ly[i] >= minY && ly[i] <= maxY && lz[i] >= minZ && lz[i] <= maxZ ? 1 : 0;
  }
  // The collision: what is drawn, less the big splats that are not pieces of a surface. Not the
  // opacity or density filters: the voxelizer already weighs each splat by its opacity and leaves
  // thin space empty, and filtering first took the faint and sparse splats walls are made of too.
  // Dropping both, Living Room's visible splats with no collision near went 15.7% -> 8.5%,
  // Counter's 21.8% -> 12.8%, Kitchen's 25.6% -> 16.9%, and Kitchen's reach rose 89.9% -> 94.9%.
  const collision = new Uint8Array(count);
  for (let i = 0; i < count; i++) collision[i] = drawn[i] && (sizeOf[i] <= scaleCap || surface[i]) ? 1 : 0;
  return { drawn, collision, tiltDeg: o.tiltDeg };
}

/** Clean a scan: the splats drawn (cleanMasks), in the same form, and which of them the
 *  collision is built from. */
export function cleanScan(scan: ParsedScan, opts: CleanOptions = {}): CleanResult {
  const { centers, covariances, colors } = scan;
  const count = centers.length / 3;
  if (count <= 0) throw new Error('The scan has no splats.');
  const { drawn, collision: forCollision } = cleanMasks(scan, opts);
  const keep: number[] = [];
  for (let i = 0; i < count; i++) if (drawn[i]) keep.push(i);
  const kept = keep.length;
  const pick = <T extends Float32Array | Uint8ClampedArray | Uint32Array>(src: T, per: number, make: (n: number) => T): T => {
    const out = make(kept * per);
    keep.forEach((i, k) => out.set(src.subarray(i * per, i * per + per), k * per));
    return out;
  };
  const collision = new Uint8Array(kept);
  let collisionKept = 0;
  keep.forEach((i, k) => { if (forCollision[i]) { collision[k] = 1; collisionKept++; } });
  const sphericalHarmonics: Record<string, Uint32Array> = {};
  for (const [name, words] of Object.entries(scan.sphericalHarmonics)) sphericalHarmonics[name] = pick(words, words.length / count, (n) => new Uint32Array(n));
  return {
    scan: {
      centers: pick(centers, 3, (n) => new Float32Array(n)),
      covariances: pick(covariances, 6, (n) => new Float32Array(n)),
      colors: pick(colors, 4, (n) => new Uint8ClampedArray(n)),
      sphericalHarmonics,
    },
    collision, kept, total: count, collisionKept,
  };
}
