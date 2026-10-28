// Scan cleanup, two sets of splats from one pass. What is drawn: the scan levelled, less the
// splats outside the room (the far-off spray past the walls, above the ceiling and below the
// floor; insideRoom). What the collision is built from: those that also pass the floater
// filters on opacity, size and density (collisionKeep). It runs on an imported scan in a Web
// Worker (clean-scan.worker.ts). scripts/clean-scan.mjs crops .ply files offline with insideRoom,
// loaded through Vite; a file loaded by name builds its collision from every splat in it.
//
// The floater filters used to choose what was drawn too. They made scans see-through (Living
// Room 0.2% of the view raw, 25% cleaned; Counter 0.2% and 8.5%), the size filter most, since
// big flat splats tile walls and floors; but the collision is better built from what they keep
// (Kitchen walkable from spawn 55% against 27% from the crop alone). context/collision.md,
// "Scan cleanup".

import * as THREE from 'three';
import { orientScan, type ScanOrientation } from './orient-scan';
import type { ParsedScan } from './parse-scan';

export interface CleanOptions {
  alphaMin?: number;    // collision only: drop splats fainter than this (default 0.35)
  scaleCapMul?: number; // collision only: drop splats larger than this x median size (default 4)
  minMass?: number;     // collision only: min accumulated opacity in a voxel to keep (default 4)
  grid?: number;        // collision only: density-grid resolution across 2*radius (default 160)
  ceil?: number;        // ceiling crop percentile (default 0.98)
  wall?: number;        // horizontal crop percentile (default 0.99)
  margin?: number;      // slack on cropped faces, fraction of span (default 0.08)
  floorMargin?: number; // keep splats to this x radius below the floor (default 0.03)
  crop?: boolean;       // crop to the room box (default true); off, every splat is kept
}

export interface CleanResult {
  scan: ParsedScan;      // the splats kept: inside the room, and any the collision is built from
  collision: Uint8Array; // per kept splat, 1 if the collision is built from it (collisionKeep)
  kept: number;
  total: number;
  collisionKept: number;
}

const median = (a: number[]) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
const pctOf = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];
const pct = (sorted: Float32Array, p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)))];

/** The largest eigenvalue of the symmetric 3x3 matrix (xx, xy, xz, yy, yz, zz), in closed
 *  form. A splat's covariance is R·S²·Rᵀ, so this is its largest scale, squared. */
function largestEigenvalue(xx: number, xy: number, xz: number, yy: number, yz: number, zz: number): number {
  const off = xy * xy + xz * xz + yz * yz;
  const q = (xx + yy + zz) / 3;
  const p = Math.sqrt(((xx - q) ** 2 + (yy - q) ** 2 + (zz - q) ** 2 + 2 * off) / 6);
  if (p < 1e-30) return q; // a sphere: all three the same
  const a = (xx - q) / p, d = (yy - q) / p, f = (zz - q) / p, b = xy / p, c = xz / p, e = yz / p;
  const r = Math.max(-1, Math.min(1, (a * (d * f - e * e) - b * (b * f - e * c) + c * (b * e - d * c)) / 2));
  return q + 2 * p * Math.cos(Math.acos(r) / 3);
}

/** The splats the collision is built from: those that pass the floater filters (opacity, size,
 *  density) and are inside the box round them. Not used to choose what is drawn: those filters
 *  made the scan see-through, but the collision built from what they keep is better than from
 *  the crop alone (Kitchen walkable from spawn 55% against 27%). Unchanged from when they
 *  chose what was drawn too, so the collision is too. */
function collisionKeep(scan: ParsedScan, o: ScanOrientation, opts: CleanOptions): Uint8Array {
  const ALPHA_MIN = opts.alphaMin ?? 0.35;
  const SCALE_CAP_MUL = opts.scaleCapMul ?? 4;
  const MIN_MASS = opts.minMass ?? 4;
  const GRID = opts.grid ?? 160;
  const CEIL_PCT = opts.ceil ?? 0.98;
  const WALL_PCT = opts.wall ?? 0.99;
  const MARGIN = opts.margin ?? 0.08;
  const FLOOR_MARGIN = opts.floorMargin ?? 0.03;
  const DO_CROP = opts.crop ?? true;

  const { centers, covariances, colors } = scan;
  const count = centers.length / 3;

  const cx = o.center.x, cy = o.center.y, cz = o.center.z, radius = o.radius;

  // per-splat opacity and size
  const alpha = new Float32Array(count), sizeOf = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    alpha[i] = colors[i * 4 + 3] / 255;
    const c = i * 6;
    sizeOf[i] = Math.sqrt(Math.max(0, largestEigenvalue(covariances[c], covariances[c + 1], covariances[c + 2], covariances[c + 3], covariances[c + 4], covariances[c + 5])));
  }
  const sampleStride = Math.max(1, Math.floor(count / 40000));
  const sizeSample: number[] = [];
  for (let i = 0; i < count; i += sampleStride) sizeSample.push(sizeOf[i]);
  const scaleCap = median(sizeSample) * SCALE_CAP_MUL;
  const passOpacitySize = (i: number) => alpha[i] >= ALPHA_MIN && sizeOf[i] <= scaleCap;

  // accumulate opacity mass per voxel (opacity/size pre-filtered)
  const voxel = (2 * radius) / GRID;
  const key = (i: number) => {
    const vx = Math.floor((centers[i * 3] - cx) / voxel), vy = Math.floor((centers[i * 3 + 1] - cy) / voxel), vz = Math.floor((centers[i * 3 + 2] - cz) / voxel);
    return (vx + 524288) * 1099511627776 + (vy + 524288) * 1048576 + (vz + 524288);
  };
  const mass = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    if (!passOpacitySize(i)) continue;
    const k = key(i);
    mass.set(k, (mass.get(k) ?? 0) + alpha[i]);
  }
  const passDensity = (i: number) => (mass.get(key(i)) ?? 0) >= MIN_MASS;

  // crop box: robust extent of the levelled, density-passing splats
  let levelled: Float32Array | null = null;
  let box: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } | null = null;
  if (DO_CROP) {
    levelled = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      v.set(centers[i * 3] - cx, centers[i * 3 + 1] - cy, centers[i * 3 + 2] - cz).applyQuaternion(o.quaternion);
      levelled[i * 3] = v.x; levelled[i * 3 + 1] = v.y + o.floorOffsetY; levelled[i * 3 + 2] = v.z;
    }
    const lx: number[] = [], lz: number[] = [], ly: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!passOpacitySize(i) || !passDensity(i)) continue;
      lx.push(levelled[i * 3]); ly.push(levelled[i * 3 + 1]); lz.push(levelled[i * 3 + 2]);
    }
    if (lx.length) {
      lx.sort((a, b) => a - b); lz.sort((a, b) => a - b); ly.sort((a, b) => a - b);
      const spanX = pctOf(lx, WALL_PCT) - pctOf(lx, 1 - WALL_PCT);
      const spanZ = pctOf(lz, WALL_PCT) - pctOf(lz, 1 - WALL_PCT);
      const ceil = pctOf(ly, CEIL_PCT);
      box = {
        minX: pctOf(lx, 1 - WALL_PCT) - MARGIN * spanX, maxX: pctOf(lx, WALL_PCT) + MARGIN * spanX,
        minZ: pctOf(lz, 1 - WALL_PCT) - MARGIN * spanZ, maxZ: pctOf(lz, WALL_PCT) + MARGIN * spanZ,
        minY: -FLOOR_MARGIN * radius, maxY: ceil + MARGIN * ceil,
      };
    }
  }
  const passBounds = (i: number) => {
    if (!box || !levelled) return true;
    const x = levelled[i * 3], y = levelled[i * 3 + 1], z = levelled[i * 3 + 2];
    return x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY && z >= box.minZ && z <= box.maxZ;
  };

  const keep = new Uint8Array(count);
  for (let i = 0; i < count; i++) if (passOpacitySize(i) && passDensity(i) && passBounds(i)) keep[i] = 1;
  return keep;
}

/** Which of the splats centred at `centers` are inside the room: the scan levelled as the room
 *  is placed at load (orientScan), and the box round where nearly all of them are (the `wall`
 *  and `ceil` percentiles, plus `margin` of the span), from a little below the floor up.
 *  `tiltDeg` is how far the levelling turned the floor. */
export function insideRoom(centers: Float32Array, opts: CleanOptions = {}): { keep: Uint8Array; kept: number; tiltDeg: number; orientation: ScanOrientation } {
  const CEIL_PCT = opts.ceil ?? 0.98;
  const WALL_PCT = opts.wall ?? 0.99;
  const MARGIN = opts.margin ?? 0.08;
  const FLOOR_MARGIN = opts.floorMargin ?? 0.03;
  const count = centers.length / 3;
  const keep = new Uint8Array(count).fill(1);
  const o = orientScan(new THREE.BufferAttribute(centers, 3));
  if (!(opts.crop ?? true)) return { keep, kept: count, tiltDeg: o.tiltDeg, orientation: o };

  // every splat levelled, and the robust extent of them all
  const lx = new Float32Array(count), ly = new Float32Array(count), lz = new Float32Array(count);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.set(centers[i * 3], centers[i * 3 + 1], centers[i * 3 + 2]).sub(o.center).applyQuaternion(o.quaternion);
    lx[i] = v.x; ly[i] = v.y + o.floorOffsetY; lz[i] = v.z;
  }
  const sx = lx.slice().sort(), sy = ly.slice().sort(), sz = lz.slice().sort();
  const spanX = pct(sx, WALL_PCT) - pct(sx, 1 - WALL_PCT), spanZ = pct(sz, WALL_PCT) - pct(sz, 1 - WALL_PCT), ceil = pct(sy, CEIL_PCT);
  const minX = pct(sx, 1 - WALL_PCT) - MARGIN * spanX, maxX = pct(sx, WALL_PCT) + MARGIN * spanX;
  const minZ = pct(sz, 1 - WALL_PCT) - MARGIN * spanZ, maxZ = pct(sz, WALL_PCT) + MARGIN * spanZ;
  const minY = -FLOOR_MARGIN * o.radius, maxY = ceil + MARGIN * ceil;
  let kept = 0;
  for (let i = 0; i < count; i++) {
    const inside = lx[i] >= minX && lx[i] <= maxX && ly[i] >= minY && ly[i] <= maxY && lz[i] >= minZ && lz[i] <= maxZ;
    keep[i] = inside ? 1 : 0;
    if (inside) kept++;
  }
  return { keep, kept, tiltDeg: o.tiltDeg, orientation: o };
}

/** Clean a scan: the splats inside the room (insideRoom) are drawn; the collision is built from
 *  those that also pass the floater filters (collisionKeep), marked in `collision`. */
export function cleanScan(scan: ParsedScan, opts: CleanOptions = {}): CleanResult {
  const { centers, covariances, colors } = scan;
  const count = centers.length / 3;
  if (count <= 0) throw new Error('The scan has no splats.');
  const { keep: inside, orientation } = insideRoom(centers, opts);
  const forCollision = collisionKeep(scan, orientation, opts);
  const keep: number[] = [];
  for (let i = 0; i < count; i++) if (inside[i] || forCollision[i]) keep.push(i); // (the two boxes differ a little at the edges)
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
